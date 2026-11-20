'use strict';
// walker.cjs (spec 9.2, 9.11, SR-9, SR-11): T-3, T-26, the walk part of T-29, counts by rule,
// extra_types, and the read part of T-30.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const W = require('../../src/search/server/walker.cjs');
const Fl = require('../../src/search/server/floor.cjs');
const Ig = require('../../src/search/server/ignore.cjs');
const { makeTempDir, removeDir, writeFiles } = require('../helpers/tmpdir-sandbox.cjs');

const IS_WIN = process.platform === 'win32';
const made = [];
const cleanups = [];
test.after(() => {
  for (const c of cleanups) try { c(); } catch (_) { /* best effort */ }
  for (const d of made) removeDir(d);
});

function project(files) {
  const base = fs.realpathSync.native(makeTempDir('walker'));
  made.push(base);
  const root = path.join(base, 'proj');
  fs.mkdirSync(root);
  writeFiles(root, files);
  return { base, root: fs.realpathSync.native(root) };
}

async function walk(p, opts = {}) {
  const filter = opts.filter || Fl.buildFilter(opts.options || {});
  const ignore = Ig.createIgnore(p.root, { globalExcludes: null, ceiling: p.base });
  const out = await W.walk(p.root, { filter, ignore, ...opts.walk });
  return { out, filter };
}

function rels(out) {
  return out.files.map((f) => f.rel).sort();
}

function sumCounts(out) {
  return Object.values(out.skipped).reduce((a, b) => a + b, 0) + out.files.length
    + Object.values(out.failed).reduce((a, b) => a + b, 0);
}

let symlinkCache = null;
function canSymlink(dir) {
  if (symlinkCache !== null) return symlinkCache;
  try {
    const t = path.join(dir, 'probe.txt');
    fs.writeFileSync(t, 'x');
    fs.symlinkSync(t, path.join(dir, 'probe-link.txt'), 'file');
    symlinkCache = true;
  } catch (_) {
    symlinkCache = false;
  }
  return symlinkCache;
}

test('every skip is counted under its rule id; the counts plus accepted files equal the files visited', async () => {
  const p = project({
    'a.md': 'x', 'b.txt': 'x', '.hidden.md': 'x', 'x.pem': 'x', 'db_password.md': 'x', 'data.csv': 'x', 'code.js': 'x',
    'node_modules/m.md': 'x', 'docs/c.md': 'x',
  });
  const { out } = await walk(p);
  assert.deepEqual(rels(out), ['a.md', 'b.txt', 'docs/c.md']);
  assert.deepEqual(out.skipped, { hidden: 1, secret_file: 1, secret_name: 1, data_type: 1, not_allowed_type: 1 });
  assert.deepEqual(out.skippedDirs, { build_folder: 1 });
  assert.equal(sumCounts(out), out.visited);
  assert.equal(out.files.find((f) => f.rel === 'docs/c.md').rel, 'docs/c.md'); // `/` separators on every OS
});

test('extra_types adds one extension to the indexed set', async () => {
  const p = project({ 'a.org': 'x', 'b.tex': 'x' });
  const { out } = await walk(p, { options: { extra_types: ['.org'] } });
  assert.deepEqual(rels(out), ['a.org']);
});

test('git-ignored files and folders are skipped and counted', async () => {
  const p = project({ '.gitignore': 'skip.md\nout-notes/\n', 'skip.md': 'x', 'keep.md': 'x', 'out-notes/a.md': 'x' });
  const { out } = await walk(p);
  assert.deepEqual(rels(out), ['keep.md']);
  assert.equal(out.skipped.git_ignored, 1);
  assert.equal(out.skippedDirs.git_ignored, 1);
});

test('T-3: links are never followed, wherever they point; a hard link is skipped', async (t) => {
  const p = project({ 'ok.md': 'fine', 'inside.md': 'inside' });
  const secret = path.join(p.base, 'outside-secret.md');
  fs.writeFileSync(secret, 'outside text');
  const outsideDir = path.join(p.base, 'outside-dir');
  writeFiles(outsideDir, { 'hidden-away.md': 'outside text' });

  // A junction (Windows) or folder symlink to a folder outside the root.
  fs.symlinkSync(outsideDir, path.join(p.root, 'dirlink'), IS_WIN ? 'junction' : 'dir');
  // A hard link to a file outside the root.
  fs.linkSync(secret, path.join(p.root, 'hard.md'));
  const fileLinks = canSymlink(p.base);
  if (fileLinks) {
    fs.symlinkSync(secret, path.join(p.root, 'filelink.md'), 'file');
    fs.symlinkSync(path.join(p.root, 'filelink.md'), path.join(p.root, 'link-to-link.md'), 'file');
    fs.symlinkSync(path.join(p.root, 'inside.md'), path.join(p.root, 'inner-link.md'), 'file');
  } else {
    t.diagnostic('file symlink cases skipped: file symlinks need extra rights on this system');
  }
  const { out } = await walk(p);
  assert.deepEqual(rels(out), ['inside.md', 'ok.md']);
  assert.equal(out.skipped.hard_link, 1);
  assert.equal(out.skipped.link, fileLinks ? 4 : 1);
  assert.equal(sumCounts(out), out.visited);
});

