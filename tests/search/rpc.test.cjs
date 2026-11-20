'use strict';
// rpc.cjs (spec 9.11, SR-3, SR-17, SR-47, T-41): JSON-RPC over line-delimited
// streams, message size limit, error replies, stdout protocol only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const R = require('../../src/search/server/rpc.cjs');
const F = require('../helpers/fake-values.cjs');

function harness(handlers = {}, opts = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOut = new PassThrough();
  const out = [];
  const err = [];
  let buf = '';
  output.setEncoding('utf8');
  output.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) { out.push(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  });
  errorOut.setEncoding('utf8');
  errorOut.on('data', (d) => err.push(d));
  const seen = { notes: [], closed: 0 };
  R.serve({
    input, output, errorOut,
    hasMethod: (m) => m === 'echo' || m === 'boom' || m === 'bad',
    onRequest: async (m, p) => {
      if (m === 'boom') { const e = new TypeError('secret detail ' + (p && p.v)); throw e; }
      if (m === 'bad') throw new R.RpcError(R.CODES.INVALID_PARAMS, 'Invalid params', 'InvalidArgument');
      return { echo: p };
    },
    onNotification: (m) => seen.notes.push(m),
    onClose: () => { seen.closed++; },
    ...handlers,
    ...opts,
  });
  const tick = () => new Promise((r) => setImmediate(r));
  const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
  return { input, out, err, seen, settle };
}

test('a request gets one reply line; a notification gets none; a response the server never asked for is ignored (SR-3)', async () => {
  const h = harness();
  h.input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: { a: 1 } }) + '\n');
  h.input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' }) + '\n');
  h.input.write(JSON.stringify({ jsonrpc: '2.0', id: 7, result: { roots: [{ uri: 'file:///x' }] } }) + '\n');
  await h.settle();
  assert.deepEqual(h.out.map((l) => JSON.parse(l)), [{ jsonrpc: '2.0', id: 1, result: { echo: { a: 1 } } }]);
  assert.deepEqual(h.seen.notes, ['notifications/roots/list_changed']);
});

test('a message split across chunks, CRLF line ends and a leading BOM are read', async () => {
  const h = harness();
  const msg = JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'echo', params: 'p' });
  h.input.write('﻿' + msg.slice(0, 10));
  h.input.write(msg.slice(10) + '\r\n');
  await h.settle();
  assert.equal(JSON.parse(h.out[0]).id, 'x');
});

test('T-41: malformed JSON, a batch, a missing jsonrpc and an unknown method each get an error reply, and serving goes on', async () => {
  const h = harness();
  h.input.write('{nope\n');
  h.input.write('[{"jsonrpc":"2.0","id":1,"method":"echo"}]\n');
  h.input.write('{"id":2,"method":"echo"}\n');
  h.input.write('{"jsonrpc":"2.0","id":3,"method":"nope"}\n');
  h.input.write('{"jsonrpc":"2.0","id":{"x":1},"method":"echo"}\n');
  h.input.write('{"jsonrpc":"2.0","id":4,"method":"echo"}\n');
  await h.settle();
  const msgs = h.out.map((l) => JSON.parse(l));
  assert.equal(msgs[0].error.code, -32700);
  assert.equal(msgs[0].id, null);
  assert.equal(msgs[1].error.code, -32600);
  assert.equal(msgs[2].error.code, -32600);
  assert.equal(msgs[2].id, 2);
  assert.equal(msgs[3].error.code, -32601);
  assert.equal(msgs[4].error.code, -32600);
  assert.deepEqual(msgs[5], { jsonrpc: '2.0', id: 4, result: {} });
});

test('T-41 / 9.11: a message over the limit gets one error reply and is thrown away up to its line feed; the next message is served', async () => {
  const h = harness({}, { maxBytes: 64 });
  h.input.write('{"jsonrpc":"2.0","id":1,"method":"echo","params":"' + 'x'.repeat(40));
  h.input.write('y'.repeat(40) + '"}\n{"jsonrpc":"2.0","id":2,"method":"echo"}\n');
  await h.settle();
  const msgs = h.out.map((l) => JSON.parse(l));
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].error.data.name, 'MessageTooLarge');
  assert.equal(msgs[1].id, 2);
  assert.equal(R.MAX_MESSAGE_BYTES, 1048576, 'the default limit is 1 MiB');
});

