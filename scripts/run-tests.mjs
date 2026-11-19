// Dev only. Lists every *.test.cjs / *.test.mjs under tests/ with fs and passes
// the list to `node --test` explicitly: no shell, no globs, no bare directory.
// Usage: node scripts/run-tests.mjs [--root <dir>] [--list]
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';

const SKIP_DIRS = new Set(['fixtures', 'helpers', 'node_modules']);
const TEST_NAME = /\.test\.(?:cjs|mjs)$/;

// Returns { files: sorted absolute paths, errors: [{ path, message }] }.
// A folder that cannot be read is collected as an error; the walk continues.
export function listTestFiles(testsDir) {
  const files = [];
  const errors = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      errors.push({ path: dir, message: String(err && err.message ? err.message : err) });
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && TEST_NAME.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(testsDir);
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { files, errors };
}

function countFrom(output, label) {
  // Both the tap reporter ("# pass 3") and the spec reporter ("\u2139 pass 3"); the last match is the top-level total.
  const re = new RegExp('^[ \\t]*(?:\\u2139|#) ' + label + ' (\\d+)[ \\t]*\\r?$', 'gm');
  let last = null;
  for (const m of output.matchAll(re)) last = Number(m[1]);
  return last;
}

export function run(root, { listOnly = false } = {}) {
  const testsDir = path.join(root, 'tests');
  const { files, errors } = listTestFiles(testsDir);
  for (const e of errors) console.error(`run-tests: could not read ${e.path}: ${e.message}`);
  if (files.length === 0) {
    console.error('run-tests: FAIL, no test files found under tests/. Zero tests is not a pass.');
    return 1;
  }
  if (listOnly) {
    for (const f of files) console.log(f);
    return errors.length ? 1 : 0;
  }
  // A parent test runner marks its children with NODE_TEST_CONTEXT; drop it so this run is a fresh runner.
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, ['--test', ...files], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env,
    windowsHide: true,
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  const pass = countFrom(out, 'pass');
  const fail = countFrom(out, 'fail');
  const skipped = countFrom(out, 'skipped');
  const status = res.error ? 1 : (res.status === null ? 1 : res.status);
  if (res.error) console.error(`run-tests: could not start node --test: ${res.error.message}`);
  console.log(
    `run-tests: ${files.length} test files; tests succeeded ${pass ?? '?'}, failed ${fail ?? '?'}, skipped ${skipped ?? '?'}; read errors ${errors.length}; exit ${status}`
  );
  return status !== 0 || errors.length > 0 ? 1 : 0;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const here = path.dirname(fileURLToPath(import.meta.url));
  let root = path.resolve(here, '..');
  let listOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) root = path.resolve(args[++i]);
    else if (args[i] === '--list') listOnly = true;
  }
  process.exitCode = run(root, { listOnly });
}
