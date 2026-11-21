// Sweep 01 logic findings. Each test encodes the behaviour main should have.
// They fail on main. They are not skipped and they are not expected failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDocument, retainItems } from '../src/memory.js';
import { draftMessages } from '../src/sheet.js';
import { clientScrub } from '../src/review.js';
import { publicationTransition, initialPublication } from '../src/publication.js';
import { email } from '../src/util.js';
import { Session } from '../src/session.js';
import { LANGUAGES, GREETINGS, WELCOME_BACK, FILLERS, unfinished } from '../src/languages.js';
import { transition, initialBreaker, blocked } from '../src/breaker.js';
import * as profile from '../src/profile.js';
import * as features from '../src/features.js';
import * as bids from '../src/bids.js';
import { Library, sqlOf } from './hold.js';
import { memorySql } from './sqlite.js';

const lib = () => new Library(memorySql(), { now: () => '2026-11-21T00:00:00.000Z' });

test('H1 memory scrub keeps ordinary words and still removes a client name', () => {
  const doc = projectDocument({
    title: 'Routing',
    answers: ['The repair of the aircraft will continue.'],
    client: { name: 'Air', location: 'Lyon', contact: 'Will' },
  });
  assert.match(doc, /repair/);
  assert.match(doc, /aircraft/);
  assert.match(doc, /\bwill\b/i);
});

test('H1 memory scrub removes a client name whether the record stored it decomposed', () => {
  const name = 'Société Générale';
  const doc = projectDocument({
    title: 'Claims',
    answers: [`Work for ${name} continues.`],
    client: { name: name.normalize('NFD') },
  });
  assert.doesNotMatch(doc, /Société|Generale|Générale/);
});

test('H1 sheet scrub keeps ordinary words when the client is Air or Will', () => {
  const messages = draftMessages({
    client: { name: 'Air', contact: 'Will' },
    documentText: 'The repair of the aircraft will continue.',
  });
  const body = messages.find(m => m.role === 'user').content;
  assert.match(body, /repair/);
  assert.match(body, /aircraft/);
  assert.match(body, /\bwill\b/i);
});

test('M1 a one-word contact on the stoplist does not rewrite that ordinary word', () => {
  const scrub = clientScrub({ client: { contact: 'Will' } });
  assert.equal(scrub('We will ship the dashboard.'), 'We will ship the dashboard.');
});

test('M1 a multi-word contact is still removed from model text', () => {
  const scrub = clientScrub({ client: { contact: 'Jane Doe (Head of Claims)' } });
  assert.equal(scrub('Jane Doe approved the change.'), 'the client approved the change.');
});

test('M2 a later approval keeps an earlier change-request note', () => {
  const asked = publicationTransition(initialPublication(), {
    type: 'decided', lane: 'manager', decision: 'changes_requested',
    note: 'Name the dashboard and the period.', by: 'manager@example.test', at: '2026-11-21T00:00:00.000Z',
  });
  assert.equal(asked.ok, true);
  const approved = publicationTransition(asked.state, {
    type: 'decided', lane: 'presales', decision: 'approved', note: '',
    by: 'presales@example.test', at: '2026-11-21T00:01:00.000Z',
  });
  assert.equal(approved.ok, true);
  assert.match(JSON.stringify(approved.state), /Name the dashboard and the period/);
});

test('M3 a shorter contribution that sits inside the kept answer is still attributed', async () => {
  const store = lib();
  const reviewer = { email: 'rev@example.test', mail: 'rev@example.test', role: 'reviewer' };
  const kept = 'I designed and built the routing model and ran the pilot with two teams.';
  const retired = 'I designed and built the routing model';
  const answers = line => ['', line, '', '', '', ''];
  const keeper = await store.upsert(
    { email: 'kim@example.test', mail: 'kim@example.test', role: 'user' },
    { localId: 'kept-story', reference: { title: 'Kept story', answers: answers(kept) } },
  );
  const gone = await store.upsert(
    { email: 'ada@example.test', mail: 'ada@example.test', role: 'user' },
    { localId: 'retired-story', reference: { title: 'Retired story', answers: answers(retired) } },
  );
  await store.merge(reviewer, { keep: keeper.id, merge: gone.id });
  const text = store.row(keeper.id).data.answers[1];
  assert.match(text, /Contribution by another consultant:/);
  assert.match(text, /I designed and built the routing model/);
});

