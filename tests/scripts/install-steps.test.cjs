'use strict';
// docs/install-steps.json and its renderer and Node performer (spec 12.2, 12.3, 14.5, 14.6,
// 15.3 install-steps row). Every temporary file is under sandbox/test-tmp/.

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { REPO_TOP, makeTempDir, removeDir, writeFiles } = require('../helpers/tmpdir-sandbox.cjs');

const made = [];
after(() => { for (const d of made) removeDir(d); });
function tmp(name) { const d = makeTempDir(name); made.push(d); return d; }

let S;
let CBH;
let doc;
before(async () => {
  S = await import(pathToFileURL(path.join(REPO_TOP, 'scripts', 'lib', 'install-steps.mjs')).href);
  CBH = await import(pathToFileURL(path.join(REPO_TOP, 'scripts', 'copy-by-hand.mjs')).href);
  doc = S.loadSteps(REPO_TOP).doc;
});

const DOLLAR_BRACE = '$' + '{';

// ---------------------------------------------------------------------------
// Schema (12.2 a, 12.3)

test('12.2 a / 12.3: an install list and an uninstall list; unique ids; part core or search; boolean optional; a type from each closed set', () => {
  assert.deepEqual(S.validateSteps(doc), []);
  assert.ok(Array.isArray(doc.install) && doc.install.length > 0);
  assert.ok(Array.isArray(doc.uninstall) && doc.uninstall.length > 0);
  const ids = [...doc.install, ...doc.uninstall].map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const a of doc.install) assert.ok(['mkdir', 'copy-file', 'copy-dir-no-overwrite', 'merge-settings', 'write-json', 'mcp-add-user'].includes(a.type), a.id);
  for (const a of doc.uninstall) assert.ok(['remove-dir', 'remove-settings-entries', 'remove-marked-block', 'mcp-remove-user'].includes(a.type), a.id);
  for (const a of [...doc.install, ...doc.uninstall]) {
    assert.ok(a.part === 'core' || a.part === 'search', a.id);
    assert.equal(typeof a.optional, 'boolean', a.id);
  }
  // Every install type is used, and every uninstall type.
  assert.deepEqual([...new Set(doc.install.map((a) => a.type))].sort(), [...S.INSTALL_TYPES].sort());
  assert.deepEqual([...new Set(doc.uninstall.map((a) => a.type))].sort(), [...S.UNINSTALL_TYPES].sort());
});

test('12.2 a: paths hold only the placeholders <REPO>, <CONFIG>, <KIT> and <NODE>; no shell text anywhere (no ; && | $( or backtick); no backslash', () => {
  const text = fs.readFileSync(path.join(REPO_TOP, 'docs', 'install-steps.json'), 'utf8');
  for (const m of text.matchAll(/<[A-Za-z_ ]+>/g)) {
    if (/^<(?:REPO|CONFIG|KIT|NODE)>$/.test(m[0])) continue;
    assert.fail('unknown placeholder ' + m[0]);
  }
  const strings = [];
  const walk = (v) => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { strings.push(k); walk(x); } };
  walk(doc);
  for (const bad of [';', '&&', '|', '$(', '`']) for (const s of strings) assert.ok(!s.includes(bad), bad + ' in ' + s.slice(0, 40));
  for (const s of strings) assert.ok(!s.includes('\\'), 'no backslash: ' + s.slice(0, 40));
  assert.ok(!text.includes(DOLLAR_BRACE) && !text.includes('$HOME') && !/~\//.test(text), 'no variables, never $HOME');
  for (const a of [...doc.install, ...doc.uninstall]) {
    for (const f of ['path', 'from', 'to', 'target', 'block_from', 'only_if_same_as']) {
      if (f in a) assert.match(a[f], /^<(?:REPO|CONFIG|KIT)>(?:\/|$)/, a.id + '.' + f);
    }
  }
});

test('12.2 a / 6.12 b: merge-settings carries both status line forms by shell, always for the key statusLine, forward slashes, the bash form equal to the snippet', () => {
  const merge = doc.install.find((a) => a.type === 'merge-settings');
  assert.deepEqual(Object.keys(merge.status_line).sort(), ['bash', 'powershell']);
  assert.deepEqual(merge.status_line.bash, { type: 'command', command: "'<NODE>' '<KIT>/hooks/meter.cjs' --statusline" });
  assert.deepEqual(merge.status_line.powershell, { type: 'command', command: "& '<NODE>' '<KIT>/hooks/meter.cjs' --statusline" });
  const snippet = JSON.parse(fs.readFileSync(path.join(REPO_TOP, 'src', 'core', 'templates', 'settings-snippet.json'), 'utf8'));
  assert.deepEqual(snippet.statusLine, merge.status_line.bash, 'the snippet holds the bash form only');
  assert.equal(merge.from, '<REPO>/src/core/templates/settings-snippet.json');
  assert.equal(merge.target, '<CONFIG>/settings.json', 'the user-level settings file only');
});

