// Publication reducer: legal revised and derive, every other event rejected, both sides of each guard,
// legacy load and round-trip. The 2560 status goldens stay in publication-golden.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PUBLICATION_EVENTS, PUBLICATION_PHASES, bothApproved, changesRequested, initialPublication, isAdminBypass, isAdminTest, isWithdrawn, loadPublication, publicationStatus, publicationTransition, qualityMissing, qualityReady, validatedFlag } from '../src/publication.js';
import { Library, deriveStatus } from '../src/library.js';
import { memorySql } from './sqlite.js';

const quiet = { log: () => {} };
const phases = {
  in_review: { quality: null, validation: { status: 'pending' } },
  needs_work: { quality: { status: 'needs_work' }, validation: { status: 'pending' } },
  changes_requested: { quality: { status: 'ready' }, validation: { status: 'changes_requested', managerDecision: 'pending', presalesDecision: 'pending' } },
  awaiting_validation: { quality: { status: 'ready' }, validation: { status: 'pending', managerDecision: 'approved', presalesDecision: 'pending' } },
  published: { quality: { status: 'ready' }, validation: { status: 'validated', managerDecision: 'pending', presalesDecision: 'pending' } },
  admin_test: { test: true, validation: { status: 'admin_bypass' } },
  withdrawn: { withdrawn: true, quality: { status: 'ready' }, validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved' } },
};

test('every legal publication transition, and every other (phase, event) pair is rejected and logged', () => {
  const logged = [];
  const log = line => logged.push(line);
  const extras = ['withdraw', 'publish'];
  let legal = 0, illegal = 0;
  for (const phase of PUBLICATION_PHASES) {
    assert.equal(publicationStatus(phases[phase]), phase);
    for (const type of [...PUBLICATION_EVENTS, ...extras]) {
      const event = { type, id: 'story-1', tenant: 'tenant-1', managerStaffIgnored: false };
      const result = publicationTransition(phases[phase], event, { log });
      if (PUBLICATION_EVENTS.includes(type)) {
        legal++;
        assert.equal(result.ok, true, phase + ' ' + type);
        assert.equal(result.illegal, false);
        if (type === 'revised') assert.equal(result.status, 'in_review');
        if (type === 'derive') assert.equal(result.status, phase);
        if (type === 'merged') {
          assert.equal(result.status, 'withdrawn');
          assert.equal(result.state.withdrawn, true);
          assert.equal(result.state.quality, phases[phase].quality);
        }
      } else {
        illegal++;
        assert.equal(result.ok, false, phase + ' ' + type);
        assert.equal(result.illegal, true);
        assert.equal(result.state, phases[phase]);
        assert.ok(Object.keys(logged.at(-1)).every(k => ['atlas_metric', 'id', 'phase', 'event'].includes(k)));
        assert.equal(logged.at(-1).id, 'story-1');
        assert.equal(logged.at(-1).event, type);
      }
    }
  }
  assert.equal(legal, PUBLICATION_PHASES.length * PUBLICATION_EVENTS.length);
  assert.equal(illegal, PUBLICATION_PHASES.length * extras.length);
  assert.equal(logged.length, illegal);
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
  assert.equal(publicationStatus({ quality: { status: 'ready' }, validation: { status: 'validated', managerDecision: 'pending', presalesDecision: 'pending' } }), 'published');
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

test('legacy and unknown snapshots load to a defined state; a story state round-trips', () => {
  assert.equal(publicationStatus(loadPublication(null)), 'in_review');
  assert.equal(publicationStatus(loadPublication('published')), 'in_review');
  const live = phases.published;
  assert.deepEqual(loadPublication(live), live);
  assert.deepEqual(loadPublication(initialPublication()).version, 1);
});
