'use strict';
// Status marks: old and retired text (spec 9.4, SR-48).
//
// Recognised lines (optional leading warning sign):
//   SUPERSEDED <YYYY-MM-DD> by <relative path>
//   PARTLY SUPERSEDED <YYYY-MM-DD> by <relative path>: <which part>
//   CANCELLED <YYYY-MM-DD>: <why>
// An optional "(who)" after the path or date is accepted and thrown away:
// who wrote a mark is a claim, never shown as proof (SR-48 e).
//
// On the first line under a heading, a mark gives the whole section that flag
// (and the sections nested under it). Anywhere else in the section it gives
// `partly`. A line that starts with one of the words but does not parse fully
// gives `unconfirmed`. `unmarked` means no mark was found, never "current".
// A file-wide mark (the first line of the title block) on a file of more than
// 20 chunks is downgraded to `unconfirmed`, counted as `suspect_mark`, and
// hides nothing. Marks are read from the scanned, stored chunk text only.

const FLAGS = Object.freeze(['unmarked', 'partly', 'unconfirmed', 'superseded', 'cancelled']);
const FILE_WIDE_MAX_CHUNKS = 20;

const LEAD_RE = /^[ \t]*(?:\u26a0\ufe0f?[ \t]*)?/;
const WORD_RE = /^(PARTLY SUPERSEDED|SUPERSEDED|CANCELLED)(?![A-Za-z])/;
const DATE = '([0-9]{4})-([0-9]{2})-([0-9]{2})';
const WHO = '(?: \\([^()\\r\\n]{1,200}\\))?';
const PATH = '`?([^\\s`]{1,240})`?';
const SUPERSEDED_RE = new RegExp('^SUPERSEDED ' + DATE + ' by ' + PATH + WHO + '[ \\t]*$');
const PARTLY_RE = new RegExp('^PARTLY SUPERSEDED ' + DATE + ' by ' + PATH + WHO + ': \\S.*$');
const CANCELLED_RE = new RegExp('^CANCELLED ' + DATE + WHO + ': \\S.*$');

function validDate(m, at) {
  const mo = Number(m[at + 1]);
  const d = Number(m[at + 2]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
}

function cleanSuccessor(p) {
  let s = p.replace(/[),.;]+$/, '');
  if (s.endsWith(':')) s = s.slice(0, -1);
  if (s === '' || s.startsWith('/') || s.startsWith('\\') || /^[A-Za-z]:/.test(s)) return null;
  return s.split('\\').join('/');
}

/**
 * Parse one line. Returns null (no mark), { kind: 'unconfirmed' }, or
 * { kind: 'superseded' | 'partly' | 'cancelled', successor }.
 */
function parseMarkLine(rawLine) {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  const rest = line.slice(LEAD_RE.exec(line)[0].length);
  const w = WORD_RE.exec(rest);
  if (!w) return null;
  if (w[1] === 'SUPERSEDED') {
    const m = SUPERSEDED_RE.exec(rest);
    if (!m || !validDate(m, 1)) return { kind: 'unconfirmed' };
    const succ = cleanSuccessor(m[4]);
    return succ ? { kind: 'superseded', successor: succ } : { kind: 'unconfirmed' };
  }
  if (w[1] === 'PARTLY SUPERSEDED') {
    const m = PARTLY_RE.exec(rest);
    if (!m || !validDate(m, 1)) return { kind: 'unconfirmed' };
    const succ = cleanSuccessor(m[4]);
    return succ ? { kind: 'partly', successor: succ } : { kind: 'unconfirmed' };
  }
  const m = CANCELLED_RE.exec(rest);
  if (!m || !validDate(m, 1)) return { kind: 'unconfirmed' };
  return { kind: 'cancelled', successor: null };
}

function linesUnderHeading(chunk) {
  let t = chunk.text || '';
  if (chunk.level > 0) {
    const nl = t.indexOf('\n');
    t = nl < 0 ? '' : t.slice(nl + 1);
  }
  return t.split('\n');
}

/**
 * Set `flag` and `successor` on the chunks of one file (the kept, scanned
 * chunks, in order). Chunks carry the chunker's internal fields sec,
 * secStart and level. Returns { chunks, counts: { suspect_mark } }.
 */