test('12.2 step 1 to 6: the actions follow the spec steps (hooks, skills, merge, meter config, search server, search config, MCP registration)', () => {
  const t = (id) => doc.install.find((a) => a.id === id);
  assert.equal(t('copy-meter').to, '<KIT>/hooks/meter.cjs');
  assert.equal(t('copy-session-start').to, '<KIT>/hooks/session-start.cjs');
  assert.equal(t('copy-skill-model-routing').type, 'copy-dir-no-overwrite');
  assert.equal(t('copy-skill-handoff').type, 'copy-dir-no-overwrite');
  assert.equal(t('copy-search-server').to, '<KIT>/search/server');
  assert.equal(t('search-config').path, '<KIT>/search/data/search-config.json');
  assert.deepEqual(t('search-register'), { ...t('search-register'), type: 'mcp-add-user', name: 'pocotoko-search', command: '<NODE>', args: ['<KIT>/search/server/server.cjs'] });
  // meter-config holds exactly the meter defaults (6.2).
  const M = require('../../src/core/hooks/meter.cjs');
  assert.deepEqual(t('meter-config').content, M.DEFAULTS);
  assert.ok(doc.install.filter((a) => a.part === 'search').every((a) => a.optional), 'search is optional');
});

test('validateSteps refuses a type outside the closed set, an unknown placeholder, shell text, a missing guard and a dangling entries_from', () => {
  const clone = () => JSON.parse(JSON.stringify(doc));
  let d = clone(); d.install[0].type = 'run-shell';
  assert.match(S.validateSteps(d).join('\n'), /not in the install set/);
  d = clone(); d.install[1].to = '<HOME>/x';
  assert.match(S.validateSteps(d).join('\n'), /must start with a placeholder|unknown placeholder/);
  d = clone(); d.install[0].note = 'a; b';
  assert.match(S.validateSteps(d).join('\n'), /shell text/);
  d = clone(); delete d.uninstall.find((a) => a.id === 'remove-kit').only_if_kit;
  assert.match(S.validateSteps(d).join('\n'), /exactly one guard/);
  d = clone(); d.uninstall.find((a) => a.id === 'remove-skills-folder').only_if_kit = true;
  assert.match(S.validateSteps(d).join('\n'), /exactly one guard/);
  d = clone(); d.install[0].new_kit = false;
  assert.match(S.validateSteps(d).join('\n'), /first install action must make the new kit folder/);
  d = clone(); delete d.marker;
  assert.match(S.validateSteps(d).join('\n'), /marker must be/);
  d = clone(); d.uninstall.find((a) => a.type === 'remove-settings-entries').entries_from = 'nope';
  assert.match(S.validateSteps(d).join('\n'), /entries_from/);
});

// ---------------------------------------------------------------------------
// The check's launcher (git ceiling) session-start row (12.2 f; end gate round 2, R2-1)

test('12.2 f: the launcher session-start row needs the routing block from the copied skill, the hand-off folder line, exit 0 and no systemMessage; it fails when the block is missing', () => {
  const skill = fs.readFileSync(path.join(REPO_TOP, 'src', 'core', 'skills', 'model-routing', 'SKILL.md'), 'utf8');
  const block = CBH.routingBlockOf(skill);
  assert.ok(block.length > 100 && !block.includes('routing-block'), 'the block between the markers');
  const ctx = 'Hand-off folder for this session: /x/handoff\nHand-off note name for this session: n.md\n\nIf your own rules file already sets model and effort rules, yours win.\n' + block;
  const hook = (c, extra = {}) => ({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: c }, ...extra });
  assert.equal(CBH.seamSessionStartOk({ status: 0, hook: hook(ctx), block }), true, 'all present');
  assert.equal(CBH.seamSessionStartOk({ status: 0, hook: hook(ctx.replace(block, '')), block }), false, 'the block missing');
  assert.equal(CBH.seamSessionStartOk({ status: 0, hook: hook(ctx.replace(block, block.slice(0, -20))), block }), false, 'the block cut short');
  assert.equal(CBH.seamSessionStartOk({ status: 0, hook: hook(ctx.replace('Hand-off folder for this session: ', '')), block }), false, 'no folder line');
  assert.equal(CBH.seamSessionStartOk({ status: 0, hook: hook(ctx, { systemMessage: 'x' }), block }), false, 'a systemMessage');
  assert.equal(CBH.seamSessionStartOk({ status: 1, hook: hook(ctx), block }), false, 'a non-zero exit');
  assert.equal(CBH.seamSessionStartOk({ status: 0, hook: null, block }), false, 'no output');
  assert.equal(CBH.seamSessionStartOk({ status: 0, hook: hook(ctx), block: '' }), false, 'an empty block never counts as found');
  assert.equal(CBH.routingBlockOf('no markers'), '');
  assert.equal(CBH.routingBlockOf('<!-- routing-block:start -->\nrules with no end marker\n'), '', 'no end marker');
  assert.equal(CBH.routingBlockOf('rules\n<!-- routing-block:end -->'), '', 'no start marker');
  assert.equal(CBH.routingBlockOf('<!-- routing-block:start -->\n  the rules  \n<!-- routing-block:end -->'), 'the rules');
  assert.equal(CBH.routingBlockOf('<!-- routing-block:end -->x<!-- routing-block:start -->'), '');
});

// ---------------------------------------------------------------------------
// Rendering (12.2 b)

test('12.2 b: --render run twice gives a byte-identical docs/install.md, and the file on disk equals a fresh render', () => {
  const a = CBH.freshInstallMd(REPO_TOP);
  const b = CBH.freshInstallMd(REPO_TOP);
  assert.equal(a.fresh, b.fresh);
  assert.equal(S.applyRender(a.fresh, S.renderBlocks(doc, REPO_TOP)), a.fresh, 'a render of a rendered file changes nothing');
  assert.equal(a.current, a.fresh, 'docs/install.md is current; run node scripts/copy-by-hand.mjs --render');
});

