// Plugin install proof (spec 12.1, 12.3, 13.4, 13.7, 14.6). Dev only, never shipped.
//
//   node scripts/sandbox.mjs --check [--claude-code <file> | --find-in <npm prefix>]
//       [--bash <file>] [--powershell <file>]
//   node scripts/sandbox.mjs --validate [--claude-code <file> | --find-in <npm prefix>]
//       Runs plugin validate --strict on src/core, src/search and the marketplace root,
//       each under the guard in a sandbox home (the CI validate step, 13.4).
//
// Under the shared guard, in sandbox homes with no login:
//   A. local folder: marketplace add of this repo -> install both plugins -> list
//      their parts -> the session-start hook says "source folder" (a local-folder
//      install is copy-by-hand mode, 6.7) -> uninstall -> marketplace remove.
//   B. git source: a git repo made in sandbox/ from the working tree, served on
//      127.0.0.1 -> marketplace add -> install both (plugin mode) -> list parts ->
//      spawn each hooks.json command with fixtures -> run the meter-statusline
//      skill's command forms in their shells -> MCP handshake and one search,
//      the server started the way .mcp.json says -> uninstall -> marketplace
//      remove -> assert nothing remains.
// With no Claude Code program the check prints SKIPPED with its reason; a skip
// never counts toward the release gate. The program can also be given in the
// KIT_CLAUDE_CODE environment variable. Close every Claude Code session first (13.7).

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as G from './lib/guard.mjs';
import * as D from './lib/dev-run.mjs';
import * as S from './lib/install-steps.mjs';
import { isMain } from './lib/is-main.mjs';

const REPO = G.kitRoot();
const MKT = 'pocotoko';
const CORE = 'pocotoko';
const SEARCH = 'pocotoko-search';
const DOLLAR = '$';

// Facts this no-login check does not reach (spec 16 B9; changelog held list). Listed, never faked.
export const HELD = Object.freeze([
  ['Still open for the search server, not done by this no-login check yet: Claude Code itself starting the real search server; a never-set option with no default, or with a boolean or number default (drop_contacts, max_file_bytes), named in .mcp.json env (does it block, and what text arrives); a list set through the interactive /plugin configure form; a --values-stdin call naming only some keys (are the others kept); a plugin cache really moved with CLAUDE_CODE_PLUGIN_CACHE_DIR', 'needs a machine without an organisation-managed MCP file (there a no-login claude mcp list launches plugin servers); the interactive /plugin configure form needs an interactive session'],
  ['Claude Code itself firing the installed hooks, and whether a project settings env reaches them (6.11 h)', 'needs a logged-in session'],
  ['The <owner>/<repo>#v<version> install form', 'needs the host repo'],
]);

export function parseArgs(argv) {
  const o = { check: false, validate: false, claudeCode: null, findIn: null, bash: null, powershell: null, problems: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) o.problems.push(a + ' needs a value'); return v; };
    if (a === '--check') o.check = true;
    else if (a === '--validate') o.validate = true;
    else if (a === '--claude-code') o.claudeCode = val();
    else if (a === '--find-in') o.findIn = val();
    else if (a === '--bash') o.bash = val();
    else if (a === '--powershell') o.powershell = val();
    else o.problems.push('unknown argument ' + JSON.stringify(a));
  }
  if (o.check === o.validate) o.problems.push('give exactly one of --check or --validate');
  return o;
}

/** The lines printed when no Claude Code program is found (tested; 13.4: a skip never counts as a pass). */
export function skippedLines(reason) {
  return [
    'SKIPPED sandbox --check: ' + reason,
    'sandbox --check: succeeded 0, failed 0, skipped 1 (a skip never counts toward the release gate)',
  ];
}

// ---------------------------------------------------------------------------

class Report {
  constructor() { this.rows = []; }
  add(part, id, status, reason = '') { this.rows.push({ part, id, status, reason }); return status === 'done'; }
  ok(part, id, cond, reason = '') { return this.add(part, id, cond ? 'done' : 'failed', reason); }
}

