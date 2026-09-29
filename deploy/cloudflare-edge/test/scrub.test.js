// scrub.js (WOW_SPEC §2.3, §F1.10): the one masking module. Real Library on node:sqlite, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STOPLIST, libraryNames, nameMatcher, pseudonymise, unmask, forOthers, maskedPreview, recordText, recordView } from '../src/scrub.js';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const OWNER = { email: 'alex@mantu.com', role: 'user' }, REV = { email: 'rev@mantu.com', role: 'reviewer' };
const ref = (title, client, answers = []) => ({ title, client, details: { country: 'France' }, answers });
async function lib(clients = [{ name: 'Zebracorp', location: 'Lyon', contact: 'Jane Doe' }]) {
  let t = 0; const l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 8, 29, 0, 0, t++)).toISOString() });
  for (const [i, c] of clients.entries()) await l.upsert(OWNER, { localId: 'r' + i, reference: ref('Ref ' + i, c) });
  return l;
}
const SENTINELS = /Zebracorp|Acme Prospect|jane@acme\.example|\+33 6 12 34 56 78|https:\/\/acme\.example/i;

test('stoplist: frozen lower-case word set with the common-word client names of the spec', () => {
  assert.ok(STOPLIST.size >= 500);
  for (const w of ['total', 'orange', 'will', 'mark', 'the', 'et', 'pour']) assert.ok(STOPLIST.has(w), w);
  assert.ok([...STOPLIST].every(w => w === w.toLowerCase() && !/\s/.test(w)));
});

test('word boundaries: GE masked in "GE Vernova", never inside "manaGEment"', async () => {
  const l = await lib([{ name: 'GE', location: '', contact: '' }]);
  assert.equal(recordText(l)('GE Vernova improved manaGEment reporting'), 'another client Vernova improved manaGEment reporting');
  const m = nameMatcher(['GE']);
  assert.equal(m('GE, GE. (GE) GEnerator ge', () => 'X'), 'X, X. (X) GEnerator ge', 'short names: stored and upper-case forms only');
  assert.equal(nameMatcher(['Air'])('We did the repair of the queue with Air and AIR.', () => 'X'), 'We did the repair of the queue with X and X.');
});

test('case rules: stoplist words and short names are case-sensitive; other names of 5+ characters are not', async () => {
  const l = await lib([{ name: 'Total', contact: 'Will' }, { name: 'Orange', contact: 'Mark' }, { name: 'Zebracorp', contact: 'Jane Doe' }]);
  const rt = recordText(l);
  assert.equal(rt('The total cost of ownership fell.'), 'The total cost of ownership fell.');
  assert.equal(rt('Total and TOTAL signed.'), 'another client and another client signed.');
  assert.equal(rt('Total cost fell.'), 'another client cost fell.', 'a stoplist name at a sentence start is masked: the documented safe side');
  assert.equal(rt('orange juice for Orange'), 'orange juice for another client');
  assert.equal(rt('zebracorp, ZEBRACORP and Zebracorp'), 'another client, another client and another client');
  assert.equal(rt('the supplier will ask Mark and Will'), 'the supplier will ask Mark and Will', 'single-token stoplist contacts are skipped');
  assert.equal(rt('jane doe and JANE DOE'), 'a contact and a contact');
  assert.deepEqual(nameMatcher(['Jo', 'Will', 'Will Smith'], { contacts: true }).spans('Jo, Will and will smith').flat().map(s => s.name), ['Will Smith']);
});

test('multi-word names with irregular spacing, longest first, and the stored name passed to replace', () => {
  const m = nameMatcher(['Acme', 'Acme  Holdings', 'Acme Inc.']);
  const seen = [];
  assert.equal(m('Acme\n  Holdings bought Acme Inc. and ACME', (x, name) => { seen.push([x, name]); return '<' + name + '>'; }), '<Acme Holdings> bought <Acme Inc.> and <Acme>');
  assert.deepEqual(seen.map(s => s[1]), ['Acme Holdings', 'Acme Inc.', 'Acme']);
  assert.equal(m('Acmex and xAcme', () => 'X'), 'Acmex and xAcme');
  assert.equal(nameMatcher(['a', ' ', ''])('a b', () => 'X'), 'a b', 'names under 2 characters are ignored');
});

test('emails, phones and URLs are masked; dates and plain figures are not phones', async () => {
  const l = await lib([]), rt = recordText(l);
  assert.equal(rt('Write to jane@acme.example or jane.doe+x@mail.acme.example.'), 'Write to [email] or [email].');
  assert.equal(rt('Call +33 6 12 34 56 78, (555) 123-4567 or 06.12.34.56.78.'), 'Call [phone], [phone] or [phone].');
  assert.equal(rt('See https://acme.example/case?id=4, www.acme.example and http://x.example/a@b.co.'), 'See [link], [link] and [link].');
  assert.equal(rt('From 2024-03-01, 2019-2024: 40 to 12 minutes, 20% faster, team of 6.'), 'From 2024-03-01, 2019-2024: 40 to 12 minutes, 20% faster, team of 6.');
  assert.equal(rt('mail jane@www.acme.example now'), 'mail [email] now', 'the longest overlapping span wins');
});

