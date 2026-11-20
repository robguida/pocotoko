'use strict';
// Test-only launcher for the search server. Usage:
//   node server-launch.cjs <absolute path of a server.cjs> [server args]
// It reads test seams from SEARCH_TEST_SEAMS (JSON), removes that variable, and
// calls the server's main(seams). The shipped server never reads seams from the
// environment; only this helper turns them into function arguments.
//
// JSON seams turned into store hooks here:
//   delayPerFileMs     a busy wait before each file is stored (a slow build)
//   delayLoadRecordMs  a busy wait before each stored record is loaded (a slow index load)
//   throwBeforeLoad    a throw while the server binds, just before the index load
//   throwLoadRecordAt  a throw on the Nth stored record loaded (counted from 1, once per process)
//   throwAfterLoad     a throw after the background load, so its promise rejects
const path = require('node:path');

function injected() {
  const e = new Error('injected');
  e.name = 'InjectedBindError';
  return e;
}

function busyWait(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* slow, on purpose */ }
}

const file = path.resolve(process.argv[2]);
const raw = process.env.SEARCH_TEST_SEAMS || '{}';
delete process.env.SEARCH_TEST_SEAMS;
const j = JSON.parse(raw);
const seams = { ...j };
delete seams.delayPerFileMs;
delete seams.delayLoadRecordMs;
delete seams.throwBeforeLoad;
delete seams.throwLoadRecordAt;
delete seams.throwAfterLoad;
const hooks = {};
if (j.delayPerFileMs) hooks.beforeUpsert = () => busyWait(j.delayPerFileMs);
if (j.delayLoadRecordMs || j.throwLoadRecordAt) {
  let n = 0;
  hooks.onLoadRecord = () => {
    n++;
    if (j.throwLoadRecordAt && n === j.throwLoadRecordAt) throw injected();
    if (j.delayLoadRecordMs) busyWait(j.delayLoadRecordMs);
  };
}
if (j.throwBeforeLoad) hooks.beforeLoad = () => { throw injected(); };
if (j.throwAfterLoad) hooks.afterLoad = () => { throw injected(); };
if (Object.keys(hooks).length) seams.storeHooks = hooks;
// The server under test is loaded from a computed path (a sandbox copy); this
// is a test helper, not shipped code.
require(file).main(seams);
