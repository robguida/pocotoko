'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { REPO_TOP, makeTempDir, removeDir, writeFiles } = require('../helpers/tmpdir-sandbox.cjs');

const SCRIPT = path.join(REPO_TOP, 'scripts', 'run-tests.mjs');
const made = [];
function fixture(name, files) {
  const dir = makeTempDir(name);
  made.push(dir);
  writeFiles(dir, files);
  return dir;
}
after(() => {
  for (const d of made) removeDir(d);
});

const PASS = "require('node:test').test('ok', () => {});\n";
const PASS_MJS = "import { test } from 'node:test';\ntest('ok', () => {});\n";
const FAIL = "require('node:test').test('boom', () => { throw new Error('planned failure'); });\n";

function runScript(root, extra = []) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [SCRIPT, '--root', root, ...extra], { encoding: 'utf8', env });
}

async function loadList() {
  const mod = await import(pathToFileURL(SCRIPT).href);
  return mod.listTestFiles;
}

test('finds every *.test.cjs and *.test.mjs, ignores other files, fixtures and helpers', async () => {
  const root = fixture('rt-find', {
    'tests/a.test.cjs': PASS,
    'tests/core/b.test.mjs': PASS_MJS,
    'tests/scripts/deep/c.test.cjs': PASS,
    'tests/notes.md': 'x',
    'tests/core/helper.cjs': 'x',
    'tests/a.test.cjs.bak': 'x',
    'tests/fixtures/f.test.cjs': PASS,
    'tests/helpers/h.test.cjs': PASS,
    'tests/core/fixtures/g.test.cjs': PASS,
  });
  const listTestFiles = await loadList();
  const { files, errors } = listTestFiles(path.join(root, 'tests'));
  const rel = files.map((f) => path.relative(path.join(root, 'tests'), f).split(path.sep).join('/'));
  assert.deepStrictEqual(rel, ['a.test.cjs', 'core/b.test.mjs', 'scripts/deep/c.test.cjs']);
  assert.deepStrictEqual(errors, []);
});

test('the list is sorted and stable, and a new test file appears in it', async () => {
  const root = fixture('rt-sorted', {
    'tests/z.test.cjs': PASS,
    'tests/a.test.cjs': PASS,
    'tests/m/k.test.cjs': PASS,
  });
  const listTestFiles = await loadList();
  const first = listTestFiles(path.join(root, 'tests')).files;
  const second = listTestFiles(path.join(root, 'tests')).files;
  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual(first, [...first].sort());
  writeFiles(root, { 'tests/new/added.test.cjs': PASS });
  const third = listTestFiles(path.join(root, 'tests')).files;
  assert.strictEqual(third.length, first.length + 1);
  assert.ok(third.some((f) => f.endsWith('added.test.cjs')));
});

test('a path with spaces works', () => {
  const root = fixture('rt spaces', { 'tests/sub dir/with space.test.cjs': PASS });
  const res = runScript(root);
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /succeeded 1, failed 0/);
});

test('--list prints each file path, and the script passes explicit files (no shell, no glob)', () => {
  const root = fixture('rt-list', { 'tests/a.test.cjs': PASS, 'tests/b.test.cjs': PASS });
  const res = runScript(root, ['--list']);
  assert.strictEqual(res.status, 0);
  const lines = res.stdout.split(/\r?\n/).filter(Boolean);
  assert.strictEqual(lines.length, 2);
  for (const l of lines) assert.ok(fs.existsSync(l), l);
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!/shell\s*:\s*true/.test(src), 'must not use a shell');
  assert.ok(src.includes("['--test', ...files]"), 'must pass the file list explicitly');
  assert.ok(!/\*\*\/\*/.test(src), 'must not pass a glob');
});

test('one failing test file does not stop the others; exit is non-zero with a summary', () => {
  const root = fixture('rt-fail', {
    'tests/a-pass.test.cjs': PASS,
    'tests/b-fail.test.cjs': FAIL,
    'tests/c-pass.test.cjs': PASS,
  });
  const res = runScript(root);
  assert.notStrictEqual(res.status, 0);
  assert.match(res.stdout, /3 test files/);
  assert.match(res.stdout, /succeeded 2, failed 1/);
});

test('a run where every file passes exits 0', () => {
  const root = fixture('rt-ok', { 'tests/a.test.cjs': PASS, 'tests/b.test.mjs': PASS_MJS });
  const res = runScript(root);
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /succeeded 2, failed 0/);
});

test('zero test files fails loudly', () => {
  const root = fixture('rt-zero', { 'tests/readme.md': 'x', 'tests/fixtures/only.test.cjs': PASS });
  const res = runScript(root);
  assert.notStrictEqual(res.status, 0);
  assert.match(res.stderr, /no test files/);
});
