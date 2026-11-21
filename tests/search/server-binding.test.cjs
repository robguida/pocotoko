'use strict';
// The spawned server's binding and launch checks (spec 6.7, 6.9, 9.1, 9.6,
// 9.10, SR-1 to SR-4, SR-21, SR-42 to SR-44a): T-1, T-8 (install mode),
// T-13, T-15, T-24, T-34 (version), T-35 (server part).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const H = require('../helpers/server-harness.cjs');
const E = require('../../src/search/server/envelope.cjs');
const S = require('../../src/search/server/server.cjs');
const B = require('../../src/search/server/binder.cjs');
const ST = require('../../src/search/server/store.cjs');

test.after(() => H.cleanup());

const NOTICE = E.NOTICE;
const IS_WIN = process.platform === 'win32';
const NOTES = { 'notes/a.md': '# A\n\nthe wombat note\n' };

function startOn(run, kit, extraEnv = {}, { cwd = run.proj, seams = {} } = {}) {
  const env = H.childEnv(run, { CLAUDE_PROJECT_DIR: run.proj, ...kit.env, ...extraEnv });
  return H.start({ serverFile: kit.serverFile, env, cwd, seams: { gitCeiling: run.base, globalExcludes: null, ...seams } });
}
async function statusOf(c) {
  await c.initialize();
  return H.status(c);
}
async function searchOf(c) {
  return H.payloadOf(await c.call('search', { query: 'wombat' }), NOTICE);
}

test('T-8: a copied server outside the plugins folder uses <server folder>/../data, writes nothing in CLAUDE_PLUGIN_DATA, and says the variable was ignored', async () => {
  const run = H.makeBase('t8-copy', NOTES);
  const kit = H.makeKit(run, { options: { projects: [run.proj] } });
  const other = path.join(run.base, 'other-data');
  fs.mkdirSync(other);
  const c = startOn(run, kit, { CLAUDE_PLUGIN_DATA: other });
  try {
    await c.initialize();
    const s = await H.waitFresh(c);
    assert.equal(s.install_mode, 'copy-by-hand');
    assert.ok(s.warnings.includes(S.LINES.PLUGIN_DATA_IGNORED));
    assert.ok((await searchOf(c)).results.length > 0);
    assert.deepEqual(fs.readdirSync(other), [], 'nothing written in the variable folder');
    assert.ok(fs.existsSync(path.join(kit.dataRoot, 'indexes')));
  } finally {
    await c.close();
  }
  const c2 = startOn(run, kit, { CLAUDE_PLUGIN_DATA: undefined });
  try {
    const s = await statusOf(c2);
    assert.equal(s.install_mode, 'copy-by-hand');
    assert.ok(!s.warnings.includes(S.LINES.PLUGIN_DATA_IGNORED));
  } finally {
    await c2.close();
  }
});

test('T-8: a server inside the plugins folder with CLAUDE_PLUGIN_DATA set uses that folder (plugin mode); unset or empty -> binds nothing and writes nothing anywhere', async () => {
  const run = H.makeBase('t8-plugin', NOTES);
  const kit = H.makeKit(run, { mode: 'plugin', options: { projects: [run.proj] } });
  const c = startOn(run, kit);
  try {
    await c.initialize();
    const s = await H.waitFresh(c);
    assert.equal(s.install_mode, 'plugin');
    assert.equal(s.state, 'fresh');
    assert.ok(fs.existsSync(path.join(kit.dataRoot, 'indexes')));
  } finally {
    await c.close();
  }
  for (const v of [undefined, '']) {
    const run2 = H.makeBase('t8-none', NOTES);
    const kit2 = H.makeKit(run2, { mode: 'plugin', options: { projects: [run2.proj] } });
    const before = H.listingKey(run2.base);
    const c2 = startOn(run2, kit2, { CLAUDE_PLUGIN_DATA: v });
    try {
      const s = await statusOf(c2);
      assert.equal(s.install_mode, 'none');
      assert.equal(s.bound_folder, null);
      assert.equal(s.reason, B.REASONS.PLUGIN_DATA_NOT_SET);
      assert.equal((await searchOf(c2)).state, 'off');
    } finally {
      await c2.close();
    }
    assert.equal(H.listingKey(run2.base), before, 'nothing written anywhere (no data/ beside server/)');
    assert.ok(!fs.existsSync(path.join(path.dirname(path.dirname(kit2.serverFile)), 'data')));
  }
});

