// Publication reducer: legal revised and derive, every other event rejected, both sides of each guard,
// legacy load and round-trip. The 2560 status goldens stay in publication-golden.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PUBLICATION_EVENTS, PUBLICATION_PHASES, PUBLICATION_VERSION, approvalUnknown, bothApproved, canPublish, changesRequested, initialPublication, isAdminBypass, isAdminTest, isWithdrawn, knownDecision, knownValidation, loadPublication, mergedAway, publicationEffect, publicationPairs, publicationStatus, publicationTransition, qualityMissing, qualityReady, readPublication, validatedFlag } from '../src/publication.js';
import { Library, acceptPublication, deriveStatus } from '../src/library.js';
import { memorySql } from './sqlite.js';

const quiet = { log: () => {} };
const phases = {
  in_review: { quality: null, validation: { status: 'pending' } },
  needs_work: { quality: { status: 'needs_work' }, validation: { status: 'pending' } },
  changes_requested: { quality: { status: 'ready' }, validation: { status: 'changes_requested', managerDecision: 'pending', presalesDecision: 'pending' } },
  awaiting_validation: { quality: { status: 'ready' }, validation: { status: 'pending', managerDecision: 'approved', presalesDecision: 'pending' } },
  published: { quality: { status: 'ready' }, validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved' } },
  admin_test: { test: true, validation: { status: 'admin_bypass' } },
  withdrawn: { withdrawn: true, quality: { status: 'ready' }, validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved' } },
};

function payload(type, phase) {
  const event = { type, id: 'story-1', tenant: 'tenant-1' };
  if (type === 'revised') return { ...event, managerStaffIgnored: false };
  if (type === 'reviewed') return { ...event, quality: phases[phase].quality ?? null };
  if (type === 'decided') return { ...event, lane: 'manager', decision: 'approved', by: 'sam@example.test', at: '2026-11-11T00:00:00.000Z', note: '' };
  if (type === 'admin_published') return { ...event, test: phases[phase].test === true, by: 'admin@example.test', at: '2026-11-11T00:00:00.000Z' };
  if (type === 'reinstated') return { ...event, mergedInto: '' };
  return event;
}

test('every legal publication transition, and every other real (phase, event) pair is rejected', () => {
  const legal = publicationPairs();
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => warns.push(args);
  const product = [];
  let accepted = 0, rejected = 0;
  try {
  for (const phase of PUBLICATION_PHASES) {
    assert.equal(publicationStatus(phases[phase]), phase);
    for (const type of PUBLICATION_EVENTS) {
      const key = phase + ':' + type;
      product.push(key);
      const result = publicationTransition(phases[phase], payload(type, phase));
      if (legal.has(key)) {
        accepted++;
        assert.equal(result.ok, true, key);
        assert.equal(result.illegal, false);
        assert.equal(result.rejection, undefined);
        assert.ok(PUBLICATION_PHASES.includes(result.status), key);
        if (type === 'revised') {
          assert.equal(result.status, 'in_review');
          assert.equal(result.state.version, PUBLICATION_VERSION);
        }
        if (type === 'derive') assert.equal(result.status, phase);
        if (type === 'merged' || type === 'withdrawn') {
          assert.equal(result.status, 'withdrawn');
          assert.equal(result.state.withdrawn, true);
        }
        if (type === 'merged') assert.equal(result.state.quality, phases[phase].quality);
        if (type === 'reinstated') assert.equal(result.state.withdrawn, false);
        if (type === 'reviewed') {
          assert.equal(result.state.quality, phases[phase].quality ?? null);
          assert.equal(!!result.state.withdrawn, !!phases[phase].withdrawn);
          assert.equal(!!result.state.test, !!phases[phase].test);
          assert.deepEqual(result.state.validation, phases[phase].validation);
        }
        if (type === 'decided' || type === 'admin_published') assert.ok(result.state.validation);
      } else {
        rejected++;
        assert.equal(result.ok, false, key);
        assert.equal(result.illegal, true);
        assert.equal(result.state, phases[phase]);
        assert.equal(result.rejection.event, type);
        assert.ok(Object.keys(result.rejection).every(k => ['atlas_metric', 'id', 'phase', 'event'].includes(k)));
      }
    }
  }
  } finally { console.warn = original; }
  const illegal = product.filter(key => !legal.has(key));
  assert.equal(warns.length, 0, 'the transition does not log');
  assert.equal(product.length, PUBLICATION_PHASES.length * PUBLICATION_EVENTS.length);
  assert.equal(accepted, legal.size);
  assert.equal(rejected, illegal.length);
  assert.deepEqual(illegal.sort(), [
    'admin_test:reinstated',
    'awaiting_validation:reinstated',
    'changes_requested:reinstated',
    'in_review:reinstated',
    'needs_work:reinstated',
    'published:reinstated',
    'withdrawn:admin_published',
    'withdrawn:decided',
    'withdrawn:withdrawn',
  ]);
  assert.deepEqual([...PUBLICATION_EVENTS], ['revised', 'derive', 'merged', 'reviewed', 'decided', 'admin_published', 'withdrawn', 'reinstated']);
});

test('guards: withdrawn, admin bypass, quality, changes, validated flag, both approvals', () => {
  const ready = { quality: { status: 'ready' }, validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved' } };
  assert.equal(isWithdrawn({ withdrawn: true }), true);
  assert.equal(isWithdrawn({ withdrawn: false }), false);
  assert.equal(isAdminBypass({ validation: { status: 'admin_bypass' } }), true);
  assert.equal(isAdminBypass({ validation: { status: 'pending' } }), false);
  assert.equal(isAdminTest({ test: true, validation: { status: 'admin_bypass' } }), true);
  assert.equal(isAdminTest({ test: false, validation: { status: 'admin_bypass' } }), false);
  assert.equal(qualityMissing({}), true);
  assert.equal(qualityMissing({ quality: { status: 'ready' } }), false);
  assert.equal(qualityReady({ quality: { status: 'ready' } }), true);
  assert.equal(qualityReady({ quality: { status: 'needs_work' } }), false);
  assert.equal(changesRequested({ validation: { status: 'pending', managerDecision: 'changes_requested' } }), true);
  assert.equal(changesRequested({ validation: { status: 'pending', managerDecision: 'approved', presalesDecision: 'pending' } }), false);
  assert.equal(validatedFlag({ validation: { status: 'validated', managerDecision: 'pending', presalesDecision: 'pending' } }), true);
  assert.equal(validatedFlag({ validation: { status: 'pending', managerDecision: 'approved', presalesDecision: 'approved' } }), false);
  assert.equal(bothApproved(ready), true);
  assert.equal(bothApproved({ validation: { managerDecision: 'approved', presalesDecision: 'pending' } }), false);
  assert.equal(canPublish(ready), true);
  assert.equal(canPublish({ validation: { status: 'validated', managerDecision: 'pending', presalesDecision: 'pending' } }), false);
  assert.equal(canPublish({ validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'pending' } }), false);
  const held = { quality: { status: 'ready' }, validation: { status: 'validated', managerDecision: 'pending', presalesDecision: 'pending' } };
  assert.equal(publicationStatus(held), 'awaiting_validation');
  assert.equal(publicationEffect(held), null);
  assert.equal(publicationStatus({ quality: { status: 'ready' }, validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved' } }), 'published');
  assert.equal(knownValidation('pending'), true);
  assert.equal(knownValidation('legacy'), false);
  assert.equal(knownDecision('approved'), true);
  assert.equal(knownDecision(null), false);
  assert.equal(approvalUnknown({ validation: { status: 'validated', managerDecision: 'pending', presalesDecision: 'pending' } }), false);
  assert.equal(approvalUnknown({ validation: { status: 'legacy', managerDecision: 'approved', presalesDecision: 'approved' } }), true);
  const unknown = { id: 'story-9', quality: { status: 'ready' }, validation: { status: 'legacy', managerDecision: 'approved', presalesDecision: 'approved' } };
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => warns.push(args);
  let phase;
  try { phase = publicationStatus(unknown); }
  finally { console.warn = original; }
  assert.equal(phase, 'awaiting_validation');
  assert.equal(warns.length, 0, 'publicationStatus does not log');
  const effect = publicationEffect(unknown, { event: 'derive' });
  assert.deepEqual(Object.keys(effect).sort(), ['atlas_metric', 'event', 'id', 'phase']);
  assert.equal(effect.id, 'story-9');
  assert.equal(effect.event, 'derive');
  console.warn = (...args) => warns.push(args);
  try { assert.equal(deriveStatus(unknown), 'awaiting_validation'); }
  finally { console.warn = original; }
  assert.equal(warns.length, 1);
  assert.deepEqual(JSON.parse(warns[0][0]), effect);
});

test('revised reopens approvals from any phase and keeps fields the event does not own', () => {
  const prior = { ...phases.published, sharedWith: ['a@example.test'], duplicates: [{ id: 'other' }], ratingGen: 4, tenant: 'old' };
  const result = publicationTransition(prior, { type: 'revised', id: 'story-1', tenant: 'kept', managerStaffIgnored: true }, quiet);
  assert.equal(result.status, 'in_review');
  assert.equal(result.state.quality, null);
  assert.equal(result.state.withdrawn, false);
  assert.equal(result.state.test, false);
  assert.equal(result.state.tenant, 'kept');
  assert.deepEqual(result.state.validation, { status: 'pending', managerDecision: 'pending', presalesDecision: 'pending', by: '', at: '', note: '', managerStaffIgnored: true });
  assert.deepEqual(result.state.sharedWith, ['a@example.test']);
  assert.equal(result.state.ratingGen, 4);
  assert.equal(result.state.duplicates[0].id, 'other');
});

test('merge stores the status the merged event returned', async () => {
  let t = 0;
  const l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 8, 27, 0, 0, t++)).toISOString() });
  const reviewer = { email: 'rev@example.test', role: 'reviewer' };
  const keep = await l.upsert({ email: 'ada@example.test', role: 'user' }, { localId: 'keep', reference: { title: 'Keep' } });
  const gone = await l.upsert({ email: 'kim@example.test', role: 'user' }, { localId: 'gone', reference: { title: 'Gone' } });
  await l.merge(reviewer, { keep: keep.id, merge: gone.id });
  const row = l.row(gone.id);
  assert.equal(row.merged_into, keep.id);
  assert.equal(row.state.withdrawn, true);
  assert.equal(row.status, 'withdrawn');
  assert.equal(row.status, deriveStatus(row.state));
});

test('legacy and unknown snapshots load to a safe state and are not rewritten', () => {
  assert.equal(publicationStatus(loadPublication(null)), 'in_review');
  assert.equal(publicationStatus(loadPublication('published')), 'in_review');
  const legacy = { ...phases.published };
  const unknown = { ...phases.published, version: 99 };
  assert.equal(publicationStatus(loadPublication(legacy)), 'published');
  assert.equal(loadPublication(legacy).validation.status, 'validated');
  assert.equal(loadPublication(unknown).version, 99);
  assert.equal(loadPublication(unknown).validation.status, 'validated');
  const viewed = readPublication(unknown);
  assert.equal(viewed.status, 'in_review');
  assert.equal(viewed.state.version, 99);
  assert.equal(viewed.state.validation.status, 'validated');
  assert.equal(legacy.version, undefined);
  assert.equal(unknown.version, 99);
  assert.equal(unknown.validation.status, 'validated');
  const live = { ...phases.published, version: PUBLICATION_VERSION };
  assert.deepEqual(loadPublication(live), live);
  assert.equal(loadPublication(initialPublication()).version, PUBLICATION_VERSION);
});

test('reinstated rejects a merged row from every phase and does not clear withdrawn', () => {
  for (const phase of PUBLICATION_PHASES) {
    assert.equal(mergedAway({ mergedInto: 'keep-id' }), true);
    assert.equal(mergedAway({ mergedInto: '' }), false);
    const prior = phases[phase];
    const result = publicationTransition(prior, { type: 'reinstated', id: 'story-1', mergedInto: 'keep-id' });
    assert.equal(result.ok, false, phase);
    assert.equal(result.state, prior);
    assert.equal(!!result.state.withdrawn, !!prior.withdrawn);
  }
});

test('reinstate names a merge only when merged_into is set', async () => {
  let t = 0;
  const l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 8, 27, 0, 0, t++)).toISOString() });
  const owner = { email: 'ada@example.test', role: 'user' };
  const reviewer = { email: 'rev@example.test', role: 'reviewer' };
  const keep = await l.upsert(owner, { localId: 'keep', reference: { title: 'Keep' } });
  const gone = await l.upsert({ email: 'kim@example.test', role: 'user' }, { localId: 'gone', reference: { title: 'Gone' } });
  await l.merge(reviewer, { keep: keep.id, merge: gone.id });
  assert.throws(() => l.reinstate(reviewer, gone.id), e => e.status === 409 && e.message === 'This reference was merged into another one.');
  const live = await l.upsert(owner, { localId: 'live', reference: { title: 'Live' } });
  assert.throws(() => l.reinstate(reviewer, live.id), e => e.status === 409 && e.message === 'That publication change is not allowed.');
  assert.equal(l.rows('SELECT status FROM refs WHERE id = ?', live.id)[0].status, 'in_review');
  const paused = await l.upsert(owner, { localId: 'paused', reference: { title: 'Paused' } });
  l.withdraw(owner, paused.id, { note: 'pause' });
  assert.equal(l.reinstate(reviewer, paused.id).status, 'in_review');
});