function applyMarks(chunks) {
  const counts = { suspect_mark: 0 };
  if (!chunks.length) return { chunks, counts };

  // Group by section, in order.
  const sections = [];
  const bySec = new Map();
  for (const c of chunks) {
    let s = bySec.get(c.sec);
    if (!s) { s = { sec: c.sec, level: c.level, pieces: [] }; bySec.set(c.sec, s); sections.push(s); }
    s.pieces.push(c);
  }

  for (const s of sections) {
    let firstMark = null;
    let partly = false;
    let unconfirmed = false;
    let successor = null;
    let seenFirst = false;
    for (const c of s.pieces) {
      const lines = c.secStart ? linesUnderHeading(c) : (c.text || '').split('\n');
      for (const line of lines) {
        const isFirst = c.secStart && !seenFirst && line.trim() !== '';
        if (isFirst) seenFirst = true;
        const mk = parseMarkLine(line);
        if (!mk) continue;
        if (mk.kind === 'unconfirmed') { if (isFirst) firstMark = mk; else unconfirmed = true; continue; }
        if (!successor && mk.successor) successor = mk.successor;
        if (isFirst) firstMark = mk;
        else partly = true;
      }
    }
    let flag = 'unmarked';
    if (firstMark && (firstMark.kind === 'superseded' || firstMark.kind === 'cancelled')) flag = firstMark.kind;
    else if ((firstMark && firstMark.kind === 'unconfirmed') || unconfirmed) flag = 'unconfirmed';
    else if ((firstMark && firstMark.kind === 'partly') || partly) flag = 'partly';
    s.flag = flag;
    s.successor = successor;
    s.full = flag === 'superseded' || flag === 'cancelled';
  }

  // A full mark covers the sections nested under it. The title block is the
  // file's true first section (section 0, before any scan drop): when the scan
  // dropped it, no later section can act as the title block.
  const first = sections[0];
  const fileWide = first.full && first.sec === 0 && first.level <= 1;
  if (fileWide && chunks.length > FILE_WIDE_MAX_CHUNKS) {
    counts.suspect_mark++;
    for (const c of chunks) { c.flag = 'unconfirmed'; c.successor = null; }
    return { chunks, counts };
  }
  const stack = [];
  for (const s of sections) {
    while (stack.length && stack[stack.length - 1].level >= s.level && s.level > 0) stack.pop();
    let flag = s.flag;
    let successor = s.successor;
    const cover = stack.length ? stack[stack.length - 1] : null;
    if (cover) ({ flag, successor } = combine({ flag, successor, full: s.full }, cover));
    if (fileWide && s !== first) ({ flag, successor } = combine({ flag, successor, full: s.full || !!cover }, first));
    for (const c of s.pieces) { c.flag = flag; c.successor = successor; }
    if (s.full || cover) stack.push({ level: s.level, flag, successor });
  }
  return { chunks, counts };
}

/**
 * A section's own flag under a covering full mark. Cancelled always wins (it
 * hides text, so a wider superseded mark never brings cancelled text back);
 * otherwise the section's own full mark wins, else the cover's.
 */
function combine(own, cover) {
  if (own.full && own.flag === 'cancelled') return { flag: own.flag, successor: own.successor };
  if (cover.flag === 'cancelled') return { flag: 'cancelled', successor: cover.successor };
  if (own.full) return { flag: own.flag, successor: own.successor };
  return { flag: cover.flag, successor: cover.successor };
}

/**
 * Resolve a stored successor against the index's paths: the path itself
 * (project-relative) or relative to the marked file's folder. Returns the
 * indexed path, 'unresolved', or null when there is no successor.
 */
function resolveSuccessor(raw, fromPath, paths) {
  if (!raw) return null;
  if (paths.has(raw)) return raw;
  const dir = String(fromPath).split('/').slice(0, -1);
  const parts = [...dir];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return 'unresolved'; parts.pop(); continue; }
    parts.push(seg);
  }
  const joined = parts.join('/');
  return paths.has(joined) ? joined : 'unresolved';
}

module.exports = { FLAGS, FILE_WIDE_MAX_CHUNKS, parseMarkLine, applyMarks, resolveSuccessor };
