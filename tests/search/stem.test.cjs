'use strict';
// stem.cjs: light English stemmer tables, when it applies, the word_families option (spec 7.2 a, 9.5 phase 2 a, 9.13).

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../src/search/server/stem.cjs');

// Each row: words that must share one stem (a word family).
const FAMILIES = [
  ['deploy', 'deployed', 'deploying', 'deploys'],
  ['test', 'tests', 'tested', 'testing'],
  ['note', 'notes', 'noted', 'noting'],
  ['hope', 'hoped', 'hoping', 'hopes'],
  ['release', 'released', 'releasing', 'releases'],
  ['policy', 'policies'],
  ['apply', 'applied', 'applies', 'applying'],
  ['copy', 'copied', 'copies', 'copying'],
  ['run', 'runs', 'running'],
  ['roll', 'rolled', 'rolling', 'rolls'],
  ['class', 'classes'],
  ['process', 'processes', 'processed', 'processing'],
  ['agree', 'agreed', 'agrees'],
  ['need', 'needed', 'needs'],
  ['add', 'added', 'adding', 'adds'],
  ['size', 'sized', 'sizes'],
  ['code', 'coded', 'codes', 'coding'],
  ['cache', 'caches', 'cached'],
  ['patch', 'patches', 'patched'],
  ['issue', 'issues', 'issued'],
  ['relate', 'related', 'relating'],
  ['make', 'makes', 'making'],
  ['invoice', 'invoices', 'invoiced'],
  ['table', 'tables'],
  ['migrate', 'migrated', 'migrating', 'migrates'],
  ['restore', 'restored', 'restoring'],
  ['fix', 'fixes', 'fixed', 'fixing'],
  ['box', 'boxes', 'boxed'],
];

// Words the rules leave alone (or that must not join another family).
const UNCHANGED = ['status', 'analysis', 'thing', 'string', 'speed', 'need', 'class', 'roll', 'deploy'];

test('stem table: every word of a family has the same family key', () => {
  for (const fam of FAMILIES) {
    // A 3-letter member is never stemmed: its family key is the word itself (B6 review fix 6).
    const keys = new Set(fam.map((w) => S.familyKey(w)));
    assert.equal(keys.size, 1, fam.join(' ') + ' -> ' + [...keys].join(' '));
    assert.ok(!keys.has(null), fam.join(' '));
  }
});

test('family key: a 3-letter all-ASCII-letter word is its own key; 1 or 2 letters, an acronym or another letter → none', () => {
  assert.equal(S.familyKey('run'), 'run');
  assert.equal(S.familyKey('running'), 'run');
  assert.equal(S.familyKey('fixes'), 'fix');
  assert.equal(S.familyKey('add'), 'add');
  assert.equal(S.familyKey('adds'), 'add');
  assert.equal(S.familyKey('run', true), null); // `RUN` caught by the acronym rule
  assert.equal(S.familyKey('runs', true), null);
  for (const w of ['go', 'x', '', 'v2t', 'é', 'déj', 'Run', 5, null]) assert.equal(S.familyKey(w), null, String(w));
  assert.equal(S.familyKey('goes'), 'goe'); // and the 2-letter `go` has no key, so the two never meet
});

test('stem table: known stems', () => {
  const want = {
    deployed: 'deploy', deploying: 'deploy', tests: 'test', notes: 'note', noted: 'note', hopping: 'hop',
    policies: 'policy', applied: 'apply', running: 'run', rolling: 'roll', classes: 'class', agreed: 'agre',
    added: 'add', sized: 'size', caches: 'cach', patches: 'patch', related: 'relat', making: 'make',
    fixes: 'fix', boxes: 'box', taxes: 'tax', annexes: 'annex',
  };
  for (const [w, s] of Object.entries(want)) assert.equal(S.stem(w), s, w);
  for (const w of UNCHANGED) assert.equal(S.stem(w), w, w);
});

test('different words stay apart', () => {
  assert.notEqual(S.stem('deploy'), S.stem('develop'));
  assert.notEqual(S.stem('hope'), S.stem('hop'));
  assert.notEqual(S.stem('notes'), S.stem('nothing'));
});

test('when it applies: only all-ASCII a-z words of 4 or more letters, never an acronym', () => {
  assert.equal(S.eligible('tests'), true);
  assert.equal(S.eligible('runs'), true);
  assert.equal(S.eligible('run'), false); // 3 letters
  assert.equal(S.eligible('cafés'), false); // a letter outside a-z
  assert.equal(S.eligible('résumés'), false);
  assert.equal(S.eligible('v2tests'), false); // a digit
  assert.equal(S.eligible('tests', true), false); // caught by the acronym rule
  assert.equal(S.eligible('Tests'), false); // only lower-cased words reach the stemmer
  // A word the rule does not cover comes back unchanged.
  for (const w of ['cafés', 'résumés', 'v2tests', 'run', 'bed', 'क्षमता']) assert.equal(S.stem(w), w);
});

test('a stem is never shorter than 3 letters', () => {
  for (const w of ['used', 'sing', 'bring', 'king', 'shed', 'seed', 'ties', 'dies']) assert.ok(S.stem(w).length >= 3, w);
  assert.equal(S.stem('sing'), 'sing');
});

test('word_families option: english (default) or off; anything else is the default', () => {
  assert.deepEqual(S.MODES, ['english', 'off']);
  assert.equal(S.parseMode('english'), 'english');
  assert.equal(S.parseMode('off'), 'off');
  assert.equal(S.parseMode(' OFF '), 'off');
  for (const bad of [undefined, null, '', 'french', 5, true, '$' + '{user_config.word_families}']) assert.equal(S.parseMode(bad), 'english');
});

test('B6 review 2: nothing persisted depends on stems, so the stemmer carries no version number', () => {
  // The family map is built in memory from the raw words (index.cjs); the store and the
  // tokenizer_version input never load the stemmer, so a stemmer change needs no rebuild.
  assert.equal('STEM_REVISION' in S, false);
  const fs = require('node:fs');
  const path = require('node:path');
  const server = path.join(__dirname, '..', '..', 'src', 'search', 'server');
  for (const f of ['store.cjs', 'tokenize.cjs', 'chunker.cjs']) {
    assert.ok(!fs.readFileSync(path.join(server, f), 'utf8').includes('stem.cjs'), f);
  }
});
