'use strict';
// Ranking (spec 7.2, 9.5, 9.13, SR-28, SR-29, SR-31).
//
// Phase 1 (`matching: 'exact'`): BM25 over exact words. Phase 2 (`matching:
// 'broad'`, the default): phase 1 plus word families, a typed trailing
// wildcard, automatic prefix match, near spellings, the user's synonyms, the
// file-name field, the all-words and closeness bonuses, and a "how it matched"
// label on every result.
//
// Scoring is BM25F: per query term, each field's count is length-normalised
// on its own (b = 0.75), weighted (heading 2x body; the file-name field 1.5x
// only at the broader level), summed, then saturated once with k1 = 1.2 and
// multiplied by the term's IDF. A document's score is the sum over query words
// of the best expansion of that word, times its match weight. The bonuses
// multiply that sum. All numbers are named constants, covered by known-answer
// tests. They act at query time on the in-memory index, so changing one, or
// the matching, word_families or synonyms option, needs no rebuild.
//
// A query is never compiled as a regular expression; every look-up is a
// plain string compare against the sorted vocabulary.

const markers = require('./markers.cjs');
const floor = require('./floor.cjs');
const tokenize = require('./tokenize.cjs');
const stem = require('./stem.cjs');

const K1 = 1.2;
const B = 0.75;
const HEADING_WEIGHT = 2.0;
const BODY_WEIGHT = 1.0;
const NAME_WEIGHT = 1.5;

// Match weights (7.2, 9.5): exact > family > prefix = synonym > fuzzy.
const EXACT_WEIGHT = 1.0;
const FAMILY_WEIGHT = 0.8;
const PREFIX_WEIGHT = 0.6;
const SYNONYM_WEIGHT = 0.6;
const FUZZY_WEIGHT = 0.4;
const LABELS = Object.freeze(['exact', 'family', 'prefix', 'fuzzy', 'synonym']);

// Bonuses (9.5 c, d; Appendix C k).
const ALL_WORDS_BONUS = 1.25;
const NEAR_WINDOW = 8;
const NEAR_BONUS = 1.25;
const FAR_WINDOW = 32;
const FAR_BONUS = 1.10;

// Expansion rules and caps (7.2 b, c; 9.5; SR-29).
const MAX_EXPANSIONS = 20; // automatic expansions per word (family, synonym, prefix, fuzzy together)
const PREFIX_MIN_LETTERS = 4;
const WILDCARD_MIN_STEM = 3;
const WILDCARD_MAX_TERMS = 200;
const FUZZY_ONE_MIN = 5; // one letter off from 5 letters
const FUZZY_TWO_MIN = 8; // two letters off from 8 letters
const BUDGET_CHECK_EVERY = 256;

// Synonym option limits (9.13 d).
const SYNONYM_MAX_ENTRIES = 500;
const SYNONYM_MAX_ALTS = 10;
const SYNONYM_MAX_WORD_CHARS = 40;
const SYNONYM_MAX_WORDS = 3;

const RETIRED_FACTOR = 0.5; // superseded (and cancelled, when shown) text is ranked down, never hidden
const MAX_PER_FILE = 2;
const K_DEFAULT = 5;
const K_MIN = 1;
const K_MAX = 10;
const MAX_HIDDEN_NAMED = 3;
const QUERY_BUDGET_MS = 1000;
const MATCHING_LEVELS = Object.freeze(['exact', 'broad']);
const MATCHING_DEFAULT = 'broad';

// Fixed note codes in a result (never query text).
const NOTES = Object.freeze({
  EXPANSION_CAPPED: 'expansion_capped',
  WILDCARD_CAPPED: 'wildcard_capped',
  WILDCARD_TOO_SHORT: 'wildcard_too_short',
  WILDCARD_IGNORED: 'wildcard_ignored',
});

// Tie-break order: unmarked and partly first, superseded after (9.5).
const FLAG_ORDER = Object.freeze({ unmarked: 0, partly: 0, unconfirmed: 1, superseded: 2, cancelled: 3 });

function argError(what) {
  const e = new Error('invalid argument: ' + what);
  e.name = 'InvalidArgument';
  return e;
}

