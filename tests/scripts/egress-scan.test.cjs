'use strict';
// T-23 Egress history scan (spec 13.2). Throwaway repos live under
// sandbox/egress/, and git runs with the sandbox settings of 13.7
// (GIT_CONFIG_GLOBAL under sandbox/, GIT_CONFIG_NOSYSTEM=1, TMP/TEMP/TMPDIR
// and XDG folders under sandbox/). Every identity, address and deny-list term
// is assembled at run time from parts (13.1 e).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..', '..');
const SANDBOX = path.join(REPO, 'sandbox');
const EGRESS_TMP = path.join(SANDBOX, 'egress');
const RUN = path.join(EGRESS_TMP, 'test-' + crypto.randomBytes(6).toString('hex'));
const SCRIPT = path.join(REPO, 'scripts', 'egress-scan.mjs');
const SCRUB_SCRIPT = path.join(REPO, 'scripts', 'scrub-scan.mjs');
const F = require('../helpers/fake-values.cjs');

// Run-time values, never literals of their shape (built by tests/helpers/fake-values.cjs).
const ID_NAME = ['Test', 'maintainer', crypto.randomBytes(2).toString('hex')].join(' ');
const ID_EMAIL = F.fakeEmail('maint' + crypto.randomBytes(2).toString('hex'));
const FAKE = F.fakeEmail('leak' + crypto.randomBytes(2).toString('hex'));
const OTHER_NAME = ['Outside', 'author'].join(' ');
const DENY = ['zq', 'xv', crypto.randomBytes(3).toString('hex')].join('');
const FIXED_TIME = String(1700 * 1000 * 1000) + ' +0000';

let E;
let G;
let GENV;
let IDENTITY_FILE;
let DENYLIST_FILE;

// No stand-in rule check: every scan below loads the real scrub rules from
// scripts/scrub-scan.mjs itself, so a broken link to the scrub scan fails here.

