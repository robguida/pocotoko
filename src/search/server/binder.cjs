'use strict';
// Binding the project root and the per-project switch (spec 6.7, 9.1, 9.6,
// 9.10, SR-1 to SR-6, SR-44a).
//
// - Install mode and data root, by the 6.7 rule (plugin mode only when
//   CLAUDE_PLUGIN_DATA is set and the server's own real path is inside the
//   plugins folder).
// - The root: the real path of CLAUDE_PROJECT_DIR, else of the process start
//   folder, fixed once and never re-bound. No roots request is ever made (SR-3).
// - Refused roots (SR-4) and the exact-match project list (SR-6, 9.1).
// - The Node self-check of 6.9 (SR-44a) as a pure path test.
//
// Every inside test calls fsx.isInside / fsx.samePath, the server's one compare
// function (SR-5).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fsx = require('./fsx.cjs');
const floor = require('./floor.cjs');

const REASONS = Object.freeze({
  PLUGIN_DATA_NOT_SET: 'plugin data folder not set',
  PROJECT_DIR_RELATIVE: 'project folder is not an absolute path',
  PROJECT_DIR_MISSING: 'project folder could not be resolved',
  START_FOLDER_MISSING: 'start folder could not be resolved',
  FS_ROOT: 'refused: the folder is a filesystem or drive root',
  HOME: 'refused: the folder is your home folder or above it',
  CONFIG: 'refused: the folder is the Claude config folder or inside it',
  DATA: 'refused: the folder is the search data folder or inside it',
  TEMP: 'refused: the folder is the temp folder or above it',
  NETWORK: 'refused: the folder is on a network path',
  PLUGINS: 'refused: the folder is the plugins folder or inside it',
  NOT_ENABLED: 'not enabled for this project',
  LIST_UNSAFE: 'projects list could not be read safely; a folder path may contain a comma',
});

// Linux file-system types that are network mounts (statfs f_type). macOS does
// not give stable numbers, so this SHOULD check runs on Linux only (SR-4 f).
const LINUX_NETWORK_FS = new Set([0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x73757245, 0x5346414f, 0x564c]);

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/** Absolute path test that also refuses a Windows path with no drive (`\x`, `C:x`). */
function isAbsoluteFor(p, platform) {
  if (typeof p !== 'string' || p === '') return false;
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
  return path.posix.isAbsolute(p);
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

/**
 * Install mode (6.7, 9.6). Returns { mode: 'plugin' | 'copy' | 'none',
 * dataRoot, pluginDataIgnored, reason, configDir, pluginsDir }.
 * - plugin: CLAUDE_PLUGIN_DATA set (absolute) and the server's real path is
 *   inside the plugins folder; data root = the variable's real path.
 * - none: the server sits inside the plugins folder but the variable is unset,
 *   empty or not absolute; nothing is bound or written.
 * - copy: every other case; data root = <server folder>/../data, from the
 *   server's own real path only; a set variable is ignored and said so.
 */
function installMode({ env, serverFile, home, platform = process.platform }) {
  const configDir = configDirOf(env, home, platform);
  const pluginsDir = pluginsDirOf(env, configDir, platform);
  const serverReal = realLoose(serverFile);
  const inPlugins = fsx.isInside(serverReal, pluginsDir, platform);
  const raw = env.CLAUDE_PLUGIN_DATA;
  const varSet = nonEmpty(raw) && isAbsoluteFor(raw.trim(), platform);
  if (inPlugins) {
    if (!varSet) return { mode: 'none', dataRoot: null, pluginDataIgnored: false, reason: REASONS.PLUGIN_DATA_NOT_SET, configDir, pluginsDir };
    return { mode: 'plugin', dataRoot: realLoose(raw.trim()), pluginDataIgnored: false, reason: null, configDir, pluginsDir };
  }
  const serverDir = path.dirname(serverReal);
  return {
    mode: 'copy',
    dataRoot: path.join(path.dirname(serverDir), 'data'),
    pluginDataIgnored: nonEmpty(raw),
    reason: null,
    configDir,
    pluginsDir,
  };
}

/**
 * The project root to bind (9.10, SR-1): the real path of CLAUDE_PROJECT_DIR,
 * else of the process start folder. Returns { rootReal, source } or { refused }.
 */
function resolveRoot({ env, cwd, platform = process.platform }) {
  // SEAM(check 6): what CLAUDE_PROJECT_DIR holds for a server started in a subfolder (that folder or the git top) is not yet probed. Default: bind exactly the variable's real path (else the start folder), never ask for MCP roots (SR-3), never walk up to a git top. The live answer may change only which folder this returns.
  const v = env.CLAUDE_PROJECT_DIR;
  if (v !== undefined && v !== null && String(v) !== '') {
    const s = String(v);
    if (!isAbsoluteFor(s, platform)) return { refused: REASONS.PROJECT_DIR_RELATIVE };
    try {
      return { rootReal: fs.realpathSync.native(s), source: 'project_dir' };
    } catch (_) {
      return { refused: REASONS.PROJECT_DIR_MISSING };
    }
  }
  try {
    return { rootReal: fs.realpathSync.native(cwd), source: 'start_folder' };
  } catch (_) {
    return { refused: REASONS.START_FOLDER_MISSING };
  }
}

function isFilesystemRoot(p, platform) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const r = P.resolve(p);
  return P.parse(r).root === r || fsx.samePath(P.dirname(r), r, platform);
}

