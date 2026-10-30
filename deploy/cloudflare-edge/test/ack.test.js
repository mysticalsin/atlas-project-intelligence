// Content-aware acknowledgements (src/ack.js): rules of plan 3d, checked against the real turn pre-pass and the persona banks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickAck, ackPrewarmList, ACK_MIN_WORDS } from '../src/ack.js';
import { analyzeTurn } from '../src/turns.js';
import { ACKS, BANNED_PRAISE_SRC } from '../src/policy.generated.js';
import { FILLERS } from '../src/languages.js';

const BANNED = new RegExp(BANNED_PRAISE_SRC, 'i');
const PILOT = 'The pilot failed after three months and we had to shut it down, but we learned a lot about the data quality problems.';
const METRIC = 'After we rolled out the new pipeline the nightly batch ran about 80% faster for the whole team last year.';
const PLAIN = 'We moved the reporting jobs to the new scheduler because the old one could not keep up with the volume.';
const turn = text => { const t = analyzeTurn(text); return { cues: t.cues, words: t.words }; };
const all = Object.values(ACKS).flatMap(l => Object.values(l).flat());

test('a failed pilot gets setback_neutral: never "Yeah.", never earned or upbeat, whatever was asked', () => {
  const t = turn(PILOT); assert.ok(t.cues.includes('describes_setback'));
  for (const category of Object.keys(ACKS)) for (let seed = 0; seed < 12; seed++) {
    const a = pickAck({ ...t, category, seed, repliesSinceEarned: 99 });
    assert.ok(a, category);
    assert.notEqual(a.text, 'Yeah.');
    assert.ok(['setback_neutral', 'correction_thanks', 'confidential_ok', 'no_number_fine'].includes(a.category), category + ' -> ' + a.category);
    assert.ok(!ACKS.earned_result.en.includes(a.text) && !ACKS.promising_unverified.en.includes(a.text), a.text);
  }
  for (const category of ['earned_result', 'promising_unverified', 'neutral', 'thanks_detail']) assert.equal(pickAck({ ...t, category, seed: 1 }).category, 'setback_neutral');
});

test('a setback in another language never gets a bare yes word', () => {
  const t = turn(PILOT);
  for (const lang of ['fr', 'es', 'pt', 'de', 'it', 'nl']) for (let seed = 0; seed < 12; seed++) {
    const a = pickAck({ ...t, lang, category: 'earned_result', seed });
    assert.ok(FILLERS[lang].includes(a.text) && !/^(oui|sí|sim|ja|sì)\.$/i.test(a.text), lang + ' ' + a.text);
  }
});

test('an unverified figure (80% faster) gets promising_unverified, never earned_result', () => {
  const t = turn(METRIC); assert.ok(t.cues.includes('metric'));
  for (let seed = 0; seed < 8; seed++) {
    const a = pickAck({ ...t, category: 'earned_result', repliesSinceEarned: 99, seed });
    assert.equal(a.category, 'promising_unverified');
    assert.ok(ACKS.promising_unverified.en.includes(a.text));
  }
});

test('either figure cue alone (metric, estimate) is enough for promising_unverified', () => {
  for (const cues of [['metric'], ['estimate']]) assert.equal(pickAck({ category: 'earned_result', cues, words: 20, repliesSinceEarned: 99, seed: 1 }).category, 'promising_unverified');
  assert.equal(pickAck({ category: 'earned_result', cues: ['describes_achievement'], words: 20, repliesSinceEarned: 99, seed: 1 }).category, 'earned_result');
});

test('a correction gets correction_thanks', () => {
  const a = pickAck({ category: 'correction_thanks', cues: [], words: 12, seed: 3 });
  assert.equal(a.category, 'correction_thanks'); assert.ok(ACKS.correction_thanks.en.includes(a.text));
});

test('each category returns a line from its own English bank', () => {
  for (const category of Object.keys(ACKS)) {
    if (category === 'setback_neutral') continue;
    const a = pickAck({ category, cues: [], words: 20, repliesSinceEarned: 5, seed: 7 });
    assert.equal(a.category, category); assert.ok(ACKS[category].en.includes(a.text));
  }
});

test('no line repeats within the last 4, over 20 picks (single category and mixed)', () => {
  for (const mix of [['neutral'], ['earned_result'], ['thanks_detail', 'neutral', 'confidential_ok', 'promising_unverified']]) {
    const recent = [];
    for (let i = 0; i < 20; i++) {
      const a = pickAck({ category: mix[i % mix.length], cues: [], words: 15, recent, seed: i, repliesSinceEarned: 9 });
      assert.ok(!recent.slice(-4).includes(a.text), `pick ${i}: ${a.text}`);
      recent.push(a.text);
    }
  }
});

