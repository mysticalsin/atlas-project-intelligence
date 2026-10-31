// Agent Brain v2.1 T10: interview checkpoints (plan 3g second half, D9, Tony Q3). Platform-free: the Durable Object (worker.js) hands in its storage.
//
// A checkpoint is the whole state of a live interview, kept ONLY when the consultant consented to transcript capture (the Session decides),
// in the signed-in person's OWN Interview Durable Object (one DO per identity: storage is per DO, and every read also requires the same
// forwarded identity), for 24 hours from its FIRST write (an absolute expiry: later writes and reconnects never extend it; a DO alarm purges it).
// It is deleted at once on a clean end, a discard or withdrawal, any end that is not a suspend, and by any new start that does not resume it.
// A finished interview (a terminal state of the machine) is never stored, and one that is found is neither offered nor kept. Pure parts: serialize(session) and restore(session, data), both carrying `version`.
//
// Storage layout (single slot per DO): cp:current -> session id; cp:<id>:meta -> {version, sessionId, owner, savedAt, expiresAt, chunks, bytes};
// cp:<id>:<n> -> a Uint8Array of at most CHUNK_BYTES (the UTF-8 JSON, split), written together with the meta in one atomic put.
import { Machine, StateError, STATES } from './conversation-state.js';

export const VERSION = 2; // 2 (T11): the summary read-back state
export const TTL_MS = 24 * 60 * 60 * 1000;
export const CHUNK_BYTES = 100 * 1024; // a value in Durable Object storage may be 128 KiB: stay under it
export const MAX_CHUNKS = 120; // 12 MB: far beyond any interview (the transcript budget is 100 000 characters); a put takes at most 128 keys
export const HISTORY_KEEP = 40;
const isTerminal = state => typeof state === 'string' && STATES.interview.terminal.includes(state);
const CUT_MARKER = /\s*\[(?:interrupted by the consultant|cut off[^\]]*)\]\s*$/;
const PREFIX = 'cp:', CURRENT = 'cp:current', SESSION_ID = /^[a-f0-9]{32}$/;
const enc = new TextEncoder(), dec = new TextDecoder();
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const metaKey = id => `${PREFIX}${id}:meta`, chunkKey = (id, n) => `${PREFIX}${id}:${n}`;

// code: missing (nothing to resume, or not yours), expired, version_mismatch, corrupt, too_large, terminal (a finished interview is not stored).
export class CheckpointError extends Error {
  constructor(code, message) { super(message || code); this.name = 'CheckpointError'; this.code = code; }
}
const bad = message => { throw new CheckpointError('corrupt', message); };

// Checkpoints exist unless the Worker env says ATLAS_CHECKPOINT=off (the rollback switch; any other value keeps them on).
export const checkpointEnabled = (env = {}) => String((env || {}).ATLAS_CHECKPOINT || '').toLowerCase() !== 'off';

export function newSessionId() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''); }

