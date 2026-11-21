'use strict';
// The floor: what is never indexed, compiled into the code (spec 9.1, 9.2,
// SR-7 to SR-9, SR-12). User options can only narrow it: they can add folder
// names, globs and terms to the never-lists, and add file types to the
// allow-list, but they can never take a floor entry away (SR-8).
//
// Every skip has one rule id, and the walker counts each skip by it.

const crypto = require('node:crypto');
const ignore = require('./ignore.cjs');
const scan = require('./scan.cjs');

// SR-7: allow-list by file type.
const ALLOW_TYPES = Object.freeze(['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc']);
const MARKDOWN_TYPES = Object.freeze(['.md', '.markdown', '.mdx']);

// SR-9 e: secret and key files by type (`.env` added so `extra_types` can never re-allow `x.env`).
const KEY_FILE_EXTS = Object.freeze([
  '.pem', '.key', '.p12', '.pfx', '.p8', '.jks', '.keystore', '.ppk', '.kdbx', '.gpg', '.pgp',
  '.asc', '.age', '.keytab', '.ovpn', '.rdp', '.tfstate', '.tfvars', '.token', '.crt', '.cer',
  '.der', '.env',
]);
// SR-9 e: secret and key files by exact name (compared lower-case).
const KEY_FILE_NAMES = Object.freeze([
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'id_rsa.pub', 'id_dsa.pub', 'id_ecdsa.pub', 'id_ed25519.pub',
  'authorized_keys', 'known_hosts', '.netrc', '_netrc', '.npmrc', '.pypirc',
  '.git-credentials', '.htpasswd', 'credentials',
]);
// SR-9 f: secret-sounding words, matched as whole words in any path segment.
const RISKY_NAME_WORDS = Object.freeze([
  'secret', 'credential', 'password', 'passwd', 'apikey', 'api_key', 'api-key',
  'private_key', 'privatekey',
]);
// SR-9 g: data, binary and archive types.
const DATA_EXTS = Object.freeze([
  // databases, dumps, backups
  '.db', '.sql', '.dump', '.bak',
  // spreadsheets and data files
  '.csv', '.tsv', '.xlsx', '.xls', '.jsonl', '.ndjson', '.parquet', '.har',
  // logs
  '.log',
  // archives
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.zst', '.lz4', '.jar', '.war',
  // office files and PDFs
  '.doc', '.docx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf', '.pages', '.numbers', '.pdf',
  // images
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.webp', '.svg', '.ico', '.heic', '.avif', '.psd',
  // audio
  '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus',
  // video
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.m4v',
  // model and vector files
  '.onnx', '.safetensors', '.gguf', '.ggml', '.pt', '.pth', '.ckpt', '.h5', '.pkl', '.pickle',
  '.npy', '.npz', '.faiss', '.tflite', '.mlmodel', '.bin',
]);
const DATA_SUFFIXES = Object.freeze(['-wal', '-shm', '-journal']);
// SR-9 h: build and vendor folders (dot-folders are caught by the hidden rule).
const BUILD_FOLDERS = Object.freeze([
  'node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'coverage', '__pycache__', 'venv',
]);

const OPT_OUT_LINE = 'search: do not index';
const OPT_OUT_LINES = 15;
const NUL_CHECK_BYTES = 8192;

const MAX_FILE_BYTES_DEFAULT = 1048576;
const MAX_FILE_BYTES_MIN = 1024;
const MAX_FILE_BYTES_MAX = 4194304;
const MAX_TERM_CHARS = 200;

// Rule ids (each skip is counted under one).
const RULES = Object.freeze({
  LINK: 'link',
  SPECIAL: 'special_file',
  HARD_LINK: 'hard_link',
  UNSAFE_NAME: 'unsafe_name',
  HIDDEN: 'hidden',
  KEY_FILE: 'secret_file',
  RISKY_NAME: 'secret_name',
  DATA_TYPE: 'data_type',
  BUILD_FOLDER: 'build_folder',
  NOT_ALLOWED_TYPE: 'not_allowed_type',
  NEVER_FOLDER: 'never_folder',
  NEVER_GLOB: 'never_glob',
  NEVER_TERM: 'never_term',
  GIT_IGNORED: 'git_ignored',
  TOO_BIG: 'too_big',
  NOT_TEXT: 'not_text',
  OPT_OUT: 'opt_out',
});