test('off in admin mode, after a question to ATLAS, and when time is up', () => {
  const base = { category: 'thanks_detail', cues: [], words: 20, seed: 1 };
  assert.ok(pickAck(base));
  assert.equal(pickAck({ ...base, admin: true }), null);
  assert.equal(pickAck({ ...base, afterQuestion: true }), null);
  assert.equal(pickAck({ ...base, timeUp: true }), null);
  assert.equal(pickAck({ ...base, admin: true, lang: 'fr' }), null);
});

test('fewer than 8 words gets no acknowledgement; exactly 8 does', () => {
  assert.equal(ACK_MIN_WORDS, 8);
  for (const words of [0, 1, 7, undefined, NaN]) assert.equal(pickAck({ category: 'neutral', words, seed: 1 }), null, String(words));
  assert.ok(pickAck({ category: 'neutral', words: 8, seed: 1 }));
  assert.equal(pickAck({ category: 'neutral', ...turn('Yes it worked fine for us.'), seed: 1 }), null);
});

test('earned_result is rate limited: only with 3 or more replies since the last one, else thanks_detail', () => {
  const base = { category: 'earned_result', cues: ['describes_achievement'], words: 20, seed: 2 };
  for (const n of [0, 1, 2]) assert.equal(pickAck({ ...base, repliesSinceEarned: n }).category, 'thanks_detail', String(n));
  for (const n of [3, 4, 10]) assert.equal(pickAck({ ...base, repliesSinceEarned: n }).category, 'earned_result', String(n));
  assert.equal(pickAck(base).category, 'earned_result'); // none yet
  assert.equal(pickAck({ ...base, category: 'neutral', repliesSinceEarned: 9 }).category, 'neutral'); // never promoted to earned
});

test('the choice is deterministic by seed and varies with it', () => {
  const args = { category: 'neutral', cues: [], words: 20 };
  assert.deepEqual(pickAck({ ...args, seed: 5 }), pickAck({ ...args, seed: 5 }));
  assert.equal(pickAck({ ...args, seed: 'abc' }).text, pickAck({ ...args, seed: 'abc' }).text);
  assert.ok(new Set(Array.from({ length: 40 }, (_, i) => pickAck({ ...args, seed: i }).text)).size >= 4);
});

test('non-English languages use the neutral FILLERS only', () => {
  for (const lang of ['fr', 'es', 'pt', 'de', 'it', 'nl', 'fr-FR']) for (const category of ['neutral', 'earned_result', 'thanks_detail', 'promising_unverified']) {
    const a = pickAck({ category, cues: ['metric'], words: 20, lang, repliesSinceEarned: 9, seed: 4 });
    assert.equal(a.category, 'neutral'); assert.ok(FILLERS[lang.slice(0, 2)].includes(a.text), lang + a.text);
  }
  assert.equal(pickAck({ category: 'neutral', words: 20, lang: 'xx', seed: 1 }).category, 'neutral'); // unknown tag: English
  assert.equal(pickAck({ category: 'neutral', words: 20, lang: 'ru', seed: 1 }), null); // no filler bank for it
});

test('every returned text has no "?" and no banned praise, across seeds, categories, cues and languages', () => {
  const cueSets = [[], ['metric'], ['describes_setback'], ['describes_achievement'], ['estimate', 'team_claim']];
  for (const lang of ['en', 'fr', 'es', 'de']) for (const category of [...Object.keys(ACKS), 'bogus', undefined]) for (const cues of cueSets) for (let seed = 0; seed < 6; seed++) {
    const a = pickAck({ category, cues, words: 20, lang, seed, repliesSinceEarned: 5 });
    assert.ok(a && !a.text.includes('?') && !BANNED.test(a.text), a && a.text);
  }
  for (const t of all) assert.ok(!t.includes('?') && !BANNED.test(t) && t.split(/\s+/).length <= 8, t);
});

test('pickAck does not mutate its inputs and accepts cues as an array, a Set or an object', () => {
  const recent = ['Okay, I see.'], cues = ['describes_setback'], copy = [...recent];
  pickAck({ category: 'neutral', cues, words: 20, recent, seed: 1 }); assert.deepEqual(recent, copy);
  for (const c of [['describes_setback'], new Set(['describes_setback']), { describes_setback: true }]) assert.equal(pickAck({ category: 'earned_result', cues: c, words: 20, seed: 1 }).category, 'setback_neutral');
});

test('prewarm list: every English line once; other languages their fillers; unknown none', () => {
  const en = ackPrewarmList('en');
  assert.equal(new Set(en).size, en.length); assert.deepEqual([...en].sort(), [...new Set(all)].sort());
  for (const lang of ['fr', 'de', 'nl']) assert.deepEqual(ackPrewarmList(lang), FILLERS[lang]);
  assert.deepEqual(ackPrewarmList('ru'), []);
  assert.deepEqual(ackPrewarmList(), en);
});
