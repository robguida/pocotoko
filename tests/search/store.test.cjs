'use strict';
// store.cjs (spec 7.4, 9.6, 9.7, 9.11, 9.12, SR-14, SR-16, SR-19 to SR-25, SR-49):
// T-6 (data-root part), T-7, T-8 (store parts), T-13 (store part), T-18, T-20 (store part),
// T-29 (chunk and text limits), T-30, loud rebuild, corrupt index, stat pass, lock, OFF file.
// Every secret-shaped value and dated mark is built at run time (13.1 e).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const St = require('../../src/search/server/store.cjs');
const S = require('../../src/search/server/scan.cjs');
const Fl = require('../../src/search/server/floor.cjs');
const X = require('../../src/search/server/fsx.cjs');
const T = require('../../src/search/server/tokenize.cjs');
const F = require('../helpers/fake-values.cjs');
const { makeRun, openStore, listFiles, dataHolds, cleanupRuns } = require('../helpers/search-run.cjs');

const IS_WIN = process.platform === 'win32';
test.after(() => cleanupRuns());

let stamp = 1700000000;
/** Give a file a new, distinct modified time (content edits can land within one clock tick). */
function touch(p) {
  stamp += 100;
  fs.utimesSync(p, stamp, stamp);
}

function write(run, rel, text) {
  const p = path.join(run.proj, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  touch(p);
  return p;
}

function uniq(tag) {
  return 'zq' + tag + crypto.randomBytes(4).toString('hex') + 'sentence';
}

function sumRun(r) {
  return r.succeeded + r.failed + Object.values(r.skipped).reduce((a, b) => a + b, 0);
}

function projectListing(dir) {
  return listFiles(dir).map((f) => f.rel + ':' + crypto.createHash('sha256').update(f.buf).digest('hex')).sort();
}

// ---------------------------------------------------------------------------
// Layout, manifest, swap point

test('manifest and chunks.jsonl hold what 9.6 says; the index at start equals one built from chunks.jsonl', async () => {
  const run = makeRun('manifest', { 'docs/deploy.md': '# Deploy\nhow to deploy\n\n## Rollback\nrun rollback\n', 'notes.txt': 'plain notes about deploy\n' });
  const before = projectListing(run.proj);
  const store = openStore(run);
  assert.equal(store.state(), 'building');
  const r = await store.refresh();
  assert.equal(r.succeeded, 2);
  assert.equal(store.state(), 'fresh');
  assert.deepEqual(fs.readdirSync(store.indexDir).sort(), ['chunks.jsonl', 'manifest.json']);
  const man = JSON.parse(fs.readFileSync(path.join(store.indexDir, 'manifest.json'), 'utf8'));
  assert.equal(man.schema_version, St.SCHEMA_VERSION);
  assert.equal(man.tokenizer_version, T.TOK_VERSION);
  assert.equal(man.rules_version, Fl.RULES_VERSION);
  assert.match(man.options_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(man.files).sort(), ['docs/deploy.md', 'notes.txt']);
  for (const f of Object.values(man.files)) {
    assert.equal(typeof f.size, 'number');
    assert.match(f.mtimeNs, /^[0-9]+$/);
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
  }
  const lines = fs.readFileSync(path.join(store.indexDir, 'chunks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  for (const rec of lines) {
    assert.deepEqual(Object.keys(rec).sort(), ['date', 'flag', 'heading', 'key', 'line', 'path', 'successor', 'text', 'trail']);
  }
  // A second store over the same data root loads the same index.
  const again = openStore(run);
  const a = store.rank('rollback deploy', { k: 10 }).results.map((x) => [x.key, x.score]);
  const b = again.rank('rollback deploy', { k: 10 }).results.map((x) => [x.key, x.score]);
  assert.deepEqual(b, a);
  // The swap-point interface (7.4).
  for (const fn of ['load', 'upsert', 'purge', 'rank']) assert.equal(typeof store[fn], 'function', fn);
  // The project is never written (SR-27).
  assert.deepEqual(projectListing(run.proj), before);
});

test('T-13 (store part): index folder name is 16 hex of the root real path; no project name in any name under the data root', async () => {
  const run = makeRun('t13names', { 'a.md': 'deploy notes' });
  const store = openStore(run);
  await store.refresh();
  const want = crypto.createHash('sha256').update(run.proj, 'utf8').digest('hex').slice(0, 16);
  assert.equal(path.basename(store.indexDir), want);
  assert.equal(St.indexFolderName(run.proj), want);
  const names = listFiles(run.data).map((f) => f.rel).join('\n');
  assert.ok(!names.includes('proj'));
  assert.ok(!names.includes(run.proj));
});

test('T-13 (store part): a data root inside the project (not git) or inside a git work tree → off, nothing written', async () => {
  const run = makeRun('t13proj', { 'a.md': 'deploy notes' });
  const before = projectListing(run.proj);
  const inside = openStore(run, { dataRoot: path.join(run.proj, 'cfg', 'data') });
  assert.equal(inside.state(), 'off');
  assert.equal(inside.status().reason, 'in_project');
  await inside.refresh();
  assert.deepEqual(projectListing(run.proj), before);
  assert.ok(!fs.existsSync(path.join(run.proj, 'cfg')));

  for (const kind of ['file', 'folder']) {
    const r2 = makeRun('t13git' + kind, { 'a.md': 'deploy notes' });
    const repo = path.join(r2.base, 'home-repo');
    fs.mkdirSync(repo);
    if (kind === 'file') fs.writeFileSync(path.join(repo, '.git'), 'gitdir: elsewhere\n');
    else fs.mkdirSync(path.join(repo, '.git'));
    const s2 = openStore(r2, { dataRoot: path.join(repo, 'cfg', 'data') });
    assert.equal(s2.state(), 'off');
    assert.equal(s2.status().reason, 'in_git');
    assert.ok(!fs.existsSync(path.join(repo, 'cfg')));
    const res = await s2.search('deploy');
    assert.equal(res.state, 'off');
  }
  // The two fixed lines, word for word (shown by the server, B7).
  assert.equal(St.IN_GIT_LINE, 'Search is off: your Claude config folder is inside a git repo, so search stores nothing there. Move the config folder out of the repo to turn it on.');
  assert.equal(St.IN_PROJECT_LINE, 'Search is off: your Claude config folder is inside this project, so search stores nothing there. Move the config folder out of the project to turn it on.');
});

// ---------------------------------------------------------------------------
// T-6 (data-root part), T-7, T-20

function secretFixtures() {
  return {
    'key.md': '# K\nclean intro\n\n## Key\n' + F.keyBlock() + '\n',
    'vendor.md': '# V\n' + F.vendorToken('gl' + 'pat-', 24, 'A-Za-z0-9') + '\n',
    'jwt.md': '# J\n' + F.fakeJwt() + '\n',
    'conn.md': '# C\n' + F.connString() + '\n',
    'signed.md': '# S\n' + F.signedUrl() + '\n',
    'hook.md': '# W\n' + F.webhookUrl() + '\n',
    'hidden.md': '# H\nnormal​​text\n',
    'setting.md': '# Clean part\nkeep this deploy text\n\n## Settings\n' + F.secretSetting() + '\n',
    'auth.md': '# A\nkeep deploy\n\n## Header\n' + F.authHeader() + '\n',
    'contact.md': '# Team\nkeep deploy\n\n## Who\nmail ' + F.fakeEmail() + '\n',
  };
}

test('T-6, T-20 (store part): no caught fake value is anywhere under the data root; stored chunks re-scan clean', async () => {
  const run = makeRun('t6data', secretFixtures());
  const store = openStore(run);
  const r = await store.refresh();
  const fakes = [F.keyBlockHeader(), F.vendorToken('gl' + 'pat-', 24, 'A-Za-z0-9'), F.fakeJwt(), F.connString(), F.signedUrl(),
    F.webhookUrl(), F.secretSetting(), F.authHeader(), F.fakeEmail()];
  for (const v of fakes) assert.equal(dataHolds(run.data, v), false, v.slice(0, 8));
  // Files dropped by a file-level hit leave no path, size, hash or text.
  const man = JSON.parse(fs.readFileSync(path.join(store.indexDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(man.files).sort(), ['auth.md', 'contact.md', 'setting.md']);
  assert.ok(!dataHolds(run.data, 'key.md') && !dataHolds(run.data, 'vendor.md'));
  // A fake caught in one chunk is absent from the clean chunks of the same file.
  assert.ok(dataHolds(run.data, 'keep this deploy text'));
  // Re-running the scan over every stored chunk finds no hit (SR-15).
  const stored = fs.readFileSync(path.join(store.indexDir, 'chunks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const c of stored) {
    assert.equal(S.fileLevelRule(c.text, () => false), null);
    assert.equal(S.chunkLevelRule(c.text), null);
    assert.equal(S.contactHit(c.text), false);
  }
  assert.ok(r.skipped.scan_key_block === 1 && r.skipped.scan_vendor_token === 1);
  // Queries holding fake values are never written.
  await store.search(F.secretSetting() + ' deploy');
  assert.equal(dataHolds(run.data, F.secretSetting()), false);
});

test('T-7: a file-level fake in the last chunk → no chunk of that file anywhere', async () => {
  const first = uniq('first');
  const run = makeRun('t7last', { 'a.md': `# One\n${first}\n\n## Two\nmore\n\n## Three\n${F.connString()}\n` });
  const store = openStore(run);
  await store.refresh();
  assert.equal(dataHolds(run.data, first), false);
});

test('T-7: a file indexed clean, then given a file-level fake or two chunk-level hits, loses every old chunk in one refresh', async () => {
  for (const add of [() => F.keyBlock(), () => F.secretSetting() + '\n\n## X\n' + F.authHeader()]) {
    const sentence = uniq('clean');
    const run = makeRun('t7late', {});
    write(run, 'a.md', `# A\n${sentence}\n\n## B\nother\n`);
    const store = openStore(run);
    await store.refresh();
    assert.equal(dataHolds(run.data, sentence), true);
    write(run, 'a.md', `# A\n${sentence}\n\n## B\n${add()}\n`);
    await store.refresh();
    assert.equal(dataHolds(run.data, sentence), false);
    assert.equal(store.rank(sentence).results.length, 0);
  }
});

test('T-20 (store part): never-terms never appear under the data root', async () => {
  const run = makeRun('t20terms', { 'a.md': '# A\nkeep deploy\n\n## B\nwork for ZqClientCo here\n', 'zqclientco-notes.md': 'x' });
  const store = openStore(run, { options: { never_terms: ['ZqClientCo'] } });
  const r = await store.refresh();
  assert.equal(r.skipped.never_term, 1);
  assert.equal(dataHolds(run.data, 'zqclientco'), false);
  assert.equal(dataHolds(run.data, 'ZqClientCo'), false);
  assert.ok(!JSON.stringify(store.status()).toLowerCase().includes('zqclientco'));
});

// ---------------------------------------------------------------------------
// T-8 purge

test('T-8: every way a file leaves the index removes its old text from the data root', async (t) => {
  const cases = {
    'file-level fake': (run, p) => write(run, 'a.md', fs.readFileSync(p, 'utf8') + '\n' + F.keyBlock() + '\n'),
    'chunk-level fake': (run) => write(run, 'a.md', '# A\nother words\n\n## B\n' + F.secretSetting() + '\n'),
    ignored: (run) => write(run, '.gitignore', 'a.md\n'),
    'renamed hidden': (run, p) => fs.renameSync(p, path.join(run.proj, '.a.md')),
    'replaced with a link': (run, p) => {
      fs.unlinkSync(p);
      const outside = path.join(run.base, 'outside');
      fs.mkdirSync(outside, { recursive: true });
      fs.symlinkSync(outside, p, IS_WIN ? 'junction' : 'dir');
    },
    'grown past the size cap': (run, p) => write(run, 'a.md', fs.readFileSync(p, 'utf8') + 'x'.repeat(1100)),
    deleted: (run, p) => fs.unlinkSync(p),
  };
  for (const [name, change] of Object.entries(cases)) {
    const sentence = uniq('purge');
    const run = makeRun('t8', {});
    const p = write(run, 'a.md', `# A\n${sentence}\n\n## B\nmore text\n`);
    write(run, 'b.md', '# Other\nkept file\n');
    const store = openStore(run, { options: { max_file_bytes: 1024 } });
    await store.refresh();
    assert.equal(dataHolds(run.data, sentence), true, name);
    change(run, p);
    await store.refresh();
    if (name === 'chunk-level fake') {
      assert.equal(dataHolds(run.data, F.secretSetting()), false, name);
      assert.equal(dataHolds(run.data, sentence), false, name);
    } else {
      assert.equal(dataHolds(run.data, sentence), false, name);
    }
    assert.equal(dataHolds(run.data, 'kept file'), true, name);
  }
  t.diagnostic('never-list case: see the options-change rebuild test');
});

test('T-8: a never-list change rebuilds and the listed file\'s text is gone', async () => {
  const sentence = uniq('never');
  const run = makeRun('t8never', { 'drafts/a.md': `# A\n${sentence}\n`, 'b.md': '# B\nkept\n' });
  const s1 = openStore(run);
  await s1.refresh();
  assert.equal(dataHolds(run.data, sentence), true);
  const s2 = openStore(run, { options: { never_folders: ['drafts'] } });
  assert.equal(s2.state(), 'rebuilding');
  await s2.refresh();
  assert.equal(dataHolds(run.data, sentence), false);
});

test('T-8 crash case: a write forced to fail after its temp file exists leaves no temp file', async () => {
  const sentence = uniq('crash');
  const run = makeRun('t8crash', { 'a.md': `# A\n${sentence}\n` });
  const store = openStore(run, { hooks: { failWriteAfterTemp: true } });
  const r = await store.refresh();
  assert.equal(r.writeError, 'forced_failure');
  assert.deepEqual(fs.readdirSync(store.indexDir).filter((n) => n.endsWith('.tmp')), []);
  assert.equal(dataHolds(run.data, sentence), false);
});

test('T-8: a leftover temp file newer than 10 minutes is removed when the next store takes the lock; others left alone', async () => {
  const sentence = uniq('leftover');
  const run = makeRun('t8leftover', { 'a.md': '# A\nplain\n' });
  const s1 = openStore(run);
  await s1.refresh();
  const dir = s1.indexDir;
  const leftover = X.tempNameFor('chunks.jsonl');
  fs.writeFileSync(path.join(dir, leftover), sentence);
  fs.writeFileSync(path.join(dir, 'other-name.txt'), 'kept');
  const target = path.join(run.base, 'link-target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'untouched');
  const linkName = X.tempNameFor('manifest.json');
  fs.symlinkSync(target, path.join(dir, linkName), IS_WIN ? 'junction' : 'dir');
  const s2 = openStore(run); // open removes only temp files older than 10 minutes
  assert.ok(fs.existsSync(path.join(dir, leftover)));
  write(run, 'a.md', '# A\nchanged\n');
  await s2.refresh(); // takes the lock, then removes its own temp files of any age
  assert.ok(!fs.existsSync(path.join(dir, leftover)));
  assert.equal(dataHolds(run.data, sentence), false);
  assert.ok(fs.existsSync(path.join(dir, 'other-name.txt')));
  assert.ok(fs.lstatSync(path.join(dir, linkName)).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'untouched');
  fs.rmSync(path.join(dir, linkName), { recursive: false, force: true });
});

// ---------------------------------------------------------------------------
// Loud rebuild and corrupt index (9.6, 9.12, SR-25, SR-49 d)

async function builtRun(tag) {
  const run = makeRun(tag, { 'a.md': '# A\ndeploy notes\n' });
  const s = openStore(run);
  await s.refresh();
  return { run, dir: s.indexDir };
}

function editManifest(dir, fn) {
  const p = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  fn(m);
  fs.writeFileSync(p, JSON.stringify(m));
}

test('loud rebuild: schema, tokenizer, rules (floor and scan) or options change → full rebuild, named error until done, then said once', async () => {
  const changes = {
    schema_changed: (dir) => editManifest(dir, (m) => { m.schema_version = 999; }),
    tokenizer_changed: (dir) => editManifest(dir, (m) => { m.tokenizer_version = 'tok-old'; }),
    rules_changed: (dir) => editManifest(dir, (m) => { m.rules_version = 'rules-0'; }),
    options_changed: null,
  };
  for (const [reason, change] of Object.entries(changes)) {
    const { run, dir } = await builtRun('rebuild');
    if (change) change(dir);
    const store = openStore(run, change ? {} : { options: { drop_contacts: false } });
    assert.equal(store.state(), 'rebuilding', reason);
    assert.deepEqual(store.status().rebuild, { reason, done: false });
    await assert.rejects(store.search('deploy', { statBudgetMs: 0 }), { name: 'IndexRebuilding' });
    await store.idle();
    const r = await store.search('deploy');
    assert.equal(r.notice, 'index rebuilt from source: ' + reason);
    assert.equal(r.results.length, 1);
    assert.equal((await store.search('deploy')).notice, null);
  }
});

test('rules version: the manifest holds it; a different stored version forces a full re-scan of unchanged files', async () => {
  const run = makeRun('rulesver', { 'a.md': '# A\ndeploy notes\n', 'b.md': '# B\nrollback notes\n', 'c.txt': 'plain deploy\n' });
  const s1 = openStore(run, { rulesVersion: 'rules-' + 'a'.repeat(32) });
  await s1.refresh();
  const man = JSON.parse(fs.readFileSync(path.join(s1.indexDir, 'manifest.json'), 'utf8'));
  assert.equal(man.rules_version, 'rules-' + 'a'.repeat(32));
  // Same files, unchanged on disk, but a release changed a scan rule.
  const s2 = openStore(run, { rulesVersion: 'rules-' + 'b'.repeat(32) });
  assert.equal(s2.state(), 'rebuilding');
  assert.equal(s2.status().rebuild.reason, 'rules_changed');
  const before = s2.counters.scans;
  await s2.refresh();
  assert.equal(s2.counters.scans - before, 3); // every file scanned again
  assert.equal((await s2.search('deploy')).notice, 'index rebuilt from source: rules_changed');
  // The same version again: nothing is re-scanned.
  const s3 = openStore(run, { rulesVersion: 'rules-' + 'b'.repeat(32) });
  await s3.refresh();
  assert.equal(s3.counters.scans, 0);
});

test('SR-49 a: a reader without the lock never deletes, even when it catches a writer between its two renames', async () => {
  const { run, dir } = await builtRun('reader');
  const chunksPath = path.join(dir, 'chunks.jsonl');
  const good = fs.readFileSync(chunksPath);
  // A writer holds the lock and has renamed chunks.jsonl but not yet manifest.json.
  plantLock(dir, 0);
  const lockBytes = fs.readFileSync(path.join(dir, 'lock'));
  fs.writeFileSync(chunksPath, Buffer.concat([good, Buffer.from(good.toString('utf8').split('\n')[0] + '\n')]));
  const midway = fs.readFileSync(chunksPath);
  const reader = openStore(run);
  assert.equal(reader.state(), 'rebuilding'); // recorded in memory only
  const r = await reader.refresh();
  assert.equal(r.readOnly, true);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['chunks.jsonl', 'lock', 'manifest.json']);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'lock')), lockBytes);
  assert.deepEqual(fs.readFileSync(chunksPath), midway);
  // The writer finishes (here: the consistent pair is back) and lets go of the lock.
  fs.writeFileSync(chunksPath, good);
  fs.unlinkSync(path.join(dir, 'lock'));
  const r2 = await reader.refresh();
  assert.equal(r2.readOnly, false);
  assert.equal(reader.state(), 'fresh');
  assert.equal(reader.status().rebuild, null); // read again under the lock: nothing to rebuild
  assert.equal(reader.rank('deploy').results.length, 1);
});

test('SR-25: a write that fails after a purge is retried by the next run, and the purged text leaves the disk', async () => {
  for (const how of ['failed write', 'lock lost']) {
    const sentence = uniq('retry');
    const run = makeRun('retry', {});
    const pa = write(run, 'a.md', `# A\n${sentence}\n`);
    write(run, 'b.md', '# B\nkept file\n');
    const hooks = {};
    const store = openStore(run, { hooks });
    await store.refresh();
    assert.equal(dataHolds(run.data, sentence), true, how);
    fs.unlinkSync(pa);
    if (how === 'failed write') hooks.failWriteAfterTemp = true;
    else hooks.beforeWrite = () => plantLock(store.indexDir, 0);
    const r1 = await store.refresh();
    assert.ok(r1.writeError, how);
    assert.equal(store._test.pendingWrite, true, how);
    assert.equal(dataHolds(run.data, sentence), true, how); // still on disk: the write did not land
    delete hooks.failWriteAfterTemp;
    delete hooks.beforeWrite;
    try { fs.unlinkSync(path.join(store.indexDir, 'lock')); } catch (_) { /* none */ }
    const r2 = await store.refresh(); // nothing changed in the project since the failed run
    assert.equal(r2.wrote, true, how);
    assert.equal(store._test.pendingWrite, false, how);
    assert.equal(dataHolds(run.data, sentence), false, how);
    assert.equal(dataHolds(run.data, 'kept file'), true, how);
  }
});

test('SR-25, 9.6 c: emptying the index folder refuses a folder that was swapped for a link; its target is untouched', (t) => {
  const run = makeRun('dellink', { 'a.md': '# A\nx\n' });
  const store = openStore(run);
  const dir = store.indexDir;
  const outside = path.join(run.base, 'outside-target');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'untouched bytes');
  fs.renameSync(dir, dir + '-moved');
  try {
    fs.symlinkSync(outside, dir, IS_WIN ? 'junction' : 'dir');
  } catch (_) {
    t.skip('folder links cannot be made here');
    return;
  }
  assert.equal(store._test.deleteIndexFolder(), false);
  assert.deepEqual(fs.readdirSync(outside), ['keep.txt']);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'untouched bytes');
  fs.rmSync(dir, { recursive: false, force: true });
});

