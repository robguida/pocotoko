'use strict';
// Chat-length meter (spec section 6). One script, four entry points:
//   (no argument)            the UserPromptSubmit hook: warns once per tier as the chat grows
//   --statusline             the status line: one passive line, never writes to disk
//   --sync                   plugin mode only: copies this file to <data folder>/statusline/
//                            and writes <data folder>/config/meter-config.json; takes no path
//   --selftest <transcript>  prints what the meter can read from a transcript (counts and
//                            the size only); writes nothing
//
// Node built-ins only. No network, no child process, no shell. Always exits 0 and never
// blocks a prompt. The command line starts only when process.argv[1] is this file
// (real-path compare), so tests can load the functions without running anything.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Defaults, limits and fixed lines

/** Option defaults (spec 6.2). The plugin manifest's userConfig defaults equal these (tested). */
const DEFAULTS = Object.freeze({
  soft_tokens: 100000,
  hard_tokens: 150000,
  repeat_every_tokens: 50000,
  handoff_note: true,
  handoff_dir: '',
  routing_rules_at_start: true,
});

/** Validation rule per option (spec 6.2). */
const OPTION_RULES = Object.freeze({
  soft_tokens: Object.freeze({ type: 'number', min: 10000 }),
  hard_tokens: Object.freeze({ type: 'number', min: 20000 }),
  repeat_every_tokens: Object.freeze({ type: 'number', min: 0 }),
  handoff_note: Object.freeze({ type: 'boolean' }),
  handoff_dir: Object.freeze({ type: 'directory' }),
  routing_rules_at_start: Object.freeze({ type: 'boolean' }),
});

const LIMITS = Object.freeze({
  STDIN_MAX_BYTES: 1024 * 1024, // 6.9
  SELF_KILL_MS: 2500, // 6.9
  READ_BUDGET_MS: 1500, // transcript reading stops here, well inside the self-kill
  TRANSCRIPT_READ_CAP: 64 * 1024 * 1024, // 6.3: read from the end, at most this much
  FIRST_CHUNK: 64 * 1024,
  MAX_CHUNK: 16 * 1024 * 1024,
  SMALL_FLOOR: 262144, // 6.8: the loud notice needs a transcript of at least this many bytes
  PRUNE_AGE_MS: 14 * 24 * 60 * 60 * 1000, // 6.7
  TEMP_MAX_AGE_MS: 10 * 60 * 1000, // 6.7
  SMALL_FILE_MAX_BYTES: 64 * 1024, // config and state files
  NOTE_CLASH_MAX: 9, // 6.6 a: -2 up to -9
  NOTE_NAME_MAX: 80, // 6.6: before `.md`
  NOTE_FOLDER_PART_MAX: 40,
  NOTE_SESSION_PART: 8,
});

/** Environment prefix Claude Code uses for plugin options in hook commands (spec 3.1 fact 2). */
const ENV_PREFIX = 'CLAUDE_PLUGIN_OPTION_';

const LINES = Object.freeze({
  // 6.9: the Node self-check (the display name opens the fixed user lines, spec 2.2).
  NODE_IN_PROJECT: 'PocoToko: Node is running from inside this project folder, so the kit did nothing. Run Node from outside the project; see the install docs.',
  // 6.8: the loud real-format notice, word for word.
  FORMAT: "chat-length meter cannot read this chat's format; it is off for this session",
  CONFIG_INVALID: 'chat-length meter: the meter options are not valid, so the built-in defaults are used for this session.',
  HANDOFF_DIR_REFUSED: 'chat-length meter: the hand-off folder option was refused (it must be an absolute path to an existing folder outside this project and outside any git repo), so the default hand-off folder is used.',
  PLUGIN_DATA_IGNORED: 'chat-length meter: CLAUDE_PLUGIN_DATA is set, but this copy runs outside the plugin cache, so the variable was ignored and the kit folder is used.',
  NOTE_CLASH: 'chat-length meter: no new hand-off note file could be created (the names up to -9 are taken), so no note was requested.',
  NOTE_FAILED: 'chat-length meter: the hand-off note file could not be created, so no note was requested.',
});

const SESSION_FILE_RE = /^(?:[a-z0-9_-]{1,64}|h-[0-9a-f]{32})\.json$/;
// <name>.<pid>.<16 hex>.tmp; group 1 is <name>. Temp cleanup removes a match only when
// <name> is a file this script writes in that folder (TEMP_BASES), so a user's own file in
// a hand-edited copy-by-hand folder is never taken for a temp file.
const TEMP_NAME_RE = /^([A-Za-z0-9_-]{1,66}\.(?:json|cjs))\.[0-9]{1,10}\.[0-9a-f]{16}\.tmp$/;
const TEMP_BASES = Object.freeze({
  'state/sessions': (base) => SESSION_FILE_RE.test(base),
  config: (base) => base === 'meter-config.json',
  statusline: (base) => base === 'meter.cjs',
});
const RESERVED_DEVICE_RE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

const C = fs.constants;
const O_NOFOLLOW = C.O_NOFOLLOW || 0; // not on Windows
const O_NONBLOCK = C.O_NONBLOCK || 0;
const O_DIRECTORY = C.O_DIRECTORY || 0;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// Small helpers

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function isWindows(platform) {
  return platform === 'win32';
}

function pathApi(platform) {
  return isWindows(platform) ? path.win32 : path.posix;
}

/** JSON with every character outside printable ASCII written as \uXXXX (6.9). */
function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Absolute path test that also refuses a Windows path with no drive (`\x`, `C:x`). */
function isAbsoluteFor(p, platform = process.platform) {
  if (typeof p !== 'string' || p === '') return false;
  if (isWindows(platform)) return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
  return path.posix.isAbsolute(p);
}

// ---------------------------------------------------------------------------
// Path compare (SR-5). Gives the same answers as the search server's own compare (T-25).

function foldForCompare(p, platform) {
  let r = p;
  if (platform === 'darwin') r = r.normalize('NFC');
  if (platform === 'win32' || platform === 'darwin') r = r.toLowerCase();
  return r;
}

/**
 * True when child is parent itself or sits inside it. Path-aware: `/x/ab` is not inside
 * `/x/a`; a child folder named `..notes` is inside; another drive or a UNC path is not.
 * Case-insensitive on Windows and macOS.
 */
function isInside(child, parent, platform = process.platform) {
  const P = pathApi(platform);
  const c = foldForCompare(P.resolve(child), platform);
  const p = foldForCompare(P.resolve(parent), platform);
  const rel = P.relative(p, c);
  if (rel === '') return true;
  if (P.isAbsolute(rel)) return false;
  if (rel === '..' || rel.startsWith('..' + P.sep)) return false;
  return true;
}

function samePath(a, b, platform = process.platform) {
  const P = pathApi(platform);
  return foldForCompare(P.resolve(a), platform) === foldForCompare(P.resolve(b), platform);
}

/** Real path of p; parts that do not exist yet are kept as written on top of the nearest real parent. */
function realLoose(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch (_) {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = up;
    }
  }
}

