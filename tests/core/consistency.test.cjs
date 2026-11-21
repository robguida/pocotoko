'use strict';
// Repo-wide consistency checks (spec 2.2, 4, 5.1, 6.2, 6.6, 6.10, 6.12, 9.9, 12.2, 14, 15.1
// consistency row, T-34). Rows for files that do not exist yet are added with those files:
//   B8: README's T-11 row text and the SR-50 points (T-33), docs/install.md, docs/search.md,
//       docs/session-limits.md, docs/prompt-cache.md, docs/token-habits.md and every 14.5
//       page, CODEOWNERS, the README floor line with `engines`.
//   B9 (done, at the end of this file): the docs/install.md blocks against a fresh render of docs/install-steps.json.
// The search plugin's 9.13 option table and its env-only mapping are checked in
// tests/search/static.test.cjs (same 15.1 row); they are not copied here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../../src/core/hooks/meter.cjs');
const SS = require('../../src/core/hooks/session-start.cjs');
const E = require('../../src/search/server/envelope.cjs');
const SRV = require('../../src/search/server/server.cjs');

const REPO_TOP = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO_TOP, 'src');
const CORE = path.join(SRC, 'core');
const SEARCH = path.join(SRC, 'search');
const RESERVED = [['cla', 'ude'], ['anthr', 'opic']].map((p) => p.join(''));
const LABEL = 'Project maintainers';
const SKILLS = ['handoff', 'meter-statusline', 'model-routing'];
const COPIED_SKILLS = ['handoff', 'model-routing']; // 12.2 step 2: copy-by-hand also installs these
const DOLLAR_BRACE = '$' + '{';

function readJson(...parts) {
  return JSON.parse(fs.readFileSync(path.join(REPO_TOP, ...parts), 'utf8'));
}
function read(...parts) {
  return fs.readFileSync(path.join(REPO_TOP, ...parts), 'utf8');
}
function skillText(name) {
  return read('src', 'core', 'skills', name, 'SKILL.md');
}
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'frontmatter block');
  const keys = {};
  for (const line of m[1].split('\n')) {
    const k = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (k) keys[k[1]] = k[2];
  }
  return keys;
}
function body(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n/, '');
}
/** Every file under dir (relative, forward slashes); folders skipped by name. */
function walk(dir, skip = new Set()) {
  const out = [];
  const go = (d) => {
    for (const n of fs.readdirSync(d)) {
      if (skip.has(n)) continue;
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) go(p);
      else out.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  };
  go(dir);
  return out.sort();
}
/** Repo files a contributor would commit: no .git, sandbox/, node_modules/, private notes or deny-lists. */
function repoFiles() {
  return walk(REPO_TOP, new Set(['.git', 'sandbox', 'node_modules', 'CLAUDE.local.md'])).filter((f) => !/(^|\/)scrub-denylist/.test(f));
}
const canonical = readJson('src', 'core', '.claude-plugin', 'plugin.json').name;

// ---------------------------------------------------------------------------
// Names (2.2, 1.4 hard line 2)

test('2.2: every name repeat equals the canonical name: marketplace name and entries, the search plugin name, the MCP server name', () => {
  assert.match(canonical, /^[a-z][a-z0-9]*$/);
  const mkt = readJson('.claude-plugin', 'marketplace.json');
  assert.equal(mkt.name, canonical);
  assert.deepEqual(mkt.plugins.map((p) => p.name), [canonical, canonical + '-search']);
  assert.equal(readJson('src', 'search', '.claude-plugin', 'plugin.json').name, canonical + '-search');
  assert.deepEqual(Object.keys(readJson('src', 'search', '.mcp.json').mcpServers), [canonical + '-search'], 'server name = search plugin name');
});

test('2.2: no split or restyled form of the name anywhere in the repo (only the id form and the display form)', () => {
  const display = canonical.slice(0, 4).replace(/^./, (c) => c.toUpperCase()) + canonical.slice(4).replace(/^./, (c) => c.toUpperCase());
  const any = new RegExp(canonical.slice(0, 4) + '[^A-Za-z0-9]{0,3}' + canonical.slice(4), 'gi');
  for (const f of repoFiles()) {
    if (/\.(?:png|jpe?g|gif|ico|webp)$/i.test(f)) continue;
    const text = fs.readFileSync(path.join(REPO_TOP, f), 'utf8');
    for (const m of text.matchAll(any)) assert.ok(m[0] === canonical || m[0] === display, `${f}: ${JSON.stringify(m[0])}`);
  }
});

