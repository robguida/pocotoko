'use strict';
// Test helper: run a sandbox copy of the core meter as a real process, with a sandbox
// environment (home, temp and config folders under sandbox/), through the test-only
// launcher (seams as function arguments) or directly.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const LAUNCHER = path.join(__dirname, 'meter-launch.cjs');

function childEnv(b, extra = {}) {
  const tmp = path.join(b.base, 'tmp');
  const env = {
    PATH: process.env.PATH || '',
    HOME: b.home,
    USERPROFILE: b.home,
    TMP: tmp,
    TEMP: tmp,
    TMPDIR: tmp,
    APPDATA: path.join(b.home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(b.home, 'AppData', 'Local'),
    XDG_DATA_HOME: path.join(b.home, '.local', 'share'),
    XDG_STATE_HOME: path.join(b.home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(b.home, '.cache'),
    NO_COLOR: '1',
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) delete env[k];
    else env[k] = v;
  }
  return env;
}

/**
 * Run the meter synchronously. opts: { scriptFile, args, input (string or Buffer), env,
 * cwd, execPath, seams (null = run the script directly, no launcher), timeoutMs }.
 * Returns { status, stdout (Buffer), text, ms }.
 */
function runMeter(b, opts) {
  const seams = opts.seams === undefined ? { gitCeiling: b.base } : opts.seams;
  const args = seams ? [LAUNCHER, opts.scriptFile, ...(opts.args || [])] : [opts.scriptFile, ...(opts.args || [])];
  const env = childEnv(b, opts.env || {});
  if (seams) env.METER_TEST_SEAMS = JSON.stringify(seams);
  const t0 = Date.now();
  const r = spawnSync(opts.execPath || process.execPath, args, {
    cwd: opts.cwd || b.proj,
    env,
    input: opts.input === undefined ? '' : opts.input,
    timeout: opts.timeoutMs || 15000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  return { status: r.status, signal: r.signal, stdout: r.stdout || Buffer.alloc(0), text: (r.stdout || '').toString('utf8'), stderr: (r.stderr || '').toString('utf8'), ms, error: r.error };
}

/** Start the meter and never close its stdin; resolves with { code, ms } when it exits. */
function runWithOpenStdin(b, opts) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [opts.scriptFile, ...(opts.args || [])], {
      cwd: b.proj, env: childEnv(b, opts.env || {}), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const guard = setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } }, 10000);
    child.stdout.resume();
    child.stderr.resume();
    child.on('exit', (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, ms: Date.now() - t0 });
    });
  });
}

module.exports = { LAUNCHER, childEnv, runMeter, runWithOpenStdin };
