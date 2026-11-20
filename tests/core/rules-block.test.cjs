'use strict';
// Spec 5.1, 5.2, 6.6, 14.3, 15.1: the model-routing skill and the rules block template.
// This file covers the routing-block rows of the consistency list in depth (wording, hard
// lines); tests/core/consistency.test.cjs (B3) repeats the identity, line-limit and marker
// checks against the block session-start.cjs extracts. Nothing here depends on that file.
// Every banned-shape value is built at run time, so this source holds no literal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_TOP = path.resolve(__dirname, '..', '..');
const SKILL = path.join(REPO_TOP, 'src', 'core', 'skills', 'model-routing', 'SKILL.md');
const TEMPLATE = path.join(REPO_TOP, 'src', 'core', 'templates', 'rules-block.md');
const START = '<!-- routing-block:start -->';
const END = '<!-- routing-block:end -->';
// The real string is owned by session-start.cjs (B3); spec 5.1 b gives its wording.
const { YOURS_WIN } = require('../../src/core/hooks/session-start.cjs');
assert.equal(YOURS_WIN, 'If your own rules file already sets model and effort rules, yours win.');
const VAR_BASE = ['CLAUDE', 'CODE', 'SUBAGENT', 'MODEL'].join('_');
const VAR_FORCE = VAR_BASE + '_FORCE';
const ALLOWED_URLS = ['https://code.claude.com/docs/en/sub-agents.md', 'https://code.claude.com/docs/en/prompt-caching.md'];

const skillText = fs.readFileSync(SKILL, 'utf8');
const templateText = fs.readFileSync(TEMPLATE, 'utf8');

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}
function extractBlock(text) {
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  assert.ok(a >= 0 && b > a, 'markers present, start before end');
  return text.slice(a + START.length, b);
}
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'skill starts with a frontmatter block');
  const keys = {};
  for (const line of m[1].split('\n')) {
    const k = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (k) keys[k[1]] = k[2];
  }
  return keys;
}

test('markers appear once each, in the skill and in the template (5.1)', () => {
  for (const text of [skillText, templateText]) {
    assert.equal(count(text, START), 1);
    assert.equal(count(text, END), 1);
  }
});

test('the routing block is identical in the skill and the template (5.1 c)', () => {
  assert.equal(extractBlock(skillText), extractBlock(templateText));
});

test('the template is the markers around exactly that block, nothing else', () => {
  assert.equal(templateText, START + extractBlock(skillText) + END + '\n');
});

test('the block is at most 25 lines (5.1)', () => {
  // Text between the markers starts and ends with a line feed; drop those two edges.
  const inner = extractBlock(skillText).replace(/^\n/, '').replace(/\n$/, '').split('\n');
  assert.ok(inner.length > 0 && inner.length <= 25, 'block has ' + inner.length + ' lines');
});

test('injected text (yours-win line plus block) stays well under 10,000 characters (6.11)', () => {
  const injected = YOURS_WIN + '\n' + extractBlock(skillText).trim();
  assert.ok(injected.length < 5000, 'injected length ' + injected.length);
});

test('frontmatter: name is model-routing, a description exists, no model or effort key (5.1, 5.2)', () => {
  const fm = frontmatter(skillText);
  assert.equal(fm.name, 'model-routing');
  assert.ok(fm.description && fm.description.length > 20);
  assert.ok(!('model' in fm), 'no model key');
  assert.ok(!('effort' in fm), 'no effort key');
});

test('no plugin path variable and no user_config substitution in the skill (6.6)', () => {
  const dollarBrace = '$' + '{';
  assert.ok(!skillText.includes(dollarBrace), 'no dollar-brace text at all');
  assert.ok(!templateText.includes(dollarBrace));
  assert.ok(!skillText.includes('user_config'));
});

test('no CRLF in either file', () => {
  assert.ok(!skillText.includes('\r'));
  assert.ok(!templateText.includes('\r'));
});

