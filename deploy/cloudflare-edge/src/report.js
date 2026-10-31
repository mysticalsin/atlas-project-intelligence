// End-of-interview report and the talker's end marker. Parity-tested port of atlas_voice/report.py.
// The report is a model-written draft grounded only in the consultant's transcript; the consultant reviews it before saving.
import { REPORT_POLICY, REPORT_TOPICS, REPORT_LIMITS, REPORT_LISTS, REPORT_TRANSCRIPT_CHARS, FACT_TEXT, FACT_LISTS } from './policy.generated.js';

// Bounded runs (red L7; report.py): a stream of '[' or spaces can neither be matched nor retained without limit, so a feed costs the same however long the reply is.
const END_PATTERN = /\[{1,16}\s{0,16}end\s{0,16}\]{1,16}/gi; // [[END]] and near misses such as [END] or [[ end ]]
const END_CLOSED = /\[{1,16}\s{0,16}end\s{0,16}\]{1,16}(?=[^\]])/gi; // ... only once no further ']' can follow
const END_PARTIAL = /\[{1,16}\s{0,16}(?:e(?:n(?:d\s{0,16}\]{0,16})?)?)?\s{0,16}$/i; // a token still arriving at the end of the stream

export class EndMarker {
  constructor() { this.buffer = ''; this.seen = false; }
  feed(delta) {
    this.buffer += delta;
    const cleaned = this.buffer.replace(END_CLOSED, '');
    if (cleaned !== this.buffer) { this.seen = true; this.buffer = cleaned; }
    const partial = END_PARTIAL.exec(this.buffer), cut = partial ? partial.index : this.buffer.length;
    const out = this.buffer.slice(0, cut); this.buffer = this.buffer.slice(cut); return out;
  }
  flush() {
    const cleaned = this.buffer.replace(END_PATTERN, '');
    if (cleaned !== this.buffer) { this.seen = true; this.buffer = cleaned; }
    const out = this.buffer; this.buffer = ''; return out;
  }
}

// history: [{role: 'user'|'assistant', content}] in speaking order. The transcript is a JSON array of {speaker, text} turns, so a line break or an "ATLAS:" typed inside an
// answer can never read as another speaker (red L4). Keeps the head and the tail of long interviews (REPORT_TRANSCRIPT_CHARS of text).
export function reportMessages(history, sections, stage) {
  let turns = history.filter(m => m?.content).map(m => ({ speaker: m.role === 'user' ? 'consultant' : 'atlas', text: String(m.content) }));
  if (turns.reduce((n, t) => n + t.text.length, 0) > REPORT_TRANSCRIPT_CHARS) {
    const headBudget = Math.floor(REPORT_TRANSCRIPT_CHARS / 3), head = [], tail = []; let used = 0, start = turns.length, cut = 0; // the turn that crosses the budget is cut to fit and its end may still open the tail
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i], room = headBudget - used;
      if (t.text.length > room) { head.push({ ...t, text: t.text.slice(0, Math.max(room, 0)) }); start = i; cut = Math.max(room, 0); break; }
      head.push(t); used += t.text.length;
    }
    used = 0;
    for (let i = turns.length - 1; i >= start; i--) { // the earliest of them is cut from its start to fit, never into what the head already holds
      const t = turns[i], room = REPORT_TRANSCRIPT_CHARS - headBudget - used;
      if (room <= 0) break;
      const floor = i === start ? cut : 0;
      if (t.text.length - floor > room) { tail.push({ ...t, text: t.text.slice(t.text.length - room) }); used += room; }
      else if (i === start && floor) { tail.push({ ...t, text: t.text.slice(floor) }); used += t.text.length - floor; }
      else { tail.push(t); used += t.text.length; }
    }
    turns = [...head, { speaker: 'server', text: '[... middle of the interview omitted ...]' }, ...tail.reverse()];
  }
  const notes = Object.fromEntries(REPORT_TOPICS.map((t, i) => [t, sections[i] ?? '']));
  return [{ role: 'system', content: REPORT_POLICY },
    { role: 'user', content: JSON.stringify({ project_stage: stage, interview_transcript: turns, quote_linked_notes: notes }) }];
}

const clean = (v, n) => typeof v === 'string' ? Array.from(v.split(/\s+/).filter(Boolean).join(' ')).slice(0, n).join('') : '';

// Stated reference details only: bounded strings, lists and a plausible team size (parity with parse_facts).
export function parseFacts(raw) {
  raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const facts = Object.fromEntries(Object.entries(FACT_TEXT).map(([k, n]) => [k, clean(raw[k], n)]));
  const size = raw.team_size;
  facts.team_size = Number.isInteger(size) && size > 0 && size <= 10000 ? size : null;
  for (const [k, [n, limit]] of Object.entries(FACT_LISTS)) facts[k] = [...new Set((Array.isArray(raw[k]) ? raw[k] : []).slice(0, 50).map(x => clean(x, limit)).filter(Boolean))].slice(0, n);
  return facts;
}

export function parseReport(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw;
  try { raw = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const topics = raw.topics && typeof raw.topics === 'object' && !Array.isArray(raw.topics) ? raw.topics : {};
  const report = { headline: clean(raw.headline, REPORT_LIMITS.headline), summary: clean(raw.summary, REPORT_LIMITS.summary),
    topics: Object.fromEntries(REPORT_TOPICS.map(t => [t, clean(topics[t], REPORT_LIMITS.topic)])) };
  for (const [key, n] of Object.entries(REPORT_LISTS)) {
    const items = Array.isArray(raw[key]) ? raw[key] : [];
    report[key] = items.slice(0, n).map(x => clean(x, REPORT_LIMITS.item)).filter(Boolean);
  }
  if (!report.headline || !report.summary) return null;
  report.facts = parseFacts(raw.facts);
  report.status = 'model_draft';
  return report;
}
