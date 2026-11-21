// JavaScript port of atlas_voice/quality.py InterviewLedger and atlas_voice/analyst.py Analyst.
// Behaviour must match the Python source exactly: test/parity.test.js replays Python-generated
// scenarios and requires identical results. Candidate details are never verified facts.
import { FIELDS, TO_TOPIC, NUMERIC_SRC, UNCERTAIN_SRC, UNKNOWN_SRC, ANALYST_POLICY, CONTEXT_SEGMENTS, SEGMENT_CHARS, MAX_CALLS } from './policy.generated.js';

const FIELD_KEYS = Object.keys(FIELDS);
const NUMERIC = new RegExp(NUMERIC_SRC, 'i');
const UNCERTAIN = new RegExp(UNCERTAIN_SRC, 'i');
const UNKNOWN = new RegExp(UNKNOWN_SRC, 'i');
const ws = s => s.split(/\s+/).filter(Boolean).join(' ');
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = m => { throw new Error(m); };
const stable = v => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' : isObj(v) ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v);

export class InterviewLedger {
  constructor(stage = 'Unknown') {
    this.transcripts = new Map(); this.details = []; this.calls = new Map(); this.updates = 0;
    this.probes = []; this.deferred = {}; this.callInputs = new Map(); this.stage = stage;
    this.withheldItems = new Set();
  }

  addTranscript(itemId, text) {
    if (typeof itemId !== 'string' || !itemId || itemId.length > 160 || typeof text !== 'string') fail('Invalid transcription event');
    text = text.trim();
    if (!text || text.length > 12000 || this.transcripts.size >= 180) fail('Transcript budget or empty transcript');
    if (this.transcripts.has(itemId) && this.transcripts.get(itemId) !== text) fail('Transcript item changed; a correction needs a new item');
    let total = 0; for (const v of this.transcripts.values()) total += v.length;
    if (total + text.length > 100000) fail('Transcript context budget reached');
    this.transcripts.set(itemId, text);
  }

  record(raw) {
    if (!isObj(raw) || Object.keys(raw).length !== 1 || !('details' in raw) || !Array.isArray(raw.details) || raw.details.length < 1 || raw.details.length > 12) fail('Expected 1-12 candidate details');
    const pending = [];
    for (const x of raw.details) {
      if (!isObj(x) || Object.keys(x).some(k => !['field', 'item_id', 'quote', 'uncertain', 'supersedes'].includes(k))) fail('Invalid detail schema');
      if ('uncertain' in x && typeof x.uncertain !== 'boolean') fail('uncertain must be boolean');
      const f = x.field, ident = x.item_id, q = x.quote;
      if (!FIELD_KEYS.includes(f) || !this.transcripts.has(ident) || typeof q !== 'string' || q.length < 5 || q.length > 1800) fail('Invalid field, transcript reference or quote length');
      if (this.withheldItems.has(ident)) fail('Quote comes from words the consultant kept private');
      const quote = ws(q), source = ws(this.transcripts.get(ident));
      if (!source.includes(quote)) fail('Quote is not in the consultant transcript');
      const supersedes = x.supersedes || '';
      if (supersedes && !this.details.some(d => d.id === supersedes && d.field === f && d.active)) fail('Correction must reference an active same-field candidate');
      if ([...this.details, ...pending].some(d => d.field === f && d.item_id === ident && d.quote === quote && d.active)) continue;
      if (supersedes && pending.some(d => d.supersedes === supersedes)) fail('Only one correction per candidate in a batch');
      pending.push({ id: 'D-' + String(this.details.length + pending.length + 1).padStart(3, '0'), field: f, item_id: ident, quote,
        status: UNKNOWN.test(quote) ? 'unknown' : (x.uncertain === true || UNCERTAIN.test(quote)) ? 'uncertain' : 'reported',
        active: true, supersedes, provenance: 'unverified_speech_recognition' });
    }
    if (this.details.length + pending.length > 100) fail('Candidate budget reached');
    for (const x of pending) { if (x.supersedes) for (const old of this.details) if (old.id === x.supersedes) old.active = false; this.details.push(x); }
    this.updates += 1;
    return this.inspect();
  }

