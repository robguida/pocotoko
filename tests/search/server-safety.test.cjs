'use strict';
// Spawned-server safety checks (spec SR-17, SR-27, SR-32, SR-41, SR-47, hard
// line 6): T-16 (next tool call answered within budget), T-20 (stdout, stderr,
// the data root and the skip report), T-32, T-36 (server part), T-37.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../helpers/server-harness.cjs');
const F = require('../helpers/fake-values.cjs');
const E = require('../../src/search/server/envelope.cjs');
const ST = require('../../src/search/server/store.cjs');
const RK = require('../../src/search/server/rank.cjs');
const S = require('../../src/search/server/server.cjs');

test.after(() => H.cleanup());

const NOTICE = E.NOTICE;
const MiB4 = 4 * 1024 * 1024;

test('T-16 (server part): with max_file_bytes at its maximum, 4 MiB worst-case files are each scanned within the per-file budget and the next tool call is answered within budget', async () => {
  const files = {
    'w/prefix.md': ['gh', 'p_'].join('').repeat(MiB4 / 4),
    'w/base64.txt': (F.ALPHA + '+/').repeat(Math.ceil(MiB4 / 64)).slice(0, MiB4),
    'w/joiners.md': ('ب‌').repeat(MiB4 / 5).slice(0, Math.floor(MiB4 / 5) * 2),
    'w/normal.md': '# Normal\n\nthe gecko note\n',
  };
  const run = H.makeBase('t16', files);
  const kit = H.makeKit(run, { options: { projects: [run.proj], max_file_bytes: MiB4 } });
  const c = H.start({ serverFile: kit.serverFile, env: H.childEnv(run, { CLAUDE_PROJECT_DIR: run.proj }), cwd: run.proj, seams: { gitCeiling: run.base, globalExcludes: null } });
  try {
    await c.initialize();
    // Scan budget 2,000 ms + stat budget 300 ms + query budget 1,000 ms + the 250 ms ordering tail.
    const budget = 2000 + ST.STAT_BUDGET_MS + RK.QUERY_BUDGET_MS + 250;
    let t0 = Date.now();
    await c.call('search', { query: 'gecko' });
    const first = Date.now() - t0;
    t0 = Date.now();
    await c.call('status', {});
    const second = Date.now() - t0;
    assert.ok(first < budget, `first call answered in ${first} ms`);
    assert.ok(second < budget, `next call answered in ${second} ms`);
    const s = await H.waitFresh(c);
    assert.equal(s.counts.skipped_by_rule.scan_timeout, undefined, 'no file ran past the per-file scan budget');
    const p = H.payloadOf(await c.call('search', { query: 'gecko' }), NOTICE);
    assert.equal(p.results[0].file, 'w/normal.md');
  } finally {
    await c.close();
  }
});

function leakFixtures() {
  const token = F.vendorToken(['gh', 'p_'].join(''), 30);
  const conn = F.connString();
  const setting = F.secretSetting();
  const neverTerm = ['zq', 'never', 'term'].join('');
  return {
    token, conn, setting, neverTerm,
    files: {
      'leak/token.md': '# Token\n\nthe emu key ' + token + ' here\n',
      'leak/keyblock.md': '# Key\n\nthe emu key\n\n' + F.keyBlock() + '\n',
      'leak/conn.md': '# Conn\n\nthe emu db ' + conn + '\n',
      'leak/mixed.md': '# Clean part\n\nclean emu text\n\n## Dirty part\n\nthe emu setting ' + setting + '\n',
      'leak/term.md': '# Term\n\nthe emu and ' + neverTerm + ' thing\n\n## Fine\n\nemu fine\n',
      'leak/ok.md': '# Ok\n\nan ordinary emu note\n',
    },
  };
}

