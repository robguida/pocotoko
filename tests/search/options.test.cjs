'use strict';
// Query options (spec 9.13): the synonym format `term=alt|alt`, both list arrival forms,
// limits and bad_synonym, one-way groups, multi-word alternatives within 8 positions,
// synonyms in the 20-term cap; matching and word_families reach the store and its status;
// live check 5 at the server (third logged-in probe): the list forms seen there, manifest
// defaults equal to code defaults, CLAUDE_PLUGIN_OPTION_* ignored, no seam marker left.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const I = require('../../src/search/server/index.cjs');
const R = require('../../src/search/server/rank.cjs');
const T = require('../../src/search/server/tokenize.cjs');
const Fl = require('../../src/search/server/floor.cjs');
const S = require('../../src/search/server/server.cjs');
const B = require('../../src/search/server/binder.cjs');
const { makeRun, openStore, cleanupRuns } = require('../helpers/search-run.cjs');
const { REPO_TOP, makeTempDir, removeDir } = require('../helpers/tmpdir-sandbox.cjs');

const tempDirs = [];
test.after(() => {
  cleanupRuns();
  for (const d of tempDirs) removeDir(d);
});

function chunk(key, path, text, heading = '') {
  return { key, path, heading, trail: heading, line: 1, date: null, flag: 'unmarked', successor: null, text };
}
function groupsOf(parsed) {
  return [...parsed.groups.entries()].map(([k, v]) => [k, v.map((a) => a.join(' '))]);
}
function broad(idx, s, synonyms) {
  return R.rank(idx, T.parseQuery(s), { matching: 'broad', k: 10, synonyms });
}
function filler(n, start = 0) {
  const out = [];
  for (let i = 0; i < n; i++) out.push('n' + String(start + i).padStart(2, '0'));
  return out.join(' ');
}

test('both arrival forms give the same groups: an array, and one string joined by commas or new lines', () => {
  const list = ['deploy=ship|release', 'undo=roll back', 'ci=continuous integration'];
  const a = R.parseSynonyms(list);
  const b = R.parseSynonyms(list.join(','));
  const c = R.parseSynonyms(list.join('\n'));
  const d = R.parseSynonyms(list.join('\r\n'));
  const e = R.parseSynonyms(JSON.stringify(list)); // a JSON-array text, stored as written (live check 5)
  const want = [['deploy', ['ship', 'release']], ['undo', ['roll back']], ['ci', ['continuous integration']]];
  for (const p of [a, b, c, d, e]) {
    assert.deepEqual(groupsOf(p), want);
    assert.equal(p.bad, 0);
  }
  assert.equal(a.maxTermWords, 1);
});

test('never set → no groups and no bad entries', () => {
  for (const raw of [undefined, null, '', '   ', '$' + '{user_config.synonyms}', []]) {
    const p = R.parseSynonyms(raw);
    assert.equal(p.groups.size, 0);
    assert.equal(p.bad, 0);
  }
});

test('1 to 3 words per term and per alternative; words are lower-cased by the word rules', () => {
  const p = R.parseSynonyms(['Pay Run=Payroll', 'one two three=alpha beta gamma', 'one two three four=x1', 'deploy=one two three four']);
  assert.deepEqual(groupsOf(p), [['pay run', ['payroll']], ['one two three', ['alpha beta gamma']]]);
  assert.equal(p.bad, 2);
  assert.equal(p.maxTermWords, 3);
});

test('bad_synonym is counted for: no =, an empty side, a word of 41 characters, 11 alternatives, the 501st entry', () => {
  const long = 'w'.repeat(41);
  const ok40 = 'w'.repeat(40);
  const alts = (n) => Array.from({ length: n }, (_, i) => 'alt' + String.fromCharCode(97 + i)).join('|');
  const cases = [
    ['no equals sign', 0],
    ['=alpha', 0],
    ['alpha=', 0],
    ['alpha=beta||gamma', 0],
    [`alpha=${long}`, 0],
    [`${long}=alpha`, 0],
    [`alpha=${alts(11)}`, 0],
    ['alpha=beta=gamma', 0],
    ['alpha=be-ta', 0], // a mark inside a word
    ['alpha  beta=gamma', 0], // two spaces
    ['the=of', 0], // every word is a stop word
  ];
  for (const [entry] of cases) {
    const p = R.parseSynonyms([entry]);
    assert.equal(p.bad, 1, entry);
    assert.equal(p.groups.size, 0, entry);
  }
  assert.equal(R.parseSynonyms([`alpha=${ok40}`]).bad, 0);
  assert.equal(R.parseSynonyms([`alpha=${alts(10)}`]).bad, 0);
  const many = [];
  for (let i = 0; i < 501; i++) many.push(`term${i}=alt${i}`);
  const p = R.parseSynonyms(many);
  assert.equal(p.groups.size, 500);
  assert.equal(p.bad, 1);
  assert.ok(!p.groups.has('term500'));
  // A non-string entry in an array is counted, and the others are still read.
  const mixed = R.parseSynonyms(['alpha=beta', 5, 'gamma=delta']);
  assert.equal(mixed.bad, 1);
  assert.equal(mixed.groups.size, 2);
});

