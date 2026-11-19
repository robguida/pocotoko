'use strict';
// Test helper: temp folders under the repo's gitignored sandbox/test-tmp/.
// Never uses the OS temp folder.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_TOP = path.resolve(__dirname, '..', '..');
const TEST_TMP = path.join(REPO_TOP, 'sandbox', 'test-tmp');

function makeTempDir(name) {
  const safe = String(name).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) || 'tmp';
  const dir = path.join(TEST_TMP, `${safe}-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function removeDir(dir) {
  // Only ever removes something inside sandbox/test-tmp.
  const resolved = path.resolve(dir);
  const rel = path.relative(TEST_TMP, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
    return true;
  } catch (_) {
    return false;
  }
}

function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

module.exports = { REPO_TOP, TEST_TMP, makeTempDir, removeDir, writeFiles };
