// Atlas core flow against the REAL Worker on workerd (make test-e2e-worker): `wrangler dev` with dev/wrangler.e2e.jsonc, local only (no deploy, no
// remote binding, no account; every outbound fetch refused by dev/e2e-worker.mjs). What runs for real: Access token verification, CSRF and Origin
// checks, the voice WebSocket into the Interview Durable Object (the real Session, typed turns), the confirmed read-back filed into the LibraryStore
// Durable Object, the browser's evidence routes (permissions, submit, review), the policy gate, the branch fan-out and the job queue. Stand-ins:
// the models (dev/fake-interviewer.mjs, dev/fake-model.mjs) and the destinations (adapters.js mocks, ATLAS_ADAPTERS=mock).
// Flow: Project ID -> interview -> consultant's inputs -> draft -> owner permissions -> submit -> reviewer approval -> skills (DNA),
// resume (MiChat CV), projects (Project Review hand-off, IMP) and success stories (Spotlight).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const EDGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = (process.env.WRANGLER || 'npx --yes wrangler@4.156.0').split(' ');
const TEAM = 'access.e2e.invalid', AUD = 'e2e-aud';
const CONSULTANT = 'alex@mantu.com', REVIEWER = 'rev@mantu.com', PROJECT_ID = 'PRJ-2026-0042';
const PROJECT = { id: 'p-local-7', projectId: PROJECT_ID, title: 'Claims triage (synthetic)', consultant: 'Alex', role: 'Data engineer', sector: 'Insurance', stage: 'Production', answers: [] };
const ANSWERS = [
  'I designed and built the routing model for the claims triage queue, and we shipped the triage queue to every adjuster.',
  'Median triage time fell from forty minutes to twelve minutes over six weeks, according to the operations dashboard.',
  'That is everything, I am done.',
];
const PURPOSES = ['skills_profile', 'cv', 'matching', 'public_spotlight'];

const freePort = () => new Promise((ok, ko) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); s.on('error', ko); });
const b64u = b => Buffer.from(b).toString('base64url');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let child, port, origin, keys, tmp, log = '';
async function token(email) {
  const now = Math.floor(Date.now() / 1000), body = { aud: [AUD], iss: `https://${TEAM}`, sub: 'e2e:' + email, email, exp: now + 3600, iat: now - 5 };
  const input = b64u(JSON.stringify({ alg: 'RS256', kid: 'e2e' })) + '.' + b64u(JSON.stringify(body));
  return input + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(input)));
}
const tokens = new Map(); // one application token per person, as Access issues it (the CSRF token is bound to its iat)
const tok = async who => tokens.get(who) ?? tokens.set(who, await token(who)).get(who);
async function call(who, method, path, body, { csrf } = {}) {
  const headers = { 'cf-access-jwt-assertion': await tok(who), Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-Atlas-CSRF': csrf } : {}) };
  const res = await fetch(origin + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 400, `${a[1]} ${a[2]} -> ${r.status} ${r.text.slice(0, 300)}`); return r.json; };

test.before(async () => {
  keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'e2e', alg: 'RS256', use: 'sig' };
  port = await freePort(); origin = `http://127.0.0.1:${port}`; tmp = mkdtempSync(join(tmpdir(), 'atlas-e2e-worker-'));
  const csrfSecret = b64u(crypto.getRandomValues(new Uint8Array(24)));
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', XDG_CONFIG_HOME: join(tmp, 'xdg'), CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' };
  child = spawn(WRANGLER[0], [...WRANGLER.slice(1), 'dev', '-c', join(EDGE, 'dev/wrangler.e2e.jsonc'), '--ip', '127.0.0.1', '--port', String(port), '--persist-to', join(tmp, 'state'),
    '--show-interactive-dev-session=false', '--var', `ORIGIN:${origin}`, '--var', `CSRF_SECRET:${csrfSecret}`, '--var', `E2E_JWKS:${JSON.stringify({ keys: [jwk] })}`],
    { cwd: join(EDGE, 'dev'), env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 240 && !/Ready on http/.test(log); i++) { if (child.exitCode !== null) break; await sleep(250); }
  assert.match(log, /Ready on http/, 'wrangler dev started locally:\n' + log.slice(-2000));
  assert.doesNotMatch(log, /remote|Logged in/i, 'no remote binding and no account in a local run');
});
test.after(() => {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
  if (process.env.E2E_WORKER_LOG) console.log(log);
});