test('counts add up: an unparseable .gitignore and a folder that cannot be listed are counted apart from files', async () => {
  const run = makeRun('counts', {
    'a.md': '# A\ndeploy\n', 'b.md': '# B\ndeploy\n',
    'sub/.gitignore': 'fine.md\nbad\\#escape.md\n', 'sub/c.md': '# C\nx\n',
    'gone/d.md': '# D\nx\n', 'gone/e.md': '# E\nx\n',
  });
  const store = openStore(run, {
    hooks: { afterFolder: (rel) => { if (rel === '') fs.rmSync(path.join(run.proj, 'gone'), { recursive: true, force: true }); } },
  });
  const r = await store.refresh();
  assert.equal(r.succeeded, 2);
  assert.equal(r.failed, 0);
  assert.equal(r.failedDirs.ENOENT, 1);
  assert.equal(r.ignoreProblems.unparseable, 1);
  assert.equal(r.skipped.ignore_unparseable_files, undefined);
  assert.equal(sumRun(r), r.visited);
  assert.deepEqual(store.status().failedDirs, { ENOENT: 1 });
});

test('a corrupt index is deleted and rebuilt; only that project\'s index folder is touched', async () => {
  const { run, dir } = await builtRun('corrupt');
  const otherDir = path.join(run.data, 'indexes', 'ffffffffffffffff');
  fs.mkdirSync(otherDir);
  fs.writeFileSync(path.join(otherDir, 'manifest.json'), 'other project');
  fs.writeFileSync(path.join(run.data, 'keep-me.txt'), 'data root file');
  fs.appendFileSync(path.join(dir, 'chunks.jsonl'), '{not json\n');
  const store = openStore(run);
  assert.equal(store.state(), 'rebuilding');
  assert.equal(store.status().rebuild.reason, 'corrupt');
  await store.refresh();
  assert.equal(store.state(), 'fresh');
  assert.equal(fs.readFileSync(path.join(otherDir, 'manifest.json'), 'utf8'), 'other project');
  assert.equal(fs.readFileSync(path.join(run.data, 'keep-me.txt'), 'utf8'), 'data root file');
  assert.equal(store.rank('deploy').results.length, 1);
});

