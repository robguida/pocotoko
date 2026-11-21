#!/usr/bin/env node
// Scrub scan (spec 13.1). Dev script only; never shipped.
//
//   node scripts/scrub-scan.mjs              public layer (runs in CI)
//   node scripts/scrub-scan.mjs --private    public layer, then the private deny-list layer
//   --rules <file>                           use another rules file (tests use this)
//
// Files in scope come from git: tracked, staged and new files that are not ignored.
// Git runs with fixed arguments and no shell (13.6). One unreadable file never stops
// the run: it is counted as failed, the other files are still scanned, and the run fails.
// The private layer never prints a deny-list term: hits name the file, the line and the
// term's index only. Its only allowed hits are the one LICENSE copyright line and the install
// slug on both allow lists, in the places allowedSpans names.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RULES = path.join(SCRIPT_DIR, 'scrub-rules.json');
const DENYLIST_ENV = 'SCRUB_DENYLIST';
// Test seam: a relative path (forward slashes) the scan treats as unreadable. It can only
// add a failure, never remove one.
const TEST_UNREADABLE_ENV = 'SCRUB_TEST_UNREADABLE';

export const PUBLIC_RULES = [
  'home-path', 'email', 'host-handle', 'iso-date', 'date-quote', 'manifest-field',
  'savings-phrase', 'reserved-name', 'official-name',
  'secret-key-block', 'secret-vendor-token', 'secret-jwt', 'secret-conn-string',
  'secret-signed-url', 'secret-webhook', 'secret-setting', 'secret-auth-header',
  'secret-random', 'hex40', 'copyright-line',
];

// ---------- small helpers ----------

function say(line) {
  process.stdout.write(`${line}\n`);
}

function withG(flags) {
  const f = String(flags || '');
  return f.includes('g') ? f : `${f}g`;
}

function re(def, forceGlobal = true) {
  if (!def || typeof def.pattern !== 'string') throw new Error('a pattern entry is missing');
  return new RegExp(def.pattern, forceGlobal ? withG(def.flags) : String(def.flags || '').replace('g', ''));
}

