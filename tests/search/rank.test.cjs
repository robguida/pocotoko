'use strict';
// rank.cjs: BM25 known answers, heading weight, k range, 2 per file, tie-breaks, retired text,
// successors, exact level labels and fields, query budget (spec 9.4, 9.5, SR-31; T-19 rank part).

const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../../src/search/server/index.cjs');
const R = require('../../src/search/server/rank.cjs');
const T = require('../../src/search/server/tokenize.cjs');

function chunk(key, path, heading, text, extra = {}) {
  return { key, path, heading, trail: heading, line: extra.line || 1, date: null, flag: 'unmarked', successor: null, text, ...extra };
}

function q(s) {
  return T.parseQuery(s);
}

// The phase-1 (B5) tests below pin the exact level, because the default is now `broad`.
const EXACT = Object.freeze({ matching: 'exact' });

test('constants: k1 1.2, b 0.75, heading 2x body, file name 1.5x, k default 5 in 1..10', () => {
  assert.equal(R.K1, 1.2);
  assert.equal(R.B, 0.75);
  assert.equal(R.HEADING_WEIGHT, 2);
  assert.equal(R.BODY_WEIGHT, 1);
  assert.equal(R.NAME_WEIGHT, 1.5);
  assert.equal(R.EXACT_WEIGHT, 1);
  assert.equal(R.MAX_PER_FILE, 2);
  assert.equal(R.K_DEFAULT, 5);
  assert.equal(R.QUERY_BUDGET_MS, 1000);
});

test('BM25 known answer with the heading field weighted 2x', () => {
  const idx = I.fromChunks([
    chunk('d0', 'a.md', '', 'deploy deploy rollback'),
    chunk('d1', 'b.md', 'Deploy', '# Deploy\nnotes here'),
    chunk('d2', 'c.md', '', 'unrelated words only'),
  ]);
  // Hand computation: N = 3, df = 2, avg heading = 1/3, avg body = 2.
  const idf = Math.log(1 + (3 - 2 + 0.5) / (2 + 0.5));
  const sat = (tf) => (tf * 2.2) / (tf + 1.2);
  const d0 = idf * sat(2 / (0.25 + 0.75 * (3 / 2)));
  const d1 = idf * sat((2 * 1) / (0.25 + 0.75 * (1 / (1 / 3))));
  const r = R.rank(idx, q('deploy'), { ...EXACT, k: 5 });
  assert.equal(r.results.length, 2);
  const byKey = Object.fromEntries(r.results.map((x) => [x.key, x.score]));
  assert.ok(Math.abs(byKey.d0 - d0) < 1e-12);
  assert.ok(Math.abs(byKey.d1 - d1) < 1e-12);
  assert.deepEqual(r.results.map((x) => x.key), d0 > d1 ? ['d0', 'd1'] : ['d1', 'd0']);
});

test('heading weight: the same word ranks higher in a heading than in the body', () => {
  const idx = I.fromChunks([
    chunk('body', 'x1.md', 'Other', '# Other\nrollback filler words'),
    chunk('head', 'x2.md', 'Rollback', '# Rollback\nother filler words'),
  ]);
  const r = R.rank(idx, q('rollback'), EXACT);
  assert.equal(r.results[0].key, 'head');
});

test('OR across words: a chunk with both words ranks above one with either', () => {
  const idx = I.fromChunks([
    chunk('one', 'p1.md', '', 'deploy filler text here'),
    chunk('both', 'p2.md', '', 'deploy rollback text here'),
    chunk('other', 'p3.md', '', 'rollback filler text here'),
  ]);
  const r = R.rank(idx, q('deploy rollback'), EXACT);
  assert.equal(r.results[0].key, 'both');
  assert.equal(r.results.length, 3);
});

test('k: default 5; 1 and 10 accepted; 0, 11, -1, 1.5 and a string are errors, never clamped', () => {
  const chunks = [];
  for (let i = 0; i < 12; i++) chunks.push(chunk('k' + i, `f${String(i).padStart(2, '0')}.md`, '', 'deploy notes'));
  const idx = I.fromChunks(chunks);
  assert.equal(R.rank(idx, q('deploy'), EXACT).results.length, 5);
  assert.equal(R.rank(idx, q('deploy'), { ...EXACT, k: 1 }).results.length, 1);
  assert.equal(R.rank(idx, q('deploy'), { ...EXACT, k: 10 }).results.length, 10);
  for (const bad of [0, 11, -1, 1.5, '5', null, NaN]) {
    assert.throws(() => R.rank(idx, q('deploy'), { ...EXACT, k: bad }), { name: 'InvalidArgument' });
  }
  assert.throws(() => R.rank(idx, q('deploy'), { ...EXACT, includeRetired: 'yes' }), { name: 'InvalidArgument' });
});

test('at most 2 results per file', () => {
  const idx = I.fromChunks([
    chunk('a1', 'a.md', '', 'deploy deploy deploy', { line: 1 }),
    chunk('a2', 'a.md', '', 'deploy deploy deploy', { line: 5 }),
    chunk('a3', 'a.md', '', 'deploy deploy deploy', { line: 9 }),
    chunk('b1', 'b.md', '', 'deploy'),
  ]);
  const r = R.rank(idx, q('deploy'), { ...EXACT, k: 10 });
  assert.equal(r.results.filter((x) => x.path === 'a.md').length, 2);
  assert.equal(r.results.length, 3);
});

test('tie-breaks: flag order, then the shorter path', () => {
  const idx = I.fromChunks([
    chunk('long', 'zz/longer.md', '', 'deploy text'),
    chunk('unc', 'aa.md', '', 'deploy text', { flag: 'unconfirmed' }),
    chunk('short', 'bb.md', '', 'deploy text'),
  ]);
  const r = R.rank(idx, q('deploy'), EXACT);
  // Same text and lengths at the exact level (no file-name field), so the scores tie.
  assert.equal(r.results[0].score, r.results[1].score);
  assert.deepEqual(r.results.map((x) => x.key), ['short', 'long', 'unc']);
});

