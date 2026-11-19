// Sandbox guard (spec 13.7). Dev only, never shipped.
//
// One shared module for scripts/sandbox.mjs and scripts/copy-by-hand.mjs.
// It refuses to run when a guarded variable could reach the developer's real
// home or real config folder, builds the child environment that keeps every
// temporary file and every git setting under sandbox/, and takes a narrow,
// read-only listing of the few real items a kit install could touch.
//
// The guard only reads. It uses lstat first, never follows a link while
// listing, never writes and never repairs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Variables that must all point at folders under sandbox/ (13.7).
export const GUARDED_VARS = Object.freeze([
  'HOME',
  'USERPROFILE',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_PLUGIN_CACHE_DIR',
  'XDG_CONFIG_HOME',
  'APPDATA',
  'LOCALAPPDATA',
]);

// Variables the guard sets to folders under sandbox/ for every child (13.7).
export const CHILD_DIR_VARS = Object.freeze([
  'TMP',
  'TEMP',
  'TMPDIR',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
]);

// Plugin registry files watched by the listing (13.7 d).
// TODO(build step 0c, day-one check 11): confirm these names with the live
// probe and update this list if the probe names different files.
export const REGISTRY_FILES = Object.freeze([
  Object.freeze(['plugins', 'installed_plugins.json']),
  Object.freeze(['plugins', 'known_marketplaces.json']),
]);

// Name of the kit folder that a copy-by-hand install creates (13.7 e).
export const KIT_FOLDER_NAME = 'pocotoko';

