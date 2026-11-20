'use strict';
// Test helper (spec 13.1 e): every scrub-shaped value a test needs is assembled here at
// run time from parts, so no test source holds a literal date, address, key, home path,
// copyright line or banned phrase, and the scrub scan needs no test-file exemption.

const AT = String.fromCharCode(64);
const BS = String.fromCharCode(92);

function charRange(from, to) {
  let s = '';
  for (let c = from.charCodeAt(0); c <= to.charCodeAt(0); c++) s += String.fromCharCode(c);
  return s;
}
const UPPER = charRange('A', 'Z');
const LOWER = charRange('a', 'z');
const DIGITS = charRange('0', '9');
const ALPHA = UPPER + LOWER + DIGITS;

// Deterministic token characters; with step 7 every character in a run of up to 62 differs.
function gen(n, start = 0, step = 7, alphabet = ALPHA) {
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[(start + i * step) % alphabet.length];
  return s;
}

function isoDate(y, m, d) {
  return [String(y), String(m).padStart(2, '0'), String(d).padStart(2, '0')].join('-');
}
function year() {
  return String(2000 + 26);
}
function writtenDate() {
  return ['November', '3,', year()].join(' ');
}
function fakeEmail(user = ['zq', 'tester'].join('')) {
  return user + AT + ['example', 'org'].join('.');
}
function gitIdentityEmail() {
  return ['scrub', 'test'].join('-') + AT + ['example', 'invalid'].join('.');
}
function copyrightLine(holder) {
  return `${['Copy', 'right'].join('')} (c) ${year()} ${holder}`;
}
function hex40() {
  return '0123456789abcdef'.repeat(3).slice(0, 40);
}
function codeHostUrl(owner, repo) {
  return `https://${['git', 'hub'].join('')}.com/${owner}/${repo}`;
}
function installLine(slug) {
  return ['/plugin marketplace', 'add', slug].join(' ');
}
function homePaths(name = 'zqtester') {
  return {
    windows: ['C:', 'Users', name, 'x'].join(BS),
    windowsJson: ['C:', 'Users', name, 'x'].join(BS + BS),
    linux: `/${['home', name, 'x'].join('/')}`,
    mac: `/${['Users', name].join('/')}`,
  };
}
function savingsPhrase() {
  return ['uses', 'fewer', 'tokens'].join(' ');
}
function savingsNumber() {
  return `${'40'}% cheaper`;
}
function keyBlockHeader() {
  return ['-----', 'BEGIN ', 'RSA PRIVATE KEY', '-----'].join('');
}
function fakeJwt() {
  return ['ey', 'J', gen(12), '.', 'ey', 'J', gen(12, 3), '.', gen(8, 5)].join('');
}
function connString() {
  return ['postgres', '://', 'zq', ':', 'pw', gen(6), AT, 'db.invalid/x'].join('');
}
function signedUrl() {
  return ['https://h.invalid/x', '?', 'X-Amz-', 'Signature', '=', 'abc123'].join('');
}
function webhookUrl() {
  return ['hooks', '.slack', '.com/services/', 'T0/B0/x1'].join('');
}
function secretSetting() {
  return ['DB_', 'PASSWORD', '=', 'correct', 'horse9'].join('');
}
function authHeader() {
  return ['Authorization', ': ', 'Bearer ', gen(24)].join('');
}
// A vendor-shaped token: the prefix (taken from the rules file at run time) plus `len`
// generated characters from the class the rule names.
function vendorToken(prefix, len, chars) {
  const alphabet = chars === 'A-Z0-9' ? UPPER + DIGITS : ALPHA;
  let tok = '';
  for (let k = 0; k < len; k++) tok += alphabet[(k * 5) % alphabet.length];
  return `${prefix}${tok}`;
}

// ---- search scan fixtures (spec T-6, T-19, T-28) ----

