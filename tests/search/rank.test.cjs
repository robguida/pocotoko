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
  const r = R.rank(idx, q('deploy'), { k: 5 });
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
  const r = R.rank(idx, q('rollback'), {});
  assert.equal(r.results[0].key, 'head');
});

test('OR across words: a chunk with both words ranks above one with either', () => {
  const idx = I.fromChunks([
    chunk('one', 'p1.md', '', 'deploy filler text here'),
    chunk('both', 'p2.md', '', 'deploy rollback text here'),
    chunk('other', 'p3.md', '', 'rollback filler text here'),
  ]);
  const r = R.rank(idx, q('deploy rollback'), {});
  assert.equal(r.results[0].key, 'both');
  assert.equal(r.results.length, 3);
});

test('k: default 5; 1 and 10 accepted; 0, 11, -1, 1.5 and a string are errors, never clamped', () => {
  const chunks = [];
  for (let i = 0; i < 12; i++) chunks.push(chunk('k' + i, `f${String(i).padStart(2, '0')}.md`, '', 'deploy notes'));
  const idx = I.fromChunks(chunks);
  assert.equal(R.rank(idx, q('deploy'), {}).results.length, 5);
  assert.equal(R.rank(idx, q('deploy'), { k: 1 }).results.length, 1);
  assert.equal(R.rank(idx, q('deploy'), { k: 10 }).results.length, 10);
  for (const bad of [0, 11, -1, 1.5, '5', null, NaN]) {
    assert.throws(() => R.rank(idx, q('deploy'), { k: bad }), { name: 'InvalidArgument' });
  }
  assert.throws(() => R.rank(idx, q('deploy'), { includeRetired: 'yes' }), { name: 'InvalidArgument' });
});

test('at most 2 results per file', () => {
  const idx = I.fromChunks([
    chunk('a1', 'a.md', '', 'deploy deploy deploy', { line: 1 }),
    chunk('a2', 'a.md', '', 'deploy deploy deploy', { line: 5 }),
    chunk('a3', 'a.md', '', 'deploy deploy deploy', { line: 9 }),
    chunk('b1', 'b.md', '', 'deploy'),
  ]);
  const r = R.rank(idx, q('deploy'), { k: 10 });
  assert.equal(r.results.filter((x) => x.path === 'a.md').length, 2);
  assert.equal(r.results.length, 3);
});

test('tie-breaks: flag order, then the shorter path', () => {
  const idx = I.fromChunks([
    chunk('long', 'zz/longer.md', '', 'deploy text'),
    chunk('unc', 'aa.md', '', 'deploy text', { flag: 'unconfirmed' }),
    chunk('short', 'bb.md', '', 'deploy text'),
  ]);
  const r = R.rank(idx, q('deploy'), {});
  // Same text, same lengths, but the file-name field is off in `exact`, so the scores tie.
  assert.equal(r.results[0].score, r.results[1].score);
  assert.deepEqual(r.results.map((x) => x.key), ['short', 'long', 'unc']);
});

test('T-19: superseded text ranks below unmarked text of the same score and is never hidden', () => {
  const idx = I.fromChunks([
    chunk('old', 'a.md', '', 'deploy text', { flag: 'superseded', successor: 'b.md' }),
    chunk('new', 'b.md', '', 'deploy text'),
  ]);
  const r = R.rank(idx, q('deploy'), {});
  assert.deepEqual(r.results.map((x) => x.key), ['new', 'old']);
  assert.equal(r.results[1].flag, 'superseded');
  assert.equal(r.results[1].successor, 'b.md');
});

test('T-19: cancelled text is hidden by default, at most 3 named with no text; include_retired shows it', () => {
  const chunks = [chunk('live', 'live.md', '', 'deploy')];
  for (let i = 0; i < 5; i++) chunks.push(chunk('c' + i, `gone${i}.md`, 'Plan ' + i, 'deploy secret plan text', { flag: 'cancelled' }));
  const idx = I.fromChunks(chunks);
  const r = R.rank(idx, q('deploy'), { k: 10 });
  assert.deepEqual(r.results.map((x) => x.key), ['live']);
  assert.equal(r.hidden.length, 3);
  assert.equal(r.hiddenCount, 5);
  for (const h of r.hidden) {
    assert.deepEqual(Object.keys(h).sort(), ['heading', 'path']);
    assert.ok(!JSON.stringify(h).includes('secret plan text'));
  }
  const all = R.rank(idx, q('deploy'), { k: 10, includeRetired: true });
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
  const r = R.rank(idx, q('deploy'), { k: 10 });
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

test('a truncated query is reported', () => {
  const idx = I.fromChunks([chunk('x', 'a.md', '', 'deploy')]);
  const words = [];
  for (let i = 0; i < 40; i++) words.push('w' + String(i).padStart(2, '0') + 'q');
  assert.equal(R.rank(idx, q(words.join(' ')), {}).truncated, true);
});
