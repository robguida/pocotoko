'use strict';
// The session start hook (spec 5.1, 6.6, 6.7, 6.9, 6.11, 6.12; SR-C8 session-start half;
// T-35, T-36 and T-38 session-start parts). Runs against sandbox copies only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../../src/core/hooks/meter.cjs');
const S = require('../../src/core/hooks/session-start.cjs');
const H = require('../helpers/meter-env.cjs');
const R = require('../helpers/meter-run.cjs');

const IS_WIN = process.platform === 'win32';
test.after(() => H.cleanup());

const ROUTING_BLOCK = S.extractBlock(fs.readFileSync(H.ROUTING_SKILL_SRC, 'utf8'));

function startInput(b, extra = {}) {
  return { session_id: H.sessionId(1), transcript_path: path.join(b.tdir, 'chat.jsonl'), cwd: b.proj, hook_event_name: 'SessionStart', source: 'startup', ...extra };
}
function run(b, kit, env, extra = {}) {
  return S.handleSessionStart(extra.input || startInput(b), { env, scriptFile: kit.startFile, home: b.home, platform: process.platform, gitCeiling: b.base, ...(extra.ctx || {}) });
}
function ctxLines(out) {
  return out && out.hookSpecificOutput ? out.hookSpecificOutput.additionalContext.split('\n') : [];
}
function lineWith(out, prefix) {
  return ctxLines(out).find((l) => l.startsWith(prefix)) || null;
}
function noBlocking(out) {
  if (!out) return;
  assert.ok(!('decision' in out) && !('continue' in out) && !('stopReason' in out), 'no blocking field');
}
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
function skillWithBlock(block) {
  return '---\nname: model-routing\ndescription: test copy\n---\n\n' + S.MARK_START + '\n' + block + '\n' + S.MARK_END + '\n';
}

// ---------------------------------------------------------------------------
// Shape of the script

test('6.11: loading session-start.cjs runs nothing; the start check is a process.argv[1] own-file check; meter.cjs is required by a literal, not copied', () => {
  const b = H.makeBase('ss-require');
  const kit = H.copyKit(b);
  const code = `require(${JSON.stringify(kit.startFile)}); setTimeout(() => process.stdout.write('still-alive'), 300);`;
  const r = require('node:child_process').spawnSync(process.execPath, ['-e', code], { cwd: b.proj, env: R.childEnv(b), input: '', windowsHide: true, timeout: 10000 });
  assert.equal(r.status, 0);
  assert.equal(String(r.stdout), 'still-alive');
  const src = fs.readFileSync(H.SESSION_START_SRC, 'utf8');
  assert.ok(!/require\.main/.test(src), 'no require.main (T-14)');
  assert.match(src, /process\.argv\[1\]/);
  assert.match(src, /require\('\.\/meter\.cjs'\)/);
  for (const f of ['installMode', 'writeBlock', 'nodeInsideProject', 'sync', 'ensureDir', 'loadOptions']) assert.ok(!new RegExp('function ' + f + '\\b').test(src), f + ' is reused from meter.cjs');
});

test('2.2: session-start.cjs holds the kit name only as the display form opening the three fixed 6.7 lines; ASCII source, no CRLF', () => {
  const src = fs.readFileSync(H.SESSION_START_SRC, 'utf8');
  const name = JSON.parse(fs.readFileSync(path.join(H.REPO_TOP, 'src', 'core', '.claude-plugin', 'plugin.json'), 'utf8')).name;
  assert.equal(src.toLowerCase().split(name).length - 1, 3, 'three occurrences');
  for (const k of ['IN_GIT', 'SOURCE_FOLDER', 'PLUGIN_DATA_NOT_SET']) assert.ok(S.LINES[k].startsWith('PocoToko: '), k);
  for (const k of ['FOLDER_PREFIX', 'NAME_PREFIX', 'NODE_PREFIX', 'RULES_UNREADABLE', 'RULES_NO_MARKERS', 'RULES_TOO_LONG']) assert.ok(!S.LINES[k].toLowerCase().includes(name), k);
  assert.ok(!/[^\x00-\x7f]/.test(src), 'ASCII source');
  assert.ok(!src.includes('\r'));
});

test('6.7: the three write-nothing lines are word for word', () => {
  assert.equal(S.LINES.IN_GIT, 'PocoToko: your Claude config folder is inside a git repo, so the kit saves nothing there (no meter warnings, no hand-off files). Move the config folder out of the repo to turn them on.');
  assert.equal(S.LINES.SOURCE_FOLDER, 'PocoToko: this plugin runs from its source folder (a developer install), so the kit saves nothing. Install from a git source or copy by hand to turn saving on.');
  assert.equal(S.LINES.PLUGIN_DATA_NOT_SET, 'PocoToko: the plugin data folder is not set, so the kit saves nothing this session (no meter warnings, no hand-off files).');
});

// ---------------------------------------------------------------------------
// Plugin mode and copy-by-hand mode

