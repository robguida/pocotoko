// Shared parts of the two install checks (spec 13.6, 13.7, 14.6). Dev only, never shipped.
//
// Finding the shells and the Claude Code program, starting them without a
// shell of their own (13.6), sandbox run folders, the stand-in `claude`
// command the rendered blocks call, and the hook and status line fixtures.
// Every child gets a sandbox environment from the shared guard module.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as G from './guard.mjs';

export const REPO = G.kitRoot();

// Variables never passed to a child: logins, API keys, cloud credentials,
// Claude Code's own settings, CI tokens, Node preload options, every git
// variable (one set by a git hook, such as GIT_DIR or GIT_INDEX_FILE, would
// point a sandbox git call at the real repo; the guard sets its own), shell
// start files, the SSH agent, and anything named like a credential.
const DROP = /^(?:ANTHROPIC|CLAUDE|AWS_|AZURE_|GOOGLE_|GCLOUD|CLOUDSDK|VERTEX|BEDROCK|OPENAI|GH_|GITHUB_|GIT_|ACTIONS_|NPM_TOKEN$|NODE_AUTH_TOKEN$|NODE_OPTIONS$|NODE_PATH$|NODE_TEST_CONTEXT$|NODE_DEBUG|NO_COLOR$|BASH_ENV$|ENV$|SSH_AUTH_SOCK$|SSH_AGENT_PID$)/i;
const CREDENTIAL = /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_KEY$)/i;

export function cleanBaseEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!DROP.test(k) && !CREDENTIAL.test(k)) out[k] = v;
  return out;
}

/**
 * The git program's absolute path, found once on PATH (absolute PATH entries only),
 * so no bare-name lookup ever starts from a sandbox folder (13.6). Null when not found.
 */
