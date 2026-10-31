// Agent Brain v2.1 T10: the Interview Durable Object itself (worker.js), run in Node with the platform stubbed: `cloudflare:workers` and the compiled page are
// replaced by a module hook, WebSocketPair and the 101 response by fakes, Workers AI by a scripted binding. A socket that closes mid-interview suspends it
// (persisted, alarm armed), the next connection resumes it, the alarm purges it, a newer window still replaces the older one (and can resume it), and the
// checkpoint routes answer only for the identity the Worker forwarded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { CheckpointStore } from '../src/checkpoint.js';
import { FakeStorage, PROJECT, ANSWER, QUESTION, USER } from './reconnect-harness.js';
// Real time here (the Durable Object has no fake clock): poll every 5 ms for up to 10 s.
const until = async cond => { for (let i = 0; i < 2000 && !cond(); i++) await new Promise(r => setTimeout(r, 5)); if (!cond()) throw new Error('condition not reached'); };
const settle = (ms = 30) => new Promise(r => setTimeout(r, ms));

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) { if (spec === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}', shortCircuit: true }; return next(spec, ctx); }
export async function load(url, ctx, next) { if (url.endsWith('.html')) return { format: 'module', source: 'export default "<html></html>"', shortCircuit: true }; return next(url, ctx); }
`));
const pairs = [];
class Socket {
  constructor() { this.sent = []; this.ls = {}; this.closed = false; }
  accept() {} addEventListener(t, f) { (this.ls[t] ||= []).push(f); }
  send(x) { this.sent.push(x); } close() { this.closed = true; }
  fire(t, e = {}) { for (const f of this.ls[t] || []) f(e); }
  events() { return this.sent.filter(x => typeof x === 'string').map(x => JSON.parse(x)); }
}
globalThis.WebSocketPair = function () { const p = { 0: new Socket(), 1: new Socket() }; pairs.push(p); return p; };
const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { constructor(b, init) { if (init?.status === 101) { super(null, { status: 200 }); this.webSocket = init.webSocket; } else super(b, init); } };
const { Interview } = await import('../src/worker.js');

const sse = text => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ response: text })}\n\ndata: [DONE]\n\n`)); c.close(); } });
function env(extra = {}) {
  const talker = []; let n = 0;
  return { talker, TALKER_MODEL: 'talker', STT_MODEL: 'stt', TTS_MODEL: 'tts', TTS_VOICE: 'harmonia', ANALYST_MODEL: 'analyst', ...extra, AI: { async run(model, input) {
    if (model === 'tts') return new Uint8Array(4800).fill(1);
    if (model === 'talker') { talker.push(input.messages); return sse(n++ === 0 ? 'Hello. Where would you like to start?' : 'Thanks. ' + QUESTION); }
    return { tool_calls: [] };
  } } };
}
const headers = (user = USER) => ({ Upgrade: 'websocket', 'x-atlas-user': user, 'x-atlas-role': 'user', 'x-atlas-email': user, 'x-atlas-csrf': 'tok', 'x-atlas-admin': '0', 'x-atlas-bank': '' });
const connect = (d, user) => { const p = d.fetch(new Request('https://atlas.example/api/voice', { headers: headers(user) })); return { p, server: pairs.at(-1)[1] }; };
const start = extra => ({ data: JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: true, voice: 'atlas', memory: false, ...extra }) });
const cpKeys = st => st.keys().filter(k => k.startsWith('cp:'));
const ready = s => s.events().find(e => e.type === 'ready');
const spoken = s => s.events().filter(e => e.type === 'agent_text').map(e => e.text).join('');
const typed = (s, text) => s.fire('message', { data: JSON.stringify({ type: 'text', text }) });
async function interview(d, st) {
  const c = connect(d); await c.p; c.server.fire('message', start());
  await until(() => ready(c.server) && spoken(c.server).includes('Where would you like to start?'));
  await until(() => !d.session.busy());
  typed(c.server, ANSWER); await until(() => spoken(c.server).includes(QUESTION) && !d.session.busy());
  await until(() => st.keys().some(k => k.endsWith(':meta')) && !d.session.ckptRun);
  return c;
}

test('a socket that closes mid-interview suspends it: persisted in this Durable Object, 24-hour alarm armed; the next connection resumes it', async () => {
  const st = new FakeStorage(), e = env(), d = new Interview({ storage: st }, e);
  const a = await interview(d, st), id = ready(a.server).sessionId;
  assert.match(id, /^[a-f0-9]{32}$/); assert.equal(ready(a.server).resumable, true);
  a.server.fire('close'); await d.session.ending;
  assert.ok(cpKeys(st).includes(`cp:${id}:meta`)); assert.ok(st.alarm > Date.now() + 23 * 3600 * 1000 && st.alarm < Date.now() + 25 * 3600 * 1000);
  assert.ok(!a.server.events().some(x => x.type === 'notes'), 'no notes: the interview is not over');
  const stored = await new CheckpointStore(st, { owner: USER }).load(id);
  assert.equal(stored.machine.state, 'suspended', 'the close ran suspend(): the machine recorded the disconnect and the state was written once more');
  const calls = e.talker.length;
  const b = connect(d); b.server.fire('message', start({ resume: id })); await b.p; // the start arrives before the Durable Object has answered the upgrade: it is buffered
  await until(() => b.server.events().some(x => x.type === 'restore') && !d.session.busy());
  assert.equal(ready(b.server).resumed, true); assert.equal(e.talker.length, calls, 'the question is said again with no model call');
  assert.ok(spoken(b.server).includes(QUESTION)); assert.equal(b.server.events().find(x => x.type === 'restore').user[0].text, ANSWER);
  await d.session.end(false);
});