test('6.11 plugin mode: --sync runs, then the folder, note-name and Node lines, then the yours-win line and the block (markers not sent); the Node line holds process.execPath', () => {
  const b = H.makeBase('ss-plugin');
  const kit = H.pluginKit(b);
  const out = run(b, kit, H.pluginEnv(b, kit));
  noBlocking(out);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(!('systemMessage' in out), 'nothing for the user');
  const ctx = out.hookSpecificOutput.additionalContext;
  const handoff = path.join(kit.data, 'handoff');
  assert.ok(fs.statSync(handoff).isDirectory(), 'default folder created by code');
  assert.ok(fs.existsSync(path.join(kit.data, 'statusline', 'meter.cjs')), '--sync copied the status line');
  assert.ok(fs.existsSync(path.join(kit.data, 'config', 'meter-config.json')), '--sync wrote the config');
  const lines = ctxLines(out);
  assert.equal(lines[0], S.LINES.FOLDER_PREFIX + handoff);
  assert.equal(lines[1], S.LINES.NAME_PREFIX + '<YYYY-MM-DD-HHmm>-proj-00000001.md');
  assert.equal(lines[2], S.LINES.NODE_PREFIX + process.execPath);
  assert.equal(lines[3], '');
  assert.equal(lines[4], S.YOURS_WIN);
  assert.ok(ctx.endsWith('\n' + S.YOURS_WIN + '\n' + ROUTING_BLOCK), 'the block follows the yours-win line');
  assert.ok(!ctx.includes(S.MARK_START) && !ctx.includes(S.MARK_END), 'markers not sent');
  assert.ok(ctx.length < S.LIMITS.INJECT_MAX_CHARS);
  assert.ok(!/node_path/i.test(JSON.stringify(out)), 'no Node-path notice of any kind (6.10 a v)');
  assert.equal(S.YOURS_WIN, 'If your own rules file already sets model and effort rules, yours win.');
  // ctx.execPath seam: the line names exactly the running program.
  const other = path.join(b.tdir, IS_WIN ? 'node.exe' : 'node');
  assert.equal(lineWith(run(b, kit, H.pluginEnv(b, kit), { ctx: { execPath: other } }), S.LINES.NODE_PREFIX), S.LINES.NODE_PREFIX + other);
});

test('6.11 copy-by-hand mode: no Node line, the default folder is <kit>/handoff, and the skill is read from <config folder>/skills/model-routing', () => {
  const b = H.makeBase('ss-copy');
  const kit = H.copyKit(b);
  H.copySkill(b);
  const out = run(b, kit, H.copyEnv(b));
  assert.equal(lineWith(out, S.LINES.FOLDER_PREFIX), S.LINES.FOLDER_PREFIX + path.join(kit.stateRoot, 'handoff'));
  assert.equal(lineWith(out, S.LINES.NODE_PREFIX), null, 'copy-by-hand prints no Node line');
  assert.ok(out.hookSpecificOutput.additionalContext.endsWith(S.YOURS_WIN + '\n' + ROUTING_BLOCK));
  assert.ok(!fs.existsSync(path.join(kit.stateRoot, 'statusline')), 'no --sync in copy-by-hand mode');
  assert.ok(!('systemMessage' in out));
  // A CRLF copy of the skill still gives the same block.
  H.copySkill(b, fs.readFileSync(H.ROUTING_SKILL_SRC, 'utf8').replace(/\n/g, '\r\n'));
  assert.ok(run(b, kit, H.copyEnv(b)).hookSpecificOutput.additionalContext.endsWith(S.YOURS_WIN + '\n' + ROUTING_BLOCK));
});

test('6.11 e: plugin mode reads its own plugin root, never the config folder copy; copy-by-hand reads only the config folder copy', () => {
  const b = H.makeBase('ss-which');
  const plug = H.pluginKit(b);
  H.copySkill(b, skillWithBlock('config folder copy'));
  assert.ok(run(b, plug, H.pluginEnv(b, plug)).hookSpecificOutput.additionalContext.endsWith(ROUTING_BLOCK));
  const copy = H.copyKit(b);
  fs.copyFileSync(H.ROUTING_SKILL_SRC, path.join(H.mk(copy.stateRoot, 'skills', 'model-routing'), 'SKILL.md'));
  assert.ok(run(b, copy, H.copyEnv(b)).hookSpecificOutput.additionalContext.endsWith(S.YOURS_WIN + '\nconfig folder copy'));
  assert.equal(S.routingSkillFile(M.installMode({ env: H.pluginEnv(b, plug), scriptFile: plug.startFile, home: b.home }), {}, b.home),
    path.join(plug.root, 'skills', 'model-routing', 'SKILL.md'));
});

