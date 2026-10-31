import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EnergyTurns, sentences, wav, SAMPLE_RATE } from '../src/speech.js';

const V = JSON.parse(readFileSync(new URL('./speech.vectors.json', import.meta.url)));
const tone = (sec, amp, hz = 180) => { const n = Math.floor(SAMPLE_RATE * sec), a = []; for (let i = 0; i < n; i++) a.push(Math.trunc(amp * 32767 * Math.sin(2 * Math.PI * hz * i / SAMPLE_RATE))); return a; };
for (const [name, v] of Object.entries(V)) {
  if (name.startsWith('_')) continue;
  test('EnergyTurns parity: ' + name, () => {
    const samples = v.segments.flatMap(([s, a]) => tone(s, a)), t = new EnergyTurns(), events = [];
    for (let i = 0; i < samples.length; i += 480) {
      const chunk = samples.slice(i, i + 480), pcm = new Uint8Array(chunk.length * 2), dv = new DataView(pcm.buffer);
      chunk.forEach((s, k) => dv.setInt16(k * 2, s, true));
      const [started, utt] = t.feed(pcm, v.agent);
      if (started) events.push(['start', i]);
      if (utt) events.push(['utt', i, utt.length]);
    }
    assert.deepEqual(events, v.events); assert.ok(Math.abs(t.floor - v.floor) < 1e-9);
  });
}
test('sentence splitting parity', () => { for (const [s, exp] of V._sentences) assert.deepEqual(sentences(s), exp); });
test('wav header', () => { const w = wav(new Uint8Array(20)), d = new DataView(w.buffer); assert.equal(String.fromCharCode(...w.slice(0, 4)), 'RIFF'); assert.equal(d.getUint32(24, true), 24000); assert.equal(d.getUint32(40, true), 20); });
import { isEcho } from '../src/speech.js';
test('echo detection matches Python', () => {
  const agent = "I'm ATLAS, here to discuss your project experience. What problem were you trying to solve with Project Falcon?";
  assert.ok(isEcho('what problem were you trying to solve', agent));
  assert.ok(!isEcho('Tickets were bouncing between three support teams', agent));
  assert.ok(!isEcho('yes', agent) && !isEcho('a b c', ''));
});

test('echo detection parity across scripts (French, Japanese, Russian, English)', () => { for (const [a, b, exp] of V._echo) assert.equal(isEcho(a, b), exp, a); });

// ---- Natural phrasing for the voice (sentence ends, pieces, markup) and a band-limited 16 kHz path. ----
import { Phrases, speakable, to16k, rms } from '../src/speech.js';
const steps = deltas => { const p = new Phrases(); return [...deltas.map(d => p.feed(d)), p.flush()]; };

test('sentence ends skip initialisms, abbreviations, an ellipsis before lowercase, decimals and list numbers', () => {
  assert.deepEqual(sentences('We used A.I. to triage. Then we'), [['We used A.I. to triage.'], 'Then we']);
  assert.deepEqual(sentences('For example, e.g. Kafka, i.e. a queue. It'), [['For example, e.g. Kafka, i.e. a queue.'], 'It']);
  assert.deepEqual(sentences('Mr. Smith and Dr. Patel led it. And'), [['Mr. Smith and Dr. Patel led it.'], 'And']);
  assert.deepEqual(sentences('The U.S. team grew 3.5 times. Next'), [['The U.S. team grew 3.5 times.'], 'Next']);
  assert.deepEqual(sentences('We had data... and more data... So'), [['We had data... and more data...'], 'So']);
  assert.deepEqual(sentences('Kafka, Spark, etc. were used vs. the old stack. Ok'), [['Kafka, Spark, etc. were used vs. the old stack.'], 'Ok']);
  assert.deepEqual(sentences('He said "done." Then'), [['He said "done."'], 'Then']);
  assert.deepEqual(sentences('1. We migrated. 2. We trained. 3'), [['1. We migrated.', '2. We trained.'], '3']);
  // At the end of the streamed text a full stop still ends the sentence at once, as ! and ? do.
  assert.deepEqual(sentences('It ended. '), [['It ended.'], '']); assert.deepEqual(sentences('Really? '), [['Really?'], '']);
});

