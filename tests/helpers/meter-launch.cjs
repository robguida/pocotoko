'use strict';
// Test-only launcher for the core meter. Usage:
//   node meter-launch.cjs <absolute path of a meter.cjs> [meter args]
// It reads test seams from METER_TEST_SEAMS (JSON: { gitCeiling }), removes that variable,
// and calls the meter's main(seams) with the remaining arguments. The shipped meter never
// reads seams from the environment; only this helper turns them into function arguments.
const path = require('node:path');

const file = path.resolve(process.argv[2]);
const raw = process.env.METER_TEST_SEAMS || '{}';
delete process.env.METER_TEST_SEAMS;
const seams = JSON.parse(raw);
seams.argv = process.argv.slice(3);
// The meter under test is loaded from a computed path (a sandbox copy); this is a test
// helper, not shipped code.
require(file).main(seams);
