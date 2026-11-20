'use strict';
// In-memory inverted index with word positions (spec 9.5, 9.6, 14.4).
//
// Built at server start from chunks.jsonl; nothing complex lives on disk.
// Three fields per chunk: heading (h), body (b) and the file's base name (n).
// The body keeps word positions (for the closeness bonus of the broader
// matching level). The vocabulary is kept sorted, with length buckets, for
// prefix and near-spelling look-ups added by the broader matching level.
//
// Word families (9.5 phase 2 a): the index keeps raw words only, plus a family
// map (family key -> sorted terms) so the word_families option needs no
// rebuild. A term joins a family only when at least one chunk holds it in a
// form the acronym rule did not catch (a term seen only as `HTTP`-style
// acronyms is never stemmed).
//
// Upkeep (B6 review): the sorted list, the length buckets and the family map
// are kept up to date as words come and go, never thrown away. A chunk change
// that adds or drops no word touches none of them. The family map changes
// only when a term's plain count goes 0 <-> 1. New and dropped words are noted
// and merged into the sorted list and buckets in one pass (no full re-sort);
// the store calls prepare() at the end of each refresh, so a query rarely does
// even that.

const tokenize = require('./tokenize.cjs');
const chunker = require('./chunker.cjs');
const stem = require('./stem.cjs');

const FIELDS = Object.freeze(['h', 'b', 'n']);

function cpLength(s) {
  return [...s].length;
}