test('reinstate rejects a merged story and leaves the stored row withdrawn', async () => {
  let t = 0;
  const l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 8, 27, 0, 0, t++)).toISOString() });
  const reviewer = { email: 'rev@example.test', role: 'reviewer' };
  const keep = await l.upsert({ email: 'ada@example.test', role: 'user' }, { localId: 'keep', reference: { title: 'Keep' } });
  const gone = await l.upsert({ email: 'kim@example.test', role: 'user' }, { localId: 'gone', reference: { title: 'Gone' } });
  await l.merge(reviewer, { keep: keep.id, merge: gone.id });
  assert.throws(() => l.reinstate(reviewer, gone.id), e => e.status === 409 && /merged/.test(e.message));
  const row = l.row(gone.id);
  assert.equal(row.merged_into, keep.id);
  assert.equal(row.state.withdrawn, true);
  assert.equal(row.status, 'withdrawn');
});

test('a status write conflicts when the stored revision changed', async () => {
  let t = 0;
  const l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 8, 27, 0, 0, t++)).toISOString() });
  const owner = { email: 'ada@example.test', role: 'user' };
  const saved = await l.upsert(owner, { localId: 'one', reference: { title: 'One' } });
  const exec = l.sql.exec.bind(l.sql);
  let armed = true;
  l.sql.exec = (q, ...p) => {
    const text = String(q);
    if (armed && text.includes('UPDATE refs SET state = ?')) {
      armed = false;
      exec('UPDATE refs SET revision = revision + 1 WHERE id = ?', saved.id);
    }
    return exec(q, ...p);
  };
  const before = l.row(saved.id);
  assert.throws(() => l.withdraw(owner, saved.id, { note: 'pause' }), e => e.status === 409 && /changed/.test(e.message));
  const after = l.row(saved.id);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.status, before.status);
  assert.equal(after.state.withdrawn, false);
});

