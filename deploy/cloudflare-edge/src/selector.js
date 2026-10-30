// JavaScript port of atlas_voice/selector.py select() (parity-tested): the deterministic next-move selector. It reads the ledger's
// inspect() output (plan), the pre-pass of the latest answer (turn, turns.js analyzeTurn shape), the moves already made (asked),
// what is known up front (prefill), phase and time left, uncertain speech spans (asr) and a rushed flag, and returns a Move
// { kind, intent, field, rung, say, why, reaction, ack_category }. No model, no clock, no I/O, and never a score. All tables come
// from policy.generated.js (SELECTOR_CONFIG, QUESTION_BANK, SELECTOR_LINES, ...); see the Python module for the rules.
import {
  FIELDS, TURN_NOT_AN_ANSWER, SELECTOR_CONFIG as CONFIG, QUESTION_BANK, SELECTOR_LINES as LINES, SELECTOR_LEAD_RUSHED as LEAD_RUSHED,
  SELECTOR_NOT_ATTEMPTS as NOT_ATTEMPTS, SELECTOR_PHASES as PHASES, SELECTOR_ESSENTIALS as ESSENTIALS, SELECTOR_METRIC_PARTS as METRIC_PARTS,
} from './policy.generated.js';

const FIELD_KEYS = Object.keys(FIELDS);
const REPEAT_LAST = 'repeat_last';
const LADDER_INTENTS = [...Object.values(CONFIG.fields).map(v => v.intent), 'role', 'impact_assessment'];
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = v => typeof v === 'string';
const inF = f => isStr(f) && has(FIELDS, f);
const truthy = v => (Array.isArray(v) ? v.length > 0 : isObj(v) ? Object.keys(v).length > 0 : Boolean(v));
const rung = f => CONFIG.fields[f].rung;
const cache = new Map();
const re = (src, flags = 'i') => { const k = flags + src; let r = cache.get(k); if (!r) cache.set(k, r = new RegExp(src, flags)); return r; };

// ----- text helpers -----
const tokens = text => (isStr(text) ? text : '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z0-9']+/g) || [];
function grams(text) {
  const toks = tokens(text);
  if (!toks.length) return new Set();
  if (toks.length < 3) return new Set([toks.join(' ')]);
  const s = new Set();
  for (let i = 0; i < toks.length - 2; i++) s.add(toks.slice(i, i + 3).join(' '));
  return s;
}
// Word 3-gram Jaccard >= 0.8, in integers.
export function similar(a, b) {
  const ga = grams(a), gb = grams(b);
  if (!ga.size || !gb.size) return false;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  const union = ga.size + gb.size - inter;
  return inter * CONFIG.repeat_den >= union * CONFIG.repeat_num;
}
const clean = text => Array.from((isStr(text) ? text : '').replace(re(CONFIG.patterns.junk, 'g'), ' ').trim()).slice(0, CONFIG.span_chars).join('').trim();
const render = (tpl, params) => tpl.replace(/\{(\w+)\}/g, (m, k) => (has(params, k) ? params[k] : m));
const active = d => isObj(d) && ('active' in d ? d.active : true);

// ----- reading the inputs -----
function presentFields(plan) {
  const present = new Set(), details = plan.candidate_details;
  if (Array.isArray(details)) for (const d of details) if (active(d) && d.status !== 'unknown') present.add(d.field);
  if (Array.isArray(plan.missing) && !(Array.isArray(details) && details.length)) for (const f of FIELD_KEYS) if (!plan.missing.includes(f)) present.add(f);
  return new Set([...present].filter(inF));
}
function ledgerPaused(plan) {
  const out = new Set();
  for (const d of Array.isArray(plan.candidate_details) ? plan.candidate_details : []) if (active(d) && d.status === 'unknown') out.add(d.field);
  if (Array.isArray(plan.unresolved_fields)) for (const f of plan.unresolved_fields) out.add(f);
  if (isObj(plan.deferred_fields)) for (const f of Object.keys(plan.deferred_fields)) out.add(f);
  return new Set([...out].filter(inF));
}
function prefilledFields(prefill) {
  const out = new Set();
  if (!isObj(prefill)) return out;
  let notes = prefill.prior_notes;
  if (isObj(notes)) notes = Array.isArray(notes.fields) || isObj(notes.fields) ? notes.fields : notes;
  if (isObj(notes)) { for (const [k, v] of Object.entries(notes)) if (inF(k) && truthy(v)) out.add(k); }
  else if (Array.isArray(notes)) for (const k of notes) if (isStr(k) && inF(k)) out.add(k);
  for (const k of FIELD_KEYS) if (truthy(prefill[k])) out.add(k);
  return out;
}
const numbersIn = quote => [...(isStr(quote) ? quote : '').matchAll(re(CONFIG.patterns.number_unit, 'gi'))].map(m => [m[1], m[0].split(/\s+/).filter(Boolean).join(' ')]);
const subset = (a, b) => [...a].every(x => b.has(x));

