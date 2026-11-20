'use strict';
// binder.cjs (spec 6.7, 9.1, 9.6, 9.10, SR-1 to SR-6, SR-44a): T-1 (unit part),
// T-8 (install-mode rule, unit part), T-24 (Unicode forms), T-35 (the path test),
// list arrival (9.1 e) and bad_project_entry. The spawned-server half of these
// cases is in server-binding.test.cjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const B = require('../../src/search/server/binder.cjs');
const { makeTempDir, removeDir } = require('../helpers/tmpdir-sandbox.cjs');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const dirs = [];
test.after(() => { for (const d of dirs) removeDir(d); });

function base(name) {
  const d = fs.realpathSync.native(makeTempDir('binder-' + name));
  dirs.push(d);
  return d;
}
function mk(...parts) {
  const p = path.join(...parts);
  fs.mkdirSync(p, { recursive: true });
  return fs.realpathSync.native(p);
}
function dirLink(target, link) {
  fs.symlinkSync(target, link, IS_WIN ? 'junction' : 'dir');
  return link;
}
function ctxFor(b) {
  return {
    home: mk(b, 'home'),
    configDir: mk(b, 'cfg'),
    pluginsDir: path.join(mk(b, 'cfg'), 'plugins'),
    dataRoot: mk(b, 'data'),
    tempDir: mk(b, 't', 'tmp'),
    platform: process.platform,
  };
}

test('T-1: refused roots -> a reason; an ordinary project folder -> none (SR-4)', () => {
  const b = base('refuse');
  const ctx = ctxFor(b);
  const proj = mk(b, 'proj');
  const R = B.REASONS;
  assert.equal(B.refusedRoot(proj, ctx), null);
  assert.equal(B.refusedRoot(path.parse(b).root, ctx), R.FS_ROOT, 'filesystem or drive root');
  assert.equal(B.refusedRoot(ctx.home, ctx), R.HOME, 'home');
  assert.equal(B.refusedRoot(b, ctx), R.HOME, 'above home');
  assert.equal(B.refusedRoot(ctx.configDir, ctx), R.CONFIG, 'config folder');
  assert.equal(B.refusedRoot(mk(ctx.configDir, 'sub'), ctx), R.CONFIG, 'inside the config folder');
  assert.equal(B.refusedRoot(ctx.dataRoot, ctx), R.DATA, 'data folder');
  assert.equal(B.refusedRoot(mk(ctx.dataRoot, 'indexes'), ctx), R.DATA, 'inside the data folder');
  assert.equal(B.refusedRoot(ctx.tempDir, ctx), R.TEMP, 'temp folder');
  assert.equal(B.refusedRoot(path.dirname(ctx.tempDir), ctx), R.TEMP, 'above the temp folder');
  // Plugins folder (SR-4 g): the default sits in the config folder; a moved one is refused on its own.
  const moved = { ...ctx, pluginsDir: mk(b, 'pcache') };
  assert.equal(B.refusedRoot(moved.pluginsDir, moved), R.PLUGINS);
  assert.equal(B.refusedRoot(mk(moved.pluginsDir, 'cache', 'x'), moved), R.PLUGINS);
  assert.equal(B.refusedRoot(mk(ctx.configDir, 'plugins', 'cache'), ctx), R.CONFIG);
});

test('T-1: a link or junction to the home folder or the config folder is refused after real-path resolution', () => {
  const b = base('links');
  const ctx = ctxFor(b);
  const toHome = fs.realpathSync.native(dirLink(ctx.home, path.join(b, 'link-home')));
  const toCfg = fs.realpathSync.native(dirLink(ctx.configDir, path.join(b, 'link-cfg')));
  assert.equal(B.refusedRoot(toHome, ctx), B.REASONS.HOME);
  assert.equal(B.refusedRoot(toCfg, ctx), B.REASONS.CONFIG);
});

test('T-1: Windows UNC paths and the \\\\?\\UNC\\ form are network paths; Linux network file systems are refused, 9p is not (SR-4 f)', () => {
  const BS = String.fromCharCode(92);
  const unc = [BS + BS + 'srv' + BS + 'share' + BS + 'x', BS + BS + '?' + BS + 'UNC' + BS + 'srv' + BS + 'share'];
  for (const p of unc) assert.equal(B.refusedRoot(p, { platform: 'win32' }), B.REASONS.NETWORK);
  assert.equal(B.isNetworkPath('/srv/x', 'linux', () => ({ type: 0x6969 })), true, 'nfs');
  assert.equal(B.isNetworkPath('/srv/x', 'linux', () => ({ type: 0xff534d42 })), true, 'cifs');
  assert.equal(B.isNetworkPath('/mnt/c', 'linux', () => ({ type: 0x01021997 })), false, '9p (WSL drives) is not refused');
  assert.equal(B.isNetworkPath('/srv/x', 'linux', () => { throw new Error('x'); }), false);
});