test('T-13: the config folder inside the project (no git repo) -> search off, nothing written in the project, and the "inside this project" line in status, search and get', async () => {
  const run = H.makeBase('t13-proj', NOTES);
  const cfg = path.join(run.proj, 'cfg');
  const kit = H.makeKit(run, { mode: 'plugin', cfg, options: { projects: [run.proj] } });
  const before = H.listingKey(run.proj);
  const c = startOn(run, kit);
  try {
    const s = await statusOf(c);
    assert.equal(s.state, 'off');
    assert.equal(s.reason, ST.IN_PROJECT_LINE);
    assert.equal((await searchOf(c)).reason, ST.IN_PROJECT_LINE);
    assert.equal(H.textOf(await c.call('get', { id: '0'.repeat(24) })), NOTICE + '\n' + ST.IN_PROJECT_LINE);
  } finally {
    await c.close();
  }
  assert.equal(H.listingKey(run.proj), before, 'nothing written in the project');
});

test('T-13: the config folder inside a different git work tree (a .git folder, and a .git file, in a parent) -> the "inside a git repo" line word for word', async () => {
  for (const kind of ['folder', 'file']) {
    const run = H.makeBase('t13-git-' + kind, NOTES);
    const wrap = path.join(run.base, 'wrap');
    fs.mkdirSync(wrap);
    if (kind === 'folder') fs.mkdirSync(path.join(wrap, '.git'));
    else fs.writeFileSync(path.join(wrap, '.git'), 'gitdir: elsewhere\n');
    const kit = H.makeKit(run, { mode: 'plugin', cfg: path.join(wrap, 'cfg'), options: { projects: [run.proj] } });
    const c = startOn(run, kit);
    try {
      const s = await statusOf(c);
      assert.equal(s.state, 'off');
      assert.equal(s.reason, ST.IN_GIT_LINE);
      assert.equal((await searchOf(c)).reason, ST.IN_GIT_LINE);
      assert.equal(H.textOf(await c.call('get', { id: '0'.repeat(24) })), NOTICE + '\n' + ST.IN_GIT_LINE);
    } finally {
      await c.close();
    }
    assert.ok(!fs.existsSync(path.join(kit.dataRoot, 'indexes')), 'nothing written');
  }
});

test('T-13 / SR-21 with no seams: the real entry file, started directly inside this repo\'s work tree, answers the handshake and says the "inside a git repo" line', async () => {
  const run = H.makeBase('direct', NOTES);
  const kit = H.makeKit(run, { options: { projects: [run.proj] } });
  const c = H.start({ serverFile: kit.serverFile, env: H.childEnv(run, { CLAUDE_PROJECT_DIR: run.proj }), cwd: run.proj, direct: true });
  try {
    const init = await c.initialize();
    assert.equal(init.result.instructions, E.RULES_BLOCK);
    const s = await H.status(c);
    assert.equal(s.reason, ST.IN_GIT_LINE);
    assert.equal((await searchOf(c)).reason, ST.IN_GIT_LINE);
  } finally {
    await c.close();
  }
  assert.ok(!fs.existsSync(path.join(kit.dataRoot, 'indexes')), 'nothing written');
});

// A plugin source folder like this repo's own src/search/: server/, data/search-config.json
// listing the project, and (unless manifest is false) .claude-plugin/plugin.json.
function makeSourceFolder(run, { git, manifest = true }) {
  const topDir = path.join(run.base, 'clone');
  const pluginDir = path.join(topDir, 'src', 'search');
  const serverFile = H.copyServer(path.join(pluginDir, 'server'));
  if (manifest) {
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'));
    fs.copyFileSync(path.join(H.SERVER_SRC, '..', '.claude-plugin', 'plugin.json'), path.join(pluginDir, '.claude-plugin', 'plugin.json'));
  }
  fs.mkdirSync(path.join(pluginDir, 'data'));
  fs.writeFileSync(path.join(pluginDir, 'data', 'search-config.json'), JSON.stringify({ projects: [run.proj] }));
  if (git) fs.mkdirSync(path.join(topDir, '.git'));
  return { topDir, pluginDir, serverFile };
}

