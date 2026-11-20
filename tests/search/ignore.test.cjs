'use strict';
// ignore.cjs (spec SR-10): T-5, the glob part of T-16, and the dev-only differential test
// against `git check-ignore` behaviour (fixed arguments, no shell, sandbox git settings).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Ig = require('../../src/search/server/ignore.cjs');
const { makeTempDir, removeDir, writeFiles } = require('../helpers/tmpdir-sandbox.cjs');

const made = [];
test.after(() => { for (const d of made) removeDir(d); });

function project(files) {
  const base = fs.realpathSync.native(makeTempDir('ignore'));
  made.push(base);
  const root = path.join(base, 'proj');
  fs.mkdirSync(root);
  writeFiles(root, files);
  return { base, root: fs.realpathSync.native(root) };
}

function matcher(p, extra = {}) {
  return Ig.createIgnore(p.root, { globalExcludes: null, ceiling: p.base, ...extra });
}

// Load every folder's .gitignore the way the walker does (top-down).
function loadAll(m, root) {
  const walk = (abs, rel) => {
    m.loadFolder(rel, abs);
    for (const n of fs.readdirSync(abs)) {
      const p = path.join(abs, n);
      if (n !== '.git' && fs.lstatSync(p).isDirectory()) walk(p, rel ? rel + '/' + n : n);
    }
  };
  walk(root, '');
  return m;
}

let canSymlink = null;
function symlinkOk(dir) {
  if (canSymlink !== null) return canSymlink;
  try {
    const t = path.join(dir, 'probe-target.txt');
    fs.writeFileSync(t, 'x');
    fs.symlinkSync(t, path.join(dir, 'probe-link.txt'), 'file');
    canSymlink = true;
  } catch (_) {
    canSymlink = false;
  }
  return canSymlink;
}

test('T-5: root and nested .gitignore files; a nested file applies only below its folder', () => {
  const p = project({
    '.gitignore': 'build-notes.md\n/top-only.md\nlogs/\n',
    'top-only.md': 'x', 'sub/top-only.md': 'x', 'sub/build-notes.md': 'x',
    'sub/.gitignore': 'local.md\n', 'sub/local.md': 'x', 'local.md': 'x',
  });
  const m = loadAll(matcher(p), p.root);
  assert.equal(m.isIgnored('top-only.md', false), true);
  assert.equal(m.isIgnored('sub/top-only.md', false), false); // anchored to the root
  assert.equal(m.isIgnored('sub/build-notes.md', false), true); // no slash: any depth
  assert.equal(m.isIgnored('sub/local.md', false), true);
  assert.equal(m.isIgnored('local.md', false), false);
  assert.equal(m.isIgnored('logs', true), true);
  assert.equal(m.isIgnored('logs', false), false); // trailing slash: folders only
});

test('T-5: a !negation line is not honoured', () => {
  const p = project({ '.gitignore': '*.md\n!keep.md\n', 'keep.md': 'x' });
  const m = loadAll(matcher(p), p.root);
  assert.equal(m.isIgnored('keep.md', false), true);
  assert.equal(m.problems.negations, 1);
});

test('T-5: an unparseable line, or syntax the matcher does not support, ignores everything at and below that folder', () => {
  for (const bad of ['\\#escaped.md', 'x[[:alpha:]]y', 'open[bracket']) {
    const p = project({ 'sub/.gitignore': 'fine.md\n' + bad + '\n', 'sub/a.md': 'x', 'b.md': 'x' });
    const m = loadAll(matcher(p), p.root);
    assert.equal(m.isIgnored('sub/a.md', false), true, bad);
    assert.equal(m.isIgnored('sub/deeper/c.md', false), true, bad);
    assert.equal(m.isIgnored('b.md', false), false, bad);
    assert.equal(m.problems.unparseable, 1);
  }
});

