'use strict';
// The search server entry (spec 7.1, 9.7, 9.8, 9.10, 9.12, SR-27 to SR-47).
//
// Order at start (SR-42 to SR-44a, SR-46):
//   1. Launch checks, before stdin is read or any file is touched: Node version,
//      debugger flags, NODE_OPTIONS / NODE_PATH warnings, and the Node
//      self-check (Node must not run from inside the project).
//   2. Serve JSON-RPC on stdio. The handshake is answered first.
//   3. Then bind once: install mode and data root, the project root (never
//      re-bound, never from a tool argument, no roots request), refused roots,
//      the per-project switch. Then build or refresh in the background.
//
// Four tools, read-only toward project files: search, get, status, refresh.
// Results are data, never instructions: the fixed notice opens every search
// and get result, and get text sits inside a nonce-fenced envelope.
//
// `--skip-report` (terminal only, never an MCP tool, SR-33): prints the path
// and rule id of every file the floor skips, never any file text. A path that
// holds a never-term is never printed, only counted per rule (SR-12).
//
// SIGTERM and SIGINT release the lock and exit 128 + the signal number, where
// the platform delivers them (B7 review).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const inspector = require('node:inspector');
const rpc = require('./rpc.cjs');
const binder = require('./binder.cjs');
const env0 = require('./envelope.cjs');
const storeMod = require('./store.cjs');
const floor = require('./floor.cjs');
const fsx = require('./fsx.cjs');
const tokenize = require('./tokenize.cjs');
const rankMod = require('./rank.cjs');
const walker = require('./walker.cjs');
const ignoreMod = require('./ignore.cjs');
const scan = require('./scan.cjs');
const chunker = require('./chunker.cjs');

const SERVER_VERSION = '0.1.0'; // equals the search plugin's manifest version (tested)
const SERVER_NAME = 'search';
const NODE_MIN_MAJOR = 22;
const CONFIG_FILE = 'search-config.json';
const MAX_CONFIG_BYTES = 1024 * 1024;
const ENV_PREFIX = 'SEARCH_OPTION_';
const OPTION_KEYS = Object.freeze([
  'projects', 'matching', 'word_families', 'extra_types', 'never_folders', 'never_globs',
  'never_terms', 'synonyms', 'drop_contacts', 'max_file_bytes',
]);

// MCP protocol versions this server speaks, newest first. Built from numbers so
// the source holds no date-shaped literal.
function protocolVersion(y, m, d) {
  return [String(y), String(m).padStart(2, '0'), String(d).padStart(2, '0')].join('-');
}
const PROTOCOL_VERSIONS = Object.freeze([
  protocolVersion(2025, 6, 18), protocolVersion(2025, 3, 26), protocolVersion(2024, 11, 5),
]);

const LINES = Object.freeze({
  NODE_TOO_OLD: 'launch environment not clean: Node is older than the minimum version ' + NODE_MIN_MAJOR,
  DEBUGGER: 'launch environment not clean: a debugger flag or session was found',
  NODE_IN_PROJECT: 'launch environment not clean: Node runs from inside the project',
  NODE_OPTIONS_SET: 'warning: NODE_OPTIONS is set; check that you meant it',
  NODE_PATH_SET: 'warning: NODE_PATH is set; check that you meant it',
  PLUGIN_DATA_IGNORED: 'copy-by-hand mode: CLAUDE_PLUGIN_DATA is set but ignored; the data folder is beside the server folder',
  CONFIG_UNREADABLE: 'warning: search-config.json could not be read; no options were applied',
  OFF_FILE: 'Search is off: an OFF file is in the search data folder. Remove it to turn search back on.',
  NOT_FOUND: 'not found',
  CHANGED: 'changed, search again',
  ALREADY: 'already running',
  REBUILDING: 'IndexRebuilding: the index is being rebuilt from source after a change; search again shortly, or use your normal file search',
  WINDOWS_PERMS: 'windows: the index takes your profile folder permissions; they are not checked',
  BIND_FAILED: 'Search is off: the project could not be bound because of an internal error. Restart the session to try again.',
  // SR-12: shown in place of a bound folder whose path holds a never-term.
  FOLDER_MASKED: '(not shown: the folder path holds one of your never-terms)',
});