test('2.2: the name never appears in skill bodies, fixtures or package.json; the core scripts hold it only in their fixed user lines', () => {
  for (const s of SKILLS) assert.ok(!skillText(s).toLowerCase().includes(canonical), s);
  for (const f of walk(path.join(REPO_TOP, 'tests', 'fixtures'))) assert.ok(!read('tests', 'fixtures', f).toLowerCase().includes(canonical), f);
  const pkg = read('package.json');
  assert.ok(!pkg.toLowerCase().includes(canonical));
  assert.equal(read('src', 'core', 'hooks', 'meter.cjs').toLowerCase().split(canonical).length - 1, 1, 'meter.cjs: the 6.9 line only');
  assert.equal(read('src', 'core', 'hooks', 'session-start.cjs').toLowerCase().split(canonical).length - 1, 3, 'session-start.cjs: the three 6.7 lines only');
  for (const f of fs.readdirSync(path.join(SEARCH, 'server'))) assert.ok(!read('src', 'search', 'server', f).toLowerCase().includes(canonical), f);
});

test('1.4 hard line 2: no reserved word, "official" or "for Claude" in any plugin, marketplace, skill, MCP server or tool name', () => {
  const names = [];
  const mkt = readJson('.claude-plugin', 'marketplace.json');
  names.push(mkt.name, ...mkt.plugins.map((p) => p.name));
  names.push(readJson('src', 'core', '.claude-plugin', 'plugin.json').name, readJson('src', 'search', '.claude-plugin', 'plugin.json').name);
  names.push(...Object.keys(readJson('src', 'search', '.mcp.json').mcpServers));
  names.push(...SRV.TOOL_DEFS.map((d) => d.name), SRV.SERVER_NAME);
  const folders = fs.readdirSync(path.join(CORE, 'skills')).sort();
  assert.deepEqual(folders, SKILLS);
  for (const s of folders) {
    const fm = frontmatter(skillText(s));
    assert.equal(fm.name, s, 'skill name = folder name');
    names.push(s);
  }
  assert.deepEqual(SRV.TOOL_DEFS.map((d) => d.name).sort(), ['get', 'refresh', 'search', 'status']);
  for (const n of names) {
    const low = String(n).toLowerCase();
    for (const w of RESERVED) assert.ok(!low.includes(w), n);
    assert.ok(!low.includes('official'), n);
    assert.ok(!/for[\s_-]*claude/i.test(n), n);
  }
});

test('14.1: the README holds the independent-project notice word for word', () => {
  assert.ok(read('README.md').includes('PocoToko is an independent community project, not made, endorsed or supported by Anthropic. Claude and Claude Code are trademarks of Anthropic.'));
});

// ---------------------------------------------------------------------------
// Rules blocks (5.1, 9.9)

test('5.1: the routing block is identical in the skill and the template, at most 25 lines, markers once each; session start extracts that same block', () => {
  const skill = skillText('model-routing');
  const tpl = read('src', 'core', 'templates', 'rules-block.md');
  for (const t of [skill, tpl]) {
    assert.equal(t.split(SS.MARK_START).length - 1, 1);
    assert.equal(t.split(SS.MARK_END).length - 1, 1);
  }
  const block = SS.extractBlock(skill);
  assert.equal(SS.extractBlock(tpl), block);
  assert.equal(tpl, SS.MARK_START + '\n' + block + '\n' + SS.MARK_END + '\n');
  assert.ok(block.split('\n').length <= 25);
});

test('9.9: the search block agrees in its three places (template, server instructions, search tool description), opens with the fixed notice, under 2,048 characters', () => {
  const tpl = read('src', 'search', 'templates', 'rules-block.md');
  assert.equal(tpl, E.BLOCK_START + '\n' + E.RULES_BLOCK + '\n' + E.BLOCK_END + '\n');
  assert.equal(SRV.TOOL_DEFS.find((d) => d.name === 'search').description, E.RULES_BLOCK);
  assert.ok(read('src', 'search', 'server', 'server.cjs').includes('instructions: env0.RULES_BLOCK'), 'the instructions field is the same block');
  assert.ok(E.RULES_BLOCK.startsWith(E.NOTICE));
  assert.ok(E.RULES_BLOCK.length < 2048);
});

// ---------------------------------------------------------------------------
// Options (6.2) and manifests (14.1, 14.3)