export function findGit(env = process.env) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  const names = process.platform === 'win32' ? ['git.exe'] : ['git'];
  for (const dir of String((key && env[key]) || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      try { if (fs.statSync(p).isFile()) return p; } catch (_) { /* next */ }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Run folders

/**
 * A fresh run folder under sandbox/<group>/ with the guard layout. Windows
 * application-data folders point outside the home (still under sandbox/), so
 * the shells' and the CLI's own caches never touch the home being compared.
 */
export function makeRun(group, name) {
  const stamp = Date.now().toString(36) + '-' + process.pid;
  const dir = path.join(G.sandboxDir(REPO), group, stamp + '-' + name);
  const L = G.sandboxLayout(dir);
  const appData = path.join(dir, 'appdata', 'Roaming');
  const localAppData = path.join(dir, 'appdata', 'Local');
  const project = path.join(dir, 'project');
  // A Windows home has these two folders; PowerShell makes them when they are missing.
  for (const d of [path.join(L.home, 'AppData', 'Roaming'), path.join(L.home, 'AppData', 'Local')]) fs.mkdirSync(d, { recursive: true });
  for (const d of [L.home, L.config, L.xdgConfig, L.tmp, L.xdgData, L.xdgState, L.xdgCache, path.dirname(L.gitConfig), appData, localAppData, project]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(L.gitConfig, '');
  return { dir, L: { ...L, appData, localAppData }, project };
}

/** The child environment for a run: guard variables in the run, nothing from the login. */
export function runEnv(run, extra = {}) {
  const env = G.sandboxEnv(cleanBaseEnv(), run.dir);
  env.APPDATA = run.L.appData;
  env.LOCALAPPDATA = run.L.localAppData;
  env.DISABLE_AUTOUPDATER = '1';
  env.DISABLE_TELEMETRY = '1';
  env.DISABLE_ERROR_REPORTING = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  Object.assign(env, extra);
  const problems = G.preflight({ env, repo: REPO });
  if (problems.length) throw new G.GuardRefusal(problems);
  return env;
}

// ---------------------------------------------------------------------------
// Shells (12.2 c)

function firstFile(list) {
  for (const p of list) {
    try { if (p && fs.statSync(p).isFile()) return p; } catch (_) { /* next */ }
  }
  return null;
}

/** { bash, powershell } program paths, or null with a reason in why. */
export function findShells({ bash, powershell } = {}, platform = process.platform) {
  const why = {};
  let b = bash || null;
  let p = powershell || null;
  if (!b) {
    if (platform === 'win32') {
      const roots = [process.env.ProgramFiles, process.env.ProgramW6432, process.env['ProgramFiles(x86)']].filter(Boolean);
      b = firstFile(roots.map((r) => path.join(r, 'Git', 'bin', 'bash.exe')));
      if (!b) why.bash = 'Git Bash not found (give --bash <path>)';
    } else {
      b = firstFile(['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']);
      if (!b) why.bash = 'bash not found (give --bash <path>)';
    }
  }
  if (!p) {
    if (platform === 'win32') {
      const sys = process.env.SystemRoot || process.env.windir;
      p = sys ? firstFile([path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]) : null;
      if (!p) why.powershell = 'Windows PowerShell not found (give --powershell <path>)';
    } else {
      why.powershell = 'the PowerShell run is Windows only (spec 12.2 c)';
    }
  }
  return { bash: b, powershell: p, why };
}

/** Run a script file in a shell, no outer shell. */
export function runShellFile(shell, exe, file, { env, cwd, input, timeout = 120000 }) {
  const args = shell === 'bash' ? [file] : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file];
  return spawnSync(exe, args, { env, cwd, input, encoding: 'utf8', windowsHide: true, timeout, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Run one command string through a shell, the way a status line command is run (3.2 fact 12a). */
export function runShellCommand(shell, exe, command, { env, cwd, input, timeout = 30000 }) {
  const args = shell === 'bash' ? ['-c', command] : ['-NoProfile', '-NonInteractive', '-Command', command];
  return spawnSync(exe, args, { env, cwd, input, encoding: 'utf8', windowsHide: true, timeout, stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Ask a shell what the four placeholder variables expand to (13.7: before a
 * PowerShell run, ask that shell; bash is asked the same way). Returns
 * { values: { REPO, CONFIG, KIT, NODE } } or { error }.
 */
export function askExpansion(shell, exe, varLines, { env, cwd }) {
  if (shell === 'powershell') return G.expandInPowerShell({ exe, varLines, env, cwd });
  const script = varLines.join('\n') + '\nprintf \'%s\\n\' "$REPO" "$CONFIG" "$KIT" "$NODE"\n';
  const r = spawnSync(exe, ['-c', script], { env, cwd, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (r.status !== 0) return { error: 'bash exited ' + r.status };
  const v = r.stdout.replace(/\r/g, '').split('\n');
  return { values: { REPO: v[0], CONFIG: v[1], KIT: v[2], NODE: v[3] } };
}

/**
 * The decision half: the write targets (CONFIG, KIT) must land under sandbox/,
 * REPO must be this repo and NODE the running Node. Problems name the variable only.
 */
export function expansionProblems(values, { repo = REPO, node = process.execPath } = {}) {
  const problems = [];
  const toNative = (p) => path.resolve(String(p || '').replace(/\//g, path.sep));
  const out = G.checkExpandedPaths([toNative(values.CONFIG), toNative(values.KIT)], { repo });
  out.forEach((p) => problems.push(p.replace('#1', 'CONFIG').replace('#2', 'KIT')));
  if (!G.samePath(toNative(values.REPO), repo)) problems.push('REPO does not expand to this repo');
  if (!G.samePath(toNative(values.NODE), node)) problems.push('NODE does not expand to the running Node program');
  return problems;
}

// ---------------------------------------------------------------------------
// The Claude Code program (13.6)

const CMD_BAD = /[&|<>^%!"\r\n]/;

/**
 * The cmd.exe route's argument check (13.6, T-39): refuse any argument
 * holding & | < > ^ % ! " or a line break, and any absolute path argument
 * outside sandbox/. Returns problems (argument numbers only).
 */
export function checkCmdArgs(args, { repo = REPO } = {}) {
  const problems = [];
  args.forEach((a, i) => {
    const s = String(a);
    if (CMD_BAD.test(s)) problems.push('argument #' + (i + 1) + ' holds a character cmd.exe would act on');
    else if (path.isAbsolute(s) && !G.isInside(s, G.sandboxDir(repo))) problems.push('argument #' + (i + 1) + ' is a path outside sandbox/');
  });
  return problems;
}

/**
 * Find the Claude Code program: --claude-code <file>, or --find-in <folder>
 * (an npm prefix holding the package; its package.json bin entry is used).
 * Returns { file, kind: 'exe' | 'js' | 'cmd' } or { missing: reason, named }. named is true
 * when a program was named but not found: the check then fails (exit 1); only an unnamed
 * program is a skip (13.4).
 */
export function findCli({ file, findIn } = {}) {
  let f = file || null;
  const named = !!(file || findIn);
  if (!f && findIn) {
    const pkgDir = path.join(path.resolve(findIn), 'node_modules', '@anthropic-ai', 'claude-code');
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && (pkg.bin.claude || Object.values(pkg.bin)[0]);
      if (bin) f = path.join(pkgDir, ...String(bin).split('/'));
    } catch (_) {
      return { missing: 'no Claude Code package found under the --find-in folder', named };
    }
    if (!f) return { missing: 'the Claude Code package under the --find-in folder names no program', named };
  }
  if (!f) return { missing: 'no Claude Code program given (use --claude-code <file> or --find-in <npm prefix>)', named: false };
  f = path.resolve(f);
  try {
    if (!fs.statSync(f).isFile()) return { missing: 'the Claude Code program is not a file', named };
  } catch (_) {
    return { missing: 'the Claude Code program was not found', named };
  }
  const ext = path.extname(f).toLowerCase();
  if (['.js', '.mjs', '.cjs'].includes(ext)) return { file: f, kind: 'js' };
  if (ext === '.cmd' || ext === '.bat') return { file: f, kind: 'cmd' };
  return { file: f, kind: 'exe' };
}

/** Run the CLI with fixed arguments, no shell. Returns { status, out } or { status: null, out, refused }. */
export function runCli(cli, args, { env, cwd, timeout = 120000 } = {}) {
  let file;
  let argv;
  if (cli.kind === 'js') { file = process.execPath; argv = [cli.file, ...args]; }
  else if (cli.kind === 'exe') { file = cli.file; argv = args; }
  else {
    const problems = checkCmdArgs([cli.file, ...args]);
    if (problems.length) return { status: null, out: '', refused: problems.join('; ') };
    file = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'cmd.exe');
    argv = ['/d', '/s', '/c', cli.file, ...args];
  }
  const r = spawnSync(file, argv, { env, cwd, encoding: 'utf8', windowsHide: true, timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), error: r.error ? r.error.code || 'error' : null };
}

/**
 * The program as a check sees it (13.4): { cli } when it was found and `--version`
 * exits 0; { skip } when none was named; { fail } when a named program is not found
 * or will not start. A fail is exit 1, never a skip.
 */
export function resolveCli({ file, findIn }, { env, cwd }) {
  const cli = findCli({ file, findIn });
  if (cli.missing) return cli.named ? { fail: cli.missing } : { skip: cli.missing };
  const r = runCli(cli, ['--version'], { env, cwd, timeout: 60000 });
  if (r.refused) return { fail: 'the Claude Code program cannot be started safely: ' + r.refused };
  if (r.status !== 0) return { fail: 'the Claude Code program did not start (' + (r.error || 'exit ' + r.status) + ')' };
  return { cli, version: short(r.out, 40) };
}

// ---------------------------------------------------------------------------
// Stand-in `claude` for the rendered blocks

/** env with dir first on its PATH (the existing key, whatever its case on Windows). */
export function withPathFirst(env, dir) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  for (const k of Object.keys(env)) if (k !== key && k.toUpperCase() === 'PATH') delete env[k];
  env[key] = dir + path.delimiter + (env[key] || '');
  return env;
}

const DUMP_SCRIPT = [
  "'use strict';",
  '// Sandbox stand-in for the claude command: records the arguments a rendered block passed, then exits.',
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "fs.appendFileSync(process.env.KIT_CHECK_DUMP, JSON.stringify([path.basename(process.argv[1] || ''), ...process.argv.slice(2)]) + '\\n');",
  'process.exit(0);',
  '',
].join('\n');

/**
 * A `claude` command on the shell's PATH that only records its arguments:
 * a link (or copy) of the running Node named claude, which preloads a dump
 * script through NODE_OPTIONS and exits before anything else runs. The check
 * then compares the arguments with the step list and runs the real CLI
 * itself, with fixed arguments and no shell (13.6).
 */
export function makeCliStub(run) {
  const bin = path.join(run.dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const target = path.join(bin, name);
  if (!fs.existsSync(target)) {
    try {
      if (process.platform === 'win32') fs.linkSync(process.execPath, target);
      else fs.symlinkSync(process.execPath, target);
    } catch (_) {
      fs.copyFileSync(process.execPath, target);
      fs.chmodSync(target, 0o755);
    }
  }
  const dumpScript = path.join(bin, 'record-args.cjs');
  fs.writeFileSync(dumpScript, DUMP_SCRIPT);
  const dumpFile = path.join(run.dir, 'claude-args.jsonl');
  return {
    bin,
    dumpFile,
    env: (env) => withPathFirst({ ...env, KIT_CHECK_DUMP: dumpFile, NODE_OPTIONS: '--require "' + dumpScript.split(path.sep).join('/') + '"' }, bin),
    read() {
      let text = '';
      try { text = fs.readFileSync(dumpFile, 'utf8'); } catch (_) { return []; }
      try { fs.unlinkSync(dumpFile); } catch (_) { /* keep */ }
      return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
  };
}

// ---------------------------------------------------------------------------
// Hook and status line fixtures (synthetic; no real session)

export const FIXTURE_SESSION = 'b9check0001';

export function sessionStartInput(project, transcript) {
  return JSON.stringify({ session_id: FIXTURE_SESSION, transcript_path: transcript, cwd: project, hook_event_name: 'SessionStart', source: 'startup' });
}
export function promptInput(project, transcript) {
  return JSON.stringify({ session_id: FIXTURE_SESSION, transcript_path: transcript, cwd: project, hook_event_name: 'UserPromptSubmit', prompt: 'fixture prompt' });
}
export function statusInput(tokens) {
  return JSON.stringify({ session_id: FIXTURE_SESSION, context_window: { total_input_tokens: tokens, current_usage: null } });
}
/** A one-record transcript whose newest reply has the given size. */
export function writeTranscript(file, tokens) {
  const rec = { type: 'assistant', isSidechain: false, message: { role: 'assistant', usage: { input_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } };
  fs.writeFileSync(file, JSON.stringify(rec) + '\n');
}

export function parseHookJson(stdout) {
  const t = String(stdout || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch (_) { return undefined; }
}

/** Spawn one exec-form hook (command plus args), the way Claude Code runs exec form: no shell. */
export function fireExec(command, args, { env, cwd, input, timeout = 15000 }) {
  return spawnSync(command, args, { env, cwd, input, encoding: 'utf8', windowsHide: true, timeout, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Spawn a kit script through the test-only launcher with a git ceiling (the in-repo sandbox is a git work tree). */
export function fireWithCeiling(script, args, ceiling, { env, cwd, input, timeout = 15000 }) {
  const launcher = path.join(REPO, 'tests', 'helpers', 'meter-launch.cjs');
  return spawnSync(process.execPath, [launcher, script, ...args], {
    env: { ...env, METER_TEST_SEAMS: JSON.stringify({ gitCeiling: ceiling }) },
    cwd, input, encoding: 'utf8', windowsHide: true, timeout, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** One-line, ASCII-only summary of a child's output for the report (no file text). */
export function short(s, n = 160) {
  return String(s || '').replace(/\s+/g, ' ').trim().replace(/[^\x20-\x7e]/g, '?').slice(0, n);
}

/** Remove a run folder when its run passed (a failed run is kept for a look). Only ever inside sandbox/. */
export function removeRun(run, passed = true) {
  if (!passed || !run || !G.isInside(run.dir, G.sandboxDir(REPO)) || G.samePath(run.dir, G.sandboxDir(REPO))) return false;
  try {
    fs.rmSync(run.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return true;
  } catch (_) {
    return false;
  }
}
