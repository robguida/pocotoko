'use strict';
// The meter's --sync (spec 6.2, 6.7, SR-C1): no path argument; plugin mode only; the target
// computed from CLAUDE_PLUGIN_DATA alone; copies only on a byte change; writes the config the
// status line reads; refuses a planted link. Tests go through the test-only entry that refuses
// any target outside sandbox/.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../../src/core/hooks/meter.cjs');
const H = require('../helpers/meter-env.cjs');
const R = require('../helpers/meter-run.cjs');

test.after(() => H.cleanup());

function syncOf(b, kit, env, extra = {}) {
  return M.syncForTest({ env, scriptFile: kit.scriptFile, home: b.home, gitCeiling: b.base, ...extra }, b.base);
}

test('SR-C1: --sync with a path argument is refused and writes nothing (function and command line)', () => {
  const b = H.makeBase('arg');
  const plug = H.pluginKit(b);
  const before = H.listing(b.base);
  const r = syncOf(b, plug, H.pluginEnv(b, plug), { args: [path.join(b.base, 'elsewhere')] });
  assert.deepEqual(r, { done: false, reason: 'path_argument_refused', copied: false, configWritten: false });
  const run = R.runMeter(b, { scriptFile: plug.scriptFile, args: ['--sync', path.join(b.base, 'elsewhere')], env: H.pluginEnv(b, plug) });
  assert.equal(run.status, 0);
  assert.equal(run.text.trim(), 'sync: skipped (path_argument_refused)');
  assert.deepEqual(H.listing(b.base), before);
});

test('6.7: sync copies meter.cjs only when the bytes differ, and only under the data folder', () => {
  const b = H.makeBase('copy');
  const plug = H.pluginKit(b);
  const env = H.pluginEnv(b, plug);
  const r1 = syncOf(b, plug, env);
  assert.equal(r1.done, true);
  assert.equal(r1.copied, true);
  const target = path.join(plug.data, 'statusline', 'meter.cjs');
  assert.ok(fs.readFileSync(target).equals(fs.readFileSync(plug.scriptFile)));
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(target, old, old);
  const mtime = fs.statSync(target).mtimeMs;
  const r2 = syncOf(b, plug, env);
  assert.equal(r2.copied, false, 'same bytes: no copy');
  assert.equal(fs.statSync(target).mtimeMs, mtime);
  fs.appendFileSync(plug.scriptFile, '// changed\n');
  const r3 = syncOf(b, plug, env);
  assert.equal(r3.copied, true);
  assert.ok(fs.readFileSync(target).equals(fs.readFileSync(plug.scriptFile)));
  // Everything written sits under the data folder.
  for (const k of Object.keys(H.listing(plug.data))) assert.ok(/^(statusline|config)(\/|$)/.test(k), k);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(plug.data, 'statusline')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  }
});

test('6.7: nothing when the variable is unset or the script is not in plugin mode (copy-by-hand, a moved plugin cache); the test entry refuses a data folder outside sandbox/', () => {
  const b = H.makeBase('modes');
  const plug = H.pluginKit(b);
  const copy = H.copyKit(b);
  const before = H.listing(b.base);
  const noVar = { CLAUDE_CONFIG_DIR: b.config };
  assert.equal(syncOf(b, plug, noVar).reason, 'not_plugin_mode');
  assert.equal(syncOf(b, plug, { ...noVar, CLAUDE_PLUGIN_DATA: '' }).reason, 'not_plugin_mode');
  assert.equal(syncOf(b, copy, H.pluginEnv(b, plug)).reason, 'not_plugin_mode', 'variable set but script outside the cache');
  assert.equal(syncOf(b, plug, { ...H.pluginEnv(b, plug), CLAUDE_CODE_PLUGIN_CACHE_DIR: H.mk(b.base, 'moved') }).reason, 'not_plugin_mode');
  assert.deepEqual(Object.keys(H.listing(b.base)).filter((k) => !(k in before)), ['moved/']);
  const outside = path.resolve(H.REPO_TOP, '..', 'never-' + process.pid);
  const r = M.syncForTest({ env: { ...H.pluginEnv(b, plug), CLAUDE_PLUGIN_DATA: outside }, scriptFile: plug.scriptFile, home: b.home }, b.base);
  assert.equal(r.reason, 'outside_sandbox');
  assert.ok(!fs.existsSync(outside));
});