test('12.2 b: the marked blocks are present once each: bash, PowerShell, the settings lines, and both uninstall blocks', () => {
  const md = fs.readFileSync(path.join(REPO_TOP, 'docs', 'install.md'), 'utf8');
  for (const name of ['install-bash', 'install-powershell', 'settings', 'uninstall-bash', 'uninstall-powershell']) {
    assert.ok(S.extractBlock(md, name) !== null, name);
  }
  assert.throws(() => S.applyRender('no markers here', S.renderBlocks(doc, REPO_TOP)), /marker pair/);
});

test('12.2 b: every rendered shell block sets the four variables once, holds each placeholder only on its variable line, and builds every path from them', () => {
  const blocks = S.renderBlocks(doc, REPO_TOP);
  for (const name of ['install-bash', 'install-powershell', 'uninstall-bash', 'uninstall-powershell']) {
    const text = S.unfence(blocks[name]);
    const lines = text.split('\n');
    const bash = name.endsWith('bash');
    for (const v of ['REPO', 'CONFIG', 'KIT', 'NODE']) {
      const want = bash ? v + "='<" + v + ">'" : '$' + v + " = '<" + v + ">'";
      assert.equal(lines.filter((l) => l === want).length, 1, name + ': ' + want);
      assert.equal(text.split('<' + v + '>').length - 1, 1, name + ': <' + v + '> only on its variable line');
    }
    // No absolute path written out: every quoted path starts with one of the four variables.
    for (const m of text.matchAll(/"([^"]*)"/g)) {
      const s = m[1];
      if (/^(?:Stopped|Left): /.test(s)) continue;
      // ${KIT%/} and the block's own lower-case helpers ($k, $c, $h) are not paths written out.
      if (s.includes('/') && !/^\$(?:\{KIT%\/\}$|\{k##\*\/\}$|[a-z]\/$)/.test(s)) assert.match(s, /^\$(?:REPO|CONFIG|KIT|NODE)(?:\/|$)/, name + ': ' + s);
    }
    assert.ok(!/[A-Za-z]:[\\/]/.test(text) && !/(^|[\s"'])\/(?:Users|home)\//.test(text), name + ': no fixed home path');
    // Writes land only under $CONFIG or $KIT.
    for (const l of lines) {
      const w = /(?:mkdir -p|cp(?: -R)? "[^"]+"|CreateDirectory\(|Copy\("[^"]+",|-Destination|WriteAllText\(|> |rm -rf|rmdir|Remove-Item -LiteralPath) "?\$([A-Z]+)/.exec(l);
      if (w) assert.ok(['CONFIG', 'KIT'].includes(w[1]), name + ': a write outside $CONFIG / $KIT: ' + l.slice(0, 60));
    }
  }
  assert.match(S.unfence(blocks['install-powershell']), /^& \{\n\$ErrorActionPreference = 'Stop'/);
  assert.match(S.unfence(blocks['install-bash']), /^\(\nset -e\n/);
});

test('12.2 b: the settings lines hold only real settings keys (hooks and statusLine), in the two forms by shell, with forward slashes and placeholders', () => {
  const t = S.renderBlocks(doc, REPO_TOP).settings;
  const parts = [...t.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
  assert.equal(parts.length, 2);
  for (const p of parts) assert.deepEqual(Object.keys(p).sort(), ['hooks', 'statusLine']);
  assert.equal(parts[0].statusLine.command, "'<NODE>' '<KIT>/hooks/meter.cjs' --statusline");
  assert.equal(parts[1].statusLine.command, "& '<NODE>' '<KIT>/hooks/meter.cjs' --statusline");
  assert.deepEqual(parts[0].hooks, parts[1].hooks);
  assert.ok(!t.includes('\\\\'), 'never doubled backslashes');
  assert.ok(!/\bnode\b/.test(JSON.stringify(parts)), 'never a bare node');
});

// ---------------------------------------------------------------------------
// Node performer: the safety rules (12.2 a, 12.3, 14.6)

function home(name) {
  const root = tmp(name);
  const config = path.join(root, 'home', '.claude');
  fs.mkdirSync(config, { recursive: true });
  const values = { REPO: S.slash(REPO_TOP), CONFIG: S.slash(config), KIT: S.slash(path.join(config, 'pocotoko')), NODE: S.slash(process.execPath) };
  return { root, config, home: path.join(root, 'home'), values };
}

test('12.2 a (never overwrite): copy-dir-no-overwrite onto an existing skill folder stops the steps, tells the user, and leaves that folder byte-identical', () => {
  const h = home('own-skill');
  writeFiles(h.config, { 'skills/handoff/SKILL.md': 'my own skill\n', 'skills/handoff/notes.txt': 'mine\n' });
  const before = S.snapshot(path.join(h.config, 'skills', 'handoff'), { configRel: '-' });
  const r = S.performList(doc, 'install', { values: h.values, repo: REPO_TOP, shell: 'bash', runMcp: null });
  const stop = r.results.find((x) => x.id === 'copy-skill-handoff');
  assert.equal(stop.status, 'stopped');
  assert.match(stop.reason, /^Stopped: .*skills\/handoff already exists\. It was not changed\.$/);
  assert.deepEqual(S.diffSnapshots(before, S.snapshot(path.join(h.config, 'skills', 'handoff'), { configRel: '-' })), []);
  assert.ok(r.results.slice(r.results.indexOf(stop) + 1).every((x) => x.status === 'not-run'), 'nothing after the stop runs');
  assert.ok(!fs.existsSync(path.join(h.config, 'settings.json')), 'the merge did not run');
  // The uninstall list keeps a folder that is not the kit's copy.
  S.performList(doc, 'uninstall', { values: h.values, repo: REPO_TOP, shell: 'bash', runMcp: null });
  assert.deepEqual(S.diffSnapshots(before, S.snapshot(path.join(h.config, 'skills', 'handoff'), { configRel: '-' })), []);
});

test('12.2 c / 14.6 (clean end): install then uninstall leaves the home byte-identical to its pre-install snapshot, user settings, hooks and CLAUDE.md included', () => {
  const h = home('clean-end');
  const userSettings = { permissions: { allow: ['Read'] }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'mine', args: [] }] }] } };
  fs.writeFileSync(path.join(h.config, 'settings.json'), JSON.stringify(userSettings, null, 2) + '\n');
  fs.writeFileSync(path.join(h.config, 'CLAUDE.md'), '# Mine\n');
  const pre = S.snapshot(h.home);
  const inst = S.performList(doc, 'install', { values: h.values, repo: REPO_TOP, shell: 'bash', runMcp: null });
  assert.equal(inst.summary.failed, 0);
  const merged = JSON.parse(fs.readFileSync(path.join(h.config, 'settings.json'), 'utf8'));
  assert.equal(merged.hooks.SessionStart.length, 2, 'the user hook is kept, the kit hook added');
  assert.deepEqual(merged.permissions, userSettings.permissions);
  assert.deepEqual(Object.keys(merged), ['permissions', 'hooks', 'statusLine'], 'the merged file holds no unknown key (12.2 a)');
  assert.equal(merged.statusLine.command, "'" + h.values.NODE + "' '" + h.values.KIT + "/hooks/meter.cjs' --statusline");
  // A user paste of both rules blocks, and state the hooks would write in the kit folder.
  let md = fs.readFileSync(path.join(h.config, 'CLAUDE.md'), 'utf8');
  for (const p of [['src', 'core', 'templates', 'rules-block.md'], ['src', 'search', 'templates', 'rules-block.md']]) md = S.pasteBlock(md, fs.readFileSync(path.join(REPO_TOP, ...p), 'utf8'));
  fs.writeFileSync(path.join(h.config, 'CLAUDE.md'), md);
  writeFiles(path.join(h.config, 'pocotoko'), { 'state/sessions/abc.json': '{}', 'handoff/note.md': 'n\n' });
  const un = S.performList(doc, 'uninstall', { values: h.values, repo: REPO_TOP, shell: 'bash', runMcp: null });
  assert.equal(un.summary.failed, 0);
  assert.deepEqual(S.diffSnapshots(pre, S.snapshot(h.home)), []);
});

test('14.6 (clean end): the byte-level snapshot catches a leftover file, a changed byte and a left folder', () => {
  const h = home('snap');
  writeFiles(h.home, { 'a.txt': 'one\n' });
  const pre = S.snapshot(h.home);
  fs.writeFileSync(path.join(h.home, 'a.txt'), 'one!\n');
  writeFiles(h.home, { 'left/b.txt': 'x' });
  assert.deepEqual(S.diffSnapshots(pre, S.snapshot(h.home)), ['a.txt', 'left', 'left/b.txt']);
});

test('12.3: remove-settings-entries removes exactly the kit entries; a statusLine that is not a kit form is kept; a file left empty is deleted', () => {
  const h = home('settings');
  const file = path.join(h.config, 'settings.json');
  const merge = doc.install.find((a) => a.type === 'merge-settings');
  const e = S.settingsEntries(merge, REPO_TOP, 'powershell', h.values);
  fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }, null, 2) + '\n');
  const m = S.mergeSettingsFile(file, e);
  assert.match(m.reason, /statusLine entry already exists; it was not replaced/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command, 'mine');
  const forms = ['bash', 'powershell'].map((s) => S.settingsEntries(merge, REPO_TOP, s, h.values).statusLine);
  S.removeSettingsEntries(file, e.hooks, forms);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { statusLine: { type: 'command', command: 'mine' } });
  fs.unlinkSync(file);
  S.mergeSettingsFile(file, e);
  S.mergeSettingsFile(file, e); // a second merge adds no duplicate
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.UserPromptSubmit.length, 1);
  assert.equal(S.removeSettingsEntries(file, e.hooks, forms, false).status, 'done');
  assert.equal(fs.readFileSync(file, 'utf8'), '{}\n', 'a file the steps did not make is kept, even when it holds nothing');
  S.mergeSettingsFile(file, e);
  const r = S.removeSettingsEntries(file, e.hooks, forms, true);
  assert.equal(r.status, 'done');
  assert.ok(!fs.existsSync(file), 'a settings file the steps made and the kit alone filled is deleted');
  fs.writeFileSync(file, 'not json');
  assert.equal(S.mergeSettingsFile(file, e).status, 'failed');
  assert.equal(fs.readFileSync(file, 'utf8'), 'not json', 'an unreadable file is never rewritten');
});

