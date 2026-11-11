// Row 9 characterization. Every combination deriveStatus distinguishes, plus merged_into,
// which it ignores. The reducer must reproduce these strings. Nothing here is logged:
// a rejection log would be an id, a phase and an event, and this file does not print story text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, deriveStatus } from '../src/library.js';
import { memorySql } from './sqlite.js';

// Pinned mapping of library.js deriveStatus. Kept here so a change to the function fails
// this file instead of updating itself.
function pinned(state) {
  if (state.withdrawn) return 'withdrawn';
  const v = state.validation || {};
  if (v.status === 'admin_bypass') {
    if (state.test) return 'admin_test';
    if (!state.quality) return 'in_review';
    if (state.quality.status !== 'ready') return 'needs_work';
    return 'published';
  }
  if (!state.quality) return 'in_review';
  if (state.quality.status !== 'ready') return 'needs_work';
  if (v.status === 'changes_requested' || v.managerDecision === 'changes_requested' || v.presalesDecision === 'changes_requested') return 'changes_requested';
  if (v.managerDecision === 'approved' && v.presalesDecision === 'approved') return 'published';
  return 'awaiting_validation';
}

const WITHDRAWN = [false, true];
const TEST = [false, true];
const QUALITY = [null, { status: 'ready' }, { status: 'needs_work' }, { status: 'insufficient' }];
const VSTATUS = [undefined, 'pending', 'validated', 'changes_requested', 'admin_bypass'];
const DECISION = [undefined, 'pending', 'approved', 'changes_requested'];
const MERGED = [undefined, 'keep-id'];

function stateOf(w, testFlag, quality, status, manager, presales, merged) {
  const validation = {};
  if (status !== undefined) validation.status = status;
  if (manager !== undefined) validation.managerDecision = manager;
  if (presales !== undefined) validation.presalesDecision = presales;
  const state = { withdrawn: w, test: testFlag, quality, validation };
  if (merged !== undefined) state.merged_into = merged;
  return state;
}

test('deriveStatus: every distinguished field combination, and merged_into changes nothing', () => {
  let n = 0;
  for (const w of WITHDRAWN) for (const testFlag of TEST) for (const quality of QUALITY)
    for (const status of VSTATUS) for (const manager of DECISION) for (const presales of DECISION) {
      const bare = stateOf(w, testFlag, quality, status, manager, presales);
      const got = deriveStatus(bare);
      assert.equal(got, pinned(bare), JSON.stringify({ w, testFlag, quality: quality?.status ?? null, status, manager, presales }));
      for (const merged of MERGED) {
        const withMerge = stateOf(w, testFlag, quality, status, manager, presales, merged);
        assert.equal(deriveStatus(withMerge), got);
        n++;
      }
    }
  assert.equal(n, WITHDRAWN.length * TEST.length * QUALITY.length * VSTATUS.length * DECISION.length * DECISION.length * MERGED.length);
});

// The oracle at 5133aa5, before both approvals were required. Used only to name the rows that moved.
function pinnedBeforeBothRequired(state) {
  if (state.withdrawn) return 'withdrawn';
  const v = state.validation || {};
  if (v.status === 'admin_bypass') {
    if (state.test) return 'admin_test';
    if (!state.quality) return 'in_review';
    if (state.quality.status !== 'ready') return 'needs_work';
    return 'published';
  }
  if (!state.quality) return 'in_review';
  if (state.quality.status !== 'ready') return 'needs_work';
  if (v.status === 'changes_requested' || v.managerDecision === 'changes_requested' || v.presalesDecision === 'changes_requested') return 'changes_requested';
  if (v.status === 'validated' || (v.managerDecision === 'approved' && v.presalesDecision === 'approved')) return 'published';
  return 'awaiting_validation';
}

