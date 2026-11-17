// Central reference library (system of record): structured records, immutable revisions, audit trail,
// permissions from the verified sign-in, a quality gate and N+1 validation. Storage is SQL through an adapter
// with exec(query, ...params) -> { toArray() } (Durable Object SQLite in production, node:sqlite in tests).
// Confidential client details are visible only to the record's people and reviewers, and never reach a model.
import { reviewReference, forModel, clientScrub, contactLead, READY_SCORE } from './review.js';
import { searchText, cosine, lexical, TARGET_POLICY, parseTarget, RERANK_POLICY, parseRerankStrict, candidateCard, SLIDES_POLICY, parseSlides, INSIGHTS_POLICY, parseInsights } from './reuse.js';
import { str, para, list, email, https, obj, fail } from './util.js';
// Model input from a record goes through recordView (other library clients, contacts and PII masked too); text a
// user types is pseudonymised and the caller gets their own words back (WOW_SPEC §2.3).
import { recordView, pseudonymise, forAuthor, nameMatcher } from './scrub.js';
import { winSignals } from './winloop.js';
// Story rating by TypeSafe JEV (docs/JEV_RATING.md): used only when a rater with a key exists and the owner consented.
import { RatingError, ratingInput, questionPlan, requestBody, compose, agentQuality, noStoryQuality, sha256Hex, BUDGETS, RUBRIC_VERSION, METRIC_CODES, MODEL } from './rating.js';
import { storedConsent } from './profile.js';
import { sameTenant, TENANT_ID } from './authz.js';
import { appendAudit, ensureChain, verifyChain } from './audit-chain.js';
import { recordUsage } from './telemetry.js';
const DUPLICATE = 0.9; // cosine similarity above which two references are flagged as the same or a related project
export const PRACTICES = { data_ai: 'Data & AI', web_app: 'Web & App Development', telecom: 'Telecom & Networks', sap_erp: 'SAP & ERP', cloud_infra: 'Cloud & Infrastructure', cybersecurity: 'Cybersecurity', transformation: 'Transformation & Strategy', engineering: 'Engineering & Industry' };

export const STATUSES = ['in_review', 'needs_work', 'changes_requested', 'awaiting_validation', 'published', 'admin_test', 'withdrawn'];
const REVIEW_DAYS = 180; // references are due for an update six months after their last change

// Server-side bounds for everything a browser may send. Unknown fields are dropped.
export function cleanReference(raw) {
  raw = obj(raw);
  const d = obj(raw.details), r = raw.report ? obj(raw.report) : null, j = raw.jev ? obj(raw.jev) : null, v = obj(raw.validation);
  const answers = Array.isArray(raw.answers) ? raw.answers.slice(0, 6).map(a => para(a, 6000)) : [];
  while (answers.length < 6) answers.push('');
  const data = {
    title: str(raw.title, 140), stage: str(raw.stage, 60), sector: str(raw.sector, 100),
    consultant: { name: str(obj(raw.consultant).name, 100), role: str(obj(raw.consultant).role, 100) },
    client: { name: str(obj(raw.client).name, 120), location: str(obj(raw.client).location, 120), contact: str(obj(raw.client).contact, 120) },
    details: {
      projectId: str(d.projectId, 60), country: str(d.country, 60), start: str(d.start, 20), end: str(d.end, 20), duration: str(d.duration, 40),
      teamSize: Number.isInteger(d.teamSize) && d.teamSize > 0 && d.teamSize <= 10000 ? d.teamSize : null,
      teamRoles: list(d.teamRoles, 8, 60), technologies: list(d.technologies, 15, 60), deliverables: list(d.deliverables, 10, 160), serviceLines: list(d.serviceLines, 6, 60),
      consultants: (Array.isArray(d.consultants) ? d.consultants : []).slice(0, 20).map(c => ({ name: str(obj(c).name, 100), email: email(obj(c).email), role: str(obj(c).role, 100) })).filter(c => c.name || c.email),
      links: (Array.isArray(d.links) ? d.links : []).slice(0, 10).map(l => ({ label: str(obj(l).label, 100), url: https(obj(l).url) })).filter(l => l.url),
    },
    answers,
    report: r && str(r.headline, 120) ? { headline: str(r.headline, 120), summary: str(r.summary, 900),
      topics: Object.fromEntries(['context', 'contribution', 'approach', 'outcome', 'evidence', 'customer_relevance'].map(k => [k, str(obj(r.topics)[k], 900)])),
      highlights: list(r.highlights, 4, 200), gaps: list(r.gaps, 6, 200), follow_ups: list(r.follow_ups, 5, 200) } : null,
    jev: j && obj(j.primary).key ? { primary: { key: str(j.primary.key, 40), label: str(j.primary.label, 60) }, also: (Array.isArray(j.also) ? j.also : []).slice(0, 8).map(a => ({ key: str(obj(a).key, 40), label: str(obj(a).label, 60) })),
      impact: Number.isFinite(j.impact) ? Math.max(0, Math.min(100, j.impact)) : null } : null,
    validation: { manager: { name: str(obj(v.manager).name, 100), email: email(obj(v.manager).email) }, managerStaff: v.managerStaff === true },
    sheet: raw.sheet && typeof raw.sheet === 'object' ? { oppId: str(obj(raw.sheet).oppId, 40), oppIdPending: obj(raw.sheet).oppIdPending === true, title: str(obj(raw.sheet).title, 140),
      exec: Object.fromEntries(['summary', 'teamSize', 'duration', 'price', 'contacts'].map(k => [k, para(obj(obj(raw.sheet).exec)[k], 1500)])),
      sections: Object.fromEntries(['industry', 'issue', 'scope', 'methodology', 'deliverables', 'tools', 'team', 'value'].map(k => [k, para(obj(obj(raw.sheet).sections)[k], 3000)])),
      file: { country: str(obj(obj(raw.sheet).file).country, 60), entity: ['HEMA', 'SOLLAN', 'ACT', 'CRO'].includes(obj(obj(raw.sheet).file).entity) ? obj(obj(raw.sheet).file).entity : '', entityCountry: str(obj(obj(raw.sheet).file).entityCountry, 60) },
      fileName: str(obj(raw.sheet).fileName, 240), confirmedAt: str(obj(raw.sheet).confirmedAt, 40) } : null,
    sources: (Array.isArray(raw.sources) ? raw.sources : []).slice(0, 20).map(s => ({ name: str(obj(s).name, 160), version: str(obj(s).version, 100), url: https(obj(s).url), excerpt: para(obj(s).excerpt, 1000) })).filter(s => s.name),
  };
  if (!data.title) throw Object.assign(new Error('A reference needs a title.'), { status: 400 });
  return data;
}

export async function hashOf(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}

// forModel no longer carries the consultant (WOW_ZERO_CONFIG §5.9). The people-facing views below are not model
// input, so they keep the record's consultant, own-client scrubbed exactly as forModel did before.
function withConsultant(m, data) {
  const own = clientScrub(data);
  return { ...m, consultant: { name: own(data.consultant?.name || ''), role: own(data.consultant?.role || '') } };
}

// Published view for people outside the record: client details removed and scrubbed from every text field.
// A one-word contact lead ("Dupont, CFO" -> "Dupont") is masked here under the contact rules (case-sensitive when short
// or a stoplist word, never a stoplist lead such as "Will"); clientScrub leaves it to recordText on model paths.
export function anonymise(data) {
  const lead = contactLead(data?.client?.contact), one = lead && !/\s/.test(lead) ? nameMatcher([lead], { contacts: true }) : null;
  const deep = v => typeof v === 'string' ? one(v, () => 'the client') : Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v;
  const own = forModel({ ...data, sources: data.sources });
  const m = withConsultant(one ? deep(own) : own, data);
  m.details = { ...m.details, consultants: (data.details.consultants || []).map(c => ({ name: c.name, role: c.role })) };
  return m;
}

