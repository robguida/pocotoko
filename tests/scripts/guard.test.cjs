'use strict';
// T-22 Sandbox guard (spec 13.7). Every temporary file is under
// sandbox/guard/. The real home, real ~/.claude and real ~/.claude.json are
// used only as variable values in the refusal cases, where the guard must
// refuse before any step runs. The narrow listing is exercised against a
// stand-in "real" folder under sandbox/, except one case that proves a
// guarded git run leaves the real global git config unchanged (read-only
// listing, allowed by 13.7).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..', '..');
const SANDBOX = path.join(REPO, 'sandbox');
const GUARD_TMP = path.join(SANDBOX, 'guard');
const RUN = path.join(GUARD_TMP, 'run-' + crypto.randomBytes(6).toString('hex'));
const CASELESS = process.platform === 'win32' || process.platform === 'darwin';
const links = [];

let G;

function flipCase(p) {
  let out = '';
  for (const ch of p) out += ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
  return out;
}

function makeDirLink(target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  links.push(link);
}

function mkdirs(env) {
  for (const k of ['TMP', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'HOME', 'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_PLUGIN_CACHE_DIR', 'XDG_CONFIG_HOME', 'APPDATA', 'LOCALAPPDATA']) {
    if (env[k]) fs.mkdirSync(env[k], { recursive: true });
  }
  fs.mkdirSync(path.dirname(env.GIT_CONFIG_GLOBAL), { recursive: true });
}

function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

test.before(async () => {
  G = await import(pathToFileURL(path.join(REPO, 'scripts', 'lib', 'guard.mjs')).href);
  fs.mkdirSync(RUN, { recursive: true });
});

test.after(() => {
  // Remove links first so a recursive delete can never walk through one.
  for (const l of links) {
    try { fs.rmdirSync(l); } catch { try { fs.unlinkSync(l); } catch { /* left for manual cleanup */ } }
  }
  const rel = path.relative(GUARD_TMP, RUN);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) fs.rmSync(RUN, { recursive: true, force: true });
});

function safeEnv(name) {
  const runDir = path.join(RUN, name);
  const env = G.sandboxEnv({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, runDir, { repo: REPO });
  mkdirs(env);
  return env;
}

// ---------------------------------------------------------------------------

test('a fully sandboxed environment passes the guard', () => {
  const env = safeEnv('ok');
  assert.deepEqual(G.preflight({ env, repo: REPO }), []);
});

test('the guarded variable list matches 13.7', () => {
  assert.deepEqual([...G.GUARDED_VARS].sort(), ['APPDATA', 'CLAUDE_CODE_PLUGIN_CACHE_DIR', 'CLAUDE_CONFIG_DIR',
    'HOME', 'LOCALAPPDATA', 'USERPROFILE', 'XDG_CONFIG_HOME'].sort());
});

test('each guarded variable at the real home, ~/.claude or ~/.claude.json refuses before any step', async () => {
  const home = os.userInfo().homedir;
  const targets = [
    ['real home', home],
    ['real ~/.claude', path.join(home, '.claude')],
    ['inside real ~/.claude', path.join(home, '.claude', 'plugins')],
    ['real ~/.claude.json', path.join(home, '.claude.json')],
  ];
  if (CASELESS) {
    targets.push(['case-changed home', flipCase(home)]);
    targets.push(['case-changed ~/.claude', flipCase(path.join(home, '.claude'))]);
    targets.push(['case-changed ~/.claude.json', flipCase(path.join(home, '.claude.json'))]);
  }
  const base = safeEnv('refuse');
  for (const name of G.GUARDED_VARS) {
    for (const [label, value] of targets) {
      const env = { ...base, [name]: value };
      const problems = G.preflight({ env, repo: REPO });
      assert.equal(problems.length, 1, name + ' at ' + label + ' should give one refusal');
      assert.ok(problems[0].startsWith(name + ' '), 'refusal names the variable');
      assert.ok(!problems[0].includes(home) && !problems[0].toLowerCase().includes(home.toLowerCase()),
        'refusal never prints the path');
      let ran = false;
      const r = await G.guardedRun({ env, repo: REPO, step: () => { ran = true; } });
      assert.equal(r.refused, true);
      assert.equal(ran, false, 'no step runs after a refusal');
    }
  }
});

test('a variable that is unset, relative or outside sandbox/ is refused', () => {
  const base = safeEnv('refuse2');
  const cases = [
    ['unset', undefined, /is not set/],
    ['empty', '', /is not set/],
    ['relative', path.join('sandbox', 'x'), /not an absolute path/],
    ['repo top', REPO, /outside sandbox/],
    ['docs folder', path.join(REPO, 'docs'), /outside sandbox/],
    ['dot-dot escape', path.join(SANDBOX, 'a', '..', '..', 'docs'), /outside sandbox/],
    ['sibling with sandbox prefix', SANDBOX + '-other', /outside sandbox/],
  ];
  for (const [label, value, re] of cases) {
    const env = { ...base };
    if (value === undefined) delete env.HOME; else env.HOME = value;
    const problems = G.checkEnv({ env, repo: REPO });
    assert.equal(problems.length, 1, label);
    assert.match(problems[0], re, label);
  }
});

test('a variable inside sandbox/ that is a link or junction to a place outside is refused', () => {
  const base = safeEnv('linkout');
  const link = path.join(RUN, 'linkout', 'escape');
  makeDirLink(path.join(REPO, 'docs'), link);
  const env = { ...base, CLAUDE_CONFIG_DIR: path.join(link, 'cfg') };
  const problems = G.checkEnv({ env, repo: REPO });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^CLAUDE_CONFIG_DIR .*(link|junction).*outside sandbox/);
});

