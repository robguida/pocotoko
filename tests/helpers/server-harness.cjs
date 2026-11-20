'use strict';
// Test helper for the search server tests: sandbox folders, copies of the
// server in a copy-by-hand kit folder or a sandbox plugins folder, a clean child
// environment, and a small MCP client over the child's stdio.
//
// Everything lives under sandbox/test-tmp/. The child never sees the real home,
// config folder or temp folder: HOME, USERPROFILE, TMP, TEMP, TMPDIR, the XDG
// folders and CLAUDE_CONFIG_DIR all point inside the run folder.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { REPO_TOP, makeTempDir, removeDir, writeFiles } = require('./tmpdir-sandbox.cjs');

const SERVER_SRC = path.join(REPO_TOP, 'src', 'search', 'server');
const LAUNCHER = path.join(__dirname, 'server-launch.cjs');
const runs = [];

/** A run folder with home/, tmp/, cfg/ and proj/ (proj holds `files`). */
function makeBase(name, files = {}) {
  const base = fs.realpathSync.native(makeTempDir('srv-' + name));
  const dirs = {};
  for (const d of ['home', 'tmp', 'cfg', 'proj']) {
    dirs[d] = path.join(base, d);
    fs.mkdirSync(dirs[d], { recursive: true });
  }
  writeFiles(dirs.proj, files);
  const run = { base, ...dirs };
  runs.push(run);
  return run;
}

function copyServer(destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const n of fs.readdirSync(SERVER_SRC)) {
    if (n.endsWith('.cjs')) fs.copyFileSync(path.join(SERVER_SRC, n), path.join(destDir, n));
  }
  return path.join(destDir, 'server.cjs');
}

/** Join a list option as one comma-separated line (a form the server may receive; the arrival form after substitution is not seen yet). */
function joinList(v) {
  return Array.isArray(v) ? v.join(',') : v;
}

/**
 * A server kit for the run.
 * mode 'copy': <base>/kit/search/server/ with options in <base>/kit/search/data/search-config.json.
 * mode 'plugin': <cfg>/plugins/cache/mkt/search/0.1.0/server/ with CLAUDE_PLUGIN_DATA and
 *   SEARCH_OPTION_* variables (lists comma-joined).
 */
function makeKit(run, { mode = 'copy', options = {}, writeConfig = true, cfg = run.cfg } = {}) {
  if (mode === 'plugin') {
    const serverFile = copyServer(path.join(cfg, 'plugins', 'cache', 'mkt', 'search', '0.1.0', 'server'));
    fs.mkdirSync(path.join(cfg, 'plugins', 'data'), { recursive: true });
    const dataRoot = path.join(cfg, 'plugins', 'data', 'search');
    const env = { CLAUDE_PLUGIN_DATA: dataRoot, CLAUDE_CONFIG_DIR: cfg };
    for (const [k, v] of Object.entries(options)) env['SEARCH_OPTION_' + k.toUpperCase()] = String(joinList(v));
    return { mode, serverFile, dataRoot, env };
  }
  const serverFile = copyServer(path.join(run.base, 'kit', 'search', 'server'));
  const dataRoot = path.join(run.base, 'kit', 'search', 'data');
  fs.mkdirSync(dataRoot, { recursive: true });
  if (writeConfig) fs.writeFileSync(path.join(dataRoot, 'search-config.json'), JSON.stringify(options));
  return { mode, serverFile, dataRoot, env: {} };
}

const DROP = /^(?:CLAUDE|ANTHROPIC|SEARCH_OPTION_|SEARCH_TEST_|XDG_|NODE_OPTIONS$|NODE_PATH$|NODE_TEST_CONTEXT$|NODE_DEBUG|HOME$|USERPROFILE$|HOMEDRIVE$|HOMEPATH$|TMP$|TEMP$|TMPDIR$|APPDATA$|LOCALAPPDATA$)/i;

/** A clean child environment pointed inside the run folder. */
function childEnv(run, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!DROP.test(k)) env[k] = v;
  Object.assign(env, {
    HOME: run.home,
    USERPROFILE: run.home,
    TMP: run.tmp,
    TEMP: run.tmp,
    TMPDIR: run.tmp,
    APPDATA: path.join(run.home, 'appdata'),
    LOCALAPPDATA: path.join(run.home, 'localappdata'),
    XDG_CONFIG_HOME: path.join(run.home, '.config'),
    XDG_DATA_HOME: path.join(run.home, '.local', 'share'),
    XDG_STATE_HOME: path.join(run.home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(run.home, '.cache'),
    CLAUDE_CONFIG_DIR: run.cfg,
  });
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) delete env[k];
    else env[k] = v;
  }
  return env;
}

