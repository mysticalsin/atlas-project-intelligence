// B1 in the Durable Objects themselves (worker.js, platform stubbed like worker-interview.test.js): the interview-start budget,
// /api/limit reachable only as the Worker's internal call, the daily audit-chain verification inside the LibraryStore, ATLAS_AI_OFF in the library.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { FakeStorage, PROJECT, USER } from './reconnect-harness.js';
import { memorySql } from './sqlite.js';
import { appendAudit } from '../src/audit-chain.js';

const until = async cond => { for (let i = 0; i < 2000 && !cond(); i++) await new Promise(r => setTimeout(r, 5)); if (!cond()) throw new Error('condition not reached'); };
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) { if (spec === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}', shortCircuit: true }; return next(spec, ctx); }
export async function load(url, ctx, next) { if (url.endsWith('.html')) return { format: 'module', source: 'export default "<html></html>"', shortCircuit: true }; return next(url, ctx); }
`));
const pairs = [];
class Socket {
  constructor() { this.sent = []; this.ls = {}; this.closed = null; }
  accept() {} addEventListener(t, f) { (this.ls[t] ||= []).push(f); }
  send(x) { this.sent.push(x); } close(code) { this.closed = code ?? 1000; }
  fire(t, e = {}) { for (const f of this.ls[t] || []) f(e); }
  events() { return this.sent.filter(x => typeof x === 'string').map(x => JSON.parse(x)); }
}
globalThis.WebSocketPair = function () { const p = { 0: new Socket(), 1: new Socket() }; pairs.push(p); return p; };
const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse { constructor(b, init) { if (init?.status === 101) { super(null, { status: 200 }); this.webSocket = init.webSocket; } else super(b, init); } };
const { Interview, LibraryStore } = await import('../src/worker.js');

const sse = text => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ response: text })}\n\ndata: [DONE]\n\n`)); c.close(); } });
const env = (extra = {}) => ({ TALKER_MODEL: 'talker', STT_MODEL: 'stt', TTS_MODEL: 'tts', TTS_VOICE: 'harmonia', ANALYST_MODEL: 'analyst', ...extra, AI: { async run(model) { if (model === 'tts') return new Uint8Array(4800).fill(1); if (model === 'talker') return sse('Hello. Where would you like to start?'); return { tool_calls: [] }; } } });
const headers = (user = USER) => ({ Upgrade: 'websocket', 'x-atlas-user': user, 'x-atlas-role': 'user', 'x-atlas-email': user, 'x-atlas-csrf': 'tok', 'x-atlas-admin': '0', 'x-atlas-bank': '', 'x-atlas-subj': 'ab12cd34ef56ab12cd34ef56ab12cd34' });
const connect = d => { const p = d.fetch(new Request('https://atlas.example/api/voice', { headers: headers() })); return { p, server: pairs.at(-1)[1] }; };
const startMsg = extra => ({ data: JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, capture: true, voice: 'atlas', memory: false, ...extra }) });
const logsOf = async fn => { const lines = [], orig = console.log; console.log = l => { try { lines.push(JSON.parse(l)); } catch { /* not ours */ } }; try { await fn(); } finally { console.log = orig; } return lines; };

test('interview starts are capped per hour: the 7th fresh start in an hour is refused politely, nothing starts, the socket closes with 1013, a security event is logged', async () => {
  const st = new FakeStorage(), d = new Interview({ storage: st }, env({ RL_INTERVIEW_HOUR: '2' }));
  const open = async () => { const c = connect(d); await c.p; c.server.fire('message', startMsg()); return c; };
  const a = await open(); await until(() => a.server.events().some(e => e.type === 'ready'));
  const b = await open(); await until(() => b.server.events().some(e => e.type === 'ready'));
  const logs = await logsOf(async () => {
    const c = await open(); await until(() => c.server.closed);
    const ev = c.server.events(); assert.equal(ev.length, 1); assert.equal(ev[0].type, 'error'); assert.equal(ev[0].code, 'rate-limited'); assert.match(ev[0].message, /try again in about \d+ minute/); assert.equal(c.server.closed, 1013);
    assert.ok(!ev.some(e => e.type === 'ready'), 'no interview started');
    await new Promise(r => setTimeout(r, 20));
  });
  const rl = logs.find(e => e.event === 'rate_limited'); assert.ok(rl); assert.equal(rl.reason, 'RATE:INTERVIEW_H'); assert.equal(rl.route, '/api/voice'); assert.equal(rl.subj, 'ab12cd34ef56ab12'); assert.ok(!JSON.stringify(rl).includes(USER));
  assert.ok(st.keys().some(k => k.startsWith('rl:interview-h:')) && st.keys().some(k => k.startsWith('rl:interview-d:')));
  // the budget is persisted: a new Durable Object instance over the same storage (eviction) is still refused
  const d2 = new Interview({ storage: st }, env({ RL_INTERVIEW_HOUR: '2' })), c2 = connect(d2); await c2.p; c2.server.fire('message', startMsg()); await until(() => c2.server.closed);
  assert.equal(c2.server.events()[0].code, 'rate-limited');
});

