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

const OWN = ['chunks.jsonl', 'manifest.json'];

function age(p, ms) {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(p, t, t);
}

test('leftover temp files: only the exact pattern of a listed base name, regular files, older than 10 minutes; links skipped', () => {
  const d = tmp('clean');
  const now = Date.now();
  const old = X.tempNameFor('chunks.jsonl');
  const fresh = X.tempNameFor('manifest.json');
  const userFile = X.tempNameFor('notes.json'); // temp-like, but not a file the store writes here
  fs.writeFileSync(path.join(d, old), 'old');
  fs.writeFileSync(path.join(d, fresh), 'fresh');
  fs.writeFileSync(path.join(d, userFile), 'user');
  fs.writeFileSync(path.join(d, 'notes.tmp'), 'other');
  for (const n of [old, userFile, 'notes.tmp']) age(path.join(d, n), 11 * 60 * 1000);
  const target = path.join(d, 'target-dir');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
  const linkName = X.tempNameFor('manifest.json');
  dirLink(target, path.join(d, linkName));
  const r = X.cleanTemps(d, [], { bases: OWN, now });
  assert.equal(r.removed, 1);
  const left = fs.readdirSync(d).sort();
  assert.ok(!left.includes(old));
  assert.ok(left.includes(fresh) && left.includes('notes.tmp') && left.includes(linkName) && left.includes(userFile));
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep');
  // No base names listed: nothing is removed.
  assert.equal(X.cleanTemps(d, [], { maxAgeMs: 0 }).removed, 0);
  // The lock holder removes its own temp files at any age.
  assert.equal(X.cleanTemps(d, [], { bases: OWN, maxAgeMs: 0 }).removed, 1);
  assert.ok(!fs.readdirSync(d).includes(fresh));
  assert.ok(fs.readdirSync(d).includes(userFile));
});

test('SR-24: temp cleanup checks its folder before listing: a junction or link at the folder, at a parent, or at the root, or a path outside the root -> nothing listed or deleted', () => {
  const d = tmp('clean-link');
  const root = path.join(d, 'root');
  fs.mkdirSync(root);
  const outside = path.join(d, 'outside');
  fs.mkdirSync(path.join(outside, 'inner'), { recursive: true });
  const names = [X.tempNameFor('chunks.jsonl'), X.tempNameFor('manifest.json')];
  for (const dir of [outside, path.join(outside, 'inner')]) {
    for (const n of names) {
      fs.writeFileSync(path.join(dir, n), 'x');
      age(path.join(dir, n), 60 * 60 * 1000);
    }
  }
  const before = () => [fs.readdirSync(outside).sort(), fs.readdirSync(path.join(outside, 'inner')).sort()];
  const listed = before();
  dirLink(outside, path.join(root, 'indexes'));
  dirLink(outside, path.join(d, 'linked-root'));
  const opts = { bases: OWN, maxAgeMs: 0 };
  assert.equal(X.cleanTemps(root, ['indexes'], opts).refused, 'link');
  assert.equal(X.cleanTemps(root, ['indexes', 'inner'], opts).refused, 'moved');
  assert.equal(X.cleanTemps(path.join(d, 'linked-root'), [], opts).refused, 'link');
  assert.equal(X.cleanTemps(root, ['..', 'outside'], opts).refused, 'outside_root');
  assert.equal(X.cleanTemps('relative', [], opts).refused, 'bad_path');
  assert.deepEqual(before(), listed, 'nothing outside deleted');
  assert.deepEqual(X.checkedFolder(outside, ['inner']), { dir: path.join(outside, 'inner') });
  for (const l of [path.join(root, 'indexes'), path.join(d, 'linked-root')]) fs.rmSync(l, { recursive: false, force: true });
});