// (field, a, b) for the first field with two active candidates whose numbers each hold a value the other lacks; else null.
export function contradiction(plan) {
  const by = {};
  for (const d of Array.isArray(plan.candidate_details) ? plan.candidate_details : []) if (active(d) && inF(d.field) && isStr(d.quote)) (by[d.field] ||= []).push(d.quote);
  for (const f of FIELD_KEYS) {
    const qs = by[f] || [];
    for (let i = 0; i < qs.length; i++) for (let j = i + 1; j < qs.length; j++) {
      const na = numbersIn(qs[i]), nb = numbersIn(qs[j]), sa = new Set(na.map(x => x[0])), sb = new Set(nb.map(x => x[0]));
      if (sa.size && sb.size && !subset(sa, sb) && !subset(sb, sa)) return [f, clean(na.find(x => !sb.has(x[0]))[1]), clean(nb.find(x => !sa.has(x[0]))[1])];
    }
  }
  return null;
}

export function effectivePhase(phase, timeLeft) {
  let idx = PHASES.indexOf(phase); if (idx < 0) idx = 0;
  if (typeof timeLeft === 'number') {
    if (timeLeft <= CONFIG.wrap_s) idx = Math.max(idx, 3);
    else if (timeLeft <= CONFIG.closing_left_s) idx = Math.max(idx, 2);
  }
  return PHASES[idx];
}