test('a comma inside an entry splits it (a valid entry holds no comma)', () => {
  const p = R.parseSynonyms('deploy=ship,release');
  assert.deepEqual(groupsOf(p), [['deploy', ['ship']]]);
  assert.equal(p.bad, 1); // `release` has no `=`
});

test('repeated terms merge; an alternative equal to its term is dropped', () => {
  const p = R.parseSynonyms(['deploy=ship', 'deploy=ship|launch', 'deploy=deploy']);
  assert.deepEqual(groupsOf(p), [['deploy', ['ship', 'launch']]]);
});

test('one-way: a query for the term finds the alternative, not the reverse', () => {
  const idx = I.fromChunks([chunk('rb', 'a.md', 'rollback steps here'), chunk('ud', 'b.md', 'undo words here')]);
  const syn = R.parseSynonyms(['undo=rollback']);
  const r = broad(idx, 'undo', syn);
  assert.deepEqual(r.results.map((x) => x.key).sort(), ['rb', 'ud']);
  assert.deepEqual(r.results.find((x) => x.key === 'rb').matched_by, ['synonym']);
  assert.deepEqual(r.results.find((x) => x.key === 'ud').matched_by, ['exact']);
  const rev = broad(idx, 'rollback', syn);
  assert.deepEqual(rev.results.map((x) => x.key), ['rb']);
  // The raw option works too (parsed inside rank).
  assert.equal(broad(idx, 'undo', ['undo=rollback']).results.length, 2);
  // Exact level: synonyms are not used.
  assert.equal(R.rank(idx, T.parseQuery('undo'), { matching: 'exact', synonyms: syn }).results.length, 1);
});

test('a multi-word alternative matches only when its words fall within 8 positions', () => {
  const idx = I.fromChunks([
    chunk('near', 'a.md', 'roll the change back now'),
    chunk('edge', 'b.md', ['roll', filler(6), 'back'].join(' ')), // span 8
    chunk('far', 'c.md', ['roll', filler(7), 'back'].join(' ')), // span 9
    chunk('half', 'd.md', 'roll only here'),
  ]);
  const syn = R.parseSynonyms(['revert=roll back']);
  const r = broad(idx, 'revert', syn);
  assert.deepEqual(r.results.map((x) => x.key).sort(), ['edge', 'near']);
  for (const res of r.results) assert.deepEqual(res.matched_by, ['synonym']);
});

test('a multi-word term matches consecutive query words; its alternatives count as matching every term word', () => {
  const idx = I.fromChunks([chunk('pr', 'a.md', 'payroll closes monthly'), chunk('other', 'b.md', 'pay attention here')]);
  const syn = R.parseSynonyms(['pay run=payroll']);
  const r = broad(idx, 'pay run', syn);
  const pr = r.results.find((x) => x.key === 'pr');
  assert.ok(pr);
  assert.deepEqual(pr.matched_by, ['synonym']);
  // Both query words count as matched, so the all-words bonus applies (and the words sit together).
  const stats = idx.stats();
  const base = R.termScores(idx, 'payroll', { h: 2, b: 1, n: 1.5 }, stats).get(0) * R.SYNONYM_WEIGHT;
  assert.ok(Math.abs(pr.score - base * R.ALL_WORDS_BONUS * R.NEAR_BONUS) < 1e-9);
  // The words apart in the query do not form the term.
  assert.equal(broad(idx, 'run pay', syn).results.some((x) => x.key === 'pr'), false);
});

