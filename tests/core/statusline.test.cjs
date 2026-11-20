'use strict';
// The meter's status line (spec 6.2, 6.3, 6.4, 6.13): rendering, rounding, colours,
// NO_COLOR, config read, never writes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../../src/core/hooks/meter.cjs');
const H = require('../helpers/meter-env.cjs');
const R = require('../helpers/meter-run.cjs');

test.after(() => H.cleanup());

const D = M.DEFAULTS;
const ESC = String.fromCharCode(27);

test('6.13: the exact line per tier, ASCII only', () => {
  assert.equal(M.renderStatusLine(50000, D, { noColor: true }), 'chat 50k (warn 100k/150k)');
  assert.equal(M.renderStatusLine(100000, D, { noColor: true }), 'chat 100k getting long (warn 100k/150k)');
  assert.equal(M.renderStatusLine(150000, D, { noColor: true }), 'chat 150k NEW SESSION NOW (warn 100k/150k)');
  for (const s of [null, 1, 99999, 100000, 150000, 2500000]) {
    const line = M.renderStatusLine(s, D, { noColor: true });
    assert.ok(/^[\x20-\x7e]+$/.test(line), line);
  }
});

test('6.4: k and M rounding at the boundaries; the tier is decided on the raw integer', () => {
  const cases = [[1499, '1k'], [1500, '2k'], [999499, '999k'], [999500, '1.0M'], [999999, '1.0M'], [1000000, '1.0M'], [1500000, '1.5M'], [1049999, '1.0M'], [1050000, '1.1M']];
  for (const [n, want] of cases) assert.equal(M.fmtSize(n), want, String(n));
  assert.equal(M.renderStatusLine(99600, D, { noColor: true }), 'chat 100k (warn 100k/150k)', '99,600 shows 100k but stays quiet');
});

test('6.4 / 6.13: green, yellow and red by tier; none with NO_COLOR', () => {
  assert.equal(M.renderStatusLine(50000, D), ESC + '[32m' + 'chat 50k (warn 100k/150k)' + ESC + '[0m');
  assert.equal(M.renderStatusLine(100000, D), ESC + '[33m' + 'chat 100k getting long (warn 100k/150k)' + ESC + '[0m');
  assert.equal(M.renderStatusLine(150000, D), ESC + '[31m' + 'chat 150k NEW SESSION NOW (warn 100k/150k)' + ESC + '[0m');
  const b = H.makeBase('colour');
  const kit = H.copyKit(b);
  const input = { context_window: { total_input_tokens: 150000 } };
  assert.ok(!M.statusLine(input, H.ctxFor(b, kit, { NO_COLOR: '1' })).includes(ESC));
  assert.ok(M.statusLine(input, H.ctxFor(b, kit, {})).includes(ESC + '[31m'));
  assert.ok(M.statusLine(input, H.ctxFor(b, kit, { NO_COLOR: '' })).includes(ESC), 'an empty NO_COLOR is not set');
});

test('6.3 / 6.13: full, empty and null inputs; total_input_tokens 0 or missing with current_usage null -> chat --; total missing but current_usage present -> the three-part sum', () => {
  const size = (input) => M.statusSize(input);
  assert.equal(size({ context_window: { total_input_tokens: 123456, current_usage: { input_tokens: 1 } } }), 123456);
  assert.equal(size({ context_window: { total_input_tokens: 0, current_usage: null } }), null);
  assert.equal(size({ context_window: { current_usage: null } }), null);
  assert.equal(size({ context_window: {} }), null);
  assert.equal(size({}), null);
  assert.equal(size(null), null);
  assert.equal(size({ context_window: { current_usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 99970, output_tokens: 5 } } }), 100000);
  assert.equal(M.renderStatusLine(size({ context_window: { total_input_tokens: 0, current_usage: null } }), D, { noColor: true }), 'chat -- (warn 100k/150k)');
  assert.ok(M.renderStatusLine(null, D).startsWith('chat --'), 'no colour on the empty line either');
});