test('M4 a gap answer cannot name a reference the assignee cannot open in full', async () => {
  const store = lib();
  const owner = { email: 'olivia@example.test', mail: 'olivia@example.test', role: 'user' };
  const alex = { email: 'alex@example.test', mail: 'alex@example.test', role: 'user' };
  const kim = { email: 'kim@example.test', mail: 'kim@example.test', role: 'user' };
  const published = await store.upsert(alex, { localId: 'alex-story', reference: { title: 'Claims triage', consultant: { name: 'Alex', role: 'Lead' } } });
  sqlOf(store).exec("UPDATE refs SET status = 'published' WHERE id = ?", published.id);
  const hidden = await store.upsert(kim, { localId: 'kim-story', reference: { title: 'Hidden story', consultant: { name: 'Kim', role: 'Lead' } } });
  bids.ensure(store);
  const clock = '2026-11-21T00:00:00.000Z';
  sqlOf(store).exec(`INSERT INTO bids (id, owner, owner_mail, title, alias, prospects, brief, pseudo, requirements, customer, req_method, status, outcome, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'b1', owner.email, owner.email, 'Synthetic bid', 'Alias', '[]', 'Brief', '{}',
    JSON.stringify([{ id: 'R1', text: 'A proof point', kind: 'capability', must: true }]),
    '{}', 'manual', 'open', 'pending', clock, clock);
  const call = async (method, path, user, body = {}) => {
    const url = new URL('https://atlas.example.test/api/library/' + path);
    const parts = url.pathname.replace(/^\/api\/library\/?/, '').split('/').filter(Boolean);
    const ctx = { request: new Request(url, { method }), url, method, parts, body, user, lib: store, env: {}, waitUntil: p => p };
    try {
      const r = await features.featureRoutes(ctx, (word, env) => features.readyGate(word, env, () => true));
      return { status: r.status || 200, body: r.body };
    } catch (e) {
      if (!e.status) throw e;
      return { status: e.status, body: { error: e.message } };
    }
  };
  const created = await call('POST', 'gaps', owner, { bidId: 'b1', requirementIds: ['R1'], assignee: { refId: published.id, person: 0 } });
  assert.equal(created.status, 201, created.body?.error || 'gap created');
  const before = sqlOf(store).exec('SELECT reference_id, status FROM gap_requests WHERE id = ?', created.body.id).toArray()[0];
  const answered = await call('POST', `gaps/${created.body.id}/answer`, alex, {
    results: [{ askId: 'G1', status: 'answered_unverified', quotes: ['A quote.'] }],
    referenceId: hidden.id,
  });
  const after = sqlOf(store).exec('SELECT reference_id, status FROM gap_requests WHERE id = ?', created.body.id).toArray()[0];
  assert.equal(answered.status, 403);
  assert.equal(after.status, 'open');
  assert.equal(after.reference_id, before.reference_id);
});

test('L1 two long addresses that differ after 200 characters stay distinct', () => {
  const local = 'a'.repeat(64);
  const host = 'b'.repeat(130);
  const first = `${local}@${host}.example.com`;
  const second = `${local}@${host}.example.org`;
  assert.ok(first.length > 200 && first.length <= 254);
  assert.ok(second.length > 200 && second.length <= 254);
  const storedFirst = email(first);
  const storedSecond = email(second);
  if (storedFirst === '' && storedSecond === '') return;
  assert.equal(storedFirst, first);
  assert.equal(storedSecond, second);
});

test('L2 acknowledgements rotate through the whole English list', () => {
  const session = Object.create(Session.prototype);
  session.admin = false;
  session.timeUp = false;
  session.fillerTurn = -2;
  session.lastFiller = -1;
  session.spoken = () => 'en';
  const text = 'one two three four five six seven eight nine ten eleven twelve thirteen';
  const heard = [];
  for (let turn = 1; turn <= 8; turn++) {
    session.turns = turn;
    const filler = session.pickFiller(text);
    if (filler) heard.push(filler);
  }
  assert.deepEqual(heard, ['Okay.', 'Right.', 'I see.', 'Yeah.']);
});

test('L3 every advertised language has a greeting, a welcome back, and fillers', () => {
  for (const code of Object.keys(LANGUAGES)) {
    assert.equal(typeof GREETINGS[code], 'string', code);
    assert.equal(typeof WELCOME_BACK[code], 'string', code);
    assert.ok(Array.isArray(FILLERS[code]) && FILLERS[code].length > 0, code);
  }
});

test('L3 an unfinished check in Japanese does not use the English trailing-word list', () => {
  assert.equal(unfinished('プロジェクトの範囲 and', 'ja'), false);
});

test('L4 a failure that opens the breaker records a finite quiet period', () => {
  let state = initialBreaker();
  state = transition(state, { type: 'fail', now: 0 }).state;
  state = transition(state, { type: 'fail', now: 0 }).state;
  const opened = transition(state, { type: 'fail' });
  assert.equal(opened.ok, true);
  assert.equal(opened.state.phase, 'open');
  assert.equal(Number.isFinite(opened.state.until), true);
  assert.equal(blocked(opened.state, null, 1000), 'circuit_open');
});

test('L5 profile retention compares instants, and keeps a seen_at it cannot parse', () => {
  const store = lib();
  const tenant = 'abcdefab-cdef-4abc-8def-0123456789ab';
  profile.ensure(store);
  const now = '2026-11-21T00:00:00.000Z';
  const cutoff = new Date(Date.parse(now) - 395 * 86400000).toISOString();
  const sameInstant = cutoff.replace(/Z$/, '+00:00');
  assert.equal(Date.parse(cutoff), Date.parse(sameInstant));
  const older = new Date(Date.parse(cutoff) - 86400000).toISOString();
  const insert = (subject, seen) => sqlOf(store).exec(
    'INSERT INTO profiles (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    subject, tenant, subject, '{}', '{}', '{}', seen, seen, seen,
  );
  insert('same-z@example.test', cutoff);
  insert('same-offset@example.test', sameInstant);
  insert('older@example.test', older);
  insert('unparsed@example.test', 'not-a-date');
  profile.daily(store, now, { tenantEnforced: true, tenant });
  const left = store.rows('SELECT email FROM profiles').map(r => r.email);
  assert.ok(left.includes('same-offset@example.test'));
  assert.ok(left.includes('same-z@example.test'));
  assert.ok(left.includes('unparsed@example.test'));
  assert.equal(left.includes('older@example.test'), false);
});

test('L6 two conversations in the same second get different memory document ids', () => {
  const payload = (said) => ({ localId: 'p-123', conversation: said, title: 'Routing', client: {} });
  const idOf = items => items.find(item => String(item.document_id).startsWith('conversation-')).document_id;
  const early = idOf(retainItems(payload('first'), '2026-09-27T10:00:00.100Z'));
  const late = idOf(retainItems(payload('second'), '2026-09-27T10:00:00.900Z'));
  assert.notEqual(early, late);
});