test('T-20 / T-32: no caught fake value, no never-term and no query text appears in the data root, stdout, stderr, status or the skip report; status is totals only', async () => {
  const L = leakFixtures();
  const queryOnly = ['qq', 'query', 'only', 'word'].join('');
  const { run, kit, c } = await H.setup('t20', L.files, { options: { never_terms: [L.neverTerm] } });
  let statusText;
  try {
    await H.waitFresh(c);
    for (const q of ['emu ' + L.token, 'emu ' + L.neverTerm, queryOnly + ' emu', L.conn]) {
      const p = H.payloadOf(await c.call('search', { query: q, k: 10 }), NOTICE);
      for (const r of p.results) await c.call('get', { id: r.id });
    }
    await c.call('refresh', {});
    statusText = H.textOf(await c.call('status', {}));
    // A forced RPC-layer error carrying a fake value: stderr gets the error name only.
    const pr = c.nextNullReply();
    c.raw('{"broken": "' + L.token + '"\n');
    await pr;
  } finally {
    await c.close();
  }
  const secrets = [L.token, L.conn, L.setting, L.neverTerm, F.keyBlockHeader()];
  // search-config.json is the user's own options file (copy-by-hand); the kit
  // only reads it, so it is left out of "every file the kit writes".
  const kitFiles = H.listing(kit.dataRoot).filter((f) => f.buf && f.rel !== 'search-config.json');
  assert.ok(kitFiles.length >= 2, 'the index files exist');
  for (const v of [...secrets, queryOnly]) {
    const needle = Buffer.from(v, 'utf8');
    assert.ok(!kitFiles.some((f) => f.buf.includes(needle)), 'data root holds no ' + v.slice(0, 6));
    assert.ok(!c.lines.join('\n').includes(v), 'stdout holds no ' + v.slice(0, 6));
    assert.ok(!c.stderr.includes(v), 'stderr holds no ' + v.slice(0, 6));
  }
  assert.ok(H.holds(kit.dataRoot, 'clean emu text'), 'the clean chunk of the mixed file is kept');
  assert.ok(!H.holds(kit.dataRoot, 'Dirty part'), 'the dropped chunk is gone, heading included');
  for (const line of c.stderr.split('\n').filter(Boolean)) assert.match(line, /^search-server: [A-Za-z_][A-Za-z0-9_]*$/);
  // T-32: totals only.
  for (const bad of ['leak/', '.md', 'Clean part', 'Dirty part', L.neverTerm, 'emu']) assert.ok(!statusText.includes(bad), 'status holds no ' + bad);
  const st = JSON.parse(statusText);
  const skippedTotal = Object.values(st.counts.skipped_by_rule).reduce((a, b) => a + b, 0);
  assert.equal(skippedTotal, 3, 'the three file-level fakes are skipped and counted by rule id');
  // The skip report: paths and rule ids only.
  const sr = H.start({ serverFile: kit.serverFile, env: H.childEnv(run, { CLAUDE_PROJECT_DIR: run.proj }), cwd: run.proj, args: ['--skip-report'], seams: { gitCeiling: run.base, globalExcludes: null } });
  const code = await sr.exited;
  const out = sr.lines.join('\n');
  assert.equal(code, 0);
  for (const v of [...secrets, 'clean emu text', 'the emu']) assert.ok(!out.includes(v), 'skip report holds no ' + v.slice(0, 6));
  assert.ok(out.includes('"leak/token.md"'), 'the skipped file is named');
});