test('SR-24: temp cleanup checks its folder again before each delete: a folder swapped for a junction mid-run deletes nothing through it', () => {
  const d = tmp('clean-swap');
  const idx = path.join(d, 'idx');
  fs.mkdirSync(idx);
  const outside = path.join(d, 'outside');
  fs.mkdirSync(outside);
  const names = [X.tempNameFor('chunks.jsonl'), X.tempNameFor('manifest.json')];
  for (const n of names) {
    for (const dir of [idx, outside]) {
      fs.writeFileSync(path.join(dir, n), 'x');
      age(path.join(dir, n), 60 * 60 * 1000);
    }
  }
  let calls = 0;
  const r = X.cleanTemps(d, ['idx'], {
    bases: OWN,
    _unlink: (p) => {
      calls++;
      fs.unlinkSync(p);
      if (calls === 1) {
        fs.renameSync(idx, idx + '-moved');
        dirLink(outside, idx);
      }
    },
  });
  assert.deepEqual({ removed: r.removed, failed: r.failed, calls }, { removed: 1, failed: 1, calls: 1 });
  assert.deepEqual(fs.readdirSync(outside).sort(), [...names].sort(), 'nothing outside deleted');
  fs.rmSync(idx, { recursive: false, force: true });
});

test('SR-24: ensureDir checks the parent first: a parent swapped for a junction gets no folder created through it; a name with a separator is refused', () => {
  const d = tmp('ensure');
  const outside = path.join(d, 'outside');
  fs.mkdirSync(outside);
  const parent = path.join(d, 'parent');
  dirLink(outside, parent);
  assert.throws(() => X.ensureDir(parent, 'indexes'), { code: 'folder_link' });
  assert.deepEqual(fs.readdirSync(outside), []);
  const real = path.join(d, 'real');
  fs.mkdirSync(real);
  for (const bad of ['..', '.', '', 'a' + path.sep + 'b', 'a/b']) assert.throws(() => X.ensureDir(real, bad), { code: 'bad_name' }, JSON.stringify(bad));
  assert.deepEqual(fs.readdirSync(real), []);
  assert.equal(X.ensureDir(real, 'indexes'), path.join(real, 'indexes'));
  fs.rmSync(parent, { recursive: false, force: true });
});

test('SR-24: the folder is checked again right before the rename: a folder swapped for a junction after the temp file is written is refused; a file planted at the temp name outside is not renamed to the target there', () => {
  const d = tmp('rename-swap');
  const dir = path.join(d, 'idx');
  fs.mkdirSync(dir);
  const outside = path.join(d, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  // A file planted in the outside folder under the exact temp name the write will use:
  // a rename through the swapped folder would turn it into outside/manifest.json.
  const tempName = 'manifest.json.1.0123456789abcdef.tmp';
  fs.writeFileSync(path.join(outside, tempName), 'planted');
  const swap = () => {
    fs.renameSync(dir, dir + '-moved');
    dirLink(outside, dir);
    return true;
  };
  assert.throws(() => X.atomicWrite({ dir, expectedDir: dir, name: 'manifest.json', data: 'x', beforeRename: swap, _tempName: tempName }), (e) => /^folder_/.test(e.code));
  assert.equal(fs.existsSync(path.join(outside, 'manifest.json')), false, 'nothing renamed into the outside folder');
  assert.deepEqual(fs.readdirSync(outside).sort(), ['keep.txt', tempName].sort());
  assert.equal(fs.readFileSync(path.join(outside, tempName), 'utf8'), 'planted', 'the planted file is not unlinked either');
  fs.rmSync(dir, { recursive: false, force: true });
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

test('T-12 / SR-24: an indexes/ folder that is a link -> a folder problem; nothing behind the link is listed or tightened', { skip: IS_WIN && 'POSIX permissions are not checked on Windows (SR-23)' }, () => {
  const data = tmp('perm-link');
  fs.chmodSync(data, 0o700);
  const outside = tmp('perm-link-outside');
  const inner = path.join(outside, 'abcdef0123456789');
  fs.mkdirSync(inner, { mode: 0o755 });
  fs.chmodSync(inner, 0o755);
  fs.writeFileSync(path.join(inner, 'manifest.json'), 'x');
  fs.chmodSync(path.join(inner, 'manifest.json'), 0o644);
  fs.symlinkSync(outside, path.join(data, 'indexes'));
  const r = X.checkPermissions(data);
  assert.equal(r.ok, false);
  assert.ok(r.problems.includes('folder_link'));
  assert.equal(r.tightened, 0);
  assert.equal(fs.statSync(inner).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(inner, 'manifest.json')).mode & 0o777, 0o644);
});
