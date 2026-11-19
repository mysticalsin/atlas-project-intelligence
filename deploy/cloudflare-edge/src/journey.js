// Consultant journey state. Confirmed fields are human-asserted. Blocked stages name the missing
// integration and do not call DNA, MAP, Spotlight, Teams or any other network endpoint.

import { str, obj, fail, email } from './util.js';
import { recordUsage } from './telemetry.js';

export const STAGES = Object.freeze([
  { id: 'project', title: 'Identify the project', group: 'consultant' },
  { id: 'prefill', title: 'Source-backed prefill', group: 'consultant' },
  { id: 'resume', title: 'MeChat résumé', group: 'consultant' },
  { id: 'skills', title: 'DNA skill proposal', group: 'consultant', blocked: 'dna' },
  { id: 'roles', title: 'Possible role matches', group: 'consultant' },
  { id: 'map', title: 'MAP annual review', group: 'consultant', blocked: 'map' },
  { id: 'review', title: 'Project review', group: 'review' },
  { id: 'spotlight', title: 'Spotlight reference', group: 'review', blocked: 'spotlight' },
]);

export const BLOCKED = Object.freeze({
  dna: {
    status: 'BLOCKED_EXTERNAL',
    system: 'DNA ERP',
    reason: 'No DNA schema or endpoint is configured. ATLAS will not invent one or write skills, certifications or HR records.',
    needs: ['A documented DNA API from the system owner', 'Field mapping reviewed by HR and the DPO', 'A separate approval before any write'],
  },
  map: {
    status: 'BLOCKED_EXTERNAL',
    system: 'MAP annual review',
    reason: 'No MAP schema or endpoint is configured. The draft below is local and is not submitted to a review system.',
    needs: ['A documented MAP export contract', 'Confirmation that a draft is not an official performance rating'],
  },
  spotlight: {
    status: 'BLOCKED_EXTERNAL',
    system: 'Spotlight Ref',
    reason: 'No Spotlight endpoint is configured. A reference can be prepared here and still needs the publication rules before anyone outside the record should rely on it.',
    needs: ['A documented Spotlight import contract', 'Client-confidentiality and IP approval', 'Trusted manager and bid/pre-sales approval for non-admins'],
  },
});

// Fixed illustrative catalog. Not an HR system and not a ranking of people for an adverse decision.
const ROLE_CATALOG = Object.freeze([
  { id: 'data-delivery', title: 'Data delivery consultant', skills: ['data', 'python', 'analysis'] },
  { id: 'service-design', title: 'Service design consultant', skills: ['workshop', 'process', 'design'] },
  { id: 'cloud-engineering', title: 'Cloud engineering consultant', skills: ['cloud', 'platform', 'automation'] },
]);

const SOURCES = new Set(['you', 'directory', 'staffing', 'document', 'interview']);

export function ensureJourney(lib) {
  lib.schema(() => ensureJourneySchema(lib));
}
function ensureJourneySchema(lib) {
  const exists = lib.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'journey'")[0];
  if (!exists) {
    lib.exec(`CREATE TABLE journey (
      subject TEXT NOT NULL, tenant TEXT NOT NULL DEFAULT '', payload TEXT, updated_at TEXT,
      PRIMARY KEY (subject, tenant))`);
    ensureJourneyIndex(lib);
    return;
  }
  const pk = lib.rows("SELECT name FROM pragma_table_info('journey') WHERE pk > 0 ORDER BY pk").map(r => r.name);
  if (pk.length === 2 && pk[0] === 'subject' && pk[1] === 'tenant') {
    ensureJourneyIndex(lib);
    return;
  }
  // Older builds keyed the journey on subject alone, so one person could overwrite another tenant.
  // Copy the stored tenant as-is, including blank. This does not assign a tenant to a legacy row.
  // Mixed-case duplicates are copied as stored. This migration does not merge them.
  lib.exec(`CREATE TABLE journey_v2 (
    subject TEXT NOT NULL, tenant TEXT NOT NULL DEFAULT '', payload TEXT, updated_at TEXT,
    PRIMARY KEY (subject, tenant))`);
  lib.recorded(() => {
    lib.exec(`INSERT INTO journey_v2 (subject, tenant, payload, updated_at)
      SELECT subject, COALESCE(tenant, ''), payload, updated_at FROM journey`);
    lib.log('schema', 'atlas', 'schema copy', 'journey');
  });
  lib.registered('drop-journey');
  lib.registered('rename-journey');
  ensureJourneyIndex(lib);
}