test('isAbsoluteFor: a Windows path needs a drive or a UNC start; POSIX needs a leading slash', () => {
  const BS = String.fromCharCode(92);
  assert.equal(B.isAbsoluteFor('C:' + BS + 'x', 'win32'), true);
  assert.equal(B.isAbsoluteFor('C:/x', 'win32'), true);
  assert.equal(B.isAbsoluteFor('C:x', 'win32'), false);
  assert.equal(B.isAbsoluteFor(BS + 'x', 'win32'), false);
  assert.equal(B.isAbsoluteFor('rel', 'win32'), false);
  assert.equal(B.isAbsoluteFor('/x', 'linux'), true);
  assert.equal(B.isAbsoluteFor('x/y', 'linux'), false);
  assert.equal(B.isAbsoluteFor('', 'linux'), false);
});

test('T-1 / 9.10: the root is the real path of CLAUDE_PROJECT_DIR, else of the start folder; relative or missing -> binds none', () => {
  const b = base('root');
  const proj = mk(b, 'proj');
  const link = dirLink(proj, path.join(b, 'via-link'));
  assert.deepEqual(B.resolveRoot({ env: { CLAUDE_PROJECT_DIR: proj }, cwd: b }), { rootReal: proj, source: 'project_dir' });
  assert.equal(B.resolveRoot({ env: { CLAUDE_PROJECT_DIR: link }, cwd: b }).rootReal, proj, 'a root reached through a link binds to its real path (T-24)');
  assert.deepEqual(B.resolveRoot({ env: {}, cwd: proj }), { rootReal: proj, source: 'start_folder' });
  assert.deepEqual(B.resolveRoot({ env: { CLAUDE_PROJECT_DIR: '' }, cwd: proj }), { rootReal: proj, source: 'start_folder' });
  assert.deepEqual(B.resolveRoot({ env: { CLAUDE_PROJECT_DIR: 'relative/dir' }, cwd: proj }), { refused: B.REASONS.PROJECT_DIR_RELATIVE });
  assert.deepEqual(B.resolveRoot({ env: { CLAUDE_PROJECT_DIR: path.join(b, 'missing') }, cwd: proj }), { refused: B.REASONS.PROJECT_DIR_MISSING });
});

test('9.1 e list arrival: an array, a JSON-array text, and the same paths joined by commas or new lines give the same entries', () => {
  const b = base('lists');
  const p = [mk(b, 'one'), mk(b, 'two'), mk(b, 'three')];
  for (const raw of [p, JSON.stringify(p), p.join(','), p.join('\n'), p.join('\r\n')]) {
    for (const root of p) assert.equal(B.projectSwitch(root, raw).enabled, true, JSON.stringify(raw).slice(0, 40));
    assert.equal(B.projectSwitch(mk(b, 'four'), raw).enabled, false);
  }
});

test('T-1 / 9.1 e: a joined list with a piece that is not absolute (a folder path holding a comma) is refused whole', () => {
  const b = base('comma');
  const withComma = mk(b, 'a,b');
  const r = B.projectSwitch(withComma, [withComma].join(','));
  assert.equal(r.listRefused, true);
  assert.equal(r.enabled, false);
  // The same path as one array element is one entry and is fine.
  assert.equal(B.projectSwitch(withComma, JSON.stringify([withComma])).enabled, true);
});

test('bad_project_entry (9.1 a, b): one relative, one empty and one unresolvable entry count 3; a valid fourth still enables its project', () => {
  const b = base('bad');
  const proj = mk(b, 'proj');
  const r = B.projectSwitch(proj, JSON.stringify(['relative/x', '', path.join(b, 'nope'), proj]));
  assert.equal(r.bad, 3);
  assert.equal(r.enabled, true);
});

test('T-1 project list: exact match only; no prefix match, no parent-enables-child; a link entry matches after real-path resolution; a refused root enables nothing', () => {
  const b = base('exact');
  const a = mk(b, 'x', 'a');
  const ab = mk(b, 'x', 'ab');
  const x = path.dirname(a);
  assert.equal(B.projectSwitch(ab, [a]).enabled, false, '/x/a does not enable /x/ab');
  assert.equal(B.projectSwitch(a, [x]).enabled, false, '/x does not enable /x/a');
  const link = dirLink(a, path.join(b, 'link-a'));
  assert.equal(B.projectSwitch(a, [link]).enabled, true);
  const ctx = ctxFor(b);
  const r = B.projectSwitch(ctx.home, [ctx.home], ctx);
  assert.equal(r.enabled, false);
  assert.equal(r.refusedEntries, 1);
  assert.deepEqual(B.projectSwitch(a, ''), { enabled: false, bad: 0, refusedEntries: 0, listRefused: false }, 'a never-set list enables nothing');
});

test('T-1: a case-changed entry matches on Windows and macOS only', () => {
  const b = base('case');
  const proj = mk(b, 'CaseProj');
  const changed = path.join(path.dirname(proj), 'caseproj');
  const r = B.projectSwitch(proj, [changed]);
  if (IS_WIN || IS_MAC) assert.equal(r.enabled, true);
  else assert.equal(r.enabled, false);
});

