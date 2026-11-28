import test from 'node:test';
import assert from 'node:assert/strict';
import { libraryFromStorage } from '../src/library-store.js';
import { memorySql } from './sqlite.js';

const ADA = { email: 'ada@example.test', role: 'user' };
const BEA = { email: 'bea@example.test', role: 'user' };
const REV = { email: 'rev@example.test', role: 'reviewer' };
const OUT = { email: 'out@example.test', role: 'user' };

function open() {
  let t = 0;
  const sql = memorySql();
  return libraryFromStorage({ sql, transactionSync: fn => sql.transactionSync(fn) }, {
    now: () => new Date(Date.UTC(2026, 10, 25, 12, 0, t++)).toISOString(),
    auditKey: 'synthetic-salt',
  });
}

function ref(name, title, projectId = 'PRJ-SYN') {
  return {
    title, stage: 'Pilot', sector: 'Insurance',
    consultant: { name, role: 'Data engineer' },
    client: { name: 'Zebracorp', location: 'Lyon', contact: 'Head of Claims' },
    details: { projectId, country: 'France', consultants: [] },
    answers: [
      'The queue was slow for the region.',
      'Personal notes that stay on this consultant story.',
      'The team chose a routing model.',
      'Handling time fell for the whole service.',
      'Dashboard export v3.',
      'Insurers with a manual queue.',
    ],
    validation: { manager: { name: 'Sam', email: 'sam@example.test' }, managerStaff: false },
  };
}

const ADA_SCOPE = 'Ada designed the routing rules for the two pilot teams.';
const BEA_SCOPE = 'Bea trained the operations leads and handed over the runbook.';
const IMPACT = 'The claims service cut handling time for the whole book of business.';

test('a reader sees the whole project impact and each consultant scope', async () => {
  const lib = open();
  const ada = await lib.upsert(ADA, {
    localId: 'ada', reference: ref('Ada', 'Claims routing'),
    consultantAddedValue: { scope: ADA_SCOPE, consent: true },
    projectImpact: { text: IMPACT, consent: true },
  });
  const bea = await lib.upsert(BEA, {
    localId: 'bea', reference: ref('Bea', 'Claims routing handover'),
    consultantAddedValue: { scope: BEA_SCOPE, consent: true },
  });
  const view = lib.get(REV, ada.id).projectView;
  assert.equal(view.projectId, 'PRJ-SYN');
  assert.equal(view.projectImpact.text, IMPACT);
  assert.deepEqual(view.addedValues.map(item => item.consultant), ['Ada', 'Bea']);
  assert.equal(view.addedValues[0].scope, ADA_SCOPE);
  assert.equal(view.addedValues[1].scope, BEA_SCOPE);
  assert.equal(view.addedValues.every(item => item.customerClaim === false), true);
  assert.equal(Object.hasOwn(view, 'score'), false);
  assert.equal(Object.hasOwn(view, 'jev'), false);
  assert.equal(Object.hasOwn(view, 'rank'), false);
  assert.doesNotMatch(JSON.stringify(view), /@/);
  const again = lib.get(REV, bea.id).projectView;
  assert.equal(again.projectImpact.text, IMPACT);
  assert.deepEqual(again.addedValues.map(item => item.scope), [ADA_SCOPE, BEA_SCOPE]);
  const adaRow = lib.row(ada.id);
  assert.equal(adaRow.data.answers[1], 'Personal notes that stay on this consultant story.');
  assert.notEqual(view.projectImpact.text, adaRow.data.answers[3]);
  assert.throws(() => lib.get(OUT, ada.id), /not found/);
});

