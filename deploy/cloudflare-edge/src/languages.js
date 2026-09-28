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

// The talker's language note (server-side, every turn).
export function languageNote(lang, spoken) {
  const name = LANGUAGES[lang] || 'English', said = LANGUAGES[spoken] || 'English';
  return lang === spoken
    ? `LANGUAGE (server): the consultant is speaking ${name}. Reply only in natural ${name} (not a translation), and switch whenever they switch.`
    : `LANGUAGE (server): the consultant is speaking ${name}, but your voice can only speak ${said} right now. Reply in ${said}. The first time this happens, say in one short sentence that you understand ${name} and they are welcome to keep speaking it.`;
}