// ---------------------------------------------------------------------------
// Stat pass (9.7)

test('stat pass: unchanged files are not re-read; same bytes with a new time are re-hashed, not re-scanned; changes are re-scanned', async () => {
  assert.equal(St.STAT_BUDGET_MS, 300);
  const run = makeRun('statpass', {});
  write(run, 'a.md', '# A\nalpha words\n');
  const pb = write(run, 'b.md', '# B\nbeta words\n');
  const store = openStore(run);
  await store.refresh();
  const c0 = store.counters;
  await store.refresh();
  assert.equal(store.counters.reads, c0.reads);
  touch(pb);
  await store.refresh();
  assert.equal(store.counters.reads, c0.reads + 1);
  assert.equal(store.counters.hashes, c0.hashes + 1);
  assert.equal(store.counters.scans, c0.scans);
  write(run, 'b.md', '# B\ngamma words\n');
  await store.refresh();
  assert.equal(store.counters.scans, c0.scans + 1);
  assert.equal(store.rank('beta').results.length, 0);
  assert.equal(store.rank('gamma').results.length, 1);
});

test('stat pass budget 0 ms → stale, the rest completes in the background, a later search is fresh', async () => {
  const run = makeRun('stale', { 'a.md': '# A\ndeploy\n' });
  const store = openStore(run);
  await store.refresh();
  write(run, 'a.md', '# A\ndeploy rollback\n');
  const r = await store.search('deploy', { statBudgetMs: 0 });
  assert.equal(r.state, 'stale');
  await store.idle();
  const r2 = await store.search('rollback');
  assert.equal(r2.state, 'fresh');
  assert.equal(r2.results.length, 1);
});