export class GuardRefusal extends Error {
  constructor(problems) {
    super('sandbox guard refused to run:\n' + problems.map((p) => '  - ' + p).join('\n'));
    this.name = 'GuardRefusal';
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// Paths

/** The repo top, found from this file's own place (scripts/lib/guard.mjs). */
export function kitRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** The real home folder. Never HOME or USERPROFILE, which a test sets. */
export function realHome() {
  return os.userInfo().homedir;
}

export function sandboxDir(repo = kitRoot()) {
  return path.join(repo, 'sandbox');
}

export function isCaseInsensitive(platform = process.platform) {
  return platform === 'win32' || platform === 'darwin';
}

function norm(p, platform) {
  const r = path.resolve(p);
  return isCaseInsensitive(platform) ? r.toLowerCase() : r;
}

/** True when a and b name the same path (case-insensitive on Windows and macOS). */
export function samePath(a, b, platform = process.platform) {
  return norm(a, platform) === norm(b, platform);
}

/**
 * True when child is parent itself or sits inside it. A child folder named
 * `..notes` is inside; a path whose `..` segments leave parent is not.
 */
export function isInside(child, parent, platform = process.platform) {
  const c = norm(child, platform);
  const p = norm(parent, platform);
  if (c === p) return true;
  const rel = path.relative(p, c);
  if (rel === '' ) return true;
  if (path.isAbsolute(rel)) return false; // another drive or a UNC path
  if (rel === '..' || rel.startsWith('..' + path.sep)) return false;
  return true;
}

/**
 * Real path of p. Parts that do not exist yet are kept as written on top of
 * the real path of the nearest existing parent. Reads only.
 */
export function realpathLoose(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return rest.length ? path.join(real, ...rest.slice().reverse()) : real;
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        const parent = path.dirname(cur);
        if (parent === cur) return path.resolve(p);
        rest.push(path.basename(cur));
        cur = parent;
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Refusals

/** Problems with sandbox/ itself: missing, or a link whose real path leaves the repo. */
export function checkSandboxFolder({ repo = kitRoot(), platform = process.platform } = {}) {
  const problems = [];
  const sb = sandboxDir(repo);
  let st;
  try {
    st = fs.lstatSync(sb);
  } catch (err) {
    problems.push(err && err.code === 'ENOENT'
      ? 'sandbox/ folder is missing; create it inside the repo first'
      : 'sandbox/ folder cannot be read (' + ((err && err.code) || 'error') + ')');
    return problems;
  }
  let real;
  let repoReal;
  try {
    real = fs.realpathSync.native(sb);
    repoReal = fs.realpathSync.native(repo);
  } catch (err) {
    problems.push('sandbox/ real path cannot be resolved (' + ((err && err.code) || 'error') + ')');
    return problems;
  }
  // A junction may not be reported by lstat as a link (day-one check 17), so
  // the real-path compare runs whatever lstat says.
  if (!isInside(real, repoReal, platform) || samePath(real, repoReal, platform)) {
    problems.push('sandbox/ is a link or junction whose real path is outside the repo');
  } else if (!st.isDirectory() && !st.isSymbolicLink()) {
    problems.push('sandbox/ is not a folder');
  }
  return problems;
}

/**
 * Problems with the guarded variables in env. Every guarded variable must be
 * set to an absolute path under sandbox/, must not name the real home, the
 * real config folder (or anything in it) or the real ~/.claude.json, and its
 * real path must stay under sandbox/. A value that is plainly outside
 * sandbox/ is refused from its text alone, before any file-system call.
 * Messages name the variable, never its value.
 */
export function checkEnv({
  env = process.env,
  repo = kitRoot(),
  home = realHome(),
  platform = process.platform,
  vars = GUARDED_VARS,
} = {}) {
  const problems = [];
  const sbLex = sandboxDir(repo);
  const realClaudeDir = path.join(home, '.claude');
  const realClaudeJson = path.join(home, '.claude.json');
  let sbReal = null;

  const realChecks = (name, p) => {
    if (samePath(p, home, platform)) return name + ' points at the real home folder';
    if (isInside(p, realClaudeDir, platform)) return name + ' points at the real config folder (~/.claude) or inside it';
    if (samePath(p, realClaudeJson, platform)) return name + ' points at the real ~/.claude.json';
    return null;
  };

  for (const name of vars) {
    try {
      const v = env[name];
      if (v === undefined || v === null || v === '') {
        problems.push(name + ' is not set; it must point to a folder under sandbox/');
        continue;
      }
      if (!path.isAbsolute(v)) {
        problems.push(name + ' is not an absolute path');
        continue;
      }
      const lex = path.resolve(v);
      const hit = realChecks(name, lex);
      if (hit) { problems.push(hit); continue; }
      if (!isInside(lex, sbLex, platform)) {
        problems.push(name + ' is outside sandbox/');
        continue;
      }
      // Inside sandbox/ by its text: now check where it really leads.
      if (sbReal === null) sbReal = realpathLoose(sbLex);
      const real = realpathLoose(lex);
      const hit2 = realChecks(name, real);
      if (hit2) { problems.push(hit2 + ' (through a link)'); continue; }
      if (!isInside(real, sbReal, platform)) {
        problems.push(name + ' resolves through a link or junction to a place outside sandbox/');
      }
    } catch (err) {
      problems.push(name + ' cannot be checked (' + ((err && err.code) || 'error') + ')');
    }
  }
  return problems;
}

/** All refusals: sandbox/ itself, then the variables. */
export function preflight(opts = {}) {
  const problems = checkSandboxFolder(opts);
  return problems.concat(checkEnv(opts));
}

/** Throws GuardRefusal when preflight finds any problem. */
export function assertSafe(opts = {}) {
  const problems = preflight(opts);
  if (problems.length) throw new GuardRefusal(problems);
}

/**
 * Decision half of the PowerShell expansion check (13.7): given the paths a
 * rendered command expands to, refuse any that lands outside sandbox/.
 */
export function checkExpandedPaths(paths, { repo = kitRoot(), platform = process.platform } = {}) {
  const problems = [];
  const sb = sandboxDir(repo);
  let sbReal = null;
  paths.forEach((p, i) => {
    try {
      if (typeof p !== 'string' || p === '' || !path.isAbsolute(p)) {
        problems.push('expanded path #' + (i + 1) + ' is not an absolute path');
        return;
      }
      if (!isInside(p, sb, platform)) {
        problems.push('expanded path #' + (i + 1) + ' lands outside sandbox/');
        return;
      }
      if (sbReal === null) sbReal = realpathLoose(sb);
      if (!isInside(realpathLoose(p), sbReal, platform)) {
        problems.push('expanded path #' + (i + 1) + ' resolves through a link outside sandbox/');
      }
    } catch (err) {
      problems.push('expanded path #' + (i + 1) + ' cannot be checked (' + ((err && err.code) || 'error') + ')');
    }
  });
  return problems;
}

/**
 * Shell half of the PowerShell expansion check (13.7): ask the same shell
 * what a rendered command expands to.
 *
 * TODO(B9): built with copy-by-hand.mjs, when the rendered PowerShell block
 * exists (spec 16, step 9). Build step 0b covers only the variable refusals
 * and the narrow listing. Until then this refuses, so nothing can run a
 * PowerShell block unchecked.
 */
export function expandInPowerShell() {
  throw new GuardRefusal(['PowerShell expansion check is not built yet (arrives with copy-by-hand.mjs in B9); no PowerShell block may run']);
}

// ---------------------------------------------------------------------------
// Child environment

/** The sandbox folders a run uses, all under runDir. The caller creates them. */
export function sandboxLayout(runDir) {
  const r = path.resolve(runDir);
  return {
    home: path.join(r, 'home'),
    config: path.join(r, 'home', '.claude'),
    pluginCache: path.join(r, 'home', '.claude', 'plugins'),
    xdgConfig: path.join(r, 'home', '.config'),
    appData: path.join(r, 'home', 'AppData', 'Roaming'),
    localAppData: path.join(r, 'home', 'AppData', 'Local'),
    tmp: path.join(r, 'tmp'),
    xdgData: path.join(r, 'xdg', 'data'),
    xdgState: path.join(r, 'xdg', 'state'),
    xdgCache: path.join(r, 'xdg', 'cache'),
    gitConfig: path.join(r, 'git', 'gitconfig'),
  };
}

function requireRunDir(runDir, repo) {
  if (typeof runDir !== 'string' || !path.isAbsolute(runDir) || !isInside(runDir, sandboxDir(repo))
      || samePath(runDir, sandboxDir(repo))) {
    throw new GuardRefusal(['run folder must be an absolute path to a folder inside sandbox/']);
  }
}

/**
 * Env for every child the guard starts: TMP, TEMP, TMPDIR and the XDG data,
 * state and cache folders under runDir; git reads only a sandbox global
 * config and no system config.
 */
export function childEnv(baseEnv, runDir, { repo = kitRoot() } = {}) {
  requireRunDir(runDir, repo);
  const L = sandboxLayout(runDir);
  const env = { ...baseEnv };
  env.TMP = L.tmp;
  env.TEMP = L.tmp;
  env.TMPDIR = L.tmp;
  env.XDG_DATA_HOME = L.xdgData;
  env.XDG_STATE_HOME = L.xdgState;
  env.XDG_CACHE_HOME = L.xdgCache;
  env.GIT_CONFIG_GLOBAL = L.gitConfig;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/** childEnv plus every guarded variable pointed at a sandbox home under runDir. */
export function sandboxEnv(baseEnv, runDir, { repo = kitRoot() } = {}) {
  const env = childEnv(baseEnv, runDir, { repo });
  const L = sandboxLayout(runDir);
  env.HOME = L.home;
  env.USERPROFILE = L.home;
  env.CLAUDE_CONFIG_DIR = L.config;
  env.CLAUDE_CODE_PLUGIN_CACHE_DIR = L.pluginCache;
  env.XDG_CONFIG_HOME = L.xdgConfig;
  env.APPDATA = L.appData;
  env.LOCALAPPDATA = L.localAppData;
  return env;
}

// ---------------------------------------------------------------------------
// Narrow read-only listing (13.7 a-f)

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

// lstat first; a link is recorded as a link and never followed.
function fileState(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return { kind: 'absent' };
    return { kind: 'unreadable', code: (err && err.code) || 'error' };
  }
  if (st.isSymbolicLink()) {
    let target = '';
    try { target = fs.readlinkSync(p); } catch { /* keep empty */ }
    return { kind: 'link', value: 'link:' + sha256(target) };
  }
  if (st.isDirectory()) return { kind: 'dir' };
  if (!st.isFile()) return { kind: 'other' };
  try {
    return { kind: 'file', bytes: fs.readFileSync(p) };
  } catch (err) {
    return { kind: 'unreadable', code: (err && err.code) || 'error' };
  }
}

function hashItem(p) {
  const s = fileState(p);
  if (s.kind === 'file') return 'sha256:' + sha256(s.bytes);
  if (s.kind === 'link') return s.value;
  if (s.kind === 'unreadable') return 'unreadable:' + s.code;
  return s.kind; // absent, dir, other
}

function mcpServersItem(p) {
  const s = fileState(p);
  if (s.kind !== 'file') return s.kind === 'link' ? s.value : (s.kind === 'unreadable' ? 'unreadable:' + s.code : s.kind);
  let parsed;
  try {
    parsed = JSON.parse(s.bytes.toString('utf8'));
  } catch {
    return 'unparseable';
  }
  if (!parsed || typeof parsed !== 'object' || !Object.prototype.hasOwnProperty.call(parsed, 'mcpServers')) {
    return 'no-mcpServers';
  }
  return 'sha256:' + sha256(canonical(parsed.mcpServers));
}

function skillsItem(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return 'absent';
    return 'unreadable:' + ((err && err.code) || 'error');
  }
  if (st.isSymbolicLink()) {
    let target = '';
    try { target = fs.readlinkSync(dir); } catch { /* keep empty */ }
    return 'link:' + sha256(target);
  }
  if (!st.isDirectory()) return 'not-a-folder';
  try {
    return 'names:' + JSON.stringify(fs.readdirSync(dir).slice().sort());
  } catch (err) {
    return 'unreadable:' + ((err && err.code) || 'error');
  }
}

function existsItem(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isSymbolicLink() ? 'present-link' : 'present';
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return 'absent';
    return 'unreadable:' + ((err && err.code) || 'error');
  }
}

/**
 * Narrow read-only listing of the real items a kit install could touch.
 * Defaults to the real home; tests pass a stand-in folder under sandbox/.
 * Returns { items: { <item name>: <state> } }. Values are hashes or states,
 * never file contents.
 */
export function takeListing({ home = realHome(), configDir } = {}) {
  const cfg = configDir || path.join(home, '.claude');
  const items = {};
  const add = (name, fn) => {
    try { items[name] = fn(); } catch (err) { items[name] = 'unreadable:' + ((err && err.code) || 'error'); }
  };
  add('settings.json', () => hashItem(path.join(cfg, 'settings.json')));
  add('.claude.json mcpServers', () => mcpServersItem(path.join(home, '.claude.json')));
  add('skills', () => skillsItem(path.join(cfg, 'skills')));
  for (const parts of REGISTRY_FILES) {
    add(parts.join('/'), () => hashItem(path.join(cfg, ...parts)));
  }
  add(KIT_FOLDER_NAME + ' kit folder', () => existsItem(path.join(cfg, KIT_FOLDER_NAME)));
  add('git global config', () => hashItem(path.join(home, '.gitconfig')));
  add('git XDG config', () => hashItem(path.join(home, '.config', 'git', 'config')));
  return { items };
}

/** Names of the items that differ between two listings (names only). */
export function compareListings(before, after) {
  const names = new Set([...Object.keys(before.items), ...Object.keys(after.items)]);
  const changed = [];
  for (const n of [...names].sort()) {
    if (before.items[n] !== after.items[n]) changed.push(n);
  }
  return changed;
}

/**
 * Run one guarded step: refuse first (no listing, no step), then list,
 * run the step, list again and compare. Any change fails the run and names
 * the changed items only.
 */
export async function guardedRun({ step, env = process.env, repo = kitRoot(), home = realHome(),
  listHome, listConfigDir, platform = process.platform } = {}) {
  const problems = preflight({ env, repo, home, platform });
  if (problems.length) return { ok: false, refused: true, problems, changed: [] };
  const lh = listHome || home;
  const before = takeListing({ home: lh, configDir: listConfigDir });
  let result;
  let error = null;
  try {
    result = await step();
  } catch (err) {
    error = err;
  }
  const after = takeListing({ home: lh, configDir: listConfigDir });
  const changed = compareListings(before, after);
  return { ok: changed.length === 0 && !error, refused: false, problems: [], changed, result, error };
}

/** One line for a changed listing, naming items only. */
export function describeChanges(changed) {
  return changed.length
    ? 'sandbox guard: real config items changed during the run: ' + changed.join(', ')
      + ' (close every Claude Code session and run again to tell a live edit from a leak)'
    : 'sandbox guard: real config items unchanged';
}
