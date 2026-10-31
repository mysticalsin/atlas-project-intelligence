// v2.2 D1: a real typed interview in the offline local edge. dev/local-edge.mjs is started on a free port as a child process (the real handle(), the
// real Library, the REAL Interview Durable Object and Session on an in-memory Durable Object stand-in, the offline fake models) and a test client speaks
// RFC 6455 to /api/voice: a typed English interview from the start (consent object) through the read-back and the confirmation to a private draft that only the
// owner can read, then the explicit Submit for review; and a French answer that gets a French reply. No network, no provider, no browser.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const EDGE = new URL('..', import.meta.url).pathname;
let child, base, port;
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
before(async () => {
  port = await freePort(); base = `http://127.0.0.1:${port}`;
  child = spawn('node', ['--no-warnings', 'dev/local-edge.mjs', String(port)], { cwd: EDGE, env: { ...process.env, ATLAS_ADAPTERS: 'mock' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', d => { out += d; });
  for (let i = 0; i < 150; i++) { try { await fetch(base + '/__settle'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  assert.match(out, /offline fake models/, 'the startup line says the models are fakes');
});
after(() => child?.kill());

const json = async (path, as, init = {}) => { const r = await fetch(base + path + (path.includes('?') ? '&' : '?') + 'as=' + as, init); return { status: r.status, body: await r.json().catch(() => null) }; };

// A tiny RFC 6455 client: masked text frames out, whole text messages in.
function mask(payload) {
  const b = Buffer.from(payload), key = randomBytes(4), n = b.length, head = n < 126 ? Buffer.from([0x81, 0x80 | n]) : Buffer.from([0x81, 0x80 | 126, n >> 8, n & 255]);
  return Buffer.concat([head, key, Buffer.from(b.map((x, i) => x ^ key[i & 3]))]);
}
function connect(user, { origin = base } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' };
    if (origin) headers.Origin = origin;
    const req = http.request({ host: '127.0.0.1', port, path: '/api/voice?as=' + user, headers });
    req.on('response', res => { res.resume(); resolve({ refused: res.statusCode }); });
    req.on('error', reject);
    req.on('upgrade', (res, sock) => {
      const events = []; let buf = Buffer.alloc(0), closed = false;
      sock.on('data', c => {
        buf = Buffer.concat([buf, c]);
        for (;;) {
          if (buf.length < 2) return;
          let len = buf[1] & 127, at = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
          if (buf.length < at + len) return;
          const op = buf[0] & 15, data = buf.subarray(at, at + len); buf = buf.subarray(at + len);
          if (op === 1) events.push(JSON.parse(data.toString())); else if (op === 8) closed = true;
        }
      });
      const c = { events, send: o => sock.write(mask(JSON.stringify(o))), close: () => sock.destroy(), isClosed: () => closed, status: res.statusCode, accept: res.headers['sec-websocket-accept'],
        text: () => events.filter(e => e.type === 'agent_text').map(e => e.text).join(''),
        until: async (cond, what, ms = 15000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what + '; last events ' + JSON.stringify(events.slice(-3)).slice(0, 600)); await new Promise(r => setTimeout(r, 25)); } } };
      resolve(c);
    });
    req.end();
  });
}

const PROJECT = { id: 'p-local-demo', title: 'Claims intake (synthetic)', role: 'Designer', sector: 'Insurance', stage: 'Pilot', oppId: 'OPP-123', answers: [] };
async function start(user, { language = 'en' } = {}) {
  const boot = (await json('/api/bootstrap', user)).body, ws = await connect(user);
  assert.equal(ws.status, 101, 'upgrade accepted');
  ws.send({ type: 'start', csrf: boot.csrf, consent: { version: boot.privacy.version, transcription: false, draft: true, checkpoint: false, memory: false, notice: true }, project: PROJECT, voice: 'atlas', capture: true, memory: false, language, mode: 'text' });
  await ws.until(() => ws.events.some(e => e.type === 'ready') && /project/.test(ws.text()), 'the ready event and the opening question');
  return { ws, boot };
}
// A typed answer, then the reply to it: one more `agent_text` after the user's text has been taken in.
async function answer(ws, text) {
  const before = ws.events.length, sent = Date.now(); ws.send({ type: 'text', text });
  await ws.until(() => ws.events.slice(before).some(e => e.type === 'user_text') && ws.events.slice(before).some(e => e.type === 'agent_text'), 'ATLAS to reply to ' + text.slice(0, 30));
  await quiet(ws); await new Promise(r => setTimeout(r, Math.max(0, 1800 - (Date.now() - sent)))); // (one typed answer per 1.5 s at most: TYPED_MIN_INTERVAL_S)
}
// The turn is over when nothing more has arrived for a moment (the reply, the analyst's notes and the next plan are in).
async function quiet(ws, ms = 900) { let n = -1; for (let i = 0; i < 100 && n !== ws.events.length; i++) { n = ws.events.length; await new Promise(r => setTimeout(r, ms)); } }
const ANSWERS = [
  'We rebuilt the claims intake process for an insurance client during the pilot. Claims were bouncing between three teams and payouts were slow. I designed and built the routing model.',
  'Before, the median triage time was forty minutes per claim, measured on the team dashboard over six weeks.',
  'After the pilot the median triage time dropped to twelve minutes, according to the same dashboard over the next six weeks.',
  'The claims team of eight people used it daily and the operations lead owned it after my handover. We chose rules instead of a learned model because auditors needed to read every decision.',
  "I don't know of any other evidence. The limit is that the pilot covered only one region.",
  'It would suit insurers with a fragmented claims queue. It would not fit a company without a central triage team.',
];

test('the voice upgrade answers like a WebSocket server: 101 with the right accept key; no Origin, no upgrade', async () => {
  const ok = await connect('alex@mantu.com'); assert.equal(ok.status, 101); assert.ok(ok.accept.length >= 20); ok.close();
  assert.equal((await connect('alex@mantu.com', { origin: null })).refused, 403, 'the real Worker refuses a socket without the page origin');
  assert.equal((await connect('alex@mantu.com', { origin: 'http://evil.example' })).refused, 403);
});

test('a typed interview end to end: answers, read-back, confirmation, a private draft only the owner can read, then Submit for review', async () => {
  const owner = 'alex@mantu.com', { ws, boot } = await start(owner);
  assert.equal(boot.textMode, true);
  assert.equal(boot.voice, false); // U1: no speech service locally, so the page leads with the typed interview
  const ready = ws.events.find(e => e.type === 'ready');
  assert.equal(ready.input, 'text'); assert.ok(ready.controls.includes('pause'));
  assert.doesNotMatch(ws.text(), /alex/i, 'the consultant\'s name is never in what ATLAS says');
  for (const a of ANSWERS) await answer(ws, a);
  await ws.until(() => ws.events.some(e => e.type === 'summary'), 'the read-back card');
  const card = ws.events.findLast(e => e.type === 'summary');
  assert.ok(card.items.length >= 3 && card.items.every(i => i.detail_id && i.quote && i.provenance === 'consultant_typed'), 'the card lists exact quotes with their provenance');
  assert.match(ws.text(), /What have I misunderstood or missed\?/);
  // Keep private and Correct work on the real ledger.
  const kept = card.items[0].detail_id, keptQuote = card.items[0].quote; ws.send({ type: 'withhold', detail_id: kept });
  await ws.until(() => !ws.events.findLast(e => e.type === 'summary').items.some(i => i.detail_id === kept), 'the kept-private item to leave the card');
  const fix = ws.events.findLast(e => e.type === 'summary').items[0];
  ws.send({ type: 'correct', detail_id: fix.detail_id, text: 'It was one team and one claims queue, not the whole company.' });
  await ws.until(() => ws.events.findLast(e => e.type === 'summary').items.some(i => /one claims queue/.test(i.quote)), 'the typed correction on the card');
  await quiet(ws);
  ws.send({ type: 'confirm_summary' });
  await ws.until(() => ws.events.some(e => e.type === 'evidence_draft'), 'the private draft');
  const draft = ws.events.find(e => e.type === 'evidence_draft');
  assert.equal(draft.visibility, 'owner_only'); assert.equal(draft.state, 'evidence_draft'); assert.equal(draft.revision, 1);
  // The real Library: the owner reads it; nobody else does, not even a reviewer; it is not submitted.
  const mine = await json('/api/library/evidence/' + draft.id, owner);
  assert.equal(mine.status, 200); assert.equal(mine.body.state, 'evidence_draft');
  const filed = JSON.stringify(mine.body);
  assert.ok(!filed.includes(keptQuote), 'what the consultant kept private is not in the draft'); assert.ok(filed.includes('one claims queue'), 'their typed correction is');
  for (const other of ['kim@mantu.com', 'reviewer@mantu.com']) {
    assert.ok([403, 404].includes((await json('/api/library/evidence/' + draft.id, other)).status), other + ' cannot read the owner\'s draft');
    assert.ok(!JSON.stringify((await json('/api/library/evidence', other)).body ?? {}).includes(draft.id), other + ' does not see it listed');
  }
  assert.ok(JSON.stringify((await json('/api/library/evidence', owner)).body).includes(draft.id), 'the owner sees it listed');
  // Submit for review is the explicit step, with the revision the owner saw (the page's own POST: Origin and CSRF as every browser POST).
  const headers = { 'Content-Type': 'application/json', Origin: base, 'X-Atlas-CSRF': boot.csrf };
  const submit = await json('/api/library/evidence/' + draft.id + '/submit', owner, { method: 'POST', headers, body: JSON.stringify({ expected_revision: 1 }) });
  assert.equal(submit.status, 200, JSON.stringify(submit.body)); assert.equal(submit.body.state, 'reviewer_queue');
  ws.close();
});

test('a French answer gets a French reply, and the localized read-back lines and question', async () => {
  const { ws } = await start('camille@mantu.com');
  await answer(ws, "Nous avons reconstruit le processus d'accueil des sinistres pour un client assureur. Les dossiers passaient entre trois équipes et les paiements étaient lents. J'ai conçu et construit le modèle d'acheminement.");
  await answer(ws, "Avant, le temps médian de tri était de quarante minutes par dossier, mesuré sur le tableau de bord de l'équipe pendant six semaines.");
  const said = ws.text().split('\n\n').slice(1).join('\n\n'); // after the greeting and the first question
  assert.match(said, /Pouvez-vous|Merci|D'accord|Je vois|Ai-je bien compris|Vous avez parlé/, 'ATLAS answered in French: ' + said.slice(0, 200));
  assert.doesNotMatch(said.slice(-160), /Could you give me one concrete example/, 'the follow-up is not the English line');
  ws.close();
});

test('Download my data and Delete my data work locally (the person\'s own Durable Object and the library, both with storage), and the per-person rate limits fire', async () => {
  const me = 'dana@mantu.com', boot = (await json('/api/bootstrap', me)).body;
  const post = (path, body) => json(path, me, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Atlas-CSRF': boot.csrf }, body: JSON.stringify(body) });
  // Something to export: consent receipted by a start, and a private draft in the library.
  const { ws } = await start(me); ws.close();
  const filed = await json('/__evidence_draft', me, { method: 'POST', body: JSON.stringify({ session_id: 'dana-1', project_ref: 'PRJ-9', details: [{ id: 'D-001', field: 'problem', item_id: 'user-1', quote: 'Claims were bouncing between three teams.', status: 'reported' }] }) });
  assert.equal(filed.status, 201, JSON.stringify(filed.body));
  const res = await fetch(base + '/api/me/export?as=' + me), out = await res.json();
  assert.equal(res.status, 200); assert.equal(out.schema, 'atlas.my-data.v1');
  assert.ok(out.library && JSON.stringify(out.library).includes('PRJ-9'), 'the library part holds the draft');
  assert.ok(out.interview?.consent?.purposes?.draft?.granted === true, 'the interview part holds the consent state the start receipted');
  // Erase: step one answers with a token and what will happen; step two erases.
  const one = await post('/api/me/erase', {});
  assert.equal(one.status, 200); assert.ok(one.body.confirmToken && one.body.willHappen.length);
  assert.equal((await post('/api/me/erase', { confirm: 'bad.token' })).status, 403, 'a wrong token erases nothing');
  const two = await post('/api/me/erase', { confirm: one.body.confirmToken });
  assert.equal(two.status, 200, JSON.stringify(two.body)); assert.equal(two.body.complete, true);
  const after = await (await fetch(base + '/api/me/export?as=' + me)).json();
  assert.ok(!JSON.stringify(after.library).includes('Claims were bouncing'), 'the draft\'s content is gone from the library export');
  assert.equal(after.interview.consent.purposes.draft?.granted ?? false, false, 'the interview object was erased too');
  // Rate limits live in the Durable Object's storage: the seventh fresh start within an hour is refused politely (RL_INTERVIEW_HOUR default 6).
  const rate = 'rate@mantu.com'; let refused = null;
  for (let i = 0; i < 7 && !refused; i++) {
    const b = (await json('/api/bootstrap', rate)).body, w = await connect(rate);
    w.send({ type: 'start', csrf: b.csrf, consent: { version: b.privacy.version, draft: true, notice: true }, project: PROJECT, voice: 'atlas', capture: true, memory: false, language: 'en', mode: 'text' });
    await w.until(() => w.events.some(e => e.type === 'ready' || e.type === 'error'), 'ready or a refusal');
    refused = w.events.find(e => e.type === 'error'); w.close();
  }
  assert.equal(refused?.code, 'rate-limited');
});