test('T-19: superseded text ranks below unmarked text of the same score and is never hidden', () => {
  const idx = I.fromChunks([
    chunk('old', 'a.md', '', 'deploy text', { flag: 'superseded', successor: 'b.md' }),
    chunk('new', 'b.md', '', 'deploy text'),
  ]);
  const r = R.rank(idx, q('deploy'), EXACT);
  assert.deepEqual(r.results.map((x) => x.key), ['new', 'old']);
  assert.equal(r.results[1].flag, 'superseded');
  assert.equal(r.results[1].successor, 'b.md');
});

test('T-19: cancelled text is hidden by default, at most 3 named with no text; include_retired shows it', () => {
  const chunks = [chunk('live', 'live.md', '', 'deploy')];
  for (let i = 0; i < 5; i++) chunks.push(chunk('c' + i, `gone${i}.md`, 'Plan ' + i, 'deploy secret plan text', { flag: 'cancelled' }));
  const idx = I.fromChunks(chunks);
  const r = R.rank(idx, q('deploy'), { ...EXACT, k: 10 });
  assert.deepEqual(r.results.map((x) => x.key), ['live']);
  assert.equal(r.hidden.length, 3);
  assert.equal(r.hiddenCount, 5);
  for (const h of r.hidden) {
    assert.deepEqual(Object.keys(h).sort(), ['heading', 'path']);
    assert.ok(!JSON.stringify(h).includes('secret plan text'));
  }
  const all = R.rank(idx, q('deploy'), { ...EXACT, k: 10, includeRetired: true });
  assert.equal(all.results.length, 6);
  assert.equal(all.hidden.length, 0);
});

test('T-19: a successor outside the index → unresolved; none → null; relative to the file folder resolves', () => {
  const idx = I.fromChunks([
    chunk('a', 'notes/old.md', '', 'deploy', { flag: 'superseded', successor: 'notes/missing.md' }),
    chunk('b', 'notes/old2.md', '', 'deploy', { flag: 'superseded', successor: 'new.md' }),
    chunk('c', 'notes/new.md', '', 'other words'),
    chunk('d', 'plain.md', '', 'deploy'),
  ]);
  const r = R.rank(idx, q('deploy'), { ...EXACT, k: 10 });
  const by = Object.fromEntries(r.results.map((x) => [x.key, x.successor]));
  assert.equal(by.a, 'unresolved');
  assert.equal(by.b, 'notes/new.md');
  assert.equal(by.d, null);
});

test('exact level: every result is labelled exact and the file-name field is not used', () => {
  const idx = I.fromChunks([chunk('n', 'docs/rollback.md', '', 'unrelated words')]);
  assert.equal(R.rank(idx, q('rollback'), { matching: 'exact' }).results.length, 0);
  const broad = R.rank(idx, q('rollback'), { matching: 'broad' });
  assert.equal(broad.results.length, 1); // the name field is wired for the broader level (B6)
  const idx2 = I.fromChunks([chunk('x', 'a.md', '', 'rollback')]);
  for (const res of R.rank(idx2, q('rollback'), { matching: 'exact' }).results) assert.deepEqual(res.matched_by, ['exact']);
});

test('hook points: expand and bonus are called; the default expansion is the word itself', () => {
  const idx = I.fromChunks([chunk('x', 'a.md', '', 'deploy rollback'), chunk('y', 'b.md', '', 'deploying rollback')]);
  const seen = [];
  const r = R.rank(idx, q('deploy'), {
    expand: (w) => { seen.push(w.w); return [{ term: 'deploy', weight: 1, label: 'exact' }, { term: 'deploying', weight: 0.8, label: 'family' }]; },
    bonus: () => 2,
  });
  assert.deepEqual(seen, ['deploy']);
  assert.equal(r.results.length, 2);
  assert.deepEqual(r.results.find((x) => x.key === 'y').matched_by, ['family']);
  assert.deepEqual(R.exactExpand({ w: 'deploy' }), [{ term: 'deploy', weight: 1, label: 'exact' }]);
});

test('query budget: over budget → partial', () => {
  const idx = I.fromChunks([chunk('x', 'a.md', '', 'deploy')]);
  const r = R.rank(idx, q('deploy'), { budgetMs: 0 });
  assert.equal(r.partial, true);
  assert.equal(R.rank(idx, q('deploy'), {}).partial, false);
});

// ---------------------------------------------------------------------------
// Phase 2 (matching: broad): spec 7.2, 9.5 phase 2, SR-29, T-16 (query part), T-17

function broad(idx, s, extra = {}) {
  return R.rank(idx, q(s), { matching: 'broad', k: 10, ...extra });
}
function keys(r) {
  return r.results.map((x) => x.key);
}
function labelOf(r, key) {
  const hit = r.results.find((x) => x.key === key);
  return hit ? hit.matched_by : null;
}
/** n filler words (3 characters, no letter run close to any test word). */
function filler(n, start = 0) {
  const out = [];
  for (let i = 0; i < n; i++) out.push('n' + String(start + i).padStart(2, '0'));
  return out.join(' ');
}

