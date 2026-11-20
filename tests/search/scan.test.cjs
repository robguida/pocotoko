'use strict';
// scan.cjs (spec 10.3, SR-13 to SR-18): T-6 (scan part), T-10, T-16 (scan part), T-28 and the
// pattern lint. Every secret-shaped value is built at run time (13.1 e).

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../src/search/server/scan.cjs');
const C = require('../../src/search/server/chunker.cjs');
const Fl = require('../../src/search/server/floor.cjs');
const F = require('../helpers/fake-values.cjs');

const never = () => false;
const RS = S.RULES;

function scanText(text, rel = 'a.md', options = {}) {
  const t = S.stripBom(text);
  return S.scanFile({ relPath: rel, text: t, chunks: C.chunkText(rel, t), filter: Fl.buildFilter(options) });
}

function tokenFor(v, len) {
  const chars = v.cls === 'A-Z0-9' ? 'A-Z0-9' : 'A-Za-z0-9';
  return F.vendorToken(v.prefix, len, chars);
}

// ---------------------------------------------------------------------------
// Pattern lint (SR-18 a, b)

function readQuant(src, i) {
  const c = src[i];
  if (c === '*' || c === '+') return { end: src[i + 1] === '?' ? i + 2 : i + 1, unbounded: true };
  if (c === '?') return { end: src[i + 1] === '?' ? i + 2 : i + 1, unbounded: false };
  if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
    if (m) return { end: i + m[0].length, unbounded: m[2] !== undefined && m[3] === '' };
  }
  return null;
}

function lint(re) {
  const src = re.source;
  const problems = [];
  if (/\\[1-9]|\\k</.test(src)) problems.push('back-reference');
  if (/\(\?<[=!]/.test(src)) problems.push('look-behind');
  const stack = [{ quant: false, alt: false }];
  let i = 0;
  const afterAtom = (j, inner) => {
    const q = readQuant(src, j);
    const top = stack[stack.length - 1];
    if (!q) { if (inner && inner.quant) top.quant = true; return j; }
    if (inner && inner.quant) problems.push('nested quantifier');
    if (inner && inner.alt) problems.push('alternation inside a repeated group');
    if (q.unbounded && q.end !== src.length) problems.push('unbounded run before the end');
    top.quant = true;
    return q.end;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      let j = i + 2;
      if ('pPu'.includes(src[i + 1]) && src[j] === '{') j = src.indexOf('}', j) + 1;
      i = afterAtom(j, null);
    } else if (c === '[') {
      let depth = 1;
      let j = i + 1;
      while (j < src.length && depth) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') depth++;
        else if (src[j] === ']') depth--;
        j++;
      }
      i = afterAtom(j, null);
    } else if (c === '(') {
      stack.push({ quant: false, alt: false });
      i++;
      if (src[i] === '?') {
        if (src[i + 1] === '<' && (src[i + 2] === '=' || src[i + 2] === '!')) i += 3;
        else if (src[i + 1] === '<') i = Math.max(i + 2, src.indexOf('>', i) + 1);
        else i += 2;
      }
    } else if (c === ')') {
      const g = stack.pop();
      i = afterAtom(i + 1, g);
    } else if (c === '|') {
      stack[stack.length - 1].alt = true;
      i++;
    } else if (c === '^' || c === '$') {
      i++;
    } else {
      i = afterAtom(i + 1, null);
    }
  }
  return problems;
}

test('pattern lint: every scan pattern is linear-time by construction', () => {
  assert.ok(S.PATTERNS.length >= S.VENDOR_PREFIXES.length + 10);
  for (const re of S.PATTERNS) assert.deepEqual(lint(re), [], re.source);
});

test('pattern lint catches the unsafe shapes', () => {
  assert.ok(lint(/(a+)+$/).includes('nested quantifier'));
  assert.ok(lint(/(?:a|b)*/).includes('alternation inside a repeated group'));
  assert.ok(lint(/(?<=x)y/).includes('look-behind'));
  assert.ok(lint(/(a)\1/).includes('back-reference'));
  assert.ok(lint(/a.*b/).includes('unbounded run before the end'));
  assert.deepEqual(lint(/ab[c-d]{2,5}(?:x)?z+/), []);
});

// ---------------------------------------------------------------------------
// T-6 file-level classes

