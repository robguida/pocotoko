// Copy-by-hand install proof (spec 12.2, 12.3, 13.7, 14.6). Dev only, never shipped.
//
//   node scripts/copy-by-hand.mjs --render
//       Writes the per-shell blocks of docs/install.md from docs/install-steps.json.
//   node scripts/copy-by-hand.mjs --check [--shells node,bash,powershell]
//       [--claude-code <file> | --find-in <npm prefix>] [--bash <file>] [--powershell <file>]
//       Performs the steps in a sandbox home in Node, then runs the rendered bash
//       block in bash and (Windows) the rendered PowerShell block in PowerShell,
//       each in a fresh sandbox home; fires the hooks and the status line through
//       the merged settings strings; runs the uninstall list; checks each home is
//       byte-identical to its pre-install snapshot; and repeats with a skill folder
//       of the same name already present. The Claude Code program can also be
//       given in the KIT_CLAUDE_CODE environment variable.
//
// Close every Claude Code session before --check (13.7): a live session can edit
// a watched real item, which the guard reports as a change.

import fs from 'node:fs';
import path from 'node:path';
import * as G from './lib/guard.mjs';
import * as S from './lib/install-steps.mjs';
import * as D from './lib/dev-run.mjs';
import { isMain } from './lib/is-main.mjs';

const REPO = G.kitRoot();
const KIT_NAME = G.KIT_FOLDER_NAME;
// Windows PowerShell rewrites its own startup cache under the home on every start; it is the shell's, not the kit's.
export const SHELL_HOUSEKEEPING = Object.freeze(['AppData/Local/Microsoft/Windows/PowerShell']);

export function parseArgs(argv) {
  const o = { mode: null, shells: null, claudeCode: null, findIn: null, bash: null, powershell: null, problems: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) o.problems.push(a + ' needs a value'); return v; };
    if (a === '--render' || a === '--check') o.mode = o.mode ? 'both' : a.slice(2);
    else if (a === '--shells') o.shells = String(val() || '').split(',').filter(Boolean);
    else if (a === '--claude-code') o.claudeCode = val();
    else if (a === '--find-in') o.findIn = val();
    else if (a === '--bash') o.bash = val();
    else if (a === '--powershell') o.powershell = val();
    else o.problems.push('unknown argument ' + JSON.stringify(a));
  }
  if (!o.mode || o.mode === 'both') o.problems.push('give exactly one of --render or --check');
  for (const s of o.shells || []) if (!['node', 'bash', 'powershell'].includes(s)) o.problems.push('unknown shell ' + JSON.stringify(s));
  return o;
}

// ---------------------------------------------------------------------------
// --render

export function freshInstallMd(repo = REPO) {
  const { doc } = S.loadSteps(repo);
  const problems = S.validateSteps(doc);
  if (problems.length) throw new Error('docs/install-steps.json: ' + problems.join('; '));
  const current = fs.readFileSync(S.installMdFile(repo), 'utf8');
  return { current, fresh: S.applyRender(current, S.renderBlocks(doc, repo)) };
}

function render() {
  const { current, fresh } = freshInstallMd();
  if (fresh === current) { console.log('render: docs/install.md unchanged'); return 0; }
  fs.writeFileSync(S.installMdFile(REPO), fresh);
  console.log('render: docs/install.md updated');
  return 0;
}

// ---------------------------------------------------------------------------
// --check

const USER_SETTINGS = { permissions: { allow: ['Read'] }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'user-own-hook', args: ['x'] }] }] } };
const USER_CLAUDE_MD = '# My own notes\n\nKeep answers short.\n';
const USER_SKILL = '---\nname: handoff\ndescription: The user own skill of the same name, which must never be overwritten.\n---\nMine.\n';

function valuesFor(run) {
  return {
    REPO: S.slash(REPO),
    CONFIG: S.slash(run.L.config),
    KIT: S.slash(path.join(run.L.config, KIT_NAME)),
    NODE: S.slash(process.execPath),
  };
}

/**
 * The homes each shell's run starts from (12.2 f, d). A variant with stopAt must stop at that
 * action and leave the home as it was.
 */
