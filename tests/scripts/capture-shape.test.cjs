'use strict';
// scripts/capture-shape.mjs (spec 6.8; 15.3 capture-shape row). Synthetic input only.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { REPO_TOP, makeTempDir, removeDir } = require('../helpers/tmpdir-sandbox.cjs');
const F = require('../helpers/fake-values.cjs');

const SCRIPT = path.join(REPO_TOP, 'scripts', 'capture-shape.mjs');
const FIXTURE = path.join(REPO_TOP, 'tests', 'fixtures', 'transcript-real-shape.jsonl');
const made = [];
after(() => { for (const d of made) removeDir(d); });
let C;
before(async () => { C = await import(pathToFileURL(SCRIPT).href); });

// A synthetic "real" transcript, built at run time: real-looking ids, text, a folder and a model.
function synthetic() {
  const id = (n) => ['1b4e28ba', '2fa1', '11d2', '883f', String(n).padStart(12, '7')].join('-');
  const recs = [
    { type: 'user', sessionId: id(1), uuid: id(2), cwd: ['', 'work', 'secret-client-folder'].join('/'), message: { role: 'user', content: 'please read the quarterly plan' }, timestamp: F.fixtureTimestamp().replace('2000', '2031') },
    { type: 'assistant', isSidechain: false, sessionId: id(1), uuid: id(3), requestId: 'req_PLANTEDREQUEST', message: { id: 'msg_PLANTEDMESSAGE', role: 'assistant', model: 'vendor-model-real-name', content: [{ type: 'text', text: 'the plan says ship on friday' }], usage: { input_tokens: 1234, cache_creation_input_tokens: 10, cache_read_input_tokens: 99, output_tokens: 7, cache_creation: { ephemeral_5m_input_tokens: 10 } } } },
    { type: 'cost-state', modelUsage: { 'vendor-model-real-name': { inputTokens: 1234 } }, startTime: 1999999999999 },
  ];
  return recs.map((r) => JSON.stringify(r)).join('\n') + '\nnot json at all\n';
}

test('6.8: the capture keeps record types, usage keys and numbers, and replaces every text field and id', () => {
  const text = synthetic();
  const cap = C.captureText(text);
  assert.equal(cap.records, 3);
  assert.equal(cap.failed, 1, 'a line that is not JSON is counted and the rest still run');
  const out = cap.lines.join('\n');
  for (const s of ['quarterly plan', 'ship on friday', 'secret-client-folder', 'PLANTEDREQUEST', 'PLANTEDMESSAGE', 'vendor-model-real-name', '1b4e28ba', '2031', '1999999999999']) {
    assert.ok(!out.includes(s), 'no source text: ' + s.slice(0, 12));
  }
  const recs = cap.lines.map((l) => JSON.parse(l));
  assert.deepEqual(recs.map((r) => r.type), ['user', 'assistant', 'cost-state']);
  assert.deepEqual(recs[1].message.usage, { input_tokens: 1234, cache_creation_input_tokens: 10, cache_read_input_tokens: 99, output_tokens: 7, cache_creation: { ephemeral_5m_input_tokens: 10 } });
  assert.equal(recs[0].cwd, '/work/project');
  assert.equal(recs[0].timestamp, F.fixtureTimestamp());
  assert.match(recs[0].sessionId, /^00000000-0000-4000-8000-0{10}[0-9a-f]{2}$/);
  assert.equal(recs[0].sessionId, recs[1].sessionId, 'one id maps to one placeholder');
  assert.match(recs[1].requestId, /^request-\d{4}$/);
  assert.match(recs[1].message.id, /^message-\d{4}$/);
  assert.match(recs[1].message.model, /^model-/);
  assert.equal(recs[1].message.content[0].text, 'x');
  assert.deepEqual(Object.keys(recs[2].modelUsage), [recs[1].message.model], 'model names used as keys are replaced the same way');
  assert.equal(recs[2].startTime, F.fixtureTimeMs());
});

test('6.8: re-capturing the committed fixture gives the same shape; a usage key added or removed fails the compare', () => {
  const fx = fs.readFileSync(FIXTURE, 'utf8');
  assert.deepEqual(C.compareShapes(C.meterShape(C.captureText(fx).lines.join('\n')), C.meterShape(fx)), []);
  const dir = makeTempDir('capture');
  made.push(dir);
  const edit = (fn) => fx.split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); if (r.type === 'assistant') fn(r.message.usage); return JSON.stringify(r); }).join('\n') + '\n';
  const added = path.join(dir, 'added.jsonl');
  fs.writeFileSync(added, edit((u) => { u.new_usage_key = 1; }));
  const removed = path.join(dir, 'removed.jsonl');
  fs.writeFileSync(removed, edit((u) => { delete u.cache_read_input_tokens; }));
  const same = spawnSync(process.execPath, [SCRIPT, FIXTURE, '--compare', FIXTURE], { encoding: 'utf8' });
  assert.equal(same.status, 0);
  assert.match(same.stdout, /^shape: same$/m);
  for (const [f, want] of [[added, /only in the capture: usage usage\.new_usage_key/], [removed, /only in the fixture: usage usage\.cache_read_input_tokens/]]) {
    const r = spawnSync(process.execPath, [SCRIPT, f, '--compare', FIXTURE], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^shape: differs$/m);
    assert.match(r.stdout, want);
  }
});

test('6.8: --out writes only inside the repo, and a bad line makes the run report a failure', () => {
  const dir = makeTempDir('capture-out');
  made.push(dir);
  const src = path.join(dir, 't.jsonl');
  fs.writeFileSync(src, synthetic());
  const out = path.join(dir, 'shape.jsonl');
  const r = spawnSync(process.execPath, [SCRIPT, src, '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 1, 'the one bad line makes the run report a failure');
  assert.match(r.stdout, /records 3, failed 1/);
  assert.ok(fs.readFileSync(out, 'utf8').endsWith('\n'));
  const bad = spawnSync(process.execPath, [SCRIPT, src, '--out', path.resolve(REPO_TOP, '..', 'outside.jsonl')], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

test('6.8: an object key not shaped like a field name (a path, a URL) becomes key-<n>, and a kept enumeration value that does not look like one becomes x', () => {
  const home = ['', 'Users', 'someone-real', 'work'].join('/');
  const rec = {
    type: 'attachment',
    fileStates: { [home + '/plan.md']: { size: 3 }, [home + '/notes.md']: { size: 4 }, plain_key: { size: 5 } },
    links: { ['https://' + ['example', 'com'].join('.') + '/a']: 1 },
    version: '2.1.329 then a sentence with spaces',
    role: 'user',
  };
  const out = C.captureText(JSON.stringify(rec)).lines[0];
  for (const s of ['someone-real', 'plan.md', 'example', 'sentence']) assert.ok(!out.includes(s), 'no source text: ' + s);
  const j = JSON.parse(out);
  assert.deepEqual(Object.keys(j.fileStates), ['key-1', 'key-2', 'plain_key']);
  assert.deepEqual(Object.keys(j.links), ['key-3']);
  assert.equal(j.version, 'x');
  assert.equal(j.role, 'user');
});