test('T-5: a pattern over 512 characters, or with more than 16 *, is unparseable', () => {
  for (const bad of ['a'.repeat(513), '*a'.repeat(17)]) {
    const p = project({ '.gitignore': bad + '\n', 'x.md': 'x' });
    const m = loadAll(matcher(p), p.root);
    assert.equal(m.isIgnored('x.md', false), true);
  }
  assert.ok(!Ig.compileGlob('*a'.repeat(16)).error);
  assert.equal(Ig.compileGlob('*a'.repeat(17)).error, 'too_many_stars');
  assert.equal(Ig.compileGlob('a'.repeat(513)).error, 'too_long');
});

test('T-5: a .gitignore over 1 MiB is unparseable', () => {
  const p = project({ '.gitignore': '#'.repeat(Ig.MAX_IGNORE_FILE_BYTES + 1), 'x.md': 'x' });
  const m = loadAll(matcher(p), p.root);
  assert.equal(m.isIgnored('x.md', false), true);
});

test('T-5: a .gitignore that is a link is unparseable and its target is never read', (t) => {
  const p = project({ 'x.md': 'x', 'sub/y.md': 'y' });
  if (!symlinkOk(p.base)) { t.skip('file symlinks need extra rights on this system'); return; }
  const target = path.join(p.base, 'outside-ignore.txt');
  fs.writeFileSync(target, 'nothing.md\n');
  fs.symlinkSync(target, path.join(p.root, 'sub', '.gitignore'), 'file');
  const m = loadAll(matcher(p), p.root);
  assert.equal(m.isIgnored('sub/y.md', false), true);
  assert.equal(m.isIgnored('x.md', false), false);
});

test('T-5: .git/info/exclude applies; present but unsafe → everything ignored; absent → no effect', (t) => {
  const p = project({ '.git/info/exclude': 'excluded.md\n', 'excluded.md': 'x', 'kept.md': 'x' });
  const m = loadAll(matcher(p), p.root);
  assert.equal(m.isIgnored('excluded.md', false), true);
  assert.equal(m.isIgnored('kept.md', false), false);

  const q = project({ '.git/HEAD': 'x', 'kept.md': 'x' });
  assert.equal(loadAll(matcher(q), q.root).isIgnored('kept.md', false), false);

  const r = project({ '.git/info/placeholder': '', 'kept.md': 'x' });
  fs.mkdirSync(path.join(r.root, '.git', 'info', 'exclude')); // a folder, not a regular file
  const mr = loadAll(matcher(r), r.root);
  assert.equal(mr.isIgnored('kept.md', false), true);
  assert.equal(mr.ignoreAll, 'info_exclude_unsafe');

  if (!symlinkOk(p.base)) { t.diagnostic('link case skipped: file symlinks need extra rights on this system'); return; }
  const s = project({ '.git/info/placeholder': '', 'kept.md': 'x' });
  const tgt = path.join(s.base, 'target.txt');
  fs.writeFileSync(tgt, 'other.md\n');
  fs.symlinkSync(tgt, path.join(s.root, '.git', 'info', 'exclude'), 'file');
  assert.equal(loadAll(matcher(s), s.root).ignoreAll, 'info_exclude_unsafe');
});

