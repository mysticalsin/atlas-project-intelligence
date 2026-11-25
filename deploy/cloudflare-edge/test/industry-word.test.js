// A sector boost is a whole word. "Air" does not match inside "repair" or "airline".
// Synthetic records only. No provider call.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as bids from '../src/bids.js';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const OWNER = { email: 'alex@example.test', role: 'user' };
const LEE = { email: 'lee@example.test', role: 'user' };

function reference(title, sector, client) {
  return {
    title,
    stage: 'Production',
    sector,
    consultant: { name: 'Lee Chen', role: 'Engineer' },
    client: { name: client, location: 'Lyon', contact: '' },
    details: {
      projectId: '',
      country: 'France',
      consultants: [],
      technologies: ['Python'],
      deliverables: [],
      serviceLines: ['Data and AI'],
      teamRoles: [],
      links: [],
    },
    answers: ['A fictional queue was slow before the handover to the local team.', 'I owned the routing change for that queue.', '', '', '', ''],
    sources: [],
    report: null,
    validation: { manager: { name: '', email: '' }, managerStaff: true },
  };
}

function library() {
  let t = 0;
  const l = new Library(memorySql(), {
    now: () => new Date(Date.UTC(2026, 10, 25, 12, 0, t++)).toISOString(),
    complete: async () => 'not json',
    embed: async () => [1, 0],
  });
  return l;
}

async function publish(l, data) {
  const saved = await l.upsert(LEE, { localId: data.title, reference: data });
  const row = l.row(saved.id);
  l.setState(row, {
    ...row.state,
    quality: { status: 'ready', score: 90 },
    validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved', by: 'test', at: '', note: '' },
  }, 'test', 'validated', '');
  await l.index(saved.id);
  return saved.id;
}

async function call(l, method, path, body) {
  const url = new URL('https://atlas.test/api/library/' + path);
  const r = await bids.routes({
    method,
    url,
    parts: url.pathname.replace('/api/library/', '').split('/').filter(Boolean),
    body: body || {},
    user: { mail: OWNER.email, ...OWNER },
    lib: l,
    env: {},
    waitUntil: p => p,
  });
  return r.body;
}

async function matchSector(l, text) {
  const brief = 'Synthetic brief for a fictional buyer. The queue needs a past reference before the meeting.';
  const created = await call(l, 'POST', 'bids', {
    title: 'Fictional queue bid',
    alias: 'Blue Heron',
    prospectNames: [],
    briefText: brief,
  });
  const edited = await call(l, 'POST', 'bids/' + created.id + '/requirements', {
    requirements: [{ text, kind: 'sector', must: true }],
  });
  assert.deepEqual(edited.requirements.map(r => [r.kind, r.text]), [['sector', text]]);
  const out = await call(l, 'POST', 'bids/' + created.id + '/match', { limit: 6 });
  assert.equal(out.verdict, 'unranked');
  assert.equal(out.results.length, 3);
  assert.ok(out.results.every(r => r.retrieval === 'semantic' && r.similarity === 1));
  return out.results.map(r => r.id);
}

test('a sector word inside a longer word does not reorder an equal match', async () => {
  const l = library();
  const air = await publish(l, reference('Air queue alias', 'Air', 'Airco'));
  const insurance = await publish(l, reference('Insurance queue alias', 'Insurance', 'Insureco'));
  const retail = await publish(l, reference('Retail queue alias', 'Retail', 'Shopco'));
  const repair = await matchSector(l, 'We must repair the queue for the buyer.');
  assert.deepEqual(repair, [retail, insurance, air]);
  const airline = await matchSector(l, 'We must cover airline operations for the buyer.');
  assert.deepEqual(airline, [retail, insurance, air]);
  const whole = await matchSector(l, 'We must show the air queue for the buyer.');
  assert.equal(whole[0], air);
  const sector = await matchSector(l, 'We must show the insurance sector for the buyer.');
  assert.equal(sector[0], insurance);
});
