'use strict';
// Static checks over the shipped search plugin (spec 1.4, 2.2, 4, 9.9, 9.13,
// 14.4): T-14, T-34 (launch shape), the search rules block in its three
// places, the .mcp.json name and option mapping, and the userConfig table.
// (T-37, the runtime confinement run, is in server-safety.test.cjs.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../../src/search/server/envelope.cjs');
const S = require('../../src/search/server/server.cjs');

const REPO_TOP = path.resolve(__dirname, '..', '..');
const SEARCH = path.join(REPO_TOP, 'src', 'search');
const CORE = path.join(REPO_TOP, 'src', 'core');
const SERVER_DIR = path.join(SEARCH, 'server');
const RESERVED = [['cla', 'ude'], ['anthr', 'opic']].map((p) => p.join(''));

function shippedSources() {
  const out = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(c?js|mjs)$/.test(n)) out.push(p);
    }
  };
  walk(path.join(REPO_TOP, 'src'));
  return out;
}

const SPEC_SERVER_FILES = ['server.cjs', 'rpc.cjs', 'binder.cjs', 'walker.cjs', 'ignore.cjs', 'floor.cjs', 'scan.cjs',
  'chunker.cjs', 'markers.cjs', 'tokenize.cjs', 'stem.cjs', 'index.cjs', 'rank.cjs', 'store.cjs', 'envelope.cjs', 'fsx.cjs'];

test('the search server is exactly the 16 files of spec 4, plus .mcp.json and the rules template; no hooks/ or bin/ folder, no package.json (SR-39, SR-45)', () => {
  assert.deepEqual(fs.readdirSync(SERVER_DIR).sort(), SPEC_SERVER_FILES.slice().sort());
  assert.deepEqual(fs.readdirSync(SEARCH).sort(), ['.claude-plugin', '.mcp.json', 'server', 'templates'].sort());
  assert.deepEqual(fs.readdirSync(path.join(SEARCH, 'templates')), ['rules-block.md']);
  for (const root of [SEARCH, CORE]) {
    assert.ok(!fs.existsSync(path.join(root, 'bin')), 'no bin/ in ' + path.basename(root));
    assert.ok(!fs.existsSync(path.join(root, 'package.json')));
  }
  assert.ok(!fs.existsSync(path.join(SEARCH, 'hooks')), 'the search plugin has no hooks');
});

test('T-14: shipped source holds no network, process, worker or code-loading module or call', () => {
  const mods = ['child_process', 'net', 'http', 'https', 'http2', 'tls', 'dgram', 'dns', 'cluster', 'vm', 'worker_threads'];
  const calls = ['fetch(', 'WebSocket', 'eval(', 'new Function', 'loadExtension', 'process.binding', 'process.dlopen', 'createRequire', 'import(', 'fs.watch', 'fs.watchFile'];
  for (const file of shippedSources()) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(REPO_TOP, file);
    for (const m of mods) {
      for (const form of [m, 'node:' + m]) {
        assert.ok(!src.includes(`'${form}'`) && !src.includes(`"${form}"`) && !src.includes('`' + form + '`'), `${rel} names module ${form}`);
      }
    }
    for (const c of calls) assert.ok(!src.includes(c), `${rel} holds ${c}`);
    if (path.basename(file) !== 'server.cjs') assert.ok(!/\binspector\b/.test(src.replace(/\/\/.*$/gm, '')), `${rel}: inspector only in server.cjs (SR-42)`);
    // `require` only as a direct call with a string literal.
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of code.matchAll(/\brequire\b/g)) {
      const after = code.slice(m.index, m.index + 200);
      assert.match(after, /^require\('(?:node:)?[a-z_./-]+(?:\.cjs)?'\)/, `${rel}: require must be a direct call with a string literal`);
    }
    for (const m of code.matchAll(/require\('([^']+)'\)/g)) {
      const name = m[1];
      if (name.startsWith('./')) assert.ok(fs.existsSync(path.join(path.dirname(file), name)), `${rel}: ${name} exists`);
      else assert.match(name, /^node:[a-z_]+$/, `${rel}: built-ins only, in node: form (${name})`);
    }
  }
});

test('9.9: the search block is identical in its three places (the template, the server instructions, the search tool description) and under 2,048 characters', () => {
  const tpl = fs.readFileSync(path.join(SEARCH, 'templates', 'rules-block.md'), 'utf8');
  assert.equal(tpl.split(E.BLOCK_START).length - 1, 1);
  assert.equal(tpl.split(E.BLOCK_END).length - 1, 1);
  assert.equal(tpl, E.BLOCK_START + '\n' + E.RULES_BLOCK + '\n' + E.BLOCK_END + '\n', 'the template is the markers around exactly the block');
  const searchDef = S.TOOL_DEFS.find((d) => d.name === 'search');
  assert.equal(searchDef.description, E.RULES_BLOCK);
  assert.ok(E.RULES_BLOCK.length < 2048);
  assert.ok(E.RULES_BLOCK.startsWith(E.NOTICE));
  assert.ok(!tpl.includes('\r'));
  // The instructions field is checked on a live handshake in server.test.cjs.
});

