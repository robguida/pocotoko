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

test('SR-4 f: a UNC value (root, start folder or projects entry) is refused before any file-system call', () => {
  const BS = String.fromCharCode(92);
  const W = (...parts) => parts.join(BS);
  const unc = BS + BS + W('srv', 'share', 'a');
  const unc2 = BS + BS + W('srv', 'share', 'b');
  const longUnc = BS + BS + W('?', 'UNC', 'srv', 'share', 'c');
  const devUnc = BS + BS + W('.', 'UNC', 'srv', 'share', 'd');
  const fwdUnc = '//srv/share/e';
  const root = W('C:', 'proj');
  // The text test alone: network forms vs the local long-path and device forms of a drive.
  for (const p of [unc, longUnc, devUnc, fwdUnc, BS + BS + W('?', 'Volume{00000000-0000-0000-0000-000000000000}', 'x'), BS + BS + '?' + BS + 'C:', '  ' + unc]) {
    assert.equal(B.isNetworkText(p, 'win32'), true, 'network (or fail closed): ' + p);
  }
  for (const p of [BS + BS + W('?', 'C:', 'proj'), BS + BS + W('.', 'C:', 'proj'), BS + BS + W('?', 'd:', ''), '//?/C:/proj', '//./C:/proj', root, '/w/a']) {
    assert.equal(B.isNetworkText(p, 'win32'), false, 'local: ' + p);
  }
  assert.equal(B.isNetworkText(unc, 'linux'), false, 'text rule is Windows only');
  // Spy: every file-system call the binder could make on a path records it and throws.
  const calls = [];
  const spied = [];
  const spy = (obj, name) => {
    if (typeof obj[name] !== 'function') return;
    const orig = obj[name];
    spied.push([obj, name, orig]);
    obj[name] = (...a) => { calls.push(name + ' ' + String(a[0])); throw new Error('file-system call in a network test'); };
  };
  const nativeOrig = fs.realpathSync.native;
  for (const n of ['realpathSync', 'statSync', 'lstatSync', 'statfsSync', 'existsSync', 'readdirSync', 'openSync']) spy(fs, n);
  fs.realpathSync.native = (...a) => { calls.push('realpathSync.native ' + String(a[0])); throw new Error('file-system call in a network test'); };
  const results = [];
  try {
    for (const raw of [[unc], [longUnc], [devUnc], [fwdUnc], JSON.stringify([unc, unc2]), unc, unc + '\n' + unc2]) {
      const r = B.projectSwitch(root, raw, { platform: 'win32' });
      results.push(['entries', raw, r]);
    }
    // A comma value whose pieces and whole text are all network paths: both readings count as
    // present without a lookup, so the whole option is refused.
    results.push(['comma', null, B.projectSwitch(root, unc + ',' + unc2, { platform: 'win32' })]);
    results.push(['root', null, B.resolveRoot({ env: { CLAUDE_PROJECT_DIR: unc }, cwd: root, platform: 'win32' })]);
    results.push(['root', null, B.resolveRoot({ env: { CLAUDE_PROJECT_DIR: longUnc }, cwd: root, platform: 'win32' })]);
    results.push(['root', null, B.resolveRoot({ env: { CLAUDE_PROJECT_DIR: devUnc }, cwd: root, platform: 'win32' })]);
    results.push(['root', null, B.resolveRoot({ env: {}, cwd: unc, platform: 'win32' })]);
    results.push(['root', null, B.resolveRoot({ env: {}, cwd: fwdUnc, platform: 'win32' })]);
  } finally {
    for (const [obj, name, orig] of spied) obj[name] = orig;
    fs.realpathSync.native = nativeOrig;
  }
  assert.deepEqual(calls, [], 'no file-system call was made');
  for (const [kind, raw, r] of results) {
    if (kind === 'entries') {
      const n = Array.isArray(raw) ? raw.length : (String(raw).trim().startsWith('[') ? JSON.parse(raw).length : String(raw).split('\n').length);
      assert.deepEqual(r, { enabled: false, bad: 0, refusedEntries: n, listRefused: false }, JSON.stringify(raw));
    } else if (kind === 'comma') {
      assert.deepEqual([r.listRefused, r.enabled], [true, false]);
    } else {
      assert.deepEqual(r, { refused: B.REASONS.NETWORK });
    }
  }
  // The comma reading never asks its lookup about a network piece; the local piece decides.
  const asked = [];
  const seam = (p) => { asked.push(p); return p === root ? p : null; };
  assert.deepEqual(B.commaReading(root + ',' + unc, 'win32', seam), { entries: [root, unc] });
  assert.ok(!asked.some((p) => B.isNetworkText(p, 'win32')), 'no network piece looked up');
});