test('a resume of a saved interview and every later message are not starts; a different person has their own Durable Object and budget', async () => {
  const st = new FakeStorage(), d = new Interview({ storage: st }, env({ RL_INTERVIEW_HOUR: '1', RL_INTERVIEW_DAY: '1' }));
  const first = connect(d); await first.p; first.server.fire('message', startMsg()); await until(() => first.server.events().some(e => e.type === 'ready'));
  // 'resume' with an id that does not exist: answered by the session ('unavailable'), never by the limiter
  const r = connect(d); await r.p; r.server.fire('message', startMsg({ resume: 'f'.repeat(32) })); await new Promise(x => setTimeout(x, 60));
  assert.ok(!r.server.events().some(e => e.code === 'rate-limited'), 'a resume does not spend or check the start budget');
  // (X2: a first message that is not a valid resume is a start, whatever it says: the budget is decided from the parsed message, never from its size)
  const typedMore = connect(d); await typedMore.p; typedMore.server.fire('message', { data: '{"type":"junk"}' }); await until(() => typedMore.server.events().some(e => e.code === 'rate-limited'));
  const other = new Interview({ storage: new FakeStorage() }, env({ RL_INTERVIEW_HOUR: '1', RL_INTERVIEW_DAY: '1' })), o = connect(other); await o.p; o.server.fire('message', startMsg());
  await until(() => o.server.events().some(e => e.type === 'ready'));
});

test('messages sent while the budget is being read are held and reach the session in their original order', async () => {
  const st = new FakeStorage(), d = new Interview({ storage: st }, env()), c = connect(d); await c.p;
  const seen = [], onText = d.session.onText.bind(d.session); d.session.onText = t => { seen.push(JSON.parse(t).type); return onText(t); };
  c.server.fire('message', startMsg()); c.server.fire('message', { data: JSON.stringify({ type: 'repeat' }) }); c.server.fire('message', { data: JSON.stringify({ type: 'skip' }) });
  assert.deepEqual(seen, [], 'nothing is dispatched until the budget has been read');
  await until(() => seen.length === 3);
  assert.deepEqual(seen, ['start', 'repeat', 'skip']);
});

test('/api/limit is the Interview DO\'s internal endpoint; its counters live in that person\'s storage', async () => {
  const st = new FakeStorage(), d = new Interview({ storage: st }, env());
  const res = await d.fetch(new Request('https://atlas.internal/api/limit', { method: 'POST', body: JSON.stringify({ checks: [{ bucket: 'sheet', max: 1, windowMs: 3600000 }] }), headers: { 'x-atlas-user': USER } }));
  assert.equal(res.status, 200);
  assert.equal((await d.fetch(new Request('https://atlas.internal/api/limit', { method: 'POST', body: JSON.stringify({ checks: [{ bucket: 'sheet', max: 1, windowMs: 3600000 }] }) }))).status, 429);
});

test('LibraryStore: the daily scan-stale call (system role only) verifies the audit chain and logs ok / a break with the chain head; the response is unchanged', async () => {
  const sql = memorySql(), ctx = { storage: { sql }, waitUntil: p => p }, store = new LibraryStore(ctx, env());
  appendAudit(sql, { id: 'a', actor: 'x', action: 'saved', at: 't1', detail: '' }); appendAudit(sql, { id: 'b', actor: 'y', action: 'saved', at: 't2', detail: '' });
  const cron = role => store.fetch(new Request('https://atlas.internal/api/library/scan-stale', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'x-atlas-user': 'atlas-cron', 'x-atlas-role': role } }));
  let res; const ok = await logsOf(async () => { res = await cron('system'); });
  assert.equal(res.status, 200); assert.ok('invited' in await res.json());
  const good = ok.find(e => e.event === 'audit_chain_ok'); assert.ok(good); assert.equal(good.n, 2); assert.match(good.head, /^[0-9a-f]{16}$/);
  sql.exec("UPDATE audit SET actor = 'mallory' WHERE seq = 1");
  const bad = await logsOf(async () => { await cron('system'); });
  const br = bad.find(e => e.event === 'audit_chain_break'); assert.ok(br); assert.equal(br.reason, 'HASH_MISMATCH'); assert.equal(br.n, 1);
  assert.ok(!JSON.stringify(bad).includes('mallory'), 'the log never carries row content');
  const user = await logsOf(async () => { await cron('user'); }); assert.ok(!user.some(e => e.event === 'audit_chain_ok' || e.event === 'audit_chain_break'), 'a non-system caller cannot trigger it');
});

test('LibraryStore with ATLAS_AI_OFF has no completion, embedding or JEV rater; without it the review agent exists as before', async () => {
  const mk = extra => new LibraryStore({ storage: { sql: memorySql() }, waitUntil: p => p }, env({ TYPESAFE_API_KEY: 'k', ...extra }));
  const off = mk({ ATLAS_AI_OFF: '1' }), on = mk({});
  assert.equal(off.lib.complete, null); assert.equal(off.lib.embed, null); assert.equal(off.lib.rater, null);
  assert.equal(typeof on.lib.complete, 'function'); assert.equal(typeof on.lib.embed, 'function');
});
