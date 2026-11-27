// Sweep 01 group 1 logic findings, copied from PR #31
// (96712474b59d6b058ef00479f2bb2d4eb065801e). Other tests in that file
// belong to other groups and are not on this branch. These are not skipped
// and they are not expected failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDocument, retainItems } from '../src/memory.js';
import { draftMessages } from '../src/sheet.js';
import { clientScrub } from '../src/review.js';

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

test('L6 two conversations in the same second get different memory document ids', () => {
  const payload = (said) => ({ localId: 'p-123', conversation: said, title: 'Routing', client: {} });
  const idOf = items => items.find(item => String(item.document_id).startsWith('conversation-')).document_id;
  const early = idOf(retainItems(payload('first'), '2026-09-27T10:00:00.100Z'));
  const late = idOf(retainItems(payload('second'), '2026-09-27T10:00:00.900Z'));
  assert.notEqual(early, late);
});