test('phrases: the first piece goes at once, then short sentences join the next; the clause fast path needs 40 characters', () => {
  assert.deepEqual(steps(['Thanks. ', 'What was ', 'the baseline?']), [['Thanks.'], [], [], ['What was the baseline?']]);
  assert.deepEqual(steps(['Great. ', 'That is clear. ', 'So it worked. ', 'Who measured the change before and after?', ' Ok.']),
    [['Great.'], [], [], [], ['That is clear. So it worked. Who measured the change before and after?'], ['Ok.']]);
  // Model tokens carry the space before the next word: an ellipsis before a lowercase word is not an end.
  assert.deepEqual(steps(['Well...', ' it depends.', ' Right.']), [[], [], ['Well... it depends.'], ['Right.']]);
  assert.deepEqual(steps(['Before we get into the numbers and the detail, ', 'tell me who ', 'owned it.']), [['Before we get into the numbers and the detail,'], [], [], ['tell me who owned it.']]);
  assert.deepEqual(steps(['Right, so the budget, ', 'who owned it?', ' And']), [[], [], ['Right, so the budget, who owned it?'], ['And']]);
  assert.deepEqual(steps(['We used A.', 'I. models, e.g. ', 'GPT, in the U.S. ', 'market. It worked.']), [[], [], [], ['We used A.I. models, e.g. GPT, in the U.S. market.'], ['It worked.']]);
  // Every piece is an exact slice of the streamed text (the on-screen text is cut at it).
  const text = 'Great. That is clear.\n\nSo it worked. Who measured the change before and after? Ok.', p = new Phrases(), got = [];
  for (const ch of text) got.push(...p.feed(ch));
  got.push(...p.flush()); let at = 0;
  for (const piece of got) { const i = text.indexOf(piece, at); assert.ok(i >= at && !text.slice(at, i).trim(), piece); at = i + piece.length; }
  assert.equal(at, text.length);
});

test('speakable: markdown and list markers are removed for the voice only', () => {
  assert.equal(speakable('**Budget**: we cut __costs__ by `40%`.'), 'Budget: we cut costs by 40%.');
  assert.equal(speakable('- the budget\n- the scope'), 'the budget the scope');
  assert.equal(speakable('1. We migrated.\n2) We trained.'), 'We migrated. We trained.');
  assert.equal(speakable('## Summary\nWe moved.'), 'Summary We moved.');
  assert.equal(speakable('C# and F# stay, -5 degrees, 3.5 times.'), 'C# and F# stay, -5 degrees, 3.5 times.');
  assert.equal(speakable('*really* good'), 'really good');
  assert.equal(speakable('**'), ''); assert.equal(speakable(' - '), '');
});

test('phrase and speakable parity with Python', () => {
  for (const [deltas, exp] of V._phrases) assert.deepEqual(steps(deltas), exp, deltas.join('|'));
  for (const [text, exp] of V._speakable) assert.equal(speakable(text), exp, text);
});

const toneAt = (hz, sec = 0.5, amp = 0.5) => { const n = Math.floor(SAMPLE_RATE * sec), pcm = new Uint8Array(n * 2), dv = new DataView(pcm.buffer);
  for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.round(amp * 32767 * Math.sin(2 * Math.PI * hz * i / SAMPLE_RATE)), true); return pcm; };
const middle = pcm => pcm.subarray(800, pcm.length - 800); // away from the edges