test('case-changed spelling of a sandbox path is accepted on Windows and macOS', (t) => {
  if (!CASELESS) { t.skip('case-sensitive file system on this OS'); return; }
  const base = safeEnv('case');
  const env = { ...base, HOME: flipCase(base.HOME) };
  assert.deepEqual(G.checkEnv({ env, repo: REPO }), []);
});

test('the guard refuses when sandbox/ itself is a link or junction outside the repo', () => {
  const fakeRepo = path.join(RUN, 'fakerepo');
  const elsewhere = path.join(RUN, 'elsewhere');
  fs.mkdirSync(fakeRepo, { recursive: true });
  fs.mkdirSync(elsewhere, { recursive: true });
  makeDirLink(elsewhere, path.join(fakeRepo, 'sandbox'));
  const problems = G.checkSandboxFolder({ repo: fakeRepo });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /link or junction whose real path is outside the repo/);

  const goodRepo = path.join(RUN, 'goodrepo');
  fs.mkdirSync(path.join(goodRepo, 'sandbox'), { recursive: true });
  assert.deepEqual(G.checkSandboxFolder({ repo: goodRepo }), []);

  const noSandbox = path.join(RUN, 'nosandbox');
  fs.mkdirSync(noSandbox, { recursive: true });
  assert.match(G.checkSandboxFolder({ repo: noSandbox })[0], /missing/);
});

test('path compare: prefix, dot-dot names and case', () => {
  const p = path.join(SANDBOX, 'x');
  assert.equal(G.isInside(path.join(SANDBOX, 'x', 'a'), p), true);
  assert.equal(G.isInside(p + 'b', p), false);
  assert.equal(G.isInside(path.join(p, '..notes'), p), true);
  assert.equal(G.isInside(path.join(p, '..', 'y'), p), false);
  assert.equal(G.isInside(p, p), true);
  assert.equal(G.isInside(flipCase(p), p), CASELESS);
  assert.equal(G.samePath(p, flipCase(p)), CASELESS);
});

// ---------------------------------------------------------------------------
// Narrow listing against a stand-in "real" folder under sandbox/

function buildStandIn(name) {
  const home = path.join(RUN, name);
  const cfg = path.join(home, '.claude');
  writeJson(path.join(cfg, 'settings.json'), { theme: 'dark' });
  writeJson(path.join(home, '.claude.json'), { numStartups: 1, mcpServers: { one: { command: 'x' } } });
  fs.mkdirSync(path.join(cfg, 'skills', 'existing'), { recursive: true });
  writeJson(path.join(cfg, 'plugins', 'installed_plugins.json'), { plugins: {} });
  writeJson(path.join(cfg, 'plugins', 'known_marketplaces.json'), {});
  fs.writeFileSync(path.join(home, '.gitconfig'), '[core]\n\tautocrlf = false\n');
  fs.mkdirSync(path.join(home, '.config', 'git'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'git', 'config'), '[core]\n');
  return { home, cfg };
}

function treeDigest(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p) + ':' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  walk(dir);
  return out.sort().join('\n');
}

test('listing: a non-watched key or a touched-but-unchanged settings.json is not a change', () => {
  const { home, cfg } = buildStandIn('standin-quiet');
  const before = G.takeListing({ home });
  writeJson(path.join(home, '.claude.json'), { numStartups: 2, other: true, mcpServers: { one: { command: 'x' } } });
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(cfg, 'settings.json'), later, later);
  assert.deepEqual(G.compareListings(before, G.takeListing({ home })), []);
});

