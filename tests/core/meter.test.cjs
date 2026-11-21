'use strict';
// The chat-length meter, prompt hook half (spec 6.1 to 6.9, SR-C2 to SR-C4, SR-C6 to SR-C10;
// T-21, T-25, T-30, T-35, T-36 and T-38, core parts). The status line is in
// statusline.test.cjs and --sync in sync.test.cjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const M = require('../../src/core/hooks/meter.cjs');
const FSX = require('../../src/search/server/fsx.cjs');
const F = require('../helpers/fake-values.cjs');
const H = require('../helpers/meter-env.cjs');
const R = require('../helpers/meter-run.cjs');

const IS_WIN = process.platform === 'win32';
test.after(() => H.cleanup());

function ctxOf(b, kit, env, extra) {
  return H.ctxFor(b, kit, env, extra);
}
function stateFiles(kit) {
  const d = path.join(kit.stateRoot, 'state', 'sessions');
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
}
function noteFiles(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.md')) : [];
}
function writeConfig(kit, obj) {
  const d = path.join(kit.stateRoot, 'config');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'meter-config.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
}
/** A copy-mode run at a size, with a fresh transcript file per call. */
function promptAt(b, kit, env, size, sid, extra = {}) {
  const t = H.writeTranscript(b, size, { name: 'chat-' + crypto.randomBytes(4).toString('hex') });
  return M.handlePrompt(H.promptInput(b, t, sid, extra.input || {}), ctxOf(b, kit, env, extra.ctx || {}));
}
function noBlocking(out) {
  if (!out) return;
  assert.ok(!('decision' in out) && !('continue' in out) && !('stopReason' in out), 'no blocking field');
}

// ---------------------------------------------------------------------------
// 6.1: exports, DEFAULTS, require runs nothing

test('6.1: DEFAULTS and the size and tier functions are exported; DEFAULTS equal the 6.2 table and the core manifest (keys, types, defaults, minimums)', () => {
  assert.deepEqual({ ...M.DEFAULTS }, { soft_tokens: 100000, hard_tokens: 150000, repeat_every_tokens: 50000, handoff_note: true, handoff_dir: '', routing_rules_at_start: true });
  for (const f of ['usageSum', 'tierOf', 'tierStep', 'readTranscriptSize', 'fmtSize', 'handlePrompt', 'statusLine', 'sync']) assert.equal(typeof M[f], 'function', f);
  const plugin = JSON.parse(fs.readFileSync(path.join(H.REPO_TOP, 'src', 'core', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.deepEqual(Object.keys(plugin.userConfig).sort(), Object.keys(M.DEFAULTS).sort());
  const types = { number: 'number', boolean: 'boolean', directory: 'directory' };
  for (const [k, rule] of Object.entries(M.OPTION_RULES)) {
    const o = plugin.userConfig[k];
    assert.equal(o.type, types[rule.type], k + ' type');
    assert.deepEqual(o.default, M.DEFAULTS[k], k + ' default');
    if (rule.min !== undefined) assert.equal(o.min, rule.min, k + ' min');
    assert.ok(o.title && o.description, k + ' title and description');
  }
  assert.ok(!('node_path' in plugin.userConfig));
});

test('6.1: loading meter.cjs runs nothing (no stdin read, no exit, no output); the start check is a process.argv[1] own-file check', () => {
  const b = H.makeBase('require');
  const kit = H.copyKit(b);
  const code = `require(${JSON.stringify(kit.scriptFile)}); setTimeout(() => process.stdout.write('still-alive'), 300);`;
  const r = require('node:child_process').spawnSync(process.execPath, ['-e', code], { cwd: b.proj, env: R.childEnv(b), input: '', windowsHide: true, timeout: 10000 });
  assert.equal(r.status, 0);
  assert.equal(String(r.stdout), 'still-alive');
  const src = fs.readFileSync(H.METER_SRC, 'utf8');
  assert.ok(!/require\.main/.test(src), 'no require.main (T-14)');
  assert.match(src, /process\.argv\[1\]/);
});

test('10.10 / 2.2: hooks.json registers UserPromptSubmit in exec form (row 1): top-level hooks key, command node, args under ${CLAUDE_PLUGIN_ROOT}/hooks/, timeout 5, no option in the launch', () => {
  const j = JSON.parse(fs.readFileSync(path.join(H.REPO_TOP, 'src', 'core', 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(j), ['hooks']);
  // B3 added SessionStart; consistency.test.cjs checks exactly two events.
  assert.ok(Array.isArray(j.hooks.UserPromptSubmit));
  const h = j.hooks.UserPromptSubmit[0].hooks[0];
  assert.deepEqual(h, { type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/meter.cjs'], timeout: 5 });
  assert.ok(fs.existsSync(path.join(H.REPO_TOP, 'src', 'core', 'hooks', 'meter.cjs')));
  const all = JSON.stringify(j);
  assert.ok(!all.includes('user_config'), 'no ${user_config...} anywhere');
  for (const bad of ['npx', '.cmd', '.bat', 'cmd.exe', 'powershell', 'bash', '&', '|', ';', '$(']) assert.ok(!all.toLowerCase().includes(bad), bad);
  assert.ok(!fs.readFileSync(path.join(H.REPO_TOP, 'src', 'core', 'hooks', 'hooks.json'), 'utf8').includes('\r'));
});

test('2.2: meter.cjs holds the kit name only as the display form opening the fixed 6.9 line', () => {
  const src = fs.readFileSync(H.METER_SRC, 'utf8');
  const lower = src.toLowerCase();
  const name = JSON.parse(fs.readFileSync(path.join(H.REPO_TOP, 'src', 'core', '.claude-plugin', 'plugin.json'), 'utf8')).name;
  assert.equal(lower.split(name).length - 1, 1, 'one occurrence');
  assert.ok(M.LINES.NODE_IN_PROJECT.toLowerCase().startsWith(name + ':'));
  assert.ok(!/[^\x00-\x7f]/.test(src), 'meter.cjs source is ASCII');
  assert.ok(!src.includes('\r'));
});

// ---------------------------------------------------------------------------
// 6.4: tiers, edges, rounding

test('6.4: tiers use >= on the raw integer; 99,600 shows as 100k but is still quiet when soft is 100,000', () => {
  const o = M.DEFAULTS;
  assert.equal(M.tierOf(99999, o), 'quiet');
  assert.equal(M.tierOf(100000, o), 'soft');
  assert.equal(M.tierOf(149999, o), 'soft');
  assert.equal(M.tierOf(150000, o), 'hard');
  assert.equal(M.fmtSize(99600), '100k');
  assert.equal(M.tierOf(99600, o), 'quiet');
  assert.equal(M.tierStep({}, 99600, o).fire, null);
});

test('6.4 / 6.5: once per tier; below soft re-arms both; the repeat fires at H + repeat_every_tokens and not one token before, then H moves', () => {
  const o = { ...M.DEFAULTS };
  let s = {};
  const step = (size) => { const r = M.tierStep(s, size, o); s = r.state; return r.fire; };
  assert.equal(step(100000), 'soft');
  assert.equal(step(110000), null);
  assert.equal(step(150000), 'hard');
  assert.equal(step(160000), null);
  assert.equal(step(150000 + 50000 - 1), null);
  assert.equal(step(150000 + 50000), 'repeat');
  assert.equal(s.hard_at, 200000);
  assert.equal(step(249999), null);
  assert.equal(step(250000), 'repeat');
  assert.equal(step(120000), null, 'back to the soft range: no new soft warning');
  assert.equal(step(50000), null);
  assert.deepEqual(s, { soft: false, hard: false, hard_at: null });
  assert.equal(step(100000), 'soft', 're-armed');
  assert.equal(step(150000), 'hard', 're-armed');
  const once = { ...o, repeat_every_tokens: 0 };
  let t = M.tierStep({}, 150000, once).state;
  assert.equal(M.tierStep(t, 900000, once).fire, null, 'repeat_every_tokens 0 means once');
  t = M.tierStep({}, 300000, o);
  assert.equal(t.fire, 'hard', 'a jump straight past hard fires hard');
});

// ---------------------------------------------------------------------------
// 6.3: size from the transcript

test('6.3: the real-shape fixture gives the newest main-thread sum (21002), never a cost-state running total', () => {
  const r = M.readTranscriptSize(H.FIXTURE);
  assert.equal(r.status, 'found');
  assert.equal(r.size, 21002);
  assert.notEqual(r.size, 4 + 36500 + 4500, 'not the cost-state totals');
});

test('6.3: a side-chain record is ignored; a record with only cache counts still counts; a record with no usage parts is skipped', () => {
  const b = H.makeBase('size');
  const lines = H.FIXTURE_LINES.concat([
    H.assistantLine({ input: 10, create: 20, read: 30 }),
    H.assistantLine({ usage: { cache_read_input_tokens: 70000 } }),
    H.assistantLine({ input: 999999, sidechain: true }),
    H.assistantLine({ usage: { output_tokens: 5 } }),
  ]);
  const f = H.writeTranscript(b, lines.join('\n') + '\n');
  const r = M.readTranscriptSize(f);
  assert.equal(r.size, 70000);
  assert.equal(M.usageSum({ input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 100 }), 6);
  assert.equal(M.usageSum({ input_tokens: -1 }), null);
  assert.equal(M.usageSum({ input_tokens: '5' }), null);
  assert.equal(M.usageSum(null), null);
});

test('6.3: a compaction record newer than any usage record gives size 0 (default record shape, and through the test seam)', () => {
  const b = H.makeBase('compact');
  const comp = JSON.stringify({ type: 'system', subtype: 'compact_boundary', isSidechain: false });
  const f = H.writeTranscript(b, H.transcriptText(180000, { extra: [comp] }));
  assert.equal(M.readTranscriptSize(f).size, 0);
  const g = H.writeTranscript(b, H.FIXTURE_LINES.concat([comp, H.assistantLine({ input: 5000 })]).join('\n') + '\n', { name: 'g' });
  assert.equal(M.readTranscriptSize(g).size, 5000, 'usage after the compaction wins');
  const seam = { marker: 'probe-compaction', test: (rec) => rec.type === 'probe-compaction' };
  const h = H.writeTranscript(b, H.transcriptText(180000, { extra: [JSON.stringify({ type: 'probe-compaction' })] }), { name: 'h' });
  assert.equal(M.readTranscriptSize(h, { compaction: seam }).size, 0);
  assert.equal(M.readTranscriptSize(h).size, 180000, 'unknown record without the seam: ignored');
});

test('6.3: a newest assistant record whose three-part sum is 0 (an API-error record) is skipped and the read looks back; the hard warning is not repeated and no second note is made', () => {
  const b = H.makeBase('zero');
  const real = H.assistantLine({ input: 2, read: 149998 });
  const zeroes = [H.assistantLine({}), H.assistantLine({ usage: { input_tokens: 0, output_tokens: 0 } })];
  const f = H.writeTranscript(b, H.FIXTURE_LINES.concat([real], zeroes).join('\n') + '\n');
  const r = M.readTranscriptSize(f);
  assert.equal(r.status, 'found');
  assert.equal(r.size, 150000, 'the record before the zero-sum ones');
  const comp = JSON.stringify({ type: 'system', subtype: 'compact_boundary', isSidechain: false });
  const g = H.writeTranscript(b, H.FIXTURE_LINES.concat([real, comp], zeroes).join('\n') + '\n', { name: 'g' });
  assert.equal(M.readTranscriptSize(g).size, 0, 'only a compaction record gives 0');
  // Through the hook: hard once, then a zero-sum newest record, then a bigger chat below the repeat.
  const kit = H.copyKit(b);
  const env = H.copyEnv(b);
  const sid = H.sessionId(610);
  assert.ok(promptAt(b, kit, env, 150000, sid).hookSpecificOutput, 'hard fires');
  const z = H.writeTranscript(b, H.FIXTURE_LINES.concat([real], zeroes).join('\n') + '\n', { name: 'z' });
  assert.equal(M.handlePrompt(H.promptInput(b, z, sid), ctxOf(b, kit, env)), null, 'no re-arm');
  assert.equal(promptAt(b, kit, env, 160000, sid), null, 'no second hard warning');
  assert.equal(noteFiles(path.join(kit.stateRoot, 'handoff')).length, 1, 'one note only');
});

test('6.3: a transcript larger than the 64 MB read cap is still read from the end and finds the newest usage record; T-38: a 70 MB file with no usage exits 0 within the budget with at most the loud notice', () => {
  const b = H.makeBase('big');
  const filler = JSON.stringify({ type: 'attachment', pad: 'a'.repeat(1000) }) + '\n';
  const big = path.join(b.tdir, 'big.jsonl');
  const block = Buffer.from(filler.repeat(1024));
  const fd = fs.openSync(big, 'w');
  let n = 0;
  while (n < 70 * 1024 * 1024) { fs.writeSync(fd, block); n += block.length; }
  fs.closeSync(fd);
  const none = M.readTranscriptSize(big);
  assert.equal(none.status, 'none');
  // Spawned: exit 0 within the time budget, no tier warning.
  const kit = H.copyKit(b);
  const run = R.runMeter(b, { scriptFile: kit.scriptFile, input: JSON.stringify(H.promptInput(b, big)), env: H.copyEnv(b) });
  assert.equal(run.status, 0);
  assert.ok(run.ms < 4000, 'within budget: ' + run.ms);
  const out = run.text.trim() ? JSON.parse(run.text) : {};
  assert.ok(!out.hookSpecificOutput, 'no tier warning');
  assert.ok(!out.systemMessage || out.systemMessage === M.LINES.FORMAT);
  fs.appendFileSync(big, H.assistantLine({ input: 2, read: 123456 }) + '\n');
  const r = M.readTranscriptSize(big);
  assert.equal(r.status, 'found');
  assert.equal(r.size, 123458);
  fs.unlinkSync(big);
});

/**
 * A transcript of exactly `bytes` bytes with no usage record: an optional reply record whose
 * usage is in a shape the meter cannot read (a format change), then one padding record.
 */
function noUsageFile(b, name, bytes, { reply = true } = {}) {
  const lines = reply ? [JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', model: 'model-small-1', tokens: { in: 5 } } })] : [];
  const head = '{"type":"mode","pad":"';
  const tail = '"}\n';
  const lead = lines.map((l) => l + '\n').join('');
  const f = path.join(b.tdir, name + '.jsonl');
  fs.writeFileSync(f, lead + head + 'a'.repeat(bytes - lead.length - head.length - tail.length) + tail);
  assert.equal(fs.statSync(f).size, bytes);
  return f;
}

test('6.8: after a first prompt, a reply record with no readable usage at 262,144 bytes gives the loud notice, once per session; 262,143 bytes gives none; neither blocks', () => {
  const b = H.makeBase('floor');
  const kit = H.copyKit(b);
  const env = H.copyEnv(b);
  const small = H.writeTranscript(b, H.FIXTURE_LINES.slice(0, 2).join('\n') + '\n', { name: 'first' });
  const at = noUsageFile(b, 'at', M.LIMITS.SMALL_FLOOR);
  const under = noUsageFile(b, 'under', M.LIMITS.SMALL_FLOOR - 1);
  // The first prompt of each session creates its state file (no reply yet, no notice).
  assert.equal(M.handlePrompt(H.promptInput(b, small, H.sessionId(1)), ctxOf(b, kit, env)), null);
  assert.equal(M.handlePrompt(H.promptInput(b, small, H.sessionId(2)), ctxOf(b, kit, env)), null);
  const o1 = M.handlePrompt(H.promptInput(b, at, H.sessionId(1)), ctxOf(b, kit, env));
  assert.deepEqual(o1, { systemMessage: M.LINES.FORMAT });
  assert.equal(M.LINES.FORMAT, "chat-length meter cannot read this chat's format; it is off for this session");
  assert.equal(M.handlePrompt(H.promptInput(b, at, H.sessionId(1)), ctxOf(b, kit, env)), null, 'once per session');
  assert.equal(M.handlePrompt(H.promptInput(b, under, H.sessionId(2)), ctxOf(b, kit, env)), null);
  noBlocking(o1);
});

test('6.8: a session\'s first prompt never gives the notice: ~300 KB of attachment records and no reply record -> no notice and off stays false; the same file with no reply on a later prompt -> none either', () => {
  const b = H.makeBase('first');
  const kit = H.copyKit(b);
  const env = H.copyEnv(b);
  const pad = (kind, n) => JSON.stringify({ type: 'attachment', attachment: { type: kind, content: 'x'.repeat(n) } });
  // Shaped like the step 0c capture's first turn: a large instructions record, a prompt
  // snapshot and smaller attachments, a user record and a request copy with the user role only.
  const lines = [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
    pad('instructions', 213000),
    pad('skill_listing', 9000),
    pad('prompt_snapshot', 70000),
    pad('session_context', 4000),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } }),
    JSON.stringify({ type: 'api-request-blob', messages: [{ role: 'user' }] }),
  ];
  const f = H.writeTranscript(b, lines.join('\n') + '\n', { name: 'first-turn' });
  const size = fs.statSync(f).size;
  assert.ok(size >= 290000 && size > M.LIMITS.SMALL_FLOOR, 'about 300 KB: ' + size);
  const r = M.readTranscriptSize(f);
  assert.equal(r.status, 'none');
  assert.equal(r.counts.assistant_lines, 0);
  const sid = H.sessionId(820);
  assert.equal(M.handlePrompt(H.promptInput(b, f, sid), ctxOf(b, kit, env)), null, 'no notice on the first prompt');
  const statePath = path.join(kit.stateRoot, 'state', 'sessions', sid + '.json');
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).off, false, 'off stays false');
  // A later prompt, still with no reply record in the window: no notice, still not off.
  assert.equal(M.handlePrompt(H.promptInput(b, f, sid), ctxOf(b, kit, env)), null, 'no reply yet: no notice');
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).off, false);
  // A reply record with unreadable usage on the first prompt of a fresh session: still none.
  const g = noUsageFile(b, 'reply-first', M.LIMITS.SMALL_FLOOR + 1000);
  assert.equal(M.handlePrompt(H.promptInput(b, g, H.sessionId(821)), ctxOf(b, kit, env)), null, 'first prompt of the session');
  // Then the same session's next prompt: the notice.
  assert.deepEqual(M.handlePrompt(H.promptInput(b, g, H.sessionId(821)), ctxOf(b, kit, env)), { systemMessage: M.LINES.FORMAT });
});

test('6.8: after a failed first turn (only zero-sum usage records, an API-error reply) a second prompt at >= 256 KiB gives no notice and off stays false; usage missing or moved still gives it', () => {
  const b = H.makeBase('zerousage');
  const kit = H.copyKit(b);
  const env = H.copyEnv(b);
  const pad = (kind, n) => JSON.stringify({ type: 'attachment', attachment: { type: kind, content: 'x'.repeat(n) } });
  const head = [pad('instructions', 213000), pad('prompt_snapshot', 70000), JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } })];
  const zero = H.assistantLine({ usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
  const f = H.writeTranscript(b, head.concat([zero]).join('\n') + '\n', { name: 'failed-first-turn' });
  assert.ok(fs.statSync(f).size >= M.LIMITS.SMALL_FLOOR);
  const r = M.readTranscriptSize(f);
  assert.equal(r.status, 'none');
  assert.equal(r.counts.assistant_lines, 1);
  assert.equal(r.counts.readable_usage, 1, 'a zero-sum usage record is in the read shape');
  const sid = H.sessionId(830);
  const statePath = path.join(kit.stateRoot, 'state', 'sessions', sid + '.json');
  assert.equal(M.handlePrompt(H.promptInput(b, f, sid), ctxOf(b, kit, env)), null, 'prompt 1');
  assert.equal(M.handlePrompt(H.promptInput(b, f, sid), ctxOf(b, kit, env)), null, 'prompt 2: no notice');
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).off, false, 'off stays false');
  // The positive cases still fire on the second prompt: usage missing, and usage moved.
  const missing = JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', model: 'model-small-1' } });
  const moved = JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', model: 'model-small-1', tokens: { input_tokens: 5 } } });
  let k = 831;
  for (const [label, rec] of [['missing', missing], ['moved', moved]]) {
    const g = H.writeTranscript(b, head.concat([rec]).join('\n') + '\n', { name: 'fmt-' + label });
    const s = H.sessionId(k++);
    assert.equal(M.handlePrompt(H.promptInput(b, g, s), ctxOf(b, kit, env)), null, label + ': prompt 1');
    assert.deepEqual(M.handlePrompt(H.promptInput(b, g, s), ctxOf(b, kit, env)), { systemMessage: M.LINES.FORMAT }, label + ': prompt 2');
  }
});