// The case-sensitive primary key can already hold more than one spelling of the same email.
// Read and save share one choice: the newest updated_at, then the greatest rowid.
// Export and erasure take every row this match finds. Nothing here merges the duplicates.
export const JOURNEY_MATCH = 'lower(subject) = lower(?) AND tenant = ?';
export const JOURNEY_READ_SQL = `SELECT rowid AS id, subject, tenant, payload, updated_at FROM journey WHERE ${JOURNEY_MATCH} ORDER BY updated_at DESC, rowid DESC LIMIT 1`;
export const JOURNEY_ALL_SQL = `SELECT rowid AS id, subject, tenant, payload, updated_at FROM journey WHERE ${JOURNEY_MATCH} ORDER BY updated_at DESC, rowid DESC`;
export const JOURNEY_COUNT_SQL = `SELECT COUNT(*) AS n FROM journey WHERE ${JOURNEY_MATCH}`;
export const JOURNEY_DELETE_SQL = `DELETE FROM journey WHERE ${JOURNEY_MATCH}`;
export const JOURNEY_UPDATE_SQL = 'UPDATE journey SET payload = ?, updated_at = ? WHERE rowid = ?';

function ensureJourneyIndex(lib) {
  lib.exec('CREATE INDEX IF NOT EXISTS journey_tenant_subject ON journey(tenant, lower(subject))');
}

export function journeyTenant(user = {}) {
  return String(user.tenant || '').trim().toLowerCase();
}

function demandTenant(user) {
  if (user?.tenantEnforced === true && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(journeyTenant(user))) {
    throw fail(403, 'A verified tenant is required.');
  }
}

function blank() {
  return {
    version: 1,
    fields: {},
    confirmed: {},
    stage: 'project',
    disclaimer: 'Role suggestions explain overlap with skills you confirmed. They are not a hiring, promotion or performance decision.',
  };
}

export function journeyChosen(lib, email, tenant) {
  ensureJourney(lib);
  return lib.rows(JOURNEY_READ_SQL, email, tenant)[0] || null;
}

export function journeyMatches(lib, email, tenant) {
  ensureJourney(lib);
  return lib.rows(JOURNEY_ALL_SQL, email, tenant);
}

// Shared by read and export. Malformed JSON and non-objects are unreadable; callers decide what to show.
export function journeyPayload(raw) {
  try {
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    return payload;
  } catch { return null; }
}

// One omission shape for every skipped export row. Callers pass only rows already in the subject's tenant.
export function omittedRow(id, source, reason = 'unparseable') {
  return { id, source, reason };
}

// Rows are already the tenant-scoped match. An unreadable payload stays in the export as an omission, not a gap.
export function journeyExport(rows) {
  const journey = [];
  const omitted = [];
  for (const row of rows) {
    const payload = journeyPayload(row.payload);
    if (!payload) omitted.push(omittedRow(row.id, 'journey'));
    else journey.push({ ...payload, subject: row.subject, updatedAt: row.updated_at });
  }
  return { journey, omitted: { count: omitted.length, rows: omitted } };
}

function read(lib, user) {
  demandTenant(user);
  const row = journeyChosen(lib, user.email, journeyTenant(user));
  if (!row) return { ...blank(), tenant: user.tenant || '' };
  const payload = journeyPayload(row.payload);
  if (!payload) return { ...blank(), tenant: user.tenant || '' };
  return { ...blank(), ...payload, tenant: row.tenant || '' };
}

function field(raw, key) {
  const f = obj(raw?.[key]);
  const source = SOURCES.has(f.source) ? f.source : '';
  return {
    value: str(f.value, key === 'evidence' ? 2000 : 240),
    source,
    confirmed: f.confirmed === true && !!source,
  };
}