test('phase 2 constants: match weights, bonuses, windows and caps', () => {
  assert.equal(R.EXACT_WEIGHT, 1.0);
  assert.equal(R.FAMILY_WEIGHT, 0.8);
  assert.equal(R.PREFIX_WEIGHT, 0.6);
  assert.equal(R.SYNONYM_WEIGHT, 0.6);
  assert.equal(R.FUZZY_WEIGHT, 0.4);
  assert.ok(R.EXACT_WEIGHT > R.FAMILY_WEIGHT && R.FAMILY_WEIGHT > R.PREFIX_WEIGHT && R.PREFIX_WEIGHT > R.FUZZY_WEIGHT);
  assert.equal(R.ALL_WORDS_BONUS, 1.25);
  assert.equal(R.NEAR_WINDOW, 8);
  assert.equal(R.NEAR_BONUS, 1.25);
  assert.equal(R.FAR_WINDOW, 32);
  assert.equal(R.FAR_BONUS, 1.10);
  assert.equal(R.MAX_EXPANSIONS, 20);
  assert.equal(R.WILDCARD_MIN_STEM, 3);
  assert.equal(R.WILDCARD_MAX_TERMS, 200);
  assert.equal(R.PREFIX_MIN_LETTERS, 4);
  assert.equal(R.FUZZY_ONE_MIN, 5);
  assert.equal(R.FUZZY_TWO_MIN, 8);
  assert.deepEqual([...R.LABELS].sort(), ['exact', 'family', 'fuzzy', 'prefix', 'synonym']);
});

test('matching option: exact or broad; anything else (and never set) → broad', () => {
  assert.equal(R.MATCHING_DEFAULT, 'broad');
  assert.equal(R.parseMatching('exact'), 'exact');
  assert.equal(R.parseMatching(' Broad '), 'broad');
  for (const bad of [undefined, null, '', 'fuzzy', 1, '$' + '{user_config.matching}']) assert.equal(R.parseMatching(bad), 'broad');
  const idx = I.fromChunks([chunk('x', 'a.md', '', 'deployed')]);
  assert.equal(R.rank(idx, q('deploying'), {}).matching, 'broad');
  assert.equal(R.rank(idx, q('deploying'), {}).results.length, 1);
  assert.equal(R.rank(idx, q('deploying'), { matching: 'nonsense' }).results.length, 1);
});

test('word families (english): deployed and deploying match deploy, labelled family; off: never', () => {
  const idx = I.fromChunks([
    chunk('base', 'a.md', '', 'deploy the build'),
    chunk('past', 'b.md', '', 'we deployed it'),
    chunk('other', 'c.md', '', 'unrelated words'),
  ]);
  const r = broad(idx, 'deploying');
  assert.deepEqual(keys(r).sort(), ['base', 'past']);
  assert.deepEqual(labelOf(r, 'base'), ['family']);
  assert.deepEqual(labelOf(r, 'past'), ['family']);
  const off = broad(idx, 'deploying', { wordFamilies: 'off' });
  assert.equal(off.results.length, 0);
  for (const res of broad(idx, 'deployed', { wordFamilies: 'off' }).results) assert.ok(!res.matched_by.includes('family'));
  // Exact level: no family match at all.
  assert.equal(R.rank(idx, q('deploying'), { matching: 'exact' }).results.length, 0);
});

test('word families: an accent, a digit or a 1- or 2-letter word is left alone, on file text and on the query', () => {
  const idx = I.fromChunks([
    chunk('acc', 'a.md', '', 'résumés kept'),
    chunk('dig', 'b.md', '', 'v2tests here'),
    chunk('two', 'c.md', '', 'go linen'),
  ]);
  for (const res of broad(idx, 'résumé').results) assert.ok(!res.matched_by.includes('family'));
  assert.equal(broad(idx, 'v2test').results.length, 1); // found by prefix, never by family
  assert.deepEqual(labelOf(broad(idx, 'v2test'), 'dig'), ['prefix']);
  assert.equal(broad(idx, 'goes').results.length, 0); // `go` in the text is 2 letters: no family
  const idx2 = I.fromChunks([chunk('goes', 'd.md', '', 'goes made')]);
  assert.equal(broad(idx2, 'go').results.length, 0); // `go` in the query is 2 letters: no family
  assert.deepEqual(idx.familyTerms('résumé'), []);
});

test('B6 review: a 3-letter word joins the family whose stem is that word, on both sides; an acronym does not', () => {
  const idx = I.fromChunks([
    chunk('run', 'a.md', '', 'run the job'),
    chunk('fix', 'b.md', '', 'fix it'),
    chunk('add', 'c.md', '', 'add rows'),
    chunk('bed', 'd.md', '', 'bed linen'),
  ]);
  assert.deepEqual(labelOf(broad(idx, 'running'), 'run'), ['family']);
  assert.deepEqual(labelOf(broad(idx, 'fixes'), 'fix'), ['family']);
  assert.deepEqual(labelOf(broad(idx, 'adding'), 'add'), ['family']);
  assert.deepEqual(labelOf(broad(idx, 'beds'), 'bed'), ['family']);
  assert.deepEqual(idx.familyTerms('run'), ['run']);
  // The query side: a 3-letter query word finds its longer family members.
  const idx2 = I.fromChunks([chunk('running', 'a.md', '', 'running late'), chunk('fixes', 'b.md', '', 'fixes landed')]);
  assert.deepEqual(labelOf(broad(idx2, 'run'), 'running'), ['family']);
  assert.deepEqual(labelOf(broad(idx2, 'fix'), 'fixes'), ['family']);
  // `RUN` in upper case is caught by the acronym rule: not in a family on either side.
  assert.equal(broad(idx2, 'RUN').results.length, 0);
  const acr = I.fromChunks([chunk('acr', 'a.md', '', 'RUN only')]);
  assert.deepEqual(acr.familyTerms('run'), []);
  assert.equal(broad(acr, 'running').results.length, 0);
  // word_families off: never.
  assert.equal(broad(idx, 'running', { wordFamilies: 'off' }).results.length, 0);
});

