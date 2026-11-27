// Sweep 01 group 1 properties. Written red, before the fix. No skip, no expected failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nameMatcher, maskOwnClient } from '../src/name-match.js';
import { scrub, retainItems } from '../src/memory.js';
import { draftMessages } from '../src/sheet.js';
import { clientScrub, contactLead } from '../src/review.js';

const STOPish = ['will', 'air', 'mark', 'total', 'orange'];
const CARRIERS = ['repair', 'aircraft', 'airline'];

test('M1 a three-letter client name is masked in any case', () => {
  const m = nameMatcher(['acme']);
  assert.equal(m('acme, Acme and ACME signed, not acmeware.', () => 'X'), 'X, X and X signed, not acmeware.');
  const ge = nameMatcher(['GE']);
  assert.equal(ge('GE and ge signed.', () => 'X'), 'X and ge signed.');
  assert.equal(ge('GE, ge', () => 'X'), 'X, ge');
});

test('D1 a stoplist client name stays masked and the same word as a contact does not', () => {
  assert.equal(clientScrub({ client: { name: 'Air' } })('air, Air and AIR, not repair.'), 'the client, the client and the client, not repair.');
  assert.equal(clientScrub({ client: { name: 'Will' } })('will, Will and WILL.'), 'the client, the client and the client.');
  assert.equal(clientScrub({ client: { contact: 'Will' } })('will stays will.'), 'will stays will.');
  assert.equal(maskOwnClient({ name: 'Air' })('repair air ducts'), 'repair the client ducts');
  assert.equal(maskOwnClient({ contact: 'Will' }, contactLead('Will'))('will stays'), 'will stays');
});

test('L1 every retain item and sheet field is masked', () => {
  const client = { name: 'acme', location: 'Lyon', contact: 'Ada Lo' };
  const payload = {
    localId: 'p-123',
    title: 'acme rollout',
    stage: 'acme stage',
    sector: 'acme sector',
    consultant: { role: 'acme lead' },
    client,
    details: {
      projectId: 'acme-1', country: 'acme land', start: 'acme start', end: 'acme end', duration: 'acme duration', teamSize: 'acme team',
      technologies: ['acme tech'], deliverables: ['acme deliverable'],
    },
    answers: ['acme context', 'ACME contribution', 'Acme approach', 'acme outcome', 'acme evidence', 'acme relevance'],
    report: { headline: 'acme headline', summary: 'Acme summary', gaps: ['acme gap'], follow_ups: ['acme follow'] },
    conversation: 'we told acme the ACME plan',
  };
  const walk = (value, found) => {
    if (typeof value === 'string') found.push(value);
    else if (Array.isArray(value)) for (const item of value) walk(item, found);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item, found);
    return found;
  };
  for (const text of walk(retainItems(payload, '2026-09-27T10:00:00.100Z'), [])) assert.doesNotMatch(text, /acme/i, text);
  const messages = draftMessages({
    client,
    project: { title: 'acme project', nested: { note: 'ACME note' } },
    current: { exec: { summary: 'acme summary', contacts: 'acme contact' }, sections: { scope: 'acme scope', value: 'Acme value' } },
    answers: 'acme answers',
    documentText: 'acme document ACME',
  });
  for (const text of walk(messages, [])) assert.doesNotMatch(text, /acme/i, text);
});

test('L2 a client name of regex metacharacters is a literal and a pathological name finishes within one second', () => {
  const cases = [
    ['a+', 'a+ and a and acme', 'the client and a and acme'],
    ['(acme)', '(acme) and acme and a', 'the client and acme and a'],
    ['.*', '.* and a and acme', 'the client and a and acme'],
    ['[', '[ and a and acme', 'the client and a and acme'],
    ['\\', '\\ and a and acme', 'the client and a and acme'],
  ];
  for (const [name, text, expected] of cases) assert.equal(maskOwnClient({ name })(text), expected, name);
  const name = 'a+'.repeat(25);
  const t0 = performance.now();
  maskOwnClient({ name })('a'.repeat(4000));
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
});

test('properties: stoplist client names, NFC and NFD, contacts, millisecond ids, and the boundaries', () => {
  for (const name of STOPish) {
    const mask = maskOwnClient({ name });
    const stored = name;
    const titled = name[0].toUpperCase() + name.slice(1);
    for (const spelling of [stored, titled, name.toUpperCase()]) {
      assert.equal(mask(`see ${spelling} now`), 'see the client now', `${name} ${spelling}`);
    }
    for (const carrier of CARRIERS) assert.ok(String(mask(carrier)).includes(carrier), `${name} ${carrier}`);
  }
  for (const word of ['Société Générale', 'Ångström']) {
    const nfc = word.normalize('NFC'), nfd = word.normalize('NFD');
    assert.equal(maskOwnClient({ name: nfd })(`x ${nfc} y`), 'x the client y');
    assert.equal(maskOwnClient({ name: nfc })(`x ${nfd} y`), 'x the client y');
  }
  const contact = 'Jane Doe (Head of Claims)';
  const people = maskOwnClient({ contact }, contactLead(contact));
  assert.equal(people('Jane Doe approved'), 'the client approved');
  assert.equal(people('Janeery stays'), 'Janeery stays');

  const payload = said => ({ localId: 'p-123', conversation: said, title: 'Routing', client: {} });
  const idOf = items => items.find(item => String(item.document_id).startsWith('conversation-')).document_id;
  const projectOf = items => items.find(item => String(item.document_id).startsWith('project-')).document_id;
  const base = '2026-09-27T10:00:00.000Z';
  const early = idOf(retainItems(payload('a'), base));
  for (let ms = 1; ms <= 999; ms++) {
    const stamp = `2026-09-27T10:00:00.${String(ms).padStart(3, '0')}Z`;
    const items = retainItems(payload('b'), stamp);
    assert.notEqual(idOf(items), early, stamp);
    assert.equal(projectOf(items), 'project-p-123');
  }
  assert.equal(idOf(retainItems(payload('same'), base)), idOf(retainItems(payload('same'), base)));

  assert.equal(maskOwnClient({})('acme stays'), 'acme stays');
  assert.equal(maskOwnClient({ name: '' })('acme stays'), 'acme stays');
  assert.equal(maskOwnClient({ name: 'GE' })('GE and ge and Ge'), 'the client and ge and Ge');
  assert.equal(maskOwnClient({ name: 'ibm' })('ibm IBM Ibm'), 'the client the client the client');
  assert.equal(maskOwnClient({ name: 'acme' })('acme ACME'), 'the client the client');
  assert.equal(maskOwnClient({ name: 'abcde' })('abcde ABCDE'), 'the client the client');
  const mail = maskOwnClient({ contact: 'ada@x.example' }, contactLead('ada@x.example'));
  assert.equal(mail('We will ship.'), 'We will ship.');
  assert.equal(clientScrub({ client: { name: 'Acme' } })(12), 12);
  assert.equal(scrub(12, { name: 'Acme' }), 12);
  assert.equal(nameMatcher(['Acme'])(12), 12);
  const bare = '2026-09-27T10:00:00Z';
  assert.equal(idOf(retainItems(payload('x'), bare)), idOf(retainItems(payload('x'), bare)));
  assert.match(idOf(retainItems(payload('x'), bare)), /^conversation-p-123-20260927100000$/);
});