test('6.7 / 9.6 e: a local-folder install (a plugin source folder run from outside the plugin cache) binds nothing and writes nothing, in a git clone and outside any', async () => {
  for (const git of [true, false]) {
    const run = H.makeBase('srcdir-' + (git ? 'git' : 'plain'), NOTES);
    const src = makeSourceFolder(run, { git });
    const pdata = path.join(run.base, 'pdata');
    fs.mkdirSync(pdata);
    const beforeTop = H.listingKey(src.topDir);
    const beforeProj = H.listingKey(run.proj);
    const env = H.childEnv(run, { CLAUDE_PROJECT_DIR: run.proj, CLAUDE_PLUGIN_DATA: pdata, CLAUDE_PLUGIN_ROOT: src.pluginDir });
    const c = H.start({ serverFile: src.serverFile, env, cwd: run.proj, seams: { gitCeiling: run.base, globalExcludes: null } });
    try {
      const s = await statusOf(c);
      assert.equal(s.install_mode, 'copy-by-hand', 'git ' + git);
      assert.equal(s.state, 'off');
      assert.equal(s.reason, S.LINES.SOURCE_FOLDER);
      assert.equal(s.bound_folder, null);
      assert.ok(s.warnings.includes(S.LINES.PLUGIN_DATA_IGNORED));
      const p = await searchOf(c);
      assert.deepEqual([p.state, p.reason], ['off', S.LINES.SOURCE_FOLDER]);
      const g = H.payloadOf(await c.call('get', { id: '0'.repeat(24) }), NOTICE);
      assert.deepEqual([g.state, g.reason], ['off', S.LINES.SOURCE_FOLDER]);
    } finally {
      await c.close();
    }
    assert.equal(H.listingKey(src.topDir), beforeTop, 'nothing written in the source folder or its clone');
    assert.equal(H.listingKey(run.proj), beforeProj, 'nothing written in the project');
    assert.deepEqual(fs.readdirSync(pdata), [], 'nothing written in the plugin data folder');
  }
});

test('6.7 / SR-21: the same source folder without a manifest, inside a git clone -> the git-work-tree check refuses it: the "inside a git repo" line and nothing written', async () => {
  const run = H.makeBase('srcdir-nomanifest', NOTES);
  const src = makeSourceFolder(run, { git: true, manifest: false });
  const beforeTop = H.listingKey(src.topDir);
  const env = H.childEnv(run, { CLAUDE_PROJECT_DIR: run.proj, CLAUDE_PLUGIN_ROOT: src.pluginDir });
  const c = H.start({ serverFile: src.serverFile, env, cwd: run.proj, seams: { gitCeiling: run.base, globalExcludes: null } });
  try {
    await c.initialize();
    const s = await H.waitFresh(c);
    assert.equal(s.install_mode, 'copy-by-hand');
    assert.equal(s.state, 'off');
    assert.equal(s.reason, ST.IN_GIT_LINE);
    assert.equal((await searchOf(c)).reason, ST.IN_GIT_LINE);
  } finally {
    await c.close();
  }
  assert.equal(H.listingKey(src.topDir), beforeTop, 'nothing written in the clone');
  assert.ok(!fs.existsSync(path.join(src.pluginDir, 'data', 'indexes')));
});

test('T-13 / SR-20: the index folder is the first 16 hex of the SHA-256 of the root real path; no file or folder name under the data root holds the project name or path', async () => {
  const { run, kit, c } = await H.setup('t13-name', NOTES);
  try {
    await H.waitFresh(c);
  } finally {
    await c.close();
  }
  const expect = crypto.createHash('sha256').update(run.proj, 'utf8').digest('hex').slice(0, 16);
  assert.deepEqual(fs.readdirSync(path.join(kit.dataRoot, 'indexes')), [expect]);
  for (const f of H.listing(kit.dataRoot)) {
    assert.ok(!f.rel.includes(path.basename(run.proj)), f.rel);
    assert.ok(!f.rel.includes(path.basename(run.base)), f.rel);
  }
});