test('12.3: remove-dir keeps a folder that is not the kit copy, is not empty, or does not hold the kit', () => {
  const h = home('rmdir');
  writeFiles(h.config, {
    'skills/model-routing/SKILL.md': fs.readFileSync(path.join(REPO_TOP, 'src', 'core', 'skills', 'model-routing', 'SKILL.md')),
    'skills/model-routing/extra.md': 'user file\n',
    'skills/other/SKILL.md': 'x',
    'pocotoko/readme.txt': 'no meter here\n',
  });
  const r = S.performList({ ...doc, uninstall: doc.uninstall.filter((a) => a.type === 'remove-dir') }, 'uninstall', { values: h.values, repo: REPO_TOP, shell: 'bash', runMcp: null });
  assert.equal(r.summary.failed, 0);
  for (const p of ['skills/model-routing/extra.md', 'skills/other/SKILL.md', 'pocotoko/readme.txt']) assert.ok(fs.existsSync(path.join(h.config, ...p.split('/'))), p);
});

test('12.2 c: one failing action is collected and the rest still run, with a succeeded / failed / skipped summary', () => {
  const h = home('one-fails');
  const broken = JSON.parse(JSON.stringify(doc));
  broken.install.find((a) => a.id === 'copy-meter').from = '<REPO>/src/core/hooks/missing.cjs';
  const r = S.performList(broken, 'install', { values: h.values, repo: REPO_TOP, shell: 'bash', runMcp: null });
  assert.equal(r.results.find((x) => x.id === 'copy-meter').status, 'failed');
  assert.equal(r.results.find((x) => x.id === 'copy-session-start').status, 'done', 'the next action still ran');
  assert.equal(r.summary.failed, 1);
  assert.ok(r.summary.succeeded > 5);
  assert.ok(r.summary.skipped >= 1, 'the MCP step with no Claude Code program is a skip');
  assert.equal(r.results.find((x) => x.id === 'search-register').status, 'skipped');
});

