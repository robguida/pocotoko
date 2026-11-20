'use strict';
// Ranking (spec 9.5, SR-28, SR-29, SR-31). Phase 1: BM25 over exact words.
//
// Scoring is BM25F: per query term, each field's count is length-normalised
// on its own (b = 0.75), weighted (heading 2x body; the file-name field 1.5x
// is used only at the broader matching level), summed, then saturated once
// with k1 = 1.2 and multiplied by the term's IDF. A document's score is the
// sum over query words of the best expansion of that word.
//
// Hook points for the broader matching level (B6), so it adds code here
// without a rewrite:
//   - options.expand(word, ctx) -> [{ term, weight, label }]
//     (phase 1: the word itself, weight 1.0, label `exact`);
//   - options.bonus(ctx) -> a multiplier per document (phase 1: 1);
//   - the `name` field is wired in and switched on by `matching: 'broad'`.
// All numbers are named constants, covered by known-answer tests. They act at
// query time on the in-memory index, so changing one needs no rebuild.

const markers = require('./markers.cjs');

const K1 = 1.2;
const B = 0.75;
const HEADING_WEIGHT = 2.0;
const BODY_WEIGHT = 1.0;
const NAME_WEIGHT = 1.5;
const EXACT_WEIGHT = 1.0;
const RETIRED_FACTOR = 0.5; // superseded (and cancelled, when shown) text is ranked down, never hidden
const MAX_PER_FILE = 2;
const K_DEFAULT = 5;
const K_MIN = 1;
const K_MAX = 10;
const MAX_HIDDEN_NAMED = 3;
const QUERY_BUDGET_MS = 1000;
const MATCHING_LEVELS = Object.freeze(['exact', 'broad']);

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

/** Phase 1 expansion: the word itself. */
function exactExpand(word) {
  return [{ term: word.w, weight: EXACT_WEIGHT, label: 'exact' }];
}

/**
 * Score one term against the index: Map(docId -> score), before the
 * expansion weight. Exposed for known-answer tests.
 */
function termScores(index, term, weights, stats) {
  const pl = index.postingsFor(term);
  const out = new Map();
  if (!pl) return out;
  let df = 0;
  for (const e of pl.values()) {
    if (Object.keys(weights).some((f) => e[f] > 0)) df++;
  }
  if (df === 0) return out;
  const w = idf(stats.docs, df);
  for (const [docId, e] of pl) {
    const doc = index.doc(docId);
    if (!doc) continue;
    let tf = 0;
    for (const f of Object.keys(weights)) {
      if (!e[f]) continue;
      const avg = stats.avg[f];
      const norm = avg > 0 ? 1 - B + B * (doc.len[f] / avg) : 1;
      tf += weights[f] * e[f] / norm;
    }
    if (tf <= 0) continue;
    out.set(docId, w * (tf * (K1 + 1)) / (tf + K1));
  }
  return out;
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
 * options: { k, matching ('exact'|'broad'), includeRetired, budgetMs, now,
 *            expand, bonus }
 * result: { results: [{ key, path, heading, line, date, flag, successor,
 *           matched_by, score }], hidden: [{ path, heading }], hiddenCount,
 *           partial, truncated }
 */
function rank(index, parsed, options = {}) {
  const k = checkK(options.k);
  if (options.includeRetired !== undefined && typeof options.includeRetired !== 'boolean') throw argError('include_retired');
  const matching = MATCHING_LEVELS.includes(options.matching) ? options.matching : 'exact';
  const expand = typeof options.expand === 'function' ? options.expand : exactExpand;
  const bonus = typeof options.bonus === 'function' ? options.bonus : null;
  const now = options.now || Date.now;
  const budgetMs = options.budgetMs === undefined ? QUERY_BUDGET_MS : options.budgetMs;
  const start = now();
  const over = () => now() - start >= budgetMs;

  const weights = fieldWeights(matching);
  const stats = index.stats();
  const perDoc = new Map(); // docId -> { score, labels:Set, matched:Set(word) }
  let partial = false;

  for (const word of parsed.words) {
    if (over()) { partial = true; break; }
    const best = new Map(); // docId -> { s, label }: the best expansion of this word
    for (const ex of expand(word, { index, matching })) {
      if (over()) { partial = true; break; }
      const scores = termScores(index, ex.term, weights, stats);
      for (const [docId, s0] of scores) {
        const s = s0 * ex.weight;
        const cur = best.get(docId);
        if (!cur || s > cur.s) best.set(docId, { s, label: ex.label });
      }
    }
    for (const [docId, v] of best) {
      let d = perDoc.get(docId);
      if (!d) { d = { score: 0, labels: new Set(), matched: new Set() }; perDoc.set(docId, d); }
      d.score += v.s;
      d.labels.add(v.label);
      d.matched.add(word.w);
    }
  }

  const paths = index.paths();
  const hits = [];
  for (const [docId, d] of perDoc) {
    const doc = index.doc(docId);
    if (!doc) continue;
    let score = d.score;
    if (bonus) score *= bonus({ index, docId, doc, matchedWords: d.matched, queryWords: parsed.words });
    if (doc.flag === 'superseded' || doc.flag === 'cancelled') score *= RETIRED_FACTOR;
    hits.push({
      key: doc.key,
      path: doc.path,
      heading: doc.heading,
      line: doc.line,
      date: doc.date,
      flag: doc.flag,
      successor: markers.resolveSuccessor(doc.successor, doc.path, paths),
      matched_by: [...d.labels].sort(),
      score,
    });
  }
  hits.sort(compareHits);

  const results = [];
  const hidden = [];
  let hiddenCount = 0;
  const perFile = new Map();
  for (const h of hits) {
    if (h.flag === 'cancelled' && options.includeRetired !== true) {
      hiddenCount++;
      if (hidden.length < MAX_HIDDEN_NAMED) hidden.push({ path: h.path, heading: h.heading });
      continue;
    }
    if (results.length >= k) continue;
    const n = perFile.get(h.path) || 0;
    if (n >= MAX_PER_FILE) continue;
    perFile.set(h.path, n + 1);
    results.push(h);
  }
  return { results, hidden, hiddenCount, partial, truncated: !!parsed.truncated };
}

module.exports = {
  K1,
  B,
  HEADING_WEIGHT,
  BODY_WEIGHT,
  NAME_WEIGHT,
  EXACT_WEIGHT,
  RETIRED_FACTOR,
  MAX_PER_FILE,
  K_DEFAULT,
  K_MIN,
  K_MAX,
  MAX_HIDDEN_NAMED,
  QUERY_BUDGET_MS,
  FLAG_ORDER,
  checkK,
  idf,
  termScores,
  exactExpand,
  rank,
};
