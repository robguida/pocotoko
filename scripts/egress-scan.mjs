// Egress scan (spec 13.2). Dev only, never shipped.
//
// Checks every commit reachable from any ref under refs/ (branches, tags,
// notes, the stash, backup refs such as refs/original/), not only the latest
// files:
//   - author, committer and tagger names and emails against the private
//     commit identity (EGRESS_IDENTITY, a JSON file under sandbox/);
//   - commit messages including trailers, tag names and messages, branch and
//     other ref names;
//   - the content and the path of every blob in history.
// Both scrub layers run over the text (rules reused from scrub-scan.mjs),
// with the private deny-list from SCRUB_DENYLIST.
//
// Output names a commit (or object) hash and a field only, never a matched
// value and never the identity. Git runs with fixed arguments, no shell, and
// no user text in its arguments.
//
// Usage: node scripts/egress-scan.mjs [--repo <folder>]

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from './lib/is-main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const KIT_ROOT = path.resolve(HERE, '..');

const NOT_CONFIGURED = 'commit identity not configured';
const BATCH = 100;
const MAX_BUFFER = 1024 * 1024 * 1024;
const HASH_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const RULE_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

// Egress-only rules on commit messages (CLAUDE.md commit rules).
const MESSAGE_RULES = [
  { rule: 'trailer-co-authored-by', re: /^[ \t]*co-authored-by[ \t]*:/im },
  { rule: 'generated-with-line', re: /generated with/i },
];

// Variables that would point git somewhere other than the scanned repo.
const GIT_REDIRECT_VARS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_COMMON_DIR',
  'GIT_REPLACE_REF_BASE', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'GIT_TRACE',
];

// ---------------------------------------------------------------------------
// Small path helpers (same rules as scripts/lib/guard.mjs)

function caseless() {
  return process.platform === 'win32' || process.platform === 'darwin';
}
function isInside(child, parent) {
  let c = path.resolve(child);
  let p = path.resolve(parent);
  if (caseless()) { c = c.toLowerCase(); p = p.toLowerCase(); }
  if (c === p) return true;
  const rel = path.relative(p, c);
  if (path.isAbsolute(rel)) return false;
  return !(rel === '..' || rel.startsWith('..' + path.sep));
}
function realpathLoose(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return rest.length ? path.join(real, ...rest.slice().reverse()) : real;
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        const parent = path.dirname(cur);
        if (parent === cur) return path.resolve(p);
        rest.push(path.basename(cur));
        cur = parent;
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Private settings

/**
 * Reads the commit identity from the private JSON file named by
 * EGRESS_IDENTITY. The path must resolve inside <kit>/sandbox/.
 * Shape: { "name": "...", "email": "...", "author_exceptions": ["<hash>", ...] }
 * Never returns or prints the file's text on failure.
 */
export function loadIdentity(env, kitRoot = KIT_ROOT) {
  const raw = env.EGRESS_IDENTITY;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { error: NOT_CONFIGURED + ' (EGRESS_IDENTITY is not set)' };
  }
  const sb = path.join(kitRoot, 'sandbox');
  const abs = path.resolve(raw);
  if (!isInside(abs, sb)) {
    return { error: NOT_CONFIGURED + ' (EGRESS_IDENTITY must point to a file inside sandbox/)' };
  }
  let real;
  try {
    real = realpathLoose(abs);
    if (!isInside(real, realpathLoose(sb))) {
      return { error: NOT_CONFIGURED + ' (EGRESS_IDENTITY resolves through a link outside sandbox/)' };
    }
  } catch {
    return { error: NOT_CONFIGURED + ' (EGRESS_IDENTITY cannot be resolved)' };
  }
  let data;
  try {
    const st = fs.statSync(real);
    if (!st.isFile()) return { error: NOT_CONFIGURED + ' (identity file is not a file)' };
    data = JSON.parse(fs.readFileSync(real, 'utf8'));
  } catch (err) {
    return { error: NOT_CONFIGURED + (err && err.code === 'ENOENT' ? ' (identity file missing)' : ' (identity file unreadable)') };
  }
  if (!data || typeof data !== 'object') return { error: NOT_CONFIGURED + ' (identity file is not a JSON object)' };
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const email = typeof data.email === 'string' ? data.email.trim() : '';
  if (!name || !email) return { error: NOT_CONFIGURED + ' (name or email empty)' };
  const exceptions = new Set();
  if (Array.isArray(data.author_exceptions)) {
    for (const h of data.author_exceptions) {
      if (typeof h === 'string' && HASH_RE.test(h.trim().toLowerCase())) exceptions.add(h.trim().toLowerCase());
    }
  }
  return { identity: { name, email, authorExceptions: exceptions } };
}