test('T-1 (server part): refused roots bind none and status gives the reason', async () => {
  const run = H.makeBase('t1-roots', NOTES);
  const kit = H.makeKit(run, { options: { projects: [] } });
  const cache = path.join(run.base, 'pcache');
  fs.mkdirSync(path.join(cache, 'x'), { recursive: true });
  const cases = [
    { name: 'home', root: run.home, reason: B.REASONS.HOME },
    { name: 'above home', root: run.base, reason: B.REASONS.HOME },
    { name: 'config folder', root: run.cfg, reason: B.REASONS.CONFIG },
    { name: 'data folder', root: kit.dataRoot, reason: B.REASONS.DATA },
    { name: 'temp folder', root: run.tmp, reason: B.REASONS.TEMP },
    { name: 'plugins folder (moved)', root: path.join(cache, 'x'), reason: B.REASONS.PLUGINS, env: { CLAUDE_CODE_PLUGIN_CACHE_DIR: cache } },
    { name: 'relative project dir', root: 'rel/dir', reason: B.REASONS.PROJECT_DIR_RELATIVE },
    { name: 'missing project dir', root: path.join(run.base, 'missing'), reason: B.REASONS.PROJECT_DIR_MISSING },
  ];
  for (const k of cases) {
    fs.writeFileSync(path.join(kit.dataRoot, 'search-config.json'), JSON.stringify({ projects: path.isAbsolute(k.root) ? [k.root] : [] }));
    const c = startOn(run, kit, { CLAUDE_PROJECT_DIR: k.root, ...(k.env || {}) });
    try {
      const s = await statusOf(c);
      assert.equal(s.bound_folder, null, k.name);
      assert.equal(s.reason, k.reason, k.name);
      assert.equal((await searchOf(c)).state, 'off', k.name);
    } finally {
      await c.close();
    }
  }
});

test('T-1: CLAUDE_PROJECT_DIR unset -> the process start folder is used, under the same refusals', async () => {
  const run = H.makeBase('t1-cwd', NOTES);
  const kit = H.makeKit(run, { options: { projects: [run.proj, run.home] } });
  let c = startOn(run, kit, { CLAUDE_PROJECT_DIR: undefined }, { cwd: run.proj });
  try {
    await c.initialize();
    const s = await H.waitFresh(c);
    assert.equal(s.bound_folder, run.proj);
    assert.equal(s.state, 'fresh');
  } finally {
    await c.close();
  }
  c = startOn(run, kit, { CLAUDE_PROJECT_DIR: undefined }, { cwd: run.home });
  try {
    const s = await statusOf(c);
    assert.equal(s.bound_folder, null);
    assert.equal(s.reason, B.REASONS.HOME);
  } finally {
    await c.close();
  }
});

test('T-1 / 9.1: a project not on the list -> no indexes folder, "not enabled for this project", search off; the server never writes search-config.json', async () => {
  const run = H.makeBase('t1-off', NOTES);
  const kit = H.makeKit(run, { options: { projects: [path.join(run.base, 'elsewhere')] } });
  const cfgFile = path.join(kit.dataRoot, 'search-config.json');
  const before = fs.readFileSync(cfgFile);
  const c = startOn(run, kit);
  try {
    const s = await statusOf(c);
    assert.equal(s.reason, 'not enabled for this project');
    assert.equal(s.bound_folder, run.proj);
    assert.equal(s.counts.bad_project_entry, 1, 'the unresolvable entry is counted');
    const p = await searchOf(c);
    assert.equal(p.state, 'off');
    assert.equal(p.reason, 'not enabled for this project');
  } finally {
    await c.close();
  }
  assert.ok(!fs.existsSync(path.join(kit.dataRoot, 'indexes')), 'no indexes folder');
  assert.deepEqual(fs.readFileSync(cfgFile), before);
});

test('T-1 / 9.1 e (plugin mode): a folder whose name holds a comma, given alone as the projects value, is bound as one path', async () => {
  const run = H.makeBase('t1-comma', NOTES);
  const comma = path.join(run.base, 'with,comma');
  fs.mkdirSync(comma);
  fs.writeFileSync(path.join(comma, 'n.md'), '# N\n\nwombat\n');
  const kit = H.makeKit(run, { mode: 'plugin', options: { projects: [comma] } });
  const c = startOn(run, kit, { CLAUDE_PROJECT_DIR: comma }, { cwd: comma });
  try {
    await c.initialize();
    const s = await H.waitFresh(c);
    assert.equal(s.state, 'fresh');
    assert.ok((await searchOf(c)).results.length > 0);
  } finally {
    await c.close();
  }
});