test('B6 review: a synonym already found by an earlier expansion still covers the other term words', () => {
  const idx = I.fromChunks([chunk('pr', 'a.md', 'payroll closes monthly'), chunk('other', 'b.md', 'pay attention here')]);
  const syn = R.parseSynonyms(['pay run=payroll']);
  // `pay*` finds `payroll` by the wildcard first; the synonym's cover of `run` must still apply.
  const r = broad(idx, 'pay* run', syn);
  const pr = r.results.find((x) => x.key === 'pr');
  assert.ok(pr);
  assert.deepEqual(pr.matched_by, ['prefix']);
  const base = R.termScores(idx, 'payroll', { h: 2, b: 1, n: 1.5 }, idx.stats()).get(0) * R.PREFIX_WEIGHT;
  assert.ok(Math.abs(pr.score - base * R.ALL_WORDS_BONUS * R.NEAR_BONUS) < 1e-9, `${pr.score} vs ${base * R.ALL_WORDS_BONUS * R.NEAR_BONUS}`);
  // The same when the earlier expansion is a family match (`payrolls` → `payroll`).
  const fam = broad(idx, 'payrolls run', R.parseSynonyms(['payrolls run=payroll']));
  const pf = fam.results.find((x) => x.key === 'pr');
  const fb = R.termScores(idx, 'payroll', { h: 2, b: 1, n: 1.5 }, idx.stats()).get(0) * R.FAMILY_WEIGHT;
  assert.deepEqual(pf.matched_by, ['family']);
  assert.ok(Math.abs(pf.score - fb * R.ALL_WORDS_BONUS * R.NEAR_BONUS) < 1e-9);
  // And when the alternative is the query word itself (exact).
  const ex = broad(idx, 'payroll run', R.parseSynonyms(['payroll run=payroll']));
  const pe = ex.results.find((x) => x.key === 'pr');
  const eb = R.termScores(idx, 'payroll', { h: 2, b: 1, n: 1.5 }, idx.stats()).get(0);
  assert.deepEqual(pe.matched_by, ['exact']);
  assert.ok(Math.abs(pe.score - eb * R.ALL_WORDS_BONUS * R.NEAR_BONUS) < 1e-9);
});

test('B6 review 2: covers of an already-found alternative still apply once the 20-term cap is hit', () => {
  const idx = I.fromChunks([chunk('pr', 'a.md', 'payroll closes monthly'), chunk('other', 'b.md', 'pay attention here')]);
  // Seven 3-word alternatives (21 terms: the 7th does not fit), then `payroll`, which `pay*` already found.
  const three = [];
  for (let i = 0; i < 7; i++) {
    const c = String.fromCharCode(97 + i);
    three.push(`zk${c}one zk${c}two zk${c}three`);
  }
  const syn = R.parseSynonyms(['pay run=' + three.join('|'), 'pay run=payroll']);
  assert.equal(syn.groups.get('pay run').length, 8);
  const ctx = { index: idx, wordFamilies: 'english', synonyms: R.synonymHits(T.parseQuery('pay* run').words, syn).get(0), over: () => false, notes: new Set(), partial: false };
  const ex = R.broadExpand(T.parseQuery('pay* run').words[0], ctx);
  assert.ok(ctx.notes.has(R.NOTES.EXPANSION_CAPPED));
  assert.deepEqual(ex.find((e) => e.term === 'payroll').covers, ['run']);
  const pr = broad(idx, 'pay* run', syn).results.find((x) => x.key === 'pr');
  assert.ok(pr);
  assert.deepEqual(pr.matched_by, ['prefix']);
  const base = R.termScores(idx, 'payroll', { h: 2, b: 1, n: 1.5 }, idx.stats()).get(0) * R.PREFIX_WEIGHT;
  assert.ok(Math.abs(pr.score - base * R.ALL_WORDS_BONUS * R.NEAR_BONUS) < 1e-9, `${pr.score} vs ${base * R.ALL_WORDS_BONUS * R.NEAR_BONUS}`);
});

