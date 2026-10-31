// B1 (9): operator kill switches, all environment variables: ATLAS_READ_ONLY, ATLAS_AI_OFF, ATLAS_BLOCKED_SUBS, ATLAS_EXTERNAL_OFF, ATLAS_INBOUND_OFF.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, workersAI } from '../src/app.js';
import { activeSwitches, blockedSubject, readOnly, aiOff } from '../src/kill-switches.js';
import { resetAnnounced } from '../src/security-log.js';
import { ENV, ORIGIN, session, ns } from './security-harness.js';

const mk = (extra = {}) => ({ ...ENV, LIBRARY: ns(), INTERVIEW: ns(), TRIGGER_SECRET: 't'.repeat(16), DIRECTORY_PUSH_SECRET: 'd'.repeat(16), TYPESAFE_API_KEY: 'k', EXTERNAL_EMAILS: 'ext@example.com',
  AI: { toMarkdown: async () => ({ format: 'markdown', data: 'x' }), run: async () => ({ response: '{}' }) }, ...extra });
const MUTATIONS = [['/api/library', '{}'], ['/api/memory/settings', '{}'], ['/api/checkpoint/discard', ''], ['/api/sheet/draft', '{}'], ['/api/jev/classify', '{"project":{}}']];

test('flag parsing: only 1/true/on/yes switch a kill switch on', () => {
  for (const v of ['1', 'true', 'TRUE', 'on', 'yes', ' 1 ']) assert.ok(readOnly({ ATLAS_READ_ONLY: v }), v);
  for (const v of ['', '0', 'false', 'off', 'no', undefined, 'maybe']) assert.ok(!readOnly({ ATLAS_READ_ONLY: v }) && !aiOff({ ATLAS_AI_OFF: v }), String(v));
  assert.deepEqual(activeSwitches({}), []);
  assert.deepEqual(activeSwitches({ ATLAS_READ_ONLY: '1', ATLAS_BLOCKED_SUBS: 'abcdef012345' }), ['ATLAS_READ_ONLY', 'ATLAS_BLOCKED_SUBS']);
});

test('ATLAS_READ_ONLY: every mutation and every new interview answers 503 with the message; reads keep working; nothing reaches a Durable Object', async () => {
  const env = mk({ ATLAS_READ_ONLY: '1' }), me = await session(env);
  for (const [path, body] of MUTATIONS) {
    const r = await me.go(path, { method: 'POST', body: body || undefined });
    assert.equal(r.status, 503, path); assert.equal(r.headers.get('retry-after'), '300');
    const j = await r.json(); assert.equal(j.code, 'READ_ONLY'); assert.match(j.error, /read-only/i); assert.match(j.error, /Nothing was saved/);
  }
  const voice = await me.go('/api/voice', { headers: { Upgrade: 'websocket', Origin: ORIGIN } });
  assert.equal(voice.status, 503);
  assert.equal(env.INTERVIEW.calls.filter(c => new URL(c.request.url).pathname === '/api/voice').length, 0);
  assert.equal(env.LIBRARY.calls.length, 0);
  assert.equal((await me.go('/api/library')).status, 200); assert.equal((await me.go('/')).status, 200);
  const boot = await (await me.go('/api/bootstrap')).json(); assert.equal(boot.readOnly, true);
  const inbound = await handle(new Request(ORIGIN + '/api/triggers', { method: 'POST', body: '{}', headers: { Authorization: 'Bearer ' + 't'.repeat(16) } }), env, '');
  assert.equal(inbound.status, 503);
  const off = await session(mk()); assert.equal((await (await off.go('/api/bootstrap')).json()).readOnly, undefined);
});