test('T-6: one fake per file-level class drops the file', () => {
  const cases = {
    [RS.KEY_BLOCK]: F.keyBlock(),
    [RS.VENDOR]: F.vendorToken('gh' + 'p_', 30, 'A-Za-z0-9'),
    [RS.JWT]: F.fakeJwt(),
    [RS.CONN]: F.connString(),
    [RS.SIGNED]: F.signedUrl(),
    [RS.WEBHOOK]: F.webhookUrl(),
    [RS.HIDDEN_TEXT]: 'normal​​hidden',
  };
  for (const [rule, value] of Object.entries(cases)) {
    const r = scanText('# Notes\nsome text\n\n## Part\nsee ' + value + ' here\n');
    assert.equal(r.fileRule, rule, rule);
    assert.deepEqual(r.kept, []);
  }
});

test('T-6: every vendor prefix: a token of exactly the minimum length hits; one shorter does not', () => {
  for (const v of S.VENDOR_PREFIXES) {
    const hit = tokenFor(v, v.min);
    const short = tokenFor(v, v.min - 1);
    assert.equal(S.fileLevelRule('x ' + hit + ' y', never), RS.VENDOR, v.prefix);
    assert.equal(S.fileLevelRule('x ' + short + ' y', never), null, v.prefix);
  }
  assert.equal(S.MIN_AWS, 16);
  assert.equal(S.MIN_GOOGLE, 30);
  assert.equal(S.MIN_OTHER, 20);
  assert.equal(S.MIN_JWT_PART, 10);
});

test('T-6: the vendor list holds each added prefix', () => {
  const prefixes = S.VENDOR_PREFIXES.map((v) => v.prefix);
  for (const p of ['glrtr-', 'glagent-', 'glffct-', 'xwfp-', 'xoxe', 'sk_org_', 'whsec_', 'sk-svcacct-', 'sk-admin-', 'sk-proj-', 'AIza']) {
    assert.ok(prefixes.includes(p), p);
  }
});

test('T-6: a long token holding . - _ hits; a prefix inside a word hits', () => {
  const long = 'gh' + 's_' + F.gen(30) + '.' + F.gen(20, 3) + '-' + F.gen(20, 5) + '_' + F.gen(20, 9);
  assert.equal(S.fileLevelRule(long, never), RS.VENDOR);
  const rot = 'xo' + 'xe.' + 'xo' + 'xp-' + F.gen(30);
  assert.equal(S.fileLevelRule(rot, never), RS.VENDOR);
  assert.equal(S.fileLevelRule('abc' + 'gh' + 'p_' + F.gen(24), never), RS.VENDOR);
  assert.equal(S.fileLevelRule('x_' + 'np' + 'm_' + F.gen(24), never), RS.VENDOR);
  assert.equal(S.fileLevelRule('a gh' + 'p_ token is a GitHub token', never), null);
});

test('T-6: connection strings with an inline password drop the file; without one they do not', () => {
  for (const c of F.connStringForms()) assert.equal(S.fileLevelRule('db: ' + c, never), RS.CONN, c.split(':')[0]);
  assert.equal(S.fileLevelRule('db: ' + F.connStringNoPassword(), never), null);
  assert.equal(S.fileLevelRule('see https://example.invalid/path', never), null);
});

test('T-6: signed URLs (each name after ?, & or #) and webhook addresses drop the file', () => {
  const forms = F.signedUrlForms();
  assert.equal(forms.length, 18);
  for (const u of forms) assert.equal(S.fileLevelRule(u, never), RS.SIGNED);
  assert.equal(S.fileLevelRule(F.webhookUrl(), never), RS.WEBHOOK);
  assert.equal(S.fileLevelRule(F.discordWebhook(), never), RS.WEBHOOK);
});

test('T-6: a key block indented in code, with CRLF line ends, or split across a chunk cut drops the file', () => {
  assert.equal(scanText('# K\n\n```\n' + F.keyBlock('\n', '    ') + '\n```\n').fileRule, RS.KEY_BLOCK);
  assert.equal(scanText('# K\r\n\r\n' + F.keyBlock('\r\n') + '\r\n').fileRule, RS.KEY_BLOCK);
  const header = F.keyBlockHeader();
  const text = 'y'.repeat(C.CHUNK_MAX_BYTES - 15) + F.keyBlock();
  const chunks = C.chunkText('a.txt', text);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => !c.text.includes(header)), 'the header is split across the cut');
  assert.equal(S.scanFile({ relPath: 'a.txt', text, chunks }).fileRule, RS.KEY_BLOCK);
});

// ---------------------------------------------------------------------------
// T-6 chunk-level

