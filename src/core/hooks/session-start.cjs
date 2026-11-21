'use strict';
// Session start hook (spec 6.11). In order:
//   0. the Node self-check (6.9), then the write-nothing checks (6.7: git work tree, source
//      folder, plugin data folder not set); in write-nothing mode the fixed line goes to the
//      user once and nothing is written
//   1. plugin mode only: --sync (the meter's own function)
//   2. the hand-off folder and note-name lines (6.6) and, plugin mode only, the Node line
//      for the status line setup skill (6.12)
//   3. the routing block from the model-routing skill, unless the user-level CLAUDE.md
//      already holds it or the option is off; loud on any failure (6.11 step 4)
//
// The shared rules (install mode, write-nothing checks, self-check, folder checks, options)
// come from meter.cjs, which ships beside this file in both install paths. Node built-ins
// only. No network, no child process, no shell. Always exits 0 and never blocks. The command
// line starts only when process.argv[1] is this file (real-path compare).

const fs = require('node:fs');
const path = require('node:path');
const M = require('./meter.cjs');

const LIMITS = Object.freeze({
  INJECT_MAX_CHARS: 10000, // 6.11: Claude Code moves longer hook context into a file
  SKILL_MAX_BYTES: 256 * 1024, // 6.11 e: the skill file; larger counts as unreadable
  USER_RULES_MAX_BYTES: 1024 * 1024, // 6.11 e: the first part of the user CLAUDE.md searched for the marker
  PATH_MAX_CHARS: M.LIMITS.PATH_MAX_CHARS, // 6.11 f: a longer path is never printed (the meter's cap)
});

const MARK_START = '<!-- routing-block:start -->';
const MARK_END = '<!-- routing-block:end -->';

/** Spec 5.1 b: the line that opens the injected block. */
const YOURS_WIN = 'If your own rules file already sets model and effort rules, yours win.';

const LINES = Object.freeze({
  // 6.7, word for word (the display name opens the fixed user lines, spec 2.2).
  IN_GIT: 'PocoToko: your Claude config folder is inside a git repo, so the kit saves nothing there (no meter warnings, no hand-off files). Move the config folder out of the repo to turn them on.',
  SOURCE_FOLDER: 'PocoToko: this plugin runs from its source folder (a developer install), so the kit saves nothing. Install from a git source or copy by hand to turn saving on.',
  PLUGIN_DATA_NOT_SET: 'PocoToko: the plugin data folder is not set, so the kit saves nothing this session (no meter warnings, no hand-off files).',
  // 6.11 a: the fixed line forms the skills read.
  FOLDER_PREFIX: 'Hand-off folder for this session: ',
  NAME_PREFIX: 'Hand-off note name for this session: ',
  NODE_PREFIX: 'Node program for the status line command: ',
  // 6.11 step 4: loud, one line each.
  RULES_UNREADABLE: 'Routing rules were not added at session start: the model-routing skill file could not be read',
  RULES_NO_MARKERS: 'Routing rules were not added at session start: the model-routing skill file has no single marked rules block.',
  RULES_TOO_LONG: 'Routing rules were not added at session start: the rules block is too long',
  RULES_IN_PROJECT: 'Routing rules were not added at session start: the model-routing skill file is inside the current project, so it was not read.',
  RULES_IN_GIT: 'Routing rules were not added at session start: the model-routing skill file is inside a git repo, so it was not read.',
});

const BLOCK_LINES = Object.freeze({
  in_git: LINES.IN_GIT,
  source_folder: LINES.SOURCE_FOLDER,
  plugin_data_not_set: LINES.PLUGIN_DATA_NOT_SET,
});

const C = fs.constants;
const O_NONBLOCK = C.O_NONBLOCK || 0;

// 6.11 f: the exact set never printed in a path and the 1,024-character cap live in
// meter.cjs (the meter checks the note path with the same rule, 6.6 a).
const UNPRINTABLE_CLASSES = M.UNPRINTABLE_CLASSES;
const printablePath = M.printablePath;

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Read a text file through one handle (links are followed; this is a read of the user's own
 * file or the kit's own skill). Regular files only; a FIFO never blocks the open.
 * truncate: read only the first maxBytes of a larger file; else a larger file is 'too_big'.
 * Returns { text } | { absent: true } | { problem }.
 */
function readText(file, maxBytes, { truncate = false } = {}) {
  let fd = null;
  try {
    try {
      fd = fs.openSync(file, C.O_RDONLY | O_NONBLOCK);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return { absent: true };
      return { problem: 'open_failed' };
    }
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { problem: 'not_file' };
    if (st.size > maxBytes && !truncate) return { problem: 'too_big' };
    const buf = Buffer.alloc(Math.min(st.size, maxBytes));
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    return { text: buf.subarray(0, got).toString('utf8') };
  } catch (_) {
    return { problem: 'read_failed' };
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) { /* ignore */ }
  }
}

