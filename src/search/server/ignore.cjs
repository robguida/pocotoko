'use strict';
// Git-ignore rules, read without running git, failing closed (spec SR-10).
// Also the glob matcher used for the user's `never_globs` option (SR-12).
//
// Supported pattern syntax: `*`, `?`, `**` as a whole path segment, bracket
// classes (`[abc]`, `[a-z]`, `[!a]`, `[^a]`), a leading `/` (anchored) and a
// trailing `/` (folders only). Anything else (a backslash escape, a POSIX
// class such as `[[:alpha:]]`, an unclosed bracket) is unsupported, and an
// unsupported line counts as unparseable: it ignores everything at and below
// that file's folder. Negation lines (`!pattern`) are not honoured: a file any
// ignore line matches stays out.
//
// Matching never uses a regular expression built from the pattern. It is a
// bounded segment-by-segment match (memoised), and patterns are capped at 512
// characters and 16 `*`, so every match stays small.
//
// Superset of git (SR-10 e):
// - Each pattern is matched twice, once per Unicode code point and once per
//   UTF-8 byte (git's own unit), and a path is ignored when either matches.
//   So `??.md` ignores `é.md` as git does, and `?.md` also ignores `é.md`.
// - On Windows and macOS, where git ignores case by default (core.ignorecase),
//   matching ignores case too: per code point by simple case mapping, per byte
//   for ASCII letters (git's own rule).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fsx = require('./fsx.cjs');

const MAX_PATTERN_CHARS = 512;
const MAX_PATTERN_STARS = 16;
const MAX_IGNORE_FILE_BYTES = 1024 * 1024;
const GLOBSTAR = Object.freeze({ globstar: true });

// ---------------------------------------------------------------------------
// Glob compile and match

const U_BACKSLASH = 0x5c;
const U_STAR = 0x2a;
const U_QUESTION = 0x3f;
const U_OPEN = 0x5b;
const U_CLOSE = 0x5d;
const U_BANG = 0x21;
const U_CARET = 0x5e;
const U_DASH = 0x2d;
const U_COLON = 0x3a;

/** A string as code points (mode 'cp') or as UTF-8 bytes (mode 'byte'). */
function toUnits(s, mode) {
  if (mode === 'byte') return Array.from(Buffer.from(s, 'utf8'));
  return Array.from(s, (c) => c.codePointAt(0));
}

/**
 * Parse one path segment (as units) into tokens, or return null when
 * unsupported. Every syntax character is ASCII, so both unit kinds parse the
 * same way.
 */
function compileSegment(seg) {
  const toks = [];
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === U_BACKSLASH) return null; // escapes unsupported
    if (ch === U_STAR) {
      if (toks.length && toks[toks.length - 1].t === '*') continue;
      toks.push({ t: '*' });
    } else if (ch === U_QUESTION) {
      toks.push({ t: '?' });
    } else if (ch === U_OPEN) {
      let j = i + 1;
      let neg = false;
      if (seg[j] === U_BANG || seg[j] === U_CARET) { neg = true; j++; }
      const items = [];
      let first = true;
      let closed = false;
      for (; j < seg.length; j++) {
        const c = seg[j];
        if (c === U_CLOSE && !first) { closed = true; break; }
        if (c === U_BACKSLASH) return null;
        if (c === U_OPEN && seg[j + 1] === U_COLON) return null; // POSIX class unsupported
        if (seg[j + 1] === U_DASH && seg[j + 2] !== undefined && seg[j + 2] !== U_CLOSE) {
          items.push([c, seg[j + 2]]);
          j += 2;
        } else {
          items.push([c, c]);
        }
        first = false;
      }
      if (!closed) return null;
      toks.push({ t: '[', neg, items });
      i = j;
    } else {
      toks.push({ t: 'c', c: ch });
    }
  }
  return toks;
}

/** Simple case variants of one unit: bytes fold ASCII letters only (git's rule). */
function caseVariants(u, mode) {
  if (mode === 'byte') {
    if (u >= 0x41 && u <= 0x5a) return [u + 0x20];
    if (u >= 0x61 && u <= 0x7a) return [u - 0x20];
    return [];
  }
  if (u < 0x80) {
    if (u >= 0x41 && u <= 0x5a) return [u + 0x20];
    if (u >= 0x61 && u <= 0x7a) return [u - 0x20];
    return [];
  }
  const ch = String.fromCodePoint(u);
  const out = [];
  for (const v of [ch.toLowerCase(), ch.toUpperCase()]) {
    const cps = Array.from(v);
    if (cps.length === 1) {
      const c = cps[0].codePointAt(0);
      if (c !== u && !out.includes(c)) out.push(c);
    }
  }
  return out;
}

function inItems(items, u) {
  for (const [a, b] of items) if (u >= a && u <= b) return true;
  return false;
}

