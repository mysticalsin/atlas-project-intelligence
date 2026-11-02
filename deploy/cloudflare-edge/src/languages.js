// Conversation languages (v2.2 L1: ATLAS speaks whatever language the consultant speaks). Understanding: Deepgram Nova-3 on Workers AI with language
// "multi" (automatic detection and code-switching) covers LANG_STT_AUTO; any other language can be locked in the UI and is then requested alone. Typed
// text is read by lang-detect.js. Speaking: Aura-2 English and Spanish on Workers AI; every other language needs the optional ElevenLabs Flash v2.5 voice
// (32 languages, raw 24 kHz PCM like Aura), else the reply is shown as text. The tables come from atlas_voice/languages.py (policy.generated.js).
import { LANG_NAMES, LANG_NATIVE, LANG_RTL, LANG_BANKS, LANG_REVIEW, LANG_STT_AUTO, LANG_ELEVENLABS, LANG_NATIVE_VOICES, LANG_NOTICES, LANG_READBACK } from './policy.generated.js';

export const LANGUAGES = LANG_NAMES; // the languages known by name; any other valid BCP-47 tag is named by Intl.DisplayNames
export const NATIVE_VOICES = LANG_NATIVE_VOICES;
export const BANK_LANGUAGES = LANG_BANKS; // fixed lines (greeting, acknowledgements, pause and resume, summary prompts) exist for these only
export const STT_AUTO = LANG_STT_AUTO;
export const ELEVENLABS_LANGUAGES = LANG_ELEVENLABS;
export { LANG_REVIEW as REVIEW_STATUS };
const ALIASES = { nb: 'no', nn: 'no', iw: 'he', in: 'id', tl: 'fil' };
let names = null;
try { names = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }); } catch { names = null; }

// A language tag (BCP-47, a Deepgram code, the browser's language) -> its base code, or null when it is not a language we can name.
export function normalize(tag) {
  let code = String(tag || '').toLowerCase().split(/[-_]/)[0];
  code = ALIASES[code] || code;
  if (Object.hasOwn(LANG_NAMES, code)) return code;
  if (!/^[a-z]{2,3}$/.test(code) || code === 'multi' || code === 'und') return null;
  try { return names && names.of(code) ? code : null; } catch { return null; }
}
export function languageName(code) { return LANG_NAMES[code] || (names && names.of(code)) || 'English'; }
export function nativeName(code) { return LANG_NATIVE[code] || languageName(code); }
export const isRtl = code => LANG_RTL.includes(code);
// What the page needs for its language selector: every language known by name, and whether ATLAS has a voice for it (speaks: the Worker's own test).
export const languageList = speaks => ({ auto: true, voice: Object.keys(LANG_NAMES).filter(c => speaks(c)), list: Object.keys(LANG_NAMES).map(code => ({ code, name: LANG_NAMES[code], native: LANG_NATIVE[code] || LANG_NAMES[code], rtl: LANG_RTL.includes(code), bank: LANG_BANKS.includes(code) })) });
export const hasBank = code => LANG_BANKS.includes(code);

