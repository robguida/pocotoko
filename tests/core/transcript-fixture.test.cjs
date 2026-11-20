'use strict';
// The real-format transcript fixture (spec 6.3, 6.8): tests/fixtures/transcript-real-shape.jsonl
// holds the record structure of a Claude Code 2.1.329 transcript (two turns, the second
// after a resume) with every value synthetic. It is simplified: 24 attachment records of the
// 52-record capture are left out and its request copies all have the `user` role (changelog,
// "Fixture for B2"). The meter tests (B2) read it; this file
// checks the fixture itself stays usable and synthetic.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../helpers/fake-values.cjs');

const FILE = path.join(__dirname, '..', 'fixtures', 'transcript-real-shape.jsonl');
const text = fs.readFileSync(FILE, 'utf8');
const records = text.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));

function walk(v, visit, key = '') {
  if (Array.isArray(v)) { v.forEach((x) => walk(x, visit, key)); return; }
  if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) walk(x, visit, k); return; }
  visit(key, v);
}

test('every line is one JSON record; LF line ends; the file ends with a new line', () => {
  assert.ok(text.endsWith('\n'));
  assert.ok(!text.includes('\r'));
  assert.equal(records.length, text.split('\n').filter((l) => l !== '').length);
});

test('record types match the 2.1.329 capture', () => {
  const types = new Set(records.map((r) => r.type));
  for (const t of ['session-owner', 'queue-operation', 'user', 'attachment', 'atis-latch', 'api-request-shape',
    'api-request-blob', 'api-request', 'assistant', 'last-prompt', 'mode', 'cost-state']) assert.ok(types.has(t), t);
});

test('values are synthetic: one fixed timestamp from the helper (13.1 d), placeholder text only', () => {
  const ts = F.fixtureTimestamp();
  for (const r of records) {
    walk(r, (k, v) => {
      if (k === 'timestamp') assert.equal(v, ts);
      if (k === 'startTime') assert.equal(v, F.fixtureTimeMs());
      if ((k === 'text' || k === 'content' || k === 'lastPrompt') && typeof v === 'string') assert.equal(v, 'x');
    });
  }
});

test('values are synthetic: every id-like, path and model value in the whole tree is an obvious placeholder', () => {
  const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const SYNTH_UUID = /^00000000-0000-4000-8000-0{10}[0-9a-f]{2}$/;
  const ID_KEY = /(uuid|id|ref|hash)$/i;
  const SYNTH_ID = /^(?:00000000-0000-4000-8000-0{10}[0-9a-f]{2}|(?:request|message|shape|blob)-\d{4})$/;
  let seen = 0;
  for (const r of records) {
    walk(r, (k, v) => {
      if (typeof v !== 'string') return;
      if (UUID_SHAPE.test(v)) { assert.match(v, SYNTH_UUID, `${k}: ${v}`); seen++; }
      if (ID_KEY.test(k)) assert.match(v, SYNTH_ID, `${k}: ${v}`);
      if (k === 'cwd') assert.equal(v, '/work/project');
      if (k === 'model' || k === 'requestedModel') assert.match(v, /^model-/, `${k}: ${v}`);
    });
    // Model names used as object keys (cost-state modelUsage) are placeholders too.
    if (r.modelUsage) for (const name of Object.keys(r.modelUsage)) assert.match(name, /^model-/);
  }
  assert.ok(seen > 0);
});