test('T-24: a root folder named in decomposed form (NFD) is not enabled by a composed (NFC) entry on Linux and Windows; on macOS it is', () => {
  const b = base('nfd');
  const nfd = mk(b, 'cafe\u0301');
  const nfc = path.join(path.dirname(nfd), 'caf\u00e9');
  const r = B.projectSwitch(nfd, [nfc]);
  if (IS_MAC) assert.equal(r.enabled, true);
  else assert.equal(r.enabled, false);
  assert.equal(B.projectSwitch(nfd, [nfd]).enabled, true, 'the exact form matches everywhere');
});

test('T-8 (unit): install mode by the 6.7 rule', () => {
  const b = base('mode');
  const home = mk(b, 'home');
  const cfg = mk(b, 'cfg');
  const cache = mk(b, 'pcache');
  const copyServer = path.join(mk(b, 'kit', 'search', 'server'), 'server.cjs');
  fs.writeFileSync(copyServer, '');
  const pluginServer = path.join(mk(cache, 'cache', 'm', 'search', '1', 'server'), 'server.cjs');
  fs.writeFileSync(pluginServer, '');
  const defaultPluginServer = path.join(mk(cfg, 'plugins', 'cache', 'm', 'search', '1', 'server'), 'server.cjs');
  fs.writeFileSync(defaultPluginServer, '');
  const data = mk(b, 'pdata');
  const kitData = path.join(path.dirname(path.dirname(copyServer)), 'data');

  let m = B.installMode({ env: { CLAUDE_CONFIG_DIR: cfg, CLAUDE_PLUGIN_DATA: data }, serverFile: copyServer, home });
  assert.equal(m.mode, 'copy');
  assert.equal(m.dataRoot, kitData);
  assert.equal(m.pluginDataIgnored, true, 'a set variable is ignored in copy-by-hand mode, and said so');
  m = B.installMode({ env: { CLAUDE_CONFIG_DIR: cfg }, serverFile: copyServer, home });
  assert.equal(m.mode, 'copy');
  assert.equal(m.dataRoot, kitData);
  assert.equal(m.pluginDataIgnored, false);

  const env = { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_PLUGIN_CACHE_DIR: cache };
  m = B.installMode({ env: { ...env, CLAUDE_PLUGIN_DATA: data }, serverFile: pluginServer, home });
  assert.equal(m.mode, 'plugin');
  assert.equal(m.dataRoot, data);
  for (const v of [undefined, '', '   ', 'relative/data']) {
    m = B.installMode({ env: { ...env, CLAUDE_PLUGIN_DATA: v }, serverFile: pluginServer, home });
    assert.equal(m.mode, 'none', 'variable ' + JSON.stringify(v));
    assert.equal(m.reason, B.REASONS.PLUGIN_DATA_NOT_SET);
    assert.equal(m.dataRoot, null);
  }
  // The plugins folder defaults to <config>/plugins when the cache variable is unset.
  m = B.installMode({ env: { CLAUDE_CONFIG_DIR: cfg, CLAUDE_PLUGIN_DATA: data }, serverFile: defaultPluginServer, home });
  assert.equal(m.mode, 'plugin');
  assert.equal(m.pluginsDir, path.join(cfg, 'plugins'));
  // With the cache moved, a server under <config>/plugins is no longer in plugin mode.
  m = B.installMode({ env: { ...env, CLAUDE_PLUGIN_DATA: data }, serverFile: defaultPluginServer, home });
  assert.equal(m.mode, 'copy');
  // The config folder is CLAUDE_CONFIG_DIR when set, else <home>/.claude.
  assert.equal(B.configDirOf({}, home), path.join(home, '.claude'));
  assert.equal(B.configDirOf({ CLAUDE_CONFIG_DIR: cfg }, home), cfg);
});

test('T-35 (path test): Node inside the project folder or the start folder is caught; a root, home or above-home folder is not tested', () => {
  const b = base('selfcheck');
  const home = mk(b, 'home');
  const proj = mk(b, 'proj');
  const exe = path.join(mk(proj, 'tools'), IS_WIN ? 'node.exe' : 'node');
  fs.writeFileSync(exe, '');
  const outsideExe = path.join(mk(b, 'nodehome'), IS_WIN ? 'node.exe' : 'node');
  fs.writeFileSync(outsideExe, '');
  assert.equal(B.nodeInsideProject({ execPath: exe, projectDir: proj, cwd: b, home }), true);
  assert.equal(B.nodeInsideProject({ execPath: exe, projectDir: undefined, cwd: proj, home }), true);
  assert.equal(B.nodeInsideProject({ execPath: outsideExe, projectDir: proj, cwd: proj, home }), false);
  // A Node under the home folder, with the project folder set to home or above it: skipped.
  const homeExe = path.join(mk(home, 'node'), IS_WIN ? 'node.exe' : 'node');
  fs.writeFileSync(homeExe, '');
  assert.equal(B.nodeInsideProject({ execPath: homeExe, projectDir: home, cwd: home, home }), false);
  assert.equal(B.nodeInsideProject({ execPath: homeExe, projectDir: b, cwd: b, home }), false);
  assert.equal(B.nodeInsideProject({ execPath: homeExe, projectDir: path.parse(b).root, cwd: path.parse(b).root, home }), false);
});
