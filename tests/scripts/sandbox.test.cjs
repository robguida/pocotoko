'use strict';
// The two install checks (spec 13.4, 13.7, 14.6; 15.3 sandbox row). No Claude Code
// program is given here, so every CLI step is a counted skip; the live runs with the
// program are run by hand and recorded in the changelog.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO_TOP, makeTempDir, removeDir } = require('../helpers/tmpdir-sandbox.cjs');

const made = [];
after(() => { for (const d of made) removeDir(d); });

function run(script, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  for (const k of Object.keys(env)) if (/^(?:KIT_CLAUDE_CODE|NODE_TEST_CONTEXT)$/.test(k)) delete env[k];
  return spawnSync(process.execPath, [path.join(REPO_TOP, 'scripts', script), ...args], { env, cwd: REPO_TOP, encoding: 'utf8', timeout: 600000, windowsHide: true });
}

test('13.4: sandbox.mjs --check with no Claude Code program prints SKIPPED with its reason and a skipped count of at least 1, and says a skip never counts toward the release gate', () => {
  const r = run('sandbox.mjs', ['--check']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^SKIPPED sandbox --check: no Claude Code program given/m);
  const m = /^sandbox --check: succeeded 0, failed 0, skipped (\d+) \(a skip never counts toward the release gate\)$/m.exec(r.stdout);
  assert.ok(m && Number(m[1]) >= 1, r.stdout);
  const v = run('sandbox.mjs', ['--validate']);
  assert.equal(v.status, 0);
  assert.match(v.stdout, /^SKIPPED plugin validate --strict: /m);
  assert.match(v.stdout, /skipped 1 \(a skip never counts toward the release gate\)/);
});

test('the check scripts refuse unknown arguments and need one mode', () => {
  assert.equal(run('sandbox.mjs', ['--nope']).status, 2);
  assert.equal(run('sandbox.mjs', []).status, 2);
  assert.equal(run('copy-by-hand.mjs', []).status, 2);
  assert.equal(run('copy-by-hand.mjs', ['--render', '--check']).status, 2);
  assert.equal(run('copy-by-hand.mjs', ['--check', '--shells', 'cmd']).status, 2);
});

test('14.6 / 12.2 c: copy-by-hand.mjs --check (Node half, and the bash block where bash is found) reaches the same installed state, leaves each home byte-identical after uninstall, stops at an existing skill folder, and keeps every temporary file under sandbox/', (t) => {
  const canary = makeTempDir('os-temp-canary');
  made.push(canary);
  const runFolders = () => { try { return fs.readdirSync(path.join(REPO_TOP, 'sandbox', 'copy-by-hand')); } catch (_) { return []; } };
  const before = runFolders();
  const r = run('copy-by-hand.mjs', ['--check', '--shells', 'node,bash'], { TMP: canary, TEMP: canary, TMPDIR: canary });
  const out = r.stdout;
  assert.equal(r.status, 0, out + r.stderr);
  assert.match(out, /^copy-by-hand --check: succeeded \d+, failed 0, skipped \d+/m);
  assert.match(out, /^SKIPPED Claude Code CLI steps: no Claude Code program given .*a skip never counts toward the release gate/m);
  assert.match(out, /^== node\n/m);
  assert.match(out, /^== node \(a skill folder of the same name already there\)$/m);
  assert.match(out, /^ {2}stopped {2}copy-skill-handoff - Stopped: <CONFIG>\/skills\/handoff already exists\. It was not changed\.$/m);
  assert.match(out, /^ {2}done {5}own skill folder left byte-identical$/m);
  const clean = out.match(/^ {2}done {5}clean end: home byte-identical to the pre-install snapshot$/gm) || [];
  if (/^== bash$/m.test(out)) {
    assert.match(out, /^same installed state: node and bash$/m);
    assert.equal(clean.length, 10, 'node and bash, each in the five starting homes');
    assert.equal((out.match(/^ {2}done {5}nothing changed by the stopped install$/gm) || []).length, 4, 'the kit-folder stops, two per shell');
  } else {
    assert.match(out, /^SKIPPED bash run: /m);
    assert.equal(clean.length, 5);
    t.diagnostic('bash not found: only the Node half ran');
  }
  assert.match(out, /^sandbox guard: real config items unchanged$/m);
  assert.deepEqual(fs.readdirSync(canary), [], 'nothing in the stand-in OS temp folder');
  const realHome = require('node:os').userInfo().homedir;
  for (const h of [realHome, realHome.split(path.sep).join('/')]) assert.ok(!out.toLowerCase().includes(h.toLowerCase()), 'the report names placeholders, never this machine\'s home');
  // A passed run removes its own run folders.
  assert.deepEqual(runFolders().filter((n) => !before.includes(n)), [], 'a passed run removes its own run folders');
});