test('T-6: secret settings and Authorization headers drop their chunk; two in one file drop the file', () => {
  const one = (value) => scanText(['# A', 'clean text', '', '## B', value, ''].join('\n'));
  for (const v of [F.secretSetting(), F.awsSecretSetting(), F.authHeader(), F.basicAuthHeader(),
    ['GITHUB_', 'TOKEN', '=', F.gen(12, 11)].join(''), ['db', 'Password', ': ', F.gen(10, 13)].join('')]) {
    const r = one(v);
    assert.equal(r.fileRule, null, v.slice(0, 6));
    assert.deepEqual(r.kept.map((c) => c.heading), ['A']);
    assert.equal(r.hits, 1);
  }
  const two = scanText(['# A', F.secretSetting(), '', '## B', F.authHeader(), ''].join('\n'));
  assert.equal(two.fileRule, RS.CHUNK_HITS);
  // Prose that only names a setting, or a word that merely contains a label, is not a hit.
  assert.equal(S.chunkLevelRule('set the password in your vault'), null);
  assert.equal(S.chunkLevelRule('tokenizer: splits text into words'), null);
});

test('T-6 (SR-13 a, b): only whole placeholder shapes are exempt; values that merely start like one hit', () => {
  // The two confirmed leaks: a `$`-led setting value and a `$`-led connection-string password.
  for (const v of F.placeholderLookalikes()) {
    assert.equal(S.chunkLevelRule('set ' + F.settingWith(v)), RS.SETTING, v[0]);
    assert.equal(S.fileLevelRule('db ' + F.connWith(v), never), RS.CONN, v[0]);
    assert.equal(S.fileLevelRule(F.signedWith(v), never), RS.SIGNED, v[0]);
  }
  // Each whole shape stays exempt, in a setting, a connection string and a signed URL.
  for (const p of F.placeholderValues()) {
    assert.equal(S.chunkLevelRule('set ' + F.settingWith(p)), null, p);
    assert.equal(S.chunkLevelRule('set ' + F.settingWith('"' + p + '"') + ' in the file.'), null, p);
    assert.equal(S.chunkLevelRule('set ' + F.settingWith(p) + '.'), null, p); // closing punctuation after it
    assert.equal(S.fileLevelRule('db ' + F.connWith(p), never), null, p);
    if (!p.startsWith('<')) assert.equal(S.fileLevelRule(F.signedWith(p), never), null, p);
  }
  // A placeholder with something after it is not a whole shape.
  assert.equal(S.chunkLevelRule('set ' + F.settingWith(F.placeholderValues()[1] + F.gen(10, 3))), RS.SETTING);
  // `$UPPER_NAME` is upper-case letters, digits and `_` only.
  assert.equal(S.isPlaceholderValue('$DB_PASS2', 0, 9), true);
  assert.equal(S.isPlaceholderValue('$Db_pass2', 0, 9), false);
  // An exempt match never hides a real value later in the same text.
  assert.equal(S.chunkLevelRule(F.settingWith(F.placeholderValues()[1]) + '\n' + F.settingWith(F.placeholderLookalikes()[0])), RS.SETTING);
  assert.equal(S.fileLevelRule(F.connWith('$' + 'PW') + ' ' + F.connWith(F.placeholderLookalikes()[0]), never), RS.CONN);
});

test('T-6 (SR-13 b2): a setting value ends at & or #, and at / after a whole ${...} or <...>', () => {
  // A placeholder followed by more URL text is not a hit.
  for (const line of F.urlPlaceholderLines()) assert.equal(S.chunkLevelRule(line), null, line.slice(0, 8));
  // Two such lines no longer drop an API-doc note.
  const [a, b, c] = F.urlPlaceholderLines();
  const note = scanText(['# API', a, b, '', '## More', c, ''].join('\n'));
  assert.equal(note.fileRule, null);
  assert.deepEqual(note.kept.map((k) => k.heading), ['API', 'More']);
  assert.equal(note.hits, 0);
  // A real value followed by `&...` or `#...` still hits.
  for (const line of F.urlRealValueLines()) assert.equal(S.chunkLevelRule(line), RS.SETTING, line.slice(0, 8));
  // A real value holding `#` or `&` is still judged whole.
  assert.equal(S.chunkLevelRule(F.settingWith('ab#' + F.gen(10, 3))), RS.SETTING);
  assert.equal(S.chunkLevelRule(F.settingWith('ab&' + F.gen(10, 5))), RS.SETTING);
  // A `/` after a value that is not a whole `${...}` or `<...>` does not end it.
  assert.equal(S.chunkLevelRule(F.settingWith(F.placeholderLookalikes()[0] + '/v1')), RS.SETTING);
  assert.equal(S.chunkLevelRule(F.settingWith('$' + 'DB_PASSWORD' + '/' + F.gen(10, 7))), RS.SETTING);
});