// What a reader without full access gets of a rating (docs/JEV_RATING.md §9.2): today's fields plus the engine; no
// per-dimension detail and no holds. A legacy object (no engine) is today's object, unchanged.
const QUALITY_PUBLIC = ['score', 'completeness', 'aiScore', 'status', 'clientValueClear', 'missing', 'issues', 'recommendations', 'summary', 'blockers', 'reviewedAt', 'model', 'readyScore', 'revision', 'engine'];
function publicQuality(q) {
  if (!q || !('engine' in q)) return q;
  return { ...Object.fromEntries(QUALITY_PUBLIC.filter(k => k in q).map(k => [k, q[k]])), jev: null, holds: [] };
}
// Numbers only (docs/JEV_RATING.md §7.5): never an id, title, client, hash, model name, text or key.
const defaultMetric = (name, values) => console.log(JSON.stringify({ atlas_metric: name, ...values }));
const waitAtMost = (p, ms) => new Promise(resolve => { const t = setTimeout(resolve, ms); p.then(() => { clearTimeout(t); resolve(); }, () => { clearTimeout(t); resolve(); }); });
// Without a key (fallback no_key) the audit text is today's, including when the review agent did not answer.
const auditDetail = q => `score ${q.score}, ${q.status}` + (q.engine === 'jev' ? ' · JEV' : q.escalatedFrom ? ' · review agent (second opinion)' : q.engine === 'rules' && q.fallbackReason !== 'no_key' ? ' · rules only' : '');

export function deriveStatus(state) {
  if (state.withdrawn) return 'withdrawn';
  const v = state.validation || {};
  // A verified admin bypass is explicit and audited. The manager-staff checkbox never arrives here as not_required.
  if (v.status === 'admin_bypass') {
    if (state.test) return 'admin_test';
    if (!state.quality) return 'in_review';
    if (state.quality.status !== 'ready') return 'needs_work';
    return 'published';
  }
  if (!state.quality) return 'in_review';
  if (state.quality.status !== 'ready') return 'needs_work';
  if (v.status === 'changes_requested' || v.managerDecision === 'changes_requested' || v.presalesDecision === 'changes_requested') return 'changes_requested';
  const both = v.managerDecision === 'approved' && v.presalesDecision === 'approved';
  if (v.status === 'validated' || both) return 'published';
  return 'awaiting_validation';
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS refs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, local_id TEXT, title TEXT, status TEXT, revision INTEGER, content_hash TEXT,
    practice TEXT, industry TEXT, country TEXT, manager_email TEXT, members TEXT, quality_score INTEGER, created_at TEXT, updated_at TEXT, updated_by TEXT,
    next_review TEXT, merged_into TEXT, data TEXT, state TEXT, embedding TEXT)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS refs_owner_local ON refs(owner, local_id)',
  'CREATE TABLE IF NOT EXISTS revisions (id TEXT, revision INTEGER, data TEXT, author TEXT, at TEXT, PRIMARY KEY (id, revision))',
  'CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, actor TEXT, action TEXT, at TEXT, detail TEXT)',
  `CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, email TEXT, project_id TEXT, title TEXT, reason TEXT, slot TEXT, reference_id TEXT,
    status TEXT, created_at TEXT, source TEXT)`,
];

function migrateManagerTrust(lib) {
  const exists = lib.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manager_trust'")[0];
  const create = `CREATE TABLE manager_trust_v2 (
    owner TEXT NOT NULL, email TEXT NOT NULL, source TEXT, tenant TEXT NOT NULL DEFAULT '', at TEXT,
    PRIMARY KEY (owner, email, tenant))`;
  if (!exists) { lib.sql.exec(create.replace('manager_trust_v2', 'manager_trust')); return; }
  const pk = lib.rows("SELECT name FROM pragma_table_info('manager_trust') WHERE pk > 0 ORDER BY pk").map(r => r.name);
  if (pk.join(',') === 'owner,email,tenant') return;
  const cols = lib.rows("SELECT name FROM pragma_table_info('manager_trust')").map(r => r.name);
  lib.sql.exec(create);
  const tenantSql = cols.includes('tenant') ? "COALESCE(tenant, '')" : "''";
  lib.sql.exec(`INSERT INTO manager_trust_v2 (owner, email, source, tenant, at)
    SELECT owner, email, source, ${tenantSql}, at FROM manager_trust`);
  lib.sql.exec('DROP TABLE manager_trust');
  lib.sql.exec('ALTER TABLE manager_trust_v2 RENAME TO manager_trust');
}
function migrateStoryTenant(lib) {
  const cols = lib.rows("SELECT name FROM pragma_table_info('refs')").map(r => r.name);
  if (cols.length && !cols.includes('tenant')) {
    lib.sql.exec("ALTER TABLE refs ADD COLUMN tenant TEXT NOT NULL DEFAULT ''");
    // Copy the tenant already stored on the story. Blank stays blank. Nothing is assigned.
    lib.sql.exec("UPDATE refs SET tenant = COALESCE(json_extract(state, '$.tenant'), '')");
  }
  const idx = lib.rows("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'refs_owner_local'")[0]?.sql || '';
  if (!idx.includes('tenant')) {
    lib.sql.exec('DROP INDEX IF EXISTS refs_owner_local');
    lib.sql.exec('CREATE UNIQUE INDEX refs_owner_local ON refs(owner, local_id, tenant)');
  }
}
export class Library {
  // services: outbound adapters for feature modules ({ teams } in production; empty in tests and local runs).
  // rater: rating.storyRater(env) (null: no JEV); metric(name, values): numbers only (default: one console.log line).
  constructor(sql, { now = () => new Date().toISOString(), newId = () => crypto.randomUUID().replace(/-/g, ''), complete = null, embed = null, readyScore = READY_SCORE, model = '', services = {},
    rater = null, metric = defaultMetric, transactionSync = null, auditKey = '', dbId = '' } = {}) {
    const atomic = typeof transactionSync === 'function' ? transactionSync : (typeof sql?.transactionSync === 'function' ? sql.transactionSync.bind(sql) : null);
    Object.assign(this, { sql, now, newId, complete, embed, readyScore, model, services, rater, metric, transactionSync: atomic, auditKey, dbId: String(dbId ?? '') });
    this.inflight = new Map(); // `${id}:${revision}` -> { gen, engine, first, all }: one rating per revision at a time
    for (const q of SCHEMA) this.sql.exec(q);
    const inv = this.rows("SELECT name FROM pragma_table_info('invitations')").map(r => r.name);
    if (inv.length && !inv.includes('tenant')) this.sql.exec('ALTER TABLE invitations ADD COLUMN tenant TEXT');
    this.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS invitations_open_scope ON invitations(email, reason, project_id, reference_id, tenant) WHERE status IN ('open', 'scheduled')");
    migrateManagerTrust(this);
    migrateStoryTenant(this);
    ensureChain(this.sql, this.auditKey, this.transactionSync, this.dbId);
  }

  rows(q, ...p) { return this.sql.exec(q, ...p).toArray(); }
  row(id) {
    const r = this.rows('SELECT * FROM refs WHERE id = ?', String(id || ''))[0];
    return r ? { ...r, data: JSON.parse(r.data), state: JSON.parse(r.state) } : null;
  }
  log(id, actor, action, detail = '') {
    if (this.auditKey == null) throw fail(503, 'LOG_SALT is not set.');
    appendAudit(this.sql, { id, actor, action, at: this.now(), detail: String(detail).slice(0, 300) }, this.auditKey, this.dbId);
  }
  // An invitation or card action may name a story. The audit id is that story only when the story's stored tenant
  // is the caller's tenant. A foreign id is not an audit target.
  auditId(refId, tenant) {
    const id = String(refId || '');
    if (!id) return 'library';
    const row = this.row(id);
    const stored = String(row?.tenant || row?.state?.tenant || '').toLowerCase();
    return row && stored === String(tenant || '').toLowerCase() ? id : 'library';
  }
  auditFor(user, refId, tenant) {
    const id = this.auditId(refId, tenant);
    if (id === 'library') return 'library';
    const row = this.row(id);
    return row && this.access(row, user) ? id : 'library';
  }
  visibleDuplicates(row, user) {
    const mine = String(row?.tenant || row?.state?.tenant || '').toLowerCase();
    const out = [];
    for (const d of row?.state?.duplicates || []) {
      const other = this.row(d?.id);
      if (!other || String(other.tenant || other.state?.tenant || '').toLowerCase() !== mine || !this.access(other, user)) continue;
      out.push({ id: other.id, title: other.data?.title || '', similarity: d.similarity, sameProjectId: !!d.sameProjectId });
    }
    return out;
  }
  ownerKeys(row) {
    const owner = String(row?.owner || '').toLowerCase();
    const keys = new Set(owner ? [owner] : []);
    const tenant = String(row?.tenant || row?.state?.tenant || '').toLowerCase();
    if (!this.rows("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'profiles'")[0]) return [...keys];
    for (const found of this.rows("SELECT email FROM profiles WHERE lower(subject) = ? AND lower(COALESCE(tenant, '')) = ?", owner, tenant)) {
      const mail = String(found.email || '').trim().toLowerCase();
      if (mail) keys.add(mail);
    }
    return [...keys];
  }
  reachableOwnerAddress(row) {
    const owner = String(row?.owner || '').trim().toLowerCase();
    if (email(owner)) return email(owner);
    for (const key of this.ownerKeys(row)) if (email(key)) return email(key);
    return '';
  }

