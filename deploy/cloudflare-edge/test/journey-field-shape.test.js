// A journey note is an object: text, source, and confirmation. A bare string must not replace a saved note.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from './hold.js';
import { memorySql } from './sqlite.js';
import { journeyView, saveJourney } from '../src/journey.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

function lib() {
  return new Library(memorySql(), { now: () => '2026-11-08T00:00:00.000Z' });
}

function user() {
  return { email: 'ada@example.test', role: 'user', tenant: TENANT, tenantEnforced: true };
}

test('a bare journey note does not replace a confirmed note', async () => {
  const library = lib();
  const who = user();
  await saveJourney(library, who, { stage: 'project', fields: { title: { value: 'Alias', source: 'you', confirmed: true } } });
  await assert.rejects(
    () => saveJourney(library, who, { stage: 'project', fields: { title: 'Alias renamed' } }),
    (error) => error.status === 400 && /bare value/.test(error.message),
  );
  await assert.rejects(
    () => saveJourney(library, who, { stage: 'project', fields: { personalWork: ['I wrote the plan'] } }),
    (error) => error.status === 400,
  );
  assert.equal(journeyView(library, who).fields.title.value, 'Alias');
  assert.equal(journeyView(library, who).fields.title.confirmed, true);
  assert.equal(journeyView(library, who).fields.title.source, 'you');
  const again = await saveJourney(library, who, { stage: 'project', fields: { title: { value: 'Edited', source: 'you', confirmed: true } } });
  assert.equal(again.fields.title.value, 'Edited');
  assert.equal(again.fields.title.confirmed, true);
});
