// A minimal RFC 6455 WebSocket server for the local, offline edge (dev only, no dependencies). It does what the Interview
// Durable Object needs and nothing more: the opening handshake, text and binary messages (masked by the client, unmasked by
// us), fragmentation, ping/pong and the close handshake. It also supplies the Workers runtime pieces worker.js expects
// (`WebSocketPair`, a 101 Response that carries `webSocket`), so the REAL Interview class runs unchanged. Never deploy this file.
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', MAX_MESSAGE = 4 * 1024 * 1024;

// The server end of a Workers WebSocketPair. Until a network socket is attached, outgoing messages wait.
class Endpoint {
  constructor() { this.ls = {}; this.out = []; this.net = null; this.closed = false; }
  accept() {}
  addEventListener(type, fn) { (this.ls[type] ||= []).push(fn); }
  fire(type, event = {}) { for (const fn of this.ls[type] || []) { try { fn(event); } catch (e) { console.error('websocket handler:', e?.message || e); } } }
  send(data) { if (this.closed || this.net?.destroyed) throw new Error('socket closed'); this.net ? this.net.write(frame(typeof data === 'string' ? 1 : 2, data)) : this.out.push(data); }
  close(code = 1000, reason = '') {
    if (this.closed) return; this.closed = true;
    if (this.net && !this.net.destroyed) { const body = Buffer.alloc(2 + Buffer.byteLength(reason)); body.writeUInt16BE(code); body.write(reason, 2); this.net.end(frame(8, body)); }
  }
}

function frame(opcode, payload) {
  const body = typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(payload.buffer ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength) : payload);
  const n = body.length, head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (b => (b.writeBigUInt64BE(BigInt(n)), b))(Buffer.alloc(8))]);
  return Buffer.concat([head, body]);
}

// Incoming frames -> whole messages. onMessage(isText, Buffer); onClose(); the parser answers ping and close itself.
function reader(net, onMessage, onClose) {
  let buf = Buffer.alloc(0), parts = [], textual = true, size = 0;
  const fail = code => { try { net.end(frame(8, Buffer.from([code >> 8, code & 255]))); } catch { /* gone */ } onClose(); };
  net.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = !!(buf[0] & 0x80), op = buf[0] & 15, masked = !!(buf[1] & 0x80);
      let len = buf[1] & 127, at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > BigInt(MAX_MESSAGE)) return fail(1009); len = Number(big); at = 10; }
      if (!masked) return fail(1002); // a client must mask (RFC 6455 5.1)
      if (len > MAX_MESSAGE) return fail(1009);
      if (buf.length < at + 4 + len) return;
      const mask = buf.subarray(at, at + 4), data = Buffer.from(buf.subarray(at + 4, at + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(at + 4 + len);
      if (op === 8) { try { net.end(frame(8, data.subarray(0, 2))); } catch { /* gone */ } return onClose(); }
      if (op === 9) { net.write(frame(10, data)); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2) { parts = []; size = 0; textual = op === 1; } else if (op !== 0) return fail(1002);
      parts.push(data); size += data.length;
      if (size > MAX_MESSAGE) return fail(1009);
      if (fin) { const whole = Buffer.concat(parts); parts = []; size = 0; onMessage(textual, whole); }
    }
  });
  net.on('close', onClose); net.on('error', onClose);
}

// Install once, before worker.js is imported: the runtime globals it uses.
export function installRuntime() {
  globalThis.WebSocketPair = function () { const client = { peer: null }, server = new Endpoint(); client.peer = server; return { 0: client, 1: server }; };
  const RealResponse = globalThis.Response;
  globalThis.Response = class extends RealResponse { // Node refuses status 101: carry the socket on an ordinary response
    constructor(body, init) { if (init?.status === 101) { super(null, { status: 200 }); this.webSocket = init.webSocket; this.upgrade = true; } else super(body, init); }
  };
}

// server.on('upgrade') handler. toResponse(req): a promise of the Worker's Response for this upgrade request.
export function upgradeHandler(toResponse) {
  return async (req, net) => {
    const key = req.headers['sec-websocket-key'];
    if (String(req.headers.upgrade).toLowerCase() !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') { net.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const queue = []; let endpoint = null, gone = false;
    const onClose = () => { if (gone) return; gone = true; if (endpoint) { endpoint.closed = true; endpoint.fire('close', { code: 1005 }); } };
    // Frames that arrive while the Worker is still answering are kept, in order, and delivered after it has.
    reader(net, (text, data) => (endpoint ? deliver(endpoint, text, data) : queue.push([text, data])), onClose);
    let res;
    try { res = await toResponse(req); } catch { res = null; }
    if (!res?.upgrade || !res.webSocket?.peer) { // a refusal (426, 403, 503...) is answered as plain HTTP
      const status = res?.status || 502, text = res ? await res.text().catch(() => '') : 'Upgrade failed';
      net.end(`HTTP/1.1 ${status} Refused\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`); gone = true; return;
    }
    endpoint = res.webSocket.peer; endpoint.net = net;
    net.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash('sha1').update(key + GUID).digest('base64')}\r\n\r\n`);
    for (const m of endpoint.out.splice(0)) net.write(frame(typeof m === 'string' ? 1 : 2, m));
    for (const [text, data] of queue.splice(0)) deliver(endpoint, text, data);
    if (gone) endpoint.fire('close', { code: 1005 });
  };
}
const deliver = (endpoint, text, data) => endpoint.fire('message', { data: text ? data.toString('utf8') : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