/** The text between the two markers, trimmed; null unless each marker appears exactly once, start first, with text between. */
function extractBlock(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/\r\n/g, '\n');
  if (t.split(MARK_START).length !== 2 || t.split(MARK_END).length !== 2) return null;
  const a = t.indexOf(MARK_START);
  const b = t.indexOf(MARK_END);
  if (b < a) return null;
  const inner = t.slice(a + MARK_START.length, b).trim();
  return inner === '' ? null : inner;
}

/**
 * 6.11 e: which model-routing skill file this run reads. A kit folder that is a plugin folder
 * (plugin mode, plugin data not set, or a source folder) reads its own plugin root, found from
 * this script's real path; copy-by-hand reads <config folder>/skills/model-routing/SKILL.md.
 */
function routingSkillFile(mode, env, home, platform = process.platform) {
  const ownRoot = path.dirname(path.dirname(mode.scriptReal));
  if (mode.mode !== 'copy' || mode.sourceFolder) return path.join(ownRoot, 'skills', 'model-routing', 'SKILL.md');
  return path.join(M.configDirOf(env, home, platform), 'skills', 'model-routing', 'SKILL.md');
}

/**
 * 6.11 h: true when the real path of file sits inside CLAUDE_PROJECT_DIR or the input cwd
 * (real paths, the SR-5 compare), the same rule handoff_dir uses (6.6). A project folder that
 * is the home folder or above it (a filesystem root included) is not tested, as in the Node
 * self-check (6.9): the default config folder always sits inside those.
 */
function insideProject(file, { projectDir, cwd, home, platform = process.platform }) {
  const real = M.realLoose(file);
  for (const p of [projectDir, cwd]) {
    if (!nonEmpty(p) || !M.isAbsoluteFor(p, platform)) continue;
    let pr;
    try { pr = fs.realpathSync.native(p); } catch (_) { pr = path.resolve(p); }
    if (home && M.isInside(home, pr, platform)) continue;
    if (M.isInside(real, pr, platform)) return true;
  }
  return false;
}

/**
 * 6.11 h: true when the real path of file sits inside a git work tree (a `.git` file or
 * folder in its folder or any folder above it, as in 6.7), so a repo that points the config
 * folder into a subfolder of itself is caught even when the session starts in another
 * subfolder. A home-folder skip like insideProject's: a `.git` in the home folder or above
 * it (a home folder kept as a git repo) is not counted. The caller passes the ACCOUNT home
 * (M.accountHomeDir), not HOME or USERPROFILE, which the same project settings could point
 * at the repo. No home given: nothing is skipped. Fails closed like the 6.7 check: any
 * `.git` error other than not-found counts as found. gitCeiling: test-only seam; the walk
 * stops after that folder. _lstat: test-only seam.
 */
