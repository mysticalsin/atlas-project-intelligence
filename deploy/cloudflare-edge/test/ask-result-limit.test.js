// A finite Ask limit of zero used to be read as "missing" and returned the default
// of six matches. The smallest page is one. Synthetic library rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as ask from '../src/ask.js';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const KIM = { email: 'kim@example.test', role: 'user', mail: 'kim@example.test' };
const LEE = { email: 'lee@example.test', role: 'user' };
const EMBED = async text => [/claims|triage/i.test(text) ? 1 : 0, 0.05, 0, 0];
const echo = ({ candidates }) => JSON.stringify({
  results: candidates.map((c, i) => ({ id: c.id, relevance: 90 - i * 10, why: 'match', caveat: '' })),
});

function reference(title, client, answer) {
  return {
    title, stage: 'Production', sector: 'Insurance',
    consultant: { name: 'Lee Chen', role: 'Data engineer' },
    client: { name: client, location: 'Lyon', contact: '' },
    details: {
      projectId: '', country: 'France', consultants: [], technologies: ['Python'],
      deliverables: [], serviceLines: ['Data'], teamRoles: [], links: [],
    },
    answers: [answer, '', '', '', '', ''],
    sources: [], report: null,
    validation: { manager: { name: '', email: '' }, managerStaff: true },
  };
}

async function publish(lib, data) {
  const saved = await lib.upsert(LEE, { localId: data.title, reference: data });
  const row = lib.row(saved.id);
  lib.setState(row, {
    ...row.state,
    quality: { status: 'ready', score: 90 },
    validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved', by: 't', at: '', note: '' },
  }, 't', 'validated', '');
  await lib.index(saved.id);
}

async function library() {
  let tick = 0;
  const lib = new Library(memorySql(), {
    now: () => new Date(Date.UTC(2026, 8, 29, 9, 0, tick++)).toISOString(),
    complete: async messages => echo(JSON.parse(messages[1].content)),
    embed: EMBED,
  });
  await publish(lib, reference('Claims triage one', 'Northco', 'The claims queue was slow before the change.'));
  await publish(lib, reference('Claims triage two', 'Southco', 'Claims triage needed a second queue for the night team.'));
  await publish(lib, reference('Claims triage three', 'Eastco', 'A third claims desk still sorted the same queue by hand.'));
  return lib;
}

async function askCount(lib, limit) {
  const body = { question: 'Which claims triage references do we have?' };
  if (limit !== undefined) body.limit = limit;
  const response = await ask.routes({ method: 'POST', parts: ['ask'], body, user: KIM, lib, env: {} });
  return response.body.results.length;
}

test('a missing ask limit stays at six and a finite number clamps to 1..8', () => {
  assert.equal(ask.resultLimit(undefined), 6);
  assert.equal(ask.resultLimit(null), 6);
  assert.equal(ask.resultLimit(''), 6);
  assert.equal(ask.resultLimit('nope'), 6);
  assert.equal(ask.resultLimit(0), 1);
  assert.equal(ask.resultLimit(0.4), 1);
  assert.equal(ask.resultLimit(-1), 1);
  assert.equal(ask.resultLimit(-0.5), 1);
  assert.equal(ask.resultLimit(1), 1);
  assert.equal(ask.resultLimit(1.6), 2);
  assert.equal(ask.resultLimit(8), 8);
  assert.equal(ask.resultLimit(9), 8);
});

test('a zero ask limit returns one match, not the default page', async () => {
  const lib = await library();
  assert.equal(await askCount(lib, undefined), 3);
  assert.equal(await askCount(lib, 0), 1);
  assert.equal(await askCount(lib, 0.4), 1);
  assert.equal(await askCount(lib, -1), 1);
  assert.equal(await askCount(lib, 1), 1);
  assert.equal(await askCount(lib, 2), 2);
});
