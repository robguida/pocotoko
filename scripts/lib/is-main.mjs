// Dev only, never shipped. Tells a dev script whether it was started directly
// (`node scripts/<name>.mjs`) or imported by another module.
//
// Both sides are compared by their real paths, so a checkout reached through a
// symbolic link or a Windows junction still counts as a direct start. Case is
// ignored on Windows and macOS. A direct start must never end as a silent
// exit 0: when the start path cannot be resolved but names this very file,
// the check throws instead of guessing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function caseless(platform) {
  return platform === 'win32' || platform === 'darwin';
}

function realOf(p) {
  try {
    return fs.realpathSync.native(p);
  } catch (_) {
    return fs.realpathSync(p);
  }
}

function sameFileOnDisk(a, b) {
  try {
    const sa = fs.statSync(a, { bigint: true });
    const sb = fs.statSync(b, { bigint: true });
    return sa.ino !== 0n && sa.ino === sb.ino && sa.dev === sb.dev;
  } catch (_) {
    return false;
  }
}

/**
 * True when the module whose `import.meta.url` is given is the program's
 * entry point. `opts.argv` and `opts.platform` exist for tests.
 */
export function isMain(metaUrl, opts = {}) {
  const argv = opts.argv || process.argv;
  const platform = opts.platform || process.platform;
  const started = argv[1];
  if (typeof started !== 'string' || started === '') return false;
  const self = fileURLToPath(metaUrl);
  const norm = (p) => (caseless(platform) ? p.toLowerCase() : p);

  let selfReal;
  try {
    selfReal = realOf(self);
  } catch (_) {
    selfReal = path.resolve(self);
  }

  let startedReal;
  try {
    startedReal = realOf(path.resolve(started));
  } catch (_) {
    // The start path cannot be resolved. If it names this file, a direct run is
    // likely: refuse loudly rather than do nothing and exit 0.
    if (norm(path.basename(started)) === norm(path.basename(self))) {
      throw new Error(
        `${path.basename(self)}: cannot confirm whether this script was started directly; refusing to exit without running`
      );
    }
    return false;
  }

  if (norm(startedReal) === norm(selfReal)) return true;
  // A hard link or another alias of the same file on disk.
  return sameFileOnDisk(startedReal, selfReal);
}