// ---------------------------------------------------------------------------
// Lock (SR-49 a, SR-34) and T-18

test('lock: holds the process id and start time; refreshed every 30 s by the injected clock', async () => {
  const run = makeRun('lock', { 'a.md': '# A\nx\n' });
  let now = Date.now();
  const store = openStore(run, { clock: { now: () => now }, identity: { pid: 4242, start: 777 } });
  assert.equal(store._lock.acquireLock(), true);
  const lock = JSON.parse(fs.readFileSync(path.join(store.indexDir, 'lock'), 'utf8'));
  assert.equal(lock.pid, 4242);
  assert.equal(lock.start, 777);
  now += 29 * 1000;
  assert.equal(store._lock.touchLock(false), false);
  now += 1000;
  assert.equal(store._lock.touchLock(false), true);
  assert.ok(Math.abs(fs.statSync(path.join(store.indexDir, 'lock')).mtimeMs - now) < 2000);
  store._lock.releaseLock();
  assert.ok(!fs.existsSync(path.join(store.indexDir, 'lock')));
  assert.equal(St.LOCK_REFRESH_MS, 30000);
  assert.equal(St.LOCK_STALE_MS, 120000);
});

function plantLock(dir, ageSeconds) {
  const p = path.join(dir, 'lock');
  fs.writeFileSync(p, JSON.stringify({ pid: 1, start: 1, nonce: 'other' }));
  const t = (Date.now() - ageSeconds * 1000) / 1000;
  fs.utimesSync(p, t, t);
}

