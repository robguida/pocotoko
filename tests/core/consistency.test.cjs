'use strict';
// Repo-wide consistency checks (spec 2.2, 4, 5.1, 6.2, 6.6, 6.10, 6.12, 9.9, 12.2, 14, 15.1
// consistency row, T-34). Rows for files that do not exist yet are added with those files:
//   B8 (done, the docs section at the end of this file): README's T-11 row text and the SR-50 points (T-33),
//       docs/install.md, docs/search.md, docs/session-limits.md, docs/prompt-cache.md, docs/token-habits.md and every
//       14.5 page, CODEOWNERS, the README floor line with `engines`.
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

// ---------------------------------------------------------------------------
// B8 docs (11, 14.1, 14.2, 14.3 engines, 14.5, T-11 row 1, T-33). Each point is checked by a fixed key
// sentence kept here, so a rewrite that drops a point fails.

const has = (text, sentence) => text.includes(sentence);
const norm = (s) => s.replace(/\s+/g, ' ');

test('14.1, 14.2, 14.5: every top file, .github file and docs page exists and is not empty', () => {
  const files = [['README.md'], ['LICENSE'], ['CONTRIBUTING.md'], ['.github', 'SECURITY.md'], ['.github', 'CODEOWNERS'], ['docs', 'install.md'], ['docs', 'install-steps.json'], ['docs', 'dynamic-modeling.md'], ['docs', 'session-limits.md'], ['docs', 'prompt-cache.md'], ['docs', 'search.md'], ['docs', 'token-habits.md'], ['docs', 'changelog.md'], ['docs', 'design', 'ptt-spec.md']];
  for (const parts of files) assert.ok(read(...parts).trim().length > 0, parts.join('/'));
});

test('14.3 engines: both manifests hold the same claude-code range, the README and install floor lines name that version, and the CI pin is the same version', () => {
  const core = readJson('src', 'core', '.claude-plugin', 'plugin.json');
  const search = readJson('src', 'search', '.claude-plugin', 'plugin.json');
  assert.deepEqual(core.engines, { 'claude-code': '>=2.1.329' });
  assert.deepEqual(search.engines, core.engines);
  assert.ok(has(read('README.md'), 'Claude Code 2.1.329 or later'));
  assert.ok(has(read('README.md'), '2.1.292'), 'the one-command install floor is stated');
  assert.ok(has(read('docs', 'install.md'), 'Claude Code 2.1.329 or later'));
  assert.match(read('.github', 'workflows', 'ci.yml'), /CLAUDE_CODE_VERSION: 2\.1\.329\b/);
});

test('6.10 a row 1 (T-11 f): README and docs/install.md hold the row 1 text; no page names the current-folder variable or a Node-path option', () => {
  const readme = norm(read('README.md'));
  const install = norm(read('docs', 'install.md'));
  for (const k of [
    'Plugin mode starts Node by the plain name `node`, found on your `PATH`, and has no Node-path option.',
    'a repository could plant its own program named `node`',
    'a planted copy did not run for any hook',
    'The kit cannot control how Claude Code finds the program.',
    'A copy-by-hand install always uses the full path of Node'
  ]) {
    assert.ok(has(readme.toLowerCase(), k.toLowerCase()), 'README: ' + k);
    assert.ok(has(install.toLowerCase(), k.toLowerCase()), 'docs/install.md: ' + k);
  }
  assert.ok(has(readme, 'you must update it after you move or upgrade Node'));
  assert.ok(has(install, 'You must update that path after you move or upgrade Node.'));
  const NOCWD = ['NoDefault', 'CurrentDirectory', 'InExePath'].join('');
  for (const f of [['README.md'], ['docs', 'install.md'], ['docs', 'session-limits.md'], ['docs', 'search.md']]) {
    const text = read(...f);
    assert.ok(!text.includes(NOCWD), f.join('/') + ' must not name the variable (T-11 d did not show it closes the gap)');
    assert.ok(!/node_path/i.test(text), f.join('/') + ' must not mention a node_path option');
  }
});

