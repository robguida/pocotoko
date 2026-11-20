'use strict';
// floor.cjs (spec 9.1, 9.2, 9.13, SR-7 to SR-9, SR-12): T-4 and the floor part of T-27,
// option parsing and the check-5 seams.

const test = require('node:test');
const assert = require('node:assert/strict');
const Fl = require('../../src/search/server/floor.cjs');

const R = Fl.RULES;
const base = Fl.buildFilter({});

function rule(name, rel = name, filter = base) {
  return Fl.fileRule(filter, name, rel);
}

test('T-4: allowed types are indexed; any other type is skipped (SR-7)', () => {
  for (const n of ['a.md', 'a.markdown', 'a.mdx', 'a.txt', 'a.rst', 'a.adoc', 'A.MD']) assert.equal(rule(n), null, n);
  for (const n of ['a.js', 'a.py', 'a.html', 'README', 'a.json']) assert.equal(rule(n), R.NOT_ALLOWED_TYPE, n);
});

test('T-4: hidden files and folders (SR-9 c)', () => {
  assert.equal(rule('.notes.md'), R.HIDDEN);
  assert.equal(rule('.ENV'), R.HIDDEN);
  assert.equal(Fl.folderRule(base, '.git', '.git'), R.HIDDEN);
  assert.equal(Fl.folderRule(base, '.obsidian', 'x/.obsidian'), R.HIDDEN);
});

test('T-4: secret and key files by name and type, any case (SR-9 e)', () => {
  const names = [
    'x.pem', 'KEY.PEM', 'a.key', 'a.p12', 'a.pfx', 'a.p8', 'a.jks', 'a.keystore', 'a.ppk', 'a.kdbx', 'a.gpg',
    'a.pgp', 'a.asc', 'a.age', 'a.keytab', 'a.ovpn', 'a.rdp', 'a.tfstate', 'a.tfvars', 'a.token', 'a.crt',
    'a.cer', 'a.der', 'prod.env', 'id_rsa', 'ID_RSA', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ed25519.pub',
    'authorized_keys', 'known_hosts', '_netrc', 'credentials', 'my-credentials.json', 'gcp-service-account.json',
    'client_secret_123.json', 'secrets.yaml', 'Secrets.md',
  ];
  for (const n of names) assert.equal(rule(n), R.KEY_FILE, n);
});

test('T-4: secret-sounding names use word edges (SR-9 f)', () => {
  for (const n of ['db_password.md', 'dbPassword.md', 'my-secrets.txt', 'Credentials.md', 'api-key.md', 'old_apikey.txt', 'privateKey.md']) {
    assert.equal(rule(n), R.RISKY_NAME, n);
  }
  assert.equal(rule('notes/passwords/list.md'), R.RISKY_NAME);
  for (const n of ['secretary.md', 'passwordless-login-ideas-sketch.md'.replace('less', 'lessx'), 'tokenize.md']) {
    assert.equal(rule(n), null, n);
  }
  assert.equal(Fl.hasSecretWord('secretary'), false);
  assert.equal(Fl.hasSecretWord('mySecret'), true);
  assert.equal(Fl.folderRule(base, 'secrets', 'secrets'), R.RISKY_NAME);
});

test('T-4 (SR-9 f): a letter whose lower case is longer does not shift the word edges', () => {
  const dotted = 'İ'; // capital I with dot above: lower case is two UTF-16 units
  assert.equal(dotted.toLowerCase().length, 2);
  for (const n of [dotted + '_password.md', dotted + dotted + '-secrets.txt', 'a' + dotted + '_apikey.md']) {
    assert.equal(rule(n), R.RISKY_NAME, n);
  }
  assert.equal(Fl.hasSecretWord(dotted + 'xPassword'), true); // lower-to-upper change is an edge
  assert.equal(Fl.hasSecretWord(dotted + 'secretary'), false);
  assert.equal(Fl.foldSameLength(dotted + 'AB').length, 3);
});

test('T-4: data, binary and archive types (SR-9 g)', () => {
  const names = ['a.db', 'a.sqlite', 'a.sqlite3', 'a.db-wal', 'a.db-shm', 'a.db-journal', 'a.sql', 'a.dump', 'a.bak',
    'a.csv', 'a.tsv', 'a.xlsx', 'a.xls', 'a.jsonl', 'a.ndjson', 'a.parquet', 'a.har', 'a.log', 'a.zip', 'a.tar',
    'a.gz', 'a.7z', 'a.docx', 'a.pdf', 'a.png', 'a.jpg', 'a.svg', 'a.mp3', 'a.mp4', 'a.onnx', 'a.safetensors', 'a.npy'];
  for (const n of names) assert.equal(rule(n), R.DATA_TYPE, n);
});

