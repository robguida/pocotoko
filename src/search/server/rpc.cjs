'use strict';
// Hand-written JSON-RPC 2.0 over stdio, one message per line (spec 7.1, 9.11,
// SR-46, SR-47, T-41).
//
// - Incoming messages are cut at line feeds. A message over 1 MiB gets an
//   error reply and is thrown away up to its line feed; the server keeps
//   serving.
// - Malformed JSON, a batch, a bad request shape (including a `method` that is
//   not a string) and an unknown method each get an error reply. Replies the
//   server never asked for (for example a roots reply) and unknown
//   notifications are ignored (SR-3).
// - Stdout carries protocol messages only, every non-ASCII character escaped as
//   \uXXXX. Diagnostics go to stderr by error name only: never a message, a
//   query or file text (SR-17, SR-47).

const MAX_MESSAGE_BYTES = 1024 * 1024;
const LF = 0x0a;

const CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

/** JSON with every character outside printable ASCII written as \uXXXX. */
function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-\uFFFF]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** An error a handler throws to get a JSON-RPC error reply with this code and a fixed data name. */
class RpcError extends Error {
  constructor(code, message, name) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.dataName = name || null;
  }
}

function errName(err) {
  if (!err) return 'Error';
  if (err instanceof RpcError) return err.dataName || 'RpcError';
  return typeof err.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(err.name) ? err.name : 'Error';
}

/**
 * Serve JSON-RPC on a readable and a writable stream.
 *
 * opts: {
 *   input, output, errorOut (streams),
 *   onRequest(method, params) -> result (may be async; throw RpcError for an error reply),
 *   onNotification(method, params),
 *   hasMethod(method) -> bool,
 *   onClose(),
 *   maxBytes (default 1 MiB)
 * }
 */
function serve(opts) {
  const output = opts.output;
  const errorOut = opts.errorOut;
  const maxBytes = opts.maxBytes || MAX_MESSAGE_BYTES;
  let parts = [];
  let size = 0;
  let discarding = false;
  let closed = false;

  function diag(name) {
    try { errorOut.write('search-server: ' + name + '\n'); } catch (_) { /* nothing more to do */ }
  }

  function send(msg) {
    if (closed) return;
    try {
      output.write(asciiJson(msg) + '\n');
    } catch (err) {
      diag(errName(err));
    }
  }

  function reply(id, result) {
    send({ jsonrpc: '2.0', id, result });
  }

  function replyError(id, code, message, name) {
    const error = { code, message };
    if (name) error.data = { name };
    send({ jsonrpc: '2.0', id: id === undefined ? null : id, error });
  }

  function validId(id) {
    return (typeof id === 'string' && id.length <= 256) || (typeof id === 'number' && Number.isFinite(id));
  }

  async function handleRequest(msg) {
    const { id, method } = msg;
    if (!opts.hasMethod(method)) {
      replyError(id, CODES.METHOD_NOT_FOUND, 'Method not found', 'MethodNotFound');
      return;
    }
    try {
      const result = await opts.onRequest(method, msg.params);
      reply(id, result === undefined ? {} : result);
    } catch (err) {
      if (err instanceof RpcError) {
        replyError(id, err.code, err.message, err.dataName);
      } else {
        diag(errName(err));
        replyError(id, CODES.INTERNAL_ERROR, 'Internal error', errName(err));
      }
    }
  }

  function handleLine(buf) {
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // some shells put a BOM before the first line
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (text.trim() === '') return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (_) {
      diag('ParseError');
      replyError(null, CODES.PARSE_ERROR, 'Parse error', 'ParseError');
      return;
    }
    if (Array.isArray(msg) || !msg || typeof msg !== 'object') {
      replyError(null, CODES.INVALID_REQUEST, 'Invalid Request', 'InvalidRequest');
      return;
    }
    if (msg.jsonrpc !== '2.0') {
      replyError(validId(msg.id) ? msg.id : null, CODES.INVALID_REQUEST, 'Invalid Request', 'InvalidRequest');
      return;
    }
    if (typeof msg.method !== 'string') {
      // A response (no `method`, and a `result` or an `error`): the server
      // sends no requests, so any reply (for example an unasked-for roots
      // reply) is ignored (SR-3). Anything else without a string method, for
      // example an `id` with a numeric or null `method`, is an invalid
      // request and gets -32600 (B7 review).
      const has = (k) => Object.prototype.hasOwnProperty.call(msg, k);
      if (!has('method') && (has('result') || has('error'))) return;
      replyError(validId(msg.id) ? msg.id : null, CODES.INVALID_REQUEST, 'Invalid Request', 'InvalidRequest');
      return;
    }
    if (msg.id === undefined) {
      try {
        if (opts.onNotification) opts.onNotification(msg.method, msg.params);
      } catch (err) {
        diag(errName(err));
      }
      return;
    }
    if (!validId(msg.id)) {
      replyError(null, CODES.INVALID_REQUEST, 'Invalid Request', 'InvalidRequest');
      return;
    }
    handleRequest(msg).catch((err) => diag(errName(err)));
  }

  function tooLarge() {
    diag('MessageTooLarge');
    replyError(null, CODES.INVALID_REQUEST, 'Message too large', 'MessageTooLarge');
  }

  function onData(chunk) {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(LF, start);
      const end = nl < 0 ? chunk.length : nl;
      const piece = chunk.subarray(start, end);
      if (!discarding) {
        if (size + piece.length > maxBytes) {
          discarding = true;
          parts = [];
          size = 0;
          tooLarge();
        } else if (piece.length) {
          parts.push(piece);
          size += piece.length;
        }
      }
      if (nl < 0) break;
      if (discarding) {
        discarding = false;
      } else {
        const line = parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
        parts = [];
        size = 0;
        try { handleLine(line); } catch (err) { diag(errName(err)); }
      }
      start = nl + 1;
    }
  }

  opts.input.on('data', (chunk) => {
    try {
      onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
    } catch (err) {
      diag(errName(err));
    }
  });
  const close = () => {
    if (closed) return;
    closed = true;
    if (opts.onClose) opts.onClose();
  };
  opts.input.on('end', close);
  opts.input.on('close', close);
  opts.input.on('error', (err) => { diag(errName(err)); close(); });

  return { send, diag };
}

module.exports = { MAX_MESSAGE_BYTES, CODES, RpcError, asciiJson, errName, serve };