test('word families: a word seen only as an acronym is never stemmed', () => {
  const idx = I.fromChunks([chunk('acr', 'a.md', '', 'TESTS pass'), chunk('plain', 'b.md', '', 'tests pass')]);
  assert.deepEqual(idx.familyTerms('test'), ['tests']); // `tests` has a plain occurrence in b.md
  const only = I.fromChunks([chunk('acr', 'a.md', '', 'TESTS pass')]);
  assert.deepEqual(only.familyTerms('test'), []);
  // The query word caught by the acronym rule is not stemmed either.
  const idx3 = I.fromChunks([chunk('t', 'a.md', '', 'testing done')]);
  assert.equal(broad(idx3, 'TESTS').results.length, 0);
  assert.deepEqual(labelOf(broad(idx3, 'tests'), 't'), ['family']);
});

test('automatic prefix match only for words of 4 or more letters', () => {
  const idx = I.fromChunks([chunk('d', 'a.md', '', 'deployment notes')]);
  assert.equal(broad(idx, 'dep').results.length, 0);
  const r = broad(idx, 'depl');
  assert.deepEqual(keys(r), ['d']);
  assert.deepEqual(r.results[0].matched_by, ['prefix']);
});

test('near spellings: none under 5 letters; one letter off from 5; two letters off from 8', () => {
  const four = I.fromChunks([chunk('p', 'a.md', '', 'plat')]);
  assert.equal(broad(four, 'plan').results.length, 0);
  const five = I.fromChunks([chunk('one', 'a.md', '', 'zebro'), chunk('two', 'b.md', '', 'zebxo')]);
  const r5 = broad(five, 'zebra');
  assert.deepEqual(keys(r5), ['one']);
  assert.deepEqual(r5.results[0].matched_by, ['fuzzy']);
  const eight = I.fromChunks([chunk('two', 'a.md', '', 'rellbeck'), chunk('del', 'b.md', '', 'rollbak'), chunk('three', 'c.md', '', 'rellbecx')]);
  const r8 = broad(eight, 'rollback');
  assert.deepEqual(keys(r8).sort(), ['del', 'two']);
  for (const res of r8.results) assert.deepEqual(res.matched_by, ['fuzzy']);
  // Seven letters: only one letter off.
  assert.equal(broad(eight, 'rollbac').results.some((x) => x.key === 'two'), false);
  assert.equal(R.fuzzyDistance(4), 0);
  assert.equal(R.fuzzyDistance(5), 1);
  assert.equal(R.fuzzyDistance(7), 1);
  assert.equal(R.fuzzyDistance(8), 2);
  assert.equal(R.editDistance([...'kitten'], [...'sitting'], 3), 3);
  assert.equal(R.editDistance([...'kitten'], [...'sitting'], 1), 2); // over the bound: bound + 1
});

test('labels: broad results each carry one of the five labels; exact results only exact', () => {
  const idx = I.fromChunks([
    chunk('e', 'a.md', '', 'rollback steps'),
    chunk('f', 'b.md', '', 'rollbacks listed'),
    chunk('p', 'c.md', '', 'rollbackplan words'),
    chunk('z', 'd.md', '', 'rolback typo'),
  ]);
  const r = broad(idx, 'rollback');
  assert.ok(r.results.length >= 4);
  for (const res of r.results) {
    assert.ok(res.matched_by.length >= 1);
    for (const l of res.matched_by) assert.ok(R.LABELS.includes(l), l);
  }
  assert.deepEqual(labelOf(r, 'e'), ['exact']);
  assert.deepEqual(labelOf(r, 'f'), ['family']);
  assert.deepEqual(labelOf(r, 'p'), ['prefix']);
  assert.deepEqual(labelOf(r, 'z'), ['fuzzy']);
  assert.deepEqual(keys(r).slice(0, 4), ['e', 'f', 'p', 'z']); // weights: exact > family > prefix > fuzzy
  const ex = R.rank(idx, q('rollback'), { matching: 'exact', k: 10 });
  assert.deepEqual(keys(ex), ['e']);
  for (const res of ex.results) assert.deepEqual(res.matched_by, ['exact']);
});

test('match weights: a family match scores 0.8 of the same exact match', () => {
  const idx = I.fromChunks([chunk('x', 'a.md', '', 'deployed now')]);
  const exact = broad(idx, 'deployed').results[0].score;
  const fam = broad(idx, 'deploys').results[0].score;
  assert.ok(Math.abs(fam - exact * R.FAMILY_WEIGHT) < 1e-12);
});

test('file-name field 1.5x only in broad', () => {
  const idx = I.fromChunks([chunk('n', 'docs/quartz.md', '', 'other words'), chunk('b', 'b.md', '', 'quartz words')]);
  assert.deepEqual(keys(R.rank(idx, q('quartz'), { matching: 'exact' })), ['b']);
  const r = broad(idx, 'quartz');
  assert.deepEqual(keys(r).sort(), ['b', 'n']);
  const stats = idx.stats();
  const nameOnly = R.termScores(idx, 'quartz', { h: 2, b: 1, n: 1.5 }, stats).get(0);
  assert.ok(Math.abs(r.results.find((x) => x.key === 'n').score - nameOnly) < 1e-12);
});

function bonusCase(gap) {
  // quartz at position 0, zephyr at position `gap`; nothing else matches.
  const text = gap === 0 ? 'quartz zephyr' : ['quartz', filler(gap - 1), 'zephyr'].join(' ');
  const idx = I.fromChunks([chunk('x', 'a.md', '', text), chunk('y', 'b.md', '', 'unrelated ' + filler(40, 50))]);
  const stats = idx.stats();
  const w = { h: 2, b: 1, n: 1.5 };
  const base = R.termScores(idx, 'quartz', w, stats).get(0) + R.termScores(idx, 'zephyr', w, stats).get(0);
  return { idx, base };
}

