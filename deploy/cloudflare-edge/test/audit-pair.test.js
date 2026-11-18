// A tenant business write and its audit line are one commit. A throw after the
// write, still inside that transaction, leaves neither the row nor the audit line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const SALT = 'synthetic-log-salt';
const STAMP = '2026-11-16T00:00:00.000Z';
const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = { email: 'ada@example.test', mail: 'ada@example.test', role: 'user', tenant: TENANT, tenantEnforced: true };
const REF = () => ({
  title: 'Claims triage alias', stage: 'Production', sector: 'Insurance',
  consultant: { name: 'Ada', role: 'Data engineer' },
  client: { name: 'Zebracorp', location: 'Lyon', contact: 'Head of Claims' },
  details: { projectId: 'PRJ-1', country: 'France', start: '2024-03', end: '2024-11', teamSize: 6, teamRoles: ['Data engineer'], technologies: ['Python'], deliverables: ['Routing model'], serviceLines: ['Data & AI'], consultants: [], links: [] },
  answers: ['Zebracorp had claims bouncing between three teams, slowing payouts for customers across the region.', 'I designed and built the routing model and ran the pilot with two teams.',
    'We compared rules against a model, chose the model, and kept a manual fallback for edge cases.', 'Triage fell from 40 to 12 minutes per claim according to the operations dashboard.',
    'Operations dashboard export v3, before and after quarters.', 'Any insurer or service desk with manual routing and a measurable queue would benefit.'],
  validation: { manager: { name: 'Sam', email: 'sam@example.test' }, managerStaff: false },
});

function count(lib, table, where = '', ...params) {
  return lib.sql.exec(`SELECT COUNT(*) AS n FROM ${table}${where ? ' WHERE ' + where : ''}`, ...params).toArray()[0].n;
}

test('a tenant story write and its audit line commit or roll back together', async () => {
  const sql = memorySql();
  const lib = new Library(sql, { now: () => STAMP, auditKey: SALT });
  const saved = await lib.upsert(OWNER, { localId: 'ok', reference: REF() });
  assert.equal(count(lib, 'refs', 'id = ?', saved.id), 1);
  assert.equal(count(lib, 'audit', "id = ? AND action = 'created'", saved.id), 1);
  assert.equal(lib.row(saved.id).tenant, TENANT);

  const real = sql.exec.bind(sql);
  let armed = true;
  sql.exec = (query, ...params) => {
    const text = String(query);
    const storyWrite = text.includes('INSERT INTO refs') || text.includes('UPDATE refs SET title');
    if (armed && storyWrite) {
      armed = false;
      real(query, ...params);
      throw new Error('disk');
    }
    return real(query, ...params);
  };
  await assert.rejects(() => lib.upsert(OWNER, { localId: 'boom', reference: REF() }), /disk/);
  assert.equal(count(lib, 'refs', 'local_id = ?', 'boom'), 0, 'the story row rolled back');
  assert.equal(count(lib, 'revisions', 'id != ?', saved.id), 0, 'the revision rolled back');
  assert.equal(count(lib, 'audit', "action IN ('created', 'revised') AND id != ?", saved.id), 0, 'the audit line rolled back');
  assert.equal(count(lib, 'refs', 'id = ?', saved.id), 1);
  assert.equal(count(lib, 'audit', "id = ? AND action = 'created'", saved.id), 1);
});