  // Privacy is a property of the utterance, not of whichever candidate is active.
  // Every detail of that item is flagged, and the words are removed from the
  // transcript, the details, and the cached tool results.
  withhold(detailId) {
    if (typeof detailId !== 'string' || !detailId) fail('Unknown detail');
    const d = this.details.find(x => x.id === detailId);
    if (!d) fail('Unknown detail');
    const item = d.item_id;
    const secrets = [];
    const transcript = this.transcripts.get(item);
    if (typeof transcript === 'string') secrets.push(transcript);
    for (const x of this.details) if (x.item_id === item && typeof x.quote === 'string') secrets.push(x.quote);
    this.withheldItems.add(item);
    for (const x of this.details) if (x.item_id === item) { x.withheld = true; x.quote = '[withheld]'; }
    if (this.transcripts.has(item)) this.transcripts.set(item, '[withheld]');
    this.scrubStored(secrets);
    return this.inspect();
  }

  scrubStored(secrets) {
    const list = [...new Set(secrets)].filter(s => typeof s === 'string' && s && s !== '[withheld]').sort((a, b) => b.length - a.length);
    const scrub = value => {
      if (typeof value === 'string') { let out = value; for (const s of list) out = out.split(s).join('[withheld]'); return out; }
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === 'object') { for (const k of Object.keys(value)) value[k] = scrub(value[k]); }
      return value;
    };
    for (const [id, sig] of this.callInputs) this.callInputs.set(id, scrub(sig));
    for (const [id, result] of this.calls) this.calls.set(id, scrub(result));
  }

  publicTranscript() {
    const parts = [];
    for (const [id, text] of this.transcripts) if (!this.withheldItems.has(id)) parts.push(text);
    return parts.join('\n\n');
  }

  measurementGaps(active) {
    const text = active.filter(x => x.field === 'measurement').map(x => x.quote).join(' ');
    const checks = [
      ['measure', /median|mean|duration|rate|time|cost|count|percentage|error|throughput|defect|accuracy/i.test(text)],
      ['before/after', /before|baseline/i.test(text) && /after|pilot|later|production/i.test(text) && (text.match(/\d+(?:[.,]\d+)?/g) || []).length >= 2],
      ['unit', /minute|second|hour|day|%|percent|dollar|ticket|case|unit/i.test(text)],
      ['period', /20\d\d|week|month|period|january|february|march|april|may|june|july|august|september|october|november|december/i.test(text)],
      ['population', /cohort|sample|population|team|queue|ticket|case|observation|region/i.test(text)],
    ];
    return checks.filter(([, v]) => !v).map(([k]) => k);
  }

  inspect() {
    // A detail marked private still holds its words until withhold runs. Inspect
    // finishes that, so a privately marked row is not returned while it is active.
    const pending = this.details.find(x => x.withheld === true && x.item_id && !this.withheldItems.has(x.item_id));
    if (pending) return this.withhold(pending.id);
    const hidden = this.withheldItems;
    const active = this.details.filter(x => x.active && x.withheld !== true && !hidden.has(x.item_id));
    const present = new Set(active.map(x => x.field));
    const missing = FIELD_KEYS.filter(f => !present.has(f));
    const numeric = active.some(x => x.field === 'outcome' && NUMERIC.test(x.quote));
    const flags = [];
    if (numeric && !present.has('measurement')) flags.push('Numerical outcome lacks a recorded measurement basis');
    if (active.some(x => x.status === 'uncertain' || x.status === 'unknown')) flags.push('Uncertainty must remain in the story');
    const multi = ['outcome', 'measurement'].filter(f => new Set(active.filter(d => d.field === f).map(d => d.quote)).size > 1);
    if (multi.length) flags.push('Multiple outcome/measurement accounts: confirm comparability or explicit correction');
    const unknown = new Set(active.filter(x => x.status === 'unknown').map(x => x.field));
    const basis = numeric ? this.measurementGaps(active) : [];
    if (numeric && unknown.has('measurement')) flags.push('No verified measurement: preserve a qualitative account; do not repeat a demand for ROI');
    else if (numeric && present.has('measurement') && basis.length) flags.push('Measurement account still needs: ' + basis.join(', '));
    const paused = new Set([...Object.keys(this.deferred), ...unknown]);
    let priority = null, reason = 'Find the most decision-useful detail, not a bigger claim.';
    if (multi.length && !paused.has('measurement')) { priority = 'measurement'; reason = 'Multiple accounts need clarification before one result is selected.'; }
    else if (numeric && basis.length && !paused.has('measurement')) { priority = 'measurement'; reason = 'A numerical claim needs its denominator and comparison basis.'; }
    else if (!present.has('contribution') && present.has('problem') && !paused.has('contribution')) { priority = 'contribution'; reason = 'Separate the consultant’s own work from the team’s achievement.'; }
    else priority = missing.find(f => !paused.has(f) && (f !== 'measurement' || numeric)) ?? null;
    let nextQuestion = priority ? FIELDS[priority][1] : 'What in this account would you correct before a customer sees it?';
    if (priority === 'measurement' && multi.length) nextQuestion = 'Do those two figures describe the same measure and population, or is one a correction?';
    else if (priority === 'measurement' && numeric) {
      if (basis.includes('before/after')) nextQuestion = 'What were the before and after values for that measure?';
      else if (basis.includes('period')) nextQuestion = 'Over which dates were the baseline and comparison measured?';
      else if (basis.includes('population')) nextQuestion = 'Which team or sample was measured in each period?';
      else if (basis.includes('unit')) nextQuestion = 'What is the unit of that measure?';
      else if (basis.includes('measure')) nextQuestion = 'What exactly does that number measure?';
    }
    const stage = this.stage.toLowerCase();
    if (['assessment', 'proof of concept'].includes(stage) && priority === 'outcome') nextQuestion = 'What decision or tested finding came out of this work, distinct from an implementation benefit?';
    return {
      candidate_details: active, missing, flags, next_field: priority, next_question: nextQuestion, why_this_question: reason,
      coverage: { present: present.size, total: FIELD_KEYS.length, meaning: 'candidate coverage; NOT quality, verification or approval' },
      unresolved_fields: [...new Set([...unknown, ...Object.keys(this.deferred)])].sort(),
      deferred_fields: { ...this.deferred }, measurement_gaps: basis,
      quality_state: flags.length || missing.length ? 'needs clarification' : 'ready for consultant correction; not verified',
      story_route: ['assessment', 'lessons learned'].includes(stage) ? 'learning or experience' : numeric && !basis.length && !unknown.has('measurement') ? 'quantified candidate' : 'qualitative candidate',
      evidence_status: 'unverified', updates: this.updates, next_action: priority ? 'ask_one_question' : 'reflect_and_confirm',
      probe_history: this.probes.slice(-12),
    };
  }

  planProbe() {
    const keys = [...this.transcripts.keys()], turn = keys.length ? keys[keys.length - 1] : 'opening';
    if (this.probes.length && this.probes[this.probes.length - 1].turn === turn) return { ...this.inspect(), planned_question: this.probes[this.probes.length - 1].question, repeat_plan: true };
    let choice = this.inspect(), f = choice.next_field;
    while (f && this.probes.filter(p => p.field === f).length >= 2) {
      this.deferred[f] = 'Two clarification plans did not resolve this point; offer to collect it later.';
      choice = this.inspect(); f = choice.next_field;
    }
    const entry = { field: f, question: choice.next_question, turn, status: 'planned_not_confirmed_spoken' };
    this.probes.push(entry);
    return { ...choice, planned_question: entry.question, repeat_plan: false, instruction: 'Ask one short, natural question. Do not read the ledger. Deferred is not resolved.' };
  }

  call(callId, name, args) {
    if (typeof callId !== 'string' || callId.length < 1 || callId.length > 200) fail('Invalid call ID');
    const signature = stable([name, args]);
    if (this.calls.has(callId)) { if (this.callInputs.get(callId) !== signature) fail('Call ID reused with different arguments'); return this.calls.get(callId); }
    if (this.calls.size >= 150) fail('Tool budget exceeded');
    const empty = isObj(args) && Object.keys(args).length === 0;
    const result = name === 'record_details' ? this.record(args) : name === 'inspect_gaps' && empty ? this.inspect() : name === 'plan_probe' && empty ? this.planProbe() : null;
    if (result === null) fail('Unknown or invalid tool');
    this.callInputs.set(callId, signature); this.calls.set(callId, result);
    return result;
  }

  notes() {
    const sections = ['', '', '', '', '', ''];
    const hidden = this.withheldItems;
    for (const x of this.details) if (x.active && x.withheld !== true && !hidden.has(x.item_id)) { const i = TO_TOPIC[x.field]; if (!sections[i].includes(x.quote)) sections[i] = (sections[i] + '\n' + x.quote).trim().slice(0, 6000); }
    return sections;
  }
}

