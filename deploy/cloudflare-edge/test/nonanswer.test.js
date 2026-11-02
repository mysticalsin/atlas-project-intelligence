// nonanswer.js: parity with atlas_voice/nonanswer.py, and what counts as "not an answer" (v2.2 Q1 item 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { kind, isNonAnswer } from '../src/nonanswer.js';

const V = JSON.parse(readFileSync(new URL('./nonanswer.vectors.json', import.meta.url)));

test('parity with Python: every vector gives the same kind', () => { for (const [t, k] of V) assert.equal(kind(t), k, JSON.stringify(t)); });

test('a deferral, refusal or skip in any of the seven languages is a refusal; a bare acknowledgement is a filler; an answer is neither', () => {
  for (const t of ["I don't know", 'No idea.', 'skip', 'Pass', 'Next question', "I can't share", 'Je ne sais pas', 'No sé', 'Não sei', 'Ich weiß nicht', 'Non so', 'Ik weet het niet', 'Honestly, I really don\'t know, sorry']) assert.equal(kind(t), 'refusal', t);
  for (const t of ['ok', 'Hmm', '?', 'Yes', '']) assert.equal(kind(t), 'filler', JSON.stringify(t));
  for (const t of ['I don\'t know the exact figure but it was around forty minutes', 'We had to skip the second phase', 'I can\'t share the client name, it is under NDA']) assert.equal(kind(t), '', t);
  assert.equal(isNonAnswer("I don't know"), true); assert.equal(isNonAnswer('We rebuilt the intake process for the client'), false);
});
