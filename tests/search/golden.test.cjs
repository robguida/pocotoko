'use strict';
// Golden set (spec 15.2 golden.test.cjs, 7.2): a fixed synthetic corpus of about 40 notes and
// 20 questions, run through the real store (walk, floor, scan, chunk, index, rank).
// Phase 1 (exact) ranks each exact-word question's file first. Phase 2 (broad) ranks every
// question's file first, including the reworded ones (plural, family, wildcard, prefix, typo,
// synonym) that phase 1 does not find in its top 5, and labels how it matched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_TOP } = require('../helpers/tmpdir-sandbox.cjs');
const { makeRun, openStore, cleanupRuns } = require('../helpers/search-run.cjs');

test.after(() => cleanupRuns());

const GOLDEN = JSON.parse(fs.readFileSync(path.join(REPO_TOP, 'tests', 'fixtures', 'golden-set.json'), 'utf8'));

async function goldenStore() {
  const run = makeRun('golden', GOLDEN.notes);
  const store = openStore(run, { options: { synonyms: GOLDEN.synonyms } });
  const r = await store.refresh();
  return { store, r };
}

test('golden set: corpus and questions are the fixed size the spec names', async () => {
  const n = Object.keys(GOLDEN.notes).length;
  assert.ok(n >= 38 && n <= 45, `notes ${n}`);
  assert.equal(GOLDEN.queries.length, 20);
  const kinds = new Set(GOLDEN.queries.map((x) => x.kind));
  for (const k of ['exact', 'plural', 'prefix', 'typo', 'synonym']) assert.ok(kinds.has(k), k);
  const { r } = await goldenStore();
  assert.equal(r.succeeded, n); // every note passes the floor and the scan
  assert.equal(r.failed, 0);
});

test('golden set: phase 1 ranks each exact-word question first; phase 2 keeps it first', async () => {
  const { store } = await goldenStore();
  for (const g of GOLDEN.queries.filter((x) => x.kind === 'exact')) {
    const p1 = await store.search(g.q, { matching: 'exact' });
    assert.equal(p1.results[0] && p1.results[0].path, g.expect, `phase 1: ${g.q}`);
    for (const res of p1.results) assert.deepEqual(res.matched_by, ['exact']);
    const p2 = await store.search(g.q, { matching: 'broad' });
    assert.equal(p2.results[0] && p2.results[0].path, g.expect, `phase 2: ${g.q}`);
    assert.ok(p2.results[0].matched_by.includes('exact'), g.q);
  }
});

test('golden set: phase 2 ranks each reworded question first, where phase 1 does not find it in the top 5', async () => {
  const { store } = await goldenStore();
  for (const g of GOLDEN.queries.filter((x) => x.kind !== 'exact')) {
    const p1 = await store.search(g.q, { matching: 'exact' });
    assert.ok(!p1.results.slice(0, 5).some((x) => x.path === g.expect), `phase 1 should miss: ${g.q}`);
    const p2 = await store.search(g.q, { matching: 'broad' });
    assert.equal(p2.results[0] && p2.results[0].path, g.expect, `phase 2: ${g.q} -> ${p2.results.map((x) => x.path).join(', ')}`);
    assert.ok(p2.results[0].matched_by.includes(g.via), `${g.q}: ${p2.results[0].matched_by.join(',')}`);
  }
});

test('golden set: without the synonym list, the synonym questions are not found; with word_families off, the family ones lose their family match', async () => {
  const { store } = await goldenStore();
  // No synonym list, every other option at its default (word families on): isolates the list.
  const noSyn = openStore(makeRun('golden-nosyn', GOLDEN.notes));
  await noSyn.refresh();
  assert.equal(noSyn.status().wordFamilies, 'english');
  const run = makeRun('golden-plain', GOLDEN.notes);
  const plain = openStore(run, { options: { word_families: 'off' } });
  await plain.refresh();
  const synQs = GOLDEN.queries.filter((x) => x.kind === 'synonym');
  const famQs = GOLDEN.queries.filter((x) => x.via === 'family');
  assert.ok(synQs.length >= 3 && famQs.length >= 2);
  for (const g of synQs) {
    // With the list the expected file is first; without it, not found at all (k 10, the most a call may ask).
    assert.equal((await store.search(g.q)).results[0].path, g.expect, g.q);
    const r = await noSyn.search(g.q, { k: 10 });
    assert.ok(!r.results.some((x) => x.path === g.expect), `${g.q}: ${r.results.map((x) => x.path).join(', ')}`);
  }
  for (const g of famQs) {
    const on = (await store.search(g.q, { k: 10 })).results.find((x) => x.path === g.expect);
    const off = (await plain.search(g.q, { k: 10 })).results.find((x) => x.path === g.expect);
    assert.ok(on && on.matched_by.includes('family'), g.q); // with families on, found by family
    // Off: the expected file is either not found, or found only by another kind of match
    // (a near spelling here), and then with a lower score than its family match.
    if (off) {
      assert.ok(!off.matched_by.includes('family'), `${g.q}: ${off.matched_by.join(',')}`);
      assert.ok(off.score < on.score, `${g.q}: ${off.score} vs ${on.score}`);
    }
  }
});

test('golden set: the same question gives the same order every time (deterministic ranking)', async () => {
  const { store } = await goldenStore();
  for (const g of GOLDEN.queries) {
    const a = (await store.search(g.q, { k: 10 })).results.map((x) => [x.path, x.line, x.score]);
    const b = (await store.search(g.q, { k: 10 })).results.map((x) => [x.path, x.line, x.score]);
    assert.deepEqual(b, a, g.q);
  }
});