test('to16k band-limits before decimating: 8-12 kHz no longer folds into the speech band; speech passes', () => {
  for (const hz of [9000, 10000, 11000]) { // above the 8 kHz limit of 16 kHz audio: would alias to 7, 6 and 5 kHz
    const inp = toneAt(hz), out = to16k(inp);
    assert.equal(out.length, Math.floor(inp.length / 2 * 2 / 3) * 2);
    assert.ok(rms(middle(out)) < 0.03 * rms(middle(inp)), `${hz} Hz leaks ${(rms(middle(out)) / rms(middle(inp))).toFixed(3)}`);
  }
  for (const hz of [300, 1000, 3000, 5000]) { const inp = toneAt(hz), ratio = rms(middle(to16k(inp))) / rms(middle(inp)); assert.ok(Math.abs(ratio - 1) < 0.03, `${hz} Hz gain ${ratio.toFixed(3)}`); }
  const odd = new Uint8Array(3001 * 2).fill(0); odd.set(toneAt(1000, 0.1).subarray(0, 4000));
  assert.equal(to16k(odd.subarray(2)).length, Math.floor(3000 * 2 / 3) * 2, 'unaligned views work');
});

// ---- ReplyGuard: one question, no empty praise, no repeated reaction, a short reply, summary-mode numbers. ----
import { ReplyGuard, GUARD_STATS, figures, assertsVerification } from '../src/speech.js';
const guardOf = o => new ReplyGuard({ bannedPraise: o.banned_praise, recentOpeners: o.recent_openers, ...('max_words' in o ? { maxWords: o.max_words } : {}), summaryFacts: o.summary_facts, allowStatus: o.allow_status });
const run = (opts, pieces) => { const g = guardOf(opts), voiced = []; let doneAt = null; pieces.forEach((p, i) => { voiced.push(g.push(p)); if (g.done && doneAt === null) doneAt = i; }); return { g, voiced, doneAt }; };

test('ReplyGuard parity with Python on every recorded stream (voiced pieces, stats, when it was done)', () => {
  assert.ok(V._guard.length >= 15);
  for (const v of V._guard) {
    if (v.deltas) assert.deepEqual(steps(v.deltas).flat(), v.pieces, v.name + ': Phrases pieces');
    const { g, voiced, doneAt } = run(v.opts, v.pieces);
    assert.deepEqual(voiced, v.voiced, v.name); assert.deepEqual(g.stats, v.stats, v.name + ': stats'); assert.equal(doneAt, v.done_at, v.name + ': done_at');
  }
});

test('ReplyGuard: the first question ends the reply and the stream; what follows it is dropped and counted', () => {
  const { g, voiced, doneAt } = run({}, ['Got it, thanks for that.', 'Who owned it? And what changed afterwards?', 'Tell me more.']);
  assert.deepEqual(voiced, [['Got it, thanks for that.'], ['Who owned it?'], []]); assert.equal(doneAt, 1);
  assert.equal(g.stats.dropped_after_question, 2); assert.equal(g.push('More?').length, 0); assert.equal(g.stats.dropped_after_question, 3);
  // A question split across pieces is voiced whole: the first clause was already out.
  const split = run({}, ['Before we get into the numbers and the detail,', 'tell me who owned it?', 'And the budget?']);
  assert.deepEqual(split.voiced, [['Before we get into the numbers and the detail,'], ['tell me who owned it?'], []]); assert.equal(split.doneAt, 1);
});

test('ReplyGuard: standalone praise of 8 words or fewer goes; a question that carries praise stays', () => {
  assert.deepEqual(run({}, ['Amazing!', 'What did you own?']).voiced, [[], ['What did you own?']]);
  assert.deepEqual(run({}, ["That's an amazing team effort — what did you own?"]).voiced, [["That's an amazing team effort — what did you own?"]]);
  assert.deepEqual(run({}, ['This is a truly fantastic piece of work from the whole team.']).voiced, [['This is a truly fantastic piece of work from the whole team.']]); // 11 words
  assert.equal(run({}, ['AWESOME.']).g.stats.dropped_praise, 1);
  const custom = run({ banned_praise: '\\b(great)\\b' }, ['Great!', 'Amazing.']); // the source is the caller's (persona.BANNED_PRAISE_SRC once wired)
  assert.deepEqual(custom.voiced, [[], ['Amazing.']]);
});