test('lock: 119 s old is not stale (read only); 121 s old is broken', async () => {
  const run = makeRun('stale-lock', { 'a.md': '# A\nx\n' });
  const s1 = openStore(run);
  await s1.refresh();
  write(run, 'a.md', '# A\nchanged\n');
  plantLock(s1.indexDir, 119);
  const r1 = await openStore(run).refresh();
  assert.equal(r1.readOnly, true);
  plantLock(s1.indexDir, 121);
  const r2 = await openStore(run).refresh();
  assert.equal(r2.readOnly, false);
  assert.equal(r2.wrote, true);
});

test('lock: if the re-create fails after breaking a stale lock, the process reads only', async () => {
  const run = makeRun('lock-fail', { 'a.md': '# A\nx\n' });
  const s1 = openStore(run);
  await s1.refresh();
  const lockDir = path.join(s1.indexDir, 'lock');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'blocker'), 'x'); // cannot be removed as a lock, so the create fails
  const r = await openStore(run).refresh();
  assert.equal(r.readOnly, true);
  fs.rmSync(lockDir, { recursive: true, force: true });
});

test('T-18: two stores refresh one project at once → one writes, the other reads only; the index stays valid', async () => {
  const run = makeRun('t18', { 'a.md': '# A\ndeploy\n', 'b.md': '# B\nrollback\n' });
  const a = openStore(run, { identity: { pid: 1001, start: 1 } });
  const b = openStore(run, { identity: { pid: 1002, start: 2 } });
  const [ra, rb] = await Promise.all([a.refresh(), b.refresh()]);
  assert.equal([ra.readOnly, rb.readOnly].filter(Boolean).length, 1);
  const c = openStore(run);
  assert.equal(c.state(), 'fresh');
  assert.equal(c.rank('deploy rollback', { k: 10 }).results.length, 2);
});

