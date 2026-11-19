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

module.exports = {
  AT, BS, UPPER, LOWER, DIGITS, ALPHA,
  charRange, gen, isoDate, year, writtenDate, fakeEmail, gitIdentityEmail, copyrightLine,
  hex40, codeHostUrl, installLine, homePaths, savingsPhrase, savingsNumber,
  keyBlockHeader, fakeJwt, connString, signedUrl, webhookUrl, secretSetting, authHeader, vendorToken,
};
