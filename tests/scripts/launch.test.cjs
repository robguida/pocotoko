'use strict';
// T-39 dev-script launching (spec 13.6): the cmd.exe route's argument check, and a static
// check over scripts/ for shell options and exec.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_TOP } = require('../helpers/tmpdir-sandbox.cjs');

test('13.6 / T-39 (launcher half): the cmd.exe route refuses an argument holding & | < > ^ % ! " or a line break, and an absolute path outside sandbox/', async () => {
  const { pathToFileURL } = require('node:url');
  const D = await import(pathToFileURL(path.join(REPO_TOP, 'scripts', 'lib', 'dev-run.mjs')).href);
  for (const c of ['&', '|', '<', '>', '^', '%', '!', '"', '\r', '\n']) {
    assert.equal(D.checkCmdArgs(['plugin', 'a' + c + 'b']).length, 1, JSON.stringify(c));
  }
  assert.deepEqual(D.checkCmdArgs(['plugin', 'list', '--json', path.join(REPO_TOP, 'sandbox', 'x')]), []);
  assert.match(D.checkCmdArgs([path.resolve(REPO_TOP, '..', 'outside')])[0], /outside sandbox/);
  const r = D.runCli({ kind: 'cmd', file: path.join(REPO_TOP, 'sandbox', 'x.cmd') }, ['a&b']);
  assert.equal(r.status, null);
  assert.match(r.refused, /cmd\.exe would act on/);
});

test('13.6 / T-39 (static half): no dev script uses a shell option or exec, and git is started only with an argument list', () => {
  const files = [];
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.m?js$/.test(n)) files.push(p); } };
  walk(path.join(REPO_TOP, 'scripts'));
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!/shell:\s*true/.test(t), path.basename(f) + ': shell: true');
    // execFile / execFileSync start a program with an argument list and no shell; exec and execSync use a shell.
    assert.ok(!/import\s*\{[^}]*\bexec(?:Sync)?\b(?!File)[^}]*\}\s*from\s*'node:child_process'/.test(t), path.basename(f) + ': exec imported');
    assert.ok(!/\bexecSync\(|child_process'?\)?\.exec\(/.test(t), path.basename(f) + ': exec(');
    for (const m of t.matchAll(/(?:spawn|execFile)(?:Sync)?\('git',\s*([^)]*)/g)) assert.match(m[1].trim(), /^(?:\[|args\b)/, path.basename(f) + ': git with an argument list');
  }
});