function isNetworkPath(p, platform, statfs) {
  if (platform === 'win32') return /^[\\/]{2}/.test(p);
  if (platform === 'linux' && typeof statfs === 'function') {
    try {
      const s = statfs(p);
      if (s && LINUX_NETWORK_FS.has(Number(s.type))) return true;
    } catch (_) { /* unknown: not refused for this reason */ }
  }
  return false;
}

/**
 * SR-4: the reason a root is refused, or null. ctx: { home, configDir,
 * pluginsDir, dataRoot, tempDir, platform, statfs }.
 */
function refusedRoot(rootReal, ctx) {
  const platform = ctx.platform || process.platform;
  if (isNetworkPath(rootReal, platform, ctx.statfs)) return REASONS.NETWORK;
  if (isFilesystemRoot(rootReal, platform)) return REASONS.FS_ROOT;
  if (ctx.home && fsx.isInside(ctx.home, rootReal, platform)) return REASONS.HOME;
  if (ctx.configDir && fsx.isInside(rootReal, ctx.configDir, platform)) return REASONS.CONFIG;
  if (ctx.dataRoot && fsx.isInside(rootReal, ctx.dataRoot, platform)) return REASONS.DATA;
  if (ctx.pluginsDir && fsx.isInside(rootReal, ctx.pluginsDir, platform)) return REASONS.PLUGINS;
  if (ctx.tempDir && fsx.isInside(ctx.tempDir, rootReal, platform)) return REASONS.TEMP;
  return null;
}

/**
 * The per-project switch (9.1, SR-6). raw: the `projects` option as it
 * arrived. Returns { enabled, bad, refusedEntries, listRefused }.
 * - Each entry must be absolute; it is resolved to its real path; it enables
 *   search only when it equals the bound root exactly (SR-5 compare).
 * - A relative, empty or unresolvable entry is ignored and counted (bad).
 * - When the list arrived as one joined string and any piece is not absolute,
 *   the whole option is refused (9.1 e).
 */
function projectSwitch(rootReal, raw, ctx = {}) {
  const platform = ctx.platform || process.platform;
  // SEAM(check 5): the list arrives through floor.splitListOption only. Known without login: the CLI stores a list as one comma-joined line, and a never-set option is an empty value; the live probe confirms what the server sees.
  const { entries, joined } = floor.splitListOption(raw);
  const out = { enabled: false, bad: 0, refusedEntries: 0, listRefused: false };
  if (joined && entries.some((e) => !isAbsoluteFor(String(e).trim(), platform))) {
    out.listRefused = true;
    return out;
  }
  for (const e of entries) {
    try {
      const s = String(e).trim();
      if (!isAbsoluteFor(s, platform)) { out.bad++; continue; }
      let real;
      try {
        real = fs.realpathSync.native(s);
      } catch (_) {
        out.bad++;
        continue;
      }
      if (refusedRoot(real, ctx)) { out.refusedEntries++; continue; }
      if (fsx.samePath(real, rootReal, platform)) out.enabled = true;
    } catch (_) {
      out.bad++;
    }
  }
  return out;
}

/**
 * SR-44a / 6.9: true when the real path of the running Node program sits inside
 * the project folder or the start folder. A folder that is a filesystem root,
 * the home folder or above it is not tested (a user-wide Node is inside those).
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
    if (home && fsx.isInside(home, real, platform)) continue;
    if (fsx.isInside(exe, real, platform)) return true;
  }
  return false;
}

/** The home folder as the server sees it (real path when it exists). */
function homeDir() {
  return realLoose(os.homedir());
}

/** The OS temp folder (real path when it exists). */
function tempDir() {
  return realLoose(os.tmpdir());
}

module.exports = {
  REASONS,
  isAbsoluteFor,
  realLoose,
  configDirOf,
  pluginsDirOf,
  installMode,
  resolveRoot,
  isFilesystemRoot,
  isNetworkPath,
  refusedRoot,
  projectSwitch,
  nodeInsideProject,
  homeDir,
  tempDir,
};