test('synonym expansions count toward the 20-term cap', () => {
  const alts = [];
  for (let i = 0; i < 10; i++) alts.push('ship' + String.fromCharCode(97 + i));
  const more = [];
  for (let i = 0; i < 10; i++) more.push('send' + String.fromCharCode(97 + i) + ' word' + String.fromCharCode(97 + i));
  const syn = R.parseSynonyms(['deploy=' + alts.join('|'), 'deploy=' + more.join('|')]);
  const idx = I.fromChunks([chunk('x', 'a.md', alts.join(' ') + ' deployment deployer')]);
  const ctx = { index: idx, wordFamilies: 'english', synonyms: R.synonymHits(T.parseQuery('deploy').words, syn).get(0), over: () => false, notes: new Set(), partial: false };
  const ex = R.broadExpand({ w: 'deploy', wild: false }, ctx);
  const cost = ex.slice(1).reduce((n, e) => n + (e.terms ? e.terms.length : 1), 0);
  assert.equal(cost, 20); // 10 single alternatives + 5 two-word alternatives; no room left for prefixes
  assert.equal(ex.filter((e) => e.label === 'prefix').length, 0);
  assert.ok(ctx.notes.has(R.NOTES.EXPANSION_CAPPED));
});

test('store: the matching, word_families and synonyms options reach ranking; status shows the level and bad_synonym', async () => {
  const files = { 'a.md': '# Deploy\nwe deployed the build\n', 'b.md': 'rollback steps\n' };
  const run = makeRun('options', files);
  const dflt = openStore(run);
  await dflt.refresh();
  assert.equal(dflt.status().matching, 'broad');
  assert.equal(dflt.status().wordFamilies, 'english');
  assert.equal((await dflt.search('deploying')).results.length, 1);

  const exact = openStore(run, { options: { matching: 'exact' } });
  assert.equal(exact.status().matching, 'exact');
  assert.equal((await exact.search('deploying')).results.length, 0);
  // A call may still ask for the other level.
  assert.equal((await exact.search('deploying', { matching: 'broad' })).results.length, 1);

  const off = openStore(run, { options: { word_families: 'off', synonyms: 'undo=rollback,bad entry' } });
  assert.equal(off.status().wordFamilies, 'off');
  assert.equal(off.status().queryCounts.bad_synonym, 1);
  // Query options are not part of the index options hash: no rebuild notice on the
  // first search after opening the store (a later search would see a cleared notice anyway).
  const u = await off.search('undo');
  assert.equal(u.notice, null);
  assert.deepEqual(u.results.map((x) => x.path), ['b.md']);
  assert.deepEqual(u.results[0].matched_by, ['synonym']);
  assert.equal((await off.search('deploying')).results.length, 0);
  // Control: an index option (drop_contacts) does change the hash, and the first search says so.
  const idxOpt = openStore(run, { options: { drop_contacts: false } });
  const first = await idxOpt.search('undo');
  assert.ok(typeof first.notice === 'string' && first.notice.length > 0);
  assert.equal((await idxOpt.search('undo')).notice, null);
  // Status never shows a synonym value (totals only).
  assert.ok(!JSON.stringify(off.status()).includes('rollback'));
});

// ---------------------------------------------------------------------------
// Live check 5 at the server (third logged-in probe; spec 3.1 fact 7 f, 9.13). The two list
// forms the CLI stores reached a stdio server's env as the stored text exactly.

const LIVE_COMMA_LINE = 'alpha,beta gamma,delta';
const LIVE_JSON_TEXT = '["alpha","beta gamma","delta,eps"]';
const envOf = (key, value) => ({ [S.ENV_PREFIX + key.toUpperCase()]: value });

