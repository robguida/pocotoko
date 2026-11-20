'use strict';
// index.cjs: in-memory inverted index with positions, sorted vocabulary, length buckets (spec 9.5, 9.6).

const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../../src/search/server/index.cjs');

function chunk(key, path, heading, text) {
  return { key, path, heading, trail: heading, line: 1, date: null, flag: 'unmarked', successor: null, text };
}

test('fields: heading, body (without its own heading line) and file name', () => {
  const idx = I.fromChunks([chunk('k1', 'docs/deploy-guide.md', 'Rollback', '## Rollback\nrun the rollback script')]);
  const pl = idx.postingsFor('rollback');
  const e = pl.get(0);
  assert.equal(e.h, 1);
  assert.equal(e.b, 1); // the heading line is not counted in the body
  assert.equal(e.n, 0);
  assert.equal(idx.postingsFor('deploy').get(0).n, 1);
  assert.equal(idx.postingsFor('guide').get(0).n, 1);
});

test('body positions are stored', () => {
  const idx = I.fromChunks([chunk('k1', 'a.md', '', 'deploy the new rollback deploy')]);
  assert.deepEqual(idx.postingsFor('deploy').get(0).pos, [0, 4]);
  assert.deepEqual(idx.postingsFor('rollback').get(0).pos, [3]);
});

test('remove and removePath drop postings, lengths and vocabulary entries', () => {
  const idx = I.fromChunks([
    chunk('k1', 'a.md', '', 'alpha beta'),
    chunk('k2', 'a.md', '', 'gamma'),
    chunk('k3', 'b.md', '', 'alpha'),
  ]);
  assert.equal(idx.stats().docs, 3);
  assert.equal(idx.removePath('a.md'), 2);
  assert.equal(idx.stats().docs, 1);
  assert.equal(idx.postingsFor('beta'), null);
  assert.deepEqual(idx.vocab(), ['alpha']); // the name `b` is one character and dropped
  assert.equal(idx.docIdForKey('k1'), null);
  assert.deepEqual([...idx.paths()], ['b.md']);
});

test('B6 review 3: hasPath and paths() follow a per-file chunk count, so a query never walks every chunk', () => {
  const idx = I.fromChunks([
    chunk('k1', 'a.md', '', 'alpha'),
    chunk('k2', 'a.md', '', 'beta'),
    chunk('k3', 'b.md', '', 'gamma'),
  ]);
  assert.equal(idx.hasPath('a.md'), true);
  assert.equal(idx.hasPath('c.md'), false);
  assert.deepEqual([...idx.paths()].sort(), ['a.md', 'b.md']);
  idx.remove('k1');
  assert.equal(idx.hasPath('a.md'), true); // one chunk of a.md is left
  idx.remove('k2');
  assert.equal(idx.hasPath('a.md'), false);
  idx.add(chunk('k3', 'c.md', '', 'gamma')); // same key, new file: the old path goes
  assert.equal(idx.hasPath('b.md'), false);
  assert.equal(idx.hasPath('c.md'), true);
  assert.deepEqual([...idx.paths()], ['c.md']);
});

test('adding a chunk with an existing key replaces it', () => {
  const idx = I.createIndex();
  idx.add(chunk('k1', 'a.md', '', 'alpha'));
  idx.add(chunk('k1', 'a.md', '', 'beta'));
  assert.equal(idx.stats().docs, 1);
  assert.equal(idx.postingsFor('alpha'), null);
});

test('sorted vocabulary, length buckets and prefix look-up', () => {
  const idx = I.fromChunks([chunk('k1', 'x.md', '', 'deploy deployed deploying zebra rollback')]);
  assert.deepEqual(idx.vocab(), ['deploy', 'deployed', 'deploying', 'rollback', 'zebra']);
  assert.deepEqual(idx.bucket(8), ['deployed', 'rollback']);
  assert.deepEqual(idx.bucket(5), ['zebra']);
  assert.deepEqual(idx.termsWithPrefix('deploy', 10), ['deploy', 'deployed', 'deploying']);
  assert.deepEqual(idx.termsWithPrefix('deploy', 2), ['deploy', 'deployed']);
  assert.deepEqual(idx.termsWithPrefix('nope', 10), []);
});

// ---------------------------------------------------------------------------
// B6 review fix 1: the sorted list, the length buckets and the family map are kept
// up to date as words come and go; only a real change of the word set touches them.