test('6.7 / SR-C2: a statusline/ folder (or config/ folder) pre-planted as a link or junction is refused; nothing is written through it', () => {
  for (const which of ['statusline', 'config']) {
    const b = H.makeBase('planted-' + which);
    const plug = H.pluginKit(b);
    const outside = H.mk(b.base, 'outside');
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    H.dirLink(outside, path.join(plug.data, which));
    const before = H.listing(outside);
    const r = syncOf(b, plug, H.pluginEnv(b, plug));
    assert.equal(r.done, false, which);
    assert.equal(r.reason, 'folder_link', which);
    assert.deepEqual(H.listing(outside), before, which);
  }
});

test('6.2 / 6.7: sync writes config/meter-config.json from the current options; the status line then uses the same values and gives the same tier as the prompt hook', () => {
  const b = H.makeBase('config');
  const plug = H.pluginKit(b);
  const env = H.pluginEnv(b, plug, { soft_tokens: 120000, hard_tokens: 130000, handoff_note: false });
  assert.equal(syncOf(b, plug, env).configWritten, true);
  const cfg = JSON.parse(fs.readFileSync(path.join(plug.data, 'config', 'meter-config.json'), 'utf8'));
  assert.deepEqual(cfg, { soft_tokens: '120000', hard_tokens: '130000', handoff_note: 'false' });
  const copyFile = path.join(plug.data, 'statusline', 'meter.cjs');
  const slCtx = { env: { CLAUDE_CONFIG_DIR: b.config, NO_COLOR: '1' }, scriptFile: copyFile, home: b.home };
  assert.equal(M.statusLine({ context_window: { total_input_tokens: 125000 } }, slCtx), 'chat 125k getting long (warn 120k/130k)');
  const hook = M.handlePrompt(H.promptInput(b, H.writeTranscript(b, 125000)), H.ctxFor(b, plug, env));
  assert.match(hook.hookSpecificOutput.additionalContext, /first warning size \(120k\)/);
  // An invalid value gives the same fall-back to defaults from both sources.
  const bad = H.pluginEnv(b, plug, { soft_tokens: 9999 });
  syncOf(b, plug, bad);
  assert.equal(M.statusLine({ context_window: { total_input_tokens: 125000 } }, slCtx), 'chat 125k getting long (warn 100k/150k)');
  assert.deepEqual(M.loadOptions({ source: 'env', env: bad }), M.loadOptions({ source: 'file', configFile: path.join(plug.data, 'config', 'meter-config.json') }));
});

test('6.7 / SR-C8: a data folder inside a git work tree -> sync writes nothing', () => {
  const b = H.makeBase('git');
  const plug = H.pluginKit(b);
  fs.mkdirSync(path.join(b.config, '.git'));
  const before = H.listing(b.base);
  assert.equal(syncOf(b, plug, H.pluginEnv(b, plug)).reason, 'in_git');
  assert.deepEqual(H.listing(b.base), before);
});

test('6.7: sync removes its own leftover temp files older than 10 minutes in statusline/ and config/', () => {
  const b = H.makeBase('temps');
  const plug = H.pluginKit(b);
  const sl = H.mk(plug.data, 'statusline');
  const old = 'meter.cjs.77.0123456789abcdef.tmp';
  const young = 'meter.cjs.78.0123456789abcdef.tmp';
  fs.writeFileSync(path.join(sl, old), 'x');
  fs.writeFileSync(path.join(sl, young), 'x');
  H.setMtime(path.join(sl, old), 11 * 60 * 1000);
  syncOf(b, plug, H.pluginEnv(b, plug));
  const left = fs.readdirSync(sl).sort();
  assert.deepEqual(left, ['meter.cjs', young].sort());
});