test('6.11 h (MUST): copy-by-hand refuses a skill file whose real path is inside CLAUDE_PROJECT_DIR or the input cwd (loud line, no block); a user CLAUDE.md there counts as not holding the block; a home-folder project and a source folder are not refused', () => {
  const b = H.makeBase('ss-inproj');
  const kit = H.copyKit(b);
  const cfgIn = H.mk(b.proj, 'cfg');
  fs.copyFileSync(H.ROUTING_SKILL_SRC, path.join(H.mk(cfgIn, 'skills', 'model-routing'), 'SKILL.md'));
  const cases = [
    ['as CLAUDE_PROJECT_DIR', { CLAUDE_CONFIG_DIR: cfgIn, CLAUDE_PROJECT_DIR: b.proj }, b.tdir],
    ['as the input cwd', { CLAUDE_CONFIG_DIR: cfgIn }, b.proj],
  ];
  for (const [label, env, cwd] of cases) {
    const out = run(b, kit, env, { input: startInput(b, { cwd }) });
    noBlocking(out);
    assert.equal(out.systemMessage, S.LINES.RULES_IN_PROJECT, label);
    assert.ok(!(out.hookSpecificOutput && out.hookSpecificOutput.additionalContext.includes(S.YOURS_WIN)), label + ': no block');
    assert.ok(lineWith(out, S.LINES.FOLDER_PREFIX), label + ': the folder line still comes');
  }
  // Reached through a link from outside the project: the real path decides.
  const linked = H.dirLink(cfgIn, path.join(b.base, 'cfg-link'));
  assert.equal(run(b, kit, { CLAUDE_CONFIG_DIR: linked, CLAUDE_PROJECT_DIR: b.proj }).systemMessage, S.LINES.RULES_IN_PROJECT, 'through a link');
  // Control: the same skill in a config folder outside the project is read.
  H.copySkill(b);
  const ok = run(b, kit, H.copyEnv(b));
  assert.ok(ok.hookSpecificOutput.additionalContext.endsWith(S.YOURS_WIN + '\n' + ROUTING_BLOCK));
  assert.ok(!('systemMessage' in ok));
  // A user CLAUDE.md inside the project counts as not holding the block.
  fs.writeFileSync(path.join(cfgIn, 'CLAUDE.md'), S.MARK_START + '\n');
  assert.equal(S.userRulesHoldBlock({ CLAUDE_CONFIG_DIR: cfgIn }, b.home, process.platform, { projectDir: b.proj, home: b.home }), false);
  assert.equal(S.userRulesHoldBlock({ CLAUDE_CONFIG_DIR: cfgIn }, b.home, process.platform, { projectDir: b.tdir, home: b.home }), true);
  // A project folder that is the home folder (or above it) is not tested: ~/.claude is always inside it.
  const homeCfg = H.mk(b.home, '.claude');
  fs.copyFileSync(H.ROUTING_SKILL_SRC, path.join(H.mk(homeCfg, 'skills', 'model-routing'), 'SKILL.md'));
  for (const p of [b.home, b.base]) {
    const out = run(b, kit, { CLAUDE_PROJECT_DIR: p }, { input: startInput(b, { cwd: p }) });
    assert.ok(out.hookSpecificOutput.additionalContext.includes(S.YOURS_WIN), 'project ' + path.basename(p));
    assert.ok(!('systemMessage' in out));
  }
  // A source folder inside the project (a developer clone) reads its own root, not refused.
  const srcRoot = H.mk(b.proj, 'clone');
  const src = { startFile: path.join(H.mk(srcRoot, 'hooks'), 'session-start.cjs') };
  fs.copyFileSync(H.SESSION_START_SRC, src.startFile);
  fs.copyFileSync(H.METER_SRC, path.join(srcRoot, 'hooks', 'meter.cjs'));
  fs.mkdirSync(path.join(srcRoot, '.claude-plugin'));
  fs.writeFileSync(path.join(srcRoot, '.claude-plugin', 'plugin.json'), '{}');
  fs.copyFileSync(H.ROUTING_SKILL_SRC, path.join(H.mk(srcRoot, 'skills', 'model-routing'), 'SKILL.md'));
  const so = run(b, src, H.copyEnv(b));
  assert.equal(so.systemMessage, S.LINES.SOURCE_FOLDER);
  assert.ok(so.hookSpecificOutput.additionalContext.endsWith(ROUTING_BLOCK));
});

test('5.1 / 6.11 step 3: the config folder is CLAUDE_CONFIG_DIR when set, else ~/.claude: a user CLAUDE.md holding the start marker there skips the block; one elsewhere does not', () => {
  const b = H.makeBase('ss-claudemd');
  const kit = H.pluginKit(b);
  const env = H.pluginEnv(b, kit);
  // A CLAUDE.md in the project (not the user-level one) changes nothing.
  fs.writeFileSync(path.join(b.proj, 'CLAUDE.md'), S.MARK_START + '\n');
  assert.ok(run(b, kit, env).hookSpecificOutput.additionalContext.includes(S.YOURS_WIN));
  fs.writeFileSync(path.join(b.config, 'CLAUDE.md'), '# mine\n' + S.MARK_START + '\nmy rules\n' + S.MARK_END + '\n');
  const out = run(b, kit, env);
  assert.ok(!out.hookSpecificOutput.additionalContext.includes(S.YOURS_WIN), 'skipped');
  assert.ok(lineWith(out, S.LINES.FOLDER_PREFIX), 'the other lines still come');
  assert.ok(!('systemMessage' in out), 'a skip is not a failure');
  // CLAUDE_CONFIG_DIR unset: the home folder's .claude is the config folder.
  const copy = H.copyKit(b);
  const homeCfg = H.mk(b.home, '.claude');
  fs.copyFileSync(H.ROUTING_SKILL_SRC, path.join(H.mk(homeCfg, 'skills', 'model-routing'), 'SKILL.md'));
  const env2 = { CLAUDE_PROJECT_DIR: b.proj };
  assert.ok(run(b, copy, env2).hookSpecificOutput.additionalContext.includes(S.YOURS_WIN));
  fs.writeFileSync(path.join(homeCfg, 'CLAUDE.md'), S.MARK_START);
  assert.ok(!run(b, copy, env2).hookSpecificOutput.additionalContext.includes(S.YOURS_WIN));
  // A CLAUDE.md that cannot be read counts as not holding the marker.
  fs.rmSync(path.join(b.config, 'CLAUDE.md'));
  fs.mkdirSync(path.join(b.config, 'CLAUDE.md'));
  assert.ok(run(b, kit, env).hookSpecificOutput.additionalContext.includes(S.YOURS_WIN));
});