export const VARIANTS = Object.freeze([
  Object.freeze({ name: 'fresh', label: '', stopAt: null }),
  Object.freeze({ name: 'empty-skills', label: ' (an empty skills folder already there)', stopAt: null }),
  Object.freeze({ name: 'own-skill', label: ' (a skill folder of the same name already there)', stopAt: 'copy-skill-handoff' }),
  Object.freeze({ name: 'kit-exists', label: ' (the kit folder already there, holding a user file)', stopAt: 'kit-folder' }),
  Object.freeze({ name: 'kit-is-config', label: ' (the kit folder set to the config folder)', stopAt: 'kit-folder' }),
]);

function preState(run, variant) {
  fs.writeFileSync(path.join(run.L.config, 'settings.json'), JSON.stringify(USER_SETTINGS, null, 2) + '\n');
  fs.writeFileSync(path.join(run.L.config, 'CLAUDE.md'), USER_CLAUDE_MD);
  if (variant.name === 'own-skill') {
    fs.mkdirSync(path.join(run.L.config, 'skills', 'handoff'), { recursive: true });
    fs.writeFileSync(path.join(run.L.config, 'skills', 'handoff', 'SKILL.md'), USER_SKILL);
  }
  if (variant.name === 'empty-skills') fs.mkdirSync(path.join(run.L.config, 'skills'), { recursive: true });
  if (variant.name === 'kit-exists') {
    fs.mkdirSync(path.join(run.L.config, KIT_NAME), { recursive: true });
    fs.writeFileSync(path.join(run.L.config, KIT_NAME, 'my-notes.txt'), 'the user own file\n');
  }
}

/** Normalise a run's installed state so runs in different homes and shells compare equal. */
function normaliser(values) {
  return (rel, buf) => {
    if (rel !== '.claude/settings.json' && rel !== '.claude/.claude.json') return buf;
    let t = buf.toString('utf8');
    if (rel === '.claude/settings.json') {
      try {
        const j = JSON.parse(t);
        if (j.statusLine && typeof j.statusLine.command === 'string') j.statusLine = { type: j.statusLine.type, command: '<status line form for this shell>' };
        t = JSON.stringify(j, null, 2);
      } catch (_) { /* compare as is */ }
    }
    return Buffer.from(t.split(values.KIT).join('<KIT>').split(values.CONFIG).join('<CONFIG>').split(values.NODE).join('<NODE>'));
  };
}

function makeMcpRunner(cli, env, cwd, log) {
  if (!cli) return null;
  return (args) => {
    const problems = G.preflight({ env, repo: REPO });
    if (problems.length) return { held: 'guard refused: ' + problems.join('; ') };
    const r = D.runCli(cli, args, { env, cwd });
    log.cliCalls++;
    if (r.refused) return { held: 'cmd.exe route refused: ' + r.refused };
    return r;
  };
}

