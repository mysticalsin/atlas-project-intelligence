// A contact written as a web address used to be cut at the first slash, so the lead was the
// scheme "https:". That scheme was then stored as the client name and matched inside every
// other link. A real client name is still a term and still stops the rating guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contactLead, clientScrub } from '../src/review.js';
import { nameMatcher } from '../src/scrub.js';
import { guard, ownMask, sensitiveTerms } from '../src/rating.js';

test('a web address is not cut down to its scheme', () => {
  assert.equal(contactLead('https://files.example/brief'), '');
  assert.equal(contactLead('http://files.example/brief'), '');
  assert.equal(contactLead('HTTPS://files.example/brief'), '');
  assert.equal(contactLead('Jane Doe https://files.example/brief'), 'Jane Doe');
});

test('a role, an email, and a slash between names still end the leading name', () => {
  assert.equal(contactLead('Jane Doe (Head of Claims)'), 'Jane Doe');
  assert.equal(contactLead('Dupont, CFO'), 'Dupont');
  assert.equal(contactLead('Max Roe <max@x.example>'), 'Max Roe');
  assert.equal(contactLead('Jane Doe - Claims'), 'Jane Doe');
  assert.equal(contactLead('Ada/Lovelace (PO)'), 'Ada');
  assert.equal(contactLead('Jane Doe'), '');
});

test('the scheme from a contact URL is not applied to a different link', () => {
  const lead = contactLead('https://files.example/brief');
  assert.equal(lead, '');
  const mask = nameMatcher([lead].filter(Boolean), { contacts: true });
  assert.equal(mask('The brief is at https://other.example/plan.', () => 'a contact'), 'The brief is at https://other.example/plan.');
});

test('a client name still blocks a story value, and a different link does not', () => {
  const data = { client: { name: 'Zebracorp', contact: 'https://files.example/brief' } };
  const terms = sensitiveTerms(data);
  assert.equal(terms.includes('https:'), false);
  assert.equal(terms.includes('Zebracorp'), true);
  assert.equal(terms.includes('https://files.example/brief'), true);
  const mask = ownMask(data, terms);
  assert.equal(mask('Zebracorp signed the note.'), 'the client signed the note.');
  assert.equal(mask('See https://other.example/plan for the note.'), 'See https://other.example/plan for the note.');
  assert.equal(clientScrub(data)('Zebracorp signed.'), 'the client signed.');
  assert.throws(() => guard(JSON.stringify({ answers: ['Zebracorp improved the queue.'] }), terms), /guard/);
  assert.throws(() => guard(JSON.stringify({ answers: ['See https://files.example/brief today.'] }), terms), /guard/);
  assert.equal(guard(JSON.stringify({ answers: ['See https://other.example/plan today.'] }), terms), true);
});