// A secret pattern whose value sits in a named group `value`; the `d` flag gives its span.
function valueRe(def) {
  const rx = re(def);
  const d = rx.flags.includes('d') ? rx : new RegExp(rx.source, `${rx.flags}d`);
  if (!/\(\?<value>/.test(d.source)) throw new Error('a secret pattern has no value group');
  return d;
}

// True when line[start, end) is a whole placeholder shape (spec SR-13 b2, same shapes as the
// search scan). A shape may run past `end` (a `<your password>` value holds a space, which ends
// the value); then the character after the shape must end the value. A shape that ends before
// `end` passes only when the rest is closing punctuation. A value that only starts like a
// placeholder (`$`, `%`, `{`, `*`) is still a hit.
const PLACEHOLDER_PEEK = 260;
function isPlaceholderValue(c, line, start, end) {
  const peek = line.slice(start, start + PLACEHOLDER_PEEK);
  for (const rx of c.placeholders) {
    const m = rx.exec(peek);
    if (!m) continue;
    const e = start + m[0].length;
    if (e === end) return true;
    if (e > end) {
      const after = line[e];
      if (after === undefined || /\s/.test(after) || `"'\``.includes(after) || c.closingPunct.includes(after)) return true;
      continue;
    }
    let rest = true;
    for (let j = e; j < end; j++) if (!c.closingPunct.includes(line[j])) { rest = false; break; }
    if (rest) return true;
  }
  return false;
}

// One hit when any match's value is not a whole placeholder. The search restarts one
// character after each exempt match, so an exempt value never hides a later real one.
function valueHit(c, rx, line) {
  rx.lastIndex = 0;
  let m;
  while ((m = rx.exec(line)) !== null) {
    const span = m.indices && m.indices.groups && m.indices.groups.value;
    if (!span || !isPlaceholderValue(c, line, span[0], span[1])) return true;
    rx.lastIndex = m.index + 1;
  }
  return false;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

function isWordChar(ch) {
  return ch !== undefined && ch !== '' && /[\p{L}\p{N}]/u.test(ch);
}

// Literal, case-insensitive, whole word or phrase: the character before and after the
// match must not be a letter or a digit. Never a regular expression.
function literalWholeHits(haystackLower, needleLower) {
  const found = [];
  if (!needleLower) return found;
  let from = 0;
  for (;;) {
    const at = haystackLower.indexOf(needleLower, from);
    if (at < 0) break;
    const before = at > 0 ? haystackLower[at - 1] : '';
    const after = haystackLower[at + needleLower.length];
    if (!isWordChar(before) && !isWordChar(after)) found.push(at);
    from = at + 1;
  }
  return found;
}

function matchPath(pattern, rel) {
  if (pattern.endsWith('/')) return rel.startsWith(pattern);
  if (pattern.includes('*')) {
    const rx = new RegExp(`^${pattern.split('*').map(escapeRegex).join('[^/]*')}$`);
    return rx.test(rel);
  }
  return rel === pattern;
}

function inAny(list, rel) {
  return Array.isArray(list) && list.some((p) => matchPath(p, rel));
}

function shannonBits(text) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) || 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function isInside(child, parent) {
  const caseless = process.platform === 'win32' || process.platform === 'darwin';
  const a = caseless ? child.toLowerCase() : child;
  const b = caseless ? parent.toLowerCase() : parent;
  const rel = path.relative(b, a);
  return rel !== '' && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..';
}

// ---------- rules ----------

function loadRules(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`cannot read rules file (${e.code || e.name})`);
  }
  let r;
  try {
    r = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (e) {
    throw new Error('rules file is not valid JSON');
  }
  const c = { raw: r };
  c.label = r.maintainer_label;
  if (typeof c.label !== 'string' || !c.label) throw new Error('maintainer_label missing');
  c.canonicalSource = r.canonical_name_source;
  c.canonicalSuffixes = Array.isArray(r.canonical_name_suffixes) ? r.canonical_name_suffixes : [''];

  c.homePatterns = r.home_path.patterns.map((d) => re(d));
  c.homePlaceholders = new Set(r.home_path.placeholders.map((s) => s.toLowerCase()));

  c.email = re(r.email);
  c.emailAllow = new Set((r.email.allow || []).map((s) => s.toLowerCase()));

  const hh = r.host_handle;
  c.hostUrl = re({ pattern: hh.url_pattern, flags: hh.flags });
  c.hostInstall = re({ pattern: hh.install_pattern, flags: hh.flags });
  // The same patterns with match indices, for the private layer's allowed spans.
  c.hostUrlD = new RegExp(c.hostUrl.source, `${c.hostUrl.flags}d`);
  c.hostInstallD = new RegExp(c.hostInstall.source, `${c.hostInstall.flags}d`);
  c.ownerPlaceholders = new Set(hh.owner_placeholders.map((s) => s.toLowerCase()));
  c.hostReserved = new Set(hh.host_reserved_paths.map((s) => s.toLowerCase()));
  c.slugAllow = new Set((hh.install_slug_allow || []).map((s) => s.toLowerCase()));
  // The hosts on which an allowed slug may stand in a web address (both layers); the host part
  // as the address pattern's first group takes it, separator included.
  c.slugHosts = new Set((hh.install_slug_hosts || []).map((s) => s.toLowerCase()));

  c.iso = re(r.iso_date);
  c.isoExclude = r.iso_date.scope_exclude || [];
  c.written = r.date_quote.written_patterns.map((d) => re(d));
  c.minQuoted = r.date_quote.min_quoted_words;
  c.dateQuoteExclude = r.date_quote.scope_exclude || [];

  c.phrases = [...r.savings.phrases_from_claude_md, ...r.savings.phrases].map((s) => s.toLowerCase());
  c.savingsPatterns = r.savings.patterns.map((d) => re(d));

  c.reserved = r.names.reserved_words.map((s) => s.toLowerCase());
  c.officialWord = r.names.official_word.toLowerCase();
  c.forClaude = new RegExp(r.names.for_claude_pattern, 'i');

  const s = r.secrets;
  c.keyBlock = re(s.key_block);
  c.vendor = s.vendor_prefixes.map((v) => {
    if (typeof v.prefix !== 'string' || !Number.isInteger(v.min) || typeof v.chars !== 'string') {
      throw new Error('a vendor prefix entry is malformed');
    }
    return new RegExp(`${escapeRegex(v.prefix)}[${v.chars}]{${v.min},}`, 'g');
  });
  c.jwt = re(s.jwt);
  if (!Array.isArray(s.placeholder_shapes) || s.placeholder_shapes.length === 0) throw new Error('placeholder_shapes missing');
  c.placeholders = s.placeholder_shapes.map((d) => {
    if (!d || typeof d.pattern !== 'string' || !d.pattern.startsWith('^')) throw new Error('a placeholder shape must be anchored with ^');
    return re(d, false);
  });
  c.closingPunct = typeof s.placeholder_closing_punct === 'string' ? s.placeholder_closing_punct : '';
  c.conn = valueRe(s.conn_string);
  c.signed = valueRe(s.signed_url);
  c.webhook = s.webhook.map((d) => re(d));
  c.setting = s.setting.map((d) => valueRe(d));
  c.auth = re(s.auth_header);
  c.random = { ...s.random, rx: re({ pattern: s.random.token_pattern, flags: s.random.flags }) };

  c.hex = re(r.hex40);
  c.hexAllowDir = r.hex40.allow_dir;
  c.hexAllowLine = new RegExp(r.hex40.allow_line_pattern);

  c.copyright = re(r.copyright, false);
  c.copyrightFile = r.copyright.allowed_file;
  c.copyrightExempt = r.copyright.exempt_files || [];

  if (!Array.isArray(r.exemptions)) throw new Error('exemptions must be a list');
  const seen = new Set();
  c.exemptions = r.exemptions.map((ex, i) => {
    const n = i + 1;
    if (!ex || typeof ex.file !== 'string' || !ex.file) throw new Error(`exemption ${n}: file missing`);
    if (!PUBLIC_RULES.includes(ex.rule)) throw new Error(`exemption ${n}: unknown rule`);
    if (typeof ex.reason !== 'string' || ex.reason.trim().length < 10) throw new Error(`exemption ${n}: reason missing`);
    if (!Number.isInteger(ex.max_hits) || ex.max_hits < 1) throw new Error(`exemption ${n}: max_hits must be a whole number of 1 or more`);
    if (ex.file.startsWith('tests/') && (ex.file.includes('*') || ex.file.endsWith('/'))) {
      throw new Error(`exemption ${n}: folder-wide test exemptions are not allowed`);
    }
    if (ex.file.endsWith('/')) throw new Error(`exemption ${n}: folder-wide exemptions are not allowed`);
    const key = `${ex.file}\u0000${ex.rule}`;
    if (seen.has(key)) throw new Error(`exemption ${n}: duplicate file and rule`);
    seen.add(key);
    return { n, file: ex.file, rule: ex.rule, max: ex.max_hits };
  });
  return c;
}