test('mcp-* actions: the argument list the CLI gets; a managed-MCP refusal is held, never a pass', () => {
  const values = { REPO: 'R', CONFIG: 'C', KIT: 'K', NODE: 'N' };
  const add = doc.install.find((a) => a.type === 'mcp-add-user');
  assert.deepEqual(S.mcpArgs(add, values), ['mcp', 'add', '--scope', 'user', 'pocotoko-search', '--', 'N', 'K/search/server/server.cjs']);
  assert.equal(S.mcpResult(add, { status: 1, out: 'Cannot add MCP server: enterprise MCP configuration is active and has exclusive control over MCP servers' }).status, 'held');
  assert.equal(S.mcpResult(add, { status: 1, out: 'enterprise MCP configuration' }).status, 'failed', 'only the exact refusal is held');
  assert.equal(S.mcpResult(add, { status: 0, out: '' }).status, 'done');
  assert.equal(S.mcpResult(add, { status: 1, out: 'boom' }).status, 'failed');
  assert.equal(S.mcpResult(add, null).status, 'skipped');
});

test('remove-marked-block removes the pasted block and the blank line above it, restoring the file byte for byte', () => {
  const tpl = fs.readFileSync(path.join(REPO_TOP, 'src', 'core', 'templates', 'rules-block.md'), 'utf8');
  const base = '# Mine\n\nText.\n';
  const pasted = S.pasteBlock(base, tpl);
  const r = S.removeMarkedBlockText(pasted, S.blockMarkers(tpl));
  assert.equal(r.removed, 1);
  assert.equal(r.text, base);
  assert.equal(S.removeMarkedBlockText(base, S.blockMarkers(tpl)).removed, 0);
});

// ---------------------------------------------------------------------------
// The kit folder and its marker (12.2 d), quoting and full paths (12.2 g): review fixes

test('12.2 d (kit folder): KIT set to the config folder stops the install at once, and the uninstall leaves the whole home byte-identical', () => {
  const h = home('kit-is-config');
  writeFiles(h.config, { 'settings.json': '{}\n', 'notes.md': 'mine\n', 'skills/own/SKILL.md': 'mine\n' });
  const values = { ...h.values, KIT: h.values.CONFIG };
  const pre = S.snapshot(h.home);
  const inst = S.performList(doc, 'install', { values, repo: REPO_TOP, shell: 'bash', runMcp: null, homes: [h.home] });
  assert.equal(inst.results[0].id, 'kit-folder');
  assert.equal(inst.results[0].status, 'stopped');
  assert.deepEqual(S.diffSnapshots(pre, S.snapshot(h.home)), [], 'nothing changed by the install');
  const un = S.performList(doc, 'uninstall', { values, repo: REPO_TOP, shell: 'bash', runMcp: null, homes: [h.home] });
  assert.match(un.results.find((x) => x.id === 'remove-kit').reason, /^Left: /);
  assert.deepEqual(S.diffSnapshots(pre, S.snapshot(h.home)), []);
});

test('12.2 d (kit folder): a kit folder that already exists, holding a user file, stops the install and is never removed', () => {
  const h = home('kit-exists');
  writeFiles(h.config, { 'pocotoko/my-notes.txt': 'the user own file\n', 'pocotoko/hooks/meter.cjs': 'not the kit\n' });
  const pre = S.snapshot(h.home);
  const inst = S.performList(doc, 'install', { values: h.values, repo: REPO_TOP, shell: 'bash', runMcp: null });
  assert.equal(inst.results[0].status, 'stopped');
  assert.match(inst.results[0].reason, /already exists\. It was not changed\./);
  S.performList(doc, 'uninstall', { values: h.values, repo: REPO_TOP, shell: 'bash', runMcp: null });
  assert.deepEqual(S.diffSnapshots(pre, S.snapshot(h.home)), [], 'the old guard (hooks/meter.cjs) is no longer enough to remove it');
});

