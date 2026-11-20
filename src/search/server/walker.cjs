'use strict';
// File listing (spec 9.2, 9.11, SR-9, SR-11, SR-14).
//
// - Only regular files and folders are walked. Links, junctions and other
//   reparse points are never followed; a FIFO, socket or device is skipped
//   and never opened. Every folder is also checked by real path before it is
//   listed: its real path must equal its parent's real path joined with its
//   own name, else it is skipped as a link (this catches a junction even if
//   lstat did not report it).
// - A file with more than one hard link is skipped.
// - Unsafe names are skipped (SR-11).
// - Every file is read through one handle (fsx.readRegular): its device and
//   inode must equal the walk's lstat, it must be a regular file with one
//   link and a size within the cap.
// - Every skip is counted under one rule id. One failing entry never stops
//   the walk.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fsx = require('./fsx.cjs');
const floor = require('./floor.cjs');
const scan = require('./scan.cjs');

const MAX_ENTRIES = 200000;
const MAX_SEGMENT_CHARS = 120;
const MAX_PATH_CHARS = 240;
const YIELD_EVERY = 256;

const R = floor.RULES;

function yieldNow() {
  return new Promise((resolve) => setImmediate(resolve));
}

function codePoints(s) {
  return Array.from(s, (c) => c.codePointAt(0));
}

const CC_CF_RE = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]$/u;
const BAD_ASCII = new Set(['<', '>', '`', '|']);

/** SR-11: true when a root-relative path holds an unsafe character or is too long. */
function unsafeName(rel) {
  const cps = codePoints(rel);
  if (cps.length > MAX_PATH_CHARS) return true;
  for (const seg of rel.split('/')) {
    const s = codePoints(seg);
    if (s.length > MAX_SEGMENT_CHARS) return true;
    for (let i = 0; i < s.length; i++) {
      const cp = s[i];
      const ch = String.fromCodePoint(cp);
      if (BAD_ASCII.has(ch)) return true;
      if (cp < 0x20 || cp === 0x7f || CC_CF_RE.test(ch) || scan.isInvisible(cp)) {
        const prevJoiner = s[i - 1] === 0x200c || s[i - 1] === 0x200d;
        const nextJoiner = s[i + 1] === 0x200c || s[i + 1] === 0x200d;
        if (!prevJoiner && !nextJoiner && scan.joinerAllowedInName(s[i - 1], cp, s[i + 1])) continue;
        return true;
      }
    }
  }
  return false;
}

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

/**
 * Walk the bound root. Returns
 * { files: [{ rel, abs, size, mtimeMs, dev, ino }], visited, skipped, skippedDirs,
 *   failed, failedDirs, incomplete }.
 * `failed` counts visited files only (so skipped + failed + accepted files =
 * visited); a folder that cannot be listed or checked goes in `failedDirs`.
 *
 * opts: { filter, ignore, maxEntries, hooks }. hooks.onSkip(rel, rule, isDir)
 * is told of each skip by name (used only by the terminal skip report, SR-33).
 */
