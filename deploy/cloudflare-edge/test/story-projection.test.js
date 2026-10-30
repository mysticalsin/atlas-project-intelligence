// Python ↔ JavaScript parity for the success-story audience projection (atlas_voice/success_story.py is the source of
// truth; test/gen_story_parity.py records it into story.vectors.json, and tests/test_edge.py fails when that file is stale).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectForAudience, ProjectionError } from '../src/story-projection.js';
import { STORY_PROJECTION as P } from '../src/policy.generated.js';

const V = JSON.parse(readFileSync(new URL('./story.vectors.json', import.meta.url)));

test('story projection parity: every recorded case', () => {
  assert.ok(V.length > 100, 'vectors recorded');
  for (const [story, audience, expected] of V) {
    const label = JSON.stringify([audience, story]).slice(0, 200);
    if (expected.ok) { assert.deepEqual(projectForAudience(story, audience), expected.ok, label); continue; }
    assert.throws(() => projectForAudience(story, audience), e => {
      assert.ok(e instanceof ProjectionError, label);
      assert.equal(e.code, expected.error, label);
      if (expected.missing) assert.deepEqual(e.missing, expected.missing, label);
      return true;
    }, label);
  }
});

test('the vectors cover accepts, every gate denial, bad audiences and unreadable stories', () => {
  const kinds = new Set(V.map(([, , r]) => r.error || 'ok'));
  for (const k of ['ok', 'denied', 'audience', 'story']) assert.ok(kinds.has(k), k);
  const denied = new Set(V.flatMap(([, , r]) => r.missing || []));
  for (const gate of P.gates.public) assert.ok(denied.has(gate), gate);
});

test('internal notes exist only in the internal projection, whatever the story carries', () => {
  for (const [story, audience, r] of V) {
    if (!r.ok) continue;
    assert.equal('internal_notes' in r.ok, audience === 'internal' && 'internal_notes' in story && typeof story.internal_notes === 'object' && story.internal_notes !== null && ['manager', 'consultant', 'date'].some(k => k in story.internal_notes));
    assert.ok(!('approval_state' in r.ok) && !('unknown_top' in r.ok));
  }
});

test('generated story constants (Python source of truth)', () => {
  assert.deepEqual(P.audiences, ['internal', 'client', 'public']);
  assert.equal(P.kpi_max, 3); assert.deepEqual(P.kpi_statuses, ['measured', 'estimated', 'qualitative']);
  assert.deepEqual(P.gates.client, ['evidence_validated', 'project_owner_approved', 'customer_approved', 'confidentiality_reviewed']);
  assert.deepEqual(P.gates.public, [...P.gates.client, 'brand_approved', 'public_release_authorized']);
  assert.ok(P.public_fields.includes('kpis') && !P.public_fields.some(f => f.startsWith('internal_notes')));
  assert.deepEqual(P.internal_fields, ['internal_notes.manager', 'internal_notes.consultant', 'internal_notes.date']);
});
