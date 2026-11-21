// Inspector on the greeting slice at 6e50f111, report 7e6177b6. Aura speaks
// English. A Dutch or Japanese start must say so once, in that language, and
// unspaced Japanese must count as a switch. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/session.js';
import { SAMPLE_RATE } from '../src/speech.js';

const PROJECT = { id: 'p', title: 'Synthetic pilot', stage: 'Pilot', answers: [] };

function frames(segments) {
  const out = [];
  for (const [sec, amp] of segments) {
    const n = Math.floor(SAMPLE_RATE * sec), pcm = new Uint8Array(n * 2), dv = new DataView(pcm.buffer);
    for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.trunc(amp * 32767 * Math.sin(2 * Math.PI * 180 * i / SAMPLE_RATE)), true);
    for (let i = 0; i < pcm.length; i += 960) out.push(pcm.slice(i, i + 960));
  }
  return out;
}

const settle = async () => { for (let i = 0; i < 300; i++) await new Promise(r => setImmediate(r)); };

function auraSession(events, spoken, heard) {
  let n = 0, t = 1000;
  const s = new Session({
    io: { send: e => events.push(e), sendBytes() {}, close() {} },
    csrf: 'tok', voice: 'harmonia', now: () => t, sleep: () => new Promise(r => setImmediate(r)), metric() {},
    ai: {
      speaks: l => l === 'en',
      async *chatStream() { yield 'Reply. '; },
      async synthesize(text, _voice, lang) { spoken.push([text, lang]); return new Uint8Array(960); },
      async transcribe() { return heard[n++] || { text: '', language: null }; },
      async analyst() { return []; },
    },
  });
  return { s, clock: () => { t += 0.02; } };
}

async function startIn(lang) {
  const events = [], spoken = [];
  const { s } = auraSession(events, spoken, []);
  await s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, voice: 'harmonia', capture: false, memory: false, language: lang }));
  await settle();
  return { s, events, spoken };
}

test('an nl or ja start with Aura speaks English and emits one notice', async () => {
  const { voiceNotice } = await import('../src/languages.js');
  for (const lang of ['nl', 'ja']) {
    const { s, events, spoken } = await startIn(lang);
    try {
      const notes = events.filter(e => e.type === 'language');
      assert.equal(notes.length, 1, lang);
      assert.equal(notes[0].language, lang);
      assert.equal(notes[0].voice, false);
      assert.equal(notes[0].notice, voiceNotice(lang));
      assert.equal(notes[0].notice, lang === 'nl' ? 'ATLAS begrijpt je. De stem blijft Engels.' : 'ATLASは理解しています。音声は英語のままです。');
      assert.ok(spoken.some(([text, said]) => text.startsWith("Hi, I'm ATLAS") && said === 'en'), lang);
    } finally {
      await s.end(false);
    }
  }
});

test('unspaced Japanese switches the language on a character count', async () => {
  const { voiceNotice } = await import('../src/languages.js');
  const events = [], spoken = [];
  const heard = [
    { text: 'これはテストです', language: 'ja' },
    { text: '音声は英語のままです', language: 'ja' },
  ];
  const { s, clock } = auraSession(events, spoken, heard);
  await s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: PROJECT, voice: 'harmonia', capture: true, memory: false, language: 'en' }));
  await settle();
  try {
    for (let turn = 0; turn < 2; turn++) {
      for (const f of frames([[0.6, .001], [1.2, .2], [1.3, .001]])) { clock(); s.onBinary(f); }
      await settle();
    }
    const notes = events.filter(e => e.type === 'language');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].language, 'ja');
    assert.equal(notes[0].voice, false);
    assert.equal(notes[0].notice, voiceNotice('ja'));
    assert.equal(notes[0].notice, 'ATLASは理解しています。音声は英語のままです。');
  } finally {
    await s.end(false);
  }
});