test('attaching a scope keeps the story revision and hash', async () => {
  const lib = open();
  const ada = await lib.upsert(ADA, { localId: 'ada', reference: ref('Ada', 'Claims routing') });
  const before = lib.row(ada.id);
  const saved = await lib.upsert(ADA, {
    id: ada.id, reference: ref('Ada', 'Claims routing'),
    consultantAddedValue: { scope: ADA_SCOPE, consent: true, storyHash: before.content_hash },
    projectImpact: { text: IMPACT, consent: true },
  });
  const after = lib.row(ada.id);
  assert.equal(after.revision, before.revision);
  assert.equal(after.content_hash, before.content_hash);
  assert.equal(after.status, before.status);
  assert.equal(saved.projectView.addedValues[0].scope, ADA_SCOPE);
  assert.equal(saved.projectView.addedValues[0].revision, 1);
  const updated = await lib.upsert(ADA, {
    id: ada.id, reference: ref('Ada', 'Claims routing'),
    consultantAddedValue: { scope: ADA_SCOPE + ' She also wrote the exception list.', consent: true },
  });
  const kept = lib.row(ada.id);
  assert.equal(kept.revision, before.revision);
  assert.equal(kept.content_hash, before.content_hash);
  assert.equal(updated.projectView.addedValues[0].revision, 2);
  assert.match(updated.projectView.addedValues[0].scope, /exception list/);
  const prior = kept.state.projectShare.scopeRevisions[0];
  assert.equal(prior.text, ADA_SCOPE);
  assert.equal(prior.storyHash, before.content_hash);
  assert.equal(prior.storyRevision, before.revision);
});

test('private memory and a missing consent do not attach or become the project impact', async () => {
  const lib = open();
  await assert.rejects(
    () => lib.upsert(ADA, {
      localId: 'ada', reference: ref('Ada', 'Claims routing'),
      consultantAddedValue: { scope: 'Remembered from a private note.', consent: true, source: 'private-memory' },
    }),
    error => error.status === 400,
  );
  assert.equal(lib.list(ADA).total, 0);
  const ada = await lib.upsert(ADA, { localId: 'ada', reference: ref('Ada', 'Claims routing') });
  const before = lib.row(ada.id);
  await assert.rejects(
    () => lib.upsert(ADA, {
      id: ada.id, reference: ref('Ada', 'Claims routing'),
      consultantAddedValue: { scope: ADA_SCOPE, consent: false },
    }),
    error => error.status === 400,
  );
  await assert.rejects(
    () => lib.upsert(ADA, {
      id: ada.id, reference: ref('Ada', 'Claims routing'),
      consultantAddedValue: { scope: IMPACT, consent: true },
      projectImpact: { text: IMPACT, consent: true },
    }),
    error => error.status === 400,
  );
  const after = lib.row(ada.id);
  assert.equal(after.content_hash, before.content_hash);
  assert.equal(after.state.projectShare, undefined);
  assert.equal(Object.hasOwn(lib.get(ADA, ada.id), 'projectView'), false);
});

test('one consultant cannot replace another consultant scope', async () => {
  const lib = open();
  const ada = await lib.upsert(ADA, {
    localId: 'ada', reference: ref('Ada', 'Claims routing'),
    consultantAddedValue: { scope: ADA_SCOPE, consent: true },
    projectImpact: { text: IMPACT, consent: true },
  });
  await lib.upsert(BEA, {
    localId: 'bea', reference: ref('Bea', 'Claims routing handover'),
    consultantAddedValue: { scope: BEA_SCOPE, consent: true },
  });
  await assert.rejects(
    () => lib.upsert(REV, {
      id: ada.id, reference: ref('Ada', 'Claims routing'),
      consultantAddedValue: { scope: 'A reviewer wrote this scope.', consent: true },
    }),
    error => error.status === 403,
  );
  const view = lib.get(REV, ada.id).projectView;
  assert.deepEqual(view.addedValues.map(item => item.scope), [ADA_SCOPE, BEA_SCOPE]);
  assert.equal(lib.row(ada.id).revision, 1);
});

test('a withdrawn story drops that consultant scope from the current reader view', async () => {
  const lib = open();
  const ada = await lib.upsert(ADA, {
    localId: 'ada', reference: ref('Ada', 'Claims routing'),
    consultantAddedValue: { scope: ADA_SCOPE, consent: true },
  });
  const bea = await lib.upsert(BEA, {
    localId: 'bea', reference: ref('Bea', 'Claims routing handover'),
    consultantAddedValue: { scope: BEA_SCOPE, consent: true },
    projectImpact: { text: IMPACT, consent: true },
  });
  lib.withdraw(ADA, ada.id, { note: 'synthetic withdrawal' });
  const view = lib.get(REV, bea.id).projectView;
  assert.equal(view.projectImpact.text, IMPACT);
  assert.deepEqual(view.addedValues.map(item => item.consultant), ['Bea']);
  assert.equal(lib.row(ada.id).state.projectShare.scopeRevisions[0].text, ADA_SCOPE);
});
