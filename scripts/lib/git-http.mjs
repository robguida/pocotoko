// Loopback git server for the install proof's git-source install (spec 14.6). Dev only, never shipped.
//
//   node scripts/lib/git-http.mjs <folder holding kit.git> <absolute path of git>
//
// Serves one bare repo, kit.git, read-only over plain HTTP on 127.0.0.1 through
// git's own `git http-backend` (git by its absolute path, fixed arguments, no
// shell). Prints "PORT <n>" once listening. Only fetches of kit.git are
// answered; pushes are refused. The folder must sit inside sandbox/. It exits
// when its stdin closes (the parent ended or stopped it) and after 10 idle minutes.

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import * as G from './guard.mjs';
import { cleanBaseEnv } from './dev-run.mjs';

const IDLE_MS = 10 * 60 * 1000;
const root = path.resolve(process.argv[2] || '');
const git = process.argv[3] || '';
if (!process.argv[2] || !G.isInside(root, G.sandboxDir()) || G.samePath(root, G.sandboxDir())) {
  process.stdout.write('git-http: the served folder must be inside sandbox/\n');
  process.exit(2);
}
let gitOk = false;
try { gitOk = path.isAbsolute(git) && fs.statSync(git).isFile(); } catch (_) { gitOk = false; }
if (!gitOk) {
  process.stdout.write('git-http: give the absolute path of git\n');
  process.exit(2);
}
// The sandbox git settings the parent's guard env set; nothing else from outside.
const gitConfig = process.env.GIT_CONFIG_GLOBAL || '';
if (!gitConfig || !G.isInside(path.resolve(gitConfig), G.sandboxDir())) {
  process.stdout.write('git-http: GIT_CONFIG_GLOBAL must point inside sandbox/\n');
  process.exit(2);
}
const baseEnv = { ...cleanBaseEnv(process.env), GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };

const ALLOWED = /^\/kit\.git\/(?:info\/refs|git-upload-pack|HEAD|objects\/[0-9a-f/]+|objects\/info\/[a-z-]+|objects\/pack\/pack-[0-9a-f]+\.(?:pack|idx))$/;

let idle = null;
function touch() {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => process.exit(0), IDLE_MS);
}

function handler(req, res) {
  touch();
  const u = new URL(req.url, 'http://127.0.0.1');
  const pathInfo = u.pathname;
  const service = u.searchParams.get('service');
  if (!ALLOWED.test(pathInfo) || (service !== null && service !== 'git-upload-pack')) {
    res.writeHead(403);
    res.end();
    return;
  }
  const env = {
    ...baseEnv,
    GIT_PROJECT_ROOT: root,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: pathInfo,
    QUERY_STRING: u.search.slice(1),
    REQUEST_METHOD: req.method,
    CONTENT_TYPE: req.headers['content-type'] || '',
    REMOTE_ADDR: '127.0.0.1',
  };
  if (req.headers['content-length']) env.CONTENT_LENGTH = req.headers['content-length'];
  if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = req.headers['content-encoding'];
  if (req.headers['git-protocol']) env.GIT_PROTOCOL = req.headers['git-protocol'];
  const p = spawn(git, ['http-backend'], { env, cwd: root, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  req.pipe(p.stdin);
  p.stdin.on('error', () => {});
  const chunks = [];
  p.stdout.on('data', (c) => chunks.push(c));
  p.on('error', () => { res.writeHead(500); res.end(); });
  p.on('close', () => {
    const buf = Buffer.concat(chunks);
    let sep = buf.indexOf('\r\n\r\n');
    let skip = 4;
    if (sep < 0) { sep = buf.indexOf('\n\n'); skip = 2; }
    if (sep < 0) { res.writeHead(500); res.end(); return; }
    let status = 200;
    const headers = {};
    for (const line of buf.slice(0, sep).toString('latin1').split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k.toLowerCase() === 'status') status = parseInt(v, 10) || 200;
      else headers[k] = v;
    }
    res.writeHead(status, headers);
    res.end(buf.slice(sep + skip));
  });
}

process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();
const server = http.createServer(handler);
server.listen(0, '127.0.0.1', () => { touch(); process.stdout.write('PORT ' + server.address().port + '\n'); });