function tokMatches(tok, u, mode, fold) {
  if (tok.t === '?') return true;
  if (tok.t === 'c') {
    if (tok.c === u) return true;
    return fold && caseVariants(u, mode).includes(tok.c);
  }
  let hit = inItems(tok.items, u);
  if (!hit && fold) for (const v of caseVariants(u, mode)) if (inItems(tok.items, v)) { hit = true; break; }
  return tok.neg ? !hit : hit;
}

/** Match one name (units) against segment tokens. Two-pointer with one star restart: O(n*m). */
function segmentMatch(toks, name, mode, fold) {
  let ti = 0;
  let ni = 0;
  let starTi = -1;
  let starNi = 0;
  while (ni < name.length) {
    if (ti < toks.length && toks[ti].t === '*') {
      starTi = ti++;
      starNi = ni;
    } else if (ti < toks.length && tokMatches(toks[ti], name[ni], mode, fold)) {
      ti++;
      ni++;
    } else if (starTi >= 0) {
      ti = starTi + 1;
      ni = ++starNi;
    } else {
      return false;
    }
  }
  while (ti < toks.length && toks[ti].t === '*') ti++;
  return ti === toks.length;
}

function countStars(p) {
  let n = 0;
  for (const ch of p) if (ch === '*') n++;
  return n;
}

/**
 * Compile a glob into { segs, bsegs, anchored, dirOnly } or { error }: `segs`
 * per code point, `bsegs` per UTF-8 byte. A pattern with no `/` (other than a
 * trailing one) matches a name at any depth.
 */
function compileGlob(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return { error: 'empty' };
  if (raw.length > MAX_PATTERN_CHARS) return { error: 'too_long' };
  if (countStars(raw) > MAX_PATTERN_STARS) return { error: 'too_many_stars' };
  let p = raw;
  let dirOnly = false;
  if (p.endsWith('/')) { dirOnly = true; p = p.replace(/\/+$/, ''); }
  if (p === '') return { error: 'empty' };
  const hasInnerSlash = p.includes('/');
  let anchored = hasInnerSlash;
  if (p.startsWith('/')) p = p.replace(/^\/+/, '');
  if (p === '') return { error: 'empty' };
  const segs = [];
  const bsegs = [];
  if (!anchored) { segs.push(GLOBSTAR); bsegs.push(GLOBSTAR); }
  for (const s of p.split('/')) {
    if (s === '') continue;
    if (s === '**') {
      if (segs.length && segs[segs.length - 1] === GLOBSTAR) continue;
      segs.push(GLOBSTAR);
      bsegs.push(GLOBSTAR);
      continue;
    }
    const toks = compileSegment(toUnits(s, 'cp'));
    const btoks = compileSegment(toUnits(s, 'byte'));
    if (!toks || !btoks) return { error: 'unsupported' };
    segs.push(toks);
    bsegs.push(btoks);
  }
  return { segs, bsegs, anchored, dirOnly };
}

/** Match compiled segments against path parts (memoised; bounded by caps). */
function globMatchParts(segs, parts, mode, fold) {
  const memo = new Map();
  const go = (si, pi) => {
    const key = si * 4096 + pi;
    if (memo.has(key)) return memo.get(key);
    let r;
    if (si === segs.length) {
      r = pi === parts.length;
    } else if (segs[si] === GLOBSTAR) {
      r = false;
      for (let k = pi; k <= parts.length && !r; k++) r = go(si + 1, k);
    } else if (pi === parts.length) {
      r = false;
    } else {
      r = segmentMatch(segs[si], parts[pi], mode, fold) && go(si + 1, pi + 1);
    }
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

/** A relative path (`/` separators) split into parts, as code points and as bytes. */
function preparePath(rel) {
  const parts = rel.split('/').filter((s) => s !== '');
  return { cp: parts.map((s) => toUnits(s, 'cp')), byte: parts.map((s) => toUnits(s, 'byte')) };
}

/** True when the compiled glob matches a prepared path. */
function matchPrepared(g, prepared, isDir, fold = false) {
  if (!g || g.error) return false;
  if (g.dirOnly && !isDir) return false;
  return globMatchParts(g.segs, prepared.cp, 'cp', fold) || globMatchParts(g.bsegs, prepared.byte, 'byte', fold);
}

/**
 * True when the compiled glob matches the relative path (`/` separators).
 * fold: ignore case (git's core.ignorecase).
 */
function globMatches(g, rel, isDir, fold = false) {
  if (!g || g.error) return false;
  return matchPrepared(g, preparePath(rel), isDir, fold);
}

/** Whether ignore matching folds case on this platform (git's core.ignorecase default). */
function foldsCase(platform = process.platform) {
  return platform === 'win32' || platform === 'darwin';
}

// ---------------------------------------------------------------------------
// Ignore files

/**
 * Parse ignore-file text. Returns { rules, unparseable, negations }. Any line
 * that cannot be compiled makes the whole file unparseable (fail closed).
 */
function parseIgnoreText(text) {
  const rules = [];
  let negations = 0;
  let unparseable = false;
  for (let line of text.split('\n')) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    line = line.replace(/[ \t]+$/, '');
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('!')) { negations++; continue; } // not honoured
    const g = compileGlob(line);
    if (g.error) { unparseable = true; continue; }
    rules.push(g);
  }
  return { rules, unparseable, negations };
}