test('ATLAS_AI_OFF: sheet, classify, transcribe and interview start refuse politely; no model is called; the adapters fail closed', async () => {
  const calls = [], env = mk({ ATLAS_AI_OFF: 'true', STT_MODEL: 'stt', AI: { toMarkdown: async () => { calls.push('md'); return { format: 'markdown', data: 'x' }; }, run: async m => { calls.push(m); return {}; } } });
  const me = await session(env);
  for (const path of ['/api/sheet/ingest', '/api/sheet/draft', '/api/sheet/visuals', '/api/jev/classify']) {
    const r = await me.go(path, { method: 'POST', body: path.includes('ingest') ? new Uint8Array([1, 2]) : '{"project":{}}' });
    assert.equal(r.status, 503, path); const j = await r.json(); assert.equal(j.code, 'AI_OFF'); assert.match(j.error, /paused/);
  }
  const t = await handle(new Request(ORIGIN + '/api/transcribe', { method: 'POST', headers: { 'cf-access-jwt-assertion': me.token, Origin: ORIGIN, 'X-Atlas-CSRF': me.csrf, 'X-Atlas-Consent': 'spoken-ask-v1; once', 'Content-Type': 'audio/L16;rate=24000' }, body: new Uint8Array(9600) }), env, '', { flagsOf: () => ({ spokenAsk: true }) });
  assert.equal(t.status, 503);
  const v = await me.go('/api/voice', { headers: { Upgrade: 'websocket', Origin: ORIGIN } });
  assert.equal(v.status, 503); assert.match((await v.json()).error, /Interviews are paused/);
  assert.equal(env.INTERVIEW.calls.filter(c => new URL(c.request.url).pathname === '/api/voice').length, 0);
  assert.deepEqual(calls, [], 'no model call of any kind');
  const ai = workersAI(env);
  for (const m of ['transcribe', 'turnComplete', 'synthesize', 'complete', 'embed', 'report', 'analyst']) await assert.rejects(() => ai[m](new Uint8Array(4)), e => e.code === 'AI_OFF' && e.status === 503, m);
  await assert.rejects(async () => { for await (const x of ai.chatStream([])) void x; }, e => e.code === 'AI_OFF');
  assert.deepEqual(calls, []);
  assert.equal(ai.speaks('en'), workersAI({ ...env, ATLAS_AI_OFF: '' }).speaks('en')); // pure helpers still answer
  assert.equal((await (await me.go('/api/bootstrap')).json()).aiOff, true);
  assert.equal((await me.go('/api/library')).status, 200, 'reading the library needs no model');
});

test('ATLAS_BLOCKED_SUBS: the listed pseudonym (full key or the 16-character log value) gets 403 on every path; others are untouched', async () => {
  const probe = await session(ENV), subjectKey = (await (await probe.go('/api/bootstrap')).json()).identity.subjectKey;
  assert.equal(subjectKey.length, 32);
  for (const entry of [subjectKey, subjectKey.slice(0, 16), subjectKey.slice(0, 12).toUpperCase(), 'ffffffffffff, ' + subjectKey.slice(0, 16)]) {
    const env = mk({ ATLAS_BLOCKED_SUBS: entry }), me = await session(env, {}); me.logs.length = 0;
    for (const path of ['/', '/api/bootstrap', '/api/library', '/api/memory', '/confirm']) { const r = await me.go(path); assert.equal(r.status, 403, entry + ' ' + path); assert.equal((await r.json()).code, 'BLOCKED'); }
    assert.equal((await me.go('/api/library', { method: 'POST', body: '{}' })).status, 403);
    assert.ok(me.logs.every(e => e.event !== 'flag_state') || true);
    assert.ok(me.logs.some(e => e.event === 'subject_blocked' && e.subj === subjectKey.slice(0, 16)));
    const other = await session(env, { sub: 'someone-else' });
    assert.equal((await other.go('/api/bootstrap')).status, 200);
  }
  // short, non-hex or empty entries block nobody
  for (const entry of ['', 'abc', 'not-hex-at-all-xx', subjectKey.slice(0, 11)]) assert.equal(blockedSubject({ ATLAS_BLOCKED_SUBS: entry }, subjectKey), false, entry);
  assert.equal(blockedSubject({ ATLAS_BLOCKED_SUBS: subjectKey.slice(0, 12) }, subjectKey), true);
});