test('6.2: the core options equal the 6.2 table and DEFAULTS (keys, types, defaults, minimums), each with a title and a description; neither manifest declares node_path', () => {
  const want = {
    soft_tokens: { type: 'number', default: 100000, min: 10000 },
    hard_tokens: { type: 'number', default: 150000, min: 20000 },
    repeat_every_tokens: { type: 'number', default: 50000, min: 0 },
    handoff_note: { type: 'boolean', default: true },
    handoff_dir: { type: 'directory', default: '' },
    routing_rules_at_start: { type: 'boolean', default: true },
  };
  const uc = readJson('src', 'core', '.claude-plugin', 'plugin.json').userConfig;
  assert.deepEqual(Object.keys(uc).sort(), Object.keys(want).sort());
  assert.deepEqual(Object.keys(M.DEFAULTS).sort(), Object.keys(want).sort());
  for (const [k, w] of Object.entries(want)) {
    assert.equal(uc[k].type, w.type, k);
    assert.deepEqual(uc[k].default, w.default, k);
    assert.deepEqual(M.DEFAULTS[k], w.default, k + ' DEFAULTS');
    if ('min' in w) { assert.equal(uc[k].min, w.min, k); assert.equal(M.OPTION_RULES[k].min, w.min, k); }
    assert.ok(uc[k].title && uc[k].description, k);
  }
  for (const dir of [CORE, SEARCH]) assert.ok(!read(path.relative(REPO_TOP, path.join(dir, '.claude-plugin', 'plugin.json'))).includes('node_path'));
});

test('14.1 / 14.3: marketplace.json has two entries with forward-slash sources, the maintainer label and a description; both plugin manifests carry the label', () => {
  const mkt = readJson('.claude-plugin', 'marketplace.json');
  assert.equal(mkt.owner.name, LABEL);
  assert.ok(typeof mkt.description === 'string' && mkt.description.trim() !== '');
  assert.deepEqual(mkt.plugins.map((p) => p.source), ['./src/core', './src/search']);
  for (const p of mkt.plugins) assert.ok(!p.source.includes('\\'));
  for (const dir of ['core', 'search']) assert.equal(readJson('src', dir, '.claude-plugin', 'plugin.json').author.name, LABEL);
});

// ---------------------------------------------------------------------------
// hooks.json (6.10) and launch shape (T-34)

test('6.10 / T-34: hooks.json has the top-level hooks key and exactly two events (SessionStart 10 s, UserPromptSubmit 5 s), exec form, command node, args under ${CLAUDE_PLUGIN_ROOT}/hooks/ naming a script that exists, no option and no shell', () => {
  const text = read('src', 'core', 'hooks', 'hooks.json');
  const j = JSON.parse(text);
  assert.deepEqual(Object.keys(j), ['hooks']);
  assert.deepEqual(Object.keys(j.hooks).sort(), ['SessionStart', 'UserPromptSubmit']);
  const want = { SessionStart: ['session-start.cjs', 10], UserPromptSubmit: ['meter.cjs', 5] };
  for (const [ev, [script, timeout]] of Object.entries(want)) {
    assert.equal(j.hooks[ev].length, 1, ev);
    assert.equal(j.hooks[ev][0].hooks.length, 1, ev);
    const h = j.hooks[ev][0].hooks[0];
    assert.deepEqual(h, { type: 'command', command: 'node', args: [DOLLAR_BRACE + 'CLAUDE_PLUGIN_ROOT}/hooks/' + script], timeout }, ev);
    assert.ok(h.args[0].startsWith(DOLLAR_BRACE + 'CLAUDE_PLUGIN_ROOT}/hooks/'));
    assert.ok(fs.existsSync(path.join(CORE, 'hooks', script)), script);
  }
  assert.ok(!text.includes('user_config'), 'no option in any launch (a never-set option blocks the launch naming it)');
  for (const bad of ['npx', '.cmd', '.bat', 'cmd.exe', 'powershell', 'bash', '/bin/sh', '&', '|', ';', '>', '<', '`', '$(']) assert.ok(!text.toLowerCase().includes(bad), bad);
});

test('SR-39: the search plugin has no hooks (no hooks/ folder, no hooks key in its manifest)', () => {
  assert.ok(!fs.existsSync(path.join(SEARCH, 'hooks')));
  assert.ok(!('hooks' in readJson('src', 'search', '.claude-plugin', 'plugin.json')));
});

// ---------------------------------------------------------------------------
// Shipped files and layout (4)

