// Agent Brain v2.1 T11: the read-back at the close of the interview (plan 3h, D19; pack: close = summarise, flag unknowns, ask "What have I
// misunderstood or missed?", offer correct / add / withhold, name the next reviewer and the permitted use). Pure: no clock, no network, no
// Session. Everything here is built from the ledger's own active details, in the consultant's own words; nothing is paraphrased, scored or
// judged, and no figure appears that the consultant did not say. The card the browser shows, the facts the talker may read back and the
// open points are all derived from the same ledger, so what is said and what is shown cannot disagree.
import { FIELDS } from './policy.generated.js';

export const MAX_ITEMS = 40;      // items on the card (the ledger holds at most 100 details)
export const QUOTE_CHARS = 160;   // an item's quote on the card, whole code points
export const MAX_FACTS = 4;       // facts ATLAS may read back at the close
export const REFLECT_FACTS = 2;   // facts for a mid-interview reflection
export const FACT_CHARS = 100;    // one fact, a label and a clipped quote: short enough to say aloud
export const MAX_UNKNOWNS = 12;
export const SUMMARY_QUESTION = 'What have I misunderstood or missed?';
const ORDER = Object.keys(FIELDS);
// Which fields make the best read-back when only a few facts fit: the story's spine first (what was wrong, what they owned, what changed, what came of it).
const FACT_PRIORITY = ['problem', 'contribution', 'intervention', 'outcome', 'measurement', 'decision', 'adoption', 'stakes', 'evidence', 'limitations', 'customer_fit', 'poor_fit'];
const NUMBER = /[0-9]+(?:[.,][0-9]+)*/g;
const squash = s => String(s ?? '').split(/\s+/).filter(Boolean).join(' ');
// The first n code points, an ellipsis when something is cut (the result is at most n code points).
export function clip(text, n) {
  const all = Array.from(squash(text));
  return all.length <= n ? all.join('') : all.slice(0, n - 1).join('').trimEnd() + '…';
}
const detailsOf = ledger => (Array.isArray(ledger) ? ledger : Array.isArray(ledger?.details) ? ledger.details : []);
const order = f => { const i = ORDER.indexOf(f); return i < 0 ? ORDER.length : i; };
const label = f => (Object.hasOwn(FIELDS, f) ? FIELDS[f][0] : f);
// What a read-back may contain: details that are active and not kept private (superseded and withheld ones are history only).
const shown = d => d && d.active !== false && d.withheld !== true && typeof d.quote === 'string' && Object.hasOwn(FIELDS, d.field);

// The card's items, in the story's order (the ledger's field order, then the order they were said).
export function buildSummary(ledger) {
  return detailsOf(ledger).filter(shown).map((d, i) => ({ d, i })).sort((a, b) => order(a.d.field) - order(b.d.field) || a.i - b.i).slice(0, MAX_ITEMS)
    .map(({ d }) => ({ detail_id: String(d.id), field: d.field, label: label(d.field), quote: clip(d.quote, QUOTE_CHARS),
      status: ['reported', 'uncertain', 'unknown'].includes(d.status) ? d.status : 'reported', asr_unconfirmed: d.asr_unconfirmed === true,
      provenance: typeof d.provenance === 'string' && d.provenance ? d.provenance : 'unverified_speech_recognition' }));
}

