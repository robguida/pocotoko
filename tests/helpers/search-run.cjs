'use strict';
// Test helper for the search engine tests: a sandbox project folder and a
// sandbox data root, both under sandbox/test-tmp/, and a store opened on them.
// The store's upward `.git` search stops at the run folder (gitCeiling), because
// the tests themselves run inside this repo's own git work tree.

const fs = require('node:fs');
const path = require('node:path');
const { REPO_TOP, makeTempDir, removeDir, writeFiles } = require('./tmpdir-sandbox.cjs');

const S = require('../../src/search/server/store.cjs');

const SERVER = path.join(REPO_TOP, 'src', 'search', 'server');
const runs = [];

function makeRun(name, files = {}) {
  const base = fs.realpathSync.native(makeTempDir('search-' + name));
  const proj = path.join(base, 'proj');
  fs.mkdirSync(proj);
  writeFiles(proj, files);
  const run = { base, proj: fs.realpathSync.native(proj), data: path.join(base, 'data') };
  runs.push(run);
  return run;
}

function openStore(run, extra = {}) {
  const store = S.createStore({
    dataRoot: run.data,
    rootReal: run.proj,
    options: {},
    globalExcludes: null,
    gitCeiling: run.base,
    ...extra,
  });
  store.open();
  return store;
}

/** Every regular file under dir (links not followed): [{ rel, buf }]. */
function listFiles(dir) {
  const out = [];
  const walk = (d, rel) => {
    let names = [];
    try { names = fs.readdirSync(d); } catch (_) { return; }
    for (const n of names) {
      const p = path.join(d, n);
      const r = rel ? rel + '/' + n : n;
      let st;
      try { st = fs.lstatSync(p); } catch (_) { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) out.push({ rel: r, buf: fs.readFileSync(p) });
    }
  };
  walk(dir, '');
  return out;
}

/** True when any file under dir holds the text (byte search). */
function dataHolds(dir, text) {
  const needle = Buffer.from(text, 'utf8');
  return listFiles(dir).some((f) => f.buf.includes(needle));
}

function cleanupRuns() {
  for (const r of runs.splice(0)) removeDir(r.base);
}

module.exports = { SERVER, makeRun, openStore, listFiles, dataHolds, cleanupRuns, writeFiles, removeDir };