test('12.2 d (kit folder): the kit folder must be named pocotoko; one holding the config folder or a home folder is never removed, marker or not', () => {
  const h = home('kit-holds-config');
  // A folder named pocotoko with a planted marker, holding the config folder.
  const outer = path.join(h.root, 'pocotoko');
  const config = path.join(outer, '.claude');
  writeFiles(outer, { '.pocotoko-kit': 'pocotoko kit folder\n', '.claude/settings.json': '{}\n' });
  const values = { ...h.values, CONFIG: S.slash(config), KIT: S.slash(outer) };
  assert.match(S.kitProblem(doc, values), /config folder or a home folder is inside it/);
  assert.match(S.kitProblem(doc, { ...h.values }), /^not there$/);
  // A home folder inside it.
  writeFiles(h.root, { 'p2/pocotoko/.pocotoko-kit': 'pocotoko kit folder\n', 'p2/pocotoko/home/x': '' });
  const v2 = { ...h.values, KIT: S.slash(path.join(h.root, 'p2', 'pocotoko')) };
  assert.match(S.kitProblem(doc, v2, [path.join(h.root, 'p2', 'pocotoko', 'home')]), /inside it/);
  // A marker under another folder name; a pocotoko folder with no marker; a marker with other text.
  writeFiles(h.root, { 'other/.pocotoko-kit': 'pocotoko kit folder\n', 'p3/pocotoko/x': '', 'p4/pocotoko/.pocotoko-kit': 'something else\n' });
  assert.match(S.kitProblem(doc, { ...h.values, KIT: S.slash(path.join(h.root, 'other')) }), /not named pocotoko/);
  assert.match(S.kitProblem(doc, { ...h.values, KIT: S.slash(path.join(h.root, 'p3', 'pocotoko')) }), /no kit marker file/);
  assert.match(S.kitProblem(doc, { ...h.values, KIT: S.slash(path.join(h.root, 'p4', 'pocotoko')) }), /no kit marker file/);
  // And the install refuses a kit folder with another name.
  const r = S.performList(doc, 'install', { values: { ...h.values, KIT: S.slash(path.join(h.root, 'newkit')) }, repo: REPO_TOP, shell: 'bash', runMcp: null });
  assert.equal(r.results[0].status, 'stopped');
  assert.match(r.results[0].reason, /must be named pocotoko/);
  assert.ok(!fs.existsSync(path.join(h.root, 'newkit')));
});

test('12.2 d (shared folders): an empty skills folder that was already there is kept after install and uninstall; one the steps made is removed', () => {
  const h = home('empty-skills');
  fs.mkdirSync(path.join(h.config, 'skills'));
  fs.writeFileSync(path.join(h.config, 'settings.json'), '{}\n');
  const pre = S.snapshot(h.home);
  S.performList(doc, 'install', { values: h.values, repo: REPO_TOP, shell: 'bash', runMcp: null });
  assert.deepEqual(fs.readFileSync(path.join(h.config, 'pocotoko', '.pocotoko-kit'), 'utf8'), 'pocotoko kit folder\n', 'nothing shared was made');
  const un = S.performList(doc, 'uninstall', { values: h.values, repo: REPO_TOP, shell: 'bash', runMcp: null });
  assert.match(un.results.find((x) => x.id === 'remove-skills-folder').reason, /the steps did not make it/);
  assert.deepEqual(S.diffSnapshots(pre, S.snapshot(h.home)), []);
  // With no skills folder and no settings file before: both are made, noted, and removed again.
  const h2 = home('made-skills');
  const pre2 = S.snapshot(h2.home);
  S.performList(doc, 'install', { values: h2.values, repo: REPO_TOP, shell: 'bash', runMcp: null });
  assert.equal(fs.readFileSync(path.join(h2.config, 'pocotoko', '.pocotoko-kit'), 'utf8'), 'pocotoko kit folder\ncreated skills\ncreated settings.json\n');
  S.performList(doc, 'uninstall', { values: h2.values, repo: REPO_TOP, shell: 'bash', runMcp: null });
  assert.deepEqual(S.diffSnapshots(pre2, S.snapshot(h2.home)), []);
});

test('12.2 g (quoting): a value holding a single quote is written as a closed and reopened quote in bash and doubled in PowerShell; the status line forms keep both paths in single quotes', () => {
  assert.equal(S.quoteValue("a'b", 'bash'), "a'\\''b");
  assert.equal(S.quoteValue("a'b", 'powershell'), "a''b");
  assert.equal(S.quoteValue('a$b`c"d', 'bash'), 'a$b`c"d', 'nothing else needs a change inside single quotes');
  const merge = doc.install.find((a) => a.type === 'merge-settings');
  const v = { REPO: '/r', CONFIG: '/c', KIT: "/o'k/pocotoko", NODE: '/n/node' };
  assert.equal(S.settingsEntries(merge, REPO_TOP, 'bash', v).statusLine.command, "'/n/node' '/o'\\''k/pocotoko/hooks/meter.cjs' --statusline");
  assert.equal(S.settingsEntries(merge, REPO_TOP, 'powershell', v).statusLine.command, "& '/n/node' '/o''k/pocotoko/hooks/meter.cjs' --statusline");
  assert.equal(S.settingsEntries(merge, REPO_TOP, 'bash', v).hooks.SessionStart[0].hooks[0].args[0], "/o'k/pocotoko/hooks/session-start.cjs", 'exec form takes the path as it is');
});