test('all-words ×1.25 and closeness ×1.25 within 8 positions, ×1.10 within 32, none beyond', () => {
  const cases = [[7, 1.25 * 1.25], [8, 1.25 * 1.10], [31, 1.25 * 1.10], [32, 1.25]];
  for (const [gap, factor] of cases) {
    const { idx, base } = bonusCase(gap);
    const s = broad(idx, 'quartz zephyr').results[0].score;
    assert.ok(Math.abs(s - base * factor) < 1e-9, `gap ${gap}: ${s} vs ${base * factor}`);
  }
  assert.equal(R.smallestSpan([[0], [7]]), 8);
  assert.equal(R.smallestSpan([[0, 50], [40, 3], [45]]), 11);
  assert.equal(R.smallestSpan([[0], []]), Infinity);
});

test('all-words bonus only when every word of a 2+ word query matches; no bonus for 1 word', () => {
  const idx = I.fromChunks([
    chunk('both', 'a.md', '', ['quartz', filler(60), 'zephyr'].join(' ')),
    chunk('one', 'b.md', '', ['quartz', filler(60)].join(' ')),
  ]);
  const stats = idx.stats();
  const w = { h: 2, b: 1, n: 1.5 };
  const r = broad(idx, 'quartz zephyr');
  const both = r.results.find((x) => x.key === 'both').score;
  const one = r.results.find((x) => x.key === 'one').score;
  const tq = R.termScores(idx, 'quartz', w, stats);
  const tz = R.termScores(idx, 'zephyr', w, stats);
  assert.ok(Math.abs(both - (tq.get(0) + tz.get(0)) * 1.25) < 1e-9);
  assert.ok(Math.abs(one - tq.get(1)) < 1e-9); // one matched word: no all-words, no closeness
  const single = broad(idx, 'quartz').results.find((x) => x.key === 'both').score;
  assert.ok(Math.abs(single - tq.get(0)) < 1e-9);
  // Exact level: no bonuses at all.
  const ex = R.rank(idx, q('quartz zephyr'), { matching: 'exact' }).results.find((x) => x.key === 'both').score;
  const we = { h: 2, b: 1 };
  assert.ok(Math.abs(ex - (R.termScores(idx, 'quartz', we, stats).get(0) + R.termScores(idx, 'zephyr', we, stats).get(0))) < 1e-9);
});

test('closeness is applied after the all-words bonus, and counts expansions as matches', () => {
  // zephyrs (family of zephyr) sits next to quartz: both words count as matched and close.
  const idx = I.fromChunks([chunk('x', 'a.md', '', 'quartz zephyrs ' + filler(10))]);
  const stats = idx.stats();
  const w = { h: 2, b: 1, n: 1.5 };
  const base = R.termScores(idx, 'quartz', w, stats).get(0) + R.termScores(idx, 'zephyrs', w, stats).get(0) * R.FAMILY_WEIGHT;
  const s = broad(idx, 'quartz zephyr').results[0].score;
  assert.ok(Math.abs(s - base * 1.25 * 1.25) < 1e-9);
  // Both words only in the heading count as close.
  const h = I.fromChunks([chunk('h', 'a.md', 'Quartz Zephyr', '# Quartz Zephyr\n' + filler(5))]);
  const hs = h.stats();
  const hb = R.termScores(h, 'quartz', w, hs).get(0) + R.termScores(h, 'zephyr', w, hs).get(0);
  assert.ok(Math.abs(broad(h, 'quartz zephyr').results[0].score - hb * 1.25 * 1.25) < 1e-9);
});

test('expansion cap: 20 automatic terms per word, in a fixed order, and the result says so', () => {
  const words = [];
  for (let i = 0; i < 30; i++) words.push('deploy' + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26)));
  const idx = I.fromChunks([chunk('x', 'a.md', '', words.join(' '))]);
  const ctx = { index: idx, wordFamilies: 'english', synonyms: [], over: () => false, notes: new Set(), partial: false };
  const ex = R.broadExpand({ w: 'deploy', wild: false }, ctx);
  assert.equal(ex.length, 1 + 20);
  assert.ok(ctx.notes.has(R.NOTES.EXPANSION_CAPPED));
  const prefixTerms = ex.filter((e) => e.label === 'prefix').map((e) => e.term);
  assert.deepEqual(prefixTerms, [...words].sort().slice(0, 20));
  assert.deepEqual(broad(idx, 'deploy').notes, [R.NOTES.EXPANSION_CAPPED]);
  // Under the cap: no note.
  const small = I.fromChunks([chunk('x', 'a.md', '', 'deployaa deployab')]);
  assert.deepEqual(broad(small, 'deploy').notes, []);
});

test('expansion cap: synonyms count toward the 20 (each word of a multi-word alternative counts), ahead of prefixes', () => {
  const words = [];
  for (let i = 0; i < 30; i++) words.push('deploy' + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26)));
  const idx = I.fromChunks([chunk('x', 'a.md', '', words.join(' ') + ' ship launch roll out')]);
  const syn = R.parseSynonyms(['deploy=ship|launch|roll forward']);
  const ctx = { index: idx, wordFamilies: 'english', synonyms: R.synonymHits(q('deploy').words, syn).get(0), over: () => false, notes: new Set(), partial: false };
  const ex = R.broadExpand({ w: 'deploy', wild: false }, ctx);
  const synEx = ex.filter((e) => e.label === 'synonym');
  assert.equal(synEx.length, 3);
  const cost = ex.slice(1).reduce((n, e) => n + (e.terms ? e.terms.length : 1), 0);
  assert.equal(cost, 20);
  assert.equal(ex.filter((e) => e.label === 'prefix').length, 20 - 4); // ship, launch, and roll forward (2 words)
  assert.ok(ctx.notes.has(R.NOTES.EXPANSION_CAPPED));
  assert.ok(ex.indexOf(synEx[0]) < ex.findIndex((e) => e.label === 'prefix'));
});