function scanEnv(extra = {}) {
  const env = { ...GENV, EGRESS_IDENTITY: IDENTITY_FILE, SCRUB_DENYLIST: DENYLIST_FILE, ...extra };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

function g(repo, args, extraEnv = {}, input) {
  const r = spawnSync('git', args, { cwd: repo, env: { ...GENV, ...extraEnv }, input, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('git ' + args[0] + ' failed: ' + r.stderr);
  return r.stdout.trim();
}

function newRepo(name) {
  const dir = path.join(RUN, name);
  fs.mkdirSync(dir, { recursive: true });
  g(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

function put(repo, rel, content) {
  const p = path.join(repo, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function commit(repo, messages, extraEnv = {}) {
  g(repo, ['add', '-A']);
  const args = ['commit', '-q', '--allow-empty'];
  for (const m of [].concat(messages)) args.push('-m', m);
  g(repo, args, extraEnv);
  return g(repo, ['rev-parse', 'HEAD']);
}

function hasHit(result, where, field, rule) {
  return result.hits.some((h) => h.where === where && h.field === field && (!rule || h.rule === rule));
}

function assertNoValues(text) {
  for (const v of [FAKE, ID_NAME, ID_EMAIL, DENY, OTHER_NAME]) {
    assert.ok(!text.toLowerCase().includes(v.toLowerCase()), 'output must not hold a matched value or the identity');
  }
}

function writeIdentity(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

test.before(async () => {
  E = await import(pathToFileURL(SCRIPT).href);
  G = await import(pathToFileURL(path.join(REPO, 'scripts', 'lib', 'guard.mjs')).href);

  GENV = G.sandboxEnv({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, path.join(RUN, 'env'), { repo: REPO });
  for (const k of ['TMP', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'HOME', 'XDG_CONFIG_HOME', 'APPDATA', 'LOCALAPPDATA']) {
    fs.mkdirSync(GENV[k], { recursive: true });
  }
  fs.mkdirSync(path.dirname(GENV.GIT_CONFIG_GLOBAL), { recursive: true });
  fs.writeFileSync(GENV.GIT_CONFIG_GLOBAL,
    '[core]\n\tautocrlf = false\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  Object.assign(GENV, {
    GIT_AUTHOR_NAME: ID_NAME, GIT_AUTHOR_EMAIL: ID_EMAIL, GIT_AUTHOR_DATE: FIXED_TIME,
    GIT_COMMITTER_NAME: ID_NAME, GIT_COMMITTER_EMAIL: ID_EMAIL, GIT_COMMITTER_DATE: FIXED_TIME,
  });
  assert.ok(G.preflight({ env: GENV, repo: REPO }).length === 0, 'test git runs inside the guard rules');

  IDENTITY_FILE = path.join(RUN, 'identity.json');
  writeIdentity(IDENTITY_FILE, { name: ID_NAME, email: ID_EMAIL });
  DENYLIST_FILE = path.join(RUN, 'denylist.txt');
  fs.writeFileSync(DENYLIST_FILE, DENY + '\n');
});

test.after(() => {
  const rel = path.relative(EGRESS_TMP, RUN);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    try { fs.rmSync(RUN, { recursive: true, force: true }); } catch { /* left under sandbox/ */ }
  }
});

test('the rule check is the real scrub check from scripts/scrub-scan.mjs', async () => {
  const loaded = await E.loadRuleCheck();
  assert.equal(loaded.error, undefined, 'loading the scrub rules must not fail');
  assert.equal(typeof loaded.check, 'function');
  const scrub = await import(pathToFileURL(SCRUB_SCRIPT).href);
  const deny = path.join(RUN, 'denylist.txt');
  const inputs = [
    { path: null, text: 'contact ' + FAKE, kind: 'message', layers: ['public'] },
    { path: 'a.txt', text: 'by ' + DENY, kind: 'file', layers: ['public', 'private'], denylistPath: deny },
    { path: null, text: 'refs/tags/clean', kind: 'ref', layers: ['public'] },
  ];
  for (const input of inputs) assert.deepEqual(loaded.check(input), scrub.scanContent(input));
  assert.deepEqual(loaded.check(inputs[0]), [{ rule: 'email' }]);
  assert.deepEqual(loaded.check(inputs[1]), [{ rule: 'private-term-1' }]);
  assert.deepEqual(loaded.check(inputs[2]), []);
});

// ---------------------------------------------------------------------------

test('a clean history passes with the commit and blob counts', async () => {
  const repo = newRepo('clean');
  put(repo, 'a.txt', 'hello\n');
  commit(repo, 'first');
  put(repo, 'b.txt', 'world\n');
  commit(repo, 'second');
  const r = await E.runEgress({ repo, env: scanEnv() });
  assert.equal(r.exitCode, 0, r.lines.join('\n'));
  assert.equal(r.lines[r.lines.length - 1], 'egress: PASS (2 commits, 2 blobs)');
});

test('a repo with zero commits passes with zero counts', async () => {
  const repo = newRepo('empty');
  const r = await E.runEgress({ repo, env: scanEnv() });
  assert.equal(r.exitCode, 0);
  assert.equal(r.lines[r.lines.length - 1], 'egress: PASS (0 commits, 0 blobs)');
});

test('T-23: every place a leak can hide in history is flagged, by hash and field only', async () => {
  const repo = newRepo('leaky');
  put(repo, 'a.txt', 'base\n');
  const base = commit(repo, 'base');

  put(repo, 'b.txt', 'b\n');
  const badAuthor = commit(repo, 'author leak', { GIT_AUTHOR_EMAIL: FAKE });

  put(repo, 'c.txt', 'c\n');
  const badCommitter = commit(repo, 'committer leak', { GIT_COMMITTER_EMAIL: FAKE });

  put(repo, 'd.txt', 'd\n');
  const trailer = commit(repo, ['fix', 'Co-Authored-By: Someone <' + FAKE + '>']);

  put(repo, 'e.txt', 'e\n');
  const generated = commit(repo, ['change', 'Generated with a tool']);

  put(repo, 'gone.txt', 'secret ' + DENY + '\n');
  const added = commit(repo, 'add file');
  fs.rmSync(path.join(repo, 'gone.txt'));
  commit(repo, 'delete file');

  put(repo, FAKE + '.txt', 'path leak\n');
  const pathLeak = commit(repo, 'path');

  g(repo, ['tag', '-a', 'v1', '-m', 'release ' + FAKE]);
  const tagObj = g(repo, ['rev-parse', 'refs/tags/v1']);

  // T-23 / 15.3: a tag whose NAME holds the value (annotated, clean message),
  // and a lightweight tag whose name holds it.
  g(repo, ['tag', '-a', 'v2-' + FAKE, '-m', 'release two', base]);
  const namedTagObj = g(repo, ['rev-parse', 'refs/tags/v2-' + FAKE]);
  g(repo, ['tag', 'lw-' + FAKE, generated]);

  g(repo, ['branch', 'leak-' + FAKE, base]);

  g(repo, ['checkout', '-q', '-b', 'side']);
  put(repo, 'side.txt', 'unmerged ' + FAKE + '\n');
  const side = commit(repo, 'side work');
  g(repo, ['checkout', '-q', 'main']);

  g(repo, ['notes', 'add', '-m', 'note ' + FAKE, base]);
  const notesCommit = g(repo, ['rev-parse', 'refs/notes/commits']);

  put(repo, 'a.txt', 'stashed ' + FAKE + '\n');
  g(repo, ['stash', 'push', '-q']);
  const stash = g(repo, ['rev-parse', 'refs/stash']);

  g(repo, ['checkout', '-q', '-b', 'tmp']);
  put(repo, 'orig.txt', 'rewritten away ' + FAKE + '\n');
  const orig = commit(repo, 'old history');
  g(repo, ['checkout', '-q', 'main']);
  g(repo, ['update-ref', 'refs/original/refs/heads/main', orig]);
  g(repo, ['branch', '-q', '-D', 'tmp']);

  const r = await E.runEgress({ repo, env: scanEnv() });
  const text = r.lines.join('\n');
  assert.equal(r.exitCode, 1);
  assert.match(r.lines[r.lines.length - 1], /^egress: FAIL \(\d+ hits\)$/);

  assert.ok(hasHit(r, badAuthor, 'author email', 'identity-mismatch'), 'author field');
  assert.ok(!hasHit(r, badAuthor, 'committer email'), 'author leak commit has a good committer');
  assert.ok(hasHit(r, badCommitter, 'committer email', 'identity-mismatch'), 'committer field');
  assert.ok(hasHit(r, trailer, 'commit message', 'trailer-co-authored-by'), 'co-author trailer');
  assert.ok(hasHit(r, trailer, 'commit message', 'email'), 'address in a trailer (the email rule itself)');
  assert.ok(hasHit(r, generated, 'commit message', 'generated-with-line'), 'generated-with line');
  assert.ok(hasHit(r, added, 'file content'), 'file added then deleted (private layer)');
  assert.ok(hasHit(r, pathLeak, 'file path'), 'file path');
  assert.ok(hasHit(r, 'tag ' + tagObj, 'tag message', 'email'), 'tag message');
  assert.ok(!hasHit(r, 'tag ' + tagObj, 'tag name'), 'a clean tag name is not flagged');
  assert.ok(hasHit(r, 'tag ' + namedTagObj, 'tag name', 'email'), 'annotated tag name');
  assert.ok(!hasHit(r, 'tag ' + namedTagObj, 'tag message'), 'that tag has a clean message');
  assert.ok(hasHit(r, 'tag ' + generated, 'tag name', 'email'), 'lightweight tag name');
  assert.ok(r.hits.some((h) => h.where.startsWith('branch ') && h.field === 'branch name'), 'branch name');
  assert.ok(hasHit(r, side, 'file content'), 'commit on a branch merged nowhere');
  assert.ok(hasHit(r, notesCommit, 'file content'), 'note under refs/notes/');
  assert.ok(hasHit(r, stash, 'file content'), 'stash content');
  assert.ok(hasHit(r, orig, 'file content'), 'commit only under refs/original/');

  // A flagged ref is named by its kind and hash, never its name.
  for (const h of r.hits) assert.match(h.where, /^((branch|tag|note-ref|stash|backup-ref|remote-ref|ref) )?[0-9a-f]{40,64}$/);
  assertNoValues(text);
});

test('an author who is not the identity passes only when the commit hash is listed; the committer never', async () => {
  const repo = newRepo('exceptions');
  put(repo, 'a.txt', 'a\n');
  commit(repo, 'mine');
  put(repo, 'b.txt', 'b\n');
  const outside = commit(repo, 'contribution', { GIT_AUTHOR_NAME: OTHER_NAME, GIT_AUTHOR_EMAIL: FAKE });

  let r = await E.runEgress({ repo, env: scanEnv() });
  assert.equal(r.exitCode, 1);
  assert.ok(hasHit(r, outside, 'author name') && hasHit(r, outside, 'author email'));

  const listed = path.join(RUN, 'identity-exceptions.json');
  writeIdentity(listed, { name: ID_NAME, email: ID_EMAIL, author_exceptions: [outside] });
  r = await E.runEgress({ repo, env: scanEnv({ EGRESS_IDENTITY: listed }) });
  assert.equal(r.exitCode, 0, r.lines.join('\n'));

  put(repo, 'c.txt', 'c\n');
  const both = commit(repo, 'pushed by someone else', {
    GIT_AUTHOR_NAME: OTHER_NAME, GIT_AUTHOR_EMAIL: FAKE, GIT_COMMITTER_NAME: OTHER_NAME, GIT_COMMITTER_EMAIL: FAKE,
  });
  writeIdentity(listed, { name: ID_NAME, email: ID_EMAIL, author_exceptions: [outside, both] });
  r = await E.runEgress({ repo, env: scanEnv({ EGRESS_IDENTITY: listed }) });
  assert.equal(r.exitCode, 1);
  assert.ok(!hasHit(r, both, 'author email'));
  assert.ok(hasHit(r, both, 'committer name') && hasHit(r, both, 'committer email'));
  assertNoValues(r.lines.join('\n'));
});

test('a blob that cannot be read is counted failed and the scan continues', async () => {
  const repo = newRepo('broken');
  put(repo, 'lost.txt', 'this blob will be removed\n');
  const first = commit(repo, 'first');
  put(repo, 'later.txt', 'later ' + FAKE + '\n');
  const second = commit(repo, 'second');
  const blob = g(repo, ['rev-parse', first + ':lost.txt']);
  const obj = path.join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
  fs.chmodSync(obj, 0o666);
  fs.rmSync(obj);

  const r = await E.runEgress({ repo, env: scanEnv() });
  assert.equal(r.exitCode, 1);
  assert.ok(r.counts.failed >= 1);
  assert.ok(r.lines.some((l) => l.startsWith('failed: ') && l.includes('file content')));
  assert.ok(hasHit(r, second, 'file content'), 'the remaining history is still scanned');
  assert.match(r.lines[r.lines.length - 1], /^egress: FAIL \(\d+ hits, \d+ failed\)$/);
  assert.ok(r.lines.some((l) => /^egress: checked \d+, failed \d+, skipped \d+$/.test(l)));
});

test('missing or bad identity settings FAIL with "commit identity not configured"', async () => {
  const repo = newRepo('identity-cases');
  put(repo, 'a.txt', 'a\n');
  commit(repo, 'one');
  const emptyField = path.join(RUN, 'identity-empty.json');
  writeIdentity(emptyField, { name: ID_NAME, email: '' });
  const cases = [
    ['unset', { EGRESS_IDENTITY: undefined }],
    ['empty', { EGRESS_IDENTITY: '' }],
    ['outside sandbox', { EGRESS_IDENTITY: path.join(REPO, 'docs', 'identity.json') }],
    ['missing file', { EGRESS_IDENTITY: path.join(RUN, 'no-such-identity.json') }],
    ['empty field', { EGRESS_IDENTITY: emptyField }],
  ];
  for (const [label, extra] of cases) {
    const r = await E.runEgress({ repo, env: scanEnv(extra) });
    assert.equal(r.exitCode, 1, label);
    assert.match(r.lines[r.lines.length - 1], /^egress: FAIL \(commit identity not configured/, label);
    assertNoValues(r.lines.join('\n'));
  }
});

test('the private layer must be configured: deny-list unset or missing FAILS', async () => {
  const repo = newRepo('deny-cases');
  let r = await E.runEgress({ repo, env: scanEnv({ SCRUB_DENYLIST: undefined }) });
  assert.equal(r.lines[r.lines.length - 1], 'egress: FAIL (deny-list not configured)');
  r = await E.runEgress({ repo, env: scanEnv({ SCRUB_DENYLIST: path.join(RUN, 'no-such-denylist.txt') }) });
  assert.equal(r.lines[r.lines.length - 1], 'egress: FAIL (deny-list file missing)');
  r = await E.runEgress({ repo, env: scanEnv({ SCRUB_DENYLIST: path.join(REPO, '.gitignore') }) });
  assert.equal(r.lines[r.lines.length - 1], 'egress: FAIL (deny-list must sit inside sandbox/)');
});

test('rule loading never runs a scrub script that lacks the content-check export', async () => {
  const fakeKit = path.join(RUN, 'fake-kit');
  const marker = path.join(fakeKit, 'ran.txt');
  fs.mkdirSync(path.join(fakeKit, 'scripts'), { recursive: true });
  const scrubFile = path.join(fakeKit, 'scripts', 'scrub-scan.mjs');
  fs.writeFileSync(scrubFile,
    "import fs from 'node:fs';\nfs.writeFileSync(" + JSON.stringify(marker) + ", 'x');\nexport const PUBLIC_RULES = [];\n");
  let loaded = await E.loadRuleCheck(fakeKit);
  assert.match(loaded.error, /scrub rules not available/);
  assert.equal(fs.existsSync(marker), false, 'the scrub script was not imported');

  fs.writeFileSync(scrubFile,
    "export function scanContent({ text }) { return text.includes('bad') ? [{ rule: 'demo' }] : []; }\n");
  loaded = await E.loadRuleCheck(fakeKit);
  assert.equal(typeof loaded.check, 'function');
  assert.deepEqual(loaded.check({ text: 'a bad line' }), [{ rule: 'demo' }]);
});

test('command line: exit code and output hold no value; a missing rule source never passes', () => {
  const repo = newRepo('cli');
  put(repo, 'x.txt', 'x ' + FAKE + '\n');
  commit(repo, 'x');
  const run = (env) => spawnSync(process.execPath, [SCRIPT, '--repo', repo], { env, encoding: 'utf8', windowsHide: true });

  const r = run(scanEnv());
  assert.equal(r.status, 1);
  assertNoValues(r.stdout + r.stderr);
  assert.match(r.stdout, /hit: [0-9a-f]{40,64} file content \[email\]/);
  assert.match(r.stdout, /egress: FAIL \(\d+ hits\)/);

  const bad = run(scanEnv({ EGRESS_IDENTITY: undefined }));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /egress: FAIL \(commit identity not configured/);
});

test('the scan starts git with fixed arguments and no shell', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!/shell:\s*true/.test(src));
  assert.ok(!/(^|[^.\w])(execSync|exec)\(/m.test(src), 'no exec( or execSync( from child_process');
  assert.ok(!/['"]-C['"]/.test(src), 'the repo folder is passed as cwd, not as a git argument');
});