test('6.2: the status line reads the kit config (copy-by-hand) and the data config (plugin status line copy); an invalid config -> default thresholds and still renders', () => {
  const b = H.makeBase('cfg');
  const kit = H.copyKit(b);
  fs.mkdirSync(path.join(kit.stateRoot, 'config'));
  const cfg = path.join(kit.stateRoot, 'config', 'meter-config.json');
  fs.writeFileSync(cfg, JSON.stringify({ soft_tokens: 120000, hard_tokens: 130000 }));
  const input = { context_window: { total_input_tokens: 125000 } };
  assert.equal(M.statusLine(input, H.ctxFor(b, kit, { NO_COLOR: '1' })), 'chat 125k getting long (warn 120k/130k)');
  for (const bad of [{ soft_tokens: 9999 }, { soft_tokens: 140000, hard_tokens: 130000 }, '{oops']) {
    fs.writeFileSync(cfg, typeof bad === 'string' ? bad : JSON.stringify(bad));
    assert.equal(M.statusLine(input, H.ctxFor(b, kit, { NO_COLOR: '1' })), 'chat 125k getting long (warn 100k/150k)');
  }
  // The plugin status line copy at <data>/statusline/meter.cjs gets no plugin variables; it
  // reads <data>/config/meter-config.json.
  const plug = H.pluginKit(b);
  const slDir = H.mk(plug.data, 'statusline');
  const copyFile = path.join(slDir, 'meter.cjs');
  fs.copyFileSync(H.METER_SRC, copyFile);
  H.mk(plug.data, 'config');
  fs.writeFileSync(path.join(plug.data, 'config', 'meter-config.json'), JSON.stringify({ soft_tokens: '110000', hard_tokens: '160000' }));
  const env = { CLAUDE_CONFIG_DIR: b.config, NO_COLOR: '1' };
  assert.equal(M.statusConfigFile({ env, scriptFile: copyFile, home: b.home, platform: process.platform }), path.join(plug.data, 'config', 'meter-config.json'));
  assert.equal(M.statusLine(input, { env, scriptFile: copyFile, home: b.home }), 'chat 125k getting long (warn 110k/160k)');
});

test('6.2 / 6.7: a config/ folder that is a link or junction, or sits under a linked parent, is not read by the status line (default thresholds, still renders)', () => {
  const b = H.makeBase('cfglink');
  const kit = H.copyKit(b);
  const outside = H.mk(b.base, 'outside');
  fs.writeFileSync(path.join(outside, 'meter-config.json'), JSON.stringify({ soft_tokens: 120000, hard_tokens: 130000 }));
  H.dirLink(outside, path.join(kit.stateRoot, 'config'));
  const input = { context_window: { total_input_tokens: 125000 } };
  assert.equal(M.statusLine(input, H.ctxFor(b, kit, { NO_COLOR: '1' })), 'chat 125k getting long (warn 100k/150k)');
  // A real config/ folder under a linked parent: not read either (the real-path compare).
  const other = H.mk(b.base, 'other-data');
  H.mk(other, 'config');
  fs.writeFileSync(path.join(other, 'config', 'meter-config.json'), JSON.stringify({ soft_tokens: 110000, hard_tokens: 160000 }));
  const viaLink = path.join(H.dirLink(other, path.join(b.base, 'linked-data')), 'config', 'meter-config.json');
  assert.deepEqual(M.loadOptions({ source: 'file', configFile: viaLink }), { options: { ...M.DEFAULTS }, invalid: true }, 'linked parent: not read');
  assert.equal(M.loadOptions({ source: 'file', configFile: path.join(other, 'config', 'meter-config.json') }).options.soft_tokens, 110000, 'control: the real path is read');
  assert.deepEqual(M.loadOptions({ source: 'file', configFile: path.join(other, 'nope', 'meter-config.json') }), { options: { ...M.DEFAULTS }, invalid: false }, 'missing folder: defaults, no notice');
});

test('6.5 / 6.13: the status line never writes, as a real process; output is one ASCII line', () => {
  const b = H.makeBase('nowrite');
  const plug = H.pluginKit(b);
  const before = H.listing(b.base);
  for (const total of [0, 50000, 100000, 150000, 1500000]) {
    const r = R.runMeter(b, { scriptFile: plug.scriptFile, args: ['--statusline'], input: JSON.stringify({ context_window: { total_input_tokens: total } }), env: H.pluginEnv(b, plug) });
    assert.equal(r.status, 0);
    const lines = r.text.split('\n').filter((l) => l !== '');
    assert.equal(lines.length, 1);
    assert.ok(/^[\x20-\x7e]+$/.test(lines[0]), lines[0]);
    assert.ok(lines[0].startsWith(total ? 'chat ' + M.fmtSize(total) : 'chat --'));
  }
  const garbage = R.runMeter(b, { scriptFile: plug.scriptFile, args: ['--statusline'], input: 'not json', env: H.pluginEnv(b, plug) });
  assert.equal(garbage.status, 0);
  assert.equal(garbage.text.trim(), 'chat -- (warn 100k/150k)');
  assert.deepEqual(H.listing(b.base), before, 'nothing written');
});