test('T-6: randomness rule: 32 chars at 4.2+ bits hits; low bits, 31 chars, hex and UUIDs do not; 40 at 4.5+ hits', () => {
  const t32 = F.gen(32);
  assert.ok(S.shannonBits(t32) >= S.RANDOM_SHORT_BITS && /[A-Z]/.test(t32) && /[a-z]/.test(t32) && /[0-9]/.test(t32));
  assert.equal(S.chunkLevelRule('k ' + t32), RS.RANDOM);
  const low = 'a'.repeat(28) + 'Ab1c';
  assert.ok(S.shannonBits(low) < S.RANDOM_SHORT_BITS);
  assert.equal(S.chunkLevelRule('k ' + low), null);
  assert.equal(S.chunkLevelRule('k ' + F.gen(31)), null);
  const t40 = F.gen(40, 1);
  assert.ok(S.shannonBits(t40) >= S.RANDOM_LONG_BITS);
  assert.equal(S.chunkLevelRule('k ' + t40), RS.RANDOM);
  assert.equal(S.chunkLevelRule('commit ' + F.hex40()), null);
  assert.equal(S.chunkLevelRule('id ' + F.uuid()), null);
});

// ---------------------------------------------------------------------------
// T-10 hidden text

test('T-10: text a Markdown preview hides is dropped as a chunk', () => {
  for (const hidden of ['<!-- note -->', '[//]: # (a note)', '[x]: <> (a note)', '<span hidden>x</span>', '<div style="display:none">x</div>']) {
    const line = hidden.startsWith('[') ? hidden : 'before ' + hidden; // a reference line starts its own line
    const r = scanText(['# A', 'clean', '', '## B', 'text', line, ''].join('\n'));
    assert.equal(r.fileRule, null, hidden);
    assert.deepEqual(r.kept.map((c) => c.heading), ['A'], hidden);
    assert.equal(r.dropped.scan_hidden_html, 1);
  }
  assert.equal(S.hiddenHtmlHit('a <b>bold</b> and <a href="x">link</a>'), false);
});

test('T-10: invisible runs and fillers hit; one selector after an emoji is kept', () => {
  const hits = [
    'a​​b', // zero-width run
    '❤️️', // variation-selector run
    'aᅟb', 'aᅠb', 'aㅤb', 'aﾠb', 'a͏b',
    'mid﻿bom', // BOM not at the start
    'ab‌cd', // ZWNJ between Latin letters
    'م‌‌ی', // a run of two joiners between Arabic letters
    'abc‮def', // bidi override
    '­word', // soft hyphen not between letters
    'flag \u{1f3f4}\u{e0067}\u{e0062}\u{e007f}', // subdivision flag: accepted false alarm
  ];
  for (const h of hits) assert.equal(S.hiddenTextHit(h), true, JSON.stringify(h));
  const kept = [
    'heart ❤️ ok',
    'می‌خواهم نمی‌دانم', // Persian ZWNJ
    'क्‍ष नमस्ते', // Hindi ZWJ
    'العربية ؜123 ‏نص', // Arabic line with ALM and RLM
    'family \u{1f468}‍\u{1f469}‍\u{1f467}', // emoji ZWJ sequence
    'flag \u{1f3f3}️‍\u{1f308}', // VS16 then ZWJ
    'hy­phen',
  ];
  for (const k of kept) assert.equal(S.hiddenTextHit(k), false, JSON.stringify(k));
  assert.equal(S.hiddenTextHit('latin only ‏ here'), true); // RLM without a right-to-left letter
});

test('T-10: a leading BOM is removed before scanning and storing; one mid-file hits', () => {
  assert.equal(S.stripBom('﻿hello'), 'hello');
  assert.equal(scanText('﻿# A\ntext\n').fileRule, null);
  assert.equal(scanText('﻿# A\ntext\n').kept[0].text.charCodeAt(0), '#'.charCodeAt(0));
  assert.equal(scanText('# A\ntext ﻿ more\n').fileRule, RS.HIDDEN_TEXT);
});

// ---------------------------------------------------------------------------
// T-28 contact details

test('T-28: email and phone chunks are dropped and counted by default; kept with drop_contacts off', () => {
  for (const contact of [F.fakeEmail(), F.intlPhone(), F.groupedPhone()]) {
    const text = ['# A', 'clean', '', '## B', 'reach ' + contact + ' today', ''].join('\n');
    const on = scanText(text);
    assert.deepEqual(on.kept.map((c) => c.heading), ['A'], contact);
    assert.equal(on.dropped.scan_contact, 1);
    const off = scanText(text, 'a.md', { drop_contacts: false });
    assert.deepEqual(off.kept.map((c) => c.heading), ['A', 'B'], contact);
  }
  assert.equal(S.contactHit('version 1.2.3 on port 8080'), false);
});