test('T-34 / SR-44: .mcp.json is exec form: one stdio server named like the search plugin, command node (or the node_path option), args under ${CLAUDE_PLUGIN_ROOT}/, no shim or shell', () => {
  const mcp = JSON.parse(fs.readFileSync(path.join(SEARCH, '.mcp.json'), 'utf8'));
  const plugin = JSON.parse(fs.readFileSync(path.join(SEARCH, '.claude-plugin', 'plugin.json'), 'utf8'));
  const names = Object.keys(mcp.mcpServers);
  assert.deepEqual(names, [plugin.name], 'the MCP server name equals the search plugin name');
  for (const w of RESERVED) assert.ok(!names[0].toLowerCase().includes(w));
  assert.ok(!/official|for[\s_-]*claude/i.test(names[0]));
  const srv = mcp.mcpServers[names[0]];
  assert.equal(srv.type, 'stdio');
  assert.ok(['node', '${user_config.node_path}'].includes(srv.command), 'command is node or the node_path option (6.10 a)');
  assert.ok(Array.isArray(srv.args) && srv.args.length === 1);
  assert.equal(srv.args[0], '${CLAUDE_PLUGIN_ROOT}/server/server.cjs');
  assert.ok(fs.existsSync(path.join(SEARCH, 'server', 'server.cjs')));
  const launch = [srv.command, ...srv.args].join(' ');
  for (const bad of ['npx', '.cmd', '.bat', 'cmd.exe', 'powershell', 'bash', '/bin/sh', '&', '|', ';', '>', '<', '`', '$(']) {
    assert.ok(!launch.toLowerCase().includes(bad), 'no ' + bad + ' in the launch line');
  }
});

test('9.13 / T-34: every search option except node_path reaches the server through env only, as ${user_config.KEY}; none in args', () => {
  const mcp = JSON.parse(fs.readFileSync(path.join(SEARCH, '.mcp.json'), 'utf8'));
  const srv = Object.values(mcp.mcpServers)[0];
  const plugin = JSON.parse(fs.readFileSync(path.join(SEARCH, '.claude-plugin', 'plugin.json'), 'utf8'));
  const keys = Object.keys(plugin.userConfig).filter((k) => k !== 'node_path').sort();
  assert.deepEqual(S.OPTION_KEYS.slice().sort(), keys, 'the server reads every option the manifest declares');
  const expectEnv = {};
  for (const k of keys) expectEnv[S.ENV_PREFIX + k.toUpperCase()] = '${user_config.' + k + '}';
  assert.deepEqual(srv.env, expectEnv);
  assert.ok(!JSON.stringify(srv.args).includes('user_config'), 'no option in args');
  assert.ok(!JSON.stringify(srv.env).includes('node_path'), 'node_path is the command, never an env value');
  for (const k of Object.keys(srv.env)) for (const w of RESERVED) assert.ok(!k.toLowerCase().includes(w), 'env name ' + k);
});

test('9.13: the search plugin userConfig keys, types and defaults equal the table; each has a title and a description; node_path defaults to node', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(SEARCH, '.claude-plugin', 'plugin.json'), 'utf8'));
  const want = {
    projects: { type: 'string', multiple: true },
    matching: { type: 'string', default: 'broad' },
    word_families: { type: 'string', default: 'english' },
    extra_types: { type: 'string', multiple: true },
    never_folders: { type: 'string', multiple: true },
    never_globs: { type: 'string', multiple: true },
    never_terms: { type: 'string', multiple: true },
    synonyms: { type: 'string', multiple: true },
    drop_contacts: { type: 'boolean', default: true },
    max_file_bytes: { type: 'number', default: 1048576, min: 1024, max: 4194304 },
    node_path: { type: 'string', default: 'node' },
  };
  assert.deepEqual(Object.keys(plugin.userConfig).sort(), Object.keys(want).sort());
  for (const [k, w] of Object.entries(want)) {
    const o = plugin.userConfig[k];
    assert.equal(o.type, w.type, k);
    assert.ok(typeof o.title === 'string' && o.title.length > 0, k + ' title');
    assert.ok(typeof o.description === 'string' && o.description.length > 0, k + ' description');
    for (const f of ['default', 'multiple', 'min', 'max']) if (f in w) assert.equal(o[f], w[f], k + ' ' + f);
    if (!('default' in w)) assert.ok(!('default' in o), k + ' has no default');
  }
});

test('the server version equals the search plugin manifest version; the server source holds no kit name (2.2)', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(SEARCH, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(S.SERVER_VERSION, plugin.version);
  const core = JSON.parse(fs.readFileSync(path.join(CORE, '.claude-plugin', 'plugin.json'), 'utf8'));
  for (const f of fs.readdirSync(SERVER_DIR)) {
    const src = fs.readFileSync(path.join(SERVER_DIR, f), 'utf8').toLowerCase();
    assert.ok(!src.includes(core.name.toLowerCase()), f + ' holds the kit name');
  }
  assert.ok(!S.SERVER_NAME.toLowerCase().includes(core.name.toLowerCase()));
});

test('no CRLF in the shipped search files', () => {
  for (const f of [...SPEC_SERVER_FILES.map((n) => path.join(SERVER_DIR, n)), path.join(SEARCH, '.mcp.json'), path.join(SEARCH, 'templates', 'rules-block.md')]) {
    assert.ok(!fs.readFileSync(f, 'utf8').includes('\r'), path.basename(f));
  }
});
