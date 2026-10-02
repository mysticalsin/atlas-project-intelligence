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

// Spoken instantly (cached audio) when the call connects: who ATLAS is and why she is there.
export const GREETINGS = {
  en: "Hi, I'm ATLAS, and I'll interview you about your project.",
  fr: "Bonjour, je suis ATLAS, et je vais vous interviewer sur votre projet.",
  es: 'Hola, soy ATLAS, y voy a entrevistarte sobre tu proyecto.',
  pt: 'Olá, eu sou a ATLAS, e vou entrevistar você sobre o seu projeto.',
  de: 'Hallo, ich bin ATLAS und interviewe Sie zu Ihrem Projekt.',
  it: 'Ciao, sono ATLAS e ti intervisterò sul tuo progetto.',
  nl: 'Hallo, ik ben ATLAS en ik ga je interviewen over je project.',
};
export const WELCOME_BACK = {
  en: "Hi, it's ATLAS again, and I'll interview you about your project.",
  fr: "Bonjour, c'est encore ATLAS, et je vais vous interviewer sur votre projet.",
  es: 'Hola, soy ATLAS otra vez, y voy a entrevistarte sobre tu proyecto.',
  pt: 'Olá, é a ATLAS de novo, e vou entrevistar você sobre o seu projeto.',
  de: 'Hallo, hier ist wieder ATLAS, und ich interviewe Sie zu Ihrem Projekt.',
  it: 'Ciao, sono di nuovo ATLAS e ti intervisterò sul tuo progetto.',
  nl: 'Hallo, hier is ATLAS weer, en ik ga je interviewen over je project.',
};
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
