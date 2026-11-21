'use strict';
// The store: manifest, chunks.jsonl, lock, purge and rebuild (spec 7.4, 9.6,
// 9.7, 9.11, 9.12, SR-14, SR-16, SR-19 to SR-25, SR-49).
//
// This is the swap point of 7.4. Its interface is load(), upsert(file, chunks),
// purge(file) and rank(query, options); a later backend must keep it.
//
// On disk, one folder per project: <data root>/indexes/<16 hex>/ with
// manifest.json, chunks.jsonl and, while a process writes, `lock`. A file
// skipped by the floor, a never-list or a scan hit leaves no record on disk.
// The inverted index is rebuilt in memory from chunks.jsonl at start.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fsx = require('./fsx.cjs');
const floor = require('./floor.cjs');
const ignoreMod = require('./ignore.cjs');
const walker = require('./walker.cjs');
const scan = require('./scan.cjs');
const chunker = require('./chunker.cjs');
const markers = require('./markers.cjs');
const tokenize = require('./tokenize.cjs');
const indexMod = require('./index.cjs');
const rankMod = require('./rank.cjs');

const SCHEMA_VERSION = 1;
const LIMITS = Object.freeze({
  entries: walker.MAX_ENTRIES,
  files: 20000,
  textBytes: 64 * 1024 * 1024,
  chunksSoft: 10000,
  chunksHard: 50000,
});
const STAT_BUDGET_MS = 300;
const LOCK_REFRESH_MS = 30 * 1000;
const LOCK_STALE_MS = 120 * 1000;
const MAX_OWN_FILE_BYTES = 512 * 1024 * 1024;
const MAX_LOCK_BYTES = 4096;
const YIELD_EVERY_FILES = 16;
// Loading a stored index in the background (openInBackground): the work is cut
// into slices of about this many milliseconds, so the server answers protocol
// messages (initialize, tools/list) between them (SR-46, B7 review).
const LOAD_SLICE_MS = 10;
const PROCESS_START = Date.now();

const MANIFEST = 'manifest.json';
const CHUNKS = 'chunks.jsonl';
const LOCK = 'lock';
const OFF_FILE = 'OFF';
// The only files the store writes through a temp file, and only in the index
// folder; temp cleanup there removes leftovers of these base names only.
const INDEX_TEMP_BASES = Object.freeze([MANIFEST, CHUNKS]);

const INCOMPLETE_LINE = 'index incomplete: project over the size cap; narrow it with your exclude options';
const LARGE_PROJECT_LINE = 'large project';
// SR-21: the two fixed lines (the server shows them in status and on every result).
const IN_GIT_LINE = 'Search is off: your Claude config folder is inside a git repo, so search stores nothing there. Move the config folder out of the repo to turn it on.';
const IN_PROJECT_LINE = 'Search is off: your Claude config folder is inside this project, so search stores nothing there. Move the config folder out of the project to turn it on.';

