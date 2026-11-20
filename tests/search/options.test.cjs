'use strict';
// Query options (spec 9.13): the synonym format `term=alt|alt`, both list arrival forms,
// limits and bad_synonym, one-way groups, multi-word alternatives within 8 positions,
// synonyms in the 20-term cap; matching and word_families reach the store and its status.

const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../../src/search/server/index.cjs');
const R = require('../../src/search/server/rank.cjs');
const T = require('../../src/search/server/tokenize.cjs');
const { makeRun, openStore, cleanupRuns } = require('../helpers/search-run.cjs');

test.after(() => cleanupRuns());

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