test('T-5: a worktree whose .git is a file reaches info/exclude through gitdir: and commondir', () => {
  const p = project({ 'a.md': 'x', 'b.md': 'x' });
  const common = path.join(p.base, 'main-git');
  const wt = path.join(common, 'worktrees', 'wt1');
  fs.mkdirSync(path.join(common, 'info'), { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(common, 'info', 'exclude'), 'a.md\n');
  fs.writeFileSync(path.join(wt, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(p.root, '.git'), 'gitdir: ' + wt + '\n');
  const m = loadAll(matcher(p), p.root);
  assert.equal(m.isIgnored('a.md', false), true);
  assert.equal(m.isIgnored('b.md', false), false);
});

test('a root below the work tree top: parent .gitignore files apply, and an ignored parent folder puts the root out', () => {
  const p = project({});
  const top = path.join(p.base, 'top');
  writeFiles(top, { '.git/HEAD': 'x', '.gitignore': '*.tmp.md\n', 'notes/a.md': 'x', 'drafts/a.md': 'x' });
  fs.writeFileSync(path.join(top, '.gitignore'), '*.tmp.md\ndrafts/\n');
  const notes = { base: p.base, root: fs.realpathSync.native(path.join(top, 'notes')) };
  const m = loadAll(matcher(notes), notes.root);
  assert.equal(m.isIgnored('x.tmp.md', false), true);
  assert.equal(m.isIgnored('a.md', false), false);
  const drafts = { base: p.base, root: fs.realpathSync.native(path.join(top, 'drafts')) };
  const md = loadAll(matcher(drafts), drafts.root);
  assert.equal(md.ignoreAll, 'root_ignored');
});

test('global excludes: applied when readable; unsafe or unparseable → not used and counted, never everything ignored', () => {
  const p = project({ 'a.md': 'x', 'b.notes.md': 'x' });
  const good = path.join(p.base, 'global-ignore');
  fs.writeFileSync(good, '*.notes.md\n');
  const m = loadAll(matcher(p, { globalExcludes: good }), p.root);
  assert.equal(m.isIgnored('b.notes.md', false), true);
  assert.equal(m.isIgnored('a.md', false), false);
  const bad = path.join(p.base, 'global-bad');
  fs.writeFileSync(bad, '\\#escaped\n');
  const mb = loadAll(matcher(p, { globalExcludes: bad }), p.root);
  assert.equal(mb.isIgnored('a.md', false), false);
  assert.equal(mb.problems.global_excludes_unread, 1);
  const folder = path.join(p.base, 'global-folder');
  fs.mkdirSync(folder);
  const mf = loadAll(matcher(p, { globalExcludes: folder }), p.root);
  assert.equal(mf.isIgnored('a.md', false), false);
  assert.equal(mf.problems.global_excludes_unread, 1);
  assert.equal(Ig.defaultGlobalExcludes({ XDG_CONFIG_HOME: p.base }), path.join(p.base, 'git', 'ignore'));
});

test('glob features: *, ?, **, bracket classes and anchoring', () => {
  const g = (p) => Ig.compileGlob(p);
  assert.equal(Ig.globMatches(g('*.md'), 'a/b/c.md', false), true);
  assert.equal(Ig.globMatches(g('doc?.md'), 'doc1.md', false), true);
  assert.equal(Ig.globMatches(g('docs/**/x.md'), 'docs/a/b/x.md', false), true);
  assert.equal(Ig.globMatches(g('docs/**/x.md'), 'docs/x.md', false), true);
  assert.equal(Ig.globMatches(g('/docs/*.md'), 'sub/docs/a.md', false), false);
  assert.equal(Ig.globMatches(g('*.py[cod]'), 'a.pyc', false), true);
  assert.equal(Ig.globMatches(g('[!a]*.md'), 'a.md', false), false);
  assert.equal(Ig.globMatches(g('[a-c]x.md'), 'bx.md', false), true);
  assert.equal(Ig.globMatches(g('*'), 'a/b', false), true);
});

test('case: on Windows and macOS matching ignores case (git core.ignorecase); on Linux it does not', () => {
  const p = project({ '.gitignore': 'Drafts/\n*.TMP.md\n[A-C]x.md\n', 'sub/.gitignore': 'Local.md\n' });
  for (const platform of ['win32', 'darwin', 'linux']) {
    const m = loadAll(matcher(p, { platform }), p.root);
    const fold = platform !== 'linux';
    assert.equal(m.foldsCase, fold, platform);
    assert.equal(m.isIgnored('drafts', true), fold, platform);
    assert.equal(m.isIgnored('Drafts', true), true, platform);
    assert.equal(m.isIgnored('notes/a.tmp.md', false), fold, platform);
    assert.equal(m.isIgnored('bx.md', false), fold, platform); // a bracket range folds too
    assert.equal(m.isIgnored('sub/local.md', false), fold, platform);
  }
  assert.equal(Ig.foldsCase('win32'), true);
  assert.equal(Ig.foldsCase('darwin'), true);
  assert.equal(Ig.foldsCase('linux'), false);
});

test('? and bracket classes match a whole code point, and the per-byte match (git\'s unit) is also applied', () => {
  const g = (p) => Ig.compileGlob(p);
  const astral = '\u{1f600}';
  // Per code point: one `?` is one character, even outside the BMP.
  assert.equal(Ig.globMatches(g('?.md'), astral + '.md', false), true);
  assert.equal(Ig.globMatches(g('[' + astral + ']x.md'), astral + 'x.md', false), true);
  assert.equal(Ig.globMatches(g('[!a].md'), astral + '.md', false), true);
  // Per byte, as git: `??` covers the two UTF-8 bytes of é, and `????` the four of an emoji.
  assert.equal(Ig.globMatches(g('??.md'), 'é.md', false), true);
  assert.equal(Ig.globMatches(g('????.md'), astral + '.md', false), true);
  assert.equal(Ig.globMatches(g('?.md'), 'é.md', false), true); // per code point
  assert.equal(Ig.globMatches(g('???.md'), 'é.md', false), false); // neither unit gives three
});

test('T-16 (globs): 16 * against a 240-character path stays within budget; a 17th * is unparseable', () => {
  const pattern = '*a'.repeat(16) + 'z';
  const g = Ig.compileGlob(pattern);
  assert.ok(!g.error);
  const p240 = ('ab/'.repeat(79) + 'abc').slice(0, 240);
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) Ig.globMatches(g, p240, false);
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(Ig.compileGlob('*a'.repeat(17)).error);
});

function gitAvailable() {
  try {
    return spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;
  } catch (_) {
    return false;
  }
}

test('T-5 differential (dev only): our ignored set is a superset of git\'s', (t) => {
  if (!gitAvailable()) { t.skip('git is not installed'); return; }
  const p = project({
    '.gitignore': '*.tmp.md\nbuild-out/\n/anchored.md\nnotes/**/secret-ish.md\n*.py[cod]\nCase-Dir/\nq??.md\n',
    'sub/.gitignore': 'local-*.md\n',
    'a.md': 'x', 'b.tmp.md': 'x', 'anchored.md': 'x', 'sub/anchored.md': 'x',
    'build-out/x.md': 'x', 'sub/local-1.md': 'x', 'sub/keep.md': 'x',
    'notes/a/b/secret-ish.md': 'x', 'notes/keep.md': 'x', 'm.pyc': 'x',
    // git ignores case on Windows and macOS (core.ignorecase), and matches `?` per byte.
    'case-dir/x.md': 'x', 'qé.md': 'x',
  });
  const gitHome = path.join(p.base, 'git-home');
  fs.mkdirSync(path.join(gitHome, 'xdg'), { recursive: true });
  const gitConfig = path.join(gitHome, 'gitconfig');
  fs.writeFileSync(gitConfig, '');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: gitHome,
    USERPROFILE: gitHome,
    XDG_CONFIG_HOME: path.join(gitHome, 'xdg'),
    GIT_TERMINAL_PROMPT: '0',
  };
  const run = (args) => spawnSync('git', args, { cwd: p.root, env, encoding: 'utf8', windowsHide: true });
  assert.equal(run(['init', '-q']).status, 0);
  fs.mkdirSync(path.join(p.root, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(p.root, '.git', 'info', 'exclude'), 'b.md\n');
  fs.writeFileSync(path.join(p.root, 'b.md'), 'x');
  const out = run(['ls-files', '--others', '--ignored', '--exclude-standard', '-z']);
  assert.equal(out.status, 0);
  const gitIgnored = out.stdout.split('\u0000').filter(Boolean);
  assert.ok(gitIgnored.length >= 6);
  const m = loadAll(matcher(p), p.root);
  const ours = (rel) => {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) if (m.isIgnored(parts.slice(0, i).join('/'), true)) return true;
    return m.isIgnored(rel, false);
  };
  for (const f of gitIgnored) assert.equal(ours(f), true, f);
  assert.equal(ours('a.md'), false);
  assert.equal(ours('sub/keep.md'), false);
  assert.equal(ours('qé.md'), true);
  assert.equal(ours('case-dir/x.md'), Ig.foldsCase());
});