/** k: integer 1 to 10, default 5. Anything else is an error, never clamped. */
function checkK(k) {
  if (k === undefined) return K_DEFAULT;
  if (typeof k !== 'number' || !Number.isInteger(k) || k < K_MIN || k > K_MAX) throw argError('k');
  return k;
}

function idf(n, df) {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

function fieldWeights(matching) {
  const w = { h: HEADING_WEIGHT, b: BODY_WEIGHT };
  if (matching === 'broad') w.n = NAME_WEIGHT;
  return w;
}

function cpArray(s) {
  return [...s];
}

// ---------------------------------------------------------------------------
// Options (9.13). Values are checked in code; anything else is the default.

/** matching: `exact` or `broad`; anything else (incl. never set) -> `broad`. */
function parseMatching(raw) {
  if (typeof raw !== 'string') return MATCHING_DEFAULT;
  const v = raw.trim().toLowerCase();
  return MATCHING_LEVELS.includes(v) ? v : MATCHING_DEFAULT;
}

/** word_families: `english` or `off`; anything else -> `english`. */
function parseWordFamilies(raw) {
  return stem.parseMode(raw);
}

const SIDE_RE = /^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*$/u;

/** One side of a synonym entry -> its kept words, or null when the side is bad. */
function synonymSide(raw) {
  const s = raw.trim();
  if (s === '' || !SIDE_RE.test(s)) return null;
  const parts = s.split(' ');
  if (parts.length > SYNONYM_MAX_WORDS) return null;
  if (parts.some((p) => cpArray(p).length > SYNONYM_MAX_WORD_CHARS)) return null;
  const kept = [];
  for (const p of parts) {
    const w = tokenize.keepWord(p);
    if (w !== null) kept.push(w);
  }
  return kept.length ? kept : null;
}

/**
 * Parse the synonyms option (9.13): one group per entry, `term=alt|alt`.
 * Returns { groups: Map(term words joined by one space -> [[alt words]]),
 * maxTermWords, bad }. A bad entry is ignored and counted (bad_synonym); it
 * never stops the other entries.
 */
function parseSynonyms(raw) {
  const groups = new Map();
  let bad = 0;
  let maxTermWords = 0;
  // List arrival goes through floor.splitListOption only. Live check 5: a set list reaches
  // the server as the stored text (a comma line or a JSON-array text); a valid synonym
  // entry holds no comma, so the comma split keeps each entry whole (9.13 a, b).
  const { entries } = floor.splitListOption(raw);
  entries.forEach((entry, i) => {
    try {
      if (i >= SYNONYM_MAX_ENTRIES || typeof entry !== 'string') { bad++; return; }
      const eq = entry.indexOf('=');
      if (eq < 0) { bad++; return; }
      const left = entry.slice(0, eq);
      const right = entry.slice(eq + 1);
      if (right.includes('=')) { bad++; return; }
      const term = synonymSide(left);
      const altRaw = right.split('|');
      if (!term || altRaw.length > SYNONYM_MAX_ALTS) { bad++; return; }
      const alts = altRaw.map(synonymSide);
      if (alts.some((a) => a === null)) { bad++; return; }
      const key = term.join(' ');
      const list = groups.get(key) || [];
      for (const a of alts) {
        const ak = a.join(' ');
        if (ak === key || list.some((x) => x.join(' ') === ak)) continue;
        list.push(a);
      }
      groups.set(key, list);
      maxTermWords = Math.max(maxTermWords, term.length);
    } catch (_) {
      bad++;
    }
  });
  return { groups, maxTermWords, bad };
}

/** All three query options from raw user values (9.13). */
function queryOptions(raw = {}) {
  return {
    matching: parseMatching(raw.matching),
    wordFamilies: parseWordFamilies(raw.word_families),
    synonyms: parseSynonyms(raw.synonyms),
  };
}

function isParsedSynonyms(s) {
  return !!s && typeof s === 'object' && s.groups instanceof Map;
}

// ---------------------------------------------------------------------------
// Scoring

/** Phase 1 expansion: the word itself. */
function exactExpand(word) {
  return [{ term: word.w, weight: EXACT_WEIGHT, label: 'exact' }];
}

/**
 * A query budget guard shared by every loop of one query whose work grows with
 * the index or the query: the clock is read once every BUDGET_CHECK_EVERY units
 * of work (one scored posting, one document looked at, one word position put
 * in a span), and once it is over, `stopped` stays set (B6 review 2, 3).
 */
function makeGuard(over) {
  return { count: 0, next: BUDGET_CHECK_EVERY, stopped: false, over };
}

/** Count `cost` units of work (default 1); true once the budget is over. */
function guardTick(guard, cost = 1) {
  if (!guard) return false;
  if (guard.stopped) return true;
  guard.count += cost;
  if (guard.count >= guard.next) {
    guard.next = guard.count + BUDGET_CHECK_EVERY;
    if (guard.over()) guard.stopped = true;
  }
  return guard.stopped;
}

/**
 * Score one term against the index: Map(docId -> score), before the
 * expansion weight. Exposed for known-answer tests. With a guard (makeGuard),
 * the loop stops once the query budget is over and returns what it scored.
 */
function termScores(index, term, weights, stats, guard) {
  const pl = index.postingsFor(term);
  const out = new Map();
  if (!pl) return out;
  const fields = Object.keys(weights);
  const fw = fields.map((f) => weights[f]);
  const avg = fields.map((f) => stats.avg[f]);
  const nf = fields.length;
  // Document frequency, never a walk over the postings at either matching
  // level (B6 review 3): every posting counts when all three fields are
  // weighted (a posting exists only once one of them is above 0); heading and
  // body alone (the exact level) use the index's own count. Any other field
  // set (tests only) counts the postings under the budget.
  let df = 0;
  const has = (f) => fields.includes(f);
  if (has('h') && has('b') && has('n')) df = pl.size;
  else if (nf === 2 && has('h') && has('b') && typeof index.textDocs === 'function') df = index.textDocs(term);
  else {
    for (const e of pl.values()) {
      if (guardTick(guard)) return out;
      for (let i = 0; i < nf; i++) if (e[fields[i]] > 0) { df++; break; }
    }
  }
  if (df === 0) return out;
  const w = idf(stats.docs, df);
  for (const [docId, e] of pl) {
    if (guardTick(guard)) break;
    const doc = index.doc(docId);
    if (!doc) continue;
    let tf = 0;
    for (let i = 0; i < nf; i++) {
      const c = e[fields[i]];
      if (!c) continue;
      const norm = avg[i] > 0 ? 1 - B + B * (doc.len[fields[i]] / avg[i]) : 1;
      tf += fw[i] * c / norm;
    }
    if (tf <= 0) continue;
    out.set(docId, w * (tf * (K1 + 1)) / (tf + K1));
  }
  return out;
}

/**
 * Smallest span (max - min + 1 positions) holding one entry of every list.
 * Infinity when a list is empty.
 */
function smallestSpan(lists) {
  if (!lists.length || lists.some((l) => !l.length)) return Infinity;
  if (lists.length === 1) return 1;
  const ev = [];
  lists.forEach((l, i) => { for (const p of l) ev.push([p, i]); });
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const need = lists.length;
  const count = new Array(need).fill(0);
  let have = 0;
  let best = Infinity;
  let lo = 0;
  for (let hi = 0; hi < ev.length; hi++) {
    if (count[ev[hi][1]]++ === 0) have++;
    while (have === need) {
      best = Math.min(best, ev[hi][0] - ev[lo][0] + 1);
      if (--count[ev[lo][1]] === 0) have--;
      lo++;
    }
  }
  return best;
}

function entryOf(index, term, docId) {
  const pl = index.postingsFor(term);
  return pl ? pl.get(docId) || null : null;
}

/** Number of word positions in a list of position lists (the work of smallestSpan). */
function positionCount(lists) {
  let n = 0;
  for (const l of lists) n += l.length;
  return n;
}

/**
 * A multi-word synonym alternative matches only when its words sit together
 * (9.13 e). With a guard, the positions to be compared are counted against the
 * query budget first; null means the budget ran out before this document.
 */
function phraseClose(index, docId, terms, guard) {
  const es = terms.map((t) => entryOf(index, t, docId));
  if (es.some((e) => !e)) return false;
  if (es.every((e) => e.h > 0)) return true;
  if (es.every((e) => e.n > 0)) return true;
  const lists = es.map((e) => e.pos);
  if (guardTick(guard, positionCount(lists))) return null;
  return smallestSpan(lists) <= NEAR_WINDOW;
}

/**
 * Scores of a multi-word alternative: the mean of its words' scores, where
 * they sit together. The document loop checks the budget (B6 review 3); when it
 * runs out, the documents found so far are kept.
 */
function phraseScores(index, terms, weights, stats, guard) {
  const maps = terms.map((t) => termScores(index, t, weights, stats, guard));
  const out = new Map();
  if (maps.some((m) => m.size === 0)) return out;
  const smallest = maps.reduce((a, b) => (a.size <= b.size ? a : b));
  for (const docId of smallest.keys()) {
    if (guardTick(guard)) break;
    if (!maps.every((m) => m.has(docId))) continue;
    const close = phraseClose(index, docId, terms, guard);
    if (close === null) break;
    if (!close) continue;
    let sum = 0;
    for (const m of maps) sum += m.get(docId);
    out.set(docId, sum / maps.length);
  }
  return out;
}

/**
 * Closeness bonus factor for one document (9.5 d). wordTerms: Map(word ->
 * Set(matched terms)). With a guard, the positions are counted against the
 * query budget first; null means the budget ran out before this document.
 */
function closenessFactor(index, docId, wordTerms, guard) {
  if (wordTerms.size < 2) return 1;
  const lists = [];
  let allHeading = true;
  for (const terms of wordTerms.values()) {
    let inHead = false;
    const pos = [];
    for (const t of terms) {
      const e = entryOf(index, t, docId);
      if (!e) continue;
      if (e.h > 0) inHead = true;
      for (const p of e.pos) pos.push(p);
    }
    if (!inHead) allHeading = false;
    lists.push(pos);
  }
  if (allHeading) return NEAR_BONUS;
  if (guardTick(guard, positionCount(lists))) return null;
  const span = smallestSpan(lists);
  if (span <= NEAR_WINDOW) return NEAR_BONUS;
  if (span <= FAR_WINDOW) return FAR_BONUS;
  return 1;
}

// ---------------------------------------------------------------------------
// Broader matching: expansions of one query word

/** Levenshtein distance between two code-point arrays, or max + 1 once it is over max. */
function editDistance(a, b, max) {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > max) return max + 1;
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    const t = prev; prev = cur; cur = t;
  }
  return prev[m];
}