test('never_terms drop a chunk by text or heading trail, any case', () => {
  const r = scanText(['# A', 'clean', '', '## Acme plans', 'x', '', '## C', 'talks with ACME', ''].join('\n'), 'a.md', { never_terms: ['acme'] });
  assert.deepEqual(r.kept.map((c) => c.heading), ['A']);
  assert.equal(r.dropped.never_term, 2);
});

test('the path is scanned too', () => {
  const r = S.scanFile({ relPath: 'notes/' + F.vendorToken('gh' + 'p_', 24, 'A-Za-z0-9') + '.md', text: 'x', chunks: C.chunkText('a.md', 'x') });
  assert.equal(r.fileRule, RS.VENDOR);
});

test('results carry rule ids only, never a matched value (SR-17)', () => {
  const secret = F.secretSetting();
  const r = scanText(['# A', 'x', '', '## B', secret, ''].join('\n'));
  const shown = JSON.stringify({ fileRule: r.fileRule, dropped: r.dropped, hits: r.hits });
  assert.ok(!shown.includes(secret));
});

// ---------------------------------------------------------------------------
// T-16 never hang (scan part)

test('T-16: worst-case 4 MiB inputs are each scanned within the per-file budget', () => {
  const MiB4 = 4 * 1024 * 1024;
  const fill = (unit) => unit.repeat(Math.ceil(MiB4 / unit.length)).slice(0, MiB4);
  const cases = {
    'prefix repeated': fill('gh' + 'p_'),
    'label then = run': ['DB_', 'PASS', 'WORD'].join('') + fill('= '),
    'header name repeated': fill('Authorization:'),
    'unclosed comment': '<!--' + fill('text '),
    'unclosed key header': F.keyBlockHeader() + '\n' + fill('abc '),
    'one base64 line': fill('QUJDRGVmZ2gxMjM0+/'),
    'joiners and letters': fill('ب‌'),
    'direction marks on one right-to-left line': fill('ب‏'),
  };
  for (const [name, text] of Object.entries(cases)) {
    const chunks = C.chunkText('a.txt', text);
    const t0 = Date.now();
    const r = S.scanFile({ relPath: 'a.txt', text, chunks });
    const ms = Date.now() - t0;
    assert.notEqual(r.fileRule, RS.TIMEOUT, name + ' took ' + ms + ' ms');
    assert.ok(ms < S.FILE_BUDGET_MS, name + ' took ' + ms + ' ms');
  }
});

test('T-16: one 400k-character right-to-left line of letters and RLM marks finishes fast and is kept', () => {
  const text = 'ب‏'.repeat(200000);
  assert.equal(text.length, 400000);
  const t0 = Date.now();
  const r = S.scanFile({ relPath: 'a.txt', text, chunks: C.chunkText('a.txt', text) });
  const ms = Date.now() - t0;
  assert.ok(ms < S.FILE_BUDGET_MS / 4, 'took ' + ms + ' ms');
  assert.equal(r.fileRule, null);
  assert.ok(r.kept.length > 0);
  assert.equal(S.hiddenTextHit(text), false);
});

test('T-16: the budget is checked inside the hidden-text loop: a slow clock → scan_timeout, never a pass', () => {
  const text = 'ب‏'.repeat(400000);
  let calls = 0;
  const now = () => calls++; // every budget check moves the clock on by 1 ms
  const r = S.scanFile({ relPath: 'a.txt', text, chunks: [], budgetMs: 150, now });
  assert.equal(r.fileRule, RS.TIMEOUT);
  assert.deepEqual(r.kept, []);
  // Straight through the loop: the loop itself gives up, it does not run to the end.
  let n = 0;
  assert.equal(S.hiddenTextScan(text, () => ++n > 3), 'timeout');
  assert.equal(n, 4);
});

test('T-16: called with a 0 ms budget → scan_timeout, nothing kept; a throwing chunk → scan_error', () => {
  const text = '# A\nplain\n';
  const r = S.scanFile({ relPath: 'a.md', text, chunks: C.chunkText('a.md', text), budgetMs: 0 });
  assert.equal(r.fileRule, RS.TIMEOUT);
  assert.deepEqual(r.kept, []);
  const e = S.scanFile({ relPath: 'a.md', text, chunks: C.chunkText('a.md', text), _throwOnChunk: 0 });
  assert.equal(e.fileRule, RS.ERROR);
});
