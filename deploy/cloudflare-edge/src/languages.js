// Conversation languages. Understanding: Deepgram Nova-3 on Workers AI with language "multi" (automatic detection and
// code-switching) covers the ten languages below. Speaking: Aura-2 English and Spanish on Workers AI; every other
// language needs the optional ElevenLabs Flash v2.5 voice (32 languages, raw 24 kHz PCM like Aura).
export const LANGUAGES = { en: 'English', fr: 'French', es: 'Spanish', pt: 'Portuguese', de: 'German', it: 'Italian', nl: 'Dutch', ru: 'Russian', hi: 'Hindi', ja: 'Japanese' };
export const NATIVE_VOICES = ['en', 'es'];

export function normalize(tag) {
  const code = String(tag || '').toLowerCase().split(/[-_]/)[0];
  return Object.hasOwn(LANGUAGES, code) ? code : null;
}

// Nova-3 result -> dominant language of this utterance, or null when unknown/unsupported.
export function detectedLanguage(result) {
  const ch = result?.results?.channels?.[0], alt = ch?.alternatives?.[0];
  const listed = normalize(alt?.languages?.[0] || ch?.languages?.[0] || ch?.detected_language);
  if (listed) return listed;
  const counts = {};
  for (const w of alt?.words || []) { const c = normalize(w?.language); if (c) counts[c] = (counts[c] || 0) + 1; }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

// Which language ATLAS can actually be heard in for a detected language.
export function spokenFor(lang, speaks) { return speaks(lang) ? lang : 'en'; }

// The talker's language note (server-side, every turn). The server switches only on consistent evidence (session.js), so
// one misheard utterance must not move the talker either: her voice would read another language's words.
export function languageNote(lang, spoken) {
  const name = LANGUAGES[lang] || 'English', said = LANGUAGES[spoken] || 'English';
  return lang === spoken
    ? `LANGUAGE (server): the consultant is speaking ${name}. Reply only in natural ${name} (not a translation). Keep to ${name} even if some of their words look like another language: this note changes when they really switch.`
    : `LANGUAGE (server): the consultant is speaking ${name}, but your voice can only speak ${said} right now. Reply in ${said}. The first time this happens, say in one short sentence that you understand ${name} and they are welcome to keep speaking it.`;
}

// Spoken instantly (cached audio) when the call connects: who ATLAS is, why she is there, what is captured and how it may
// be used, that anything can be skipped ("I don't know", "I can't share"), and that a summary is read back for correction
// before anything goes to review. Tony chose this full introduction on 2026-10-30 (Agent Brain v2.1, Q1). It is four short
// sentences, two spoken breaths. English was authored; every other language is a faithful translation that still needs a
// native-speaker review (see docs/agent-brain-v2.1/IMPLEMENTATION_STATUS.md).
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
  en: `I'll capture what you say, you review it first, and nothing is reused without your permission. You can skip anything, or say "I don't know" or "I can't share". At the end, I'll read back a summary for you to correct before anything goes to review.`,
  fr: "Je note ce que vous dites, vous le relisez d'abord, et rien n'est réutilisé sans votre accord. Vous pouvez passer n'importe quelle question, ou dire « je ne sais pas » ou « je ne peux pas le partager ». À la fin, je vous lirai un résumé à corriger avant tout envoi en relecture.",
  es: 'Tomo nota de lo que dices, tú lo revisas primero, y nada se reutiliza sin tu permiso. Puedes saltarte cualquier pregunta, o decir «no lo sé» o «no puedo compartirlo». Al final, te leeré un resumen para que lo corrijas antes de que nada pase a revisión.',
  pt: 'Vou registrar o que você disser, você revisa primeiro, e nada é reutilizado sem a sua permissão. Você pode pular qualquer pergunta, ou dizer «não sei» ou «não posso compartilhar». No final, vou ler um resumo para você corrigir antes de qualquer envio para revisão.',
  de: 'Ich halte fest, was Sie sagen, Sie prüfen es zuerst, und nichts wird ohne Ihre Erlaubnis wiederverwendet. Sie können jede Frage überspringen oder „Ich weiß es nicht“ oder „Das kann ich nicht teilen“ sagen. Am Ende lese ich Ihnen eine Zusammenfassung vor, die Sie korrigieren können, bevor etwas in die Prüfung geht.',
  it: 'Annoto quello che dici, tu lo rivedi per primo, e niente viene riutilizzato senza il tuo permesso. Puoi saltare qualsiasi domanda, oppure dire «non lo so» o «non posso condividerlo». Alla fine ti leggerò un riepilogo da correggere, prima che qualcosa vada in revisione.',
  nl: 'Ik noteer wat je zegt, jij bekijkt het eerst, en niets wordt hergebruikt zonder jouw toestemming. Je mag elke vraag overslaan, of zeggen: «ik weet het niet» of «dat kan ik niet delen». Aan het einde lees ik een samenvatting voor die je kunt corrigeren, voordat er iets ter beoordeling gaat.',
};
export const GREETINGS = Object.fromEntries(Object.keys(INTRO).map(l => [l, INTRO[l] + ' ' + INTRO_REST[l]]));
export const WELCOME_BACK = Object.fromEntries(Object.keys(INTRO_AGAIN).map(l => [l, INTRO_AGAIN[l] + ' ' + INTRO_REST[l]]));
// The same introductions as two cached spoken pieces (Agent Brain v2.1 T6): who she is plus what is captured and how it is
// used (the first sentence of INTRO_REST), then the skip and read-back promises. Joined with a space they are exactly
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
// answers a finished answer with a nudge. The lists need a native-speaker review. Hesitations ("um", "euh") only matter
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
  const low = tokens.map(w => w.toLowerCase()), list = TRAIL[lang] || TRAIL.en;
  if (list.words.has(low.at(-1))) return true;
  return list.phrases.some(ph => ph.length <= low.length && ph.every((w, k) => low[low.length - ph.length + k] === w));
}