async function walk(rootReal, { filter, ignore = null, maxEntries = MAX_ENTRIES, hooks = {} } = {}) {
  const out = { files: [], visited: 0, skipped: {}, skippedDirs: {}, failed: {}, failedDirs: {}, incomplete: null };
  const stack = [{ abs: rootReal, rel: '', expectedReal: rootReal }];
  let entries = 0;
  while (stack.length) {
    const dir = stack.pop();
    // Real-path check before listing (SR-9 b).
    let real;
    try {
      real = fs.realpathSync.native(dir.abs);
    } catch (err) {
      bump(out.failedDirs, (err && err.code) || 'error');
      continue;
    }
    if (!fsx.samePath(real, dir.expectedReal)) {
      bump(out.skippedDirs, R.LINK);
      continue;
    }
    if (ignore) {
      try { ignore.loadFolder(dir.rel, dir.abs); } catch (_) { bump(out.failedDirs, 'ignore_read'); }
    }
    let names;
    try {
      names = fs.readdirSync(dir.abs);
    } catch (err) {
      bump(out.failedDirs, (err && err.code) || 'error');
      continue;
    }
    names.sort();
    const subdirs = [];
    for (const name of names) {
      if (entries >= maxEntries) { out.incomplete = 'walk_limit'; return out; }
      entries++;
      if (entries % YIELD_EVERY === 0) await yieldNow();
      const abs = path.join(dir.abs, name);
      const rel = dir.rel ? dir.rel + '/' + name : name;
      let st;
      try {
        st = fs.lstatSync(abs, { bigint: true });
      } catch (err) {
        out.visited++;
        bump(out.failed, (err && err.code) || 'error');
        continue;
      }
      if (st.isDirectory()) {
        let rule = null;
        if (unsafeName(rel)) rule = R.UNSAFE_NAME;
        else rule = floor.folderRule(filter, name, rel);
        if (!rule && ignore && ignore.isIgnored(rel, true)) rule = R.GIT_IGNORED;
        if (rule) {
          bump(out.skippedDirs, rule);
          if (hooks.onSkip) hooks.onSkip(rel, rule, true);
          continue;
        }
        subdirs.push({ abs, rel, expectedReal: path.join(real, name) });
        continue;
      }
      out.visited++;
      let rule = null;
      if (st.isSymbolicLink()) rule = R.LINK;
      else if (!st.isFile()) rule = R.SPECIAL;
      else if (unsafeName(rel)) rule = R.UNSAFE_NAME;
      else rule = floor.fileRule(filter, name, rel);
      if (!rule && ignore && ignore.isIgnored(rel, false)) rule = R.GIT_IGNORED;
      if (!rule && st.nlink > 1n) rule = R.HARD_LINK;
      if (!rule && st.size > BigInt(filter.maxFileBytes)) rule = R.TOO_BIG;
      if (rule) {
        bump(out.skipped, rule);
        if (hooks.onSkip) hooks.onSkip(rel, rule, false);
        continue;
      }
      out.files.push({
        rel,
        abs,
        size: Number(st.size),
        mtimeMs: Number(st.mtimeMs),
        mtimeNs: st.mtimeNs.toString(),
        dev: st.dev,
        ino: st.ino,
      });
    }
    // Depth-first, in name order.
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
    if (hooks.afterFolder) hooks.afterFolder(dir.rel);
  }
  return out;
}

/**
 * Read one walked file through one handle and apply the content rules.
 * Returns { text, sha256, size } | { rule } | { fail: code }.
 *
 * hooks.beforeOpen(abs): test-only seam between the walk's lstat and the open.
 */
function readFile(file, { filter, hooks = {} } = {}) {
  try {
    if (hooks.beforeOpen) hooks.beforeOpen(file.abs, file.rel);
    const res = fsx.readRegular(file.abs, { dev: file.dev, ino: file.ino }, filter.maxFileBytes);
    if (!res.buf) return { rule: res.rule };
    const text0 = floor.decodeText(res.buf);
    if (text0 === null) return { rule: R.NOT_TEXT };
    const text = scan.stripBom(text0);
    if (floor.hasOptOut(text)) return { rule: R.OPT_OUT };
    const sha256 = crypto.createHash('sha256').update(res.buf).digest('hex');
    return { text, sha256, size: res.buf.length };
  } catch (err) {
    if (err && err.code === 'ELOOP') return { rule: R.LINK };
    return { fail: (err && err.code) || (err && err.name) || 'error' };
  }
}

/** sha256 of a file's bytes through one handle (stat-pass re-hash). */
function hashFile(file, { filter }) {
  const res = fsx.readRegular(file.abs, { dev: file.dev, ino: file.ino }, filter.maxFileBytes);
  if (!res.buf) return { rule: res.rule };
  return { sha256: crypto.createHash('sha256').update(res.buf).digest('hex') };
}

module.exports = {
  MAX_ENTRIES,
  MAX_SEGMENT_CHARS,
  MAX_PATH_CHARS,
  unsafeName,
  walk,
  readFile,
  hashFile,
};