/** Hooks and status line through the merged settings strings (12.2 c, 14.6). */
function fireThroughSettings(run, env, values, shells, shellName, log) {
  const out = [];
  const settings = JSON.parse(fs.readFileSync(path.join(run.L.config, 'settings.json'), 'utf8'));
  const transcript = path.join(run.project, 'transcript.jsonl');
  D.writeTranscript(transcript, 50000);
  const hookEnv = { ...env, CLAUDE_PROJECT_DIR: run.project };
  const kitHooks = (ev) => (settings.hooks[ev] || []).flatMap((g) => g.hooks).filter((h) => Array.isArray(h.args) && String(h.args[0]).startsWith(values.KIT + '/'));
  for (const [ev, input, expect] of [
    ['SessionStart', D.sessionStartInput(run.project, transcript), 'session-start'],
    ['UserPromptSubmit', D.promptInput(run.project, transcript), 'prompt'],
  ]) {
    const hs = kitHooks(ev);
    if (hs.length !== 1) { out.push({ id: 'fire ' + ev, status: 'failed', reason: 'expected one kit hook, found ' + hs.length }); continue; }
    const r = D.fireExec(hs[0].command, hs[0].args, { env: hookEnv, cwd: run.project, input });
    const j = D.parseHookJson(r.stdout);
    let ok = r.status === 0 && j !== undefined;
    let what = 'exit ' + r.status;
    if (expect === 'session-start') {
      // The sandbox sits inside this repo's git work tree, so the kit writes nothing (6.7).
      const routing = fs.readFileSync(path.join(run.L.config, 'skills', 'model-routing', 'SKILL.md'), 'utf8');
      const block = routing.slice(routing.indexOf('-->', routing.indexOf('routing-block:start')) + 3, routing.indexOf('<!-- routing-block:end')).trim();
      ok = ok && j && /inside a git repo/.test(j.systemMessage || '') && String((j.hookSpecificOutput || {}).additionalContext || '').includes(block);
      what += j ? ', write-nothing line (git work tree) + routing block from the copied skill' : ', no output';
    } else {
      ok = ok && j === null;
      what += ', no output (git work tree: no tier warnings)';
    }
    out.push({ id: 'fire ' + ev, status: ok ? 'done' : 'failed', reason: what + (ok ? '' : ' | ' + D.short(r.stdout + r.stderr)) });
  }
  // The status line: one command string, run through this run's shell (3.2 fact 12a).
  const sl = settings.statusLine && settings.statusLine.command;
  const shell = shellName === 'powershell' ? 'powershell' : 'bash';
  const exe = shells[shell];
  if (!exe) out.push({ id: 'fire statusLine', status: 'skipped', reason: shells.why[shell] });
  else {
    const r = D.runShellCommand(shell, exe, sl, { env: { ...env, NO_COLOR: '1' }, cwd: run.project, input: D.statusInput(50000) });
    const line = String(r.stdout || '').replace(/\r/g, '').trim();
    const ok = r.status === 0 && line === 'chat 50k (warn 100k/150k)';
    out.push({ id: 'fire statusLine (' + shell + ')', status: ok ? 'done' : 'failed', reason: 'exit ' + r.status + ', ' + JSON.stringify(D.short(line || r.stderr, 80)) });
  }
  log.fired += out.length;
  return out;
}

/** Node run only: the hooks through the test launcher with a git ceiling, so they really write (then uninstall must remove it all). */
function fireWithCeiling(run, env, values) {
  const out = [];
  const kit = path.join(run.L.config, KIT_NAME);
  const transcript = path.join(run.project, 'transcript-hard.jsonl');
  D.writeTranscript(transcript, 160000);
  const hookEnv = { ...env, CLAUDE_PROJECT_DIR: run.project };
  const ss = D.fireWithCeiling(path.join(kit, 'hooks', 'session-start.cjs'), [], run.dir, { env: hookEnv, cwd: run.project, input: D.sessionStartInput(run.project, transcript) });
  const j = D.parseHookJson(ss.stdout) || {};
  const ctx = String((j.hookSpecificOutput || {}).additionalContext || '');
  const okSs = ss.status === 0 && ctx.includes('Hand-off folder for this session: ') && !j.systemMessage;
  out.push({ id: 'seam SessionStart', status: okSs ? 'done' : 'failed', reason: 'exit ' + ss.status + (okSs ? ', hand-off folder line and routing block' : ' | ' + D.short(ss.stdout + ss.stderr)) });
  const pr = D.fireWithCeiling(path.join(kit, 'hooks', 'meter.cjs'), [], run.dir, { env: hookEnv, cwd: run.project, input: D.promptInput(run.project, transcript) });
  const pj = D.parseHookJson(pr.stdout) || {};
  let notes = [];
  try { notes = fs.readdirSync(path.join(kit, 'handoff')); } catch (_) { /* none */ }
  const okPr = pr.status === 0 && /NEW SESSION|new session/i.test(JSON.stringify(pj)) && notes.length === 1;
  out.push({ id: 'seam UserPromptSubmit', status: okPr ? 'done' : 'failed', reason: 'exit ' + pr.status + ', hard-tier warning, hand-off notes pre-created: ' + notes.length });
  return out;
}

function userPaste(run) {
  const file = path.join(run.L.config, 'CLAUDE.md');
  let t = fs.readFileSync(file, 'utf8');
  t = S.pasteBlock(t, fs.readFileSync(path.join(REPO, 'src', 'core', 'templates', 'rules-block.md'), 'utf8'));
  t = S.pasteBlock(t, fs.readFileSync(path.join(REPO, 'src', 'search', 'templates', 'rules-block.md'), 'utf8'));
  fs.writeFileSync(file, t);
}

