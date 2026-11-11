// Living CV and fiche routes. The consultant asks for a draft. Evidence is published library
// snippets only. Status changes go through transition(), then this module writes, then it logs.
import { fail, obj, para, uuidish } from './util.js';
import { sameTenant, TENANT_ID } from './authz.js';
import { snippetsOf } from './snippets.js';
import { storedConsent } from './profile.js';
import { recordUsage } from './telemetry.js';
import {
  SmartNeedLinkAdapter, PastedJobDescriptionAdapter, composeCv, buildFiche, transition, hasTerm,
  MiChatAdapter, atlasExport, bytesToBase64, toCompetencyFile,
} from './living-core.js';

export const READY = true;
const TOPIC = ['context', 'contribution', 'approach', 'outcome', 'evidence', 'customer_relevance'];
const TOPIC_ORDER = { outcome: 0, contribution: 1, evidence: 2, context: 3, approach: 4, customer_relevance: 5 };

export function ensure(lib) {
  lib.sql.exec(`CREATE TABLE IF NOT EXISTS living_artifacts (
    id TEXT PRIMARY KEY, tenant TEXT, owner TEXT, type TEXT, status TEXT, payload TEXT, created_at TEXT, updated_at TEXT)`);
  lib.sql.exec('CREATE INDEX IF NOT EXISTS living_owner ON living_artifacts(owner, type)');
}

function demand(user) {
  if (user?.tenantEnforced === true && !TENANT_ID.test(String(user.tenant || ''))) throw fail(403, 'A verified tenant is required.');
}

function tenantOf(user) { return String(user?.tenant || '').trim().toLowerCase(); }

function requireConsent(lib, user) {
  if (!storedConsent(lib, user.email, 'profileReuse', tenantOf(user))) throw fail(403, 'Consent required.');
}

export function publishedMine(lib, user) {
  return lib.visibleRows(user)
    .filter(([row, level]) => level === 'full' && row.owner === user.email && row.status === 'published')
    .map(([row]) => row)
    .sort((a, b) => String(b.data?.details?.end || b.updated_at || '').localeCompare(String(a.data?.details?.end || a.updated_at || '')));
}

function linesOf(lib, row, audience) {
  return snippetsOf(lib, row.data).map(snip => {
    const text = audience === 'external' ? snip.text : snip.raw;
    const topic = TOPIC[snip.topic] || snip.kind;
    return {
      text, evidenceId: `${row.id}:${snip.id}`, storyId: row.id, topic, kind: snip.kind,
      at: row.data?.details?.end || row.updated_at || '',
      storyTitle: row.data?.title || '',
      role: row.data?.consultant?.role || '', roleEvidenceId: `${row.id}:role`,
      period: [row.data?.details?.start, row.data?.details?.end].filter(Boolean).join(' – '),
      periodEvidenceId: `${row.id}:period`,
      company: audience === 'external' ? null : (row.data?.client?.name || null),
      companyEvidenceId: audience === 'external' ? null : `${row.id}:client`,
      technologies: (row.data?.details?.technologies || []).filter(item => hasTerm(text, item)),
    };
  }).filter(line => line.text).sort((a, b) => (TOPIC_ORDER[a.topic] ?? 9) - (TOPIC_ORDER[b.topic] ?? 9)).slice(0, 8);
}

function consultantOf(stories) {
  const first = stories[0];
  return {
    name: first?.data?.consultant?.name || '',
    nameEvidenceId: first ? `${first.id}:consultant` : null,
    role: first?.data?.consultant?.role || '',
    roleEvidenceId: first ? `${first.id}:role` : null,
  };
}

function readArtifact(lib, id) {
  const row = lib.rows('SELECT id, tenant, owner, type, status, payload, created_at, updated_at FROM living_artifacts WHERE id = ?', id)[0];
  if (!row) return null;
  return { ...row, payload: JSON.parse(row.payload || '{}') };
}

function mayApprove(lib, user, row) {
  if (!user?.email || user.email === row.owner) return false;
  if (!sameTenant(row.tenant, user.tenant, user.tenantEnforced === true)) return false;
  if (['admin', 'reviewer'].includes(user.role)) return true;
  const owner = { email: row.owner, role: 'user', tenant: user.tenant, tenantEnforced: user.tenantEnforced === true };
  const stories = publishedMine(lib, owner);
  if (user.role === 'presales' && lib.canPresalesApprove({ owner: row.owner, state: { tenant: row.tenant }, data: { details: {} } }, user)) return true;
  return stories.some(story => lib.canManagerApprove(story, user));
}

function canSee(lib, user, row) {
  if (!row || !sameTenant(row.tenant, user.tenant, user.tenantEnforced === true)) return false;
  return row.owner === user.email || mayApprove(lib, user, row);
}