test('T-18: a holder whose lock was broken while paused writes nothing and removes its temp file', async () => {
  const run = makeRun('t18paused', { 'a.md': '# A\ndeploy\n' });
  const store = openStore(run, {
    hooks: { beforeWrite: () => plantLock(path.join(run.data, 'indexes', St.indexFolderName(run.proj)), 0) },
  });
  const r = await store.refresh();
  assert.equal(r.lockLost, true);
  assert.deepEqual(fs.readdirSync(store.indexDir).sort(), ['lock']);
});

test('T-18: a lock path pre-planted as a link → the link itself is removed, never its target', async () => {
  const run = makeRun('t18link', { 'a.md': '# A\ndeploy\n' });
  const s1 = openStore(run);
  const target = path.join(run.base, 'lock-target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'untouched bytes');
  fs.symlinkSync(target, path.join(s1.indexDir, 'lock'), IS_WIN ? 'junction' : 'dir');
  const r = await s1.refresh();
  assert.equal(r.readOnly, false);
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'untouched bytes');
  assert.deepEqual(fs.readdirSync(target), ['keep.txt']);
});

test('SR-34: two refresh calls at once in one store → the second says already running', async () => {
  const run = makeRun('sr34', { 'a.md': '# A\ndeploy\n' });
  const store = openStore(run);
  const first = store.refresh();
  const second = await store.refresh();
  assert.deepEqual(second, { already: true });
  await first;
  const third = await store.refresh();
  assert.equal(third.already, undefined);
});