function cliStep(rep, part, label, cli, args, { env, cwd, must = false }) {
  const problems = G.preflight({ env, repo: REPO });
  if (problems.length) { rep.add(part, label, 'failed', 'guard refused: ' + problems.join('; ')); return null; }
  const r = D.runCli(cli, args, { env, cwd });
  if (r.refused) { rep.add(part, label, 'failed', 'cmd.exe route refused: ' + r.refused); return null; }
  rep.calls = (rep.calls || 0) + 1;
  const s = cliStatus(r);
  rep.add(part, label, s.status, s.reason);
  return r;
}

/** A CLI call's row: held only on the one known refusal text; anything else that fails is a failure. */
export function cliStatus(r) {
  const out = String((r && r.out) || '');
  if (r && r.status === 0) return { status: 'done', reason: 'exit 0' };
  if (out.includes(S.MANAGED_MCP_TEXT)) return { status: 'held', reason: 'organisation-managed MCP configuration' };
  return { status: 'failed', reason: 'exit ' + (r ? r.status : '?') + ' | ' + D.short(out) };
}

function listJson(rep, part, cli, env, cwd) {
  const r = cliStep(rep, part, 'plugin list --json', cli, ['plugin', 'list', '--json'], { env, cwd });
  if (!r || r.status !== 0) return [];
  try {
    const t = r.out.slice(r.out.indexOf('['), r.out.lastIndexOf(']') + 1);
    return JSON.parse(t);
  } catch (_) { return []; }
}

/** A path for the report: relative to the repo or the run folder, never this machine's home. */
function where(p, run) {
  const r = path.resolve(String(p));
  if (G.isInside(r, run.dir)) return '<run>/' + S.slash(path.relative(run.dir, r));
  if (G.isInside(r, REPO)) return '<REPO>/' + S.slash(path.relative(REPO, r));
  return 'outside the repo';
}

function kitEntries(list) {
  return list.filter((p) => typeof p.id === 'string' && /^pocotoko(?:-search)?@pocotoko$/.test(p.id));
}

/** What the CLI's details command says about a plugin's parts (counts only). */
export function partsOf(out) {
  const want = {};
  for (const k of ['skills', 'hooks', 'MCP servers', 'agents']) {
    const m = new RegExp('\\b' + k + '\\b[^0-9\\n]{0,40}([0-9]+)', 'i').exec(out) || new RegExp('([0-9]+)[^0-9\\n]{0,10}\\b' + k + '\\b', 'i').exec(out);
    if (m) want[k] = Number(m[1]);
  }
  return want;
}

/** Every wanted part is listed, with exactly the wanted count (a missing key fails). */
export function partsMatch(out, want) {
  const got = partsOf(out);
  return Object.entries(want).every(([k, n]) => got[k] === n);
}

function hookCommands(pluginRoot) {
  const j = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
  const out = [];
  for (const [ev, groups] of Object.entries(j.hooks)) {
    for (const g of groups) for (const h of g.hooks) out.push({ ev, ...h });
  }
  return out;
}

/** command "node" runs from PATH in plugin mode (6.10 a row 1); here the Node running the check stands in. */
function substitute(h, pluginRoot) {
  const sub = (s) => String(s).split(DOLLAR + '{CLAUDE_PLUGIN_ROOT}').join(S.slash(pluginRoot));
  return { command: h.command === 'node' ? process.execPath : sub(h.command), args: (h.args || []).map(sub) };
}

/** The two status line forms the meter-statusline skill shows (6.12 b), filled in. */
function skillStatusForms(pluginRoot, node, dataDir) {
  const t = fs.readFileSync(path.join(pluginRoot, 'skills', 'meter-statusline', 'SKILL.md'), 'utf8');
  const forms = [...t.matchAll(/"command": "((?:\\.|[^"\\])*)"/g)].map((m) => JSON.parse('"' + m[1] + '"'));
  // Both paths sit in single quotes (6.12 b); a quote inside a value is written as the skill says for that shell.
  const fill = (s, shell) => s.split('<NODE>').join(S.quoteValue(S.slash(node), shell)).split(DOLLAR + '{CLAUDE_PLUGIN_DATA}').join(S.quoteValue(S.slash(dataDir), shell));
  return { bash: forms.find((f) => f.startsWith("'")), powershell: forms.find((f) => f.startsWith('& ')), fill };
}