// A status-mark line with a date built from numbers (13.1 e).
// kind: 'superseded' | 'partly' | 'cancelled'.
function markLine(kind, successor = 'notes/new.md', { sign = false, who = '' } = {}) {
  const date = isoDate(2000 + 26, 3, 4);
  const lead = sign ? '⚠ ' : '';
  const w = who ? ` (${who})` : '';
  if (kind === 'superseded') return `${lead}${['SUPER', 'SEDED'].join('')} ${date} by ${successor}${w}`;
  if (kind === 'partly') return `${lead}PARTLY ${['SUPER', 'SEDED'].join('')} ${date} by ${successor}${w}: the second half`;
  return `${lead}${['CAN', 'CELLED'].join('')} ${date}${w}: dropped plan`;
}
function connStringNoPassword() {
  return ['postgres', '://', 'zq', AT, 'db.invalid/x'].join('');
}
function connStringForms() {
  return [
    ['postgres', '://', 'zq', ':', 'pw', gen(6), AT, 'db.invalid/x'].join(''),
    ['mongodb+srv', '://', 'zq', ':', 'pw', gen(6, 2), AT, 'cluster.invalid/x'].join(''),
    ['https', '://', 'zq', ':', 'pw', gen(6, 4), AT, 'h.invalid/x'].join(''),
  ];
}
function signedUrlForms() {
  const names = [['X-Amz-', 'Signature'], ['X-Goog-', 'Signature'], ['s', 'ig'], ['to', 'ken'], ['access_', 'token'], ['client_', 'secret']];
  const out = [];
  for (const sep of ['?', '&', '#']) {
    for (const n of names) out.push(['https://h.invalid/x', sep === '?' ? '' : '?a=1', sep, n.join(''), '=', 'abc', gen(6)].join(''));
  }
  return out;
}
function discordWebhook() {
  return ['https://', 'discord', '.com/api/', 'webhooks/', '1234/', gen(10)].join('');
}
function awsSecretSetting() {
  return ['AWS_', 'SECRET', '_ACCESS_KEY', '=', gen(20, 3)].join('');
}
function basicAuthHeader() {
  return ['Authorization', ': ', 'Basic ', gen(16, 9)].join('');
}
function keyBlock(lineEnd = '\n', indent = '') {
  const end = ['-----', 'END ', 'RSA PRIVATE KEY', '-----'].join('');
  return [indent + keyBlockHeader(), indent + gen(40, 1), indent + end].join(lineEnd);
}
function intlPhone() {
  return ['+', '1 ', '555 ', '010 ', '0199'].join('');
}
function groupedPhone() {
  return ['(555) ', '010', '-', '0188'].join('');
}
function uuid() {
  return ['123e4567', 'e89b', '12d3', 'a456', '426614174000'].join('-');
}

// ---- placeholder shapes and look-alike values (spec SR-13 a, b) ----
// The whole placeholder shapes the scan exempts, for a setting value (a) and for
// a value with no `<` (b, connection strings and URLs).
function placeholderValues() {
  return ['<your-db-password>', '$' + '{DB_PASSWORD}', '$' + 'DB_PASSWORD', '%' + 'DB_PASSWORD' + '%',
    '{' + '{db_password}' + '}', '*'.repeat(10)];
}
// Real-looking values that only start like a placeholder.
function placeholderLookalikes() {
  return ['$', '%', '{', '*'].map((lead, k) => lead + gen(12, 2 + k));
}
function settingWith(value) {
  return ['DB_', 'PASSWORD', '=', value].join('');
}
function connWith(pw) {
  return ['postgres', '://', 'u', ':', pw, AT, 'h.invalid/x'].join('');
}
function signedWith(value) {
  return ['https://h.invalid/x', '?', 'to', 'ken', '=', value].join('');
}
// API-doc lines whose setting value is a placeholder followed by more URL text (SR-13 b2).
function urlPlaceholderLines() {
  return [
    ['GET /x?', 'to', 'ken', '=', '<YOUR_', 'TOKEN>', '&page=2'].join(''),
    ['?', 'access_', 'token', '=', '<', 'token', '>', '#frag'].join(''),
    ['api_', 'key', '=', '$', '{API_', 'KEY}', '/v1'].join(''),
  ];
}
// The same lines with a real-looking value in place of the placeholder.
function urlRealValueLines() {
  return [
    ['GET /x?', 'to', 'ken', '=', gen(12, 4), '&page=2'].join(''),
    ['?', 'access_', 'token', '=', gen(12, 6), '#frag'].join(''),
    ['api_', 'key', '=', gen(12, 8), '&v=1'].join(''),
  ];
}

module.exports = {
  AT, BS, UPPER, LOWER, DIGITS, ALPHA,
  charRange, gen, isoDate, year, writtenDate, fakeEmail, gitIdentityEmail, copyrightLine,
  hex40, codeHostUrl, installLine, homePaths, savingsPhrase, savingsNumber,
  keyBlockHeader, fakeJwt, connString, signedUrl, webhookUrl, secretSetting, authHeader, vendorToken,
  markLine, connStringNoPassword, connStringForms, signedUrlForms, discordWebhook, awsSecretSetting,
  basicAuthHeader, keyBlock, intlPhone, groupedPhone, uuid,
  placeholderValues, placeholderLookalikes, settingWith, connWith, signedWith,
  urlPlaceholderLines, urlRealValueLines,
};