test('T-1 / 9.1 e (plugin mode): two existing folders as a comma list are both bound; a comma value where neither reading exists refuses the whole option', async () => {
  const run = H.makeBase('t1-comma-list', NOTES);
  const other = path.join(run.base, 'other');
  fs.mkdirSync(other);
  const kit = H.makeKit(run, { mode: 'plugin', options: { projects: [other, run.proj] } });
  const c = startOn(run, kit);
  try {
    await c.initialize();
    const s = await H.waitFresh(c);
    assert.equal(s.state, 'fresh');
    assert.ok((await searchOf(c)).results.length > 0);
  } finally {
    await c.close();
  }
  // run.proj exists but the other two pieces do not, and the whole text is no folder: neither reading fully exists.
  const bad = H.makeKit(run, { mode: 'plugin', options: { projects: [path.join(run.base, 'zqgonezq'), run.proj, path.join(run.base, 'zqawayzq')] } });
  const c2 = startOn(run, bad);
  try {
    const s = await statusOf(c2);
    assert.equal(s.reason, B.REASONS.LIST_UNSAFE);
    assert.ok(!/zqgonezq|zqawayzq/.test(JSON.stringify(s)), 'no path text in status');
    assert.equal((await searchOf(c2)).state, 'off');
  } finally {
    await c2.close();
  }
});

test('plugin mode: an empty value (the simulated arrival of a never-set option) gives the default; a comma-separated list is read as entries', async () => {
  const run = H.makeBase('pm-opts', NOTES);
  const kit = H.makeKit(run, { mode: 'plugin', options: { projects: [run.proj] } });
  const empty = {};
  for (const k of S.OPTION_KEYS) if (k !== 'projects') empty[S.ENV_PREFIX + k.toUpperCase()] = '';
  const c = startOn(run, kit, empty);
  try {
    await c.initialize();
    const s = await H.waitFresh(c);
    assert.equal(s.state, 'fresh');
    assert.equal(s.matching, 'broad');
    assert.equal(s.word_families, 'english');
    assert.ok((await searchOf(c)).results.length > 0);
  } finally {
    await c.close();
  }
});

test('T-15: a debugger flag in execArgv (each form) or an open inspector session -> binds none and status says the launch environment is not clean', async () => {
  const run = H.makeBase('t15', NOTES);
  const kit = H.makeKit(run, { options: { projects: [run.proj] } });
  const cases = [{ execArgv: ['--inspect'] }, { execArgv: ['--inspect-brk'] }, { execArgv: ['--inspect-wait'] }, { execArgv: ['--inspect-port=0'] }, { inspectorUrl: 'ws://127.0.0.1:9/x' }];
  for (const seams of cases) {
    const c = startOn(run, kit, {}, { seams });
    try {
      const s = await statusOf(c);
      assert.equal(s.bound_folder, null);
      assert.equal(s.reason, S.LINES.DEBUGGER, JSON.stringify(seams));
      assert.equal((await searchOf(c)).state, 'off');
    } finally {
      await c.close();
    }
  }
});

test('T-15 (unit): NODE_OPTIONS holding an inspect flag is caught and the inspector is closed; another NODE_OPTIONS or NODE_PATH is only a warning', () => {
  const base = { cwd: process.cwd(), home: B.homeDir(), platform: process.platform, execPath: process.execPath, nodeVersion: '24.0.0', execArgv: [], inspectorUrl: () => undefined };
  for (const v of ['--inspect', '--inspect-brk', '--inspect-wait', '--inspect-port=0', '--max-old-space-size=100 --inspect=127.0.0.1:0']) {
    let closed = 0;
    const r = S.launchChecks({ ...base, env: { NODE_OPTIONS: v }, inspectorClose: () => { closed++; } });
    assert.ok(r.problems.includes(S.LINES.DEBUGGER), v);
    assert.equal(closed, 1);
  }
  const w = S.launchChecks({ ...base, env: { NODE_OPTIONS: '--max-old-space-size=100', NODE_PATH: 'x' }, inspectorClose: () => {} });
  assert.deepEqual(w.problems, []);
  assert.deepEqual(w.warnings, [S.LINES.NODE_OPTIONS_SET, S.LINES.NODE_PATH_SET]);
  assert.ok(S.launchChecks({ ...base, env: {}, nodeVersion: '20.11.0', inspectorClose: () => {} }).problems.includes(S.LINES.NODE_TOO_OLD));
});

