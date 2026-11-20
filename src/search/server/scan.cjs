'use strict';
// The text scan: a backstop, not the main control (spec 10.3, SR-13 to SR-18).
//
// Every chunk is scanned before it is stored: its text, its heading trail and
// its path. File-level rules drop the whole file; chunk-level rules drop one
// chunk; two or more chunk-level secret hits in one file drop the file.
//
// Design (SR-18): no worker. Every regular expression here is linear-time by
// construction: a fixed literal prefix or label, bounded character-class
// runs, at most one unbounded run and only at the very end, no nested
// quantifiers, no back-references, no look-behind, no alternation inside a
// repeated group. `tests/search/scan.test.cjs` lints every pattern in
// PATTERNS against those rules. The JWT check, the randomness check, the
// contact checks and the hidden-text rule are hand-written loops. A
// cooperative time budget per file is checked between chunks and patterns.
//
// A matched value is never stored, returned, logged or printed (SR-17): the
// result carries rule ids and counts only.

const FILE_BUDGET_MS = 2000;

// SR-13 f x: the kit's own minimum number of token characters after a prefix.
const MIN_AWS = 16;
const MIN_GOOGLE = 30;
const MIN_JWT_PART = 10;
const MIN_OTHER = 20;

const TOK_CHARS = 'A-Za-z0-9._-';
const AWS_CLASS = 'A-Z0-9';
const GOOGLE_CLASS = 'A-Za-z0-9_-';

