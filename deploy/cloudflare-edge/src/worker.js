// ATLAS edge deployment entry: Cloudflare Worker + one Durable Object per signed-in person.
import { DurableObject } from 'cloudflare:workers';
import page from './atlas.html';
import { handle, scheduled, workersAI } from './app.js';
import { jevRanker } from './jev.js';
import { Session, messageTooLarge } from './session.js';
import { CheckpointStore, checkpointRoutes, checkpointEnabled } from './checkpoint.js';
import { Library } from './library.js';
import { evidenceWorkflowOn } from './adapters.js';
import { postDraftFromInterview } from './evidence.js';
import { storyRater } from './rating.js';
import { libraryRoutes } from './library-routes.js';
import { hindsight, recallQuery, memoryNote } from './memory.js';
import { memoryRoutes } from './memory-routes.js';
import { meRoutes } from './me-routes.js';
import * as privacy from './privacy.js';
import { resolveForInterview } from './gaps.js';
import { fetchWinHint } from './winloop.js';
import { teamsClient } from './teams.js';
import { limitRoute, consume, limitOf, HOUR, DAY } from './ratelimit.js';
import { verifyChain } from './audit-chain.js';
import { aiOff } from './kill-switches.js';
import { secEvent } from './security-log.js';

const EARLY_MAX = 64, EARLY_MAX_BYTES = 1024 * 1024; // messages held while the older window's session is suspending
const SUSPEND_WAIT_MS = 3000; // the longest the new window waits for the older window's session to finish suspending, then it proceeds

export default {
  fetch: (request, env, ctx) => handle(request, env, page, { waitUntil: p => ctx.waitUntil(p) }),
  // Daily: references not updated for six months get an update invitation for their owner (never auto-sent).
  scheduled,
};