test('T-15 / SR-43: any other non-empty NODE_OPTIONS or NODE_PATH -> one warning line each in status, and search still works', async () => {
  const run = H.makeBase('t15-warn', NOTES);
  const kit = H.makeKit(run, { options: { projects: [run.proj] } });
  const c = startOn(run, kit, { NODE_OPTIONS: '--max-old-space-size=256', NODE_PATH: path.join(run.base, 'nm') });
  try {
    await c.initialize();
    const s = await H.waitFresh(c);
    assert.equal(s.warnings.filter((x) => x === S.LINES.NODE_OPTIONS_SET).length, 1);
    assert.equal(s.warnings.filter((x) => x === S.LINES.NODE_PATH_SET).length, 1);
    assert.ok((await searchOf(c)).results.length > 0);
  } finally {
    await c.close();
  }
});

test('T-34 (version): the server started with a Node version under the minimum -> handshake answered, no project bound, status says why', async () => {
  const run = H.makeBase('t34', NOTES);
  const kit = H.makeKit(run, { options: { projects: [run.proj] } });
  const c = startOn(run, kit, {}, { seams: { nodeVersion: '20.18.0' } });
  try {
    const init = await c.initialize();
    assert.ok(init.result.serverInfo);
    const s = await H.status(c);
    assert.equal(s.bound_folder, null);
    assert.equal(s.reason, S.LINES.NODE_TOO_OLD);
  } finally {
    await c.close();
  }
  assert.ok(!fs.existsSync(path.join(kit.dataRoot, 'indexes')));
});

function plantNode(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, path.basename(process.execPath));
  try {
    fs.linkSync(process.execPath, target);
  } catch (_) {
    fs.copyFileSync(process.execPath, target);
    fs.chmodSync(target, 0o755);
  }
  return target;
}

test('T-35 (server part): a copy of the running Node inside the project, as CLAUDE_PROJECT_DIR and as the start folder -> handshake answered, nothing bound or written, the fixed line in status', async () => {
  const run = H.makeBase('t35', NOTES);
  const kit = H.makeKit(run, { options: { projects: [run.proj] } });
  const planted = plantNode(path.join(run.proj, 'tools'));
  for (const mode of ['project_dir', 'start_folder']) {
    const beforeProj = H.listingKey(run.proj);
    const beforeData = H.listingKey(kit.dataRoot);
    const env = mode === 'project_dir' ? {} : { CLAUDE_PROJECT_DIR: undefined };
    const c = H.start({
      serverFile: kit.serverFile,
      env: H.childEnv(run, { CLAUDE_PROJECT_DIR: run.proj, ...env }),
      cwd: run.proj,
      execPath: planted,
      seams: { gitCeiling: run.base, globalExcludes: null },
    });
    try {
      const init = await c.initialize();
      assert.ok(init.result, mode + ': handshake answered');
      const s = await H.status(c);
      assert.equal(s.bound_folder, null);
      assert.equal(s.reason, S.LINES.NODE_IN_PROJECT);
      assert.equal(s.warnings.filter((w) => w === S.LINES.NODE_IN_PROJECT).length, 1, 'the line once');
    } finally {
      await c.close();
    }
    assert.equal(H.listingKey(run.proj), beforeProj, mode + ': project unchanged');
    assert.equal(H.listingKey(kit.dataRoot), beforeData, mode + ': data root unchanged');
  }
});

test('T-24 / SR-3: the server never sends roots/list; a root-change notice and an unasked roots reply naming another folder change nothing', async () => {
  const other = H.makeBase('t24-other', { 'x.md': '# X\n\nwombat elsewhere\n' });
  const { run, c } = await H.setup('t24', NOTES);
  try {
    await H.waitFresh(c);
    c.notify('notifications/roots/list_changed', {});
    c.raw(JSON.stringify({ jsonrpc: '2.0', id: 'roots-1', result: { roots: [{ uri: 'file:///' + other.proj.split(path.sep).join('/'), name: 'other' }] } }) + '\n');
    const s = await H.status(c);
    assert.equal(s.bound_folder, run.proj);
    const p = await searchOf(c);
    assert.ok(p.results.every((r) => r.file === 'notes/a.md'));
    await c.close();
    for (const m of c.messages) assert.notEqual(m.method, 'roots/list', 'no roots request on stdout');
    assert.ok(!c.messages.some((m) => typeof m.method === 'string'), 'the server sends no requests or notifications at all');
  } finally {
    await c.close();
  }
});

