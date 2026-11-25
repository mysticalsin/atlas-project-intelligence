// The name guessed from an email capitalises a letter after an apostrophe.
// Synthetic addresses only. No provider, Entra, Hindsight, or Teams calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emailGuess, resolveProfile } from '../src/profile.js';
import { Library } from './hold.js';
import { memorySql } from './sqlite.js';

test('an apostrophe in the email local part keeps the following letter capital', () => {
  assert.deepEqual(emailGuess("patrick.o'brien@example.test"), { name: "Patrick O'Brien", givenName: 'Patrick' });
  assert.deepEqual(emailGuess("o'brien.smith@example.test"), { name: "O'Brien Smith", givenName: "O'Brien" });
  assert.deepEqual(emailGuess("d'almeida.ana@example.test"), { name: "D'Almeida Ana", givenName: "D'Almeida" });
  assert.deepEqual(emailGuess('tony.walteur@example.test'), { name: 'Tony Walteur', givenName: 'Tony' });
  assert.deepEqual(emailGuess('j.dupont@example.test'), { name: 'J. Dupont' });
});

test('a sign-in with no name claim shows that apostrophe guess', async () => {
  const lib = new Library(memorySql(), { now: () => '2026-09-29T10:00:00.000Z' });
  const user = { email: "patrick.o'brien@example.test", mail: "patrick.o'brien@example.test", role: 'user' };
  const seen = await resolveProfile(lib, { DATA_MODE: 'test' }, user, {});
  assert.equal(seen.guessed, true);
  assert.equal(seen.fields.name.from, 'guess');
  assert.equal(seen.fields.name.value, "Patrick O'Brien");
  assert.equal(seen.fields.preferredName.value, 'Patrick');
});
