'use strict';
// scripts/skip-report.mjs (spec 9.8, 14.6, SR-33; 15.3 skip-report row): path and rule id per
// skipped file, never file text; an unreadable file is listed as failed and the rest still print.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO_TOP, makeTempDir, removeDir, writeFiles } = require('../helpers/tmpdir-sandbox.cjs');
const F = require('../helpers/fake-values.cjs');

const SCRIPT = path.join(REPO_TOP, 'scripts', 'skip-report.mjs');
const made = [];
after(() => { for (const d of made) removeDir(d); });

function report(dir, extra = []) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(?:CLAUDE_|SEARCH_OPTION_|NODE_TEST_CONTEXT$)/.test(k)) delete env[k];
  // The fixture sits inside this repo's git work tree; the ceiling keeps the repo's own ignore file out.
  const r = spawnSync(process.execPath, [SCRIPT, dir, '--git-ceiling', dir, ...extra], { env, cwd: REPO_TOP, encoding: 'utf8' });
  const rows = {};
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^([a-z_]+)\t(".*")$/.exec(line);
    if (m) rows[JSON.parse(m[2])] = m[1];
  }
  return { ...r, rows };
}

test('9.8 / SR-33: over a fixture project it prints path and rule id per skipped file, no file text, and the counts', () => {
  const dir = makeTempDir('skip-report');
  made.push(dir);
  const secretText = 'the kiwi key text';
  writeFiles(dir, {
    'good.md': '# Good\n\nthe kiwi note that stays\n',
    '.hidden.md': '# Hidden\n\nkiwi hidden\n',
    'my-secrets.md': '# S\n\nkiwi secret name\n',
    'data.csv': 'a,b\n1,2\n',
    'ignored.md': '# I\n\nkiwi ignored\n',
    'keyfile.md': '# K\n\n' + secretText + '\n\n' + F.keyBlock() + '\n',
    'node_modules/x.md': '# N\n\nkiwi vendor\n',
  });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.md\n');
  const r = report(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.rows['.hidden.md'], 'hidden');
  assert.equal(r.rows['my-secrets.md'], 'secret_name');
  assert.equal(r.rows['data.csv'], 'data_type');
  assert.equal(r.rows['ignored.md'], 'git_ignored');
  assert.equal(r.rows['node_modules/'], 'build_folder');
  assert.ok(r.rows['keyfile.md'], 'the scan hit is listed');
  assert.ok(!('good.md' in r.rows), 'an indexable file is not listed');
  for (const t of ['kiwi', secretText, F.keyBlockHeader()]) assert.ok(!r.stdout.includes(t), 'no file text: ' + t.slice(0, 8));
  assert.match(r.stdout, /^skip report: skipped \d+, failed 0, indexable 1$/m);
  let left = [];
  try { left = fs.readdirSync(path.join(REPO_TOP, 'sandbox', 'skip-report')); } catch (_) { /* none */ }
  assert.deepEqual(left, [], 'its scratch kit folder is removed');
});

test('9.13 / SR-12: an options file narrows the report; a path holding a never-term is only counted, never printed', () => {
  const dir = makeTempDir('skip-report-terms');
  made.push(dir);
  writeFiles(dir, { 'plan-zebracode.md': '# P\n\ntext\n', 'other.md': '# O\n\ntext\n' });
  const opts = path.join(dir, '..', path.basename(dir) + '-options.json');
  made.push(opts);
  fs.writeFileSync(opts, JSON.stringify({ never_terms: ['zebracode'] }));
  const r = report(dir, ['--options', opts]);
  assert.equal(r.status, 0, r.stdout);
  assert.ok(!r.stdout.includes('zebracode'), 'the never-term is never printed');
  assert.match(r.stdout, /^masked\tnever_term\t1$/m);
  fs.rmSync(opts, { force: true });
});

test('hard line 7: an unreadable file is listed as failed and the rest still print (POSIX)', { skip: process.platform === 'win32' ? 'file modes do not make a file unreadable on Windows; proven by CI on macOS and Linux' : false }, () => {
  const dir = makeTempDir('skip-report-fail');
  made.push(dir);
  writeFiles(dir, { 'locked.md': '# L\n\nx\n', 'data.csv': 'a\n', 'ok.md': '# O\n\ny\n' });
  fs.chmodSync(path.join(dir, 'locked.md'), 0o000);
  try {
    const r = report(dir);
    if (process.getuid && process.getuid() === 0) return; // root reads anything
    assert.equal(r.rows['locked.md'], 'failed');
    assert.equal(r.rows['data.csv'], 'data_type', 'the rest still print');
    assert.match(r.stdout, /failed [1-9]/);
  } finally {
    fs.chmodSync(path.join(dir, 'locked.md'), 0o644);
  }
});

test('the skip report refuses unknown arguments', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
