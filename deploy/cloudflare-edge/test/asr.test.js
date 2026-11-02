// Python <-> JavaScript parity for the uncertain-span detector (atlas_voice/asr.py), plus the Deepgram word parser (JS only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { uncertainSpans, replacement, tauFrom, sttWords } from '../src/asr.js';
import { workersAI } from '../src/app.js';
const V = JSON.parse(readFileSync(new URL('./asr.vectors.json', import.meta.url)));
const w = (text, c = 0.95) => text.split(' ').map((t, i) => { const [word, conf] = t.split(':'); return { w: word, c: conf ? Number(conf) : c, s: Math.round(i * 400) / 1000, e: Math.round(i * 400 + 350) / 1000 }; });

test('asr: at least 40 span vectors', () => assert.ok(V.spans.length >= 40));
test('asr: uncertain_spans parity with Python on every vector', () => {
  for (const [args, expected] of V.spans) assert.deepEqual(uncertainSpans(...args), expected, JSON.stringify(args).slice(0, 160));
});
test('asr: replacement parity with Python', () => { for (const [args, expected] of V.replacement) assert.equal(replacement(...args), expected, JSON.stringify(args).slice(0, 80)); });
test('asr: threshold parity with Python', () => { for (const [arg, expected] of V.tau) assert.equal(tauFrom(arg), expected, JSON.stringify(arg)); });
test('asr: "twenty five" at 0.4 is one number span, minutes is not part of it', () => {
  assert.deepEqual(uncertainSpans(w('it took twenty:0.4 five:0.4 minutes')), [{ text: 'twenty five', kind: 'number', min_conf: 0.4, start: 0.8, end: 1.55 }]);
});
test('asr: high confidence or no confidence gives no span', () => {
  assert.deepEqual(uncertainSpans(w('it took twenty five minutes')), []);
  assert.deepEqual(uncertainSpans([{ w: 'five' }, { w: 'Contoso' }]), []);
  assert.deepEqual(uncertainSpans(undefined), []);
});
test('asr: proper nouns need a capital that does not start a sentence', () => {
  assert.deepEqual(uncertainSpans(w('Contoso:0.2 hired us')), []);
  assert.deepEqual(uncertainSpans(w('We hired Contoso:0.2')).map(s => s.text), ['Contoso']);
  assert.deepEqual(uncertainSpans(w('It was big. Then Contoso:0.2 signed')).map(s => s.text), ['Contoso']);
});
test('asr: a number is flagged before a proper noun, and the weakest first', () => {
  assert.deepEqual(uncertainSpans(w('ten:0.4 Contoso:0.2 five:0.3')).map(s => s.text), ['five', 'ten', 'Contoso']);
});
test('asr: threshold from env is honoured and a bad one falls back to 0.55', () => {
  const words = w('we saved 35:0.45 percent');
  assert.equal(uncertainSpans(words, 0.4).length, 0); assert.equal(uncertainSpans(words, 0.5).length, 1); assert.equal(uncertainSpans(words, 'junk').length, 1);
  assert.equal(tauFrom('0.3'), 0.3); assert.equal(tauFrom('9'), 0.55);
});
test('asr: output is bounded (400 words in, 6 spans out)', () => {
  const many = Array.from({ length: 900 }, (_, i) => ({ w: i % 2 ? 'x' : '7', c: 0.1, s: i, e: i + 1 }));
  assert.ok(uncertainSpans(many).length <= 6);
});
test('asr: sttWords keeps the punctuated word, confidence and times, bounded to 400', () => {
  const alt = { words: Array.from({ length: 500 }, (_, i) => ({ word: 'w' + i, punctuated_word: i === 0 ? 'Hello,' : undefined, start: i * 0.1234567, end: i * 0.1234567 + 0.05, confidence: 0.98765 })) };
  const out = sttWords({ results: { channels: [{ alternatives: [alt] }] } });
  assert.equal(out.length, 400); assert.deepEqual(out[0], { w: 'Hello,', c: 0.988, s: 0, e: 0.05 }); assert.equal(out[1].w, 'w1');
});
test('asr: sttWords tolerates absence and junk', () => {
  for (const r of [undefined, null, {}, { results: {} }, { results: { channels: [] } }, { results: { channels: [{ alternatives: [{}] }] } }, { results: { channels: [{ alternatives: [{ words: 'x' }] }] } }]) assert.deepEqual(sttWords(r), []);
  const out = sttWords({ results: { channels: [{ alternatives: [{ words: [null, 3, { word: '' }, { word: 'ok' }, { word: 'two', confidence: 7, start: 'a' }] }] }] } });
  assert.deepEqual(out, [{ w: 'ok', c: null, s: null, e: null }, { w: 'two', c: 1, s: null, e: null }]);
});
test('asr: workersAI.transcribe returns words from a Nova-3 result, and none when absent', async () => {
  const env = r => ({ STT_MODEL: 'stt', AI: { run: async () => r } });
  const pcm = new Uint8Array(4800);
  const full = await workersAI(env({ results: { channels: [{ alternatives: [{ transcript: 'twenty five minutes', words: [{ word: 'twenty', punctuated_word: 'Twenty', start: 0, end: 0.3, confidence: 0.4 }, { word: 'five', start: 0.3, end: 0.6, confidence: 0.4 }] }] }] } })).transcribe(pcm);
  assert.equal(full.text, 'twenty five minutes'); assert.deepEqual(full.words, [{ w: 'Twenty', c: 0.4, s: 0, e: 0.3 }, { w: 'five', c: 0.4, s: 0.3, e: 0.6 }]);
  const bare = await workersAI(env({ results: { channels: [{ alternatives: [{ transcript: 'hello' }] }] } })).transcribe(pcm);
  assert.deepEqual(bare, { text: 'hello', language: null });
});