/** Run one rendered block in its shell, with the stand-in claude; then the CLI calls it asked for, checked and run directly. */
function runRenderedList(doc, listName, shell, ctx) {
  const { run, env, values, shells, stub, runMcp } = ctx;
  const results = [];
  const text = S.unfence(S.renderBlocks(doc, REPO)[listName + '-' + shell]);
  const lines = text.split('\n');
  const varLines = lines.filter((l) => (shell === 'bash' ? /^(REPO|CONFIG|KIT|NODE)='<[A-Z]+>'$/ : /^\$(REPO|CONFIG|KIT|NODE) = '<[A-Z]+>'$/).test(l));
  const filledVars = varLines.map((l) => S.fillShell(l, values, shell));
  const exp = D.askExpansion(shell, shells[shell], filledVars, { env, cwd: run.project });
  const problems = exp.error ? [exp.error] : D.expansionProblems(exp.values);
  if (problems.length) {
    results.push({ id: listName + ' block (' + shell + ')', status: 'failed', reason: 'expansion check refused: ' + problems.join('; ') });
    return { results, stopped: false };
  }
  const file = path.join(run.dir, listName + (shell === 'bash' ? '.sh' : '.ps1'));
  fs.writeFileSync(file, S.fillShell(text, values, shell) + '\n');
  const r = D.runShellFile(shell, shells[shell], file, { env: stub.env(env), cwd: run.project });
  const said = String(r.stdout || '').replace(/\r/g, '');
  const stopped = /^Stopped: /m.test(said);
  const expectStop = !!ctx.expectStop;
  const okExit = shell === 'bash' ? (stopped ? r.status === 1 : r.status === 0) : r.status === 0;
  results.push({ id: listName + ' block (' + shell + ')', status: okExit && stopped === expectStop ? 'done' : 'failed',
    reason: 'exit ' + r.status + (stopped ? ', ' + D.short(said.split('\n').find((l) => l.startsWith('Stopped: ')).split(values.KIT).join('<KIT>').split(values.CONFIG).join('<CONFIG>'), 160) : '') + (okExit ? '' : ' | ' + D.short(r.stderr)) });
  // The claude lines: the shell's argument lists must equal the step list's; then the check runs them itself.
  const asked = stub.read();
  const ran = [];
  for (const a of doc[listName]) {
    if (a.type !== 'mcp-add-user' && a.type !== 'mcp-remove-user') continue;
    if (stopped) { results.push({ id: a.id, status: 'not-run', reason: 'the steps stopped earlier' }); continue; }
    const want = S.mcpArgs(a, values);
    const got = asked[ran.length];
    ran.push(a.id);
    if (!got || JSON.stringify(got) !== JSON.stringify(want)) {
      results.push({ id: a.id, status: 'failed', reason: 'the ' + shell + ' line passed other arguments than the step list' });
      continue;
    }
    results.push({ id: a.id, ...S.mcpResult(a, runMcp ? runMcp(want, a) : null), reason2: 'arguments match the step list' });
  }
  if (asked.length !== ran.length) results.push({ id: listName + ' claude lines', status: 'failed', reason: 'the block ran ' + asked.length + ' claude lines, the list has ' + ran.length });
  // The by-hand steps, applied from the same JSON (12.2 c).
  if (!stopped) {
    const byHand = { ...doc, [listName]: doc[listName].filter((a) => ['merge-settings', 'remove-settings-entries', 'remove-marked-block'].includes(a.type)) };
    results.push(...S.performList(byHand, listName, { values, repo: REPO, shell, runMcp: null, homes: [run.L.home] }).results.map((x) => ({ ...x, reason: (x.reason ? x.reason + '; ' : '') + 'by-hand step applied from the JSON' })));
  }
  return { results, stopped };
}