test('a decided event with a bad lane or decision is illegal and is not accepted', () => {
  const prior = phases.published;
  const bad = [
    { type: 'decided', id: 'story-1', lane: 'owner', decision: 'approved' },
    { type: 'decided', id: 'story-1', lane: 'manager', decision: 'rejected' },
    { type: 'decided', id: 'story-1', lane: '', decision: 'approved' },
    { type: 'decided', id: 'story-1' },
  ];
  for (const event of bad) {
    const result = publicationTransition(prior, event);
    assert.equal(result.ok, false, JSON.stringify(event));
    assert.equal(result.illegal, true);
    assert.equal(result.state, prior);
    assert.equal(result.rejection.event, 'decided');
    assert.equal(acceptPublication(result, { id: 'story-1', event: 'decided' }), null);
  }
});

test('an unknown version stays withdrawn and is not overlaid or persisted', async () => {
  let t = 0;
  const l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 8, 27, 0, 0, t++)).toISOString() });
  const owner = { email: 'ada@example.test', role: 'user' };
  const saved = await l.upsert(owner, { localId: 'paused', reference: { title: 'Paused' } });
  const stored = { ...l.row(saved.id).state, version: 99, withdrawn: true };
  const json = JSON.stringify(stored);
  l.sql.exec('UPDATE refs SET state = ?, status = ? WHERE id = ?', json, 'published', saved.id);
  const read = l.row(saved.id);
  assert.equal(read.status, 'withdrawn');
  assert.equal(read.state.withdrawn, true);
  assert.equal(read.state.version, 99);
  assert.equal(read.storedStatus, 'published');
  const raw = l.rows('SELECT state, status FROM refs WHERE id = ?', saved.id)[0];
  assert.equal(raw.state, json);
  assert.equal(raw.status, 'published');
  l.sql.exec('UPDATE refs SET next_review = ? WHERE id = ?', '2000-01-01T00:00:00.000Z', saved.id);
  assert.equal(l.scanStale(), 0);
  assert.equal(l.rows('SELECT state, status FROM refs WHERE id = ?', saved.id)[0].state, json);
});