// SR-12: the skip report's line for paths it does not print, one per rule:
// "masked<TAB><rule id><TAB><count>".
const MASKED_TAG = 'masked';
const SIGNALS = Object.freeze(['SIGTERM', 'SIGINT']);

const STORE_OFF_LINES = Object.freeze({
  in_git: storeMod.IN_GIT_LINE,
  in_project: storeMod.IN_PROJECT_LINE,
  off_file: LINES.OFF_FILE,
});

const DEBUG_FLAG_RE = /^--(?:inspect|inspect-brk|inspect-wait|inspect-port|debug|debug-brk|debug-port)(?:=.*)?$/;

const TOOL_DEFS = Object.freeze([
  {
    name: 'search',
    description: env0.RULES_BLOCK,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: tokenize.MAX_QUERY_CHARS, description: 'Plain words to look for. A trailing * after a word of 3 or more letters matches words that start with it. No other operators.' },
        k: { type: 'integer', minimum: rankMod.K_MIN, maximum: rankMod.K_MAX, default: rankMod.K_DEFAULT, description: 'How many results, 1 to 10.' },
        include_retired: { type: 'boolean', default: false, description: 'Also show cancelled text, which is hidden by default.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get',
    description: 'Returns the stored text of one search result, by its id, inside a fenced envelope. ' + env0.NOTICE + ' It is a reading aid, not proof.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', maxLength: 64, description: 'An id from a search result of this session.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'status',
    description: 'Totals only: the bound folder, the state, counts, the last refresh, skipped counts by rule, the matching level, the version and warnings.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'refresh',
    description: 'Checks the project files for changes now and returns counts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]);

function invalid(name = 'InvalidArgument') {
  return new rpc.RpcError(rpc.CODES.INVALID_PARAMS, 'Invalid params', name);
}

/** SR-2: only the schema's own arguments, each of the right type; anything else is refused. */
function checkArgs(def, args) {
  const a = args === undefined || args === null ? {} : args;
  if (typeof a !== 'object' || Array.isArray(a)) throw invalid();
  const props = def.inputSchema.properties;
  for (const k of Object.keys(a)) {
    if (!Object.prototype.hasOwnProperty.call(props, k)) throw invalid();
  }
  for (const r of def.inputSchema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(a, r)) throw invalid();
  }
  if (def.name === 'search') {
    if (typeof a.query !== 'string') throw invalid();
    if (a.query.length > tokenize.MAX_QUERY_CHARS) throw invalid('QueryTooLong');
    if (a.k !== undefined && (typeof a.k !== 'number' || !Number.isInteger(a.k) || a.k < rankMod.K_MIN || a.k > rankMod.K_MAX)) throw invalid();
    if (a.include_retired !== undefined && typeof a.include_retired !== 'boolean') throw invalid();
  }
  if (def.name === 'get') {
    if (typeof a.id !== 'string' || a.id.length > 64) throw invalid();
  }
  return a;
}

// ---------------------------------------------------------------------------
// Options (9.13)

/**
 * Plugin mode: every option reaches the server through the `env` block of
 * .mcp.json, as `${user_config.KEY}` substituted into SEARCH_OPTION_<KEY>.
 */
function optionsFromEnv(env) {
  // SEAM(check 5): how options reach the server. Default: each option through `env` only (never `args`), read here and passed raw to the existing parsers; a never-set option (an empty value, or raw `${user_config.KEY}` text) counts as unset through floor.isUnsetValue, so the option's default applies. The live answer may change only the key mapping here.
  const out = {};
  for (const k of OPTION_KEYS) {
    const raw = env[ENV_PREFIX + k.toUpperCase()];
    if (!floor.isUnsetValue(raw)) out[k] = raw;
  }
  return out;
}

/** Copy-by-hand mode: <data root>/search-config.json, read only, never written (9.1). */
function optionsFromFile(dataRoot) {
  const file = path.join(dataRoot, CONFIG_FILE);
  let r;
  try {
    r = fsx.readOwnFile(file, MAX_CONFIG_BYTES);
  } catch (_) {
    return { options: {}, unreadable: true };
  }
  if (r.absent) return { options: {}, unreadable: false };
  if (!r.buf) return { options: {}, unreadable: true };
  let obj;
  try {
    obj = JSON.parse(r.buf.toString('utf8'));
  } catch (_) {
    return { options: {}, unreadable: true };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { options: {}, unreadable: true };
  const out = {};
  for (const k of OPTION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    if (Array.isArray(v) || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') {
      if (!floor.isUnsetValue(v)) out[k] = v;
    }
  }
  return { options: out, unreadable: false };
}

// ---------------------------------------------------------------------------
// Launch checks (SR-42 to SR-44a)

function launchChecks(ctx) {
  const problems = [];
  const warnings = [];
  const major = Number.parseInt(String(ctx.nodeVersion).replace(/^v/, '').split('.')[0], 10);
  if (!Number.isInteger(major) || major < NODE_MIN_MAJOR) problems.push(LINES.NODE_TOO_OLD);

  const nodeOptions = typeof ctx.env.NODE_OPTIONS === 'string' ? ctx.env.NODE_OPTIONS : '';
  const flags = [...(ctx.execArgv || []), ...nodeOptions.split(/\s+/).filter(Boolean)];
  let url;
  try { url = ctx.inspectorUrl(); } catch (_) { url = undefined; }
  if (flags.some((f) => DEBUG_FLAG_RE.test(f)) || url) {
    try { ctx.inspectorClose(); } catch (_) { /* nothing open */ }
    problems.push(LINES.DEBUGGER);
  } else if (nodeOptions.trim() !== '') {
    warnings.push(LINES.NODE_OPTIONS_SET);
  }
  if (typeof ctx.env.NODE_PATH === 'string' && ctx.env.NODE_PATH.trim() !== '') warnings.push(LINES.NODE_PATH_SET);

  if (binder.nodeInsideProject({
    execPath: ctx.execPath, projectDir: ctx.env.CLAUDE_PROJECT_DIR, cwd: ctx.cwd, home: ctx.home, platform: ctx.platform,
  })) problems.push(LINES.NODE_IN_PROJECT);
  return { problems, warnings };
}

// ---------------------------------------------------------------------------
// The server

/**
 * Create the server state for one process. seams (test-only, passed by a test
 * launcher, never read from the environment): { gitCeiling, globalExcludes,
 * nodeVersion, execArgv, inspectorUrl, storeHooks, statBudgetMs }.
 */
function createServer({ env = process.env, cwd = process.cwd(), serverFile = __filename, seams = {} } = {}) {
  const platform = process.platform;
  const home = binder.homeDir();
  const launch = launchChecks({
    env,
    cwd,
    home,
    platform,
    execPath: process.execPath,
    nodeVersion: seams.nodeVersion || process.versions.node,
    execArgv: seams.execArgv || process.execArgv,
    inspectorUrl: seams.inspectorUrl ? () => seams.inspectorUrl : () => inspector.url(),
    inspectorClose: () => inspector.close(),
  });

  const ids = env0.createIdMap();
  const s = {
    bound: false,
    rootReal: null,
    rootMasked: false, // the bound folder's path holds a never-term (SR-12)
    reason: null,
    install: null,
    options: {},
    switchInfo: null,
    store: null,
    dropped: null, // a store dropped after its load failed, until it is closed
    warnings: launch.warnings.slice(),
  };

  function bindOnce() {
    if (s.bound) return;
    s.bound = true;
    try {
      bindSteps();
    } catch (_) {
      // Any throw while binding leaves search off with a fixed reason, never
      // "off" with none (B7 review). The store, if made, is closed and dropped.
      try { if (s.store) s.store.close(); } catch (_e) { /* ignore */ }
      s.store = null;
      s.reason = LINES.BIND_FAILED;
    }
  }

  function bindSteps() {
    if (launch.problems.length) { s.reason = launch.problems[0]; return; }
    const inst = binder.installMode({ env, serverFile, home, platform });
    s.install = inst;
    if (inst.mode === 'none') { s.reason = inst.reason; return; }
    if (inst.pluginDataIgnored) s.warnings.push(LINES.PLUGIN_DATA_IGNORED);
    if (inst.mode === 'plugin') {
      s.options = optionsFromEnv(env);
    } else {
      const f = optionsFromFile(inst.dataRoot);
      s.options = f.options;
      if (f.unreadable) s.warnings.push(LINES.CONFIG_UNREADABLE);
    }
    const root = binder.resolveRoot({ env, cwd, platform });
    if (root.refused) { s.reason = root.refused; return; }
    const ctx = {
      home,
      configDir: inst.configDir,
      pluginsDir: inst.pluginsDir,
      dataRoot: inst.dataRoot,
      tempDir: binder.tempDir(),
      platform,
      statfs: typeof fs.statfsSync === 'function' ? fs.statfsSync : null,
    };
    const refused = binder.refusedRoot(root.rootReal, ctx);
    if (refused) { s.reason = refused; return; }
    s.rootReal = root.rootReal;
    s.rootMasked = floor.termHit(floor.buildFilter(s.options), root.rootReal);
    const sw = binder.projectSwitch(root.rootReal, s.options.projects, ctx);
    s.switchInfo = sw;
    if (sw.listRefused) { s.reason = binder.REASONS.LIST_UNSAFE; return; }
    if (!sw.enabled) { s.reason = binder.REASONS.NOT_ENABLED; return; }
    s.store = storeMod.createStore({
      dataRoot: inst.dataRoot,
      rootReal: root.rootReal,
      options: s.options,
      globalExcludes: seams.globalExcludes,
      gitCeiling: seams.gitCeiling || null,
      hooks: seams.storeHooks || {},
      platform,
    });
    // Load the stored index, then build or refresh, in the background; tools
    // say `building` meanwhile, and initialize and tools/list are answered
    // between the load's slices (SR-46).
    const store = s.store;
    store.openInBackground().then(
      () => store.refresh().catch(() => { /* counted in the run; the next stat pass tries again */ }),
      () => loadFailed(store),
    );
  }

  /**
   * The background load rejected (B7 review). The store has already emptied
   * its memory and recorded a full rebuild; the server treats this as a bind
   * that failed (9.7): search is off with the fixed BIND_FAILED line, never
   * "off" with no reason, and the error itself is never shown. The store is
   * dropped now and closed once any refresh it is running has ended, so its
   * lock is released.
   */
  function loadFailed(store) {
    if (s.store === store) s.store = null;
    s.reason = LINES.BIND_FAILED;
    s.dropped = store; // still closed on SIGTERM / SIGINT while a refresh runs
    store.idle()
      .catch(() => { /* nothing to report */ })
      .then(() => {
        try { store.close(); } catch (_) { /* ignore */ }
        if (s.dropped === store) s.dropped = null;
      });
  }

  function storeOffLine() {
    const why = s.store ? s.store.status().reason : null;
    if (!why) return null;
    return STORE_OFF_LINES[why] || ('Search is off: ' + why);
  }

  function textResult(lines, isError = false) {
    const out = { content: [{ type: 'text', text: lines.join('\n') }] };
    if (isError) out.isError = true;
    return out;
  }

  function payloadResult(payload) {
    return textResult([env0.NOTICE, JSON.stringify(payload, null, 2)]);
  }

  function offPayload(reason) {
    return { state: 'off', reason, results: [] };
  }

  function statBudget() {
    return seams.statBudgetMs === undefined ? storeMod.STAT_BUDGET_MS : seams.statBudgetMs;
  }

  async function toolSearch(a) {
    if (!s.store) return payloadResult(offPayload(s.reason));
    const off = storeOffLine();
    if (off) return payloadResult(offPayload(off));
    let r;
    try {
      r = await s.store.search(a.query, { k: a.k, includeRetired: a.include_retired, statBudgetMs: statBudget() });
    } catch (err) {
      if (err && err.name === 'IndexRebuilding') return textResult([env0.NOTICE, LINES.REBUILDING], true);
      if (err && (err.name === 'QueryTooLong' || err.name === 'InvalidArgument')) throw invalid(err.name);
      throw err;
    }
    if (r.state === 'off') return payloadResult(offPayload(storeOffLine() || 'Search is off'));
    const notes = [...(r.notes || [])];
    if (r.truncated) notes.push('query_words_capped');
    if (r.partial) notes.push('partial');
    const payload = {
      state: r.state,
      matching: r.matching,
      results: r.results.map((h) => ({
        id: ids.issue(h.key),
        file: h.path,
        heading: env0.cleanField(h.heading),
        line: h.line,
        date: env0.cleanField(h.date),
        flag: h.flag,
        successor: h.successor,
        matched_by: h.matched_by,
      })),
      hidden_count: r.hiddenCount,
      hidden: r.hidden.map((x) => ({ file: x.path, heading: env0.cleanField(x.heading) })),
      partial: !!r.partial,
      notes: notes.sort(),
    };
    if (r.state === 'stale') payload.reason = 'the stat pass ran over its time budget; the rest finishes in the background';
    if (r.state === 'building') payload.reason = 'the first build is still running';
    if (r.notice) payload.notice = r.notice;
    return payloadResult(payload);
  }

  async function toolGet(a) {
    if (!s.store) return payloadResult(offPayload(s.reason));
    const off = storeOffLine();
    if (off) return textResult([env0.NOTICE, off]);
    const key = ids.lookup(a.id);
    if (!key) return textResult([env0.NOTICE, LINES.NOT_FOUND]);
    const rec = s.store.getChunk(key);
    if (!rec) return textResult([env0.NOTICE, LINES.NOT_FOUND]);
    if (!s.store.recheck(rec.path).ok) return textResult([env0.NOTICE, LINES.CHANGED]);
    const state = await s.store.ensureFresh(statBudget());
    if (state === 'off') return textResult([env0.NOTICE, storeOffLine() || 'Search is off']);
    if (state === 'rebuilding') return textResult([env0.NOTICE, LINES.REBUILDING], true);
    const rec2 = s.store.getChunk(key);
    if (!rec2) return textResult([env0.NOTICE, LINES.CHANGED]);
    const e = env0.envelope({ file: rec2.path, heading: rec2.heading, indexedAt: s.store.indexedAt, flag: rec2.flag, text: rec2.text });
    const lines = [env0.NOTICE, e.text];
    if (e.cut) lines.push('(text cut at ' + env0.GET_MAX_CHARS + ' characters)');
    return textResult(lines);
  }

  function installLabel() {
    if (!s.install) return 'unknown';
    return s.install.mode === 'copy' ? 'copy-by-hand' : s.install.mode;
  }

  function toolStatus() {
    const st = s.store ? s.store.status() : null;
    const warnings = [...launch.problems, ...s.warnings];
    if (platform === 'win32' && s.store) warnings.push(LINES.WINDOWS_PERMS);
    let state = 'off';
    let reason = s.reason;
    if (st) {
      state = st.state === 'rebuilding' ? 'rebuilding' : st.state;
      if (st.reason) reason = STORE_OFF_LINES[st.reason] || ('Search is off: ' + st.reason);
      for (const w of st.warnings) warnings.push(w);
      if (st.rebuild && !st.rebuild.done) warnings.push('index is being rebuilt from source: ' + st.rebuild.reason);
    }
    const payload = {
      bound_folder: s.rootReal && s.rootMasked ? LINES.FOLDER_MASKED : s.rootReal,
      state,
      reason: reason || null,
      install_mode: installLabel(),
      plugin_version: SERVER_VERSION,
      matching: st ? st.matching : rankMod.queryOptions(s.options).matching,
      word_families: st ? st.wordFamilies : rankMod.queryOptions(s.options).wordFamilies,
      last_refresh: st && st.lastRefresh ? new Date(st.lastRefresh).toISOString() : null,
      folder_checks: st ? (st.folderChecks || 'not run') : 'not run',
      off_file: !!(st && st.reason === 'off_file'),
      counts: {
        files: st ? st.files : 0,
        chunks: st ? st.chunks : 0,
        succeeded: st ? st.succeeded : 0,
        failed: st ? st.failed : 0,
        skipped_by_rule: st ? st.skipped : {},
        skipped_folders_by_rule: st ? st.skippedDirs : {},
        failed_folders: st ? st.failedDirs : {},
        ignore_problems: st ? st.ignoreProblems : {},
        option_entries_ignored: st ? st.filterCounts : {},
        bad_project_entry: s.switchInfo ? s.switchInfo.bad : 0,
        refused_project_entry: s.switchInfo ? s.switchInfo.refusedEntries : 0,
        bad_synonym: rankMod.queryOptions(s.options).synonyms.bad,
      },
      incomplete: st ? st.incomplete : null,
      warnings,
    };
    return textResult([JSON.stringify(payload, null, 2)]);
  }

  async function toolRefresh() {
    if (!s.store) return textResult([JSON.stringify({ state: 'off', reason: s.reason }, null, 2)]);
    const r = await s.store.refresh();
    if (r && r.already) return textResult([LINES.ALREADY]);
    const skipped = Object.values(r.skipped || {}).reduce((x, y) => x + y, 0);
    const out = {
      state: s.store.state(),
      succeeded: r.succeeded || 0,
      failed: r.failed || 0,
      skipped,
      skipped_by_rule: r.skipped || {},
      visited: r.visited || 0,
      files: r.files || 0,
      chunks: r.chunks || 0,
      incomplete: r.incomplete || null,
      read_only: !!r.readOnly,
    };
    if (r.off) out.reason = STORE_OFF_LINES[r.off] || ('Search is off: ' + r.off);
    return textResult([JSON.stringify(out, null, 2)]);
  }

  async function callTool(params) {
    const p = params && typeof params === 'object' ? params : {};
    const def = TOOL_DEFS.find((d) => d.name === p.name);
    if (!def) throw invalid('UnknownTool');
    const a = checkArgs(def, p.arguments);
    bindOnce();
    if (def.name === 'search') return toolSearch(a);
    if (def.name === 'get') return toolGet(a);
    if (def.name === 'status') return toolStatus();
    return toolRefresh();
  }

  const METHODS = new Set(['initialize', 'ping', 'tools/list', 'tools/call']);

  function initialize(params) {
    const asked = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    const version = asked && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
    // Bind right after the reply has been written (SR-46: handshake first).
    setImmediate(() => { try { bindOnce(); } catch (_) { /* the reason shows in status */ } });
    return {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: env0.RULES_BLOCK,
    };
  }

  async function onRequest(method, params) {
    if (method === 'initialize') return initialize(params);
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: TOOL_DEFS };
    return callTool(params);
  }

  return {
    hasMethod: (m) => METHODS.has(m),
    onRequest,
    // Notifications (initialized, roots/list_changed and any other) change
    // nothing: the root is never re-bound (SR-3).
    onNotification: () => {},
    close: () => {
      if (s.store) s.store.close();
      if (s.dropped) { try { s.dropped.close(); } catch (_) { /* ignore */ } }
    },
    _state: s,
  };
}

// ---------------------------------------------------------------------------
// Terminal skip report (SR-33): path and rule id only, never file text.

async function skipReport({ env = process.env, cwd = process.cwd(), serverFile = __filename, out = process.stdout, seams = {} } = {}) {
  const platform = process.platform;
  const home = binder.homeDir();
  const print = (line) => out.write(line + '\n');
  const inst = binder.installMode({ env, serverFile, home, platform });
  if (inst.mode === 'none') { print('skip report: ' + inst.reason); return 1; }
  const options = inst.mode === 'plugin' ? optionsFromEnv(env) : optionsFromFile(inst.dataRoot).options;
  const root = binder.resolveRoot({ env, cwd, platform });
  if (root.refused) { print('skip report: ' + root.refused); return 1; }
  const refused = binder.refusedRoot(root.rootReal, {
    home, configDir: inst.configDir, pluginsDir: inst.pluginsDir, dataRoot: inst.dataRoot, tempDir: binder.tempDir(), platform,
  });
  if (refused) { print('skip report: ' + refused); return 1; }
  const filter = floor.buildFilter(options);
  const ig = ignoreMod.createIgnore(root.rootReal, { globalExcludes: seams.globalExcludes, ceiling: seams.gitCeiling || null });
  const counts = { listed: 0, failed: 0, kept: 0 };
  // SR-12: a path that holds a never-term is never printed, whatever rule it
  // was skipped under (a hidden file or a link can hold one too); it is only
  // counted per rule, and the counts come after the rows, so a row's place
  // in name order gives nothing away.
  const masked = {};
  const row = (tag, rel) => {
    if (floor.termHit(filter, rel)) { masked[tag] = (masked[tag] || 0) + 1; return; }
    print(tag + '\t' + rpc.asciiJson(rel));
  };
  const show = (rule, rel) => { counts.listed++; row(rule, rel); };
  const fail = (rel) => { counts.failed++; row('failed', rel); };
  const w = await walker.walk(root.rootReal, { filter, ignore: ig, hooks: { onSkip: (rel, rule, isDir) => show(rule, isDir ? rel + '/' : rel) } });
  for (const f of w.files) {
    try {
      const got = walker.readFile(f, { filter });
      if (got.rule) { show(got.rule, f.rel); continue; }
      if (got.fail) { fail(f.rel); continue; }
      const res = scan.scanFile({ relPath: f.rel, text: got.text, chunks: chunker.chunkText(f.rel, got.text), filter });
      if (res.fileRule) { show(res.fileRule, f.rel); continue; }
      counts.kept++;
    } catch (_) {
      fail(f.rel);
    }
  }
  for (const tag of Object.keys(masked).sort()) print(MASKED_TAG + '\t' + tag + '\t' + masked[tag]);
  print(`skip report: skipped ${counts.listed}, failed ${counts.failed + Object.values(w.failed).reduce((x, y) => x + y, 0)}, indexable ${counts.kept}`);
  return 0;
}

// ---------------------------------------------------------------------------
// Process entry

/** Exit code for a signal: 128 + its number (130 for SIGINT, 143 for SIGTERM). */
function signalExitCode(sig) {
  const n = os.constants && os.constants.signals ? os.constants.signals[sig] : undefined;
  return 128 + (Number.isInteger(n) ? n : 0);
}

/**
 * SIGTERM and SIGINT: release the lock now (rather than leave it for the 120 s
 * stale rule), then exit 128 + the signal number. Where the platform never
 * delivers a signal (Windows ends a process on SIGTERM without telling it),
 * the listener simply never runs and the stale rule still applies.
 */
function installSignalHandlers(server, proc = process) {
  for (const sig of SIGNALS) {
    try {
      proc.on(sig, () => {
        try { server.close(); } catch (_) { /* the exit still happens */ }
        proc.exit(signalExitCode(sig));
      });
    } catch (_) { /* this platform cannot listen for it */ }
  }
}

function main(seams = {}) {
  if (process.argv.includes('--skip-report')) {
    skipReport({ seams }).then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
    return null;
  }
  const errorOut = process.stderr;
  const diag = (name) => { try { errorOut.write('search-server: ' + name + '\n'); } catch (_) { /* ignore */ } };
  // Errors are reported by name only, never by message (SR-17).
  process.on('uncaughtException', (err) => diag(rpc.errName(err)));
  process.on('unhandledRejection', (err) => diag(rpc.errName(err)));
  const server = createServer({ seams });
  installSignalHandlers(server);
  rpc.serve({
    input: process.stdin,
    output: process.stdout,
    errorOut,
    hasMethod: server.hasMethod,
    onRequest: server.onRequest,
    onNotification: server.onNotification,
    onClose: () => {
      // The session ended: stop, releasing the lock if held (SR-49 e).
      try { server.close(); } catch (_) { /* ignore */ }
      process.exit(0);
    },
  });
  return server;
}

/** True when this file is the process entry (T-14 allows `require` only as a literal call). */
function isEntry() {
  const arg = process.argv[1];
  if (typeof arg !== 'string' || arg === '') return false;
  try {
    return fsx.samePath(fs.realpathSync.native(arg), fs.realpathSync.native(__filename));
  } catch (_) {
    return fsx.samePath(path.resolve(arg), __filename);
  }
}

if (isEntry()) main();

module.exports = {
  SERVER_VERSION,
  SERVER_NAME,
  NODE_MIN_MAJOR,
  ENV_PREFIX,
  OPTION_KEYS,
  PROTOCOL_VERSIONS,
  LINES,
  MASKED_TAG,
  SIGNALS,
  TOOL_DEFS,
  checkArgs,
  signalExitCode,
  installSignalHandlers,
  optionsFromEnv,
  optionsFromFile,
  launchChecks,
  createServer,
  skipReport,
  main,
};
