'use strict';
// chunker.cjs (spec 9.3, SR-14): cuts, trails, lines, sizes, UTF-8 safety, dates.

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../src/search/server/chunker.cjs');
const F = require('../helpers/fake-values.cjs');

const NINE = ['date', 'flag', 'heading', 'key', 'line', 'path', 'successor', 'text', 'trail'];

test('chunk record holds the nine fields; the stored form holds exactly those', () => {
  const [c] = C.chunkText('docs/a.md', '# Title\nbody text\n');
  for (const k of NINE) assert.ok(Object.prototype.hasOwnProperty.call(c, k), k);
  assert.deepEqual(Object.keys(C.storedRecord(c)).sort(), NINE);
  assert.equal(c.path, 'docs/a.md');
  assert.equal(c.flag, 'unmarked');
  assert.equal(c.successor, null);
  assert.match(c.key, /^[0-9a-f]{32}$/);
});

test('Markdown is cut at heading levels 1 to 4; a level-5 heading does not cut', () => {
  const text = ['# A', 'a', '## B', 'b', '### C', 'c', '#### D', 'd', '##### E', 'e', ''].join('\n');
  const cs = C.chunkText('x.md', text);
  assert.deepEqual(cs.map((c) => c.heading), ['A', 'B', 'C', 'D']);
  assert.ok(cs[3].text.includes('##### E'));
});

test('heading trail and start line', () => {
  const text = ['intro', '# A', 'a', '## B', 'b', '### C', 'c', '## B2', 'x', ''].join('\n');
  const cs = C.chunkText('x.md', text);
  assert.deepEqual(cs.map((c) => c.trail), ['', 'A', 'A › B', 'A › B › C', 'A › B2']);
  assert.deepEqual(cs.map((c) => c.line), [1, 2, 4, 6, 8]);
});

test('a heading inside fenced code does not cut', () => {
  const text = ['# A', '```', '# not a heading', '```', 'after', ''].join('\n');
  const cs = C.chunkText('x.md', text);
  assert.equal(cs.length, 1);
});

test('a section over 4,000 characters splits at a paragraph break', () => {
  const para = 'word '.repeat(150).trim(); // 749 characters
  const text = '# Big\n' + Array.from({ length: 10 }, () => para).join('\n\n') + '\n';
  const cs = C.chunkText('x.md', text);
  assert.ok(cs.length >= 2);
  for (const c of cs) {
    assert.equal(c.heading, 'Big');
    assert.ok(c.text.length <= C.SECTION_SOFT_CHARS + para.length + 2);
  }
  assert.equal(cs.map((c) => c.text).join(''), text);
  // Each later piece starts at a paragraph start.
  for (const c of cs.slice(1)) assert.ok(c.text.startsWith('word'));
});

test('plain text splits at blank lines near 2,000 characters', () => {
  const para = 'text '.repeat(100).trim(); // 499 characters
  const text = Array.from({ length: 12 }, () => para).join('\n\n');
  const cs = C.chunkText('notes.txt', text);
  assert.ok(cs.length >= 3);
  for (const c of cs) {
    assert.equal(c.heading, '');
    assert.ok(c.text.length <= C.TEXT_CHUNK_CHARS + para.length + 2);
  }
  assert.equal(cs.map((c) => c.text).join(''), text);
});

test('a run with no break past 16,384 bytes cuts at the last white space', () => {
  const text = 'x'.repeat(10000) + ' ' + 'y'.repeat(10000);
  const cs = C.chunkText('a.txt', text);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].text, 'x'.repeat(10000) + ' ');
  for (const c of cs) assert.ok(Buffer.byteLength(c.text) <= C.CHUNK_MAX_BYTES);
});

test('no white space: cut at the last whole character, never inside a UTF-8 sequence', () => {
  const euro = '€'; // 3 bytes
  const text = 'a'.repeat(16383) + euro + 'b'.repeat(10);
  const cs = C.chunkText('a.txt', text);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].text, 'a'.repeat(16383));
  assert.ok(cs[1].text.startsWith(euro));
  assert.equal(cs.map((c) => c.text).join(''), text);
  for (const c of cs) {
    assert.ok(Buffer.byteLength(c.text) <= C.CHUNK_MAX_BYTES);
    assert.equal(Buffer.from(c.text, 'utf8').toString('utf8'), c.text);
  }
});

test('every chunk of a large mixed file stays within 16,384 bytes', () => {
  const text = '# H\n' + 'é中'.repeat(20000);
  for (const c of C.chunkText('a.md', text)) assert.ok(Buffer.byteLength(c.text) <= C.CHUNK_MAX_BYTES);
});

test('date: file name first, else front matter, else none; never the modified time', () => {
  const d1 = F.isoDate(2000 + 25, 1, 2);
  const d2 = F.isoDate(2000 + 24, 11, 30);
  assert.equal(C.fileDate(`notes/${d1}-plan.md`, `---\ndate: ${d2}\n---\nx`), d1);
  assert.equal(C.fileDate('notes/plan.md', `---\ntitle: x\ndate: ${d2}\n---\nx`), d2);
  assert.equal(C.fileDate('notes/plan.md', 'no front matter'), null);
  const cs = C.chunkText(`${d1}.md`, '# A\nx\n## B\ny\n');
  assert.ok(cs.every((c) => c.date === d1));
});

test('front matter is not read as a heading cut', () => {
  const d = F.isoDate(2000 + 24, 5, 6);
  const cs = C.chunkText('a.md', `---\ndate: ${d}\n---\n# Title\nbody\n`);
  assert.deepEqual(cs.map((c) => c.heading), ['', 'Title']);
  assert.equal(cs[1].line, 4);
});

test('bodyText drops only the chunk own heading line', () => {
  const [c] = C.chunkText('a.md', '## Rollback\nrun it\n');
  assert.equal(C.bodyText(c), 'run it\n');
});
