'use strict';
// File-system helpers for the search server (spec 9.6, SR-5, SR-9 b, SR-22 to SR-24).
//
// - The one path compare function of the server (SR-5).
// - One-handle reads of regular files (SR-9 b).
// - Atomic, link-safe writes: temp file in the same folder, created exclusively
//   with mode 0600, fsync, rename over the target (SR-24).
// - Leftover temp-file cleanup and POSIX permission checks (SR-22, SR-24).
//
// Errors carry a code only. No message ever holds file text.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const C = fs.constants;
const O_NOFOLLOW = C.O_NOFOLLOW || 0; // not available on Windows
const O_NONBLOCK = C.O_NONBLOCK || 0;
const O_DIRECTORY = C.O_DIRECTORY || 0;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const TEMP_MAX_AGE_MS = 10 * 60 * 1000;
// <name>.<pid>.<16 hex>.tmp; group 1 is <name>. cleanTemps removes a match only
// when <name> is one of the base names the caller lists for that folder.
const TEMP_NAME_RE = /^([A-Za-z0-9_-]{1,40}(?:\.[A-Za-z0-9_-]{1,10})?)\.[0-9]{1,10}\.[0-9a-f]{16}\.tmp$/;

class FsxError extends Error {
  constructor(code) {
    super(code);
    this.name = 'FsxError';
    this.code = code;
  }
}

function isWindows(platform) {
  return platform === 'win32';
}

// ---------------------------------------------------------------------------
// Printable paths (9.8, SR-12; the 6.11 f rule). The search plugin does not ship
// the core's meter.cjs, so this is the server's own copy of the 6.11 f table and
// cap; it MUST equal the meter's (consistency.test.cjs checks it). C0 and C1
// controls; line and paragraph separators; bidi controls; zero-width and
// invisible characters; every other Cc, Cf, Zl and Zp character (the class the
// walker and the envelope use for file names); the whole tag block
// U+E0000-U+E007F; every default-ignorable code point, except a lone U+FE0E or
// U+FE0F right after an emoji character (LONE_PRESENTATION_SELECTOR, equal to the meter's).

const PATH_MAX_CHARS = 1024;
const UNPRINTABLE_CLASSES = Object.freeze({
  controls: '\\u0000-\\u001f\\u007f-\\u009f',
  separators: '\\u2028\\u2029',
  bidi: '\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069',
  zero_width: '\\u200b-\\u200d\\u2060\\ufeff',
  format: '\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}',
  tags: '\\u{e0000}-\\u{e007f}',
  ignorable: '\\p{Default_Ignorable_Code_Point}',
});
const LONE_PRESENTATION_SELECTOR = '(?<=\\p{Emoji})[\\ufe0e\\ufe0f]';

/**
 * Builds the test: true when p may be shown (no character of UNPRINTABLE_CLASSES once a lone
 * presentation selector is set aside, at most 1,024 characters). Fails closed: if the table
 * cannot be built (a Node without the Unicode property data), no path may be shown.
 * _RegExp: test-only seam.
 */
function makePrintablePath(_RegExp = RegExp) {
  let table;
  let lone;
  try {
    table = new _RegExp('[' + Object.values(UNPRINTABLE_CLASSES).join('') + ']', 'u');
    lone = new _RegExp(LONE_PRESENTATION_SELECTOR, 'gu');
  } catch (_) {
    return function printablePath() { return false; };
  }
  return function printablePath(p) {
    if (typeof p !== 'string' || p === '' || p.length > PATH_MAX_CHARS) return false;
    return !table.test(p.replace(lone, ''));
  };
}
const printablePath = makePrintablePath();

// ---------------------------------------------------------------------------
// Path compare (SR-5). The only inside check of the server: every other module
// calls this one.

function pathApi(platform) {
  return isWindows(platform) ? path.win32 : path.posix;
}

function foldForCompare(p, platform) {
  let r = p;
  // NFC only inside comparisons, and only on macOS (SR-1).
  if (platform === 'darwin') r = r.normalize('NFC');
  if (platform === 'win32' || platform === 'darwin') r = r.toLowerCase();
  return r;
}

/**
 * True when child is parent itself or sits inside it. Path-aware: a sibling
 * `/x/ab` is not inside `/x/a`; a child folder named `..notes` is inside;
 * another drive or a UNC path is not inside. Case-insensitive on Windows and
 * macOS; NFC folded on macOS only.
 */