test('6.3 / T-38: a missing transcript, a folder and an empty or non-string path give no output', () => {
  const b = H.makeBase('missing');
  const kit = H.copyKit(b);
  const env = H.copyEnv(b);
  for (const t of [path.join(b.tdir, 'nope.jsonl'), b.tdir, '', 42]) {
    assert.equal(M.handlePrompt(H.promptInput(b, t), ctxOf(b, kit, env)), null, String(t));
  }
});

test('T-38 (POSIX): a transcript_path naming a FIFO -> exit 0 within the budget, no output, no hang', { skip: IS_WIN && 'POSIX only: Windows has no FIFO in the file system; proven by CI on macOS and Linux' }, () => {
  const b = H.makeBase('fifo');
  const kit = H.copyKit(b);
  const fifo = path.join(b.tdir, 'pipe');
  const mk = require('node:child_process').spawnSync('mkfifo', [fifo]);
  assert.equal(mk.status, 0, 'mkfifo');
  const run = R.runMeter(b, { scriptFile: kit.scriptFile, input: JSON.stringify(H.promptInput(b, fifo)), env: H.copyEnv(b) });
  assert.equal(run.status, 0);
  assert.ok(run.ms < 4000);
  assert.equal(run.text.trim(), '');
});

test('6.6 / 6.7 (POSIX): the hand-off folder and the state folders are 0700; the note and the state file are 0600, even with a loose umask', { skip: IS_WIN && 'POSIX only: Windows file modes are not checked (SR-23); proven by CI on macOS and Linux' }, () => {
  const b = H.makeBase('modes');
  const kit = H.copyKit(b);
  const old = process.umask(0o000);
  try {
    promptAt(b, kit, H.copyEnv(b), 150000, H.sessionId(500));
  } finally {
    process.umask(old);
  }
  const mode = (...p) => fs.statSync(path.join(kit.stateRoot, ...p)).mode & 0o777;
  assert.equal(mode('handoff'), 0o700);
  assert.equal(mode('state'), 0o700);
  assert.equal(mode('state', 'sessions'), 0o700);
  const note = noteFiles(path.join(kit.stateRoot, 'handoff'))[0];
  assert.equal(mode('handoff', note), 0o600);
  const sf = fs.readdirSync(path.join(kit.stateRoot, 'state', 'sessions'))[0];
  assert.equal(mode('state', 'sessions', sf), 0o600);
});

// ---------------------------------------------------------------------------
// 6.5: hook output through the full prompt path