test('ReplyGuard: a leading reaction that repeats a recent opener is dropped; only the last three count; a long first sentence is an answer', () => {
  const o = { recent_openers: ['Got it, thanks for that.', 'I see'] };
  assert.deepEqual(run(o, ['Got it, thanks for that detail.', 'Who owned it?']).voiced, [[], ['Who owned it?']]);
  assert.deepEqual(run(o, ["I see.", 'Who owned it?']).voiced, [[], ['Who owned it?']]);
  assert.deepEqual(run(o, ['Makes sense.', 'Who owned it?']).voiced, [['Makes sense.'], ['Who owned it?']]);
  assert.deepEqual(run({ recent_openers: ['Right', 'Got it', 'I see', 'Fine'] }, ['Right.', 'Who?']).voiced, [['Right.'], ['Who?']]);
  assert.deepEqual(run({ recent_openers: ['thanks'] }, ['Thanks to the new pipeline the tickets dropped in the first quarter after launch.']).voiced, [['Thanks to the new pipeline the tickets dropped in the first quarter after launch.']]);
  assert.equal(run(o, ['Got it. Got it, thanks for that.', 'Who?']).g.stats.dropped_repeat_opener, 1); // only the leading sentence is a reaction
});

test('ReplyGuard: the word cap cuts at a sentence when it can, at a word when it must, and ends the reply', () => {
  const sentence = 'We looked at the numbers again and again for the quarter and the pipeline.'; // 14 words
  const a = run({}, [[sentence, sentence, sentence, sentence].join(' '), 'Who owned it?']);
  assert.equal(a.voiced[0][0], [sentence, sentence, sentence].join(' ')); assert.deepEqual(a.voiced[1], []); assert.equal(a.g.stats.capped_words, 1); assert.equal(a.doneAt, 0);
  const one = run({}, [Array.from({ length: 60 }, (_, i) => 'w' + i).join(' ') + '.']).voiced[0][0];
  assert.equal(one.split(' ').length, 45); assert.ok(one.endsWith('w44'));
  assert.deepEqual(run({ max_words: 6 }, ['That is clear.', 'It worked well for us.']).voiced, [['That is clear.'], []]);
  assert.equal(run({ max_words: null }, [Array(200).fill('word').join(' ') + '.']).g.stats.capped_words, 0);
  // Exactly at the cap is fine; the next word is not.
  assert.deepEqual(run({ max_words: 4 }, ['One two three four.']).g.stats.capped_words, 0);
  assert.equal(run({ max_words: 4 }, ['One two three four.', 'Five.']).g.stats.capped_words, 1);
});

test('ReplyGuard: summary mode drops a sentence with a figure that is not a given fact; numerals are normalised', () => {
  const o = { summary_facts: ['35%', '12 weeks', '1,200', '3.50'] };
  const { g, voiced } = run(o, ['Tickets dropped 35% over 12 weeks.', 'That saved us 40 hours.', 'We handled 1200 tickets at 3.5 each.', 'What have I misunderstood or missed?']);
  assert.deepEqual(voiced, [['Tickets dropped 35% over 12 weeks.'], [], ['We handled 1200 tickets at 3.5 each.'], ['What have I misunderstood or missed?']]);
  assert.equal(g.stats.dropped_unknown_number, 1);
  assert.deepEqual(run({}, ['That saved us 40 hours.']).voiced, [['That saved us 40 hours.']]); // not summary mode: numbers are fine
  assert.deepEqual(run({ summary_facts: [] }, ['It took 3 teams.', 'No figures here.']).voiced, [[], ['No figures here.']]);
});

test('ReplyGuard: non-English questions end the reply (inverted mark, full-width mark, space before the mark)', () => {
  assert.deepEqual(run({}, ['Gracias. ¿Quién lideró eso? ¿Y cuánto tardó?']).voiced, [['Gracias. ¿Quién lideró eso?']]);
  assert.deepEqual(run({}, ['ありがとう。基準は何でしたか？そして']).voiced, [['ありがとう。基準は何でしたか？']]);
  assert.deepEqual(run({}, ['Merci.', 'Quelle était la référence ?', 'Et ?']).voiced, [['Merci.'], ['Quelle était la référence ?'], []]);
});