// ---------- git ----------

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    maxBuffer: 512 * 1024 * 1024,
  });
}

function gitScope() {
  let top;
  try {
    top = runGit(['rev-parse', '--show-toplevel'], process.cwd()).toString('utf8').trim();
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new Error('git not available: cannot list the files in scope');
    throw new Error('not inside a git work tree: cannot list the files in scope');
  }
  if (!top) throw new Error('git gave no work tree: cannot list the files in scope');
  top = path.resolve(top);
  let out;
  try {
    out = runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], top).toString('utf8');
  } catch (e) {
    throw new Error('git ls-files failed: cannot list the files in scope');
  }
  const files = [...new Set(out.split('\0').filter(Boolean))].sort();
  return { top, files };
}

// ---------- names ----------

function nameFlags(c, name) {
  const lower = String(name).toLowerCase();
  const rules = [];
  if (c.reserved.some((w) => lower.includes(w))) rules.push('reserved-name');
  if (lower.includes(c.officialWord) || c.forClaude.test(lower)) rules.push('official-name');
  return rules;
}

function lineOf(lines, value) {
  const needle = JSON.stringify(value);
  const i = lines.findIndex((l) => l.includes(needle));
  return i < 0 ? 1 : i + 1;
}

function readCanonical(c, top, files) {
  const set = new Set();
  if (!c.canonicalSource || !files.includes(c.canonicalSource)) return set;
  try {
    const obj = JSON.parse(fs.readFileSync(path.join(top, ...c.canonicalSource.split('/')), 'utf8').replace(/^﻿/, ''));
    if (obj && typeof obj.name === 'string' && obj.name) {
      for (const suffix of c.canonicalSuffixes) set.add(`${obj.name}${suffix}`);
    }
  } catch (_) {
    // An unreadable or broken core manifest leaves the set empty, so every name field fails.
  }
  return set;
}

// ---------- the public layer, one file ----------

