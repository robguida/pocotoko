'use strict';
// Tests for scripts/scrub-scan.mjs (spec 13.1, 15.3).
// Every scrub-shaped value (dates, addresses, keys, home paths, copyright lines) is built
// at run time from parts (13.1 e), so this file holds none and needs no exemption.
// Throwaway git repos live under the gitignored sandbox/ and use repo-local git settings only.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO_TOP, makeTempDir, removeDir } = require('../helpers/tmpdir-sandbox.cjs');

const SCRIPT = path.join(REPO_TOP, 'scripts', 'scrub-scan.mjs');
const REAL_RULES_FILE = path.join(REPO_TOP, 'scripts', 'scrub-rules.json');
const REAL_RULES = JSON.parse(fs.readFileSync(REAL_RULES_FILE, 'utf8'));
const LABEL = REAL_RULES.maintainer_label;

const made = [];
test.after(() => {
  for (const dir of made) removeDir(dir);
});

// ---------- run-time value builders (one shared module, 13.1 e) ----------

const F = require('../helpers/fake-values.cjs');
const {
  gen, isoDate, writtenDate, fakeEmail, gitIdentityEmail, copyrightLine, hex40,
  codeHostUrl, installLine, homePaths, savingsPhrase, savingsNumber, vendorToken,
} = F;

// ---------- throwaway repos ----------

function baseRules() {
  const r = JSON.parse(JSON.stringify(REAL_RULES));
  r.exemptions = [];
  return r;
}

function cleanEnv(dir) {
  const env = { ...process.env };
  delete env.SCRUB_DENYLIST;
  delete env.SCRUB_TEST_UNREADABLE;
  const sb = path.join(dir, 'sandbox');
  env.GIT_CONFIG_GLOBAL = path.join(sb, 'gitconfig');
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.TMP = path.join(sb, 'tmp');
  env.TEMP = path.join(sb, 'tmp');
  env.TMPDIR = path.join(sb, 'tmp');
  return env;
}

function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo.dir, env: repo.env, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, `git ${args[args.length - 1]} failed: ${r.stderr}`);
  return r;
}