test('4: the shipped-file list under src/ is exact; no bin/, no CLAUDE.md, no package.json or lockfile under src/; no CRLF in src/', () => {
  const want = [
    'core/.claude-plugin/plugin.json',
    'core/hooks/hooks.json',
    'core/hooks/meter.cjs',
    'core/hooks/session-start.cjs',
    'core/skills/handoff/SKILL.md',
    'core/skills/meter-statusline/SKILL.md',
    'core/skills/model-routing/SKILL.md',
    'core/templates/rules-block.md',
    'core/templates/settings-snippet.json',
    'search/.claude-plugin/plugin.json',
    'search/.mcp.json',
    ...['server.cjs', 'rpc.cjs', 'binder.cjs', 'walker.cjs', 'ignore.cjs', 'floor.cjs', 'scan.cjs', 'chunker.cjs', 'markers.cjs',
      'tokenize.cjs', 'stem.cjs', 'index.cjs', 'rank.cjs', 'store.cjs', 'envelope.cjs', 'fsx.cjs'].map((f) => 'search/server/' + f),
    'search/templates/rules-block.md',
  ].sort();
  const got = walk(SRC);
  assert.deepEqual(got, want);
  for (const f of got) {
    const base = path.posix.basename(f);
    assert.ok(!['CLAUDE.md', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'].includes(base), f);
    assert.ok(!f.split('/').includes('bin'), f);
    assert.ok(!read('src', f).includes('\r'), 'CRLF in ' + f);
  }
  for (const root of [CORE, SEARCH]) assert.ok(!fs.existsSync(path.join(root, 'bin')));
});

test('4: .gitignore equals the section 4 list (order free); .gitattributes is exactly the one line', () => {
  const want = ['sandbox/', 'node_modules/', '*.log', '.DS_Store', 'Thumbs.db', 'CLAUDE.local.md', 'scrub-denylist*', '*.sqlite*'];
  const got = read('.gitignore').split('\n').map((l) => l.trim()).filter((l) => l !== '');
  assert.deepEqual(got.slice().sort(), want.slice().sort());
  assert.equal(read('.gitattributes').trim(), '* text=auto eol=lf');
});

test('4 / 14.1: package.json is private, has no name, no dependencies, the two scripts, and no shell-only syntax', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.private, true);
  assert.ok(!('name' in pkg));
  assert.ok(!('dependencies' in pkg) && !('devDependencies' in pkg));
  assert.equal(pkg.scripts.test, 'node scripts/run-tests.mjs');
  assert.equal(pkg.scripts.scrub, 'node scripts/scrub-scan.mjs');
  for (const s of Object.values(pkg.scripts)) for (const bad of ['&&', ';', '$(', 'rm ', 'cp ']) assert.ok(!s.includes(bad), s);
});

test('1.4 hard line 5: no image file anywhere in the repo', () => {
  for (const f of repoFiles()) assert.ok(!/\.(?:png|jpe?g|gif|svg|ico|webp)$/i.test(f), f);
});

test('1.4 hard line 8: THIRD-PARTY-NOTICES exists only when a source file carries a borrowed-source header (a comment near the top naming a source and its licence), and then names that source', () => {
  const headers = [];
  for (const f of walk(REPO_TOP, new Set(['.git', 'sandbox', 'node_modules', 'tests', 'docs']))) {
    if (!/\.(?:c?js|mjs)$/.test(f)) continue;
    const top = read(f).split('\n').slice(0, 20).filter((l) => /^\s*(?:\/\/|\/?\*)/.test(l));
    const hit = top.find((l) => /licen[cs]e/i.test(l) && /\b(?:source|from)\b/i.test(l));
    if (hit) headers.push([f, hit]);
  }
  const notices = path.join(REPO_TOP, 'THIRD-PARTY-NOTICES');
  if (!headers.length) assert.ok(!fs.existsSync(notices), 'nothing is borrowed, so no notices file');
  else {
    assert.ok(fs.existsSync(notices), 'a borrowed header needs the notices file: ' + headers.map((h) => h[0]).join(', '));
    const text = fs.readFileSync(notices, 'utf8');
    for (const [f, line] of headers) {
      const src = /(?:source|from)\s*:?\s*(\S+)/i.exec(line);
      assert.ok(src && text.includes(src[1]), f + ': its source is named in the notices file');
    }
  }
});