test('the skill name holds no reserved word, "official" or "for claude" (1.4 hard line 2)', () => {
  const name = frontmatter(skillText).name.toLowerCase();
  const bad = [['cla', 'ude'], ['anthr', 'opic'], ['offi', 'cial']].map((p) => p.join(''));
  for (const b of bad) assert.ok(!name.includes(b));
});

test('no reserved word or "official" in the two files, apart from the two platform variable names the rules must state (5.2 points 11, 12)', () => {
  const bad = [['cla', 'ude'], ['anthr', 'opic'], ['offi', 'cial']].map((p) => p.join(''));
  for (const text of [skillText, templateText]) {
    let lower = text.toLowerCase().split(VAR_BASE.toLowerCase()).join('');
    for (const u of ALLOWED_URLS) lower = lower.split(u).join('');
    for (const b of bad) assert.ok(!lower.includes(b), 'found: ' + b);
  }
});

test('no savings claim: no banned phrases, no number tied to cost, tokens or speed (1.4 hard line 1)', () => {
  const phrases = [
    ['fewer', 'tokens'], ['save', 'tokens'], ['saves', 'tokens'], ['token', 'savings'],
    ['save', 'money'], ['saves', 'money'], ['cost', 'savings'], ['cheap'], ['cheaper'],
    ['lower your', 'bill'], ['saves'], ['saving']
  ].map((parts) => parts.join(' '));
  const pct = new RegExp('[0-9]\\s?(%|percent)', 'i');
  const money = new RegExp('\\$' + '[0-9]');
  const times = new RegExp('[0-9]\\s?(x|\\u00d7)\\s+(faster|fewer|less|smaller)', 'i');
  for (const text of [skillText, templateText]) {
    const lower = text.toLowerCase();
    for (const p of phrases) assert.ok(!lower.includes(p), 'banned phrase: ' + p);
    assert.ok(!pct.test(text), 'no percentage');
    assert.ok(!money.test(text), 'no money amount');
    assert.ok(!times.test(text), 'no multiplier claim');
  }
});

test('the holder name from LICENSE is absent from both files (1.4 hard line 3)', () => {
  const license = fs.readFileSync(path.join(REPO_TOP, 'LICENSE'), 'utf8');
  const m = /^Copyright \(c\) [0-9]{4} (.+)$/m.exec(license);
  assert.ok(m, 'LICENSE has a copyright line');
  for (const text of [skillText, templateText]) assert.ok(!text.includes(m[1].trim()));
});

test('the block states each rule point from 5.2 in plain words', () => {
  const block = extractBlock(skillText);
  const needles = [
    'pass a model and an effort', 'Trivial', 'Standard', 'Hard', 'smallest tier', 'effort low',
    'effort medium', 'effort high', 'Never downgrade', 'security', 'privacy', 'legal',
    'compliance', 'money and pricing', 'irreversible', 'pass or fail verdict',
    'one tier up', 'raised, never lowered', 're-run the same task on the top tier',
    'Gather on a smaller tier', 'lower the effort on the same model', 'xhigh', 'Explore',
    'Plan and general-purpose', 'mid-session', 'prompt cache', VAR_BASE,
    '/tasks', VAR_FORCE + '=1'
  ];
  for (const n of needles) assert.ok(block.includes(n), 'missing: ' + n);
});

test('the yours-win line is not inside the block (5.1 b)', () => {
  assert.ok(!extractBlock(skillText).includes(YOURS_WIN));
  assert.ok(!templateText.includes(YOURS_WIN));
});

test('the block speaks of tiers, not model aliases; the table in the skill maps them (5.3)', () => {
  const block = extractBlock(skillText);
  for (const alias of ['haiku', 'sonnet', 'opus', 'fable']) {
    assert.ok(!new RegExp('\\b' + alias + '\\b', 'i').test(block), 'alias in block: ' + alias);
  }
  assert.ok(!/\bbest\b/.test(block), 'alias in block: best');
  const outside = skillText.replace(block, '');
  for (const alias of ['haiku', 'sonnet', 'opus']) assert.ok(outside.includes('`' + alias + '`'));
});