function createIndex() {
  const docs = []; // docId -> doc record, or null when removed
  const byKey = new Map(); // chunk key -> docId
  const postings = new Map(); // term -> Map(docId -> { h, b, n, pos: [] })
  const lenSum = { h: 0, b: 0, n: 0 };
  const plainDocs = new Map(); // term -> number of chunks holding it in a non-acronym form
  const pathCount = new Map(); // file path -> number of live chunks (B6 review 3: a query never walks every chunk for paths)
  const textDocs = new Map(); // term -> chunks holding it in the heading or body (B6 review 3: the exact level's document frequency)
  let live = 0;
  let sorted = []; // the vocabulary in sorted order, once pending words are merged
  const buckets = new Map(); // length in code points -> sorted terms
  const families = new Map(); // family key -> sorted terms
  const addPending = new Set(); // new words not merged into sorted / buckets yet
  const dropPending = new Set(); // dropped words still in sorted / buckets
  const upkeep = { sorts: 0, merges: 0, familyBuilds: 0 };

  function wordAdded(term) {
    if (dropPending.has(term)) dropPending.delete(term); else addPending.add(term);
  }
  function wordDropped(term) {
    if (addPending.has(term)) addPending.delete(term); else dropPending.add(term);
  }

  /** Binary search: first index in a sorted list whose value is not below t. */
  function lowerBound(list, t) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** Merge two sorted lists (no shared values) into one. */
  function mergeSorted(a, b) {
    if (!b.length) return a;
    if (!a.length) return b;
    const out = new Array(a.length + b.length);
    let i = 0;
    let j = 0;
    let k = 0;
    while (i < a.length && j < b.length) out[k++] = a[i] < b[j] ? a[i++] : b[j++];
    while (i < a.length) out[k++] = a[i++];
    while (j < b.length) out[k++] = b[j++];
    return out;
  }

  /** Merge the noted new and dropped words into the sorted list and the buckets. */
  function flush() {
    if (addPending.size === 0 && dropPending.size === 0) return;
    if (dropPending.size) {
      const lens = new Set();
      for (const t of dropPending) lens.add(cpLength(t));
      sorted = sorted.filter((t) => !dropPending.has(t));
      for (const l of lens) {
        const b = buckets.get(l);
        if (!b) continue;
        const kept = b.filter((t) => !dropPending.has(t));
        if (kept.length) buckets.set(l, kept); else buckets.delete(l);
      }
      dropPending.clear();
    }
    if (addPending.size) {
      const add = [...addPending].sort();
      if (sorted.length === 0) upkeep.sorts++; // the first fill is the one full sort
      sorted = mergeSorted(sorted, add);
      const byLen = new Map();
      for (const t of add) {
        const l = cpLength(t);
        if (!byLen.has(l)) byLen.set(l, []);
        byLen.get(l).push(t);
      }
      for (const [l, list] of byLen) buckets.set(l, mergeSorted(buckets.get(l) || [], list));
      addPending.clear();
    }
    upkeep.merges++;
  }

  /** A term's plain count went 0 -> 1 (join its family) or 1 -> 0 (leave it). */
  function familyJoin(term) {
    const k = stem.familyKey(term);
    if (k === null) return;
    let list = families.get(k);
    if (!list) { list = []; families.set(k, list); }
    const at = lowerBound(list, term);
    if (list[at] !== term) list.splice(at, 0, term);
  }
  function familyLeave(term) {
    const k = stem.familyKey(term);
    if (k === null) return;
    const list = families.get(k);
    if (!list) return;
    const at = lowerBound(list, term);
    if (list[at] === term) list.splice(at, 1);
    if (list.length === 0) families.delete(k);
  }

  function addTerm(docId, term, field, pos) {
    let pl = postings.get(term);
    if (!pl) { pl = new Map(); postings.set(term, pl); wordAdded(term); }
    let e = pl.get(docId);
    if (!e) { e = { h: 0, b: 0, n: 0, pos: [] }; pl.set(docId, e); }
    if (field !== 'n' && e.h === 0 && e.b === 0) textDocs.set(term, (textDocs.get(term) || 0) + 1);
    e[field]++;
    if (field === 'b') e.pos.push(pos);
  }

  /** Add one chunk record. A chunk with the same key replaces the old one. */
  function add(chunk) {
    if (byKey.has(chunk.key)) remove(chunk.key);
    const docId = docs.length;
    const h = tokenize.tokenize(chunk.heading || '');
    const b = tokenize.tokenize(chunker.bodyText(chunk));
    const n = tokenize.nameTokens(chunk.path);
    const terms = new Set();
    const plain = new Set();
    const note = (t) => { terms.add(t.w); if (!t.acr) plain.add(t.w); };
    h.forEach((t) => { addTerm(docId, t.w, 'h', 0); note(t); });
    b.forEach((t) => { addTerm(docId, t.w, 'b', t.pos); note(t); });
    n.forEach((t) => { addTerm(docId, t.w, 'n', 0); note(t); });
    for (const t of plain) {
      const c = (plainDocs.get(t) || 0) + 1;
      plainDocs.set(t, c);
      if (c === 1) familyJoin(t);
    }
    const doc = {
      key: chunk.key,
      path: chunk.path,
      heading: chunk.heading || '',
      trail: chunk.trail || '',
      line: chunk.line,
      date: chunk.date || null,
      flag: chunk.flag || 'unmarked',
      successor: chunk.successor || null,
      len: { h: h.length, b: b.length, n: n.length },
      terms: [...terms],
      plain: [...plain],
    };
    docs.push(doc);
    byKey.set(chunk.key, docId);
    pathCount.set(doc.path, (pathCount.get(doc.path) || 0) + 1);
    for (const f of FIELDS) lenSum[f] += doc.len[f];
    live++;
    return docId;
  }

  /** Remove one chunk by key. */
  function remove(key) {
    const docId = byKey.get(key);
    if (docId === undefined) return false;
    const doc = docs[docId];
    for (const t of doc.terms) {
      const pl = postings.get(t);
      if (!pl) continue;
      const e = pl.get(docId);
      if (e && (e.h > 0 || e.b > 0)) {
        const c = (textDocs.get(t) || 0) - 1;
        if (c > 0) textDocs.set(t, c); else textDocs.delete(t);
      }
      pl.delete(docId);
      if (pl.size === 0) { postings.delete(t); wordDropped(t); }
    }
    for (const t of doc.plain) {
      const c = (plainDocs.get(t) || 0) - 1;
      if (c > 0) plainDocs.set(t, c);
      else { plainDocs.delete(t); familyLeave(t); }
    }
    for (const f of FIELDS) lenSum[f] -= doc.len[f];
    const pc = (pathCount.get(doc.path) || 0) - 1;
    if (pc > 0) pathCount.set(doc.path, pc); else pathCount.delete(doc.path);
    docs[docId] = null;
    byKey.delete(key);
    live--;
    return true;
  }

  /** Remove every chunk of one file. */
  function removePath(relPath) {
    let n = 0;
    for (const [key, id] of [...byKey]) {
      if (docs[id] && docs[id].path === relPath && remove(key)) n++;
    }
    return n;
  }

  /** The sorted vocabulary (do not change the returned list). */
  function vocab() {
    flush();
    return sorted;
  }

  /** Sorted terms of one length (in code points). */
  function bucket(len) {
    flush();
    return buckets.get(len) || [];
  }

  /** Up to `limit` terms starting with prefix, in sorted order (binary search). */
  function termsWithPrefix(prefix, limit) {
    const v = vocab();
    const out = [];
    for (let i = lowerBound(v, prefix); i < v.length && out.length < limit && v[i].startsWith(prefix); i++) out.push(v[i]);
    return out;
  }

  /**
   * Sorted terms whose family key equals `key` (word families, stem.familyKey).
   * Only terms that occur at least once outside the acronym rule.
   */
  function familyTerms(key) {
    return families.get(key) || [];
  }

  return {
    add,
    remove,
    removePath,
    vocab,
    bucket,
    termsWithPrefix,
    familyTerms,
    /** Merge pending word changes now (the store calls this after a refresh). */
    prepare() { flush(); },
    /** Upkeep counters: full sorts, merges, whole family-map builds (always 0). */
    upkeep() { return { ...upkeep }; },
    postingsFor(term) { return postings.get(term) || null; },
    doc(docId) { return docs[docId] || null; },
    docIdForKey(key) { const id = byKey.get(key); return id === undefined ? null : id; },
    /** The indexed file paths (a new Set; one entry per file, not per chunk). */
    paths() { return new Set(pathCount.keys()); },
    /** True when at least one live chunk comes from this file path. */
    hasPath(p) { return pathCount.has(p); },
    /** Number of chunks holding the term in the heading or body (not only in the file name). */
    textDocs(term) { return textDocs.get(term) || 0; },
    stats() {
      return {
        docs: live,
        avg: {
          h: live ? lenSum.h / live : 0,
          b: live ? lenSum.b / live : 0,
          n: live ? lenSum.n / live : 0,
        },
        terms: postings.size,
      };
    },
    *liveDocs() {
      for (let i = 0; i < docs.length; i++) if (docs[i]) yield [i, docs[i]];
    },
  };
}

/** Build an index from chunk records. */
function fromChunks(chunks) {
  const idx = createIndex();
  for (const c of chunks) idx.add(c);
  idx.prepare();
  return idx;
}

module.exports = { FIELDS, createIndex, fromChunks };