test('16: docs/changelog.md holds the rule-set snapshot line and a tested Claude Code version line', () => {
  const log = read('docs', 'changelog.md');
  assert.match(log, /^- \*\*Rule-set snapshot date:\*\* [0-9]{4}-[0-9]{2}-[0-9]{2}/m);
  assert.match(log, /^- \*\*Claude Code version tested:\*\* [0-9]+\.[0-9]+\.[0-9]+/m);
});

// ---------------------------------------------------------------------------
// Skills (5.1, 6.6, 6.12, 14.3)

test('14.3 / 5.1: no kit skill frontmatter carries model or effort; each has a name and a description', () => {
  for (const s of SKILLS) {
    const fm = frontmatter(skillText(s));
    assert.ok(!('model' in fm), s + ': no model');
    assert.ok(!('effort' in fm), s + ': no effort');
    assert.ok(fm.description && fm.description.length > 20, s);
  }
});

test('6.6: no plugin path variable (no dollar-brace text at all) in the two skills copy-by-hand installs; no kit skill holds a user_config substitution; meter-statusline may use the data folder variable', () => {
  for (const s of COPIED_SKILLS) assert.ok(!skillText(s).includes(DOLLAR_BRACE), s);
  for (const s of SKILLS) assert.ok(!skillText(s).includes(DOLLAR_BRACE + 'user_config.'), s);
  const ms = skillText('meter-statusline');
  const vars = [...ms.matchAll(/\$\{([A-Za-z_]+)\}/g)].map((m) => m[1]);
  assert.ok(vars.length > 0);
  for (const v of vars) assert.equal(v, 'CLAUDE_PLUGIN_DATA', 'only the data folder variable');
});

test('6.6 b / 14.3: the handoff skill states the name rules, picks a new name, never overwrites a note, the 25-line limit, never secrets, prints the note in the chat when the folder line is missing, and writes into the exact path the meter names', () => {
  const t = skillText('handoff');
  for (const needle of [
    '<YYYY-MM-DD-HHmm>-<folder>-<sid>.md', 'at most 40 characters', 'at most 8', 'at most 80 characters before `.md`',
    'empty after cleaning becomes `session`', 'first 8 characters of the session id',
    'pick a new name', '`-2`', '`-9`', 'Never overwrite a note.',
    'At most 25 lines.', 'Never secrets, keys, passwords',
    'If the folder line is missing, print the note in the chat instead of writing a file.',
    'Write the note into that exact file and into no other file.',
    'Write only if that file exists and is empty.',
    'If it holds any text or is missing, write nothing to it and follow "Writing a note on request"',
    'start fresh and read', 'code does not enforce', 'Keep them out of repos and out of synced folders.',
    SS.LINES.FOLDER_PREFIX.trim(), SS.LINES.NAME_PREFIX.trim(),
  ]) assert.ok(t.includes(needle), 'handoff: ' + needle);
});

test('6.12 / SR-C5: meter-statusline is user-invoked only, names only the user-level settings file, holds the yes, backup, never-replace and undo steps, never a bare node, and says to fill in an absolute Node path when the session-start line is missing', () => {
  const t = skillText('meter-statusline');
  const fm = frontmatter(t);
  assert.equal(fm['disable-model-invocation'], 'true', 'user-invoked only');
  for (const needle of [
    SS.LINES.NODE_PREFIX.trim(),
    'If that line is missing, do not write anything.', 'fill in their own absolute Node path',
    'Never use a bare `node` as the command',
    '`' + DOLLAR_BRACE + 'CLAUDE_PLUGIN_DATA}/statusline/meter.cjs`',
    // 6.12 a to c: forward slashes; the Git Bash / macOS / Linux form and the PowerShell form; pick or ask.
    // 12.2 g: both paths in single quotes, so the shell never expands a $ or a backtick in a path.
    '"command": "\'<NODE>\' \'' + DOLLAR_BRACE + 'CLAUDE_PLUGIN_DATA}/statusline/meter.cjs\' --statusline"',
    '"command": "& \'<NODE>\' \'' + DOLLAR_BRACE + 'CLAUDE_PLUGIN_DATA}/statusline/meter.cjs\' --statusline"',
    'Keep both paths in single quotes', "write it in the settings file as `'\\\\''` in the Git Bash form", "and as `''` in the PowerShell form",
    'Write every path with forward slashes.', 'Never double the backslashes in a path.',
    'PowerShell, only on Windows without Git Bash', 'check whether Git Bash is installed',
    'If you cannot tell, show both forms and ask the user which applies.',
    'The only file this skill may change is the **user-level settings file**',
    'Ask the user for a yes first.', 'Without a clear yes, change nothing.',
    'never replace it.', 'Back up first.', DOLLAR_BRACE + 'CLAUDE_PLUGIN_DATA}/backup/settings-<YYYY-MM-DD-HHmm>.json',
    // 6.12 d: never overwrite a backup; no backup, no change.
    'never overwrite a backup.', 'If the backup cannot be made, change nothing.',
    'Print the undo lines', 'Remove the `statusLine` entry',
    'Some editor panels do not draw a custom status line.', 'code does not enforce them',
    // 6.12 e: after a Node upgrade, swap by hand.
    'run this skill again to see the new line, then swap the old `statusLine` entry by hand (the skill never replaces one)',
  ]) assert.ok(t.includes(needle), 'meter-statusline: ' + needle);
  assert.ok(!/two backslashes/i.test(t), 'backslashes are never doubled (6.12 a)');
  // Any other settings file is named only in a "never" sentence.
  for (const line of t.split('\n')) {
    if (/\.claude\/settings(?:\.local)?\.json|managed settings/.test(line)) assert.ok(/\bNever\b/.test(line), 'only in a never line: ' + line);
  }
});