test('6.5: soft fires once with additionalContext plus a short systemMessage; hard pre-creates the note and names its exact path; below soft re-arms', () => {
  const b = H.makeBase('flow');
  const kit = H.copyKit(b);
  const env = H.copyEnv(b);
  const sid = H.sessionId(3);
  assert.equal(promptAt(b, kit, env, 50000, sid), null, 'quiet');
  const soft = promptAt(b, kit, env, 100000, sid);
  assert.equal(soft.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(soft.hookSpecificOutput.additionalContext, /about 100k tokens; finish this step, then start a new session/);
  assert.ok(soft.systemMessage.length < 200);
  noBlocking(soft);
  assert.equal(promptAt(b, kit, env, 120000, sid), null, 'soft once');
  const hard = promptAt(b, kit, env, 150000, sid);
  const notes = noteFiles(path.join(kit.stateRoot, 'handoff'));
  assert.equal(notes.length, 1);
  const notePath = path.join(kit.stateRoot, 'handoff', notes[0]);
  assert.equal(fs.readFileSync(notePath, 'utf8'), '', 'pre-created empty');
  assert.ok(hard.hookSpecificOutput.additionalContext.includes(notePath), 'names that exact path');
  assert.ok(hard.hookSpecificOutput.additionalContext.includes('start fresh and read ' + notePath));
  assert.ok(hard.systemMessage.includes(notePath));
  noBlocking(hard);
  assert.equal(promptAt(b, kit, env, 160000, sid), null, 'hard once');
  assert.equal(promptAt(b, kit, env, 20000, sid), null, 'below soft: quiet');
  assert.ok(promptAt(b, kit, env, 100000, sid).hookSpecificOutput, 'soft fires again after re-arm');
  assert.ok(promptAt(b, kit, env, 150000, sid).hookSpecificOutput, 'hard fires again after re-arm');
  if (!IS_WIN) {
    assert.equal(fs.statSync(path.join(kit.stateRoot, 'handoff')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(notePath).mode & 0o777, 0o600);
  }
});

test('6.4 / 6.5 (hook): a repeat at H + repeat_every_tokens warns again with a new note file; repeat_every_tokens 0 never repeats', () => {
  const b = H.makeBase('repeat');
  const kit = H.copyKit(b);
  const env = H.copyEnv(b);
  const sid = H.sessionId(4);
  let n = 0;
  const now = () => new Date(2000 + 26, 0, 5, 3, n++);
  assert.ok(promptAt(b, kit, env, 150000, sid, { ctx: { now } }).hookSpecificOutput);
  assert.equal(promptAt(b, kit, env, 199999, sid, { ctx: { now } }), null);
  const rep = promptAt(b, kit, env, 200000, sid, { ctx: { now } });
  assert.ok(rep.hookSpecificOutput);
  assert.equal(noteFiles(path.join(kit.stateRoot, 'handoff')).length, 2);
  writeConfig(kit, { repeat_every_tokens: 0 });
  const sid2 = H.sessionId(5);
  assert.ok(promptAt(b, kit, env, 150000, sid2).hookSpecificOutput);
  assert.equal(promptAt(b, kit, env, 900000, sid2), null);
});

test('6.5 / 6.6: handoff_note false -> at the hard tier no file is created and no path is named', () => {
  const b = H.makeBase('nonote');
  const kit = H.copyKit(b);
  writeConfig(kit, { handoff_note: false });
  const out = promptAt(b, kit, H.copyEnv(b), 150000, H.sessionId(6));
  assert.ok(out.hookSpecificOutput);
  assert.ok(!fs.existsSync(path.join(kit.stateRoot, 'handoff')));
  assert.ok(!/hand-off note/i.test(out.hookSpecificOutput.additionalContext));
});

// ---------------------------------------------------------------------------
// 6.6: hand-off names and pre-create

test('6.6: name parts are cleaned to [A-Za-z0-9_-] with runs collapsed and capped; empty -> session; the session part is the first 8 characters of the cleaned id; the whole name is at most 80 characters', () => {
  const nasty = 'a/b' + F.BS + 'c..d e\u0001\u0007f' + 'x'.repeat(200);
  const c = M.cleanPart(nasty, 40);
  assert.match(c, /^[A-Za-z0-9_-]{1,40}$/);
  assert.ok(!c.includes('--'));
  assert.equal(M.cleanPart('..', 40), 'session');
  assert.equal(M.cleanPart('éé', 40), 'session');
  assert.equal(M.cleanPart(' -- ', 40), 'session');
  const d = new Date(2000 + 26, 0, 5, 3, 5);
  const sid = M.cleanSessionId('ABCDEF0123456789');
  const base = M.noteBaseName(d, path.join(H.REPO_TOP, 'x'.repeat(200)), sid);
  assert.ok(base.length <= 80);
  assert.ok(base.endsWith('-abcdef01'));
  assert.ok(base.startsWith(F.isoDate(2000 + 26, 1, 5) + '-0305-'), 'local YYYY-MM-DD-HHmm, zero-padded');
  assert.equal(M.datePart(d), F.isoDate(2000 + 26, 1, 5) + '-0305');
  const hashed = M.cleanSessionId('a/b');
  assert.ok(M.noteBaseName(d, 'proj', hashed).endsWith('-' + hashed.slice(0, 8)));
  assert.ok(M.noteBaseName(d, '', sid).includes('-session-'));
});

test('6.6 a / SR-C4: a pre-existing file at the name -> -2 is used and the original is untouched; -2 to -9 taken -> stops with a message and writes nothing', () => {
  const b = H.makeBase('clash');
  const kit = H.copyKit(b);
  const env = H.copyEnv(b);
  const now = () => new Date(2000 + 26, 0, 5, 3, 5);
  const dir = path.join(kit.stateRoot, 'handoff');
  fs.mkdirSync(dir);
  const base = M.noteBaseName(now(), b.proj, M.cleanSessionId(H.sessionId(7)));
  fs.writeFileSync(path.join(dir, base + '.md'), 'original');
  const out = promptAt(b, kit, env, 150000, H.sessionId(7), { ctx: { now } });
  assert.ok(out.hookSpecificOutput.additionalContext.includes(path.join(dir, base + '-2.md')));
  assert.equal(fs.readFileSync(path.join(dir, base + '.md'), 'utf8'), 'original');
  const base8 = M.noteBaseName(now(), b.proj, M.cleanSessionId(H.sessionId(8)));
  fs.writeFileSync(path.join(dir, base8 + '.md'), 'o');
  for (let k = 2; k <= 9; k++) fs.writeFileSync(path.join(dir, base8 + '-' + k + '.md'), 'o' + k);
  const before = H.listing(dir);
  const full = promptAt(b, kit, env, 150000, H.sessionId(8), { ctx: { now } });
  assert.deepEqual(H.listing(dir), before, 'nothing written');
  assert.ok(full.systemMessage.includes(M.LINES.NOTE_CLASH));
  assert.ok(!full.hookSpecificOutput.additionalContext.includes(dir), 'no path named');
});

test('6.6 / SR-C6: handoff_dir is refused (default used, said once) when relative, missing, inside CLAUDE_PROJECT_DIR, inside the input cwd, a link whose real path is inside the project, or inside another git work tree; a good folder is used', () => {
  const b = H.makeBase('hdir');
  const kit = H.copyKit(b);
  const env = H.copyEnv(b);
  const cwdDir = H.mk(b.base, 'started-here');
  const inProj = H.mk(b.proj, 'notes');
  const inCwd = H.mk(cwdDir, 'notes');
  const linkToProj = H.dirLink(inProj, path.join(b.base, 'link-notes'));
  const gitTop = H.mk(b.base, 'other-repo');
  fs.mkdirSync(path.join(gitTop, '.git'));
  const inGit = H.mk(gitTop, 'notes');
  const def = path.join(kit.stateRoot, 'handoff');
  const cases = [['relative', 'notes'], ['missing', path.join(b.base, 'nope')], ['in project', inProj], ['in cwd', inCwd], ['link into project', linkToProj], ['in git', inGit]];
  let k = 20;
  for (const [label, value] of cases) {
    writeConfig(kit, { handoff_dir: value });
    const sid = H.sessionId(k++);
    const before = noteFiles(def).length;
    const out = promptAt(b, kit, env, 150000, sid, { input: { cwd: cwdDir } });
    assert.ok(out.systemMessage.includes(M.LINES.HANDOFF_DIR_REFUSED), label + ': said');
    assert.equal(noteFiles(def).length, before + 1, label + ': default folder used');
    for (const d of [inProj, inCwd, inGit]) assert.equal(noteFiles(d).length, 0, label);
    const again = promptAt(b, kit, env, 200000, sid, { input: { cwd: cwdDir } });
    assert.ok(!again.systemMessage.includes(M.LINES.HANDOFF_DIR_REFUSED), label + ': said once');
  }
  const good = H.mk(b.base, 'my notes');
  writeConfig(kit, { handoff_dir: good });
  const ok = promptAt(b, kit, env, 150000, H.sessionId(40), { input: { cwd: cwdDir } });
  assert.ok(!(ok.systemMessage || '').includes(M.LINES.HANDOFF_DIR_REFUSED));
  assert.equal(noteFiles(good).length, 1);
  assert.ok(ok.hookSpecificOutput.additionalContext.includes(path.join(good, noteFiles(good)[0])));
});

// Windows network and device path forms, built from parts (no literal host anywhere). The host
// is under the reserved .invalid name, and no test passes these to a real file call.
const BS = '\\';
const NET_HOST = ['pocotoko-test', 'invalid'].join('.');
const NET_FORMS = [
  ['UNC, backslashes', BS + BS + NET_HOST + BS + 'share' + BS + 'notes'],
  ['UNC, forward slashes', '//' + NET_HOST + '/share/notes'],
  ['UNC, mixed slashes', BS + '/' + NET_HOST + '/share'],
  ['device form', BS + BS + '.' + BS + 'C:' + BS + 'notes'],
  ['long-path form', BS + BS + '?' + BS + 'C:' + BS + 'notes'],
  ['long-path UNC form', BS + BS + '?' + BS + 'UNC' + BS + NET_HOST + BS + 'share'],
];

test('6.6 / SR-C6 (L-3): on Windows a handoff_dir in a network or device form (\\\\host\\share, //host/share, \\\\.\\, \\\\?\\) is refused on the string alone, before any file call; the same strings are not network paths on macOS or Linux (pure strings, every OS)', () => {
  for (const [label, p] of NET_FORMS) {
    assert.equal(M.isWindowsNetworkOrDevicePath(p, 'win32'), true, label);
    assert.equal(M.isWindowsNetworkOrDevicePath(p, 'linux'), false, label + ' (linux)');
    assert.equal(M.isWindowsNetworkOrDevicePath(p, 'darwin'), false, label + ' (darwin)');
    const calls = [];
    const seam = (x) => { calls.push(x); throw Object.assign(new Error('must not be called'), { code: 'EACCES' }); };
    assert.deepEqual(M.resolveHandoffDir(p, { projectDir: '', cwd: '', configDir: null, platform: 'win32', _realpath: seam }), { refused: true }, label);
    assert.deepEqual(M.resolveHandoffDir('  ' + p + '  ', { platform: 'win32', _realpath: seam }), { refused: true }, label + ' (padded)');
    assert.deepEqual(calls, [], label + ': no file call was made, so no network connection');
  }
  for (const p of ['C:' + BS + 'notes', 'C:/notes', 'd:' + BS + 'a' + BS + BS + 'b']) assert.equal(M.isWindowsNetworkOrDevicePath(p, 'win32'), false, p);
  // On POSIX a leading // is an ordinary absolute path: the rule does not apply and the folder
  // check runs (here the seam says it does not exist, so it is refused as missing).
  const calls = [];
  const missing = (x) => { calls.push(x); throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  assert.deepEqual(M.resolveHandoffDir('//' + NET_HOST + '/share', { platform: 'linux', _realpath: missing }), { refused: true });
  assert.equal(calls.length, 1, 'POSIX: the ordinary folder check ran');
});

test('6.6 / SR-C6 (L-3): a handoff_dir inside the config folder (the folder itself, a subfolder such as commands, the default ~/.claude, or a link into it) is refused, default used, said once; a sibling folder with a longer name is used (every OS)', () => {
  const b = H.makeBase('hdir-cfg');
  const kit = H.copyKit(b);
  const env = H.copyEnv(b);
  const def = path.join(kit.stateRoot, 'handoff');
  const commands = H.mk(b.config, 'commands');
  const deep = H.mk(b.config, 'skills', 'notes');
  const linkIn = H.dirLink(commands, path.join(b.base, 'link-to-commands'));
  const cases = [
    ['the config folder', b.config, env],
    ['config/commands', commands, env],
    ['config/skills/notes', deep, env],
    ['a link into the config folder', linkIn, env],
  ];
  // CLAUDE_CONFIG_DIR unset: the config folder is <home>/.claude.
  const homeCmds = H.mk(b.home, '.claude', 'commands');
  cases.push(['~/.claude/commands, CLAUDE_CONFIG_DIR unset', homeCmds, { CLAUDE_PROJECT_DIR: b.proj }]);
  let k = 120;
  for (const [label, value, e] of cases) {
    writeConfig(kit, { handoff_dir: value });
    const sid = H.sessionId(k++);
    const before = noteFiles(def).length;
    const out = promptAt(b, kit, e, 150000, sid);
    noBlocking(out);
    assert.ok(out.systemMessage.includes(M.LINES.HANDOFF_DIR_REFUSED), label + ': said');
    assert.equal(noteFiles(def).length, before + 1, label + ': default folder used');
    for (const d of [b.config, commands, deep, homeCmds]) assert.equal(noteFiles(d).length, 0, label + ': nothing in the config folder');
    const again = promptAt(b, kit, e, 200000, sid);
    assert.ok(!(again.systemMessage || '').includes(M.LINES.HANDOFF_DIR_REFUSED), label + ': said once');
  }
  // Path-aware: <base>/config-notes is not inside <base>/config.
  const sibling = H.mk(b.base, path.basename(b.config) + '-notes');
  writeConfig(kit, { handoff_dir: sibling });
  const ok = promptAt(b, kit, env, 150000, H.sessionId(140));
  assert.ok(!(ok.systemMessage || '').includes(M.LINES.HANDOFF_DIR_REFUSED));
  assert.equal(noteFiles(sibling).length, 1);
  // Unit level: the same answers from resolveHandoffDir.
  const cfgReal = M.configDirOf(env, b.home);
  assert.deepEqual(M.resolveHandoffDir(commands, { configDir: cfgReal, gitCeiling: b.base }), { refused: true });
  assert.deepEqual(M.resolveHandoffDir(sibling, { configDir: cfgReal, gitCeiling: b.base }), { dir: sibling });
});

test('6.6 (end gate round 1, N-1): a handoff_dir whose written form is inside the project, the start folder or the config folder is refused before any link in it is resolved; a link from outside into them is still refused on its real path', () => {
  const b = H.makeBase('hdir-text');
  const cwdDir = H.mk(b.base, 'started-here');
  const recording = () => {
    const calls = [];
    const fn = (x) => { calls.push(x); throw Object.assign(new Error('must not be called'), { code: 'EACCES' }); };
    return { calls, fn };
  };
  // The written value need not exist: a link there would never be followed.
  for (const [label, value] of [
    ['inside the project', path.join(b.proj, 'link-to-share')],
    ['the project itself', b.proj],
    ['inside the start folder', path.join(cwdDir, 'a', 'b')],
    ['inside the config folder', path.join(b.config, 'commands')],
  ]) {
    const seam = recording();
    assert.deepEqual(M.resolveHandoffDir(value, { projectDir: b.proj, cwd: cwdDir, configDir: b.config, gitCeiling: b.base, _realpath: seam.fn }), { refused: true }, label);
    assert.deepEqual(seam.calls, [], label + ': refused before the real-path step');
  }
  // The project named through a link: the value under the link's own written form is
  // refused before the real-path step too, not only under the project's real path.
  const projLink = H.dirLink(b.proj, path.join(b.base, 'proj-link'));
  const viaLink = recording();
  assert.deepEqual(M.resolveHandoffDir(path.join(projLink, 'notes'), { projectDir: projLink, cwd: '', gitCeiling: b.base, _realpath: viaLink.fn }), { refused: true });
  assert.deepEqual(viaLink.calls, [], 'the project named through a link: refused before the real-path step');
  // Outside all three: the real-path step runs.
  const seam = recording();
  assert.deepEqual(M.resolveHandoffDir(path.join(b.base, 'elsewhere'), { projectDir: b.proj, cwd: cwdDir, configDir: b.config, gitCeiling: b.base, _realpath: seam.fn }), { refused: true });
  assert.equal(seam.calls.length, 1, 'outside: resolved as before');
  // A link from outside into the project: the written form passes, the real path refuses it.
  const inProj = H.mk(b.proj, 'notes');
  const link = H.dirLink(inProj, path.join(b.base, 'outside-link'));
  assert.deepEqual(M.resolveHandoffDir(link, { projectDir: b.proj, cwd: cwdDir, configDir: b.config, gitCeiling: b.base }), { refused: true });
  // The project named through a link (as projectDir, and as cwd), the value a folder inside the
  // project named by its REAL path: the project's real path fences it (end gate round 2, N-1).
  const realInside = H.mk(b.proj, 'real-notes');
  assert.deepEqual(M.resolveHandoffDir(realInside, { projectDir: projLink, cwd: '', gitCeiling: b.base }), { refused: true }, 'projectDir is a link');
  assert.deepEqual(M.resolveHandoffDir(realInside, { projectDir: '', cwd: projLink, gitCeiling: b.base }), { refused: true }, 'cwd is a link');
  // A good folder is still used, also when reached through a local link from outside.
  const good = H.mk(b.base, 'good notes');
  assert.deepEqual(M.resolveHandoffDir(good, { projectDir: b.proj, cwd: cwdDir, configDir: b.config, gitCeiling: b.base }), { dir: good });
  const goodLink = H.dirLink(good, path.join(b.base, 'good-link'));
  assert.deepEqual(M.resolveHandoffDir(goodLink, { projectDir: b.proj, cwd: cwdDir, configDir: b.config, gitCeiling: b.base }), { dir: good }, 'a local link is followed');
  assert.equal(M.linkToNetwork(goodLink, process.platform), false, 'a real local link is not a network link');
});

// A fake file system for the link walk: `links` maps a path to its stored link target; every
// other path is a plain folder; `errors` maps a path to an lstat error code. Nothing real is
// touched, so a network target is only ever a string.
function fakeFs({ links = {}, errors = {}, readlinkErrors = [] } = {}) {
  const calls = { lstat: [], readlink: [], realpath: [] };
  const key = (p) => p.toLowerCase();
  const L = Object.fromEntries(Object.entries(links).map(([k, v]) => [key(k), v]));
  const E = Object.fromEntries(Object.entries(errors).map(([k, v]) => [key(k), v]));
  const RE = readlinkErrors.map(key);
  return {
    calls,
    lstat: (p) => {
      calls.lstat.push(p);
      if (E[key(p)]) throw Object.assign(new Error(E[key(p)]), { code: E[key(p)] });
      return { isSymbolicLink: () => Object.prototype.hasOwnProperty.call(L, key(p)) };
    },
    readlink: (p) => {
      calls.readlink.push(p);
      if (RE.includes(key(p))) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return L[key(p)];
    },
    realpath: (p) => { calls.realpath.push(p); throw Object.assign(new Error('stop here'), { code: 'ENOENT' }); },
  };
}

test('6.6 (end gate round 2, R2-2): on Windows a link anywhere in handoff_dir whose stored target is a network or device path is refused before anything is resolved: a short 8.3 name, a link in another repo, a chain of links (fake file system, pure strings, every OS)', () => {
  const NET = BS + BS + NET_HOST + BS + 'share';
  const resolve = (value, f) => M.resolveHandoffDir(value, { projectDir: 'C:' + BS + 'Work' + BS + 'Project Folder Long', cwd: '', configDir: null, platform: 'win32', _realpath: f.realpath, _lstat: f.lstat, _readlink: f.readlink });
  for (const [label, target] of [
    ['UNC, backslashes', NET],
    ['UNC, forward slashes', '//' + NET_HOST + '/share'],
    ['long-path UNC', BS + BS + '?' + BS + 'UNC' + BS + NET_HOST + BS + 'share'],
    ['NT form', BS + '??' + BS + 'UNC' + BS + NET_HOST + BS + 'share'],
    ['NT form without the prefix', 'UNC' + BS + NET_HOST + BS + 'share'],
    ['NT form, lower case', 'unc' + BS + NET_HOST + BS + 'share'],
    ['device form', BS + BS + '.' + BS + 'pipe' + BS + 'x'],
  ]) {
    // The 8.3 name of the project: the text fence cannot see it is the project.
    const value = 'C:' + BS + 'Work' + BS + 'PROJEC~1' + BS + 'link';
    const f = fakeFs({ links: { [value]: target } });
    assert.deepEqual(resolve(value, f), { refused: true }, label);
    assert.deepEqual(f.calls.realpath, [], label + ': nothing resolved');
    assert.ok(f.calls.readlink.length === 1, label + ': the link target was read, not followed');
  }
  // A link in the middle of the value, inside some other repo on the disk.
  const mid = fakeFs({ links: { ['D:' + BS + 'repo' + BS + 'share-link']: NET } });
  assert.deepEqual(resolve('D:' + BS + 'repo' + BS + 'share-link' + BS + 'notes', mid), { refused: true }, 'a link in the middle');
  assert.deepEqual(mid.calls.realpath, []);
  // A chain: a local link to a folder that is itself a link to the network.
  const chain = fakeFs({ links: { ['D:' + BS + 'a']: 'D:' + BS + 'b', ['D:' + BS + 'b']: NET } });
  assert.deepEqual(resolve('D:' + BS + 'a' + BS + 'notes', chain), { refused: true }, 'a chain of links');
  assert.deepEqual(chain.calls.realpath, []);
  // A relative stored target is read against the link's own folder.
  // (D:\x\w\up holds ..\y, which is D:\x\y, a link to the network; D:\y is a plain folder.)
  const rel = fakeFs({ links: { ['D:' + BS + 'x' + BS + 'w' + BS + 'up']: '..' + BS + 'y', ['D:' + BS + 'x' + BS + 'y']: NET } });
  assert.deepEqual(resolve('D:' + BS + 'x' + BS + 'w' + BS + 'up', rel), { refused: true }, 'a relative target');
  assert.deepEqual(rel.calls.realpath, [], 'a relative target: nothing resolved');
  // A link loop fails closed.
  const loop = fakeFs({ links: { ['D:' + BS + 'loop']: 'D:' + BS + 'loop' } });
  assert.deepEqual(resolve('D:' + BS + 'loop' + BS + 'n', loop), { refused: true }, 'a loop');
  assert.deepEqual(loop.calls.realpath, []);
  // Errors fail closed; a part that does not exist ends the walk (the real-path step refuses it).
  const denied = fakeFs({ errors: { ['D:' + BS + 'locked']: 'EACCES' } });
  assert.deepEqual(resolve('D:' + BS + 'locked' + BS + 'n', denied), { refused: true }, 'lstat EACCES');
  assert.deepEqual(denied.calls.realpath, [], 'lstat EACCES: nothing resolved');
  const unreadable = fakeFs({ links: { ['D:' + BS + 'l']: 'D:' + BS + 'z' }, readlinkErrors: ['D:' + BS + 'l'] });
  assert.deepEqual(resolve('D:' + BS + 'l' + BS + 'n', unreadable), { refused: true }, 'readlink error');
  assert.deepEqual(unreadable.calls.realpath, []);
  const missing = fakeFs({ errors: { ['D:' + BS + 'gone']: 'ENOENT' } });
  assert.deepEqual(resolve('D:' + BS + 'gone' + BS + 'n', missing), { refused: true });
  assert.equal(missing.calls.realpath.length, 1, 'not found: the walk ends and the real-path step refuses it');
  // A local link: the walk passes it and the real-path step runs.
  const local = fakeFs({ links: { ['D:' + BS + 'notes-link']: 'E:' + BS + 'notes' } });
  assert.deepEqual(resolve('D:' + BS + 'notes-link', local), { refused: true });
  assert.equal(local.calls.realpath.length, 1, 'a local link: resolved as before');
  assert.ok(local.calls.lstat.some((p) => p.toLowerCase() === ('E:' + BS + 'notes').toLowerCase()), 'its target was walked too');
  // End gate round 3, R3-1: a relative target is read from the folder really reached, not the
  // path as written. C:\a\J is a junction to D:\deep\dir; there R is a relative link ..\N; and
  // D:\deep\N is a link to the network. (C:\a\N, the as-written answer, is a plain folder.)
  const viaJunction = fakeFs({ links: {
    ['C:' + BS + 'a' + BS + 'J']: 'D:' + BS + 'deep' + BS + 'dir',
    ['D:' + BS + 'deep' + BS + 'dir' + BS + 'R']: '..' + BS + 'N',
    ['D:' + BS + 'deep' + BS + 'N']: NET,
  } });
  assert.deepEqual(resolve('C:' + BS + 'a' + BS + 'J' + BS + 'R' + BS + 'x', viaJunction), { refused: true }, 'junction, then a relative link');
  assert.deepEqual(viaJunction.calls.realpath, []);
  assert.ok(viaJunction.calls.lstat.some((p) => p === 'D:' + BS + 'deep' + BS + 'N'), 'the folder really reached was read');
  assert.ok(!viaJunction.calls.lstat.some((p) => p === 'C:' + BS + 'a' + BS + 'J' + BS + 'R' + BS + 'x'), 'nothing was opened through the links');
  // The same with relative links only, inside one repo: a\R1 -> sub\deeper, there R2 -> ..\..\N, N -> network.
  const relOnly = fakeFs({ links: {
    ['D:' + BS + 'repo' + BS + 'a' + BS + 'R1']: 'sub' + BS + 'deeper',
    ['D:' + BS + 'repo' + BS + 'a' + BS + 'sub' + BS + 'deeper' + BS + 'R2']: '..' + BS + '..' + BS + 'N',
    ['D:' + BS + 'repo' + BS + 'a' + BS + 'N']: NET,
  } });
  assert.deepEqual(resolve('D:' + BS + 'repo' + BS + 'a' + BS + 'R1' + BS + 'R2' + BS + 'x', relOnly), { refused: true }, 'relative links only');
  assert.deepEqual(relOnly.calls.realpath, []);
  // A local relative chain that ends at a plain folder: walked, then resolved as before.
  const relSafe = fakeFs({ links: { ['D:' + BS + 'a' + BS + 'R']: '..' + BS + 'b' } });
  assert.deepEqual(resolve('D:' + BS + 'a' + BS + 'R' + BS + 'x', relSafe), { refused: true });
  assert.equal(relSafe.calls.realpath.length, 1, 'a safe relative chain: resolved as before');
  assert.ok(relSafe.calls.lstat.includes('D:' + BS + 'b' + BS + 'x'), 'the rest is walked from the folder reached');
  // A stored target that is not a drive path (rooted with no drive, an NT volume or device
  // name) refuses the value without walking or resolving anything more.
  for (const target of [BS + 'x' + BS + 'y', BS + '??' + BS + 'Volume{0000}' + BS + 'x', BS + 'Device' + BS + 'Mup' + BS + NET_HOST + BS + 'share']) {
    const odd = fakeFs({ links: { ['D:' + BS + 'odd']: target } });
    assert.deepEqual(resolve('D:' + BS + 'odd' + BS + 'n', odd), { refused: true }, 'not a drive path: ' + target);
    assert.deepEqual(odd.calls.realpath, [], 'not a drive path, nothing resolved: ' + target);
    assert.deepEqual(odd.calls.lstat, ['D:' + BS + 'odd'], 'not a drive path, no more parts walked: ' + target);
  }
  // End gate round 3, R3-2: one budget for all calls. The review's branching shape: a link named
  // L<k> points at a path of 8 links named L<k-1>, 6 levels (8^6 parts if walked in full); L0 is
  // a plain folder. It is refused after at most the budget of calls, quickly.
  const branch = (width, levels) => {
    const calls = { lstat: 0, readlink: 0, realpath: 0 };
    const name = (p) => p.split(BS).pop();
    return {
      calls,
      lstat: (p) => { calls.lstat++; return { isSymbolicLink: () => /^L[1-9][0-9]*$/.test(name(p)) }; },
      readlink: (p) => { calls.readlink++; const k = Number(name(p).slice(1)); return ['C:', ...Array(width).fill('L' + (k - 1))].join(BS); },
      realpath: () => { calls.realpath++; throw Object.assign(new Error('stop'), { code: 'ENOENT' }); },
    };
  };
  const wide = branch(8, 6);
  const t0 = Date.now();
  assert.deepEqual(resolve('C:' + BS + 'L6', wide), { refused: true }, 'the 8 by 6 shape is refused');
  assert.ok(wide.calls.lstat + wide.calls.readlink <= 256, 'at most the budget of calls: ' + (wide.calls.lstat + wide.calls.readlink));
  assert.ok(Date.now() - t0 < 1000, 'and quickly');
  assert.equal(wide.calls.realpath, 0, 'nothing resolved');
  // A small branching shape inside the budget is walked to the end (3 by 2: 13 parts).
  const small = branch(3, 2);
  assert.deepEqual(resolve('C:' + BS + 'L2', small), { refused: true });
  assert.equal(small.calls.realpath, 1, 'a small shape: walked in full, then resolved');
  // An ordinary deep path with a few local links stays well inside the budget.
  const parts = Array.from({ length: 40 }, (_, j) => 'p' + j);
  const deepLinks = {};
  for (const j of [5, 15, 25]) deepLinks[['D:', ...parts.slice(0, j + 1)].join(BS)] = ['E:', 'm' + j].join(BS);
  const ordinary = fakeFs({ links: deepLinks });
  assert.deepEqual(resolve(['D:', ...parts].join(BS), ordinary), { refused: true });
  assert.equal(ordinary.calls.realpath.length, 1, 'an ordinary deep path: walked to the end, then resolved');
  // macOS and Linux: no walk (a leading // is an ordinary path there).
  const posix = fakeFs({ links: { '/x/l': NET } });
  assert.equal(M.linkToNetwork('/x/l', 'linux', posix.lstat, posix.readlink), false);
  assert.equal(M.linkToNetwork('/x/l', 'darwin', posix.lstat, posix.readlink), false);
  assert.deepEqual(posix.calls.lstat, [], 'no walk on POSIX');
});

// End gate round 4, U-1: the budget is exactly 256 calls (spec 6.6), pinned from both sides.
// Fake file system only (pure strings, Windows rules, every OS).
function budgetFake(links = {}) {
  const calls = { lstat: 0, readlink: 0, realpath: 0 };
  return {
    calls,
    lstat: (p) => { calls.lstat++; return { isSymbolicLink: () => Object.prototype.hasOwnProperty.call(links, p) }; },
    readlink: (p) => { calls.readlink++; return links[p]; },
    realpath: () => { calls.realpath++; throw Object.assign(new Error('stop'), { code: 'ENOENT' }); },
  };
}
const budgetRun = (value, f) => M.resolveHandoffDir(value, { projectDir: '', cwd: '', platform: 'win32', _realpath: f.realpath, _lstat: f.lstat, _readlink: f.readlink });

test('6.6 (end gate round 4, U-1): the walk budget edge: 256 plain parts are walked to the end (256 calls); 257 are refused before resolving', () => {
  const at = budgetFake();
  budgetRun(['D:', ...Array(256).fill('p')].join(BS), at);
  assert.equal(at.calls.lstat + at.calls.readlink, 256);
  assert.equal(at.calls.realpath, 1, '256 calls: walked to the end, then resolved');
  const over = budgetFake();
  budgetRun(['D:', ...Array(257).fill('p')].join(BS), over);
  assert.equal(over.calls.realpath, 0, '257 calls: refused before resolving');
});

test('6.6 (end gate round 4, U-1): the budget edge with a link: 254 parts + one link (readlink counted) + its 1 target part = 256 calls pass; one more refuses', () => {
  const mk = (n) => {
    const parts = Array(n).fill('p');
    const linkAt = ['D:', ...parts.slice(0, 10)].join(BS);
    return { value: ['D:', ...parts].join(BS), links: { [linkAt]: 'E:' + BS + 't' } };
  };
  // n parts with a link at part 10: lstat n + readlink 1 + lstat of E:\t 1 = n + 2 calls.
  const a = mk(254);
  const fa = budgetFake(a.links);
  budgetRun(a.value, fa);
  assert.equal(fa.calls.lstat + fa.calls.readlink, 256);
  assert.equal(fa.calls.realpath, 1);
  const b = mk(255);
  const fb = budgetFake(b.links);
  budgetRun(b.value, fb);
  assert.equal(fb.calls.realpath, 0);
  // The readlink as the 256th call: 255 parts, the last a link to a drive root (no parts left).
  const last = (n) => {
    const value = ['D:', ...Array(n).fill('p')].join(BS);
    return { value, links: { [value]: 'E:' + BS } };
  };
  const c = last(255);
  const fc = budgetFake(c.links);
  budgetRun(c.value, fc);
  assert.equal(fc.calls.lstat + fc.calls.readlink, 256);
  assert.equal(fc.calls.readlink, 1);
  assert.equal(fc.calls.realpath, 1, 'the readlink as the 256th call: walked, then resolved');
  const d = last(256);
  const fd = budgetFake(d.links);
  budgetRun(d.value, fd);
  assert.equal(fd.calls.realpath, 0, 'the readlink as the 257th call: refused');
});

test('6.6 (end gate round 4, N4-3): a relative link target holding a colon (a drive-relative or stream form) refuses the value without being joined as a name (fake file system)', () => {
  for (const target of ['C:foo', 'foo:bar', '..' + BS + 'x:y']) {
    const link = 'C:' + BS + 'a' + BS + 'l';
    const f = fakeFs({ links: { [link]: target } });
    const out = M.resolveHandoffDir(link + BS + 'x', { projectDir: '', cwd: '', platform: 'win32', _realpath: f.realpath, _lstat: f.lstat, _readlink: f.readlink });
    assert.deepEqual(out, { refused: true }, target);
    assert.deepEqual(f.calls.realpath, [], target + ': nothing resolved');
    assert.deepEqual(f.calls.lstat, ['C:' + BS + 'a', link], target + ': nothing walked after the link');
  }
  // An absolute drive target still is walked.
  const ok = fakeFs({ links: { ['C:' + BS + 'a' + BS + 'l']: 'D:' + BS + 'b' } });
  M.resolveHandoffDir('C:' + BS + 'a' + BS + 'l', { projectDir: '', cwd: '', platform: 'win32', _realpath: ok.realpath, _lstat: ok.lstat, _readlink: ok.readlink });
  assert.equal(ok.calls.realpath.length, 1, 'a drive target: walked, then resolved');
});

test('6.6 (end gate round 3, R3-2, child process): a handoff_dir through a loop of two local links is refused quickly: exit 0, no blocking field, the refusal line once, nothing on stderr', () => {
  const b = H.makeBase('hdir-loop');
  const kit = H.copyKit(b);
  // j1 -> <base>/j2/in and j2 -> <base>/j1/in: each turn makes the path longer (Windows: the
  // walk's budget ends it; macOS and Linux: the real-path step gives ELOOP or a too-long name).
  H.dirLink(path.join(b.base, 'j2', 'in'), path.join(b.base, 'j1'));
  H.dirLink(path.join(b.base, 'j1', 'in'), path.join(b.base, 'j2'));
  writeConfig(kit, { handoff_dir: path.join(b.base, 'j1', 'notes') });
  const t = H.writeTranscript(b, 150000);
  const r = R.runMeter(b, { scriptFile: kit.scriptFile, input: JSON.stringify(H.promptInput(b, t)), env: H.copyEnv(b) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.ok(r.ms < 2500, 'inside the self-kill time: ' + r.ms + ' ms');
  const out = JSON.parse(r.text);
  noBlocking(out);
  assert.equal(out.systemMessage.split(M.LINES.HANDOFF_DIR_REFUSED).length, 2, 'the refusal line once');
});

test('6.6 / SR-C6 (L-3, child process, Windows): the long-path forms of a real local folder (\\\\?\\ and //?/) are refused, default used, exit 0 (local only, no network)', { skip: !IS_WIN && 'Windows path forms only: on macOS and Linux a leading // is an ordinary path (tested as strings above)' }, () => {
  const b = H.makeBase('hdir-long');
  const kit = H.copyKit(b);
  const good = H.mk(b.base, 'notes');
  let n = 150;
  for (const [label, v, refused] of [['plain (control)', good, false], ['long-path form', BS + BS + '?' + BS + good, true], ['forward-slash device form', '//?/' + good, true]]) {
    writeConfig(kit, { handoff_dir: v });
    const t = H.writeTranscript(b, 150000, { name: 'long-' + n });
    const r = R.runMeter(b, { scriptFile: kit.scriptFile, input: JSON.stringify(H.promptInput(b, t, H.sessionId(n++))), env: H.copyEnv(b) });
    assert.equal(r.status, 0, label);
    assert.equal(r.stderr, '', label);
    const out = JSON.parse(r.text);
    noBlocking(out);
    assert.equal((out.systemMessage || '').includes(M.LINES.HANDOFF_DIR_REFUSED), refused, label);
  }
});

test('6.6 / SR-C6 (L-3): the hook still fails safe on a refused handoff_dir: exit 0, no blocking field, the refusal line once (real process)', () => {
  const b = H.makeBase('hdir-proc');
  const kit = H.copyKit(b);
  writeConfig(kit, { handoff_dir: H.mk(b.config, 'commands') });
  const t = H.writeTranscript(b, 150000);
  const r = R.runMeter(b, { scriptFile: kit.scriptFile, input: JSON.stringify(H.promptInput(b, t)), env: H.copyEnv(b) });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.text);
  noBlocking(out);
  assert.ok(out.systemMessage.includes(M.LINES.HANDOFF_DIR_REFUSED));
  assert.equal(noteFiles(path.join(b.config, 'commands')).length, 0);
});

test('6.6 a / 6.11 f: the meter uses the one printable-path table and cap; session-start.cjs imports them', () => {
  const S = require('../../src/core/hooks/session-start.cjs');
  assert.equal(S.printablePath, M.printablePath);
  assert.equal(S.UNPRINTABLE_CLASSES, M.UNPRINTABLE_CLASSES);
  assert.equal(M.LIMITS.PATH_MAX_CHARS, 1024);
  assert.equal(S.LIMITS.PATH_MAX_CHARS, M.LIMITS.PATH_MAX_CHARS);
  const src = fs.readFileSync(path.join(H.REPO_TOP, 'src', 'core', 'hooks', 'session-start.cjs'), 'utf8');
  assert.ok(!/new RegExp\(/.test(src) && !/\\\\u202a/.test(src), 'session-start.cjs holds no copy of the table');
  assert.equal(M.printablePath('x'.repeat(1024)), true);
  assert.equal(M.printablePath('x'.repeat(1025)), false);
  assert.ok(/^[\x20-\x7e]+$/.test(M.LINES.NOTE_UNPRINTABLE), 'ASCII line');
});

test('6.6 a / 6.11 f (MUST): a hand-off folder whose note path holds a character of each 6.11 f class, or is over 1,024 characters, gets no pre-create and is never named; the warning still fires; the line comes once per session', (t) => {
  const b = H.makeBase('hprint');
  const kit = H.copyKit(b);
  const env = H.copyEnv(b);
  const def = path.join(kit.stateRoot, 'handoff');
  // One character per class; a C0 control only where the OS allows it in a folder name.
  const cases = [
    ['controls (C1)', 'a\u0085b'],
    ['controls (DEL)', 'a\u007fb'],
    ['separators', 'a b'],
    ['bidi', 'a‮b'],
    ['bidi (U+061C)', 'a؜b'],
    ['zero_width', 'a​b'],
    ['zero_width (U+FEFF)', 'a﻿b'],
    ['format (soft hyphen)', 'a­b'],
    ['format (U+2061)', 'a⁡b'],
    ['format (U+FFF9)', 'a￹b'],
    ['tags (U+E0041)', 'a\u{e0041}b'],
    ['tags (U+E007F)', 'a\u{e007f}b'],
    ['ignorable (a run of variation selectors)', 'a\u{e0100}\u{e0101}b'],
    ['ignorable (two emoji selectors)', 'a️️b'],
    ['ignorable (Hangul filler)', 'aㅤb'],
  ];
  if (!IS_WIN) cases.push(['controls (C0, line feed)', 'a\nb']);
  const covered = new Set();
  let k = 60;
  for (const [label, name] of cases) {
    covered.add(label.split(' ')[0]);
    const dir = H.mk(b.base, name);
    assert.ok(fs.existsSync(dir), label + ': folder made');
    writeConfig(kit, { handoff_dir: dir });
    const sid = H.sessionId(k++);
    const out = promptAt(b, kit, env, 150000, sid);
    assert.ok(out && out.hookSpecificOutput, label + ': the warning still fires');
    assert.match(out.hookSpecificOutput.additionalContext, /start-a-new-session size/, label);
    const all = out.hookSpecificOutput.additionalContext + '\n' + (out.systemMessage || '');
    assert.ok(!all.includes(name), label + ': the path is named nowhere');
    assert.ok(!/hand-off note into/.test(out.hookSpecificOutput.additionalContext), label + ': no note requested');
    assert.ok(out.systemMessage.includes(M.LINES.NOTE_UNPRINTABLE), label + ': said');
    assert.equal(noteFiles(dir).length, 0, label + ': nothing pre-created there');
    assert.equal(noteFiles(def).length, 0, label + ': and not in the default folder');
    const again = promptAt(b, kit, env, 200000, sid);
    assert.ok(again && again.hookSpecificOutput, label + ': the repeat still fires');
    assert.ok(!(again.systemMessage || '').includes(M.LINES.NOTE_UNPRINTABLE), label + ': said once');
    assert.equal(noteFiles(dir).length, 0, label + ': still nothing pre-created');
  }
  assert.deepEqual([...covered].sort(), Object.keys(M.UNPRINTABLE_CLASSES).sort(), 'one case per class');
  // Over 1,024 characters, two real nested folders. (1) The folder fits every OS path limit
  // (macOS cannot make or open a full path of 1,024 bytes or more; ASCII here, so characters =
  // bytes), but the note path at the longest clash name does not: the check is on the note path.
  // (2) The folder itself is over the cap, where the OS can make it (macOS: mkdir gives ENAMETOOLONG).
  const FIT = 1000;
  let fitDir = b.base;
  while (fitDir.length + 121 <= FIT) fitDir = path.join(fitDir, 'd'.repeat(120));
  if (FIT - fitDir.length - 1 >= 1) fitDir = path.join(fitDir, 'e'.repeat(FIT - fitDir.length - 1));
  const tail = (path.sep + M.noteBaseName(new Date(), b.proj, H.sessionId(90)) + '-' + M.LIMITS.NOTE_CLASH_MAX + '.md').length;
  assert.ok(fitDir.length <= FIT && fitDir.length + tail > M.LIMITS.PATH_MAX_CHARS, 'the folder fits; its note path is over the cap');
  let longDir = b.base;
  while (longDir.length <= 1024) longDir = path.join(longDir, 'd'.repeat(120));
  const longCases = [['note path over 1,024', fitDir, 90]];
  try {
    fs.mkdirSync(longDir, { recursive: true });
    longCases.push(['folder over 1,024', longDir, 92]);
  } catch (err) {
    if (!err || err.code !== 'ENAMETOOLONG' || process.platform !== 'darwin') throw err;
    t.diagnostic('folder over 1,024: macOS cannot make a folder by such a full path (ENAMETOOLONG), so only the note-path case runs');
  }
  fs.mkdirSync(fitDir, { recursive: true });
  for (const [label, dir, n] of longCases) {
    writeConfig(kit, { handoff_dir: dir });
    const long = promptAt(b, kit, env, 150000, H.sessionId(n));
    assert.ok(long && long.hookSpecificOutput, label + ': the warning still fires');
    assert.ok(!(long.hookSpecificOutput.additionalContext + long.systemMessage).includes('d'.repeat(120)), label + ': not named');
    assert.ok(long.systemMessage.includes(M.LINES.NOTE_UNPRINTABLE), label + ': said');
    assert.equal(noteFiles(dir).length, 0, label + ': nothing pre-created');
  }
  // A control: a printable folder still gets its note, named.
  const good = H.mk(b.base, 'plain notes');
  writeConfig(kit, { handoff_dir: good });
  const ok = promptAt(b, kit, env, 150000, H.sessionId(91));
  assert.equal(noteFiles(good).length, 1);
  assert.ok(ok.hookSpecificOutput.additionalContext.includes(path.join(good, noteFiles(good)[0])));
  assert.ok(!(ok.systemMessage || '').includes(M.LINES.NOTE_UNPRINTABLE));
  // So does a folder whose name holds one emoji selector after a heart (the one exception).
  const heart = H.mk(b.base, 'team ❤️ notes');
  writeConfig(kit, { handoff_dir: heart });
  const ok2 = promptAt(b, kit, env, 150000, H.sessionId(93));
  assert.equal(noteFiles(heart).length, 1, 'heart + U+FE0F: the note is made');
  assert.ok(ok2.hookSpecificOutput.additionalContext.includes(path.join(heart, noteFiles(heart)[0])));
});

// ---------------------------------------------------------------------------
// 6.7: session ids

test('6.7 / SR-C9: session id cleaning, one case each', () => {
  const uuid = 'A1B2C3D4-0000-4000-8000-00000000ABCD';
  assert.equal(M.cleanSessionId(uuid), uuid.toLowerCase());
  const ok64 = 'a'.repeat(32) + '_' + 'B'.repeat(31);
  assert.equal(M.cleanSessionId(ok64), ok64.toLowerCase());
  const hashed = (s) => 'h-' + crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex').slice(0, 32);
  const bad = ['a'.repeat(65), 'a/b', 'a' + F.BS + 'b', '..', '.', 'a b', 'a\u0000b', 'a\nb', 'a\u001bb', 'café', 'Ａbc',
    'CON', 'con', 'Prn', 'AUX', 'NUL', 'COM0', 'com9', 'LPT1', 'nul.txt'];
  for (const s of bad) {
    const c = M.cleanSessionId(s);
    assert.equal(c, hashed(s), JSON.stringify(s));
    assert.ok(M.SESSION_FILE_RE.test(c + '.json'), 'matches the pruning pattern');
    assert.equal(M.cleanSessionId(s), c, 'stable');
  }
  for (const s of [undefined, null, '', 5, {}, []]) assert.equal(M.cleanSessionId(s), null);
  const root = path.resolve('state-root');
  for (const s of [uuid, 'a/b', '..', 'CON']) {
    const p = M.statePathFor(root, M.cleanSessionId(s));
    assert.equal(path.dirname(p), path.join(root, 'state', 'sessions'));
  }
  assert.equal(M.statePathFor(root, '../x'), null);
});

test('6.7 c / SR-C9: a missing, empty or non-string id -> no output, no file, no hand-off pre-create; two ids differing only by case share one state file', () => {
  const b = H.makeBase('sid');
  const kit = H.copyKit(b);
  const env = H.copyEnv(b);
  const t = H.writeTranscript(b, 150000);
  for (const sid of [undefined, '', 7, { a: 1 }, null]) {
    const input = H.promptInput(b, t);
    if (sid === undefined) delete input.session_id; else input.session_id = sid;
    assert.equal(M.handlePrompt(input, ctxOf(b, kit, env)), null);
  }
  assert.ok(!fs.existsSync(path.join(kit.stateRoot, 'state')));
  assert.ok(!fs.existsSync(path.join(kit.stateRoot, 'handoff')));
  assert.ok(promptAt(b, kit, env, 100000, 'SessionAbc'));
  assert.equal(promptAt(b, kit, env, 100000, 'sessionabc'), null, 'same state file');
  assert.deepEqual(stateFiles(kit).filter((n) => n.startsWith('sessionabc')), ['sessionabc.json']);
});

// ---------------------------------------------------------------------------
// 6.2: options

test('6.2: invalid options, one case each, plugin mode (env) and copy-by-hand (file) -> all defaults and the notice exactly once per session', () => {
  const b = H.makeBase('opts');
  const plug = H.pluginKit(b);
  const copy = H.copyKit(b);
  const cases = [
    ['wrong type', { soft_tokens: 'abc' }, { soft_tokens: true }],
    ['bool wrong type', { handoff_note: 'yes' }, { handoff_note: 'yes' }],
    ['soft 9999', { soft_tokens: 9999 }, { soft_tokens: 9999 }],
    ['hard 19999', { hard_tokens: 19999 }, { hard_tokens: 19999 }],
    ['non-integer', { soft_tokens: '100000.5' }, { soft_tokens: 100000.5 }],
    ['repeat -1', { repeat_every_tokens: -1 }, { repeat_every_tokens: -1 }],
    ['soft equal hard', { soft_tokens: 120000, hard_tokens: 120000 }, { soft_tokens: 120000, hard_tokens: 120000 }],
  ];
  let k = 100;
  for (const [label, envOpts, fileOpts] of cases) {
    const sid = H.sessionId(k++);
    const penv = H.pluginEnv(b, plug, envOpts);
    const o1 = promptAt(b, plug, penv, 100000, sid);
    assert.ok(o1.systemMessage.includes(M.LINES.CONFIG_INVALID), label + ' (env)');
    assert.match(o1.hookSpecificOutput.additionalContext, /first warning size \(100k\)/, label + ': defaults used');
    const o2 = promptAt(b, plug, penv, 100000, sid);
    assert.equal(o2, null, label + ': notice once');
    writeConfig(copy, fileOpts);
    const c1 = promptAt(b, copy, H.copyEnv(b), 100000, sid);
    assert.ok(c1.systemMessage.includes(M.LINES.CONFIG_INVALID), label + ' (file)');
    assert.equal(promptAt(b, copy, H.copyEnv(b), 100000, sid), null);
    assert.deepEqual(M.validateOptions(envOpts), M.validateOptions(fileOpts), label + ': same fall-back from every source');
  }
  writeConfig(copy, '{not json');
  assert.ok(promptAt(b, copy, H.copyEnv(b), 50000, H.sessionId(150)).systemMessage.includes(M.LINES.CONFIG_INVALID));
  const zero = M.validateOptions({ repeat_every_tokens: 0 });
  assert.equal(zero.invalid, false);
  assert.equal(zero.options.repeat_every_tokens, 0);
  assert.equal(promptAt(b, plug, H.pluginEnv(b, plug, { repeat_every_tokens: 0 }), 50000, H.sessionId(151)), null, 'valid, no notice');
});

test('6.2 / live check 5 (hooks): plugin mode reads CLAUDE_PLUGIN_OPTION_<KEY in upper case>, the only form seen live; absent (never set), empty ("") or raw ${user_config...} text means the default; copy-by-hand ignores the env and reads the kit file; the same values give the same tier from both sources', () => {
  const b = H.makeBase('src');
  const plug = H.pluginKit(b);
  const copy = H.copyKit(b);
  assert.deepEqual(M.readEnvOptions({}), {});
  assert.deepEqual(M.readEnvOptions({ CLAUDE_PLUGIN_OPTION_SOFT_TOKENS: '' }), {});
  assert.deepEqual(M.readEnvOptions({ CLAUDE_PLUGIN_OPTION_SOFT_TOKENS: '${user_config.soft_tokens}' }), {});
  assert.deepEqual(M.readEnvOptions({ CLAUDE_PLUGIN_OPTION_SOFT_TOKENS: '120000' }), { soft_tokens: '120000' });
  // The key as written (lower case) is not a form Claude Code exports, so it is not read.
  assert.deepEqual(M.readEnvOptions({ CLAUDE_PLUGIN_OPTION_soft_tokens: '120000' }), {});
  assert.deepEqual(M.readEnvOptions({ CLAUDE_PLUGIN_OPTION_HARD_TOKENS: '200000', CLAUDE_PLUGIN_OPTION_HANDOFF_NOTE: 'false' }), { hard_tokens: '200000', handoff_note: 'false' });
  assert.deepEqual(M.validateOptions(M.readEnvOptions({})), { options: { ...M.DEFAULTS }, invalid: false });
  const vals = { soft_tokens: 120000, hard_tokens: 130000 };
  const penv = H.pluginEnv(b, plug, vals);
  assert.match(promptAt(b, plug, penv, 125000, H.sessionId(160)).hookSpecificOutput.additionalContext, /first warning size \(120k\)/);
  writeConfig(copy, vals);
  const cenv = { ...H.copyEnv(b), CLAUDE_PLUGIN_OPTION_SOFT_TOKENS: '9999' };
  assert.match(promptAt(b, copy, cenv, 125000, H.sessionId(160)).hookSpecificOutput.additionalContext, /first warning size \(120k\)/, 'file read, env ignored');
  assert.equal(M.tierOf(125000, M.validateOptions(vals).options), M.tierOf(125000, M.validateOptions(M.readEnvOptions(penv)).options));
  const src = fs.readFileSync(H.METER_SRC, 'utf8');
  assert.equal(src.split('SEAM(check 5)').length - 1, 0, 'the hook option seam is closed (second logged-in probe)');
});

// ---------------------------------------------------------------------------
// 6.7: install mode, write-nothing modes

test('6.7 / SR-C10: install mode by the 6.7 rule: the variable set but the script outside the plugin cache -> copy-by-hand (said once); inside the cache with the variable unset or empty -> nothing written', () => {
  const b = H.makeBase('mode');
  const plug = H.pluginKit(b);
  const copy = H.copyKit(b);
  const t = H.writeTranscript(b, 150000);
  const m = M.installMode({ env: { CLAUDE_CONFIG_DIR: b.config, CLAUDE_PLUGIN_DATA: plug.data }, scriptFile: copy.scriptFile, home: b.home });
  assert.equal(m.mode, 'copy');
  assert.equal(m.stateRoot, copy.stateRoot);
  const cenv = { ...H.copyEnv(b), CLAUDE_PLUGIN_DATA: plug.data };
  const before = H.listing(plug.data);
  const out = M.handlePrompt(H.promptInput(b, t, H.sessionId(200)), ctxOf(b, copy, cenv));
  assert.ok(out.systemMessage.includes(M.LINES.PLUGIN_DATA_IGNORED));
  assert.deepEqual(H.listing(plug.data), before, 'nothing in the variable folder');
  assert.ok(stateFiles(copy).length === 1);
  const again = M.handlePrompt(H.promptInput(b, H.writeTranscript(b, 210000, { name: 'r' }), H.sessionId(200)), ctxOf(b, copy, cenv));
  assert.ok(!again.systemMessage.includes(M.LINES.PLUGIN_DATA_IGNORED), 'said once');
  for (const v of [undefined, '']) {
    const env = { CLAUDE_CONFIG_DIR: b.config, CLAUDE_PROJECT_DIR: b.proj };
    if (v !== undefined) env.CLAUDE_PLUGIN_DATA = v;
    assert.equal(M.installMode({ env, scriptFile: plug.scriptFile, home: b.home }).mode, 'none');
    const pbefore = H.listing(b.config);
    assert.equal(M.handlePrompt(H.promptInput(b, t, H.sessionId(201)), ctxOf(b, plug, env)), null);
    assert.deepEqual(H.listing(b.config), pbefore);
  }
  const moved = { CLAUDE_CONFIG_DIR: b.config, CLAUDE_CODE_PLUGIN_CACHE_DIR: H.mk(b.base, 'moved-plugins'), CLAUDE_PLUGIN_DATA: plug.data };
  assert.equal(M.installMode({ env: moved, scriptFile: plug.scriptFile, home: b.home }).mode, 'copy', 'the moved plugins folder is the one compared');
});

test('6.7 / SR-C8: a state root inside a git work tree (plugin and copy-by-hand mode), or a copy-by-hand kit folder that is a plugin source folder (in and out of a work tree) -> nothing written, no tier warning, no hand-off pre-create', () => {
  const b = H.makeBase('git');
  const plug = H.pluginKit(b);
  const copy = H.copyKit(b);
  const t = H.writeTranscript(b, 150000);
  fs.mkdirSync(path.join(b.config, '.git'));
  const pbefore = H.listing(b.config);
  assert.equal(M.writeBlock(M.installMode({ env: H.pluginEnv(b, plug), scriptFile: plug.scriptFile, home: b.home }), b.base), 'in_git');
  assert.equal(M.handlePrompt(H.promptInput(b, t), ctxOf(b, plug, H.pluginEnv(b, plug))), null);
  assert.deepEqual(H.listing(b.config), pbefore);
  fs.writeFileSync(path.join(copy.stateRoot, '.git'), 'gitdir: elsewhere\n');
  const cbefore = H.listing(copy.stateRoot);
  assert.equal(M.handlePrompt(H.promptInput(b, t), ctxOf(b, copy, H.copyEnv(b))), null);
  assert.deepEqual(H.listing(copy.stateRoot), cbefore);
  // Source folder: a kit folder holding .claude-plugin/plugin.json.
  const src = H.copyKit(b, 'source');
  fs.mkdirSync(path.join(src.stateRoot, '.claude-plugin'));
  fs.writeFileSync(path.join(src.stateRoot, '.claude-plugin', 'plugin.json'), '{}');
  for (const inGit of [false, true]) {
    if (inGit) fs.mkdirSync(path.join(src.stateRoot, '.git'));
    const before = H.listing(src.stateRoot);
    const mode = M.installMode({ env: H.copyEnv(b), scriptFile: src.scriptFile, home: b.home });
    assert.equal(M.writeBlock(mode, b.base), 'source_folder');
    assert.equal(M.handlePrompt(H.promptInput(b, t), ctxOf(b, src, H.copyEnv(b))), null);
    assert.deepEqual(H.listing(src.stateRoot), before);
  }
});

// ---------------------------------------------------------------------------
// 6.7: link-safe atomic writes, pruning, temp files

test('6.7 / SR-C2: a state folder replaced by a link or junction is refused and nothing is written through it; a junction that lstat does not report is refused by the real-path check', () => {
  const b = H.makeBase('links');
  const outside = H.mk(b.base, 'outside');
  const t = H.writeTranscript(b, 150000);
  for (const which of [['state'], ['state', 'sessions']]) {
    const kit = H.copyKit(b, 'kit-' + which.length);
    if (which.length === 2) fs.mkdirSync(path.join(kit.stateRoot, 'state'));
    H.dirLink(outside, path.join(kit.stateRoot, ...which));
    const before = H.listing(outside);
    assert.equal(M.handlePrompt(H.promptInput(b, t), ctxOf(b, kit, H.copyEnv(b))), null, which.join('/'));
    assert.deepEqual(H.listing(outside), before);
    assert.ok(!fs.existsSync(path.join(kit.stateRoot, 'handoff')));
  }
  const real = H.mk(b.base, 'real-folder');
  const junction = H.dirLink(real, path.join(b.base, 'unreported'));
  const fakeStat = () => ({ isSymbolicLink: () => false, isDirectory: () => true });
  assert.equal(M.folderProblem(junction, junction, process.platform, fakeStat), 'moved');
  assert.equal(M.folderProblem(real, real), null);
  assert.equal(M.folderProblem(junction, junction), 'link');
});

test('6.7 / SR-C2 / SR-C7: a pre-planted link at the temp name is not followed; a failed write leaves no temp file; success replaces the target in one rename', () => {
  const b = H.makeBase('atomic');
  const dir = H.mk(b.base, 'state');
  const outside = H.mk(b.base, 'outside');
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  const tmpName = 's.json.' + process.pid + '.0123456789abcdef.tmp';
  H.dirLink(outside, path.join(dir, tmpName));
  const before = H.listing(outside);
  assert.throws(() => M.atomicWrite({ dir, expectedDir: dir, rootReal: b.base, name: 's.json', data: 'x', _tempName: tmpName }), (e) => e.code === 'temp_exists');
  assert.deepEqual(H.listing(outside), before);
  try { fs.unlinkSync(path.join(dir, tmpName)); } catch (_) { fs.rmdirSync(path.join(dir, tmpName)); }
  const fileTarget = path.join(outside, 'keep.txt');
  if (H.fileLink(fileTarget, path.join(dir, tmpName))) {
    assert.throws(() => M.atomicWrite({ dir, expectedDir: dir, rootReal: b.base, name: 's.json', data: 'x', _tempName: tmpName }));
    assert.equal(fs.readFileSync(fileTarget, 'utf8'), 'keep');
    fs.unlinkSync(path.join(dir, tmpName));
  }
  assert.throws(() => M.atomicWrite({ dir, expectedDir: dir, rootReal: b.base, name: 's.json', data: 'x', _failAfterTemp: true }), (e) => e.code === 'forced_failure');
  assert.deepEqual(fs.readdirSync(dir), [], 'no temp file left');
  M.atomicWrite({ dir, expectedDir: dir, rootReal: b.base, name: 's.json', data: 'one' });
  M.atomicWrite({ dir, expectedDir: dir, rootReal: b.base, name: 's.json', data: 'two' });
  assert.equal(fs.readFileSync(path.join(dir, 's.json'), 'utf8'), 'two');
  assert.deepEqual(fs.readdirSync(dir), ['s.json']);
  if (!IS_WIN) assert.equal(fs.statSync(path.join(dir, 's.json')).mode & 0o777, 0o600);
  assert.throws(() => M.atomicWrite({ dir: outside, expectedDir: outside, rootReal: dir, name: 's.json', data: 'x' }), (e) => e.code === 'outside_state_root');
});

test('6.7 / SR-C2 / SR-C7: the folder is checked again right before the rename: a state folder swapped for a junction after the temp file is written is refused; a file planted at the temp name outside is not renamed to the target there', () => {
  const b = H.makeBase('rename-swap');
  const root = H.mk(b.base, 'root');
  const dir = H.mk(root, 'state');
  const outside = H.mk(b.base, 'outside');
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  // A file planted in the outside folder under the exact temp name the write will use:
  // a rename through the swapped folder would turn it into outside/s.json.
  const tmpName = 's.json.1.0123456789abcdef.tmp';
  fs.writeFileSync(path.join(outside, tmpName), 'planted');
  const swap = () => {
    fs.renameSync(dir, dir + '-moved');
    H.dirLink(outside, dir);
  };
  assert.throws(() => M.atomicWrite({ dir, expectedDir: dir, rootReal: root, name: 's.json', data: 'x', _tempName: tmpName, _beforeRename: swap }), (e) => /^folder_/.test(e.code));
  assert.equal(fs.existsSync(path.join(outside, 's.json')), false, 'nothing renamed into the outside folder');
  assert.deepEqual(fs.readdirSync(outside).sort(), ['keep.txt', tmpName].sort());
  assert.equal(fs.readFileSync(path.join(outside, tmpName), 'utf8'), 'planted', 'the planted file is not unlinked either');
  fs.rmSync(dir, { recursive: false, force: true });
});

test('6.7 / SR-C3: pruning removes only old exact session files; config, notes, other names, a folder and a link named like a session file are left (the link target untouched); the 14-day boundary', () => {
  const b = H.makeBase('prune');
  const kit = H.copyKit(b);
  const sessions = H.mk(kit.stateRoot, 'state', 'sessions');
  const cfg = H.mk(kit.stateRoot, 'config');
  fs.writeFileSync(path.join(cfg, 'meter-config.json'), '{}');
  const outside = H.mk(b.base, 'outside');
  fs.writeFileSync(path.join(outside, 'target.txt'), 'keep');
  const files = { old: 'aaaa.json', edge: 'bbbb.json', young: 'cccc.json', hashed: 'h-' + '0'.repeat(32) + '.json', other: 'notes.txt', upper: 'ABC.json' };
  for (const n of Object.values(files)) fs.writeFileSync(path.join(sessions, n), '{}');
  fs.mkdirSync(path.join(sessions, 'dddd.json'));
  H.dirLink(outside, path.join(sessions, 'eeee.json'));
  const AGE = M.LIMITS.PRUNE_AGE_MS;
  const edgeMs = Date.now() - AGE - 60 * 60 * 1000;
  H.setMtime(path.join(sessions, files.edge), 0, edgeMs);
  const now = fs.statSync(path.join(sessions, files.edge)).mtimeMs + AGE;
  H.setMtime(path.join(sessions, files.young), 0, now - AGE + 60000);
  for (const n of [files.old, files.hashed, files.other, files.upper]) H.setMtime(path.join(sessions, n), AGE * 2, now);
  try { H.setMtime(path.join(sessions, 'dddd.json'), AGE * 2, now); } catch (_) { /* best effort: a folder's time */ }
  const r = M.pruneSessions(kit.stateRoot, { now });
  assert.deepEqual(fs.readdirSync(sessions).sort(), [files.young, files.other, files.upper, 'dddd.json', 'eeee.json'].sort());
  assert.equal(r.removed, 3);
  assert.equal(fs.readFileSync(path.join(outside, 'target.txt'), 'utf8'), 'keep');
  assert.ok(fs.existsSync(path.join(cfg, 'meter-config.json')));
});

test('T-30 (core part): pruning with one old session file that cannot be deleted -> the other old files are still deleted and the failure is counted', () => {
  const b = H.makeBase('t30');
  const sessions = H.mk(b.base, 'state', 'sessions');
  for (const n of ['aaaa.json', 'bbbb.json', 'cccc.json']) {
    fs.writeFileSync(path.join(sessions, n), '{}');
    H.setMtime(path.join(sessions, n), M.LIMITS.PRUNE_AGE_MS * 2);
  }
  const r = M.pruneSessions(b.base, {
    _unlink: (p) => { if (path.basename(p) === 'bbbb.json') { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } fs.unlinkSync(p); },
  });
  assert.deepEqual({ removed: r.removed, failed: r.failed }, { removed: 2, failed: 1 });
  assert.deepEqual(fs.readdirSync(sessions), ['bbbb.json']);
});

test('6.7 / SR-C7: a leftover temp file older than 10 minutes is removed at start; a newer one and a non-matching name are left', () => {
  const b = H.makeBase('temps');
  const kit = H.copyKit(b);
  const sessions = H.mk(kit.stateRoot, 'state', 'sessions');
  const oldTmp = 'aaaa.json.123.0123456789abcdef.tmp';
  const newTmp = 'bbbb.json.124.0123456789abcdef.tmp';
  const other = 'something.tmp';
  for (const n of [oldTmp, newTmp, other]) fs.writeFileSync(path.join(sessions, n), 'x');
  H.setMtime(path.join(sessions, oldTmp), 11 * 60 * 1000);
  H.setMtime(path.join(sessions, other), 60 * 60 * 1000);
  M.handlePrompt(H.promptInput(b, H.writeTranscript(b, 50000)), ctxOf(b, kit, H.copyEnv(b)));
  const left = fs.readdirSync(sessions).sort();
  assert.ok(!left.includes(oldTmp));
  assert.ok(left.includes(newTmp) && left.includes(other));
});

test('6.7 / SR-C2 / SR-C7 / 10.10: config/ as a link or junction -> one prompt deletes nothing through it and reads no config through it (defaults and the notice); nothing outside is touched, in both install modes', () => {
  for (const modeName of ['copy', 'plugin']) {
    const b = H.makeBase('cfglink-' + modeName);
    const kit = modeName === 'plugin' ? H.pluginKit(b) : H.copyKit(b);
    const env = modeName === 'plugin' ? H.pluginEnv(b, kit) : H.copyEnv(b);
    const outside = H.mk(b.base, 'outside');
    const tmpName = 'meter-config.json.123.0123456789abcdef.tmp';
    fs.writeFileSync(path.join(outside, tmpName), 'x');
    H.setMtime(path.join(outside, tmpName), 60 * 60 * 1000);
    fs.writeFileSync(path.join(outside, 'meter-config.json'), JSON.stringify({ soft_tokens: 120000, hard_tokens: 130000 }));
    H.dirLink(outside, path.join(kit.stateRoot, 'config'));
    const before = H.listing(outside);
    const out = promptAt(b, kit, env, 125000, H.sessionId(620));
    assert.deepEqual(H.listing(outside), before, modeName + ': outside untouched');
    if (modeName === 'copy') {
      assert.ok(out.systemMessage.includes(M.LINES.CONFIG_INVALID), 'a linked config folder counts as invalid');
      assert.match(out.hookSpecificOutput.additionalContext, /first warning size \(100k\)/, 'defaults, not the linked file');
    }
    const r = M.cleanTemps(kit.stateRoot, ['config'], { now: Date.now() });
    assert.equal(r.refused, 'link');
    assert.equal(r.removed, 0);
    assert.deepEqual(H.listing(outside), before);
  }
});

test('6.7 / SR-C2 / SR-C3: temp cleanup and pruning check their own folder: a link or junction at a parent inside the state root, a path outside it, or a root that is not a real path -> nothing listed or deleted', () => {
  const b = H.makeBase('parentlink');
  const kit = H.copyKit(b);
  const outside = H.mk(b.base, 'outside');
  const outSessions = H.mk(outside, 'sessions');
  const oldTmp = 'aaaa.json.123.0123456789abcdef.tmp';
  fs.writeFileSync(path.join(outSessions, oldTmp), 'x');
  fs.writeFileSync(path.join(outSessions, 'aaaa.json'), '{}');
  H.setMtime(path.join(outSessions, oldTmp), 60 * 60 * 1000);
  H.setMtime(path.join(outSessions, 'aaaa.json'), M.LIMITS.PRUNE_AGE_MS * 2);
  H.dirLink(outside, path.join(kit.stateRoot, 'state'));
  const before = H.listing(outside);
  assert.equal(M.cleanTemps(kit.stateRoot, ['state', 'sessions']).refused, 'moved');
  assert.equal(M.pruneSessions(kit.stateRoot).refused, 'moved');
  assert.equal(M.cleanTemps(kit.stateRoot, ['..', 'outside', 'sessions']).refused, 'outside_state_root');
  assert.equal(M.cleanTemps(kit.stateRoot, []).refused, 'bad_path');
  // A root reached through a link is not its own real path: refused, not followed.
  const linkedRoot = H.dirLink(outside, path.join(b.base, 'linked-root'));
  assert.equal(M.cleanTemps(linkedRoot, ['sessions']).refused, 'moved');
  assert.equal(M.pruneSessions(path.join(b.base, 'linked-root', '..', 'linked-root'), {}).removed, 0);
  assert.deepEqual(H.listing(outside), before, 'nothing deleted');
  assert.deepEqual(M.checkedFolder(outside, ['sessions']), { dir: outSessions });
});

test('6.7 / SR-C7: temp cleanup removes only temp names of the files the meter writes in that folder; a user file with a temp-like name for another base survives', () => {
  const b = H.makeBase('tempbase');
  const kit = H.copyKit(b);
  const hex = () => crypto.randomBytes(8).toString('hex');
  const tempOf = (base) => base + '.' + (1000 + crypto.randomInt(1000)) + '.' + hex() + '.tmp';
  const folders = {
    config: { own: tempOf('meter-config.json'), user: [tempOf('notes.json'), tempOf('meter.cjs')] },
    'state/sessions': { own: tempOf('aaaa.json'), user: [tempOf('Notes.json'), tempOf('meter.cjs')] },
    statusline: { own: tempOf('meter.cjs'), user: [tempOf('meter-config.json'), tempOf('helper.cjs')] },
  };
  for (const [rel, f] of Object.entries(folders)) {
    const dir = H.mk(kit.stateRoot, ...rel.split('/'));
    for (const n of [f.own, ...f.user]) {
      fs.writeFileSync(path.join(dir, n), 'x');
      H.setMtime(path.join(dir, n), 60 * 60 * 1000);
    }
    const r = M.cleanTemps(kit.stateRoot, rel.split('/'));
    assert.equal(r.removed, 1, rel);
    assert.deepEqual(fs.readdirSync(dir).sort(), [...f.user].sort(), rel);
  }
  // A folder the meter writes no temp files in: nothing is removed.
  const handoff = H.mk(kit.stateRoot, 'handoff');
  const stray = tempOf('aaaa.json');
  fs.writeFileSync(path.join(handoff, stray), 'x');
  H.setMtime(path.join(handoff, stray), 60 * 60 * 1000);
  const r = M.cleanTemps(kit.stateRoot, ['handoff']);
  assert.deepEqual({ removed: r.removed, refused: r.refused }, { removed: 0, refused: 'not_own_folder' });
  assert.deepEqual(fs.readdirSync(handoff), [stray]);
});

test('6.7: the git-work-tree check fails closed: a .git probe error other than not-found counts as found; ENOENT and ENOTDIR keep walking up', () => {
  const b = H.makeBase('gitprobe');
  const throwing = (code) => () => { const e = new Error(code); e.code = code; throw e; };
  assert.equal(M.inGitWorkTree(b.proj, b.base, throwing('EACCES')), true);
  assert.equal(M.inGitWorkTree(b.proj, b.base, throwing('EPERM')), true);
  assert.equal(M.inGitWorkTree(b.proj, b.base, throwing('ENOENT')), false);
  assert.equal(M.inGitWorkTree(b.proj, b.base, throwing('ENOTDIR')), false);
  assert.equal(M.inGitWorkTree(b.proj, b.base), false);
});

// ---------------------------------------------------------------------------
// T-25 (core part): the same compare answers as the server

test('T-25 (core part): the core and the server path compare give the same answers', () => {
  const W = F.BS;
  const cases = [
    ['/x/ab', '/x/a', 'linux', false],
    ['/x/a/../b', '/x/a', 'linux', false],
    ['/x/a/..notes', '/x/a', 'linux', true],
    ['/x/a', '/x/a', 'linux', true],
    ['/X/a', '/x', 'linux', false],
    ['/X/a', '/x', 'darwin', true],
    ['D:' + W + 'x', 'C:' + W + 'x', 'win32', false],
    [W + W + 'srv' + W + 'share' + W + 'x', 'C:' + W + 'x', 'win32', false],
    ['C:' + W + 'X' + W + 'A', 'c:' + W + 'x', 'win32', true],
    ['C:' + W + 'x' + W + '..notes', 'C:' + W + 'x', 'win32', true],
  ];
  for (const [c, p, plat, want] of cases) {
    assert.equal(M.isInside(c, p, plat), want, `core ${c} in ${p} (${plat})`);
    assert.equal(FSX.isInside(c, p, plat), want, `server ${c} in ${p} (${plat})`);
    assert.equal(M.samePath(c, p, plat), FSX.samePath(c, p, plat));
  }
});

// ---------------------------------------------------------------------------
// 6.9: the Node self-check, ASCII JSON, exit 0, time budget, stdin

test('6.9 / T-35 (unit): Node inside the project or start folder is caught; a filesystem root, home or above-home folder is not tested', () => {
  const b = H.makeBase('selfcheck');
  const exe = path.join(H.mk(b.proj, 'tools'), IS_WIN ? 'node.exe' : 'node');
  fs.writeFileSync(exe, '');
  assert.equal(M.nodeInsideProject({ execPath: exe, projectDir: b.proj, cwd: b.base, home: b.home }), true);
  assert.equal(M.nodeInsideProject({ execPath: exe, projectDir: undefined, cwd: b.proj, home: b.home }), true);
  const homeExe = path.join(H.mk(b.home, 'node'), IS_WIN ? 'node.exe' : 'node');
  fs.writeFileSync(homeExe, '');
  assert.equal(M.nodeInsideProject({ execPath: homeExe, projectDir: b.home, cwd: b.home, home: b.home }), false);
  assert.equal(M.nodeInsideProject({ execPath: homeExe, projectDir: b.base, cwd: b.base, home: b.home }), false);
  assert.equal(M.nodeInsideProject({ execPath: homeExe, projectDir: path.parse(b.base).root, cwd: path.parse(b.base).root, home: b.home }), false);
  // Through handlePrompt: the input cwd is checked too, before any file.
  const kit = H.copyKit(b);
  const out = M.handlePrompt(H.promptInput(b, H.writeTranscript(b, 150000)), ctxOf(b, kit, { CLAUDE_CONFIG_DIR: b.config }, { execPath: exe }));
  assert.deepEqual(out, { systemMessage: M.LINES.NODE_IN_PROJECT });
  assert.ok(!fs.existsSync(path.join(kit.stateRoot, 'state')));
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

test('T-35 (core part): a copy of the running Node inside the project, as CLAUDE_PROJECT_DIR, as the input cwd and as the process start folder -> nothing written anywhere and the fixed line once', () => {
  const b = H.makeBase('t35');
  const kit = H.copyKit(b);
  const t = H.writeTranscript(b, 150000);
  const planted = plantNode(path.join(b.proj, 'tools'));
  // Control: the same run with the real Node writes state.
  // The other folders used here (b.tdir) hold no Node copy; b.base would, as it holds the project.
  const ctl = R.runMeter(b, { scriptFile: kit.scriptFile, input: JSON.stringify(H.promptInput(b, t, H.sessionId(300), { cwd: b.tdir })), env: H.copyEnv(b), cwd: b.tdir });
  assert.equal(ctl.status, 0);
  assert.ok(JSON.parse(ctl.text).hookSpecificOutput, 'control run warns');
  const cases = [
    ['project dir', { CLAUDE_PROJECT_DIR: b.proj }, b.tdir, b.tdir],
    ['input cwd', { CLAUDE_PROJECT_DIR: undefined }, b.tdir, b.proj],
    ['start folder', { CLAUDE_PROJECT_DIR: undefined }, b.proj, b.tdir],
  ];
  let k = 301;
  for (const [label, env, cwd, inputCwd] of cases) {
    const before = { kit: H.listing(kit.stateRoot), proj: H.listing(b.proj) };
    const r = R.runMeter(b, {
      scriptFile: kit.scriptFile, execPath: planted, cwd,
      env: { CLAUDE_CONFIG_DIR: b.config, ...env },
      input: JSON.stringify(H.promptInput(b, t, H.sessionId(k++), { cwd: inputCwd })),
    });
    assert.equal(r.status, 0, label);
    assert.deepEqual(JSON.parse(r.text), { systemMessage: M.LINES.NODE_IN_PROJECT }, label);
    assert.equal(r.text.trim().split('\n').length, 1);
    assert.deepEqual(H.listing(kit.stateRoot), before.kit, label + ': state root unchanged');
    assert.deepEqual(H.listing(b.proj), before.proj, label + ': project unchanged');
  }
});

test('6.9 / T-35 (core part): --sync with Node inside the project (as CLAUDE_PROJECT_DIR, or as the process start folder) prints its skipped line and writes nothing; the same run with the real Node copies', () => {
  const b = H.makeBase('t35sync');
  const plug = H.pluginKit(b);
  const planted = plantNode(path.join(b.proj, 'tools'));
  const cases = [
    ['project dir', H.pluginEnv(b, plug), b.tdir],
    ['start folder', { ...H.pluginEnv(b, plug), CLAUDE_PROJECT_DIR: undefined }, b.proj],
  ];
  for (const [label, env, cwd] of cases) {
    const before = { data: H.listing(plug.data), proj: H.listing(b.proj) };
    const r = R.runMeter(b, { scriptFile: plug.scriptFile, args: ['--sync'], execPath: planted, cwd, env });
    assert.equal(r.status, 0, label);
    assert.equal(r.text.trim(), 'sync: skipped (node_in_project)', label);
    assert.deepEqual(H.listing(plug.data), before.data, label + ': data folder unchanged');
    assert.deepEqual(H.listing(b.proj), before.proj, label + ': project unchanged');
  }
  const ctl = R.runMeter(b, { scriptFile: plug.scriptFile, args: ['--sync'], cwd: b.tdir, env: H.pluginEnv(b, plug) });
  assert.equal(ctl.status, 0);
  assert.equal(ctl.text.trim(), 'sync: copied', 'control: the real Node copies');
  assert.ok(fs.existsSync(path.join(plug.data, 'statusline', 'meter.cjs')));
});

test('6.9 / T-35 (core part): --statusline with Node inside the project prints the empty form with the default thresholds and reads nothing (no stdin size, no config); the same run with the real Node reads both', () => {
  const b = H.makeBase('t35sl');
  const plug = H.pluginKit(b);
  const cfg = H.mk(plug.data, 'config');
  fs.writeFileSync(path.join(cfg, 'meter-config.json'), JSON.stringify({ soft_tokens: 120000, hard_tokens: 130000 }));
  const planted = plantNode(path.join(b.proj, 'tools'));
  const input = JSON.stringify({ context_window: { total_input_tokens: 140000 } });
  const empty = M.renderStatusLine(null, M.DEFAULTS);
  assert.equal(empty, 'chat -- (warn 100k/150k)');
  const cases = [
    ['project dir', H.pluginEnv(b, plug), b.tdir],
    ['start folder', { ...H.pluginEnv(b, plug), CLAUDE_PROJECT_DIR: undefined }, b.proj],
  ];
  for (const [label, env, cwd] of cases) {
    const before = { data: H.listing(plug.data), proj: H.listing(b.proj) };
    const r = R.runMeter(b, { scriptFile: plug.scriptFile, args: ['--statusline'], input, execPath: planted, cwd, env });
    assert.equal(r.status, 0, label);
    assert.equal(r.text.trim(), empty, label);
    assert.deepEqual(H.listing(plug.data), before.data, label + ': nothing written');
    assert.deepEqual(H.listing(b.proj), before.proj, label + ': project unchanged');
  }
  const ctl = R.runMeter(b, { scriptFile: plug.scriptFile, args: ['--statusline'], input, cwd: b.tdir, env: H.pluginEnv(b, plug) });
  assert.equal(ctl.text.trim(), 'chat 140k NEW SESSION NOW (warn 120k/130k)', 'control: size and config read');
});

test('6.9 / T-38: spaces and non-ASCII paths work; the JSON out is ASCII (non-ASCII escaped as \\uXXXX); exit 0 within the time budget; no blocking field', () => {
  const b = H.makeBase('ascii', { sub: 'a b é中' });
  const plug = H.pluginKit(b);
  const t = H.writeTranscript(b, 150000);
  const r = R.runMeter(b, { scriptFile: plug.scriptFile, input: JSON.stringify(H.promptInput(b, t)), env: H.pluginEnv(b, plug) });
  assert.equal(r.status, 0);
  assert.ok(r.ms < 2500, 'time: ' + r.ms);
  for (const byte of r.stdout) assert.ok(byte < 0x80, 'ASCII bytes only');
  assert.ok(r.text.includes('\\u00e9'), 'escaped');
  const out = JSON.parse(r.text);
  noBlocking(out);
  const notes = noteFiles(path.join(plug.data, 'handoff'));
  assert.equal(notes.length, 1);
  assert.ok(out.hookSpecificOutput.additionalContext.includes(path.join(plug.data, 'handoff', notes[0])));
  assert.ok(!/[^\x00-\x7f]/.test(M.LINES.FORMAT + M.LINES.CONFIG_INVALID + M.LINES.NODE_IN_PROJECT + M.LINES.HANDOFF_DIR_REFUSED + M.LINES.NOTE_CLASH));
});

test('6.9 / T-38: empty, garbage and oversize stdin -> exit 0, no output; stdin that never closes -> the 2.5 s self-kill (allowed 4 s)', async () => {
  const b = H.makeBase('stdin');
  const kit = H.copyKit(b);
  for (const input of ['', 'garbage{', '[1,2]', 'null', Buffer.alloc(M.LIMITS.STDIN_MAX_BYTES + 10, 0x20)]) {
    const r = R.runMeter(b, { scriptFile: kit.scriptFile, input, env: H.copyEnv(b) });
    assert.equal(r.status, 0);
    assert.equal(r.text.trim(), '');
  }
  const big = JSON.stringify({ ...H.promptInput(b, H.writeTranscript(b, 150000)), pad: 'a'.repeat(M.LIMITS.STDIN_MAX_BYTES) });
  const over = R.runMeter(b, { scriptFile: kit.scriptFile, input: big, env: H.copyEnv(b) });
  assert.equal(over.status, 0);
  assert.equal(over.text.trim(), '', 'read stops at the cap; nothing acted on');
  const hang = await R.runWithOpenStdin(b, { scriptFile: kit.scriptFile, env: H.copyEnv(b) });
  assert.equal(hang.code, 0);
  assert.ok(hang.ms >= 2000 && hang.ms < 4000, 'self-kill: ' + hang.ms);
});

test('6.9: the 2.5 s self-kill covers the prompt hook, --statusline and --sync, not --selftest', () => {
  assert.equal(M.LIMITS.SELF_KILL_MS, 2500);
  for (const argv of [[], ['--statusline'], ['--sync'], ['--other']]) assert.equal(M.selfKillMs(argv), 2500, argv.join(' '));
  assert.equal(M.selfKillMs(['--selftest', 'x.jsonl']), null);
  assert.equal(M.selfKillMs(['--selftest']), null);
});

// ---------------------------------------------------------------------------
// --selftest, T-36

test('6.8: --selftest prints counts and the size only, no transcript text, and writes nothing', () => {
  const b = H.makeBase('selftest');
  const kit = H.copyKit(b);
  const unique = 'zq unique sentence ' + crypto.randomBytes(6).toString('hex');
  const rec = JSON.parse(H.assistantLine({ input: 2, read: 4998 }));
  rec.message.content[0].text = unique;
  const t = H.writeTranscript(b, H.FIXTURE_LINES.concat([JSON.stringify(rec)]).join('\n') + '\n');
  const before = H.listing(b.base);
  const r = R.runMeter(b, { scriptFile: kit.scriptFile, args: ['--selftest', t], seams: null });
  assert.equal(r.status, 0);
  assert.match(r.text, /^selftest: ok; lines 29, usage records 3, side-chain records skipped 0, unreadable lines 0, bytes \d+; chat size 5000 \(5k\)\s*$/);
  assert.ok(!r.text.includes(unique));
  assert.deepEqual(H.listing(b.base), before, 'writes nothing');
  const bad = H.writeTranscript(b, 'not json\n', { name: 'bad' });
  assert.match(M.selftest(bad), /^selftest: no usage record found; lines 1, usage records 0/);
  assert.match(M.selftest(path.join(b.tdir, 'none.jsonl')), /could not be read as a file \(missing\)/);
});

test('T-36 (core part): a full session of meter calls in plugin mode and in copy-by-hand mode changes only files under the state root; the project and the home folder are byte-identical', () => {
  for (const modeName of ['plugin', 'copy']) {
    const b = H.makeBase('t36-' + modeName);
    const kit = modeName === 'plugin' ? H.pluginKit(b) : H.copyKit(b);
    const env = modeName === 'plugin' ? H.pluginEnv(b, kit) : H.copyEnv(b);
    const sizes = [50000, 100000, 150000, 200000, 20000];
    const ts = sizes.map((s, i) => H.writeTranscript(b, s, { name: 't' + i }));
    fs.writeFileSync(path.join(b.proj, 'README.md'), 'project');
    const before = H.listing(b.base);
    const projBefore = H.listing(b.proj);
    const homeBefore = H.listing(b.home);
    ts.forEach((t) => M.handlePrompt(H.promptInput(b, t, H.sessionId(400)), ctxOf(b, kit, env)));
    if (modeName === 'plugin') M.syncForTest({ env, scriptFile: kit.scriptFile, home: b.home, gitCeiling: b.base }, b.base);
    M.statusLine({ context_window: { total_input_tokens: 150000 } }, ctxOf(b, kit, env));
    const after = H.listing(b.base);
    const rootRel = path.relative(b.base, kit.stateRoot).split(path.sep).join('/');
    const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
    assert.ok(changed.length > 0);
    for (const k of changed) assert.ok(k.startsWith(rootRel + '/'), modeName + ': ' + k);
    assert.deepEqual(H.listing(b.proj), projBefore);
    assert.deepEqual(H.listing(b.home), homeBefore);
  }
});