test('T-24: a root folder whose name is in decomposed Unicode (NFD) is walked and read through its exact real path', async () => {
  const run = H.makeBase('t24-nfd', {});
  const nfd = path.join(run.base, 'café-notes');
  fs.mkdirSync(nfd);
  fs.writeFileSync(path.join(nfd, 'n.md'), '# N\n\nthe wombat in a decomposed folder\n');
  const kit = H.makeKit(run, { options: { projects: [nfd] } });
  const c = startOn(run, kit, { CLAUDE_PROJECT_DIR: nfd }, { cwd: nfd });
  try {
    await c.initialize();
    const s = await H.waitFresh(c);
    assert.equal(s.bound_folder, fs.realpathSync.native(nfd));
    const p = await searchOf(c);
    assert.equal(p.results.length, 1);
    assert.ok(H.textOf(await c.call('get', { id: p.results[0].id })).includes('decomposed folder'));
  } finally {
    await c.close();
  }
});

test('Windows: status says the index takes the profile folder permissions (SR-23)', { skip: IS_WIN ? false : 'Windows only' }, async () => {
  const { c } = await H.setup('perms', NOTES);
  try {
    const s = await H.waitFresh(c);
    assert.ok(s.warnings.includes(S.LINES.WINDOWS_PERMS));
    assert.equal(s.folder_checks, 'skipped');
  } finally {
    await c.close();
  }
});

test('9.8 / SR-12 (6.11 f rule): a bound folder holding U+202E (enabled and indexed) or over 1,024 characters (not enabled) is shown in status as the unprintable-folder mask, never as the path', async () => {
  const run = H.makeBase('unprintable-root', {});
  const tag = 'rtl' + crypto.randomBytes(3).toString('hex');
  const bidi = path.join(run.base, tag + '\u202e' + 'dm.krow');
  fs.mkdirSync(bidi);
  fs.writeFileSync(path.join(bidi, 'n.md'), '# N\n\nthe marmot note\n');
  let long = path.join(run.base, 'long' + tag);
  while (long.length <= 1024) long = path.join(long, 'd'.repeat(120));
  fs.mkdirSync(long, { recursive: true });
  const bidiReal = fs.realpathSync.native(bidi);
  const longReal = fs.realpathSync.native(long);
  const kit = H.makeKit(run, { options: { projects: [bidiReal] } });
  const cases = [['U+202E, enabled', bidiReal, true], ['over 1,024 characters, not enabled', longReal, false]];
  for (const [label, root, enabled] of cases) {
    // CLAUDE_PROJECT_DIR names the root; the start folder stays short, because Windows cannot start a
    // process in a folder over its path limit.
    const c = H.start({ serverFile: kit.serverFile, env: H.childEnv(run, { CLAUDE_PROJECT_DIR: root }), cwd: enabled ? root : run.proj, seams: { gitCeiling: run.base, globalExcludes: null } });
    try {
      await c.initialize();
      const s = enabled ? await H.waitFresh(c) : await H.status(c);
      assert.equal(s.bound_folder, S.LINES.FOLDER_UNPRINTABLE, label);
      if (enabled) {
        assert.equal(s.state, 'fresh', label);
        const p = H.payloadOf(await c.call('search', { query: 'marmot' }), NOTICE);
        assert.deepEqual(p.results.map((r) => r.file), ['n.md'], label + ': still indexed');
      } else {
        assert.equal(s.reason, 'not enabled for this project', label);
      }
      const text = H.textOf(await c.call('status', {}));
      assert.ok(!text.includes(tag) && !text.includes('\u202e'), label + ': status names no part of the path');
    } finally {
      await c.close();
    }
    const out = c.lines.join('\n');
    assert.ok(!out.includes(tag) && !/\u202e/i.test(out) && !out.includes('\u202e'), label + ': stdout names no part of the path');
  }
  // A printable bound folder is shown as its path, as before.
  const plain = path.join(run.base, 'plain');
  fs.mkdirSync(plain);
  const c = H.start({ serverFile: kit.serverFile, env: H.childEnv(run, { CLAUDE_PROJECT_DIR: plain }), cwd: plain, seams: { gitCeiling: run.base, globalExcludes: null } });
  try {
    const s = await statusOf(c);
    assert.equal(s.bound_folder, fs.realpathSync.native(plain));
  } finally {
    await c.close();
  }
});