test('9.13 / live check 5 (server, third probe): the list forms seen at the server (a comma line, a JSON-array text) give the entries typed through server.optionsFromEnv for never_terms, never_folders, never_globs and synonyms', () => {
  const forms = [
    [LIVE_COMMA_LINE, ['alpha', 'beta gamma', 'delta']],
    [LIVE_JSON_TEXT, ['alpha', 'beta gamma', 'delta,eps']],
  ];
  // Every form is checked; the failures are collected and asserted once with the full list.
  const failures = [];
  for (const [arrived, typed] of forms) try {
    const env = {
      ...envOf('never_terms', arrived),
      ...envOf('never_folders', arrived),
      ...envOf('never_globs', arrived),
    };
    const opts = S.optionsFromEnv(env);
    assert.deepEqual(Object.keys(opts).sort(), ['never_folders', 'never_globs', 'never_terms'], arrived);
    const f = Fl.buildFilter(opts);
    assert.deepEqual(f.neverTerms, typed, 'never_terms: ' + arrived);
    assert.deepEqual([...f.neverFolders], typed, 'never_folders: ' + arrived);
    assert.equal(f.neverGlobs.length, typed.length, 'never_globs: ' + arrived);
    assert.deepEqual(f.counts, { bad_extra_type: 0, extra_type_refused: 0, bad_never_folder: 0, bad_never_glob: 0, bad_never_term: 0 });
    // The same effective filter as the entries given as a real array.
    const fromArray = Fl.buildFilter({ never_terms: typed, never_folders: typed, never_globs: typed });
    assert.equal(f.optionsHash, fromArray.optionsHash, 'same options hash as the typed entries: ' + arrived);
    // A never-term holding a space is one term: it hits that phrase only.
    assert.equal(Fl.termHit(f, 'notes on beta gamma here'), true);
    assert.equal(Fl.termHit(f, 'only gamma here'), false);
  } catch (err) {
    failures.push(arrived + ': ' + (err && err.message));
  }
  assert.deepEqual(failures, []);
  // A comma inside a JSON-array element stays one term.
  const j = Fl.buildFilter(S.optionsFromEnv(envOf('never_terms', LIVE_JSON_TEXT)));
  assert.equal(Fl.termHit(j, 'see delta,eps'), true);
  assert.equal(Fl.termHit(j, 'only eps here'), false);

  const synComma = 'deploy=ship|release,undo=roll back';
  const synJson = JSON.stringify(['deploy=ship|release', 'undo=roll back']);
  const synFailures = [];
  for (const arrived of [synComma, synJson]) try {
    const opts = S.optionsFromEnv(envOf('synonyms', arrived));
    const p = R.parseSynonyms(opts.synonyms);
    assert.deepEqual(groupsOf(p), [['deploy', ['ship', 'release']], ['undo', ['roll back']]], arrived);
    assert.equal(p.bad, 0);
    assert.deepEqual(groupsOf(R.queryOptions(opts).synonyms), groupsOf(p));
  } catch (err) {
    synFailures.push(arrived + ': ' + (err && err.message));
  }
  assert.deepEqual(synFailures, []);
});

test('9.13 / 9.1 e / live check 5 (server, third probe): projects in both list forms seen at the server enable exactly the listed real folders through binder.projectSwitch', () => {
  const base = fs.realpathSync.native(makeTempDir('options-live-projects'));
  tempDirs.push(base);
  const mk = (name) => {
    const p = path.join(base, name);
    fs.mkdirSync(p, { recursive: true });
    return fs.realpathSync.native(p);
  };
  const alpha = mk('alpha');
  const betaGamma = mk('beta gamma');
  const delta = mk('delta');
  const deltaEps = mk('delta,eps');
  const other = mk('other');
  const ctx = { platform: process.platform };

  // The comma line, as it arrived: every piece is an existing folder, the whole text is not.
  const commaLine = [alpha, betaGamma, delta].join(',');
  const c = S.optionsFromEnv(envOf('projects', commaLine)).projects;
  assert.equal(c, commaLine, 'passed on raw');
  // Every folder is checked; the failures are collected and asserted once with the full list.
  const commaFailures = [];
  for (const root of [alpha, betaGamma, delta]) try {
    const r = B.projectSwitch(root, c, ctx);
    assert.equal(r.enabled, true, 'comma line enables ' + path.basename(root));
    assert.equal(r.listRefused, false);
    assert.equal(r.bad, 0);
  } catch (err) {
    commaFailures.push(path.basename(root) + ': ' + (err && err.message));
  }
  assert.deepEqual(commaFailures, []);
  assert.equal(B.projectSwitch(other, c, ctx).enabled, false, 'a folder not listed stays off');

  // The JSON-array text, as it arrived: an element holding a comma is one folder.
  const jsonText = JSON.stringify([alpha, betaGamma, deltaEps]);
  const j = S.optionsFromEnv(envOf('projects', jsonText)).projects;
  const jsonFailures = [];
  for (const root of [alpha, betaGamma, deltaEps]) try {
    const r = B.projectSwitch(root, j, ctx);
    assert.equal(r.enabled, true, 'JSON-array text enables ' + path.basename(root));
    assert.equal(r.listRefused, false);
    assert.equal(r.bad, 0);
  } catch (err) {
    jsonFailures.push(path.basename(root) + ': ' + (err && err.message));
  }
  assert.deepEqual(jsonFailures, []);
  assert.equal(B.projectSwitch(delta, j, ctx).enabled, false, 'the folder before the comma is not enabled');
});