// ---------------------------------------------------------------------------
// OFF file, T-29, T-30

test('a file named OFF in the data root turns search off; removing it turns search back on without a restart', async () => {
  const run = makeRun('off', { 'a.md': '# A\ndeploy\n' });
  const store = openStore(run);
  await store.refresh();
  fs.writeFileSync(path.join(store.dataReal, St.OFF_FILE), '');
  const r = await store.search('deploy');
  assert.equal(r.state, 'off');
  assert.equal(r.reason, 'off_file');
  assert.equal(store.status().state, 'off');
  fs.unlinkSync(path.join(store.dataReal, St.OFF_FILE));
  const r2 = await store.search('deploy');
  assert.equal(r2.state, 'fresh');
  assert.equal(r2.results.length, 1);
});

test('T-29: file, text and chunk hard limits stop the build, keep what they have and say so; the soft target warns', async () => {
  const files = {};
  for (let i = 0; i < 6; i++) files[`n${i}.md`] = `# N${i}\ndeploy ${i}\n\n## More\ntext\n`;
  for (const limits of [{ files: 3 }, { textBytes: 60 }, { chunksHard: 5 }]) {
    const run = makeRun('t29', files);
    const store = openStore(run, { limits });
    const r = await store.refresh();
    assert.equal(r.incomplete, 'size_cap', JSON.stringify(limits));
    assert.ok(r.succeeded > 0 && r.succeeded < 6);
    assert.ok(store.status().warnings.includes(St.INCOMPLETE_LINE));
    assert.equal(St.INCOMPLETE_LINE, 'index incomplete: project over the size cap; narrow it with your exclude options');
    assert.equal(sumRun(r), r.visited);
  }
  const run = makeRun('t29soft', files);
  const store = openStore(run, { limits: { chunksSoft: 4 } });
  const r = await store.refresh();
  assert.equal(r.succeeded, 6);
  assert.equal(r.incomplete, null);
  assert.ok(store.status().warnings.includes(St.LARGE_PROJECT_LINE));
  assert.deepEqual(St.LIMITS, { entries: 200000, files: 20000, textBytes: 67108864, chunksSoft: 10000, chunksHard: 50000 });
});

