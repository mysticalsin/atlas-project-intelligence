import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Session } from '../src/session.js';
import { SAMPLE_RATE } from '../src/speech.js';

const INTRO = "Hi, I'm ATLAS, and I'll help you tell the story of your project. I'll capture what you say, you review it first, and nothing is reused without your permission. If something is client-confidential, say so and I'll note it without the details. At the end, I'll read back a summary for you to correct before anything goes to review.";
const AGAIN = "Hi, it's ATLAS again, and I'll help you tell the story of your project. " + INTRO.slice(INTRO.indexOf("I'll capture"));

test('one greeting set uses the introduction and the rest, not a second short line', async () => {
  const { GREETINGS, WELCOME_BACK, FILLERS } = await import('../src/languages.js');
  assert.equal(GREETINGS.en, INTRO);
  assert.equal(WELCOME_BACK.en, AGAIN);
  for (const lang of ['fr', 'es', 'pt', 'de', 'it', 'nl']) {
    assert.ok(GREETINGS[lang].includes('ATLAS'), lang);
    assert.ok(GREETINGS[lang].length > 80, lang);
  }
  assert.deepEqual(FILLERS.en, ['Okay.', 'Right.', 'I see.', 'Yeah.']);
  assert.equal(GREETINGS.ru, undefined);
});

test('an unsupported voice stays English and the screen shows one notice', async () => {
  const { spokenFor, voiceNotice } = await import('../src/languages.js');
  assert.equal(spokenFor('pt', () => false), 'en');
  assert.equal(voiceNotice('pt'), 'A ATLAS compreende. A voz fica em inglês.');
  assert.equal(voiceNotice('nl'), 'ATLAS begrijpt je. De stem blijft Engels.');
  assert.equal(voiceNotice('ja'), 'ATLASは理解しています。音声は英語のままです。');
  assert.doesNotMatch(voiceNotice('pt') + voiceNotice('ja'), /amazing/i);
  const client = readFileSync(new URL('../../../src/voice-client.js', import.meta.url), 'utf8');
  assert.match(client, /m\.notice/);
  assert.doesNotMatch(client, /its voice answers in English for now/);
  assert.doesNotMatch(client, /english\+' '\+notice/);
});

function frames(segments) {
  const out = [];
  for (const [sec, amp] of segments) {
    const n = Math.floor(SAMPLE_RATE * sec), pcm = new Uint8Array(n * 2), dv = new DataView(pcm.buffer);
    for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.trunc(amp * 32767 * Math.sin(2 * Math.PI * 180 * i / SAMPLE_RATE)), true);
    for (let i = 0; i < pcm.length; i += 960) out.push(pcm.slice(i, i + 960));
  }
  return out;
}

test('Portuguese with no Portuguese voice is spoken in English and noticed in Portuguese', async () => {
  const events = []; let n = 0, t = 1000;
  const heard = [
    { text: 'Nós reduzimos o tempo de triagem de quarenta para doze minutos', language: 'pt' },
    { text: 'E a equipe de suporte ficou muito mais tranquila', language: 'pt' },
  ];
  const s = new Session({ io: { send: e => events.push(e), sendBytes: () => {}, close: () => {} }, csrf: 'tok', voice: 'atlas', now: () => t, sleep: () => new Promise(r => setImmediate(r)), metric: () => {},
    ai: { speaks: l => l === 'en', async *chatStream() { yield 'Reply. '; }, async synthesize() { return new Uint8Array(960); },
      async transcribe() { return heard[n++] || { text: '', language: null }; }, async analyst() { return []; } } });
  await s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: { id: 'p', title: 'Synthetic pilot', stage: 'Pilot', answers: [] }, voice: 'atlas', capture: true, memory: false, language: 'en' }));
  const settle = async () => { for (let i = 0; i < 300; i++) await new Promise(r => setImmediate(r)); };
  await settle();
  for (let turn = 0; turn < 2; turn++) {
    for (const f of frames([[0.6, .001], [1.2, .2], [1.3, .001]])) { t += 0.02; s.onBinary(f); }
    await settle();
  }
  try {
    const pt = events.find(e => e.type === 'language');
    assert.equal(events.filter(e => e.type === 'language').length, 1);
    assert.equal(pt.voice, false);
    assert.equal(pt.notice, 'A ATLAS compreende. A voz fica em inglês.');
  } finally {
    await s.end(false);
  }
});
