// Machine translation into any language (D-L2, Tony 2026-11-02: no native-speaker dependency). A fake Workers AI binding stands in for the models:
// no network, synthetic text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { translateText, glossaryTerms, protect, restore, DEFAULT_GLOSSARY, FALLBACK_MODEL, TRANSLATE_MAX_CHARS } from '../src/translate.js';

const fakeAI = (answer, calls = []) => ({ run: async (model, input) => { calls.push({ model, input }); const a = typeof answer === 'function' ? answer(model, input) : answer; if (a instanceof Error) throw a; return a; } });
const chat = text => ({ response: text });
const EN = 'We cut the claims backlog by 40 percent in 6 months with the ATLAS pipeline.';

test('any target language: the chat model translates, the source language is detected, and a clean result is high confidence', async () => {
  const calls = [];
  const out = await translateText({ AI: fakeAI(chat('Nous avons réduit le retard des dossiers de 40 pour cent en 6 mois avec le pipeline [[G0]].'), calls), TALKER_MODEL: 'talker' }, EN, { target: 'fr' });
  assert.equal(out.translated, true); assert.equal(out.source, 'en'); assert.equal(out.target, 'fr'); assert.equal(out.engine, 'talker');
  assert.match(out.text, /ATLAS/); assert.equal(out.confidence, 'high'); assert.deepEqual(out.flags, []);
  assert.equal(calls.length, 1); assert.match(calls[0].input.messages[0].content, /into French/); assert.match(calls[0].input.messages[1].content, /\[\[G0\]\]/, 'glossary terms are protected before the model sees them');
  for (const target of ['ja', 'pt-BR', 'sw', 'ar', 'pl']) {
    const r = await translateText({ AI: fakeAI(chat('x [[G0]] 40 6 translated text of similar length here')), TALKER_MODEL: 't' }, EN, { target });
    assert.equal(r.translated, true, target); assert.equal(r.target, target.slice(0, 2));
  }
  const seen = [];
  await translateText({ AI: fakeAI(chat('Construímos o serviço [[G0]] em 6 meses, reduzindo 40 por cento.'), seen), TALKER_MODEL: 't' }, EN, { target: 'pt-PT' });
  assert.match(seen[0].input.messages[0].content, /pt-PT, use that regional variety/, 'a regional variety reaches the prompt (NATIVE_REVIEW A3)');
});

test('confidence is a flag, never a gate: lost glossary terms, changed numbers and the wrong output language lower it but still return text', async () => {
  const env = t => ({ AI: fakeAI(chat(t)), TALKER_MODEL: 't' });
  const lost = await translateText(env('Nous avons réduit le retard de 40 pour cent en 6 mois avec le pipeline.'), EN, { target: 'fr' });
  assert.equal(lost.translated, true); assert.equal(lost.confidence, 'low'); assert.ok(lost.flags.includes('GLOSSARY_TERM_LOST'));
  const nums = await translateText(env('Nous avons réduit le retard de 45 pour cent en 6 mois avec le pipeline [[G0]].'), EN, { target: 'fr' });
  assert.equal(nums.confidence, 'low'); assert.ok(nums.flags.includes('NUMBERS_CHANGED'));
  const wrong = await translateText(env('We reduced the claims backlog by 40 percent in 6 months with the [[G0]] pipeline, and the team was happy with it.'), EN, { target: 'fr' });
  assert.ok(wrong.flags.includes('OUTPUT_LANGUAGE_MISMATCH')); assert.equal(wrong.confidence, 'low');
});

test('fallback engine, model failures, AI off and no binding never throw: the original text comes back untranslated with a reason', async () => {
  const calls = [];
  const fb = await translateText({ AI: fakeAI((m) => m === 't' ? new Error('down') : { translated_text: 'Abbiamo ridotto del 40 percento in 6 mesi con [[G0]] il lavoro arretrato delle pratiche.' }, calls), TALKER_MODEL: 't' }, EN, { target: 'it' });
  assert.equal(fb.engine, FALLBACK_MODEL); assert.ok(fb.flags.includes('FALLBACK_ENGINE')); assert.equal(fb.confidence, 'medium'); assert.equal(calls[1].input.target_lang, 'it');
  const dead = await translateText({ AI: fakeAI(new Error('down')), TALKER_MODEL: 't' }, EN, { target: 'it' });
  assert.deepEqual([dead.translated, dead.text, dead.confidence], [false, EN, 'none']); assert.ok(dead.flags.includes('ENGINE_FAILED'));
  const off = await translateText({ AI: fakeAI(chat('never')), ATLAS_AI_OFF: 'true' }, EN, { target: 'it' });
  assert.ok(off.flags.includes('AI_OFF')); assert.equal(off.translated, false);
  const none = await translateText({}, EN, { target: 'it' });
  assert.ok(none.flags.includes('NO_AI'));
  const bad = await translateText({ AI: fakeAI(chat('x')) }, EN, { target: 'not a language!' });
  assert.ok(bad.flags.includes('TARGET_INVALID'));
  const same = await translateText({ AI: fakeAI(chat('x')) }, EN, { target: 'en' });
  assert.deepEqual([same.translated, same.text, same.confidence], [false, EN, 'high']); assert.ok(same.flags.includes('ALREADY_TARGET'));
  const long = await translateText({}, 'a'.repeat(TRANSLATE_MAX_CHARS + 50), { target: 'fr' });
  assert.equal(long.text.length, TRANSLATE_MAX_CHARS);
});

test('glossary: defaults, env terms with a rendering, bounded; protect/restore round-trips and keeps the original casing', () => {
  const g = glossaryTerms({ TRANSLATE_GLOSSARY: 'Synthetic Corp\nclaims backlog=retard des dossiers, ' + 'x'.repeat(61) });
  for (const t of DEFAULT_GLOSSARY) assert.ok(g.some(e => e.term === (t.term || t)), JSON.stringify(t));
  assert.ok(g.some(e => e.term === 'Synthetic Corp')); assert.ok(g.some(e => e.term === 'claims backlog' && e.rendering === 'retard des dossiers'));
  assert.ok(!g.some(e => e.term.length > 60));
  const p = protect('the atlas tool and the claims backlog', g);
  assert.doesNotMatch(p.text, /atlas|claims backlog/i);
  const r = restore(p.text, p.used);
  assert.equal(r.text, 'the atlas tool and the retard des dossiers'); assert.equal(r.lost, 0);
});