test('T-17: ab* (stem under 3), a leading *, a middle * and ** → no wildcard look-up; abc* allowed', () => {
  const idx = I.fromChunks([chunk('x', 'a.md', '', 'abacus abcdef abcxyz')]);
  const short = broad(idx, 'ab*');
  assert.equal(short.results.length, 0);
  assert.deepEqual(short.notes, [R.NOTES.WILDCARD_TOO_SHORT]);
  assert.equal(broad(idx, 'a*').results.length, 0); // one letter: no word at all
  assert.equal(broad(idx, '*abc').results.length, 0); // leading *: a plain separator; 3 letters get no automatic prefix
  assert.equal(broad(idx, 'ab*cd').results.length, 0); // middle *: a separator
  assert.equal(broad(idx, 'abc**').results.length, 0);
  assert.equal(broad(idx, '**').results.length, 0);
  const ok = broad(idx, 'abc*');
  assert.deepEqual(keys(ok), ['x']);
  assert.deepEqual(ok.results[0].matched_by, ['prefix']);
  assert.deepEqual(ok.notes, []);
  // Exact level: the * is a separator, and the result says the wildcard was not used.
  const ex = R.rank(idx, q('abc*'), { matching: 'exact' });
  assert.equal(ex.results.length, 0);
  assert.deepEqual(ex.notes, [R.NOTES.WILDCARD_IGNORED]);
});

test('T-17: a wildcard stem matching thousands of terms → capped at 200 terms, with a note', () => {
  const words = [];
  for (let i = 0; i < 3000; i++) words.push('abc' + String(i).padStart(4, '0'));
  const chunks = [];
  for (let i = 0; i < words.length; i += 100) chunks.push(chunk('c' + i, `f${i}.md`, '', words.slice(i, i + 100).join(' ')));
  const idx = I.fromChunks(chunks);
  const ctx = { index: idx, wordFamilies: 'english', synonyms: [], over: () => false, notes: new Set(), partial: false };
  const ex = R.broadExpand({ w: 'abc', wild: true }, ctx);
  assert.equal(ex.filter((e) => e.label === 'prefix').length, 200);
  assert.ok(ctx.notes.has(R.NOTES.WILDCARD_CAPPED));
  const r = broad(idx, 'abc*');
  assert.ok(r.notes.includes(R.NOTES.WILDCARD_CAPPED));
  assert.ok(r.results.length > 0 && r.results.length <= 10);
});

test('T-16 (query part): 32 eight-letter words that each expand to the cap → no error, within budget or partial', () => {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const base = (i) => 'qz' + letters[i % 26] + letters[Math.floor(i / 26) % 26] + 'mnop'; // 8 letters
  const qwords = [];
  const chunks = [];
  for (let i = 0; i < 32; i++) {
    const w = base(i);
    qwords.push(w);
    const ext = [];
    for (let j = 0; j < 25; j++) ext.push(w + letters[j]);
    chunks.push(chunk('c' + i, `f${i}.md`, '', ext.join(' ')));
  }
  const idx = I.fromChunks(chunks);
  const t0 = Date.now();
  const r = broad(idx, qwords.join(' '));
  const took = Date.now() - t0;
  assert.ok(r.partial || took < R.QUERY_BUDGET_MS + 500, `took ${took} ms`);
  assert.ok(r.notes.includes(R.NOTES.EXPANSION_CAPPED));
  // Symbols are plain separators at the broader level too.
  for (const s of ['.*+?()[]{}^$|\\ qzaamnop', '"qzaamnop"', '*', '**', 'qza*amnop']) assert.doesNotThrow(() => broad(idx, s));
  // A clock that runs out at once → partial, never an error.
  const pr = broad(idx, qwords.join(' '), { budgetMs: 0 });
  assert.equal(pr.partial, true);
  // A clock that moves on at every check: the near-spelling scan itself stops.
  let tick = 0;
  const big = [];
  for (let i = 0; i < 2000; i++) big.push('zz' + String(i).padStart(6, '0'));
  const bigIdx = I.fromChunks([chunk('b', 'b.md', '', big.join(' '))]);
  const ctx = { index: bigIdx, wordFamilies: 'english', synonyms: [], over: () => ++tick > 2, notes: new Set(), partial: false };
  R.broadExpand({ w: 'zz000000', wild: false }, { ...ctx, over: () => false });
  R.broadExpand({ w: 'qq000000', wild: false }, ctx);
  assert.equal(ctx.partial, true);
});

test('T-16 (query part, B6 review 2): the hard-stop worst case (50,000 chunks, each holding all 32 query words) → within the budget, or partial within the budget plus the 250 ms tail', () => {
  const TAIL_MS = 250; // spec 9.5 query handling (SR-28)
  const HARD_STOP = 50000; // spec 9.11: chunks per project, hard stop
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const qwords = [];
  for (let i = 0; i < 32; i++) qwords.push('qz' + letters[i % 26] + letters[Math.floor(i / 26) % 26] + 'mnop'); // 8 letters each
  const text = qwords.join(' ');
  const idx = I.createIndex();
  for (let i = 0; i < HARD_STOP; i++) idx.add(chunk('k' + i, `d${i % 500}/f${i}.md`, '', text));
  idx.prepare();
  const query = q(text);
  assert.equal(query.words.length, 32);
  for (const matching of ['exact', 'broad']) {
    const t0 = Date.now();
    const r = R.rank(idx, query, { matching });
    const took = Date.now() - t0;
    if (r.partial) assert.ok(took <= R.QUERY_BUDGET_MS + TAIL_MS, `${matching}: partial after ${took} ms`);
    else assert.ok(took <= R.QUERY_BUDGET_MS, `${matching}: ${took} ms`);
    assert.equal(r.results.length, 5);
    for (const res of r.results) assert.deepEqual(res.matched_by, ['exact'], matching);
  }
  // The budget runs out inside the exact pass itself: partial at once, holding the exact hits scored so far.
  for (const matching of ['exact', 'broad']) {
    const t0 = Date.now();
    const r = R.rank(idx, query, { matching, budgetMs: 0 });
    const took = Date.now() - t0;
    assert.equal(r.partial, true, matching);
    assert.ok(took <= TAIL_MS, `${matching}: ${took} ms with no budget`);
    assert.equal(r.results.length, 5);
    for (const res of r.results) assert.deepEqual(res.matched_by, ['exact'], matching);
  }
});