function insideGitRepo(file, { home = null, platform = process.platform, gitCeiling = null, _lstat = fs.lstatSync }) {
  let cur = M.realLoose(file);
  for (;;) {
    if (home && M.isInside(home, cur, platform)) return false;
    try {
      _lstat(path.join(cur, '.git'));
      return true;
    } catch (err) {
      if (!(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))) return true;
    }
    if (gitCeiling && M.samePath(cur, gitCeiling, platform)) return false;
    const up = path.dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

/**
 * 6.11 h: why the skill file taken from the config folder is not read: 'project', 'git' or
 * null. where: { projectDir, cwd, home (the project check's skip), accountHome (the git
 * check's skip), gitCeiling, platform }.
 */
function configFileRefusal(file, where) {
  if (insideProject(file, where)) return 'project';
  if (insideGitRepo(file, { platform: where.platform, gitCeiling: where.gitCeiling, home: where.accountHome || null, _lstat: where._lstat })) return 'git';
  return null;
}

/**
 * True when the user-level CLAUDE.md in the config folder holds the routing block's start
 * marker (5.1). A CLAUDE.md inside the current project counts as not holding it (6.11 h).
 * One inside a git work tree does count: its marker can only turn the kit's own injection
 * off, Claude Code loads that file anyway, and ignoring it would send the block twice to
 * everyone who keeps the config folder as a git repo.
 */
function userRulesHoldBlock(env, home, platform = process.platform, where = {}) {
  const file = path.join(M.configDirOf(env, home, platform), 'CLAUDE.md');
  if (insideProject(file, { home, ...where, platform })) return false;
  const r = readText(file, LIMITS.USER_RULES_MAX_BYTES, { truncate: true });
  return typeof r.text === 'string' && r.text.includes(MARK_START);
}

/** `<YYYY-MM-DD-HHmm>-<folder part>-<session part>.md`, the parts as the meter cleans them (6.6, 6.11 a). */
function noteNameLine(startFolder, rawSessionId) {
  const folder = M.cleanPart(startFolder ? path.basename(String(startFolder)) : '', M.LIMITS.NOTE_FOLDER_PART_MAX);
  const cleaned = M.cleanSessionId(rawSessionId);
  const sid = M.cleanPart(String(cleaned || '').slice(0, M.LIMITS.NOTE_SESSION_PART), M.LIMITS.NOTE_SESSION_PART);
  return `<YYYY-MM-DD-HHmm>-${folder}-${sid}.md`;
}

/**
 * 6.6, 6.11 b: the hand-off folder for this session. handoff_dir when it passes 6.6, else
 * <state root>/handoff/, created by code with the 6.7 folder checks. Returns the real path,
 * or null when no folder can be named.
 */
function handoffFolder({ mode, opts, env, cwd, home, platform, gitCeiling }) {
  if (nonEmpty(opts.handoff_dir)) {
    const configDir = M.configDirOf(env, home || M.homeDir(), platform);
    const h = M.resolveHandoffDir(opts.handoff_dir, { projectDir: env.CLAUDE_PROJECT_DIR, cwd, configDir, platform, gitCeiling });
    if (h.dir) return h.dir;
  }
  try {
    const root = M.stateRootReal(mode.stateRoot, platform);
    return M.ensureDir(root, 'handoff', platform);
  } catch (_) {
    return null;
  }
}

/**
 * The hook, given the parsed hook input. Returns the hook output object, or null for no
 * output. ctx: { env, scriptFile, home, platform, execPath, gitCeiling, meterFile, accountHome }
 * (execPath, gitCeiling, meterFile, accountHome: test seams; meterFile defaults to meter.cjs beside
 * scriptFile, the file --sync copies).
 */
function handleSessionStart(input, ctx) {
  const env = ctx.env || {};
  const platform = ctx.platform || process.platform;
  const home = ctx.home || M.homeDir();
  const execPath = ctx.execPath || process.execPath;
  const gitCeiling = ctx.gitCeiling || null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const cwd = typeof input.cwd === 'string' ? input.cwd : '';
  // 6.9: once more against the hook input's cwd, right after parsing, before any file.
  if (M.nodeInsideProject({ execPath, projectDir: env.CLAUDE_PROJECT_DIR, cwd, home, platform })) {
    return { systemMessage: M.LINES.NODE_IN_PROJECT };
  }

  const mode = M.installMode({ env, scriptFile: ctx.scriptFile, home, platform });
  const block = M.writeBlock(mode, gitCeiling); // 6.7, SR-C8: before --sync and any write
  const notices = [];
  const lines = [];
  if (block) notices.push(BLOCK_LINES[block]);

  const opts = M.loadOptions(mode.mode === 'copy'
    ? { source: 'file', configFile: path.join(mode.stateRoot, 'config', 'meter-config.json'), platform }
    : { source: 'env', env }).options;

  if (!block) {
    let synced = false;
    if (mode.mode === 'plugin') {
      const meterFile = ctx.meterFile || path.join(path.dirname(ctx.scriptFile), 'meter.cjs');
      synced = M.sync({ env, scriptFile: meterFile, home, platform, gitCeiling }).done;
    }
    const folder = handoffFolder({ mode, opts, env, cwd, home, platform, gitCeiling });
    if (folder && printablePath(folder)) {
      const startFolder = nonEmpty(env.CLAUDE_PROJECT_DIR) ? env.CLAUDE_PROJECT_DIR : cwd;
      lines.push(LINES.FOLDER_PREFIX + folder);
      lines.push(LINES.NAME_PREFIX + noteNameLine(startFolder, input.session_id));
    }
    if (mode.mode === 'plugin' && synced && printablePath(execPath)) lines.push(LINES.NODE_PREFIX + execPath);
  }

  let rules = '';
  // 6.11 h: the git check's home skip uses the account's own home, never HOME or USERPROFILE.
  const accountHome = ctx.accountHome || M.accountHomeDir();
  const where = { projectDir: env.CLAUDE_PROJECT_DIR, cwd, home, accountHome, gitCeiling };
  if (opts.routing_rules_at_start && !userRulesHoldBlock(env, home, platform, where)) {
    const skillFile = routingSkillFile(mode, env, home, platform);
    // 6.11 h (MUST): a skill copy taken from the config folder must not sit in the project,
    // or anywhere in a git work tree.
    const fromConfig = mode.mode === 'copy' && !mode.sourceFolder;
    const refusal = fromConfig ? configFileRefusal(skillFile, { ...where, platform }) : null;
    const r = refusal ? { refusal } : readText(skillFile, LIMITS.SKILL_MAX_BYTES);
    if (r.refusal === 'project') notices.push(LINES.RULES_IN_PROJECT);
    else if (r.refusal === 'git') notices.push(LINES.RULES_IN_GIT);
    else if (r.absent) notices.push(LINES.RULES_UNREADABLE + ' (missing).');
    else if (r.problem) notices.push(LINES.RULES_UNREADABLE + ' (' + r.problem + ').');
    else {
      const b = extractBlock(r.text);
      if (b === null) notices.push(LINES.RULES_NO_MARKERS);
      else rules = YOURS_WIN + '\n' + b;
    }
  }

  let context = lines.join('\n');
  if (rules) {
    const withRules = context ? context + '\n\n' + rules : rules;
    // 6.11 f (MUST): the whole injected text stays under 10,000 characters.
    if (withRules.length < LIMITS.INJECT_MAX_CHARS) context = withRules;
    else notices.push(`${LINES.RULES_TOO_LONG} (${withRules.length} characters; the limit is under ${LIMITS.INJECT_MAX_CHARS}).`);
  }

  if (!context && !notices.length) return null;
  const output = {};
  if (context) output.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: context };
  if (notices.length) output.systemMessage = notices.join('\n');
  return output;
}