/** How many letters off a word may be: 0 under 5 letters, 1 from 5, 2 from 8 (7.2 c). */
function fuzzyDistance(len) {
  if (len >= FUZZY_TWO_MIN) return 2;
  if (len >= FUZZY_ONE_MIN) return 1;
  return 0;
}

/**
 * Expansions of one query word at the broader level, in a fixed order:
 * the word itself; a typed wildcard (its own cap of 200); then, under one cap
 * of 20 terms, family, synonym, prefix and near-spelling terms, each kind in
 * sorted (synonyms: entry) order. Once the cap is reached nothing more is
 * added and the result says so. A one-word synonym already found by an
 * earlier expansion adds nothing and uses no room, but its covers are added to
 * that expansion. ctx: { index, wordFamilies, synonyms, over, notes, partial }.
 */
function broadExpand(word, ctx) {
  const { index } = ctx;
  const w = word.w;
  const len = cpArray(w).length;
  const out = [{ term: w, weight: EXACT_WEIGHT, label: 'exact' }];
  const seen = new Set([w]);
  const byTerm = new Map([[w, out[0]]]); // single-term expansion of each seen term

  if (word.wild) {
    if (len < WILDCARD_MIN_STEM) ctx.notes.add(NOTES.WILDCARD_TOO_SHORT);
    else {
      let n = 0;
      for (const t of index.termsWithPrefix(w, WILDCARD_MAX_TERMS + 2)) {
        if (seen.has(t)) continue;
        if (n >= WILDCARD_MAX_TERMS) { ctx.notes.add(NOTES.WILDCARD_CAPPED); break; }
        const ex = { term: t, weight: PREFIX_WEIGHT, label: 'prefix' };
        out.push(ex);
        seen.add(t);
        byTerm.set(t, ex);
        n++;
      }
    }
  }

  let room = MAX_EXPANSIONS;
  let full = false;
  const add = (ex, cost) => {
    if (full) return false;
    if (cost > room) { full = true; ctx.notes.add(NOTES.EXPANSION_CAPPED); return false; }
    out.push(ex);
    room -= cost;
    if (ex.term !== undefined) { seen.add(ex.term); byTerm.set(ex.term, ex); }
    return true;
  };

  const famKey = ctx.wordFamilies === 'english' ? stem.familyKey(w, !!word.acr) : null;
  if (famKey !== null) {
    for (const t of index.familyTerms(famKey)) {
      if (seen.has(t)) continue;
      if (!add({ term: t, weight: FAMILY_WEIGHT, label: 'family' }, 1)) break;
    }
  }

  const alts = ctx.synonyms || [];
  for (const alt of alts) {
    if (full) break;
    if (alt.words.length === 1) {
      // Already found by an earlier expansion (or the word itself): no new
      // term and no room used; its covers are applied in the pass below.
      if (seen.has(alt.words[0])) continue;
      if (!add({ term: alt.words[0], weight: SYNONYM_WEIGHT, label: 'synonym', covers: alt.covers }, 1)) break;
    } else {
      if (!add({ terms: alt.words, weight: SYNONYM_WEIGHT, label: 'synonym', covers: alt.covers }, alt.words.length)) break;
    }
  }
  // Covers pass (B6 review 2), not stopped by the cap: every one-word
  // alternative whose term is among the expansions found so far adds its
  // covers to that expansion, so they apply wherever the term matches.
  for (const alt of alts) {
    if (alt.words.length !== 1 || !alt.covers.length) continue;
    const prev = byTerm.get(alt.words[0]);
    if (prev) prev.covers = [...new Set([...(prev.covers || []), ...alt.covers])];
  }

  if (!full && !word.wild && len >= PREFIX_MIN_LETTERS) {
    for (const t of index.termsWithPrefix(w, MAX_EXPANSIONS + seen.size + 2)) {
      if (seen.has(t)) continue;
      if (!add({ term: t, weight: PREFIX_WEIGHT, label: 'prefix' }, 1)) break;
    }
  }

  const d = fuzzyDistance(len);
  if (!full && d > 0) {
    const a = cpArray(w);
    const found = [];
    let checked = 0;
    let stop = false;
    for (let L = Math.max(1, len - d); L <= len + d && !stop; L++) {
      for (const t of index.bucket(L)) {
        if (++checked % BUDGET_CHECK_EVERY === 0 && ctx.over()) { ctx.partial = true; stop = true; break; }
        if (seen.has(t)) continue;
        const dist = editDistance(a, cpArray(t), d);
        if (dist <= d) found.push([dist, t]);
      }
    }
    found.sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
    for (const [, t] of found) {
      if (!add({ term: t, weight: FUZZY_WEIGHT, label: 'fuzzy' }, 1)) break;
    }
  }
  return out;
}