function isInside(child, parent, platform = process.platform) {
  const P = pathApi(platform);
  const c = foldForCompare(P.resolve(child), platform);
  const p = foldForCompare(P.resolve(parent), platform);
  const rel = P.relative(p, c);
  if (rel === '') return true;
  if (P.isAbsolute(rel)) return false;
  if (rel === '..' || rel.startsWith('..' + P.sep)) return false;
  return true;
}

function samePath(a, b, platform = process.platform) {
  const P = pathApi(platform);
  return foldForCompare(P.resolve(a), platform) === foldForCompare(P.resolve(b), platform);
}

// ---------------------------------------------------------------------------
// Folder checks

/**
 * Null when dir is a real folder (not a link) whose real path equals the
 * expected path; otherwise a problem code. The real-path compare also catches
 * a junction that lstat does not report as a link (day-one check 17).
 */
function folderProblem(dir, expected, platform = process.platform) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    return err && err.code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  if (st.isSymbolicLink()) return 'link';
  if (!st.isDirectory()) return 'not_folder';
  let real;
  try {
    real = fs.realpathSync.native(dir);
  } catch (_) {
    return 'unresolved';
  }
  if (!samePath(real, expected, platform)) return 'moved';
  return null;
}

/**
 * The folder `<rootReal>/<parts...>` checked before it is listed or changed:
 * the root itself (parts empty) or a folder strictly inside it, not a link,
 * with a real path equal to the built path. So a link or junction at the
 * folder or at any parent up to and including the root is refused (a root
 * that is not its own real path fails the same way). Returns { dir } or
 * { problem }.
 */
function checkedFolder(rootReal, parts, platform = process.platform) {
  if (typeof rootReal !== 'string' || rootReal === '' || !Array.isArray(parts)) return { problem: 'bad_path' };
  if (!pathApi(platform).isAbsolute(rootReal)) return { problem: 'bad_path' };
  const dir = parts.length ? path.join(rootReal, ...parts) : rootReal;
  if (parts.length && (!isInside(dir, rootReal, platform) || samePath(dir, rootReal, platform))) return { problem: 'outside_root' };
  const why = folderProblem(dir, dir, platform);
  return why ? { problem: why } : { dir };
}

/** True when name is one plain path part (no separator, not `.` or `..`). */
function plainName(name) {
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && !/[\\/]/.test(name);
}

/**
 * Create (if missing) the folder `name` inside the real folder `parentReal`,
 * mode 0700 set explicitly on POSIX, then check it. The parent is checked
 * first, so nothing is created through a parent swapped for a link or
 * junction. Returns its path.
 */
function ensureDir(parentReal, name, platform = process.platform) {
  if (!plainName(name)) throw new FsxError('bad_name');
  const pwhy = folderProblem(parentReal, parentReal, platform);
  if (pwhy) throw new FsxError('folder_' + pwhy);
  const dir = path.join(parentReal, name);
  try {
    fs.mkdirSync(dir, { mode: DIR_MODE });
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw new FsxError('mkdir_failed');
  }
  const why = folderProblem(dir, dir, platform);
  if (why) throw new FsxError('folder_' + why);
  if (!isWindows(platform)) chmodNoFollow(dir, DIR_MODE, true);
  return dir;
}

// ---------------------------------------------------------------------------
// One-handle read (SR-9 b)

/**
 * Read a regular file through one handle. `expect` is the walk's BigInt lstat
 * (dev and ino). Returns { buf } or { rule } where rule is a floor rule id:
 * `link` (the handle is not the file the walk saw), `special_file`,
 * `hard_link` or `too_big`. Throws on an open or read error (the caller counts
 * it by error code).
 */
function readRegular(abs, expect, maxBytes) {
  const fd = fs.openSync(abs, C.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile()) return { rule: 'special_file' };
    if (expect && (st.dev !== BigInt(expect.dev) || st.ino !== BigInt(expect.ino))) return { rule: 'link' };
    if (st.nlink !== 1n) return { rule: 'hard_link' };
    if (st.size > BigInt(maxBytes)) return { rule: 'too_big' };
    const size = Number(st.size);
    const buf = Buffer.alloc(Math.min(size, maxBytes) + 1);
    let got = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, got, buf.length - got, null);
      if (n === 0) break;
      got += n;
      if (got > maxBytes) return { rule: 'too_big' }; // grew while reading
      if (got === buf.length) break;
    }
    if (got > size) throw new FsxError('changed_during_read');
    return { buf: buf.subarray(0, got) };
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* already closed */ }
  }
}