function scanPublic(c, ctx, rel, text, opts = {}) {
  const structural = opts.structural !== false;
  const hits = new Map();
  const add = (line, rule) => hits.set(`${line}\u0000${rule}`, { line, rule });
  const lines = text.split(/\r\n|\n|\r/);
  const base = rel.split('/').pop();
  const isMd = structural && /\.(md|markdown)$/i.test(rel);
  const isoOn = !inAny(c.isoExclude, rel);
  const dqOn = !inAny(c.dateQuoteExclude, rel);
  const copyrightLines = [];

  lines.forEach((line, idx) => {
    const ln = idx + 1;

    for (const rx of c.homePatterns) {
      for (const m of line.matchAll(rx)) {
        const name = (m[1] || '').replace(/[.\-_]+$/, '');
        if (/^[<$%{[*~.]/.test(name) || !/\p{L}/u.test(name) || c.homePlaceholders.has(name.toLowerCase())) continue;
        add(ln, 'home-path');
      }
    }

    for (const m of line.matchAll(c.email)) {
      if (!c.emailAllow.has(m[0].toLowerCase())) add(ln, 'email');
    }

    for (const m of line.matchAll(c.hostUrl)) {
      const host = m[1].toLowerCase();
      const owner = m[2] || '';
      const repo = (m[3] || '').replace(/\.git$/i, '');
      if (/^[<{$]/.test(owner) || c.ownerPlaceholders.has(owner.toLowerCase())) continue;
      if (host.startsWith('github.com') && c.hostReserved.has(owner.toLowerCase())) continue;
      if (repo && c.slugHosts.has(host) && c.slugAllow.has(`${owner}/${repo}`.toLowerCase())) continue;
      add(ln, 'host-handle');
    }
    for (const m of line.matchAll(c.hostInstall)) {
      const owner = m[1];
      const repo = m[2].replace(/\.git$/i, '');
      if (!/\p{L}/u.test(owner) || c.ownerPlaceholders.has(owner.toLowerCase())) continue;
      if (c.slugAllow.has(`${owner}/${repo}`.toLowerCase())) continue;
      add(ln, 'host-handle');
    }

    const hasIso = [...line.matchAll(c.iso)].length > 0;
    if (isoOn && hasIso) add(ln, 'iso-date');
    if (dqOn && (hasIso || c.written.some((rx) => [...line.matchAll(rx)].length > 0)) && hasQuotedSpan(line, c.minQuoted)) {
      add(ln, 'date-quote');
    }

    const lower = line.toLowerCase();
    if (c.phrases.some((p) => literalWholeHits(lower, p).length > 0)) add(ln, 'savings-phrase');
    if (c.savingsPatterns.some((rx) => [...line.matchAll(rx)].length > 0)) add(ln, 'savings-phrase');

    if ([...line.matchAll(c.keyBlock)].length) add(ln, 'secret-key-block');
    if (c.vendor.some((rx) => [...line.matchAll(rx)].length > 0)) add(ln, 'secret-vendor-token');
    if ([...line.matchAll(c.jwt)].length) add(ln, 'secret-jwt');
    if (valueHit(c, c.conn, line)) add(ln, 'secret-conn-string');
    if (valueHit(c, c.signed, line)) add(ln, 'secret-signed-url');
    if (c.webhook.some((rx) => [...line.matchAll(rx)].length > 0)) add(ln, 'secret-webhook');
    if (c.setting.some((rx) => valueHit(c, rx, line))) add(ln, 'secret-setting');
    if ([...line.matchAll(c.auth)].length) add(ln, 'secret-auth-header');
    for (const m of line.matchAll(c.random.rx)) {
      const tok = m[0];
      if (!/[A-Z]/.test(tok) || !/[a-z]/.test(tok) || !/[0-9]/.test(tok)) continue;
      const bits = shannonBits(tok);
      if ((tok.length >= c.random.long_min_len && bits >= c.random.long_min_bits) ||
          (tok.length >= c.random.short_min_len && tok.length < c.random.long_min_len && bits >= c.random.short_min_bits)) {
        add(ln, 'secret-random');
      }
    }

    for (const m of line.matchAll(c.hex)) {
      void m;
      const allowed = rel.startsWith(c.hexAllowDir) && c.hexAllowLine.test(line);
      if (!allowed) add(ln, 'hex40');
    }

    if (c.copyright.test(line)) copyrightLines.push(ln);

    if (isMd && /^\s{0,3}#{1,6}\s/.test(line)) {
      if (lower.includes(c.officialWord)) add(ln, 'official-name');
      if (/^\s{0,3}#\s/.test(line) && c.forClaude.test(line)) add(ln, 'official-name');
    }
  });

  // Copyright line: only in LICENSE, and only once there. THIRD-PARTY-NOTICES is exempt.
  if (rel === c.copyrightFile) {
    if (copyrightLines.length > 1) copyrightLines.forEach((ln) => add(ln, 'copyright-line'));
  } else if (!c.copyrightExempt.includes(rel)) {
    copyrightLines.forEach((ln) => add(ln, 'copyright-line'));
  }
  if (rel === c.copyrightFile) ctx.licenseCopyright = copyrightLines.length === 1 ? copyrightLines[0] : 0;

  // Text that is not a file's content (a path, a commit message, a ref name) gets the line rules only.
  if (!structural) return [...hits.values()];

  // Manifests: every name, author and owner field must be the maintainer label or a canonical name.
  if (/(^|\/)\.claude-plugin\/(plugin|marketplace)\.json$/.test(rel)) {
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch (_) {
      add(1, 'manifest-field');
    }
    if (obj) {
      const check = (value) => {
        const ln = lineOf(lines, value);
        if (value !== c.label && !ctx.canonical.has(value)) add(ln, 'manifest-field');
        for (const rule of nameFlags(c, value)) add(ln, rule);
      };
      const walk = (node) => {
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        if (!node || typeof node !== 'object') return;
        for (const [k, v] of Object.entries(node)) {
          if (k === 'name' && typeof v === 'string') check(v);
          else if ((k === 'author' || k === 'owner') && typeof v === 'string') check(v);
          if (k === 'mcpServers' && v && typeof v === 'object' && !Array.isArray(v)) {
            for (const server of Object.keys(v)) {
              for (const rule of nameFlags(c, server)) add(lineOf(lines, server), rule);
            }
          }
          walk(v);
        }
      };
      walk(obj);
    }
  }

  // MCP server names.
  if (base === '.mcp.json') {
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch (_) {
      add(1, 'manifest-field');
    }
    if (obj && typeof obj === 'object') {
      const servers = obj.mcpServers && typeof obj.mcpServers === 'object' ? obj.mcpServers : obj;
      for (const server of Object.keys(servers)) {
        for (const rule of nameFlags(c, server)) add(lineOf(lines, server), rule);
      }
    }
  }

  // Skill names: the folder name and the frontmatter name.
  if (base === 'SKILL.md' && rel.startsWith('src/')) {
    const parts = rel.split('/');
    const folder = parts.length >= 2 ? parts[parts.length - 2] : '';
    for (const rule of nameFlags(c, folder)) add(0, rule);
    if (lines[0] && lines[0].trim() === '---') {
      for (let i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
        const m = /^name\s*:\s*['"]?([^'"#]+?)['"]?\s*$/.exec(lines[i]);
        if (m) for (const rule of nameFlags(c, m[1])) add(i + 1, rule);
      }
    }
  }

  // Tool names in server source.
  if (rel.startsWith('src/') && rel.split('/').includes('server') && /\.(c?js|mjs)$/.test(rel)) {
    lines.forEach((line, idx) => {
      for (const m of line.matchAll(/\bname\s*:\s*['"]([^'"\n]{1,100})['"]/g)) {
        for (const rule of nameFlags(c, m[1])) add(idx + 1, rule);
      }
    });
  }

  return [...hits.values()];
}

function hasQuotedSpan(line, minWords) {
  const spans = [];
  const straight = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"' && line[i - 1] !== '\\') straight.push(i);
  }
  for (let i = 0; i + 1 < straight.length; i += 2) spans.push(line.slice(straight[i] + 1, straight[i + 1]));
  for (const [open, close] of [['“', '”'], ['‘', '’']]) {
    let from = 0;
    for (;;) {
      const a = line.indexOf(open, from);
      if (a < 0) break;
      const b = line.indexOf(close, a + 1);
      if (b < 0) break;
      spans.push(line.slice(a + 1, b));
      from = b + 1;
    }
  }
  return spans.some((s) => s.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length >= minWords);
}

// ---------- the private layer ----------

function loadDenylist(top) {
  const raw = process.env[DENYLIST_ENV];
  if (raw === undefined || raw === '') return { error: 'deny-list not configured' };
  const file = path.resolve(raw);
  let st;
  try {
    st = fs.statSync(file);
  } catch (_) {
    return { error: 'deny-list file missing' };
  }
  if (!st.isFile()) return { error: 'deny-list file missing' };
  let real;
  let sandboxReal;
  try {
    real = fs.realpathSync(file);
    sandboxReal = fs.realpathSync(path.join(top, 'sandbox'));
  } catch (_) {
    return { error: 'deny-list must sit inside sandbox/' };
  }
  if (!isInside(real, sandboxReal)) return { error: 'deny-list must sit inside sandbox/' };
  let text;
  try {
    text = fs.readFileSync(real, 'utf8');
  } catch (_) {
    return { error: 'deny-list file unreadable' };
  }
  const { terms, allowSlugs } = parseDenyList(text);
  if (terms.length === 0) return { error: 'deny-list has no terms' };
  return { terms, allowSlugs };
}

// The deny-list file: one term per line; `#` starts a comment line. A line
// `allow-slug: <owner>/<repo>` is not a term: it is a private allow entry (13.1). A slug is
// allowed by the private layer only when it is ALSO on the public `install_slug_allow` list,
// so neither file alone can let a private term through.
const ALLOW_SLUG_RE = /^allow-slug:\s*([a-z0-9_.-]+\/[a-z0-9_.-]+)$/;

function parseDenyList(text) {
  const terms = [];
  const allowSlugs = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)) {
    const l = raw.trim().toLowerCase();
    if (!l || l.startsWith('#')) continue;
    const m = ALLOW_SLUG_RE.exec(l);
    if (m) allowSlugs.push(m[1]);
    else terms.push(l);
  }
  return { terms, allowSlugs };
}

// The slugs the private layer allows: on both lists. Returns [{ owner, repo, slug }].
function privateSlugs(c, allowSlugs) {
  const out = [];
  for (const slug of allowSlugs || []) {
    if (!c.slugAllow.has(slug)) continue;
    const [owner, repo] = slug.split('/');
    out.push({ owner, repo, slug });
  }
  return out;
}

// Spans [start, end) on one line where an allowed slug may stand (13.1, private layer):
// the whole `<owner>/<repo>` of an install line or of a web address on one of the
// `install_slug_hosts` (the public layer's own patterns, whose repo part already takes every
// slug character, so nothing can follow the slug inside a word); in `.github/CODEOWNERS`, an `@<owner>` entry on an owner line (not a comment, not
// the path pattern); in `scripts/scrub-rules.json`, the quoted slug on the `install_slug_allow`
// line. Anywhere else a term hit still counts.
function allowedSpans(c, rel, line, slugs) {
  const spans = [];
  if (!slugs.length) return spans;
  const bySlug = new Map(slugs.map((s) => [s.slug, s]));
  const fromMatch = (m, gOwner, gRepo) => {
    const owner = m[gOwner];
    const repoRaw = m[gRepo];
    if (!owner || !repoRaw) return;
    const repo = repoRaw.replace(/\.git$/i, '');
    if (!bySlug.has(`${owner}/${repo}`.toLowerCase())) return;
    spans.push([m.indices[gOwner][0], m.indices[gRepo][1]]);
  };
  for (const m of line.matchAll(c.hostUrlD)) {
    if (c.slugHosts.has(m[1].toLowerCase())) fromMatch(m, 2, 3);
  }
  for (const m of line.matchAll(c.hostInstallD)) fromMatch(m, 1, 2);
  if (rel === '.github/CODEOWNERS' && !line.trim().startsWith('#')) {
    const owners = new Set(slugs.map((s) => s.owner));
    const tokenRe = /\S+/g;
    let m;
    let first = true;
    while ((m = tokenRe.exec(line)) !== null) {
      if (first) { first = false; continue; }
      if (m[0].startsWith('#')) break;
      if (m[0].startsWith('@') && owners.has(m[0].slice(1).toLowerCase())) spans.push([m.index + 1, m.index + m[0].length]);
    }
  }
  if (rel === 'scripts/scrub-rules.json' && /^\s*"install_slug_allow"\s*:/.test(line)) {
    for (const s of slugs) {
      const needle = `"${s.slug}"`;
      const lower = line.toLowerCase();
      let from = 0;
      for (;;) {
        const at = lower.indexOf(needle, from);
        if (at < 0) break;
        spans.push([at + 1, at + 1 + s.slug.length]);
        from = at + 1;
      }
    }
  }
  return spans;
}

// Per-file, per-rule exemptions with a hit limit. Returns the hits that still count, plus a
// max-hits line for each exemption that was passed. `used` (optional) collects use counts.
function applyExemptions(c, rel, hits, used) {
  const kept = [];
  const byRule = new Map();
  for (const h of hits) {
    if (!byRule.has(h.rule)) byRule.set(h.rule, []);
    byRule.get(h.rule).push(h);
  }
  for (const [rule, list] of byRule) {
    const exIndex = rel ? c.exemptions.findIndex((ex) => ex.rule === rule && matchPath(ex.file, rel)) : -1;
    if (exIndex >= 0) {
      if (used) used[exIndex] += list.length;
      if (list.length <= c.exemptions[exIndex].max) continue;
      const ex = c.exemptions[exIndex];
      kept.push({ line: 0, rule: `max-hits-exceeded exemption=${ex.n} rule=${rule} hits=${list.length} max=${ex.max}` });
    }
    kept.push(...list);
  }
  return kept;
}

// ---------- one piece of text, for other dev scripts (the egress scan) ----------

const rulesCache = new Map();
const denyCache = new Map();

function cachedRules(file) {
  if (!rulesCache.has(file)) {
    const c = loadRules(file);
    const kitTop = path.resolve(SCRIPT_DIR, '..');
    const canonical = new Set();
    try {
      const src = path.join(kitTop, ...c.canonicalSource.split('/'));
      const obj = JSON.parse(fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, ''));
      if (obj && typeof obj.name === 'string' && obj.name) {
        for (const suffix of c.canonicalSuffixes) canonical.add(`${obj.name}${suffix}`);
      }
    } catch (_) {
      // No core manifest: the canonical set stays empty, so every manifest name field fails.
    }
    rulesCache.set(file, { c, canonical });
  }
  return rulesCache.get(file);
}

