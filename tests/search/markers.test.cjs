'use strict';
// markers.cjs (spec 9.4, SR-48): mark parsing, section and file-wide flags, unconfirmed, suspect_mark.
// Mark lines with dates are built at run time (13.1 e).

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../src/search/server/markers.cjs');
const C = require('../../src/search/server/chunker.cjs');
const F = require('../helpers/fake-values.cjs');

function marked(path, text) {
  return M.applyMarks(C.chunkText(path, text));
}

test('each mark form parses; a leading warning sign and a who part are accepted', () => {
  assert.deepEqual(M.parseMarkLine(F.markLine('superseded', 'notes/new.md')), { kind: 'superseded', successor: 'notes/new.md' });
  assert.deepEqual(M.parseMarkLine(F.markLine('superseded', 'notes/new.md', { sign: true, who: 'someone' })), { kind: 'superseded', successor: 'notes/new.md' });
  assert.deepEqual(M.parseMarkLine(F.markLine('partly', 'a/b.md', { sign: true })), { kind: 'partly', successor: 'a/b.md' });
  assert.deepEqual(M.parseMarkLine(F.markLine('cancelled', '', { who: 'x' })), { kind: 'cancelled', successor: null });
  assert.equal(M.parseMarkLine('⚠️ ' + F.markLine('cancelled')).kind, 'cancelled');
});

test('a line that starts with a mark word but does not parse fully → unconfirmed', () => {
  const good = F.markLine('superseded', 'notes/new.md');
  const word = good.split(' ')[0];
  const date = good.split(' ')[1];
  const bad = [
    `${word} ${date}`, // no successor
    `${word} soon by notes/new.md`, // no date
    `${word} ${date.slice(0, 5)}13-01 by notes/new.md`, // month 13
    `${word} ${date} by /abs/path.md`, // absolute successor
    F.markLine('cancelled').replace(': ', ' '), // no reason
  ];
  for (const b of bad) assert.deepEqual(M.parseMarkLine(b), { kind: 'unconfirmed' }, b);
  assert.equal(M.parseMarkLine('Superseded by the new plan'), null);
  assert.equal(M.parseMarkLine('plain text'), null);
});

test('a mark on the first line under a heading flags the section; elsewhere → partly', () => {
  const first = marked('a.md', ['# Top', 'intro', '## Old', '', F.markLine('superseded', 'b.md'), 'text', '## Other', 'line one', F.markLine('superseded', 'b.md'), ''].join('\n'));
  const by = Object.fromEntries(first.chunks.map((c) => [c.heading, c]));
  assert.equal(by.Top.flag, 'unmarked');
  assert.equal(by.Old.flag, 'superseded');
  assert.equal(by.Old.successor, 'b.md');
  assert.equal(by.Other.flag, 'partly');
});

test('a malformed mark on the first line → unconfirmed', () => {
  const r = marked('a.md', ['# Top', 'x', '## S', 'CANCELLED whenever', 'text', ''].join('\n'));
  assert.equal(r.chunks.find((c) => c.heading === 'S').flag, 'unconfirmed');
});

test('a full mark covers the sections nested under it', () => {
  const r = marked('a.md', ['# Top', 'x', '## Old', F.markLine('cancelled'), '### Child', 'y', '## Next', 'z', ''].join('\n'));
  const by = Object.fromEntries(r.chunks.map((c) => [c.heading, c.flag]));
  assert.deepEqual(by, { Top: 'unmarked', Old: 'cancelled', Child: 'cancelled', Next: 'unmarked' });
});

function fileWithSections(n, mark) {
  const lines = ['# Title', mark, ''];
  for (let i = 1; i < n; i++) lines.push(`## Section ${i}`, `text ${i}`, '');
  return lines.join('\n');
}

test('file-wide mark on exactly 20 chunks stays a mark', () => {
  const r = marked('a.md', fileWithSections(20, F.markLine('superseded', 'b.md')));
  assert.equal(r.chunks.length, 20);
  assert.ok(r.chunks.every((c) => c.flag === 'superseded'));
  assert.equal(r.counts.suspect_mark, 0);
});