export function buildMessages(ledger, itemId) {
  const ids = [...ledger.transcripts.keys()];
  const hidden = ledger.withheldItems || new Set();
  const recent = ids.slice(-(CONTEXT_SEGMENTS + 1)).filter(i => i !== itemId && !hidden.has(i)).slice(-CONTEXT_SEGMENTS);
  const active = ledger.details.filter(d => d.active && d.withheld !== true && !hidden.has(d.item_id)).map(d => ({ id: d.id, field: d.field, quote: d.quote.slice(0, 200) })).slice(-20);
  const segment = hidden.has(itemId) ? '' : ledger.transcripts.get(itemId);
  const context = { project_stage: ledger.stage, recent_segments: recent.map(i => ({ item_id: i, text: ledger.transcripts.get(i).slice(0, SEGMENT_CHARS) })),
    active_candidates: active, new_segment: { item_id: itemId, text: segment.slice(0, SEGMENT_CHARS * 4) } };
  return [{ role: 'system', content: ANALYST_POLICY }, { role: 'user', content: 'UNTRUSTED INTERVIEW DATA\n' + JSON.stringify(context) }];
}

export function guidance(plan) {
  const field = plan.next_field;
  return { field, label: field ? FIELDS[field][0] : null, question: plan.planned_question || plan.next_question,
    why: plan.why_this_question, action: plan.next_action, deferred: Object.keys(plan.deferred_fields || {}).sort() };
}