class Client {
  constructor(child) {
    this.child = child;
    this.lines = [];
    this.badLines = [];
    this.messages = [];
    this.stderr = '';
    this.pending = new Map();
    this.nextId = 1;
    this.exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        this.lines.push(line);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (_) {
          this.badLines.push(line);
          continue;
        }
        this.messages.push(msg);
        if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(msg);
        } else if (msg && msg.id === null && this.waitNull) {
          const w = this.waitNull;
          this.waitNull = null;
          w(msg);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { this.stderr += d; });
    child.stdin.on('error', () => {});
  }

  raw(text) {
    this.child.stdin.write(text);
  }

  /** Wait for the next reply whose id is null (an error for a line with no usable id). */
  nextNullReply(timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for an error reply')), timeoutMs);
      this.waitNull = (m) => { clearTimeout(timer); resolve(m); };
    });
  }

  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('timeout: ' + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /** Several requests written in one write, so the server reads them together. */
  requestMany(list, timeoutMs = 30000) {
    const lines = [];
    const promises = list.map(([method, params]) => {
      const id = this.nextId++;
      lines.push(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout: ' + method)); }, timeoutMs);
        this.pending.set(id, { resolve, timer });
      });
    });
    this.child.stdin.write(lines.join('\n') + '\n');
    return Promise.all(promises);
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async initialize() {
    const r = await this.request('initialize', {
      protocolVersion: ['2025', '06', '18'].join('-'),
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1' },
    });
    this.notify('notifications/initialized', {});
    return r;
  }

  call(name, args) {
    return this.request('tools/call', { name, arguments: args });
  }

  async close() {
    try { this.child.stdin.end(); } catch (_) { /* gone */ }
    const t = setTimeout(() => { try { this.child.kill(); } catch (_) { /* gone */ } }, 10000);
    const code = await this.exited;
    clearTimeout(t);
    return code;
  }
}

/**
 * Start a server. With `direct`, the copied server.cjs itself is the entry (no
 * seams); otherwise the test launcher passes `seams` to main().
 */
function start({ serverFile, env, cwd, seams = {}, direct = false, execPath = process.execPath, args = [], nodeArgs = [] }) {
  const argv = [...nodeArgs, ...(direct ? [serverFile, ...args] : [LAUNCHER, serverFile, ...args])];
  const childEnvVars = { ...env };
  if (!direct) childEnvVars.SEARCH_TEST_SEAMS = JSON.stringify(seams);
  const child = spawn(execPath, argv, { cwd, env: childEnvVars, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  return new Client(child);
}

/** The text of a tools/call reply. */
function textOf(resp) {
  if (!resp || !resp.result || !Array.isArray(resp.result.content)) throw new Error('not a tool result: ' + JSON.stringify(resp && resp.error));
  return resp.result.content.map((c) => c.text).join('\n');
}

/** The JSON payload of a search, refresh or status reply (after the notice line, when there is one). */
function payloadOf(resp, notice) {
  const text = textOf(resp);
  const body = notice && text.startsWith(notice + '\n') ? text.slice(notice.length + 1) : text;
  return JSON.parse(body);
}

/** Every regular file under dir (links not followed): [{ rel, buf }] sorted. */
function listing(dir) {
  const out = [];
  const walk = (d, rel) => {
    let names = [];
    try { names = fs.readdirSync(d); } catch (_) { return; }
    for (const n of names.sort()) {
      const p = path.join(d, n);
      const r = rel ? rel + '/' + n : n;
      let st;
      try { st = fs.lstatSync(p); } catch (_) { continue; }
      if (st.isSymbolicLink()) { out.push({ rel: r, link: true }); continue; }
      if (st.isDirectory()) { out.push({ rel: r + '/', dir: true }); walk(p, r); } else if (st.isFile()) out.push({ rel: r, buf: fs.readFileSync(p) });
    }
  };
  walk(dir, '');
  return out;
}

function listingKey(dir) {
  return JSON.stringify(listing(dir).map((f) => [f.rel, f.buf ? f.buf.toString('base64') : (f.dir ? 'dir' : 'link')]));
}

function holds(dir, text) {
  const needle = Buffer.from(text, 'utf8');
  return listing(dir).some((f) => f.buf && f.buf.includes(needle));
}

function cleanup() {
  for (const r of runs.splice(0)) removeDir(r.base);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A run, a kit and a started, initialized server bound to <run>/proj, which is
 * on the projects list unless `noProjects`. Seams by default: the upward
 * `.git` search stops at the run folder (the tests sit inside this repo's own
 * work tree), and no global git excludes file.
 */
async function setup(name, files = {}, { mode = 'copy', options = {}, seams = {}, env = {}, cwd, noProjects = false, nodeArgs = [] } = {}) {
  const run = makeBase(name, files);
  const opts = noProjects ? { ...options } : { projects: [run.proj], ...options };
  const kit = makeKit(run, { mode, options: opts });
  const e = childEnv(run, { CLAUDE_PROJECT_DIR: run.proj, ...kit.env, ...env });
  const c = start({ serverFile: kit.serverFile, env: e, cwd: cwd || run.proj, nodeArgs, seams: { gitCeiling: run.base, globalExcludes: null, ...seams } });
  await c.initialize();
  return { run, kit, c, env: e };
}

async function status(c) {
  return payloadOf(await c.call('status', {}));
}

/** Poll status until the state is fresh (or off). */
async function waitFresh(c, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await status(c);
    if (s.state === 'fresh' || s.state === 'off') return s;
    if (Date.now() > end) throw new Error('not fresh: ' + s.state);
    await sleep(25);
  }
}

module.exports = {
  SERVER_SRC, LAUNCHER, makeBase, copyServer, makeKit, childEnv, joinList, start, textOf, payloadOf,
  listing, listingKey, holds, cleanup, writeFiles, Client, setup, status, waitFresh, sleep,
};