test('pseudonymise -> unmask round trip: the author gets every spelling back; identical spans share a placeholder', async () => {
  const l = await lib();
  const text = 'Acme Prospect asked jane@acme.example (+33 6 12 34 56 78, https://acme.example) about Zebracorp. ZEBRACORP and Jane Doe again, Acme Prospect too. Lyon is fine.';
  const p = pseudonymise(l, text, { prospects: ['Acme Prospect'] });
  assert.doesNotMatch(p.text, SENTINELS); assert.doesNotMatch(p.text, /Jane Doe/);
  assert.match(p.text, /Lyon is fine/, 'client locations are not library names');
  assert.equal(p.text.match(/\[Company 1\]/g).length, 2, 'the repeated prospect shares one placeholder');
  assert.deepEqual(Object.keys(p.map).sort(), ['[Company 1]', '[Company 2]', '[Company 3]', '[Email 1]', '[Link 1]', '[Person 1]', '[Phone 1]']);
  assert.equal(unmask(p.text, p.map), text, 'exact round trip, including the upper-case spelling');
  // A second call extends the same map (one bid map for alias, brief and requirement edits).
  const q = pseudonymise(l, 'Brief for Acme Prospect, not Zebracorp.', { prospects: ['Acme Prospect'], map: p.map });
  assert.equal(q.text, 'Brief for [Company 1], not [Company 2].'); assert.equal(Object.keys(q.map).length, 7);
  assert.equal(Object.keys(p.map).length, 7, 'the caller map is not mutated');
  assert.deepEqual(unmask({ a: ['[Company 2] and [company 1]', 3], b: '[Person 9]' }, p.map), { a: ['Zebracorp and Acme Prospect', 3], b: '[person]' });
});

test('typed placeholders are neutralised, so nobody can type the masked form of a name', async () => {
  const l = await lib();
  const p = pseudonymise(l, 'Compare [Company 1], [company] and [Link 2] with Zebracorp.', {});
  assert.equal(p.text, 'Compare Company 1, company and Link 2 with [Company 1].');
  assert.equal(unmask(p.text, p.map), 'Compare Company 1, company and Link 2 with Zebracorp.');
});

test('forOthers: one uniform label per kind, whether the span was a prospect or a library name', async () => {
  const l = await lib();
  const p = pseudonymise(l, 'Acme Prospect vs Zebracorp; Jane Doe; jane@acme.example; +33 6 12 34 56 78; www.acme.example', { prospects: ['Acme Prospect'] });
  assert.equal(forOthers(p.text), '[company] vs [company]; [person]; [contact]; [contact]; [contact]');
  assert.deepEqual(forOthers({ t: ['[Company 12]'] }), { t: ['[company]'] });
});

test('maskedPreview: declared prospects and contact details only, never library names', async () => {
  assert.equal(maskedPreview('Acme Prospect and acme prospect met Zebracorp at jane@acme.example, +33 6 12 34 56 78, https://acme.example.', ['Acme Prospect']),
    '[prospect] and [prospect] met Zebracorp at [contact], [contact], [contact].');
  assert.equal(maskedPreview('Nothing declared: Zebracorp.', []), 'Nothing declared: Zebracorp.');
});

test('libraryNames: every row, merged rows included, cached until the refs table changes', async () => {
  const l = await lib([{ name: 'Zebracorp', location: 'Lyon', contact: 'Jane Doe' }, { name: 'Quillon Energy', contact: '' }]);
  assert.deepEqual(libraryNames(l), { clients: ['Quillon Energy', 'Zebracorp'], contacts: ['Jane Doe'] });
  const rt = recordText(l);
  assert.equal(rt('Brightwave'), 'Brightwave');
  const b = await l.upsert(OWNER, { localId: 'new', reference: ref('New', { name: 'Brightwave' }) });
  assert.equal(recordText(l)('Brightwave'), 'another client', 'cache invalidated by the upsert');
  // Merge Brightwave into another record: its client name stays confidential.
  const keep = l.rows('SELECT id FROM refs WHERE local_id = ?', 'r0')[0].id;
  await l.merge(REV, { keep, merge: b.id });
  assert.ok(l.row(b.id).merged_into);
  assert.ok(libraryNames(l).clients.includes('Brightwave'));
  assert.equal(recordText(l)('as at Brightwave'), 'as at another client');
});

