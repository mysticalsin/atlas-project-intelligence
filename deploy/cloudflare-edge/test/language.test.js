import test from 'node:test';
import assert from 'node:assert/strict';
import { workersAI } from '../src/app.js';
import { Session } from '../src/session.js';
import { SAMPLE_RATE } from '../src/speech.js';
import { unfinished, languageNote } from '../src/languages.js';
import { clearPcmCache } from '../src/session.js';
test.afterEach(() => clearPcmCache());

test('ElevenLabs voice: verified endpoint, key header, raw 24 kHz PCM, Flash v2.5, language code', async () => {
  const real = globalThis.fetch; let call = null;
  globalThis.fetch = async (url, init) => { call = { url: String(url), init }; return new Response(new Uint8Array(9)); };
  try {
    const pcm = await workersAI({ ELEVENLABS_API_KEY: 'el-key', ELEVENLABS_VOICE_ID: 'voice1' }).synthesize('Bonjour.', 'atlas', 'fr');
    assert.equal(call.url, 'https://api.elevenlabs.io/v1/text-to-speech/voice1/stream?output_format=pcm_24000'); // v2.2 V1: the streaming endpoint
    assert.equal(call.init.headers['xi-api-key'], 'el-key');
    assert.deepEqual(JSON.parse(call.init.body), { text: 'Bonjour.', model_id: 'eleven_flash_v2_5', language_code: 'fr' });
    assert.equal(pcm.length, 8, 'odd byte trimmed: whole 16-bit samples only');
  } finally { globalThis.fetch = real; }
});

test('turn model helper: base64 16 kHz WAV of the last 8 s; an answer without a boolean verdict is no verdict (not "unfinished")', async () => {
  // The binding rejected the streamed {body, contentType} form for smart-turn-v2 (live logs: AiError on every turn); the
  // base64 WAV string is the documented form, and the live model answers it with a verdict.
  let input = null, reply = { is_complete: true, probability: 0.93 };
  const ai = workersAI({ AI: { async run(model, body) { input = [model, body]; return reply; } } });
  assert.deepEqual(await ai.turnComplete(new Uint8Array(10 * 48000)), { complete: true, probability: 0.93 });
  assert.equal(typeof input[1].audio, 'string', 'audio is a base64 string');
  assert.deepEqual(Object.keys(input[1]), ['audio']);
  const wav = Uint8Array.from(atob(input[1].audio), c => c.charCodeAt(0)), v = new DataView(wav.buffer);
  assert.deepEqual([input[0], String.fromCharCode(...wav.subarray(0, 4)), v.getUint32(24, true), v.getUint32(40, true)], ['@cf/pipecat-ai/smart-turn-v2', 'RIFF', 16000, 8 * 32000]);
  for (reply of [{}, { result: { is_complete: true } }, null, { is_complete: 'yes', probability: 1 }]) assert.equal(await ai.turnComplete(new Uint8Array(4800)), null, JSON.stringify(reply));
});

function frames(segments) {
  const out = [];
  for (const [sec, amp] of segments) { const n = Math.floor(SAMPLE_RATE * sec), pcm = new Uint8Array(n * 2), dv = new DataView(pcm.buffer);
    for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.trunc(amp * 32767 * Math.sin(2 * Math.PI * 180 * i / SAMPLE_RATE)), true);
    for (let i = 0; i < pcm.length; i += 960) out.push(pcm.slice(i, i + 960)); }
  return out;
}
async function interview({ browser = 'fr-FR', heard = [], speaks = l => ['en', 'es', 'fr', 'pt'].includes(l) } = {}) {
  const talker = [], tts = [], events = [], metrics = []; let n = 0, t = 1000;
  const s = new Session({ io: { send: e => events.push(e), sendBytes: () => {}, close: () => {} }, csrf: 'tok', voice: 'atlas', now: () => t, sleep: () => new Promise(r => setImmediate(r)), metric: (k, v) => metrics.push([k, v]),
    ai: { speaks, async *chatStream(m) { talker.push(m); yield `Reply ${talker.length}, parlons du projet. `; }, async synthesize(text, voice, lang) { tts.push(lang); return new Uint8Array(960); },
      async transcribe() { return heard[n++] || { text: '', language: null }; }, async analyst() { return []; } } });
  await s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: { id: 'p', title: 'Claims', stage: 'Pilot', answers: [] }, voice: 'atlas', capture: true, memory: false, language: browser }));
  const settle = async () => { for (let i = 0; i < 300; i++) await new Promise(r => setImmediate(r)); };
  await settle();
  const speak = async () => { for (const f of frames([[0.6, .001], [1.2, .2], [1.3, .001]])) { t += 0.02; s.onBinary(f); } await settle(); };
  return { s, talker, tts, events, metrics, speak, done: () => s.end(false) };
}
const note = msgs => msgs.find(m => m.role === 'system' && m.content.startsWith('LANGUAGE'))?.content || '';

