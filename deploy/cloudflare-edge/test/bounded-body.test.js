// B1 (4) / red review M5: a chunked body with no Content-Length is never buffered past the route's cap. Regression of
// /tmp/claude-501/audit2/red/pocs/client/p1_unbounded_body.mjs: before the fix /api/sheet/* and /api/jev/classify pulled the WHOLE 80 MB
// (rss +80..240 MB); now the stream is cancelled right after the cap and the answer is 413.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.js';
import { sheetRoutes } from '../src/sheet.js';
import { ENV, ORIGIN, session, ns } from './security-harness.js';

const CH = 256 * 1024;
// A streaming upload that reports how many bytes the server actually pulled from it. No Content-Length (chunked).
function stream(totalBytes, fill = 0x20) {
  const state = { pulled: 0 };
  const body = new ReadableStream({ pull(c) { if (state.pulled >= totalBytes) { c.close(); return; } const n = Math.min(CH, totalBytes - state.pulled); state.pulled += n; c.enqueue(new Uint8Array(n).fill(fill)); } });
  return { body, state };
}
const MB = 1024 * 1024;
async function probe(me, path, mb, extra = {}) {
  const { body, state } = stream(mb * MB);
  const res = await me.go(path, { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream', ...extra } });
  return { res, pulledMB: state.pulled / MB, state };
}
const env = () => ({ ...ENV, TRIGGER_SECRET: 't'.repeat(16), DIRECTORY_PUSH_SECRET: 'd'.repeat(16), DIRECTORY_PUSH: 'on', HINDSIGHT_API_KEY: 'k', HINDSIGHT_BANK_SECRET: 'b', TYPESAFE_API_KEY: 'k',
  AI: { toMarkdown: async () => ({ format: 'markdown', data: 'x' }), run: async () => ({ response: '{}' }) },
  LIBRARY: ns(async r => new Response(JSON.stringify({ forwarded: (await r.arrayBuffer()).byteLength }))), INTERVIEW: ns(async r => new Response(JSON.stringify({ forwarded: (await r.arrayBuffer()).byteLength }))) });

test('boundedBytes: exact cap passes, one byte over is null, the stream is cancelled, a declared length over the cap never starts reading', async () => {
  const { boundedBytes, boundedText, boundedJson } = await import('../src/bounded.js'); // dynamic: the PoC tests below must also run (and fail) against pre-B1 code
  const mk = (n, h = {}) => new Request('https://x.test/', { method: 'POST', body: new Uint8Array(n), headers: h });
  assert.equal((await boundedBytes(mk(100), 100)).length, 100);
  assert.equal(await boundedBytes(mk(101), 100), null);
  assert.equal((await boundedBytes(new Request('https://x.test/'), 10)).length, 0);
  let cancelled = false, pulls = 0;
  const body = new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(1000)); }, cancel() { cancelled = true; } });
  assert.equal(await boundedBytes(new Request('https://x.test/', { method: 'POST', body, duplex: 'half' }), 2500), null);
  assert.ok(cancelled); assert.ok(pulls <= 5, 'pulled ' + pulls);
  assert.equal(await boundedText(mk(3), 10), '\0\0\0');
  assert.deepEqual(await boundedJson(new Request('https://x.test/', { method: 'POST', body: '{"a":1}' }), 100), { value: { a: 1 } });
  assert.deepEqual(await boundedJson(new Request('https://x.test/', { method: 'POST', body: 'nope' }), 100), { invalid: true });
  assert.deepEqual(await boundedJson(new Request('https://x.test/', { method: 'POST', body: '{"a":"' + 'x'.repeat(200) + '"}' }), 100), { tooLarge: true });
});