test('T-27 (B7 review): a never-term in a file name, a folder name and a hidden file name appears in no output: status, search, get, stdout, stderr, the skip report or the data root', async () => {
  const term = ['zq', 'plum', 'term'].join('');
  const files = {
    ['notes/a ' + term + ' b.md']: '# A\n\nthe wren note in a named file\n',
    ['notes/Upper' + term.toUpperCase() + '.md']: '# U\n\nthe wren note, upper case name\n',
    [term + '-dir/x.md']: '# X\n\nthe wren note in a named folder\n',
    ['.' + term + '.md']: '# H\n\nthe wren hidden note\n',
    'notes/ok.md': '# Ok\n\nthe wren note that stays\n',
  };
  const { run, kit, c } = await H.setup('t27-names', files, { options: { never_terms: [term] } });
  let statusText;
  try {
    await H.waitFresh(c);
    const p = H.payloadOf(await c.call('search', { query: 'wren note', k: 10 }), NOTICE);
    assert.deepEqual(p.results.map((r) => r.file), ['notes/ok.md'], 'only the file with no term in its path is indexed');
    for (const r of p.results) await c.call('get', { id: r.id });
    await c.call('search', { query: term + ' wren' });
    await c.call('refresh', {});
    statusText = H.textOf(await c.call('status', {}));
  } finally {
    await c.close();
  }
  const lower = (s) => s.toLowerCase();
  assert.ok(!lower(statusText).includes(term), 'status holds no term');
  // The query above holds the term; stdout must not echo it in any reply.
  assert.ok(!lower(c.lines.join('\n')).includes(term), 'stdout holds no term');
  assert.ok(!lower(c.stderr).includes(term), 'stderr holds no term');
  const kitFiles = H.listing(kit.dataRoot).filter((f) => f.buf && f.rel !== 'search-config.json');
  assert.ok(kitFiles.length >= 2);
  for (const f of kitFiles) assert.ok(!lower(f.buf.toString('latin1')).includes(term), 'no term in ' + f.rel.split('/').pop());
  // The skip report: rows only for paths with no term; one count line per rule for the rest.
  const sr = H.start({ serverFile: kit.serverFile, env: H.childEnv(run, { CLAUDE_PROJECT_DIR: run.proj }), cwd: run.proj, args: ['--skip-report'], seams: { gitCeiling: run.base, globalExcludes: null } });
  const code = await sr.exited;
  assert.equal(code, 0);
  const out = sr.lines.join('\n');
  assert.ok(!lower(out).includes(term), 'the skip report holds no term: ' + out);
  assert.ok(sr.lines.includes(['masked', 'never_term', '3'].join('\t')), 'two files and one folder skipped as never_term are counted, not listed');
  assert.ok(sr.lines.includes(['masked', 'hidden', '1'].join('\t')), 'a hidden file whose name holds the term is counted, not listed');
  assert.match(sr.lines[sr.lines.length - 1], /^skip report: skipped 4, failed 0, indexable 1$/);
});

test('T-27 (B7 review): a bound folder whose path holds a never-term is shown in status as a fixed mask, never as the path', async () => {
  const term = ['zq', 'fig', 'term'].join('');
  const run = H.makeBase('t27-root', {});
  const root = path.join(run.base, 'work-' + term.toUpperCase());
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'n.md'), '# N\n\nthe vole note\n');
  const kit = H.makeKit(run, { options: { projects: [root], never_terms: [term] } });
  const c = H.start({ serverFile: kit.serverFile, env: H.childEnv(run, { CLAUDE_PROJECT_DIR: root }), cwd: root, seams: { gitCeiling: run.base, globalExcludes: null } });
  try {
    await c.initialize();
    const s = await H.waitFresh(c);
    assert.equal(s.state, 'fresh');
    assert.equal(s.bound_folder, S.LINES.FOLDER_MASKED);
    assert.ok(!H.textOf(await c.call('status', {})).toLowerCase().includes(term));
    const p = H.payloadOf(await c.call('search', { query: 'vole' }), NOTICE);
    assert.deepEqual(p.results.map((r) => r.file), ['n.md'], 'the project is still indexed: the term rule judges relative paths');
  } finally {
    await c.close();
  }
  assert.ok(!c.lines.join('\n').toLowerCase().includes(term), 'stdout holds no term');
  // A bound folder with no term is shown as its path, as before.
  const { run: run2, c: c2 } = await H.setup('t27-root-plain', { 'n.md': '# N\n\nthe vole note\n' }, { options: { never_terms: [term] } });
  try {
    assert.equal((await H.waitFresh(c2)).bound_folder, run2.proj);
  } finally {
    await c2.close();
  }
});

