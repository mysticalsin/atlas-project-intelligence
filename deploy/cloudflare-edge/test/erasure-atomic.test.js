// A privacy delete is one transaction. A throw on a later manager-trust chunk
// must put every store back and answer with a non-2xx error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, sqlOf } from './hold.js';
import { libraryRoutes } from '../src/library-routes.js';
import { memorySql } from './sqlite.js';
import { ensureJourney } from '../src/journey.js';
import { ensure as ensureProfile } from '../src/profile.js';
import { ensureTelemetry, personaKey } from '../src/telemetry.js';

const NOW = '2026-11-08T00:00:00.000Z';
const TENANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'ada@example.test';

function library() {
  return new Library(memorySql(), { now: () => NOW });
}

function snap(l) {
  return {
    journey: l.rows('SELECT subject, tenant, payload FROM journey ORDER BY subject, tenant'),
    telemetry: l.rows('SELECT id, persona, tenant FROM telemetry ORDER BY id'),
    profiles: l.rows('SELECT subject, tenant FROM profiles ORDER BY subject, tenant'),
    trust: l.rows('SELECT owner, email, tenant FROM manager_trust ORDER BY owner, email, tenant'),
    directory: l.rows('SELECT key, tenant, name FROM directory ORDER BY key, tenant, name'),
  };
}

test('a later manager-trust chunk rolls back every store and the response is not 2xx', async () => {
  const l = library();
  ensureJourney(l);
  ensureProfile(l);
  ensureTelemetry(l);
  const user = { email: EMAIL, mail: EMAIL, role: 'user', tenant: TENANT, tenantEnforced: true };
  const persona = await personaKey(user);
  sqlOf(l).exec('INSERT INTO journey (subject, tenant, payload, updated_at) VALUES (?, ?, ?, ?)', EMAIL, TENANT, '{"title":"Kept"}', NOW);
  sqlOf(l).exec('INSERT INTO journey (subject, tenant, payload, updated_at) VALUES (?, ?, ?, ?)', EMAIL, OTHER, '{"title":"Other"}', NOW);
  sqlOf(l).exec(`INSERT INTO telemetry (id, at, tenant, persona, kind, feature, outcome, latency_ms, tokens_in, tokens_out, token_status, model, error_class)
    VALUES ('tel-ada', ?, ?, ?, 'journey', 'app', 'ok', NULL, NULL, NULL, 'missing', '', '')`, NOW, TENANT, persona);
  sqlOf(l).exec(`INSERT INTO profiles (subject, tenant, email, edits, signin, consents, created_at, updated_at, seen_at)
    VALUES (?, ?, ?, '{}', '{}', '{}', ?, ?, ?)`, EMAIL, TENANT, EMAIL, NOW, NOW, NOW);
  for (let i = 0; i < 101; i++) {
    sqlOf(l).exec('INSERT INTO manager_trust (owner, email, source, tenant, at) VALUES (?, ?, ?, ?, ?)', EMAIL, `mgr-${i}@example.test`, 'directory', TENANT, NOW);
  }
  sqlOf(l).exec('INSERT INTO manager_trust (owner, email, source, tenant, at) VALUES (?, ?, ?, ?, ?)', 'other@example.test', 'kept@example.test', 'directory', TENANT, NOW);
  sqlOf(l).exec(`INSERT INTO directory (key, source, name, given_name, title, manager_name, manager_email, batch, fetched_at, tenant)
    VALUES (?, 'dna', 'Ada', '', '', '', '', 'pull', ?, ?)`, EMAIL, NOW, TENANT);
  const before = snap(l);
  const chunks = [];
  const orig = sqlOf(l).exec.bind(sqlOf(l));
  sqlOf(l).exec = (q, ...p) => {
    if (String(q).startsWith('DELETE FROM manager_trust')) {
      chunks.push(p.length);
      if (p.length === 1) throw new Error('disk');
    }
    return orig(q, ...p);
  };
  const response = await libraryRoutes(new Request('https://atlas.test/api/library/privacy/delete', {
    method: 'POST', body: '{}',
    headers: {
      'x-atlas-user': EMAIL, 'x-atlas-role': 'user', 'x-atlas-email': EMAIL,
      'x-atlas-tenant': TENANT, 'x-atlas-tenant-enforced': '1',
    },
  }), l, { env: { DATA_MODE: 'production', ORIGIN: 'https://atlas.test', CSRF_SECRET: 's' } });
  const body = await response.json();
  assert.deepEqual(chunks, [100, 1]);
  assert.deepEqual(snap(l), before);
  assert.equal(response.ok, false);
  assert.equal(body.error, 'The deletion did not finish. Nothing was removed.');
  assert.equal(body.outcomes, undefined);
});