test('T-4: build and vendor folders (SR-9 h)', () => {
  for (const n of Fl.BUILD_FOLDERS) assert.equal(Fl.folderRule(base, n, n), R.BUILD_FOLDER, n);
  assert.equal(Fl.folderRule(base, 'Node_Modules', 'Node_Modules'), R.BUILD_FOLDER);
  assert.equal(Fl.folderRule(base, 'docs', 'docs'), null);
});

test('T-4: opt-out line on line 15 → out; on line 16 → in (SR-9 k)', () => {
  const lines = (at) => Array.from({ length: 20 }, (_, i) => (i + 1 === at ? Fl.OPT_OUT_LINE : 'text')).join('\n');
  assert.equal(Fl.hasOptOut(lines(15)), true);
  assert.equal(Fl.hasOptOut(lines(16)), false);
  assert.equal(Fl.hasOptOut('  ' + Fl.OPT_OUT_LINE + '  \r\nrest'), true);
  assert.equal(Fl.hasOptOut('x ' + Fl.OPT_OUT_LINE), false);
});

test('T-4: not text: a NUL in the first 8 KB, or not valid UTF-8 (SR-9 i)', () => {
  assert.equal(Fl.decodeText(Buffer.from([0x61, 0x00, 0x62])), null);
  assert.equal(Fl.decodeText(Buffer.from([0x61, 0xff, 0x62])), null);
  assert.equal(Fl.decodeText(Buffer.concat([Buffer.alloc(8192, 0x61), Buffer.from([0x00])])), 'a'.repeat(8192) + '\u0000');
  assert.equal(Fl.decodeText(Buffer.from('café', 'utf8')), 'café');
});

test('SR-13 g i: decoding keeps a leading BOM, so only the one explicit strip removes one; a double BOM hits', () => {
  const S = require('../../src/search/server/scan.cjs');
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const one = Fl.decodeText(Buffer.concat([bom, Buffer.from('# A\ntext\n')]));
  assert.equal(one.charCodeAt(0), 0xfeff);
  assert.equal(S.hiddenTextHit(S.stripBom(one)), false);
  const two = Fl.decodeText(Buffer.concat([bom, bom, Buffer.from('# A\ntext\n')]));
  assert.equal(S.stripBom(two).charCodeAt(0), 0xfeff);
  assert.equal(S.fileLevelRule(S.stripBom(two), () => false), S.RULES.HIDDEN_TEXT);
});

test('rules version: a SHA-256 of the floor lists and the scan rules; any change gives a new version', () => {
  const S = require('../../src/search/server/scan.cjs');
  assert.match(Fl.RULES_VERSION, /^rules-[0-9a-f]{32}$/);
  assert.equal(Fl.computeRulesVersion(), Fl.RULES_VERSION);
  const src = S.ruleSources();
  const changed = (scanPart) => Fl.computeRulesVersion({ scan: { ...src, ...scanPart } });
  // A release that adds a vendor prefix (SR-13 f ix), changes one pattern, or one minimum length.
  assert.notEqual(changed({ vendors: [...src.vendors, ['zz' + 'k_', 20, 'A-Za-z0-9']] }), Fl.RULES_VERSION);
  assert.notEqual(changed({ patterns: src.patterns.map((p, i) => (i === 0 ? p + 'x' : p)) }), Fl.RULES_VERSION);
  assert.notEqual(changed({ constants: src.constants.map((c, i) => (i === 0 ? c + 1 : c)) }), Fl.RULES_VERSION);
  assert.notEqual(changed({ logic: src.logic + 1 }), Fl.RULES_VERSION);
  assert.notEqual(Fl.computeRulesVersion({ keyExts: [...Fl.KEY_FILE_EXTS, '.zz'] }), Fl.RULES_VERSION);
  // The vendor prefixes in the version are the live list.
  assert.deepEqual(src.vendors.map((v) => v[0]), S.VENDOR_PREFIXES.map((v) => v.prefix));
});

test('T-4 (SR-8): extra_types naming a floor type is refused; bad entries ignored and counted', () => {
  const f = Fl.buildFilter({ extra_types: ['.env', '.pem', '.sql', '.log', '.jsonl', '.csv', '', '*', 'a/b', 'x\\y', '.org', 'tex'] });
  for (const n of ['x.env', 'x.pem', 'x.sql', 'x.log', 'x.jsonl', 'x.csv']) assert.notEqual(rule(n, n, f), null, n);
  assert.equal(f.counts.extra_type_refused, 6);
  assert.equal(f.counts.bad_extra_type, 4); // '', '*', 'a/b', 'x\\y'
  assert.equal(rule('notes.org', 'notes.org', f), null);
  assert.equal(rule('paper.tex', 'paper.tex', f), null);
  assert.equal(rule('notes.org'), R.NOT_ALLOWED_TYPE);
});

