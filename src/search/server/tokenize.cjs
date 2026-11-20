'use strict';
// Word split, stop words and query limits (spec 9.5, SR-28).
//
// The same word rules run on file text and on queries:
//   a. split into Unicode letter/digit words (combining marks stay in the word);
//   b. drop 1-character words;
//   c. acronym rule: a word of 2 to 5 characters written entirely in upper-case
//      letters and digits (at least one letter) is always kept;
//   d. lower-case every kept word and drop the remaining stop words.
// Positions count every word in the text, kept or not, so the distance
// between two kept words is their real distance.
//
// A query is never compiled as a regular expression. No operator syntax
// except a trailing `*`, which is recorded per word for the broader matching
// level; every other symbol is a plain separator.

const crypto = require('node:crypto');

const RULES_REVISION = 'words-1';
const MAX_QUERY_CHARS = 512;
const MAX_QUERY_WORDS = 32;
const MAX_WORD_CHARS = 64;
const ACRONYM_MIN = 2;
const ACRONYM_MAX = 5;

// The project's own short English stop-word list (fixed; its content is part
// of tokenizer_version).
const STOP_WORDS = Object.freeze([
  'a', 'about', 'above', 'after', 'again', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'during', 'each', 'few', 'for', 'from', 'further',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how',
  'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'my',
  'no', 'nor', 'not', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'out', 'over', 'own',
  'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'then',
  'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'us',
  'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why',
  'will', 'with', 'would', 'you', 'your', 'yours',
]);
const STOP_SET = new Set(STOP_WORDS);

/** tokenizer_version: changes whenever the word rules or the stop-word list change. */
function tokenizerVersion(stopWords = STOP_WORDS) {
  const h = crypto.createHash('sha256')
    .update(JSON.stringify({ rules: RULES_REVISION, maxWord: MAX_WORD_CHARS, stop: [...stopWords] }))
    .digest('hex');
  return 'tok-' + h.slice(0, 16);
}
const TOK_VERSION = tokenizerVersion();

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;
const ACRONYM_RE = /^[\p{Lu}\p{Nd}]+$/u;
const HAS_UPPER_RE = /\p{Lu}/u;

function cpLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdbff) n++;
  }
  return n;
}

function wellFormed(s) {
  return typeof s.toWellFormed === 'function' ? s.toWellFormed() : s.replace(/[\ud800-\udfff]/g, '�');
}

/** Apply rules b to d to one raw word; returns the kept lower-case word or null. */
function keepWord(raw, stop = STOP_SET) {
  const len = cpLength(raw);
  if (len < 2 || len > MAX_WORD_CHARS) return null;
  const lower = raw.normalize('NFC').toLowerCase();
  if (len >= ACRONYM_MIN && len <= ACRONYM_MAX && ACRONYM_RE.test(raw) && HAS_UPPER_RE.test(raw)) return lower;
  if (stop.has(lower)) return null;
  return lower;
}

/**
 * Words of a text: [{ w, pos }] in order. pos counts every raw word.
 */
function tokenize(text) {
  const out = [];
  if (!text) return out;
  const s = wellFormed(String(text));
  let pos = 0;
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(s)) !== null) {
    const w = keepWord(m[0]);
    if (w !== null) out.push({ w, pos });
    pos++;
  }
  return out;
}

/** Just the kept words. */
function words(text) {
  return tokenize(text).map((t) => t.w);
}

/** Words of a file's base name without its extension (the file-name field). */
function nameWords(relPath) {
  const base = String(relPath).split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return words(dot > 0 ? base.slice(0, dot) : base);
}

function queryError(name) {
  const e = new Error(name);
  e.name = name;
  return e;
}

/**
 * Parse a query. Rejects a non-string or a query over 512 characters with a
 * named error. Uses the first 32 kept words (and says so). Repeated words are
 * kept once. Each word records whether a `*` follows it directly.
 *
 * Returns { words: [{ w, wild }], truncated, empty }.
 */
function parseQuery(q) {
  if (typeof q !== 'string') throw queryError('InvalidArgument');
  if (q.length > MAX_QUERY_CHARS) throw queryError('QueryTooLong');
  const s = wellFormed(q);
  const kept = [];
  let truncated = false;
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(s)) !== null) {
    const w = keepWord(m[0]);
    if (w === null) continue;
    if (kept.length >= MAX_QUERY_WORDS) { truncated = true; break; }
    kept.push({ w, wild: s[m.index + m[0].length] === '*' });
  }
  const seen = new Map();
  for (const k of kept) {
    const prev = seen.get(k.w);
    if (prev) prev.wild = prev.wild || k.wild;
    else seen.set(k.w, { w: k.w, wild: k.wild });
  }
  const list = [...seen.values()];
  return { words: list, truncated, empty: list.length === 0 };
}

module.exports = {
  RULES_REVISION,
  MAX_QUERY_CHARS,
  MAX_QUERY_WORDS,
  MAX_WORD_CHARS,
  STOP_WORDS,
  TOK_VERSION,
  tokenizerVersion,
  keepWord,
  tokenize,
  words,
  nameWords,
  parseQuery,
};