test('T-36 (server part): a full session of the four tools, with a refresh after edits, writes only under the data root; the project is byte-identical, in copy-by-hand and in plugin mode', async () => {
  for (const mode of ['copy', 'plugin']) {
    const files = { 'n/a.md': '# A\n\nthe heron note\n', 'n/b.txt': 'the heron text\n' };
    const { run, kit, c } = await H.setup('t36-' + mode, files, { mode });
    try {
      await H.waitFresh(c);
      fs.writeFileSync(path.join(run.proj, 'n', 'a.md'), '# A\n\nthe heron note, edited\n');
      fs.writeFileSync(path.join(run.proj, 'n', 'c.md'), '# C\n\nanother heron\n');
      const dataRel = path.relative(run.base, kit.dataRoot).split(path.sep).join('/');
      const outside = () => JSON.stringify(H.listing(run.base).filter((f) => !f.rel.startsWith(dataRel + '/') && f.rel !== dataRel + '/')
        .map((f) => [f.rel, f.buf ? f.buf.toString('base64') : 'x']));
      const before = outside();
      await c.call('refresh', {});
      const p = H.payloadOf(await c.call('search', { query: 'heron' }), NOTICE);
      for (const r of p.results) await c.call('get', { id: r.id });
      await c.call('status', {});
      await c.call('refresh', {});
      await H.waitFresh(c);
      assert.equal(outside(), before, mode + ': nothing outside the data root changed');
    } finally {
      await c.close();
    }
  }
});

function permissionFlag() {
  const f = process.allowedNodeEnvironmentFlags;
  if (f.has('--permission')) return '--permission';
  if (f.has('--experimental-permission')) return '--experimental-permission';
  return null;
}

// The file calls the store needs that a permission model may disable:
// fsync before each rename (SR-24) and futimes on the lock (SR-49 a).
const PROBE_CALLS = Object.freeze(['fsyncSync', 'futimesSync']);
const DENIED = 'ERR_ACCESS_DENIED';

/** Run the probe under the permission model, with writes allowed in `dir` only. */
function runPermissionProbe(dir) {
  // Each call is tried on its own and reported by name, so an open failure is
  // never mistaken for a refused fsync or futimes.
  const probe = [
    "const fs=require('node:fs');const p=require('node:path').join(process.argv[1],'probe.txt');",
    'const out={};let fd=null;const code=(e)=>String((e&&(e.code||e.name))||"error");',
    "try{fd=fs.openSync(p,'w');out.open='ok';}catch(e){out.open=code(e);}",
    "if(fd!==null){try{fs.fsyncSync(fd);out.fsyncSync='ok';}catch(e){out.fsyncSync=code(e);}",
    "try{fs.futimesSync(fd,1,1);out.futimesSync='ok';}catch(e){out.futimesSync=code(e);}",
    'try{fs.closeSync(fd);}catch(_){}}',
    'process.stdout.write(JSON.stringify(out));',
  ].join('');
  const { spawnSync } = require('node:child_process');
  return spawnSync(process.execPath, [permissionFlag(), '--allow-fs-read=*', '--allow-fs-write=' + dir, '-e', probe, dir], { encoding: 'utf8', windowsHide: true });
}

/**
 * What T-37 does with a probe result: { verdict: 'run' | 'skip' | 'fail', why }.
 * SKIP only when the open succeeded and fsyncSync or futimesSync (or both)
 * threw ERR_ACCESS_DENIED, which SR-24 and SR-49 a forbid weakening around;
 * the reason names each refused call. Any other result (no output, a bad
 * flag, a failed open, another error code) is a FAIL, never a skip.
 */
function classifyPermissionProbe(r) {
  if (!r || r.error) return { verdict: 'fail', why: 'the probe could not be started' };
  let out = null;
  try { out = JSON.parse(String(r.stdout || '').trim()); } catch (_) { out = null; }
  if (!out || typeof out !== 'object' || Array.isArray(out)) {
    return { verdict: 'fail', why: `the probe printed no result (exit ${r.status}); check the permission flags for this Node line` };
  }
  if (r.status !== 0) return { verdict: 'fail', why: `the probe exited ${r.status}` };
  if (out.open !== 'ok') return { verdict: 'fail', why: 'openSync failed under the permission model: ' + out.open };
  const denied = PROBE_CALLS.filter((c) => out[c] === DENIED);
  const other = PROBE_CALLS.filter((c) => out[c] !== 'ok' && out[c] !== DENIED);
  if (other.length) return { verdict: 'fail', why: other.map((c) => c + ' failed: ' + out[c]).join('; ') };
  if (denied.length) {
    return {
      verdict: 'skip',
      why: `SKIPPED: this Node line's permission model refuses ${denied.join(' and ')} (${DENIED}), which SR-24 and SR-49 a require; T-37 waits for a Node line that allows them`,
    };
  }
  return { verdict: 'run', why: '' };
}