/** Synthetic a-z words: 'w' + i written in base 26, padded to `len` letters. */
function synthWord(i, len = 6) {
  let s = '';
  let n = i;
  for (let j = 0; j < len - 1; j++) { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
  return 'w' + s;
}

test('B6 review: a change that adds no new word rebuilds nothing; a new word is merged in, never a full re-sort', () => {
  const idx = I.fromChunks([
    chunk('k1', 'a.md', '', 'deploy deployed rollback zebra'),
    chunk('k2', 'b.md', '', 'deploy zebra'),
  ]);
  // Warm every look-up once.
  idx.vocab();
  idx.bucket(6);
  assert.deepEqual(idx.familyTerms('deploy'), ['deploy', 'deployed']);
  const before = idx.upkeep();
  assert.equal(before.familyBuilds, 0); // the family map is never built whole
  // Same words only: add, replace and remove chunks.
  idx.add(chunk('k3', 'c.md', '', 'zebra deploy'));
  idx.add(chunk('k3', 'c.md', '', 'rollback deployed'));
  idx.remove('k2');
  idx.remove('k3');
  assert.deepEqual(idx.vocab(), ['deploy', 'deployed', 'rollback', 'zebra']); // every word is still held by k1
  assert.deepEqual(idx.upkeep(), before);
  assert.deepEqual(idx.familyTerms('deploy'), ['deploy', 'deployed']);
  // A new word: merged into the list, its bucket and its family; no full sort.
  idx.add(chunk('k4', 'd.md', '', 'deploying'));
  assert.deepEqual(idx.vocab().filter((t) => t.startsWith('deploy')), ['deploy', 'deployed', 'deploying']);
  assert.deepEqual(idx.bucket(9), ['deploying']);
  assert.deepEqual(idx.familyTerms('deploy'), ['deploy', 'deployed', 'deploying']);
  const after = idx.upkeep();
  assert.equal(after.sorts, before.sorts);
  assert.equal(after.familyBuilds, 0);
  assert.equal(after.merges, before.merges + 1);
  // Its last chunk removed: the word leaves the list, the bucket and the family.
  idx.remove('k4');
  assert.deepEqual(idx.bucket(9), []);
  assert.deepEqual(idx.familyTerms('deploy'), ['deploy', 'deployed']);
  assert.equal(idx.upkeep().sorts, before.sorts);
});

test('B6 review: after many adds and removes, the kept-up lists equal a fresh build of the same chunks', () => {
  const words = ['deploy', 'deploys', 'deployed', 'run', 'runs', 'running', 'zebra', 'zebras', 'TESTS', 'tests', 'testing', 'résumé', 'v2tests', 'add', 'adding'];
  const live = new Map();
  const idx = I.createIndex();
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let step = 0; step < 400; step++) {
    const key = 'k' + rnd(12);
    if (rnd(3) === 0) { idx.remove(key); live.delete(key); } else {
      const text = [words[rnd(words.length)], words[rnd(words.length)], words[rnd(words.length)]].join(' ');
      const c = chunk(key, key + '.md', '', text);
      idx.add(c);
      live.set(key, c);
    }
    if (step % 37 === 0) { idx.vocab(); idx.bucket(5); idx.familyTerms('run'); }
  }
  const fresh = I.fromChunks([...live.values()]);
  assert.deepEqual(idx.vocab(), fresh.vocab());
  for (let len = 1; len <= 12; len++) assert.deepEqual(idx.bucket(len), fresh.bucket(len), 'bucket ' + len);
  for (const key of ['deploy', 'run', 'zebra', 'test', 'add', 'résumé', 'v2tests', 'k0', 'md']) {
    assert.deepEqual(idx.familyTerms(key), fresh.familyTerms(key), key);
  }
});

test('B6 review: a broad query right after a change stays within the query budget on a large vocabulary', () => {
  const R = require('../../src/search/server/rank.cjs');
  const T = require('../../src/search/server/tokenize.cjs');
  const N = 300000;
  const PER = 2000;
  const idx = I.createIndex();
  for (let i = 0; i < N; i += PER) {
    const ws = [];
    for (let j = i; j < Math.min(N, i + PER); j++) ws.push(synthWord(j));
    idx.add(chunk('c' + i, `f${i}.md`, '', ws.join(' ')));
  }
  idx.prepare(); // what the store does at the end of a refresh
  assert.ok(idx.stats().terms >= N);
  const query = T.parseQuery(['quartzes', synthWord(12345), synthWord(54321) + 's'].join(' '));
  R.rank(idx, query, { matching: 'broad' }); // warm
  // A change that adds no new word, then one that adds a new word.
  idx.add(chunk('c0', 'f0.md', '', synthWord(1) + ' ' + synthWord(2)));
  let t0 = Date.now();
  let r = R.rank(idx, query, { matching: 'broad' });
  let took = Date.now() - t0;
  assert.equal(r.partial, false, `no new word: took ${took} ms`);
  assert.ok(took < R.QUERY_BUDGET_MS, `no new word: took ${took} ms`);
  idx.add(chunk('new', 'new.md', '', 'quartz ' + synthWord(N + 1)));
  t0 = Date.now();
  r = R.rank(idx, query, { matching: 'broad' });
  took = Date.now() - t0;
  assert.equal(r.partial, false, `new word: took ${took} ms`);
  assert.ok(took < R.QUERY_BUDGET_MS, `new word: took ${took} ms`);
  assert.ok(r.results.some((x) => x.key === 'new'));
});

test('average field lengths', () => {
  const idx = I.fromChunks([chunk('k1', 'x.md', 'Alpha Beta', 'one two three'), chunk('k2', 'y.md', '', 'four')]);
  const s = idx.stats();
  assert.equal(s.avg.h, 1); // 2 + 0 over 2 docs
  assert.equal(s.avg.b, 2); // 3 + 1 over 2 docs
});