test('B6 review: every exact hit is scored before any expansion, so a partial result keeps them all', () => {
  // 31 long words with big near-spelling buckets come first in the query; `quartz` is last.
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const long = [];
  // 12 letters each, at least 3 letters apart from one another.
  for (let i = 0; i < 31; i++) long.push('zq' + letters[i % 26].repeat(3) + letters[Math.floor(i / 26)].repeat(3) + 'vwxy');
  const big = [];
  for (let i = 0; i < 3000; i++) big.push('zz' + letters[i % 26] + letters[Math.floor(i / 26) % 26] + letters[Math.floor(i / 676) % 26] + 'mnopq');
  const idx = I.fromChunks([
    chunk('q', 'q.md', '', 'quartz crystal'),
    chunk('l', 'l.md', '', long[3] + ' text'),
    chunk('b', 'b.md', '', big.join(' ')),
  ]);
  const query = q([...long, 'quartz'].join(' '));
  assert.equal(query.words.length, 32);
  // A clock that moves on at every look: the budget runs out during the first word's expansions.
  let tick = 0;
  const r = broad(idx, [...long, 'quartz'].join(' '), { now: () => tick++, budgetMs: 40 });
  assert.equal(r.partial, true);
  assert.deepEqual(keys(r).sort(), ['l', 'q']);
  assert.deepEqual(labelOf(r, 'q'), ['exact']);
  assert.deepEqual(labelOf(r, 'l'), ['exact']);
  // No time at all: still every exact hit, never an expansion.
  const none = broad(idx, 'crystals quartz', { budgetMs: 0 });
  assert.equal(none.partial, true);
  assert.deepEqual(keys(none), ['q']);
  assert.deepEqual(labelOf(none, 'q'), ['exact']);
  // The exact level is unchanged by the budget split.
  assert.deepEqual(keys(R.rank(idx, query, { matching: 'exact', budgetMs: 0 })).sort(), ['l', 'q']);
});

// ---------------------------------------------------------------------------
// B6 review 3: every loop that grows with the index checks the budget, and a
// partial result is ordered by base score alone (spec 9.5 query handling, SR-28, T-16).

const CHECK_EVERY = 256; // rank.cjs BUDGET_CHECK_EVERY: units of work between clock reads

test('B6 review 3: a 3-word synonym alternative held by every chunk near the 64 MiB text cap → partial within the budget plus the 250 ms tail', () => {
  const TAIL_MS = 250; // spec 9.5 query handling (SR-28)
  const TEXT_CAP = 64 * 1024 * 1024; // spec 9.11: indexed text per project
  const alt = ['zkone', 'zktwo', 'zkthree'];
  const reps = [];
  for (let j = 0; j < 300; j++) reps.push(alt.join(' '));
  const text = reps.join(' '); // about 6,000 bytes, under the 16 KiB chunk size
  const n = Math.floor((TEXT_CAP * 0.9) / text.length);
  const idx = I.createIndex();
  for (let i = 0; i < n; i++) idx.add(chunk('k' + i, `d${i % 50}/f${i}.md`, '', text));
  idx.prepare();
  assert.ok(n * text.length < TEXT_CAP);
  const synonyms = R.parseSynonyms(['revert=' + alt.join(' ')]);
  const query = q('revert');
  const full = R.rank(idx, query, { synonyms });
  assert.equal(full.results.length, 5);
  for (const res of full.results) assert.deepEqual(res.matched_by, ['synonym']);
  for (const budgetMs of [20, 50]) {
    const t0 = Date.now();
    const r = R.rank(idx, query, { synonyms, budgetMs });
    const took = Date.now() - t0;
    assert.equal(r.partial, true, `budget ${budgetMs} ms`);
    assert.ok(took <= budgetMs + TAIL_MS, `budget ${budgetMs} ms: partial after ${took} ms`);
    for (const res of r.results) assert.deepEqual(res.matched_by, ['synonym']);
  }
});

test('B6 review 3: when the clock runs out after the expansions or while the bonuses are worked out, the partial result is ordered by base score alone', () => {
  // 300 longer chunks, then one short chunk that holds both words; others raise the IDF.
  const chunks = [];
  for (let i = 0; i < 300; i++) chunks.push(chunk('long' + i, `l${i}.md`, '', 'alpha beta ' + filler(3)));
  chunks.push(chunk('short', 's.md', '', 'alpha beta'));
  for (let i = 0; i < 1260; i++) chunks.push(chunk('o' + i, `o${i}.md`, '', 'gamma delta ' + filler(3)));
  const idx = I.fromChunks(chunks);
  const query = q('alpha beta');
  const w = { h: R.HEADING_WEIGHT, b: R.BODY_WEIGHT, n: R.NAME_WEIGHT };
  const sa = R.termScores(idx, 'alpha', w, idx.stats());
  const sb = R.termScores(idx, 'beta', w, idx.stats());
  const id = (key) => idx.docIdForKey(key);
  const both = (key) => sa.get(id(key)) + sb.get(id(key));
  const BOOST = R.ALL_WORDS_BONUS * R.NEAR_BONUS;
  // The case the review found: a bonus on the long chunks alone would put the short one behind them.
  assert.ok(both('short') < both('long0') * BOOST);
  assert.ok(both('short') > both('long0'));
  // Full run: every hit gets both bonuses, and the short chunk is first.
  let reads = 0;
  const full = R.rank(idx, query, { k: 10, budgetMs: Infinity, now: () => reads++ });
  assert.equal(full.partial, false);
  assert.equal(full.results[0].key, 'short');
  assert.ok(Math.abs(full.results[0].score - both('short') * BOOST) < 1e-9);
  // A clock that moves on at every read, running out at each read in turn.
  let sawLate = 0;
  for (let budgetMs = 0; budgetMs < reads; budgetMs++) {
    let t = 0;
    const r = R.rank(idx, query, { k: 10, budgetMs, now: () => t++ });
    assert.equal(r.partial, true, `budget ${budgetMs}`);
    for (const res of r.results) {
      const s1 = sa.get(id(res.key));
      const ok = Math.abs(res.score - s1) < 1e-9 || Math.abs(res.score - both(res.key)) < 1e-9;
      assert.ok(ok, `budget ${budgetMs}: ${res.key} kept a bonus (${res.score})`);
    }
    // Once both of its words are scored, the short chunk (the best base score) is first.
    const sh = r.results.find((x) => x.key === 'short');
    if (sh && Math.abs(sh.score - both('short')) < 1e-9) {
      assert.equal(r.results[0].key, 'short', `budget ${budgetMs}`);
      sawLate++;
    }
  }
  // The last read (inside the bonus loop) and the reads just before it are covered.
  assert.ok(sawLate >= 2, `late stops seen: ${sawLate}`);
  let t = 0;
  const last = R.rank(idx, query, { k: 5, budgetMs: reads - 1, now: () => t++ });
  assert.equal(last.partial, true);
  assert.deepEqual(keys(last), ['short', 'long0', 'long1', 'long2', 'long3']);
});