test('T-3: a folder whose real path differs from its listed path is skipped as a link', async () => {
  const p = project({ 'a.md': 'x' });
  const real = path.join(p.base, 'real-root');
  writeFiles(real, { 'b.md': 'x' });
  const alias = path.join(p.base, 'alias-root');
  fs.symlinkSync(real, alias, IS_WIN ? 'junction' : 'dir');
  const filter = Fl.buildFilter({});
  // The walk is told the alias is the real root; its real path differs, so nothing is listed.
  const out = await W.walk(alias, { filter });
  assert.deepEqual(out.files, []);
  assert.equal(out.skippedDirs.link, 1);
});

test('T-3: a FIFO and a socket are skipped as special files and never opened', { skip: IS_WIN && 'no FIFO or socket files on Windows' }, async () => {
  const p = project({ 'a.md': 'x' });
  let expected = 0;
  const fifo = path.join(p.root, 'pipe.md');
  const mk = spawnSync('mkfifo', [fifo], { windowsHide: true });
  if (mk.status === 0) expected++;
  const sockPath = path.join(p.root, 'sock.md');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(sockPath, resolve));
  cleanups.push(() => server.close());
  expected++;
  const { out } = await walk(p);
  assert.deepEqual(rels(out), ['a.md']);
  assert.equal(out.skipped.special_file, expected);
  server.close();
});

test('T-3: swap race between the walk and the open is refused by the one-handle check', async (t) => {
  const p = project({ 'a.md': 'checked text' });
  const secret = path.join(p.base, 'outside-secret.md');
  fs.writeFileSync(secret, 'outside text');
  const { out, filter } = await walk(p);
  const f = out.files[0];
  const useLink = canSymlink(p.base);
  const swapped = W.readFile(f, {
    filter,
    hooks: {
      beforeOpen: (abs) => {
        fs.unlinkSync(abs);
        if (useLink) fs.symlinkSync(secret, abs, 'file');
        else fs.writeFileSync(abs, 'outside text'); // a new file: a different inode
      },
    },
  });
  if (!useLink) t.diagnostic('swapped with a new regular file: file symlinks need extra rights on this system');
  assert.deepEqual(swapped, { rule: 'link' });
});

test('T-30 (read part): a file deleted between the walk and the read is a failure, not a crash', async () => {
  const p = project({ 'a.md': 'x' });
  const { out, filter } = await walk(p);
  const res = W.readFile(out.files[0], { filter, hooks: { beforeOpen: (abs) => fs.unlinkSync(abs) } });
  assert.equal(res.fail, 'ENOENT');
});

test('readFile: BOM stripped, not text, opt-out line, and the sha256 of the bytes', async () => {
  const p = project({ 'bom.md': '﻿hello', 'bin.md': Buffer.from([0x61, 0x00]), 'opt.md': 'title\n' + Fl.OPT_OUT_LINE + '\n' });
  const { out, filter } = await walk(p);
  const by = Object.fromEntries(out.files.map((f) => [f.rel, W.readFile(f, { filter })]));
  assert.equal(by['bom.md'].text, 'hello');
  assert.match(by['bom.md'].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(by['bin.md'], { rule: 'not_text' });
  assert.deepEqual(by['opt.md'], { rule: 'opt_out' });
});

test('T-29 (walk and file size): walk limit stops the walk; one byte over max_file_bytes → too_big', async () => {
  const files = {};
  for (let i = 0; i < 30; i++) files[`n${String(i).padStart(2, '0')}.md`] = 'x';
  const p = project(files);
  const { out } = await walk(p, { walk: { maxEntries: 10 } });
  assert.equal(out.incomplete, 'walk_limit');
  assert.equal(out.files.length, 10);

  const q = project({ 'at.md': 'a'.repeat(1024), 'over.md': 'a'.repeat(1025) });
  const r = await walk(q, { options: { max_file_bytes: 1024 } });
  assert.deepEqual(rels(r.out), ['at.md']);
  assert.equal(r.out.skipped.too_big, 1);
});

test('T-26: unsafe names, one per class, are skipped as unsafe_name (unit)', () => {
  const unsafe = [
    'a\u0001b.md', 'a‮b.md', 'a​b.md', 'a b.md', 'a b.md', 'a<b.md', 'a>b.md', 'a`b.md', 'a|b.md',
    'x'.repeat(121) + '.md', ('d'.repeat(100) + '/').repeat(2) + 'e'.repeat(36) + '.md',
    'ab‌cd.md', 'م‌‌ی.md', 'می‏.md',
  ];
  for (const n of unsafe) assert.equal(W.unsafeName(n), true, JSON.stringify(n));
  const safe = [
    'my notes.md', 'été café.md', 'x'.repeat(117) + '.md', ('d'.repeat(100) + '/').repeat(2) + 'e'.repeat(35) + '.md',
    'می‌خواهم.md', // Persian, one ZWNJ inside a word
    'क्‍ष.md', // Hindi, one ZWJ after a virama
  ];
  for (const n of safe) assert.equal(W.unsafeName(n), false, JSON.stringify(n));
  assert.equal(('d'.repeat(100) + '/').repeat(2).length + 'e'.repeat(35).length + 3, 240);
});

test('T-26: on disk, joiner names are indexed and keep their exact relative path; unsafe ones are skipped', async () => {
  const persian = 'می‌خواهم.md';
  const hindi = 'क्‍ष.md';
  const files = { [persian]: 'x', [hindi]: 'x', 'ab‌cd.md': 'x', 'a‮b.md': 'x', 'a`b.md': 'x', ['x'.repeat(121) + '.md']: 'x' };
  const p = project(files);
  const { out } = await walk(p);
  assert.deepEqual(rels(out), [persian, hindi].sort());
  assert.equal(out.skipped.unsafe_name, 4);
});
