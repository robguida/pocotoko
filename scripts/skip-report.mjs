// Skip report (spec 9.8, 14.6, SR-33). Dev only, never shipped.
//
//   node scripts/skip-report.mjs [<project folder>] [--options <search-config.json>]
//
// Prints which files the search floor would skip in a project folder and by
// which rule: one "<rule id><TAB><path as JSON>" line per skipped file, then the
// counts. Never file text. A path that holds a never-term is only counted.
// It runs the search server's own report (the copied server's --skip-report
// flag) as a copy-by-hand install would, with the options file you give, or the
// defaults. It reads only; its one scratch folder is under sandbox/.
// --git-ceiling <folder> stops the git-ignore walk at that folder (for tests).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as G from './lib/guard.mjs';
import { isMain } from './lib/is-main.mjs';

const REPO = G.kitRoot();
const require = createRequire(import.meta.url);

export function parseArgs(argv) {
  const o = { project: null, options: null, gitCeiling: null, problems: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--options' || a === '--git-ceiling') {
      const v = argv[++i];
      if (v === undefined) { o.problems.push(a + ' needs a value'); continue; }
      if (a === '--options') o.options = v; else o.gitCeiling = v;
    } else if (a.startsWith('--')) o.problems.push('unknown argument ' + JSON.stringify(a));
    else if (o.project) o.problems.push('give one project folder');
    else o.project = a;
  }
  return o;
}

export async function main(argv = process.argv.slice(2), out = process.stdout) {
  const o = parseArgs(argv);
  if (o.problems.length) { out.write('skip report: ' + o.problems.join('; ') + '\n'); return 2; }
  const project = path.resolve(o.project || process.cwd());
  // A stand-in copy-by-hand kit folder under sandbox/: the server's install-mode rule
  // reads options from <kit>/data/search-config.json and stores nothing for a report.
  const kit = path.join(G.sandboxDir(REPO), 'skip-report', 'kit-' + process.pid);
  const dataRoot = path.join(kit, 'data');
  fs.mkdirSync(dataRoot, { recursive: true });
  try {
    if (o.options) fs.copyFileSync(path.resolve(o.options), path.join(dataRoot, 'search-config.json'));
    const server = require(path.join(REPO, 'src', 'search', 'server', 'server.cjs'));
    const env = { ...process.env, CLAUDE_PROJECT_DIR: project };
    delete env.CLAUDE_PLUGIN_DATA;
    return await server.skipReport({
      env, cwd: project, serverFile: path.join(kit, 'server', 'server.cjs'), out,
      seams: o.gitCeiling ? { gitCeiling: path.resolve(o.gitCeiling) } : {},
    });
  } finally {
    fs.rmSync(kit, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