/**
 * Read an ignore file the SR-9 b way. Returns { absent } | { text } |
 * { unsafe: code }.
 */
function readIgnoreFile(abs) {
  let st;
  try {
    st = fs.lstatSync(abs, { bigint: true });
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return { absent: true };
    return { unsafe: 'unreadable' };
  }
  if (st.isSymbolicLink()) return { unsafe: 'link' };
  if (!st.isFile()) return { unsafe: 'special_file' };
  if (st.size > BigInt(MAX_IGNORE_FILE_BYTES)) return { unsafe: 'too_big' };
  let res;
  try {
    res = fsx.readRegular(abs, { dev: st.dev, ino: st.ino }, MAX_IGNORE_FILE_BYTES);
  } catch (_) {
    return { unsafe: 'unreadable' };
  }
  if (!res.buf) return { unsafe: res.rule };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(res.buf) };
  } catch (_) {
    return { unsafe: 'not_text' };
  }
}

/** Default place of git's global excludes file (no git config is read). */
function defaultGlobalExcludes(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, 'git', 'ignore');
  return path.join(os.homedir(), '.config', 'git', 'ignore');
}

/**
 * Find the git folder for a work tree top. `.git` may be a folder, or a file
 * holding `gitdir: <path>` (a worktree or submodule); that folder's
 * `commondir` file, if present, names the folder whose `info/exclude` applies.
 * Returns { infoExclude } (a path) or { unsafe } or {}.
 */
function findInfoExclude(top) {
  const dotGit = path.join(top, '.git');
  let st;
  try {
    st = fs.lstatSync(dotGit);
  } catch (_) {
    return {};
  }
  if (st.isSymbolicLink()) return { unsafe: 'git_link' };
  let gitDir;
  if (st.isDirectory()) {
    gitDir = dotGit;
  } else if (st.isFile()) {
    const r = readIgnoreFile(dotGit);
    if (!r.text) return { unsafe: 'git_file_unreadable' };
    const m = /^gitdir:[ \t]*(.+?)[ \t]*\r?$/m.exec(r.text);
    if (!m) return { unsafe: 'git_file_unreadable' };
    gitDir = path.resolve(top, m[1]);
    const cd = readIgnoreFile(path.join(gitDir, 'commondir'));
    if (cd.text) {
      const rel = cd.text.split('\n')[0].replace(/\r$/, '').trim();
      if (rel) gitDir = path.resolve(gitDir, rel);
    } else if (cd.unsafe) {
      return { unsafe: 'commondir_unsafe' };
    }
  } else {
    return { unsafe: 'git_special' };
  }
  return { infoExclude: path.join(gitDir, 'info', 'exclude') };
}

/**
 * Walk up from root to the nearest folder holding a `.git` entry (git work
 * tree top). ceiling: test-only seam; the walk stops after that folder.
 */
