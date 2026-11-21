// Copy-by-hand step list (spec 12.2, 12.3, 14.5, 14.6). Dev only, never shipped.
//
// One module for docs/install-steps.json: load and check it, fill its
// placeholders, render the per-shell blocks of docs/install.md, perform each
// action in Node, and take the byte-level snapshots the check compares.
// Every path is built with path.join / path.resolve. A failing action never
// stops the list (hard line 7), except the designed stops: a
// copy-dir-no-overwrite target that already exists, and a kit folder that
// already exists or is not named for the kit (12.2 a, d).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const INSTALL_TYPES = Object.freeze(['mkdir', 'copy-file', 'copy-dir-no-overwrite', 'merge-settings', 'write-json', 'mcp-add-user']);
export const UNINSTALL_TYPES = Object.freeze(['remove-dir', 'remove-settings-entries', 'remove-marked-block', 'mcp-remove-user']);
export const PLACEHOLDERS = Object.freeze(['<REPO>', '<CONFIG>', '<KIT>', '<NODE>']);
export const SHELL_TEXT = Object.freeze([';', '&&', '|', '$(', '`']);
export const SHELLS = Object.freeze(['bash', 'powershell']);
export const BLOCK_NAMES = Object.freeze(['install-bash', 'install-powershell', 'settings', 'uninstall-bash', 'uninstall-powershell']);
// The CLI's exact refusal while an organisation-managed MCP configuration has exclusive control (seen on 2.1.329).
export const MANAGED_MCP_TEXT = 'enterprise MCP configuration is active and has exclusive control over MCP servers';

const VAR = Object.freeze({ '<REPO>': 'REPO', '<CONFIG>': 'CONFIG', '<KIT>': 'KIT', '<NODE>': 'NODE' });
const PATH_FIELDS = Object.freeze(['path', 'from', 'to', 'target', 'block_from', 'only_if_same_as', 'command']);
const LABEL = /^[a-z][a-z0-9.-]{0,40}$/;
const REMOVE_GUARDS = Object.freeze(['only_if_same_as', 'only_if_created', 'only_if_kit']);
const REQUIRED = Object.freeze({
  mkdir: ['path'],
  'copy-file': ['from', 'to'],
  'copy-dir-no-overwrite': ['from', 'to'],
  'merge-settings': ['from', 'target', 'status_line'],
  'write-json': ['path', 'content'],
  'mcp-add-user': ['name', 'command', 'args'],
  'remove-dir': ['path'],
  'remove-settings-entries': ['target', 'entries_from'],
  'remove-marked-block': ['target', 'block_from'],
  'mcp-remove-user': ['name'],
});

export function stepsFile(repo) {
  return path.join(repo, 'docs', 'install-steps.json');
}
export function installMdFile(repo) {
  return path.join(repo, 'docs', 'install.md');
}

export function loadSteps(repo) {
  const text = fs.readFileSync(stepsFile(repo), 'utf8');
  return { text, doc: JSON.parse(text) };
}

function placeholdersIn(s) {
  return [...String(s).matchAll(/<[^<>]*>/g)].map((m) => m[0]);
}

/** Problems with the step list (empty when it is well formed). Messages name ids and fields only. */
function allStrings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); allStrings(x, out); }
  return out;
}

