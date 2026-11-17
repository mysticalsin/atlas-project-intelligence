// ATLAS edge deployment entry: Cloudflare Worker + one Durable Object per signed-in person.
import { DurableObject } from 'cloudflare:workers';
import page from './atlas.html';
import { handle, scheduled, workersAI } from './app.js';
import { jevRanker } from './jev.js';
import { Session } from './session.js';
import { storyRater } from './rating.js';
import { libraryRoutes } from './library-routes.js';
import { hindsight, recallQuery, memoryNote, jevRelevant } from './memory.js';
import { memoryRoutes } from './memory-routes.js';
import { resolveForInterview } from './gaps.js';
import { fetchWinHint } from './winloop.js';
import { teamsClient } from './teams.js';
import { libraryFromStorage } from './library-store.js';
import { limitRoute } from './ratelimit.js';
import { loadState, memoryAllowed, recordConsent } from './privacy.js';
import { auditKey } from './audit-chain.js';

export default {
  fetch: (request, env, ctx) => handle(request, env, page, { waitUntil: p => ctx.waitUntil(p), log: line => console.log(line) }),
  // Daily: references not updated for six months get an update invitation for their owner (never auto-sent).
  scheduled,
};

export class Interview extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.env = env; this.session = null; this.hs = hindsight(env); }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/limit') return limitRoute(request, this.ctx.storage);
    if (url.pathname === '/api/consent' && request.method === 'POST') {
      let wanted; try { wanted = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON.' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
      const who = { user: request.headers.get('x-atlas-user') || '', role: request.headers.get('x-atlas-role') || 'user', mail: request.headers.get('x-atlas-email') || '', subj: request.headers.get('x-atlas-subj') || '' };
      try {
        const state = await recordConsent(this.ctx.storage, this.env, who, wanted);
        return new Response(JSON.stringify(state), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) { return new Response(JSON.stringify({ error: e.message || 'Consent was not recorded.' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
    }
    if (url.pathname.startsWith('/api/memory')) return memoryRoutes(request, { storage: this.ctx.storage, hs: this.hs, env: this.env });
    // Private memory for this person's interview: recall before the opening, JEV relevance check when configured.
    // Recall stays off until this object has a granted memory purpose (privacy.js). The memoryOff flag still wins.
    const bank = request.headers.get('x-atlas-bank') || '', metric = (name, values) => console.log(JSON.stringify({ atlas_metric: name, ...values }));
    const consent = await loadState(this.ctx.storage);
    const memory = this.hs && bank && memoryAllowed(consent) && (await this.ctx.storage.get('memoryOff')) !== true ? async project => {
      const t0 = Date.now(); let found = await this.hs.recall(bank, recallQuery(project), { tags: project?.id && project.id !== 'new' ? ['project:' + project.id] : undefined });
      const n = found.length; let checked = 0;
      try { const j = await jevRelevant(this.env, found, project); found = j.memories; checked = j.checked; } catch { metric('memory_jev_error', {}); }
      metric('memory_recall', { ms: Date.now() - t0, found: n, kept: found.length, jev_checked: checked });
      return memoryNote(found);
    } : null;
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    server.accept();
    if (this.session && !this.session.finished) {
      // Still one live interview per signed-in person, but the newest window wins: a forgotten tab or a
      // stale session must never block the person from starting again.
      await this.session.fail('This interview continued in another window. Nothing was approved.', 'voice-contract');
    }
    // The verified identity the Worker forwarded (always overwritten there), for gap requests and the win hint.
    const identity = { user: request.headers.get('x-atlas-user') || '', role: request.headers.get('x-atlas-role') || 'user', mail: request.headers.get('x-atlas-email') || '', tenant: request.headers.get('x-atlas-tenant') || '', tenantEnforced: request.headers.get('x-atlas-tenant-enforced') === '1' };
    const session = new Session({
      io: { send: e => { try { server.send(JSON.stringify(e)); } catch { /* closed */ } }, sendBytes: b => { try { server.send(b); } catch { /* closed */ } },
        close: () => { try { server.close(1000, 'ended'); } catch { /* closed */ } } },
      ai: Object.assign(workersAI(this.env), jevRanker(this.env) ? { rankProbe: jevRanker(this.env) } : {}), csrf: request.headers.get('x-atlas-csrf') || '', voice: 'atlas', captureRequired: true, model: this.env.TALKER_MODEL, admin: request.headers.get('x-atlas-admin') === '1', memory,
      metric: (name, values) => console.log(JSON.stringify({ atlas_metric: name, ...values })),
      gaps: this.env.LIBRARY ? id => resolveForInterview(this.env, identity, id) : null,
      winHint: this.env.LIBRARY ? () => fetchWinHint(this.env, identity) : null,
    });
    this.session = session;
    server.addEventListener('message', e => {
      try {
        if (typeof e.data === 'string') session.onText(e.data);
        else session.onBinary(new Uint8Array(e.data));
      } catch { session.fail('The session stopped safely. No story was approved.', 'voice-failed'); }
    });
    server.addEventListener('close', () => { if (!session.finished) session.end(false); });
    server.addEventListener('error', () => { if (!session.finished) session.end(false); });
    return new Response(null, { status: 101, webSocket: client });
  }
}

// The central reference library: one SQLite-backed instance for the pilot (see handoff/SCALE_PLAN.md to shard).
export class LibraryStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    const ai = workersAI(env);
    this.lib = libraryFromStorage(ctx.storage, { complete: messages => ai.complete(messages), embed: text => ai.embed(text),
      readyScore: Number(env.READY_SCORE) || undefined, model: env.ANALYST_MODEL, services: { teams: teamsClient(env) }, rater: storyRater(env), auditKey: auditKey(env), dbId: String(ctx.id) }); // JEV only with TYPESAFE_API_KEY
  }
  fetch(request) { return libraryRoutes(request, this.lib, { waitUntil: p => this.ctx.waitUntil(p), env: this.env, storage: this.ctx.storage }); }
}
