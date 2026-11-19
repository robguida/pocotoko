'use strict';
// Direct-start check for the dev scripts (scripts/lib/is-main.mjs). A checkout
// reached through a symbolic link or a Windows junction must still run the
// script's command line, never exit 0 having done nothing. Links are made under
// the gitignored sandbox/test-tmp/ only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { REPO_TOP, makeTempDir, removeDir } = require('../helpers/tmpdir-sandbox.cjs');

const SCRIPTS = path.join(REPO_TOP, 'scripts');
const made = [];
const links = [];
// Remove each link itself first (never what it points to), then its folder.
function removeLink(link) {
  try { fs.unlinkSync(link); return; } catch (_) { /* a Windows junction needs rmdir */ }
  try { fs.rmdirSync(link); } catch (_) { /* left under sandbox/test-tmp/ */ }
}
test.after(() => {
  for (const link of links) removeLink(link);
  for (const dir of made) {
    if (links.some((l) => fs.existsSync(l) && path.dirname(l) === dir)) continue; // never recurse through a live link
    removeDir(dir);
  }
});

// Makes <tmp>/linked-scripts pointing at the real scripts/ folder. Returns the
// link path, or { skip: reason } when the system refuses to make one.
function linkScripts() {
  const dir = makeTempDir('is-main');
  made.push(dir);
  const link = path.join(dir, 'linked-scripts');
  try {
    fs.symlinkSync(SCRIPTS, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    return { skip: `the system refused to make a link (${(err && err.code) || 'error'})` };
  }
  links.push(link);
  return { link };
}

function runNode(file, args) {
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.NODE_TEST_CONTEXT;
  delete env.SCRUB_DENYLIST;
  delete env.EGRESS_IDENTITY;
  return spawnSync(process.execPath, [file, ...args], { cwd: REPO_TOP, env, encoding: 'utf8', windowsHide: true });
}

test('each dev script started through a link or junction still runs its command line', (t) => {
  const made1 = linkScripts();
  if (made1.skip) { t.skip(made1.skip); return; }
  const { link } = made1;
  assert.notEqual(fs.realpathSync(link), link, 'the start path really goes through a link');

  // A bad argument makes each script print its own failure line and exit 1.
  // Before the fix, a start through a link printed nothing and exited 0.
  const scrub = runNode(path.join(link, 'scrub-scan.mjs'), ['--zq-unknown']);
  assert.equal(scrub.status, 1, scrub.stdout + scrub.stderr);
  assert.match(scrub.stdout, /scrub: FAIL \(unknown argument\)/);

  const egress = runNode(path.join(link, 'egress-scan.mjs'), ['--zq-unknown']);
  assert.equal(egress.status, 1, egress.stdout + egress.stderr);
  assert.match(egress.stdout, /egress: FAIL \(bad arguments\)/);

  const tests = runNode(path.join(link, 'run-tests.mjs'), ['--list']);
  assert.equal(tests.status, 0, tests.stdout + tests.stderr);
  assert.ok(tests.stdout.split(/\r?\n/).some((l) => l.endsWith('is-main.test.cjs')), 'the file list was printed');
});

test('isMain: real paths decide; an import is not a start; an unresolvable start of this file fails loudly', async (t) => {
  const { isMain } = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'is-main.mjs')).href);
  const self = path.join(SCRIPTS, 'scrub-scan.mjs');
  const url = pathToFileURL(self).href;

  assert.equal(isMain(url, { argv: ['node', self] }), true);
  assert.equal(isMain(url, { argv: ['node', path.join(SCRIPTS, 'egress-scan.mjs')] }), false, 'imported by another script');
  assert.equal(isMain(url, { argv: ['node'] }), false, 'no start file (for example a REPL)');
  if (process.platform === 'win32' || process.platform === 'darwin') {
    assert.equal(isMain(url, { argv: ['node', self.toUpperCase()] }), true, 'case is ignored on Windows and macOS');
  }

  const missing = path.join(REPO_TOP, 'sandbox', 'test-tmp', 'no-such-folder', 'scrub-scan.mjs');
  assert.throws(() => isMain(url, { argv: ['node', missing] }), /cannot confirm whether this script was started directly/);
  assert.equal(isMain(url, { argv: ['node', path.join(REPO_TOP, 'sandbox', 'test-tmp', 'no-such-folder', 'other.mjs')] }), false);

  const made2 = linkScripts();
  if (made2.skip) { t.diagnostic(made2.skip); return; }
  assert.equal(isMain(url, { argv: ['node', path.join(made2.link, 'scrub-scan.mjs')] }), true, 'through a link');
});
