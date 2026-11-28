// A rating field name is schema. A masked client name that only matches that
// name must still be scored. Synthetic names only. No provider is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { guard, ratingInput } from '../src/rating.js';

const ANSWERS = [
  'The client had a slow queue before the change and missed the cutoff.',
  'I rebuilt the routing step myself.',
  'We kept a manual fallback after comparing two designs.',
  'The queue was shorter on the team dashboard.',
  'Dashboard export v1 from the operations report.',
  'Similar desks with a named owner and a written handover.',
];

function record(name) {
  return {
    title: 'Queue rewrite',
    sector: 'Insurance',
    client: { name, location: 'Lyon', contact: 'Ops' },
    consultant: { name: 'Ada Quinn', role: 'Consultant' },
    answers: ANSWERS,
    details: { projectId: 'PRJ-7', serviceLines: ['Claims'] },
    sources: [],
  };
}

function valuesOf(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) valuesOf(item, out);
  return out;
}

const lib = { rows() { return []; } };

test('a client name that only matches a rating field does not block the guard', () => {
  for (const name of ['Lines', 'Title', 'Approach', 'Story']) {
    const input = ratingInput(lib, record(name));
    const body = JSON.stringify(input.state.reference);
    const values = valuesOf(input.state.reference).join('\n').toLowerCase();
    assert.equal(values.includes(name.toLowerCase()), false, name);
    assert.match(body, /"service_lines"/);
    assert.equal(guard(body, input.terms), true, name);
  }
});

test('a client name left in a rating value still blocks the guard', () => {
  const body = JSON.stringify({ title: 'Queue rewrite', story: { context: 'Lines kept the old queue.' } });
  assert.throws(() => guard(body, ['Lines']), (error) => error.code === 'guard');
});

test('a stoplist word left in a story value still blocks the guard', () => {
  const body = JSON.stringify({ service_lines: ['Claims'], story: { context: 'Similar service desks.' } });
  assert.throws(() => guard(body, ['Service']), (error) => error.code === 'guard');
});