/**
 * The rules version (9.6, SR-49 d): the SHA-256 of the floor lists and limits
 * and of the scan's pattern sources, predicates, vendor prefixes, minimum
 * lengths and randomness constants (scan.ruleSources()). Never a hand-bumped
 * name: any change to a list or a pattern changes it, and the store re-scans
 * every file when the stored version differs. `parts` is a test-only seam.
 */
function computeRulesVersion(parts = {}) {
  const input = {
    allow: ALLOW_TYPES, markdown: MARKDOWN_TYPES, keyExts: KEY_FILE_EXTS, keyNames: KEY_FILE_NAMES,
    riskyWords: RISKY_NAME_WORDS, dataExts: DATA_EXTS, dataSuffixes: DATA_SUFFIXES, buildFolders: BUILD_FOLDERS,
    optOut: [OPT_OUT_LINE, OPT_OUT_LINES, NUL_CHECK_BYTES],
    scan: scan.ruleSources(),
    ...parts,
  };
  return 'rules-' + crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 32);
}
const RULES_VERSION = computeRulesVersion();

// ---------------------------------------------------------------------------
// Option values

const UNSET_PLACEHOLDER_RE = /^\$\{user_config\.[A-Za-z0-9_]{1,64}\}$/;

/**
 * True when an option value means "never set by the user".
 */
function isUnsetValue(raw) {
  if (raw === undefined || raw === null) return true;
  if (typeof raw !== 'string') return false;
  // Live check 5 (Claude Code 2.1.329): at the server, an option set to "" arrives as empty
  // text, and a never-set string option WITH a default arrives as that default (equal to the
  // code default). A never-set option with no default, or a never-set boolean or number
  // option with a default, is not seen yet, so absent, empty and the
  // raw `${user_config.KEY}` text all mean "never set": the code default applies.
  return raw.trim() === '' || UNSET_PLACEHOLDER_RE.test(raw.trim());
}

/**
 * Split a list option (`string` with `multiple`) into entries. Accepts an
 * array, or one string. Returns { entries, joined } where joined is true when
 * a single string had to be split (the projects rule in 9.1 e needs to know).
 */
function splitListOption(raw) {
  if (isUnsetValue(raw)) return { entries: [], joined: false };
  if (Array.isArray(raw)) return { entries: raw.map((v) => (typeof v === 'string' ? v : String(v))), joined: false };
  const s = String(raw);
  // Live check 5 (Claude Code 2.1.329): a set list reaches the server's env as the stored
  // text exactly, a comma line or a JSON-array text (the forms `plugin configure
  // --values-stdin` stores). A string is read as a JSON-array text, else split on commas and
  // new lines (9.1 e, 9.13). The array branch serves callers that do not read the env.
  const parsed = parseJsonArray(s);
  if (parsed) return { entries: parsed, joined: false };
  return { entries: s.split(/[,\r\n]/).map((v) => v.trim()).filter((v) => v !== ''), joined: true };
}

function parseJsonArray(s) {
  const t = s.trim();
  if (!t.startsWith('[')) return null;
  try {
    const v = JSON.parse(t);
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
  } catch (_) { /* not JSON */ }
  return null;
}

function parseBool(raw, dflt) {
  if (typeof raw === 'boolean') return raw;
  if (isUnsetValue(raw)) return dflt;
  const s = String(raw).trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return dflt;
}

/** max_file_bytes: not a number → default; otherwise clamped to 1,024 … 4,194,304 (9.11). */
function parseMaxFileBytes(raw) {
  if (isUnsetValue(raw)) return MAX_FILE_BYTES_DEFAULT;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return MAX_FILE_BYTES_DEFAULT;
  const i = Math.floor(n);
  return Math.min(MAX_FILE_BYTES_MAX, Math.max(MAX_FILE_BYTES_MIN, i));
}

// ---------------------------------------------------------------------------
// Name rules

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

function isLetter(ch) {
  return ch !== undefined && /\p{L}/u.test(ch);
}
function isLower(ch) {
  return ch !== undefined && /\p{Ll}/u.test(ch);
}
function isUpper(ch) {
  return ch !== undefined && /\p{Lu}/u.test(ch);
}

/**
 * Lower-case each UTF-16 unit on its own, keeping one unit for one unit, so
 * offsets in the folded text are offsets in the original. A unit whose lower
 * case is longer (`İ` becomes two units) is kept as it is.
 */
