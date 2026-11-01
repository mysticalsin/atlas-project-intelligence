// v2.2 Q1 item 7 (evaluation scenario): the French answer "de 40 à 12 minutes", typed, through the real Session, a fake analyst that files the sentence under two fields (one marked
// uncertain by the model), and the story board's own model. Live QA showed "12 minutes" twice (one an "estimate") and no 40: the board must show ONE chip "40 à 12 minutes",
// no estimate flag (the words hold no hedge), and no "before/after values" left to recover.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { FIELDS, NUMERIC_SRC } from '../src/policy.generated.js';
import { rig, startMsg, send, until, cleanup } from './reconnect-harness.js';

test.afterEach(cleanup);
const Board = createRequire(import.meta.url)('../../../src/storyboard-core.js');
const board = quality => Board.model({ quality, heard: [], qualitySeq: 1, session: {}, now: 0, policy: { FIELDS, NUMERIC_SRC }, geo: null });

async function run(sentence, filed) {
  const h = rig({ talk: n => n === 0 ? ['Bonjour. ', 'Qu’est-ce qui a changé ?'] : ['Merci. ', 'Sur quelle période ?'] });
  h.s.ai.analyst = async messages => {
    const seg = JSON.parse(messages[1].content.split('\n').slice(1).join('\n')).new_segment;
    return [{ id: 'c1', name: 'record_details', arguments: JSON.stringify({ details: filed.map(([field, uncertain]) => ({ field, item_id: seg.item_id, quote: seg.text, ...(uncertain ? { uncertain: true } : {}) })) }) }];
  };
  await h.s.onText(startMsg({ mode: 'text', language: 'fr' }));
  await until(() => h.s.started && !h.s.busy());
  await send(h, { type: 'text', text: sentence });
  await until(() => h.events.some(e => e.type === 'quality') && !h.s.busy());
  return h.events.filter(e => e.type === 'quality').at(-1);
}

test('Q1-7: "de 40 à 12 minutes" is one figure chip, once, with no estimate flag and no before/after slot', async () => {
  const q = await run('Le temps de traitement est passé de 40 à 12 minutes.', [['outcome', false], ['measurement', true]]);
  assert.equal(q.candidate_details.length, 2, 'the sentence was filed under two fields');
  const m = board({ ...q, measurement_gaps: ['before/after', 'period'] });
  assert.deepEqual(m.metrics.map(x => [x.text, x.status]), [['40 à 12 minutes', 'reported']]);
  assert.deepEqual(m.measurementSlots, [{ need: 'period' }]);
});

test('Q1-7: a hedge in the consultant’s own words is the only thing that makes a chip an estimate', async () => {
  const q = await run('Il a fallu environ 12 minutes au lieu de 40.', [['outcome', false]]);
  assert.deepEqual(board(q).metrics.map(x => [x.text, x.status]), [['12 minutes', 'uncertain'], ]);
});
