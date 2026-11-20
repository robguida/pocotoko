'use strict';
// The copied server's --skip-report flag (spec 9.8, SR-33, T-32 skip-report
// part): path and rule id only, never file text; not an MCP tool.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../helpers/server-harness.cjs');
const F = require('../helpers/fake-values.cjs');

test.after(() => H.cleanup());

const IS_WIN = process.platform === 'win32';

function report(run, kit) {
  const c = H.start({ serverFile: kit.serverFile, env: H.childEnv(run, { CLAUDE_PROJECT_DIR: run.proj }), cwd: run.proj, args: ['--skip-report'], seams: { gitCeiling: run.base, globalExcludes: null } });
  return c.exited.then((code) => ({ code, lines: c.lines, stderr: c.stderr }));
}

test('--skip-report names each skipped fixture with its rule id, lists no indexable file and prints no file text', async () => {
  const secretText = 'the kiwi key text';
  const files = {
    'good.md': '# Good\n\nthe kiwi note that stays\n',
    '.hidden.md': '# Hidden\n\nkiwi hidden text\n',
    'my-secrets.md': '# S\n\nkiwi secret-name text\n',
    'data.csv': 'a,b\n1,2\n',
    'ignored.md': '# I\n\nkiwi ignored text\n',
    'optout.md': 'search: do not index\n\nkiwi opt out text\n',
    'keyfile.md': '# K\n\n' + secretText + '\n\n' + F.keyBlock() + '\n',
    'node_modules/x.md': '# N\n\nkiwi vendor\n',
    'binary.md': Buffer.from([0x23, 0x00, 0x01, 0x02]),
  };
  const run = H.makeBase('skip', files);
  fs.writeFileSync(path.join(run.proj, '.gitignore'), 'ignored.md\n');
  const kit = H.makeKit(run, { options: { projects: [run.proj] } });
  const r = await report(run, kit);
  assert.equal(r.code, 0);
  const rows = {};
  for (const line of r.lines) {
    const m = /^([a-z_]+)\t(".*")$/.exec(line);
    if (m) rows[JSON.parse(m[2])] = m[1];
  }
  assert.equal(rows['.hidden.md'], 'hidden');
  assert.equal(rows['.gitignore'], 'hidden');
  assert.equal(rows['my-secrets.md'], 'secret_name');
  assert.equal(rows['data.csv'], 'data_type');
  assert.equal(rows['ignored.md'], 'git_ignored');
  assert.equal(rows['optout.md'], 'opt_out');
  assert.equal(rows['binary.md'], 'not_text');
  assert.equal(rows['node_modules/'], 'build_folder');
  assert.ok(rows['keyfile.md'], 'the scan hit is listed');
  assert.ok(!('good.md' in rows), 'an indexable file is not listed');
  const out = r.lines.join('\n');
  for (const t of ['kiwi', secretText, F.keyBlockHeader()]) assert.ok(!out.includes(t), 'no file text: ' + t.slice(0, 8));
  assert.match(r.lines[r.lines.length - 1], /^skip report: skipped \d+, failed 0, indexable 1$/);
  // Nothing was written: the report reads only.
  assert.ok(!fs.existsSync(path.join(kit.dataRoot, 'indexes')));
});

test('--skip-report: a file that cannot be read is listed as failed and the rest still print (POSIX)', { skip: IS_WIN ? 'Windows gives no plain way to make a file unreadable to its owner' : false }, async () => {
  const run = H.makeBase('skip-fail', { 'a.md': '# A\n\nfine\n', 'b.md': '# B\n\nlocked\n', '.c.md': 'hidden\n' });
  fs.chmodSync(path.join(run.proj, 'b.md'), 0o000);
  const kit = H.makeKit(run, { options: { projects: [run.proj] } });
  try {
    const r = await report(run, kit);
    const out = r.lines.join('\n');
    if (process.getuid && process.getuid() === 0) return; // root reads anything
    assert.ok(out.includes('failed\t"b.md"'));
    assert.ok(out.includes('hidden\t".c.md"'));
    assert.match(r.lines[r.lines.length - 1], /failed 1, indexable 1$/);
  } finally {
    fs.chmodSync(path.join(run.proj, 'b.md'), 0o600);
  }
});

test('--skip-report on a refused root prints the reason and walks nothing', async () => {
  const run = H.makeBase('skip-home', {});
  fs.writeFileSync(path.join(run.home, 'n.md'), '# N\n\ntext\n');
  const kit = H.makeKit(run, { options: {} });
  const c = H.start({ serverFile: kit.serverFile, env: H.childEnv(run, { CLAUDE_PROJECT_DIR: run.home }), cwd: run.home, args: ['--skip-report'], seams: { gitCeiling: run.base, globalExcludes: null } });
  const code = await c.exited;
  assert.equal(code, 1);
  assert.equal(c.lines.length, 1);
  assert.match(c.lines[0], /^skip report: refused: the folder is your home folder/);
});