function foldSameLength(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const lo = ch.toLowerCase();
    out += lo.length === 1 ? lo : ch;
  }
  return out;
}

/**
 * SR-9 f word edge: start or end of the segment, a character that is not a
 * letter, or a change from a lower-case to an upper-case letter. A trailing
 * `s` is allowed.
 */
function hasSecretWord(segment) {
  const lower = foldSameLength(segment);
  for (const w of RISKY_NAME_WORDS) {
    let from = 0;
    for (;;) {
      const i = lower.indexOf(w, from);
      if (i < 0) break;
      from = i + 1;
      const before = segment[i - 1];
      const first = segment[i];
      const leftEdge = i === 0 || !isLetter(before) || (isLower(before) && isUpper(first));
      if (!leftEdge) continue;
      let end = i + w.length;
      const rightEdgeAt = (e) => {
        const last = segment[e - 1];
        const after = segment[e];
        return e >= segment.length || !isLetter(after) || (isLower(last) && isUpper(after));
      };
      if (rightEdgeAt(end)) return true;
      if (lower[end] === 's' && rightEdgeAt(end + 1)) return true;
    }
  }
  return false;
}

function isSecretFileName(name) {
  const n = name.toLowerCase();
  if (n.startsWith('.env')) return true;
  if (KEY_FILE_NAMES.includes(n)) return true;
  if (KEY_FILE_EXTS.includes(extOf(n))) return true;
  if (n.endsWith('.json') && (n.includes('credentials') || n.includes('service-account') || n.startsWith('client_secret'))) return true;
  if (n.startsWith('secrets.')) return true;
  return false;
}