// Open points the read-back flags: words the recogniser was unsure of, answers that were "I don't know", questions the consultant skipped
// or that two probes did not settle. Names of fields only, never an assessment. A field they have since answered is not open.
// opts: {skipped: field ids (machine.skipped), deferred: field ids (ledger.deferred)}.
export function buildUnknowns(ledger, { skipped = [], deferred = [] } = {}) {
  const details = detailsOf(ledger).filter(shown), answered = new Set(details.filter(d => d.status !== 'unknown').map(d => d.field)), out = [], seen = new Set();
  const add = (kind, field, detail_id) => {
    const key = kind + '|' + (detail_id || field);
    if (seen.has(key) || !Object.hasOwn(FIELDS, field)) return;
    seen.add(key); out.push({ kind, field, label: label(field), ...(detail_id ? { detail_id: String(detail_id) } : {}) });
  };
  const by = list => [...list].sort((a, b) => order(a.field) - order(b.field));
  for (const d of by(details.filter(x => x.asr_unconfirmed === true))) add('unconfirmed_speech', d.field, d.id);
  for (const d of by(details.filter(x => x.status === 'unknown'))) add('unknown', d.field, d.id);
  for (const f of [...skipped].filter(f => typeof f === 'string').sort((a, b) => order(a) - order(b))) if (!answered.has(f)) add('skipped', f);
  for (const f of [...deferred].filter(f => typeof f === 'string').sort((a, b) => order(a) - order(b))) if (!answered.has(f)) add('deferred', f);
  return out.slice(0, MAX_UNKNOWNS);
}

// The facts ATLAS may read back (at most `max`, one per field, the story's spine first) and every figure those facts contain. Only details
// the consultant's words support without doubt: an answer of "I don't know" or a span the recogniser was unsure of is an open point, not a fact.
// The number strings are what the ReplyGuard allows in a summary reply; a figure that is in no fact is dropped from what ATLAS says.
export function summaryFacts(items, { max = MAX_FACTS } = {}) {
  const list = (Array.isArray(items) ? items : []).filter(x => x && typeof x.quote === 'string' && Object.hasOwn(FIELDS, x.field) && x.status !== 'unknown' && x.asr_unconfirmed !== true);
  const facts = [];
  for (const f of FACT_PRIORITY) {
    if (facts.length >= Math.max(0, max)) break;
    const x = list.find(y => y.field === f);
    if (x) facts.push(label(f) + ': ' + clip(x.quote, FACT_CHARS));
  }
  const numbers = [...new Set(facts.flatMap(f => f.match(NUMBER) || []))];
  return { facts, numbers };
}

// What the talker is told for a read-back: the facts, the open points by name, and the one question. `facts` and `unknowns` are already clean
// (the Session removes control characters and tags from the consultant's words). Never kept; rebuilt for each reply.
export function summaryNote(facts, unknowns = [], { reflect = false, question = '' } = {}) {
  const list = (Array.isArray(facts) ? facts : []).map((f, i) => `${i + 1}) ${f}`).join(' ');
  if (reflect) {
    return 'REFLECTION FACTS (server, from what they have said so far): ' + (list || 'none yet') + '. Say back in ONE short sentence only what is written here, in your own words, '
      + 'with no figure that is not written here, then ask the one check question from the NEXT MOVE note' + (question ? ' (' + JSON.stringify(question) + ')' : '') + '.';
  }
  const open = [...new Set((Array.isArray(unknowns) ? unknowns : []).map(u => u?.label).filter(Boolean))].slice(0, 3);
  return 'SUMMARY FACTS (server, the read-back of what they told you): ' + (list || 'none: nothing is firm enough to read back yet') + '. '
    + 'Read back ONLY these, in your own short words, adding nothing and using no figure that is not written here. '
    + (open.length ? 'OPEN POINTS (name at most two, briefly, as still open, never as a failure): ' + open.join('; ') + '. ' : '')
    + 'Then ask exactly one question and stop: ' + SUMMARY_QUESTION;
}

// Remove the consultant's withheld words from a text (a transcript, a conversation history entry) before it goes into a report or a notes
// event: each withheld quote becomes a marker. Quotes were matched with whitespace normalised, so they are matched that way here.
export function redact(text, quotes) {
  let out = String(text ?? '');
  for (const q of quotes || []) {
    const words = squash(q).split(' ').filter(Boolean);
    if (!words.length) continue;
    out = out.replace(new RegExp(words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g'), '[kept private]');
  }
  return out;
}
export const withheldQuotes = ledger => detailsOf(ledger).filter(d => d && d.active !== false && d.withheld === true && typeof d.quote === 'string').map(d => d.quote);