// What a checkpoint keeps of a Session (a copy: later changes to the session never alter it). Nothing here is reachable from the browser:
// it is stored, and read back by the same person's Durable Object only.
export function serialize(s) {
  const now = s.now(), L = s.ledger, h = s.humane, q = s.lastQuestion, at = q?.move ? h.asked.indexOf(q.move) : -1;
  return structuredClone({
    version: VERSION, sessionId: s.sessionId, savedAt: now, capturedAt: s.capturedAt ?? null, mode: s.mode, language: s.language, voice: s.voice, project: s.project, prefill: s.prefill,
    machine: s.stateSnapshot(),
    history: s.history.slice(-HISTORY_KEEP),
    ledger: { stage: L.stage, transcripts: [...L.transcripts], details: L.details, probes: L.probes, deferred: L.deferred, updates: L.updates },
    humane: { asked: h.asked, covered: [...h.covered], rushed: h.rushed, acks: h.acks, sinceEarned: h.sinceEarned, openers: h.openers },
    asr: { meta: s.asrMeta, idents: s.asrIdents, done: s.asrDone, corrections: s.asrCorrections },
    // The question in front of the consultant. Its move is stored as a position in the asked log (the session finds it by identity), or whole when it is not in it.
    lastQuestion: q ? { text: q.text, item: q.item, turn: q.turn ?? null, moveAt: at, move: at < 0 ? q.move ?? null : null } : null,
    // Durations, not clock readings: the time a connection was down is neither interview time nor wall-cap time.
    clock: { wall: now - s.startedAt, pausedTotal: s.pausedTotal, pausedFor: s.pausedAt === null ? 0 : now - s.pausedAt, paused: s.paused, pauseCount: s.pauseCount, resumeCount: s.resumeCount },
    // The read-back (T11): whether the card is open, how many read-backs and typed corrections there were, and the confirmation with the draft it saved.
    summary: { open: s.summary.open, rounds: s.summary.rounds, corrections: s.summary.corrections, confirmed: s.summary.confirmed, draft: s.summary.draft, prompts: s.summary.prompts },
    counters: { turns: s.turns, replies: s.replies, spokenMs: s.spokenMs, identNow: s.identNow, timeUp: s.timeUp },
  });
}

const list = (v, max, what) => { if (!Array.isArray(v) || v.length > max) bad(`${what} is not a list of at most ${max}`); return v; };
const num = (v, what) => { if (typeof v !== 'number' || !Number.isFinite(v)) bad(`${what} is not a number`); return v; };
const str = (v, what) => { if (typeof v !== 'string') bad(`${what} is not text`); return v; };