// The voice socket as the browser opens it: Origin and the Access token header, then the start frame with fresh consent and the CSRF token.
async function interview(csrf) {
  const ws = new WebSocket(origin.replace('http', 'ws') + '/api/voice', { headers: { Origin: origin, 'cf-access-jwt-assertion': await tok(CONSULTANT) } });
  const events = [], waiters = [];
  ws.binaryType = 'arraybuffer';
  ws.onmessage = e => {
    if (typeof e.data !== 'string') return;
    const m = JSON.parse(e.data); events.push(m);
    if (m.type === 'audio_turn') ws.send(JSON.stringify({ type: 'playback', item_id: m.item_id, played_ms: 600000 })); // the "browser" has played it
    for (const w of waiters.splice(0)) w();
  };
  const until = async (pred, what, ms = 20000) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}; events: ${JSON.stringify(events.map(e => e.type === "agent_text" || e.type === "error" || e.type === "quality_warning" ? e : e.type)).slice(0, 3000)}`); await Promise.race([new Promise(r => waiters.push(r)), sleep(200)]); } };
  let last = Date.now(); const seen = ws.onmessage; ws.onmessage = e => { last = Date.now(); seen(e); };
  const quiet = async (ms = 700) => { while (Date.now() - last < ms) await sleep(100); }; // ATLAS has finished its turn
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('voice socket refused')); });
  ws.send(JSON.stringify({ type: 'start', consent: { transcription: true, draft: true, checkpoint: false }, csrf, project: PROJECT, capture: true, voice: 'atlas', memory: false, mode: 'text' })); // "Type instead": a typed interview
  await until(() => events.some(e => e.type === 'agent_text') || events.some(e => e.type === 'error'), 'the opening');
  assert.ok(!events.some(e => e.type === 'error'), 'the start was accepted: ' + JSON.stringify(events.find(e => e.type === 'error')));
  for (const answer of ANSWERS) {
    if (events.some(e => e.type === 'summary')) break;
    // As a person would: wait for ATLAS to finish, and if it asks for a moment (the typed pacing rule), send the answer again.
    for (let attempt = 0; ; attempt++) {
      await quiet();
      const asked = events.filter(e => e.type === 'agent_text').length, refusals = () => events.filter(e => e.type === 'quality_warning' && e.refused === 'text').length, before = refusals();
      ws.send(JSON.stringify({ type: 'text', text: answer }));
      await until(() => events.filter(e => e.type === 'agent_text').length > asked || events.some(e => e.type === 'summary') || refusals() > before, 'the next question');
      if (refusals() === before) break;
      assert.ok(attempt < 5, 'the typed answer was never taken: ' + JSON.stringify(events.at(-1)));
      await sleep(1000);
    }
  }
  await until(() => events.some(e => e.type === 'summary'), 'the read-back');
  await quiet();
  ws.send(JSON.stringify({ type: 'confirm_summary' }));
  await until(() => events.some(e => e.type === 'evidence_draft' || e.type === 'evidence_draft_unavailable'), 'the filed draft');
  ws.close();
  return events;
}

test('E2E-W1 on the real Worker: Project ID -> interview -> draft -> permissions -> submit -> approval -> skills, resume, projects and success stories', { timeout: 120000 }, async () => {
  assert.equal((await call(CONSULTANT, 'GET', '/api/bootstrap')).status, 200);
  const unsigned = await fetch(origin + '/api/bootstrap'); assert.equal(unsigned.status, 401, 'no Access token, no answer'); await unsigned.text();
  const me = await ok(CONSULTANT, 'GET', '/api/bootstrap'); assert.ok(me.csrf);

  const events = await interview(me.csrf);
  const filed = events.find(e => e.type === 'evidence_draft');
  assert.ok(filed, 'the confirmed read-back was filed as a draft: ' + JSON.stringify(events.find(e => e.type === 'evidence_draft_unavailable')));

  const mine = await ok(CONSULTANT, 'GET', '/api/library/evidence');
  assert.equal(mine.items.length, 1); const id = mine.items[0].id;
  let rec = await ok(CONSULTANT, 'GET', `/api/library/evidence/${id}`);
  assert.equal(rec.state, 'evidence_draft'); assert.equal(rec.project_ref, PROJECT_ID, 'the Project ID is the record\'s project reference');
  assert.ok(Array.isArray(rec.claims) && rec.claims.length >= 1, 'the consultant\'s inputs became claims');
  assert.equal((await call(REVIEWER, 'GET', `/api/library/evidence/${id}`)).status, 404, 'a draft is owner-only');

  assert.equal((await call(CONSULTANT, 'POST', `/api/library/evidence/${id}/submit`, { expected_revision: rec.revision })).status, 403, 'no CSRF token, no write');
  for (const purpose of PURPOSES) await ok(CONSULTANT, 'POST', `/api/library/evidence/${id}/permissions`, { expected_revision: rec.revision, purpose }, { csrf: me.csrf });
  rec = await ok(CONSULTANT, 'POST', `/api/library/evidence/${id}/submit`, { expected_revision: rec.revision }, { csrf: me.csrf });
  assert.equal(rec.state, 'reviewer_queue');

  const own = await call(CONSULTANT, 'POST', `/api/library/evidence/${id}/review`, { action: 'approve', expected_revision: rec.revision, content_hash: rec.content_hash }, { csrf: me.csrf });
  assert.equal(own.status, 403, 'the owner cannot approve their own evidence');
  const rev = await ok(REVIEWER, 'GET', '/api/bootstrap');
  const approved = await ok(REVIEWER, 'POST', `/api/library/evidence/${id}/review`, { action: 'approve', expected_revision: rec.revision, content_hash: rec.content_hash }, { csrf: rev.csrf });
  assert.equal(approved.state, 'downstream_proposals', 'approved, and the knowledge is proposed downstream');

  const status = await ok(REVIEWER, 'GET', `/api/library/evidence/${id}/status`);
  const card = b => status.cards.find(c => c.branch === b)?.status;
  assert.equal(status.adapters, 'mock');
  for (const b of ['dna', 'michat', 'imp']) assert.equal(card(b), 'mock_acknowledged', `${b} holds the approved knowledge (mock destination)`);
  assert.equal(card('project_review'), 'project_review_pending');
  assert.ok(['spotlight_draft', 'publication_held', 'spotlight_approval_pending'].includes(card('spotlight')), 'the success story is nominated, not published: ' + card('spotlight'));
  assert.notEqual(status.overall.status, 'complete', 'mock deliveries never read as complete');
});