// The only status writer. transition() decides; this writes; the log follows the write.
function commit(lib, user, row, event) {
  const next = transition(row.status, event);
  if (!next.ok) throw fail(409, 'That action is not available.');
  row.status = next.to;
  row.payload = { ...row.payload, status: next.to };
  const at = lib.now();
  lib.sql.exec('UPDATE living_artifacts SET status = ?, payload = ?, updated_at = ? WHERE id = ?', row.status, JSON.stringify(row.payload), at, row.id);
  lib.log(row.id, user.email, 'living ' + event, row.id + ' ' + next.from + '->' + next.to);
  return row;
}

function createArtifact(lib, user, type, payload) {
  const id = lib.newId(), at = lib.now(), tenant = tenantOf(user);
  const body = { ...payload, id, type, status: 'draft' };
  lib.sql.exec('INSERT INTO living_artifacts (id, tenant, owner, type, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, tenant, user.email, type, 'draft', JSON.stringify(body), at, at);
  lib.log(id, user.email, 'living create', id + ' draft');
  return commit(lib, user, { id, tenant, owner: user.email, type, status: 'draft', payload: body }, 'submit');
}

function viewOf(lib, user, row) {
  const p = row.payload || {};
  return {
    id: row.id, type: row.type, status: row.status,
    consultant: { name: p.consultant?.name || '', role: p.consultant?.role || '' },
    cf: p.cf || null,
    lines: (p.lines || []).map(line => ({ text: line.text, source: line.source || line.text, evidenceId: line.evidenceId, storyId: line.storyId, topic: line.topic, storyTitle: line.storyTitle || '' })),
    provenance: (p.provenance || []).map(line => ({ text: line.text, source: line.source || line.text, evidenceId: line.evidenceId, storyId: line.storyId, topic: line.topic })),
    gaps: p.gaps || [], flags: p.flags || [],
    need: p.need ? { source: p.need.source, needId: p.need.needId || '', title: p.need.title || '', keywords: p.need.keywords || [], flags: p.need.flags || [] } : null,
    fiche: p.fiche || null,
    canApprove: mayApprove(lib, user, row),
  };
}

function latest(lib, user, type) {
  const row = lib.rows("SELECT id FROM living_artifacts WHERE owner = ? AND type = ? AND lower(COALESCE(tenant, '')) = ? ORDER BY updated_at DESC LIMIT 1", user.email, type, tenantOf(user))[0];
  return row ? readArtifact(lib, row.id) : null;
}

function reviewQueue(lib, user) {
  const rows = lib.rows("SELECT id FROM living_artifacts WHERE status = 'in_review' AND owner != ? AND lower(COALESCE(tenant, '')) = ?", user.email, tenantOf(user));
  return rows.map(item => readArtifact(lib, item.id)).filter(row => row && mayApprove(lib, user, row)).map(row => viewOf(lib, user, row));
}

function profile(lib, user) {
  const stories = publishedMine(lib, user);
  const lines = stories.flatMap(row => linesOf(lib, row, 'internal')).slice(0, 8);
  const cv = latest(lib, user, 'cv');
  const fiche = latest(lib, user, 'fiche');
  return {
    name: stories[0]?.data?.consultant?.name || '',
    role: stories[0]?.data?.consultant?.role || '',
    evidence: lines.map(line => ({ text: line.text, evidenceId: line.evidenceId, storyTitle: line.storyTitle })),
    stories: stories.map(row => ({ id: row.id, title: row.data?.title || '' })),
    consent: storedConsent(lib, user.email, 'profileReuse', tenantOf(user)),
    cv: cv ? viewOf(lib, user, cv) : null,
    fiche: fiche ? viewOf(lib, user, fiche) : null,
    queue: reviewQueue(lib, user),
  };
}

function resolveNeed(smart, paste, link, text) {
  if (link) {
    const got = smart.resolve(link);
    if (got.ok) return got;
    if (!text) return got;
  }
  if (text) {
    const got = paste.resolve(text);
    if (!got.ok) throw fail(400, 'The job description is empty.');
    return got;
  }
  return null;
}

function stillLive(lib, user, audience, lines) {
  const stories = new Map(publishedMine(lib, user).map(row => [row.id, row]));
  return lines.every(line => {
    const row = stories.get(line.storyId);
    if (!row) return false;
    const snip = snippetsOf(lib, row.data).find(item => `${row.id}:${item.id}` === line.evidenceId);
    if (!snip) return false;
    const cited = line.source || line.text;
    return (audience === 'external' ? snip.text : snip.raw) === cited;
  });
}

function fileBody(doc) {
  return { filename: doc.filename, mime: doc.mime, base64: bytesToBase64(doc.bytes) };
}

export function deleteOwned(lib, user) {
  ensure(lib);
  const tenant = tenantOf(user);
  const n = lib.rows("SELECT COUNT(*) AS n FROM living_artifacts WHERE owner = ? AND lower(COALESCE(tenant, '')) = ?", user.email, tenant)[0].n;
  if (n) lib.sql.exec("DELETE FROM living_artifacts WHERE owner = ? AND lower(COALESCE(tenant, '')) = ?", user.email, tenant);
  return n;
}

export function ownedIds(lib, user) {
  try {
    return lib.rows("SELECT id, type, status FROM living_artifacts WHERE owner = ? AND lower(COALESCE(tenant, '')) = ?", user.email, tenantOf(user));
  } catch { return []; }
}

export async function routes(ctx, adapters = {}) {
  const { method, parts, user, lib } = ctx;
  if (parts[0] !== 'living') throw fail(404, 'Not found.');
  demand(user);
  ensure(lib);
  const smart = adapters.smart || new SmartNeedLinkAdapter();
  const paste = adapters.paste || new PastedJobDescriptionAdapter();
  if (method === 'GET' && parts.length === 1) return { body: profile(lib, user) };
  if (method === 'POST' && parts[1] === 'generate' && parts.length === 2) {
    const body = obj(ctx.body);
    const audience = body.audience === 'external' ? 'external' : 'internal';
    const parsed = resolveNeed(smart, paste, para(body.link, 500), para(body.text, 20000));
    if (parsed && parsed.ok === false) return { body: parsed };
    requireConsent(lib, user);
    const stories = publishedMine(lib, user);
    const lines = stories.flatMap(row => linesOf(lib, row, audience));
    const cv = composeCv({ consultant: consultantOf(stories), lines, need: parsed?.need || null, audience });
    cv.cf = toCompetencyFile(cv);
    const row = createArtifact(lib, user, 'cv', cv);
    await recordUsage(lib, user, { kind: 'usage', feature: 'living', outcome: 'generate', tokenStatus: 'missing' });
    return { body: { ok: true, artifact: viewOf(lib, user, row) } };
  }
  if (method === 'POST' && parts[1] === 'review' && parts.length === 2) {
    requireConsent(lib, user);
    const storyId = uuidish(obj(ctx.body).storyId);
    const story = publishedMine(lib, user).find(row => row.id === storyId);
    if (!story) throw fail(404, 'Reference not found.');
    const audience = obj(ctx.body).audience === 'external' ? 'external' : 'internal';
    const lines = linesOf(lib, story, audience);
    const fiche = buildFiche({ title: story.data?.title || '', storyId: story.id, lines });
    const row = createArtifact(lib, user, 'fiche', { lines, fiche, flags: [], gaps: [], audience, consultant: consultantOf([story]) });
    await recordUsage(lib, user, { kind: 'usage', feature: 'living', outcome: 'review', tokenStatus: 'missing' });
    return { body: { ok: true, artifact: viewOf(lib, user, row) } };
  }
  if (parts[1] === 'artifacts' && uuidish(parts[2])) {
    const row = readArtifact(lib, uuidish(parts[2]));
    if (!canSee(lib, user, row)) throw fail(404, 'Not found.');
    const action = parts[3];
    if (method === 'GET' && !action) return { body: viewOf(lib, user, row) };
    if (method === 'POST' && action === 'approve' && parts.length === 4) {
      if (!mayApprove(lib, user, row)) throw fail(403, 'You cannot approve your own CV.');
      commit(lib, user, row, 'approve');
      return { body: viewOf(lib, user, row) };
    }
    if (method === 'POST' && action === 'reject' && parts.length === 4) {
      if (!mayApprove(lib, user, row)) throw fail(403, 'You cannot approve your own CV.');
      commit(lib, user, row, 'reject');
      return { body: viewOf(lib, user, row) };
    }
    if (method === 'POST' && action === 'export' && parts.length === 4) {
      if (row.owner !== user.email && !mayApprove(lib, user, row)) throw fail(404, 'Not found.');
      const audience = row.payload.audience === 'external' ? 'external' : 'internal';
      const owner = { email: row.owner, role: 'user', tenant: user.tenant, tenantEnforced: user.tenantEnforced === true };
      if (!stillLive(lib, owner, audience, row.payload.lines || [])) throw fail(409, 'A cited line is no longer published.');
      if (row.status === 'approved') commit(lib, user, row, 'export');
      else if (row.status !== 'exported') throw fail(409, 'That action is not available.');
      const doc = row.type === 'fiche'
        ? atlasExport({ consultant: row.payload.consultant, lines: row.payload.lines, status: row.status }, 'docx')
        : new MiChatAdapter().exportDocument({ ...row.payload, status: row.status });
      await recordUsage(lib, user, { kind: 'export', feature: 'living', outcome: 'export', tokenStatus: 'missing' });
      return { body: { ...fileBody(doc), status: row.status } };
    }
  }
  throw fail(404, 'Not found.');
}
