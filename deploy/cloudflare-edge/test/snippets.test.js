// snippets.js (WOW_SPEC §F1.6, §F1.10): one raw split for snippets and claims; each raw sentence masked on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, TOPIC_KEYS, claimKey, snippetsOf } from '../src/snippets.js';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const OWNER = { email: 'alex@mantu.com', role: 'user' };
async function lib(clients = []) {
  let t = 0; const l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 8, 29, 0, 0, t++)).toISOString() });
  for (const [i, name] of clients.entries()) await l.upsert(OWNER, { localId: 'c' + i, reference: { title: 'Other ' + i, client: { name } } });
  return l;
}
const data = (client, answers, extra = {}) => ({ title: 'T', client: { name: client, location: '', contact: '' }, details: {}, answers: [...answers, '', '', '', '', '', ''].slice(0, 6), sources: [], report: null, ...extra });
// Every consultant-words snippet is exactly splitSentences(answers[topic])[idx], and its claim key is the same.
const aligned = (d, snippets) => snippets.filter(s => s.kind === 'consultant_words').every(s => splitSentences(d.answers[s.topic])[s.idx] === s.raw);

test('splitSentences: raw text only, sentence ends and newlines, 12+ characters measured on raw, bounded', () => {
  assert.deepEqual(splitSentences('BNP agreed. Costs fell 20% after launch.'), ['Costs fell 20% after launch.']);
  assert.deepEqual(splitSentences('First line without a stop\nShort one? Yes it is!  Third sentence here.'), ['First line without a stop', 'Third sentence here.'], 'fragments under 12 characters are dropped');
  assert.deepEqual(splitSentences(null), []); assert.deepEqual(splitSentences(''), []);
  const many = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is long enough.`).join(' ');
  assert.equal(splitSentences(many).length, 40); assert.equal(splitSentences(many)[39], 'Sentence number 39 is long enough.');
  assert.equal(splitSentences('x'.repeat(900) + '.')[0].length, 400);
  assert.deepEqual(TOPIC_KEYS, ['context', 'contribution', 'approach', 'outcome', 'evidence', 'customer_relevance']);
  assert.equal(claimKey(3, 'Costs fell.'), '3\nCosts fell.');
});

test('alignment fixture 1: "BNP agreed. Costs fell 20% after launch." gives one snippet keyed on the raw sentence', async () => {
  const l = await lib(), d = data('BNP', ['', '', '', 'BNP agreed. Costs fell 20% after launch.']);
  const s = snippetsOf(l, d);
  assert.equal(s.length, 1);
  assert.deepEqual({ id: s[0].id, kind: s[0].kind, topic: s[0].topic, idx: s[0].idx, raw: s[0].raw, text: s[0].text },
    { id: 'A4.1', kind: 'consultant_words', topic: 3, idx: 0, raw: 'Costs fell 20% after launch.', text: 'Costs fell 20% after launch.' });
  assert.equal(claimKey(s[0].topic, s[0].raw), claimKey(3, splitSentences(d.answers[3])[0]));
});

test('alignment fixture 2: "Acme Inc. hired us…" splits after "Inc." identically for claims and snippets', async () => {
  const l = await lib(), d = data('Acme Inc.', ['', 'Acme Inc. hired us to rebuild intake. We then ran the new intake with the Acme Inc. team for a year.']);
  const s = snippetsOf(l, d);
  assert.deepEqual(splitSentences(d.answers[1]), ['hired us to rebuild intake.', 'We then ran the new intake with the Acme Inc.', 'team for a year.']);
  assert.deepEqual(s.map(x => x.raw), splitSentences(d.answers[1]));
  assert.deepEqual(s.map(x => x.text), ['hired us to rebuild intake.', 'We then ran the new intake with the the client', 'team for a year.']);
  assert.ok(aligned(d, s));
});

test('alignment fixture 3: client "Air" never rewrites "repair" (word-bounded scrub)', async () => {
  const l = await lib(), d = data('Air', ['We did the repair of the queue. Air asked for it.']);
  const s = snippetsOf(l, d);
  assert.deepEqual(s.map(x => x.text), ['We did the repair of the queue.', 'the client asked for it.']);
  assert.deepEqual(snippetsOf(l, data('Air', ['We did the repair of the queue for Air and AIR teams.'])).map(x => x.text), ['We did the repair of the queue for the client and the client teams.']);
});

test('masking: own client, other library clients, contacts and PII in text; raw kept server-side only', async () => {
  const l = await lib(['Zebracorp']), d = data('Quillon', ['Quillon asked us after the Zebracorp rollout went well.', 'I wrote to jane@acme.example about it twice.']);
  const s = snippetsOf(l, d);
  assert.deepEqual(s.map(x => x.text), ['the client asked us after the another client rollout went well.', 'I wrote to [email] about it twice.']);
  assert.deepEqual(s.map(x => x.raw), ['Quillon asked us after the Zebracorp rollout went well.', 'I wrote to jane@acme.example about it twice.']);
  assert.ok(s.every(x => typeof x.raw === 'string' && typeof x.text === 'string'));
});

test('sources are evidence snippets; data.report is never a snippet; caps respected', async () => {
  const l = await lib(), long = n => Array.from({ length: n }, (_, i) => `Consultant sentence ${i} is here.`).join(' ');
  const d = data('Client', Array(6).fill(long(20)), {
    sources: Array.from({ length: 20 }, (_, j) => ({ name: 'Dashboard ' + j, version: 'v' + j, url: '', excerpt: long(10) })),
    report: { headline: 'Report headline sentence here.', summary: 'Model draft summary that must never be a snippet.', topics: {} } });
  const s = snippetsOf(l, d);
  assert.equal(s.length, 80);
  for (let t = 0; t < 6; t++) assert.equal(s.filter(x => x.topic === t).length, 12);
  const src = s.filter(x => x.kind === 'evidence');
  assert.equal(src.length, 8); assert.deepEqual(src[0], { id: 'S1.1', kind: 'evidence', idx: 0, source: { name: 'Dashboard 0', version: 'v0' }, rawSource: { name: 'Dashboard 0', version: 'v0' }, raw: 'Consultant sentence 0 is here.', text: 'Consultant sentence 0 is here.' });
  assert.equal(snippetsOf(l, { ...d, answers: ['', '', '', '', '', ''] }).filter(x => x.id.startsWith('S1.')).length, 6);
  assert.doesNotMatch(JSON.stringify(s), /Model draft|Report headline/);
  assert.ok(aligned(d, s)); assert.ok(s.every(x => x.text.length <= 400));
});

test('evidence source name and version get the same masking as the text; the raw source stays server-side', async () => {
  const l = await lib(['Quillon Energy']), name = 'Zebracorp Bank claims triage SOW.txt (jane.doe@zebracorp.example)', version = 'Quillon Energy v2 2026-03-01';
  const d = data('Zebracorp Bank', [], { sources: [{ name, version, excerpt: 'Claims triage times fell from 40 to 12 minutes per claim.' }] });
  const [s] = snippetsOf(l, d);
  assert.deepEqual(s.source, { name: 'the client claims triage SOW.txt ([email])', version: 'another client v2 2026-03-01' });
  assert.deepEqual(s.rawSource, { name, version }, 'raw, like `raw`: for full-access readers only, never customer-facing');
  assert.deepEqual(snippetsOf(l, data('C', [], { sources: [{ excerpt: 'An excerpt long enough to keep.' }] }))[0].source, { name: '', version: '' });
});