  // Who may see what. 'full' includes confidential client details; 'public' is the anonymised published view.
  // Typed teammate emails do not grant full access. A trusted manager row does.
  access(row, user) {
    if (!row || row.merged_into || !sameTenant(row.state?.tenant, user.tenant, user.tenantEnforced === true)) return null;
    if (['admin', 'reviewer', 'presales'].includes(user.role)) return 'full';
    const e = user.email;
    if (e && row.owner === e) return 'full';
    if (e && Array.isArray(row.state?.sharedWith) && row.state.sharedWith.includes(e)) return 'full';
    if (this.canManagerApprove(row, user)) return 'full';
    return row.status === 'published' ? 'public' : null;
  }
  canEdit(row, user) { return !!user.email && sameTenant(row.state?.tenant, user.tenant, user.tenantEnforced === true) && (['admin', 'reviewer'].includes(user.role) || row.owner === user.email); }
  identityAliases(user = {}) {
    return [...new Set([user.email, user.mail].map(v => String(v || '').trim().toLowerCase()).filter(Boolean))];
  }
  canManagerApprove(row, user) {
    const aliases = this.identityAliases(user);
    const owner = String(row?.owner || '').toLowerCase();
    if (!aliases.length || !row || aliases.includes(owner)) return false;
    if (!sameTenant(row.state?.tenant, user.tenant, user.tenantEnforced === true)) return false;
    const want = String(user.tenant || '').toLowerCase();
    const marks = aliases.map(() => '?').join(', ');
    const owners = this.ownerKeys(row);
    if (!owners.length || owners.some(o => aliases.includes(o))) return false;
    const ownerMarks = owners.map(() => '?').join(', ');
    const grants = this.rows(`SELECT source FROM manager_trust WHERE lower(owner) IN (${ownerMarks}) AND lower(email) IN (${marks}) AND lower(COALESCE(tenant, '')) = ?`, ...owners, ...aliases, want);
    if (grants.some(g => g.source === 'directory')) return true;
    if (!grants.some(g => g.source === 'staffing')) return false;
    const project = String(row.data?.details?.projectId || '').trim().toLowerCase();
    if (!project) return false;
    if (!this.rows("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'staffing'")[0]) return false;
    const hits = this.rows(`SELECT project_id, consultant_email, manager_email FROM staffing WHERE lower(project_id) = ? AND lower(consultant_email) IN (${ownerMarks}) AND lower(COALESCE(tenant, '')) = ?`, project, ...owners, want);
    const physical = new Map();
    for (const hit of hits) {
      const key = String(hit.project_id || '').toLowerCase() + '\n' + String(hit.consultant_email || '').toLowerCase();
      physical.set(key, (physical.get(key) || 0) + 1);
    }
    if (physical.size !== 1 || [...physical.values()][0] !== 1) return false;
    return hits.some(hit => aliases.includes(String(hit.manager_email || '').toLowerCase()));
  }
  canPresalesApprove(row, user) {
    if (!row || user.role !== 'presales' || !user.email || user.email === row.owner) return false;
    return sameTenant(row.state?.tenant, user.tenant, user.tenantEnforced === true);
  }

  summary(row, level, user) {
    const d = row.data, q = row.state.quality;
    return { id: row.id, title: d.title, status: row.status, revision: row.revision, access: level, mine: row.owner === user.email,
      practice: d.jev?.primary?.label || '', industry: d.sector, country: d.details.country, serviceLines: d.details.serviceLines, technologies: d.details.technologies,
      headline: d.report?.headline || '', impact: d.jev?.impact ?? null, qualityScore: q?.score ?? null, qualityStatus: q?.status || '',
      updatedAt: row.updated_at, nextReview: row.next_review, owner: row.owner, client: level === 'full' ? d.client.name : '' };
  }