function isFilesystemRoot(p, platform = process.platform) {
  const P = pathApi(platform);
  const r = P.resolve(p);
  return P.parse(r).root === r || samePath(P.dirname(r), r, platform);
}

/**
 * True when a `.git` file or folder is found in p or any folder above it (6.7). Fails
 * closed: a check that fails with anything other than not-found (ENOENT, ENOTDIR) counts
 * as found, the same as isPluginSourceFolder. ceiling: test-only seam; the walk up stops
 * after that folder (the tests run inside the repo's own work tree). _lstat: test-only seam.
 */
function inGitWorkTree(p, ceiling = null, _lstat = fs.lstatSync) {
  let cur = path.resolve(p);
  for (;;) {
    try {
      _lstat(path.join(cur, '.git'));
      return true;
    } catch (err) {
      if (!(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))) return true;
    }
    if (ceiling && samePath(cur, ceiling)) return false;
    const up = path.dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

// ---------------------------------------------------------------------------
// Install mode (6.7, SR-C10)

function homeDir() {
  return realLoose(os.homedir());
}

/** The config folder: CLAUDE_CONFIG_DIR when set to an absolute path, else <home>/.claude. */
function configDirOf(env, home, platform = process.platform) {
  const v = env.CLAUDE_CONFIG_DIR;
  if (nonEmpty(v) && isAbsoluteFor(v.trim(), platform)) return realLoose(v.trim());
  return realLoose(path.join(home, '.claude'));
}

/** The plugins folder (SR-4 g): CLAUDE_CODE_PLUGIN_CACHE_DIR when set, else <config>/plugins. */
function pluginsDirOf(env, configDir, platform = process.platform) {
  const v = env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  if (nonEmpty(v) && isAbsoluteFor(v.trim(), platform)) return realLoose(v.trim());
  return realLoose(path.join(configDir, 'plugins'));
}

/** True when dir holds `.claude-plugin/plugin.json` (any kind of entry; other errors fail closed). */
function isPluginSourceFolder(dir) {
  try {
    fs.lstatSync(path.join(dir, '.claude-plugin', 'plugin.json'));
    return true;
  } catch (err) {
    return !(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'));
  }
}

/**
 * The 6.7 rule, never CLAUDE_PLUGIN_DATA alone (SR-C10). Returns
 * { mode: 'plugin' | 'copy' | 'none', stateRoot, sourceFolder, pluginDataIgnored, scriptReal }.
 * - plugin: the variable is set (absolute) and this script's real path is inside the plugins
 *   folder; state root = the variable's real path.
 * - none: the script sits inside the plugins folder but the variable is unset or empty;
 *   nothing is written.
 * - copy: every other case; state root = the folder above this script's folder (the kit
 *   folder). sourceFolder: the kit folder holds `.claude-plugin/plugin.json` (a plugin folder
 *   run from outside the plugin cache), so nothing is written.
 */
function installMode({ env, scriptFile, home, platform = process.platform }) {
  const configDir = configDirOf(env, home, platform);
  const pluginsDir = pluginsDirOf(env, configDir, platform);
  const scriptReal = realLoose(scriptFile);
  const inPlugins = isInside(scriptReal, pluginsDir, platform);
  const raw = env.CLAUDE_PLUGIN_DATA;
  const varSet = nonEmpty(raw) && isAbsoluteFor(raw.trim(), platform);
  if (inPlugins) {
    if (!varSet) return { mode: 'none', stateRoot: null, sourceFolder: false, pluginDataIgnored: false, scriptReal };
    return { mode: 'plugin', stateRoot: realLoose(raw.trim()), sourceFolder: false, pluginDataIgnored: false, scriptReal };
  }
  const kit = path.dirname(path.dirname(scriptReal));
  return { mode: 'copy', stateRoot: kit, sourceFolder: isPluginSourceFolder(kit), pluginDataIgnored: nonEmpty(raw), scriptReal };
}

/**
 * Why the core must write nothing, or null (6.7, SR-C8): 'plugin_data_not_set',
 * 'source_folder', or 'in_git' (the state root's real path is inside a git work tree).
 */
function writeBlock(mode, gitCeiling = null) {
  if (mode.mode === 'none') return 'plugin_data_not_set';
  if (mode.sourceFolder) return 'source_folder';
  if (inGitWorkTree(realLoose(mode.stateRoot), gitCeiling)) return 'in_git';
  return null;
}

// ---------------------------------------------------------------------------
// Node self-check (6.9, SR-44a)

/**
 * True when the real path of the running Node program sits inside the project folder or
 * the start folder. A folder that is a filesystem root, the home folder or above it is not
 * tested (a user-wide Node is inside those).
 */
function nodeInsideProject({ execPath, projectDir, cwd, home, platform = process.platform }) {
  let exe;
  try {
    exe = fs.realpathSync.native(execPath);
  } catch (_) {
    exe = path.resolve(execPath);
  }
  const folders = [];
  if (nonEmpty(projectDir) && isAbsoluteFor(projectDir, platform)) folders.push(projectDir);
  if (nonEmpty(cwd)) folders.push(cwd);
  for (const f of folders) {
    let real;
    try { real = fs.realpathSync.native(f); } catch (_) { continue; }
    if (isFilesystemRoot(real, platform)) continue;
    if (home && isInside(home, real, platform)) continue;
    if (isInside(exe, real, platform)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Session id cleaning (6.7, SR-C9)

/**
 * The cleaned session id, or null for a missing, empty or non-string id. A raw id that
 * matches [A-Za-z0-9_-]{1,64} and is not a Windows device name is lower-cased; anything
 * else becomes `h-` plus the first 32 hex characters of its SHA-256.
 */
function cleanSessionId(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  if (/^[A-Za-z0-9_-]{1,64}$/.test(raw) && !RESERVED_DEVICE_RE.test(raw)) return raw.toLowerCase();
  return 'h-' + crypto.createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex').slice(0, 32);
}

/** <root>/state/sessions/<cleaned>.json, checked to sit directly inside state/sessions/, else null. */
function statePathFor(stateRoot, cleaned) {
  const dir = path.join(stateRoot, 'state', 'sessions');
  if (typeof cleaned !== 'string') return null;
  const p = path.join(dir, cleaned + '.json');
  if (path.dirname(p) !== dir || !SESSION_FILE_RE.test(path.basename(p))) return null;
  return p;
}

// ---------------------------------------------------------------------------
// Options (6.2)

function isUnsetValue(v) {
  if (v === undefined || v === null) return true;
  if (typeof v !== 'string') return false;
  const t = v.trim();
  return t === '' || t.startsWith('${user_config.');
}

/**
 * Plugin mode: the raw option values from CLAUDE_PLUGIN_OPTION_<KEY>. Absent or empty means
 * "use the default" (a never-set option is not stored, so absent is the normal case).
 */
function readEnvOptions(env) {
  // Live (second logged-in probe, Claude Code 2.1.329): every plugin hook gets one variable
  // per SET option, named CLAUDE_PLUGIN_OPTION_ plus the key in upper case (soft_tokens ->
  // CLAUDE_PLUGIN_OPTION_SOFT_TOKENS), holding the stored text as written; a hook whose
  // command names no option gets them too. A never-set option has no variable, and one set
  // to "" arrives as empty text, so absent, empty or raw ${user_config...} text all mean the
  // default. Only the upper-case name is read: no other form was seen or is documented.
  const raw = {};
  for (const key of Object.keys(DEFAULTS)) {
    const v = env[ENV_PREFIX + key.toUpperCase()];
    if (typeof v === 'string' && !isUnsetValue(v)) raw[key] = v;
  }
  return raw;
}

function parseNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\s*-?[0-9]+(?:\.[0-9]+)?\s*$/.test(v)) return Number(v);
  return NaN;
}

function parseBoolean(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true') return true;
    if (t === 'false') return false;
  }
  return null;
}

/**
 * One validation for every source (6.2): env strings, the config file's JSON values.
 * Returns { options, invalid }. Any wrong type, value under its minimum, non-integer, or
 * soft_tokens >= hard_tokens -> all built-in defaults, invalid: true. Unknown keys are ignored.
 */
function validateOptions(raw) {
  const out = { ...DEFAULTS };
  let invalid = false;
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!src) return { options: { ...DEFAULTS }, invalid: raw !== undefined && raw !== null };
  for (const [key, rule] of Object.entries(OPTION_RULES)) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    const v = src[key];
    if (isUnsetValue(v)) continue;
    if (rule.type === 'number') {
      const n = parseNumber(v);
      if (!Number.isSafeInteger(n) || n < rule.min) { invalid = true; continue; }
      out[key] = n;
    } else if (rule.type === 'boolean') {
      const b = parseBoolean(v);
      if (b === null) { invalid = true; continue; }
      out[key] = b;
    } else {
      if (typeof v !== 'string') { invalid = true; continue; }
      out[key] = v.trim();
    }
  }
  if (!invalid && out.soft_tokens >= out.hard_tokens) invalid = true;
  if (invalid) return { options: { ...DEFAULTS }, invalid: true };
  return { options: out, invalid: false };
}