test('T-27 (floor part): never_folders, never_globs and never_terms narrow only', () => {
  const f = Fl.buildFilter({
    never_folders: ['clients', 'Drafts'],
    never_globs: ['*.private.md', 'archive/**', 'x'.repeat(513), '*'.repeat(17), 'a\\b'],
    never_terms: ['AcmeCorp', 'a.b', '(x)'],
  });
  assert.equal(Fl.folderRule(f, 'clients', 'clients'), R.NEVER_FOLDER);
  assert.equal(Fl.folderRule(f, 'drafts', 'notes/drafts'), R.NEVER_FOLDER);
  assert.equal(rule('plan.private.md', 'notes/plan.private.md', f), R.NEVER_GLOB);
  assert.equal(Fl.folderRule(f, 'archive', 'archive'), R.NEVER_GLOB);
  assert.equal(rule('acmecorp-notes.md', 'acmecorp-notes.md', f), R.NEVER_TERM);
  assert.equal(f.counts.bad_never_glob, 3);
  // Terms are plain text, never a regular expression.
  assert.equal(Fl.termHit(f, 'see a.b here'), true);
  assert.equal(Fl.termHit(f, 'see axb here'), false);
  assert.equal(Fl.termHit(f, 'call (x) now'), true);
  assert.equal(Fl.termHit(f, 'call x now'), false);
  // No user option puts back a floor file.
  assert.equal(rule('x.pem', 'x.pem', f), R.KEY_FILE);
});

test('a term value never appears in the filter counts or its hash input', () => {
  const f = Fl.buildFilter({ never_terms: ['ZqUniqueTerm'] });
  assert.ok(!JSON.stringify(f.counts).toLowerCase().includes('zquniqueterm'));
  assert.match(f.optionsHash, /^[0-9a-f]{64}$/);
  assert.notEqual(f.optionsHash, base.optionsHash);
});

test('list options: array, JSON array text, comma-joined and new-line-joined give the same entries (check 5)', () => {
  const want = ['one', 'two', 'three'];
  assert.deepEqual(Fl.splitListOption(want).entries, want);
  assert.deepEqual(Fl.splitListOption(JSON.stringify(want)).entries, want);
  assert.deepEqual(Fl.splitListOption('one,two,three').entries, want);
  assert.deepEqual(Fl.splitListOption('one\ntwo\r\nthree').entries, want);
  assert.equal(Fl.splitListOption('one,two').joined, true);
  assert.equal(Fl.splitListOption(want).joined, false);
});

test('live check 5: single-line texts stored as written (a comma list, a JSON-array text) read back as the entries typed', () => {
  // A comma-separated single-line text (what the probe supplied) keeps spaces inside an entry.
  assert.deepEqual(Fl.splitListOption(['alpha', 'beta gamma', 'delta'].join(',')).entries, ['alpha', 'beta gamma', 'delta']);
  // A JSON-array text is stored as written; an element holding a comma stays one entry.
  const withComma = ['alpha', 'delta,eps'];
  const r = Fl.splitListOption(JSON.stringify(withComma));
  assert.deepEqual(r.entries, withComma);
  assert.equal(r.joined, false);
  // A never-set option reads back as an empty value, even when it has a default.
  assert.deepEqual(Fl.splitListOption(''), { entries: [], joined: false });
});

test('unset options: empty or the raw substitution text means the default (check 5)', () => {
  const placeholder = '$' + '{user_config.never_terms}';
  assert.equal(Fl.isUnsetValue(''), true);
  assert.equal(Fl.isUnsetValue(placeholder), true);
  assert.equal(Fl.isUnsetValue(undefined), true);
  assert.equal(Fl.isUnsetValue('x'), false);
  assert.deepEqual(Fl.splitListOption(placeholder).entries, []);
  assert.equal(Fl.parseBool(placeholder, true), true);
  assert.equal(Fl.parseBool('false', true), false);
  assert.equal(Fl.parseBool('nope', true), true);
});

test('max_file_bytes: clamped to 1,024 … 4,194,304; not a number → default', () => {
  assert.equal(Fl.parseMaxFileBytes(0), 1024);
  assert.equal(Fl.parseMaxFileBytes(1023), 1024);
  assert.equal(Fl.parseMaxFileBytes(5 * 1024 * 1024), 4194304);
  assert.equal(Fl.parseMaxFileBytes(-5), 1024);
  assert.equal(Fl.parseMaxFileBytes(2048.7), 2048);
  assert.equal(Fl.parseMaxFileBytes('4096'), 4096);
  assert.equal(Fl.parseMaxFileBytes('abc'), Fl.MAX_FILE_BYTES_DEFAULT);
  assert.equal(Fl.parseMaxFileBytes(undefined), 1048576);
  assert.equal(base.maxFileBytes, 1048576);
  assert.equal(base.dropContacts, true);
});