// ---------------------------------------------------------------------------
// MCP client (stdio, one JSON message per line)

function mcpSession(command, args, { env, cwd, timeoutMs = 30000 }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const pending = new Map();
    let buf = '';
    let nextId = 1;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.t); p.resolve(msg); }
      }
    });
    child.stdin.on('error', () => {});
    const call = (method, params) => new Promise((res) => {
      const id = nextId++;
      const t = setTimeout(() => { pending.delete(id); res({ timeout: true }); }, timeoutMs);
      pending.set(id, { resolve: res, t });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    const close = () => new Promise((res) => { child.on('exit', (code) => res(code)); try { child.stdin.end(); } catch (_) { /* ignore */ } setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } }, 3000); });
    child.on('error', () => resolve({ error: 'spawn failed' }));
    child.on('spawn', () => resolve({ call, notify, close }));
  });
}

function toolText(msg) {
  try { return msg.result.content.map((c) => c.text).join('\n'); } catch (_) { return ''; }
}
function toolJson(msg) {
  const t = toolText(msg);
  try { return JSON.parse(t); } catch (_) { /* fall through */ }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  try { return a >= 0 ? JSON.parse(t.slice(a, b + 1)) : null; } catch (_) { return null; }
}

async function handshake(rep, part, label, command, args, { env, cwd, query }) {
  const s = await mcpSession(command, args, { env, cwd });
  if (s.error) { rep.add(part, label + ': start', 'failed', s.error); return null; }
  const pv = [2025, 6, 18].map((n, i) => (i ? String(n).padStart(2, '0') : String(n))).join('-');
  const init = await s.call('initialize', { protocolVersion: pv, capabilities: {}, clientInfo: { name: 'install-proof', version: '0' } });
  rep.ok(part, label + ': initialize', init.result && init.result.serverInfo && init.result.serverInfo.name === 'search', init.result ? 'server ' + (init.result.serverInfo || {}).name : D.short(JSON.stringify(init)));
  s.notify('notifications/initialized', {});
  const tl = await s.call('tools/list', {});
  const names = ((tl.result || {}).tools || []).map((t) => t.name).sort();
  rep.ok(part, label + ': tools/list', names.join(',') === 'get,refresh,search,status', names.join(','));
  const st = await s.call('tools/call', { name: 'status', arguments: {} });
  const sj = toolJson(st) || {};
  rep.add(part, label + ': status', st.result ? 'done' : 'failed', 'install mode ' + (sj.install_mode || '?') + ', state ' + (sj.state || '?') + (sj.reason ? ', reason: ' + D.short(sj.reason, 120) : ''));
  await s.call('tools/call', { name: 'refresh', arguments: {} });
  let sr = null;
  for (let i = 0; i < 20; i++) {
    sr = await s.call('tools/call', { name: 'search', arguments: { query } });
    const j = toolJson(sr) || {};
    if (j.state !== 'building' && j.state !== 'stale') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const sj2 = toolJson(sr) || {};
  await s.close();
  return { status: sj, search: sj2, raw: toolText(sr) };
}

// ---------------------------------------------------------------------------

/** git by its absolute path (found once, 13.6), with fixed arguments and no shell. */
function gitRun(git, args, { env, cwd }) {
  return spawnSync(git, args, { env, cwd, encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * A git repo in sandbox/ holding the working tree's files (tracked and new, not ignored), served on 127.0.0.1.
 * The env is a guard child env (every git variable from outside dropped, 13.7); the repo-making calls also
 * name their own git folder and work tree, and stop git's search at the run folder, so none can reach this repo.
 */
export async function gitSource(rep, run, env) {
  const git = D.findGit(env);
  if (!git) { rep.add('B', 'git source: find git', 'failed', 'git not found on PATH'); return null; }
  const work = path.join(run.dir, 'git-work');
  const served = path.join(run.dir, 'git-served');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(served, { recursive: true });
  const ls = gitRun(git, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { env, cwd: REPO });
  if (ls.status !== 0) { rep.add('B', 'git source: list the working tree', 'failed', 'git exited ' + ls.status); return null; }
  let copied = 0;
  let missing = 0;
  for (const rel of ls.stdout.split('\0').filter(Boolean)) {
    const from = path.join(REPO, ...rel.split('/'));
    try {
      if (!fs.lstatSync(from).isFile()) { missing++; continue; }
    } catch (_) { missing++; continue; }
    const to = path.join(work, ...rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied++;
  }
  const who = { GIT_AUTHOR_NAME: 'install proof', GIT_COMMITTER_NAME: 'install proof', GIT_AUTHOR_EMAIL: ['proof', 'example.invalid'].join('@'), GIT_COMMITTER_EMAIL: ['proof', 'example.invalid'].join('@') };
  const genv = { ...env, ...who, GIT_CEILING_DIRECTORIES: run.dir };
  const init = gitRun(git, ['init', '-q', '-b', 'main', work], { env: genv, cwd: run.dir });
  if (init.status !== 0) { rep.add('B', 'git source: git init', 'failed', D.short(init.stderr)); return null; }
  const own = ['--git-dir', path.join(work, '.git'), '--work-tree', work];
  for (const args of [['add', '-A'], ['commit', '-q', '-m', 'install proof']]) {
    const r = gitRun(git, [...own, ...args], { env: genv, cwd: work });
    if (r.status !== 0) { rep.add('B', 'git source: git ' + args[0], 'failed', D.short(r.stderr)); return null; }
  }
  const bare = gitRun(git, ['clone', '-q', '--bare', work, path.join(served, 'kit.git')], { env: genv, cwd: run.dir });
  if (bare.status !== 0) { rep.add('B', 'git source: bare clone', 'failed', D.short(bare.stderr)); return null; }
  rep.add('B', 'git source: sandbox repo from the working tree', 'done', copied + ' files copied, ' + missing + ' listed but not present');
  // The server exits when its stdin closes (this process ends) or after an idle time.
  const server = spawn(process.execPath, [path.join(REPO, 'scripts', 'lib', 'git-http.mjs'), served, git], { env, cwd: run.dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const port = await new Promise((resolve) => {
    let b = '';
    const t = setTimeout(() => resolve(null), 15000);
    server.stdout.on('data', (c) => { b += c; const m = /PORT (\d+)/.exec(b); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    server.on('exit', () => { clearTimeout(t); resolve(null); });
  });
  if (!port) { rep.add('B', 'git source: loopback server', 'failed', 'did not start'); try { server.kill(); } catch (_) { /* ignore */ } return null; }
  const url = 'http://127.0.0.1:' + port + '/kit.git';
  const probe = gitRun(git, ['ls-remote', url], { env: genv, cwd: run.dir });
  rep.ok('B', 'git source: loopback server answers git', probe.status === 0, 'plain http on 127.0.0.1');
  return { url, stop: () => { try { server.stdin.end(); } catch (_) { /* ignore */ } try { server.kill(); } catch (_) { /* ignore */ } } };
}

function kitResidue(run) {
  const left = [];
  const cfg = run.L.config;
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; } };
  for (const f of ['settings.json', path.join('plugins', 'installed_plugins.json'), path.join('plugins', 'known_marketplaces.json')]) {
    if (/pocotoko/.test(read(path.join(cfg, f)))) left.push(S.slash(f) + ' names the kit');
  }
  const pluginsDir = path.join(cfg, 'plugins');
  for (const d of [path.join('data', CORE + '-' + MKT), path.join('data', SEARCH + '-' + MKT), path.join('marketplaces', MKT)]) {
    if (fs.existsSync(path.join(pluginsDir, d))) left.push('plugins/' + S.slash(d) + ' still there');
  }
  // Old version folders in the cache stay with an .orphaned_at marker: Claude Code's housekeeping (day-one check 19).
  const cache = path.join(pluginsDir, 'cache', MKT);
  let orphaned = 0;
  if (fs.existsSync(cache)) {
    for (const p of fs.readdirSync(cache)) {
      for (const v of fs.readdirSync(path.join(cache, p))) {
        if (fs.existsSync(path.join(cache, p, v, '.orphaned_at'))) orphaned++;
        else left.push('plugins/cache/' + MKT + '/' + p + '/' + v + ' has no .orphaned_at marker');
      }
    }
  }
  return { left, orphaned };
}

function uninstallAll(rep, part, cli, env, cwd) {
  cliStep(rep, part, 'plugin uninstall ' + SEARCH + '@' + MKT, cli, ['plugin', 'uninstall', SEARCH + '@' + MKT], { env, cwd, must: true });
  cliStep(rep, part, 'plugin uninstall ' + CORE + '@' + MKT, cli, ['plugin', 'uninstall', CORE + '@' + MKT], { env, cwd, must: true });
  cliStep(rep, part, 'plugin marketplace remove ' + MKT, cli, ['plugin', 'marketplace', 'remove', MKT], { env, cwd, must: true });
}

function installBoth(rep, part, cli, source, env, cwd) {
  const a = cliStep(rep, part, 'plugin marketplace add (' + (part === 'A' ? 'this repo folder' : 'loopback git URL') + ')', cli, ['plugin', 'marketplace', 'add', source], { env, cwd, must: true });
  if (!a || a.status !== 0) return false;
  const b = cliStep(rep, part, 'plugin install ' + CORE + '@' + MKT, cli, ['plugin', 'install', CORE + '@' + MKT], { env, cwd, must: true });
  const c = cliStep(rep, part, 'plugin install ' + SEARCH + '@' + MKT, cli, ['plugin', 'install', SEARCH + '@' + MKT], { env, cwd, must: true });
  return !!(b && c && b.status === 0 && c.status === 0);
}

function listParts(rep, part, cli, env, cwd) {
  for (const [name, want] of [[CORE, { skills: 3, hooks: 2, 'MCP servers': 0 }], [SEARCH, { skills: 0, hooks: 0, 'MCP servers': 1 }]]) {
    const r = cliStep(rep, part, 'plugin details ' + name + '@' + MKT, cli, ['plugin', 'details', name + '@' + MKT], { env, cwd });
    if (!r || r.status !== 0) continue;
    rep.ok(part, 'parts of ' + name, partsMatch(r.out, want), Object.entries(partsOf(r.out)).map(([k, n]) => k + ' ' + n).join(', '));
  }
}

async function partA(rep, cli) {
  const run = D.makeRun('install-proof', 'local-folder');
  const env = D.runEnv(run);
  const srcBefore = S.snapshot(path.join(REPO, 'src'), { configRel: '-' });
  if (installBoth(rep, 'A', cli, REPO, env, run.project)) {
    const list = kitEntries(listJson(rep, 'A', cli, env, run.project));
    const core = list.find((p) => p.id === CORE + '@' + MKT);
    // Recorded, not judged: the CLI lists a version copy in the plugin cache as installPath, while
    // the logged-in probe saw hooks run with CLAUDE_PLUGIN_ROOT = the source folder (check 1).
    rep.add('A', 'installPath the CLI lists for a local-folder install', core ? 'done' : 'failed', core ? where(core.installPath, run) : 'not listed');
    listParts(rep, 'A', cli, env, run.project);
    const coreSrc = path.join(REPO, 'src', 'core');
    const dataDir = path.join(run.L.pluginCache, 'data', CORE + '-' + MKT);
    const fireFrom = (root) => {
      const h = hookCommands(root).find((x) => x.ev === 'SessionStart');
      const { command, args } = substitute(h, root);
      const r = D.fireExec(command, args, { env: { ...env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_PROJECT_DIR: run.project }, cwd: run.project, input: D.sessionStartInput(run.project, path.join(run.project, 't.jsonl')) });
      return { r, j: D.parseHookJson(r.stdout) || {} };
    };
    const a = fireFrom(coreSrc);
    rep.ok('A', 'SessionStart hook run from the source folder (where the logged-in probe saw it run) gives the source-folder line', a.r.status === 0 && /source folder/.test(a.j.systemMessage || ''), 'exit ' + a.r.status + '; nothing written');
    if (core && !G.samePath(path.resolve(core.installPath), coreSrc)) {
      const b = fireFrom(core.installPath);
      rep.ok('A', 'the same hook run from the listed cache copy is plugin mode and still writes nothing here', b.r.status === 0 && /inside a git repo/.test(b.j.systemMessage || ''), 'exit ' + b.r.status + '; git-work-tree line');
    }
  }
  uninstallAll(rep, 'A', cli, env, run.project);
  const res = kitResidue(run);
  rep.ok('A', 'nothing remains', res.left.length === 0, res.left.join('; '));
  rep.ok('A', 'the source folder is unchanged', S.diffSnapshots(srcBefore, S.snapshot(path.join(REPO, 'src'), { configRel: '-' })).length === 0);
  D.removeRun(run, !rep.rows.some((r) => r.part === 'A' && r.status === 'failed'));
}

async function partB(rep, cli, shells) {
  const run = D.makeRun('install-proof', 'git-source');
  const env = D.runEnv(run);
  const src = await gitSource(rep, run, env);
  if (!src) return;
  try {
    if (!installBoth(rep, 'B', cli, src.url, env, run.project)) return;
    const list = kitEntries(listJson(rep, 'B', cli, env, run.project));
    const core = list.find((p) => p.id === CORE + '@' + MKT);
    const search = list.find((p) => p.id === SEARCH + '@' + MKT);
    const pluginsDir = run.L.pluginCache;
    const inCache = (p) => p && G.isInside(path.resolve(p.installPath), pluginsDir);
    rep.ok('B', 'git-source install runs from the plugin cache (plugin mode, 6.7)', inCache(core) && inCache(search), core ? 'both installPaths inside the plugins folder' : 'not listed');
    listParts(rep, 'B', cli, env, run.project);
    if (!core || !search) return;
    const coreData = path.join(pluginsDir, 'data', CORE + '-' + MKT);
    const searchData = path.join(pluginsDir, 'data', SEARCH + '-' + MKT);
    // Claude Code makes each data folder before the plugin's first launch (live check 1); no session runs here, so the check does.
    for (const d of [coreData, searchData]) fs.mkdirSync(d, { recursive: true });
    const transcript = path.join(run.project, 'transcript.jsonl');
    D.writeTranscript(transcript, 160000);
    const hookEnv = { ...env, CLAUDE_PLUGIN_ROOT: core.installPath, CLAUDE_PLUGIN_DATA: coreData, CLAUDE_PROJECT_DIR: run.project };
    const hooks = hookCommands(core.installPath);
    rep.ok('B', 'hooks.json has the two events', hooks.map((h) => h.ev).sort().join(',') === 'SessionStart,UserPromptSubmit');
    for (const h of hooks) {
      const { command, args } = substitute(h, core.installPath);
      const input = h.ev === 'SessionStart' ? D.sessionStartInput(run.project, transcript) : D.promptInput(run.project, transcript);
      // As Claude Code would start it. The data folder is inside this repo's git work tree, so the core writes nothing (6.7).
      const r = D.fireExec(command, args, { env: hookEnv, cwd: run.project, input });
      const j = D.parseHookJson(r.stdout);
      const ok = h.ev === 'SessionStart' ? r.status === 0 && j && /inside a git repo/.test(j.systemMessage || '') : r.status === 0 && j === null;
      rep.ok('B', 'spawn ' + h.ev + ' command (' + h.command + ', exec form)', ok, 'exit ' + r.status + (h.ev === 'SessionStart' ? ', plugin mode reached; git-work-tree line' : ', no output (git work tree)'));
      // The same command through the test launcher with a git ceiling: plugin mode writes (sync, hand-off, state).
      const s = D.fireWithCeiling(args[0], args.slice(1), run.dir, { env: hookEnv, cwd: run.project, input });
      const sj = D.parseHookJson(s.stdout) || {};
      const text = JSON.stringify(sj);
      const okS = h.ev === 'SessionStart'
        ? s.status === 0 && text.includes('Node program for the status line command: ') && text.includes('Hand-off folder for this session: ')
        : s.status === 0 && /new session/i.test(text);
      rep.ok('B', 'seam ' + h.ev + ' (git ceiling at the run folder)', okS, h.ev === 'SessionStart' ? 'Node line and hand-off folder line; status line copy ' + (fs.existsSync(path.join(coreData, 'statusline', 'meter.cjs')) ? 'made' : 'missing') : 'hard-tier warning');
    }
    // SR-C5 sandbox half: the meter-statusline skill's command forms, filled as the skill says, each in its shell.
    const forms = skillStatusForms(core.installPath, process.execPath, coreData);
    for (const shell of ['bash', 'powershell']) {
      if (!shells[shell]) { rep.add('B', 'status line form (' + shell + ')', 'skipped', shells.why[shell]); continue; }
      const cmd = forms.fill(forms[shell], shell);
      const r = D.runShellCommand(shell, shells[shell], cmd, { env: { ...env, NO_COLOR: '1' }, cwd: run.project, input: D.statusInput(50000) });
      const line = String(r.stdout || '').replace(/\r/g, '').trim();
      rep.ok('B', 'status line form (' + shell + ') from the skill, run in ' + shell, r.status === 0 && line === 'chat 50k (warn 100k/150k)', JSON.stringify(D.short(line || r.stderr, 80)));
    }
    // MCP: start the server the way .mcp.json says (command node, args under the plugin root, env).
    const mcp = JSON.parse(fs.readFileSync(path.join(search.installPath, '.mcp.json'), 'utf8')).mcpServers[SEARCH];
    const sub = (s) => String(s).split(DOLLAR + '{CLAUDE_PLUGIN_ROOT}').join(S.slash(search.installPath));
    fs.writeFileSync(path.join(run.project, 'notes.md'), '# Fixture note\n\nThe loopback lighthouse keeps the harbour lamp lit.\n');
    const mcpEnv = { ...env, CLAUDE_PLUGIN_ROOT: search.installPath, CLAUDE_PLUGIN_DATA: searchData, CLAUDE_PROJECT_DIR: run.project };
    for (const [k, v] of Object.entries(mcp.env || {})) {
      // A direct spawn, not Claude Code's own launch (HELD row 1): projects is given as one path, the rest unset; it proves the launch shape only (the arrival form seen for stub servers: changelog, third logged-in run).
      mcpEnv[k] = /user_config\.projects\}/.test(v) ? run.project : '';
    }
    const command = mcp.command === 'node' ? process.execPath : sub(mcp.command);
    const args = (mcp.args || []).map(sub);
    rep.ok('B', '.mcp.json launch shape', mcp.command === 'node' && args.length === 1 && args[0].endsWith('/server/server.cjs'), 'command ' + mcp.command + ', one script argument');
    const plain = await handshake(rep, 'B', 'MCP as .mcp.json says', command, args, { env: mcpEnv, cwd: run.project, query: 'lighthouse' });
    // The data folder is inside this repo's git work tree, so search must refuse to store anything there (SR-21).
    if (plain) rep.ok('B', 'search (plain launch) is off with the git-work-tree reason', plain.search.state === 'off' && /inside a git repo/.test(plain.search.reason || ''), 'state ' + (plain.search.state || '?'));
    const launcher = path.join(REPO, 'tests', 'helpers', 'server-launch.cjs');
    const seam = await handshake(rep, 'B', 'MCP through the test launcher (git ceiling)', process.execPath, [launcher, args[0]], { env: { ...mcpEnv, SEARCH_TEST_SEAMS: JSON.stringify({ gitCeiling: run.dir }) }, cwd: run.project, query: 'lighthouse' });
    if (seam) {
      const hits = Array.isArray(seam.search.results) ? seam.search.results : [];
      rep.ok('B', 'one search finds the fixture note', hits.some((h) => /notes\.md$/.test(h.file || '')), 'state ' + (seam.search.state || '?') + ', ' + hits.length + ' result(s)');
    }
    for (const [id, why] of HELD) rep.add('B', id, 'held', why);
  } finally {
    uninstallAll(rep, 'B', cli, env, run.project);
    src.stop();
    const res = kitResidue(run);
    rep.ok('B', 'nothing remains (old version folders keep their .orphaned_at marker: Claude Code housekeeping)', res.left.length === 0, res.left.join('; ') || res.orphaned + ' marked version folder(s)');
  }
  D.removeRun(run, !rep.rows.some((r) => r.part === 'B' && r.status === 'failed'));
}

/** The named program, checked under the guard: { cli } | { skip } | { fail } (13.4: a named program that is missing or will not start fails). */
async function program(opts) {
  const run = D.makeRun('install-proof', 'program');
  const env = D.runEnv(run);
  const g = await G.guardedRun({ env, repo: REPO, step: async () => D.resolveCli({ file: opts.claudeCode || process.env.KIT_CLAUDE_CODE || null, findIn: opts.findIn }, { env, cwd: run.project }) });
  D.removeRun(run);
  if (g.refused) return { fail: g.problems.join('; ') };
  if (g.changed.length) return { fail: G.describeChanges(g.changed) };
  return g.result;
}

/** The lines printed when a named program is missing or will not start (exit 1). */
export function failedLines(what, reason) {
  return ['FAILED ' + what + ': ' + reason, what + ': succeeded 0, failed 1, skipped 0 (a named program must be found and start)'];
}

async function check(opts) {
  const p = await program(opts);
  if (p.fail) { for (const l of failedLines('sandbox --check', p.fail)) console.log(l); return 1; }
  if (p.skip) { for (const l of skippedLines(p.skip)) console.log(l); return 0; }
  const cli = p.cli;
  const shells = D.findShells({ bash: opts.bash, powershell: opts.powershell });
  const rep = new Report();
  const guardRun = D.makeRun('install-proof', 'guard');
  const guard = await G.guardedRun({
    env: D.runEnv(guardRun),
    repo: REPO,
    step: async () => {
      for (const [name, fn] of [['A', () => partA(rep, cli)], ['B', () => partB(rep, cli, shells)]]) {
        try { await fn(); } catch (err) { rep.add(name, 'part ' + name, 'failed', (err && err.message) || String(err)); }
      }
    },
  });
  D.removeRun(guardRun);
  if (guard.refused) { console.log('sandbox --check: ' + guard.problems.join('; ')); return 1; }
  const hide = (s) => String(s || '').split(S.slash(REPO)).join('<REPO>').split(REPO).join('<REPO>').split(S.slash(process.execPath)).join('<NODE>');
  for (const r of rep.rows) console.log('  ' + r.status.padEnd(7) + ' ' + r.part + ' ' + r.id + (r.reason ? ' - ' + hide(r.reason) : ''));
  console.log(G.describeChanges(guard.changed));
  const n = (s) => rep.rows.filter((r) => r.status === s).length;
  const failed = n('failed') + (guard.changed.length ? 1 : 0) + (guard.error ? 1 : 0);
  console.log('sandbox --check: succeeded ' + n('done') + ', failed ' + failed + ', skipped ' + (n('skipped') + n('held')) + ' (held ' + n('held') + '; Claude Code CLI calls: ' + (rep.calls || 0) + ')');
  return failed ? 1 : 0;
}

async function validate(opts) {
  const p = await program(opts);
  if (p.fail) { for (const l of failedLines('validate --strict', p.fail)) console.log(l); return 1; }
  if (p.skip) { console.log('SKIPPED plugin validate --strict: ' + p.skip); console.log('validate --strict: succeeded 0, failed 0, skipped 1 (a skip never counts toward the release gate)'); return 0; }
  const cli = p.cli;
  const run = D.makeRun('install-proof', 'validate');
  const env = D.runEnv(run);
  let ok = 0;
  let bad = 0;
  for (const [label, target] of [['src/core', path.join(REPO, 'src', 'core')], ['src/search', path.join(REPO, 'src', 'search')], ['marketplace root', REPO]]) {
    const g = await G.guardedRun({ env, repo: REPO, step: async () => D.runCli(cli, ['plugin', 'validate', '--strict', target], { env, cwd: run.project }) });
    const r = g.result || {};
    const pass = !g.refused && !g.changed.length && r.status === 0;
    console.log(label + ': exit ' + r.status + (g.refused ? ' | guard refused' : '') + (g.changed.length ? ' | ' + G.describeChanges(g.changed) : '') + (pass ? '' : ' | ' + D.short(r.out, 300)));
    if (pass) ok++; else bad++;
  }
  D.removeRun(run, bad === 0);
  console.log('validate --strict: succeeded ' + ok + ', failed ' + bad + ', skipped 0');
  return bad ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.problems.length) { console.log('sandbox: ' + opts.problems.join('; ')); return 2; }
  try {
    return opts.validate ? await validate(opts) : await check(opts);
  } catch (err) {
    console.log('sandbox: ' + ((err && err.message) || String(err)));
    return 1;
  }
}

if (isMain(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
