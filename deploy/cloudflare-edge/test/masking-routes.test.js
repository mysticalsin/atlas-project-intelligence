// Masking regressions through the real routes (WOW_SPEC §2.3, §F1.9 #2, §F6.4 #3): evidence source names in
// customer-facing one-pager footnotes and Ask snippets, and the placeholder-map cap oracle on requirement edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as ask from '../src/ask.js';
import * as bids from '../src/bids.js';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const LEE = { email: 'lee@mantu.com', role: 'user', mail: 'lee@mantu.com' }, KIM = { email: 'kim@mantu.com', role: 'user', mail: 'kim@mantu.com' };
const DETAILS = { projectId: '', country: 'France', consultants: [], technologies: [], deliverables: [], serviceLines: [], teamRoles: [], links: [] };
const SOURCE = 'Zebracorp Bank claims triage SOW.txt (jane.doe@zebracorp.example)';

// A published record by Lee whose evidence file name carries the client and an email (app.js defaults the source
// name to the uploaded file name). The model stub cites every snippet it is given, evidence first.
async function published() {
  let t = 0;
  const l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 8, 29, 9, 0, t++)).toISOString(), embed: async () => null,
    complete: async m => {
      const sys = m[0].content;
      if (sys.startsWith('You match past')) { const { candidates } = JSON.parse(m[1].content); return JSON.stringify({ results: candidates.map(c => ({ id: c.id, relevance: 90, why: 'fits' })) }); }
      if (sys.startsWith('You write a one-page')) { const inp = JSON.parse(m[1].content); return JSON.stringify({ title: 'T', summary: inp.references.flatMap(r => r.snippets.map(s => ({ text: 'claim', kind: 'fact', cites: [s.id] }))).reverse() }); }
      if (sys.startsWith('You extract')) return JSON.stringify({ requirements: [{ text: 'claims triage evidence', kind: 'capability' }], customer: {} });
      return '{}';
    } });
  const data = { title: 'Claims triage', stage: 'Production', sector: 'Insurance', consultant: { name: 'Lee', role: 'Eng' },
    client: { name: 'Zebracorp Bank', location: 'Lyon', contact: '' }, details: DETAILS,
    answers: ['The client had claims triage delays across regions.', 'I rebuilt claims triage routing for the client.', '', 'Claims triage fell from 40 to 12 minutes.', 'Dashboard shows claims triage times.', ''],
    sources: [{ name: SOURCE, version: 'Zebracorp Bank v2 2026-03-01', excerpt: 'Claims triage times fell from 40 to 12 minutes per claim.' }],
    report: null, validation: { manager: { name: '', email: '' }, managerStaff: true } };
  const s = await l.upsert(LEE, { localId: 'x', reference: data }), row = l.row(s.id);
  l.setState(row, { ...row.state, quality: { status: 'ready', score: 90 }, validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved', by: 't', at: '', note: '' } }, 't', 'validated', '');
  return { l, id: s.id };
}
const onePagerEvidence = async (l, user, refId) => {
  const b = await bids.routes({ method: 'POST', parts: ['bids'], body: { title: 'My bid', alias: 'Project Owl', prospectNames: [], briefText: 'We need claims triage evidence and experience with routing at scale.' }, user, lib: l, env: {} });
  const op = await bids.routes({ method: 'POST', parts: ['bids', b.body.id, 'onepager'], body: { refIds: [refId] }, user, lib: l, env: {} });
  return op.body.footnotes.filter(f => f.kind === 'evidence');
};

test('one-pager footnotes carry the masked source name and version, for a public reader and for the record owner alike', async () => {
  const { l, id } = await published();
  assert.equal(l.access(l.row(id), KIM), 'public'); assert.equal(l.access(l.row(id), LEE), 'full');
  for (const user of [KIM, LEE]) {
    const [f] = await onePagerEvidence(l, user, id);
    assert.equal(f.sourceName, 'the client claims triage SOW.txt ([email])', user.email);
    assert.equal(f.sourceVersion, 'the client v2 2026-03-01', user.email);
    assert.doesNotMatch(JSON.stringify(f), /Zebracorp|@/, 'customer-facing text always uses the record masking');
  }
});

test('Ask: a public reader never gets the raw source name of an evidence snippet', async () => {
  const { l } = await published();
  const a = await ask.routes({ method: 'POST', parts: ['ask'], body: { question: 'claims triage times fell per claim' }, user: KIM, lib: l, env: {} });
  const evidence = a.body.results.flatMap(r => r.snippets).filter(s => s.kind === 'evidence');
  assert.ok(evidence.length);
  for (const s of evidence) assert.equal(s.sourceName, 'the client claims triage SOW.txt ([email])');
  assert.doesNotMatch(JSON.stringify(a.body.results), /Zebracorp|jane\.doe/);
});

test('requirement edits on a bid whose map is full still give the author every typed name back (no membership oracle)', async () => {
  const l = new Library(memorySql(), {});
  // Lee's draft: Kim cannot open it, so its client and contact must not be detectable from Kim's author view.
  await l.upsert(LEE, { localId: 'x', reference: { title: 'Secret project', client: { name: 'Zebracorp', location: 'Lyon', contact: 'Jane Doe' }, details: DETAILS, answers: ['', '', '', '', '', ''] } });
  const call = (method, parts, body) => bids.routes({ method, parts, body, user: KIM, lib: l, env: {} });
  const b = await call('POST', ['bids'], { title: 'Probe', alias: 'Probe bid', prospectNames: [], briefText: 'We need proof of delivery experience and a team that can scale.' });
  // One edit: 11 requirements of 24 distinct emails (264 placeholders) fill the map before the probe requirement.
  const filler = Array.from({ length: 11 }, (_, j) => ({ text: Array.from({ length: 24 }, (_, i) => `u${j * 24 + i}@x.io`).join(' '), kind: 'capability' }));
  assert.ok(filler.every(x => x.text.length <= 240));
  const text = 'Experience with Zebracorp and Jane Doe and Fakeco and John Roe';
  const r = await call('POST', ['bids', b.body.id, 'requirements'], { requirements: [...filler, { text, kind: 'capability' }] });
  assert.equal(r.body.view, 'author');
  assert.equal(r.body.requirements.length, 12);
  assert.equal(r.body.requirements[11].text, text);
  assert.deepEqual(r.body.requirements.slice(0, 11).map(x => x.text), filler.map(x => x.text));
});

// ---- Integration (review #12): the display rule wired at every author-facing model output. Lee's draft names the
// client 'Orange' (a stoplist word of 3 or more characters, matched in every case), which Kim cannot open. Kim's
// lower-case "orange" is masked as a whole word before the model. Alias 'Heron' matches no library client, so the
// first company placeholder is [Company 1] and the map stores the typed span "orange". A library name she never
// typed ('Zebracorp') stays masked, and every other view keeps the full masking.
const REV = { email: 'rev@mantu.com', role: 'reviewer', mail: 'rev@mantu.com' };
async function orangeLibrary(complete) {
  const l = new Library(memorySql(), { complete, embed: null });
  await l.upsert(LEE, { localId: 'o', reference: { title: 'O ref', client: { name: 'Orange' }, details: DETAILS, answers: ['x', '', '', '', '', ''] } });
  await l.upsert(LEE, { localId: 'z', reference: { title: 'Z ref', client: { name: 'Zebracorp' }, details: DETAILS, answers: ['x', '', '', '', '', ''] } });
  const own = await l.upsert(KIM, { localId: 'k', reference: { title: 'Juice logistics', sector: 'Retail', client: { name: 'Acme Foods', location: 'Lyon' }, details: DETAILS,
    answers: ['Supply chain delays for juice.', 'I rebuilt the supply chain planning.', '', 'Delays fell.', '', ''] } });
  return { l, ownId: own.id };
}
const cap = s => s[0].toUpperCase() + s.slice(1);
const echoRank = m => { const { candidates } = JSON.parse(m[1].content); return JSON.stringify({ results: candidates.map(c => ({ id: c.id, relevance: 90, why: 'Orange juice supply chains match.', transferable: ['Orange juice planning'], caveat: 'Unlike Zebracorp, smaller.' })) }); };

test('display rule wired (review #12): bid create keeps the author\'s own echoed word; a library name the author never typed and the other view stay masked', async () => {
  const seen = [];
  const { l } = await orangeLibrary(async m => { seen.push(m[1].content); const first = m[1].content.split(/(?<=\.)\s/)[0];
    return JSON.stringify({ requirements: [{ text: cap(first), kind: 'capability', must: true }, { text: 'Claims routing like Zebracorp is needed.', kind: 'capability' }], customer: {} }); });
  const b = await bids.routes({ method: 'POST', parts: ['bids'], body: { title: 'Juice bid', alias: 'Heron', prospectNames: [], briefText: 'orange juice supply chain experience is required for this tender. More text here.' }, user: KIM, lib: l, env: {} });
  assert.match(seen[0], /^\[Company 1\] juice/);
  assert.deepEqual(b.body.requirements.map(r => r.text), ['orange juice supply chain experience is required for this tender.', 'Claims routing like another client is needed.']);
  const other = await bids.routes({ method: 'GET', parts: ['bids', b.body.id], body: null, user: REV, lib: l, env: {} });
  assert.equal(other.body.view, 'other');
  assert.deepEqual(other.body.requirements.map(r => r.text), ['[company] juice supply chain experience is required for this tender.', 'Claims routing like another client is needed.']);
});

test('display rule wired (review #12): Ask, recommend and slides give the author their own echoed word back and still mask other library names', async () => {
  const { l, ownId } = await orangeLibrary(async m => {
    const sys = m[0].content;
    if (sys.startsWith('You match past')) return echoRank(m);
    if (sys.startsWith('You turn one validated')) return JSON.stringify({ title: 'Orange juice logistics', subtitle: '', summary: 'Orange juice planning, unlike Zebracorp.',
      sections: [{ heading: 'The challenge', bullets: [{ text: 'Orange juice supply chain was slow.', kind: 'fact', source: 'context' }] }] });
    return '{}';
  });
  const a = await ask.routes({ method: 'POST', parts: ['ask'], body: { question: 'Which project covered orange juice supply chains?' }, user: KIM, lib: l, env: {} });
  assert.ok(a.body.results.length);
  for (const r of a.body.results) { assert.equal(r.why, 'another client juice supply chains match.'); assert.equal(r.caveat, 'Unlike another client, smaller.'); }
  const rec = await l.recommend(KIM, { query: 'Meeting an orange juice producer about supply chains' });
  assert.ok(rec.results.length);
  for (const r of rec.results) { assert.equal(r.why, 'another client juice supply chains match.'); assert.deepEqual(r.transferable, ['another client juice planning']); assert.equal(r.caveat, 'Unlike another client, smaller.'); }
  const s = await l.slides(KIM, ownId, { context: 'Pitch to an orange juice producer' });
  assert.equal(s.title, 'another client juice logistics');
  assert.equal(s.summary, 'another client juice planning, unlike another client.');
  assert.equal(s.sections[0].bullets[0].text, 'another client juice supply chain was slow.');
});

test('Ask (spec §2.3 "full access shown raw"): a reader with full access gets the raw source name, like the raw sentence', async () => {
  const { l } = await published();
  const a = await ask.routes({ method: 'POST', parts: ['ask'], body: { question: 'claims triage times fell per claim' }, user: LEE, lib: l, env: {} });
  const evidence = a.body.results.flatMap(r => r.snippets).filter(s => s.kind === 'evidence');
  assert.ok(evidence.length);
  for (const s of evidence) { assert.equal(s.sourceName, SOURCE); assert.match(s.text, /^Claims triage times fell/); }
});

// Integration (review #2/#4 with the map cap gone): create stores only the map entries its stored texts use (alias,
// requirements, customer), so a long brief full of names or addresses no longer stores its whole map. The author still
// reads every stored name back, and no size ever changes what is masked or refused.
test('bid create stores only the map entries the alias, requirements and customer use; the author view is unchanged', async () => {
  const emails = Array.from({ length: 400 }, (_, i) => `person${i}@corp${i}.example`).join(' ');
  const l = new Library(memorySql(), { embed: null, complete: async m => JSON.stringify({ requirements: [{ text: 'Proof of delivery for ' + m[1].content.match(/\[Email \d+\]/)[0], kind: 'capability' }],
    customer: { buyer: 'A buyer called [Company 1].' } }) });
  const b = await bids.routes({ method: 'POST', parts: ['bids'], body: { title: 'Big brief', alias: 'Heron bid', prospectNames: ['Flimflam'],
    briefText: `This tender is for Flimflam. Contacts: ${emails}. We need proof of delivery experience at scale.` }, user: KIM, lib: l, env: {} });
  assert.equal(b.body.view, 'author');
  assert.equal(b.body.requirements[0].text, 'Proof of delivery for person0@corp0.example');
  assert.equal(b.body.customer.buyer, 'A buyer called Flimflam.');
  const stored = JSON.parse(l.rows('SELECT pseudo FROM bids WHERE id = ?', b.body.id)[0].pseudo);
  assert.deepEqual(stored, { '[Company 1]': 'Flimflam', '[Email 1]': 'person0@corp0.example' }, `only used entries are stored (${Object.keys(stored).length} stored)`);
  const again = await bids.routes({ method: 'GET', parts: ['bids', b.body.id], body: null, user: KIM, lib: l, env: {} });
  assert.deepEqual([again.body.requirements[0].text, again.body.customer.buyer], ['Proof of delivery for person0@corp0.example', 'A buyer called Flimflam.']);
});

// Review #7, same class (reviewer probes probe_email*.mjs): util.email validates raw body fields (a reference's
// consultants and N+1, confirmation and gap assignees, staffing CSV cells). A 250,000-character non-address inside a
// 256 KiB body must not stall the one global LibraryStore; real addresses validate as before.
import { email } from '../src/util.js';
test('util.email stays linear on long non-addresses; valid addresses are unchanged', () => {
  for (const s of ['a@' + '.'.repeat(250000) + '@', 'a@' + 'b.'.repeat(120000), 'x'.repeat(250000) + '@y.z']) {
    const t0 = performance.now(), got = email(s), ms = performance.now() - t0;
    assert.equal(got, '', JSON.stringify(s.slice(0, 6)));
    assert.ok(ms < 200, `${JSON.stringify(s.slice(0, 6))}… took ${ms.toFixed(0)} ms`);
  }
  assert.equal(email('  Jane.Doe+x@Mail.Acme.example '), 'jane.doe+x@mail.acme.example');
  assert.equal(email(`${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.example`).length, 200, 'a long valid address keeps today\'s 200-character cut');
  for (const bad of ['', 'no-at', 'a@b', 'a b@c.d', '<a@b.c>']) assert.equal(email(bad), '', bad);
});

// Review #13 residual (handed over by the masking group): the record's own contact typed with a role ("Dupont, CFO")
// has a one-word lead that clientScrub leaves to recordText on model paths. The human public view (Library.get for a
// reader without full access) applies the contact rules to that lead too; a stoplist lead ("Will (CFO)") stays.
test('Library.get public view masks a one-word contact lead under the contact rules; full access is unchanged', async () => {
  const l = new Library(memorySql(), {});
  const mk = async (localId, contact, answer) => {
    const s = await l.upsert(LEE, { localId, reference: { title: 'Claims ' + localId, sector: 'Insurance', consultant: { name: 'Lee', role: 'Eng' }, client: { name: 'Zebracorp Bank', location: 'Lyon', contact }, details: DETAILS,
      answers: [answer, '', '', '', '', ''] } });
    const row = l.row(s.id); l.setState(row, { ...row.state, quality: { status: 'ready', score: 90 }, validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved', by: 't', at: '', note: '' } }, 't', 'validated', '');
    return s.id;
  };
  const a = await mk('a', 'Dupont, CFO', 'Dupont approved the rollout; DUPONT signed. We will ship.');
  const b = await mk('b', 'Will (CFO)', 'Will approved it and we will ship.');
  assert.equal(l.access(l.row(a), KIM), 'public');
  assert.equal(l.get(KIM, a).data.answers[0], 'the client approved the rollout; the client signed. We will ship.');
  assert.equal(l.get(KIM, b).data.answers[0], 'Will approved it and we will ship.', 'a stoplist one-word lead is never masked (it would rewrite every "will")');
  assert.equal(l.get(LEE, a).data.answers[0], 'Dupont approved the rollout; DUPONT signed. We will ship.', 'full access: the record as written');
});