test('B6 review 3: the document frequency is never a walk over the postings; an odd field set counts them under the budget', () => {
  const chunks = [];
  for (let i = 0; i < 1000; i++) chunks.push(chunk('k' + i, `f${i}.md`, '', 'alpha'));
  chunks.push(chunk('nm', 'alpha.md', '', 'other words')); // `alpha` in the file name only
  const idx = I.fromChunks(chunks);
  assert.equal(idx.textDocs('alpha'), 1000);
  assert.equal(idx.postingsFor('alpha').size, 1001);
  const exactW = { h: R.HEADING_WEIGHT, b: R.BODY_WEIGHT };
  const broadW = { h: R.HEADING_WEIGHT, b: R.BODY_WEIGHT, n: R.NAME_WEIGHT };
  // A clock already out: both levels score up to the first clock read, with no counting loop first.
  for (const w of [exactW, broadW]) {
    let reads = 0;
    const g = R.makeGuard(() => { reads++; return true; });
    assert.equal(R.termScores(idx, 'alpha', w, idx.stats(), g).size, CHECK_EVERY - 1);
    assert.equal(reads, 1);
  }
  // Body alone (no level uses it): the counting loop itself stops at the first clock read.
  const g = R.makeGuard(() => true);
  assert.equal(R.termScores(idx, 'alpha', { b: R.BODY_WEIGHT }, idx.stats(), g).size, 0);
  assert.equal(g.stopped, true);
  // The index's count gives the same document frequency as counting the postings.
  const idf = Math.log(1 + (idx.stats().docs - 1000 + 0.5) / (1000 + 0.5));
  const sat = (tf) => (tf * (R.K1 + 1)) / (tf + R.K1);
  const avgB = idx.stats().avg.b;
  const want = idf * sat(R.BODY_WEIGHT / (1 - R.B + R.B * (1 / avgB)));
  assert.ok(Math.abs(R.termScores(idx, 'alpha', exactW, idx.stats()).get(0) - want) < 1e-12);
  // Removing a chunk keeps the count in step.
  idx.remove('k0');
  idx.remove('nm');
  assert.equal(idx.textDocs('alpha'), 999);
});

test('B6 review 3: covers on the word\'s own exact match are applied under the budget', () => {
  const N = 10 * CHECK_EVERY;
  const chunks = [];
  for (let i = 0; i < N; i++) chunks.push(chunk('k' + i, `f${i}.md`, '', 'payroll closes'));
  const idx = I.fromChunks(chunks);
  const run = (covers) => {
    let reads = 0;
    const expand = (wd) => [{ term: wd.w, weight: R.EXACT_WEIGHT, label: 'exact', ...(covers ? { covers: ['zzcover'] } : {}) }];
    const r = R.rank(idx, q('payroll'), { matching: 'exact', expand, budgetMs: Infinity, now: () => reads++ });
    assert.equal(r.partial, false);
    return reads;
  };
  // The covers loop reads the clock about once per CHECK_EVERY documents.
  assert.ok(run(true) - run(false) >= N / CHECK_EVERY - 1);
  // A clock already out: partial, never an error.
  const r = R.rank(idx, q('payroll'), { matching: 'exact', expand: (wd) => [{ term: wd.w, weight: 1, label: 'exact', covers: ['zzcover'] }], budgetMs: 0 });
  assert.equal(r.partial, true);
});

test('B6 review 3: resolving a successor looks up one path, never walks every chunk', () => {
  const idx = I.fromChunks([
    chunk('old', 'notes/old.md', '', 'alpha', { flag: 'superseded', successor: 'new.md' }),
    chunk('new', 'notes/new.md', '', 'alpha beta'),
  ]);
  idx.paths = () => { throw new Error('paths() walked every chunk'); };
  const r = R.rank(idx, q('alpha'), EXACT);
  assert.equal(r.results.find((x) => x.key === 'old').successor, 'notes/new.md');
  idx.removePath('notes/new.md');
  assert.equal(R.rank(idx, q('alpha'), EXACT).results[0].successor, 'unresolved');
});

test('a truncated query is reported', () => {
  const idx = I.fromChunks([chunk('x', 'a.md', '', 'deploy')]);
  const words = [];
  for (let i = 0; i < 40; i++) words.push('w' + String(i).padStart(2, '0') + 'q');
  assert.equal(R.rank(idx, q(words.join(' ')), {}).truncated, true);
});