/**
 * Entry. seams (test-only, from a launcher's function call, never from the environment):
 * { argv, gitCeiling }.
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
  const killer = setTimeout(() => process.exit(0), M.LIMITS.SELF_KILL_MS); // 6.9 self-kill
  if (typeof killer.unref === 'function') killer.unref();
  process.on('uncaughtException', () => finish(null));
  if (argv.length) { finish(null); return; }
  const env = process.env;
  const home = M.homeDir();
  // 6.9: the Node self-check runs before stdin is read or any file is touched.
  if (M.nodeInsideProject({ execPath: process.execPath, projectDir: env.CLAUDE_PROJECT_DIR, cwd: process.cwd(), home })) {
    finish(M.asciiJson({ systemMessage: M.LINES.NODE_IN_PROJECT }));
    return;
  }
  M.readStdin(process.stdin, M.LIMITS.STDIN_MAX_BYTES, (text) => {
    try {
      const out = handleSessionStart(M.parseJson(text), { env, scriptFile: __filename, home, platform: process.platform, gitCeiling: seams.gitCeiling || null });
      finish(out ? M.asciiJson(out) : null);
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
    return M.samePath(fs.realpathSync.native(arg), fs.realpathSync.native(__filename));
  } catch (_) {
    return M.samePath(path.resolve(arg), __filename);
  }
}

if (isEntry()) main();

module.exports = {
  LIMITS,
  LINES,
  YOURS_WIN,
  MARK_START,
  MARK_END,
  UNPRINTABLE_CLASSES,
  printablePath,
  insideProject,
  insideGitRepo,
  configFileRefusal,
  readText,
  extractBlock,
  routingSkillFile,
  userRulesHoldBlock,
  noteNameLine,
  handoffFolder,
  handleSessionStart,
  main,
};