// Nova-3 result -> dominant language of this utterance, or null when unknown.
export function detectedLanguage(result) {
  const ch = result?.results?.channels?.[0], alt = ch?.alternatives?.[0];
  const listed = normalize(alt?.languages?.[0] || ch?.languages?.[0] || ch?.detected_language);
  if (listed) return listed;
  const counts = {};
  for (const w of alt?.words || []) { const c = normalize(w?.language); if (c) counts[c] = (counts[c] || 0) + 1; }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

// What the consultant is told, in their language when we have a line for it and in English otherwise (these are screen notices, never spoken).
export const notice = (key, lang) => LANG_NOTICES[key]?.[lang] || LANG_NOTICES[key]?.en || '';
export const readback = (key, lang) => LANG_READBACK[key]?.[lang] || LANG_READBACK[key]?.en || '';

// The talker's language note (server-side, every turn). `voiced`: ATLAS can say this language aloud right now; when it cannot, the reply is written on screen
// in the same language (never switched to English), and `announce` tells the talker to say so once (a language without a notice bank; the others get the
// bank's notice from the server). The server switches only on consistent evidence (session.js), so one misheard utterance must not move the talker either.
export function languageNote(lang, voiced = true, { announce = false } = {}) {
  const name = languageName(lang);
  let note = `LANGUAGE (server): the consultant is speaking ${name}. Reply only in natural ${name} (not a translation). Keep to ${name} even if some of their words look like another language: this note changes when they really switch.`;
  if (lang !== 'en') note += ` The server notes, the proposed wording of a NEXT MOVE and your rules are English guidance: say their content in your own ${name} words, keeping every rule. Keep proper nouns and product names as they are, and never translate or paraphrase a quote of the consultant.`;
  if (!voiced) {
    note += ` Your voice cannot speak ${name} yet, so your reply is shown on screen as text only.`;
    if (announce) note += ` In this reply say once, in one short sentence in ${name}, that you cannot speak ${name} aloud yet, that your words are on screen, and that they are welcome to keep speaking or typing.`;
  }
  return note;
}

// Spoken instantly (cached audio) when the call connects: who ATLAS is, why she is there, what is captured and how it may
// be used, that client-confidential details can be named as such and are noted without the details, and that a summary is read back for correction
// before anything goes to review. Tony chose this full introduction on 2026-10-30 (Agent Brain v2.1, Q1); on 2026-10-31 he removed the invitation to skip or to say
// "I don't know" (ATLAS is there to understand the work) and kept one narrow confidentiality sentence. It is four short
// sentences, two spoken breaths. English was authored; every other language is a faithful translation that still needs a
// machine translation, used as is (D-L2, docs/agent-brain-v2.1/DECISION_LOG.md).
const INTRO = {
  en: "Hi, I'm ATLAS, and I'll help you tell the story of your project.",
  fr: "Bonjour, je suis ATLAS, et je vais vous aider à raconter l'histoire de votre projet.",
  es: 'Hola, soy ATLAS, y voy a ayudarte a contar la historia de tu proyecto.',
  pt: 'Olá, eu sou a ATLAS, e vou ajudar você a contar a história do seu projeto.',
  de: 'Hallo, ich bin ATLAS und helfe Ihnen, die Geschichte Ihres Projekts zu erzählen.',
  it: 'Ciao, sono ATLAS e ti aiuterò a raccontare la storia del tuo progetto.',
  nl: 'Hallo, ik ben ATLAS en ik help je het verhaal van je project te vertellen.',
};
const INTRO_AGAIN = {
  en: "Hi, it's ATLAS again, and I'll help you tell the story of your project.",
  fr: "Bonjour, c'est encore ATLAS, et je vais vous aider à raconter l'histoire de votre projet.",
  es: 'Hola, soy ATLAS otra vez, y voy a ayudarte a contar la historia de tu proyecto.',
  pt: 'Olá, é a ATLAS de novo, e vou ajudar você a contar a história do seu projeto.',
  de: 'Hallo, hier ist wieder ATLAS, und ich helfe Ihnen, die Geschichte Ihres Projekts zu erzählen.',
  it: 'Ciao, sono di nuovo ATLAS e ti aiuterò a raccontare la storia del tuo progetto.',
  nl: 'Hallo, hier is ATLAS weer, en ik help je het verhaal van je project te vertellen.',
};
const INTRO_REST = {
  en: `I'll capture what you say, you review it first, and nothing is reused without your permission. If something is client-confidential, say so and I'll note it without the details. At the end, I'll read back a summary for you to correct before anything goes to review.`,
  fr: "Je note ce que vous dites, vous le relisez d'abord, et rien n'est réutilisé sans votre accord. Si quelque chose est confidentiel pour le client, dites-le-moi et je le noterai sans les détails. À la fin, je vous lirai un résumé à corriger avant tout envoi en relecture.",
  es: 'Tomo nota de lo que dices, tú lo revisas primero, y nada se reutiliza sin tu permiso. Si algo es confidencial del cliente, dímelo y lo anotaré sin los detalles. Al final, te leeré un resumen para que lo corrijas antes de que nada pase a revisión.',
  pt: 'Vou registrar o que você disser, você revisa primeiro, e nada é reutilizado sem a sua permissão. Se algo for confidencial do cliente, diga e eu registro sem os detalhes. No final, vou ler um resumo para você corrigir antes de qualquer envio para revisão.',
  de: 'Ich halte fest, was Sie sagen, Sie prüfen es zuerst, und nichts wird ohne Ihre Erlaubnis wiederverwendet. Wenn etwas für den Kunden vertraulich ist, sagen Sie es, und ich notiere es ohne die Details. Am Ende lese ich Ihnen eine Zusammenfassung vor, die Sie korrigieren können, bevor etwas in die Prüfung geht.',
  it: 'Annoto quello che dici, tu lo rivedi per primo, e niente viene riutilizzato senza il tuo permesso. Se qualcosa è riservato per il cliente, dimmelo e lo annoterò senza i dettagli. Alla fine ti leggerò un riepilogo da correggere, prima che qualcosa vada in revisione.',
  nl: 'Ik noteer wat je zegt, jij bekijkt het eerst, en niets wordt hergebruikt zonder jouw toestemming. Als iets vertrouwelijk is voor de klant, zeg het dan, en ik noteer het zonder de details. Aan het einde lees ik een samenvatting voor die je kunt corrigeren, voordat er iets ter beoordeling gaat.',
};
export const GREETINGS = Object.fromEntries(Object.keys(INTRO).map(l => [l, INTRO[l] + ' ' + INTRO_REST[l]]));
export const WELCOME_BACK = Object.fromEntries(Object.keys(INTRO_AGAIN).map(l => [l, INTRO_AGAIN[l] + ' ' + INTRO_REST[l]]));
// The same introductions as two cached spoken pieces (Agent Brain v2.1 T6): who she is plus what is captured and how it is
// used (the first sentence of INTRO_REST), then the confidentiality and read-back promises. Joined with a space they are exactly
// GREETINGS / WELCOME_BACK. The session protects only the first piece from barge-in (about 11 s instead of 25 s).
const firstSentence = text => text.indexOf('. ') + 1; // every INTRO_REST opens with one sentence that has no inner full stop
const pieces = (intro, rest) => { const cut = firstSentence(rest); return [intro + ' ' + rest.slice(0, cut), rest.slice(cut + 1)]; };
export const GREETING_PIECES = Object.fromEntries(Object.keys(INTRO).map(l => [l, pieces(INTRO[l], INTRO_REST[l])]));
export const WELCOME_BACK_PIECES = Object.fromEntries(Object.keys(INTRO_AGAIN).map(l => [l, pieces(INTRO_AGAIN[l], INTRO_REST[l])]));
// Short uptake words ("Right.", "I see.") played from cache as ATLAS takes her turn, while the reply is prepared.
// Not continuers like "Mm-hm", which mean "keep going" and contradict her taking the floor.
export const FILLERS = {
  en: ['Okay.', 'Right.', 'I see.', 'Yeah.'], fr: ["D'accord.", 'Je vois.', 'Ah oui.', 'Oui.'], es: ['Vale.', 'Ya veo.', 'Claro.', 'Sí.'], pt: ['Certo.', 'Entendi.', 'Sim.', 'Ah, sim.'],
  de: ['Okay.', 'Ja.', 'Verstehe.', 'Ah ja.'], it: ['Certo.', 'Sì.', 'Capisco.', 'Ah, ok.'], nl: ['Oké.', 'Ja.', 'Duidelijk.', 'Ik snap het.'],
};

// Words a finished answer almost never ends on, per language (the one the speech recogniser heard). Precision beats
// recall: a missed trailing word only falls back to the turn model plus merge-on-resume, while a false "unfinished"
// answers a finished answer with a nudge. The lists are machine translations (D-L2). Hesitations ("um", "euh") only matter
// when the recogniser keeps them (Nova-3 drops filler words by default); conjunctions and articles are the main signal.
const TRAIL = Object.fromEntries(Object.entries({
  en: ['and but or because the an a um uh erm er hmm', ['and so', 'and then', 'such as']],
  fr: ['et mais car ou le la les des du de euh heu', ['parce que', "parce qu'", 'et puis', 'et alors']],
  es: ['y pero porque o el los las de con eh em', ['o sea', 'y entonces', 'y luego']],
  pt: ['e mas porque ou os as de do da com tipo hum ahn', ['e então', 'e aí', 'e depois']],
  de: ['und aber weil sondern dass äh ähm öh', ['und dann', 'und also', 'zum beispiel']],
  it: ['e ma quindi o il lo gli di con ehm cioè che', ['e poi', 'e quindi']],
  nl: ['en maar omdat want of de met eh ehm uhm', ['en dan', 'en toen']],
}).map(([lang, [words, phrases]]) => [lang, { words: new Set(words.split(' ')), phrases: phrases.map(x => x.split(' ')) }]));
const TITLES = new Set('dr mr mrs ms prof st mme mlle hr fr sr sra dott sig dhr mevr'.split(' '));
export function unfinished(text, lang = 'en') {
  let t = String(text || '').trim();
  if (!t || /[?？]\s*$/.test(t)) return false; // a question is never a thought left hanging
  if (/(\.\.\.|…|[,;:–—-])$/.test(t)) return true;
  t = t.replace(/[.!。]+$/, '');
  const tokens = t.match(/[\p{L}\p{N}']+/gu) || [];
  if (!tokens.length) return false;
  const last = tokens.at(-1);
  // "...the intake. And" starts a new sentence (not a name); a stop after an initial or a title ("Dr. A") does not.
  const stop = /([\p{L}']+)[.!?。]\s+[\p{L}']+$/u.exec(t);
  const newSentence = !!stop && stop[1].length > 1 && !TITLES.has(stop[1].toLowerCase());
  if (tokens.length > 1 && last !== last.toLowerCase() && !newSentence) return false; // a name or "plan A"
  const low = tokens.map(w => w.toLowerCase()), list = TRAIL[lang];
  if (!list) return false; // no word list for this language: only the punctuation above says an answer is unfinished (never another language's words)
  if (list.words.has(low.at(-1))) return true;
  return list.phrases.some(ph => ph.length <= low.length && ph.every((w, k) => low[low.length - ph.length + k] === w));
}