  async upsert(user, body) {
    if (!user.email) throw fail(401, 'Sign in first.');
    if (user.tenantEnforced === true && !TENANT_ID.test(String(user.tenant || ''))) throw fail(403, 'A verified tenant is required.');
    body = obj(body);
    const data = cleanReference(body.reference), localId = str(body.localId, 100), hash = await hashOf(data), at = this.now();
    const storyTenant = String(user.tenant || '').trim().toLowerCase();
    const found = body.id ? { id: String(body.id) } : localId ? this.rows("SELECT id FROM refs WHERE owner = ? AND local_id = ? AND lower(COALESCE(tenant, '')) = ?", user.email, localId, storyTenant)[0] : null;
    const row = found ? this.row(found.id) : null;
    if (body.id && !row) throw fail(404, 'Reference not found.');
    if (row && !this.canEdit(row, user)) throw fail(403, 'You cannot edit this reference.');
    if (row && row.merged_into) throw fail(409, 'This reference was merged into another one.');
    if (row && row.content_hash === hash) return { ...this.summary(row, 'full', user), unchanged: true };
    const id = row ? row.id : this.newId(), revision = row ? row.revision + 1 : 1;
    const members = ',' + data.details.consultants.map(c => c.email).filter(Boolean).join(',') + ',';
    // An empty tenant is left empty. Enforcement hides that row until an operator backfill
    // supplies the tenant from a verified source. This function does not invent one.
    const keptTenant = row ? String(row.tenant || row.state?.tenant || '') : storyTenant;
    const state = { ...(row ? row.state : {}), quality: null, withdrawn: false, test: false, tenant: keptTenant,
      validation: { status: 'pending', managerDecision: 'pending', presalesDecision: 'pending', by: '', at: '', note: '', managerStaffIgnored: !!data.validation.managerStaff } };
    const status = deriveStatus(state), next = new Date(Date.parse(at) + REVIEW_DAYS * 864e5).toISOString();
    if (row) this.sql.exec(`UPDATE refs SET title=?, status=?, revision=?, content_hash=?, practice=?, industry=?, country=?, manager_email=?, members=?, quality_score=NULL,
      updated_at=?, updated_by=?, next_review=?, data=?, state=?, embedding=NULL WHERE id=?`,
      data.title, status, revision, hash, data.jev?.primary?.key || '', data.sector, data.details.country, data.validation.manager.email, members, at, user.email, next, JSON.stringify(data), JSON.stringify(state), id);
    else this.sql.exec(`INSERT INTO refs (id, owner, local_id, title, status, revision, content_hash, practice, industry, country, manager_email, members, created_at, updated_at, updated_by, next_review, data, state, tenant)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, user.email, localId, data.title, status, revision, hash, data.jev?.primary?.key || '', data.sector, data.details.country, data.validation.manager.email, members, at, at, user.email, next, JSON.stringify(data), JSON.stringify(state), keptTenant);
    this.sql.exec('INSERT INTO revisions (id, revision, data, author, at) VALUES (?, ?, ?, ?, ?)', id, revision, JSON.stringify(data), user.email, at);
    this.log(id, user.email, row ? 'revised' : 'created', 'revision ' + revision + (row ? '; manager and pre-sales approval reopened' : ''));
    return this.summary(this.row(id), 'full', user);
  }

  demandTenant(user) {
    if (user?.tenantEnforced === true && !TENANT_ID.test(String(user.tenant || ''))) throw fail(403, 'A verified tenant is required.');
  }

  // Rows written before chain-start were not signed. They stay visible and are marked unverified.
  chainStartSeq() {
    try {
      const row = this.rows(`SELECT seq FROM audit WHERE action = 'chain-start' AND "commit" IS NOT NULL ORDER BY seq LIMIT 1`)[0];
      return row ? Number(row.seq) : null;
    } catch { return null; }
  }
  auditLines(id) {
    let keyed = true;
    try { this.sql.exec('SELECT "commit" FROM audit LIMIT 0'); }
    catch { keyed = false; }
    const start = keyed ? this.chainStartSeq() : null;
    const query = keyed
      ? 'SELECT seq, actor, action, at, detail, "commit" FROM audit WHERE id = ? ORDER BY seq DESC LIMIT 100'
      : 'SELECT seq, actor, action, at, detail FROM audit WHERE id = ? ORDER BY seq DESC LIMIT 100';
    const verified = keyed ? new Set((verifyChain(this.sql, this.auditKey, this.dbId).verifiedSeqs) || []) : null;
    return this.rows(query, id).map(a => {
      const line = { actor: a.actor, action: a.action, at: a.at, detail: a.action === 'possible duplicate' ? '' : a.detail };
      if (!keyed) return { ...line, unverified: true };
      if (start != null && Number(a.seq) < start) return { ...line, legacy: true, unverified: true };
      if (!a.commit || !verified.has(Number(a.seq))) return { ...line, unverified: true };
      return line;
    });
  }

  get(user, id) {
    this.demandTenant(user);
    const row = this.row(id), level = this.access(row, user);
    if (!level) throw fail(404, 'Reference not found.');
    const full = level === 'full';
    return { ...this.summary(row, level, user), data: full ? row.data : anonymise(row.data),
      state: { quality: full ? row.state.quality : publicQuality(row.state.quality), validation: full ? row.state.validation : { status: row.state.validation?.status }, withdrawn: !!row.state.withdrawn, duplicates: this.visibleDuplicates(row, user) },
      revisions: full ? this.rows('SELECT revision, author, at FROM revisions WHERE id = ? ORDER BY revision DESC', row.id) : [],
      audit: full ? this.auditLines(row.id) : [],
      permissions: { edit: this.canEdit(row, user), validate: this.canValidate(row, user), validateLane: this.canManagerApprove(row, user) ? 'manager' : this.canPresalesApprove(row, user) ? 'presales' : '', withdraw: this.canEdit(row, user), review: this.canEdit(row, user), reinstate: ['admin', 'reviewer'].includes(user.role), merge: ['admin', 'reviewer'].includes(user.role) },
      rating: { running: this.inflight.has(row.id + ':' + row.revision) }, ...(full ? { jevAllowed: this.jevAllowed(row) } : {}) };
  }

  // JEV may rate this story: a key, the OWNER's stored consent (whoever triggers the rating), and no rejected key.
  jevAllowed(row) { return !!this.rater?.available() && this.rater.blocked() !== 'auth' && storedConsent(this, row.owner, 'jevRating', row.state?.tenant || ''); }
  engineFor(row) {
    // Without a key, a story with no text still goes to the review agent, exactly as before JEV (docs/JEV_RATING.md §0).
    if (!(row.data.answers || []).some(a => String(a ?? '').trim())) return this.rater?.available() ? 'rules' : 'review-agent';
    return this.rater?.available() && storedConsent(this, row.owner, 'jevRating', row.state?.tenant || '') ? 'jev' : 'review-agent';
  }

  revision(user, id, n) {
    const row = this.row(id);
    if (this.access(row, user) !== 'full') throw fail(404, 'Reference not found.');
    const r = this.rows('SELECT revision, data, author, at FROM revisions WHERE id = ? AND revision = ?', row.id, Number(n))[0];
    if (!r) throw fail(404, 'Revision not found.');
    return { ...r, data: JSON.parse(r.data) };
  }

  visibleRows(user) {
    const all = this.rows("SELECT * FROM refs WHERE merged_into IS NULL ORDER BY updated_at DESC").map(r => ({ ...r, data: JSON.parse(r.data), state: JSON.parse(r.state) }));
    return all.map(r => [r, this.access(r, user)]).filter(([, level]) => level);
  }

  list(user, f = {}) {
    this.demandTenant(user);
    const q = str(f.q, 200).toLowerCase(), has = (arr, v) => !v || (arr || []).some(x => x.toLowerCase() === String(v).toLowerCase());
    const rows = this.visibleRows(user).filter(([r, level]) => (!f.status || r.status === f.status) && (!f.practice || r.practice === f.practice)
      && (!f.country || (r.country || '').toLowerCase() === String(f.country).toLowerCase()) && (!f.industry || (r.industry || '').toLowerCase() === String(f.industry).toLowerCase())
      && has(r.data.details.serviceLines, f.service) && has(r.data.details.technologies, f.tech) && (!f.mine || r.owner === user.email)
      && (!q || JSON.stringify(withConsultant(forModel(r.data), r.data)).toLowerCase().includes(q) || (level === 'full' && Object.values(r.data.client).join(' ').toLowerCase().includes(q))));
    const facet = key => { const out = {}; for (const [r] of rows) for (const v of [].concat(key(r)).filter(Boolean)) out[v] = (out[v] || 0) + 1; return out; };
    return { items: rows.slice(0, 200).map(([r, l]) => this.summary(r, l, user)), total: rows.length,
      facets: { status: facet(r => r.status), practice: facet(r => r.data.jev?.primary?.label), country: facet(r => r.data.details.country), industry: facet(r => r.data.sector),
        serviceLines: facet(r => r.data.details.serviceLines), technologies: facet(r => r.data.details.technologies) } };
  }

  canValidate(row, user) { return this.canManagerApprove(row, user) || this.canPresalesApprove(row, user); }
  bindTrust(actor, spec = {}) {
    if (!actor || !['system', 'admin'].includes(actor.role)) throw fail(403, 'Only a verified admin or a directory import can bind a manager.');
    const source = spec.source === 'staffing' ? 'staffing' : spec.source === 'directory' ? 'directory' : '';
    const owner = str(spec.owner, 200), who = String(spec.email || '').trim().toLowerCase();
    const tenant = String(spec.tenant || '').trim().toLowerCase();
    const enforced = actor.tenantEnforced === true || spec.tenantEnforced === true;
    if (!source || !owner || !who || who === owner.toLowerCase()) throw fail(400, 'A trusted manager binding needs a directory or staffing source and two different people.');
    if (!tenant) {
      if (spec.sandbox !== true || enforced) throw fail(403, 'A tenantless manager binding is refused.');
    } else if (enforced && (!TENANT_ID.test(tenant) || String(actor.tenant || '').toLowerCase() !== tenant)) {
      throw fail(403, 'A verified tenant is required to bind a manager.');
    }
    this.sql.exec(`INSERT INTO manager_trust (owner, email, source, tenant, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner, email, tenant) DO UPDATE SET
        source = CASE WHEN manager_trust.source = 'directory' AND excluded.source = 'staffing' THEN manager_trust.source ELSE excluded.source END,
        at = excluded.at`,
      owner, who, source, tenant, this.now());
    this.log('library', actor.email || actor.role, 'manager trust', `${source}`);
    return { owner, email: who, source };
  }

  setState(row, state, actor, action, detail) {
    const status = deriveStatus(state);
    this.sql.exec('UPDATE refs SET state = ?, status = ?, quality_score = ? WHERE id = ?', JSON.stringify(state), status, state.quality?.score ?? null, row.id);
    this.log(row.id, actor, action, detail);
    return status;
  }

  // Rates the current revision (docs/JEV_RATING.md §5.5, §6.4-§6.6, §7.3). The engine resolves in this order: rules when
  // the story has no text; jev with a key and the owner's consent; otherwise the review agent (today's path). One rating
  // per revision at a time: a call with the same engine joins the one in flight; a different engine starts a new
  // generation, and only the newest generation of the current revision is ever stored. An interactive call returns once
  // the primary rating is stored; a second opinion and the index continue in waitUntil (awaited inline without it).
  async review(user, id, { budget = 'interactive', waitUntil = null } = {}) {
    const row = this.row(id);
    if (!row || !this.access(row, user)) throw fail(404, 'Reference not found.');
    if (user.email !== 'atlas' && !this.canEdit(row, user)) throw fail(403, 'You cannot review this reference.');
    if (!this.complete && !this.rater?.available()) throw fail(503, 'The review agent is not available.');
    const engine = this.engineFor(row), key = row.id + ':' + row.revision, cur = this.inflight.get(key);
    if (cur && cur.engine === engine) {
      // The 2 s cap exists because the JEV-configured dialog polls (rating.running). Without a key the dialog is today's
      // and does not poll, so the person waits for the rating in flight, as they waited for their own review before JEV.
      const capped = budget === 'interactive' && this.rater?.available();
      await (capped ? waitAtMost(cur.first, this.rater?.budgets?.interactive?.deadlineMs ?? BUDGETS.interactive.deadlineMs) : cur.first);
      return this.get(user, id);
    }
    const gen = this.nextGen(row.id);
    let markFirst; const entry = { gen, engine, first: new Promise(r => { markFirst = r; }) };
    // `running` ends when the rating (and any second opinion) is stored, not when the index finishes.
    const release = () => { if (this.inflight.get(key) === entry) this.inflight.delete(key); };
    this.inflight.set(key, entry);
    entry.all = this.runRating(row, { engine, gen, budget, waitUntil, markFirst, release, actor: user.email })
      .finally(() => { release(); markFirst(); });
    entry.all.catch(() => {}); // awaited below or by waitUntil; never an unhandled rejection
    await entry.first;
    if (budget === 'interactive' && waitUntil) waitUntil(entry.all); else await entry.all;
    return this.get(user, id);
  }

  // refs.state.ratingGen: incremented and written back at once (a synchronous read-modify-write in the Durable Object).
  nextGen(id) {
    const r = this.row(id), gen = (Number(r.state.ratingGen) || 0) + 1;
    this.sql.exec('UPDATE refs SET state = ? WHERE id = ?', JSON.stringify({ ...r.state, ratingGen: gen }), id);
    return gen;
  }

  // Stores a rating only for the same revision and a generation that nothing newer superseded. A valid JEV answer is
  // kept for reuse (lastJev) even when its rating is dropped.
  storeRating(row, gen, quality, actor, lastJev = null) {
    const fresh = this.row(row.id);
    if (!fresh || fresh.merged_into) return false;
    if (fresh.revision !== row.revision || (Number(fresh.state.ratingGen) || 0) > gen) {
      if (lastJev) this.sql.exec('UPDATE refs SET state = ? WHERE id = ?', JSON.stringify({ ...fresh.state, lastJev }), fresh.id);
      return false;
    }
    this.setState(fresh, { ...fresh.state, quality, ...(lastJev ? { lastJev } : {}) }, actor, 'reviewed', auditDetail(quality));
    return true;
  }

  emitRating(q, { fallback = q.fallbackReason, attempts = 0, hedged = 0, http = 0, asked = 0, escalated = 0, strict = 0, inputTokens = 0 } = {}) {
    const C = METRIC_CODES, n = x => (Number.isFinite(x) ? x : 0);
    const values = { engine: C.engine[q.engine] ?? 0, fallback: C.fallback[fallback || 'none'] ?? 0, status: C.status[q.status] ?? 0, ms: n(q.ms), attempts: n(attempts), hedged: n(hedged),
      http: n(http), cached: q.cached ? 1 : 0, asked: n(asked), holds: (q.holds || []).length, escalated: escalated ? 1 : 0, strict: strict ? 1 : 0,
      language: C.language[q.jev?.language?.code] ?? 0, input_tokens: n(inputTokens) };
    try { this.metric('story_rating', values); } catch { /* a metric never breaks a rating */ }
  }

  async runRating(row, { engine, gen, budget, waitUntil, markFirst, release, actor }) {
    const inline = !(budget === 'interactive' && waitUntil);
    const finish = async (stored, second = null) => {
      const idx = stored ? this.index(row.id).catch(() => {}) : null;
      if (!second) release(); // before markFirst: the caller's response must not say "running" for a finished rating
      markFirst();
      if (idx) { if (inline) await idx; else waitUntil(idx); }
      if (second) { try { await second; } finally { release(); } }
    };
    if (engine === 'rules') {
      const q = agentQuality({ ...noStoryQuality(row.data, { readyScore: this.readyScore, now: this.now }), revision: row.revision }, { engine: 'rules', fallbackReason: 'no_story', gen });
      const stored = this.storeRating(row, gen, q, actor);
      this.emitRating(q);
      return finish(stored);
    }
    let fallback = engine === 'jev' ? null : this.rater?.available() ? 'no_consent' : 'no_key', meta = {};
    if (engine === 'jev') {
      let done = null;
      // Any JEV failure falls back to the review agent. An unexpected error is recorded as `rejected` (metric 7): the
      // person still gets a rating, and the metric shows JEV did not answer.
      try { done = await this.jevRating(row, { gen, budget }); }
      catch (e) { fallback = e instanceof RatingError ? e.code : 'rejected'; meta = e instanceof RatingError ? e.meta : {}; }
      if (done) {
        const stored = this.storeRating(row, gen, done.quality, actor, done.lastJev);
        this.emitRating(done.quality, { ...done.meta, escalated: done.escalate, strict: done.quality.jev.strict });
        return finish(stored, stored && done.escalate && this.complete ? this.secondOpinion(row, gen, done) : null);
      }
    }
    const t0 = Date.now(), q0 = await reviewReference(row.data, this.complete || (async () => { throw new Error('no review agent'); }),
      { view: d => recordView(this, d), readyScore: this.readyScore, now: this.now, model: this.model });
    const q = agentQuality({ ...q0, revision: row.revision }, { fallbackReason: fallback, gen, ms: Date.now() - t0 });
    const stored = this.storeRating(row, gen, q, actor);
    this.emitRating(q, meta);
    return finish(stored);
  }

  // The JEV engine: rules first, the masked state, the body; the last answer is reused when the body is unchanged.
  async jevRating(row, { gen, budget }) {
    const t0 = Date.now();
    if (this.rater.blocked() === 'auth') throw new RatingError('auth'); // skipped until the key changes; never reused
    const input = ratingInput(this, row.data, { owner: row.owner, ...(this.ratingView ? { view: this.ratingView } : {}) });
    const plan = questionPlan(row.data, input.figure), asked = plan.asked;
    const bodyText = JSON.stringify(requestBody(input.state, asked)), bodyHash = await sha256Hex(bodyText);
    const last = this.row(row.id)?.state?.lastJev;
    let answers, meta, lastJev = null, cached = false;
    if (last && last.bodyHash === bodyHash && last.rubric === RUBRIC_VERSION && last.answers) {
      answers = last.answers; cached = true; meta = { attempts: 0, hedged: 0, http: 0, inputTokens: 0 };
    } else {
      let r;
      try { r = await this.rater.rate(bodyText, JSON.stringify(input.state.reference), { asked, terms: input.terms, budget }); }
      catch (e) { throw e instanceof RatingError ? new RatingError(e.code, { ...e.meta, asked: asked.length }) : e; }
      answers = r.answers; meta = { attempts: r.attempts, hedged: r.hedged, http: r.http, inputTokens: r.inputTokens ?? 0 };
      lastJev = { bodyHash, rubric: RUBRIC_VERSION, model: MODEL, answers, inputTokens: r.inputTokens ?? 0 };
    }
    const strict = row.state.validation?.status === 'admin_bypass' && !row.state.test;
    const opts = { asked, ruled: plan.ruled, readyScore: this.readyScore, strict, ms: Date.now() - t0, cached, model: answers.model, now: this.now, revision: row.revision, gen };
    const { quality, escalate } = compose(row.data, answers, { ...opts, second: this.complete ? 'running' : 'unanswered' });
    return { quality, escalate, lastJev, meta: { ...meta, asked: asked.length }, unanswered: escalate ? compose(row.data, answers, { ...opts, second: 'unanswered' }).quality : null };
  }

  // §5.5 escalation: today's review agent decides, in the same generation. If it does not answer, the JEV rating stays
  // needs_work and says a reviewer should check the unsure parts.
  async secondOpinion(row, gen, done) {
    const t0 = Date.now(), q0 = await reviewReference(row.data, this.complete, { view: d => recordView(this, d), readyScore: this.readyScore, now: this.now, model: this.model });
    const strict = done.quality.jev.strict;
    if (q0.aiScore !== null) {
      const q = agentQuality({ ...q0, revision: row.revision }, { engine: 'review-agent', escalatedFrom: 'jev', fallbackReason: 'escalated', jev: done.quality.jev, holds: [], gen, ms: Date.now() - t0 });
      this.storeRating(row, gen, q, 'atlas');
      this.emitRating(q, { strict });
    } else {
      this.storeRating(row, gen, done.unanswered, 'atlas');
      this.emitRating({ ...done.unanswered, engine: 'rules', ms: Date.now() - t0 }, { fallback: 'escalated', strict });
    }
  }

  // Semantic index + duplicate detection (same project ID, or very similar anonymised content). Reciprocal flags.
  async index(id) {
    const row = this.row(id); if (!row) return;
    const vec = this.embed ? await this.embed(searchText(recordView(this, row.data))) : null;
    if (vec) this.sql.exec('UPDATE refs SET embedding = ? WHERE id = ?', JSON.stringify(vec), id);
    const storyTenant = String(row.tenant || row.state?.tenant || '').toLowerCase();
    const others = this.rows("SELECT id, title, data, state, embedding, tenant FROM refs WHERE merged_into IS NULL AND id != ? AND lower(COALESCE(tenant, '')) = ?", id, storyTenant);
    const mine = [], pid = row.data.details.projectId.toLowerCase();
    for (const o of others) {
      const od = JSON.parse(o.data), sim = vec && o.embedding ? cosine(vec, JSON.parse(o.embedding)) : lexical(searchText(forModel(row.data)), searchText(forModel(od)));
      const sameId = pid && od.details.projectId.toLowerCase() === pid;
      if (sameId || sim >= DUPLICATE) {
        const hit = { id: o.id, similarity: Math.round(sim * 100) / 100, sameProjectId: !!sameId };
        mine.push(hit);
        const os = JSON.parse(o.state), list = (os.duplicates || []).filter(x => x.id !== id);
        list.push({ id, similarity: hit.similarity, sameProjectId: hit.sameProjectId });
        this.sql.exec('UPDATE refs SET state = ? WHERE id = ?', JSON.stringify({ ...os, duplicates: list.slice(0, 10) }), o.id);
      }
    }
    mine.sort((a, b) => (b.sameProjectId - a.sameProjectId) || (b.similarity - a.similarity)); // strongest signal first
    const fresh = this.row(id);
    this.sql.exec('UPDATE refs SET state = ? WHERE id = ?', JSON.stringify({ ...fresh.state, duplicates: mine.slice(0, 10) }), id);
    if (mine.length) this.log(id, 'atlas', 'possible duplicate', String(mine.length));
  }

  // Natural-language recommendation: understand the context, retrieve by meaning, then rerank with reasons.
  async recommend(user, body = {}) {
    const query = str(obj(body).query, 1200), limit = Math.max(1, Math.min(10, Number(obj(body).limit) || 5));
    if (query.length < 8) throw fail(400, 'Describe the client or the meeting in a sentence.');
    if (!this.complete) throw fail(503, 'Recommendations are not available.');
    // The query is typed text: every model call gets its pseudonymised form, and what comes back to the caller is
    // un-masked with its map, so they read their own words (no trace of which names ATLAS knows).
    const q = pseudonymise(this, query), mine = forAuthor(this, q.map, { authorText: q.text });
    const target = parseTarget(await this.complete([{ role: 'system', content: TARGET_POLICY }, { role: 'user', content: q.text }]).catch(() => ''), q.text);
    const pool = this.visibleRows(user).filter(([r, level]) => r.status === 'published' || level === 'full');
    if (!pool.length) return { target: mine(target), results: [], method: 'none', note: 'No references are available to you yet.' };
    const want = [target.searchText, target.industry, target.likelyChallenges.join('. '), target.capabilities.join(', ')].join('\n');
    const qv = this.embed ? await this.embed(want).catch(() => null) : null;
    const wins = winSignals(this, user); // bounded win-history boost (F7): order only, never model relevance, this tenant only
    const scored = pool.map(([r, level]) => {
      const m = forModel(r.data), sem = qv && r.embedding ? cosine(qv, JSON.parse(r.embedding)) : null, lex = lexical(want, searchText(m));
      const boost = (target.industry && (r.data.sector || '').toLowerCase().includes(target.industry.toLowerCase().split(/\s+/)[0]) ? 0.05 : 0) + (wins.get(r.id)?.boost || 0);
      return { r, level, score: (sem ?? lex) + boost, similarity: sem ?? lex };
    }).sort((a, b) => b.score - a.score).slice(0, 12);
    const cards = scored.map(s => candidateCard(s.r.id, recordView(this, s.r.data)));
    const ranked = parseRerankStrict(await this.complete([{ role: 'system', content: RERANK_POLICY },
      { role: 'user', content: JSON.stringify({ context: { query: q.text, ...target }, candidates: cards }) }]).catch(() => ''), cards.map(c => c.id));
    // Unranked either way, but say which: the model did not answer (null) or nothing reached 30 ([]).
    const caveat = ranked ? 'Matched by similarity only; no candidate reached the relevance threshold of 30.' : 'Matched by similarity only; the ranking model did not answer.';
    const byId = new Map(scored.map(s => [s.r.id, s]));
    const results = (ranked?.length ? ranked : scored.slice(0, limit).map(s => ({ id: s.r.id, relevance: null, why: '', transferable: [], caveat })))
      .slice(0, limit).map(x => { const s = byId.get(x.id); return { ...this.summary(s.r, s.level, user), ...x, why: mine(x.why), transferable: mine(x.transferable), caveat: mine(x.caveat), similarity: Math.round(s.similarity * 100) / 100 }; });
    this.log('library', user.email, 'recommendation', `${results.length} results`);
    return { target: mine(target), results, method: (qv ? 'semantic' : 'lexical') + (ranked?.length ? ' + model ranking' : ''), label: 'Relevance and reasons are interpretation; open each reference for the facts.' };
  }

  // Consolidation: one stronger reference; every consultant keeps access and their own contribution.
  async merge(user, body = {}) {
    this.demandTenant(user);
    if (!['admin', 'reviewer'].includes(user.role)) throw fail(403, 'Only a reviewer can merge references.');
    const keep = this.row(obj(body).keep), gone = this.row(obj(body).merge);
    if (!keep || !gone || keep.id === gone.id || keep.merged_into || gone.merged_into) throw fail(400, 'Choose two different active references.');
    if (!this.access(keep, user) || !this.access(gone, user)) throw fail(404, 'Reference not found.');
    const k = structuredClone(keep.data), g = gone.data;
    const people = [...k.details.consultants];
    for (const c of [{ name: g.consultant.name, email: gone.owner, role: g.consultant.role }, ...g.details.consultants])
      if ((c.name || c.email) && !people.some(p => (c.email && p.email === c.email) || (!c.email && p.name === c.name))) people.push(c);
    k.details.consultants = people.slice(0, 20);
    for (const key of ['technologies', 'deliverables', 'serviceLines', 'teamRoles']) k.details[key] = [...new Set([...k.details[key], ...g.details[key]])].slice(0, 15);
    k.details.links = [...k.details.links, ...g.details.links.filter(l => !k.details.links.some(x => x.url === l.url))].slice(0, 10);
    k.sources = [...k.sources, ...g.sources].slice(0, 20);
    // No name or email in the text: answers reach models through forModel and recordView (WOW_ZERO_CONFIG §5.9); who
    // contributed stays in details.consultants and members.
    if (g.answers[1] && !k.answers[1].includes(g.answers[1])) k.answers[1] = (k.answers[1] + '\n\nContribution by another consultant: ' + g.answers[1]).trim().slice(0, 6000);
    for (const i of [0, 2, 3, 4, 5]) if (!k.answers[i] && g.answers[i]) k.answers[i] = g.answers[i];
    this.sql.exec('UPDATE refs SET merged_into = ?, status = ? WHERE id = ?', keep.id, 'withdrawn', gone.id);
    const sharedWith = [...new Set([...(keep.state.sharedWith || []), gone.owner].filter(Boolean))];
    this.sql.exec('UPDATE refs SET state = ?, members = ? WHERE id = ?', JSON.stringify({ ...keep.state, sharedWith }), (keep.members || ',') + sharedWith.join(',') + ',', keep.id);
    this.log(gone.id, user.email, 'merged into', keep.id);
    const saved = await this.upsert({ ...user }, { id: keep.id, reference: k });
    this.log(keep.id, user.email, 'consolidated', `merged ${gone.data.title} (${gone.id})`);
    return saved;
  }

  // Client-context slide content; the client name is added by code only for people allowed to see it.
  async slides(user, id, body = {}) {
    const row = this.row(id), level = this.access(row, user);
    if (!level) throw fail(404, 'Reference not found.');
    if (row.status !== 'published' && level !== 'full') throw fail(403, 'Only published references can be turned into slides.');
    if (!this.complete) throw fail(503, 'Slide generation is not available.');
    // The context is typed text: pseudonymised for the model, the slide text un-masked for the caller; the audit row
    // keeps only its length (it may name the prospect).
    const m = recordView(this, row.data), context = str(obj(body).context, 800), c = pseudonymise(this, context);
    const source = JSON.stringify(m);
    const out = parseSlides(await this.complete([{ role: 'system', content: SLIDES_POLICY }, { role: 'user', content: JSON.stringify({ context: c.text || 'A general client presentation.', reference: m }) }]).catch(() => ''), source + ' ' + c.text);
    if (!out) throw fail(502, 'The slide writer did not produce usable text. Try again.');
    const d = row.data.details;
    this.log(id, user.email, 'slides generated', `context ${context.length} characters`);
    return { ...forAuthor(this, c.map, { authorText: c.text })(out), reference: { id, title: row.data.title, status: row.status, revision: row.revision }, facts: { industry: row.data.sector, country: d.country, timeline: d.start || d.end ? `${d.start || '?'} – ${d.end || 'ongoing'}` : d.duration, team: d.teamSize ? `${d.teamSize} people` : '', technologies: d.technologies.slice(0, 6) },
      client: obj(body).includeClient && level === 'full' ? row.data.client.name : '', warning: row.status === 'published' ? '' : 'Draft reference: not validated for client use.' };
  }

  analytics(user) {
    this.demandTenant(user);
    const rows = this.visibleRows(user).map(([r, l]) => [r, l]), now = this.now();
    const count = (key, pick) => { const out = {}; for (const [r] of rows) for (const v of [].concat(pick(r)).filter(Boolean)) out[v] = (out[v] || 0) + 1; return Object.entries(out).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n })); };
    const pub = rows.filter(([r]) => r.status === 'published');
    const countries = [...new Set(rows.map(([r]) => r.data.details.country).filter(Boolean))];
    const coverage = Object.values(PRACTICES).map(p => ({ practice: p, countries: Object.fromEntries(countries.map(c => [c, pub.filter(([r]) => r.data.jev?.primary?.label === p && r.data.details.country === c).length])) }));
    const gaps = []; for (const row of coverage) for (const [c, n] of Object.entries(row.countries)) if (!n) gaps.push(`${row.practice} in ${c}`);
    const inviteTenant = String(user.tenant || '').toLowerCase();
    const openInvites = this.rows("SELECT project_id, title, email, reason FROM invitations WHERE status IN ('open','scheduled') AND (reference_id IS NULL OR reference_id = '') AND lower(COALESCE(tenant, '')) = ?", inviteTenant)
      .filter(i => ['admin', 'reviewer'].includes(user.role) || i.email === user.email);
    return {
      totals: { visible: rows.length, published: pub.length, byStatus: count('status', r => r.status) },
      byCountry: count('country', r => r.data.details.country), byServiceLine: count('service', r => r.data.details.serviceLines), byPractice: count('practice', r => r.data.jev?.primary?.label),
      byIndustry: count('industry', r => r.data.sector), byTechnology: count('tech', r => r.data.details.technologies), byConsultant: count('people', r => [r.data.consultant.name, ...r.data.details.consultants.map(c => c.name)]),
      byClient: ['admin', 'reviewer'].includes(user.role) ? count('client', r => r.data.client.name) : [],
      coverage, coverageGaps: gaps.slice(0, 40), strongest: pub.sort((a, b) => (b[0].quality_score || 0) - (a[0].quality_score || 0)).slice(0, 5).map(([r, l]) => this.summary(r, l, user)),
      needsEnrichment: rows.filter(([r]) => ['needs_work', 'changes_requested', 'in_review'].includes(r.status) || (r.next_review && r.next_review < now)).slice(0, 20).map(([r, l]) => ({ ...this.summary(r, l, user), stale: !!(r.next_review && r.next_review < now) })),
      activityWithoutReference: openInvites.slice(0, 20).map(i => ({ projectId: i.project_id, title: i.title, reason: i.reason })),
    };
  }

  async insights(user) {
    if (!['admin', 'reviewer'].includes(user.role)) throw fail(403, 'Commercial insights are for reviewers.');
    if (!this.complete) throw fail(503, 'Insights are not available.');
    const pub = this.visibleRows(user).filter(([r]) => r.status === 'published').slice(0, 60);
    if (pub.length < 3) return { repeatedNeeds: [], emergingExpertise: [], offeringIdeas: [], gaps: [], label: 'interpretation', note: 'At least three published references are needed.' };
    const cards = pub.map(([r]) => candidateCard(r.id, recordView(this, r.data)));
    const out = parseInsights(await this.complete([{ role: 'system', content: INSIGHTS_POLICY }, { role: 'user', content: JSON.stringify({ references: cards }) }], 4000).catch(() => ''), cards.map(c => c.id));
    if (!out) throw fail(502, 'The insights model did not answer. Try again.');
    this.log('library', user.email, 'insights', `${pub.length} references`);
    return { ...out, titles: Object.fromEntries(pub.map(([r]) => [r.id, r.data.title])), basedOn: pub.length };
  }

  // ---- Interview invitations: lifecycle triggers and six-month updates. Nothing is ever sent automatically. ----
  invite(actor, body = {}, caller) {
    const b = obj(body), to = email(b.email);
    if (!to) throw fail(400, 'A consultant email is required.');
    const user = caller && typeof caller === 'object' ? caller : null;
    if (user?.tenantEnforced === true && !TENANT_ID.test(String(user.tenant || ''))) throw fail(403, 'A verified tenant is required.');
    const tenant = user ? String(user.tenant || '').toLowerCase() : String(b.tenant || '').toLowerCase();
    if (b.tenant !== undefined && String(b.tenant).toLowerCase() !== tenant) throw fail(403, 'An invitation cannot choose a different tenant.');
    const reason = ['project_end', 'milestone', 'six_month_update', 'periodic_review', 'manual'].includes(b.reason) ? b.reason : 'manual';
    const refId = str(b.referenceId, 40), pid = str(b.projectId, 60);
    if (refId && user && !this.access(this.row(refId), user)) throw fail(404, 'Reference not found.');
    if (refId && !user && this.auditId(refId, tenant) !== refId) throw fail(404, 'Reference not found.');
    const dupe = this.rows("SELECT id FROM invitations WHERE lower(email) = ? AND reason = ? AND status IN ('open','scheduled') AND lower(project_id) = lower(?) AND reference_id = ? AND lower(COALESCE(tenant, '')) = ?", to, reason, pid, refId, tenant)[0];
    if (dupe) return this.rows('SELECT * FROM invitations WHERE id = ?', dupe.id)[0];
    const id = this.newId(), slot = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(b.slot || '')) ? String(b.slot).slice(0, 25) : '';
    this.sql.exec('INSERT INTO invitations (id, email, project_id, title, reason, slot, reference_id, status, created_at, source, tenant) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, to, pid, str(b.title, 140), reason, slot, refId, slot ? 'scheduled' : 'open', this.now(), str(b.source || actor, 60), tenant);
    this.log(this.auditId(refId, tenant), actor, 'interview invitation', `${reason} for ${to}`);
    return this.rows('SELECT * FROM invitations WHERE id = ?', id)[0];
  }
  invitations(user) {
    if (user.tenantEnforced === true && !TENANT_ID.test(String(user.tenant || ''))) throw fail(403, 'A verified tenant is required.');
    const tenant = String(user.tenant || '').toLowerCase();
    if (['admin', 'reviewer'].includes(user.role) && user.all) {
      const sql = user.tenantEnforced === true
        ? "SELECT * FROM invitations WHERE lower(COALESCE(tenant, '')) = ? ORDER BY created_at DESC LIMIT 200"
        : "SELECT * FROM invitations WHERE lower(COALESCE(tenant, '')) = '' ORDER BY created_at DESC LIMIT 200";
      const rows = user.tenantEnforced === true ? this.rows(sql, tenant) : this.rows(sql);
      return rows.map(row => this.invitationView(user, row));
    }
    const aliases = [...new Set([user.email, user.mail].map(v => String(v || '').trim().toLowerCase()).filter(Boolean))];
    if (!aliases.length) return [];
    const marks = aliases.map(() => '?').join(', ');
    return this.rows(`SELECT * FROM invitations WHERE lower(email) IN (${marks}) AND status IN ('open','scheduled') AND lower(COALESCE(tenant, '')) = ? ORDER BY created_at DESC`, ...aliases, user.tenantEnforced === true ? tenant : '')
      .map(row => this.invitationView(user, row));
  }
  invitationView(user, row) {
    const refId = String(row?.reference_id || '');
    const base = { id: row.id, status: row.status, reason: row.reason, slot: row.slot || '', created_at: row.created_at, tenant: row.tenant || '' };
    if (!refId) return { ...base, title: row.title || '', project_id: row.project_id || '' };
    const linked = this.row(refId);
    const linkedTenant = String(linked?.tenant || linked?.state?.tenant || '').toLowerCase();
    if (!linked || !this.access(linked, user) || linkedTenant !== String(row.tenant || '').toLowerCase()) return base;
    return { ...base, title: row.title || '', project_id: row.project_id || '', reference_id: refId };
  }
  updateInvitation(user, id, body = {}) {
    const inv = this.rows('SELECT * FROM invitations WHERE id = ?', String(id))[0];
    const aliases = this.identityAliases(user);
    if (!inv || (!aliases.includes(String(inv.email || '').toLowerCase()) && !['admin', 'reviewer'].includes(user.role))) throw fail(404, 'Invitation not found.');
    if (user.tenantEnforced === true && !sameTenant(inv.tenant, user.tenant, true)) throw fail(404, 'Invitation not found.');
    const action = obj(body).action;
    if (!['schedule', 'dismiss', 'done'].includes(action)) throw fail(400, 'Unknown action.');
    const nextRef = str(obj(body).referenceId, 40);
    const existingRef = String(inv.reference_id || '');
    const openRef = refId => {
      if (!refId) return false;
      const linked = this.row(refId);
      const linkedTenant = String(linked?.tenant || linked?.state?.tenant || '').toLowerCase();
      return !!(linked && this.access(linked, user) && linkedTenant === String(inv.tenant || '').toLowerCase());
    };
    if (action === 'done') {
      if (!nextRef && !existingRef) throw fail(400, 'A reference is required.');
      if (existingRef && !openRef(existingRef)) throw fail(404, 'Reference not found.');
      if (nextRef && !openRef(nextRef)) throw fail(404, 'Reference not found.');
    }
    const keptRef = action === 'done' && nextRef ? nextRef : existingRef;
    const storyOpen = openRef(keptRef);
    if (keptRef && !storyOpen) {
      if (action !== 'dismiss') throw fail(404, 'Reference not found.');
      this.sql.exec("UPDATE invitations SET status = 'dismissed' WHERE id = ?", inv.id);
      return this.invitationView(user, this.rows('SELECT * FROM invitations WHERE id = ?', inv.id)[0]);
    }
    const auditOn = storyOpen ? this.auditFor(user, keptRef, inv.tenant) : 'library';
    if (action === 'schedule') { const slot = String(obj(body).slot || ''); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(slot)) throw fail(400, 'Pick a date and time.'); this.sql.exec("UPDATE invitations SET slot = ?, status = 'scheduled' WHERE id = ?", slot.slice(0, 25), inv.id); }
    else if (action === 'dismiss') this.sql.exec("UPDATE invitations SET status = 'dismissed' WHERE id = ?", inv.id);
    else if (action === 'done') this.sql.exec("UPDATE invitations SET status = 'done', reference_id = ? WHERE id = ?", nextRef || inv.reference_id, inv.id);
    else throw fail(400, 'Unknown action.');
    this.log(auditOn, user.email, 'invitation ' + action, inv.reason);
    return this.invitationView(user, this.rows('SELECT * FROM invitations WHERE id = ?', inv.id)[0]);
  }
  // Daily: every reference not updated for six months gets one open update invitation for its owner.
  scanStale(user = {}) {
    const due = this.rows('SELECT id, owner, title, data, state FROM refs WHERE merged_into IS NULL AND next_review < ? AND status != ?', this.now(), 'withdrawn')
      .filter(r => { let tenant = ''; try { tenant = JSON.parse(r.state || '{}').tenant || ''; } catch { return false; } return sameTenant(tenant, user.tenant, user.tenantEnforced === true); });
    const tenant = user.tenantEnforced === true ? String(user.tenant || '').toLowerCase() : '';
    let invited = 0;
    for (const r of due) {
      let recordTenant = '';
      try { recordTenant = JSON.parse(r.state || '{}').tenant || ''; } catch { continue; }
      const to = this.reachableOwnerAddress({ owner: r.owner, tenant: recordTenant, state: { tenant: recordTenant } });
      if (!to) continue;
      this.invite('atlas', { email: to, reason: 'six_month_update', referenceId: r.id, projectId: JSON.parse(r.data).details.projectId, title: r.title, source: 'six-month scan', tenant });
      invited++;
    }
    return invited;
  }

  // ---- Corporate export / import. Verified admins only, tenant-scoped, audited. No story text in the audit line. ----
  exportAll(user) {
    if (user.role !== 'admin') throw fail(403, 'Export is for a verified admin.');
    if (user.tenantEnforced === true && !TENANT_ID.test(String(user.tenant || ''))) throw fail(403, 'A verified tenant is required.');
    const references = this.rows('SELECT id, owner, status, revision, updated_at, data, state FROM refs WHERE merged_into IS NULL')
      .filter(r => { let recordTenant = ''; try { recordTenant = JSON.parse(r.state || '{}').tenant || ''; } catch { return false; } return sameTenant(recordTenant, user.tenant, user.tenantEnforced === true); })
      .map(r => ({ id: r.id, owner: r.owner, status: r.status, revision: r.revision, updatedAt: r.updated_at, quality: JSON.parse(r.state).quality?.score ?? null, reference: JSON.parse(r.data) }));
    this.log('library', user.email, 'admin export', `${references.length} references`);
    return { schema: 'atlas.reference.v1', exportedAt: this.now(), references };
  }
  async importAll(user, body = {}) {
    if (user.role !== 'admin') throw fail(403, 'Import is for a verified admin.');
    if (user.tenantEnforced === true && !TENANT_ID.test(String(user.tenant || ''))) throw fail(403, 'A verified tenant is required.');
    const items = Array.isArray(obj(body).references) ? obj(body).references.slice(0, 500) : [];
    const out = { created: 0, unchanged: 0, rejected: [] };
    for (const [i, it] of items.entries()) {
      try { const r = await this.upsert(user, { localId: 'import:' + str(obj(it).externalId || obj(it).id || String(i), 80), reference: obj(it).reference || it }); r.unchanged ? out.unchanged++ : out.created++; }
      catch (e) { out.rejected.push({ index: i, error: e.message }); }
    }
    this.log('library', user.email, 'import', JSON.stringify({ created: out.created, unchanged: out.unchanged, rejected: out.rejected.length }));
    return out;
  }

  validate(user, id, body = {}) {
    this.demandTenant(user);
    const row = this.row(id);
    if (!row || !this.access(row, user)) throw fail(404, 'Reference not found.');
    const lane = body.lane === 'manager' ? 'manager' : body.lane === 'presales' ? 'presales' : '';
    if (!lane) throw fail(400, 'Choose a lane: manager or presales.');
    if (lane === 'manager' && !this.canManagerApprove(row, user)) throw fail(403, 'Only the trusted manager from directory or staffing can approve this lane.');
    if (lane === 'presales' && !this.canPresalesApprove(row, user)) throw fail(403, 'Only a verified bid/pre-sales reviewer can approve this lane.');
    const decision = body.decision === 'request_changes' ? 'changes_requested' : body.decision === 'validate' ? 'approved' : '';
    if (!decision) throw fail(400, 'Choose validate or request_changes.');
    const note = str(body.note, 500);
    if (decision === 'changes_requested' && !note) throw fail(400, 'Say what should change.');
    const prev = row.state.validation || {};
    const validation = { ...prev, by: user.email, at: this.now(), note, status: 'pending' };
    if (lane === 'manager') validation.managerDecision = decision;
    else validation.presalesDecision = decision;
    if (validation.managerDecision === 'changes_requested' || validation.presalesDecision === 'changes_requested') validation.status = 'changes_requested';
    else if (validation.managerDecision === 'approved' && validation.presalesDecision === 'approved') validation.status = 'validated';
    this.setState(row, { ...row.state, validation }, user.email, lane + ' ' + decision, lane);
    return this.get(user, id);
  }

  async adminPublish(user, id, body = {}) {
    if (user.role !== 'admin') throw fail(403, 'Only a verified admin can publish without the two approvals.');
    this.demandTenant(user);
    const row = this.row(id);
    if (!row || !this.access(row, user)) throw fail(404, 'Reference not found.');
    const test = body.test === true;
    const validation = { ...(row.state.validation || {}), status: 'admin_bypass', by: user.email, at: this.now(), note: test ? 'admin test' : 'admin publish' };
    this.setState(row, { ...row.state, test, validation }, user.email, 'admin-publish-bypass', test ? 'test' : 'publish');
    await recordUsage(this, user, { kind: 'admin_publish', feature: 'library', outcome: test ? 'test' : 'publish', tokenStatus: 'missing' });
    return this.get(user, id);
  }

  withdraw(user, id, body = {}) {
    const row = this.row(id);
    if (!row || !this.access(row, user)) throw fail(404, 'Reference not found.');
    if (!this.canEdit(row, user)) throw fail(403, 'You cannot withdraw this reference.');
    this.setState(row, { ...row.state, withdrawn: true }, user.email, 'withdrawn', str(body.note, 300));
    return this.get(user, id);
  }

  reinstate(user, id) {
    this.demandTenant(user);
    const row = this.row(id);
    if (!row || !sameTenant(row.tenant || row.state?.tenant, user.tenant, user.tenantEnforced === true)) throw fail(404, 'Reference not found.');
    if (!['admin', 'reviewer'].includes(user.role)) throw fail(403, 'Only a reviewer can reinstate a reference.');
    this.setState(row, { ...row.state, withdrawn: false }, user.email, 'reinstated', '');
    return this.get(user, id);
  }
}