/**
 * The private deny-list file from SCRUB_DENYLIST (13.1): unset → FAIL,
 * missing → FAIL, outside <kit>/sandbox/ → FAIL.
 */
export function checkDenylist(env, kitRoot = KIT_ROOT) {
  const p = env.SCRUB_DENYLIST;
  if (typeof p !== 'string' || p.trim() === '') return { error: 'deny-list not configured' };
  const abs = path.resolve(p);
  try {
    if (!fs.statSync(abs).isFile()) return { error: 'deny-list file missing' };
  } catch {
    return { error: 'deny-list file missing' };
  }
  const sb = path.join(kitRoot, 'sandbox');
  try {
    if (!isInside(abs, sb) || !isInside(realpathLoose(abs), realpathLoose(sb))) {
      return { error: 'deny-list must sit inside sandbox/' };
    }
  } catch {
    return { error: 'deny-list must sit inside sandbox/' };
  }
  return { path: abs };
}

// ---------------------------------------------------------------------------
// Scrub rules (integration point with scripts/scrub-scan.mjs)

/**
 * Loads the rule check from scripts/scrub-scan.mjs.
 *
 * Contract the egress scan needs from scrub-scan.mjs (both layers):
 *   export function scanContent({ path, text, kind, layers, denylistPath, env })
 *     -> Array<{ rule: string }>
 * where `path` is the repo-relative path with `/` separators (null for
 * text that is not a file), `kind` is one of 'file', 'path', 'message',
 * 'ref', `layers` is ['public', 'private'], and the per-file exemptions of
 * scrub-rules.json apply by `path`. Importing scrub-scan.mjs must not run
 * its command-line part.
 *
 * Returns { check } or { error }. A missing rule check is a FAIL, never a
 * silent pass.
 */
export async function loadRuleCheck(kitRoot = KIT_ROOT) {
  const file = path.join(kitRoot, 'scripts', 'scrub-scan.mjs');
  // Read the source first: importing a version without the export would run
  // its command-line part inside this process.
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch {
    return { error: 'scrub rules not available (scripts/scrub-scan.mjs could not be loaded)' };
  }
  if (!/export\s+(async\s+)?function\s+scanContent\b|export\s*\{[^}]*\bscanContent\b/.test(src)) {
    return { error: 'scrub rules not available (scripts/scrub-scan.mjs exports no scanContent)' };
  }
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch {
    return { error: 'scrub rules not available (scripts/scrub-scan.mjs could not be loaded)' };
  }
  const fn = adaptScrubModule(mod);
  if (!fn) return { error: 'scrub rules not available (scripts/scrub-scan.mjs exports no content check)' };
  return { check: fn };
}

/** Maps what scrub-scan.mjs exports onto the one call the egress scan makes. */
export function adaptScrubModule(mod) {
  if (mod && typeof mod.scanContent === 'function') {
    return (input) => mod.scanContent(input);
  }
  return null;
}

function cleanRule(r) {
  const id = r && typeof r === 'object' ? r.rule : r;
  return typeof id === 'string' && RULE_ID_RE.test(id) ? id : 'rule';
}

// ---------------------------------------------------------------------------
// Git