test('the browser language opens the conversation (French greeting in a French voice)', async () => {
  const h = await interview({ browser: 'fr-FR' });
  assert.match(note(h.talker[0]), /speaking French\. Reply only in natural French/); assert.equal(h.tts[0], 'fr');
  await h.done();
  const unknown = await interview({ browser: 'zz-ZZ' }); assert.match(note(unknown.talker[0]), /speaking English/); await unknown.done();
});

test('ATLAS follows a switch mid-interview once two utterances agree; short or echoed utterances never switch; no voice means a reply in the language, on screen, with one notice', async () => {
  const h = await interview({ browser: 'en-GB', speaks: l => ['en', 'es'].includes(l), heard: [
    { text: 'Sim', language: 'pt' },                                                   // too short: no switch
    { text: 'Nós reduzimos o tempo de triagem de quarenta para doze minutos', language: 'pt' }, // clear Portuguese: a candidate
    { text: 'E a equipe de suporte ficou muito mais tranquila', language: 'pt' },       // and again: switch
    { text: 'Reducimos el tiempo de clasificación a doce minutos', language: 'es' },    // then Spanish, twice
    { text: 'Y el equipo quedó muy contento con el resultado', language: 'es' }] });
  await h.speak(); assert.ok(!h.events.some(e => e.type === 'language'));
  await h.speak(); assert.ok(!h.events.some(e => e.type === 'language'), 'one utterance is not enough');
  const spoken = h.tts.length;
  await h.speak();
  const pt = h.events.find(e => e.type === 'language');
  assert.deepEqual([pt.language, pt.voice], ['pt', false]); assert.match(pt.notice, /não consegue falar português em voz alta/);
  assert.match(note(h.talker.at(-1)), /speaking Portuguese\. Reply only in natural Portuguese.*cannot speak Portuguese yet, so your reply is shown on screen as text only/); assert.doesNotMatch(note(h.talker.at(-1)), /Reply in English/);
  assert.ok(!h.tts.slice(spoken).includes('pt') && !h.tts.slice(spoken).includes('en'), 'no voice for it: nothing is synthesised, and never in English instead');
  assert.ok(h.events.some(e => e.type === 'agent_text' && /Reply 3/.test(e.text)), 'the reply is shown on screen');
  await h.speak(); await h.speak();
  assert.equal(h.events.filter(e => e.type === 'language').at(-1).language, 'es');
  assert.deepEqual(h.metrics.filter(([k]) => k.startsWith('language_')), [['language_candidate', { language: 'pt' }], ['language_switch', { language: 'pt', voice: 0 }],
    ['language_candidate', { language: 'es' }], ['language_switch', { language: 'es', voice: 1 }]]);
  assert.match(note(h.talker.at(-1)), /speaking Spanish\. Reply only in natural Spanish/); assert.equal(h.tts.at(-1), 'es');
  await h.done();
});