function namedError(name) {
  const e = new Error(name);
  e.name = name;
  return e;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function yieldNow() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Run a step generator to its end at once and return its value. */
function drain(gen) {
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

/** Run a step generator in slices of about LOAD_SLICE_MS, yielding to the event loop between slices. */
async function drainInSlices(gen) {
  let last = Date.now();
  let r = gen.next();
  while (!r.done) {
    if (Date.now() - last >= LOAD_SLICE_MS) {
      await yieldNow();
      last = Date.now();
    }
    r = gen.next();
  }
  return r.value;
}

/** Folder name of a project's index: the first 16 hex of the SHA-256 of its real path (SR-20). */
function indexFolderName(rootReal) {
  return sha256(Buffer.from(rootReal, 'utf8')).slice(0, 16);
}

/** Real path of p; parts that do not exist yet are kept as written on top of the nearest real parent. */
function realpathLoose(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch (_) {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = up;
    }
  }
}

/**
 * True when a `.git` file or folder is found in p or any folder above it (6.7).
 * Fails closed: a check that fails with anything other than not-found (ENOENT,
 * ENOTDIR) counts as found, so nothing is written. ceiling: test-only seam; the
 * walk up stops after that folder (the tests run inside the repo's own work
 * tree). _lstat: test-only seam.
 */
function inGitWorkTree(p, ceiling = null, _lstat = fs.lstatSync) {
  let cur = path.resolve(p);
  for (;;) {
    try {
      _lstat(path.join(cur, '.git'));
      return true;
    } catch (err) {
      if (!(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))) return true;
    }
    if (ceiling && fsx.samePath(cur, ceiling)) return false;
    const up = path.dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

/** SR-21: null, or 'in_git' / 'in_project' for an index folder location. */
function locationProblem(indexDir, rootReal, ceiling = null) {
  const real = realpathLoose(indexDir);
  if (inGitWorkTree(real, ceiling)) return 'in_git';
  if (fsx.isInside(real, rootReal)) return 'in_project';
  return null;
}

function bump(map, key, n = 1) {
  map[key] = (map[key] || 0) + n;
}

/**
 * Create the store for one bound project.
 *
 * opts: {
 *   dataRoot, rootReal, options (raw user options), globalExcludes,
 *   gitCeiling (test-only seam: where the upward .git search stops),
 *   limits (test-only seam), clock { now }, identity { pid, start } (test-only),
 *   hooks { beforeOpen, beforeUpsert, beforeWrite, failWriteAfterTemp, scanThrowOn, afterFolder,
 *           beforeLoad, onLoadRecord, afterLoad } (all test-only),
 *   platform, uid (test-only seam for the owner check),
 *   rulesVersion (test-only: stands in for floor.RULES_VERSION),
 *   ignorePlatform (test-only: the platform the ignore matcher folds case for),
 *   offLstat (test-only: stands in for fs.lstatSync in the OFF file check)
 * }
 */
function createStore(opts) {
  const rootReal = opts.rootReal;
  const options = opts.options || {};
  const limits = { ...LIMITS, ...(opts.limits || {}) };
  const clock = opts.clock || { now: Date.now };
  const identity = opts.identity || { pid: process.pid, start: PROCESS_START };
  const hooks = opts.hooks || {};
  const platform = opts.platform || process.platform;
  const lockToken = { pid: identity.pid, start: identity.start, nonce: crypto.randomBytes(8).toString('hex') };
  const rulesVersion = opts.rulesVersion || floor.RULES_VERSION; // opts.rulesVersion: test-only seam
  const offLstat = typeof opts.offLstat === 'function' ? opts.offLstat : fs.lstatSync; // opts.offLstat: test-only seam

  const st = {
    off: null, // reason when off (location, folder checks)
    dataReal: null,
    indexDir: null,
    loaded: false,
    everBuilt: false,
    rebuild: null, // { reason, done, reset } while a full rebuild is pending
    pendingWrite: false, // a write that was needed but did not land; retried by the next run (SR-25)
    notice: null, // one-time line for the next search result
    running: null,
    opening: null, // the background load of openInBackground(), while it runs
    lastRefresh: null,
    lastRun: null,
    warnings: [],
    folderChecks: null,
    lastDelete: null, // counts of the last index-folder delete: { removed, failed, left, refused }
    lock:{ held: false, lastTouch: 0 },
    counters: { reads: 0, hashes: 0, scans: 0, writes: 0 },
    indexedAt: null, // when the index in memory was last written (or the loaded manifest's built_at)
  };
  let filter = floor.buildFilter(options);
  // Query-time options (matching, word_families, synonyms): they act on the
  // in-memory index only, so they are not part of the options hash and a
  // change needs no rebuild (9.5 e).
  const queryOpts = rankMod.queryOptions(options);
  let manifest = { files: {} };
  let records = new Map(); // rel -> stored chunk records
  let index = indexMod.createIndex();

  // -------------------------------------------------------------------------
  // Opening

  function ensureFolders() {
    const dataRoot = path.resolve(opts.dataRoot);
    const problem = locationProblem(path.join(dataRoot, 'indexes', indexFolderName(rootReal)), rootReal, opts.gitCeiling);
    if (problem) {
      st.off = problem;
      return false;
    }
    try {
      try {
        fs.mkdirSync(dataRoot, { mode: fsx.DIR_MODE });
      } catch (err) {
        if (!err || err.code !== 'EEXIST') throw namedError('data_root_unavailable');
      }
      const lst = fs.lstatSync(dataRoot);
      if (lst.isSymbolicLink() || !lst.isDirectory()) throw namedError('data_root_unsafe');
      st.dataReal = fs.realpathSync.native(dataRoot);
      const indexes = fsx.ensureDir(st.dataReal, 'indexes', platform);
      st.indexDir = fsx.ensureDir(indexes, indexFolderName(rootReal), platform);
    } catch (err) {
      st.off = (err && err.name === 'FsxError') ? err.code : ((err && err.name) || 'data_root_unavailable');
      return false;
    }
    const perms = fsx.checkPermissions(st.dataReal, { platform, uid: opts.uid });
    st.folderChecks = perms.ok ? (perms.skipped ? 'skipped' : 'passed') : 'failed';
    if (!perms.ok) {
      st.off = 'folder_checks_failed';
      return false;
    }
    // Only the index folder ever holds the store's temp files (SR-24).
    cleanIndexTemps({ now: clock.now() });
    return true;
  }

  /** The parts of this project's index folder below the data root. */
  function indexParts() {
    return ['indexes', indexFolderName(rootReal)];
  }

  /**
   * Null when the index folder still passes the SR-24 folder check (not a link,
   * real path equal to the path built from the data root's real path); else a
   * problem code. Run before every list, delete, lock create, lock touch and
   * lock removal in the folder.
   */
  function indexFolderProblem() {
    if (!st.dataReal || !st.indexDir) return 'not_open';
    const c = fsx.checkedFolder(st.dataReal, indexParts(), platform);
    if (c.problem) return c.problem;
    return fsx.samePath(c.dir, st.indexDir, platform) ? null : 'moved';
  }

  function cleanIndexTemps(extra) {
    return fsx.cleanTemps(st.dataReal, indexParts(), { bases: INDEX_TEMP_BASES, platform, ...extra });
  }

  /**
   * 9.6: the emergency OFF file. Fails closed: only not-found (ENOENT, ENOTDIR)
   * means there is no OFF file; any other lstat error counts as off.
   */
  function isOff() {
    if (st.off) return st.off;
    if (!st.dataReal) return null;
    try {
      offLstat(path.join(st.dataReal, OFF_FILE));
      return 'off_file';
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
      return 'off_file';
    }
  }

  // -------------------------------------------------------------------------
  // Load and rebuild

  function resetMemory() {
    manifest = { files: {} };
    records = new Map();
    index = indexMod.createIndex();
  }

  /**
   * Empty only this project's index folder (SR-25, 9.6 c). Called only by the
   * lock holder, so it keeps the holder's own lock file. The folder is checked
   * first (a link, a junction or a moved folder is refused, and nothing in it
   * is touched), and again before each delete; a check that fails at any
   * point refuses the delete. Never recursive: a file is unlinked, a link is
   * removed as a link only, and a folder inside is removed with rmdir only, so
   * an empty folder (or a junction lstat does not report) goes and a folder
   * that is not empty is left and counted (the store never creates folders
   * here). One failing item never stops the rest. The counts
   * { removed, failed, left, refused } are recorded in st.lastDelete.
   * Returns true when the folder check held throughout, false when refused.
   */
  function deleteIndexFolder() {
    const out = { removed: 0, failed: 0, left: 0, refused: null };
    st.lastDelete = out;
    const first = indexFolderProblem();
    if (first) { out.refused = first; return false; }
    const dir = st.indexDir;
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { names = []; }
    for (const n of names) {
      if (n === LOCK && st.lock.held) continue;
      const p = path.join(dir, n);
      // Checked again before each delete; a failed check refuses the delete,
      // and no item is touched through that folder.
      const again = indexFolderProblem();
      if (again) {
        if (!out.refused) out.refused = again;
        out.failed++;
        continue;
      }
      try {
        const s = fs.lstatSync(p);
        if (s.isSymbolicLink()) {
          // Only the link itself goes, never its target.
          try { fs.unlinkSync(p); } catch (_) { fs.rmdirSync(p); }
        } else if (s.isDirectory()) {
          fs.rmdirSync(p); // empty folder or a link in disguise only; never recursive
        } else {
          fs.unlinkSync(p);
        }
        out.removed++;
      } catch (err) {
        if (err && (err.code === 'ENOTEMPTY' || err.code === 'EEXIST')) out.left++;
        else out.failed++;
      }
    }
    return out.refused === null;
  }

  function readJsonFile(name) {
    // Read only through a folder that passes the check; a failed check reads as corrupt.
    const why = indexFolderProblem();
    if (why === 'missing') return { absent: true };
    if (why) throw namedError('index_folder_unsafe');
    const r = fsx.readOwnFile(path.join(st.indexDir, name), MAX_OWN_FILE_BYTES);
    if (r.absent) return { absent: true };
    if (!r.buf) return { corrupt: true };
    return { buf: r.buf };
  }

  /**
   * Read and check the files on disk: { status: 'empty' | 'loaded' | reason, man, recs }.
   * A step generator: it yields between steps (and after each stored line), so
   * a caller may run it at once (load) or in slices (openInBackground). The
   * two file reads stay one step each: fsx.readOwnFile is the one-handle read
   * with its checks, and it is synchronous.
   */
  function* readIndexSteps() {
    let m;
    let c;
    try {
      m = readJsonFile(MANIFEST);
      c = readJsonFile(CHUNKS);
    } catch (_) {
      return { status: 'corrupt' };
    }
    if (m.absent && c.absent) return { status: 'empty' };
    if (m.absent || c.absent || m.corrupt || c.corrupt) return { status: 'corrupt' };
    yield;
    let man;
    try {
      man = JSON.parse(m.buf.toString('utf8'));
    } catch (_) {
      return { status: 'corrupt' };
    }
    if (!man || typeof man !== 'object' || !man.files || typeof man.files !== 'object') return { status: 'corrupt' };
    if (man.schema_version !== SCHEMA_VERSION) return { status: 'schema_changed' };
    if (man.tokenizer_version !== tokenize.TOK_VERSION) return { status: 'tokenizer_changed' };
    if (man.rules_version !== rulesVersion) return { status: 'rules_changed' };
    if (man.options_hash !== filter.optionsHash) return { status: 'options_changed' };
    yield;
    if (man.chunks_sha256 !== sha256(c.buf)) return { status: 'corrupt' };
    yield;
    const recs = new Map();
    try {
      const text = c.buf.toString('utf8');
      for (const line of text.split('\n')) {
        if (line === '') continue;
        const r = JSON.parse(line);
        if (!r || typeof r.key !== 'string' || typeof r.path !== 'string' || typeof r.text !== 'string'
          || !Object.prototype.hasOwnProperty.call(man.files, r.path)) throw namedError('corrupt');
        if (!recs.has(r.path)) recs.set(r.path, []);
        recs.get(r.path).push(r);
        yield;
      }
    } catch (_) {
      return { status: 'corrupt' };
    }
    return { status: 'loaded', man, recs };
  }

  /**
   * load(): read manifest.json and chunks.jsonl and build the in-memory index.
   * Returns 'empty' | 'loaded' | a rebuild reason.
   *
   * A process without the lock only reads (SR-49 a): on a bad or out-of-date
   * index it records "rebuild needed" in memory and deletes nothing, because
   * what it saw may be a writer caught between its two renames. Only the lock
   * holder (`locked`) empties the folder, and it reads the files again first.
   */
  function load(opts) {
    return drain(loadSteps(opts));
  }

  /** load() as a step generator (see readIndexSteps). */
  function* loadSteps({ locked = false } = {}) {
    resetMemory();
    let r = yield* readIndexSteps();
    if (r.status === 'loaded') {
      // A throw while the in-memory index is built (B7 review) must never leave
      // part of it behind: `records` and `manifest` would list every file while
      // the index held only some chunks, and the next refresh would see every
      // file as unchanged and report `fresh` with chunks missing. Memory is
      // emptied and the index is treated as corrupt, so it is rebuilt in full.
      let built = false;
      try {
        manifest = { files: r.man.files };
        records = r.recs;
        st.indexedAt = Number.isFinite(r.man.built_at) ? r.man.built_at : null;
        for (const list of records.values()) {
          for (const rec of list) {
            if (hooks.onLoadRecord) hooks.onLoadRecord(); // test-only: a slow load, or a throw
            index.add(rec);
            yield;
          }
        }
        index.prepare(); // sorted words and length buckets ready before the first query
        built = true;
      } catch (_) {
        resetMemory();
        st.indexedAt = null;
      }
      if (built) {
        st.everBuilt = true;
        // A rebuild only recorded (never started) is not needed any more.
        if (st.rebuild && !st.rebuild.done && !st.rebuild.reset) st.rebuild = null;
        return 'loaded';
      }
      r = { status: 'corrupt' };
    }
    if (r.status === 'empty') return 'empty';
    let reset = false;
    if (locked) {
      if (!deleteIndexFolder()) throw namedError('index_folder_unsafe');
      reset = true;
    }
    st.rebuild = { reason: r.status, done: false, reset };
    return r.status;
  }

  // -------------------------------------------------------------------------
  // Swap-point interface

  function purge(rel) {
    const list = records.get(rel);
    if (list) for (const r of list) index.remove(r.key);
    records.delete(rel);
    const had = Object.prototype.hasOwnProperty.call(manifest.files, rel);
    delete manifest.files[rel];
    return !!list || had;
  }

  function upsert(rel, chunks, meta) {
    const old = records.get(rel);
    if (old) for (const r of old) index.remove(r.key);
    const stored = chunks.map(chunker.storedRecord);
    records.set(rel, stored);
    for (const r of stored) index.add(r);
    if (meta) manifest.files[rel] = { size: meta.size, mtimeNs: meta.mtimeNs, sha256: meta.sha256 };
  }

  function rank(query, rankOptions = {}) {
    if (st.rebuild && !st.rebuild.done) throw namedError('IndexRebuilding');
    const parsed = typeof query === 'string' ? tokenize.parseQuery(query) : query;
    const merged = { matching: queryOpts.matching, wordFamilies: queryOpts.wordFamilies, synonyms: queryOpts.synonyms };
    for (const [key, v] of Object.entries(rankOptions)) if (v !== undefined) merged[key] = v;
    return rankMod.rank(index, parsed, merged);
  }

  // -------------------------------------------------------------------------
  // Lock (SR-49 a)

  const lockPath = () => path.join(st.indexDir, LOCK);

  function readLock() {
    if (indexFolderProblem()) return null; // a swapped folder never holds this process's lock
    try {
      const r = fsx.readOwnFile(lockPath(), MAX_LOCK_BYTES);
      if (!r.buf) return null;
      return JSON.parse(r.buf.toString('utf8'));
    } catch (_) {
      return null;
    }
  }

  function holdsLock() {
    const l = readLock();
    return !!l && l.pid === lockToken.pid && l.start === lockToken.start && l.nonce === lockToken.nonce;
  }

  function createLock() {
    const why = indexFolderProblem();
    if (why) throw namedError('index_folder_' + why);
    const fd = fs.openSync(lockPath(), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0), fsx.FILE_MODE);
    try {
      fs.writeSync(fd, JSON.stringify(lockToken));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  function removeLockPath() {
    // The lock path itself only: a link is removed as a link, never its target.
    // Never through a folder that fails the check.
    if (indexFolderProblem()) return;
    try { fs.unlinkSync(lockPath()); return; } catch (_) { /* maybe a folder link */ }
    try { fs.rmdirSync(lockPath()); } catch (_) { /* gone */ }
  }

  function lockIsStale() {
    let s;
    try { s = fs.lstatSync(lockPath()); } catch (_) { return true; }
    if (s.isSymbolicLink() || !s.isFile()) return true;
    return clock.now() - s.mtimeMs > LOCK_STALE_MS;
  }

  function acquireLock() {
    if (indexFolderProblem()) return false;
    try {
      createLock();
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return false;
      if (!lockIsStale()) return false;
      removeLockPath();
      try { createLock(); } catch (_) { return false; }
    }
    st.lock.held = true;
    st.lock.lastTouch = clock.now();
    touchLock(true);
    // Right after taking the lock: remove every leftover temp file here, of any age.
    cleanIndexTemps({ maxAgeMs: 0 });
    return true;
  }

  function touchLock(force) {
    const now = clock.now();
    if (!force && now - st.lock.lastTouch < LOCK_REFRESH_MS) return false;
    if (indexFolderProblem()) return false;
    let fd = null;
    try {
      const s = fs.lstatSync(lockPath());
      if (s.isSymbolicLink() || !s.isFile()) return false;
      fd = fs.openSync(lockPath(), fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
      fs.futimesSync(fd, now / 1000, now / 1000);
      st.lock.lastTouch = now;
      return true;
    } catch (_) {
      return false;
    } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
  }

  function releaseLock() {
    if (st.lock.held && holdsLock()) removeLockPath();
    st.lock.held = false;
  }

  // -------------------------------------------------------------------------
  // Writing

  function writeAll() {
    const paths = [...records.keys()].sort();
    const lines = [];
    for (const p of paths) for (const r of records.get(p)) lines.push(JSON.stringify(r));
    const chunksBuf = Buffer.from(lines.length ? lines.join('\n') + '\n' : '', 'utf8');
    const files = {};
    for (const p of Object.keys(manifest.files).sort()) files[p] = manifest.files[p];
    const man = {
      schema_version: SCHEMA_VERSION,
      tokenizer_version: tokenize.TOK_VERSION,
      rules_version: rulesVersion,
      options_hash: filter.optionsHash,
      chunks_sha256: sha256(chunksBuf),
      built_at: clock.now(),
      files,
    };
    if (hooks.beforeWrite) hooks.beforeWrite();
    if (locationProblem(st.indexDir, rootReal, opts.gitCeiling)) throw namedError('location_refused'); // SR-21: before every write
    const common = { dir: st.indexDir, expectedDir: st.indexDir, beforeRename: holdsLock, platform };
    fsx.atomicWrite({ ...common, name: CHUNKS, data: chunksBuf, _failAfterTemp: !!hooks.failWriteAfterTemp });
    fsx.atomicWrite({ ...common, name: MANIFEST, data: JSON.stringify(man) });
    st.counters.writes++;
    st.indexedAt = man.built_at;
  }

  // -------------------------------------------------------------------------
  // Refresh: walk, stat pass, read, chunk, scan, mark, upsert, purge, write.

  async function runRefresh() {
    // Files visited add up: succeeded + failed + skipped (by rule) = visited.
    // Folder-level counts (skipped folders, folders that could not be listed,
    // unparseable ignore files) are kept apart, because they are not files.
    const run = {
      succeeded: 0, failed: 0, failedBy: {}, skipped: {}, skippedDirs: {}, failedDirs: {}, ignoreProblems: {}, visited: 0,
      incomplete: null, readOnly: false, lockLost: false, wrote: false, dropped: {}, suspect_mark: 0,
    };
    const off = isOff();
    if (off) { run.off = off; return run; }
    const problem = locationProblem(st.indexDir, rootReal, opts.gitCeiling);
    if (problem) { st.off = problem; run.off = problem; return run; }
    // SR-24: an index folder swapped for a link or junction turns search off;
    // nothing is listed, locked, read or written through it.
    const folderWhy = indexFolderProblem();
    if (folderWhy && folderWhy !== 'missing') {
      st.folderChecks = 'failed';
      st.off = 'index_folder_' + folderWhy;
      run.off = st.off;
      return run;
    }

    if (!acquireLock()) {
      run.readOnly = true;
      const r = load();
      if (r === 'loaded' || r === 'empty') st.loaded = true;
      return run;
    }
    let dirty = false;
    try {
      // A rebuild recorded without the lock: read again now that this process
      // holds it, and empty the folder only if the index is still bad.
      if (st.rebuild && !st.rebuild.done && !st.rebuild.reset) {
        try {
          load({ locked: true });
        } catch (err) {
          st.off = (err && err.name) || 'index_folder_unsafe';
          if (/^index_folder_/.test(st.off)) st.folderChecks = 'failed';
          run.off = st.off;
          return run;
        }
      }
      const ig = ignoreMod.createIgnore(rootReal, { globalExcludes: opts.globalExcludes, ceiling: opts.gitCeiling, platform: opts.ignorePlatform });
      const w = await walker.walk(rootReal, { filter, ignore: ig, maxEntries: limits.entries, hooks: { afterFolder: hooks.afterFolder } });
      run.visited = w.visited;
      for (const [k, v] of Object.entries(w.skipped)) bump(run.skipped, k, v);
      for (const [k, v] of Object.entries(w.skippedDirs)) bump(run.skippedDirs, k, v);
      for (const [k, v] of Object.entries(w.failed)) { run.failed += v; bump(run.failedBy, k, v); }
      for (const [k, v] of Object.entries(w.failedDirs)) bump(run.failedDirs, k, v);
      if (w.incomplete) run.incomplete = w.incomplete;
      if (ig.ignoreAll) st.warnings = [ig.ignoreAll];
      else st.warnings = [];
      for (const [k, v] of Object.entries(ig.problems)) if (v) bump(run.ignoreProblems, k, v);

      const seen = new Set();
      let indexedFiles = 0;
      let textBytes = 0;
      let chunkCount = 0;
      let stopped = false;
      for (let i = 0; i < w.files.length; i++) {
        const f = w.files[i];
        if (stopped) { bump(run.skipped, 'size_cap'); continue; }
        if (i % YIELD_EVERY_FILES === 0) await yieldNow();
        touchLock(false);
        if (indexedFiles >= limits.files || textBytes + f.size > limits.textBytes) {
          stopped = true;
          run.incomplete = 'size_cap';
          bump(run.skipped, 'size_cap');
          continue;
        }
        try {
          const prev = manifest.files[f.rel];
          const prevChunks = records.get(f.rel);
          if (prev && prevChunks && prev.size === f.size && prev.mtimeNs === f.mtimeNs) {
            // Unchanged: not re-read.
            if (chunkCount + prevChunks.length > limits.chunksHard) {
              stopped = true; run.incomplete = 'size_cap'; bump(run.skipped, 'size_cap'); continue;
            }
            seen.add(f.rel);
            indexedFiles++;
            textBytes += f.size;
            chunkCount += prevChunks.length;
            run.succeeded++;
            continue;
          }
          const got = walker.readFile(f, { filter, hooks: { beforeOpen: hooks.beforeOpen } });
          st.counters.reads++;
          if (got.rule) { bump(run.skipped, got.rule); continue; }
          if (got.fail) { run.failed++; bump(run.failedBy, got.fail); continue; }
          if (prev && prevChunks && prev.sha256 === got.sha256) {
            // New modified time, same bytes: re-hashed, not re-scanned.
            st.counters.hashes++;
            if (chunkCount + prevChunks.length > limits.chunksHard) {
              stopped = true; run.incomplete = 'size_cap'; bump(run.skipped, 'size_cap'); continue;
            }
            manifest.files[f.rel] = { size: f.size, mtimeNs: f.mtimeNs, sha256: got.sha256 };
            seen.add(f.rel);
            dirty = true;
            indexedFiles++;
            textBytes += f.size;
            chunkCount += prevChunks.length;
            run.succeeded++;
            continue;
          }
          st.counters.scans++;
          const chunks = chunker.chunkText(f.rel, got.text);
          const res = scan.scanFile({
            relPath: f.rel, text: got.text, chunks, filter, now: clock.now,
            _throwOnChunk: hooks.scanThrowOn && hooks.scanThrowOn(f.rel) ? 0 : -1,
          });
          if (res.fileRule) { bump(run.skipped, res.fileRule); continue; }
          for (const [k, v] of Object.entries(res.dropped)) bump(run.dropped, k, v);
          const marked = markers.applyMarks(res.kept);
          run.suspect_mark += marked.counts.suspect_mark;
          if (chunkCount + marked.chunks.length > limits.chunksHard) {
            stopped = true; run.incomplete = 'size_cap'; bump(run.skipped, 'size_cap'); continue;
          }
          if (hooks.beforeUpsert) hooks.beforeUpsert(f.rel);
          upsert(f.rel, marked.chunks, { size: f.size, mtimeNs: f.mtimeNs, sha256: got.sha256 });
          seen.add(f.rel);
          dirty = true;
          indexedFiles++;
          textBytes += f.size;
          chunkCount += marked.chunks.length;
          run.succeeded++;
        } catch (err) {
          run.failed++;
          bump(run.failedBy, (err && (err.code || err.name)) || 'error');
        }
      }
      // Purge every file that is no longer indexed: deleted, now skipped,
      // failed, or past a size cap (SR-25, SR-49 c).
      for (const rel of new Set([...Object.keys(manifest.files), ...records.keys()])) {
        if (!seen.has(rel) && purge(rel)) dirty = true;
      }
      // Merge this run's new and dropped words into the sorted list and buckets
      // now, inside the refresh, not inside the next query's budget.
      index.prepare();
      run.chunks = chunkCount;
      run.files = indexedFiles;
      if (chunkCount > limits.chunksSoft) st.warnings.push(LARGE_PROJECT_LINE);
      if (run.incomplete) st.warnings.push(INCOMPLETE_LINE);
      // A write that failed or lost the lock in an earlier run is still owed:
      // purged text may still be on disk, so it is written again now (SR-25).
      if (dirty || st.pendingWrite || (st.rebuild && !st.rebuild.done) || !st.everBuilt) {
        try {
          writeAll();
          run.wrote = true;
          st.pendingWrite = false;
        } catch (err) {
          if (err && err.code === 'lock_lost') run.lockLost = true;
          run.writeError = (err && (err.code || err.name)) || 'error';
          st.pendingWrite = true;
        }
      }
      if (!run.lockLost && !run.writeError) {
        st.everBuilt = true;
        if (st.rebuild && !st.rebuild.done) {
          st.rebuild.done = true;
          st.notice = 'index rebuilt from source: ' + st.rebuild.reason;
        }
      }
      st.lastRefresh = clock.now();
    } finally {
      releaseLock();
    }
    st.lastRun = run;
    return run;
  }

  // -------------------------------------------------------------------------
  // Public

  /** Open: folders, checks, temp cleanup, load. Returns the state. */
  function open() {
    if (!ensureFolders()) return state();
    load(); // without the lock: reads only, never deletes (SR-49 a)
    st.loaded = true;
    return state();
  }

  /**
   * open() for the server (SR-46, B7 review): the folder checks run now; the
   * stored index is then loaded in the background, in slices of about
   * LOAD_SLICE_MS, so protocol messages are answered while a large index
   * loads. The state is `building` until it has loaded, and a refresh started
   * meanwhile waits for the load. Returns a promise of the state.
   */
  function openInBackground() {
    if (!ensureFolders()) return Promise.resolve(state());
    if (hooks.beforeLoad) hooks.beforeLoad(); // test-only seam
    const p = drainInSlices(loadSteps()) // without the lock: reads only (SR-49 a)
      .then(() => {
        if (hooks.afterLoad) hooks.afterLoad(); // test-only seam: a load that rejects
        st.loaded = true;
        return state();
      })
      .catch((err) => {
        // Any other throw in the load: nothing half-loaded stays in memory, and
        // a full rebuild is recorded, so no later refresh can report `fresh`
        // from it. The rejection still reaches the caller (the server turns it
        // into a fixed reason, 9.7).
        resetMemory();
        st.indexedAt = null;
        st.rebuild = { reason: 'corrupt', done: false, reset: false };
        throw err;
      })
      .finally(() => { if (st.opening === p) st.opening = null; });
    st.opening = p;
    return p;
  }

  function state() {
    const off = isOff();
    if (off) return 'off';
    if (st.rebuild && !st.rebuild.done) return 'rebuilding';
    if (!st.everBuilt) return 'building';
    if (st.running) return 'stale';
    return 'fresh';
  }

  /** The refresh tool: one at a time (SR-34). */
  function refresh() {
    if (st.running) return Promise.resolve({ already: true });
    // A refresh asked for while the stored index still loads runs after the load.
    const opening = st.opening;
    const run = opening ? opening.catch(() => {}).then(() => runRefresh()) : runRefresh();
    st.running = run.finally(() => { st.running = null; });
    return st.running;
  }

  /**
   * The stat pass before each search or get (9.7): start a refresh if none is
   * running and wait up to budgetMs. Returns the state after waiting.
   */
  async function ensureFresh(budgetMs = STAT_BUDGET_MS) {
    if (isOff()) return 'off';
    if (!st.running) refresh();
    const running = st.running;
    if (running && budgetMs > 0) {
      let timer = null;
      await Promise.race([
        running.catch(() => {}),
        new Promise((resolve) => { timer = setTimeout(resolve, budgetMs); }),
      ]);
      if (timer) clearTimeout(timer);
    }
    return state();
  }

  /** Wait for any running refresh. */
  async function idle() {
    while (st.running) {
      try { await st.running; } catch (_) { /* counted in the run */ }
    }
  }

  /**
   * Convenience for callers and tests: stat pass, then rank. Throws the named
   * error IndexRebuilding while a full rebuild has not finished.
   */
  async function search(query, { k, matching, wordFamilies, synonyms, includeRetired, statBudgetMs, budgetMs, now } = {}) {
    const s = await ensureFresh(statBudgetMs === undefined ? STAT_BUDGET_MS : statBudgetMs);
    if (s === 'off') return { state: 'off', reason: isOff(), results: [], hidden: [], hiddenCount: 0 };
    const parsed = tokenize.parseQuery(query);
    const r = rank(parsed, { k, matching, wordFamilies, synonyms, includeRetired, budgetMs, now });
    const notice = st.notice;
    st.notice = null;
    return { state: s, notice, ...r };
  }

  function getChunk(key) {
    const docId = index.docIdForKey(key);
    if (docId === null) return null;
    const doc = index.doc(docId);
    const list = records.get(doc.path) || [];
    return list.find((r) => r.key === key) || null;
  }

  /**
   * `get` re-checks its own file (9.7): re-stat it, re-test it and every folder
   * above it against the floor and the options (names, links, git-ignore, hard
   * links, size), and re-hash it when its size or modified time changed.
   * Returns { ok: true } or { ok: false, why } (why is a fixed code).
   */
  function recheck(rel) {
    const no = (why) => ({ ok: false, why });
    try {
      const prev = typeof rel === 'string' ? manifest.files[rel] : undefined;
      if (!prev) return no('not_indexed');
      const parts = rel.split('/');
      if (parts.some((p) => p === '' || p === '.' || p === '..')) return no('bad_path');
      if (walker.unsafeName(rel)) return no(floor.RULES.UNSAFE_NAME);
      const ig = ignoreMod.createIgnore(rootReal, { globalExcludes: opts.globalExcludes, ceiling: opts.gitCeiling, platform: opts.ignorePlatform });
      if (ig.ignoreAll) return no(floor.RULES.GIT_IGNORED);
      ig.loadFolder('', rootReal);
      let dirAbs = rootReal;
      let dirReal = rootReal;
      for (let i = 0; i < parts.length - 1; i++) {
        const name = parts[i];
        const relDir = parts.slice(0, i + 1).join('/');
        const abs = path.join(dirAbs, name);
        const s = fs.lstatSync(abs);
        if (s.isSymbolicLink() || !s.isDirectory()) return no(floor.RULES.LINK);
        const real = fs.realpathSync.native(abs);
        if (!fsx.samePath(real, path.join(dirReal, name), platform)) return no(floor.RULES.LINK);
        const rule = floor.folderRule(filter, name, relDir);
        if (rule) return no(rule);
        if (ig.isIgnored(relDir, true)) return no(floor.RULES.GIT_IGNORED);
        ig.loadFolder(relDir, abs);
        dirAbs = abs;
        dirReal = real;
      }
      const name = parts[parts.length - 1];
      const abs = path.join(dirAbs, name);
      const s = fs.lstatSync(abs, { bigint: true });
      if (s.isSymbolicLink()) return no(floor.RULES.LINK);
      if (!s.isFile()) return no(floor.RULES.SPECIAL);
      const fr = floor.fileRule(filter, name, rel);
      if (fr) return no(fr);
      if (ig.isIgnored(rel, false)) return no(floor.RULES.GIT_IGNORED);
      if (s.nlink > 1n) return no(floor.RULES.HARD_LINK);
      if (s.size > BigInt(filter.maxFileBytes)) return no(floor.RULES.TOO_BIG);
      const size = Number(s.size);
      const mtimeNs = s.mtimeNs.toString();
      if (size === prev.size && mtimeNs === prev.mtimeNs) return { ok: true };
      const got = walker.readFile({ rel, abs, size, dev: s.dev, ino: s.ino }, { filter });
      if (got.rule) return no(got.rule);
      if (got.fail) return no('read_failed');
      if (got.sha256 !== prev.sha256) return no('changed');
      return { ok: true };
    } catch (_) {
      return no('gone');
    }
  }

  /** Release the lock if this process holds it (the session is ending). */
  function close() {
    if (st.lock.held) releaseLock();
  }

  /** Totals only (SR-32). */
  function status() {
    const run = st.lastRun || {};
    let chunks = 0;
    for (const l of records.values()) chunks += l.length;
    return {
      state: state(),
      reason: isOff(),
      files: Object.keys(manifest.files).length,
      chunks,
      lastRefresh: st.lastRefresh,
      succeeded: run.succeeded || 0,
      failed: run.failed || 0,
      skipped: { ...(run.skipped || {}) },
      skippedDirs: { ...(run.skippedDirs || {}) },
      failedDirs: { ...(run.failedDirs || {}) },
      ignoreProblems: { ...(run.ignoreProblems || {}) },
      incomplete: run.incomplete || null,
      folderChecks: st.folderChecks,
      rebuild: st.rebuild ? { reason: st.rebuild.reason, done: st.rebuild.done } : null,
      warnings: st.warnings.slice(),
      filterCounts: { ...filter.counts },
      matching: queryOpts.matching,
      wordFamilies: queryOpts.wordFamilies,
      queryCounts: { bad_synonym: queryOpts.synonyms.bad },
    };
  }

  return {
    open,
    openInBackground,
    load,
    upsert,
    purge,
    rank,
    refresh,
    ensureFresh,
    idle,
    search,
    getChunk,
    recheck,
    close,
    status,
    state,
    get indexedAt() { return st.indexedAt; },
    get indexDir() { return st.indexDir; },
    get dataReal() { return st.dataReal; },
    get counters() { return { ...st.counters }; },
    _lock: { holdsLock, touchLock, lockIsStale, acquireLock, releaseLock },
    _test: { deleteIndexFolder, get pendingWrite() { return st.pendingWrite; }, get lastDelete() { return st.lastDelete; } },
  };
}

module.exports = {
  SCHEMA_VERSION,
  LIMITS,
  STAT_BUDGET_MS,
  LOAD_SLICE_MS,
  LOCK_REFRESH_MS,
  LOCK_STALE_MS,
  INCOMPLETE_LINE,
  LARGE_PROJECT_LINE,
  IN_GIT_LINE,
  IN_PROJECT_LINE,
  OFF_FILE,
  indexFolderName,
  inGitWorkTree,
  locationProblem,
  createStore,
};