test('13.4: a named Claude Code program that is not found, or will not start, fails the check (exit 1); only an unnamed one is a skip', () => {
  const dir = makeTempDir('named-program');
  made.push(dir);
  const bad = path.join(dir, 'will-not-start.cjs');
  fs.writeFileSync(bad, 'process.exit(3);\n');
  const missing = path.join(REPO_TOP, 'sandbox', 'no-such-program.exe');
  for (const [script, args, env] of [
    ['sandbox.mjs', ['--check', '--claude-code', missing], {}],
    ['sandbox.mjs', ['--validate', '--claude-code', missing], {}],
    ['sandbox.mjs', ['--check', '--find-in', dir], {}],
    ['sandbox.mjs', ['--check'], { KIT_CLAUDE_CODE: missing }],
    ['sandbox.mjs', ['--check', '--claude-code', bad], {}],
    ['copy-by-hand.mjs', ['--check', '--shells', 'node', '--claude-code', missing], {}],
    ['copy-by-hand.mjs', ['--check', '--shells', 'node', '--claude-code', bad], {}],
  ]) {
    const e = { ...process.env, ...env };
    for (const k of Object.keys(e)) if (k === 'NODE_TEST_CONTEXT' || (k === 'KIT_CLAUDE_CODE' && !env.KIT_CLAUDE_CODE)) delete e[k];
    const r = spawnSync(process.execPath, [path.join(REPO_TOP, 'scripts', script), ...args], { env: e, cwd: REPO_TOP, encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.equal(r.status, 1, script + ' ' + args.join(' ') + ': ' + r.stdout);
    assert.match(r.stdout, /^FAILED .*(?:not found|did not start|names no program|no Claude Code package)/m, script + ' ' + args.join(' '));
    assert.ok(!/^SKIPPED/m.test(r.stdout), 'a named program is never a skip');
  }
});

test('13.7: the child environment drops every git variable, shell start files, the SSH agent and anything named like a credential', async () => {
  const { pathToFileURL } = require('node:url');
  const D = await import(pathToFileURL(path.join(REPO_TOP, 'scripts', 'lib', 'dev-run.mjs')).href);
  const planted = {
    GIT_DIR: 'x', GIT_WORK_TREE: 'x', GIT_INDEX_FILE: 'x', GIT_OBJECT_DIRECTORY: 'x', GIT_CONFIG_PARAMETERS: 'x', GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'x', GIT_CONFIG_VALUE_0: 'x', GIT_ASKPASS: 'x', GIT_SSH_COMMAND: 'x', BASH_ENV: 'x', ENV: 'x', NPM_TOKEN: 'x',
    NODE_AUTH_TOKEN: 'x', SSH_AUTH_SOCK: 'x', ACTIONS_RUNTIME_TOKEN: 'x', ACTIONS_ID_TOKEN_REQUEST_URL: 'x', MY_SERVICE_SECRET: 'x',
    DB_PASSWORD: 'x', SOME_CREDENTIALS: 'x', VENDOR_API_KEY: 'x', KEEP_ME: 'y',
  };
  const out = D.cleanBaseEnv(planted);
  assert.deepEqual(Object.keys(out), ['KEEP_ME']);
  const run = D.makeRun('install-proof-test', 'env');
  try {
    const env = D.runEnv(run);
    for (const k of Object.keys(env)) if (/^GIT_/.test(k)) assert.ok(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT'].includes(k), k);
  } finally {
    D.removeRun(run);
  }
});

test('13.7: started from inside a git hook (GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE pointing at another repo), the git-source build touches only its own sandbox repo', async () => {
  const { pathToFileURL } = require('node:url');
  const D = await import(pathToFileURL(path.join(REPO_TOP, 'scripts', 'lib', 'dev-run.mjs')).href);
  const dir = makeTempDir('gitdir-decoy');
  made.push(dir);
  const decoy = path.join(dir, 'decoy');
  fs.mkdirSync(decoy);
  // Git by absolute path in a clean environment (no outside git variable), as the scripts do.
  const gitEnv = { ...D.cleanBaseEnv(process.env), GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '');
  const gitExe = D.findGit(gitEnv);
  assert.ok(gitExe && path.isAbsolute(gitExe), 'git found by absolute path');
  const git = (args, cwd) => spawnSync(gitExe, args, { cwd, env: gitEnv, encoding: 'utf8', windowsHide: true });
  assert.equal(git(['init', '-q', decoy], dir).status, 0);
  // This repo's git folder and index, asked of git: in a linked worktree `.git` is a file.
  const ask = (...args) => {
    const r = git(args, REPO_TOP);
    assert.equal(r.status, 0, args.join(' ') + ': ' + r.stderr);
    return r.stdout.trim();
  };
  const gitDir = ask('rev-parse', '--absolute-git-dir');
  const indexFile = path.resolve(REPO_TOP, ask('rev-parse', '--git-path', 'index'));
  const headFile = path.join(gitDir, 'HEAD');
  const realHead = git(['rev-parse', 'HEAD'], REPO_TOP).stdout;
  const realHeadFile = fs.readFileSync(headFile);
  const realIndex = fs.readFileSync(indexFile);
  const child = path.join(dir, 'child.mjs');
  fs.writeFileSync(child, [
    "import { pathToFileURL } from 'node:url';",
    "const repo = process.argv[2];",
    "const D = await import(pathToFileURL(repo + '/scripts/lib/dev-run.mjs').href);",
    "const SB = await import(pathToFileURL(repo + '/scripts/sandbox.mjs').href);",
    "const rows = []; const rep = { add: (p, id, s, why) => { rows.push(s + ' ' + id + ' ' + (why || '')); return s === 'done'; }, ok(p, id, c, why) { return this.add(p, id, c ? 'done' : 'failed', why); } };",
    "const run = D.makeRun('install-proof-test', 'gitdir');",
    "const src = await SB.gitSource(rep, run, D.runEnv(run));",
    "if (src) src.stop();",
    "console.log(JSON.stringify({ ok: !!src, rows }));",
    "D.removeRun(run);",
  ].join('\n'));
  const hooked = { ...process.env, GIT_DIR: path.join(decoy, '.git'), GIT_WORK_TREE: decoy, GIT_INDEX_FILE: path.join(decoy, '.git', 'index') };
  delete hooked.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [child, REPO_TOP.split(path.sep).join('/')], { env: hooked, cwd: REPO_TOP, encoding: 'utf8', timeout: 180000 });
  const res = JSON.parse(String(r.stdout).trim().split('\n').pop());
  assert.ok(res.ok, res.rows.join('\n') + r.stderr);
  assert.notEqual(git(['rev-parse', '--verify', '-q', 'HEAD'], decoy).status, 0, 'the decoy repo got no commit');
  assert.ok(!fs.existsSync(path.join(decoy, '.git', 'index')), 'the decoy repo got no index');
  assert.equal(git(['rev-parse', 'HEAD'], REPO_TOP).stdout, realHead, 'this repo has the same HEAD');
  assert.ok(fs.readFileSync(headFile).equals(realHeadFile), 'this repo has the same HEAD file');
  assert.ok(fs.readFileSync(indexFile).equals(realIndex), 'this repo has the same index');
});

test('sandbox.mjs: a CLI row is held only on the exact managed-MCP refusal text; a login message or a short form of the text is a failure; plugin details must list every wanted part with its exact count', async () => {
  const { pathToFileURL } = require('node:url');
  const SB = await import(pathToFileURL(path.join(REPO_TOP, 'scripts', 'sandbox.mjs')).href);
  assert.equal(SB.cliStatus({ status: 0, out: '' }).status, 'done');
  assert.equal(SB.cliStatus({ status: 1, out: 'Cannot add MCP server: enterprise MCP configuration is active and has exclusive control over MCP servers' }).status, 'held');
  for (const out of ['Please log in first', 'not authenticated', 'enterprise MCP configuration', 'boom']) assert.equal(SB.cliStatus({ status: 1, out }).status, 'failed', out);
  const want = { skills: 3, hooks: 2, 'MCP servers': 0 };
  assert.ok(SB.partsMatch('Components: skills 3, hooks 2, MCP servers 0, agents 0', want));
  assert.ok(!SB.partsMatch('Components: skills 3, MCP servers 0', want), 'a missing key fails');
  assert.ok(!SB.partsMatch('Components: skills 3, hooks 1, MCP servers 0', want), 'a wrong count fails');
});
