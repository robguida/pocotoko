'use strict';
// tokenize.cjs: word rules, stop words, tokenizer_version, query limits (spec 9.5, SR-28; T-16 query part).

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../../src/search/server/tokenize.cjs');

test('1-character words are dropped', () => {
  assert.deepEqual(T.words('a b c deploy x'), ['deploy']);
});

test('a 2-character stop word is dropped; other 2-character words are kept', () => {
  assert.deepEqual(T.words('it is ok go'), ['ok', 'go']);
});

test('acronyms CI, DB, AI, IT, S3 are kept as written (lower-cased)', () => {
  assert.deepEqual(T.words('CI DB AI IT S3'), ['ci', 'db', 'ai', 'it', 's3']);
});

test('a query IT finds the note word IT and not the everyday word it', () => {
  const q = T.parseQuery('IT').words.map((w) => w.w);
  assert.deepEqual(q, ['it']);
  assert.ok(T.words('the IT team').includes('it'));
  assert.ok(!T.words('it works').includes('it'));
  assert.ok(!T.words('It works').includes('it'));
  assert.equal(T.parseQuery('it').empty, true);
});

test('acronym rule stops at 5 characters: a 6-letter all-upper stop word is dropped', () => {
  assert.deepEqual(T.words('ABOUT'), ['about']); // 5 letters: kept by the acronym rule
  assert.deepEqual(T.words('BEFORE'), []); // 6 letters: not an acronym, stop word
});

test('words are lower-cased and remaining stop words dropped', () => {
  assert.deepEqual(T.words('The Deploy and the Rollback'), ['deploy', 'rollback']);
});

test('Unicode letters and digits form words; combining marks stay inside a word', () => {
  assert.deepEqual(T.words('café näive 42x'), ['café', 'näive'.normalize('NFC'), '42x']);
  assert.deepEqual(T.words('क्षमता'), ['क्षमता']);
});

test('positions count every word, kept or not', () => {
  assert.deepEqual(T.tokenize('deploy the new rollback'), [
    { w: 'deploy', pos: 0 }, { w: 'new', pos: 2 }, { w: 'rollback', pos: 3 },
  ]);
});

test('changing the stop-word list changes tokenizer_version', () => {
  const base = T.tokenizerVersion();
  assert.equal(base, T.TOK_VERSION);
  assert.notEqual(T.tokenizerVersion([...T.STOP_WORDS, 'zzz']), base);
  assert.notEqual(T.tokenizerVersion(T.STOP_WORDS.slice(1)), base);
});

test('nameWords uses the base name without its extension', () => {
  assert.deepEqual(T.nameWords('docs/deploy-guide.md'), ['deploy', 'guide']);
});

test('query: over 512 characters is rejected with a named error; 512 is accepted', () => {
  assert.throws(() => T.parseQuery('a'.repeat(513)), { name: 'QueryTooLong' });
  assert.doesNotThrow(() => T.parseQuery('ab '.repeat(170) + 'ab'));
  assert.throws(() => T.parseQuery(5), { name: 'InvalidArgument' });
});

test('query: 33 words → the first 32 are used and the result says so', () => {
  const ws = [];
  for (let i = 0; i < 33; i++) ws.push('w' + String(i).padStart(2, '0') + 'x');
  const q = T.parseQuery(ws.join(' '));
  assert.equal(q.words.length, 32);
  assert.equal(q.truncated, true);
  assert.equal(q.words[31].w, 'w31x');
  assert.equal(T.parseQuery(ws.slice(0, 32).join(' ')).truncated, false);
});

test('query: a trailing * is recorded per word; repeated words are kept once', () => {
  const q = T.parseQuery('deploy* deploy roll*back');
  assert.deepEqual(q.words, [{ w: 'deploy', wild: true }, { w: 'roll', wild: true }, { w: 'back', wild: false }]);
});

test('T-16 queries: symbols, controls, a lone surrogate and combining-mark runs are plain separators', () => {
  const cases = [
    '.*+?()[]{}^$|\\ deploy',
    '"deploy" \'rollback\'',
    '*', '**', 'de*ploy',
    'deploy\u0000\u0007\u001b rollback',
    'deploy \ud800 rollback',
    'a' + '́'.repeat(10000),
  ];
  for (const c of cases) {
    const q = c.length > T.MAX_QUERY_CHARS ? null : T.parseQuery(c);
    if (q) for (const w of q.words) assert.match(w.w, /^[\p{L}\p{N}\p{M}]+$/u);
  }
  // A word of one letter plus 10,000 combining marks is longer than the word cap and is dropped.
  assert.deepEqual(T.words('a' + '́'.repeat(10000)), []);
  assert.deepEqual(T.parseQuery('deploy \ud800 rollback').words.map((w) => w.w), ['deploy', 'rollback']);
});