function cachedDenyTerms(file) {
  const abs = path.resolve(file);
  if (!denyCache.has(abs)) {
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch (_) {
      throw new Error('deny-list file missing or unreadable');
    }
    const parsed = parseDenyList(text);
    if (parsed.terms.length === 0) throw new Error('deny-list has no terms');
    denyCache.set(abs, parsed);
  }
  return denyCache.get(abs);
}

/**
 * Applies the scrub rules to one piece of text and returns rule ids only, never a matched value.
 *   path         repo-relative path with `/` separators, or null for text that is not a file
 *   text         the text to check
 *   kind         'file' (file content), 'path' (a file path), 'message' (a commit or tag message),
 *                'ref' (a ref or tag name)
 *   layers       ['public'] or ['public', 'private']
 *   denylistPath the private deny-list file (falls back to env.SCRUB_DENYLIST)
 *   env          environment to read SCRUB_DENYLIST from (default process.env)
 *   rulesPath    optional rules file (default scripts/scrub-rules.json)
 * Per-file exemptions apply by `path` for kinds 'file' and 'path'. Throws when the private
 * layer is asked for and no deny-list can be read, so a caller never takes that as a pass.
 */
export function scanContent({ path: relPath = null, text = '', kind = 'file', layers = ['public'], denylistPath, env = process.env, rulesPath } = {}) {
  const kinds = ['file', 'path', 'message', 'ref'];
  if (!kinds.includes(kind)) throw new Error('unknown kind');
  const { c, canonical } = cachedRules(rulesPath ? path.resolve(rulesPath) : DEFAULT_RULES);
  const rel = typeof relPath === 'string' ? relPath.split('\\').join('/') : '';
  const body = String(text).replace(/^\uFEFF/, '');
  const fileLike = kind === 'file' || kind === 'path';
  const scanRel = fileLike ? rel : '';
  const ctx = { canonical, licenseCopyright: 0 };
  const out = [];
  const seen = new Set();
  const push = (rule) => {
    if (seen.has(rule)) return;
    seen.add(rule);
    out.push({ rule });
  };

  if (!Array.isArray(layers) || layers.includes('public')) {
    const hits = scanPublic(c, ctx, scanRel, body, { structural: kind === 'file' && rel !== '' });
    for (const h of applyExemptions(c, scanRel, hits)) push(h.rule.split(' ')[0]);
  } else if (kind === 'file' && rel === c.copyrightFile) {
    scanPublic(c, ctx, scanRel, body, { structural: false });
  }

  if (Array.isArray(layers) && layers.includes('private')) {
    const file = denylistPath || (env && env[DENYLIST_ENV]);
    if (!file) throw new Error('deny-list not configured');
    const { terms, allowSlugs } = cachedDenyTerms(file);
    const slugs = privateSlugs(c, allowSlugs);
    for (const h of scanPrivate(terms, kind === 'file' ? rel : '', body, ctx, c, slugs)) push(h.rule);
    if (kind === 'file' && rel) for (const rule of scanPrivatePath(terms, rel)) push(`${rule}-in-path`);
  }
  return out;
}