test('6.2 / 6.11 step 3: routing_rules_at_start off -> no block and no loud line (plugin env and copy-by-hand file)', () => {
  const b = H.makeBase('ss-off');
  const plug = H.pluginKit(b);
  const p = run(b, plug, H.pluginEnv(b, plug, { routing_rules_at_start: 'false' }));
  assert.ok(!p.hookSpecificOutput.additionalContext.includes(S.YOURS_WIN));
  assert.ok(!('systemMessage' in p));
  const copy = H.copyKit(b);
  H.mk(copy.stateRoot, 'config');
  fs.writeFileSync(path.join(copy.stateRoot, 'config', 'meter-config.json'), JSON.stringify({ routing_rules_at_start: false }));
  const c = run(b, copy, H.copyEnv(b));
  assert.ok(!c.hookSpecificOutput.additionalContext.includes(S.YOURS_WIN));
  assert.ok(!('systemMessage' in c), 'no skill needed, no loud line');
});

test('6.11 step 4: loud on failure: a missing skill file, a folder in its place, a file over 256 KiB, no markers, a marker twice, end before start -> one systemMessage line naming the problem, no block', () => {
  const b = H.makeBase('ss-loud');
  const kit = H.copyKit(b);
  const env = H.copyEnv(b);
  const cases = [];
  cases.push(['missing', () => {}, S.LINES.RULES_UNREADABLE + ' (missing).']);
  cases.push(['folder', () => fs.mkdirSync(path.join(b.config, 'skills', 'model-routing', 'SKILL.md'), { recursive: true }), S.LINES.RULES_UNREADABLE]);
  cases.push(['too big', () => H.copySkill(b, skillWithBlock('x') + 'y'.repeat(S.LIMITS.SKILL_MAX_BYTES)), S.LINES.RULES_UNREADABLE + ' (too_big).']);
  cases.push(['no markers', () => H.copySkill(b, '---\nname: model-routing\n---\nrules\n'), S.LINES.RULES_NO_MARKERS]);
  cases.push(['twice', () => H.copySkill(b, skillWithBlock('a') + skillWithBlock('b')), S.LINES.RULES_NO_MARKERS]);
  cases.push(['reversed', () => H.copySkill(b, S.MARK_END + '\nrules\n' + S.MARK_START + '\n'), S.LINES.RULES_NO_MARKERS]);
  cases.push(['empty block', () => H.copySkill(b, S.MARK_START + '\n  \n' + S.MARK_END + '\n'), S.LINES.RULES_NO_MARKERS]);
  for (const [label, prep, want] of cases) {
    fs.rmSync(path.join(b.config, 'skills'), { recursive: true, force: true });
    prep();
    const out = run(b, kit, env);
    noBlocking(out);
    assert.equal(out.systemMessage.split('\n').length, 1, label + ': one line');
    assert.ok(out.systemMessage.startsWith(want), label + ': ' + out.systemMessage);
    assert.ok(!out.hookSpecificOutput.additionalContext.includes(S.YOURS_WIN), label + ': no block');
    assert.ok(!/[^\x00-\x7f]/.test(out.systemMessage));
  }
});

test('6.11 f (MUST): the whole injected text stays under 10,000 characters: a block that would reach 10,000 is left out with a loud line; one character less is sent', () => {
  const b = H.makeBase('ss-cap');
  const kit = H.copyKit(b);
  const env = H.copyEnv(b);
  H.copySkill(b, skillWithBlock('x'));
  const base = run(b, kit, env).hookSpecificOutput.additionalContext;
  const overhead = base.length - 1; // everything but the one-character block
  const fill = (total) => 'x'.repeat(total - overhead);
  H.copySkill(b, skillWithBlock(fill(S.LIMITS.INJECT_MAX_CHARS - 1)));
  const under = run(b, kit, env);
  assert.equal(under.hookSpecificOutput.additionalContext.length, S.LIMITS.INJECT_MAX_CHARS - 1);
  assert.ok(under.hookSpecificOutput.additionalContext.includes(S.YOURS_WIN));
  assert.ok(!('systemMessage' in under));
  H.copySkill(b, skillWithBlock(fill(S.LIMITS.INJECT_MAX_CHARS)));
  const at = run(b, kit, env);
  assert.ok(at.hookSpecificOutput.additionalContext.length < S.LIMITS.INJECT_MAX_CHARS);
  assert.ok(!at.hookSpecificOutput.additionalContext.includes(S.YOURS_WIN), 'block left out');
  assert.equal(at.systemMessage, `${S.LINES.RULES_TOO_LONG} (${S.LIMITS.INJECT_MAX_CHARS} characters; the limit is under ${S.LIMITS.INJECT_MAX_CHARS}).`);
  assert.equal(S.LIMITS.INJECT_MAX_CHARS, 10000);
});