test('the only golden rows that move are validated without both approvals', () => {
  const changed = [];
  let rows = 0, moved = 0;
  for (const w of WITHDRAWN) for (const testFlag of TEST) for (const quality of QUALITY)
    for (const status of VSTATUS) for (const manager of DECISION) for (const presales of DECISION) {
      const bare = stateOf(w, testFlag, quality, status, manager, presales);
      const before = pinnedBeforeBothRequired(bare);
      const after = pinned(bare);
      rows++;
      assert.equal(deriveStatus(bare), after);
      if (before !== after) {
        moved++;
        assert.equal(before, 'published');
        assert.equal(after, 'awaiting_validation');
        changed.push({ withdrawn: w, test: testFlag, quality: quality.status, status, manager: manager === undefined ? 'missing' : manager, presales: presales === undefined ? 'missing' : presales });
      }
      for (const merged of MERGED) assert.equal(deriveStatus(stateOf(w, testFlag, quality, status, manager, presales, merged)), after);
    }
  assert.equal(rows, 1280);
  assert.equal(moved, 16);
  assert.equal(moved * MERGED.length, 32);
  assert.deepEqual(changed, [
    { withdrawn: false, test: false, quality: 'ready', status: 'validated', manager: 'missing', presales: 'missing' },
    { withdrawn: false, test: false, quality: 'ready', status: 'validated', manager: 'missing', presales: 'pending' },
    { withdrawn: false, test: false, quality: 'ready', status: 'validated', manager: 'missing', presales: 'approved' },
    { withdrawn: false, test: false, quality: 'ready', status: 'validated', manager: 'pending', presales: 'missing' },
    { withdrawn: false, test: false, quality: 'ready', status: 'validated', manager: 'pending', presales: 'pending' },
    { withdrawn: false, test: false, quality: 'ready', status: 'validated', manager: 'pending', presales: 'approved' },
    { withdrawn: false, test: false, quality: 'ready', status: 'validated', manager: 'approved', presales: 'missing' },
    { withdrawn: false, test: false, quality: 'ready', status: 'validated', manager: 'approved', presales: 'pending' },
    { withdrawn: false, test: true, quality: 'ready', status: 'validated', manager: 'missing', presales: 'missing' },
    { withdrawn: false, test: true, quality: 'ready', status: 'validated', manager: 'missing', presales: 'pending' },
    { withdrawn: false, test: true, quality: 'ready', status: 'validated', manager: 'missing', presales: 'approved' },
    { withdrawn: false, test: true, quality: 'ready', status: 'validated', manager: 'pending', presales: 'missing' },
    { withdrawn: false, test: true, quality: 'ready', status: 'validated', manager: 'pending', presales: 'pending' },
    { withdrawn: false, test: true, quality: 'ready', status: 'validated', manager: 'pending', presales: 'approved' },
    { withdrawn: false, test: true, quality: 'ready', status: 'validated', manager: 'approved', presales: 'missing' },
    { withdrawn: false, test: true, quality: 'ready', status: 'validated', manager: 'approved', presales: 'pending' },
  ]);
});

test('validated does not publish unless both lanes approved', () => {
  const ready = { status: 'ready' };
  const bothPending = { quality: ready, validation: { status: 'validated', managerDecision: 'pending', presalesDecision: 'pending' } };
  assert.equal(deriveStatus(bothPending), 'awaiting_validation');
  for (const [manager, presales] of [['approved', 'pending'], ['pending', 'approved']]) {
    assert.equal(deriveStatus({ quality: ready, validation: { status: 'validated', managerDecision: manager, presalesDecision: presales } }), 'awaiting_validation', manager + '/' + presales);
    assert.equal(deriveStatus({ quality: ready, validation: { status: 'pending', managerDecision: manager, presalesDecision: presales } }), 'awaiting_validation', 'without the flag ' + manager + '/' + presales);
  }
});