// Shell runs of the rendered blocks (each skipped with its reason where the shell is not found).
async function shellKit() {
  const D = await import(pathToFileURL(path.join(REPO_TOP, 'scripts', 'lib', 'dev-run.mjs')).href);
  return { D, shells: D.findShells() };
}
function runBlock(D, shells, shell, listName, run, values) {
  const text = S.unfence(S.renderBlocks(doc, REPO_TOP)[listName + '-' + shell]);
  const file = path.join(run.dir, listName + (shell === 'bash' ? '.sh' : '.ps1'));
  fs.writeFileSync(file, S.fillShell(text, values, shell) + '\n');
  const stub = D.makeCliStub(run);
  return D.runShellFile(shell, shells[shell], file, { env: stub.env(D.runEnv(run)), cwd: run.project });
}

test('12.2 g (quoting, live): the rendered blocks install and uninstall into a folder whose name holds a single quote, a dollar sign and a backtick, and the status line form runs there', async (t) => {
  const { D, shells } = await shellKit();
  const odd = "o'dd $HOME `x`";
  let ran = 0;
  for (const shell of ['bash', 'powershell']) {
    if (!shells[shell]) { t.diagnostic(shell + ': ' + shells.why[shell]); continue; }
    ran++;
    const run = D.makeRun('install-steps-test', 'quote-' + shell);
    t.after(() => D.removeRun(run));
    const config = path.join(run.dir, odd, '.claude');
    fs.mkdirSync(config, { recursive: true });
    const values = { REPO: S.slash(REPO_TOP), CONFIG: S.slash(config), KIT: S.slash(path.join(config, 'pocotoko')), NODE: S.slash(process.execPath) };
    const r = runBlock(D, shells, shell, 'install', run, values);
    assert.equal(r.status, 0, shell + ': ' + r.stdout + r.stderr);
    assert.ok(fs.existsSync(path.join(config, 'pocotoko', 'hooks', 'meter.cjs')), shell + ': installed at the odd path');
    assert.equal(fs.readFileSync(path.join(config, 'pocotoko', '.pocotoko-kit'), 'utf8'), 'pocotoko kit folder\ncreated skills\n');
    const merge = doc.install.find((a) => a.type === 'merge-settings');
    const cmd = S.settingsEntries(merge, REPO_TOP, shell, values).statusLine.command;
    const s = D.runShellCommand(shell, shells[shell], cmd, { env: { ...D.runEnv(run), NO_COLOR: '1' }, cwd: run.project, input: D.statusInput(50000) });
    assert.equal(String(s.stdout).replace(/\r/g, '').trim(), 'chat -- (warn 100k/150k)'.replace('--', '50k'), shell + ': ' + s.stderr);
    const u = runBlock(D, shells, shell, 'uninstall', run, values);
    assert.equal(u.status, 0, shell + ': ' + u.stdout + u.stderr);
    assert.deepEqual(fs.readdirSync(config), [], shell + ': the kit and the skills folder it made are gone');
  }
  if (!ran) t.skip('neither shell found');
});

test('12.2 g (full paths, live): each rendered block stops before anything when a value is not a full path (a ~ or a relative path)', async (t) => {
  const { D, shells } = await shellKit();
  let ran = 0;
  for (const shell of ['bash', 'powershell']) {
    if (!shells[shell]) { t.diagnostic(shell + ': ' + shells.why[shell]); continue; }
    ran++;
    const run = D.makeRun('install-steps-test', 'relative-' + shell);
    t.after(() => D.removeRun(run));
    for (const [listName, values] of [
      ['install', { REPO: S.slash(REPO_TOP), CONFIG: '~/.claude', KIT: '~/.claude/pocotoko', NODE: S.slash(process.execPath) }],
      ['install', { REPO: S.slash(REPO_TOP), CONFIG: 'rel/.claude', KIT: 'rel/.claude/pocotoko', NODE: S.slash(process.execPath) }],
      ['uninstall', { REPO: S.slash(REPO_TOP), CONFIG: 'rel/.claude', KIT: 'rel/.claude/pocotoko', NODE: 'node' }],
    ]) {
      const r = runBlock(D, shells, shell, listName, run, values);
      assert.match(String(r.stdout), /Stopped: every path must be a full path/, shell + ' ' + listName);
      assert.ok(!fs.existsSync(path.join(run.project, 'rel')) && !fs.existsSync(path.join(run.project, '~')), shell + ': nothing made');
    }
  }
  if (!ran) t.skip('neither shell found');
});

test('12.2 d (kit folder, live): the rendered uninstall blocks keep a pocotoko folder with a marker that holds the config folder, and one with no marker', async (t) => {
  const { D, shells } = await shellKit();
  let ran = 0;
  for (const shell of ['bash', 'powershell']) {
    if (!shells[shell]) { t.diagnostic(shell + ': ' + shells.why[shell]); continue; }
    ran++;
    const run = D.makeRun('install-steps-test', 'kitguard-' + shell);
    t.after(() => D.removeRun(run));
    const outer = path.join(run.dir, 'a', 'pocotoko');
    writeFiles(outer, { '.pocotoko-kit': 'pocotoko kit folder\n', '.claude/settings.json': '{}\n', 'hooks/meter.cjs': 'x\n' });
    const values = { REPO: S.slash(REPO_TOP), CONFIG: S.slash(path.join(outer, '.claude')), KIT: S.slash(outer), NODE: S.slash(process.execPath) };
    const before = S.snapshot(outer, { configRel: '-' });
    const r = runBlock(D, shells, shell, 'uninstall', run, values);
    assert.match(String(r.stdout), /Left: .*not a kit folder these steps made/, shell);
    assert.deepEqual(S.diffSnapshots(before, S.snapshot(outer, { configRel: '-' })), [], shell + ': config inside the kit folder: kept');
    const bare = path.join(run.dir, 'b', 'pocotoko');
    writeFiles(bare, { 'hooks/meter.cjs': 'x\n', 'mine.txt': 'y\n' });
    const v2 = { ...values, CONFIG: S.slash(path.join(run.dir, 'b', 'cfg')), KIT: S.slash(bare) };
    fs.mkdirSync(path.join(run.dir, 'b', 'cfg'));
    runBlock(D, shells, shell, 'uninstall', run, v2);
    assert.ok(fs.existsSync(path.join(bare, 'mine.txt')), shell + ': no marker: kept');
  }
  if (!ran) t.skip('neither shell found');
});