/**
 * Read a small JSON file we own or the user edits, through one handle, never following a
 * link. Returns { value } | { absent: true } | { problem }.
 */
function readSmallJson(file, maxBytes = LIMITS.SMALL_FILE_MAX_BYTES) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return { absent: true };
    return { problem: 'stat_failed' };
  }
  if (st.isSymbolicLink()) return { problem: 'link' };
  if (!st.isFile()) return { problem: 'not_file' };
  let fd = null;
  try {
    fd = fs.openSync(file, C.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const fst = fs.fstatSync(fd);
    if (!fst.isFile()) return { problem: 'not_file' };
    if (fst.size > maxBytes) return { problem: 'too_big' };
    const buf = Buffer.alloc(fst.size);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    return { value: JSON.parse(buf.subarray(0, got).toString('utf8')) };
  } catch (_) {
    return { problem: 'unreadable' };
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) { /* ignore */ }
  }
}

/**
 * The options for a run (6.2): plugin mode hooks read env; everything else reads the config
 * file. The config folder is checked first (6.7): a missing folder gives the defaults with no
 * notice; a folder that is a link or junction, or whose real path is not its own path (a
 * link at a parent), is not read and counts as an invalid config.
 */
function loadOptions({ source, env, configFile, platform = process.platform }) {
  if (source === 'env') return validateOptions(readEnvOptions(env));
  const dir = path.dirname(configFile);
  const why = folderProblem(dir, dir, platform);
  if (why === 'missing') return { options: { ...DEFAULTS }, invalid: false };
  if (why) return { options: { ...DEFAULTS }, invalid: true };
  const r = readSmallJson(configFile);
  if (r.absent) return { options: { ...DEFAULTS }, invalid: false };
  if (r.problem) return { options: { ...DEFAULTS }, invalid: true };
  return validateOptions(r.value);
}

// ---------------------------------------------------------------------------
// Size, tiers and display (6.3, 6.4, 6.5)