// ---------------------------------------------------------------------------
// The hand-off folder and name lines (6.6, 6.11 a, b, f)

test('6.6 / 6.11 b: a valid handoff_dir is named (real path, nothing created); a refused one (relative, inside the project, inside a git work tree) gives the default folder and no notice here', () => {
  const b = H.makeBase('ss-hdir');
  const kit = H.pluginKit(b);
  const good = H.mk(b.base, 'notes');
  const out = run(b, kit, H.pluginEnv(b, kit, { handoff_dir: good }));
  assert.equal(lineWith(out, S.LINES.FOLDER_PREFIX), S.LINES.FOLDER_PREFIX + good);
  assert.ok(!fs.existsSync(path.join(kit.data, 'handoff')), 'the default folder is not created');
  assert.deepEqual(fs.readdirSync(good), []);
  const inGit = H.mk(b.base, 'repo', 'notes');
  fs.mkdirSync(path.join(b.base, 'repo', '.git'));
  for (const bad of ['relative/notes', H.mk(b.proj, 'notes'), inGit]) {
    const o = run(b, kit, H.pluginEnv(b, kit, { handoff_dir: bad }));
    assert.equal(lineWith(o, S.LINES.FOLDER_PREFIX), S.LINES.FOLDER_PREFIX + path.join(kit.data, 'handoff'), bad);
    assert.ok(!('systemMessage' in o), 'the meter says the refusal once; session start does not');
  }
});

test('6.7 / 6.11 b: the hand-off folder as a link or junction, or a file at its name -> no folder line, nothing written through it; the rest still comes', () => {
  const b = H.makeBase('ss-hlink');
  const outside = H.mk(b.base, 'outside');
  const kit = H.copyKit(b);
  H.copySkill(b);
  H.dirLink(outside, path.join(kit.stateRoot, 'handoff'));
  const before = H.listing(outside);
  const out = run(b, kit, H.copyEnv(b));
  assert.equal(lineWith(out, S.LINES.FOLDER_PREFIX), null);
  assert.equal(lineWith(out, S.LINES.NAME_PREFIX), null);
  assert.ok(out.hookSpecificOutput.additionalContext.startsWith(S.YOURS_WIN), 'the block still comes');
  assert.deepEqual(H.listing(outside), before);
  const kit2 = H.copyKit(b, 'kit2');
  fs.writeFileSync(path.join(kit2.stateRoot, 'handoff'), 'not a folder');
  assert.equal(lineWith(run(b, kit2, H.copyEnv(b)), S.LINES.FOLDER_PREFIX), null);
});