test('listing: each watched change fails and names that item only', () => {
  const cases = [
    ['.claude.json mcpServers', (h) => writeJson(path.join(h, '.claude.json'),
      { numStartups: 1, mcpServers: { one: { command: 'x' }, two: { command: 'y' } } })],
    ['skills', (h) => fs.mkdirSync(path.join(h, '.claude', 'skills', 'added'))],
    ['plugins/installed_plugins.json', (h) => writeJson(path.join(h, '.claude', 'plugins', 'installed_plugins.json'),
      { plugins: { a: 1 } })],
    ['plugins/known_marketplaces.json', (h) => writeJson(path.join(h, '.claude', 'plugins', 'known_marketplaces.json'),
      { m: 1 })],
    ['settings.json', (h) => writeJson(path.join(h, '.claude', 'settings.json'), { theme: 'light' })],
    ['pocotoko kit folder', (h) => fs.mkdirSync(path.join(h, '.claude', 'pocotoko'))],
    ['git global config', (h) => fs.appendFileSync(path.join(h, '.gitconfig'), '[user]\n\tname = x\n')],
    ['git XDG config', (h) => fs.appendFileSync(path.join(h, '.config', 'git', 'config'), '[user]\n')],
  ];
  cases.forEach(([item, change], i) => {
    const { home } = buildStandIn('standin-change-' + i);
    const before = G.takeListing({ home });
    change(home);
    assert.deepEqual(G.compareListings(before, G.takeListing({ home })), [item]);
  });
});

test('listing: an item that appears or disappears is a change', () => {
  const { home, cfg } = buildStandIn('standin-appear');
  const before = G.takeListing({ home });
  fs.rmSync(path.join(cfg, 'settings.json'));
  fs.rmSync(path.join(home, '.claude.json'));
  assert.deepEqual(G.compareListings(before, G.takeListing({ home })), ['.claude.json mcpServers', 'settings.json']);
});