test('9.13 / live check 5 (server, third probe): each manifest default given as text gives the same effective options as the option being absent (manifest and code defaults stay equal)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_TOP, 'src', 'search', '.claude-plugin', 'plugin.json'), 'utf8'));
  const withDefault = Object.entries(manifest.userConfig).filter(([, v]) => Object.prototype.hasOwnProperty.call(v, 'default'));
  assert.ok(withDefault.length > 0, 'the manifest declares defaults');
  const effective = (opts) => {
    const f = Fl.buildFilter(opts);
    const q = R.queryOptions(opts);
    return {
      allowTypes: [...f.allowTypes].sort(),
      neverFolders: [...f.neverFolders].sort(),
      neverGlobs: f.neverGlobs.length,
      neverTerms: f.neverTerms.slice().sort(),
      dropContacts: f.dropContacts,
      maxFileBytes: f.maxFileBytes,
      counts: f.counts,
      optionsHash: f.optionsHash,
      matching: q.matching,
      wordFamilies: q.wordFamilies,
      synonyms: groupsOf(q.synonyms),
      badSynonyms: q.synonyms.bad,
    };
  };
  const absent = effective(S.optionsFromEnv({}));
  const all = {};
  // Every option is checked; the failures are collected and asserted once with the full list.
  const failures = [];
  for (const [key, spec] of withDefault) {
    try {
      if (!S.OPTION_KEYS.includes(key)) { failures.push(key + ': not a server option'); continue; }
      // A never-set string option with a default reached a live server as the default text;
      // for the boolean and number options the same text is assumed (not probed, 9.13).
      const env = envOf(key, String(spec.default));
      Object.assign(all, env);
      const opts = S.optionsFromEnv(env);
      if (JSON.stringify(Object.keys(opts)) !== JSON.stringify([key])) failures.push(key + ': not read as a set value');
      if (JSON.stringify(effective(opts)) !== JSON.stringify(absent)) failures.push(key + ': the manifest default ' + JSON.stringify(spec.default) + ' differs from the code default');
    } catch (err) {
      failures.push(key + ': threw ' + (err && err.name));
    }
  }
  assert.deepEqual(failures, []);
  assert.deepEqual(effective(S.optionsFromEnv(all)), absent, 'every default at once');
  // Control: a value that differs from a default does change the effective options.
  assert.notDeepEqual(effective(S.optionsFromEnv(envOf('max_file_bytes', '2048'))), absent);
  assert.notDeepEqual(effective(S.optionsFromEnv(envOf('matching', 'exact'))), absent);
  assert.notDeepEqual(effective(S.optionsFromEnv(envOf('drop_contacts', 'false'))), absent);
});

test('3.1 fact 2 / live check 5 (server, third probe): the server ignores CLAUDE_PLUGIN_OPTION_* (servers never get them); only SEARCH_OPTION_<KEY> is read, and empty or raw placeholder text counts as unset', () => {
  const pluginVars = {};
  for (const k of S.OPTION_KEYS) pluginVars['CLAUDE_PLUGIN_OPTION_' + k.toUpperCase()] = k === 'projects' ? REPO_TOP : 'x';
  assert.deepEqual(S.optionsFromEnv(pluginVars), {}, 'nothing is read from the hook variables');
  assert.deepEqual(S.optionsFromEnv({ ...pluginVars, ...envOf('matching', 'exact') }), { matching: 'exact' });
  const placeholder = '$' + '{user_config.never_terms}';
  assert.deepEqual(S.optionsFromEnv({ ...envOf('never_terms', ''), ...envOf('synonyms', placeholder) }), {}, 'empty and raw placeholder text are unset');
});

test('live check 5 (server, third probe): no SEAM(check 5) marker remains in src/search/', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(p);
    }
  };
  walk(path.join(REPO_TOP, 'src', 'search'));
  assert.ok(files.some((f) => path.basename(f) === 'server.cjs'), 'the server source was walked');
  const marker = 'SEAM' + '(check 5)';
  const left = files.filter((f) => fs.readFileSync(f, 'utf8').includes(marker)).map((f) => path.relative(REPO_TOP, f));
  assert.deepEqual(left, [], 'the server option seams are closed (third logged-in probe)');
});