const SR50 = [
  'The search index is an unencrypted copy of text from your files.',
  'Any program running as you can read it.',
  'Backup or sync tools that copy your home folder or your Claude config folder copy the index too.',
  'Whatever search returns becomes part of the chat and is sent to the model provider, the same as when Claude reads the file.',
  'The secret scan is best effort. Keep secrets out of files you index.',
  'Files that come from outside (downloaded pages, vendored READMEs, pasted issue text) can carry hidden instructions. Search results are data.',
  'On Windows the index takes the permissions of your profile folder. On a shared machine, check them.',
  'Uninstalling the plugin deletes the index when it is removed from the last place it is installed, unless you used `--keep-data`.',
  'Do not index material you are not allowed to copy',
  'create a file named `OFF` in the search data folder',
  'add your own never-terms'
];

test('11 SR-50 / T-33: README and docs/search.md each hold all nine points', () => {
  for (const f of [['README.md'], ['docs', 'search.md']]) {
    const text = norm(read(...f));
    for (const k of SR50) assert.ok(has(text, norm(k)), f.join('/') + ' is missing: ' + k);
  }
});

test('11 SR-23, SR-40, SR-21, T-33: docs/search.md holds the Windows-permissions and what-the-kit-cannot-stop points, the config-folder case, the emoji flag false alarm, the mark lines with placeholders, and every option', () => {
  const s = norm(read('docs', 'search.md'));
  for (const k of [
    "so on Windows the kit does not check the index's permissions. It discloses them instead",
    'the index inherits the permissions of your profile folder',
    'Once Claude reads a planted line, it is text in the chat.',
    'If you let Claude run shell commands without asking, a planted instruction has real reach.',
    'It does not remove the risk.',
    'If your config folder is inside a git repo, or inside the project, search switches itself off',
    'Emoji subdivision flags',
    'That is an accepted false alarm',
    'SUPERSEDED <YYYY-MM-DD> by <relative path>',
    'PARTLY SUPERSEDED <YYYY-MM-DD> by <relative path>: <which part>',
    'CANCELLED <YYYY-MM-DD>: <why>',
    'Search by meaning is not included.',
    'This comes from the Claude Code docs, and two live runs showed it: with such a file in place no plugin MCP server was listed or started'
  ]) assert.ok(has(s, norm(k)), 'docs/search.md is missing: ' + k);
  assert.ok(!/(?:19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}/.test(s), 'no real date in a mark example');
  for (const k of Object.keys(readJson('src', 'search', '.claude-plugin', 'plugin.json').userConfig)) assert.ok(s.includes('`' + k + '`'), 'docs/search.md names option ' + k);
  assert.ok(has(s, 'drop_contacts') && has(s, 'max_file_bytes'));
});

test('11, T-33: docs/install.md holds the Node points, the home-folder-as-git-repo case, the developer-only local install and the managed-MCP notice; README holds the last two', () => {
  const i = norm(read('docs', 'install.md'));
  for (const k of [
    'Check with `node -v`.',
    'The common installers give a real `node.exe` on Windows.',
    'switch the hook to shell form with the full path to Node in single quotes',
    'The self-check catches a stray but genuine Node only; it can never stop a planted program.',
    'A home folder kept as a git repo.',
    'Installing from a local folder is a developer path only.',
    'the kit saves nothing',
    'takes exclusive control of MCP servers, you will not get plugin MCP servers, so the search plugin cannot start for you',
    'This comes from the Claude Code docs, and two live runs showed it: with such a file in place no plugin MCP server was listed or started',
    'so the copy-by-hand step that registers the search server cannot work there either',
    '--debug',
    '/hooks',
    'Uninstall leaves nothing the kit created, except what you chose to keep.',
    'A comma-separated list works when each listed folder exists.',
    'List the folder you start sessions in.',
    'blocks a hook launch that names an option you never set, and only that launch',
    "a stand-in server's never-set text option with a default got that default",
    'The core hooks name no options.'
  ]) assert.ok(has(i, norm(k)), 'docs/install.md is missing: ' + k);
  const r = norm(read('README.md'));
  for (const k of ['Installing from a local folder is for developers only.', 'takes exclusive control of MCP servers, you will not get plugin MCP servers, so the search plugin cannot start for you', 'This comes from the Claude Code docs, and two live runs showed it', 'cannot register the search server there either', 'Uninstall leaves nothing the kit created, except what you chose to keep.']) assert.ok(has(r, norm(k)), 'README is missing: ' + k);
  // Held items are marked pending, never stated as an instruction or a fact.
  assert.ok(has(i, 'PENDING'), 'held items are marked PENDING');
  assert.ok(!/set every search option/i.test(i + norm(read('docs', 'search.md'))), 'the held "set every search option" line is not stated');
});