// ---------------------------------------------------------------------------
// Settings snippet (12.2 step 3)

test('12.2 step 3: settings-snippet.json is a paste-safe settings fragment with placeholders only: exactly the real settings keys hooks and statusLine; the two hooks in exec form (<NODE>, <KIT>/hooks/<script>); statusLine in the Git Bash / macOS / Linux one-string form; forward slashes; never $HOME, never a bare node; no second status line key anywhere in src/', () => {
  const text = read('src', 'core', 'templates', 'settings-snippet.json');
  const j = JSON.parse(text);
  assert.deepEqual(Object.keys(j).sort(), ['hooks', 'statusLine'], 'only real settings keys');
  assert.ok(!j.statusLine.command.includes('\\'), 'forward slashes only (6.12 a)');
  // The PowerShell form is rendered from install-steps.json in B9; it is never a key in src/.
  const alt = ['statusLine', 'PowerShell'].join('');
  for (const f of walk(SRC)) assert.ok(!read('src', f).includes(alt), f);
  assert.deepEqual(Object.keys(j.hooks).sort(), ['SessionStart', 'UserPromptSubmit']);
  const want = { SessionStart: ['session-start.cjs', 10], UserPromptSubmit: ['meter.cjs', 5] };
  for (const [ev, [script, timeout]] of Object.entries(want)) {
    assert.deepEqual(j.hooks[ev], [{ hooks: [{ type: 'command', command: '<NODE>', args: ['<KIT>/hooks/' + script], timeout }] }], ev);
    assert.ok(fs.existsSync(path.join(CORE, 'hooks', script)));
  }
  assert.deepEqual(j.statusLine, { type: 'command', command: "'<NODE>' '<KIT>/hooks/meter.cjs' --statusline" });
  assert.ok(!text.includes('$HOME') && !text.includes('~/'), 'never $HOME');
  assert.ok(!/\bnode\b/.test(text), 'never a bare node');
  assert.ok(!text.includes(DOLLAR_BRACE), 'no variables, placeholders only');
  for (const m of text.matchAll(/<([A-Z]+)>/g)) assert.ok(['NODE', 'KIT'].includes(m[1]), m[0]);
});

// ---------------------------------------------------------------------------
// docs/install.md against docs/install-steps.json (12.2 b)

test('12.2 b: every marked block of docs/install.md (bash, PowerShell, the settings lines, both uninstall blocks) equals a fresh render of docs/install-steps.json', async () => {
  const { pathToFileURL } = require('node:url');
  const S = await import(pathToFileURL(path.join(REPO_TOP, 'scripts', 'lib', 'install-steps.mjs')).href);
  const { doc } = S.loadSteps(REPO_TOP);
  const blocks = S.renderBlocks(doc, REPO_TOP);
  const md = read('docs', 'install.md');
  for (const name of S.BLOCK_NAMES) assert.equal(S.extractBlock(md, name), blocks[name], name + ' differs from a fresh render: run node scripts/copy-by-hand.mjs --render');
  // No rendered block holds a key that is not a real settings key (12.2 a).
  for (const m of blocks.settings.matchAll(/```json\n([\s\S]*?)\n```/g)) assert.deepEqual(Object.keys(JSON.parse(m[1])).sort(), ['hooks', 'statusLine']);
});