/** lstat, then a one-handle read of a small file we own (manifest, chunks, lock). */
function readOwnFile(abs, maxBytes) {
  let st;
  try {
    st = fs.lstatSync(abs, { bigint: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return { absent: true };
    throw new FsxError('stat_failed');
  }
  if (st.isSymbolicLink()) return { rule: 'link' };
  if (!st.isFile()) return { rule: 'special_file' };
  return readRegular(abs, { dev: st.dev, ino: st.ino }, maxBytes);
}

// ---------------------------------------------------------------------------
// Atomic, link-safe write (SR-24)

function writeAll(fd, buf) {
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}

function fsyncDir(dir, platform) {
  if (isWindows(platform)) return;
  let fd = null;
  try {
    fd = fs.openSync(dir, C.O_RDONLY | O_DIRECTORY);
    fs.fsyncSync(fd);
  } catch (_) {
    // best effort: some file systems refuse a folder fsync
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) { /* ignore */ }
  }
}

function tempNameFor(name) {
  return `${name}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
}

/**
 * Write `data` to `<dir>/<name>` atomically. Before writing: lstat the folder,
 * refuse a link, refuse a real path that differs from `expectedDir`. The temp
 * file is created exclusively (`wx`, 0600, O_NOFOLLOW where the OS has it),
 * fsynced, the folder is checked again, then the temp file is renamed over the
 * target. On any failure after the temp file exists, it is unlinked before the
 * error is thrown, only through a folder that still passes the check (a
 * swapped folder's temp file is left where it is).
 *
 * opts.beforeRename: called after fsync; returning false aborts (lock lost).
 * opts._tempName / opts._failAfterTemp: test-only seams.
 */
function atomicWrite({ dir, expectedDir, name, data, beforeRename, platform = process.platform, _tempName, _failAfterTemp }) {
  const why = folderProblem(dir, expectedDir || dir, platform);
  if (why) throw new FsxError('folder_' + why);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const tmp = path.join(dir, _tempName || tempNameFor(name));
  let fd = null;
  let created = false;
  try {
    try {
      fd = fs.openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | O_NOFOLLOW, FILE_MODE);
    } catch (err) {
      throw new FsxError(err && err.code === 'EEXIST' ? 'temp_exists' : 'temp_create_failed');
    }
    created = true;
    if (!isWindows(platform)) fs.fchmodSync(fd, FILE_MODE);
    if (_failAfterTemp) throw new FsxError('forced_failure');
    writeAll(fd, buf);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (beforeRename && beforeRename() === false) throw new FsxError('lock_lost');
    // The folder is checked again right before the rename.
    const again = folderProblem(dir, expectedDir || dir, platform);
    if (again) throw new FsxError('folder_' + again);
    fs.renameSync(tmp, path.join(dir, name));
    created = false;
    fsyncDir(dir, platform);
  } catch (err) {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    // The temp file is unlinked only through a folder that still passes the check
    // (a swapped folder leaves it in the real folder, out of reach).
    if (created && !folderProblem(dir, expectedDir || dir, platform)) try { fs.unlinkSync(tmp); } catch (_) { /* gone already */ }
    if (err instanceof FsxError) throw err;
    throw new FsxError('write_failed');
  }
}

// ---------------------------------------------------------------------------
// Leftover temp files (SR-24, SR-49 a)

/**
 * Remove this server's own leftover temp files from the folder
 * `<rootReal>/<parts...>`, checked by checkedFolder before it is listed and
 * again before each delete; a refused folder is not listed (`refused` names
 * why). Only names of the exact temp pattern whose base name is in `bases`
 * (the files the server writes in that folder), regular files only (a link is
 * skipped, never followed), older than maxAgeMs by modified time (0 = any
 * age). No bases → nothing removed. Never recursive. One failing entry never
 * stops the rest. _unlink: test-only seam.
 */
function cleanTemps(rootReal, parts, { bases = [], maxAgeMs = TEMP_MAX_AGE_MS, now = Date.now(), platform = process.platform, _unlink = fs.unlinkSync } = {}) {
  const out = { removed: 0, kept: 0, failed: 0, refused: null };
  const c = checkedFolder(rootReal, parts, platform);
  if (c.problem) { out.refused = c.problem; return out; }
  const own = new Set(Array.isArray(bases) ? bases : []);
  if (!own.size) return out;
  const dir = c.dir;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    out.refused = 'unreadable';
    return out;
  }
  for (const n of names) {
    const m = TEMP_NAME_RE.exec(n);
    if (!m || !own.has(m[1])) continue;
    try {
      const p = path.join(dir, n);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink() || !st.isFile()) { out.kept++; continue; }
      if (maxAgeMs > 0 && now - st.mtimeMs < maxAgeMs) { out.kept++; continue; }
      if (folderProblem(dir, dir, platform)) { out.failed++; continue; }
      _unlink(p);
      out.removed++;
    } catch (_) {
      out.failed++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// POSIX permissions (SR-22). Windows: disclosed, not checked (SR-23).

function chmodNoFollow(p, mode, isDir) {
  // Open without following a link, then change the mode through the handle,
  // so a link planted in our folder is never chmod-ed and its target is safe.
  const fd = fs.openSync(p, C.O_RDONLY | O_NOFOLLOW | (isDir ? O_DIRECTORY : O_NONBLOCK));
  try {
    fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
}

function permProblem(st, wantMode, uid) {
  if (st.uid !== uid) return 'not_owner';
  if ((st.mode & 0o077) !== 0) return 'loose';
  if ((st.mode & 0o777) !== wantMode) return 'loose';
  return null;
}

/**
 * Check the data root and the server's own items under it: the data root,
 * `indexes/`, each index folder, and the files directly inside those folders.
 * Each must be owned by the current user with no group or other bits. A loose
 * item is tightened once (through a no-follow handle) and checked again. Links
 * are skipped. Each folder is checked (checkedFolder, from the data root's
 * real path) before it is listed, and the folder holding an item is checked
 * again right before the item is tightened, so nothing is listed or changed
 * through a link or junction; a folder that fails (other than missing) is a
 * problem. Nothing outside the data root is touched. Never recursive beyond
 * that fixed shape.
 *
 * Returns { ok, skipped, problems: [code], tightened }.
 * opts.uid: test-only seam for the owner check.
 */
function checkPermissions(dataRoot, { platform = process.platform, uid } = {}) {
  if (isWindows(platform)) {
    return { ok: true, skipped: 'windows permissions are inherited from the profile folder and not checked', problems: [], tightened: 0 };
  }
  const me = uid !== undefined ? uid : (typeof process.getuid === 'function' ? process.getuid() : -1);
  const problems = [];
  let tightened = 0;

  // `parts`: the folder itself (isDir) or the folder holding the file, below the data root.
  const visit = (p, isDir, parts) => {
    let st;
    try { st = fs.lstatSync(p); } catch (_) { return; }
    if (st.isSymbolicLink()) return;
    if (isDir && !st.isDirectory()) return;
    if (!isDir && !st.isFile()) return;
    const want = isDir ? DIR_MODE : FILE_MODE;
    let why = permProblem(st, want, me);
    if (why === 'loose') {
      try {
        if (checkedFolder(dataRoot, parts, platform).problem) throw new FsxError('folder_changed');
        chmodNoFollow(p, want, isDir);
        tightened++;
        why = permProblem(fs.lstatSync(p), want, me);
      } catch (_) {
        why = 'tighten_failed';
      }
    }
    if (why) problems.push(why);
  };

  const namesIn = (parts) => {
    const c = checkedFolder(dataRoot, parts, platform);
    if (c.problem) {
      if (c.problem !== 'missing') problems.push('folder_' + c.problem);
      return [];
    }
    try { return fs.readdirSync(c.dir); } catch (_) { return []; }
  };

  visit(dataRoot, true, []);
  for (const n of namesIn([])) {
    const p = path.join(dataRoot, n);
    let st;
    try { st = fs.lstatSync(p); } catch (_) { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isFile()) visit(p, false, []);
  }
  const indexes = path.join(dataRoot, 'indexes');
  visit(indexes, true, ['indexes']);
  for (const n of namesIn(['indexes'])) {
    const d = path.join(indexes, n);
    let st;
    try { st = fs.lstatSync(d); } catch (_) { continue; }
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    visit(d, true, ['indexes', n]);
    for (const fn of namesIn(['indexes', n])) {
      const f = path.join(d, fn);
      let fst;
      try { fst = fs.lstatSync(f); } catch (_) { continue; }
      if (fst.isSymbolicLink() || !fst.isFile()) continue;
      visit(f, false, ['indexes', n]);
    }
  }
  return { ok: problems.length === 0, skipped: null, problems, tightened };
}

module.exports = {
  FsxError,
  DIR_MODE,
  FILE_MODE,
  TEMP_MAX_AGE_MS,
  TEMP_NAME_RE,
  PATH_MAX_CHARS,
  UNPRINTABLE_CLASSES,
  LONE_PRESENTATION_SELECTOR,
  makePrintablePath,
  printablePath,
  isInside,
  samePath,
  folderProblem,
  checkedFolder,
  ensureDir,
  readRegular,
  readOwnFile,
  atomicWrite,
  cleanTemps,
  checkPermissions,
  tempNameFor,
};