test('the alarm purges after 24 hours; before that it keeps the interview and re-arms', async () => {
  const st = new FakeStorage(), d = new Interview({ storage: st }, env()), a = await interview(d, st);
  a.server.fire('close'); await d.session.ending;
  const armed = st.alarm; await d.alarm(); assert.ok(cpKeys(st).length, 'not expired: kept'); assert.equal(st.alarm, armed);
  const realNow = Date.now; Date.now = () => realNow() + 24 * 3600 * 1000 + 1000;
  try { await d.alarm(); } finally { Date.now = realNow; }
  assert.equal(cpKeys(st).length, 0); assert.equal(st.alarm, null);
});

test('a newer window replaces the older one, the older one is kept, and the newer can resume it', async () => {
  const st = new FakeStorage(), d = new Interview({ storage: st }, env()), a = await interview(d, st), id = ready(a.server).sessionId, first = d.session;
  const b = connect(d); b.server.fire('message', start({ resume: id })); await b.p;
  assert.ok(first.finished); assert.ok(a.server.events().some(x => x.type === 'error' && /another window/.test(x.message)));
  await until(() => b.server.events().some(x => x.type === 'restore'));
  assert.equal(ready(b.server).resumed, true); assert.notEqual(d.session, first);
  await d.session.end(false);
});

test('a start that does not resume deletes a stored interview; discard deletes it too', async () => {
  const st = new FakeStorage(), d = new Interview({ storage: st }, env()), a = await interview(d, st), id = ready(a.server).sessionId;
  a.server.fire('close'); await d.session.ending; assert.ok(cpKeys(st).length);
  const b = connect(d); await b.p; b.server.fire('message', start()); await until(() => ready(b.server));
  assert.ok(!cpKeys(st).some(k => k.includes(id)), 'the old interview is gone'); assert.notEqual(ready(b.server).sessionId, id);
  await until(() => !d.session.busy()); await settle(20);
  b.server.fire('message', { data: JSON.stringify({ type: 'discard' }) }); await d.session.ending;
  assert.equal(cpKeys(st).length, 0); assert.equal(st.alarm, null);
});

test('ATLAS_CHECKPOINT=off: no checkpoint, a dropped socket ends the session as before', async () => {
  const st = new FakeStorage(), d = new Interview({ storage: st }, env({ ATLAS_CHECKPOINT: 'off' }));
  const c = connect(d); await c.p; c.server.fire('message', start()); await until(() => ready(c.server) && !d.session.busy());
  assert.ok(!('sessionId' in ready(c.server)));
  typed(c.server, ANSWER); await until(() => spoken(c.server).includes(QUESTION) && !d.session.busy()); await settle(30);
  c.server.fire('close'); await d.session.ending;
  assert.equal(st.keys().length, 0); assert.ok(c.server.events().some(x => x.type === 'ended'));
});

test('without a verified identity header there is no checkpoint at all, and the routes refuse', async () => {
  const st = new FakeStorage(), d = new Interview({ storage: st }, env());
  const c = connect(d, ''); await c.p; c.server.fire('message', start()); await until(() => ready(c.server));
  assert.ok(!('sessionId' in ready(c.server)));
  const r = await d.fetch(new Request('https://atlas.example/api/checkpoint')); assert.equal(r.status, 401);
  await d.session.end(false);
});

test('the checkpoint routes answer for the forwarded identity only', async () => {
  const st = new FakeStorage(), d = new Interview({ storage: st }, env()), a = await interview(d, st), id = ready(a.server).sessionId;
  a.server.fire('close'); await d.session.ending;
  const get = user => d.fetch(new Request('https://atlas.example/api/checkpoint', { headers: { 'x-atlas-user': user } })).then(r => r.json());
  assert.equal((await get(USER)).resumable.sessionId, id); assert.equal((await get('someone@else.example')).resumable, null);
  const del = user => d.fetch(new Request('https://atlas.example/api/checkpoint/discard', { method: 'POST', headers: { 'x-atlas-user': user } })).then(r => r.json());
  assert.deepEqual(await del('someone@else.example'), { discarded: false }); assert.ok(cpKeys(st).length);
  assert.deepEqual(await del(USER), { discarded: true }); assert.equal(cpKeys(st).length, 0);
});

// T11: the Interview DO hands the Session the hook that saves the confirmed summary as an owner-only draft: server to server, under the forwarded identity.
test('the confirmed summary is saved through the library binding under the forwarded identity; off with ATLAS_EVIDENCE_WORKFLOW=off or without the binding or the identity', async () => {
  const posts = [], LIBRARY = { idFromName: n => n, get: () => ({ fetch: async req => { posts.push([req.method, new URL(req.url).pathname, req.headers.get('x-atlas-user'), req.headers.get('x-atlas-role'), JSON.parse(await req.text())]); return new Response(JSON.stringify({ id: 'e1', revision: 1 }), { status: 201 }); } }) };
  const hook = async (extra, user) => { const d = new Interview({ storage: new FakeStorage() }, env(extra)), c = connect(d, user); await c.p; c.server.fire('message', start()); await until(() => ready(c.server)); const h = d.session.evidence; await d.session.end(false); return h; };
  const on = await hook({ LIBRARY });
  assert.equal(typeof on, 'function');
  assert.deepEqual(await on({ session_id: 's1', details: [{ id: 'D-001' }] }), { status: 201, body: { id: 'e1', revision: 1 } });
  assert.deepEqual(posts.map(p => p.slice(0, 4)), [['POST', '/api/evidence', USER, 'user']]); assert.equal(posts[0][4].notes.session_id, 's1');
  assert.equal(await hook({ LIBRARY, ATLAS_EVIDENCE_WORKFLOW: 'off' }), null);
  assert.equal(await hook({}), null);
  assert.equal(await hook({ LIBRARY }, ''), null);
});
