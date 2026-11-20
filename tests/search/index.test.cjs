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

test('average field lengths', () => {
  const idx = I.fromChunks([chunk('k1', 'x.md', 'Alpha Beta', 'one two three'), chunk('k2', 'y.md', '', 'four')]);
  const s = idx.stats();
  assert.equal(s.avg.h, 1); // 2 + 0 over 2 docs
  assert.equal(s.avg.b, 2); // 3 + 1 over 2 docs
});