const strList = v => (Array.isArray(v) ? v.filter(isStr) : []);
function context(plan, turn, asked, prefill, phase, timeLeft, rushed) {
  plan = isObj(plan) ? plan : {}; turn = isObj(turn) ? turn : {}; prefill = isObj(prefill) ? prefill : {};
  asked = (Array.isArray(asked) ? asked : []).filter(isObj);
  const intents = strList(turn.intents), cues = strList(turn.cues), hints = Array.isArray(turn.field_hints) ? turn.field_hints.filter(inF) : [];
  const words = Number.isInteger(turn.words) ? turn.words : 0;
  const last = asked.length ? asked[asked.length - 1] : null, lastField = last && inF(last.field) ? last.field : null;
  const answerShaped = words >= 1 && !intents.some(i => TURN_NOT_AN_ANSWER.includes(i));
  const covered = new Set(hints);
  if (Array.isArray(plan.covered_fields)) for (const f of plan.covered_fields) if (inF(f)) covered.add(f);
  // the thread is where the answer got furthest along the ladder (the asked field wins a tie), else the field just asked
  let thread = lastField;
  if (hints.length) {
    const key = f => [rung(f), f === lastField ? 1 : 0, -FIELD_KEYS.indexOf(f)];
    const better = (f, b) => { const x = key(f), y = key(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
    thread = hints.reduce((b, f) => (b === null || better(f, b) ? f : b), null);
  }
  const flags = Array.isArray(plan.flags) ? plan.flags : [];
  const gaps = plan.measurement_gaps;
  const numericPlan = (Array.isArray(gaps) && gaps.length > 0) || flags.some(f => isStr(f) && f.startsWith('Numerical outcome lacks'));
  const deferred = ledgerPaused(plan);
  for (const a of asked) {
    const m = /^(?:dont_know|cannot_disclose|skip):([a-z_]+)(?:>|$)/.exec(isStr(a.why) ? a.why : '');
    if (m && inF(m[1])) deferred.add(m[1]);
    if (a.intent === 'offer_move_on' && inF(a.field)) deferred.add(a.field);
  }
  return {
    plan, turn, asked, prefill, intents, cues, hints, words, numbers: Array.isArray(turn.numbers) ? turn.numbers : [], last, lastField, answerShaped,
    covered, thread, present: presentFields(plan), numericPlan, deferred, prefilled: prefilledFields(prefill), rushed: Boolean(rushed) || intents.includes('rushed'),
    phase: effectivePhase(phase, timeLeft), recent: asked.slice(-CONFIG.repeat_window).map(a => a.say).filter(isStr),
  };
}

const real = a => a.why !== REPEAT_LAST;
const count = (c, intent, field = null, anyField = false) => c.asked.filter(a => real(a) && a.intent === intent && (anyField || (a.field ?? null) === field)).length;
const attempts = (c, field) => c.asked.filter(a => real(a) && a.field === field && !NOT_ATTEMPTS.includes(a.intent)).length;
const summarized = c => c.asked.some(a => a.kind === 'summary' || a.intent === 'summary');

// The wording for a candidate: the variant its count points at, else the next, skipping any that repeats a recent say.
function say(c, cand) {
  const bank = QUESTION_BANK[cand.intent].en, start = count(c, cand.intent, null, true) % bank.length;
  const lead = c.rushed && cand.lead && !c.asked.some(a => isStr(a.why) && a.why.includes('rushed:')) ? LEAD_RUSHED + ' ' : '';
  for (let k = 0; k < bank.length; k++) {
    const text = lead + render(bank[(start + k) % bank.length], cand.params || {});
    if (!c.recent.some(r => similar(text, r))) return [text, k === 0 ? '' : '+rv'];
  }
  return null;
}

// ----- candidates, in priority order -----
function metricPart(c) {
  const { plan, cues } = c, gaps = plan.measurement_gaps, known = c.present.has('measurement') && Array.isArray(gaps);
  const quotes = (Array.isArray(plan.candidate_details) ? plan.candidate_details : [])
    .filter(d => active(d) && ['measurement', 'outcome'].includes(d.field) && isStr(d.quote)).map(d => d.quote).join(' ');
  const last = c.last, done = new Set(c.asked.slice(0, -1).filter(a => real(a) && METRIC_PARTS.includes(a.intent)).map(a => a.intent));
  if (last && METRIC_PARTS.includes(last.intent) && c.answerShaped) done.add(last.intent);
  if (done.size) { const hi = Math.max(...[...done].map(p => METRIC_PARTS.indexOf(p))); for (const p of METRIC_PARTS.slice(0, hi + 1)) done.add(p); }
  const units = new Set(c.numbers.filter(isObj).map(n => n.unit));
  if (!done.has('metric_kind') && !cues.includes('estimate') && !re(CONFIG.patterns.kind_words).test(quotes)) return 'metric_kind';
  if (!done.has('metric_period') && !(known && !gaps.includes('period')) && !CONFIG.period_units.some(u => units.has(u))) return 'metric_period';
  if (!done.has('metric_baseline') && c.numbers.length < 2 && !(known && !gaps.includes('before/after'))) return 'metric_baseline';
  if (!done.has('metric_source') && !['evidence'].some(f => c.present.has(f) || c.covered.has(f) || c.prefilled.has(f))) return 'metric_source';
  return null;
}

// Ladder candidates for the fields still worth asking, best first, as [field, score].
function ladder(c) {
  const cfg = CONFIG, out = [];
  FIELD_KEYS.forEach((f, i) => {
    const fc = cfg.fields[f];
    if (c.deferred.has(f) || c.present.has(f) || c.covered.has(f) || c.prefilled.has(f)) return;
    if (c.rushed && !ESSENTIALS.includes(f)) return;
    if (c.phase === 'closing' && !ESSENTIALS.includes(f)) return;
    let gain = cfg.gain.missing;
    if (f === 'measurement') {
      if (c.numericPlan) gain = cfg.gain.measurement_flagged;
      else if (c.present.has('outcome') || c.covered.has('outcome')) gain = cfg.gain.measurement_qualitative;
      else return;
    }
    const rel = cfg.relevance;
    let relevance;
    if (c.thread === null) relevance = rel.default;
    else { const d = rung(f) - rung(c.thread); relevance = d === 1 ? rel.next_rung : d === 0 ? rel.same_rung : d > 1 ? rel.ahead : rel.behind; }
    if (c.phase === 'depth' && rung(f) >= rel.depth_rung) relevance += rel.phase_bonus;
    else if (c.phase === 'breadth' && rung(f) <= rel.breadth_rung) relevance += rel.phase_bonus;
    const tries = attempts(c, f), exhausted = tries >= cfg.max_attempts;
    const score = fc.value * gain * relevance - fc.effort * cfg.weights.effort - fc.sensitivity * cfg.weights.sensitivity - (exhausted ? 0 : cfg.weights.asked * tries);
    if (score > 0 || exhausted) out.push([score, i, f]);
  });
  out.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  return out.map(([s, , f]) => [f, s]);
}

function* candidates(c) {
  const { cues, rushed } = c, cueing = !rushed && (c.phase === 'breadth' || c.phase === 'depth'), lastIntent = c.last ? c.last.intent : null;
  const none = { params: {}, important: false };
  if (cueing) {
    const hit = contradiction(c.plan);
    if (hit) yield { intent: 'contradiction', field: hit[0], rung: rung(hit[0]), params: { a: hit[1], b: hit[2] }, why: 'contradiction:' + hit[0], important: true };
    const continuing = METRIC_PARTS.includes(lastIntent) && c.answerShaped;
    if (!c.deferred.has('measurement') && (cues.includes('metric') || continuing || (c.numericPlan && c.hints.includes('measurement')))) {
      const part = metricPart(c);
      if (part) yield { intent: part, field: 'measurement', rung: 7, params: {}, why: 'metric:' + part.slice(7), important: true };
    }
    if (cues.includes('vague_verb') || lastIntent === 'vague_example') {
      if (lastIntent === 'vague_example' || count(c, 'vague_example', 'intervention') >= CONFIG.max_attempts) {
        if (!(c.present.has('contribution') || c.covered.has('contribution')) && !['ownership', 'role'].includes(lastIntent)) yield { ...none, intent: 'ownership', field: 'contribution', rung: 3, why: 'vague:ownership' };
      } else if (!['ownership', 'team_ownership'].includes(lastIntent)) yield { ...none, intent: 'vague_example', field: 'intervention', rung: 2, why: 'vague:example' };
    }
    if (cues.includes('team_claim') && !['team_ownership', 'ownership', 'role', 'vague_example'].includes(lastIntent)
        && !c.present.has('contribution') && !c.covered.has('contribution') && !c.prefilled.has('contribution')) yield { ...none, intent: 'team_ownership', field: 'contribution', rung: 3, why: 'team_claim' };
    if (cues.includes('tech_list') && lastIntent !== 'tech_depth') yield { ...none, intent: 'tech_depth', field: null, rung: 2, why: 'tech_list' };
    if (cues.includes('certification') && lastIntent !== 'cert_details') yield { ...none, intent: 'cert_details', field: null, rung: null, why: 'certification' };
    if (cues.includes('client_praise') && lastIntent !== 'praise_source') yield { ...none, intent: 'praise_source', field: null, rung: null, why: 'client_praise' };
    if (c.phase === 'depth' && c.present.size >= CONFIG.reflect_min_fields && !c.asked.some(a => a.kind === 'reflect' || a.intent === 'reflect')) {
      const labels = FIELD_KEYS.filter(f => c.present.has(f)).map(f => FIELDS[f][0].toLowerCase()).slice(0, 3);
      const text = labels.length === 1 ? labels[0] : labels.slice(0, -1).join(', ') + ' and ' + labels[labels.length - 1];
      yield { ...none, intent: 'reflect', kind: 'reflect', field: null, rung: null, params: { labels: text }, why: 'reflect:depth' };
    }
  }
  for (const [f] of ladder(c)) {
    const fc = CONFIG.fields[f];
    let intent = fc.intent;
    if (f === 'contribution' && !(truthy(c.prefill.role) || count(c, 'role', 'contribution'))) intent = 'role';
    else if (f === 'outcome' && CONFIG.assessment_stages.includes(String(c.prefill.stage ?? '').toLowerCase())) intent = 'impact_assessment';
    else if (f === 'measurement' && c.numericPlan) { intent = metricPart(c); if (intent === null) continue; }
    yield { intent, field: f, rung: fc.rung, params: {}, why: (rushed ? 'rushed:' : '') + 'ladder:' + f, important: true, lead: rushed };
  }
}

function blocked(c, cand) {
  const { field: f, intent } = cand;
  if (LADDER_INTENTS.includes(intent) && inF(f)) return attempts(c, f) >= CONFIG.max_attempts;
  return count(c, intent, f ?? null) >= CONFIG.max_attempts;
}

// The first candidate that is neither deferred nor exhausted nor a repeat, with its words filled in; null when nothing is left.
function pick(c) {
  let suffix = '';
  for (const cand of candidates(c)) {
    const f = cand.field ?? null;
    if (f !== null && c.deferred.has(f)) continue;
    if (blocked(c, cand)) {
      if (cand.important && inF(f) && !c.asked.some(a => a.intent === 'offer_move_on' && a.field === f)) {
        const offer = { intent: 'offer_move_on', kind: 'offer_move_on', field: f, rung: cand.rung, params: {}, why: 'blocked:' + cand.intent + ':' + f };
        const said = say(c, offer);
        if (said) { offer.say = said[0]; return offer; }
      }
      continue;
    }
    const said = say(c, cand);
    if (said === null) { suffix = '+ri'; continue; }
    cand.say = said[0]; cand.why += said[1] + suffix;
    return cand;
  }
  return null;
}

// ----- reactions -----
function reaction(c, accept = null) {
  const cues = c.cues;
  if (accept === 'correction') return ['ack', 'correction_thanks'];
  if (cues.includes('describes_setback')) return ['ack', 'setback_neutral'];
  if (accept === 'dont_know' || accept === 'skip') {
    const numeric = ['measurement', 'outcome'].includes(c.thread) || cues.includes('metric') || (c.last && [...METRIC_PARTS, 'measurement', 'impact'].includes(c.last.intent));
    return ['ack', numeric ? 'no_number_fine' : 'neutral'];
  }
  if (accept === 'cannot_disclose') return ['ack', 'confidential_ok'];
  if (cues.includes('metric') && !c.present.has('measurement') && (cues.includes('describes_achievement') || cues.includes('estimate'))) return ['ack', 'promising_unverified'];
  const gaps = c.plan.measurement_gaps, basisKnown = c.present.has('measurement') && !(Array.isArray(gaps) && gaps.length > 0);
  const recentEarned = c.asked.slice(-CONFIG.earned_gap).some(a => a.reaction === 'earned');
  if (cues.includes('describes_achievement') && basisKnown && !recentEarned) return ['earned', 'earned_result'];
  if (c.words >= CONFIG.detail_words) return ['ack', 'thanks_detail'];
  if (c.words >= CONFIG.ack_min_words) return ['ack', 'neutral'];
  return ['none', null];
}
const NONE = ['none', null];
const move = (kind, cand, text, why, r) => ({ kind, intent: cand.intent, field: cand.field ?? null, rung: cand.rung ?? null, say: text, why, reaction: r[0], ack_category: r[1] });
function line(c, kind, why, r = NONE) {
  const bank = LINES[kind].en;
  return { kind, intent: kind, field: null, rung: null, say: bank[count(c, kind, null, true) % bank.length], why, reaction: r[0], ack_category: r[1] };
}
// No question is left: the read-back summary first, then the close.
const end = (c, why, r = NONE) => (summarized(c) ? line(c, 'close', 'close:' + why, r) : line(c, 'summary', 'summary:' + why, r));
const deferField = c => (c.hints.includes(c.lastField) ? c.lastField : c.hints.length ? c.hints[0] : c.lastField);

export function select(plan, turn, asked, prefill, phase, timeLeft, asr = null, rushed = false, lang = 'en') {
  const c = context(plan, turn, asked, prefill, phase, timeLeft, rushed), { intents, last } = c;
  // 1. time is up: close, no question
  if (c.phase === 'wrap') return line(c, 'close', 'close:wrap');
  // 2. a span of speech the recogniser was unsure of (once per span), or the repair after a "no"
  if (last && last.intent === 'confirm_asr' && intents.includes('deny')) {
    const cand = { intent: 'asr_repair', field: null, rung: null, params: {} }, said = say(c, cand);
    if (said && count(c, 'asr_repair', null, true) < CONFIG.max_attempts) return move('ask', cand, said[0], 'asr_repair' + said[1], NONE);
  }
  for (const span of Array.isArray(asr) ? asr : []) {
    const text = isObj(span) ? clean(span.text) : '';
    if (!text || c.asked.some(a => a.intent === 'confirm_asr' && String(a.say ?? '').toLowerCase().includes(text.toLowerCase()))) continue;
    const cand = { intent: 'confirm_asr', field: null, rung: null, params: { span: text } };
    let said = say(c, cand);
    if (said === null) said = [render(QUESTION_BANK.confirm_asr.en[count(c, 'confirm_asr', null, true) % 3], cand.params), '+rv'];
    return move('confirm_asr', cand, said[0], 'asr_span' + said[1], NONE);
  }
  // 3. the consultant wants to stop
  if (intents.includes('stop')) return end(c, 'stop');
  // 4. a correction: use their version, narrow
  if (intents.includes('correction')) {
    const number = c.numbers.length > 0;
    const cand = { intent: number ? 'correction_number' : 'correction', field: c.thread, rung: number ? 7 : 3, params: {} }, said = say(c, cand);
    return move('accept_and_move', cand, said ? said[0] : render(QUESTION_BANK[cand.intent].en[0], {}), 'correction' + (said ? said[1] : ''), reaction(c, 'correction'));
  }
  // 5. a pause, a "say that again" or a question to ATLAS leaves the last question unanswered: put it again (not an attempt)
  if (last && String(last.say ?? '').includes('?') && ['pause', 'resume', 'repeat', 'question_to_atlas'].some(i => intents.includes(i))) {
    return { kind: ['confirm_asr', 'offer_move_on', 'reflect'].includes(last.kind) ? last.kind : 'ask', intent: last.intent ?? null, field: last.field ?? null, rung: last.rung ?? null,
      say: last.say, why: REPEAT_LAST, reaction: 'none', ack_category: null };
  }
  // 5b. right after the read-back summary, a short reply ends the interview
  if (last && (last.kind === 'summary' || last.intent === 'summary') && (c.words <= 6 || intents.includes('confirm'))) return line(c, 'close', 'close:after_summary');
  // 6. "I don't know" / "I can't share" / skip: accept, leave the field open, ask something else (never that field again)
  const accept = ['cannot_disclose', 'dont_know', 'skip'].find(i => intents.includes(i));
  if (accept) {
    const field = deferField(c);
    if (field) c.deferred.add(field);
    const tag = accept + ':' + (field || '-');
    if (accept === 'cannot_disclose' && field && !count(c, 'anonymise', field)) {
      const cand = { intent: 'anonymise', field, rung: rung(field), params: {} }, said = say(c, cand);
      if (said) return move('accept_and_move', cand, said[0], tag + '>anonymise' + said[1], reaction(c, accept));
    }
    const cand = pick(c);
    if (cand === null) { const e = end(c, 'no_candidates', reaction(c, accept)); e.why = tag + '>' + e.why; return e; }
    return move('accept_and_move', cand, cand.say, tag + '>' + cand.why, reaction(c, accept));
  }
  // 7. everything else: the best question
  const cand = pick(c);
  if (cand === null) return end(c, c.rushed ? 'essentials' : c.phase === 'closing' ? 'closing' : 'no_candidates');
  const kind = cand.kind || 'ask';
  return move(kind, cand, cand.say, cand.why, kind === 'offer_move_on' || kind === 'reflect' || cand.intent === 'contradiction' ? NONE : reaction(c));
}