export class Interview extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.env = env; this.session = null; this.connection = 0; this.checkpointOwner = null; this.hs = hindsight(env); }

  // The 24-hour purge of a stored interview (checkpoint.js): the alarm is armed at every checkpoint write, so it never needs another trigger.
  async alarm() { await new CheckpointStore(this.ctx.storage).expire(); }

  // Which consents a withdrawal, a restriction or an erasure takes away: 'all' (erasure) or a list of purposes.
  async withdrawn(request, path) {
    if (path === '/api/me/erase') return 'all';
    let body = {}; try { body = await request.clone().json(); } catch { body = {}; }
    if (path === '/api/consent') return Object.entries(body?.purposes && typeof body.purposes === 'object' ? body.purposes : {}).filter(([, v]) => v === false).map(([k]) => k);
    if (path === '/api/consent/block' && body?.memory === true) return ['memory'];
    return [];
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/memory')) return memoryRoutes(request, { storage: this.ctx.storage, hs: this.hs, env: this.env });
    // Consent state, data export and erasure for THIS person (me-routes.js): reachable only through the Worker's own /api/consent and /api/me/* handlers.
    if (path === '/api/consent' || path.startsWith('/api/consent/') || path.startsWith('/api/me/')) {
      // A live interview of this person is told first (X2, red H2): it revokes what was withdrawn or erased in memory, so it cannot write it back, and only then is the stored data changed.
      const gone = request.method === 'POST' ? await this.withdrawn(request, path) : [];
      if (gone.length && this.session && !this.session.finished) { try { await this.session.revoke(gone); } catch { /* the stored data is changed regardless */ } }
      const res = await meRoutes(request, { storage: this.ctx.storage, hs: this.hs, env: this.env });
      // Withdrawing the saved-interview (or transcript) consent also deletes what is already stored under it (an erasure does so itself).
      if (res.ok && Array.isArray(gone) && (gone.includes('checkpoint') || gone.includes('transcription'))) await new CheckpointStore(this.ctx.storage, { owner: request.headers.get('x-atlas-user') || '' }).purge().catch(() => {});
      return res;
    }
    // Resumable interview of THIS person (their own Durable Object, their own identity): whether one exists, and discarding it.
    if (path === '/api/checkpoint' || path.startsWith('/api/checkpoint/')) {
      const res = await checkpointRoutes(request, { storage: this.ctx.storage });
      if (request.method !== 'GET' || path !== '/api/checkpoint' || !res.ok) return res;
      // The bootstrap's one question to this object also carries the consent state in force (what the person last chose; privacy.js), so the page needs no second call.
      const state = await privacy.loadState(this.ctx.storage);
      return new Response(JSON.stringify({ ...(await res.json()), consent: { purposes: state.purposes, blocked: state.blocked || {} } }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    // Persistent per-person rate limits (ratelimit.js). Internal: only the Worker forwards this path; no browser route reaches it.
    if (path === '/api/limit') return limitRoute(request, this.ctx.storage);
    // Private memory for this person's interview: recall before the opening, JEV relevance check when configured.
    const bank = request.headers.get('x-atlas-bank') || '', metric = (name, values) => console.log(JSON.stringify({ atlas_metric: name, ...values }));
    // Private memory is OFF unless the person turned it on (the memory purpose, privacy.js) and has not restricted or objected to it; the Session recalls only when the
    // start message carried memory consent as well. Recalled text is never sent to another processor (the JEV relevance check was removed from this path, G2).
    const memory = this.hs && bank ? async project => {
      if (!privacy.memoryAllowed(await privacy.loadState(this.ctx.storage))) return '';
      const t0 = Date.now(), found = await this.hs.recall(bank, recallQuery(project), { tags: project?.id && project.id !== 'new' ? ['project:' + project.id] : undefined });
      metric('memory_recall', { ms: Date.now() - t0, found: found.length });
      return memoryNote(found);
    } : null;
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    server.accept();
    // Messages that arrive while the older window's session is being suspended wait here (the start of a resume comes first): none is lost.
    // Bounded (EARLY_MAX messages, EARLY_MAX_BYTES): a client cannot grow this buffer without limit; one that overflows it is closed with an error and no session starts.
    const early = []; let earlyBytes = 0, overflow = false;
    let route = e => {
      earlyBytes += typeof e.data === 'string' ? e.data.length : (e.data?.byteLength ?? 0);
      if (overflow || early.length >= EARLY_MAX || earlyBytes > EARLY_MAX_BYTES) { overflow = true; early.length = 0; try { server.close(1009, 'Too much input before the interview started.'); } catch { /* closed */ } return; }
      early.push(e);
    };
    server.addEventListener('message', e => route(e));
    const connection = ++this.connection;
    if (this.session && !this.session.finished) {
      // Still one live interview per signed-in person, but the newest window wins: a forgotten tab or a
      // stale session must never block the person from starting again.
      // Bounded: saving the older interview (up to ~8 s of waiting on transcription and the analyst) must not hold the new window's socket for ever.
      let timer;
      try { await Promise.race([this.session.fail('This interview continued in another window. Nothing was approved.', 'voice-contract'), new Promise(r => { timer = setTimeout(r, SUSPEND_WAIT_MS); })]); }
      finally { clearTimeout(timer); }
    }
    if (connection !== this.connection) { server.close(1000, 'This interview continued in another window.'); return new Response(null, { status: 101, webSocket: client }); }
    if (overflow) return new Response(null, { status: 101, webSocket: client }); // closed above; nothing was processed
    // The verified identity the Worker forwarded (always overwritten there), for gap requests and the win hint.
    const identity = { user: request.headers.get('x-atlas-user') || '', role: request.headers.get('x-atlas-role') || 'user', mail: request.headers.get('x-atlas-email') || '' };
    const subj = request.headers.get('x-atlas-subj') || '';
    // Fence the old writer before the replacement starts, even when suspension timed out.
    const checkpointOwner = Symbol(); this.checkpointOwner = checkpointOwner;
    const session = new Session({
      io: { send: e => { try { server.send(JSON.stringify(e)); } catch { /* closed */ } }, sendBytes: b => { try { server.send(b); } catch { /* closed */ } },
        close: () => { try { server.close(1000, 'ended'); } catch { /* closed */ } } },
      ai: Object.assign(workersAI(this.env), !aiOff(this.env) && jevRanker(this.env) ? { rankProbe: jevRanker(this.env) } : {}), csrf: request.headers.get('x-atlas-csrf') || '', voice: 'atlas', captureRequired: true, model: this.env.TALKER_MODEL, admin: request.headers.get('x-atlas-admin') === '1', memory,
      metric: (name, values) => console.log(JSON.stringify({ atlas_metric: name, ...values })),
      gaps: this.env.LIBRARY ? id => resolveForInterview(this.env, identity, id) : null,
      winHint: this.env.LIBRARY ? () => fetchWinHint(this.env, identity) : null,
      // Interviews with transcript consent are kept for 24 hours so a dropped connection can resume (ATLAS_CHECKPOINT=off: never).
      checkpoint: checkpointEnabled(this.env) && identity.user ? new CheckpointStore(this.ctx.storage, { owner: identity.user, isCurrent: () => this.checkpointOwner === checkpointOwner }) : null,
      // The saved-interview consent as it stands in storage right now, read before each checkpoint write (session.js saveCheckpoint).
      consentGuard: checkpointEnabled(this.env) && identity.user ? async () => privacy.grantedIn(await privacy.loadState(this.ctx.storage), 'checkpoint') : null,
      // Each start's consent choices: the state in this person's storage and one receipt per change in the library (privacy.js recordConsent), all or nothing. Nothing is kept
      // before it succeeds; a failure starts nothing.
      consentHook: ({ mode, purposes, legacy }) => privacy.recordConsent(this.ctx.storage, this.env, { ...identity, subj }, legacy ? { transcription: purposes.transcription, draft: purposes.draft } : purposes, { mode, channel: legacy ? 'legacy-start' : 'consent-dialog' }), // an old page's bare tick states only what it always meant
      // Confirming the read-back saves an OWNER-ONLY evidence draft under the verified identity, server to server (never submitted from here). Off with
      // ATLAS_EVIDENCE_WORKFLOW=off or without the library: the summary is then confirmed but not filed, and the browser is told so.
      evidence: evidenceWorkflowOn(this.env) && this.env.LIBRARY && identity.user ? notes => postDraftFromInterview(this.env, identity, notes) : null,
    });
    this.session = session;
    const dispatch = e => {
      if (this.session !== session) return;
      try {
        if (typeof e.data === 'string') session.onText(e.data);
        else session.onBinary(new Uint8Array(e.data));
      } catch { session.fail('The session stopped safely. No story was approved.', 'voice-failed'); }
    };
    // Fresh interview starts per person are capped per hour and per day, persistently (ratelimit.js): restarting is otherwise free STT + LLM + TTS.
    // Only a valid resume of a saved interview (start with a string `resume`) is free; every other first message counts as a start, decided from the PARSED value and never
    // from the size of the text (X2, red M1: padding the start past 64 KiB used to make it "not a start"). A first message over the size cap is counted and refused without
    // being parsed or dispatched. Messages that arrive while the budget is being read wait in order (bounded); a refused start is answered politely and the socket closes.
    let first = true, budget = null; const waiting = [];
    const refuse = (message, code, extra = {}) => {
      waiting.length = 0;
      try { server.send(JSON.stringify({ type: 'error', message, code, ...extra })); } catch { /* closed */ }
      try { server.close(code === 'rate-limited' ? 1013 : 1009, code === 'rate-limited' ? 'Try again later.' : 'Message too large.'); } catch { /* closed */ }
      if (this.session === session) this.session = null;
    };
    const onMessage = e => {
      if (budget) { if (waiting.length >= EARLY_MAX) { refuse('Too much input before the interview started.', 'message-too-large'); return; } waiting.push(e); return; }
      if (first) {
        first = false;
        const big = messageTooLarge(e.data);
        let resume = false;
        if (!big && typeof e.data === 'string') { try { const v = JSON.parse(e.data); resume = v?.type === 'start' && typeof v.resume === 'string'; } catch { /* the session reports it */ } }
        if (!resume && identity.role !== 'system') {
          budget = consume(this.ctx.storage, [{ bucket: 'interview-h', max: limitOf(this.env, 'INTERVIEW_HOUR'), windowMs: HOUR }, { bucket: 'interview-d', max: limitOf(this.env, 'INTERVIEW_DAY'), windowMs: DAY }])
            .catch(() => ({ ok: true })) // a limiter that cannot read its counters must not stop an interview
            .then(r => {
              budget = null;
              if (!r.ok) {
                const minutes = Math.max(1, Math.ceil(r.retryAfter / 60));
                refuse(`You have started a lot of interviews in a short time. Please try again in about ${minutes} minute${minutes === 1 ? '' : 's'}. Nothing was lost.`, 'rate-limited', { retryAfter: r.retryAfter });
                secEvent(this.env, 'rate_limited', { route: '/api/voice', reason: 'RATE:' + r.bucket.toUpperCase().replace(/-/g, '_'), status: 429, bucket: r.bucket, subj: request.headers.get('x-atlas-subj'), role: identity.role });
                return;
              }
              if (big) { refuse('That message was too large. Nothing was started.', 'message-too-large'); secEvent(this.env, 'body_too_large', { route: '/api/voice', reason: 'WS_MESSAGE_SIZE', status: 1009, subj: request.headers.get('x-atlas-subj'), role: identity.role }); return; }
              dispatch(e); for (const w of waiting.splice(0)) dispatch(w);
            });
          return;
        }
        if (big) { refuse('That message was too large. Nothing was started.', 'message-too-large'); return; }
      }
      dispatch(e);
    };
    route = onMessage; for (const e of early) onMessage(e);
    // A socket that closes mid-interview suspends it (resumable for 24 hours); one that cannot be resumed ends as before.
    server.addEventListener('close', () => { if (!session.finished) session.suspend(); });
    server.addEventListener('error', () => { if (!session.finished) session.suspend(); });
    return new Response(null, { status: 101, webSocket: client });
  }
}

// The central reference library: one SQLite-backed instance for the pilot (see handoff/SCALE_PLAN.md to shard).
export class LibraryStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    const ai = workersAI(env);
    // ATLAS_AI_OFF: no completion, embedding or JEV rating at all (the review agent and ranking then fall back to their deterministic paths).
    const off = aiOff(env);
    this.lib = new Library(ctx.storage.sql, { complete: off ? null : messages => ai.complete(messages), embed: off ? null : text => ai.embed(text),
      readyScore: Number(env.READY_SCORE) || undefined, model: env.ANALYST_MODEL, services: { teams: teamsClient(env) }, rater: off ? null : storyRater(env) }); // JEV only with TYPESAFE_API_KEY
  }
  async fetch(request) {
    // The daily cron (app.js `scheduled`) posts scan-stale as the system role, which only the Worker's own cron can set. The same call verifies the
    // audit chain (audit-chain.js): a break is logged as a security event, and the chain head as the external anchor. Never part of the response.
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/library/scan-stale' && request.headers.get('x-atlas-role') === 'system') {
      try {
        const r = verifyChain(this.ctx.storage.sql), head = String(r.head || '').slice(0, 16);
        await (r.ok ? secEvent(this.env, 'audit_chain_ok', { reason: 'CHAIN_VERIFIED', n: r.checked, head }) : secEvent(this.env, 'audit_chain_break', { reason: r.reason, n: r.brokenSeq, head }));
      } catch { await secEvent(this.env, 'audit_chain_break', { reason: 'VERIFY_FAILED' }); }
    }
    // `storage`: the Durable Object's key-value storage, for ratelimit.enforce() in the library routes (Wave B).
    return libraryRoutes(request, this.lib, { waitUntil: p => this.ctx.waitUntil(p), env: this.env, storage: this.ctx.storage });
  }
}