test('named publication inputs', () => {
  const ready = { status: 'ready' };
  assert.equal(deriveStatus({ quality: ready, validation: { status: 'validated', managerDecision: 'pending', presalesDecision: 'pending' } }), 'awaiting_validation', 'validated without both approvals does not publish');
  assert.equal(deriveStatus({ quality: ready, validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved' } }), 'published', 'validated with both approvals still publishes');
  assert.equal(deriveStatus({ quality: ready, validation: { status: 'pending', managerDecision: 'approved', presalesDecision: 'pending' } }), 'awaiting_validation', 'one approval is not both');
  assert.equal(deriveStatus({ quality: ready, validation: { status: 'validated', managerDecision: 'changes_requested', presalesDecision: 'approved' } }), 'changes_requested', 'a changes request is checked before the validated flag');
  assert.equal(deriveStatus({ test: true, validation: { status: 'admin_bypass' } }), 'admin_test', 'admin test with no approvals and no quality');
  assert.equal(deriveStatus({ test: false, validation: { status: 'admin_bypass', managerDecision: 'pending', presalesDecision: 'pending' } }), 'in_review', 'admin bypass with no quality is still in review');
  assert.equal(deriveStatus({ test: false, quality: ready, validation: { status: 'admin_bypass' } }), 'published', 'admin bypass of a ready story publishes with no approvals');
  assert.equal(deriveStatus({ withdrawn: true, merged_into: 'other', quality: ready, validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved' } }), 'withdrawn');
  assert.equal(deriveStatus({ withdrawn: false, merged_into: 'other', quality: ready, validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved' } }), 'published', 'merged_into is not a status input');
  assert.equal(deriveStatus({ quality: { status: 'needs_work' }, validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved' } }), 'needs_work');
  assert.equal(deriveStatus({ quality: { status: 'insufficient' }, validation: { status: 'pending' } }), 'needs_work');
  assert.equal(deriveStatus({ validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved' } }), 'in_review', 'validated with no quality is not published');
});

test('unknown validation status or decision derives awaiting_validation or in_review, never published', () => {
  const ready = { status: 'ready' };
  const qualities = [null, ready, { status: 'needs_work' }];
  const statuses = [...VSTATUS, 'legacy', '', null];
  const decisions = [...DECISION, 'legacy', '', null];
  let n = 0;
  for (const quality of qualities) for (const status of statuses) for (const manager of decisions) for (const presales of decisions) {
    const known = VSTATUS.includes(status) && DECISION.includes(manager) && DECISION.includes(presales);
    if (known) continue;
    const state = { quality, validation: { status, managerDecision: manager, presalesDecision: presales } };
    const got = deriveStatus(state);
    const expect = quality && quality.status === 'ready' ? 'awaiting_validation' : 'in_review';
    assert.equal(got, expect);
    assert.notEqual(got, 'published');
    n++;
  }
  assert.equal(n, qualities.length * (statuses.length * decisions.length * decisions.length - VSTATUS.length * DECISION.length * DECISION.length));
  assert.equal(deriveStatus({ withdrawn: true, quality: ready, validation: { status: 'legacy', managerDecision: 'approved', presalesDecision: 'approved' } }), 'withdrawn');
  assert.equal(deriveStatus({ quality: ready, validation: { status: 'validated', managerDecision: 'pending', presalesDecision: 'pending' } }), 'awaiting_validation');
  assert.equal(deriveStatus({ quality: ready, validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved' } }), 'published');
});

const OWNER = { email: 'alex@mantu.com', role: 'user' };
const N1 = { email: 'sam@mantu.com', role: 'user' };
const PRE = { email: 'pre@mantu.com', role: 'presales' };
const SYS = { email: 'directory', role: 'system' };
const REF = () => ({
  title: 'Claims triage alias', stage: 'Production', sector: 'Insurance',
  consultant: { name: 'Alex', role: 'Data engineer' },
  client: { name: 'Zebracorp', location: 'Lyon', contact: 'Head of Claims' },
  details: { projectId: 'PRJ-1', country: 'France', start: '2024-03', end: '2024-11', teamSize: 6, teamRoles: ['Data engineer'], technologies: ['Python'], deliverables: ['Routing model'], serviceLines: ['Data & AI'], consultants: [], links: [] },
  answers: ['A queue was slow for customers across the region.', 'I designed and built the routing model and ran the pilot.', 'We kept a manual fallback.', 'Triage time fell, measured on the operations dashboard.', 'Dashboard export, two quarters.', 'A service desk with a measurable queue would benefit.'],
  validation: { manager: { name: 'Sam', email: 'sam@mantu.com' }, managerStaff: false },
});
const GOOD = JSON.stringify({ score: 90, client_value_clear: true, issues: [], recommendations: [], summary: 'Strong.' });

test('after a revision, validation.status is reset and the unapproved revision does not derive published', async () => {
  let t = 0;
  const l = new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 8, 27, 0, 0, t++)).toISOString(), complete: async () => GOOD });
  const a = await l.upsert(OWNER, { localId: 'p1', reference: REF() });
  await l.review(OWNER, a.id);
  l.bindTrust(SYS, { owner: OWNER.email, email: N1.email, source: 'directory', sandbox: true });
  l.validate(N1, a.id, { decision: 'validate', lane: 'manager' });
  l.validate(PRE, a.id, { decision: 'validate', lane: 'presales' });
  const published = l.get(OWNER, a.id);
  assert.equal(published.status, 'published');
  assert.equal(published.state.validation.status, 'validated');
  assert.equal(published.state.validation.managerDecision, 'approved');
  assert.equal(published.state.validation.presalesDecision, 'approved');
  const changed = REF();
  changed.answers[3] += ' The second quarter held.';
  const revised = await l.upsert(OWNER, { id: a.id, reference: changed });
  const row = l.get(OWNER, a.id);
  assert.equal(revised.revision, 2);
  assert.equal(row.state.validation.status, 'pending');
  assert.equal(row.state.validation.managerDecision, 'pending');
  assert.equal(row.state.validation.presalesDecision, 'pending');
  assert.equal(row.state.quality, null);
  assert.equal(row.state.withdrawn, false);
  assert.equal(deriveStatus(row.state), 'in_review');
  assert.equal(row.status, 'in_review');
  assert.notEqual(row.status, 'published');
});