export function validateSteps(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object') return ['not an object'];
  const strings = allStrings(doc);
  for (const c of SHELL_TEXT) if (strings.some((s) => s.includes(c))) problems.push('shell text ' + JSON.stringify(c) + ' in the step list');
  if (strings.some((s) => s.includes('\\'))) problems.push('a backslash in the step list (forward slashes only)');
  const ids = new Set();
  const merges = new Set();
  for (const [listName, types] of [['install', INSTALL_TYPES], ['uninstall', UNINSTALL_TYPES]]) {
    const list = doc[listName];
    if (!Array.isArray(list) || list.length === 0) { problems.push(listName + ' list missing or empty'); continue; }
    for (const a of list) {
      const id = a && typeof a.id === 'string' ? a.id : '?';
      if (!/^[a-z0-9-]+$/.test(id)) problems.push(listName + ': bad id ' + JSON.stringify(id));
      if (ids.has(id)) problems.push('duplicate id ' + id);
      ids.add(id);
      if (a.part !== 'core' && a.part !== 'search') problems.push(id + ': part must be core or search');
      if (typeof a.optional !== 'boolean') problems.push(id + ': optional must be true or false');
      if (!types.includes(a.type)) { problems.push(id + ': type ' + JSON.stringify(a.type) + ' is not in the ' + listName + ' set'); continue; }
      for (const f of REQUIRED[a.type]) if (!(f in a)) problems.push(id + ': ' + f + ' missing');
      if (a.type === 'merge-settings') merges.add(id);
      const pathValues = [];
      for (const f of PATH_FIELDS) if (typeof a[f] === 'string') pathValues.push([f, a[f]]);
      if (Array.isArray(a.args)) a.args.forEach((v, i) => pathValues.push(['args[' + i + ']', v]));
      for (const [f, v] of pathValues) {
        if (typeof v !== 'string' || !PLACEHOLDERS.some((p) => v.startsWith(p))) problems.push(id + ': ' + f + ' must start with a placeholder');
        for (const p of placeholdersIn(v)) if (!PLACEHOLDERS.includes(p)) problems.push(id + ': ' + f + ' holds an unknown placeholder');
      }
      if (a.type === 'merge-settings') {
        const sl = a.status_line;
        if (!sl || typeof sl !== 'object' || Object.keys(sl).sort().join(',') !== SHELLS.slice().sort().join(',')) {
          problems.push(id + ': status_line must hold exactly the bash and powershell forms');
        } else {
          for (const s of SHELLS) {
            const form = sl[s];
            if (!form || form.type !== 'command' || typeof form.command !== 'string' || Object.keys(form).sort().join(',') !== 'command,type') {
              problems.push(id + ': status_line.' + s + ' must be { type: command, command }');
              continue;
            }
            for (const p of placeholdersIn(form.command)) if (!PLACEHOLDERS.includes(p)) problems.push(id + ': status_line.' + s + ' holds an unknown placeholder');
          }
        }
      }
      if (a.type === 'remove-dir') {
        const guards = REMOVE_GUARDS.filter((g) => g in a);
        if (guards.length !== 1) problems.push(id + ': remove-dir needs exactly one guard');
        if ('only_if_kit' in a && (a.only_if_kit !== true || a.path !== '<KIT>')) problems.push(id + ': only_if_kit must be true, on the path <KIT>');
        if ('only_if_created' in a && !LABEL.test(String(a.only_if_created))) problems.push(id + ': only_if_created must be a marker label');
      }
      if ('new_kit' in a && (a.type !== 'mkdir' || a.new_kit !== true || a.path !== '<KIT>' || listName !== 'install' || list[0] !== a)) {
        problems.push(id + ': new_kit belongs only on the first install action, a mkdir of <KIT>');
      }
      for (const k of ['record_if_created', 'delete_if_created']) if (k in a && !LABEL.test(String(a[k]))) problems.push(id + ': ' + k + ' must be a marker label');
    }
  }
  for (const a of doc.uninstall || []) {
    if (a && a.type === 'remove-settings-entries' && !merges.has(a.entries_from)) problems.push(a.id + ': entries_from must name a merge-settings action');
  }
  const mk = doc.marker;
  if (!mk || mk.path !== '<KIT>/.pocotoko-kit' || typeof mk.first_line !== 'string' || !/^[a-z ]{1,40}$/.test(mk.first_line) || !/^[a-z]{1,40}$/.test(String(mk.kit_name))) {
    problems.push('marker must be { path: <KIT>/.pocotoko-kit, first_line, kit_name } with plain lower-case text');
  }
  if (!(doc.install || [])[0] || doc.install[0].new_kit !== true) problems.push('the first install action must make the new kit folder (new_kit)');
  return problems;
}

// ---------------------------------------------------------------------------
// Placeholders

/** Forward-slash form of an absolute path (Windows too). */
export function slash(p) {
  return String(p).split(path.sep).join('/').replace(/\\/g, '/');
}

/** A value for a single-quoted string: ' becomes '\'' in bash and '' in PowerShell (12.2 g). */
export function quoteValue(v, shell) {
  return shell === 'powershell' ? String(v).split("'").join("''") : String(v).split("'").join("'\\''");
}

/** Replace every placeholder in s with a value ready for a single-quoted string in that shell. */
export function fillShell(s, values, shell) {
  const q = {};
  for (const k of Object.keys(values)) q[k] = quoteValue(values[k], shell);
  return fill(s, q);
}

/** Replace every placeholder in s. values: { REPO, CONFIG, KIT, NODE } in forward-slash form. */
export function fill(s, values) {
  let out = String(s);
  for (const [ph, name] of Object.entries(VAR)) out = out.split(ph).join(values[name]);
  return out;
}

function fillDeep(v, values) {
  if (typeof v === 'string') return fill(v, values);
  if (Array.isArray(v)) return v.map((x) => fillDeep(x, values));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = fillDeep(x, values);
    return o;
  }
  return v;
}

/** The argument list a mcp-* action gives the Claude Code CLI, filled. */
export function mcpArgs(action, values) {
  if (action.type === 'mcp-add-user') return ['mcp', 'add', '--scope', 'user', action.name, '--', fill(action.command, values), ...action.args.map((x) => fill(x, values))];
  if (action.type === 'mcp-remove-user') return ['mcp', 'remove', '--scope', 'user', action.name];
  throw new Error('not an mcp action: ' + action.id);
}

/** The settings entries a merge-settings action adds, filled: { hooks, statusLine } for one shell. */
export function settingsEntries(action, repo, shell, values) {
  const snippet = JSON.parse(fs.readFileSync(fromRepo(action.from, repo), 'utf8'));
  const form = action.status_line[shell];
  return { hooks: fillDeep(snippet.hooks, values), statusLine: { type: form.type, command: fillShell(form.command, values, shell) } };
}

/** A <REPO>/... path as a real path inside repo (render time). */
function fromRepo(p, repo) {
  if (!p.startsWith('<REPO>/')) throw new Error('not a repo path: ' + p);
  return path.join(repo, ...p.slice('<REPO>/'.length).split('/'));
}

// ---------------------------------------------------------------------------
// Rendering (12.2 b)

export function markers(name) {
  return { start: '<!-- install-steps:' + name + ':start -->', end: '<!-- install-steps:' + name + ':end -->' };
}

