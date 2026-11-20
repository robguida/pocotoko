'use strict';
// fsx.cjs (spec SR-5, SR-22 to SR-24): T-25 (server part), T-31, T-12 and the temp-file cleanup.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const X = require('../../src/search/server/fsx.cjs');
const { makeTempDir, removeDir } = require('../helpers/tmpdir-sandbox.cjs');

const IS_WIN = process.platform === 'win32';
const made = [];
test.after(() => { for (const d of made) removeDir(d); });

function tmp(name) {
  const d = fs.realpathSync.native(makeTempDir('fsx-' + name));
  made.push(d);
  return d;
}

function dirLink(target, link) {
  fs.symlinkSync(target, link, IS_WIN ? 'junction' : 'dir');
}

function tempNames(dir) {
  return fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
}

// ---------------------------------------------------------------------------
// T-25 (server part)

test('T-25: path compare, POSIX rules (Linux: case matters)', () => {
  assert.equal(X.isInside('/x/ab', '/x/a', 'linux'), false);
  assert.equal(X.isInside('/x/a/../b', '/x/a', 'linux'), false);
  assert.equal(X.isInside('/x/a/..notes', '/x/a', 'linux'), true);
  assert.equal(X.isInside('/x/a', '/x/a', 'linux'), true);
  assert.equal(X.isInside('/x/a/b', '/x/a', 'linux'), true);
  assert.equal(X.isInside('/x/A/b', '/x/a', 'linux'), false);
});

test('T-25: path compare, macOS: case and Unicode form differences are the same name', () => {
  assert.equal(X.isInside('/x/A/b', '/x/a', 'darwin'), true);
  assert.equal(X.isInside('/x/caf\u0065\u0301/b', '/x/caf\u00e9', 'darwin'), true);
  assert.equal(X.isInside('/x/caf\u0065\u0301/b', '/x/caf\u00e9', 'linux'), false);
  assert.equal(X.isInside('/x/ab', '/x/a', 'darwin'), false);
});

test('T-25: path compare, Windows: drives, UNC paths and case', () => {
  assert.equal(X.isInside('D:\\x\\a', 'C:\\x', 'win32'), false);
  assert.equal(X.isInside('\\\\srv\\share\\x', 'C:\\x', 'win32'), false);
  assert.equal(X.isInside('C:\\X\\A\\b', 'c:\\x\\a', 'win32'), true);
  assert.equal(X.isInside('C:\\x\\ab', 'C:\\x\\a', 'win32'), false);
  assert.equal(X.isInside('C:\\x\\a\\..notes', 'C:\\x\\a', 'win32'), true);
  assert.equal(X.isInside('C:\\x\\a\\..\\b', 'C:\\x\\a', 'win32'), false);
  assert.equal(X.samePath('C:\\X', 'c:\\x', 'win32'), true);
  assert.equal(X.samePath('/X', '/x', 'linux'), false);
});

// ---------------------------------------------------------------------------
// T-31 atomic, link-safe writes

test('T-31: on success the target is replaced in one rename with the new bytes; no temp file is left', () => {
  const d = tmp('ok');
  fs.writeFileSync(path.join(d, 'manifest.json'), 'old');
  X.atomicWrite({ dir: d, name: 'manifest.json', data: 'new bytes' });
  assert.equal(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8'), 'new bytes');
  assert.deepEqual(tempNames(d), []);
});

test('T-31: a target folder that is a link or junction is refused', () => {
  const d = tmp('folder-link');
  const real = path.join(d, 'real');
  fs.mkdirSync(real);
  const link = path.join(d, 'link');
  dirLink(real, link);
  assert.throws(() => X.atomicWrite({ dir: link, name: 'a.json', data: 'x' }), { code: 'folder_link' });
  assert.deepEqual(fs.readdirSync(real), []);
});

test('T-31: a folder whose real path differs from the expected path is refused (the junction case lstat may miss)', () => {
  const d = tmp('moved');
  const a = path.join(d, 'a');
  fs.mkdirSync(a);
  assert.throws(() => X.atomicWrite({ dir: a, expectedDir: path.join(d, 'b'), name: 'x.json', data: 'x' }), { code: 'folder_moved' });
  assert.deepEqual(fs.readdirSync(a), []);
});

test('T-31: something pre-planted at the temp name makes the exclusive create fail; its target is untouched', () => {
  const d = tmp('planted');
  const outside = path.join(d, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'untouched');
  const dir = path.join(d, 'idx');
  fs.mkdirSync(dir);
  const tname = X.tempNameFor('manifest.json');
  dirLink(outside, path.join(dir, tname));
  assert.throws(() => X.atomicWrite({ dir, name: 'manifest.json', data: 'x', _tempName: tname }), { code: 'temp_exists' });
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'untouched');
  assert.deepEqual(fs.readdirSync(outside), ['keep.txt']);
  assert.ok(fs.lstatSync(path.join(dir, tname)).isSymbolicLink());
});

