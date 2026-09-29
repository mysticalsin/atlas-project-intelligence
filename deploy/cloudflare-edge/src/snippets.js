// Snippets and sentence alignment (WOW_SPEC §F1.6). Snippets (F1 footnotes) and claims (F3) come from ONE split of
// the RAW text, so they can never disagree; scrubbed text is never re-split. Each raw sentence is masked on its own.
import { clientScrub } from './review.js';
import { recordText, piiText } from './scrub.js';

// RAW text only: split on sentence ends and newlines, trim, keep sentences of 12+ characters (measured on the raw
// text), each cut to 400 characters, at most 40 per text. Index = position after filtering.
export function splitSentences(text) {
  return String(text ?? '').split(/[\r\n]+/).flatMap(line => line.split(/(?<=[.!?])\s+/))
    .map(s => s.trim()).filter(s => s.length >= 12).slice(0, 40).map(s => s.slice(0, 400));
}

export const TOPIC_KEYS = Object.freeze(['context', 'contribution', 'approach', 'outcome', 'evidence', 'customer_relevance']);

// The lookup key shared by F1 footnotes and F3 claims (topic = answers index).
export function claimKey(topic, text) { return `${topic}\n${text}`; }

// Snippets of one reference's raw data: answers[t] (<= 12 sentences each) as consultant words, sources[j].excerpt
// (<= 6 each) as evidence; <= 80 in all. `raw` is SERVER-SIDE ONLY and must be stripped before any response.
// An evidence source's name and version (often the uploaded file name, which carries the client) get the same
// masking as the text: `source` is what one-pager footnotes (customer-facing, every viewer) and non-full readers
// see. `rawSource`, like `raw`, is SERVER-SIDE ONLY: for a reader with full access to the record, never customer-facing.
// data.report is never a snippet (it is a model draft).
export function snippetsOf(lib, data) {
  // PII first, so the own-client scrub never rewrites a name inside an email or URL (scrub.piiText).
  const own = clientScrub(data), others = recordText(lib), mask = raw => others(own(piiText(raw))).slice(0, 400), out = [];
  const answers = Array.isArray(data?.answers) ? data.answers : [];
  for (let t = 0; t < TOPIC_KEYS.length; t++)
    splitSentences(answers[t]).slice(0, 12).forEach((raw, n) => out.push({ id: `A${t + 1}.${n + 1}`, kind: 'consultant_words', topic: t, idx: n, raw, text: mask(raw) }));
  (Array.isArray(data?.sources) ? data.sources : []).forEach((s, j) => {
    const rawSource = { name: String(s?.name || ''), version: String(s?.version || '') }, source = { name: mask(rawSource.name), version: mask(rawSource.version) };
    splitSentences(s?.excerpt).slice(0, 6).forEach((raw, n) => out.push({ id: `S${j + 1}.${n + 1}`, kind: 'evidence', idx: n, source, rawSource, raw, text: mask(raw) }));
  });
  return out.slice(0, 80);
}
