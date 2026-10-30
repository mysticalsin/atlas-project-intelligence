// Python <-> JavaScript parity for the conversation state machines (plan §3i, D8-D11). atlas_voice/conversation_state.py is the
// source of truth; test/gen_state_parity.py records it into state.vectors.json (tests/test_edge.py fails when that file is stale).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Machine, StateError, WORKFLOW_VERSION, STATES, EVENTS, TRANSITIONS, MACHINES } from '../src/conversation-state.js';

const V = JSON.parse(readFileSync(new URL('./state.vectors.json', import.meta.url)));
const take = (m, [event, actor, reason, at, data]) => m.fire(event, actor, { reason, at, data });
const attempt = (m, step) => { try { take(m, step); return { ok: true }; } catch (e) { assert.ok(e instanceof StateError, String(e)); return { error: e.code }; } };

test('the workflow version and tables are the Python ones', () => {
  assert.equal(WORKFLOW_VERSION, V.workflow_version); assert.equal(WORKFLOW_VERSION, 'atlas-conversation-2.1.0');
  for (const k of MACHINES) assert.deepEqual({ states: STATES[k].states.length, transitions: TRANSITIONS[k].length }, V.tables[k]);
});

for (const [name, c] of Object.entries(V.cases)) {
  test('state machine parity: ' + name, () => {
    const m = new Machine(c.kind);
    c.steps.forEach((step, i) => {
      const before = m.toDict(), got = attempt(m, step), exp = c.results[i];
      if (exp.error) { assert.deepEqual(got, exp, `step ${i} ${step[0]}`); assert.deepEqual(m.toDict(), before, 'an error changes nothing'); }
      else { assert.ok(got.ok, `step ${i} ${step[0]}`); assert.deepEqual({ ok: true, state: m.state, status: m.status }, exp); }
    });
    assert.deepEqual(m.toDict(), c.final); assert.equal(m.terminal, c.terminal); assert.deepEqual(m.availableEvents(), c.available);
    assert.deepEqual(Machine.fromDict(m.toDict()).toDict(), c.final);
  });
}

test('state machine parity: every event from every reachable position (legitimate actor, other actors, missing reason or data)', () => {
  assert.ok(V.matrix.length > 2000);
  for (const [kind, index, probe, exp] of V.matrix) {
    const m = new Machine(kind); V.positions[kind][index].forEach(step => take(m, step));
    const before = m.toDict(), got = attempt(m, probe), label = `${kind}#${index} ${JSON.stringify(probe)}`;
    if (exp.error) { assert.deepEqual(got, exp, label); assert.deepEqual(m.toDict(), before, label); continue; }
    assert.deepEqual({ state: m.state, focus: m.focus, returns: m.returns, skipped: m.skipped, status: m.status, audit: m.audit.length }, exp, label);
  }
});

test('snapshot restore parity: good snapshots round-trip, tampered or foreign ones fail with the same code', () => {
  for (const { name, dict, result } of V.restore) {
    if (result.error) assert.throws(() => Machine.fromDict(dict), e => e instanceof StateError && e.code === result.error, name);
    else assert.deepEqual(Machine.fromDict(dict).toDict(), result.dict, name);
  }
});

test('legal and illegal moves, and the audit entry', () => {
  const m = new Machine('interview'), at = '2026-11-01T10:00:00.000Z';
  assert.equal(m.state, 'welcome'); assert.equal(m.status, 'identified');
  assert.throws(() => m.fire('submit', 'user'), e => e.code === 'unknown_event');
  assert.throws(() => m.fire('confirm_summary', 'user'), e => e.code === 'illegal_transition');
  assert.equal(m.fire('start', 'atlas', { at }), 'purpose_permissions');
  assert.deepEqual(m.audit, [{ from: 'welcome', to: 'purpose_permissions', event: 'start', actor: 'atlas', at, workflow_version: WORKFLOW_VERSION, reason: null }]);
  assert.throws(() => m.fire('consent_given', 'atlas'), e => e.code === 'actor_not_allowed');
  const n = new Machine(); n.fire('start', 'user'); assert.match(n.audit[0].at, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/); // `at` defaults to the clock
});

test('the evidence machine: reject needs a reason, no shortcut to approved, withdrawal after approval goes to impact review', () => {
  const m = new Machine('evidence');
  m.fire('submit', 'user'); m.fire('enqueue', 'system'); m.fire('reject', 'reviewer', { reason: 'metric has no source' });
  assert.equal(m.state, 'rejected');
  assert.throws(() => m.fire('approve', 'reviewer'), e => e.code === 'illegal_transition');
  assert.throws(() => m.fire('close_rejected', 'reviewer'), e => e.code === 'reason_required');
  const n = new Machine('evidence'); n.fire('submit', 'user'); n.fire('enqueue', 'system'); n.fire('approve', 'reviewer');
  assert.throws(() => n.fire('enqueue', 'system'), e => e.code === 'illegal_transition');
  assert.equal(n.fire('withdraw', 'user', { reason: 'client objected' }), 'impact_review');
  assert.deepEqual(EVENTS.evidence.withdraw.actors, ['user']);
});