test('a single misdetected utterance changes nothing: the language, the voice and the note stay until two agree', async () => {
  const h = await interview({ browser: 'en-GB', heard: [
    { text: 'We moved the claims platform to the cloud last year', language: 'hi' }, // misheard as Hindi: a candidate only
    { text: 'The team cut triage time by a third', language: 'en' },                  // English again: the candidate is dropped
    { text: 'Then we trained the regional support teams', language: 'fr' },           // misheard as French
    { text: 'Nous avons formé les équipes régionales de support', language: 'fr' }] });  // French again: now a real switch
  for (let i = 0; i < 3; i++) await h.speak();
  assert.ok(!h.events.some(e => e.type === 'language'), 'no switch');
  assert.equal(h.s.language, 'en'); assert.ok(h.tts.every(l => l === 'en'), 'the voice never changed');
  assert.ok(h.talker.every(m => /speaking English\. Reply only in natural English/.test(note(m))), 'the note never changed');
  assert.deepEqual(h.metrics.filter(([k]) => k.startsWith('language_')), [['language_candidate', { language: 'hi' }], ['language_candidate', { language: 'fr' }]]);
  await h.speak();
  assert.equal(h.s.language, 'fr'); assert.match(note(h.talker.at(-1)), /speaking French\. Reply only in natural French/); assert.equal(h.tts.at(-1), 'fr');
  await h.done();
});

test('the language note keeps the talker in the session language until the server confirms a switch', () => {
  assert.match(languageNote('en', 'en'), /Reply only in natural English \(not a translation\)\. Keep to English even if some of their words look like another language/);
  assert.doesNotMatch(languageNote('fr', 'fr'), /switch whenever they switch/);
});

test('unfinished: words that trail off, per language; finished answers and questions are not', () => {
  const yes = [['We moved the platform and', 'en'], ['We moved the.', 'en'], ['So we, um.', 'en'], ['It took six months,', 'en'], ['and then', 'en'],
    ['On a migré la plateforme parce que', 'fr'], ["C'était surtout parce qu'", 'fr'], ['Nous avons migré la plateforme, euh', 'fr'],
    ['Migramos la plataforma porque', 'es'], ['o sea', 'es'], ['Migramos a plataforma e', 'pt'], ['e então', 'pt'],
    ['Wir haben die Plattform migriert, weil', 'de'], ['Und äh', 'de'], ['Abbiamo migrato la piattaforma e', 'it'], ['cioè', 'it'],
    ['We hebben het platform gemigreerd omdat', 'nl'], ['We rebuilt the intake. And', 'en'], ['On a refait la plateforme. Et', 'fr'],
    ['Rehicimos la plataforma. Y', 'es'], ['Wir haben das gemacht. Und', 'de']];
  const no = [['I think so.', 'en'], ['We had to.', 'en'], ['We went with plan A.', 'en'], ['It was a lot of work, like.', 'en'], ['That was it, so.', 'en'],
    ['the team I worked with.', 'en'], ['OPP-12345.', 'en'], ["C'est tout.", 'fr'], ['Il y en a.', 'fr'], ['Il y en a un.', 'fr'], ['Sí, seis meses.', 'es'],
    ['Desde entonces.', 'es'], ['Sim, é.', 'pt'], ['Foi só um.', 'pt'], ['Ich weiß das.', 'de'], ['Das ist gut, oder?', 'de'], ['Es war so.', 'de'],
    ['Genau das.', 'de'], ['Bis dann.', 'de'], ['Non so perché.', 'it'], ['E poi?', 'it'], ['Ik weet het.', 'nl'], ['Queremos más proyectos como este.', 'es'], ['It went well. Thanks', 'en'], ['Our sponsor was Dr. A', 'en'], ['', 'en']];
  for (const [t, l] of yes) assert.equal(unfinished(t, l), true, `${l}: ${t}`);
  for (const [t, l] of no) assert.equal(unfinished(t, l), false, `${l}: ${t}`);
  assert.equal(unfinished('We moved the', 'xx'), false, 'a language without a word list is judged by its punctuation only, never by English words');
  assert.equal(unfinished('Zrobiliśmy to, bo', 'pl'), false); assert.equal(unfinished('Zrobiliśmy to,', 'pl'), true); assert.equal(unfinished('これは…', 'ja'), true);
});