async function oneRun(doc, kind, shared, variant) {
  const run = D.makeRun('copy-by-hand', kind + '-' + variant.name);
  const values = valuesFor(run);
  if (variant.name === 'kit-is-config') values.KIT = values.CONFIG;
  const stopping = !!variant.stopAt;
  const env = D.runEnv(run);
  const log = shared.log;
  const runMcp = makeMcpRunner(shared.cli, env, run.project, log);
  preState(run, variant);
  if (runMcp) runMcp(['mcp', 'get', 'pocotoko-search']); // warm-up: the CLI writes its own state file first
  const pre = S.snapshot(run.L.home, { exclude: SHELL_HOUSEKEEPING });
  const ownBefore = variant.name === 'own-skill' ? S.snapshot(path.join(run.L.config, 'skills', 'handoff'), { configRel: '-' }) : null;
  const settingsBefore = fs.readFileSync(path.join(run.L.config, 'settings.json'));
  const report = { kind, variant, steps: [], installed: null, clean: null };
  const stub = kind === 'node' ? null : D.makeCliStub(run);
  const formShell = kind === 'powershell' ? 'powershell' : 'bash';
  let stopped = false;
  if (kind === 'node') {
    const r = S.performList(doc, 'install', { values, repo: REPO, shell: formShell, runMcp, homes: [run.L.home] });
    report.steps.push(...r.results);
    stopped = r.summary.stopped > 0;
    const at = (r.results.find((x) => x.status === 'stopped') || {}).id || null;
    if (at !== variant.stopAt) report.steps.push({ id: 'install stop', status: 'failed', reason: 'expected the stop at ' + variant.stopAt + ', got ' + at });
  } else {
    const r = runRenderedList(doc, 'install', kind, { run, env, values, shells: shared.shells, stub, runMcp, expectStop: stopping });
    report.steps.push(...r.results);
    stopped = r.stopped;
  }
  if (stopping) {
    const settingsSame = fs.readFileSync(path.join(run.L.config, 'settings.json')).equals(settingsBefore);
    if (ownBefore) {
      const same = S.diffSnapshots(ownBefore, S.snapshot(path.join(run.L.config, 'skills', 'handoff'), { configRel: '-' })).length === 0;
      report.steps.push({ id: 'own skill folder left byte-identical', status: same ? 'done' : 'failed', reason: '' });
    } else {
      // The kit-folder stop comes first: nothing at all may have changed.
      const d = S.diffSnapshots(pre, S.snapshot(run.L.home, { exclude: SHELL_HOUSEKEEPING }));
      report.steps.push({ id: 'nothing changed by the stopped install', status: d.length ? 'failed' : 'done', reason: d.slice(0, 6).join(', ') });
    }
    report.steps.push({ id: 'steps stopped before the settings merge', status: stopped && settingsSame ? 'done' : 'failed', reason: '' });
  } else {
    report.installed = S.snapshot(run.L.home, { transform: normaliser(values), exclude: SHELL_HOUSEKEEPING });
    report.steps.push(...fireThroughSettings(run, env, values, shared.shells, kind, log));
    if (kind === 'node') report.steps.push(...fireWithCeiling(run, env, values));
    userPaste(run);
  }
  if (kind === 'node') report.steps.push(...S.performList(doc, 'uninstall', { values, repo: REPO, shell: formShell, runMcp, homes: [run.L.home] }).results);
  else report.steps.push(...runRenderedList(doc, 'uninstall', kind, { run, env, values, shells: shared.shells, stub, runMcp }).results);
  const post = S.snapshot(run.L.home, { exclude: SHELL_HOUSEKEEPING });
  report.clean = S.diffSnapshots(pre, post);
  report.steps.push({ id: 'clean end: home byte-identical to the pre-install snapshot', status: report.clean.length ? 'failed' : 'done',
    reason: report.clean.length ? 'differs: ' + report.clean.slice(0, 8).join(', ') : '' });
  // Reports name placeholders, never this machine's paths.
  const hide = (s) => (typeof s === 'string' ? s.split(values.KIT).join('<KIT>').split(values.CONFIG).join('<CONFIG>').split(values.REPO).join('<REPO>').split(values.NODE).join('<NODE>') : s);
  for (const s of report.steps) { s.reason = hide(s.reason); s.reason2 = hide(s.reason2); }
  D.removeRun(run, !report.steps.some((s) => s.status === 'failed'));
  return report;
}

function printReport(rep) {
  console.log('== ' + rep.kind + rep.variant.label);
  for (const s of rep.steps) {
    const extra = [s.reason, s.reason2].filter(Boolean).join('; ');
    console.log('  ' + s.status.padEnd(8) + ' ' + s.id + (extra ? ' - ' + extra : ''));
  }
}