// slugs: the allowed slugs (privateSlugs). A term hit counts unless it lies wholly inside an
// allowed span of its line, or is on the one LICENSE copyright line.
function scanPrivate(terms, rel, text, ctx, c = null, slugs = []) {
  const hits = new Map();
  const lines = text.split(/\r\n|\n|\r/);
  lines.forEach((line, idx) => {
    const lower = line.toLowerCase();
    let spans = null;
    terms.forEach((term, t) => {
      const found = literalWholeHits(lower, term);
      if (found.length === 0) return;
      const ln = idx + 1;
      if (rel === 'LICENSE' && ctx.licenseCopyright === ln) return;
      if (c && slugs.length) {
        if (spans === null) spans = allowedSpans(c, rel, line, slugs);
        const inSpan = (at) => spans.some(([s, e]) => at >= s && at + term.length <= e);
        if (found.every(inSpan)) return;
      }
      hits.set(`${ln}\u0000${t}`, { line: ln, rule: `private-term-${t + 1}` });
    });
  });
  return [...hits.values()];
}

function scanPrivatePath(terms, rel) {
  const lower = rel.toLowerCase();
  const found = [];
  terms.forEach((term, t) => {
    if (literalWholeHits(lower, term).length > 0) found.push(`private-term-${t + 1}`);
  });
  return found;
}

