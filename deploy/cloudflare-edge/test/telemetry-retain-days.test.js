// The privacy disclosure names the telemetry period the purge keeps.
// A setting under 7 days, over 3650 days, blank, or not a number must not be shown as a different period.
import test from 'node:test';
import assert from 'node:assert/strict';
import { privacyRoutes } from '../src/operate.js';
import { purgeTelemetry, recordUsage } from '../src/telemetry.js';
import { Library } from './hold.js';
import { memorySql } from './sqlite.js';

const NOW = '2026-11-08T00:00:00.000Z';
const user = {
  email: 'ada@example.test',
  role: 'admin',
  tenant: '11111111-1111-4111-8111-111111111111',
  tenantEnforced: true,
};

function library() {
  return new Library(memorySql(), { now: () => NOW });
}

async function disclosed(raw) {
  const env = raw === undefined ? {} : { ATLAS_TELEMETRY_DAYS: raw };
  const result = await privacyRoutes({ method: 'GET', user, parts: ['privacy', 'disclosure'], env, lib: {} });
  const body = JSON.parse(JSON.stringify(result.body));
  return body.retention.appTelemetryDays;
}

test('the privacy disclosure names the telemetry period the purge keeps', async () => {
  const cases = [
    [undefined, 180],
    ['30', 30],
    ['7', 7],
    ['3', 7],
    ['6', 7],
    ['5000', 3650],
    ['0', 180],
    ['-4', 7],
    ['1e309', 3650],
    ['nope', 180],
  ];
  for (const [raw, want] of cases) {
    const days = await disclosed(raw);
    assert.equal(days, want, String(raw));
    assert.equal(typeof days, 'number', String(raw));
    assert.equal(purgeTelemetry(library(), days, user).retainDays, want, String(raw));
  }
});

test('a three-day setting still keeps a row inside the seven-day floor', async () => {
  const lib = library();
  await recordUsage(lib, user, { at: '2026-11-03T00:00:00.000Z', kind: 'usage', tokenStatus: 'missing' });
  await recordUsage(lib, user, { at: '2026-10-31T00:00:00.000Z', kind: 'usage', tokenStatus: 'missing' });
  const env = { ATLAS_TELEMETRY_DAYS: '3' };
  const disclosedDays = await disclosed('3');
  const purged = await privacyRoutes({
    method: 'POST', user, parts: ['privacy', 'purge-telemetry'], env, lib,
  });
  assert.equal(disclosedDays, 7);
  assert.equal(purged.body.retainDays, 7);
  assert.equal(purged.body.purged, 1);
  assert.equal(lib.rows('SELECT at FROM telemetry').map(row => row.at).join(','), '2026-11-03T00:00:00.000Z');
});