test('listing only reads, holds no file contents, and the failure names items only', async () => {
  const { home, cfg } = buildStandIn('standin-read');
  const marker = 'unique-' + crypto.randomBytes(8).toString('hex');
  writeJson(path.join(cfg, 'settings.json'), { note: marker });
  const digest = treeDigest(home);
  const listing = G.takeListing({ home });
  assert.equal(treeDigest(home), digest, 'listing wrote nothing');
  assert.ok(!JSON.stringify(listing).includes(marker), 'no file contents in the listing');

  const env = safeEnv('guarded-run');
  const r = await G.guardedRun({
    env, repo: REPO, listHome: home,
    step: () => writeJson(path.join(home, '.claude.json'), { mcpServers: { leaked: { command: marker } } }),
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.changed, ['.claude.json mcpServers']);
  const line = G.describeChanges(r.changed);
  assert.ok(line.includes('.claude.json mcpServers') && !line.includes(marker));
});

test('listing: a link in a watched place is recorded, never followed', () => {
  const { home, cfg } = buildStandIn('standin-link');
  const target = path.join(RUN, 'standin-link-target');
  fs.mkdirSync(path.join(target, 'inner'), { recursive: true });
  fs.rmSync(path.join(cfg, 'skills'), { recursive: true });
  makeDirLink(target, path.join(cfg, 'skills'));
  const before = G.takeListing({ home });
  assert.match(before.items.skills, /^link:/);
  fs.mkdirSync(path.join(target, 'inner2'));
  assert.deepEqual(G.compareListings(before, G.takeListing({ home })), [], 'the link target is not read');
});

// ---------------------------------------------------------------------------
// Child environment

test('every child sees TMP, TEMP, TMPDIR and XDG folders under sandbox/, and git sees sandbox settings', async () => {
  const env = safeEnv('child');
  const names = ['TMP', 'TEMP', 'TMPDIR', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'GIT_CONFIG_GLOBAL'];
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
    { env, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0);
  const seen = JSON.parse(r.stdout);
  for (const n of names) {
    assert.ok(seen[n] && G.isInside(seen[n], SANDBOX), n + ' is under sandbox/');
  }
  assert.equal(seen.GIT_CONFIG_NOSYSTEM, '1');

  // A guarded git run writes its global setting under sandbox/ and leaves the
  // real global git config unchanged (read-only listing of the real home).
  const value = 'guard-test-' + crypto.randomBytes(4).toString('hex');
  const run = await G.guardedRun({
    env, repo: REPO,
    step: () => spawnSync('git', ['config', '--global', 'pocotoko.guardtest', value], { env, windowsHide: true }),
  });
  assert.equal(run.refused, false);
  assert.equal(run.result.status, 0);
  assert.ok(!run.changed.includes('git global config') && !run.changed.includes('git XDG config'));
  assert.ok(fs.readFileSync(env.GIT_CONFIG_GLOBAL, 'utf8').includes(value));
});

test('the child environment refuses a run folder outside sandbox/', () => {
  assert.throws(() => G.childEnv({}, path.join(REPO, 'docs')), G.GuardRefusal);
  assert.throws(() => G.childEnv({}, SANDBOX), G.GuardRefusal);
  assert.throws(() => G.childEnv({}, 'relative'), G.GuardRefusal);
});

// ---------------------------------------------------------------------------
// PowerShell expansion check and shared module

test('the PowerShell expansion check refuses a path outside sandbox/', () => {
  assert.deepEqual(G.checkExpandedPaths([path.join(SANDBOX, 'home', '.claude', 'pocotoko')]), []);
  const out = G.checkExpandedPaths([path.join(os.userInfo().homedir, '.claude', 'pocotoko'), path.join(SANDBOX, 'ok')]);
  assert.equal(out.length, 1);
  assert.match(out[0], /#1 lands outside sandbox/);
  assert.match(G.checkExpandedPaths(['relative'])[0], /not an absolute path/);
});

test('the PowerShell shell half takes only the four plain variable lines of a rendered block', () => {
  const ok = ["$REPO = 'a'", "$CONFIG = 'b'", "$KIT = 'c'", "$NODE = 'd'"];
  assert.match(G.expandInPowerShell({}).error, /needs the program/);
  assert.match(G.expandInPowerShell({ exe: 'x', varLines: ok.slice(0, 3) }).error, /needs the program and the four variable lines/);
  for (const bad of ["$KIT = 'c'; Remove-Item x", '$KIT = "$HOME"', "$OTHER = 'c'", "$KIT = 'c' + 'd'"]) {
    assert.match(G.expandInPowerShell({ exe: 'x', varLines: [ok[0], ok[1], bad, ok[3]] }).error, /not a plain assignment/, bad);
  }
});

test('13.7: before a rendered block runs, its shell is asked what the variables expand to, and a write target outside sandbox/ is refused (PowerShell on Windows; bash where present)', async (t) => {
  const D = await import(pathToFileURL(path.join(REPO, 'scripts', 'lib', 'dev-run.mjs')).href);
  const shells = D.findShells();
  const inside = path.join(SANDBOX, 'guard', 'x', 'home', '.claude').split(path.sep).join('/');
  const outside = path.join(os.userInfo().homedir, '.claude').split(path.sep).join('/');
  const repo = REPO.split(path.sep).join('/');
  const node = process.execPath.split(path.sep).join('/');
  const lines = (shell, cfg) => [['REPO', repo], ['CONFIG', cfg], ['KIT', cfg + '/pocotoko'], ['NODE', node]]
    .map(([k, v]) => (shell === 'bash' ? k + "='" + v + "'" : '$' + k + " = '" + v + "'"));
  let ran = 0;
  // A sandbox run environment, so neither shell writes its caches into the real profile.
  const run = D.makeRun('guard-test', 'expansion');
  t.after(() => D.removeRun(run));
  for (const shell of ['powershell', 'bash']) {
    if (!shells[shell]) { t.diagnostic(shell + ': ' + shells.why[shell]); continue; }
    ran++;
    const env = D.runEnv(run);
    const good = D.askExpansion(shell, shells[shell], lines(shell, inside), { env, cwd: run.project });
    assert.ok(good.values, shell + ' answered');
    assert.deepEqual(D.expansionProblems(good.values), [], shell + ': all inside');
    const bad = D.askExpansion(shell, shells[shell], lines(shell, outside), { env, cwd: run.project });
    const p = D.expansionProblems(bad.values);
    assert.ok(p.some((x) => /CONFIG lands outside sandbox/.test(x)) && p.some((x) => /KIT lands outside sandbox/.test(x)), shell + ': ' + p.join('; '));
  }
  if (!ran) t.skip('neither shell found on this machine');
});

test('sandbox.mjs and copy-by-hand.mjs share this one guard module', (t) => {
  const files = ['sandbox.mjs', 'copy-by-hand.mjs'].map((f) => path.join(REPO, 'scripts', f));
  const present = files.filter((f) => fs.existsSync(f));
  if (present.length === 0) { t.skip('both scripts arrive in B9'); return; }
  for (const f of present) {
    assert.match(fs.readFileSync(f, 'utf8'), /from\s+['"]\.\/lib\/guard\.mjs['"]/, path.basename(f) + ' imports the shared guard');
  }
});