// Put a stored checkpoint back into a Session that has been constructed and has its analyst and ledger, but has not started. Everything is
// validated first and the session is changed only at the end, so a refused checkpoint leaves it untouched. The state machine comes back by
// replaying its audit trail (Machine.fromDict), left in `suspended` (a checkpoint taken while the connection was still up, as after a crash,
// is moved there by a system `disconnect`): the session then fires `reconnect`.
export function restore(s, d) {
  if (!isObj(d)) bad('not a checkpoint');
  if (d.version !== VERSION) throw new CheckpointError('version_mismatch', `checkpoint is version ${JSON.stringify(d.version)}, this is ${VERSION}`);
  if (typeof d.sessionId !== 'string' || !SESSION_ID.test(d.sessionId)) bad('bad session id');
  if (d.mode !== 'full') bad('only full interviews are resumable');
  let m;
  try {
    m = Machine.fromDict(d.machine);
    if (m.kind !== 'interview' || m.terminal) bad('the interview had already ended');
    if (m.state !== 'suspended') m.fire('disconnect', 'system', { at: new Date(s.now() * 1000).toISOString() });
  } catch (e) { if (e instanceof StateError) throw new CheckpointError(e.code === 'version_mismatch' ? 'version_mismatch' : 'corrupt', e.message); throw e; }
  const history = list(d.history, HISTORY_KEEP, 'history');
  for (const x of history) if (!isObj(x) || !['user', 'assistant'].includes(x.role) || typeof x.content !== 'string') bad('bad history entry');
  const L = d.ledger; if (!isObj(L)) bad('no ledger');
  const transcripts = list(L.transcripts, 180, 'transcripts').map(p => { if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'string' || typeof p[1] !== 'string') bad('bad transcript'); return p; });
  const details = list(L.details, 100, 'details'); for (const x of details) if (!isObj(x) || typeof x.id !== 'string' || typeof x.field !== 'string' || typeof x.quote !== 'string' || typeof x.item_id !== 'string') bad('bad detail');
  const probes = list(L.probes, 1000, 'probes'), updates = num(L.updates, 'updates'), stage = str(L.stage, 'stage');
  if (!isObj(L.deferred)) bad('bad deferred');
  const H = d.humane; if (!isObj(H)) bad('no humane state');
  const asked = list(H.asked, 400, 'asked'), covered = list(H.covered, 100, 'covered'), acks = list(H.acks, 20, 'acks'), openers = list(H.openers, 10, 'openers');
  if (!asked.every(isObj) || !covered.every(x => typeof x === 'string') || typeof H.rushed !== 'boolean') bad('bad humane state');
  if (H.sinceEarned !== null) num(H.sinceEarned, 'sinceEarned');
  const A = d.asr; if (!isObj(A) || !isObj(A.meta)) bad('no asr state');
  const idents = list(A.idents, 400, 'asr idents'), corrections = list(A.corrections, 100, 'asr corrections');
  const S = d.summary; if (!isObj(S)) bad('no summary state');
  if (typeof S.open !== 'boolean' || typeof S.confirmed !== 'boolean') bad('bad summary flags');
  for (const [v, what] of [[S.rounds, 'summary rounds'], [S.corrections, 'summary corrections'], [S.prompts, 'summary prompts']]) if (num(v, what) < 0) bad(what + ' is negative');
  if (S.draft !== null && !(isObj(S.draft) && typeof S.draft.id === 'string' && S.draft.id.length <= 100 && Number.isInteger(S.draft.revision))) bad('bad summary draft');
  if (S.open && !m.returns.some(r => r === 'summary' || r === 'user_correction')) bad('an open summary needs the interview to be in the read-back');
  const c = d.clock, k = d.counters; if (!isObj(c) || !isObj(k)) bad('no clock');
  for (const [v, what] of [[c.wall, 'wall'], [c.pausedTotal, 'pausedTotal'], [c.pausedFor, 'pausedFor'], [c.pauseCount, 'pauseCount'], [c.resumeCount, 'resumeCount'], [k.turns, 'turns'], [k.replies, 'replies'], [k.spokenMs, 'spokenMs']]) num(v, what);
  if (typeof c.paused !== 'boolean') bad('bad pause flag');
  if (c.paused !== (m.returns.at(-1) === 'paused')) bad('pause clock and state machine disagree');
  if (!isObj(d.project) || typeof d.project.title !== 'string' || !isObj(d.prefill)) bad('no project');
  let lastQuestion = null;
  if (d.lastQuestion !== null) {
    const q = d.lastQuestion; if (!isObj(q) || typeof q.text !== 'string') bad('bad last question');
    const move = Number.isInteger(q.moveAt) && q.moveAt >= 0 ? asked[q.moveAt] : q.move ?? null;
    if (Number.isInteger(q.moveAt) && q.moveAt >= 0 && !move) bad('last question points outside the asked log');
    lastQuestion = { text: q.text, move: isObj(move) ? move : null, item: typeof q.item === 'string' ? q.item : null, turn: Number.isInteger(q.turn) ? q.turn : null };
  }
  // Valid: change the session.
  const now = s.now();
  Object.assign(s, { capturedAt: Number.isFinite(d.capturedAt) ? d.capturedAt : null, sessionId: d.sessionId, language: typeof d.language === 'string' ? d.language : s.language, project: d.project, prefill: d.prefill, machine: m,
    history: history.slice(), lastQuestion, asrMeta: A.meta, asrIdents: idents, asrDone: isObj(A.done) ? A.done : null, asrCorrections: corrections,
    startedAt: now - c.wall, pausedTotal: c.pausedTotal, pausedAt: c.paused ? now - c.pausedFor : null, paused: c.paused, pauseCount: c.pauseCount, resumeCount: c.resumeCount,
    turns: k.turns, replies: k.replies, spokenMs: k.spokenMs, identNow: typeof k.identNow === 'string' ? k.identNow : null, timeUp: k.timeUp === true });
  Object.assign(s.summary, { open: S.open, rounds: S.rounds, corrections: S.corrections, confirmed: S.confirmed, draft: S.draft, prompts: S.prompts, sig: '', posting: false });
  Object.assign(s.humane, { asked, covered: new Set(covered), rushed: H.rushed, acks, sinceEarned: H.sinceEarned, openers });
  Object.assign(s.ledger, { stage, transcripts: new Map(transcripts), details, probes, deferred: L.deferred, updates });
  return { from: d.machine.state, savedAt: d.savedAt };
}