export function explainRoles(confirmedSkills) {
  const have = new Set((confirmedSkills || []).map(s => String(s).toLowerCase()).filter(Boolean));
  const matches = ROLE_CATALOG.map(role => {
    const because = role.skills.filter(s => have.has(s));
    return { id: role.id, title: role.title, because, overlap: because.length, possible: because.length > 0 };
  }).filter(m => m.possible);
  return {
    matches,
    decision: 'not-a-decision',
    explanation: matches.length
      ? 'Each line is only the overlap between your confirmed skill words and a fixed illustrative list.'
      : 'No illustrative role overlaps the skills you have confirmed. Nothing was inferred.',
  };
}

export function blockedAdapter(id) {
  const stage = STAGES.find(s => s.id === id);
  if (!stage?.blocked) return null;
  return { ...BLOCKED[stage.blocked], stage: id };
}

export function journeyView(lib, user) {
  const data = read(lib, user);
  const skills = Object.entries(data.confirmed).filter(([, v]) => v?.kind === 'skill' && v.confirmed).map(([, v]) => v.value);
  return {
    stages: STAGES.map(s => ({ ...s, blocked: s.blocked ? blockedAdapter(s.id) : null, current: data.stage === s.id })),
    fields: data.fields,
    confirmed: data.confirmed,
    roles: explainRoles(skills),
    integrations: { dna: BLOCKED.dna, map: BLOCKED.map, spotlight: BLOCKED.spotlight, teams: { status: 'BLOCKED_EXTERNAL', reason: 'Teams is not connected from this journey.' } },
    publication: 'A non-admin Spotlight story is published only after a trusted manager and a trusted bid/pre-sales reviewer both approve it. A verified admin may publish or mark a test copy; that action is audited.',
  };
}

export async function saveJourney(lib, user, body = {}) {
  ensureJourney(lib);
  const current = read(lib, user);
  const incoming = obj(body.fields);
  const fields = { ...current.fields };
  for (const key of ['title', 'personalWork', 'evidence', 'clientAlias']) {
    if (incoming[key]) fields[key] = field(incoming, key);
  }
  const skill = str(body.confirmSkill, 80);
  const confirmed = { ...current.confirmed };
  if (skill) {
    if (body.skillConfirmed !== true || !SOURCES.has(body.skillSource)) throw fail(400, 'Confirm the skill and where it came from. ATLAS will not add it for you.');
    confirmed['skill:' + skill.toLowerCase()] = { kind: 'skill', value: skill, source: body.skillSource, confirmed: true, at: lib.now() };
  }
  const stage = STAGES.some(s => s.id === body.stage) ? body.stage : current.stage;
  const payload = { version: 1, fields, confirmed, stage, disclaimer: blank().disclaimer };
  demandTenant(user);
  const tenant = journeyTenant(user);
  const chosen = journeyChosen(lib, user.email, tenant);
  const at = lib.now();
  lib.recorded(() => {
    if (chosen) lib.exec(JOURNEY_UPDATE_SQL, JSON.stringify(payload), at, chosen.id);
    else lib.exec('INSERT INTO journey (subject, tenant, payload, updated_at) VALUES (?, ?, ?, ?)', user.email, tenant, JSON.stringify(payload), at);
    lib.log('journey', user.email, 'journey saved', stage);
  });
  await recordUsage(lib, user, { kind: 'journey', feature: 'journey', outcome: 'saved', tokenStatus: 'missing' });
  return journeyView(lib, user);
}

export function mapDraft(view) {
  const title = view.fields.title?.confirmed ? view.fields.title.value : '';
  const work = view.fields.personalWork?.confirmed ? view.fields.personalWork.value : '';
  return {
    ...BLOCKED.map,
    draft: {
      label: 'Local draft only',
      project: title || 'No confirmed project title yet',
      contribution: work || 'No confirmed contribution yet',
      skills: Object.values(view.confirmed).filter(v => v.kind === 'skill').map(v => v.value),
      submitted: false,
    },
  };
}

export function recipientEmail(value) {
  return email(value);
}