test('6.11 d: a failed --sync (statusline/ planted as a link or junction) -> no Node line and nothing written through it; the folder line still comes', () => {
  const b = H.makeBase('ss-syncfail');
  const outside = H.mk(b.base, 'outside');
  const kit = H.pluginKit(b);
  H.dirLink(outside, path.join(kit.data, 'statusline'));
  const out = run(b, kit, H.pluginEnv(b, kit));
  assert.equal(lineWith(out, S.LINES.NODE_PREFIX), null);
  assert.ok(lineWith(out, S.LINES.FOLDER_PREFIX));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('6.6 / 6.11 a: the note-name line parts equal the meter note name parts for the same start folder and session id; a missing id gives session', () => {
  const b = H.makeBase('ss-name');
  const kit = H.copyKit(b);
  const when = new Date(2000, 0, 2, 3, 4);
  const datePrefix = M.datePart(when) + '-';
  const cases = [
    [b.proj, H.sessionId(7)],
    [path.join(b.base, 'a b..c' + 'z'.repeat(60)), 'ABCDEFGHIJ'],
    [path.join(b.base, '...'), 'x/y'],
    [b.proj, undefined],
    [b.proj, 42],
  ];
  for (const [start, sid] of cases) {
    const meterName = M.noteBaseName(when, start, M.cleanSessionId(sid));
    assert.ok(meterName.startsWith(datePrefix));
    assert.equal(S.noteNameLine(start, sid), '<YYYY-MM-DD-HHmm>-' + meterName.slice(datePrefix.length) + '.md', String(sid));
  }
  assert.equal(S.noteNameLine(b.proj, undefined), '<YYYY-MM-DD-HHmm>-proj-session.md');
  // Through the hook: CLAUDE_PROJECT_DIR first, else the input cwd.
  const named = H.mk(b.base, 'Start Folder');
  const out = run(b, kit, { CLAUDE_CONFIG_DIR: b.config }, { input: startInput(b, { cwd: named }) });
  assert.equal(lineWith(out, S.LINES.NAME_PREFIX), S.LINES.NAME_PREFIX + '<YYYY-MM-DD-HHmm>-Start-Folder-00000001.md');
});

test('6.11 f: a path holding a control or line-separator character, a bidi control, or over 1,024 characters is never printed', () => {
  for (const bad of ['a\nb', 'a\rb', 'a\u2028b', 'a\u2029b', 'a\u202eb', 'a\u0000b', 'a\u0085b', 'x'.repeat(1025), '']) assert.equal(S.printablePath(bad), false, JSON.stringify(bad.slice(0, 8)));
  // One case per 6.11 f class, every listed character and range end.
  const classes = {
    controls: ['\u0000', '\u0009', '\u001f', '\u007f', '\u0085', '\u009f'],
    separators: ['\u2028', '\u2029'],
    bidi: ['\u061c', '\u200e', '\u200f', '\u202a', '\u202c', '\u202e', '\u2066', '\u2069'],
    zero_width: ['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff'],
  };
  assert.deepEqual(Object.keys(S.UNPRINTABLE_CLASSES).sort(), Object.keys(classes).sort());
  for (const [cls, chars] of Object.entries(classes)) {
    for (const c of chars) assert.equal(S.printablePath('/x/a' + c + 'b/node'), false, cls + ' U+' + c.charCodeAt(0).toString(16));
  }
  // Neighbours that stay printable (ordinary letters, spaces, a non-joiner-free script).
  for (const c of ['\u00a0', '\u0620', '\u200a', '\u2061', '\ufefe', '\u4e2d']) assert.equal(S.printablePath('/x/a' + c + 'b'), true, 'U+' + c.charCodeAt(0).toString(16));
  for (const ok of ['C:\\Program Files\\nodejs\\node.exe', '/usr/local/bin/node', 'x'.repeat(1024), '/home/\u00e9\u4e2d/node']) assert.equal(S.printablePath(ok), true);
  // Through the hook: a Node path with a line feed, or a very long one, is left out.
  const b = H.makeBase('ss-print');
  const kit = H.pluginKit(b);
  for (const execPath of [path.join(b.tdir, 'bin\nINJECTED', 'node'), path.join(b.tdir, 'x'.repeat(1100), 'node')]) {
    const out = run(b, kit, H.pluginEnv(b, kit), { ctx: { execPath } });
    assert.equal(lineWith(out, S.LINES.NODE_PREFIX), null);
    assert.ok(!out.hookSpecificOutput.additionalContext.includes('INJECTED'));
    assert.ok(lineWith(out, S.LINES.FOLDER_PREFIX), 'the folder line still comes');
  }
});

test('6.11 f (POSIX): a handoff_dir whose name holds a line feed is not printed; the line is left out', { skip: IS_WIN && 'POSIX only: Windows file names cannot hold a line feed; proven by CI on macOS and Linux' }, () => {
  const b = H.makeBase('ss-lf');
  const kit = H.pluginKit(b);
  const odd = H.mk(b.base, 'notes\nINJECTED');
  const out = run(b, kit, H.pluginEnv(b, kit, { handoff_dir: odd }));
  assert.equal(lineWith(out, S.LINES.FOLDER_PREFIX), null);
  assert.ok(!out.hookSpecificOutput.additionalContext.includes('INJECTED'));
});

// ---------------------------------------------------------------------------
// Write-nothing modes (6.7, SR-C8)

test('6.7 / SR-C8: a state root inside a git work tree (plugin and copy-by-hand), a source folder (in and out of a work tree), and plugin data not set -> the fixed line word for word, once; nothing written (no --sync, no folder); no hand-off or Node line; the block still comes', () => {
  const b = H.makeBase('ss-block');
  // The config folder copy holds a different block, so each case shows which file it read (6.11 e).
  H.copySkill(b, skillWithBlock('config folder copy'));
  const check = (label, kit, env, want, watch, block) => {
    const before = watch.map((d) => H.listing(d));
    const out = run(b, kit, env);
    noBlocking(out);
    assert.equal(out.systemMessage, want, label);
    assert.equal(lineWith(out, S.LINES.FOLDER_PREFIX), null, label + ': no folder line');
    assert.equal(lineWith(out, S.LINES.NAME_PREFIX), null, label);
    assert.equal(lineWith(out, S.LINES.NODE_PREFIX), null, label + ': no Node line');
    assert.equal(out.hookSpecificOutput.additionalContext, S.YOURS_WIN + '\n' + block, label + ': block still injected, from the right file');
    watch.forEach((d, i) => assert.deepEqual(H.listing(d), before[i], label + ': nothing written'));
  };
  // Plugin mode, data folder inside a work tree: no sync write; its own root's skill.
  const plug = H.pluginKit(b);
  fs.mkdirSync(path.join(kit0(plug), '.git'));
  check('plugin in git', plug, H.pluginEnv(b, plug), S.LINES.IN_GIT, [b.config], ROUTING_BLOCK);
  assert.ok(!fs.existsSync(path.join(plug.data, 'statusline')), 'the git check runs before --sync');
  fs.rmSync(path.join(kit0(plug), '.git'), { recursive: true });
  // Copy-by-hand, kit folder in a work tree (a .git file): the config folder copy.
  const copy = H.copyKit(b);
  fs.writeFileSync(path.join(copy.stateRoot, '.git'), 'gitdir: elsewhere\n');
  check('copy in git', copy, H.copyEnv(b), S.LINES.IN_GIT, [copy.stateRoot, b.config], 'config folder copy');
  // Source folder (a developer install): its own skill copy is read, never the config copy; in and out of a work tree.
  const src = H.copyKit(b, 'source');
  fs.mkdirSync(path.join(src.stateRoot, '.claude-plugin'));
  fs.writeFileSync(path.join(src.stateRoot, '.claude-plugin', 'plugin.json'), '{}');
  fs.copyFileSync(H.ROUTING_SKILL_SRC, path.join(H.mk(src.stateRoot, 'skills', 'model-routing'), 'SKILL.md'));
  check('source', src, H.copyEnv(b), S.LINES.SOURCE_FOLDER, [src.stateRoot], ROUTING_BLOCK);
  fs.mkdirSync(path.join(src.stateRoot, '.git'));
  check('source in git', src, H.copyEnv(b), S.LINES.SOURCE_FOLDER, [src.stateRoot], ROUTING_BLOCK);
  // Inside the plugin cache with the variable unset or empty: its own root's skill.
  for (const v of [undefined, '']) {
    const env = { CLAUDE_CONFIG_DIR: b.config, CLAUDE_PROJECT_DIR: b.proj };
    if (v !== undefined) env.CLAUDE_PLUGIN_DATA = v;
    check('data not set ' + JSON.stringify(v), plug, env, S.LINES.PLUGIN_DATA_NOT_SET, [b.config], ROUTING_BLOCK);
  }
});

/** The folder that holds the plugin data folder's parents (b.config/plugins/data). */
function kit0(plug) {
  return path.dirname(plug.data);
}

// ---------------------------------------------------------------------------
// The Node self-check (6.9, T-35), output and stdin (T-38), nothing written outside (T-36)

test('6.9 / T-35 (unit): Node inside the project, or inside the input cwd -> only the fixed 6.9 line; nothing written', () => {
  const b = H.makeBase('ss-self');
  const kit = H.pluginKit(b);
  const exe = path.join(H.mk(b.proj, 'tools'), IS_WIN ? 'node.exe' : 'node');
  fs.writeFileSync(exe, '');
  const before = H.listing(b.base);
  assert.deepEqual(run(b, kit, H.pluginEnv(b, kit), { ctx: { execPath: exe } }), { systemMessage: M.LINES.NODE_IN_PROJECT });
  const env = { ...H.pluginEnv(b, kit) };
  delete env.CLAUDE_PROJECT_DIR;
  assert.deepEqual(run(b, kit, env, { ctx: { execPath: exe }, input: startInput(b, { cwd: b.proj }) }), { systemMessage: M.LINES.NODE_IN_PROJECT });
  assert.deepEqual(H.listing(b.base), before, 'nothing written');
});

test('T-35 (session-start part): a copy of the running Node inside the project, as CLAUDE_PROJECT_DIR, as the input cwd and as the process start folder -> nothing written anywhere and the fixed line once', () => {
  const b = H.makeBase('ss-t35');
  const kit = H.pluginKit(b);
  const planted = plantNode(path.join(b.proj, 'tools'));
  const cases = [
    ['project dir', { CLAUDE_PROJECT_DIR: b.proj }, b.tdir, b.tdir],
    ['input cwd', { CLAUDE_PROJECT_DIR: undefined }, b.tdir, b.proj],
    ['start folder', { CLAUDE_PROJECT_DIR: undefined }, b.proj, b.tdir],
  ];
  for (const [label, envExtra, cwd, inputCwd] of cases) {
    const before = { data: H.listing(kit.data), proj: H.listing(b.proj) };
    const r = R.runMeter(b, {
      scriptFile: kit.startFile, execPath: planted, cwd,
      env: { ...H.pluginEnv(b, kit), ...envExtra },
      input: JSON.stringify(startInput(b, { cwd: inputCwd })),
    });
    assert.equal(r.status, 0, label);
    assert.deepEqual(JSON.parse(r.text), { systemMessage: M.LINES.NODE_IN_PROJECT }, label);
    assert.equal(r.text.trim().split('\n').length, 1);
    assert.deepEqual(H.listing(kit.data), before.data, label + ': data folder unchanged');
    assert.deepEqual(H.listing(b.proj), before.proj, label + ': project unchanged');
  }
  // Control: the real Node, started outside the project, syncs and names the folder.
  const ctl = R.runMeter(b, { scriptFile: kit.startFile, cwd: b.tdir, env: H.pluginEnv(b, kit), input: JSON.stringify(startInput(b)) });
  assert.equal(ctl.status, 0);
  const out = JSON.parse(ctl.text);
  assert.ok(lineWith(out, S.LINES.NODE_PREFIX), 'control: Node line');
  assert.ok(fs.existsSync(path.join(kit.data, 'statusline', 'meter.cjs')), 'control: synced');
});

test('6.9 / T-38: spaces and non-ASCII paths work; the JSON out is ASCII; exit 0 within the time budget; no blocking field', () => {
  const b = H.makeBase('ss-ascii', { sub: 'a b \u00e9\u4e2d' });
  const kit = H.pluginKit(b);
  const r = R.runMeter(b, { scriptFile: kit.startFile, input: JSON.stringify(startInput(b)), env: H.pluginEnv(b, kit) });
  assert.equal(r.status, 0);
  assert.ok(r.ms < 2500, 'time: ' + r.ms);
  for (const byte of r.stdout) assert.ok(byte < 0x80, 'ASCII bytes only');
  assert.ok(r.text.includes('\\u00e9'), 'escaped');
  const out = JSON.parse(r.text);
  noBlocking(out);
  assert.equal(lineWith(out, S.LINES.FOLDER_PREFIX), S.LINES.FOLDER_PREFIX + path.join(kit.data, 'handoff'));
  assert.ok(out.hookSpecificOutput.additionalContext.includes(S.YOURS_WIN));
});

test('6.9 / 6.11 g / T-38: empty, garbage, non-object and over-cap stdin -> exit 0, no output, nothing written; stdin that never closes -> the 2.5 s self-kill (allowed 4 s); an argument -> nothing', async () => {
  const b = H.makeBase('ss-stdin');
  const kit = H.copyKit(b);
  H.copySkill(b);
  const before = H.listing(kit.stateRoot);
  for (const input of ['', 'garbage{', '[1,2]', 'null', '"x"', Buffer.alloc(M.LIMITS.STDIN_MAX_BYTES + 10, 0x20)]) {
    const r = R.runMeter(b, { scriptFile: kit.startFile, input, env: H.copyEnv(b) });
    assert.equal(r.status, 0);
    assert.equal(r.text.trim(), '');
  }
  const big = JSON.stringify({ ...startInput(b), pad: 'a'.repeat(M.LIMITS.STDIN_MAX_BYTES) });
  const over = R.runMeter(b, { scriptFile: kit.startFile, input: big, env: H.copyEnv(b) });
  assert.equal(over.status, 0);
  assert.equal(over.text.trim(), '', 'read stops at the cap; nothing acted on');
  const arg = R.runMeter(b, { scriptFile: kit.startFile, args: ['--sync'], input: JSON.stringify(startInput(b)), env: H.copyEnv(b) });
  assert.equal(arg.status, 0);
  assert.equal(arg.text.trim(), '');
  assert.deepEqual(H.listing(kit.stateRoot), before, 'nothing written');
  const hang = await R.runWithOpenStdin(b, { scriptFile: kit.startFile, env: H.copyEnv(b) });
  assert.equal(hang.code, 0);
  assert.ok(hang.ms >= 2000 && hang.ms < 4000, 'self-kill: ' + hang.ms);
});

test('T-36 (session-start part): session start plus a session of meter calls, in plugin mode and in copy-by-hand mode, change only files under the state root; the project and the home folder are byte-identical', () => {
  for (const modeName of ['plugin', 'copy']) {
    const b = H.makeBase('ss-t36-' + modeName);
    const kit = modeName === 'plugin' ? H.pluginKit(b) : H.copyKit(b);
    const env = modeName === 'plugin' ? H.pluginEnv(b, kit) : H.copyEnv(b);
    if (modeName === 'copy') H.copySkill(b);
    fs.writeFileSync(path.join(b.proj, 'README.md'), 'project');
    fs.writeFileSync(path.join(b.config, 'CLAUDE.md'), 'user rules\n');
    const ts = [50000, 100000, 150000].map((s, i) => H.writeTranscript(b, s, { name: 't' + i }));
    const before = H.listing(b.base);
    const projBefore = H.listing(b.proj);
    const homeBefore = H.listing(b.home);
    const r = R.runMeter(b, { scriptFile: kit.startFile, cwd: b.tdir, env, input: JSON.stringify(startInput(b)) });
    assert.equal(r.status, 0);
    ts.forEach((t) => M.handlePrompt(H.promptInput(b, t, H.sessionId(1)), H.ctxFor(b, kit, env)));
    run(b, kit, env, { input: startInput(b, { source: 'compact' }) });
    const after = H.listing(b.base);
    const rootRel = path.relative(b.base, kit.stateRoot).split(path.sep).join('/');
    const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
    assert.ok(changed.length > 0);
    for (const k of changed) assert.ok(k.startsWith(rootRel + '/'), modeName + ': ' + k);
    assert.deepEqual(H.listing(b.proj), projBefore);
    assert.deepEqual(H.listing(b.home), homeBefore);
  }
});

test('6.11: a non-object input gives no output (in process)', () => {
  const b = H.makeBase('ss-null');
  const kit = H.copyKit(b);
  for (const input of [null, [], 'x', 5]) {
    assert.equal(S.handleSessionStart(input, { env: H.copyEnv(b), scriptFile: kit.startFile, home: b.home, gitCeiling: b.base }), null);
  }
});