function gitEnv(baseEnv, kitRoot) {
  const env = { ...baseEnv };
  for (const k of GIT_REDIRECT_VARS) delete env[k];
  env.GIT_CONFIG_NOSYSTEM = '1';
  // An empty global config under sandbox/ (it need not exist): the scan
  // never reads or changes the machine's own git settings.
  env.GIT_CONFIG_GLOBAL = path.join(kitRoot, 'sandbox', 'egress', 'scan-gitconfig');
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

function makeGit(repo, env) {
  return (args, input) => {
    const r = spawnSync('git', args, {
      cwd: repo, env, input, maxBuffer: MAX_BUFFER, windowsHide: true, shell: false,
    });
    return { ok: !r.error && r.status === 0, status: r.status, error: r.error, stdout: r.stdout || Buffer.alloc(0) };
  };
}

function parseBatch(buf, wanted) {
  const out = [];
  let i = 0;
  for (let k = 0; k < wanted.length && i < buf.length; k++) {
    const nl = buf.indexOf(0x0a, i);
    if (nl < 0) break;
    const header = buf.toString('utf8', i, nl);
    i = nl + 1;
    const parts = header.split(' ');
    if (parts.length < 3) { out.push({ oid: wanted[k], missing: true }); continue; }
    const size = Number(parts[2]);
    out.push({ oid: wanted[k], type: parts[1], content: buf.subarray(i, i + size) });
    i += size + 1;
  }
  while (out.length < wanted.length) out.push({ oid: wanted[out.length], missing: true });
  return out;
}

/** Reads objects in batches; one bad object never stops the rest. */
function readObjects(git, oids) {
  const result = new Map();
  for (let s = 0; s < oids.length; s += BATCH) {
    const chunk = oids.slice(s, s + BATCH);
    const r = git(['cat-file', '--batch'], chunk.join('\n') + '\n');
    if (r.ok) {
      for (const o of parseBatch(r.stdout, chunk)) result.set(o.oid, o);
      continue;
    }
    for (const oid of chunk) {
      const one = git(['cat-file', '--batch'], oid + '\n');
      result.set(oid, one.ok ? parseBatch(one.stdout, [oid])[0] : { oid, missing: true });
    }
  }
  return result;
}

function parseHeaders(text) {
  const cut = text.indexOf('\n\n');
  const head = cut < 0 ? text : text.slice(0, cut);
  const message = cut < 0 ? '' : text.slice(cut + 2);
  const headers = [];
  for (const line of head.split('\n')) {
    if (line.startsWith(' ') && headers.length) {
      headers[headers.length - 1].value += '\n' + line.slice(1);
    } else {
      const sp = line.indexOf(' ');
      headers.push(sp < 0 ? { key: line, value: '' } : { key: line.slice(0, sp), value: line.slice(sp + 1) });
    }
  }
  return { headers, message };
}

function parsePerson(value) {
  const m = /^(.*) <([^<>]*)> (\d+) ([+-]\d{4})$/.exec(value);
  return m ? { name: m[1], email: m[2] } : null;
}

function refKind(refname) {
  if (refname.startsWith('refs/heads/')) return 'branch';
  if (refname.startsWith('refs/tags/')) return 'tag';
  if (refname.startsWith('refs/notes/')) return 'note-ref';
  if (refname === 'refs/stash') return 'stash';
  if (refname.startsWith('refs/original/')) return 'backup-ref';
  if (refname.startsWith('refs/remotes/')) return 'remote-ref';
  return 'ref';
}

// ---------------------------------------------------------------------------
// The scan

/**
 * Runs the scan. Returns { exitCode, lines, hits, counts, commits, blobs }.
 * `ruleCheck` may be injected (tests); otherwise it is loaded from
 * scrub-scan.mjs.
 */
export async function runEgress({ repo = KIT_ROOT, env = process.env, kitRoot = KIT_ROOT, ruleCheck } = {}) {
  const lines = [];
  const hits = [];
  const seen = new Set();
  const counts = { succeeded: 0, failed: 0, skipped: 0 };
  const done = (summary) => {
    lines.push(summary);
    return { exitCode: summary.startsWith('egress: PASS') ? 0 : 1, lines, hits, counts };
  };

  const id = loadIdentity(env, kitRoot);
  if (id.error) return done('egress: FAIL (' + id.error + ')');
  const deny = checkDenylist(env, kitRoot);
  if (deny.error) return done('egress: FAIL (' + deny.error + ')');
  let check = ruleCheck;
  if (!check) {
    const loaded = await loadRuleCheck(kitRoot);
    if (loaded.error) return done('egress: FAIL (' + loaded.error + ')');
    check = loaded.check;
  }

  const identity = id.identity;
  const git = makeGit(path.resolve(repo), gitEnv(env, kitRoot));
  const probe = git(['rev-parse', '--git-dir']);
  if (probe.error && probe.error.code === 'ENOENT') return done('egress: FAIL (git not available)');
  if (!probe.ok) return done('egress: FAIL (not a git repository)');

  const hit = (where, field, rule) => {
    const key = where + '|' + field + '|' + rule;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ where, field, rule });
    lines.push('hit: ' + where + ' ' + field + ' [' + rule + ']');
  };
  const failed = (where, field) => {
    counts.failed += 1;
    lines.push('failed: ' + where + ' ' + field + ' (cannot be read; scan continued)');
  };
  const runRules = (where, field, input) => {
    let found;
    try {
      found = check({ ...input, layers: ['public', 'private'], denylistPath: deny.path, env });
    } catch {
      failed(where, field + ' (rule check error)');
      return;
    }
    if (Array.isArray(found)) for (const r of found) hit(where, field, cleanRule(r));
  };
  const checkPerson = (where, role, value, allowException) => {
    const p = parsePerson(value || '');
    if (!p) { hit(where, role, 'identity-unparseable'); return; }
    const nameOk = p.name === identity.name;
    const emailOk = p.email.toLowerCase() === identity.email.toLowerCase();
    if (nameOk && emailOk) return;
    if (allowException) return;
    if (!nameOk) hit(where, role + ' name', 'identity-mismatch');
    if (!emailOk) hit(where, role + ' email', 'identity-mismatch');
  };
  const checkMessage = (where, field, message) => {
    for (const m of MESSAGE_RULES) if (m.re.test(message)) hit(where, field, m.rule);
    runRules(where, field, { path: null, text: message, kind: 'message' });
  };
  const checkTagText = (where, field, text) => {
    const { headers, message } = parseHeaders(text);
    const tagger = headers.find((h) => h.key === 'tagger');
    if (tagger) checkPerson(where, field + ' tagger', tagger.value, false);
    const tagName = headers.find((h) => h.key === 'tag');
    if (tagName) runRules(where, field + ' name', { path: null, text: tagName.value, kind: 'ref' });
    checkMessage(where, field + ' message', message);
    const obj = headers.find((h) => h.key === 'object');
    const typ = headers.find((h) => h.key === 'type');
    return obj && typ ? { oid: obj.value.trim(), type: typ.value.trim() } : null;
  };

  // 1. Refs: names, annotated tags, start points.
  const refsOut = git(['for-each-ref', '--format=%(objectname) %(objecttype) %(refname)', 'refs/']);
  if (!refsOut.ok) return done('egress: FAIL (refs cannot be listed)');
  const startCommits = new Set();
  const extraTrees = [];
  const blobInfo = new Map(); // blob oid -> { where, paths:Set }
  const pathFirst = new Map(); // path -> where
  const noteBlob = (oid, where, p) => {
    let b = blobInfo.get(oid);
    if (!b) { b = { where, paths: new Set() }; blobInfo.set(oid, b); }
    if (p !== null) {
      b.paths.add(p);
      if (!pathFirst.has(p)) pathFirst.set(p, where);
    }
  };
  for (const line of refsOut.stdout.toString('utf8').split('\n')) {
    if (!line) continue;
    const a = line.indexOf(' ');
    const b = line.indexOf(' ', a + 1);
    let oid = line.slice(0, a);
    let type = line.slice(a + 1, b);
    const refname = line.slice(b + 1);
    const kind = refKind(refname);
    const where = kind + ' ' + oid;
    runRules(where, kind + ' name', { path: null, text: refname, kind: 'ref' });
    let depth = 0;
    while (type === 'tag' && depth < 10) {
      depth += 1;
      const obj = readObjects(git, [oid]).get(oid);
      if (!obj || obj.missing) { failed(where, 'tag object'); type = null; break; }
      counts.succeeded += 1;
      const next = checkTagText(where, 'tag', obj.content.toString('utf8'));
      if (!next) { type = null; break; }
      oid = next.oid;
      type = next.type;
    }
    if (type === 'commit') startCommits.add(oid);
    else if (type === 'tree') extraTrees.push({ oid, where });
    else if (type === 'blob') noteBlob(oid, where, null);
  }

  // 2. Every commit reachable from those refs.
  let commitList = [];
  if (startCommits.size) {
    const rl = git(['rev-list', '--stdin'], [...startCommits].join('\n') + '\n');
    if (!rl.ok) return done('egress: FAIL (history cannot be listed)');
    commitList = rl.stdout.toString('utf8').split('\n').filter(Boolean);
  }

  const treeDone = new Set();
  const walkTree = (treeOid, where) => {
    if (treeDone.has(treeOid)) return;
    const r = git(['ls-tree', '-r', '-z', '--full-tree', treeOid]);
    if (!r.ok) { failed(where, 'tree'); return; }
    treeDone.add(treeOid);
    for (const entry of r.stdout.toString('utf8').split('\0')) {
      if (!entry) continue;
      const tab = entry.indexOf('\t');
      const meta = entry.slice(0, tab).split(' ');
      const p = entry.slice(tab + 1);
      if (meta[1] === 'blob') noteBlob(meta[2], where, p);
      else { counts.skipped += 1; if (!pathFirst.has(p)) pathFirst.set(p, where); } // submodule link
    }
  };

  const commits = readObjects(git, commitList);
  for (const c of commitList) {
    const obj = commits.get(c);
    if (!obj || obj.missing) { failed(c, 'commit object'); continue; }
    counts.succeeded += 1;
    const { headers, message } = parseHeaders(obj.content.toString('utf8'));
    const get = (k) => headers.find((h) => h.key === k);
    const author = get('author');
    const committer = get('committer');
    checkPerson(c, 'author', author && author.value, identity.authorExceptions.has(c));
    checkPerson(c, 'committer', committer && committer.value, false);
    checkMessage(c, 'commit message', message);
    for (const h of headers) if (h.key === 'mergetag') checkTagText(c, 'merge tag', h.value);
    const tree = get('tree');
    if (tree) walkTree(tree.value.trim(), c);
  }
  for (const t of extraTrees) walkTree(t.oid, t.where);

  // 3. Paths and blob contents, both scrub layers.
  for (const [p, where] of pathFirst) runRules(where, 'file path', { path: p, text: p, kind: 'path' });
  const blobOids = [...blobInfo.keys()];
  for (let s = 0; s < blobOids.length; s += BATCH) {
    const chunk = blobOids.slice(s, s + BATCH);
    const got = readObjects(git, chunk);
    for (const oid of chunk) {
      const info = blobInfo.get(oid);
      const o = got.get(oid);
      if (!o || o.missing) { failed(info.where, 'file content'); continue; }
      counts.succeeded += 1;
      const text = o.content.toString('utf8');
      const paths = info.paths.size ? [...info.paths] : [null];
      for (const p of paths) runRules(info.where, 'file content', { path: p, text, kind: 'file' });
    }
  }

  lines.push('egress: checked ' + counts.succeeded + ', failed ' + counts.failed + ', skipped ' + counts.skipped);
  if (!hits.length && !counts.failed) {
    if (!commitList.length && !blobOids.length) lines.push('egress: no commits yet; nothing in history to publish');
    return done('egress: PASS (' + commitList.length + ' commits, ' + blobOids.length + ' blobs)');
  }
  return done('egress: FAIL (' + hits.length + ' hits' + (counts.failed ? ', ' + counts.failed + ' failed' : '') + ')');
}

// ---------------------------------------------------------------------------
// Command line

// Real paths compared (scripts/lib/is-main.mjs), so a link or junction to the
// checkout still runs the scan instead of exiting 0 having done nothing.
if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  let repo = KIT_ROOT;
  let bad = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && i + 1 < args.length) { repo = path.resolve(args[++i]); } else { bad = true; }
  }
  if (bad) {
    console.log('usage: node scripts/egress-scan.mjs [--repo <folder>]');
    console.log('egress: FAIL (bad arguments)');
    process.exitCode = 1;
  } else {
    const r = await runEgress({ repo });
    for (const l of r.lines) console.log(l);
    process.exitCode = r.exitCode;
  }
}