test('ReplyGuard: output is an exact slice of the piece; stats are counts only and a copy', () => {
  const piece = 'Amazing!  Thanks.\n\nWho owned it?  And more?';
  const g = new ReplyGuard(), out = g.push(piece);
  assert.deepEqual(out, ['Thanks.\n\nWho owned it?']); assert.ok(piece.includes(out[0]));
  assert.deepEqual(Object.keys(g.stats), GUARD_STATS);
  assert.ok(Object.values(g.stats).every(Number.isInteger));
  g.stats.dropped_praise = 99; assert.equal(g.stats.dropped_praise, 1);
  assert.deepEqual(new ReplyGuard().push(''), []); assert.deepEqual(new ReplyGuard().push(undefined), []);
  assert.equal(new ReplyGuard().done, false);
});

test('ReplyGuard follows the Phrases pieces of a streamed reply, and done tells the caller to stop reading', () => {
  const p = new Phrases(), g = new ReplyGuard({ recentOpeners: ['Thanks for that'] }), spoken = []; let read = 0;
  for (const d of ['Thanks for ', 'that. ', 'Amazing! ', 'Who ', 'measured the change before and after?', ' And how big was it?', ' Tell me more.']) {
    if (g.done) break; read++;
    for (const piece of p.feed(d)) spoken.push(...g.push(piece));
  }
  assert.deepEqual(spoken, ['Who measured the change before and after?']); assert.equal(read, 6); /* Phrases releases a sentence at the whitespace after it, so the stop comes one delta after the question mark */ assert.equal(g.stats.dropped_repeat_opener, 1); assert.equal(g.stats.dropped_praise, 1);
});

// ---- Red L3 (R2): figures however they are written, and sentences that claim something was verified or approved. PoC: red/pocs/prompt/p9_guard_numbers.mjs ----
test('figures and verification claims: parity with Python on every recorded text', () => {
  for (const [text, expected] of V._figures) assert.deepEqual(figures(text), expected, text);
  for (const [text, expected] of V._claims) assert.equal(assertsVerification(text), expected, text);
});

test('p9 regression: spelled-out and full-width numbers are caught in summary mode, and "verified and approved" is never voiced', () => {
  const facts = ['you cut the handling time by 4 percent'];
  const said = reply => { const g = new ReplyGuard({ summaryFacts: facts }); return { out: g.push(reply), stats: g.stats }; };
  for (const reply of ['So, you cut the handling time by 40 percent. ', 'So, you cut the handling time by forty percent. ', 'So, you cut it by four-fold, saving two million euros. ',
    'So, you cut it by \uff14\uff10 percent. ', 'So, you cut it by half, a tenfold gain. ']) {
    const r = said(reply); assert.deepEqual(r.out, [], reply); assert.equal(r.stats.dropped_unknown_number, 1, reply);
  }
  const verified = said('So, you cut it by 4 percent, and your manager verified and approved it. ');
  assert.deepEqual(verified.out, []); assert.equal(verified.stats.dropped_unverified_claim, 1);
  assert.deepEqual(said('So, you cut it by 4 percent. ').out, ['So, you cut it by 4 percent.'], 'the true figure still passes');
  assert.deepEqual(said('So, you cut it by four percent. ').out, ['So, you cut it by four percent.'], 'a spelled-out fact is the same figure');
});

test('ReplyGuard: verification claims are dropped in every mode, denials, hedges and questions are kept, a server status line may say it', () => {
  const g = new ReplyGuard({}), out = [];
  for (const p of ['Your 40 percent saving is independently verified and approved by your manager.', 'That figure is not verified yet.', 'A reviewer will approve it later.', 'Was that approved by anyone?']) out.push(g.push(p));
  assert.deepEqual(out, [[], ['That figure is not verified yet.'], ['A reviewer will approve it later.'], ['Was that approved by anyone?']]);
  assert.equal(g.stats.dropped_unverified_claim, 1);
  assert.deepEqual(new ReplyGuard({ allowStatus: true }).push('The draft was approved by the reviewer.'), ['The draft was approved by the reviewer.']);
  assert.ok(GUARD_STATS.includes('dropped_unverified_claim'));
});