// What the browser needs to repopulate its screens after a resume (the `restore` event): the consultant's turns as they were heard, ATLAS's
// words, the quality state the story board shows, where the conversation stands. Sent to the same person on the same authenticated socket.
export function restoreView(s) {
  const typed = id => id.startsWith('user-typed-');
  return {
    user: [...s.ledger.transcripts].map(([item_id, text]) => ({ item_id, text, provenance: typed(item_id) ? 'consultant_typed' : 'unverified_speech_recognition' })),
    agent: s.history.filter(m => m.role === 'assistant').map(m => m.content.replace(CUT_MARKER, '')), // the talker's cut-off markers are never on the screen
    quality: { ...s.ledger.inspect(), analyst_status: 'restored' },
    // The open read-back, so the card comes back on the screen (items and open points from the ledger, as when it was first sent).
    summary: s.summary.open ? { ...s.summaryView(), state: s.machine.state } : null,
    lastQuestion: s.lastQuestion?.text || '', state: s.machine.state, paused: s.paused, activeSeconds: Math.max(0, Math.floor(s.activeSeconds())), turns: s.turns,
  };
}

// UTF-8 bytes split into pieces of at most `size` (a piece may end inside a character: they are rejoined before decoding).
export function split(bytes, size = CHUNK_BYTES) {
  const out = []; for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, Math.min(bytes.length, i + size)));
  return out.length ? out : [new Uint8Array(0)];
}

export class CheckpointStore {
  // storage: the Durable Object storage (get/put/delete/list/setAlarm/deleteAlarm). owner: the verified identity the Worker forwarded for this
  // request. now: milliseconds (a test moves it).
  constructor(storage, { owner = '', now = () => Date.now(), ttlMs = TTL_MS } = {}) { Object.assign(this, { storage, owner, now, ttlMs }); }

  // Write the checkpoint (one atomic put of the chunks and the meta), drop chunks of an older, longer write, and arm the purge alarm.
  async save(doc) {
    if (!isObj(doc) || typeof doc.sessionId !== 'string' || !SESSION_ID.test(doc.sessionId)) throw new CheckpointError('corrupt', 'bad session id');
    const id = doc.sessionId, state = isObj(doc.machine) ? doc.machine.state : null;
    if (isTerminal(state)) throw new CheckpointError('terminal', 'a finished interview is not stored');
    // The expiry is fixed by the FIRST write of this interview (kept in its meta; the Session also carries it, see session.js, for a purge in between): saving again never extends it.
    const savedAt = this.now(), old = await this.storage.get(metaKey(id));
    const capturedAt = isObj(old) && Number.isFinite(old.capturedAt) && old.capturedAt <= savedAt ? old.capturedAt : savedAt, expiresAt = capturedAt + this.ttlMs;
    if (savedAt >= expiresAt) { await this.purge(); throw new CheckpointError('expired', 'the 24 hours are over: the interview is no longer kept'); }
    const chunks = split(enc.encode(JSON.stringify(doc)));
    if (chunks.length > MAX_CHUNKS) throw new CheckpointError('too_large', 'the checkpoint is too large to keep');
    const entries = { [CURRENT]: id, [metaKey(id)]: { version: VERSION, sessionId: id, owner: this.owner, savedAt, capturedAt, expiresAt, state, chunks: chunks.length, bytes: chunks.reduce((n, c) => n + c.length, 0) } };
    chunks.forEach((c, n) => { entries[chunkKey(id, n)] = c; });
    await this.storage.put(entries);
    if (isObj(old) && Number.isInteger(old.chunks) && old.chunks > chunks.length) await this.storage.delete(Array.from({ length: old.chunks - chunks.length }, (_, i) => chunkKey(id, chunks.length + i)));
    await this.storage.setAlarm(expiresAt);
    return { chunks: chunks.length, bytes: entries[metaKey(id)].bytes, expiresAt, capturedAt };
  }