test('T-31: a failure forced after the temp file is created leaves no temp file', () => {
  const d = tmp('crash');
  assert.throws(() => X.atomicWrite({ dir: d, name: 'chunks.jsonl', data: 'secret sentence', _failAfterTemp: true }), { code: 'forced_failure' });
  assert.deepEqual(fs.readdirSync(d), []);
});

test('T-31: a lost lock before the rename aborts the write and removes the temp file', () => {
  const d = tmp('lock-lost');
  assert.throws(() => X.atomicWrite({ dir: d, name: 'chunks.jsonl', data: 'x', beforeRename: () => false }), { code: 'lock_lost' });
  assert.deepEqual(fs.readdirSync(d), []);
});

test('T-31: files are created 0600 and folders 0700 on POSIX, even with a loose umask', { skip: IS_WIN && 'POSIX modes do not apply on Windows (SR-23)' }, () => {
  const d = tmp('modes');
  const old = process.umask(0);
  try {
    const sub = X.ensureDir(d, 'indexes');
    X.atomicWrite({ dir: sub, name: 'manifest.json', data: 'x' });
    assert.equal(fs.statSync(sub).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(sub, 'manifest.json')).mode & 0o777, 0o600);
  } finally {
    process.umask(old);
  }
});

// ---------------------------------------------------------------------------
// Temp-file cleanup (SR-24)

test('leftover temp files: only the exact pattern, regular files, older than 10 minutes; links skipped', () => {
  const d = tmp('clean');
  const now = Date.now();
  const old = X.tempNameFor('chunks.jsonl');
  const fresh = X.tempNameFor('manifest.json');
  fs.writeFileSync(path.join(d, old), 'old');
  fs.writeFileSync(path.join(d, fresh), 'fresh');
  fs.writeFileSync(path.join(d, 'notes.tmp'), 'other');
  const t = new Date(now - 11 * 60 * 1000);
  fs.utimesSync(path.join(d, old), t, t);
  fs.utimesSync(path.join(d, 'notes.tmp'), t, t);
  const target = path.join(d, 'target-dir');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
  const linkName = X.tempNameFor('lock');
  dirLink(target, path.join(d, linkName));
  const r = X.cleanTemps(d, { now });
  assert.equal(r.removed, 1);
  const left = fs.readdirSync(d).sort();
  assert.ok(!left.includes(old));
  assert.ok(left.includes(fresh) && left.includes('notes.tmp') && left.includes(linkName));
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep');
  // The lock holder removes its own temp files at any age.
  assert.equal(X.cleanTemps(d, { maxAgeMs: 0 }).removed, 1);
  assert.ok(!fs.readdirSync(d).includes(fresh));
});

// ---------------------------------------------------------------------------
// T-12 permissions (POSIX)

test('T-12: on Windows the permission check reports SKIPPED with its reason (SR-23)', () => {
  const r = X.checkPermissions(tmp('win'), { platform: 'win32' });
  assert.equal(r.ok, true);
  assert.match(r.skipped, /windows/i);
});

test('T-12: loose items are tightened once; another owner fails; a planted link is not followed', { skip: IS_WIN && 'POSIX permissions are not checked on Windows (SR-23)' }, () => {
  const data = tmp('perm');
  fs.chmodSync(data, 0o700);
  const idx = path.join(data, 'indexes', 'abcdef0123456789');
  fs.mkdirSync(idx, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(data, 'indexes'), 0o700);
  fs.chmodSync(idx, 0o700);
  fs.writeFileSync(path.join(idx, 'manifest.json'), 'x', { mode: 0o644 });
  fs.chmodSync(path.join(idx, 'manifest.json'), 0o644);
  const outside = path.join(path.dirname(data), path.basename(data) + '-outside.txt');
  fs.writeFileSync(outside, 'x');
  fs.chmodSync(outside, 0o644);
  made.push(outside);
  fs.symlinkSync(outside, path.join(idx, 'planted-link'));
  const r = X.checkPermissions(data);
  assert.equal(r.ok, true);
  assert.equal(r.tightened, 1);
  assert.equal(fs.statSync(path.join(idx, 'manifest.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
  const other = X.checkPermissions(data, { uid: process.getuid() + 12345 });
  assert.equal(other.ok, false);
  assert.ok(other.problems.includes('not_owner'));
});
