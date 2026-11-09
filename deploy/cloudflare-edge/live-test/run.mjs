// Driver for the local-only live test (docs/LIVE_TEST_BOUND.md): baseline, then Plan A transcription only, then drafts
// only if transcription-only ran cleanly and the ledger still has headroom. It talks to `wrangler dev` on localhost and
// writes timings and counts (no audio, no transcript text) to the output file. The ledger is the authority; the
// headroom check here only avoids starting a session that would certainly be cut off mid-turn.
//   node live-test/run.mjs http://127.0.0.1:8787 out.json [sessionsPerMode] [turnsPerSession]
import { writeFileSync } from 'node:fs';

const [base = 'http://127.0.0.1:8787', out = 'live-run.json', perMode = '1', perSession = '2'] = process.argv.slice(2);
// Scripted, fictional answers. The second part of a two-part answer follows a 1.0 s mid-answer pause, which exercises
// the early pause (0.7 s) without ending the turn (1.2 s), so a discarded early transcription is part of the sample.
const SCRIPT = [
  { parts: ['We moved the claims intake for the Harbour Lane pilot onto one shared queue.'] },
  { parts: ['I owned the routing rules myself.', 'The regional team adopted them in the second month.'], pauseMs: 1000 },
  { parts: ['Average handling time went from nine days to six, measured on the pilot queue only.'] },
  { parts: ['We rejected a full platform replacement because the budget was fixed.'] },
];
// Per-turn ceiling used for planning only: one reply (and one draft) at the largest prompt seen so far, plus headroom.
const PLAN = { inputPerCall: 14000, outputPerCall: 300 };

const get = async p => (await fetch(base + p)).json();
const post = async (p, b) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json();
const pct = (xs, p) => { const v = xs.filter(x => typeof x === 'number').sort((a, b) => a - b); if (!v.length) return null; return v[Math.min(v.length - 1, Math.ceil(p / 100 * v.length) - 1)]; };
const stats = xs => ({ n: xs.filter(x => typeof x === 'number').length, median: pct(xs, 50), p90: pct(xs, 90), p95: pct(xs, 95) });

function headroom(l, calls) {
  const r = l.reserved, c = l.caps;
  return !l.stopped && r.inputTokens + calls * PLAN.inputPerCall <= c.inputTokens && r.outputTokens + calls * PLAN.outputPerCall <= c.outputTokens && l.sessions < c.sessions;
}

const result = { kind: 'local-only live test (wrangler dev): synthetic speech, remote Workers AI binding, local ledger', base, started: new Date().toISOString(), runs: [], stopped: '' };
for (const mode of ['baseline', 'early_stt', 'early_draft']) {
  if (mode === 'early_draft' && result.runs.some(r => r.mode === 'early_stt' && (r.errors?.length || r.refused))) { result.skipped_drafts = 'early_stt run was not clean'; break; }
  for (let i = 0; i < Number(perMode); i++) {
    const turns = Number(perSession), calls = (1 + turns) * (mode === 'early_draft' ? 2 : 1);
    const before = await get('/ledger');
    if (!headroom(before, calls)) { result.stopped = `headroom before ${mode} session ${i + 1}`; break; }
    const r = await post('/run', { mode, turns: SCRIPT.slice(0, turns) });
    result.runs.push(r);
    if (r.refused || r.ledger?.stopped) { result.stopped = r.refused || r.ledger.stopped; break; }
  }
  if (result.stopped && !result.stopped.startsWith('headroom')) break;
}

const ledger = await get('/ledger');
const byMode = {};
for (const r of result.runs) {
  const m = byMode[r.mode] ||= { sessions: 0, turns: [], early_stt_sent: 0, early_stt_used: 0, early_withdrawn: 0, early_late_discarded: 0, draft_sent: 0, draft_adopted: 0, draft_withdrawn: 0, errors: [] };
  m.sessions += 1; m.errors.push(...(r.errors || []));
  for (const t of r.turns || []) {
    m.turns.push({ cold: t.index === 1, transcript_ms: t.transcript_ms, first_token_ms: t.first_token_ms, first_audio_sent_ms: t.first_audio_sent_ms });
    for (const x of t.metrics) {
      if (x.metric === 'early_stt_sent') m.early_stt_sent += 1; if (x.metric === 'early_stt_used') m.early_stt_used += 1;
      if (x.metric === 'early_withdrawn') m.early_withdrawn += 1; if (x.metric === 'early_late_discarded') m.early_late_discarded += 1;
      if (x.metric === 'early_draft_sent') m.draft_sent += 1; if (x.metric === 'early_draft_adopted') m.draft_adopted += 1; if (x.metric === 'early_draft_withdrawn') m.draft_withdrawn += 1;
    }
  }
}
for (const m of Object.values(byMode)) {
  const sel = (k, cold) => m.turns.filter(t => t.cold === cold).map(t => t[k]);
  m.latency_ms = Object.fromEntries(['transcript_ms', 'first_token_ms', 'first_audio_sent_ms'].map(k => [k, { cold: stats(sel(k, true)), warm: stats(sel(k, false)) }]));
  m.early_stt_discard_rate = m.early_stt_sent ? +(1 - m.early_stt_used / m.early_stt_sent).toFixed(3) : null;
  m.draft_discard_rate = m.draft_sent ? +(1 - m.draft_adopted / m.draft_sent).toFixed(3) : null;
}
Object.assign(result, { finished: new Date().toISOString(), ledger, by_mode: byMode,
  definitions: { end_of_speech: 'the moment the last frame of the final synthetic speech part was handed to the session', cold: 'the first consultant turn of a session', warm: 'later turns',
    first_token_ms: 'first agent_text event of the reply sent to the client', first_audio_sent_ms: 'first reply PCM chunk handed to the socket (sendBytes); a server-side proxy for first audible: no browser, no speaker, no network to a client' } });
writeFileSync(out, JSON.stringify(result, null, 1));
console.log(JSON.stringify({ out, stopped: result.stopped, sessions: ledger.sessions, turns: ledger.turns, usd_reserved: ledger.reserved.usd }));
