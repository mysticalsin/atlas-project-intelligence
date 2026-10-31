// ATLAS edge deployment entry: Cloudflare Worker + one Durable Object per signed-in person.
import { DurableObject } from 'cloudflare:workers';
import page from './atlas.html';
import { handle, scheduled, workersAI } from './app.js';
import { jevRanker } from './jev.js';
import { Session } from './session.js';
import { CheckpointStore, checkpointRoutes, checkpointEnabled } from './checkpoint.js';
import { Library } from './library.js';
import { evidenceWorkflowOn } from './adapters.js';
import { postDraftFromInterview } from './evidence.js';
import { storyRater } from './rating.js';
import { libraryRoutes } from './library-routes.js';
import { hindsight, recallQuery, memoryNote, jevRelevant } from './memory.js';
import { memoryRoutes } from './memory-routes.js';
import { resolveForInterview } from './gaps.js';
import { fetchWinHint } from './winloop.js';
import { teamsClient } from './teams.js';

const EARLY_MAX = 64, EARLY_MAX_BYTES = 1024 * 1024; // messages held while the older window's session is suspending
const SUSPEND_WAIT_MS = 3000; // the longest the new window waits for the older window's session to finish suspending, then it proceeds

export default {
  fetch: (request, env, ctx) => handle(request, env, page, { waitUntil: p => ctx.waitUntil(p) }),
  // Daily: references not updated for six months get an update invitation for their owner (never auto-sent).
  scheduled,
};

export class Interview extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.env = env; this.session = null; this.hs = hindsight(env); }

  // The 24-hour purge of a stored interview (checkpoint.js): the alarm is armed at every checkpoint write, so it never needs another trigger.
  async alarm() { await new CheckpointStore(this.ctx.storage).expire(); }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/memory')) return memoryRoutes(request, { storage: this.ctx.storage, hs: this.hs, env: this.env });
    // Resumable interview of THIS person (their own Durable Object, their own identity): whether one exists, and discarding it.
    if (path === '/api/checkpoint' || path.startsWith('/api/checkpoint/')) return checkpointRoutes(request, { storage: this.ctx.storage });
    // Private memory for this person's interview: recall before the opening, JEV relevance check when configured.
    const bank = request.headers.get('x-atlas-bank') || '', metric = (name, values) => console.log(JSON.stringify({ atlas_metric: name, ...values }));
    const memory = this.hs && bank && (await this.ctx.storage.get('memoryOff')) !== true ? async project => {
      const t0 = Date.now(); let found = await this.hs.recall(bank, recallQuery(project), { tags: project?.id && project.id !== 'new' ? ['project:' + project.id] : undefined });
      const n = found.length; let checked = 0;
      try { const j = await jevRelevant(this.env, found, project); found = j.memories; checked = j.checked; } catch { metric('memory_jev_error', {}); }
      metric('memory_recall', { ms: Date.now() - t0, found: n, kept: found.length, jev_checked: checked });
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
    if (this.session && !this.session.finished) {
      // Still one live interview per signed-in person, but the newest window wins: a forgotten tab or a
      // stale session must never block the person from starting again.
      // Bounded: saving the older interview (up to ~8 s of waiting on transcription and the analyst) must not hold the new window's socket for ever.
      await Promise.race([this.session.fail('This interview continued in another window. Nothing was approved.', 'voice-contract'), new Promise(r => setTimeout(r, SUSPEND_WAIT_MS))]);
    }
    if (overflow) return new Response(null, { status: 101, webSocket: client }); // closed above; nothing was processed
    // The verified identity the Worker forwarded (always overwritten there), for gap requests and the win hint.
    const identity = { user: request.headers.get('x-atlas-user') || '', role: request.headers.get('x-atlas-role') || 'user', mail: request.headers.get('x-atlas-email') || '' };
    const session = new Session({
      io: { send: e => { try { server.send(JSON.stringify(e)); } catch { /* closed */ } }, sendBytes: b => { try { server.send(b); } catch { /* closed */ } },
        close: () => { try { server.close(1000, 'ended'); } catch { /* closed */ } } },
      ai: Object.assign(workersAI(this.env), jevRanker(this.env) ? { rankProbe: jevRanker(this.env) } : {}), csrf: request.headers.get('x-atlas-csrf') || '', voice: 'atlas', captureRequired: true, model: this.env.TALKER_MODEL, admin: request.headers.get('x-atlas-admin') === '1', memory,
      metric: (name, values) => console.log(JSON.stringify({ atlas_metric: name, ...values })),
      gaps: this.env.LIBRARY ? id => resolveForInterview(this.env, identity, id) : null,
      winHint: this.env.LIBRARY ? () => fetchWinHint(this.env, identity) : null,
      // Interviews with transcript consent are kept for 24 hours so a dropped connection can resume (ATLAS_CHECKPOINT=off: never).
      checkpoint: checkpointEnabled(this.env) && identity.user ? new CheckpointStore(this.ctx.storage, { owner: identity.user }) : null,
      // Confirming the read-back saves an OWNER-ONLY evidence draft under the verified identity, server to server (never submitted from here). Off with
      // ATLAS_EVIDENCE_WORKFLOW=off or without the library: the summary is then confirmed but not filed, and the browser is told so.
      evidence: evidenceWorkflowOn(this.env) && this.env.LIBRARY && identity.user ? notes => postDraftFromInterview(this.env, identity, notes) : null,
    });
    this.session = session;
    const onMessage = e => {
      try {
        if (typeof e.data === 'string') session.onText(e.data);
        else session.onBinary(new Uint8Array(e.data));
      } catch { session.fail('The session stopped safely. No story was approved.', 'voice-failed'); }
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
    this.lib = new Library(ctx.storage.sql, { complete: messages => ai.complete(messages), embed: text => ai.embed(text),
      readyScore: Number(env.READY_SCORE) || undefined, model: env.ANALYST_MODEL, services: { teams: teamsClient(env) }, rater: storyRater(env) }); // JEV only with TYPESAFE_API_KEY
  }
  fetch(request) { return libraryRoutes(request, this.lib, { waitUntil: p => this.ctx.waitUntil(p), env: this.env }); }
}