// SR-13 f: the vendor prefix list, exact. Bare prefixes only; no token text.
const VENDOR_PREFIXES = Object.freeze([
  // i. AWS access key ids
  { prefix: 'AKIA', min: MIN_AWS, cls: AWS_CLASS },
  { prefix: 'ASIA', min: MIN_AWS, cls: AWS_CLASS },
  // ii. GitHub
  { prefix: 'ghp_', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'gho_', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'ghu_', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'ghs_', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'ghr_', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'github_pat_', min: MIN_OTHER, cls: TOK_CHARS },
  // iii. GitLab
  { prefix: 'glpat-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'gloas-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'gldt-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'glrt-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'glrtr-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'glcbt-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'glptt-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'glft-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'glimt-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'glagent-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'glwt-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'glsoat-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'glffct-', min: MIN_OTHER, cls: TOK_CHARS },
  // iv. Slack (`xoxe` covers `xoxe-`, `xoxe.xoxp-` and `xoxe.xapp-`)
  { prefix: 'xoxb-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'xoxp-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'xoxa-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'xoxr-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'xoxs-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'xapp-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'xoxe', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'xwfp-', min: MIN_OTHER, cls: TOK_CHARS },
  // v. npm
  { prefix: 'npm_', min: MIN_OTHER, cls: TOK_CHARS },
  // vi. Stripe
  { prefix: 'sk_live_', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'rk_live_', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'sk_org_', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'whsec_', min: MIN_OTHER, cls: TOK_CHARS },
  // viii. AI-vendor and cloud API keys
  { prefix: 'sk-ant-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'sk-proj-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'sk-svcacct-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'sk-admin-', min: MIN_OTHER, cls: TOK_CHARS },
  { prefix: 'AIza', min: MIN_GOOGLE, cls: GOOGLE_CLASS },
]);

function escapeLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const VENDOR_PATTERNS = Object.freeze(VENDOR_PREFIXES.map((v) => Object.freeze({
  prefix: v.prefix,
  min: v.min,
  re: new RegExp(escapeLiteral(v.prefix) + '[' + v.cls + ']{' + v.min + ',}'),
})));

// File-level patterns (SR-13 a). The connection-string and signed-URL patterns
// are global: a match whose value is a whole placeholder shape (below) is
// passed over and the search goes on.
const KEY_BLOCK = /-{5}BEGIN[A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-{5}/;
const CONN_STRING = /[A-Za-z][A-Za-z0-9+.-]{1,30}:\/\/[^\s:/?#@'"<>`]{0,256}:([^\s/?#@'"`]{1,256})@/g;
const SIGNED_URL = /[?&#](x-amz-signature|x-goog-signature|sig|token|access_token|client_secret)=[^\s&#'"<>`]+/gi;
const WEBHOOK_SLACK = /hooks\.slack\.com\/services\/[A-Za-z0-9]/i;
const WEBHOOK_DISCORD = /discord(?:app)?\.com\/api\/webhooks\/[0-9]/i;
const B64_RUN = /[A-Za-z0-9_.-]+/g; // runs for the JWT loop

// Chunk-level patterns (SR-13 b, d).
const SETTING = /(password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?key)[A-Za-z0-9_]{0,32}["']?[ \t]{0,8}[:=][ \t]{0,8}["']?[^\s"'`]{8,}/gi;
// The part of a SETTING match between the label and the value (re-read to find where the value starts).
const SETTING_HEAD = /[A-Za-z0-9_]{0,32}["']?[ \t]{0,8}[:=][ \t]{0,8}["']?/y;
const AUTH_HEADER = /Authorization[ \t]{0,8}:[ \t]{0,8}(?:Basic|Bearer)[ \t]{1,8}[A-Za-z0-9._~+/=-]{8,}/i;

// Whole placeholder shapes (SR-13 a, b). A value is not a hit only when one of
// these shapes covers all of it: `<…>`, `${…}`, `$UPPER_NAME`, `%NAME%`,
// `{{…}}`, or a run of `*`. A value that merely starts with `$`, `%`, `{` or
// `*` is still a hit. Each is matched at the value's start only.
const PLACEHOLDER_SHAPES = Object.freeze([
  /^<[^<>\r\n]{1,200}>/,
  /^\$\{[^{}\r\n]{1,200}\}/,
  /^\{\{[^{}\r\n]{1,200}\}\}/,
  /^%[A-Za-z_][A-Za-z0-9_]{0,200}%/,
  /^\$[A-Z_][A-Z0-9_]*/,
  /^\*+/,
]);
const PLACEHOLDER_PEEK = 260; // the longest shape above, plus room
// What may follow a placeholder inside the same value run: closing punctuation only.
const CLOSING_PUNCT = '.,;:!?)]}>';

/**
 * True when the value text[start, end) is a whole placeholder shape. A shape
 * may run past `end` (a `<your password>` value holds a space, which ends the
 * value run); then the character after the shape must end the value. A shape
 * that ends before `end` passes only when the rest is closing punctuation.
 */
function isPlaceholderValue(text, start, end) {
  const peek = text.slice(start, start + PLACEHOLDER_PEEK);
  for (const re of PLACEHOLDER_SHAPES) {
    const m = re.exec(peek);
    if (!m) continue;
    const e = start + m[0].length;
    if (e === end) return true;
    if (e > end) {
      const after = text[e];
      if (after === undefined || /\s/.test(after) || `"'\``.includes(after) || CLOSING_PUNCT.includes(after)) return true;
      continue;
    }
    let rest = true;
    for (let j = e; j < end; j++) if (!CLOSING_PUNCT.includes(text[j])) { rest = false; break; }
    if (rest) return true;
  }
  return false;
}

// The shapes after which a `/` ends a setting value (SR-13 b2): `<…>` and `${…}`.
const URL_PATH_SHAPES = Object.freeze([PLACEHOLDER_SHAPES[0], PLACEHOLDER_SHAPES[1]]);

/**
 * SR-13 b2, setting rule only: where a setting value ends inside a URL. The
 * value ends at the first `&` or `#`, so each URL parameter is judged under its
 * own label, and at a `/` straight after a whole `${…}` or `<…>` shape.
 */
function settingValueEnd(text, start, end) {
  let cut = end;
  for (let j = start; j < end; j++) if (text[j] === '&' || text[j] === '#') { cut = j; break; }
  const peek = text.slice(start, start + PLACEHOLDER_PEEK);
  for (const re of URL_PATH_SHAPES) {
    const m = re.exec(peek);
    if (m && start + m[0].length < cut && text[start + m[0].length] === '/') return start + m[0].length;
  }
  return cut;
}

/** SR-13 a: a connection string with an inline password that is not a placeholder. */
function connHit(text) {
  CONN_STRING.lastIndex = 0;
  let m;
  while ((m = CONN_STRING.exec(text)) !== null) {
    const pwEnd = m.index + m[0].length - 1; // the `@`
    const pwStart = pwEnd - m[1].length;
    if (!isPlaceholderValue(text, pwStart, pwEnd)) return true;
    CONN_STRING.lastIndex = m.index + 1;
  }
  return false;
}

/** SR-13 a: a signed or keyed URL whose value is not a placeholder. */
function signedHit(text) {
  SIGNED_URL.lastIndex = 0;
  let m;
  while ((m = SIGNED_URL.exec(text)) !== null) {
    const vStart = m.index + 1 + m[1].length + 1;
    if (!isPlaceholderValue(text, vStart, m.index + m[0].length)) return true;
    SIGNED_URL.lastIndex = m.index + 1;
  }
  return false;
}
const RANDOM_RUN = /[A-Za-z0-9+/_=-]+/g;
const REF_COMMENT = /^[ \t]{0,3}\[[^\]\r\n]{1,200}\]:[ \t]{0,8}(?:#|<>)/m;
const TAG_ATTR = /\s(?:hidden|style)(?:[\s=/>]|$)/;
const PHONE_GROUPED = /\(?[0-9]{3}\)?[ .-]?[0-9]{3}[ .-][0-9]{4}/g;

// Character predicates for the hidden-text loop (single characters only).
const CF_RE = /^\p{Cf}$/u;
const LETTER_RE = /^\p{L}$/u;
const LETTER_OR_MARK_RE = /^[\p{L}\p{M}]$/u;
const JOINING_SCRIPT_RE = /^[\p{scx=Arab}\p{scx=Syrc}\p{scx=Thaa}\p{scx=Nkoo}\p{scx=Mong}\p{scx=Deva}\p{scx=Beng}\p{scx=Guru}\p{scx=Gujr}\p{scx=Orya}\p{scx=Taml}\p{scx=Telu}\p{scx=Knda}\p{scx=Mlym}\p{scx=Sinh}\p{scx=Mymr}\p{scx=Khmr}]$/u;
const RTL_LETTER_RE = /[\p{L}&&[\p{sc=Arab}\p{sc=Hebr}\p{sc=Syrc}\p{sc=Thaa}\p{sc=Nkoo}]]/v;
const EXT_PICT_RE = /^\p{Extended_Pictographic}$/u;
const EMOJI_RE = /^\p{Emoji}$/u;
const EMOJI_MODIFIER_RE = /^\p{Emoji_Modifier}$/u;

// Every pattern the lint checks (SR-18 b).
const PATTERNS = Object.freeze([
  ...VENDOR_PATTERNS.map((v) => v.re),
  KEY_BLOCK, CONN_STRING, SIGNED_URL, WEBHOOK_SLACK, WEBHOOK_DISCORD, B64_RUN,
  SETTING, SETTING_HEAD, AUTH_HEADER, RANDOM_RUN, REF_COMMENT, TAG_ATTR, PHONE_GROUPED,
  ...PLACEHOLDER_SHAPES,
]);

// The single-character predicates of the hand-written loops (not linted: one
// character each). Part of the rules version (floor.cjs), with PATTERNS.
const PREDICATES = Object.freeze([CF_RE, LETTER_RE, LETTER_OR_MARK_RE, JOINING_SCRIPT_RE, RTL_LETTER_RE,
  EXT_PICT_RE, EMOJI_RE, EMOJI_MODIFIER_RE]);

// Rule ids.
const R = Object.freeze({
  KEY_BLOCK: 'scan_key_block',
  VENDOR: 'scan_vendor_token',
  JWT: 'scan_jwt',
  CONN: 'scan_conn_string',
  SIGNED: 'scan_signed_url',
  WEBHOOK: 'scan_webhook',
  HIDDEN_TEXT: 'scan_hidden_text',
  CHUNK_HITS: 'scan_chunk_hits',
  TIMEOUT: 'scan_timeout',
  ERROR: 'scan_error',
  SETTING: 'scan_setting',
  AUTH: 'scan_auth_header',
  RANDOM: 'scan_random',
  HIDDEN_HTML: 'scan_hidden_html',
  CONTACT: 'scan_contact',
  NEVER_TERM: 'never_term',
});

// ---------------------------------------------------------------------------
// Small character helpers (cached per code point)

function cached(re) {
  const memo = new Map();
  return (cp) => {
    if (cp === undefined || cp < 0) return false;
    let v = memo.get(cp);
    if (v === undefined) {
      v = re.test(String.fromCodePoint(cp));
      if (memo.size < 65536) memo.set(cp, v);
    }
    return v;
  };
}

const isCf = cached(CF_RE);
const isLetterCp = cached(LETTER_RE);
const isLetterOrMark = cached(LETTER_OR_MARK_RE);
const isJoiningScript = cached(JOINING_SCRIPT_RE);
const isExtPict = cached(EXT_PICT_RE);
const isEmoji = cached(EMOJI_RE);
const isEmojiModifier = cached(EMOJI_MODIFIER_RE);

const ZWNJ = 0x200c;
const ZWJ = 0x200d;
const VS16 = 0xfe0f;

function isVariationSelector(cp) {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
}

/** The invisible characters SR-13 g is about. */
function isInvisible(cp) {
  if (cp < 0xad) return false;
  if (cp === 0xad || cp === 0x34f) return true;
  if (cp === 0x115f || cp === 0x1160 || cp === 0x3164 || cp === 0xffa0) return true;
  if (isVariationSelector(cp)) return true;
  if (cp >= 0x180b && cp <= 0x180f) return true;
  if (cp >= 0xe0000 && cp <= 0xe007f) return true;
  if (cp < 0x600) return false;
  return isCf(cp);
}

/** A joiner (ZWNJ, ZWJ) between two letters or marks of a joining script. */
function joinerBetweenScript(prev, next) {
  return isLetterOrMark(prev) && isJoiningScript(prev) && isLetterOrMark(next) && isJoiningScript(next);
}

/** SR-11 exception: one joiner allowed in a file-name segment between joining-script letters or marks. */
function joinerAllowedInName(prev, cur, next) {
  return (cur === ZWNJ || cur === ZWJ) && joinerBetweenScript(prev, next);
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ---------------------------------------------------------------------------
// Hidden text (SR-13 g): one pass over the code points.

const HIDDEN_BUDGET_EVERY = 4096; // code points between budget checks

/**
 * One pass over the code points. Returns 'hit', 'timeout' (the `over` budget
 * check fired inside the loop) or null. The line a direction mark sits on is
 * tracked in the same pass: its start moves at each line feed, and whether it
 * holds a right-to-left letter is worked out once per line, the first time a
 * mark needs it. So the work stays linear however many marks one line holds.
 */
function hiddenTextScan(text, over = null) {
  let prev = -1;
  let prev2 = -1;
  let prevInvisible = false;
  let i = 0;
  let lineStart = 0;
  let lineRtl = null; // null = not worked out yet for this line
  let count = 0;
  while (i < text.length) {
    if (over && ++count % HIDDEN_BUDGET_EVERY === 0 && over()) return 'timeout';
    const cp = text.codePointAt(i);
    const step = cp > 0xffff ? 2 : 1;
    if (cp === 0x0a) { lineStart = i + 1; lineRtl = null; }
    const inv = isInvisible(cp);
    if (inv) {
      const next = i + step < text.length ? text.codePointAt(i + step) : -1;
      let ok = false;
      if (cp === ZWNJ || cp === ZWJ) {
        if (!prevInvisible) ok = joinerBetweenScript(prev, next);
        if (!ok && cp === ZWJ && isExtPict(next)) {
          ok = (!prevInvisible && (isExtPict(prev) || isEmojiModifier(prev)))
            || (prev === VS16 && isEmoji(prev2));
        }
      } else if (cp === 0x200e || cp === 0x200f || cp === 0x061c) {
        if (!prevInvisible && !isInvisible(next)) {
          if (lineRtl === null) {
            let end = text.indexOf('\n', i);
            if (end < 0) end = text.length;
            lineRtl = RTL_LETTER_RE.test(text.slice(lineStart, end));
          }
          ok = lineRtl;
        }
      } else if (cp === 0xad) {
        ok = !prevInvisible && isLetterCp(prev) && isLetterCp(next);
      } else if (isVariationSelector(cp)) {
        ok = !prevInvisible && isEmoji(prev);
      }
      if (!ok) return 'hit';
    }
    prev2 = prev;
    prev = cp;
    prevInvisible = inv;
    i += step;
  }
  return null;
}

/** True when the text holds hidden text (SR-13 g). No budget. */
function hiddenTextHit(text) {
  return hiddenTextScan(text) === 'hit';
}

// ---------------------------------------------------------------------------
// File-level checks

function jwtHit(text) {
  B64_RUN.lastIndex = 0;
  let m;
  while ((m = B64_RUN.exec(text)) !== null) {
    const run = m[0];
    if (run.length < MIN_JWT_PART * 2 + 2 || run.indexOf('eyJ') < 0) continue;
    const parts = run.split('.');
    for (let k = 0; k + 2 < parts.length; k++) {
      const a = parts[k];
      const b = parts[k + 1];
      const aIdx = a.lastIndexOf('eyJ');
      if (aIdx < 0) continue;
      // the first part may sit inside a longer word; it starts at its `eyJ`
      if (a.length - aIdx >= MIN_JWT_PART && b.startsWith('eyJ') && b.length >= MIN_JWT_PART) return true;
    }
  }
  return false;
}

/** File-level rule for a piece of text, or null. `over` is the budget check. */
function fileLevelRule(text, over) {
  if (!text) return null;
  // Cheap literal pre-checks skip a pattern that cannot match.
  if (text.includes('BEGIN') && KEY_BLOCK.test(text)) return R.KEY_BLOCK;
  for (const v of VENDOR_PATTERNS) {
    if (over()) return R.TIMEOUT;
    if (text.includes(v.prefix) && v.re.test(text)) return R.VENDOR;
  }
  if (over()) return R.TIMEOUT;
  if (text.includes('eyJ') && jwtHit(text)) return R.JWT;
  if (text.includes('://') && connHit(text)) return R.CONN;
  if (text.includes('=') && signedHit(text)) return R.SIGNED;
  if (/services\//i.test(text) || /webhooks\//i.test(text)) {
    if (WEBHOOK_SLACK.test(text) || WEBHOOK_DISCORD.test(text)) return R.WEBHOOK;
  }
  if (over()) return R.TIMEOUT;
  const hidden = hiddenTextScan(text, over);
  if (hidden === 'timeout') return R.TIMEOUT;
  if (hidden === 'hit') return R.HIDDEN_TEXT;
  return null;
}

// ---------------------------------------------------------------------------
// Chunk-level checks

function isAsciiLetter(ch) {
  return ch !== undefined && /[A-Za-z]/.test(ch);
}
function isAsciiLower(ch) {
  return ch !== undefined && ch >= 'a' && ch <= 'z';
}
function isAsciiUpper(ch) {
  return ch !== undefined && ch >= 'A' && ch <= 'Z';
}

function settingHit(text) {
  SETTING.lastIndex = 0;
  let m;
  while ((m = SETTING.exec(text)) !== null) {
    const s = m.index;
    const e = s + m[1].length;
    const before = text[s - 1];
    const after = text[e];
    const leftEdge = s === 0 || !isAsciiLetter(before) || (isAsciiLower(before) && isAsciiUpper(text[s]));
    const rightEdge = !isAsciiLetter(after) || (isAsciiLower(text[e - 1]) && isAsciiUpper(after));
    if (leftEdge && rightEdge) {
      SETTING_HEAD.lastIndex = e;
      const head = SETTING_HEAD.exec(text);
      const vStart = e + (head ? head[0].length : 0);
      const vEnd = s + m[0].length;
      // A value that is not a whole shape up to its URL end is judged whole, as before.
      const cut = settingValueEnd(text, vStart, vEnd);
      const exempt = isPlaceholderValue(text, vStart, vEnd)
        || (cut > vStart && cut < vEnd && isPlaceholderValue(text, vStart, cut));
      if (!exempt) return true;
    }
    SETTING.lastIndex = s + 1;
  }
  return false;
}

function shannonBits(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const RANDOM_SHORT_MIN = 32;
const RANDOM_SHORT_BITS = 4.2;
const RANDOM_LONG_MIN = 40;
const RANDOM_LONG_BITS = 4.5;

function randomHit(text) {
  RANDOM_RUN.lastIndex = 0;
  let m;
  while ((m = RANDOM_RUN.exec(text)) !== null) {
    const tok = m[0];
    if (tok.length < RANDOM_SHORT_MIN) continue;
    if (!/[A-Z]/.test(tok) || !/[a-z]/.test(tok) || !/[0-9]/.test(tok)) continue;
    if (/^[0-9A-Fa-f-]+$/.test(tok)) continue; // pure hex and UUIDs pass
    const bits = shannonBits(tok);
    if (tok.length >= RANDOM_LONG_MIN ? bits >= RANDOM_LONG_BITS : bits >= RANDOM_SHORT_BITS) return true;
  }
  return false;
}

/** Chunk-level secret rule for a piece of text, or null. */
function chunkLevelRule(text) {
  if (!text) return null;
  if (settingHit(text)) return R.SETTING;
  if (AUTH_HEADER.test(text)) return R.AUTH;
  if (randomHit(text)) return R.RANDOM;
  return null;
}

/** SR-13 d: text a Markdown preview hides. */
function hiddenHtmlHit(text) {
  if (text.includes('<!--')) return true;
  if (REF_COMMENT.test(text)) return true;
  let i = text.indexOf('<');
  while (i >= 0) {
    const c = text[i + 1];
    if (c !== undefined && /[A-Za-z]/.test(c)) {
      let j = i + 1;
      const limit = Math.min(text.length, i + 1000);
      while (j < limit && text[j] !== '>' && text[j] !== '<') j++;
      if (TAG_ATTR.test(text.slice(i + 1, j).toLowerCase())) return true;
      i = text.indexOf('<', j);
    } else {
      i = text.indexOf('<', i + 1);
    }
  }
  return false;
}

const EMAIL_LOCAL = /[A-Za-z0-9._%+-]/;
const EMAIL_DOMAIN = /[A-Za-z0-9.-]/;

function emailHit(text) {
  let at = text.indexOf('@');
  while (at >= 0) {
    let l = at;
    while (l > 0 && at - l < 64 && EMAIL_LOCAL.test(text[l - 1])) l--;
    let r = at + 1;
    while (r < text.length && r - at <= 253 && EMAIL_DOMAIN.test(text[r])) r++;
    let domain = text.slice(at + 1, r);
    domain = domain.replace(/\.+$/, '');
    if (l < at && domain.includes('.')) {
      const labels = domain.split('.');
      const tld = labels[labels.length - 1];
      if (labels.every((x) => x.length > 0) && /^[A-Za-z]{2,24}$/.test(tld)) return true;
    }
    at = text.indexOf('@', at + 1);
  }
  return false;
}

function isDigit(ch) {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function phoneHit(text) {
  // International form: `+` then a digit, digits with spaces, dots, dashes or brackets.
  let p = text.indexOf('+');
  while (p >= 0) {
    const before = text[p - 1];
    if (isDigit(text[p + 1]) && !(before !== undefined && /[A-Za-z0-9]/.test(before))) {
      let digits = 0;
      let lastDigitAt = p;
      for (let j = p + 1; j < text.length && j - p <= 24; j++) {
        const ch = text[j];
        if (isDigit(ch)) { digits++; lastDigitAt = j; continue; }
        if (ch === ' ' || ch === '-' || ch === '.' || ch === '(' || ch === ')') continue;
        break;
      }
      if (digits >= 8 && digits <= 15 && !isDigit(text[lastDigitAt + 1])) return true;
    }
    p = text.indexOf('+', p + 1);
  }
  // Grouped 10-digit form: (555) 555-5555, 555-555-5555, 555.555.5555.
  PHONE_GROUPED.lastIndex = 0;
  let m;
  while ((m = PHONE_GROUPED.exec(text)) !== null) {
    const before = text[m.index - 1];
    const after = text[m.index + m[0].length];
    if (!isDigit(before) && !isDigit(after)) return true;
    PHONE_GROUPED.lastIndex = m.index + 1;
  }
  return false;
}

function contactHit(text) {
  return emailHit(text) || phoneHit(text);
}

// ---------------------------------------------------------------------------
// The file scan (SR-13, SR-15, SR-16, SR-18)

/**
 * Scan one file before anything from it is stored.
 *
 * input: { relPath, text (after the BOM strip), chunks: [{ text, trail, ... }],
 *          filter (floor.buildFilter result, optional), budgetMs, now }
 * result: { fileRule: rule id or null, kept: [chunk], dropped: { rule: count }, hits }
 * When fileRule is set, nothing from the file may be stored.
 */
function scanFile({ relPath = '', text = '', chunks = [], filter = null, budgetMs = FILE_BUDGET_MS, now = Date.now, _throwOnChunk = -1 } = {}) {
  const start = now();
  const over = () => now() - start >= budgetMs;
  const drop = (rule) => ({ fileRule: rule, kept: [], dropped: {}, hits: 0 });
  try {
    if (over()) return drop(R.TIMEOUT);
    const pathRule = fileLevelRule(relPath, over) || chunkLevelRule(relPath);
    if (pathRule) return drop(pathRule === R.TIMEOUT ? R.TIMEOUT : pathRule);
    const whole = fileLevelRule(text, over);
    if (whole) return drop(whole);
  } catch (_) {
    return drop(R.ERROR);
  }
  const kept = [];
  const dropped = {};
  let hits = 0;
  const dropChunk = (rule) => { dropped[rule] = (dropped[rule] || 0) + 1; };
  const dropContacts = filter ? filter.dropContacts !== false : true;
  for (let k = 0; k < chunks.length; k++) {
    if (over()) return drop(R.TIMEOUT);
    const c = chunks[k];
    try {
      if (k === _throwOnChunk) throw new Error('test seam');
      const trail = c.trail || '';
      const fl = fileLevelRule(c.text, over) || fileLevelRule(trail, over);
      if (fl) return drop(fl);
      if (over()) return drop(R.TIMEOUT);
      const cl = chunkLevelRule(c.text) || chunkLevelRule(trail);
      if (cl) { hits++; dropChunk(cl); continue; }
      if (hiddenHtmlHit(c.text)) { dropChunk(R.HIDDEN_HTML); continue; }
      if (dropContacts && (contactHit(c.text) || contactHit(trail))) { dropChunk(R.CONTACT); continue; }
      if (filter && filter.neverTerms && filter.neverTerms.length) {
        const lower = (c.text + '\n' + trail).toLowerCase();
        if (filter.neverTerms.some((t) => lower.includes(t))) { dropChunk(R.NEVER_TERM); continue; }
      }
      kept.push(c);
    } catch (_) {
      return drop(R.ERROR);
    }
  }
  if (over()) return drop(R.TIMEOUT); // a file that went over budget anywhere is a hit (SR-18 d)
  if (hits >= 2) return drop(R.CHUNK_HITS);
  return { fileRule: null, kept, dropped, hits };
}

// Hand-written loops (JWT, randomness, hidden text, hidden HTML, contacts)
// have no pattern source to hash. Raise this number whenever one of them
// changes what it catches, so stored files are scanned again (floor.cjs
// RULES_VERSION).
const SCAN_LOGIC_REVISION = 3;

/** Everything the scan rules version is derived from (floor.cjs). */
function ruleSources() {
  return {
    patterns: PATTERNS.map((re) => re.source + '/' + re.flags),
    predicates: PREDICATES.map((re) => re.source + '/' + re.flags),
    vendors: VENDOR_PREFIXES.map((v) => [v.prefix, v.min, v.cls]),
    constants: [MIN_AWS, MIN_GOOGLE, MIN_JWT_PART, MIN_OTHER,
      RANDOM_SHORT_MIN, RANDOM_SHORT_BITS, RANDOM_LONG_MIN, RANDOM_LONG_BITS],
    logic: SCAN_LOGIC_REVISION,
  };
}

module.exports = {
  FILE_BUDGET_MS,
  MIN_AWS,
  MIN_GOOGLE,
  MIN_JWT_PART,
  MIN_OTHER,
  VENDOR_PREFIXES,
  PATTERNS,
  PLACEHOLDER_SHAPES,
  SCAN_LOGIC_REVISION,
  RULES: R,
  RANDOM_SHORT_MIN,
  RANDOM_SHORT_BITS,
  RANDOM_LONG_MIN,
  RANDOM_LONG_BITS,
  stripBom,
  isInvisible,
  joinerAllowedInName,
  hiddenTextScan,
  hiddenTextHit,
  isPlaceholderValue,
  ruleSources,
  fileLevelRule,
  chunkLevelRule,
  hiddenHtmlHit,
  contactHit,
  shannonBits,
  scanFile,
};
