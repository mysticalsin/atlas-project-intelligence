// A library recommendation boosts an industry only as its own word in the sector.
// Industry or sector Air does not match repair or airline. Insurance still matches insurance.
// Synthetic records only. No provider call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const OWNER = { email: 'lee@example.test', role: 'user' };

function reference(title, sector) {
  return {
    title,
    stage: 'Production',
    sector,
    consultant: { name: 'Lee Chen', role: 'Engineer' },
    client: { name: 'Example Co', location: 'Lyon', contact: '' },
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

function library(industry) {
  let t = 0;
  return new Library(memorySql(), {
    now: () => new Date(Date.UTC(2026, 10, 25, 12, 0, t++)).toISOString(),
    complete: async () => JSON.stringify({
      industry: industry(),
      audience: 'buyer',
      country: '',
      likely_challenges: [],
      capabilities: [],
      search_text: 'A fictional queue reference for a buyer meeting.',
    }),
    embed: async () => [1, 0],
  });
}

const wholeWord = (sector, word) => new RegExp('(?<![\\p{L}\\p{N}])' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'u').test(sector);

function expectedOrder(l, word) {
  const rows = l.rows('SELECT id, updated_at, data FROM refs WHERE merged_into IS NULL').map(row => ({
    id: row.id,
    at: row.updated_at,
    sector: JSON.parse(row.data).sector.toLowerCase(),
  }));
  const times = rows.map(row => row.at);
  assert.equal(new Set(times).size, times.length);
  rows.sort((a, b) => {
    const boost = sector => (wholeWord(sector, word) ? 1 : 0);
    const delta = boost(b.sector) - boost(a.sector);
    if (delta) return delta;
    return a.at < b.at ? 1 : -1;
  });
  return rows.map(row => row.id);
}

async function recommend(l, industry) {
  const out = await l.recommend(OWNER, { query: 'A buyer meeting needs a past queue reference.', limit: 5 });
  assert.equal(out.target.industry, industry);
  assert.equal(out.results.length, 5);
  assert.ok(out.results.every(row => row.similarity === 1));
  return out.results.map(row => row.id);
}

test('an industry word inside a longer sector word does not reorder an equal match', async () => {
  let industry = 'Air';
  const l = library(() => industry);
  const saved = {};
  for (const [key, sector] of [['repair', 'repair'], ['airline', 'airline'], ['air', 'Air'], ['retail', 'retail'], ['insurance', 'insurance']]) {
    const row = await l.upsert(OWNER, { localId: key, reference: reference(key + ' queue alias', sector) });
    await l.index(row.id);
    saved[key] = row.id;
  }
  const air = await recommend(l, 'Air');
  assert.equal(air[0], saved.air);
  assert.ok(air.indexOf(saved.retail) < air.indexOf(saved.repair));
  assert.ok(air.indexOf(saved.retail) < air.indexOf(saved.airline));
  assert.ok(air.indexOf(saved.insurance) < air.indexOf(saved.repair));
  assert.ok(air.indexOf(saved.insurance) < air.indexOf(saved.airline));
  assert.deepEqual(air, expectedOrder(l, 'air'));

  industry = 'repair';
  const repair = await recommend(l, 'repair');
  assert.equal(repair[0], saved.repair);
  assert.notEqual(repair[0], saved.air);
  assert.deepEqual(repair, expectedOrder(l, 'repair'));

  industry = 'airline';
  const airline = await recommend(l, 'airline');
  assert.equal(airline[0], saved.airline);
  assert.notEqual(airline[0], saved.air);
  assert.deepEqual(airline, expectedOrder(l, 'airline'));

  industry = 'Insurance';
  const insurance = await recommend(l, 'Insurance');
  assert.equal(insurance[0], saved.insurance);
  assert.deepEqual(insurance, expectedOrder(l, 'insurance'));
});