test('T-30: unreadable, deleted, throwing and hit files never stop the batch; the counts add up', async () => {
  const files = {};
  for (let i = 0; i < 10; i++) files[`good${i}.md`] = `# G${i}\ndeploy good ${i}\n`;
  files['unreadable.md'] = '# U\nx\n';
  files['vanish.md'] = '# V\nx\n';
  files['throws.md'] = '# T\nx\n';
  files['hit.md'] = '# H\n' + F.connString() + '\n';
  const run = makeRun('t30', files);
  const store = openStore(run, {
    hooks: {
      beforeOpen: (abs, rel) => {
        if (rel === 'unreadable.md') { const e = new Error('denied'); e.code = 'EACCES'; throw e; }
        if (rel === 'vanish.md') fs.unlinkSync(abs);
      },
      scanThrowOn: (rel) => rel === 'throws.md',
    },
  });
  const r = await store.refresh();
  assert.equal(r.succeeded, 10);
  assert.equal(r.failed, 2);
  assert.deepEqual(r.failedBy, { EACCES: 1, ENOENT: 1 });
  assert.equal(r.skipped.scan_error, 1);
  assert.equal(r.skipped.scan_conn_string, 1);
  assert.equal(sumRun(r), r.visited);
  assert.equal(store.rank('deploy', { k: 10 }).results.length, 10);
});

test('hard line 7: one file whose store write fails is counted failed; the other files are stored', async () => {
  const run = makeRun('upsertfail', { 'a.md': '# A\ndeploy\n', 'b.md': '# B\ndeploy\n', 'c.md': '# C\ndeploy\n' });
  const store = openStore(run, { hooks: { beforeUpsert: (rel) => { if (rel === 'b.md') throw new Error('x'); } } });
  const r = await store.refresh();
  assert.equal(r.succeeded, 2);
  assert.equal(r.failed, 1);
  assert.deepEqual(store.rank('deploy').results.map((x) => x.path).sort(), ['a.md', 'c.md']);
  assert.equal(sumRun(r), r.visited);
});

test('marks flow through the store: cancelled hidden by default, superseded resolved to an indexed successor', async () => {
  const run = makeRun('marks', {
    'old.md': ['# Old plan', F.markLine('superseded', 'new.md'), 'deploy the old way', ''].join('\n'),
    'new.md': '# New plan\ndeploy the new way\n',
    'gone.md': ['# Gone', F.markLine('cancelled'), 'deploy never', ''].join('\n'),
  });
  const store = openStore(run);
  await store.refresh();
  const r = store.rank('deploy', { k: 10 });
  assert.deepEqual(r.results.map((x) => x.path), ['new.md', 'old.md']);
  assert.equal(r.results[1].successor, 'new.md');
  assert.deepEqual(r.hidden, [{ path: 'gone.md', heading: 'Gone' }]);
});

test('T-19: a mark line inside an HTML comment has no effect (marks come from the stored, scanned text)', async () => {
  const run = makeRun('markcomment', {
    'plan.md': ['# Plan', '<!--', F.markLine('cancelled'), '-->', 'intro', '', '## Deploy', 'deploy steps here', ''].join('\n'),
  });
  const store = openStore(run);
  const r0 = await store.refresh();
  assert.equal(r0.dropped.scan_hidden_html, 1);
  const r = store.rank('deploy', { k: 10 });
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].flag, 'unmarked');
  assert.equal(r.hiddenCount, 0);
});

test('T-12 (store part): a data root owned by another user → off', { skip: IS_WIN && 'POSIX permissions are not checked on Windows (SR-23)' }, () => {
  const run = makeRun('owner', { 'a.md': 'x' });
  const store = openStore(run, { uid: (process.getuid ? process.getuid() : 0) + 12345 });
  assert.equal(store.state(), 'off');
  assert.equal(store.status().reason, 'folder_checks_failed');
});