test('6.12 b / 12.2 g (quote in a settings file, live): the documented settings-file form of a single quote in a path, from the skill and from docs/install.md, parses as JSON, and the parsed command runs in its shell', async (t) => {
  const { D, shells } = await shellKit();
  const skill = fs.readFileSync(path.join(REPO_TOP, 'src', 'core', 'skills', 'meter-statusline', 'SKILL.md'), 'utf8');
  const md = fs.readFileSync(path.join(REPO_TOP, 'docs', 'install.md'), 'utf8');
  const sk = /write it in the settings file as `([^`]+)` in the Git Bash form[\s\S]*?and as `([^`]+)` in the PowerShell form/.exec(skill);
  const mdq = /In the settings lines \(JSON text\), write a single quote in a path as `([^`]+)` in the Git Bash form and as `([^`]+)` in the PowerShell form/.exec(md);
  assert.ok(sk && mdq, 'both documents state the settings-file form');
  const fences = (text) => [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const skillForms = fences(skill).filter((f) => f.includes('statusLine'));
  const mdForms = fences(S.extractBlock(md, 'settings'));
  assert.equal(skillForms.length, 2);
  assert.equal(mdForms.length, 2);
  // The shell escape written raw into the JSON text would not parse.
  assert.throws(() => JSON.parse('{"command": "\'a\'\\\'\'b\'"}'), SyntaxError);
  const run = D.makeRun('install-steps-test', 'json-quote');
  t.after(() => D.removeRun(run));
  const base = path.join(run.dir, "o'k");
  for (const d of [path.join(base, 'pocotoko', 'hooks'), path.join(base, 'data', 'statusline')]) {
    fs.mkdirSync(d, { recursive: true });
    fs.copyFileSync(path.join(REPO_TOP, 'src', 'core', 'hooks', 'meter.cjs'), path.join(d, 'meter.cjs'));
  }
  let ran = 0;
  for (const [i, shell] of [[0, 'bash'], [1, 'powershell']]) {
    if (!shells[shell]) { t.diagnostic(shell + ': ' + shells.why[shell]); continue; }
    ran++;
    for (const [label, fragment, written] of [['skill', skillForms[i], sk[i + 1]], ['install.md', mdForms[i], mdq[i + 1]]]) {
      const q = (p) => S.slash(p).split("'").join(written);
      const text = fragment.split('<NODE>').join(S.slash(process.execPath)).split('<KIT>').join(q(path.join(base, 'pocotoko')))
        .split('$' + '{CLAUDE_PLUGIN_DATA}').join(q(path.join(base, 'data')));
      const cmd = JSON.parse(text).statusLine.command;
      const r = D.runShellCommand(shell, shells[shell], cmd, { env: { ...D.runEnv(run), NO_COLOR: '1' }, cwd: run.project, input: D.statusInput(50000) });
      assert.equal(String(r.stdout).replace(/\r/g, '').trim(), 'chat 50k (warn 100k/150k)', label + ' ' + shell + ': ' + r.stderr);
    }
  }
  if (!ran) t.skip('neither shell found');
});

test('12.2 d (kit folder name, live): the name check at install is case-sensitive and the same in Node, bash and PowerShell: a kit folder named in other letter case stops the install and is not made', async (t) => {
  const { D, shells } = await shellKit();
  const ODD_CASE = 'P' + 'ocotoko'; // built from parts: the restyled name may not appear in repo text (2.2)
  const h = home('kit-case');
  const values = { ...h.values, KIT: S.slash(path.join(h.config, ODD_CASE)) };
  const r = S.performList(doc, 'install', { values, repo: REPO_TOP, shell: 'bash', runMcp: null });
  assert.equal(r.results[0].status, 'stopped');
  assert.match(r.results[0].reason, /must be named pocotoko/);
  assert.ok(!fs.existsSync(path.join(h.config, ODD_CASE)), 'node: not made');
  for (const shell of ['bash', 'powershell']) {
    if (!shells[shell]) { t.diagnostic(shell + ': ' + shells.why[shell]); continue; }
    const run = D.makeRun('install-steps-test', 'case-' + shell);
    t.after(() => D.removeRun(run));
    const config = path.join(run.dir, 'home', '.claude');
    const v = { REPO: S.slash(REPO_TOP), CONFIG: S.slash(config), KIT: S.slash(path.join(config, ODD_CASE)), NODE: S.slash(process.execPath) };
    const b = runBlock(D, shells, shell, 'install', run, v);
    assert.match(String(b.stdout), /Stopped: the kit folder must be named pocotoko\./, shell + ': ' + b.stdout + b.stderr);
    assert.ok(!fs.existsSync(path.join(config, ODD_CASE)), shell + ': not made');
  }
});