export class Analyst {
  // complete(messages) -> [{id, name, arguments(string)}]. Only record_details is honoured.
  constructor(complete, stage = 'Unknown', timeoutMs = 8000) { this.ledger = new InterviewLedger(stage); this.complete = complete; this.timeoutMs = timeoutMs; this.chain = Promise.resolve(); }

  hear(itemId, text) {
    // Serialise turns so the ledger order equals speech order.
    const run = this.chain.then(() => this._hear(itemId, text));
    this.chain = run.catch(() => {});
    return run;
  }

  async _hear(itemId, text) {
    this.ledger.addTranscript(itemId, text);
    let status = 'analysed', rejected = 0, ignored = 0, calls = [];
    try {
      calls = await Promise.race([this.complete(buildMessages(this.ledger, itemId)), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), this.timeoutMs))]);
      if (!Array.isArray(calls)) throw new Error('bad');
    } catch { calls = []; status = 'analyst-unavailable'; }
    for (const call of calls.slice(0, MAX_CALLS)) {
      if (call?.name !== 'record_details') { ignored += 1; continue; }
      let details;
      try { const a = typeof call.arguments === 'string' ? JSON.parse(call.arguments || '{}') : call.arguments; details = a.details; if (!Array.isArray(details)) throw 0; details = details.slice(0, 12); }
      catch { rejected += 1; continue; }
      details.forEach((detail, n) => { try { this.ledger.call(`${call.id ?? ''}#${n}`, 'record_details', { details: [detail] }); } catch { rejected += 1; } });
    }
    ignored += Math.max(0, calls.length - MAX_CALLS);
    const plan = this.ledger.planProbe();
    return { ...plan, analyst_status: status, rejected_proposals: rejected, ignored_tool_calls: ignored, guidance: guidance(plan) };
  }
}