test('T-37 probe (B7 review): skip only when the open worked and fsyncSync or futimesSync was refused; name the refused call; fail on anything else', () => {
  const res = (out, status = 0) => ({ status, stdout: out === null ? '' : JSON.stringify(out) });
  const ok = { open: 'ok', fsyncSync: 'ok', futimesSync: 'ok' };
  assert.equal(classifyPermissionProbe(res(ok)).verdict, 'run');
  const fsyncOnly = classifyPermissionProbe(res({ ...ok, fsyncSync: DENIED }));
  assert.equal(fsyncOnly.verdict, 'skip');
  assert.match(fsyncOnly.why, /refuses fsyncSync \(/);
  const futimesOnly = classifyPermissionProbe(res({ ...ok, futimesSync: DENIED }));
  assert.equal(futimesOnly.verdict, 'skip');
  assert.match(futimesOnly.why, /refuses futimesSync \(/);
  assert.match(classifyPermissionProbe(res({ ...ok, fsyncSync: DENIED, futimesSync: DENIED })).why, /refuses fsyncSync and futimesSync/);
  // Every other result is a failure, never a skip.
  for (const [what, r] of [
    ['open refused', res({ open: DENIED })],
    ['open failed', res({ open: 'EACCES' })],
    ['no output (a bad flag)', res(null, 9)],
    ['not JSON', { status: 0, stdout: 'ok' }],
    ['fsync failed otherwise', res({ ...ok, fsyncSync: 'EIO' })],
    ['futimes failed otherwise, fsync refused', res({ ...ok, fsyncSync: DENIED, futimesSync: 'EPERM' })],
    ['a non-zero exit', res(ok, 1)],
    ['spawn error', { error: new Error('x') }],
  ]) assert.equal(classifyPermissionProbe(r).verdict, 'fail', what);
});

test('T-37 (SHOULD): the server runs under Node\'s permission model with file writes allowed only under the data root and no child processes or workers; a full run ends with no access-denied error', { skip: permissionFlag() ? false : 'this Node line has no permission model flag' }, async (t) => {
  const run = H.makeBase('t37', { 'p/a.md': '# A\n\nthe ibis note\n' });
  const kit = H.makeKit(run, { options: { projects: [run.proj] } });
  fs.mkdirSync(kit.dataRoot, { recursive: true });
  const probe = classifyPermissionProbe(runPermissionProbe(run.tmp));
  if (probe.verdict === 'fail') assert.fail('T-37 probe: ' + probe.why);
  if (probe.verdict === 'skip') {
    t.skip(probe.why);
    return;
  }
  const nodeArgs = [permissionFlag(), '--allow-fs-read=*', '--allow-fs-write=' + kit.dataRoot];
  const c = H.start({ serverFile: kit.serverFile, env: H.childEnv(run, { CLAUDE_PROJECT_DIR: run.proj }), cwd: run.proj, nodeArgs, seams: { gitCeiling: run.base, globalExcludes: null } });
  try {
    await c.initialize();
    const s = await H.waitFresh(c);
    assert.equal(s.state, 'fresh', JSON.stringify(s.reason));
    const p = H.payloadOf(await c.call('search', { query: 'ibis' }), NOTICE);
    assert.equal(p.results.length, 1);
    assert.ok(H.textOf(await c.call('get', { id: p.results[0].id })).includes('ibis note'));
    await c.call('refresh', {});
  } finally {
    await c.close();
  }
  assert.ok(!/ERR_ACCESS_DENIED|AccessDenied/i.test(c.stderr), 'no access-denied error: ' + c.stderr.slice(0, 200));
  assert.ok(fs.existsSync(path.join(kit.dataRoot, 'indexes')), 'the index was written under the data root');
});