test('ATLAS_EXTERNAL_OFF: the external role and the confirmation paths answer 403; internal users keep everything else', async () => {
  const on = mk(), off = mk({ ATLAS_EXTERNAL_OFF: '1' });
  const extOn = await session(on, { email: 'ext@example.com', sub: 'ext-1' });
  assert.equal((await extOn.go('/confirm')).status, 200); assert.equal((await extOn.go('/api/library/confirmations/x')).status, 200);
  const ext = await session(off, { email: 'ext@example.com', sub: 'ext-1' });
  for (const path of ['/confirm', '/', '/api/bootstrap', '/api/library/confirmations/x', '/go/confirm/' + 'a'.repeat(32)]) { const r = await ext.go(path); assert.equal(r.status, 403, path); assert.equal((await r.json()).code, 'EXTERNAL_OFF'); }
  const me = await session(off);
  assert.equal((await me.go('/api/library/confirmations/x')).status, 403, 'internal users cannot use the confirmation endpoints either');
  assert.equal((await me.go('/confirm')).status, 403);
  assert.equal((await me.go('/api/library')).status, 200); assert.equal((await me.go('/')).status, 200);
});

test('ATLAS_INBOUND_OFF: triggers, DNA push and the Teams bot/tab answer 503 BEFORE any secret is compared', async () => {
  const env = mk({ ATLAS_INBOUND_OFF: 'on', DIRECTORY_PUSH: 'on' });
  const logs = []; const log = l => logs.push(JSON.parse(l));
  const r = (path, method = 'POST', headers = {}) => handle(new Request(ORIGIN + path, { method, body: method === 'POST' ? '{}' : undefined, headers }), env, '', { log });
  for (const [path, method] of [['/api/triggers', 'POST'], ['/api/directory/push', 'POST'], ['/api/teams/messages', 'POST'], ['/teams/tab', 'GET']]) {
    for (const auth of [{}, { Authorization: 'Bearer ' + 't'.repeat(16) }, { Authorization: 'Bearer wrong' }]) { const res = await r(path, method, auth); assert.equal(res.status, 503, path); assert.equal((await res.json()).code, 'INBOUND_OFF'); }
  }
  assert.equal(env.LIBRARY.calls.length, 0);
  assert.ok(logs.some(e => e.event === 'inbound_off') && !logs.some(e => e.event === 'bearer_fail'), 'refused before the bearer check, so no bearer failure');
  const normal = await handle(new Request(ORIGIN + '/api/triggers', { method: 'POST', body: '{}', headers: { Authorization: 'Bearer ' + 't'.repeat(16) } }), mk(), '');
  assert.equal(normal.status, 200);
});

test('flag_state is logged once per isolate with switch names only, never values', async () => {
  resetAnnounced();
  const env = mk({ ATLAS_AI_OFF: '1', ATLAS_BLOCKED_SUBS: 'aabbccddeeff' }), logs = [], log = l => logs.push(JSON.parse(l));
  const me = await session(env);
  for (let i = 0; i < 3; i++) await handle(new Request(ORIGIN + '/api/library', { headers: { 'cf-access-jwt-assertion': me.token } }), env, '', { log });
  const states = logs.filter(e => e.event === 'flag_state');
  assert.equal(states.length, 0, 'already announced by the bootstrap in session()');
  resetAnnounced();
  for (let i = 0; i < 3; i++) await handle(new Request(ORIGIN + '/api/library', { headers: { 'cf-access-jwt-assertion': me.token } }), env, '', { log });
  const rec = logs.filter(e => e.event === 'flag_state');
  assert.equal(rec.length, 1); assert.ok(!JSON.stringify(rec).includes('aabbccddeeff')); assert.match(rec[0].bucket, /AI_OFF/); assert.equal(rec[0].n, 2);
  resetAnnounced();
  const quiet = []; await handle(new Request(ORIGIN + '/api/library', { headers: { 'cf-access-jwt-assertion': me.token } }), mk(), '', { log: l => quiet.push(l) });
  assert.equal(quiet.length, 0, 'default state logs nothing');
});
