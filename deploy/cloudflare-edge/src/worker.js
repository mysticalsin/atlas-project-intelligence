// ATLAS edge deployment entry: Cloudflare Worker + one Durable Object per signed-in person.
import { DurableObject } from 'cloudflare:workers';
import page from './atlas.html';
import { handle, scheduled, workersAI } from './app.js';
import { jevRanker } from './jev.js';
import { Session } from './session.js';
import { storyRater } from './rating.js';
import { libraryRoutes } from './library-routes.js';
import { hindsight, recallQuery, memoryNote, jevRelevant } from './memory.js';
import { budgetOutcome } from './budget-stop.js';
import { memoryRoutes } from './memory-routes.js';
import { resolveForInterview } from './gaps.js';
import { fetchWinHint } from './winloop.js';
import { teamsClient } from './teams.js';
import { libraryFromStorage } from './library-store.js';
import { ProductionSpendLedger as LedgerCore } from './meter.js';

// The pure ledger stays free of cloudflare:workers so the Node tests can construct it.
// This subclass is what wrangler binds, and it is what RPC requires.
export class ProductionSpendLedger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new LedgerCore(ctx, env);
  }
  reserve(req) { return this.core.reserve(req); }
  record(req) { return this.core.record(req); }
  settle(id, observed) { return this.core.settle(id, observed); }
  snapshot() { return this.core.snapshot(); }
}

export default {
  fetch: (request, env, ctx) => handle(request, env, page, { waitUntil: p => ctx.waitUntil(p) }),
  // Daily: references not updated for six months get an update invitation for their owner (never auto-sent).
  scheduled,
};

export class Interview extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.env = env; this.session = null; this.hs = hindsight(env); }

  async fetch(request) {
    if (new URL(request.url).pathname.startsWith('/api/memory')) return memoryRoutes(request, { storage: this.ctx.storage, hs: this.hs, env: this.env });
    // Private memory for this person's interview: recall before the opening, JEV relevance check when configured.
    const bank = request.headers.get('x-atlas-bank') || '', metric = (name, values) => console.log(JSON.stringify({ atlas_metric: name, ...values }));
    const memory = this.hs && bank && (await this.ctx.storage.get('memoryOff')) !== true ? async project => {
      const t0 = Date.now(); let found = await this.hs.recall(bank, recallQuery(project), { tags: project?.id && project.id !== 'new' ? ['project:' + project.id] : undefined });
      const n = found.length; let checked = 0;
      try { const j = await jevRelevant(this.env, found, project); found = j.memories; checked = j.checked; }
      catch (e) { if (budgetOutcome(e) || e?.name === 'BudgetRefused') throw e; metric('memory_jev_error', {}); }
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
      readyScore: Number(env.READY_SCORE) || undefined, model: env.ANALYST_MODEL, services: { teams: teamsClient(env) }, rater: storyRater(env) }); // JEV only with TYPESAFE_API_KEY
  }
  fetch(request) { return libraryRoutes(request, this.lib, { waitUntil: p => this.ctx.waitUntil(p), env: this.env }); }
}
