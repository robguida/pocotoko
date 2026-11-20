'use strict';
// Test helper for the core meter (B2): sandbox layouts for plugin mode and copy-by-hand
// mode, transcripts built from the real-shape fixture, and folder listings. Everything
// lives under sandbox/test-tmp/ (never the OS temp folder, never a real config folder).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { makeTempDir, removeDir, REPO_TOP } = require('./tmpdir-sandbox.cjs');

const METER_SRC = path.join(REPO_TOP, 'src', 'core', 'hooks', 'meter.cjs');
const SESSION_START_SRC = path.join(REPO_TOP, 'src', 'core', 'hooks', 'session-start.cjs');
const ROUTING_SKILL_SRC = path.join(REPO_TOP, 'src', 'core', 'skills', 'model-routing', 'SKILL.md');
const FIXTURE = path.join(REPO_TOP, 'tests', 'fixtures', 'transcript-real-shape.jsonl');
const IS_WIN = process.platform === 'win32';

const made = [];
function cleanup() {
  for (const d of made.splice(0)) removeDir(d);
}

function mk(...parts) {
  const p = path.join(...parts);
  fs.mkdirSync(p, { recursive: true });
  return fs.realpathSync.native(p);
}

/**
 * A fresh sandbox: home, config folder, plugins folder, a project, a transcript folder.
 * name may hold spaces or non-ASCII letters (the "spaces and non-ASCII paths" case).
 */
function makeBase(name, { sub = null } = {}) {
  let base = fs.realpathSync.native(makeTempDir('meter-' + name));
  made.push(base);
  if (sub) base = mk(base, sub);
  const home = mk(base, 'home');
  const config = mk(base, 'config');
  const plugins = mk(config, 'plugins');
  const proj = mk(base, 'proj');
  const tdir = mk(base, 'transcripts');
  mk(base, 'tmp');
  return { base, home, config, plugins, proj, tdir };
}

/**
 * Plugin mode: both core scripts and the model-routing skill copied into the plugin cache
 * (the plugin root holds hooks/ and skills/), the data folder created.
 */
function pluginKit(b) {
  const root = mk(b.plugins, 'cache', 'mkt', 'kit', '0.1.0');
  const hooks = mk(root, 'hooks');
  const scriptFile = path.join(hooks, 'meter.cjs');
  fs.copyFileSync(METER_SRC, scriptFile);
  const startFile = path.join(hooks, 'session-start.cjs');
  fs.copyFileSync(SESSION_START_SRC, startFile);
  fs.copyFileSync(ROUTING_SKILL_SRC, path.join(mk(root, 'skills', 'model-routing'), 'SKILL.md'));
  const data = mk(b.plugins, 'data', 'kit-mkt');
  return { scriptFile, startFile, root, stateRoot: data, data };
}

/** Copy-by-hand mode: <kit>/hooks/meter.cjs and session-start.cjs; the state root is the kit folder. */
function copyKit(b, folder = 'kit') {
  const kit = mk(b.base, folder);
  const hooks = mk(kit, 'hooks');
  const scriptFile = path.join(hooks, 'meter.cjs');
  fs.copyFileSync(METER_SRC, scriptFile);
  const startFile = path.join(hooks, 'session-start.cjs');
  fs.copyFileSync(SESSION_START_SRC, startFile);
  return { scriptFile, startFile, stateRoot: kit, kit };
}

/** Copy-by-hand: the model-routing skill copied to <config>/skills/model-routing/SKILL.md (12.2 step 2). */
function copySkill(b, text = null) {
  const file = path.join(mk(b.config, 'skills', 'model-routing'), 'SKILL.md');
  if (text === null) fs.copyFileSync(ROUTING_SKILL_SRC, file);
  else fs.writeFileSync(file, text);
  return file;
}