// The words of an invitation to skip, to pass or to say "I don't know", per bank language (the opening must hold none of them), and the confidentiality line (native review still due).
const NO_SKIP = { en: /skip|don.t know|can.t share/i, fr: /passer|sais pas|ne peux pas le partager/i, es: /saltar|no lo s[eé]|no puedo compartir/i, pt: /pular|n[aã]o sei|n[aã]o posso compartilhar/i,
  de: /überspringen|weiß (?:es )?nicht|nicht teilen/i, it: /saltare|non lo so|non posso condividere/i, nl: /overslaan|weet (?:het )?niet|niet delen/i };
const CONFIDENTIAL = { en: /client-confidential.*without the details/, fr: /confidentiel pour le client.*sans les détails/, es: /confidencial del cliente.*sin los detalles/, pt: /confidencial do cliente.*sem os detalhes/,
  de: /vertraulich.*ohne die Details/, it: /riservato per il cliente.*senza i dettagli/, nl: /vertrouwelijk is voor de klant.*zonder de details/ };
const words = t => t.split(/\s+/).filter(Boolean).length, sentences = t => (t.match(/[.!?](["”»]?)(\s|$)/g) || []).length;
const OPENING_EN = `Hi, I'm ATLAS, and I'll help you tell the story of your project. I'll capture what you say, you review it first, and nothing is reused without your permission. If something is client-confidential, say so and I'll note it without the details. At the end, I'll read back a summary for you to correct before anything goes to review.`;
test('greetings are the full pack opening in every language (purpose, capture, use, one confidentiality line, read-back), voice-short', async () => {
  const { GREETINGS } = await import('../src/languages.js');
  assert.equal(GREETINGS.en, OPENING_EN);
  assert.ok(words(GREETINGS.en) <= 62, `English is about 60 words (${words(GREETINGS.en)})`);
  for (const [lang, text] of Object.entries(GREETINGS)) {
    assert.ok(text.includes('ATLAS'), lang);
    assert.equal(sentences(text), 4, `${lang}: four short sentences, two spoken breaths`);
    assert.ok(words(text) <= 75, `${lang}: voice-short (${words(text)} words)`);
    assert.ok(!/[?？]/.test(text), `${lang}: an introduction asks nothing`);
    assert.ok(!text.includes('\n'), lang);
    // Tony, 2026-10-31 (U2): no invitation to skip a question or to say "I don't know" in any language (ATLAS is there to understand the work); one narrow confidentiality line instead
    assert.ok(!NO_SKIP[lang].test(text), `${lang}: no invitation to skip or to say "I don't know": ${text}`);
    assert.match(text, CONFIDENTIAL[lang], `${lang}: one client-confidentiality line`);
  }
  assert.deepEqual(Object.keys(GREETINGS), ['en', 'fr', 'es', 'pt', 'de', 'it', 'nl'], 'every cached language has one');
});

test('the welcome-back greeting is the same opening, introduced as "again"', async () => {
  const { GREETINGS, WELCOME_BACK } = await import('../src/languages.js');
  assert.equal(WELCOME_BACK.en, OPENING_EN.replace("Hi, I'm ATLAS", "Hi, it's ATLAS again"));
  assert.deepEqual(Object.keys(WELCOME_BACK), Object.keys(GREETINGS));
  for (const [lang, text] of Object.entries(WELCOME_BACK)) {
    assert.ok(text.includes('ATLAS'), lang);
    assert.equal(sentences(text), 4, `${lang}: four short sentences`);
    assert.ok(words(text) <= 75, `${lang}: voice-short (${words(text)} words)`);
    assert.ok(text.endsWith(GREETINGS[lang].split(/(?<=[.!?])\s/).slice(1).join(' ')), `${lang}: the same disclosure as the first greeting`);
  }
});