function findWorkTreeTop(rootReal, ceiling = null) {
  let cur = rootReal;
  for (;;) {
    try {
      fs.lstatSync(path.join(cur, '.git'));
      return cur;
    } catch (_) { /* keep walking up */ }
    if (ceiling && fsx.samePath(cur, ceiling)) return null;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

function toSlash(p) {
  return p.split(path.sep).join('/');
}

/**
 * Create the matcher for one bound root.
 *
 * opts.ceiling: test-only seam; the upward search for `.git` stops there.
 * opts.globalExcludes: path of the global excludes file, or null to skip it.
 *   Default: git's default place. A global file that is a link, unsafe or
 *   unparseable is not used and is counted (`global_excludes_unread`), like an
 *   absent one: it sits outside the project and reading it is a SHOULD, so it
 *   never turns search off for every project.
 *
 * Rule sets have a `base` (root-relative folder, '' for the root) or a
 * `prefix` (the root's path relative to a folder above it). When the root sits
 * below the top of a git work tree, the `.gitignore` files of the folders
 * above it up to that top, and that top's `info/exclude`, apply too.
 */
function createIgnore(rootReal, opts = {}) {
  const fold = foldsCase(opts.platform || process.platform); // opts.platform: test-only seam
  const sets = [];
  const problems = { unparseable: 0, negations: 0, global_excludes_unread: 0 };
  let ignoreAll = null; // reason, when everything is ignored

  const addFile = (abs, where, { failOpen = false } = {}) => {
    const r = readIgnoreFile(abs);
    if (r.absent) return;
    if (r.unsafe) {
      if (failOpen) { problems.global_excludes_unread++; return; }
      problems.unparseable++;
      sets.push({ ...where, all: true, rules: [] });
      return;
    }
    const parsed = parseIgnoreText(r.text);
    if (parsed.unparseable && failOpen) { problems.global_excludes_unread++; return; }
    problems.negations += parsed.negations;
    if (parsed.unparseable) {
      problems.unparseable++;
      sets.push({ ...where, all: true, rules: [] });
      return;
    }
    sets.push({ ...where, all: false, rules: parsed.rules });
  };

  const top = findWorkTreeTop(rootReal, opts.ceiling || null);
  let topPrefix = '';
  if (top && !fsx.samePath(top, rootReal)) {
    topPrefix = toSlash(path.relative(top, rootReal));
    // Folders from the top down to (not including) the root.
    const parts = topPrefix.split('/');
    for (let i = 0; i < parts.length; i++) {
      const dirAbs = path.join(top, ...parts.slice(0, i));
      const prefix = parts.slice(i).join('/');
      addFile(path.join(dirAbs, '.gitignore'), { prefix });
    }
  }
  if (top) {
    const ie = findInfoExclude(top);
    if (ie.unsafe) {
      ignoreAll = 'info_exclude_unsafe';
    } else if (ie.infoExclude) {
      const r = readIgnoreFile(ie.infoExclude);
      if (r.unsafe) {
        ignoreAll = 'info_exclude_unsafe';
      } else if (!r.absent) {
        const parsed = parseIgnoreText(r.text);
        problems.negations += parsed.negations;
        if (parsed.unparseable) { problems.unparseable++; ignoreAll = 'info_exclude_unparseable'; }
        else sets.push({ prefix: topPrefix, all: false, rules: parsed.rules });
      }
    }
  }
  const globalPath = opts.globalExcludes === undefined ? defaultGlobalExcludes() : opts.globalExcludes;
  if (globalPath) addFile(globalPath, { prefix: topPrefix }, { failOpen: true });

  // A folder above the root that an ignore line matches puts the whole root out.
  if (!ignoreAll && topPrefix) {
    const parts = topPrefix.split('/');
    for (let i = 1; i <= parts.length && !ignoreAll; i++) {
      const anc = parts.slice(0, i).join('/');
      for (const s of sets) {
        if (s.prefix === undefined) continue;
        // s.prefix is the root's path below that set's folder; the set's view
        // of this ancestor is the ancestor's own tail below the set's folder.
        const below = topPrefix.slice(0, topPrefix.length - s.prefix.length).replace(/\/$/, '');
        if (below && !(anc + '/').startsWith(below + '/')) continue;
        const sub = below ? anc.slice(below.length).replace(/^\//, '') : anc;
        if (!sub) continue;
        if (s.all || s.rules.some((g) => globMatches(g, sub, true, fold))) { ignoreAll = 'root_ignored'; break; }
      }
    }
  }

  return {
    problems,
    get ignoreAll() { return ignoreAll; },
    /** Read `<absDir>/.gitignore` for the root-relative folder relDir ('' = root). */
    loadFolder(relDir, absDir) {
      addFile(path.join(absDir, '.gitignore'), { base: relDir });
    },
    /** True when the root-relative path is ignored. */
    isIgnored(rel, isDir) {
      if (ignoreAll) return true;
      for (const s of sets) {
        let sub;
        if (s.prefix !== undefined) {
          sub = s.prefix ? s.prefix + '/' + rel : rel;
        } else if (s.base === '') {
          sub = rel;
        } else if (underBase(rel, s.base)) {
          sub = rel.slice(s.base.length + 1);
        } else {
          continue;
        }
        if (s.all) return true;
        if (!s.rules.length) continue;
        const prepared = preparePath(sub);
        for (const g of s.rules) if (matchPrepared(g, prepared, isDir, fold)) return true;
      }
      return false;
    },
    get foldsCase() { return fold; },
  };

  // A nested .gitignore applies below its own folder; with case folding the
  // folder name compares without case too (git looks the file up through the
  // same case-blind file system).
  function underBase(rel, base) {
    if (rel.length <= base.length + 1 || rel[base.length] !== '/') return false;
    const head = rel.slice(0, base.length);
    return fold ? head.toLowerCase() === base.toLowerCase() : head === base;
  }
}

module.exports = {
  MAX_PATTERN_CHARS,
  MAX_PATTERN_STARS,
  MAX_IGNORE_FILE_BYTES,
  compileGlob,
  globMatches,
  foldsCase,
  parseIgnoreText,
  readIgnoreFile,
  defaultGlobalExcludes,
  createIgnore,
};