test('an unknown-version row reads as not published and the stored JSON stays unchanged', async () => {
  let t = 0;
  const l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 8, 27, 0, 0, t++)).toISOString() });
  const owner = { email: 'ada@example.test', role: 'user' };
  const saved = await l.upsert(owner, { localId: 'one', reference: { title: 'One' } });
  const stored = {
    ...l.row(saved.id).state,
    version: 99,
    quality: { status: 'ready', score: 90 },
    withdrawn: false,
    test: false,
    validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved', by: 't', at: '', note: '' },
  };
  const json = JSON.stringify(stored);
  l.sql.exec('UPDATE refs SET state = ?, status = ? WHERE id = ?', json, 'published', saved.id);
  const read = l.row(saved.id);
  assert.equal(read.status, 'in_review');
  assert.equal(read.state.version, 99);
  assert.equal(read.state.validation.status, 'validated');
  assert.equal(read.storedStatus, 'published');
  const raw = l.rows('SELECT state, status FROM refs WHERE id = ?', saved.id)[0];
  assert.equal(raw.state, json);
  assert.equal(raw.status, 'published');
  const withdrawn = l.withdraw(owner, saved.id, { note: 'stop' });
  assert.equal(withdrawn.status, 'withdrawn');
  assert.equal(l.rows('SELECT status FROM refs WHERE id = ?', saved.id)[0].status, 'withdrawn');
});