test('6.6 b, SR-C4, SR-C5, 6.2, 6.8, 6.11 h, T-33: docs/session-limits.md holds its notices and every option', () => {
  const s = norm(read('docs', 'session-limits.md'));
  for (const k of [
    'Each prompt you send re-sends the whole chat so far.',
    "A note written when you run the `handoff` skill yourself follows the skill's text; code does not enforce it.",
    "The write follows the skill's steps; code does not enforce it.",
    'Notes can hold work details. Keep them out of repos and out of synced folders.',
    'Some editor panels do not draw a custom status line.',
    'lower both `soft_tokens` and `hard_tokens` to match',
    'whose format belongs to Claude Code and can change between versions',
    "chat-length meter cannot read this chat's format; it is off for this session",
    'Routing rules were not added at session start: the model-routing skill file is inside the current project, so it was not read.',
    "`& '<NODE>' '<path to meter.cjs>' --statusline`",
    "Git Bash, macOS and Linux: `'<NODE>' '<path to meter.cjs>' --statusline`",
    "Whether a project's own settings can move your config folder this way has not been checked."
  ]) assert.ok(has(s, norm(k)), 'docs/session-limits.md is missing: ' + k);
  for (const k of Object.keys(M.DEFAULTS)) assert.ok(s.includes('`' + k + '`'), 'docs/session-limits.md names option ' + k);
});

test('8, 14.5: docs/prompt-cache.md names its three source URLs, tags facts [CC], [API] or [SL], and holds no percent sign or currency sign; docs/token-habits.md links its source and holds none either', () => {
  const c = read('docs', 'prompt-cache.md');
  for (const u of ['https://code.claude.com/docs/en/prompt-caching.md', 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md', 'https://code.claude.com/docs/en/statusline.md']) assert.ok(c.includes(u), u);
  for (const tag of ['[CC]', '[API]', '[SL]']) assert.ok(c.includes(tag), tag);
  const MONEY = /[%$€£¥]/;
  assert.ok(!MONEY.test(c), 'prompt-cache: no percent or currency sign');
  const h = read('docs', 'token-habits.md');
  assert.ok(h.includes('https://code.claude.com/docs/en/costs.md'));
  assert.ok(!MONEY.test(h), 'token-habits: no percent or currency sign');
});

test('14.5: README names every docs page; every relative Markdown link and every backtick *.md path in the README, CONTRIBUTING and the docs resolves to a file (from the page folder or the repo top)', () => {
  const readme = read('README.md');
  for (const f of ['install.md', 'dynamic-modeling.md', 'session-limits.md', 'prompt-cache.md', 'search.md', 'token-habits.md', 'changelog.md']) assert.ok(readme.includes('docs/' + f), f);
  const pages = [['README.md'], ['CONTRIBUTING.md'], ['.github', 'SECURITY.md'], ...fs.readdirSync(path.join(REPO_TOP, 'docs')).filter((n) => n.endsWith('.md') && n !== 'changelog.md').map((n) => ['docs', n])];
  const resolves = (page, ref) => [path.resolve(REPO_TOP, ...page.slice(0, -1), ref), path.resolve(REPO_TOP, ref)].some((f) => fs.existsSync(f));
  let checked = 0;
  for (const page of pages) {
    const text = read(...page).replace(/^```[\s\S]*?^```/gm, '');
    for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(m[1])) continue;
      checked++;
      assert.ok(resolves(page, m[1]), page.join('/') + ' links to a missing file: ' + m[1]);
    }
    for (const m of text.matchAll(/`([A-Za-z0-9_./-]+\.md)`/g)) {
      checked++;
      assert.ok(resolves(page, m[1]), page.join('/') + ' names a missing file: ' + m[1]);
    }
  }
  assert.ok(checked > 10, 'the check found references to test');
});