function isDataFileName(name) {
  const n = name.toLowerCase();
  if (DATA_EXTS.includes(extOf(n))) return true;
  if (n.includes('.sqlite')) return true;
  if (DATA_SUFFIXES.some((s) => n.endsWith(s))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// The effective filter (floor + the user's narrowing options)

const EXT_ENTRY_RE = /^\.?[a-z0-9][a-z0-9_+-]{0,15}$/;
const FOLDER_ENTRY_RE = /^[^/\\]{1,120}$/;

/**
 * Build the filter from raw user options. Bad entries are ignored and counted;
 * counts never hold the entry's value.
 */
function buildFilter(raw = {}) {
  const counts = {
    bad_extra_type: 0, extra_type_refused: 0, bad_never_folder: 0, bad_never_glob: 0, bad_never_term: 0,
  };

  const allow = new Set(ALLOW_TYPES);
  for (const e of splitListOption(raw.extra_types).entries) {
    const v = String(e).trim().toLowerCase();
    if (!EXT_ENTRY_RE.test(v)) { counts.bad_extra_type++; continue; }
    const ext = v.startsWith('.') ? v : '.' + v;
    if (KEY_FILE_EXTS.includes(ext) || DATA_EXTS.includes(ext) || ext.startsWith('.sqlite')) {
      counts.extra_type_refused++;
      continue;
    }
    allow.add(ext);
  }

  const neverFolders = new Set();
  for (const e of splitListOption(raw.never_folders).entries) {
    const v = String(e).trim();
    if (!FOLDER_ENTRY_RE.test(v) || v === '.' || v === '..') { counts.bad_never_folder++; continue; }
    neverFolders.add(v.toLowerCase());
  }

  const neverGlobs = [];
  for (const e of splitListOption(raw.never_globs).entries) {
    const g = ignore.compileGlob(String(e).trim());
    if (g.error) { counts.bad_never_glob++; continue; }
    neverGlobs.push(g);
  }

  const neverTerms = [];
  for (const e of splitListOption(raw.never_terms).entries) {
    const v = String(e).trim().toLowerCase();
    if (v === '' || v.length > MAX_TERM_CHARS) { counts.bad_never_term++; continue; }
    if (!neverTerms.includes(v)) neverTerms.push(v);
  }

  const dropContacts = parseBool(raw.drop_contacts, true);
  const maxFileBytes = parseMaxFileBytes(raw.max_file_bytes);

  // A hash of the floor plus the effective options (9.6 manifest). Term values
  // only ever leave memory inside this one-way hash.
  const optionsHash = crypto.createHash('sha256').update(JSON.stringify({
    floor: RULES_VERSION,
    allow: [...allow].sort(),
    neverFolders: [...neverFolders].sort(),
    neverGlobs: splitListOption(raw.never_globs).entries.map((e) => String(e).trim()).filter((e) => !ignore.compileGlob(e).error).sort(),
    neverTerms: neverTerms.slice().sort(),
    dropContacts,
    maxFileBytes,
  })).digest('hex');

  return Object.freeze({
    allowTypes: allow,
    neverFolders,
    neverGlobs,
    neverTerms,
    dropContacts,
    maxFileBytes,
    counts,
    optionsHash,
  });
}

/** True when the plain-text term list hits the text (case-insensitive, never a regex). */
function termHit(filter, text) {
  if (!filter.neverTerms.length || !text) return false;
  const lower = String(text).toLowerCase();
  for (const t of filter.neverTerms) if (lower.includes(t)) return true;
  return false;
}

/** Rule id for a folder (name = its own name, rel = root-relative path), or null. */
function folderRule(filter, name, rel) {
  if (name.startsWith('.')) return RULES.HIDDEN;
  const n = name.toLowerCase();
  if (BUILD_FOLDERS.includes(n)) return RULES.BUILD_FOLDER;
  if (hasSecretWord(name)) return RULES.RISKY_NAME;
  if (filter.neverFolders.has(n)) return RULES.NEVER_FOLDER;
  for (const g of filter.neverGlobs) if (ignore.globMatches(g, rel, true)) return RULES.NEVER_GLOB;
  if (termHit(filter, rel)) return RULES.NEVER_TERM;
  return null;
}

/** Rule id for a regular file by its name and path, or null when it may be read. */
function fileRule(filter, name, rel) {
  if (name.startsWith('.')) return RULES.HIDDEN;
  if (isSecretFileName(name)) return RULES.KEY_FILE;
  for (const seg of rel.split('/')) if (hasSecretWord(seg)) return RULES.RISKY_NAME;
  if (isDataFileName(name)) return RULES.DATA_TYPE;
  if (!filter.allowTypes.has(extOf(name))) return RULES.NOT_ALLOWED_TYPE;
  for (const g of filter.neverGlobs) if (ignore.globMatches(g, rel, false)) return RULES.NEVER_GLOB;
  if (termHit(filter, rel)) return RULES.NEVER_TERM;
  return null;
}

// ---------------------------------------------------------------------------
// Content rules

// ignoreBOM: true keeps a leading BOM in the decoded text, so the one explicit
// strip (scan.stripBom, SR-13 g i) is the only place a BOM is removed, and a
// second BOM straight after it is still seen by the hidden-text rule.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** SR-9 i: text only. A NUL in the first 8 KB, or bytes that are not valid UTF-8 → null. */
function decodeText(buf) {
  const head = buf.subarray(0, NUL_CHECK_BYTES);
  if (head.includes(0)) return null;
  try {
    return UTF8.decode(buf);
  } catch (_) {
    return null;
  }
}

/** SR-9 k: the exact line `search: do not index` in the first 15 lines. */
function hasOptOut(text) {
  let start = 0;
  for (let i = 0; i < OPT_OUT_LINES; i++) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    if (text.slice(start, end).trim() === OPT_OUT_LINE) return true;
    if (end >= text.length) break;
    start = end + 1;
  }
  return false;
}

function isMarkdownPath(rel) {
  return MARKDOWN_TYPES.includes(extOf(rel.split('/').pop()));
}

module.exports = {
  RULES_VERSION,
  computeRulesVersion,
  foldSameLength,
  ALLOW_TYPES,
  KEY_FILE_EXTS,
  KEY_FILE_NAMES,
  RISKY_NAME_WORDS,
  DATA_EXTS,
  BUILD_FOLDERS,
  RULES,
  OPT_OUT_LINE,
  MAX_FILE_BYTES_DEFAULT,
  MAX_FILE_BYTES_MIN,
  MAX_FILE_BYTES_MAX,
  isUnsetValue,
  splitListOption,
  parseBool,
  parseMaxFileBytes,
  hasSecretWord,
  isSecretFileName,
  isDataFileName,
  buildFilter,
  termHit,
  folderRule,
  fileRule,
  decodeText,
  hasOptOut,
  isMarkdownPath,
  extOf,
};
