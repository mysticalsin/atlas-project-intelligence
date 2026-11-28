// Snippets and sentence alignment (WOW_SPEC §F1.6). Snippets (F1 footnotes) and claims (F3) come from ONE split of
// the RAW text, so they can never disagree; scrubbed text is never re-split. Each raw sentence is masked on its own.
import { clientScrub } from './review.js';
import { recordText, piiText } from './scrub.js';

// RAW text only: split on sentence ends and newlines, trim, keep sentences of 12+ characters (measured on the raw
// text), at most 40 per text. Index = position after filtering. The claim key cuts each of those to 400 characters.
function sentences(text) {
  return String(text ?? '').split(/[\r\n]+/).flatMap(line => line.split(/(?<=[.!?])\s+/))
    .map(s => s.trim()).filter(s => s.length >= 12).slice(0, 40);
}

export function splitSentences(text) {
  return sentences(text).map(s => s.slice(0, 400));
}

const WORD = /[\p{L}\p{N}]/u;

// The customer-facing cut follows scrubbing. If 400 lands inside a token, step back to the
// previous boundary. An unbroken token still keeps 400.
function cutMasked(text) {
  if (text.length <= 400) return text;
  if (!WORD.test(text[399]) || !WORD.test(text[400])) return text.slice(0, 400);
  let end = 400;
  while (end > 0 && WORD.test(text[end - 1])) end--;
  if (end === 0) return text.slice(0, 400);
  return text.slice(0, end).replace(/\s+$/u, '');
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
  // Scrub the whole sentence, then cut. Masking the raw claim-key cut leaves a client name
  // sliced mid-token (Zebracorp becomes Zebracor) because the scrubber is word-bounded.
  const own = clientScrub(data), others = recordText(lib), scrubbed = full => others(own(piiText(full))), out = [];
  const mask = full => scrubbed(full).slice(0, 400), textOf = full => cutMasked(scrubbed(full));
  const answers = Array.isArray(data?.answers) ? data.answers : [];
  for (let t = 0; t < TOPIC_KEYS.length; t++)
    sentences(answers[t]).slice(0, 12).forEach((full, n) => out.push({ id: `A${t + 1}.${n + 1}`, kind: 'consultant_words', topic: t, idx: n, raw: full.slice(0, 400), text: textOf(full) }));
  (Array.isArray(data?.sources) ? data.sources : []).forEach((s, j) => {
    const rawSource = { name: String(s?.name || ''), version: String(s?.version || '') }, source = { name: mask(rawSource.name), version: mask(rawSource.version) };
    sentences(s?.excerpt).slice(0, 6).forEach((full, n) => out.push({ id: `S${j + 1}.${n + 1}`, kind: 'evidence', idx: n, source, rawSource, raw: full.slice(0, 400), text: textOf(full) }));
  });
  return out.slice(0, 80);
}