// ---------- main ----------

function parseArgs(argv) {
  const out = { private: false, rules: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--private') out.private = true;
    else if (a === '--rules') {
      out.rules = argv[i + 1];
      i += 1;
      if (!out.rules) throw new Error('--rules needs a file path');
    } else throw new Error('unknown argument');
  }
  return out;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    say(`scrub: FAIL (${e.message})`);
    return 1;
  }
  const rulesPath = args.rules ? path.resolve(args.rules) : DEFAULT_RULES;

  let c;
  try {
    c = loadRules(rulesPath);
  } catch (e) {
    say(`scrub public: FAIL (rules file invalid: ${e.message})`);
    if (args.private) say('scrub private: FAIL (not run: rules file invalid)');
    return 1;
  }

  let scope;
  try {
    scope = gitScope();
  } catch (e) {
    say(`scrub public: FAIL (${e.message})`);
    if (args.private) say(`scrub private: FAIL (${e.message})`);
    return 1;
  }
  const { top, files } = scope;
  const rulesRel = path.relative(top, rulesPath);
  const rulesLabel = rulesRel && !rulesRel.startsWith('..') && !path.isAbsolute(rulesRel)
    ? rulesRel.split(path.sep).join('/')
    : 'rules-file';

  let deny = null;
  if (args.private) deny = loadDenylist(top);
  const slugs = deny && deny.terms ? privateSlugs(c, deny.allowSlugs) : [];

  const ctx = { canonical: readCanonical(c, top, files), licenseCopyright: 0 };
  const counts = { succeeded: 0, failed: 0, skipped: 0 };
  const publicHits = [];
  const privateHits = [];
  const failures = [];
  const unreadableSeam = process.env[TEST_UNREADABLE_ENV] || '';

  // LICENSE first, so the private layer knows its one copyright line.
  const ordered = files.includes('LICENSE') ? ['LICENSE', ...files.filter((f) => f !== 'LICENSE')] : files;
  const perFile = new Map();
  const withheld = (i) => `[path withheld: file ${i + 1} of ${ordered.length}]`;
  // With the private layer on, a path that holds a deny-list term is never printed, by either layer.
  const shown = (rel) => {
    if (!deny || !deny.terms || !ordered.includes(rel)) return rel;
    return scanPrivatePath(deny.terms, rel).length > 0 ? withheld(ordered.indexOf(rel)) : rel;
  };

  ordered.forEach((rel, fileIndex) => {
    let text;
    try {
      const abs = path.join(top, ...rel.split('/'));
      let st;
      try {
        st = fs.lstatSync(abs);
      } catch (e) {
        if (e && e.code === 'ENOENT') {
          counts.skipped += 1;
          return;
        }
        throw e;
      }
      if (st.isDirectory()) {
        counts.skipped += 1;
        return;
      }
      if (unreadableSeam && unreadableSeam === rel) throw new Error('unreadable (test seam)');
      if (st.isSymbolicLink()) text = fs.readlinkSync(abs);
      else text = fs.readFileSync(abs).toString('utf8');
      text = text.replace(/^﻿/, '');
    } catch (_) {
      counts.failed += 1;
      failures.push({ file: rel, line: 0, rule: 'read-failed' });
      return;
    }
    try {
      const hits = scanPublic(c, ctx, rel, text);
      perFile.set(rel, hits);
      if (deny && deny.terms) {
        for (const h of scanPrivate(deny.terms, rel, text, ctx, c, slugs)) privateHits.push({ file: rel, ...h });
        for (const rule of scanPrivatePath(deny.terms, rel)) {
          privateHits.push({ file: withheld(fileIndex), line: 0, rule: `${rule}-in-path` });
        }
      }
      counts.succeeded += 1;
    } catch (_) {
      counts.failed += 1;
      failures.push({ file: rel, line: 0, rule: 'scan-failed' });
    }
  });

  // Exemptions: per file, per rule, with a hit limit. A stale one fails.
  const used = c.exemptions.map(() => 0);
  for (const [rel, hits] of perFile) {
    for (const h of applyExemptions(c, rel, hits, used)) publicHits.push({ file: rel, ...h });
  }
  c.exemptions.forEach((ex, i) => {
    if (used[i] === 0) {
      publicHits.push({ file: rulesLabel, line: 0, rule: `stale-exemption exemption=${ex.n} file=${ex.file} rule=${ex.rule}` });
    }
  });

  const sortHits = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.rule < b.rule ? -1 : 1));
  const allPublic = [...failures, ...publicHits].sort(sortHits);
  for (const h of allPublic) say(`${shown(h.file)}:${h.line} ${h.rule}`);
  const privSorted = privateHits.sort(sortHits);
  for (const h of privSorted) say(`${shown(h.file)}:${h.line} ${h.rule}`);

  say(`scrub files: succeeded ${counts.succeeded}, failed ${counts.failed}, skipped ${counts.skipped}`);
  let code = 0;
  if (allPublic.length === 0) say(`scrub public: PASS (${counts.succeeded} files)`);
  else {
    say(`scrub public: FAIL (${allPublic.length} hits)`);
    code = 1;
  }
  if (args.private) {
    if (deny.error) {
      say(`scrub private: FAIL (${deny.error})`);
      code = 1;
    } else {
      const n = privSorted.length + failures.length;
      if (n === 0) say(`scrub private: PASS (${counts.succeeded} files)`);
      else {
        say(`scrub private: FAIL (${n} hits)`);
        code = 1;
      }
    }
  }
  return code;
}

// Run the command line only when started directly (real paths compared, so a
// link or junction to the checkout still runs it), never when imported.
if (isMain(import.meta.url)) process.exitCode = main();