/** input + cache creation + cache read of one usage object, or null when it holds none of them. */
function usageSum(u) {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
  let sum = 0;
  let seen = 0;
  for (const k of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    if (!Object.prototype.hasOwnProperty.call(u, k) || u[k] === null || u[k] === undefined) continue;
    const v = u[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
    sum += v;
    seen++;
  }
  return seen ? Math.floor(sum) : null;
}

/**
 * Display only (6.4): below 999,500 `<k>k` (half up), else `<m>M` with one decimal, so a
 * size never shows as `1000k` (999,500 to 999,999 show as `1.0M`).
 */
function fmtSize(n) {
  if (n >= 999500) return (Math.round(n / 100000) / 10).toFixed(1) + 'M';
  return Math.round(n / 1000) + 'k';
}

/** The tier of a raw integer size (6.4): 'quiet', 'soft' or 'hard'; ">=" everywhere. */
function tierOf(size, opts) {
  if (size >= opts.hard_tokens) return 'hard';
  if (size >= opts.soft_tokens) return 'soft';
  return 'quiet';
}

/**
 * Once per tier (6.5) and the repeat rule (6.4). Pure. Returns { state, fire } where fire is
 * null, 'soft', 'hard' or 'repeat'. Below soft re-arms both flags.
 */
function tierStep(state, size, opts) {
  const s = { soft: !!state.soft, hard: !!state.hard, hard_at: Number.isSafeInteger(state.hard_at) ? state.hard_at : null };
  const tier = tierOf(size, opts);
  if (tier === 'quiet') return { state: { soft: false, hard: false, hard_at: null }, fire: null };
  if (tier === 'soft') {
    if (s.soft) return { state: s, fire: null };
    return { state: { ...s, soft: true }, fire: 'soft' };
  }
  if (!s.hard) return { state: { soft: true, hard: true, hard_at: size }, fire: 'hard' };
  if (opts.repeat_every_tokens > 0 && s.hard_at !== null && size >= s.hard_at + opts.repeat_every_tokens) {
    return { state: { ...s, hard_at: size }, fire: 'repeat' };
  }
  return { state: s, fire: null };
}

// ---------------------------------------------------------------------------
// Transcript reading (6.3, 6.8)

/** Default compaction test: Claude Code's compact boundary record (not yet seen live; see the changelog). */
const DEFAULT_COMPACTION = Object.freeze({
  marker: 'compact_boundary',
  test: (rec) => rec.type === 'system' && rec.subtype === 'compact_boundary',
});

/**
 * Read the size from a transcript, from the end, in growing chunks (at most the read cap).
 * The newest main-thread `assistant` record with `message.usage` whose sum is above 0 gives
 * the size; a compaction record newer than it gives 0. `cost-state` running totals are never used.
 * Returns { status, size, fileBytes, counts } where status is one of: 'found', 'none'
 * (the whole window was read, no usage record), 'missing', 'not_file', 'unreadable',
 * 'timeout'. opts: { full: count every line (selftest), deadline (ms timestamp), clock,
 * compaction (test seam) }.
 */
function readTranscriptSize(file, opts = {}) {
  // assistant_lines: lines holding the JSON string "assistant" (a record type or a message
  // role), so a reply exists. readable_usage: main-thread assistant records whose
  // message.usage is in the read shape, a zero sum included (the format is readable). Both
  // are complete only when the whole window was read (status 'none').
  const counts = { lines: 0, usage_records: 0, side_chain_skipped: 0, unreadable_lines: 0, assistant_lines: 0, readable_usage: 0 };
  const out = { status: 'none', size: null, fileBytes: 0, counts };
  const clock = opts.clock || Date.now;
  const comp = opts.compaction || DEFAULT_COMPACTION;
  const cap = opts.cap || LIMITS.TRANSCRIPT_READ_CAP;
  const marker = Buffer.from(comp.marker, 'utf8');
  const assistantMark = Buffer.from('"assistant"', 'utf8');
  if (typeof file !== 'string' || file === '' || file.includes('\u0000')) { out.status = 'missing'; return out; }
  let fd = null;
  try {
    try {
      fd = fs.openSync(file, C.O_RDONLY | O_NONBLOCK);
    } catch (err) {
      out.status = err && (err.code === 'ENOENT' || err.code === 'ENOTDIR') ? 'missing' : (err && err.code === 'EISDIR' ? 'not_file' : 'unreadable');
      return out;
    }
    const st = fs.fstatSync(fd);
    if (!st.isFile()) { out.status = 'not_file'; return out; }
    const total = st.size;
    out.fileBytes = total;
    const lower = Math.max(0, total - cap);
    let pos = total;
    let carry = Buffer.alloc(0);
    let chunk = LIMITS.FIRST_CHUNK;
    while (pos > lower) {
      if (opts.deadline && clock() > opts.deadline) { out.status = out.size === null ? 'timeout' : 'found'; return out; }
      const start = Math.max(lower, pos - chunk);
      const buf = Buffer.alloc(pos - start);
      let got = 0;
      while (got < buf.length) {
        const n = fs.readSync(fd, buf, got, buf.length - got, start + got);
        if (n === 0) break;
        got += n;
      }
      pos = start;
      let data = carry.length ? Buffer.concat([buf.subarray(0, got), carry]) : buf.subarray(0, got);
      carry = Buffer.alloc(0);
      if (pos > lower) {
        const cut = data.indexOf(10);
        if (cut < 0) { carry = data; chunk = Math.min(chunk * 2, LIMITS.MAX_CHUNK); continue; }
        carry = data.subarray(0, cut);
        data = data.subarray(cut + 1);
      } else if (pos > 0) {
        // The read cap was reached mid-file: the first line is cut, so it is dropped.
        const cut = data.indexOf(10);
        data = cut < 0 ? Buffer.alloc(0) : data.subarray(cut + 1);
      }
      // Lines from the newest to the oldest. One bad line never stops the rest.
      let end = data.length;
      while (end > 0) {
        const nl = data.lastIndexOf(10, end - 1);
        const line = data.subarray(nl + 1, end);
        end = nl < 0 ? 0 : nl;
        if (line.length === 0 || (line.length === 1 && line[0] === 13)) continue;
        counts.lines++;
        const hasAssistant = line.includes(assistantMark);
        const hasMarker = line.includes(marker);
        if (hasAssistant) counts.assistant_lines++;
        if (!hasAssistant && !hasMarker) continue;
        let rec;
        try {
          rec = JSON.parse(line.toString('utf8'));
        } catch (_) {
          counts.unreadable_lines++;
          continue;
        }
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
        let isComp = false;
        try { isComp = hasMarker && comp.test(rec) === true; } catch (_) { isComp = false; }
        if (isComp) {
          if (out.size === null) { out.size = 0; out.status = 'found'; if (!opts.full) return out; }
          continue;
        }
        if (rec.type !== 'assistant') continue;
        if (rec.isSidechain === true) { counts.side_chain_skipped++; continue; }
        const sum = usageSum(rec.message && typeof rec.message === 'object' ? rec.message.usage : null);
        if (sum !== null) counts.readable_usage++;
        // A zero sum (for example a synthetic API-error record) is no size: keep looking
        // back. Only a compaction record gives size 0 (6.3).
        if (sum === null || sum === 0) continue;
        counts.usage_records++;
        if (out.size === null) { out.size = sum; out.status = 'found'; if (!opts.full) return out; }
      }
      chunk = Math.min(chunk * 2, LIMITS.MAX_CHUNK);
    }
    out.status = out.size === null ? 'none' : 'found';
    return out;
  } catch (_) {
    out.status = out.size === null ? 'unreadable' : 'found';
    return out;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Link-safe folders and atomic writes (6.7, SR-C2, SR-C7)

/**
 * Null when dir is a real folder (not a link) whose real path equals the expected path;
 * otherwise a problem code. The real-path compare also catches a junction that lstat does
 * not report as a link (day-one check 17). _lstat: test-only seam.
 */
function folderProblem(dir, expected, platform = process.platform, _lstat = fs.lstatSync) {
  let st;
  try {
    st = _lstat(dir);
  } catch (err) {
    return err && err.code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  if (st.isSymbolicLink()) return 'link';
  if (!st.isDirectory()) return 'not_folder';
  let real;
  try {
    real = fs.realpathSync.native(dir);
  } catch (_) {
    return 'unresolved';
  }
  if (!samePath(real, expected, platform)) return 'moved';
  return null;
}

class MeterError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MeterError';
    this.code = code;
  }
}

/**
 * Create (if missing) the folder `name` inside the real folder `parentReal`, mode 0700 set
 * explicitly on POSIX, then check it is a real folder at exactly that path. Returns it.
 */
function ensureDir(parentReal, name, platform = process.platform) {
  const dir = path.join(parentReal, name);
  try {
    fs.mkdirSync(dir, { mode: DIR_MODE });
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw new MeterError('mkdir_failed');
  }
  const why = folderProblem(dir, dir, platform);
  if (why) throw new MeterError('folder_' + why);
  if (!isWindows(platform)) {
    try {
      const fd = fs.openSync(dir, C.O_RDONLY | O_NOFOLLOW | O_DIRECTORY);
      try { fs.fchmodSync(fd, DIR_MODE); } finally { fs.closeSync(fd); }
    } catch (_) {
      throw new MeterError('chmod_failed');
    }
  }
  return dir;
}

/** The real path of the state root, checked to be an existing real folder. */
function stateRootReal(stateRoot, platform = process.platform) {
  let real;
  try {
    real = fs.realpathSync.native(stateRoot);
  } catch (_) {
    throw new MeterError('state_root_missing');
  }
  const why = folderProblem(real, real, platform);
  if (why) throw new MeterError('state_root_' + why);
  return real;
}

/** Create the chain of folders `parts` under the real root, each link-checked. */
function ensureTree(rootReal, parts, platform = process.platform) {
  let cur = rootReal;
  for (const p of parts) cur = ensureDir(cur, p, platform);
  return cur;
}

function tempNameFor(name) {
  return `${name}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
}

function writeAll(fd, buf) {
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}

/**
 * Write `data` to `<dir>/<name>` atomically (6.7): lstat the folder and refuse a link,
 * refuse a folder outside the state root or whose real path is not `expectedDir`; then a
 * temp file `<name>.<pid>.<random>.tmp` created exclusively, mode 0600, O_NOFOLLOW where the
 * OS has it; fsync; the same folder check again right before the rename; rename over the
 * target. On any failure after the temp file exists, it is unlinked before the error is
 * thrown, only through a folder that still passes the check (a swapped folder's temp file is
 * left where it is). _failAfterTemp / _tempName / _beforeRename: test-only seams.
 */
function atomicWrite({ dir, expectedDir, rootReal, name, data, platform = process.platform, _failAfterTemp, _tempName, _beforeRename }) {
  // The write folder check: inside the state root, lstat not a link, real path equal to the built path.
  const writeFolderProblem = () => {
    if (rootReal && !isInside(expectedDir, rootReal, platform)) return 'outside_state_root';
    const w = folderProblem(dir, expectedDir, platform);
    return w ? 'folder_' + w : null;
  };
  const why = writeFolderProblem();
  if (why) throw new MeterError(why);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const tmp = path.join(dir, _tempName || tempNameFor(name));
  let fd = null;
  let created = false;
  try {
    try {
      fd = fs.openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | O_NOFOLLOW, FILE_MODE);
    } catch (err) {
      throw new MeterError(err && err.code === 'EEXIST' ? 'temp_exists' : 'temp_create_failed');
    }
    created = true;
    if (!isWindows(platform)) fs.fchmodSync(fd, FILE_MODE);
    if (_failAfterTemp) throw new MeterError('forced_failure');
    writeAll(fd, buf);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (_beforeRename) _beforeRename();
    // The folder is checked again right before the rename.
    const again = writeFolderProblem();
    if (again) throw new MeterError(again);
    fs.renameSync(tmp, path.join(dir, name));
    created = false;
  } catch (err) {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    // The temp file is unlinked only through a folder that still passes the check.
    if (created && !writeFolderProblem()) try { fs.unlinkSync(tmp); } catch (_) { /* gone already */ }
    if (err instanceof MeterError) throw err;
    throw new MeterError('write_failed');
  }
}

/**
 * The folder `<rootReal>/<parts...>` checked before it is listed (6.7, SR-C2): it must sit
 * below the state root, not be a link, and have a real path equal to that built path, so a
 * link or junction at the folder or at any parent inside the state root is refused (a root
 * that is not a real path fails closed the same way). Returns { dir } | { problem }.
 */
function checkedFolder(rootReal, parts, platform = process.platform) {
  if (typeof rootReal !== 'string' || rootReal === '' || !Array.isArray(parts) || !parts.length) return { problem: 'bad_path' };
  const dir = path.join(rootReal, ...parts);
  if (!isInside(dir, rootReal, platform) || samePath(dir, rootReal, platform)) return { problem: 'outside_state_root' };
  const why = folderProblem(dir, dir, platform);
  return why ? { problem: why } : { dir };
}

/**
 * Remove this script's own leftover temp files from the folder `<rootReal>/<parts...>`,
 * checked by checkedFolder before it is listed and again before each delete; a refused folder
 * is not listed (`refused` names why). Exact temp name pattern only, and only for a base
 * name this script writes in that folder (TEMP_BASES: session files in state/sessions,
 * meter-config.json in config, meter.cjs in statusline; any other folder removes nothing).
 * Regular files only (a link is skipped, never followed), older than maxAgeMs by modified
 * time. Never recursive. One failing entry never stops the rest.
 */
function cleanTemps(rootReal, parts, { maxAgeMs = LIMITS.TEMP_MAX_AGE_MS, now = Date.now(), platform = process.platform } = {}) {
  const out = { removed: 0, kept: 0, failed: 0, refused: null };
  const c = checkedFolder(rootReal, parts, platform);
  if (c.problem) { out.refused = c.problem; return out; }
  const ownBase = Object.prototype.hasOwnProperty.call(TEMP_BASES, parts.join('/')) ? TEMP_BASES[parts.join('/')] : null;
  if (!ownBase) { out.refused = 'not_own_folder'; return out; }
  const dir = c.dir;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    out.refused = 'unreadable';
    return out;
  }
  for (const n of names) {
    const m = TEMP_NAME_RE.exec(n);
    if (!m || !ownBase(m[1])) continue;
    try {
      const p = path.join(dir, n);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink() || !st.isFile()) { out.kept++; continue; }
      if (now - st.mtimeMs < maxAgeMs) { out.kept++; continue; }
      if (folderProblem(dir, dir, platform)) { out.failed++; continue; }
      fs.unlinkSync(p);
      out.removed++;
    } catch (_) {
      out.failed++;
    }
  }
  return out;
}

/**
 * Pruning (6.7, SR-C3): lists only `<rootReal>/state/sessions/`, checked by checkedFolder
 * before it is listed and again before each delete; deletes only names matching the exact
 * session-file pattern that are regular files (never a folder, never a link or its target)
 * older than 14 days by modified time. Never recursive. One failing delete never stops the
 * rest; it is counted (T-30). _unlink: test-only seam.
 */
function pruneSessions(rootReal, { now = Date.now(), maxAgeMs = LIMITS.PRUNE_AGE_MS, platform = process.platform, _unlink = fs.unlinkSync } = {}) {
  const out = { removed: 0, kept: 0, skipped: 0, failed: 0, refused: null };
  const c = checkedFolder(rootReal, ['state', 'sessions'], platform);
  if (c.problem) { out.refused = c.problem; return out; }
  const sessionsDir = c.dir;
  let names;
  try {
    names = fs.readdirSync(sessionsDir);
  } catch (_) {
    out.refused = 'unreadable';
    return out;
  }
  for (const n of names) {
    if (!SESSION_FILE_RE.test(n)) { out.skipped++; continue; }
    try {
      const p = path.join(sessionsDir, n);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink() || !st.isFile()) { out.skipped++; continue; }
      if (now - st.mtimeMs < maxAgeMs) { out.kept++; continue; }
      if (folderProblem(sessionsDir, sessionsDir, platform)) { out.failed++; continue; }
      _unlink(p);
      out.removed++;
    } catch (_) {
      out.failed++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hand-off note (6.6, SR-C4, SR-C6)

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Local time `YYYY-MM-DD-HHmm`, zero-padded, from Date getters (6.4). */
function datePart(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

/** One name part cut down to [A-Za-z0-9_-], runs collapsed, capped; empty -> `session`. */
function cleanPart(s, max) {
  let r = String(s).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  r = r.slice(0, max).replace(/-+$/, '');
  return r || 'session';
}

/** `<YYYY-MM-DD-HHmm>-<folder>-<sid>`, at most 80 characters (6.6). */
function noteBaseName(date, startFolder, cleanedId) {
  const folder = cleanPart(startFolder ? path.basename(String(startFolder)) : '', LIMITS.NOTE_FOLDER_PART_MAX);
  const sid = cleanPart(String(cleanedId || '').slice(0, LIMITS.NOTE_SESSION_PART), LIMITS.NOTE_SESSION_PART);
  return `${datePart(date)}-${folder}-${sid}`.slice(0, LIMITS.NOTE_NAME_MAX);
}

/**
 * Pre-create the note file exclusively (6.6 a): `wx`, 0600 on POSIX, after the folder check.
 * On a clash, `-2` up to `-9`, then stop. Returns { file } | { error: 'clash' | 'folder' | 'create' }.
 */
function precreateNote(dir, expectedDir, base, platform = process.platform) {
  if (folderProblem(dir, expectedDir, platform)) return { error: 'folder' };
  for (let n = 1; n <= LIMITS.NOTE_CLASH_MAX; n++) {
    const suffix = n === 1 ? '' : '-' + n;
    const name = base.slice(0, LIMITS.NOTE_NAME_MAX - suffix.length) + suffix + '.md';
    const file = path.join(dir, name);
    let fd;
    try {
      fd = fs.openSync(file, C.O_WRONLY | C.O_CREAT | C.O_EXCL | O_NOFOLLOW, FILE_MODE);
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      return { error: 'create' };
    }
    try {
      if (!isWindows(platform)) fs.fchmodSync(fd, FILE_MODE);
    } catch (_) { /* the file exists; mode best effort after a wx create with 0600 */ }
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    return { file };
  }
  return { error: 'clash' };
}

/**
 * The `handoff_dir` option (6.6, SR-C6): absolute, existing folder, resolved to its real
 * path once. Refused when it is inside the current project (CLAUDE_PROJECT_DIR or the hook
 * input's cwd) or inside any git work tree. Returns { dir } | { refused: true }.
 */
function resolveHandoffDir(value, { projectDir, cwd, platform = process.platform, gitCeiling = null }) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!isAbsoluteFor(s, platform)) return { refused: true };
  let real;
  try {
    real = fs.realpathSync.native(s);
    if (!fs.statSync(real).isDirectory()) return { refused: true };
  } catch (_) {
    return { refused: true };
  }
  for (const p of [projectDir, cwd]) {
    if (!nonEmpty(p) || !isAbsoluteFor(p, platform)) continue;
    let pr;
    try { pr = fs.realpathSync.native(p); } catch (_) { pr = path.resolve(p); }
    if (isInside(real, pr, platform)) return { refused: true };
  }
  if (inGitWorkTree(real, gitCeiling)) return { refused: true };
  return { dir: real };
}

// ---------------------------------------------------------------------------
// The prompt hook (6.3 to 6.8)

function readState(file) {
  const r = readSmallJson(file);
  if (r.absent) return { state: null };
  if (r.problem || !r.value || typeof r.value !== 'object' || Array.isArray(r.value)) return { state: {} };
  return { state: r.value };
}

function softText(size, opts) {
  return `Chat-length meter: this chat is now about ${fmtSize(size)} tokens, at or above the first warning size (${fmtSize(opts.soft_tokens)}). `
    + `Lead your next reply with one plain warning line for the user: the chat is about ${fmtSize(size)} tokens; finish this step, then start a new session. Say it once.`;
}

function hardText(size, opts, note) {
  let t = `Chat-length meter: this chat is now about ${fmtSize(size)} tokens, at or above the start-a-new-session size (${fmtSize(opts.hard_tokens)}). `
    + `Lead your next reply with one plain warning line for the user: the chat is about ${fmtSize(size)} tokens; finish this step, then start a new session.`;
  if (note) {
    t += ` Then write a hand-off note into this new, empty file, and into no other file: ${note}`
      + ' The note is at most 25 lines: the work in flight, the exact next step, the key files and the open decisions. Never put secrets, keys, passwords or personal data in it.'
      + ` Then give the user one line: start fresh and read ${note}`;
  }
  return t;
}

/**
 * The prompt hook, given the parsed hook input. Returns the hook output object, or null for
 * no output. ctx: { env, scriptFile, home, platform, now (Date), clock, deadline,
 * gitCeiling, compaction } (gitCeiling, compaction: test seams).
 */
function handlePrompt(input, ctx) {
  const env = ctx.env || {};
  const platform = ctx.platform || process.platform;
  const home = ctx.home || homeDir();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  // 6.9: once more against the hook input's cwd, right after parsing, before any file.
  if (nodeInsideProject({ execPath: ctx.execPath || process.execPath, projectDir: env.CLAUDE_PROJECT_DIR, cwd: typeof input.cwd === 'string' ? input.cwd : '', home, platform })) {
    return { systemMessage: LINES.NODE_IN_PROJECT };
  }
  const sid = cleanSessionId(input.session_id);
  if (sid === null) return null; // 6.7 c
  const mode = installMode({ env, scriptFile: ctx.scriptFile, home, platform });
  if (writeBlock(mode, ctx.gitCeiling || null)) return null; // 6.7, SR-C8: silent, no tier warnings

  let root;
  let sessionsDir;
  try {
    root = stateRootReal(mode.stateRoot, platform);
    sessionsDir = ensureTree(root, ['state', 'sessions'], platform);
  } catch (_) {
    return null; // a state folder replaced by a link or junction is refused: nothing written
  }
  const expectedSessions = path.join(root, 'state', 'sessions');
  const nowMs = ctx.clock ? ctx.clock() : Date.now();
  cleanTemps(root, ['state', 'sessions'], { now: nowMs, platform });
  cleanTemps(root, ['config'], { now: nowMs, platform });
  const stateFile = statePathFor(root, sid);
  if (!stateFile || path.dirname(stateFile) !== expectedSessions) return null;

  const read = readState(stateFile);
  const isNew = read.state === null;
  const prev = read.state || {};
  if (isNew) pruneSessions(root, { now: nowMs, platform });
  const state = {
    soft: !!prev.soft,
    hard: !!prev.hard,
    hard_at: Number.isSafeInteger(prev.hard_at) ? prev.hard_at : null,
    told: prev.told && typeof prev.told === 'object' && !Array.isArray(prev.told) ? { ...prev.told } : {},
    off: prev.off === true,
  };
  const notices = [];
  const tellOnce = (key, line) => {
    if (state.told[key]) return;
    state.told[key] = true;
    notices.push(line);
  };

  const opt = loadOptions(mode.mode === 'plugin'
    ? { source: 'env', env }
    : { source: 'file', configFile: path.join(root, 'config', 'meter-config.json'), platform });
  const opts = opt.options;
  if (opt.invalid) tellOnce('config', LINES.CONFIG_INVALID);
  if (mode.pluginDataIgnored) tellOnce('plugin_data', LINES.PLUGIN_DATA_IGNORED);

  let context = '';
  let message = '';
  if (!state.off) {
    const r = readTranscriptSize(input.transcript_path, { deadline: ctx.deadline, clock: ctx.clock, compaction: ctx.compaction });
    if (r.status === 'found') {
      const step = tierStep(state, r.size, opts);
      state.soft = step.state.soft;
      state.hard = step.state.hard;
      state.hard_at = step.state.hard_at;
      if (step.fire === 'soft') {
        context = softText(r.size, opts);
        message = `chat-length meter: the chat is about ${fmtSize(r.size)} tokens (first warning at ${fmtSize(opts.soft_tokens)}). Finish this step, then start a new session.`;
      } else if (step.fire === 'hard' || step.fire === 'repeat') {
        let note = null;
        if (opts.handoff_note) {
          let dir = null;
          let expected = null;
          if (nonEmpty(opts.handoff_dir)) {
            const h = resolveHandoffDir(opts.handoff_dir, { projectDir: env.CLAUDE_PROJECT_DIR, cwd: input.cwd, platform, gitCeiling: ctx.gitCeiling || null });
            if (h.refused) tellOnce('handoff_dir', LINES.HANDOFF_DIR_REFUSED);
            else { dir = h.dir; expected = h.dir; }
          }
          if (!dir) {
            try {
              dir = ensureDir(root, 'handoff', platform);
              expected = path.join(root, 'handoff');
            } catch (_) {
              dir = null;
            }
          }
          const startFolder = nonEmpty(env.CLAUDE_PROJECT_DIR) ? env.CLAUDE_PROJECT_DIR : (typeof input.cwd === 'string' ? input.cwd : '');
          const base = noteBaseName(ctx.now ? ctx.now() : new Date(nowMs), startFolder, sid);
          const made = dir ? precreateNote(dir, expected, base, platform) : { error: 'folder' };
          if (made.file) note = made.file;
          else notices.push(made.error === 'clash' ? LINES.NOTE_CLASH : LINES.NOTE_FAILED);
        }
        context = hardText(r.size, opts, note);
        message = `chat-length meter: the chat is about ${fmtSize(r.size)} tokens (new-session size ${fmtSize(opts.hard_tokens)}). Finish this step, then start a new session.`
          + (note ? ` Hand-off note file: ${note}` : '');
      }
    } else if (r.status === 'none' && r.fileBytes >= LIMITS.SMALL_FLOOR && !isNew && r.counts.assistant_lines > 0 && r.counts.readable_usage === 0) {
      // 6.8: only after a reply exists. A first prompt's attachment records alone can pass the
      // floor, so the line needs this session's state file from an earlier prompt AND a line
      // naming the assistant role in the read window; it never fires before the first reply.
      // A usage record in the read shape, even with a zero sum (a failed request), proves the
      // format is readable, so it never gives the line.
      state.off = true;
      tellOnce('format', LINES.FORMAT);
    }
  }

  const text = JSON.stringify(state) + '\n';
  if (isNew || text !== JSON.stringify(prev) + '\n') {
    try {
      atomicWrite({ dir: sessionsDir, expectedDir: expectedSessions, rootReal: root, name: path.basename(stateFile), data: text, platform });
    } catch (_) {
      // The answer still goes out; the next prompt may repeat a warning. Never blocks.
    }
  }

  const msgs = notices.slice();
  if (message) msgs.push(message);
  if (!context && !msgs.length) return null;
  const output = {};
  if (context) output.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: context };
  if (msgs.length) output.systemMessage = msgs.join('\n');
  return output;
}

// ---------------------------------------------------------------------------
// Status line (6.3, 6.13): passive, redrawn on every update, never writes to disk

const COLOURS = Object.freeze({ quiet: '\u001b[32m', soft: '\u001b[33m', hard: '\u001b[31m', reset: '\u001b[0m' });

/** The size from the status line input (6.3): total_input_tokens, else the current_usage sum; null for none. */
function statusSize(input) {
  const cw = input && typeof input === 'object' ? input.context_window : null;
  if (!cw || typeof cw !== 'object') return null;
  const t = cw.total_input_tokens;
  if (typeof t === 'number' && Number.isFinite(t) && t > 0) return Math.floor(t);
  const sum = usageSum(cw.current_usage);
  return sum && sum > 0 ? sum : null;
}

/** One line (6.13): `chat <n>k[ getting long| NEW SESSION NOW] (warn <soft>k/<hard>k)`. */
function renderStatusLine(size, opts, { noColor = false } = {}) {
  const warn = `(warn ${fmtSize(opts.soft_tokens)}/${fmtSize(opts.hard_tokens)})`;
  if (size === null || size === undefined) return `chat -- ${warn}`;
  const tier = tierOf(size, opts);
  const tag = tier === 'hard' ? ' NEW SESSION NOW' : tier === 'soft' ? ' getting long' : '';
  const line = `chat ${fmtSize(size)}${tag} ${warn}`;
  return noColor ? line : COLOURS[tier] + line + COLOURS.reset;
}

/** Which config file the status line reads (6.2): plugin mode -> <data>/config; else the folder above this script's folder. */
function statusConfigFile({ env, scriptFile, home, platform }) {
  const mode = installMode({ env, scriptFile, home, platform });
  const root = mode.mode === 'plugin' ? mode.stateRoot : path.dirname(path.dirname(mode.scriptReal));
  return path.join(root, 'config', 'meter-config.json');
}

function statusLine(input, ctx) {
  const env = ctx.env || {};
  const platform = ctx.platform || process.platform;
  const opts = loadOptions({ source: 'file', configFile: statusConfigFile({ env, scriptFile: ctx.scriptFile, home: ctx.home || homeDir(), platform }), platform }).options;
  const noColor = typeof env.NO_COLOR === 'string' && env.NO_COLOR !== '';
  return renderStatusLine(statusSize(input), opts, { noColor });
}

// ---------------------------------------------------------------------------
// --sync (6.7, SR-C1)

/**
 * Plugin mode only: copy this file to <data folder>/statusline/meter.cjs when the bytes
 * differ, and write <data folder>/config/meter-config.json from the current options. The
 * target comes only from CLAUDE_PLUGIN_DATA (by real path); there is no path argument.
 * Returns { done, reason, copied, configWritten }.
 */
function sync({ env, scriptFile, home, platform = process.platform, gitCeiling = null, args = [] }) {
  const out = { done: false, reason: null, copied: false, configWritten: false };
  if (args.length) { out.reason = 'path_argument_refused'; return out; }
  const mode = installMode({ env, scriptFile, home: home || homeDir(), platform });
  if (mode.mode !== 'plugin') { out.reason = 'not_plugin_mode'; return out; }
  const block = writeBlock(mode, gitCeiling);
  if (block) { out.reason = block; return out; }
  try {
    const root = stateRootReal(mode.stateRoot, platform);
    const slDir = ensureDir(root, 'statusline', platform);
    const cfgDir = ensureDir(root, 'config', platform);
    cleanTemps(root, ['statusline'], { platform });
    cleanTemps(root, ['config'], { platform });
    const own = fs.readFileSync(mode.scriptReal);
    const target = path.join(slDir, 'meter.cjs');
    let same = false;
    const st = (() => { try { return fs.lstatSync(target); } catch (_) { return null; } })();
    if (st && st.isFile() && !st.isSymbolicLink() && st.size === own.length) {
      try { same = fs.readFileSync(target).equals(own); } catch (_) { same = false; }
    }
    if (!same) {
      atomicWrite({ dir: slDir, expectedDir: path.join(root, 'statusline'), rootReal: root, name: 'meter.cjs', data: own, platform });
      out.copied = true;
    }
    atomicWrite({ dir: cfgDir, expectedDir: path.join(root, 'config'), rootReal: root, name: 'meter-config.json', data: JSON.stringify(readEnvOptions(env), null, 2) + '\n', platform });
    out.configWritten = true;
    out.done = true;
  } catch (err) {
    out.reason = err && err.code ? String(err.code) : 'sync_failed';
  }
  return out;
}

/** Test-only entry (6.7): refuses any target outside the given sandbox folder before doing anything. */
function syncForTest(opts, sandboxDir) {
  const mode = installMode({ env: opts.env, scriptFile: opts.scriptFile, home: opts.home || homeDir(), platform: opts.platform || process.platform });
  if (mode.mode === 'plugin' && !isInside(mode.stateRoot, realLoose(sandboxDir))) {
    return { done: false, reason: 'outside_sandbox', copied: false, configWritten: false };
  }
  return sync(opts);
}

// ---------------------------------------------------------------------------
// --selftest (6.8): counts and the size only; no transcript text; writes nothing

function selftest(file) {
  const r = readTranscriptSize(file, { full: true });
  const c = r.counts;
  if (r.status === 'missing' || r.status === 'not_file' || r.status === 'unreadable') {
    return 'selftest: the transcript could not be read as a file (' + r.status + ')';
  }
  const counts = `lines ${c.lines}, usage records ${c.usage_records}, side-chain records skipped ${c.side_chain_skipped}, unreadable lines ${c.unreadable_lines}, bytes ${r.fileBytes}`;
  if (r.status === 'found') return `selftest: ok; ${counts}; chat size ${r.size} (${fmtSize(r.size)})`;
  return `selftest: no usage record found; ${counts}; the meter cannot read this format`;
}

// ---------------------------------------------------------------------------
// Command line

function readStdin(stream, cap, cb) {
  const chunks = [];
  let n = 0;
  let done = false;
  const finish = (text) => {
    if (done) return;
    done = true;
    try { stream.pause(); } catch (_) { /* ignore */ }
    try { stream.destroy(); } catch (_) { /* ignore */ }
    cb(text);
  };
  stream.on('data', (c) => {
    if (done) return;
    n += c.length;
    if (n > cap) { finish(null); return; } // 6.9: stop at the cap; act on nothing
    chunks.push(c);
  });
  stream.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
  stream.on('error', () => finish(null));
}

function parseJson(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (_) {
    return null;
  }
}

/**
 * The self-kill delay for a command line (6.9), or null for none: `--selftest` is a user's
 * own check, bounded by the read cap, and must not lose its output to the timer.
 */
function selfKillMs(argv) {
  return Array.isArray(argv) && argv[0] === '--selftest' ? null : LIMITS.SELF_KILL_MS;
}

/**
 * Entry. seams (test-only, from a launcher's function call, never from the environment):
 * { argv, gitCeiling, compaction }.
 */
function main(seams = {}) {
  const argv = Array.isArray(seams.argv) ? seams.argv : process.argv.slice(2);
  let finished = false;
  const finish = (text) => {
    if (finished) return;
    finished = true;
    if (typeof text === 'string' && text !== '') {
      try {
        process.stdout.write(text + '\n', () => process.exit(0));
        return;
      } catch (_) { /* fall through */ }
    }
    process.exit(0);
  };
  const killMs = selfKillMs(argv);
  if (killMs !== null) {
    const killer = setTimeout(() => process.exit(0), killMs); // 6.9 self-kill
    if (typeof killer.unref === 'function') killer.unref();
  }
  process.on('uncaughtException', () => finish(null));
  const env = process.env;
  const home = homeDir();
  const base = { env, scriptFile: __filename, home, platform: process.platform, gitCeiling: seams.gitCeiling || null, compaction: seams.compaction };
  // 6.9: the Node self-check runs before stdin is read or any file is touched, for the prompt
  // hook, --sync and --statusline alike (--selftest is a user's own check of a named file).
  const nodeInside = () => nodeInsideProject({ execPath: process.execPath, projectDir: env.CLAUDE_PROJECT_DIR, cwd: process.cwd(), home });

  if (argv[0] === '--sync') {
    if (nodeInside()) { finish('sync: skipped (node_in_project)'); return; }
    const r = sync({ ...base, args: argv.slice(1) });
    finish('sync: ' + (r.done ? (r.copied ? 'copied' : 'unchanged') : 'skipped (' + r.reason + ')'));
    return;
  }
  if (argv[0] === '--selftest') {
    finish(argv.length === 2 ? selftest(argv[1]) : 'selftest: give exactly one transcript path');
    return;
  }
  if (argv[0] === '--statusline') {
    // Node inside the project: the empty form with the default thresholds; reads nothing.
    if (nodeInside()) { finish(renderStatusLine(null, DEFAULTS)); return; }
    readStdin(process.stdin, LIMITS.STDIN_MAX_BYTES, (text) => {
      try {
        finish(statusLine(parseJson(text), base));
      } catch (_) {
        finish(null);
      }
    });
    return;
  }
  if (argv.length) { finish(null); return; }

  // The prompt hook. 6.9: the Node self-check runs before stdin is read or any file touched.
  if (nodeInside()) {
    finish(asciiJson({ systemMessage: LINES.NODE_IN_PROJECT }));
    return;
  }
  const started = Date.now();
  readStdin(process.stdin, LIMITS.STDIN_MAX_BYTES, (text) => {
    try {
      const out = handlePrompt(parseJson(text), { ...base, deadline: started + LIMITS.READ_BUDGET_MS });
      finish(out ? asciiJson(out) : null);
    } catch (_) {
      finish(null);
    }
  });
}

/** True when this file is the process entry (T-14 allows `require` only as a direct call with a literal). */
function isEntry() {
  const arg = process.argv[1];
  if (typeof arg !== 'string' || arg === '') return false;
  try {
    return samePath(fs.realpathSync.native(arg), fs.realpathSync.native(__filename));
  } catch (_) {
    return samePath(path.resolve(arg), __filename);
  }
}

if (isEntry()) main();

module.exports = {
  DEFAULTS,
  OPTION_RULES,
  LIMITS,
  LINES,
  ENV_PREFIX,
  SESSION_FILE_RE,
  TEMP_NAME_RE,
  DEFAULT_COMPACTION,
  asciiJson,
  isAbsoluteFor,
  isInside,
  samePath,
  realLoose,
  inGitWorkTree,
  configDirOf,
  pluginsDirOf,
  installMode,
  writeBlock,
  nodeInsideProject,
  cleanSessionId,
  statePathFor,
  readEnvOptions,
  validateOptions,
  readSmallJson,
  loadOptions,
  usageSum,
  fmtSize,
  tierOf,
  tierStep,
  readTranscriptSize,
  folderProblem,
  checkedFolder,
  ensureDir,
  atomicWrite,
  cleanTemps,
  pruneSessions,
  datePart,
  cleanPart,
  noteBaseName,
  precreateNote,
  resolveHandoffDir,
  handlePrompt,
  statusSize,
  renderStatusLine,
  statusConfigFile,
  statusLine,
  sync,
  syncForTest,
  selftest,
  selfKillMs,
  main,
};