  // The current meta, or why there is none: null when nothing is stored, it is another person's (never purged by that), or a different version
  // of the format; an expired one is purged here as well (the alarm is the normal route).
  async meta() {
    const id = await this.storage.get(CURRENT);
    if (typeof id !== 'string' || !SESSION_ID.test(id)) return null;
    const m = await this.storage.get(metaKey(id));
    if (!isObj(m) || m.sessionId !== id) return null;
    if (this.owner && m.owner !== this.owner) return null;
    if (this.now() >= m.expiresAt) { await this.purge(); return null; }
    return m;
  }

  // What the bootstrap may say: that something can be resumed, and until when. Never any content.
  async info() {
    const m = await this.meta();
    if (m && isTerminal(m.state)) { await this.purge(); return null; } // finished (an older write): it can only be refused, so it is neither offered nor kept
    return m && m.version === VERSION ? { sessionId: m.sessionId, savedAt: m.savedAt, expiresAt: m.expiresAt } : null;
  }

  async load(sessionId) {
    const m = await this.meta();
    if (!m || m.sessionId !== sessionId) throw new CheckpointError('missing', 'no such checkpoint');
    if (m.version !== VERSION) throw new CheckpointError('version_mismatch', `checkpoint is version ${JSON.stringify(m.version)}, this is ${VERSION}`);
    const keys = Array.from({ length: m.chunks }, (_, n) => chunkKey(sessionId, n)), got = await this.storage.get(keys), parts = keys.map(k => got.get(k));
    if (parts.some(p => !(p instanceof Uint8Array))) throw new CheckpointError('corrupt', 'a chunk is missing');
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { bytes.set(p, at); at += p.length; }
    let doc; try { doc = JSON.parse(dec.decode(bytes)); } catch { throw new CheckpointError('corrupt', 'unreadable checkpoint'); }
    if (!isObj(doc) || doc.version !== VERSION) throw new CheckpointError(isObj(doc) && doc.version !== undefined ? 'version_mismatch' : 'corrupt', 'wrong checkpoint version');
    if (doc.sessionId !== sessionId) throw new CheckpointError('corrupt', 'checkpoint belongs to another session');
    return doc;
  }

  // Delete every checkpoint key of this Durable Object and disarm the alarm. Safe to call when nothing is stored.
  async purge() {
    const keys = [...(await this.storage.list({ prefix: PREFIX })).keys()];
    for (let i = 0; i < keys.length; i += 128) await this.storage.delete(keys.slice(i, i + 128));
    await this.storage.deleteAlarm();
    return keys.length;
  }

  // The alarm: purge what has expired (the stored interview is abandoned, ttl_expired), keep and re-arm what has not.
  async expire() {
    const id = await this.storage.get(CURRENT);
    if (typeof id !== 'string') { await this.storage.deleteAlarm(); return false; }
    const m = await this.storage.get(metaKey(id));
    if (!isObj(m) || this.now() >= m.expiresAt) { await this.purge(); return true; }
    await this.storage.setAlarm(m.expiresAt);
    return false;
  }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// The two routes the Worker forwards to the signed-in person's own Durable Object (it checks Origin and CSRF for the POST): who the checkpoint
// belongs to arrives only in a header the Worker overwrites after verifying the sign-in (x-atlas-user).
export async function checkpointRoutes(request, { storage, now = () => Date.now() }) {
  const url = new URL(request.url), owner = request.headers.get('x-atlas-user') || '';
  if (!owner) return json({ error: 'Sign in first.' }, 401);
  const store = new CheckpointStore(storage, { owner, now });
  if (request.method === 'GET' && url.pathname === '/api/checkpoint') return json({ resumable: await store.info() });
  if (request.method === 'POST' && url.pathname === '/api/checkpoint/discard') {
    const m = await store.meta(); if (m) await store.purge(); // only the owner's own checkpoint is deleted
    return json({ discarded: !!m });
  }
  return json({ error: 'Not found.' }, 404);
}
