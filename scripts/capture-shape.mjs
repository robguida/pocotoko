// Real-format check (spec 6.8). Dev only, never shipped.
//
//   node scripts/capture-shape.mjs <transcript.jsonl> [--out <file>]
//       Writes the structure of a real transcript: record types, keys, usage keys and
//       numbers. Every text field and id is replaced (text "x", ids built from zeros,
//       models "model-<n>", the start folder "/work/project", one fixed timestamp),
//       the same form as tests/fixtures/transcript-real-shape.jsonl.
//   node scripts/capture-shape.mjs <transcript.jsonl> --compare <fixture.jsonl>
//       Fails when the shape the meter reads differs: the keys of main-thread
//       assistant records and every key path under their message.usage.
//
// A line that is not JSON is counted as failed; the rest still run (hard line 7).

import fs from 'node:fs';
import path from 'node:path';
import * as G from './lib/guard.mjs';
import { isMain } from './lib/is-main.mjs';

const REPO = G.kitRoot();

// String values kept as written: enumerations that carry no user text.
const KEEP = new Set(['type', 'role', 'operation', 'renderedRole', 'stop_reason', 'service_tier', 'speed', 'display', 'keep',
  'effort', 'perTurnEffort', 'permissionMode', 'promptSource', 'turnOrigin', 'querySource', 'userType', 'mode', 'madeBy',
  'promptCacheRequested', 'version', 'entrypoint', 'subtype', 'level']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_PREFIX = { id: 'message', requestId: 'request', shapeHash: 'shape', hash: 'blob', requestDigest: 'digest' };
const FIXTURE_MS = Date.UTC(2000, 0, 1);
// A key is kept only when it is shaped like a field name; any other key (a path, a URL, text
// used as a map key) becomes key-<n>. A kept enumeration value must look like one, else "x".
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SAFE_VALUE = /^[A-Za-z0-9_.:-]{1,40}$/;

export function makeCapturer() {
  const uuids = new Map();
  const ids = new Map();
  const models = new Map();
  const uuidFor = (v) => {
    if (!uuids.has(v)) uuids.set(v, '00000000-0000-4000-8000-' + (uuids.size + 1).toString(16).padStart(12, '0'));
    return uuids.get(v);
  };
  const idFor = (k, v) => {
    const key = k + '\0' + v;
    if (!ids.has(key)) ids.set(key, ID_PREFIX[k] + '-' + String(ids.size + 1).padStart(4, '0'));
    return ids.get(key);
  };
  const keys = new Map();
  const keyFor = (k) => {
    if (SAFE_KEY.test(k)) return k;
    if (!keys.has(k)) keys.set(k, 'key-' + (keys.size + 1));
    return keys.get(k);
  };
  const modelFor = (v) => {
    if (!models.has(v)) models.set(v, 'model-' + (models.size + 1));
    return models.get(v);
  };
  const str = (k, v) => {
    if (UUID.test(v)) return uuidFor(v.toLowerCase());
    if (k in ID_PREFIX) return idFor(k, v);
    if (k === 'model' || k === 'requestedModel') return modelFor(v);
    if (k === 'timestamp') return new Date(FIXTURE_MS).toISOString();
    if (k === 'cwd') return '/work/project';
    if (k === 'gitBranch') return 'main';
    if (k === 'inference_geo') return 'region';
    if (k === 'atis') return '';
    if (KEEP.has(k)) return SAFE_VALUE.test(v) ? v : 'x';
    return 'x';
  };
  const walk = (v, k = '', parentKey = '') => {
    if (Array.isArray(v)) return v.map((x) => walk(x, k, parentKey));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [kk, x] of Object.entries(v)) {
        const outKey = k === 'modelUsage' ? modelFor(kk) : keyFor(kk);
        o[outKey] = walk(x, kk, k);
      }
      return o;
    }
    if (typeof v === 'string') return str(k, v);
    if (k === 'startTime' && typeof v === 'number') return FIXTURE_MS;
    return v; // numbers, booleans, null: kept
  };
  return (record) => walk(record);
}

/** Capture a transcript's text. Returns { lines, records, failed }. */
export function captureText(text) {
  const cap = makeCapturer();
  const lines = [];
  let failed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { failed++; continue; }
    lines.push(JSON.stringify(cap(rec)));
  }
  return { lines, records: lines.length, failed };
}

function paths(v, prefix, out) {
  if (Array.isArray(v)) { v.forEach((x) => paths(x, prefix + '[]', out)); return out; }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { out.add(prefix + '.' + k); paths(x, prefix + '.' + k, out); }
  }
  return out;
}

/** The shape the meter reads: main-thread assistant record keys and usage key paths. */
export function meterShape(text) {
  const recordKeys = new Set();
  const usage = new Set();
  for (const line of text.split(/\r?\n/)) {
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; }
    if (!r || r.type !== 'assistant' || r.isSidechain === true) continue;
    for (const k of Object.keys(r)) recordKeys.add(k);
    if (r.message && r.message.usage) paths(r.message.usage, 'usage', usage);
  }
  return { recordKeys: [...recordKeys].sort(), usage: [...usage].sort() };
}

export function compareShapes(a, b) {
  const diff = [];
  for (const part of ['recordKeys', 'usage']) {
    const sa = new Set(a[part]);
    const sb = new Set(b[part]);
    for (const x of sa) if (!sb.has(x)) diff.push('only in the capture: ' + part + ' ' + x);
    for (const x of sb) if (!sa.has(x)) diff.push('only in the fixture: ' + part + ' ' + x);
  }
  return diff;
}

export function main(argv = process.argv.slice(2), out = process.stdout) {
  let file = null;
  let outFile = null;
  let compare = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') outFile = argv[++i];
    else if (argv[i] === '--compare') compare = argv[++i];
    else if (!file) file = argv[i];
    else { out.write('capture: unknown argument\n'); return 2; }
  }
  if (!file) { out.write('capture: give a transcript file\n'); return 2; }
  let text;
  try { text = fs.readFileSync(path.resolve(file), 'utf8'); } catch (err) { out.write('capture: the transcript could not be read (' + ((err && err.code) || 'error') + ')\n'); return 1; }
  const cap = captureText(text);
  const body = cap.lines.join('\n') + '\n';
  if (compare) {
    let fx;
    try { fx = fs.readFileSync(path.resolve(compare), 'utf8'); } catch (_) { out.write('capture: the fixture could not be read\n'); return 1; }
    const d = compareShapes(meterShape(body), meterShape(fx));
    out.write(d.length ? 'shape: differs\n' + d.map((x) => '  ' + x).join('\n') + '\n' : 'shape: same\n');
    out.write('capture: records ' + cap.records + ', failed ' + cap.failed + '\n');
    return d.length ? 1 : 0;
  }
  if (outFile) {
    const target = path.resolve(outFile);
    if (!G.isInside(target, REPO)) { out.write('capture: --out must be inside the repo\n'); return 2; }
    fs.writeFileSync(target, body);
    out.write('capture: records ' + cap.records + ', failed ' + cap.failed + '\n');
  } else {
    out.write(body);
  }
  return cap.failed ? 1 : 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = main();
}