/**
 * Synonym groups found in the query, by query-word index: a term of 1 to 3
 * words matches consecutive query words (after the word rules), and its
 * alternatives attach to the term's first word; `covers` names the term's
 * other words, which count as matched wherever an alternative matches.
 */
function synonymHits(words, syn) {
  const hits = new Map();
  if (!isParsedSynonyms(syn) || syn.groups.size === 0) return hits;
  for (let i = 0; i < words.length; i++) {
    for (let L = Math.min(syn.maxTermWords, words.length - i); L >= 1; L--) {
      const key = words.slice(i, i + L).map((x) => x.w).join(' ');
      const alts = syn.groups.get(key);
      if (!alts) continue;
      const covers = words.slice(i + 1, i + L).map((x) => x.w);
      const list = hits.get(i) || [];
      for (const a of alts) list.push({ words: a, covers });
      hits.set(i, list);
    }
  }
  return hits;
}

function compareHits(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const fa = FLAG_ORDER[a.flag] ?? 1;
  const fb = FLAG_ORDER[b.flag] ?? 1;
  if (fa !== fb) return fa - fb;
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.line - b.line;
}

/**
 * Rank a parsed query (tokenize.parseQuery) against an index.
 *
 * options: { k, matching ('exact'|'broad', default broad), wordFamilies
 *            ('english'|'off'), synonyms (parseSynonyms result, or the raw
 *            option), includeRetired, budgetMs, now, expand, bonus }
 * result: { results: [{ key, path, heading, line, date, flag, successor,
 *           matched_by, score }], hidden: [{ path, heading }], hiddenCount,
 *           partial, truncated, matching, notes: [fixed codes] }
 */