function pluginEnv(b, kit, options = {}) {
  const env = { CLAUDE_CONFIG_DIR: b.config, CLAUDE_PLUGIN_DATA: kit.data, CLAUDE_PROJECT_DIR: b.proj };
  for (const [k, v] of Object.entries(options)) env['CLAUDE_PLUGIN_OPTION_' + k.toUpperCase()] = String(v);
  return env;
}

function copyEnv(b) {
  return { CLAUDE_CONFIG_DIR: b.config, CLAUDE_PROJECT_DIR: b.proj };
}

function ctxFor(b, kit, env, extra = {}) {
  return { env, scriptFile: kit.scriptFile, home: b.home, platform: process.platform, gitCeiling: b.base, ...extra };
}

const FIXTURE_TEXT = fs.readFileSync(FIXTURE, 'utf8');
const FIXTURE_LINES = FIXTURE_TEXT.split('\n').filter((l) => l !== '');
const ASSISTANT = JSON.parse(FIXTURE_LINES.find((l) => JSON.parse(l).type === 'assistant'));

/** One assistant record (the fixture's shape) with the given usage parts. */
function assistantLine({ input = 0, create = 0, read = 0, sidechain = false, usage = null } = {}) {
  const r = JSON.parse(JSON.stringify(ASSISTANT));
  r.isSidechain = sidechain;
  if (usage) r.message.usage = usage;
  else {
    r.message.usage.input_tokens = input;
    r.message.usage.cache_creation_input_tokens = create;
    r.message.usage.cache_read_input_tokens = read;
  }
  return JSON.stringify(r);
}

/** The fixture, then one more assistant record whose three-part sum is `size`. */
function transcriptText(size, { extra = [] } = {}) {
  return FIXTURE_LINES.concat([assistantLine({ input: 2, create: 0, read: size - 2 })], extra).join('\n') + '\n';
}

function writeTranscript(b, size, opts = {}) {
  const file = path.join(b.tdir, (opts.name || 'chat') + '.jsonl');
  fs.writeFileSync(file, typeof size === 'string' ? size : transcriptText(size, opts));
  return file;
}

function sessionId(n = 1) {
  // The number leads, so the first 8 characters (the note name's session part) differ.
  return String(n).padStart(8, '0') + '-0000-4000-8000-000000000000';
}

function promptInput(b, transcript, sid = sessionId(), extra = {}) {
  return { session_id: sid, transcript_path: transcript, cwd: b.proj, hook_event_name: 'UserPromptSubmit', prompt: 'x', ...extra };
}

/** Names, sizes and SHA-256 of every file under dir (links listed by their target text). */
function listing(dir) {
  const out = {};
  const walk = (d) => {
    let names = [];
    try { names = fs.readdirSync(d); } catch (_) { return; }
    for (const n of names.sort()) {
      const p = path.join(d, n);
      const rel = path.relative(dir, p).split(path.sep).join('/');
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[rel] = 'link:' + fs.readlinkSync(p);
      else if (st.isDirectory()) { out[rel + '/'] = 'dir'; walk(p); }
      else out[rel] = st.size + ':' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

/** A folder link: a junction on Windows (no admin rights needed), a symlink elsewhere. */
function dirLink(target, link) {
  fs.symlinkSync(target, link, IS_WIN ? 'junction' : 'dir');
  return link;
}

/** A file symlink, or null where the OS refuses (Windows without the right). */
function fileLink(target, link) {
  try {
    fs.symlinkSync(target, link, 'file');
    return link;
  } catch (_) {
    return null;
  }
}

function setMtime(file, msAgo, now = Date.now()) {
  const t = new Date(now - msAgo);
  fs.utimesSync(file, t, t);
}

module.exports = {
  METER_SRC, SESSION_START_SRC, ROUTING_SKILL_SRC, FIXTURE, FIXTURE_LINES, IS_WIN, REPO_TOP,
  cleanup, mk, makeBase, pluginKit, copyKit, copySkill, pluginEnv, copyEnv, ctxFor,
  assistantLine, transcriptText, writeTranscript, sessionId, promptInput,
  listing, dirLink, fileLink, setMtime,
};