test('SR-4 f (Windows, real folders): a projects entry and CLAUDE_PROJECT_DIR in the local long-path form \\\\?\\<drive>:\\ or the device form \\\\.\\<drive>:\\ are resolved normally and bind', { skip: !IS_WIN && 'Windows only: these path forms exist only there; the text rule is covered on every OS above' }, () => {
  const b = base('longpath');
  const proj = mk(b, 'proj');
  const real = fs.realpathSync.native(proj);
  const BS = String.fromCharCode(92);
  for (const prefix of [BS + BS + '?' + BS, BS + BS + '.' + BS]) {
    const r = B.projectSwitch(real, [prefix + real], { platform: 'win32' });
    assert.deepEqual([r.enabled, r.refusedEntries, r.bad], [true, 0, 0], prefix);
    const root = B.resolveRoot({ env: { CLAUDE_PROJECT_DIR: prefix + real }, cwd: b, platform: 'win32' });
    assert.equal(root.source, 'project_dir', prefix);
    assert.equal(String(root.rootReal).toLowerCase(), real.toLowerCase(), prefix + ': bound to the plain real path');
  }
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

test('live check 6 (unit): given a subfolder of a git project as CLAUDE_PROJECT_DIR or as the start folder, resolveRoot binds that subfolder and never walks up to the git top (the server\'s own view is not observed here)', () => {
  const b = base('subfolder');
  const top = mk(b, 'repo');
  mk(top, '.git');
  const start = mk(top, 'sub', 'deeper');
  // Live (2.1.329): CLAUDE_PROJECT_DIR holds the start folder; the start folder is the fallback.
  assert.deepEqual(B.resolveRoot({ env: { CLAUDE_PROJECT_DIR: start }, cwd: start }), { rootReal: start, source: 'project_dir' });
  assert.deepEqual(B.resolveRoot({ env: {}, cwd: start }), { rootReal: start, source: 'start_folder' });
  // Listing the git top does not enable the subfolder session (exact match, 9.1 c).
  assert.equal(B.projectSwitch(start, JSON.stringify([top])).enabled, false);
  assert.equal(B.projectSwitch(start, JSON.stringify([top, start])).enabled, true);
});

test('9.1 e list arrival: an array, a JSON-array text, and the same paths joined by new lines or by commas give the same entries', () => {
  const b = base('lists');
  const p = [mk(b, 'one'), mk(b, 'two'), mk(b, 'three')];
  // Joined by commas: every piece is an existing folder and the whole text is not one, so it is the list.
  for (const raw of [p, JSON.stringify(p), p.join('\n'), p.join('\r\n'), p.join(','), p.join(', ')]) {
    for (const root of p) assert.equal(B.projectSwitch(root, raw).enabled, true, JSON.stringify(raw).slice(0, 40));
    assert.equal(B.projectSwitch(mk(b, 'four'), raw).enabled, false);
    assert.equal(B.projectSwitch(p[0], raw).listRefused, false);
  }
});

test('9.1 e (real folders): two existing folders as a comma list -> both bound', () => {
  const b = base('two');
  const one = mk(b, 'one');
  const two = mk(b, 'two');
  for (const root of [one, two]) {
    const r = B.projectSwitch(root, one + ',' + two);
    assert.deepEqual([r.listRefused, r.enabled, r.bad], [false, true, 0]);
  }
});

test('9.1 e (real folders): a folder whose name holds a comma, given alone -> bound as one path', () => {
  const b = base('comma');
  const withComma = mk(b, 'a,b');
  for (const raw of [withComma, ' ' + withComma + ' ', JSON.stringify([withComma]), [withComma]]) {
    const r = B.projectSwitch(withComma, raw);
    assert.deepEqual([r.listRefused, r.enabled, r.bad], [false, true, 0], JSON.stringify(raw));
  }
  // The split reading (`<b>/a` and `b`) does not exist, so nothing else is bound.
  assert.deepEqual(B.commaReading(withComma, process.platform), { entries: [withComma] });
});

test('9.1 e (real folders): neither reading existing -> the whole option refused, no path text in the reason', () => {
  const b = base('neither');
  const one = mk(b, 'one');
  const cases = [
    path.join(b, 'gone') + ',' + path.join(b, 'away'),
    path.join(b, 'with,missing'),
    one + ',' + path.join(b, 'missing'), // one piece exists, the other does not, and the whole is no folder
    one + ',relative',
  ];
  for (const raw of cases) {
    const r = B.projectSwitch(one, raw);
    assert.deepEqual([r.listRefused, r.enabled], [true, false], raw);
  }
  // One fixed reason for every refusal: it names both causes (a missing or relative listed
  // folder, and a comma that may be part of a path) and holds no path text.
  const reason = B.REASONS.LIST_UNSAFE;
  assert.ok(!reason.includes(path.sep) && !reason.includes('/') && !reason.includes(path.win32.sep));
  assert.match(reason, /missing/);
  assert.match(reason, /comma/);
});

// A = <s>/w/a and Bp = <s>/b; the raw text A + ',' + Bp is also, as one path, the folder
// <Bp without its root> inside `<s>/w/a,`. Only POSIX can create that folder (a Windows
// name cannot hold the drive colon), so Windows runs the list and neither setups and skips
// the one-path and both setups, which the seam test below covers on every OS.
function wabSetup(b, name, { list, one }) {
  const s = mk(b, name);
  const A = path.join(s, 'w', 'a');
  const Bp = path.join(s, 'b');
  const raw = A + ',' + Bp;
  if (list) { mk(A); mk(Bp); }
  if (one) fs.mkdirSync(raw, { recursive: true });
  return { A, Bp, raw };
}

test('9.1 e (real folders): the `/w/a,/b` shape, list only and neither', () => {
  const b = base('wab');
  const l = wabSetup(b, 'list', { list: true });
  assert.equal(B.projectSwitch(fs.realpathSync.native(l.A), l.raw).enabled, true);
  assert.equal(B.projectSwitch(fs.realpathSync.native(l.Bp), l.raw).enabled, true);
  const n = wabSetup(b, 'neither', {});
  assert.equal(B.projectSwitch(mk(b, 'root'), n.raw).listRefused, true);
});

test('9.1 e (real folders): the `/w/a,/b` shape, one path only and both', {
  skip: IS_WIN ? 'a Windows folder name cannot hold the drive colon; the seam test covers these setups' : false,
}, () => {
  const b = base('wab1');
  const o = wabSetup(b, 'one', { one: true });
  const oneReal = fs.realpathSync.native(o.raw);
  const ro = B.projectSwitch(oneReal, o.raw);
  assert.deepEqual([ro.listRefused, ro.enabled], [false, true]);
  const both = wabSetup(b, 'both', { list: true, one: true });
  for (const root of [both.A, both.Bp, both.raw]) {
    const r = B.projectSwitch(fs.realpathSync.native(root), both.raw);
    assert.deepEqual([r.listRefused, r.enabled], [true, false]);
  }
});

test('9.1 e (seam): `/w/a,/b` and Windows-style comma values are read by what exists, POSIX and Windows alike', () => {
  const BS = String.fromCharCode(92);
  const W = (...parts) => parts.join(BS);
  const fakeFs = (folders) => (p) => (folders.includes(p) ? p : null);
  const REFUSED = { refused: true };
  for (const platform of ['linux', 'darwin']) {
    const raw = '/w/a,/b';
    assert.deepEqual(B.commaReading(raw, platform, fakeFs(['/w/a', '/b'])), { entries: ['/w/a', '/b'] }, 'list only');
    assert.deepEqual(B.commaReading(raw, platform, fakeFs(['/w/a,/b'])), { entries: ['/w/a,/b'] }, 'one path only');
    assert.deepEqual(B.commaReading(raw, platform, fakeFs(['/w/a', '/b', '/w/a,/b'])), REFUSED, 'both');
    assert.deepEqual(B.commaReading(raw, platform, fakeFs([])), REFUSED, 'neither');
    assert.deepEqual(B.commaReading(raw, platform, fakeFs(['/w/a'])), REFUSED, 'list partly');
    assert.deepEqual(B.commaReading(' /w/a, /b ', platform, fakeFs(['/w/a', '/b'])), { entries: ['/w/a', '/b'] }, 'spaces trimmed');
    assert.deepEqual(B.commaReading('w/a,/b', platform, fakeFs(['/b', 'w/a', 'w/a,/b'])), REFUSED, 'relative: neither reading is absolute');
  }
  // Windows: a drive-letter list, a UNC piece, and a folder name holding a comma.
  const drives = W('C:', 'w', 'a') + ',' + W('D:', 'b');
  const unc = W('C:', 'w', 'a') + ',' + BS + BS + W('srv', 'b');
  const named = W('C:', 'w', 'a,b');
  assert.deepEqual(B.commaReading(drives, 'win32', fakeFs([W('C:', 'w', 'a'), W('D:', 'b')])), { entries: [W('C:', 'w', 'a'), W('D:', 'b')] });
  assert.deepEqual(B.commaReading(drives, 'win32', fakeFs([W('C:', 'w', 'a')])), REFUSED);
  assert.deepEqual(B.commaReading(unc, 'win32', fakeFs([W('C:', 'w', 'a'), BS + BS + W('srv', 'b')])), { entries: [W('C:', 'w', 'a'), BS + BS + W('srv', 'b')] });
  assert.deepEqual(B.commaReading(unc, 'win32', fakeFs([unc])), { entries: [unc] });
  assert.deepEqual(B.commaReading(unc, 'win32', fakeFs([unc, W('C:', 'w', 'a'), BS + BS + W('srv', 'b')])), REFUSED);
  assert.deepEqual(B.commaReading(named, 'win32', fakeFs([named])), { entries: [named] });
  assert.deepEqual(B.commaReading(named, 'win32', fakeFs([])), REFUSED);
  // A UNC entry chosen by the list reading still meets the refused-location rule later (SR-4 f).
  assert.equal(B.refusedRoot(BS + BS + W('srv', 'b'), { platform: 'win32' }), B.REASONS.NETWORK);
  // A seam that throws counts as "does not exist"; the other piece is still looked at.
  assert.deepEqual(B.commaReading('/w/a,/b', 'linux', (p) => { if (p === '/w/a') throw new Error('x'); return p === '/b' ? p : null; }), REFUSED);
});

test('9.1 e: a value with no comma, an array and a JSON-array text are not read by the comma rule', () => {
  const b = base('nocomma');
  const one = mk(b, 'one');
  // New lines only: refused whole when a piece is not absolute, as before.
  assert.equal(B.projectSwitch(one, one + '\nrelative').listRefused, true);
  assert.equal(B.projectSwitch(one, one + '\n' + path.join(b, 'missing')).enabled, true, 'a missing piece is counted, not refused');
  // An array or a JSON-array text: one entry per element, a missing element counted as bad.
  const r = B.projectSwitch(one, JSON.stringify([one, path.join(b, 'x,missing')]));
  assert.deepEqual([r.listRefused, r.enabled, r.bad], [false, true, 1]);
  assert.equal(B.projectSwitch(one, [one, 'relative,x']).listRefused, false);
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
  assert.equal(m.sourceFolder, false, 'a copy-by-hand kit folder holds no plugin manifest');
  // 6.7 source-folder rule: a plugin folder run from outside the cache (a local-folder install).
  const srcServer = path.join(mk(b, 'clone', 'src', 'search', 'server'), 'server.cjs');
  fs.writeFileSync(srcServer, '');
  fs.writeFileSync(path.join(mk(b, 'clone', 'src', 'search', '.claude-plugin'), 'plugin.json'), '{}');
  m = B.installMode({ env: { CLAUDE_CONFIG_DIR: cfg, CLAUDE_PLUGIN_DATA: data }, serverFile: srcServer, home });
  assert.equal(m.mode, 'copy');
  assert.equal(m.sourceFolder, true);

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