function rank(index, parsed, options = {}) {
  const k = checkK(options.k);
  if (options.includeRetired !== undefined && typeof options.includeRetired !== 'boolean') throw argError('include_retired');
  const matching = parseMatching(options.matching);
  const broad = matching === 'broad';
  const wordFamilies = parseWordFamilies(options.wordFamilies);
  const synonyms = broad
    ? (isParsedSynonyms(options.synonyms) ? options.synonyms : parseSynonyms(options.synonyms))
    : null;
  const expand = typeof options.expand === 'function' ? options.expand : (broad ? broadExpand : exactExpand);
  const bonus = typeof options.bonus === 'function' ? options.bonus : null;
  const now = options.now || Date.now;
  const budgetMs = options.budgetMs === undefined ? QUERY_BUDGET_MS : options.budgetMs;
  const start = now();
  const over = () => now() - start >= budgetMs;

  const weights = fieldWeights(matching);
  const stats = index.stats();
  const notes = new Set();
  const words = parsed.words;
  if (!broad && words.some((wd) => wd.wild)) notes.add(NOTES.WILDCARD_IGNORED);
  const synHits = broad ? synonymHits(words, synonyms) : new Map();
  const guard = makeGuard(over);
  let partial = false;

  // Light bookkeeping (B6 review 2): one bit per distinct query word, so a
  // document's matched words are one integer, not a set, and its total is
  // kept up to date as each term is scored, inside the budgeted loops. Labels
  // are worked out only for the results returned, and the terms for the
  // closeness bonus only when it is worked out.
  const wordBit = new Map();
  for (const wd of words) if (!wordBit.has(wd.w) && wordBit.size < 32) wordBit.set(wd.w, 1 << wordBit.size);
  let allMask = 0;
  for (const b of wordBit.values()) allMask |= b;
  // docId -> { score, matched (bits), cov: null | [[word, terms]] }
  const perDoc = new Map();
  const rec = (docId) => {
    let d = perDoc.get(docId);
    if (!d) { d = { score: 0, matched: 0, cov: null }; perDoc.set(docId, d); }
    return d;
  };

  const hasExpansions = broad || typeof options.expand === 'function';
  // Per query word, only with expansions: exact scores (docId -> score), the
  // best expansion per document (docId -> { s, label }) and the expansion
  // terms that matched it (docId -> [terms]).
  const perWord = hasExpansions ? words.map(() => ({ exact: new Map(), best: new Map(), extra: new Map() })) : null;

  // Pass 1: every query word's exact term, before any expansion, so a partial
  // result still holds every exact hit; the loop itself checks the budget, so
  // a huge index cannot run past it (it then keeps the exact hits scored so far).
  for (let wi = 0; wi < words.length; wi++) {
    const w = words[wi].w;
    const scores = termScores(index, w, weights, stats, guard);
    if (perWord) perWord[wi].exact = scores;
    const bit = wordBit.get(w) || 0;
    for (const [docId, s] of scores) {
      const d = rec(docId);
      d.score += s;
      d.matched |= bit;
    }
    if (guard.stopped) { partial = true; break; }
  }

  const coverInto = (d, covers, terms) => {
    for (const cw of covers) {
      d.matched |= wordBit.get(cw) || 0;
      (d.cov || (d.cov = [])).push([cw, terms]);
    }
  };
  // One expansion's scores: a document's total moves up only when the
  // expansion beats the word's best so far (its exact score or an earlier
  // expansion); exact wins a tie.
  const apply = (wi, ex, terms, scores) => {
    const st = perWord[wi];
    const bit = wordBit.get(words[wi].w) || 0;
    const covers = ex.covers && ex.covers.length ? ex.covers : null;
    for (const [docId, s0] of scores) {
      const s = s0 * ex.weight;
      const cur = st.best.get(docId);
      const e = st.exact.get(docId);
      const d = rec(docId);
      if (cur === undefined && e === undefined) { d.score += s; d.matched |= bit; }
      else {
        const was = cur === undefined ? e : (e === undefined || cur.s > e ? cur.s : e);
        if (s > was) d.score += s - was;
      }
      if (cur === undefined || s > cur.s) st.best.set(docId, { s, label: ex.label });
      const ht = st.extra.get(docId);
      if (ht) { for (const t of terms) ht.push(t); } else st.extra.set(docId, [...terms]);
      if (covers) coverInto(d, covers, terms);
    }
  };

  // Pass 2: the expansions (family, synonym, prefix, near spelling, or a test
  // hook's list) under the query budget. The word's own exact term is not
  // scored again; covers attached to it still apply where it matched.
  for (let wi = 0; perWord && !partial && wi < words.length; wi++) {
    const word = words[wi];
    if (over()) { partial = true; break; }
    const ctx = { index, matching, wordFamilies, synonyms: synHits.get(wi) || [], over, notes, partial: false };
    const exps = expand(word, ctx);
    if (ctx.partial) partial = true;
    const st = perWord[wi];
    for (const ex of exps) {
      const terms = ex.terms || [ex.term];
      if (terms.length === 1 && terms[0] === word.w && ex.weight === EXACT_WEIGHT) {
        if (ex.covers && ex.covers.length) {
          for (const docId of st.exact.keys()) {
            if (guardTick(guard)) break;
            coverInto(rec(docId), ex.covers, terms);
          }
          if (guard.stopped) { partial = true; break; }
        }
        continue;
      }
      if (over()) { partial = true; break; }
      const scores = terms.length === 1 ? termScores(index, terms[0], weights, stats, guard) : phraseScores(index, terms, weights, stats, guard);
      apply(wi, ex, terms, scores);
      if (guard.stopped) { partial = true; break; }
    }
    if (guard.stopped) break;
  }

  /** The label of each matched word's best match in one document, sorted. */
  const labelsOf = (docId) => {
    if (!perWord) return ['exact'];
    const out = new Set();
    for (const st of perWord) {
      const e = st.exact.get(docId);
      const b = st.best.get(docId);
      if (b !== undefined && (e === undefined || b.s > e)) out.add(b.label);
      else if (e !== undefined) out.add('exact');
    }
    return [...out].sort();
  };

  /** Map(word -> Set(matched terms)) for one document, for the closeness bonus. */
  const wordTermsOf = (docId, d) => {
    const wt = new Map();
    const into = (w, list) => {
      let s = wt.get(w);
      if (!s) { s = new Set(); wt.set(w, s); }
      for (const t of list) s.add(t);
    };
    for (let wi = 0; wi < words.length; wi++) {
      const st = perWord[wi];
      const w = words[wi].w;
      if (st.exact.has(docId)) into(w, [w]);
      const ex = st.extra.get(docId);
      if (ex) into(w, ex);
    }
    if (d.cov) for (const [cw, terms] of d.cov) into(cw, terms);
    return wt;
  };
  const matchedWords = (mask) => {
    const s = new Set();
    for (const [w, b] of wordBit) if (mask & b) s.add(w);
    return s;
  };

  // Base scores: the sum over query words, with retired text ranked down.
  const cands = [];
  for (const [docId, d] of perDoc) {
    const doc = index.doc(docId);
    if (!doc) continue;
    const base = doc.flag === 'superseded' || doc.flag === 'cancelled' ? d.score * RETIRED_FACTOR : d.score;
    cands.push({ score: base, base, flag: doc.flag, path: doc.path, line: doc.line, doc, docId, d });
  }
  // Bonuses (all-words, closeness, and a test hook's), all or none (B6 review
  // 3): they are worked out only when the result is not already partial and
  // the budget is not yet over, and if it runs out part-way, the bonuses
  // already applied are dropped, so every document is ordered by its base
  // score alone ("only the hits already scored are put in order").
  if ((broad || bonus) && !partial) {
    if (over()) partial = true;
    else {
      const closeness = broad && wordBit.size >= 2;
      let stopped = false;
      for (const c of cands) {
        if (guardTick(guard)) { stopped = true; break; }
        let f = 1;
        if (broad) {
          if (words.length >= 2 && c.d.matched === allMask) f *= ALL_WORDS_BONUS;
          if (closeness) {
            const cf = closenessFactor(index, c.docId, wordTermsOf(c.docId, c.d), guard);
            if (cf === null) { stopped = true; break; }
            f *= cf;
          }
        }
        if (bonus) f *= bonus({ index, docId: c.docId, doc: c.doc, matchedWords: matchedWords(c.d.matched), queryWords: words });
        c.score = c.base * f;
      }
      if (stopped) {
        partial = true;
        for (const c of cands) c.score = c.base;
      }
    }
  }
  cands.sort(compareHits);

  // A look-up per successor, never a walk over every chunk (B6 review 3).
  const paths = { has: (p) => index.hasPath(p) };
  const toHit = (c) => {
    const { doc } = c;
    return {
      key: doc.key,
      path: doc.path,
      heading: doc.heading,
      line: doc.line,
      date: doc.date,
      flag: doc.flag,
      successor: doc.successor ? markers.resolveSuccessor(doc.successor, doc.path, paths) : null,
      matched_by: labelsOf(c.docId),
      score: c.score,
    };
  };

  const results = [];
  const hidden = [];
  let hiddenCount = 0;
  const perFile = new Map();
  for (const c of cands) {
    if (c.flag === 'cancelled' && options.includeRetired !== true) {
      hiddenCount++;
      if (hidden.length < MAX_HIDDEN_NAMED) hidden.push({ path: c.path, heading: c.doc.heading });
      continue;
    }
    if (results.length >= k) continue;
    const n = perFile.get(c.path) || 0;
    if (n >= MAX_PER_FILE) continue;
    perFile.set(c.path, n + 1);
    results.push(toHit(c));
  }
  return { results, hidden, hiddenCount, partial, truncated: !!parsed.truncated, matching, notes: [...notes].sort() };
}