// Every string value in the fixture, by its key: a fixed set of allowed values or a pattern.
// A key with no rule fails, so no real-looking value (a branch name, an entry point, a
// region, a digest, a version) can enter the fixture later without a rule written for it.
const SYNTH_UUID_RE = /^00000000-0000-4000-8000-0{10}[0-9a-f]{2}$/;
const one = (...v) => new Set(v);
const STRING_RULES = {
  type: one('session-owner', 'queue-operation', 'user', 'attachment', 'atis-latch', 'api-request-shape',
    'api-request-blob', 'api-request', 'assistant', 'last-prompt', 'mode', 'cost-state',
    'total_tokens_reminder', 'text', 'message', 'adaptive', 'clear_thinking'),
  accountUuid: SYNTH_UUID_RE,
  organizationUuid: SYNTH_UUID_RE,
  sessionId: SYNTH_UUID_RE,
  promptId: SYNTH_UUID_RE,
  uuid: SYNTH_UUID_RE,
  parentUuid: SYNTH_UUID_RE,
  leafUuid: SYNTH_UUID_RE,
  requestRef: SYNTH_UUID_RE,
  id: /^(?:00000000-0000-4000-8000-0{10}[0-9a-f]{2}|message-\d{4})$/,
  requestId: /^request-\d{4}$/,
  shapeHash: /^shape-\d{4}$/,
  hash: /^blob-\d{4}$/,
  requestDigest: /^digest-\d{4}$/,
  operation: one('enqueue', 'dequeue'),
  timestamp: one(F.fixtureTimestamp()),
  content: one('x'),
  text: one('x'),
  lastPrompt: one('x'),
  role: one('user', 'assistant', 'system'),
  renderedRole: one('system'),
  permissionMode: one('default'),
  promptSource: one('cli'),
  turnOrigin: one('cli'),
  querySource: one('cli'),
  userType: one('external'),
  entrypoint: one('sdk-cli'),
  cwd: one('/work/project'),
  version: /^\d{1,3}\.\d{1,3}\.\d{1,4}$/,
  gitBranch: one('main'),
  atis: one(''),
  model: /^model-[a-z0-9-]+$/,
  requestedModel: /^model-[a-z0-9-]+$/,
  display: one('summary'),
  keep: one('all'),
  effort: one('low', 'medium', 'high'),
  perTurnEffort: one('low', 'medium', 'high'),
  stop_reason: one('end_turn'),
  service_tier: one('standard'),
  speed: one('standard'),
  inference_geo: one('region'),
  promptCacheRequested: one('1h', '5m'),
  madeBy: one('model'),
  mode: one('normal'),
};

test('values are synthetic: every string value in the whole tree matches an allow-list or a pattern for its key', () => {
  let checked = 0;
  for (const r of records) {
    walk(r, (k, v) => {
      if (typeof v !== 'string') return;
      const rule = STRING_RULES[k];
      assert.ok(rule, `no allow-list or pattern for key "${k}"`);
      if (rule instanceof Set) assert.ok(rule.has(v), `${k}: value not on its allow-list`);
      else assert.match(v, rule, `${k}: value does not match its pattern`);
      checked++;
    });
  }
  assert.ok(checked > 0);
});

test('usage sits in main-thread assistant records as message.usage; the size is input + cache creation + cache read (6.3)', () => {
  const asst = records.filter((r) => r.type === 'assistant');
  assert.ok(asst.length >= 2);
  const sizes = asst.map((r) => {
    assert.equal(r.isSidechain, false);
    const u = r.message.usage;
    for (const k of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) assert.equal(typeof u[k], 'number', k);
    return u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  });
  assert.deepEqual(sizes, [20002, 21002], 'the newest record gives the current size, after a resume too');
});

test('cost-state records hold running totals per model (camelCase); they are not the current size', () => {
  const cost = records.filter((r) => r.type === 'cost-state');
  assert.ok(cost.length >= 1);
  const lastCost = cost[cost.length - 1].modelUsage;
  const m = Object.values(lastCost)[0];
  assert.equal(typeof m.cacheReadInputTokens, 'number');
  assert.notEqual(m.inputTokens + m.cacheCreationInputTokens + m.cacheReadInputTokens, 21002);
  // The newest record in the file is a cost-state, after the newest assistant record.
  assert.equal(records[records.length - 1].type, 'cost-state');
});

test('a resume appends to the same file: a second session-owner record, the same session id', () => {
  // A mid-turn marker shows too, so the count is a floor, not an exact number.
  assert.ok(records.filter((r) => r.type === 'session-owner').length >= 2);
  assert.equal(new Set(records.map((r) => r.sessionId)).size, 1);
});