test('recordView: own client is "the client", other library clients "another client", contacts and PII masked', async () => {
  const l = await lib([{ name: 'Zebracorp', location: 'Lyon', contact: 'Jane Doe' }, { name: 'Quillon Energy', location: 'Nantes', contact: 'Head of Ops' }]);
  const data = l.row(l.rows('SELECT id FROM refs WHERE local_id = ?', 'r1')[0].id).data;
  data.answers[0] = 'Quillon Energy in Nantes had the same issue as we saw at Zebracorp; Jane Doe (jane@acme.example) agreed.';
  const v = recordView(l, data);
  assert.equal(v.answers[0], 'the client in the client had the same issue as we saw at another client; a contact ([email]) agreed.');
  assert.ok(!('client' in v)); assert.doesNotMatch(JSON.stringify(v), /Zebracorp|Quillon|Jane Doe|jane@/);
});

test('scale: 5,000 library names over a 60,000-character brief stay fast (no giant alternation)', () => {
  const names = Array.from({ length: 5000 }, (_, i) => 'Client' + i.toString(36) + ['corp', ' Holdings', ' SA', 'tech'][i % 4]);
  const m = nameMatcher([...names, '(Paren) Group', 'GE']), text = 'x '.repeat(30000) + 'Client1 Holdings, CLIENT4CORP, (Paren) Group, GE and ge.';
  const t0 = performance.now(), out = m(text, () => 'X'), ms = performance.now() - t0;
  assert.equal(out.slice(60000), 'X, X, X, X and ge.');
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
});

// ---- T1 steps 1-4 helpers (beyond the §6.3 names): PII first, the author display rule, SafeSummary ----
import { piiText, recordMask, forAuthor, clientMatcher, safeSummary } from '../src/scrub.js';
test('piiText runs before the own-client scrub, so an address carrying the client name is masked whole', async () => {
  assert.equal(piiText('Write to ops@brightwave.example or see https://brightwave.example/case, call +33 6 12 34 56 78.'), 'Write to [email] or see [link], call [phone].');
  assert.equal(piiText(7), 7);
  const l = new Library(memorySql(), {});
  await l.upsert({ email: 'a@mantu.com', role: 'user' }, { localId: 'b', reference: { title: 'Brightwave grid', client: { name: 'Brightwave' }, answers: ['Mail ops@brightwave.example about Brightwave.'] } });
  const row = l.row(l.rows('SELECT id FROM refs')[0].id);
  assert.equal(recordView(l, row.data).answers[0], 'Mail [email] about the client.');
});

test('forAuthor: record masking first, then the author\'s own words back; clientMatcher reports stored names', async () => {
  const l = new Library(memorySql(), {});
  await l.upsert({ email: 'a@mantu.com', role: 'user' }, { localId: 'z', reference: { title: 'Z', client: { name: 'Zebracorp', contact: 'Jane Doe' } } });
  const q = pseudonymise(l, 'Compare ZEBRACORP with Acme', { prospects: ['Acme'] });
  const out = forAuthor(l, q.map)({ why: `Like ${q.text.slice(8)}, and Zebracorp itself`, n: 3, list: ['Jane Doe said so'] });
  assert.deepEqual(out, { why: 'Like ZEBRACORP with Acme, and another client itself', n: 3, list: ['a contact said so'] }, 'a name the model produced is masked; the author\'s own spelling comes back');
  assert.deepEqual(recordMask(l)(['[Company 1] and Zebracorp']), ['[Company 1] and another client'], 'placeholders untouched');
  const found = []; clientMatcher(l)('zebracorp and ZEBRACORP', (m, stored) => { found.push([m, stored]); return m; });
  assert.deepEqual(found, [['zebracorp', 'Zebracorp'], ['ZEBRACORP', 'Zebracorp']]);
  assert.equal(clientMatcher(l), clientMatcher(l), 'cached per library change');
});

test('safeSummary: full access unchanged; otherwise no owner email, no client, and titles and tags record-masked', async () => {
  const l = new Library(memorySql(), {}), owner = { email: 'lee@mantu.com', role: 'user' };
  await l.upsert(owner, { localId: 'o', reference: { title: 'Brightwave payouts', client: { name: 'Brightwave' } } });
  const s = await l.upsert(owner, { localId: 'z', reference: { title: 'Zebracorp claims triage like Brightwave, ops@zebracorp.example', sector: 'Zebracorp insurance', client: { name: 'Zebracorp' }, details: { technologies: ['Zebracorp stack'] } } });
  const row = l.row(s.id);
  assert.deepEqual(safeSummary(l, row, 'full', owner), l.summary(row, 'full', owner));
  const pub = safeSummary(l, row, 'public', { email: 'kim@mantu.com', role: 'user' });
  assert.deepEqual([pub.owner, pub.client, pub.title, pub.industry, pub.technologies], ['', '', 'the client claims triage like another client, [email]', 'the client insurance', ['the client stack']]);
  assert.doesNotMatch(JSON.stringify(pub), /@|Zebracorp|Brightwave/);
});