test('a message of exactly the limit is accepted', async () => {
  const body = (n) => '{"jsonrpc":"2.0","id":1,"method":"echo","params":"' + 'x'.repeat(n) + '"}';
  const len = body(0).length;
  const h = harness({}, { maxBytes: len + 10 });
  h.input.write(body(10) + '\n');
  await h.settle();
  assert.equal(JSON.parse(h.out[0]).id, 1);
});

test('SR-17 / T-20 (RPC part): a handler error is replied as an internal error with the error name only; stderr gets the name only, never the message', async () => {
  const h = harness();
  const fake = F.vendorToken(['gh', 'p_'].join(''), 30);
  h.input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'boom', params: { v: fake } }) + '\n');
  h.input.write('{"broken": "' + fake + '"\n');
  await h.settle();
  const msgs = h.out.map((l) => JSON.parse(l));
  const boom = msgs.find((m) => m.id === 1);
  assert.equal(boom.error.code, -32603);
  assert.equal(boom.error.data.name, 'TypeError');
  assert.equal(msgs.find((m) => m.id === null).error.code, -32700);
  assert.ok(!h.out.join('\n').includes(fake));
  assert.ok(!h.out.join('\n').includes('secret detail'));
  const errText = h.err.join('');
  assert.ok(!errText.includes(fake) && !errText.includes('secret detail'));
  for (const line of errText.split('\n').filter(Boolean)) assert.match(line, /^search-server: [A-Za-z_][A-Za-z0-9_]*$/);
});

test('an RpcError from a handler becomes that error reply', async () => {
  const h = harness();
  h.input.write('{"jsonrpc":"2.0","id":9,"method":"bad"}\n');
  await h.settle();
  assert.deepEqual(JSON.parse(h.out[0]).error, { code: -32602, message: 'Invalid params', data: { name: 'InvalidArgument' } });
});

test('stdout is ASCII only: every non-ASCII character is escaped as \\uXXXX, and the line still parses to the same value', async () => {
  const h = harness();
  const value = 'café   \u{1F600} ب‌ر';
  h.input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: value }) + '\n');
  await h.settle();
  assert.match(h.out[0], /^[\x20-\x7e]+$/);
  assert.equal(JSON.parse(h.out[0]).result.echo, value);
  assert.equal(R.asciiJson({ a: 'é' }), '{"a":"\\u00e9"}');
});

test('B7 review: a message whose method is not a string gets -32600 (with its id when valid); one with no method and no result or error too; a real response is still ignored', async () => {
  const h = harness();
  h.input.write('{"jsonrpc":"2.0","id":5,"method":7}\n');
  h.input.write('{"jsonrpc":"2.0","id":6,"method":null}\n');
  h.input.write('{"jsonrpc":"2.0","id":"s","method":{"x":1}}\n');
  h.input.write('{"jsonrpc":"2.0","id":7}\n');
  h.input.write('{"jsonrpc":"2.0","method":3}\n');
  h.input.write('{"jsonrpc":"2.0","id":8,"result":{"roots":[]}}\n');
  h.input.write('{"jsonrpc":"2.0","id":9,"error":{"code":1,"message":"m"}}\n');
  h.input.write('{"jsonrpc":"2.0","id":10,"method":"echo"}\n');
  await h.settle();
  const msgs = h.out.map((l) => JSON.parse(l));
  const invalid = (id) => ({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request', data: { name: 'InvalidRequest' } } });
  assert.deepEqual(msgs, [invalid(5), invalid(6), invalid('s'), invalid(7), invalid(null), { jsonrpc: '2.0', id: 10, result: {} }]);
  assert.deepEqual(h.seen.notes, [], 'none of them reached the notification handler');
});

test('B7 review: rpc.cjs source holds printable ASCII only (the U+FFFF bound is written as an escape), and asciiJson still escapes U+FFFF', () => {
  const src = require('node:fs').readFileSync(require.resolve('../../src/search/server/rpc.cjs'), 'utf8');
  const bad = [...src].filter((ch) => ch !== '\n' && (ch < ' ' || ch > '~'));
  assert.deepEqual(bad.map((ch) => ch.codePointAt(0).toString(16)), []);
  assert.equal(R.asciiJson(String.fromCharCode(0xffff)), '"\\uffff"');
  assert.equal(R.asciiJson(String.fromCharCode(0x7f)), '"\\u007f"');
  assert.equal(R.asciiJson('~'), '"~"');
});

test('the end of input calls onClose once', async () => {
  const h = harness();
  h.input.end();
  await h.settle();
  assert.equal(h.seen.closed, 1);
});
