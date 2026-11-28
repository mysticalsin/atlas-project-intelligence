// End-of-interview report and the talker's end marker. Parity-tested port of atlas_voice/report.py.
// The report is a model-written draft grounded only in the consultant's transcript; the consultant reviews it before saving.
import { REPORT_POLICY, REPORT_TOPICS, REPORT_LIMITS, REPORT_LISTS, REPORT_TRANSCRIPT_CHARS, FACT_TEXT, FACT_LISTS } from './policy.generated.js';

const END_PATTERN = /\[+\s*end\s*\]+/gi; // [[END]] and near misses such as [END] or [[ end ]]
const END_CLOSED = /\[+\s*end\s*\]+(?=[^\]])/gi; // ... only once no further ']' can follow
const END_PARTIAL = /\[+\s*(?:e(?:n(?:d\s*\]*)?)?)?\s*$/i; // a token still arriving at the end of the stream

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

const SPEAKER_ROLES = ['Consultant: ', 'ATLAS: '];
const OMITTED = '\n[... middle of the interview omitted ...]\n';
// A cut inside a short line keeps that whole line. A much longer line keeps a labeled tail.
const TAIL_LINE = 400;
const speaker = line => SPEAKER_ROLES.find(role => line.startsWith(role)) || '';
const isSpace = ch => ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v';

// Head and tail of a long interview. Every kept line still names ATLAS or the consultant.
// A raw character cut can start the tail inside an ATLAS sentence. The report model
// would then read the interviewer's words as the consultant's.
function boundedTranscript(transcript) {
  if (transcript.length <= REPORT_TRANSCRIPT_CHARS) return transcript;
  const headN = Math.floor(REPORT_TRANSCRIPT_CHARS / 3), tailN = REPORT_TRANSCRIPT_CHARS - headN;
  let head = transcript.slice(0, headN);
  if (headN < transcript.length && transcript[headN - 1] !== '\n') {
    const lineStart = head.lastIndexOf('\n') + 1, partial = head.slice(lineStart), role = speaker(transcript.slice(lineStart));
    if (!(role && partial.length >= role.length && partial.startsWith(role))) {
      const cut = head.lastIndexOf('\n');
      if (cut >= 0) head = head.slice(0, cut);
    }
  }
  const tailStart = transcript.length - tailN, lineStart = transcript.lastIndexOf('\n', tailStart - 1) + 1;
  const role = speaker(transcript.slice(lineStart)), extra = tailStart - lineStart;
  let tail;
  if (extra <= 0 || transcript[tailStart] === '\n') tail = transcript.slice(tailStart);
  else if (role && extra <= TAIL_LINE) tail = transcript.slice(lineStart);
  else if (role) {
    let chunk = transcript.slice(tailStart);
    if (extra > role.length && !isSpace(transcript[tailStart - 1]) && !isSpace(transcript[tailStart])) {
      const space = chunk.indexOf(' '), newline = chunk.indexOf('\n');
      if (space >= 0 && space < 40 && (newline < 0 || space < newline)) chunk = chunk.slice(space + 1);
    }
    tail = role + chunk;
  } else tail = transcript.slice(tailStart);
  return head + OMITTED + tail;
}

// history: [{role: 'user'|'assistant', content}] in speaking order. Keeps the head and the tail of long interviews.
export function reportMessages(history, sections, stage) {
  const transcript = boundedTranscript(history.filter(m => m?.content).map(m => (m.role === 'user' ? 'Consultant: ' : 'ATLAS: ') + String(m.content)).join('\n'));
  const notes = Object.fromEntries(REPORT_TOPICS.map((t, i) => [t, sections[i] ?? '']));
  return [{ role: 'system', content: REPORT_POLICY },
    { role: 'user', content: JSON.stringify({ project_stage: stage, interview_transcript: transcript, quote_linked_notes: notes }) }];
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