test('file-wide mark on 21 chunks → unconfirmed, counted suspect_mark, hides nothing', () => {
  const r = marked('a.md', fileWithSections(21, F.markLine('cancelled')));
  assert.equal(r.chunks.length, 21);
  assert.ok(r.chunks.every((c) => c.flag === 'unconfirmed'));
  assert.equal(r.counts.suspect_mark, 1);
});

test('T-19: a title-block cancel on a 25-chunk file → unconfirmed, nothing hidden', () => {
  const r = marked('a.md', fileWithSections(25, F.markLine('cancelled')));
  assert.ok(r.chunks.every((c) => c.flag === 'unconfirmed'));
});

test('title block is the true first section: when the scan drops the preamble, a later level-1 cancel is not file-wide', () => {
  const S = require('../../src/search/server/scan.cjs');
  const Fl = require('../../src/search/server/floor.cjs');
  const text = ['reach ' + F.fakeEmail() + ' for access', '', '# Old plan', F.markLine('cancelled'), 'old text', '',
    '# Live plan', 'live text', ''].join('\n');
  const chunks = C.chunkText('a.md', text);
  assert.equal(chunks[0].sec, 0);
  const scanned = S.scanFile({ relPath: 'a.md', text, chunks, filter: Fl.buildFilter({}) });
  assert.equal(scanned.dropped.scan_contact, 1); // the preamble is gone
  const r = M.applyMarks(scanned.kept);
  const by = Object.fromEntries(r.chunks.map((c) => [c.heading, c.flag]));
  assert.deepEqual(by, { 'Old plan': 'cancelled', 'Live plan': 'unmarked' });
  // With the preamble kept, the same file is not file-wide either (the title block holds no mark).
  const all = Object.fromEntries(marked('a.md', text).chunks.map((c) => [c.heading, c.flag]));
  assert.equal(all['Live plan'], 'unmarked');
});

test('cancelled wins: a file-wide superseded mark never brings back a section\'s own cancelled text', () => {
  const r = marked('a.md', ['# Title', F.markLine('superseded', 'b.md'), 'intro', '', '## Dropped', F.markLine('cancelled'),
    'never do this', '', '### Under it', 'detail', '', '## Plain', 'text', ''].join('\n'));
  const by = Object.fromEntries(r.chunks.map((c) => [c.heading, c.flag]));
  assert.deepEqual(by, { Title: 'superseded', Dropped: 'cancelled', 'Under it': 'cancelled', Plain: 'superseded' });
  // And a nested superseded mark under a cancelled section stays hidden.
  const n = marked('a.md', ['# Top', 'x', '## Gone', F.markLine('cancelled'), 'y', '', '### Old', F.markLine('superseded', 'b.md'), 'z', ''].join('\n'));
  assert.equal(n.chunks.find((c) => c.heading === 'Old').flag, 'cancelled');
});

test('no mark → unmarked; the who text is never kept', () => {
  const r = marked('a.md', ['# A', F.markLine('superseded', 'b.md', { who: 'boss said so' }), ''].join('\n'));
  assert.equal(r.chunks[0].flag, 'superseded');
  assert.ok(!JSON.stringify(r.chunks.map((c) => ({ flag: c.flag, successor: c.successor }))).includes('boss'));
  assert.equal(marked('b.md', '# A\nnothing here\n').chunks[0].flag, 'unmarked');
});

test('resolveSuccessor: indexed path, relative to the file folder, unresolved, none', () => {
  const paths = new Set(['notes/new.md', 'top.md']);
  assert.equal(M.resolveSuccessor('notes/new.md', 'notes/old.md', paths), 'notes/new.md');
  assert.equal(M.resolveSuccessor('new.md', 'notes/old.md', paths), 'notes/new.md');
  assert.equal(M.resolveSuccessor('../top.md', 'notes/old.md', paths), 'top.md');
  assert.equal(M.resolveSuccessor('gone.md', 'notes/old.md', paths), 'unresolved');
  assert.equal(M.resolveSuccessor('../../x.md', 'notes/old.md', paths), 'unresolved');
  assert.equal(M.resolveSuccessor(null, 'a.md', paths), null);
});
