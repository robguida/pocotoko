'use strict';
// Reads .github/workflows/ci.yml as plain text; no YAML library.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_TOP } = require('../helpers/tmpdir-sandbox.cjs');

const text = fs.readFileSync(path.join(REPO_TOP, '.github', 'workflows', 'ci.yml'), 'utf8');
const lines = text.split(/\r?\n/);
const code = lines.filter((l) => !/^\s*#/.test(l));
const codeText = code.join('\n');

test('triggers are push and pull_request only', () => {
  assert.match(codeText, /^on:\s*\n\s+push:\s*\n\s+pull_request:/m);
  assert.ok(!/pull_request_target/.test(codeText));
  assert.ok(!/workflow_run/.test(codeText));
});

test('top-level permissions are empty and each job grants contents: read', () => {
  assert.ok(lines.some((l) => /^permissions:\s*\{\}\s*$/.test(l)), 'top-level permissions: {}');
  const jobs = codeText.slice(codeText.indexOf('\njobs:'));
  assert.match(jobs, /^\s{4}permissions:\s*\n\s{6}contents:\s*read\s*$/m);
  assert.ok(!/:\s*write\b/.test(codeText), 'no write permission');
});

test('every action is pinned to a full 40-hex commit hash with a tag comment', () => {
  const uses = code.filter((l) => /^\s*-?\s*uses:/.test(l));
  assert.ok(uses.length >= 2);
  for (const l of uses) {
    assert.match(l, /uses:\s*[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}\s+#\s*v\d[\w.]*\s*$/, l);
  }
});

test('checkout does not persist credentials', () => {
  const idx = code.findIndex((l) => /uses:\s*actions\/checkout@/.test(l));
  assert.ok(idx >= 0);
  const block = code.slice(idx, idx + 4).join('\n');
  assert.match(block, /persist-credentials:\s*false/);
});

test('matrix has windows, macos and ubuntu runners and Node 22 and 24', () => {
  const os = /^\s+os:\s*\[(.*)\]\s*$/m.exec(codeText);
  assert.ok(os, 'os matrix line');
  for (const r of ['windows-latest', 'macos-latest', 'ubuntu-latest']) assert.ok(os[1].includes(r), r);
  const node = /^\s+node:\s*\[(.*)\]\s*$/m.exec(codeText);
  assert.ok(node, 'node matrix line');
  const versions = node[1].split(',').map((s) => s.trim());
  assert.ok(versions.includes('22') && versions.includes('24'), versions.join(','));
});

test('steps run npm test and the public scrub; nothing passes the private flag', () => {
  assert.match(codeText, /^\s+run:\s*npm test\s*$/m);
  assert.match(codeText, /^\s+run:\s*node scripts\/scrub-scan\.mjs\s*$/m);
  assert.ok(!/--private/.test(text), 'no --private anywhere, comments included');
});

test('no secrets, login token or key variable', () => {
  assert.ok(!/secrets\./i.test(text));
  assert.ok(!/\b[A-Z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD)[A-Z0-9_]*\b/.test(text));
  // Variable names only: the pinned package name (@anthropic-ai/claude-code) is not a credential.
  assert.ok(!/\bANTHROPIC_[A-Z0-9_]*|CLAUDE_CODE_OAUTH|AUTH_TOKEN/.test(text));
});

test('the job summary prints a skipped count and says a skipped step shows its reason', () => {
  assert.match(codeText, /GITHUB_STEP_SUMMARY/);
  assert.match(codeText, /Skipped steps: \$\{skipped\}/);
  assert.match(codeText, /SKIPPED with a reason/);
  // The count is the sum of each check's own summary-line skipped count, so it matches what the checks
  // report; the reasons are the checks' own SKIPPED, FAILED, held, skipped and not-run lines.
  assert.ok(codeText.includes("grep -hoE ': succeeded [0-9]+, failed [0-9]+, skipped [0-9]+' | awk '{ s += $NF } END { print s + 0 }'"));
  assert.ok(codeText.includes("grep -e '^SKIPPED' -e '^FAILED' -e '^  held' -e '^  skipped' -e '^  not-run' >> \"$GITHUB_STEP_SUMMARY\""));
});

test('13.4 full steps (B9), in order: npm test, the public scrub, a pinned Claude Code in a job-local folder, validate --strict, the plugin install proof, the copy-by-hand proof', () => {
  const order = [
    /^\s+run:\s*npm test\s*$/m,
    /^\s+run:\s*node scripts\/scrub-scan\.mjs\s*$/m,
    /^\s+run:\s*npm install --prefix "\$RUNNER_TEMP\/claude-code" --ignore-scripts [^\n]*"@anthropic-ai\/claude-code@\$CLAUDE_CODE_VERSION"\s*$/m,
    /^\s+run:\s*node scripts\/sandbox\.mjs --validate --find-in "\$RUNNER_TEMP\/claude-code"/m,
    /^\s+run:\s*node scripts\/sandbox\.mjs --check --find-in "\$RUNNER_TEMP\/claude-code"/m,
    /^\s+run:\s*node scripts\/copy-by-hand\.mjs --check --find-in "\$RUNNER_TEMP\/claude-code"/m,
  ];
  let at = 0;
  for (const re of order) {
    const m = re.exec(codeText.slice(at));
    assert.ok(m, 'step missing or out of order: ' + re);
    at += m.index + m[0].length;
  }
});

test('13.4: the Claude Code version is pinned exactly and installed outside the checkout (the job-local runner temp folder); the check steps run in bash on every OS (Git Bash on Windows)', () => {
  assert.match(codeText, /^\s+CLAUDE_CODE_VERSION:\s*\d+\.\d+\.\d+\s*$/m);
  assert.ok(!/claude-code@(?:latest|next|\^|~)/.test(codeText), 'no floating version');
  for (const s of ['sandbox.mjs --validate', 'sandbox.mjs --check', 'copy-by-hand.mjs --check']) {
    const i = code.findIndex((l) => l.includes(s));
    assert.ok(i > 0 && /shell:\s*bash/.test(code[i - 1]), s + ' runs in bash');
  }
});