async function check(opts) {
  const shared = { log: { cliCalls: 0, fired: 0 } };
  const ccArg = opts.claudeCode || process.env.KIT_CLAUDE_CODE || null;
  const guardRun = D.makeRun('copy-by-hand', 'guard');
  const probe = await G.guardedRun({ env: D.runEnv(guardRun), repo: REPO, step: async () => D.resolveCli({ file: ccArg, findIn: opts.findIn }, { env: D.runEnv(guardRun), cwd: guardRun.project }) });
  const cliRes = probe.refused ? { fail: probe.problems.join('; ') } : probe.changed.length ? { fail: G.describeChanges(probe.changed) } : probe.result;
  if (cliRes.fail) {
    D.removeRun(guardRun);
    console.log('FAILED Claude Code program: ' + cliRes.fail);
    console.log('copy-by-hand --check: succeeded 0, failed 1, skipped 0 (a named program must be found and start)');
    return 1;
  }
  const cli = cliRes.cli ? cliRes.cli : { missing: cliRes.skip };
  shared.cli = cliRes.cli || null;
  shared.shells = D.findShells({ bash: opts.bash, powershell: opts.powershell });
  const { doc } = S.loadSteps(REPO);
  const problems = S.validateSteps(doc);
  const lines = [];
  let failed = 0;
  let skipped = 0;
  let held = 0;
  let succeeded = 0;
  if (problems.length) { console.log('check: docs/install-steps.json: ' + problems.join('; ')); return 1; }
  const { current, fresh } = freshInstallMd();
  if (current !== fresh) { console.log('check: docs/install.md differs from a fresh render; run --render'); return 1; }
  const kinds = opts.shells || ['node', 'bash', ...(process.platform === 'win32' ? ['powershell'] : [])];
  const guard = await G.guardedRun({
    env: D.runEnv(guardRun),
    repo: REPO,
    step: async () => {
      const reports = [];
      for (const kind of kinds) {
        if (kind !== 'node' && !shared.shells[kind]) { lines.push('SKIPPED ' + kind + ' run: ' + shared.shells.why[kind]); skipped++; continue; }
        for (const variant of VARIANTS) {
          let rep;
          try { rep = await oneRun(doc, kind, shared, variant); } catch (err) {
            rep = { kind, variant, steps: [{ id: kind + ' run', status: 'failed', reason: (err && err.message) || String(err) }], installed: null, clean: [] };
          }
          reports.push(rep);
        }
      }
      return reports;
    },
  });
  D.removeRun(guardRun);
  if (guard.refused) { console.log('check: ' + guard.problems.join('; ')); return 1; }
  const reports = guard.result || [];
  if (guard.error) { console.log('check: ' + guard.error.message); failed++; }
  for (const rep of reports) {
    printReport(rep);
    for (const s of rep.steps) {
      if (s.status === 'failed') failed++;
      else if (s.status === 'done' || s.status === 'stopped') succeeded++;
      else { skipped++; if (s.status === 'held') held++; }
    }
  }
  // Every run reaches the same installed state (12.2 c).
  const full = reports.filter((r) => r.variant.name === 'fresh' && r.installed);
  for (const r of full.slice(1)) {
    const d = S.diffSnapshots(full[0].installed, r.installed);
    const ok = d.length === 0;
    lines.push((ok ? 'same' : 'DIFFERENT') + ' installed state: ' + full[0].kind + ' and ' + r.kind + (ok ? '' : ' (' + d.slice(0, 8).join(', ') + ')'));
    if (ok) succeeded++; else failed++;
  }
  if (cli.missing) { lines.push('SKIPPED Claude Code CLI steps: ' + cli.missing + ' (a skip never counts toward the release gate)'); }
  lines.push(G.describeChanges(guard.changed));
  if (guard.changed.length) failed++;
  for (const l of lines) console.log(l);
  console.log('copy-by-hand --check: succeeded ' + succeeded + ', failed ' + failed + ', skipped ' + skipped
    + ' (held ' + held + '; runs: ' + reports.length + ', Claude Code CLI calls: ' + shared.log.cliCalls + ')');
  return failed ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.problems.length) { console.log('copy-by-hand: ' + opts.problems.join('; ')); return 2; }
  try {
    return opts.mode === 'render' ? render() : await check(opts);
  } catch (err) {
    console.log('copy-by-hand: ' + ((err && err.message) || String(err)));
    return 1;
  }
}

if (isMain(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