test('M5 PoC: an 80 MB chunked body on every body-reading route is cut off at the cap with 413 (memory stays bounded)', async () => {
  const e = env(), me = await session(e), rows = [];
  const cases = [['/api/sheet/ingest', 10 + 1, 'The file is larger than 10 MB'], ['/api/sheet/draft', 2 + 1, 'too large'], ['/api/sheet/visuals', 12 + 1, 'too large'],
    ['/api/jev/classify', 0.0625 + 0.5, 'too large to score'], ['/api/library', 0.25 + 0.5, 'too large'], ['/api/memory/remember', 0.125 + 0.5, 'too large']];
  for (const [path, capPlusSlackMB, msg] of cases) {
    const { res, pulledMB } = await probe(me, path, 80);
    assert.equal(res.status, 413, path); assert.match((await res.json()).error, new RegExp(msg), path);
    assert.ok(pulledMB <= capPlusSlackMB + CH / MB * 2, `${path} pulled ${pulledMB} MB (cap+slack ${capPlusSlackMB})`);
    rows.push(`${path} pulled=${pulledMB.toFixed(2)}MB`);
  }
  assert.equal(e.LIBRARY.calls.length, 0, 'an oversized body is never forwarded'); assert.equal(e.INTERVIEW.calls.filter(c => new URL(c.request.url).pathname.startsWith('/api/memory')).length, 0);
  console.log('# M5 regression:', rows.join('; '));
});

test('M5 PoC: the bearer-secret routes are bounded too (triggers 16 KiB, directory push 256 KiB)', async () => {
  const e = env();
  for (const [path, token, cap] of [['/api/triggers', 't'.repeat(16), 16384], ['/api/directory/push', 'd'.repeat(16), 262144]]) {
    const { body, state } = stream(80 * MB);
    const res = await handle(new Request(ORIGIN + path, { method: 'POST', body, duplex: 'half', headers: { Authorization: 'Bearer ' + token } }), e, '');
    assert.equal(res.status, 413, path); assert.ok(state.pulled <= cap + CH * 2, `${path} pulled ${state.pulled}`);
  }
  assert.equal(e.LIBRARY.calls.length, 0);
  // and the normal-sized request still goes through with its full body
  const ok = await handle(new Request(ORIGIN + '/api/triggers', { method: 'POST', body: JSON.stringify({ a: 'b'.repeat(1000) }), headers: { Authorization: 'Bearer ' + 't'.repeat(16) } }), e, '');
  assert.equal(ok.status, 200); assert.equal((await ok.json()).forwarded, 1008);
});

test('routes still accept bodies just under their caps and forward them whole', async () => {
  const e = env(), me = await session(e);
  const lib = await me.go('/api/library', { method: 'POST', body: JSON.stringify({ t: 'x'.repeat(200000) }) });
  assert.equal(lib.status, 200); assert.equal((await lib.json()).forwarded, 200000 + 8);
  const mem = await me.go('/api/memory/remember', { method: 'POST', body: JSON.stringify({ t: 'x'.repeat(100000) }) });
  assert.equal(mem.status, 200); assert.equal((await mem.json()).forwarded, 100000 + 8);
  const cls = await me.go('/api/jev/classify', { method: 'POST', body: JSON.stringify({ project: { title: 'x'.repeat(50000) } }) });
  assert.notEqual(cls.status, 413);
  assert.equal((await me.go('/api/jev/classify', { method: 'POST', body: '{not json' })).status, 400);
});

test('sheetRoutes itself (the PoC target): ingest reads at most 10 MB, draft 2 MiB, visuals 12 MiB, and an unknown path is a 404 before any read', async () => {
  const ai = { toMarkdown: async () => ({ format: 'markdown', data: 'x' }), complete: async () => '{}' };
  const mk = (stateBody, h = {}) => new Request('https://atlas.test/x', { method: 'POST', body: stateBody, duplex: 'half', headers: h });
  for (const [path, capMB] of [['ingest', 10], ['draft', 2], ['visuals', 12]]) {
    const { body, state } = stream(80 * MB);
    const r = await sheetRoutes(mk(body, { 'Content-Type': 'application/octet-stream' }), path, ai);
    assert.equal(r.status, 413, path); assert.ok(state.pulled / MB <= capMB + 0.6, `${path} pulled ${state.pulled / MB}`);
  }
  const { body, state } = stream(80 * MB);
  assert.equal((await sheetRoutes(mk(body), 'bogus', ai)).status, 404); assert.ok(state.pulled <= CH, 'nothing beyond the runtime prefetch was read');
  assert.equal((await sheetRoutes(new Request('https://atlas.test/x', { method: 'POST', body: new Uint8Array(0) }), 'ingest', ai)).status, 400);
});