test('13.5, 14.2: CODEOWNERS covers exactly the five required paths, each names an owner and exists; CONTRIBUTING holds the repo-hardening points; SECURITY names private reporting and the limits', () => {
  const co = read('.github', 'CODEOWNERS').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  const wanted = ['src/**/hooks/**', 'src/search/**', '.github/**', 'scripts/**', 'package.json'];
  assert.deepEqual(co.map((l) => l.trim().split(/\s+/)[0].replace(/^\//, '')).sort(), wanted.slice().sort());
  for (const l of co) assert.ok(l.trim().split(/\s+/).length >= 2, 'each line names an owner: ' + l);
  for (const w of wanted) {
    const stat = w.split('*')[0].replace(/\/$/, '');
    assert.ok(fs.existsSync(path.join(REPO_TOP, stat || '.')), 'path exists: ' + w);
  }
  assert.ok(fs.existsSync(path.join(SRC, 'core', 'hooks')) && fs.existsSync(path.join(SRC, 'search')) && fs.existsSync(path.join(REPO_TOP, 'scripts')));
  const c = norm(read('CONTRIBUTING.md'));
  for (const k of [
    'Both scan layers must pass before a commit.',
    "Do not use the host's web merge or web edit buttons.",
    'Every outside pull request gets a security review before merge.',
    'A lone maintainer cannot approve their own pull request.',
    'The required checks are never skipped',
    'a force push is never allowed',
    'This bypass is removed once a second maintainer with review rights joins.',
    'Close every Claude Code session before you run them',
    'Private vulnerability reporting switched on.',
    "Contributions are under the repo's licence"
  ]) assert.ok(has(c, norm(k)), 'CONTRIBUTING.md is missing: ' + k);
  const s = norm(read('.github', 'SECURITY.md'));
  assert.ok(has(s, 'private vulnerability reporting'));
  assert.ok(has(s, 'What the kit does not do'));
  assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(s), 'no personal email in SECURITY.md');
  assert.ok(has(s, 'Its Node self-check catches a stray but genuine Node program only.'));
});

// The user pages the --values-stdin guard reads: README.md, CONTRIBUTING.md and docs/*.md, except
// docs/changelog.md (history) and the spec under docs/design/ (not a .md file at the docs top).
function valuesStdinPages() {
  const docsDir = path.join(REPO_TOP, 'docs');
  return [['README.md'], ['CONTRIBUTING.md']].concat(fs.readdirSync(docsDir).filter((n) => n.endsWith('.md') && n !== 'changelog.md').sort().map((n) => ['docs', n]));
}

// Each line on its own, split again after a sentence end (. ! or ? then white space). Simple on
// purpose: an odd split only makes more, shorter sentences, and each is judged alone.
function sentencesOf(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    for (const s of line.split(/(?<=[.!?])\s+/)) if (s.trim()) out.push(s.trim());
  }
  return out;
}

const IMPERATIVE_VERB = '(?:set|use|run|give|pass|call|configure|pipe|type|enter)\\b';
const IMPERATIVE = new RegExp('^' + IMPERATIVE_VERB + '|(?:,|;|\\bthen)\\s+' + IMPERATIVE_VERB, 'i');
// A modal or purpose form ahead of the command: "you can / may / should" or "to set / change /
// enable", anywhere before --values-stdin in the sentence.
const MODAL_OR_PURPOSE = /\b(?:you\s+(?:can|may|should)|to\s+(?:set|change|enable))\b[\s\S]*--values-stdin/i;
const VALUES_STDIN_FACT = /\breached\b|\bhas not been seen\b/i;

// A sentence naming --values-stdin passes only when it is not an instruction and it is a fact
// sentence ("reached", "has not been seen") or carries PENDING as a whole word in capitals.
// "stores" or "stored" alone is not enough. An instruction: it starts with set / use / run /
// give / pass / call / configure / pipe / type / enter (after list marks, emphasis and a PENDING
// label), or holds one of them after a comma, semicolon or "then", or holds "you can / may /
// should" or "to set / change / enable" before the command; any case.
// Returns the offending sentences.
function valuesStdinViolations(text) {
  const bad = [];
  for (const s of sentencesOf(text)) {
    if (!/--values-stdin/i.test(s)) continue;
    const bare = s.replace(/^[^A-Za-z]+/, '').replace(/^PENDING\b[^A-Za-z]*/, '');
    const instruction = IMPERATIVE.test(bare) || MODAL_OR_PURPOSE.test(s);
    const ok = !instruction && (VALUES_STDIN_FACT.test(s) || /\bPENDING\b/.test(s));
    if (!ok) bad.push('names --values-stdin outside a PENDING or fact sentence: ' + s.slice(0, 80));
  }
  return bad;
}

test('9.13 / fix round 3: the --values-stdin guard judges each sentence: an instruction fails in any case and inside a long line, and the real fact sentences in the docs pass', () => {
  const fails = [
    'Set the never-lists with `claude plugin configure --values-stdin`.',
    "A list stored as one comma-separated line reached a plugin's server as stored. Set the never-lists with `claude plugin configure --values-stdin`. The other keys are stored too.",
    'Set the never-lists with `claude plugin configure --values-stdin`, which stores them as typed, so they reached the server.',
    'Depending on your setup, set the never-lists with `claude plugin configure --values-stdin`.',
    'use `claude plugin configure --values-stdin` to set them',
    'USE `CLAUDE PLUGIN CONFIGURE --VALUES-STDIN` TO SET THEM',
    'SET THEM WITH `CLAUDE PLUGIN CONFIGURE --VALUES-STDIN`.',
    'If a list is stored, then run `claude plugin configure --values-stdin` again.',
    '- **PENDING:** set the never-lists with `--values-stdin`.',
    'pending: a call with `--values-stdin` naming some keys.',
    'The settings command `claude plugin configure --values-stdin` stores such a line as it was typed.',
    'You can set the never-lists with `claude plugin configure --values-stdin`, which stores them as typed.',
    'To set the lists, pipe JSON-array text to `claude plugin configure --values-stdin`; it stores the line as typed.',
    'You should configure the lists with `claude plugin configure --values-stdin`, so they reached the server.',
    'Enter the lists through `claude plugin configure --values-stdin`; it stores them as typed.'
  ];
  const wrong = [];
  for (const s of fails) if (valuesStdinViolations(s).length !== 1) wrong.push('should fail once: ' + s);
  const passes = [
    '- **PENDING:** a call with `--values-stdin` naming some keys.',
    'A list stored by `--values-stdin` reached the server as stored.',
    'Whether `--values-stdin` keeps the other keys has not been seen.'
  ];
  for (const s of passes) if (valuesStdinViolations(s).length !== 0) wrong.push('should pass: ' + s);
  // The real sentences in the user pages that name --values-stdin are fact sentences and pass.
  const real = [];
  for (const f of valuesStdinPages()) for (const s of sentencesOf(read(...f))) if (/--values-stdin/i.test(s)) real.push([f.join('/'), s]);
  assert.ok(real.length >= 2, 'the user pages hold the --values-stdin fact sentences');
  for (const [f, s] of real) if (valuesStdinViolations(s).length !== 0) wrong.push(f + ': real sentence fails: ' + s.slice(0, 80));
  assert.deepEqual(wrong, []);
});

test('3.1 fact 7 still open (iv): README, docs/search.md and docs/install.md each hold the partial-call bullet in "Not yet proven" (PENDING on the two docs pages)', () => {
  const key = norm('when you change some options with `claude plugin configure`, whether the options you did not name are kept has not been seen. If they were dropped, a never-list could stop narrowing.');
  const missing = [];
  for (const [f, mark] of [[['README.md'], '- '], [['docs', 'search.md'], '- **PENDING:** '], [['docs', 'install.md'], '- **PENDING:** ']]) {
    const lines = read(...f).split('\n');
    const start = lines.findIndex((l) => /^## Not yet proven\s*$/.test(l));
    if (start < 0) { missing.push(f.join('/') + ': no "Not yet proven" section'); continue; }
    let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
    if (end < 0) end = lines.length;
    const bullet = lines.slice(start + 1, end).find((l) => l.startsWith(mark) && has(norm(l), key));
    if (!bullet) missing.push(f.join('/') + ': no partial-call bullet');
  }
  assert.deepEqual(missing, []);
});

test('11 SR-50 points 7 and 9, 3.1 fact 7, 9.13 (third logged-in probe): README and docs/search.md give the index path and the OFF file place, say a list in the stored forms reached a plugin server as stored and one set through the interactive form may not narrow until that form is proven, and give no instruction to set the never-lists with --values-stdin; the held lines name every manifest option with no default and every non-text option with a default', () => {
  for (const f of [['README.md'], ['docs', 'search.md']]) {
    const text = norm(read(...f));
    for (const k of [
      '<config folder>/plugins/data/pocotoko-search-pocotoko/indexes/<16 hex>/',
      '<KIT>/search/data/',
      'may not narrow anything when they are set through the interactive `/plugin configure` form, or when you change only some options with `claude plugin configure`, until both are proven',
      "reached a plugin's server as stored, and the kit reads such a list entry by entry",
      'search: do not index'
    ]) assert.ok(has(text, norm(k)), f.join('/') + ' is missing: ' + k);
  }
  assert.ok(has(norm(read('docs', 'search.md')), 'The never-lists do not fail safe.'));
  assert.ok(has(norm(read('README.md')), 'Notes in the default hand-off folder are deleted with the plugin'));
  // The options table: each never-list row carries the plugin-install caveat, and the
  // never_terms row does not state the drop as fact.
  const rows = {};
  for (const line of read('docs', 'search.md').split('\n')) {
    const m = /^\| `(never_folders|never_globs|never_terms)` \|/.exec(line);
    if (m) rows[m[1]] = line;
  }
  assert.deepEqual(Object.keys(rows).sort(), ['never_folders', 'never_globs', 'never_terms'], 'docs/search.md options table rows');
  for (const [k, line] of Object.entries(rows)) assert.ok(has(line, '(Plugin install: see the caveat in point 9'), k + ' row is missing the plugin-install caveat');
  assert.ok(has(rows.never_terms, 'a list set through the interactive form may not drop or skip anything until that form is proven'), 'never_terms row: the caveat says an interactive-form list may not drop or skip');
  assert.ok(!/A chunk holding it is dropped|a file whose path holds it is skipped/.test(rows.never_terms), 'never_terms row must not state the drop as fact');
  // 3.1 fact 7 still open (i) and (iii): the held lines name every manifest option with no
  // default, and every non-text option with a default, on the README, search and install pages.
  // Every page and option is checked; the failures are collected and asserted once.
  const cfg = readJson('src', 'search', '.claude-plugin', 'plugin.json').userConfig;
  const noDefault = Object.keys(cfg).filter((k) => !Object.prototype.hasOwnProperty.call(cfg[k], 'default'));
  const nonTextDefault = Object.keys(cfg).filter((k) => !noDefault.includes(k) && cfg[k].type !== 'string');
  assert.ok(noDefault.length > 0 && nonTextDefault.length > 0);
  const missing = [];
  const namedIn = (line) => [...line.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
  for (const [f, start] of [[['README.md'], 'Whether an option with no default that you never set'], [['docs', 'search.md'], '**PENDING:** whether an option that has no default'], [['docs', 'install.md'], 'Whether a never-set option with no default']]) {
    const lines = read(...f).split('\n');
    const line = lines.find((l) => l.includes(start));
    if (!line) { missing.push(f.join('/') + ': no no-default line'); continue; }
    for (const k of noDefault) if (!namedIn(line).includes(k)) missing.push(f.join('/') + ': no-default line does not name ' + k);
    const held = lines.find((l) => /has not been seen/.test(l) && nonTextDefault.every((k) => namedIn(l).includes(k)));
    if (!held) missing.push(f.join('/') + ': no not-seen line naming ' + nonTextDefault.join(', '));
  }
  // 9.13 / fix round 3: a sentence that names --values-stdin must be a fact or PENDING sentence; never an instruction.
  for (const f of valuesStdinPages()) for (const v of valuesStdinViolations(read(...f))) missing.push(f.join('/') + ': ' + v);
  assert.deepEqual(missing, []);
});

test('11 / 6.11 h: README "Not yet proven" holds the never-list bullet; the copy-by-hand scope is on the 6.11 h note in session-limits and install; the plugins folder is the folder CLAUDE_CODE_PLUGIN_CACHE_DIR names', () => {
  const r = norm(read('README.md'));
  assert.ok(has(r, 'but the never-lists (`never_terms`, `never_folders`, `never_globs`) would not narrow anything'));
  assert.ok(has(norm(read('docs', 'session-limits.md')), '**Config folder inside the project you opened (copy-by-hand install).**'));
  assert.ok(has(norm(read('docs', 'install.md')), '**A config folder inside the project you opened (copy-by-hand install)**'));
  for (const f of [['README.md'], ['docs', 'search.md'], ['docs', 'install.md']]) assert.ok(has(norm(read(...f)), 'the plugins folder is the folder that variable names'), f.join('/'));
});

test('1.4, 17: no docs page or README mentions a sponsor button, and no heading says "official"', () => {
  for (const name of ['install.md', 'dynamic-modeling.md', 'session-limits.md', 'prompt-cache.md', 'search.md', 'token-habits.md']) {
    const text = read('docs', name);
    for (const line of text.split('\n')) if (/^#/.test(line)) assert.ok(!/official/i.test(line), name + ': ' + line);
    assert.ok(!/sponsor/i.test(text), name + ' mentions a sponsor');
  }
  assert.ok(!/sponsor/i.test(read('README.md')));
});

test('9.8 / SR-12: the search server\'s copy of the 6.11 f table and cap (server/fsx.cjs) equals the meter\'s, and both give the same answers', () => {
  const FSX = require('../../src/search/server/fsx.cjs');
  assert.deepEqual({ ...FSX.UNPRINTABLE_CLASSES }, { ...M.UNPRINTABLE_CLASSES });
  assert.equal(FSX.PATH_MAX_CHARS, M.LIMITS.PATH_MAX_CHARS);
  const samples = ['/x/a\u202eb', '/x/a\u0085b', '/x/a\u2028b', '/x/a\u200bb', '/x/a\ufeffb', '/x/a\u0000b', '/x/ab', '/x/\u00e9\u4e2d', 'x'.repeat(1024), 'x'.repeat(1025), '',
    '/x/a\u00adb', '/x/a\u180eb', '/x/a\u2061b', '/x/a\u206fb', '/x/a\ufffbb', '/x/a\u{e0000}b', '/x/a\u{e0041}b', '/x/a\u{e007f}b', '/x/a\u{e0080}b', '/x/a\u2065b'];
  for (const p of samples) assert.equal(FSX.printablePath(p), M.printablePath(p), JSON.stringify(p.slice(0, 8)));
  // L-1: every character the search server's file-name class refuses (walker.cjs, envelope.cjs)
  // is never printed in a path by either plugin, and so is the whole tag block.
  const serverClass = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]$/u;
  let refused = 0;
  for (let cp = 0; cp <= 0xe01ff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (cp > 0xffff && cp < 0xe0000 && cp !== 0x110bd && cp !== 0x1d173) continue;
    const ch = String.fromCodePoint(cp);
    const must = serverClass.test(ch) || (cp >= 0xe0000 && cp <= 0xe007f);
    if (!must) continue;
    refused++;
    assert.equal(M.printablePath('/x/a' + ch + 'b'), false, 'meter U+' + cp.toString(16));
    assert.equal(FSX.printablePath('/x/a' + ch + 'b'), false, 'server U+' + cp.toString(16));
  }
  assert.ok(refused > 200, 'the sweep found the class');
  assert.equal(SRV.LINES.FOLDER_UNPRINTABLE, '(not shown: the folder path holds a character that cannot be shown safely, or is over 1,024 characters)');
});
