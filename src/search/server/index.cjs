'use strict';
// In-memory inverted index with word positions (spec 9.5, 9.6, 14.4).
//
// Built at server start from chunks.jsonl; nothing complex lives on disk.
// Three fields per chunk: heading (h), body (b) and the file's base name (n).
// The body keeps word positions (for the closeness bonus of the broader
// matching level). The vocabulary is kept sorted, with length buckets, for
// prefix and near-spelling look-ups added by the broader matching level.

const tokenize = require('./tokenize.cjs');
const chunker = require('./chunker.cjs');

const FIELDS = Object.freeze(['h', 'b', 'n']);

function cpLength(s) {
  return [...s].length;
}

function createIndex() {
  const docs = []; // docId -> doc record, or null when removed
  const byKey = new Map(); // chunk key -> docId
  const postings = new Map(); // term -> Map(docId -> { h, b, n, pos: [] })
  const lenSum = { h: 0, b: 0, n: 0 };
  let live = 0;
  let vocabCache = null;
  let bucketCache = null;

  const touchVocab = () => { vocabCache = null; bucketCache = null; };

  function addTerm(docId, term, field, pos) {
    let pl = postings.get(term);
    if (!pl) { pl = new Map(); postings.set(term, pl); touchVocab(); }
    let e = pl.get(docId);
    if (!e) { e = { h: 0, b: 0, n: 0, pos: [] }; pl.set(docId, e); }
    e[field]++;
    if (field === 'b') e.pos.push(pos);
  }

  /** Add one chunk record. A chunk with the same key replaces the old one. */
  function add(chunk) {
    if (byKey.has(chunk.key)) remove(chunk.key);
    const docId = docs.length;
    const h = tokenize.words(chunk.heading || '');
    const b = tokenize.tokenize(chunker.bodyText(chunk));
    const n = tokenize.nameWords(chunk.path);
    const terms = new Set();
    h.forEach((w) => { addTerm(docId, w, 'h', 0); terms.add(w); });
    b.forEach((t) => { addTerm(docId, t.w, 'b', t.pos); terms.add(t.w); });
    n.forEach((w) => { addTerm(docId, w, 'n', 0); terms.add(w); });
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
    };
    docs.push(doc);
    byKey.set(chunk.key, docId);
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
      pl.delete(docId);
      if (pl.size === 0) { postings.delete(t); touchVocab(); }
    }
    for (const f of FIELDS) lenSum[f] -= doc.len[f];
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

  function vocab() {
    if (!vocabCache) vocabCache = [...postings.keys()].sort();
    return vocabCache;
  }

  /** Sorted terms of one length (in code points). */
  function bucket(len) {
    if (!bucketCache) {
      bucketCache = new Map();
      for (const t of vocab()) {
        const l = cpLength(t);
        if (!bucketCache.has(l)) bucketCache.set(l, []);
        bucketCache.get(l).push(t);
      }
    }
    return bucketCache.get(len) || [];
  }

  /** Up to `limit` terms starting with prefix, in sorted order (binary search). */
  function termsWithPrefix(prefix, limit) {
    const v = vocab();
    let lo = 0;
    let hi = v.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (v[mid] < prefix) lo = mid + 1; else hi = mid;
    }
    const out = [];
    for (let i = lo; i < v.length && out.length < limit && v[i].startsWith(prefix); i++) out.push(v[i]);
    return out;
  }

  return {
    add,
    remove,
    removePath,
    vocab,
    bucket,
    termsWithPrefix,
    postingsFor(term) { return postings.get(term) || null; },
    doc(docId) { return docs[docId] || null; },
    docIdForKey(key) { const id = byKey.get(key); return id === undefined ? null : id; },
    paths() {
      const s = new Set();
      for (const d of docs) if (d) s.add(d.path);
      return s;
    },
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
  return idx;
}

module.exports = { FIELDS, createIndex, fromChunks };