function sh(p) {
  // "<KIT>/hooks" -> "$KIT/hooks" (bash and PowerShell share this form).
  const ph = PLACEHOLDERS.find((x) => p.startsWith(x));
  const rest = p.slice(ph.length);
  if (/["$`\\]/.test(rest)) throw new Error('a path part holds a quote or a dollar sign: ' + p);
  return '$' + VAR[ph] + rest;
}
const q = (p) => '"' + sh(p) + '"';

function flatFiles(dir) {
  const names = fs.readdirSync(dir).sort();
  for (const n of names) {
    if (!fs.lstatSync(path.join(dir, n)).isFile()) throw new Error('only_if_same_as needs a folder of plain files: ' + dir);
  }
  return names;
}

function varLines(shell) {
  return Object.entries(VAR).map(([ph, name]) => (shell === 'bash' ? name + "='" + ph + "'" : '$' + name + " = '" + ph + "'"));
}

const NOT_FULL = 'Stopped: every path must be a full path (no ~ and no relative path): ';
/** The line right after the variable lines: stop on a value that is not a full path (12.2 g). */
function fullPathLine(shell) {
  return shell === 'bash'
    ? 'for v in "$REPO" "$CONFIG" "$KIT" "$NODE"; do case "$v" in /*|[A-Za-z]:/*|[A-Za-z]:\\\\*) ;; *) echo "' + NOT_FULL + '$v"; exit 1;; esac; done'
    : "foreach ($v in @($REPO, $CONFIG, $KIT, $NODE)) { if ($v -notmatch '^(?:[A-Za-z]:[\\\\/]|[\\\\/])') { Write-Output \"" + NOT_FULL + '$v"; return } }';
}

const markerOf = (doc) => doc.marker;

function bashLine(a, repo, doc) {
  const mk = markerOf(doc);
  switch (a.type) {
    case 'mkdir':
      if (a.new_kit) {
        return [
          'if [ -e ' + q(a.path) + ' ]; then echo "Stopped: ' + sh(a.path) + ' already exists. It was not changed. Uninstall first, or name a new kit folder."; exit 1; fi',
          'case "${KIT%/}" in */' + mk.kit_name + '|' + mk.kit_name + ') ;; *) echo "Stopped: the kit folder must be named ' + mk.kit_name + '."; exit 1;; esac',
          'mkdir -p ' + q(a.path),
          "printf '%s\\n' '" + mk.first_line + "' > " + q(mk.path),
        ];
      }
      if (a.record_if_created) {
        return ['if [ ! -e ' + q(a.path) + ' ]; then mkdir -p ' + q(a.path) + "; printf '%s\\n' 'created " + a.record_if_created + "' >> " + q(mk.path) + '; fi'];
      }
      return ['mkdir -p ' + q(a.path)];
    case 'copy-file': return ['cp ' + q(a.from) + ' ' + q(a.to)];
    case 'copy-dir-no-overwrite': return [
      'if [ -e ' + q(a.to) + ' ]; then echo "Stopped: ' + sh(a.to) + ' already exists. It was not changed."; exit 1; fi',
      'cp -R ' + q(a.from) + ' ' + q(a.to),
    ];
    case 'merge-settings': return ['# By hand: open ' + sh(a.target) + ' in a text editor and add the settings lines for this shell (below). Never replace an existing entry.'];
    case 'write-json': return ['[ -e ' + q(a.path) + " ] || printf '%s\\n' '" + JSON.stringify(a.content) + "' > " + q(a.path)];
    case 'mcp-add-user': return ['claude mcp add --scope user ' + a.name + ' -- ' + q(a.command) + ' ' + a.args.map(q).join(' ')];
    case 'mcp-remove-user': return ['claude mcp remove --scope user ' + a.name];
    case 'remove-settings-entries': return ['# By hand: open ' + sh(a.target) + ' in a text editor and delete the two kit hooks and the kit statusLine. Change nothing else.'];
    case 'remove-marked-block': return ['# By hand: if ' + sh(a.target) + ' holds the block from ' + sh(a.block_from) + ', delete it, markers included.'];
    case 'remove-dir': {
      const t = q(a.path);
      if (a.only_if_kit) {
        // Lower-cased real paths: the kit folder may go only when neither the config folder nor the home folder sits in it.
        const real = (v) => '$(cd "$' + v + '" 2>/dev/null && pwd -P | tr \'[:upper:]\' \'[:lower:]\')';
        return [
          'if [ -d ' + t + ' ]; then',
          '  k=' + real('KIT') + '; c=' + real('CONFIG') + '; h=' + real('HOME'),
          '  if [ "${k##*/}" = "' + mk.kit_name + '" ] && [ -f ' + q(mk.path) + ' ] && [ "$(head -n 1 ' + q(mk.path) + ')" = "' + mk.first_line + '" ] && case "$c/" in "$k"/*) false;; *) true;; esac && case "$h/" in "$k"/*) false;; *) true;; esac; then rm -rf ' + t + '; else echo "Left: ' + sh(a.path) + ' (not removed: it is not a kit folder these steps made)."; fi',
          'fi',
        ];
      }
      let cond;
      if (a.only_if_created) cond = '[ -f ' + q(mk.path) + " ] && grep -qx 'created " + a.only_if_created + "' " + q(mk.path) + ' && [ -z "$(ls -A ' + t + ')" ]';
      else {
        const names = flatFiles(fromRepo(a.only_if_same_as, repo));
        cond = '[ "$(ls -A ' + t + " | wc -l | tr -d ' ')\" = \"" + names.length + '" ]'
          + names.map((n) => ' && cmp -s ' + q(a.only_if_same_as + '/' + n) + ' ' + q(a.path + '/' + n)).join('');
      }
      const rm = a.only_if_created ? 'rmdir ' + t : 'rm -rf ' + t;
      return ['if [ -d ' + t + ' ]; then if ' + cond + '; then ' + rm + '; else echo "Left: ' + sh(a.path) + ' (not removed: the steps did not make it, it is not the kit copy, or it is not empty)."; fi; fi'];
    }
    default: throw new Error('unknown type ' + a.type);
  }
}

function psLine(a, repo, doc) {
  const mk = markerOf(doc);
  switch (a.type) {
    case 'mkdir':
      if (a.new_kit) {
        return [
          'if (Test-Path -LiteralPath ' + q(a.path) + ') { Write-Output "Stopped: ' + sh(a.path) + ' already exists. It was not changed. Uninstall first, or name a new kit folder."; return }',
          "if ((Split-Path -Leaf $KIT.TrimEnd('/', '\\')) -cne '" + mk.kit_name + "') { Write-Output \"Stopped: the kit folder must be named " + mk.kit_name + '."; return }',
          '[System.IO.Directory]::CreateDirectory(' + q(a.path) + ') | Out-Null',
          '[System.IO.File]::WriteAllText(' + q(mk.path) + ", '" + mk.first_line + "' + [char]10)",
        ];
      }
      if (a.record_if_created) {
        return ['if (-not (Test-Path -LiteralPath ' + q(a.path) + ')) { [System.IO.Directory]::CreateDirectory(' + q(a.path) + ') | Out-Null; [System.IO.File]::AppendAllText('
          + q(mk.path) + ", 'created " + a.record_if_created + "' + [char]10) }"];
      }
      return ['[System.IO.Directory]::CreateDirectory(' + q(a.path) + ') | Out-Null'];
    case 'copy-file': return ['[System.IO.File]::Copy(' + q(a.from) + ', ' + q(a.to) + ', $true)'];
    case 'copy-dir-no-overwrite': return [
      'if (Test-Path -LiteralPath ' + q(a.to) + ') { Write-Output "Stopped: ' + sh(a.to) + ' already exists. It was not changed."; return }',
      'Copy-Item -LiteralPath ' + q(a.from) + ' -Destination ' + q(a.to) + ' -Recurse',
    ];
    case 'merge-settings': return ['# By hand: open ' + sh(a.target) + ' in a text editor and add the settings lines for this shell (below). Never replace an existing entry.'];
    case 'write-json': return ['if (-not (Test-Path -LiteralPath ' + q(a.path) + ')) { [System.IO.File]::WriteAllText(' + q(a.path) + ", '" + JSON.stringify(a.content) + "' + [char]10) }"];
    case 'mcp-add-user': return ['claude mcp add --scope user ' + a.name + ' -- ' + q(a.command) + ' ' + a.args.map(q).join(' ')];
    case 'mcp-remove-user': return ['claude mcp remove --scope user ' + a.name];
    case 'remove-settings-entries': return ['# By hand: open ' + sh(a.target) + ' in a text editor and delete the two kit hooks and the kit statusLine. Change nothing else.'];
    case 'remove-marked-block': return ['# By hand: if ' + sh(a.target) + ' holds the block from ' + sh(a.block_from) + ', delete it, markers included.'];
    case 'remove-dir': {
      const t = q(a.path);
      if (a.only_if_kit) {
        return [
          'if (Test-Path -LiteralPath ' + t + ' -PathType Container) {',
          "  $k = (Resolve-Path -LiteralPath " + t + ").ProviderPath.TrimEnd('/', '\\') + '\\'",
          "  $held = @(\"$CONFIG\", $env:USERPROFILE, $env:HOME) | Where-Object { $_ } | ForEach-Object { Resolve-Path -LiteralPath $_ -ErrorAction SilentlyContinue } | ForEach-Object { $_.ProviderPath.TrimEnd('/', '\\') + '\\' }",
          "  $m = Join-Path $k '.pocotoko-kit'",
          "  if (((Split-Path -Leaf $k.TrimEnd('\\')) -eq '" + mk.kit_name + "') -and (Test-Path -LiteralPath $m -PathType Leaf) -and ((Get-Content -LiteralPath $m -TotalCount 1) -eq '"
            + mk.first_line + "') -and -not ($held | Where-Object { $_.StartsWith($k, [System.StringComparison]::OrdinalIgnoreCase) })) { Remove-Item -LiteralPath " + t
            + ' -Recurse -Force } else { Write-Output "Left: ' + sh(a.path) + ' (not removed: it is not a kit folder these steps made)." }',
          '}',
        ];
      }
      let cond;
      if (a.only_if_created) {
        cond = '(Test-Path -LiteralPath ' + q(mk.path) + " -PathType Leaf) -and (@(Get-Content -LiteralPath " + q(mk.path) + ") -contains 'created " + a.only_if_created
          + "') -and (-not (Get-ChildItem -LiteralPath " + t + ' -Force))';
      } else {
        const names = flatFiles(fromRepo(a.only_if_same_as, repo));
        cond = '(@(Get-ChildItem -LiteralPath ' + t + ' -Force).Count -eq ' + names.length + ')'
          + names.map((n) => ' -and (Test-Path -LiteralPath ' + q(a.path + '/' + n) + ' -PathType Leaf) -and ((Get-FileHash -LiteralPath '
            + q(a.only_if_same_as + '/' + n) + ').Hash -eq (Get-FileHash -LiteralPath ' + q(a.path + '/' + n) + ').Hash)').join('');
      }
      const rm = a.only_if_created ? 'Remove-Item -LiteralPath ' + t + ' -Force' : 'Remove-Item -LiteralPath ' + t + ' -Recurse -Force';
      return ['if (Test-Path -LiteralPath ' + t + ' -PathType Container) { if (' + cond + ') { ' + rm + ' } else { Write-Output "Left: ' + sh(a.path) + ' (not removed: the steps did not make it, it is not the kit copy, or it is not empty)." } }'];
    }
    default: throw new Error('unknown type ' + a.type);
  }
}

function comment(a) {
  return '# ' + a.id + ' (' + a.part + (a.optional ? ', optional' : '') + '): ' + a.note;
}

/** The shell text of one list for one shell (no fences). */
export function renderList(doc, listName, shell, repo) {
  const lines = [];
  const install = listName === 'install';
  if (shell === 'bash') lines.push('(', ...(install ? ['set -e'] : []), ...varLines('bash'), fullPathLine('bash'));
  else lines.push('& {', ...(install ? ["$ErrorActionPreference = 'Stop'"] : []), ...varLines('powershell'), fullPathLine('powershell'));
  for (const a of doc[listName]) {
    lines.push(comment(a));
    lines.push(...(shell === 'bash' ? bashLine(a, repo, doc) : psLine(a, repo, doc)));
  }
  lines.push(shell === 'bash' ? ')' : '}');
  return lines.join('\n');
}

/** The settings lines to paste, one JSON fragment per shell form, placeholders kept. */
export function renderSettings(doc, repo) {
  const merge = doc.install.find((a) => a.type === 'merge-settings');
  const snippet = JSON.parse(fs.readFileSync(fromRepo(merge.from, repo), 'utf8'));
  const part = (shell) => JSON.stringify({ hooks: snippet.hooks, statusLine: merge.status_line[shell] }, null, 2);
  return [
    'Git Bash, macOS and Linux (bash, zsh): add these entries to ' + merge.target + '.',
    '',
    '```json',
    part('bash'),
    '```',
    '',
    'PowerShell (Windows without Git Bash): add these entries to ' + merge.target + '.',
    '',
    '```json',
    part('powershell'),
    '```',
  ].join('\n');
}

/** Every marked block, as it appears between its markers. */
export function renderBlocks(doc, repo) {
  const fence = (lang, body) => '```' + lang + '\n' + body + '\n```';
  return {
    'install-bash': fence('bash', renderList(doc, 'install', 'bash', repo)),
    'install-powershell': fence('powershell', renderList(doc, 'install', 'powershell', repo)),
    settings: renderSettings(doc, repo),
    'uninstall-bash': fence('bash', renderList(doc, 'uninstall', 'bash', repo)),
    'uninstall-powershell': fence('powershell', renderList(doc, 'uninstall', 'powershell', repo)),
  };
}

/** The text between one block's markers (trimmed of the line breaks next to them), or null. */
export function extractBlock(text, name) {
  const m = markers(name);
  const a = text.indexOf(m.start);
  const b = text.indexOf(m.end);
  if (a < 0 || b < 0 || b < a || text.indexOf(m.start, a + 1) >= 0 || text.indexOf(m.end, b + 1) >= 0) return null;
  return text.slice(a + m.start.length, b).replace(/^\n/, '').replace(/\n$/, '');
}

/** install.md with every marked block replaced by a fresh render. Throws when a marker pair is missing. */
export function applyRender(text, blocks) {
  let out = text;
  for (const name of BLOCK_NAMES) {
    const m = markers(name);
    if (extractBlock(out, name) === null) throw new Error('docs/install.md: the marker pair for ' + name + ' is missing or repeated');
    const a = out.indexOf(m.start) + m.start.length;
    const b = out.indexOf(m.end);
    out = out.slice(0, a) + '\n' + blocks[name] + '\n' + out.slice(b);
  }
  return out;
}

/** The shell text of a fenced block (the lines inside the fence). */
export function unfence(block) {
  const lines = block.split('\n');
  return lines.slice(1, -1).join('\n');
}

// ---------------------------------------------------------------------------
// Settings (12.2 a: add, never replace; 12.3: remove exactly what was added)

function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
export function sameJson(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

function readSettings(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (err) {
    if (err && err.code === 'ENOENT') return { obj: {}, existed: false };
    return { error: 'unreadable (' + ((err && err.code) || 'error') + ')' };
  }
  if (!st.isFile()) return { error: 'not a plain file' };
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return { error: 'not valid JSON' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'not a JSON object' };
  return { obj, existed: true };
}

const settingsText = (obj) => JSON.stringify(obj, null, 2) + '\n';

/** Merge { hooks, statusLine } into a settings file. Returns { status, reason, notes }. */
export function mergeSettingsFile(file, entries) {
  const r = readSettings(file);
  if (r.error) return { status: 'failed', reason: 'settings file ' + r.error + '; nothing changed' };
  const obj = r.obj;
  const notes = [];
  if ('hooks' in obj && (!obj.hooks || typeof obj.hooks !== 'object' || Array.isArray(obj.hooks))) {
    return { status: 'failed', reason: 'the hooks entry is not an object; nothing changed' };
  }
  const hooks = obj.hooks || {};
  for (const [ev, groups] of Object.entries(entries.hooks)) {
    if (ev in hooks && !Array.isArray(hooks[ev])) return { status: 'failed', reason: 'hooks.' + ev + ' is not a list; nothing changed' };
  }
  let changed = false;
  for (const [ev, groups] of Object.entries(entries.hooks)) {
    const list = hooks[ev] || [];
    for (const g of groups) {
      if (list.some((x) => sameJson(x, g))) { notes.push(ev + ' hook already there'); continue; }
      list.push(g);
      changed = true;
    }
    hooks[ev] = list;
  }
  obj.hooks = hooks;
  if ('statusLine' in obj) {
    if (!sameJson(obj.statusLine, entries.statusLine)) notes.push('a statusLine entry already exists; it was not replaced');
  } else {
    obj.statusLine = entries.statusLine;
    changed = true;
  }
  if (changed) fs.writeFileSync(file, settingsText(obj));
  return { status: 'done', reason: notes.join('; '), notes };
}

/**
 * Remove exactly the kit's entries: its hook groups and a statusLine equal to any kit form.
 * A file left holding nothing is deleted only when deleteIfEmpty (the marker says the steps made it).
 */
export function removeSettingsEntries(file, hookGroups, statusForms, deleteIfEmpty = false) {
  const r = readSettings(file);
  if (r.error) return { status: 'failed', reason: 'settings file ' + r.error + '; nothing changed' };
  if (!r.existed) return { status: 'skipped', reason: 'no settings file' };
  const obj = r.obj;
  let changed = false;
  if (obj.hooks && typeof obj.hooks === 'object' && !Array.isArray(obj.hooks)) {
    for (const [ev, groups] of Object.entries(hookGroups)) {
      if (!Array.isArray(obj.hooks[ev])) continue;
      const keep = obj.hooks[ev].filter((x) => !groups.some((g) => sameJson(x, g)));
      if (keep.length !== obj.hooks[ev].length) changed = true;
      if (keep.length) obj.hooks[ev] = keep;
      else delete obj.hooks[ev];
    }
    if (Object.keys(obj.hooks).length === 0 && changed) delete obj.hooks;
  }
  if ('statusLine' in obj && statusForms.some((f) => sameJson(obj.statusLine, f))) {
    delete obj.statusLine;
    changed = true;
  }
  if (!changed) return { status: 'skipped', reason: 'no kit entry found' };
  if (Object.keys(obj).length === 0 && deleteIfEmpty) {
    fs.unlinkSync(file);
    return { status: 'done', reason: 'the steps made the file and it held nothing else, so it was deleted' };
  }
  fs.writeFileSync(file, settingsText(obj));
  return { status: 'done', reason: '' };
}

// ---------------------------------------------------------------------------
// Marked blocks in CLAUDE.md (step 4 and 12.3)

/** The marker lines of a rules-block template: its first and last lines. */
export function blockMarkers(templateText) {
  const lines = templateText.replace(/\n$/, '').split('\n');
  return { start: lines[0], end: lines[lines.length - 1] };
}

/** What a user paste of the block does (the check's stand-in for the by-hand step). */
export function pasteBlock(text, templateText) {
  const base = text === '' || text.endsWith('\n') ? text : text + '\n';
  return base + (base === '' ? '' : '\n') + templateText;
}

/** Remove the marked block (markers included) and one blank line right above it. Returns { text, removed }. */
export function removeMarkedBlockText(text, mk) {
  const lines = text.split('\n');
  let removed = 0;
  for (let guard = 0; guard < 100; guard++) {
    const a = lines.indexOf(mk.start);
    if (a < 0) break;
    const b = lines.indexOf(mk.end, a + 1);
    if (b < 0) break;
    const from = a > 0 && lines[a - 1] === '' ? a - 1 : a;
    lines.splice(from, b - from + 1);
    removed++;
  }
  return { text: lines.join('\n'), removed };
}

// ---------------------------------------------------------------------------
// Node performer (12.2 c)

function lexists(p) {
  try { fs.lstatSync(p); return true; } catch (_) { return false; }
}

/** Same files, same bytes, one level, nothing else. */
function sameFlatFolder(dir, src) {
  let names;
  try {
    names = fs.readdirSync(src).sort();
    if (fs.readdirSync(dir).sort().join('\n') !== names.join('\n')) return false;
  } catch (_) { return false; }
  for (const n of names) {
    try {
      const a = fs.lstatSync(path.join(dir, n));
      if (!a.isFile()) return false;
      if (!fs.readFileSync(path.join(dir, n)).equals(fs.readFileSync(path.join(src, n)))) return false;
    } catch (_) { return false; }
  }
  return true;
}

const native = (p) => path.resolve(p);

// ---------------------------------------------------------------------------
// The kit folder's marker (12.2 d)

/** The marker file's lines, or null when it is not a plain file that starts with the first line. */
export function readMarker(doc, values) {
  const file = native(fill(doc.marker.path, values));
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    return lines[0] === doc.marker.first_line ? lines : null;
  } catch (_) {
    return null;
  }
}
const recorded = (doc, values, label) => { const m = readMarker(doc, values); return !!m && m.includes('created ' + label); };
function record(doc, values, label) {
  fs.appendFileSync(native(fill(doc.marker.path, values)), 'created ' + label + '\n');
}

function realLower(p) {
  let r = path.resolve(p);
  try { r = fs.realpathSync.native(r); } catch (_) { /* keep as written */ }
  return r.toLowerCase();
}
/** True when child is parent or sits inside it, case ignored (fails safe on a case-sensitive disk). */
function insideLower(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}

/**
 * Why the kit folder may not be removed, or null (12.2 d): it must be named for the kit,
 * hold the marker, and hold neither the config folder nor a home folder.
 */
export function kitProblem(doc, values, homes = []) {
  const kit = native(fill('<KIT>', values));
  let st;
  try { st = fs.lstatSync(kit); } catch (_) { return 'not there'; }
  if (st.isSymbolicLink() || !st.isDirectory()) return 'not a plain folder';
  const k = realLower(kit);
  if (path.basename(k) !== doc.marker.kit_name) return 'not named ' + doc.marker.kit_name;
  if (!readMarker(doc, values)) return 'no kit marker file';
  for (const h of [native(fill('<CONFIG>', values)), os.homedir(), process.env.HOME, process.env.USERPROFILE, ...homes]) {
    if (h && insideLower(realLower(h), k)) return 'the config folder or a home folder is inside it';
  }
  return null;
}

/**
 * Perform one list in Node. ctx: { values, repo, shell, runMcp(args) -> { status, out } | null, homes }.
 * Returns { results: [{ id, type, status, reason }], summary }.
 * status: done | skipped | failed | held | stopped (the designed stop) | not-run (after a stop).
 */
export function performList(doc, listName, ctx) {
  const results = [];
  let stopped = false;
  const merge = doc.install.find((a) => a.type === 'merge-settings');
  for (const a of doc[listName]) {
    if (stopped) { results.push({ id: a.id, type: a.type, status: 'not-run', reason: 'the steps stopped earlier' }); continue; }
    let r;
    try {
      r = performOne(a, ctx, merge, doc);
    } catch (err) {
      r = { status: 'failed', reason: (err && err.code) || (err && err.message) || 'error' };
    }
    if (r.status === 'stopped') stopped = true;
    results.push({ id: a.id, type: a.type, ...r });
  }
  return { results, summary: summarize(results) };
}

export function summarize(results) {
  const n = (s) => results.filter((r) => r.status === s).length;
  return { succeeded: n('done'), failed: n('failed'), skipped: n('skipped') + n('held') + n('not-run'), held: n('held'), stopped: n('stopped') };
}

function performOne(a, ctx, merge, doc) {
  const v = ctx.values;
  const P = (s) => native(fill(s, v));
  switch (a.type) {
    case 'mkdir': {
      const p = P(a.path);
      if (a.new_kit) {
        if (lexists(p)) return { status: 'stopped', reason: 'Stopped: ' + fill(a.path, v) + ' already exists. It was not changed. Uninstall first, or name a new kit folder.' };
        if (path.basename(p) !== doc.marker.kit_name) return { status: 'stopped', reason: 'Stopped: the kit folder must be named ' + doc.marker.kit_name + '.' };
        fs.mkdirSync(p, { recursive: true });
        fs.writeFileSync(P(doc.marker.path), doc.marker.first_line + '\n', { flag: 'wx' });
        return { status: 'done', reason: '' };
      }
      if (a.record_if_created && !lexists(p)) {
        fs.mkdirSync(p, { recursive: true });
        record(doc, v, a.record_if_created);
        return { status: 'done', reason: 'made, and noted in the marker file' };
      }
      fs.mkdirSync(p, { recursive: true });
      return { status: 'done', reason: '' };
    }
    case 'copy-file':
      fs.copyFileSync(P(a.from), P(a.to));
      return { status: 'done', reason: '' };
    case 'copy-dir-no-overwrite': {
      const to = P(a.to);
      if (lexists(to)) return { status: 'stopped', reason: 'Stopped: ' + fill(a.to, v) + ' already exists. It was not changed.' };
      fs.cpSync(P(a.from), to, { recursive: true, errorOnExist: true, force: false });
      return { status: 'done', reason: '' };
    }
    case 'merge-settings': {
      const existed = lexists(P(a.target));
      const res = mergeSettingsFile(P(a.target), settingsEntries(a, ctx.repo, ctx.shell, v));
      if (res.status === 'done' && !existed && a.record_if_created && lexists(P(a.target))) record(doc, v, a.record_if_created);
      return res;
    }
    case 'write-json': {
      const p = P(a.path);
      if (lexists(p)) return { status: 'skipped', reason: 'the file exists; it was not overwritten' };
      fs.writeFileSync(p, JSON.stringify(a.content) + '\n', { flag: 'wx' });
      return { status: 'done', reason: '' };
    }
    case 'mcp-add-user':
    case 'mcp-remove-user':
      return mcpResult(a, ctx.runMcp ? ctx.runMcp(mcpArgs(a, v), a) : null);
    case 'remove-settings-entries': {
      const forms = SHELLS.map((s) => settingsEntries(merge, ctx.repo, s, v).statusLine);
      const made = a.delete_if_created ? recorded(doc, v, a.delete_if_created) : false;
      return removeSettingsEntries(P(a.target), settingsEntries(merge, ctx.repo, 'bash', v).hooks, forms, made);
    }
    case 'remove-marked-block': {
      const file = P(a.target);
      if (!lexists(file)) return { status: 'skipped', reason: 'no such file' };
      const mk = blockMarkers(fs.readFileSync(P(a.block_from), 'utf8'));
      const before = fs.readFileSync(file, 'utf8');
      const r = removeMarkedBlockText(before, mk);
      if (!r.removed) return { status: 'skipped', reason: 'no block found' };
      fs.writeFileSync(file, r.text);
      return { status: 'done', reason: '' };
    }
    case 'remove-dir': {
      const dir = P(a.path);
      let st;
      try { st = fs.lstatSync(dir); } catch (_) { return { status: 'skipped', reason: 'not there' }; }
      if (st.isSymbolicLink() || !st.isDirectory()) return { status: 'skipped', reason: 'Left: not a plain folder' };
      if (a.only_if_kit) {
        const why = kitProblem(doc, v, ctx.homes || []);
        if (why) return { status: 'skipped', reason: 'Left: ' + fill(a.path, v) + ' (' + why + ')' };
      } else if (a.only_if_created) {
        if (!recorded(doc, v, a.only_if_created)) return { status: 'skipped', reason: 'Left: ' + fill(a.path, v) + ' (the steps did not make it)' };
        if (fs.readdirSync(dir).length) return { status: 'skipped', reason: 'Left: ' + fill(a.path, v) + ' (not empty)' };
        fs.rmdirSync(dir);
        return { status: 'done', reason: '' };
      } else if (!sameFlatFolder(dir, P(a.only_if_same_as))) {
        return { status: 'skipped', reason: 'Left: ' + fill(a.path, v) + ' (not the kit copy)' };
      }
      fs.rmSync(dir, { recursive: true, force: false });
      return { status: 'done', reason: '' };
    }
    default:
      return { status: 'failed', reason: 'unknown type' };
  }
}

/** Map a Claude Code CLI result for an mcp action to a step status. */
export function mcpResult(a, r) {
  if (!r) return { status: 'skipped', reason: 'no Claude Code program given' };
  if (r.held) return { status: 'held', reason: r.held };
  const out = String(r.out || '');
  if (out.includes(MANAGED_MCP_TEXT)) return { status: 'held', reason: 'this machine has an organisation-managed MCP configuration with exclusive control, so the Claude Code CLI refuses MCP changes' };
  if (r.status === 0) return { status: 'done', reason: '' };
  if (a.type === 'mcp-remove-user' && /No MCP server named/.test(out)) return { status: 'skipped', reason: 'not registered' };
  return { status: 'failed', reason: 'the Claude Code CLI exited ' + r.status };
}

// ---------------------------------------------------------------------------
// Snapshots (14.6: byte-identical clean end)

/**
 * Items the Claude Code CLI itself writes on any call, so they are not kit
 * state: the CLI's own state file in the config folder is compared by its
 * mcpServers value only (as the guard does, 13.7 b), and its backups folder
 * is left out.
 */
export const CLI_HOUSEKEEPING = Object.freeze({ stateFile: '.claude.json', backups: 'backups' });

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Every entry under root: relative path (forward slashes) -> state. Files by
 * SHA-256, folders as "dir", links by target. configRel names the config
 * folder inside root, for the CLI housekeeping rule; exclude lists further relative
 * paths left out (a shell's own cache). Reads only; never follows a link.
 */
export function snapshot(root, { configRel = '.claude', transform, exclude = [] } = {}) {
  const out = new Map();
  const stateRel = configRel + '/' + CLI_HOUSEKEEPING.stateFile;
  const backupsRel = configRel + '/' + CLI_HOUSEKEEPING.backups;
  const go = (dir, rel) => {
    let names;
    try { names = fs.readdirSync(dir).sort(); } catch (err) { out.set(rel || '.', 'unreadable:' + ((err && err.code) || 'error')); return; }
    for (const n of names) {
      const p = path.join(dir, n);
      const r = rel ? rel + '/' + n : n;
      if (r === backupsRel || exclude.includes(r)) continue;
      let st;
      try { st = fs.lstatSync(p); } catch (_) { out.set(r, 'unreadable'); continue; }
      if (st.isSymbolicLink()) { let t = ''; try { t = fs.readlinkSync(p); } catch (_) { /* keep */ } out.set(r, 'link:' + t); continue; }
      if (st.isDirectory()) {
        // A folder that only leads to an excluded path is not recorded itself; what else it holds still is.
        if (!exclude.some((e) => e.startsWith(r + '/'))) out.set(r, 'dir');
        go(p, r);
        continue;
      }
      if (!st.isFile()) { out.set(r, 'other'); continue; }
      let buf = fs.readFileSync(p);
      if (r === stateRel) {
        let mcp = null;
        try { mcp = JSON.parse(buf.toString('utf8')).mcpServers; } catch (_) { mcp = 'unparseable'; }
        // Absent, null and {} all mean "no user-scope server" (the CLI may leave an empty object after a remove).
        if (mcp === undefined || mcp === null || (typeof mcp === 'object' && !Array.isArray(mcp) && Object.keys(mcp).length === 0)) mcp = 'none';
        buf = Buffer.from('mcpServers:' + canonicalJson(mcp));
      }
      if (transform) buf = transform(r, buf);
      out.set(r, 'sha256:' + sha(buf));
    }
  };
  go(root, '');
  return out;
}

/** Relative paths whose state differs (added, removed or changed). */
export function diffSnapshots(a, b) {
  const names = new Set([...a.keys(), ...b.keys()]);
  return [...names].sort().filter((n) => a.get(n) !== b.get(n));
}
