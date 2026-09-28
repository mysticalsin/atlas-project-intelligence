import test from 'node:test';
import assert from 'node:assert/strict';
import { workersAI } from '../src/app.js';
import { Session } from '../src/session.js';
import { SAMPLE_RATE } from '../src/speech.js';
import { unfinished } from '../src/languages.js';
import { clearPcmCache } from '../src/session.js';
test.afterEach(() => clearPcmCache());

test('ElevenLabs voice: verified endpoint, key header, raw 24 kHz PCM, Flash v2.5, language code', async () => {
  const real = globalThis.fetch; let call = null;
  globalThis.fetch = async (url, init) => { call = { url: String(url), init }; return new Response(new Uint8Array(9)); };
  try {
    const pcm = await workersAI({ ELEVENLABS_API_KEY: 'el-key', ELEVENLABS_VOICE_ID: 'voice1' }).synthesize('Bonjour.', 'atlas', 'fr');
    assert.equal(call.url, 'https://api.elevenlabs.io/v1/text-to-speech/voice1?output_format=pcm_24000');
    assert.equal(call.init.headers['xi-api-key'], 'el-key');
    assert.deepEqual(JSON.parse(call.init.body), { text: 'Bonjour.', model_id: 'eleven_flash_v2_5', language_code: 'fr' });
    assert.equal(pcm.length, 8, 'odd byte trimmed: whole 16-bit samples only');
  } finally { globalThis.fetch = real; }
});

function frames(segments) {
  const out = [];
  for (const [sec, amp] of segments) { const n = Math.floor(SAMPLE_RATE * sec), pcm = new Uint8Array(n * 2), dv = new DataView(pcm.buffer);
    for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.trunc(amp * 32767 * Math.sin(2 * Math.PI * 180 * i / SAMPLE_RATE)), true);
    for (let i = 0; i < pcm.length; i += 960) out.push(pcm.slice(i, i + 960)); }
  return out;
}
async function interview({ browser = 'fr-FR', heard = [], speaks = l => ['en', 'es', 'fr', 'pt'].includes(l) } = {}) {
  const talker = [], tts = [], events = []; let n = 0, t = 1000;
  const s = new Session({ io: { send: e => events.push(e), sendBytes: () => {}, close: () => {} }, csrf: 'tok', voice: 'atlas', now: () => t, sleep: () => new Promise(r => setImmediate(r)),
    ai: { speaks, async *chatStream(m) { talker.push(m); yield `Reply ${talker.length}, parlons du projet. `; }, async synthesize(text, voice, lang) { tts.push(lang); return new Uint8Array(960); },
      async transcribe() { return heard[n++] || { text: '', language: null }; }, async analyst() { return []; } } });
  await s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: { id: 'p', title: 'Claims', stage: 'Pilot', answers: [] }, voice: 'atlas', capture: true, memory: false, language: browser }));
  const settle = async () => { for (let i = 0; i < 300; i++) await new Promise(r => setImmediate(r)); };
  await settle();
  const speak = async () => { for (const f of frames([[0.6, .001], [1.2, .2], [1.3, .001]])) { t += 0.02; s.onBinary(f); } await settle(); };
  return { s, talker, tts, events, speak, done: () => s.end(false) };
}
const note = msgs => msgs.find(m => m.role === 'system' && m.content.startsWith('LANGUAGE'))?.content || '';

test('the browser language opens the conversation (French greeting in a French voice)', async () => {
  const h = await interview({ browser: 'fr-FR' });
  assert.match(note(h.talker[0]), /speaking French\. Reply only in natural French/); assert.equal(h.tts[0], 'fr');
  await h.done();
  const unknown = await interview({ browser: 'zz-ZZ' }); assert.match(note(unknown.talker[0]), /speaking English/); await unknown.done();
});

test('ATLAS follows a switch mid-interview; short or echoed utterances never switch; no voice means an honest English reply', async () => {
  const h = await interview({ browser: 'en-GB', speaks: l => ['en', 'es'].includes(l), heard: [
    { text: 'Sim', language: 'pt' },                                                   // too short: no switch
    { text: 'Nós reduzimos o tempo de triagem de quarenta para doze minutos', language: 'pt' }, // clear Portuguese
    { text: 'Reducimos el tiempo de clasificación a doce minutos', language: 'es' }] });  // then Spanish
  await h.speak(); assert.ok(!h.events.some(e => e.type === 'language'));
  await h.speak();
  const pt = h.events.find(e => e.type === 'language');
  assert.deepEqual([pt.language, pt.voice], ['pt', false]);
  assert.match(note(h.talker.at(-1)), /speaking Portuguese, but your voice can only speak English right now/); assert.equal(h.tts.at(-1), 'en');
  await h.speak();
  assert.equal(h.events.filter(e => e.type === 'language').at(-1).language, 'es');
  assert.match(note(h.talker.at(-1)), /speaking Spanish\. Reply only in natural Spanish/); assert.equal(h.tts.at(-1), 'es');
  await h.done();
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
  assert.equal(unfinished('We moved the', 'xx'), true, 'an unknown language falls back to English');
});
