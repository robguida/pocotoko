'use strict';
// Chunking (spec 9.3, SR-14).
//
// - Markdown is cut at headings, levels 1 to 4 (not inside fenced code). Each
//   chunk keeps its heading trail ("A › B › C") and its start line.
// - A section over about 4,000 characters is split at paragraph breaks.
// - Plain text: about 2,000-character chunks, cut at blank lines.
// - Hard maximum per chunk: 16,384 bytes of UTF-8. A run with no break that
//   would pass it is cut at the last white space before it, else at the last
//   whole character before it (never inside a UTF-8 sequence).
//
// Chunk record: key, path, heading, trail, line, date, flag, successor, text.
// Three internal fields (sec, secStart, level) are used by markers.cjs and are
// not stored.

const crypto = require('node:crypto');
const floor = require('./floor.cjs');

const SECTION_SOFT_CHARS = 4000;
const TEXT_CHUNK_CHARS = 2000;
const CHUNK_MAX_BYTES = 16384;
const MAX_CUT_LEVEL = 4;
const TRAIL_SEP = ' › ';

const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const PARA_BREAK_RE = /\n[ \t]*\r?\n/g;
const FILE_DATE_RE = /(?:^|[^0-9])([0-9]{4})-([0-9]{2})-([0-9]{2})(?![0-9])/;
const FM_DATE_RE = /^date:[ \t]*["']?([0-9]{4})-([0-9]{2})-([0-9]{2})(?![0-9])/m;

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function validDate(y, m, d) {
  const mi = Number(m);
  const di = Number(d);
  return mi >= 1 && mi <= 12 && di >= 1 && di <= 31 ? `${y}-${m}-${d}` : null;
}

/** Heading text of an ATX line, or null. The closing `#` run is dropped. */
function parseHeading(line) {
  const l = line.endsWith('\r') ? line.slice(0, -1) : line;
  const m = ATX_RE.exec(l);
  if (!m) return null;
  let t = (m[2] || '').replace(/[ \t]+#+$/, '').replace(/^#+$/, '').trim();
  return { level: m[1].length, text: t };
}

/** Front matter block at the very top: { end (offset after it), body }. */
function frontMatter(text) {
  if (!/^---[ \t]*\r?\n/.test(text)) return null;
  const re = /\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/g;
  re.lastIndex = 3;
  const m = re.exec(text);
  if (!m) return null;
  return { end: m.index + m[0].length, body: text.slice(0, m.index) };
}

/**
 * `date` of a file: a YYYY-MM-DD in the file name first, else a `date:`
 * front-matter value, else null. Never the modified time.
 */
function fileDate(relPath, text) {
  const base = String(relPath).split('/').pop() || '';
  const fm = FILE_DATE_RE.exec(base);
  if (fm) {
    const v = validDate(fm[1], fm[2], fm[3]);
    if (v) return v;
  }
  const front = frontMatter(text || '');
  if (front) {
    const m = FM_DATE_RE.exec(front.body);
    if (m) return validDate(m[1], m[2], m[3]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Splitting helpers. Every piece is { off, text } with off = offset in the file.

/** Cut so every piece is at most CHUNK_MAX_BYTES of UTF-8. */
function isSpace(c) {
  return c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0d || c === 0x0c || c === 0x0b;
}

function hardCut(piece, maxBytes = CHUNK_MAX_BYTES) {
  const { off, text } = piece;
  if (text.length * 3 <= maxBytes || Buffer.byteLength(text, 'utf8') <= maxBytes) return [piece];
  // One pass: a running byte count from the current piece start, and the
  // last white space seen in it.
  const out = [];
  let start = 0;
  let bytes = 0;
  let lastSpaceEnd = -1;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i);
    const w = cp > 0xffff ? 2 : 1;
    const b = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + b > maxBytes) {
      // Cut at the last white space in the piece, else before this character.
      const cut = lastSpaceEnd > start ? lastSpaceEnd : i;
      out.push({ off: off + start, text: text.slice(start, cut) });
      start = cut;
      bytes = Buffer.byteLength(text.slice(start, i), 'utf8');
      lastSpaceEnd = -1;
      for (let j = i - 1; j >= start; j--) {
        if (isSpace(text.charCodeAt(j))) { lastSpaceEnd = j + 1; break; }
      }
      continue; // re-check this character against the new piece
    }
    bytes += b;
    i += w;
    if (isSpace(cp)) lastSpaceEnd = i;
  }
  if (start < text.length) out.push({ off: off + start, text: text.slice(start) });
  return out;
}

/** Pack paragraphs into pieces of about softChars, cutting only at blank lines. */
function packParagraphs(piece, softChars) {
  const { off, text } = piece;
  if (text.length <= softChars) return [piece];
  const bounds = [0];
  PARA_BREAK_RE.lastIndex = 0;
  let m;
  while ((m = PARA_BREAK_RE.exec(text)) !== null) {
    const end = m.index + m[0].length;
    if (end < text.length) bounds.push(end);
    PARA_BREAK_RE.lastIndex = m.index + m[0].length - 1; // allow back-to-back blank lines
  }
  bounds.push(text.length);
  const out = [];
  let start = 0;
  for (let k = 1; k < bounds.length; k++) {
    const b = bounds[k];
    if (b - start > softChars && bounds[k - 1] > start) {
      out.push({ off: off + start, text: text.slice(start, bounds[k - 1]) });
      start = bounds[k - 1];
    }
  }
  if (start < text.length) out.push({ off: off + start, text: text.slice(start) });
  return out;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function lineOfOffset(starts, off) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= off) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

// ---------------------------------------------------------------------------

/** Markdown sections: [{ off, text, heading, trail, level }]. */
function markdownSections(text) {
  const starts = lineStarts(text);
  const sections = [];
  const stack = [];
  let fence = null;
  let cur = { off: 0, heading: '', trail: '', level: 0 };
  const fm = frontMatter(text);
  const firstLine = fm ? lineOfOffset(starts, fm.end) - 1 : 0;
  for (let li = firstLine; li < starts.length; li++) {
    const s = starts[li];
    const e = li + 1 < starts.length ? starts[li + 1] - 1 : text.length;
    const line = text.slice(s, e);
    const f = FENCE_RE.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const h = parseHeading(line);
    if (!h || h.level > MAX_CUT_LEVEL) continue;
    if (s > cur.off) sections.push({ ...cur, text: text.slice(cur.off, s) });
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    stack.push({ level: h.level, text: h.text });
    cur = { off: s, heading: h.text, trail: stack.map((x) => x.text).join(TRAIL_SEP), level: h.level };
  }
  if (cur.off < text.length) sections.push({ ...cur, text: text.slice(cur.off) });
  return sections.filter((sec) => sec.heading !== '' || sec.level > 0 || sec.text.trim() !== '');
}

/**
 * Cut one file's text into chunk records. `text` is the file text after the
 * BOM strip (the exact text that is scanned and stored).
 */
function chunkText(relPath, text) {
  const path = String(relPath);
  const date = fileDate(path, text);
  const starts = lineStarts(text);
  const md = floor.isMarkdownPath(path);
  const pieces = [];
  if (md) {
    markdownSections(text).forEach((sec, si) => {
      const soft = packParagraphs({ off: sec.off, text: sec.text }, SECTION_SOFT_CHARS);
      let first = true;
      for (const p of soft) {
        for (const h of hardCut(p)) {
          pieces.push({ ...h, heading: sec.heading, trail: sec.trail, level: sec.level, sec: si, secStart: first });
          first = false;
        }
      }
    });
  } else if (text.trim() !== '') {
    let first = true;
    for (const p of packParagraphs({ off: 0, text }, TEXT_CHUNK_CHARS)) {
      for (const h of hardCut(p)) {
        pieces.push({ ...h, heading: '', trail: '', level: 0, sec: 0, secStart: first });
        first = false;
      }
    }
  }
  return pieces.map((p, ordinal) => ({
    key: sha256(path + '\u0000' + ordinal + '\u0000' + sha256(p.text)).slice(0, 32),
    path,
    heading: p.heading,
    trail: p.trail,
    line: lineOfOffset(starts, p.off),
    date,
    flag: 'unmarked',
    successor: null,
    text: p.text,
    sec: p.sec,
    secStart: p.secStart,
    level: p.level,
  }));
}

/** Body text of a chunk for the index: without its own heading line. */
function bodyText(chunk) {
  const t = chunk.text || '';
  if (!chunk.heading) return t;
  const nl = t.indexOf('\n');
  const first = nl < 0 ? t : t.slice(0, nl);
  const h = parseHeading(first);
  if (h && h.text === chunk.heading) return nl < 0 ? '' : t.slice(nl + 1);
  return t;
}

/** The stored form of a chunk record (the nine fields of 9.3). */
function storedRecord(c) {
  return {
    key: c.key,
    path: c.path,
    heading: c.heading,
    trail: c.trail,
    line: c.line,
    date: c.date,
    flag: c.flag,
    successor: c.successor,
    text: c.text,
  };
}

module.exports = {
  SECTION_SOFT_CHARS,
  TEXT_CHUNK_CHARS,
  CHUNK_MAX_BYTES,
  MAX_CUT_LEVEL,
  TRAIL_SEP,
  parseHeading,
  fileDate,
  hardCut,
  packParagraphs,
  chunkText,
  bodyText,
  storedRecord,
};