function writeFile(dir, rel, content) {
  const target = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function makeRepo(files, opts = {}) {
  const dir = makeTempDir('scrub');
  made.push(dir);
  fs.mkdirSync(path.join(dir, 'sandbox', 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sandbox', 'gitconfig'), '');
  const repo = { dir, env: cleanEnv(dir), rules: path.join(dir, 'sandbox', 'rules.json') };
  writeFile(dir, '.gitignore', ['sandbox/', ...(opts.ignore || [])].join('\n') + '\n');
  for (const [rel, content] of Object.entries(files)) writeFile(dir, rel, content);
  fs.writeFileSync(repo.rules, JSON.stringify(opts.rules || baseRules(), null, 2));
  git(repo, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  return repo;
}

function commitAll(repo) {
  git(repo, ['add', '-A']);
  git(repo, [
    '-c', `user.name=${['scrub', 'test'].join(' ')}`,
    '-c', `user.email=${gitIdentityEmail()}`,
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', 'test commit',
  ]);
}

function scan(repo, args = [], extraEnv = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, '--rules', repo.rules, ...args], {
    cwd: repo.dir,
    env: { ...repo.env, ...extraEnv },
    encoding: 'utf8',
    windowsHide: true,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, lines: `${r.stdout}`.split(/\r?\n/).filter(Boolean) };
}

function hasHit(res, file, rule) {
  return res.lines.some((l) => l.startsWith(`${file}:`) && l.split(' ')[1] === rule);
}
function hitsFor(res, file) {
  return res.lines.filter((l) => l.startsWith(`${file}:`));
}

function coreManifest(name = 'zqkit') {
  return JSON.stringify({ name, version: '0.1.0', author: { name: LABEL } }, null, 2);
}

// ---------- each public rule fires on a planted hit ----------

test('each public rule fires on a planted hit; clean look-alikes pass', () => {
  const home = homePaths('zqtester');
  const placeholderHome = homePaths('<user>');
  const planted = {
    'p/home-win.txt': home.windows,
    'p/home-win-json.txt': home.windowsJson,
    'p/home-linux.txt': `see ${home.linux}`,
    'p/home-mac.txt': `see ${home.mac}`,
    'p/email.txt': `write to ${fakeEmail()}`,
    'p/host-url.txt': codeHostUrl('zqtester', 'zqrepo'),
    'p/host-install.txt': installLine(['zqtester', 'zqrepo'].join('/')),
    'p/iso.txt': `on ${isoDate(2026, 3, 4)}`,
    'p/savings.txt': `it ${savingsPhrase()}`,
    'p/savings-num.txt': `about ${savingsNumber()}`,
    'p/key-block.txt': F.keyBlockHeader(),
    'p/jwt.txt': F.fakeJwt(),
    'p/conn.txt': F.connString(),
    'p/signed.txt': F.signedUrl(),
    'p/webhook.txt': F.webhookUrl(),
    'p/setting.txt': F.secretSetting(),
    'p/auth.txt': F.authHeader(),
    'p/random.txt': `value ${gen(40)}`,
    'p/hex.txt': `id ${hex40()}`,
    'p/copyright.txt': copyrightLine('Zq Tester'),
    // Clean look-alikes: placeholders and allowed forms.
    'p/ok-home.txt': [placeholderHome.linux, placeholderHome.windows, '~/.claude/settings.json'].join('\n'),
    'p/ok-host.txt': [codeHostUrl('owner', 'repo'), installLine('owner/repo'), installLine('./src/core')].join('\n'),
    'p/ok-text.txt': 'The cache keeps the prefix. A commit id is pure hex. Tokens are counted, not saved.',
    '.github/workflows/ci.yml': `jobs:\n  t:\n    steps:\n      - uses: actions/checkout@${hex40()}\n      - run: echo ${hex40()}\n`,
    LICENSE: `MIT\n\n${copyrightLine('Zq Tester')}\n`,
    'THIRD-PARTY-NOTICES': `${copyrightLine('Another Project')}\n`,
  };
  const repo = makeRepo(planted);
  const res = scan(repo);
  assert.strictEqual(res.code, 1);
  const expect = [
    ['p/home-win.txt', 'home-path'], ['p/home-win-json.txt', 'home-path'], ['p/home-linux.txt', 'home-path'],
    ['p/home-mac.txt', 'home-path'], ['p/email.txt', 'email'], ['p/host-url.txt', 'host-handle'],
    ['p/host-install.txt', 'host-handle'], ['p/iso.txt', 'iso-date'], ['p/savings.txt', 'savings-phrase'],
    ['p/savings-num.txt', 'savings-phrase'], ['p/key-block.txt', 'secret-key-block'], ['p/jwt.txt', 'secret-jwt'],
    ['p/conn.txt', 'secret-conn-string'], ['p/signed.txt', 'secret-signed-url'], ['p/webhook.txt', 'secret-webhook'],
    ['p/setting.txt', 'secret-setting'], ['p/auth.txt', 'secret-auth-header'], ['p/random.txt', 'secret-random'],
    ['p/hex.txt', 'hex40'], ['p/copyright.txt', 'copyright-line'],
    ['.github/workflows/ci.yml', 'hex40'],
  ];
  for (const [file, rule] of expect) assert.ok(hasHit(res, file, rule), `${rule} should fire in ${file}\n${res.out}`);
  // The pinned uses: line passes; only the run: line hits.
  assert.deepStrictEqual(hitsFor(res, '.github/workflows/ci.yml'), ['.github/workflows/ci.yml:5 hex40']);
  for (const file of ['p/ok-home.txt', 'p/ok-host.txt', 'p/ok-text.txt', 'LICENSE', 'THIRD-PARTY-NOTICES']) {
    assert.deepStrictEqual(hitsFor(res, file), [], `${file} should be clean\n${res.out}`);
  }
});

test('every vendor prefix hits at its minimum length and not one character shorter', () => {
  const files = {};
  REAL_RULES.secrets.vendor_prefixes.forEach((v, i) => {
    files[`v/hit-${i}.txt`] = `x ${vendorToken(v.prefix, v.min, v.chars)} x`;
    files[`v/short-${i}.txt`] = `x ${vendorToken(v.prefix, v.min - 1, v.chars)} x`;
  });
  // A prefix straight after letters still hits (the prefix may sit anywhere in a word).
  const gh = REAL_RULES.secrets.vendor_prefixes.find((v) => v.prefix.startsWith('gh'));
  files['v/in-word.txt'] = `abc${gh.prefix}${gen(gh.min)}`;
  const repo = makeRepo(files);
  const res = scan(repo);
  REAL_RULES.secrets.vendor_prefixes.forEach((v, i) => {
    assert.ok(hasHit(res, `v/hit-${i}.txt`, 'secret-vendor-token'), `prefix ${i} at minimum should hit`);
    assert.ok(!hasHit(res, `v/short-${i}.txt`, 'secret-vendor-token'), `prefix ${i} one short should not hit`);
  });
  assert.ok(hasHit(res, 'v/in-word.txt', 'secret-vendor-token'));
});

// ---------- dates ----------

test('ISO dates: allowed in docs/changelog.md and tests/fixtures/, fail in tests/core/ and elsewhere', () => {
  const d = isoDate(2026, 1, 2);
  const repo = makeRepo({
    'docs/changelog.md': `- ${d} released\n`,
    'tests/fixtures/shape.json': `{"ts":"${d}"}\n`,
    'tests/core/x.test.cjs': `// ${d}\n`,
    'docs/page.md': `Updated ${d}.\n`,
  });
  const res = scan(repo);
  assert.deepStrictEqual(hitsFor(res, 'docs/changelog.md'), []);
  assert.deepStrictEqual(hitsFor(res, 'tests/fixtures/shape.json'), []);
  assert.ok(hasHit(res, 'tests/core/x.test.cjs', 'iso-date'));
  assert.ok(hasHit(res, 'docs/page.md', 'iso-date'));
});

test('date next to a quotation: a 3-word quoted span hits, a 2-word span does not', () => {
  const d = isoDate(2026, 5, 6);
  const written = writtenDate();
  const repo = makeRepo({
    'docs/changelog.md': [`- ${d} the owner said "keep it short"`, `- ${d} the owner said "keep short"`].join('\n'),
    'docs/written.md': `On ${written} the owner said \u201cship it today\u201d.\n`,
    'docs/written-two.md': `On ${written} the owner said "ship it".\n`,
  });
  const res = scan(repo);
  assert.deepStrictEqual(hitsFor(res, 'docs/changelog.md'), ['docs/changelog.md:1 date-quote']);
  assert.ok(hasHit(res, 'docs/written.md', 'date-quote'));
  assert.deepStrictEqual(hitsFor(res, 'docs/written-two.md'), []);
});

// ---------- names and manifests ----------

test('manifest name, author and owner fields must be the maintainer label or a canonical name', () => {
  const good = makeRepo({
    'src/core/.claude-plugin/plugin.json': coreManifest('zqkit'),
    'src/search/.claude-plugin/plugin.json': JSON.stringify({ name: 'zqkit-search', author: { name: LABEL } }),
    '.claude-plugin/marketplace.json': JSON.stringify({
      name: 'zqkit', owner: { name: LABEL },
      plugins: [{ name: 'zqkit', source: './src/core' }, { name: 'zqkit-search', source: './src/search' }],
    }, null, 2),
  });
  const ok = scan(good);
  assert.strictEqual(ok.code, 0, ok.out);

  const bad = makeRepo({
    'src/core/.claude-plugin/plugin.json': coreManifest('zqkit'),
    '.claude-plugin/marketplace.json': JSON.stringify({
      name: 'zqkit', owner: { name: ['Zq', 'Tester'].join(' ') },
      plugins: [{ name: 'zqkit', source: './src/core', author: 'someone else' }],
    }, null, 2),
  });
  const res = scan(bad);
  assert.strictEqual(res.code, 1);
  assert.strictEqual(hitsFor(res, '.claude-plugin/marketplace.json').filter((l) => l.endsWith(' manifest-field')).length, 2, res.out);
});

test('reserved words in plugin, skill, server and tool names fail', () => {
  const reserved = REAL_RULES.names.reserved_words;
  const repo = makeRepo({
    'src/core/.claude-plugin/plugin.json': coreManifest('zqkit'),
    'src/search/.claude-plugin/plugin.json': JSON.stringify({ name: `zq-${reserved[0]}-kit`, author: { name: LABEL } }, null, 2),
    'src/search/.mcp.json': JSON.stringify({ mcpServers: { [`${reserved[0]}-srv`]: { command: 'node' } } }, null, 2),
    [`src/core/skills/zq-${reserved[1]}-helper/SKILL.md`]: '---\ndescription: x\n---\nbody\n',
    'src/core/skills/zq-plain/SKILL.md': `---\nname: zq-${reserved[1]}\n---\nbody\n`,
    'src/search/server/server.cjs': `const tools = [{ name: '${reserved[0]}_find' }];\n`,
  });
  const res = scan(repo);
  assert.ok(hasHit(res, 'src/search/.claude-plugin/plugin.json', 'reserved-name'), res.out);
  assert.ok(hasHit(res, 'src/search/.mcp.json', 'reserved-name'), res.out);
  assert.ok(hasHit(res, `src/core/skills/zq-${reserved[1]}-helper/SKILL.md`, 'reserved-name'), res.out);
  assert.ok(hasHit(res, 'src/core/skills/zq-plain/SKILL.md', 'reserved-name'), res.out);
  assert.ok(hasHit(res, 'src/search/server/server.cjs', 'reserved-name'), res.out);
});

test('"official" or "for Claude" in a name fails; in plain prose it passes', () => {
  const repo = makeRepo({
    'src/core/.claude-plugin/plugin.json': coreManifest('zqkit'),
    'src/search/.mcp.json': JSON.stringify({ mcpServers: { 'official-zq': { command: 'node' } } }, null, 2),
    'src/core/skills/zq-x/SKILL.md': `---\nname: zq-for-${'claude'}\n---\nbody\n`,
    'docs/a.md': '# Zq\n\n## Official setup\n',
    'docs/b.md': `# Zq kit for ${'Claude'} Code\n`,
    'docs/ok.md': `# Zq\n\n## Setup for ${'Claude'} Code users\n\nThis is not an official project.\n`,
  });
  const res = scan(repo);
  assert.ok(hasHit(res, 'src/search/.mcp.json', 'official-name'), res.out);
  assert.ok(hasHit(res, 'src/core/skills/zq-x/SKILL.md', 'official-name'), res.out);
  assert.ok(hasHit(res, 'docs/a.md', 'official-name'), res.out);
  assert.ok(hasHit(res, 'docs/b.md', 'official-name'), res.out);
  assert.deepStrictEqual(hitsFor(res, 'docs/ok.md'), []);
});

// ---------- copyright line ----------

test('copyright line: once in LICENSE passes, twice fails, THIRD-PARTY-NOTICES passes, elsewhere fails', () => {
  const line = copyrightLine('Zq Tester');
  const once = scan(makeRepo({ LICENSE: `MIT\n${line}\n`, 'THIRD-PARTY-NOTICES': `${line}\n` }));
  assert.strictEqual(once.code, 0, once.out);
  const twice = scan(makeRepo({ LICENSE: `MIT\n${line}\n${line}\n` }));
  assert.ok(hasHit(twice, 'LICENSE', 'copyright-line'));
  const elsewhere = scan(makeRepo({ LICENSE: `MIT\n${line}\n`, 'README.md': `${line}\n` }));
  assert.ok(hasHit(elsewhere, 'README.md', 'copyright-line'));
  assert.deepStrictEqual(hitsFor(elsewhere, 'LICENSE'), []);
});

// ---------- allow-lists ----------

test('allow-lists: an allow-listed install slug and address pass; the shipped install list holds the one host slug (this repo, its own name), the email list stays empty', () => {
  const slugs = REAL_RULES.host_handle.install_slug_allow;
  assert.strictEqual(slugs.length, 1);
  const [owner, repo] = slugs[0].split('/');
  assert.ok(/^[a-z0-9-]+$/.test(owner) && !REAL_RULES.host_handle.owner_placeholders.includes(owner), 'a real owner, not a placeholder');
  assert.strictEqual(repo, JSON.parse(fs.readFileSync(path.join(REPO_TOP, 'src', 'core', '.claude-plugin', 'plugin.json'), 'utf8')).name, 'the repo is named after the product');
  assert.deepStrictEqual(REAL_RULES.email.allow, []);
  const files = {
    'README.md': [codeHostUrl('zqtester', 'zqrepo'), installLine('zqtester/zqrepo'), fakeEmail()].join('\n'),
  };
  const blocked = scan(makeRepo(files));
  assert.ok(hasHit(blocked, 'README.md', 'host-handle'));
  assert.ok(hasHit(blocked, 'README.md', 'email'));
  const rules = baseRules();
  rules.host_handle.install_slug_allow = ['zqtester/zqrepo'];
  rules.email.allow = [fakeEmail()];
  const allowed = scan(makeRepo(files, { rules }));
  assert.strictEqual(allowed.code, 0, allowed.out);
});

// ---------- exemptions ----------

test('exemptions: per file and rule, hit limit enforced, stale one fails and is named', () => {
  const phrase = savingsPhrase();
  const rules = baseRules();
  rules.exemptions = [{ file: 'README.md', rule: 'savings-phrase', reason: 'test reason long enough', max_hits: 1 }];
  const within = scan(makeRepo({ 'README.md': `${phrase}\n` }, { rules }));
  assert.strictEqual(within.code, 0, within.out);

  const over = scan(makeRepo({ 'README.md': `${phrase}\n${phrase}\n` }, { rules }));
  assert.strictEqual(over.code, 1);
  assert.match(over.out, /README\.md:0 max-hits-exceeded exemption=1 rule=savings-phrase/);
  assert.ok(hasHit(over, 'README.md', 'savings-phrase'));

  const otherRule = scan(makeRepo({ 'README.md': `${phrase}\n${fakeEmail()}\n` }, { rules }));
  assert.ok(hasHit(otherRule, 'README.md', 'email'), 'an exemption covers its own rule only');

  const stale = scan(makeRepo({ 'README.md': 'clean\n' }, { rules }));
  assert.strictEqual(stale.code, 1);
  assert.match(stale.out, /stale-exemption exemption=1 file=README\.md rule=savings-phrase/);

  const globRules = baseRules();
  globRules.exemptions = [{ file: 'docs/design/*.md', rule: 'savings-phrase', reason: 'test reason long enough', max_hits: 1 }];
  const glob = scan(makeRepo({ 'docs/design/a.md': `${phrase}\n`, 'docs/other.md': `${phrase}\n` }, { rules: globRules }));
  assert.deepStrictEqual(hitsFor(glob, 'docs/design/a.md'), []);
  assert.ok(hasHit(glob, 'docs/other.md', 'savings-phrase'));
});

test('folder-wide test exemptions are refused; the shipped rules hold none for tests/', () => {
  for (const file of ['tests/', 'tests/*.cjs', 'tests/core/*']) {
    const rules = baseRules();
    rules.exemptions = [{ file, rule: 'iso-date', reason: 'test reason long enough', max_hits: 1 }];
    const res = scan(makeRepo({ 'a.md': 'x\n' }, { rules }));
    assert.strictEqual(res.code, 1);
    assert.match(res.out, /rules file invalid/);
  }
  for (const ex of REAL_RULES.exemptions) {
    assert.ok(!ex.file.startsWith('tests/'), `shipped exemption for ${ex.file}`);
    assert.ok(typeof ex.reason === 'string' && ex.reason.length >= 10);
    assert.ok(Number.isInteger(ex.max_hits) && ex.max_hits >= 1);
  }
});

// ---------- scope ----------

test('scope works before the first commit: new files are scanned, gitignored files are not', () => {
  const repo = makeRepo({ 'new.md': `${fakeEmail()}\n`, 'skip.md': `${fakeEmail()}\n` }, { ignore: ['skip.md'] });
  const res = scan(repo);
  assert.ok(hasHit(res, 'new.md', 'email'));
  assert.deepStrictEqual(hitsFor(res, 'skip.md'), []);
});

test('scope: tracked, staged and new-not-ignored files are scanned', () => {
  const repo = makeRepo({ 'tracked.md': `${fakeEmail()}\n` }, { ignore: ['skip.md'] });
  commitAll(repo);
  writeFile(repo.dir, 'staged.md', `${fakeEmail()}\n`);
  git(repo, ['add', 'staged.md']);
  writeFile(repo.dir, 'new.md', `${fakeEmail()}\n`);
  writeFile(repo.dir, 'skip.md', `${fakeEmail()}\n`);
  const res = scan(repo);
  for (const f of ['tracked.md', 'staged.md', 'new.md']) assert.ok(hasHit(res, f, 'email'), `${f}\n${res.out}`);
  assert.deepStrictEqual(hitsFor(res, 'skip.md'), []);
});

test('no git available: the scan fails loudly, not a pass', () => {
  const repo = makeRepo({ 'a.md': 'clean\n' });
  const emptyBin = path.join(repo.dir, 'sandbox', 'empty-bin');
  fs.mkdirSync(emptyBin, { recursive: true });
  const env = { ...repo.env };
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
  env.PATH = emptyBin;
  const r = spawnSync(process.execPath, [SCRIPT, '--rules', repo.rules], { cwd: repo.dir, env, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /scrub public: FAIL \(git not available/);
  assert.doesNotMatch(r.stdout, /PASS/);
});

test('an unreadable file is counted failed, the rest are still scanned, and the summary gives the counts', () => {
  const repo = makeRepo({ 'a.md': 'clean\n', 'b.md': `${fakeEmail()}\n`, 'c.md': 'clean\n' });
  const res = scan(repo, [], { SCRUB_TEST_UNREADABLE: 'a.md' });
  assert.strictEqual(res.code, 1);
  assert.ok(res.lines.includes('a.md:0 read-failed'), res.out);
  assert.ok(hasHit(res, 'b.md', 'email'));
  assert.match(res.out, /scrub files: succeeded \d+, failed 1, skipped 0/);
});

test('a clean repo passes with the PASS summary line', () => {
  const res = scan(makeRepo({ 'README.md': '# Zq\n\nPlain words.\n' }));
  assert.strictEqual(res.code, 0, res.out);
  assert.match(res.out, /^scrub public: PASS \(\d+ files\)$/m);
});

// ---------- private layer ----------

function privateRepo(files, denyLines) {
  const repo = makeRepo(files);
  const deny = path.join(repo.dir, 'sandbox', 'deny.txt');
  if (denyLines) fs.writeFileSync(deny, denyLines.join('\n'));
  return { repo, deny };
}

test('--private with the variable unset fails "deny-list not configured", and both layers run', () => {
  const { repo } = privateRepo({ 'a.md': 'clean\n' }, null);
  const res = scan(repo, ['--private']);
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /scrub public: PASS/);
  assert.match(res.out, /scrub private: FAIL \(deny-list not configured\)/);
});

test('--private with the variable set but the file missing fails', () => {
  const { repo, deny } = privateRepo({ 'a.md': 'clean\n' }, null);
  const res = scan(repo, ['--private'], { SCRUB_DENYLIST: deny });
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /scrub private: FAIL \(deny-list file missing\)/);
});

test('--private refuses a deny-list outside sandbox/', () => {
  const { repo } = privateRepo({ 'a.md': 'clean\n' }, null);
  const elsewhere = makeTempDir('scrub-deny');
  made.push(elsewhere);
  const file = path.join(elsewhere, 'deny.txt');
  fs.writeFileSync(file, 'zq\n');
  const res = scan(repo, ['--private'], { SCRUB_DENYLIST: file });
  assert.strictEqual(res.code, 1);
  assert.match(res.out, /scrub private: FAIL \(deny-list must sit inside sandbox\/\)/);
});

test('deny-list terms match case-insensitively as whole words or phrases, literally, never as a regex', () => {
  const term = ['zor', 'blax'].join('');
  const dotted = ['q', 'z'].join('.');
  const phrase = ['blue', 'heron'].join(' ');
  const { repo, deny } = privateRepo({
    'no.md': `${term}y and pre${term} and qaz and blue  heron\n`,
    'yes1.md': `Hello ${term.toUpperCase()}.\n`,
    'yes2.md': `x ${dotted} y\n`,
    'yes3.md': `the Blue Heron flies\n`,
  }, ['# comment line', '', term, dotted, phrase]);
  const res = scan(repo, ['--private'], { SCRUB_DENYLIST: deny });
  assert.strictEqual(res.code, 1);
  assert.deepStrictEqual(hitsFor(res, 'no.md'), []);
  assert.ok(res.lines.includes('yes1.md:1 private-term-1'), res.out);
  assert.ok(res.lines.includes('yes2.md:1 private-term-2'), res.out);
  assert.ok(res.lines.includes('yes3.md:1 private-term-3'), res.out);
  assert.match(res.out, /scrub public: PASS/);
  assert.match(res.out, /scrub private: FAIL \(3 hits\)/);
});

test('a deny-list term passes only inside the one LICENSE copyright line, and output never holds the term', () => {
  const term = ['zor', 'blax'].join('');
  const holder = `Zq ${term[0].toUpperCase()}${term.slice(1)}`;
  const ok = privateRepo({ LICENSE: `MIT\n${copyrightLine(holder)}\n` }, [term]);
  const pass = scan(ok.repo, ['--private'], { SCRUB_DENYLIST: ok.deny });
  assert.strictEqual(pass.code, 0, pass.out);
  assert.match(pass.out, /scrub private: PASS/);

  const bad = privateRepo({
    LICENSE: `MIT by ${term}\n${copyrightLine(holder)}\n`,
    'README.md': `${copyrightLine(holder)}\n`,
    // A path holding the term, with a public hit too: neither layer prints the path.
    [`notes/${term}-notes.md`]: `${fakeEmail()}\n`,
  }, [term]);
  const fail = scan(bad.repo, ['--private'], { SCRUB_DENYLIST: bad.deny });
  assert.strictEqual(fail.code, 1);
  assert.ok(fail.lines.includes('LICENSE:1 private-term-1'), fail.out);
  assert.ok(!fail.lines.includes('LICENSE:2 private-term-1'), fail.out);
  assert.ok(fail.lines.includes('README.md:1 private-term-1'), fail.out);
  assert.match(fail.out, /\[path withheld: file \d+ of \d+\]:0 private-term-1-in-path/);
  assert.ok(!fail.out.toLowerCase().includes(term), 'output must never contain the private term');
  assert.ok(!pass.out.toLowerCase().includes(term));
});

// ---------- the install slug in the private layer (13.1, settled at publish) ----------

// A synthetic owner account whose name holds the synthetic holder's surname inside one word,
// as the real one does. Both are deny-list terms; the slug is on both allow lists.
const SLUG_OWNER = ['zq', 'zorblax'].join('');
const SURNAME = ['zor', 'blax'].join('');
const SLUG = `${SLUG_OWNER}/zqrepo`;

function slugRules(list = [SLUG]) {
  const rules = baseRules();
  rules.host_handle.install_slug_allow = list;
  return rules;
}

function slugRepo(files, { rules = slugRules(), allowLines = [`allow-slug: ${SLUG}`] } = {}) {
  const repo = makeRepo(files, { rules });
  const deny = path.join(repo.dir, 'sandbox', 'deny.txt');
  fs.writeFileSync(deny, ['# terms', SLUG_OWNER, SURNAME, ...allowLines].join('\n') + '\n');
  return { repo, deny };
}

const SLUG_OK = {
  'README.md': [
    `${installLine(SLUG)}#v1.0.0`,
    `claude plugin install zqkit --marketplace ${SLUG}`,
    codeHostUrl(SLUG_OWNER, 'zqrepo'),
    `${codeHostUrl(SLUG_OWNER, 'zqrepo')}.git`,
  ].join('\n') + '\n',
  'p/.claude-plugin/plugin.json': JSON.stringify({ name: 'zqkit', author: { name: LABEL }, repository: codeHostUrl(SLUG_OWNER, 'zqrepo'), homepage: codeHostUrl(SLUG_OWNER, 'zqrepo') }, null, 2) + '\n',
  '.github/CODEOWNERS': `src/** @${SLUG_OWNER}\nscripts/** @${SLUG_OWNER} # the one owner\n`,
  'scripts/scrub-rules.json': `{\n  "host_handle": {\n    "install_slug_allow": ["${SLUG}"]\n  }\n}\n`,
  'src/core/.claude-plugin/plugin.json': coreManifest(),
};

test('13.1 private layer: the install slug on both allow lists passes in install lines, host web addresses (with .git), CODEOWNERS owner entries and the rules file\'s allow line; output never holds a term', () => {
  const { repo, deny } = slugRepo(SLUG_OK);
  const res = scan(repo, ['--private'], { SCRUB_DENYLIST: deny });
  assert.strictEqual(res.code, 0, res.out);
  assert.match(res.out, /scrub public: PASS/);
  assert.match(res.out, /scrub private: PASS/);
  assert.ok(!res.out.toLowerCase().includes(SURNAME));
});

test('13.1 private layer: the bare account name, the account in another slug or a comment, and the holder\'s surname anywhere else still fail', () => {
  const cases = {
    'a.md': `maintained by ${SLUG_OWNER}\n`,
    'b.md': `ping @${SLUG_OWNER} for review\n`,
    'c.md': `${codeHostUrl(SLUG_OWNER, 'other')}\n`,
    'd.md': `${installLine(`${SLUG_OWNER}/other`)}\n`,
    'e.md': `see ${SLUG} for more\n`,
    'f.md': `Zq ${SURNAME[0].toUpperCase()}${SURNAME.slice(1)} wrote this\n`,
    'g.md': `${installLine(SLUG)} by ${SLUG_OWNER}\n`,
    'scripts/other.json': `{ "install_slug_allow": ["${SLUG}"] }\n`,
    '.github/CODEOWNERS': `# owner: @${SLUG_OWNER}\n@${SLUG_OWNER}/x/** @${SLUG_OWNER}\n`,
  };
  const { repo, deny } = slugRepo(cases);
  const res = scan(repo, ['--private'], { SCRUB_DENYLIST: deny });
  assert.strictEqual(res.code, 1);
  for (const f of ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'g.md', 'scripts/other.json']) {
    assert.ok(res.lines.includes(`${f}:1 private-term-1`), `${f}\n${res.out}`);
  }
  assert.ok(res.lines.includes('f.md:1 private-term-2'), res.out);
  assert.ok(res.lines.includes('.github/CODEOWNERS:1 private-term-1'), 'a comment line: ' + res.out);
  assert.ok(res.lines.includes('.github/CODEOWNERS:2 private-term-1'), 'the path pattern: ' + res.out);
  assert.ok(!res.out.toLowerCase().includes(SURNAME), 'output must never contain a private term');
});

test('13.1 private layer: a slug on only one of the two lists is not allowed (neither file alone lets a term through)', () => {
  const onlyPublic = slugRepo(SLUG_OK, { allowLines: [] });
  const a = scan(onlyPublic.repo, ['--private'], { SCRUB_DENYLIST: onlyPublic.deny });
  assert.strictEqual(a.code, 1);
  assert.ok(a.lines.includes('README.md:1 private-term-1'), a.out);
  assert.match(a.out, /scrub public: PASS/);
  const onlyPrivate = slugRepo(SLUG_OK, { rules: slugRules([]) });
  const b = scan(onlyPrivate.repo, ['--private'], { SCRUB_DENYLIST: onlyPrivate.deny });
  assert.strictEqual(b.code, 1);
  assert.ok(b.lines.includes('README.md:1 private-term-1'), b.out);
  assert.ok(hasHit(b, 'README.md', 'host-handle'), 'the public layer fails it too');
  // An allow line is not a term, and a malformed one is a plain term (it never allows anything).
  const odd = slugRepo(SLUG_OK, { allowLines: [`allow-slug ${SLUG}`] });
  const c = scan(odd.repo, ['--private'], { SCRUB_DENYLIST: odd.deny });
  assert.strictEqual(c.code, 1);
  assert.ok(c.lines.includes('README.md:1 private-term-1'), c.out);
});

test('13.1 private layer through scanContent (the egress scan path): the same allowed places and the same failures', async () => {
  const { pathToFileURL } = require('node:url');
  const mod = await import(pathToFileURL(SCRIPT).href);
  const dir = makeTempDir('scrub-slug');
  made.push(dir);
  const rulesFile = path.join(dir, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify(slugRules(), null, 2));
  const deny = path.join(dir, 'deny.txt');
  fs.writeFileSync(deny, [SLUG_OWNER, SURNAME, `allow-slug: ${SLUG}`].join('\n') + '\n');
  const both = ['public', 'private'];
  const rulesOf = (p, text, kind = 'file') => mod.scanContent({ path: p, text, kind, layers: both, denylistPath: deny, rulesPath: rulesFile }).map((h) => h.rule);
  assert.deepStrictEqual(rulesOf('README.md', `${installLine(SLUG)}#v1.0.0`), []);
  assert.deepStrictEqual(rulesOf('x.json', `"repository": "${codeHostUrl(SLUG_OWNER, 'zqrepo')}"`), []);
  assert.deepStrictEqual(rulesOf('.github/CODEOWNERS', `src/** @${SLUG_OWNER}`), []);
  assert.deepStrictEqual(rulesOf('a.md', `by ${SLUG_OWNER}`), ['private-term-1']);
  assert.deepStrictEqual(rulesOf('a.md', `by ${SURNAME}`), ['private-term-2']);
  assert.deepStrictEqual(rulesOf(null, `fill the install line with ${SLUG_OWNER}`, 'message'), ['private-term-1']);
  assert.deepStrictEqual(rulesOf(null, `${SLUG_OWNER}-branch`, 'ref'), ['private-term-1']);
});

// ---------- scanContent (used by the egress scan) ----------

test('scanContent: import runs no command line; returns rule ids only; exemptions by path; both layers', async () => {
  const { pathToFileURL } = require('node:url');
  const before = process.exitCode;
  const mod = await import(pathToFileURL(SCRIPT).href);
  assert.strictEqual(process.exitCode, before, 'importing must not run the command line');
  assert.strictEqual(typeof mod.scanContent, 'function');

  const addr = fakeEmail();
  const msg = mod.scanContent({ path: null, text: `contact ${addr}`, kind: 'message', layers: ['public'] });
  assert.deepStrictEqual(msg, [{ rule: 'email' }]);
  assert.ok(!JSON.stringify(msg).includes(addr), 'no matched value is returned');

  assert.deepStrictEqual(mod.scanContent({ path: `docs/${isoDate(2026, 2, 3)}.md`, text: `docs/${isoDate(2026, 2, 3)}.md`, kind: 'path', layers: ['public'] }),
    [{ rule: 'iso-date' }]);

  // The shipped exemption for CLAUDE.md allows one savings hit, by path.
  const phrase = savingsPhrase();
  assert.deepStrictEqual(mod.scanContent({ path: 'CLAUDE.md', text: phrase, kind: 'file', layers: ['public'] }), []);
  assert.deepStrictEqual(mod.scanContent({ path: 'other.md', text: phrase, kind: 'file', layers: ['public'] }), [{ rule: 'savings-phrase' }]);
  const over = mod.scanContent({ path: 'CLAUDE.md', text: `${phrase}\n${phrase}`, kind: 'file', layers: ['public'] });
  assert.ok(over.some((h) => h.rule === 'savings-phrase') && over.some((h) => h.rule === 'max-hits-exceeded'));

  const dir = makeTempDir('scrub-content');
  made.push(dir);
  const term = ['zor', 'blax'].join('');
  const deny = path.join(dir, 'deny.txt');
  fs.writeFileSync(deny, `# terms\n${term}\n`);
  const both = ['public', 'private'];
  const hit = mod.scanContent({ path: 'a.md', text: `by ${term}`, kind: 'file', layers: both, denylistPath: deny });
  assert.deepStrictEqual(hit, [{ rule: 'private-term-1' }]);
  assert.ok(!JSON.stringify(hit).toLowerCase().includes(term));
  assert.deepStrictEqual(mod.scanContent({ path: null, text: `${term}-branch`, kind: 'ref', layers: both, denylistPath: deny }), [{ rule: 'private-term-1' }]);
  assert.deepStrictEqual(mod.scanContent({ path: 'LICENSE', text: `MIT\n${copyrightLine(`Zq ${term}`)}\n`, kind: 'file', layers: both, denylistPath: deny }), []);
  assert.throws(() => mod.scanContent({ path: null, text: 'x', kind: 'message', layers: both, env: {} }), /deny-list not configured/);
});

// ---------- placeholders: whole shapes only (spec SR-13 b2, same shapes as the search scan) ----------

test('placeholders: a value that only starts like a placeholder still hits (setting, connection string, signed URL)', async () => {
  const { pathToFileURL } = require('node:url');
  const mod = await import(pathToFileURL(SCRIPT).href);
  const rulesOf = (text) => mod.scanContent({ path: 'p/x.txt', text, kind: 'file', layers: ['public'] }).map((h) => h.rule);
  for (const value of F.placeholderLookalikes()) {
    assert.ok(rulesOf(F.settingWith(value)).includes('secret-setting'), `setting value led by ${value[0]} should hit`);
    assert.ok(rulesOf(F.connWith(value)).includes('secret-conn-string'), `conn password led by ${value[0]} should hit`);
    assert.ok(rulesOf(F.signedWith(value)).includes('secret-signed-url'), `signed value led by ${value[0]} should hit`);
  }
  // An exempt match never hides a later real one on the same line.
  const real = F.placeholderLookalikes()[0];
  const shape = F.placeholderValues()[1];
  assert.ok(rulesOf(`${F.connWith(shape)} ${F.connWith(real)}`).includes('secret-conn-string'));
  assert.ok(rulesOf(`${F.settingWith(shape)} ${F.settingWith(real)}`).includes('secret-setting'));
  // A shape with more text after it is not whole.
  assert.ok(rulesOf(F.settingWith(`${shape}${F.gen(8, 4)}`)).includes('secret-setting'));
});

test('placeholders: each whole placeholder shape stays exempt (setting, connection string, signed URL)', async () => {
  const { pathToFileURL } = require('node:url');
  const mod = await import(pathToFileURL(SCRIPT).href);
  const secretRules = (text) => mod.scanContent({ path: 'p/x.txt', text, kind: 'file', layers: ['public'] })
    .map((h) => h.rule).filter((r) => r.startsWith('secret-'));
  for (const value of F.placeholderValues()) {
    assert.deepStrictEqual(secretRules(F.settingWith(value)), [], `setting ${value}`);
    assert.deepStrictEqual(secretRules(`${F.settingWith(value)}.`), [], `setting ${value} with closing punctuation`);
    assert.deepStrictEqual(secretRules(F.connWith(value)), [], `conn ${value}`);
    assert.deepStrictEqual(secretRules(F.signedWith(value)), [], `signed ${value}`);
  }
  // A shape that holds a space may run past the value.
  assert.deepStrictEqual(secretRules(F.settingWith('<your db password>')), []);
});

test('a 40,000-character line scans in bounded time (secret-setting label is length-capped)', async () => {
  const { pathToFileURL } = require('node:url');
  const mod = await import(pathToFileURL(SCRIPT).href);
  const word = ['PASS', 'WORD'].join('');
  const LIMIT_MS = 500; // an engineering limit for one line, not a speed claim
  const lines = {
    'label-shaped': ('_' + word).repeat(Math.ceil(40000 / (word.length + 1))).slice(0, 40000),
    underscores: '_'.repeat(40000),
    'long line ending in a real setting': `${'_'.repeat(40000)} ${F.secretSetting()}`,
  };
  mod.scanContent({ path: 'p/warm.txt', text: 'warm up', kind: 'file', layers: ['public'] });
  for (const [label, text] of Object.entries(lines)) {
    assert.ok(text.length >= 40000, label);
    const t0 = process.hrtime.bigint();
    const hits = mod.scanContent({ path: 'p/long.txt', text, kind: 'file', layers: ['public'] });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < LIMIT_MS, `${label}: took ${Math.round(ms)} ms, limit ${LIMIT_MS} ms`);
    if (label.startsWith('long line')) assert.ok(hits.some((h) => h.rule === 'secret-setting'), 'the setting is still found');
  }
});

// ---------- the real repo ----------

test('the real repo: test source holds no scrub-shaped value (no hit under tests/, no test exemption)', () => {
  const sb = makeTempDir('scrub-real');
  made.push(sb);
  const gitcfg = path.join(sb, 'gitconfig');
  fs.writeFileSync(gitcfg, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gitcfg, GIT_CONFIG_NOSYSTEM: '1', TMP: sb, TEMP: sb, TMPDIR: sb };
  delete env.SCRUB_DENYLIST;
  delete env.SCRUB_TEST_UNREADABLE;
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_TOP, env, encoding: 'utf8', windowsHide: true });
  const testLines = r.stdout.split(/\r?\n/).filter((l) => l.startsWith('tests/'));
  assert.deepStrictEqual(testLines, []);
  assert.match(r.stdout, /scrub public: (PASS|FAIL)/);
});
