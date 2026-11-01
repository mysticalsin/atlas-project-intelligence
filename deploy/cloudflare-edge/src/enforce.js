// JavaScript port of atlas_voice/enforce.py (the source of truth; test/enforce.vectors.json holds the port to it): is the question ATLAS spoke the move's question?
// The Session (session.js) runs onMove on what the talker said and replaces an off-move question with the selector's own wording (English), the localized line (fr es pt de it nl),
// or one more guarded talker call that renders exactly the move's question (any other language). localSay: the move's wording in a bank language, or null.
import { ENFORCE_STOP, ENFORCE_ANGLES, ENFORCE_LOCAL_REANGLE, ENFORCE_LOCAL_HOLD, ENFORCE_STEM, ENFORCE_MIN_LEN, ENFORCE_OVERLAP } from './policy.generated.js';

const STOP = new Set(ENFORCE_STOP), LOCAL_LANGS = ['fr', 'es', 'pt', 'de', 'it', 'nl'];
const ANGLES = Object.fromEntries(Object.entries(ENFORCE_ANGLES).map(([k, v]) => [k, new RegExp(v, 'i')]));
const [OVERLAP_NUM, OVERLAP_DEN] = ENFORCE_OVERLAP;
const fold = text => (typeof text === 'string' ? text : '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = text => fold(text).replace(/['’]/g, ' ').match(/[a-z0-9]+/g) || [];

// The set of topic stems of a text: words of three letters or more that are not stop words, cut to five letters.
export const stems = text => new Set(words(text).filter(w => w.length >= ENFORCE_MIN_LEN && !STOP.has(w)).map(w => w.slice(0, ENFORCE_STEM)));

// The last sentence of a wording that holds a question mark (a held "that's all" has a lead sentence before its question), else the last sentence, else ''.
export function lastQuestion(text) {
  const t = (typeof text === 'string' ? text : '').split(/\s+/).filter(Boolean).join(' ');
  const parts = t.split(/(?<=[.!?؟？])\s+/).filter(p => p.trim()), asked = parts.filter(p => /[?？؟]/.test(p));
  return (asked.length ? asked.at(-1) : parts.length ? parts.at(-1) : '').trim();
}

// True when the spoken `question` is the move's question (`expected`, its wording in the language it is spoken in). A re-angle intent is judged by its concrete angle
// (English words), every other move by the overlap of content stems; nothing at all to compare with is never "on" the move.
export function onMove(question, expected, intent = '', lang = 'en') {
  const q = stems(question);
  if (!q.size) return false;
  if (lang === 'en' && Object.hasOwn(ANGLES, intent) && ANGLES[intent].test(words(question).join(' '))) return true;
  const s = stems(lastQuestion(expected));
  if (!s.size) return false;
  const need = Math.max(OVERLAP_NUM, Math.floor((Math.min(q.size, s.size) * OVERLAP_NUM + OVERLAP_DEN - 1) / OVERLAP_DEN));
  let shared = 0; for (const x of q) if (s.has(x)) shared += 1;
  return shared >= need;
}

// The move's wording in a bank language other than English, or null: a re-angle's own line, or the held "that's all" line of its essential field.
export function localSay(intent, field, why, lang) {
  if (!LOCAL_LANGS.includes(lang)) return null;
  if (Object.hasOwn(ENFORCE_LOCAL_REANGLE, intent)) return ENFORCE_LOCAL_REANGLE[intent][lang];
  if (typeof why === 'string' && why.startsWith('stop_missing:') && Object.hasOwn(ENFORCE_LOCAL_HOLD, field)) return ENFORCE_LOCAL_HOLD[field][lang];
  return null;
}