module.exports = {
  K1,
  B,
  HEADING_WEIGHT,
  BODY_WEIGHT,
  NAME_WEIGHT,
  EXACT_WEIGHT,
  FAMILY_WEIGHT,
  PREFIX_WEIGHT,
  SYNONYM_WEIGHT,
  FUZZY_WEIGHT,
  LABELS,
  ALL_WORDS_BONUS,
  NEAR_WINDOW,
  NEAR_BONUS,
  FAR_WINDOW,
  FAR_BONUS,
  MAX_EXPANSIONS,
  PREFIX_MIN_LETTERS,
  WILDCARD_MIN_STEM,
  WILDCARD_MAX_TERMS,
  FUZZY_ONE_MIN,
  FUZZY_TWO_MIN,
  SYNONYM_MAX_ENTRIES,
  SYNONYM_MAX_ALTS,
  SYNONYM_MAX_WORD_CHARS,
  SYNONYM_MAX_WORDS,
  RETIRED_FACTOR,
  MAX_PER_FILE,
  K_DEFAULT,
  K_MIN,
  K_MAX,
  MAX_HIDDEN_NAMED,
  QUERY_BUDGET_MS,
  MATCHING_DEFAULT,
  NOTES,
  FLAG_ORDER,
  checkK,
  idf,
  makeGuard,
  termScores,
  smallestSpan,
  closenessFactor,
  editDistance,
  fuzzyDistance,
  exactExpand,
  broadExpand,
  synonymHits,
  parseMatching,
  parseWordFamilies,
  parseSynonyms,
  queryOptions,
  rank,
};
