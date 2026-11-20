'use strict';
// Light English stemmer for word families (spec 7.2 a, 9.5 phase 2 a).
// Written by the project (hard line 8); nothing is borrowed.
//
// When it applies (testable, no language detection): only to a word made
// entirely of the ASCII letters a-z (after lower-casing), 4 or more letters
// long, and not caught by the acronym rule. Any other word is left as it is.
// The same rule runs on file text and on the query, so both sides agree: two
// words are in one family when their stems are equal.
//
// Family key (B6 review): a word of exactly 3 such letters is too short to
// stem, so its family key is the word itself (`run` joins the family of
// `running`). A word of 1 or 2 letters, or one the rule above leaves alone,
// has no family key and joins no family.
//
// Steps, in order:
//   1. plurals: `sses` -> `ss`; `ies` -> `y` (a 4-letter word: `ie`);
//      `xes` -> `x`; a final `s` is dropped unless the word ends in `ss`,
//      `us` or `is`;
//   2. past and -ing forms: `eed` -> `ee` when a vowel-consonant pair comes
//      before it; else `ed` or `ing` is dropped when what is left holds a
//      vowel and has 3 or more letters, then: `at`, `bl`, `iz` take an `e`
//      back; a doubled final consonant (not l, s or z) is undoubled when
//      3 or more letters stay; a short consonant-vowel-consonant stem (not
//      ending in w, x or y) takes an `e` back;
//   3. a final `e` is dropped when 4 or more letters stay.
// A result shorter than 3 letters is never used: the word stays as it is.
//
// Nothing on disk depends on these rules: the index stores raw words only,
// and the family map is built in memory from them (index.cjs), so a change
// here needs no rebuild and carries no version number.

const MIN_LETTERS = 4;
const MIN_STEM = 3;
const SHORT_KEY_RE = /^[a-z]{3}$/;
const MODES = Object.freeze(['english', 'off']);
const ELIGIBLE_RE = /^[a-z]+$/;

function isConsonant(s, i) {
  const c = s[i];
  if (c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u') return false;
  if (c === 'y') return i === 0 ? true : !isConsonant(s, i - 1);
  return true;
}

function hasVowel(s) {
  for (let i = 0; i < s.length; i++) if (!isConsonant(s, i)) return true;
  return false;
}

/** Number of vowel-then-consonant runs (the classic "measure"). */
function measure(s) {
  let m = 0;
  let i = 0;
  const n = s.length;
  while (i < n && isConsonant(s, i)) i++;
  while (i < n) {
    while (i < n && !isConsonant(s, i)) i++;
    if (i >= n) break;
    while (i < n && isConsonant(s, i)) i++;
    m++;
  }
  return m;
}

function endsDoubleConsonant(s) {
  const n = s.length;
  return n >= 2 && s[n - 1] === s[n - 2] && isConsonant(s, n - 1);
}

/** A short consonant-vowel-consonant stem whose last letter is not w, x or y. */
function shortCvc(s) {
  const n = s.length;
  if (n < 3 || measure(s) !== 1) return false;
  if (!isConsonant(s, n - 3) || isConsonant(s, n - 2) || !isConsonant(s, n - 1)) return false;
  const last = s[n - 1];
  return last !== 'w' && last !== 'x' && last !== 'y';
}

function step1(s) {
  if (s.endsWith('sses')) return s.slice(0, -2);
  if (s.endsWith('ies')) return s.length > 4 ? s.slice(0, -3) + 'y' : s.slice(0, -1);
  if (s.endsWith('xes')) return s.slice(0, -2);
  if (s.endsWith('ss') || s.endsWith('us') || s.endsWith('is')) return s;
  if (s.endsWith('s')) return s.slice(0, -1);
  return s;
}

function fixUp(s) {
  if (s.endsWith('at') || s.endsWith('bl') || s.endsWith('iz')) return s + 'e';
  if (endsDoubleConsonant(s)) {
    const last = s[s.length - 1];
    if (last !== 'l' && last !== 's' && last !== 'z' && s.length - 1 >= MIN_STEM) return s.slice(0, -1);
    return s;
  }
  if (shortCvc(s)) return s + 'e';
  return s;
}

function step2(s) {
  if (s.endsWith('ied')) return s.length > 4 ? s.slice(0, -3) + 'y' : s.slice(0, -1);
  if (s.endsWith('eed')) {
    const base = s.slice(0, -3);
    return measure(base) > 0 ? s.slice(0, -1) : s;
  }
  for (const suf of ['ed', 'ing']) {
    if (!s.endsWith(suf)) continue;
    const base = s.slice(0, -suf.length);
    if (base.length >= MIN_STEM && hasVowel(base)) return fixUp(base);
    return s;
  }
  return s;
}

function step3(s) {
  if (s.endsWith('e') && s.length - 1 >= MIN_LETTERS) return s.slice(0, -1);
  return s;
}

/** True when the stemmer may run on this (lower-cased) word. acronym: the word was caught by the acronym rule. */
function eligible(word, acronym = false) {
  return !acronym && typeof word === 'string' && word.length >= MIN_LETTERS && ELIGIBLE_RE.test(word);
}

/** The stem of one word; a word the rule does not cover is returned unchanged. */
function stem(word) {
  if (!eligible(word)) return word;
  const s = step3(step2(step1(word)));
  return s.length >= MIN_STEM ? s : word;
}

/**
 * The family a (lower-cased) word joins, or null for none: its stem when the
 * stemmer applies; the word itself when it is exactly 3 ASCII letters; never
 * for an acronym or a word of 1 or 2 letters. The same rule runs on file text
 * and on the query.
 */
function familyKey(word, acronym = false) {
  if (acronym || typeof word !== 'string') return null;
  if (eligible(word)) return stem(word);
  return SHORT_KEY_RE.test(word) ? word : null;
}

/** word_families value: `english` (default) or `off`; anything else is the default (9.13). */
function parseMode(raw) {
  if (typeof raw !== 'string') return 'english';
  const v = raw.trim().toLowerCase();
  return MODES.includes(v) ? v : 'english';
}

module.exports = {
  MIN_LETTERS,
  MODES,
  eligible,
  measure,
  stem,
  familyKey,
  parseMode,
};
