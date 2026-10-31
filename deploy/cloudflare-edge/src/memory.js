// Private per-person memory with Hindsight (hindsight.vectorize.io). One bank per verified identity, derived on the
// server (never chosen by the browser). After an interview the project's state is retained as one document per
// project (upserted, so nothing piles up); before an interview the relevant memories are recalled for the talker.
// Memory is self-reported continuity, never evidence. Confidential client details are scrubbed before retention.
// API contract checked against @vectorize-io/hindsight-client 0.10.1: /v1/default/banks/{bank_id}/..., Bearer key.

// Hindsight Cloud (docs.hindsight.vectorize.io/api-integration). HINDSIGHT_URL overrides it for a self-hosted server.
export const HINDSIGHT_CLOUD = 'https://api.hindsight.vectorize.io';
export const RETAIN_MISSION = 'Extract durable facts about this consultant and their project work: their role and expertise, how they like interviews to be run, and for each project its context, their personal contribution, approach, outcomes, what evidence exists or is still missing, and open follow-up questions. Everything is self-reported and unverified: keep it labelled that way. Never extract client company names, people\'s names or confidential identifiers.';
export const REFLECT_MISSION = 'You help ATLAS, a project interviewer, continue conversations with one consultant: what was already covered, what is still open, and how they prefer to be interviewed. Never present memories as verified facts.';

const enc = new TextEncoder();
async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
// Bank id from the verified subject only. Derivation (unchanged, so no bank is ever orphaned): HMAC(HINDSIGHT_BANK_SECRET, 'hindsight-bank:' + sub).
// Memory is configured by HINDSIGHT_API_KEY, and then HINDSIGHT_BANK_SECRET is REQUIRED (fail closed): a bank id must not move when CSRF_SECRET
// is rotated during an incident. A deployment that already holds banks derived from CSRF_SECRET migrates without orphaning anything by setting
// HINDSIGHT_BANK_SECRET to the literal text 'atlas-hindsight:' + <the current CSRF_SECRET> (handoff/SECURITY_RUNBOOK.md); the bootstrap flag
// HINDSIGHT_ALLOW_DERIVED_BANK=1 keeps the old coupled derivation for a short, explicit transition only.
//   'unused'  memory is not configured; 'ok' the secret is set; 'derived' bootstrap flag on; 'missing' memory is refused until one is set.
export const bankSecretStatus = env => (!env?.HINDSIGHT_API_KEY ? 'unused' : env.HINDSIGHT_BANK_SECRET ? 'ok'
  : /^(1|true|on|yes)$/i.test(String(env.HINDSIGHT_ALLOW_DERIVED_BANK || '').trim()) ? 'derived' : 'missing');
export const BANK_SECRET_MESSAGE = 'Memory is switched off until the operator sets HINDSIGHT_BANK_SECRET (see handoff/SECURITY_RUNBOOK.md).';
export async function bankId(env, sub) {
  if (bankSecretStatus(env) === 'missing') throw Object.assign(new Error(BANK_SECRET_MESSAGE), { code: 'BANK_SECRET_REQUIRED' });
  const secret = env.HINDSIGHT_BANK_SECRET || ('atlas-hindsight:' + env.CSRF_SECRET);
  return 'atlas-' + (await hmacHex(secret, 'hindsight-bank:' + sub)).slice(0, 40);
}

const str = (v, n) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '';
const safeId = v => String(v || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);

// Replace every recorded client detail (name, location, contact) wherever it appears.
export function scrub(text, client = {}) {
  const names = [client.name, client.location, client.contact].map(x => String(x || '').trim()).filter(x => x.length >= 3);
  if (!names.length) return text;
  const re = new RegExp(names.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  return String(text).replace(re, 'the client');
}

// The project document retained after an interview: the consultant's words and ATLAS's report, labelled self-reported.
export function projectDocument(p) {
  const d = p.details || {}, r = p.report, labels = ['Context', 'Personal contribution', 'Approach', 'Outcome', 'Evidence', 'Relevance for other clients'];
  const lines = [`Project "${str(p.title, 140)}" (${str(p.stage, 40) || 'stage not stated'}${p.sector ? ', ' + str(p.sector, 80) : ''}). Self-reported by the consultant in ATLAS interviews; not verified.`];
  if (p.consultant?.role) lines.push('Consultant role: ' + str(p.consultant.role, 100) + '.');
  const facts = [d.projectId && 'project ID ' + d.projectId, d.country, d.start || d.end ? `${d.start || '?'} to ${d.end || 'ongoing'}` : d.duration, d.teamSize && `team of ${d.teamSize}`,
    (d.technologies || []).length && 'technologies: ' + d.technologies.join(', '), (d.deliverables || []).length && 'deliverables: ' + d.deliverables.join('; ')].filter(Boolean);
  if (facts.length) lines.push('Details: ' + facts.map(x => str(String(x), 300)).join('; ') + '.');
  (p.answers || []).forEach((a, i) => { if (a && a.trim()) lines.push(`${labels[i]}: ${str(a, 1500)}`); });
  if (r) {
    lines.push('ATLAS report headline: ' + str(r.headline, 160) + '. Summary: ' + str(r.summary, 900));
    if ((r.gaps || []).length) lines.push('Still missing or unverified: ' + r.gaps.map(g => str(g, 200)).join('; ') + '.');
    if ((r.follow_ups || []).length) lines.push('Open follow-up questions: ' + r.follow_ups.map(g => str(g, 200)).join('; ') + '.');
  }
  return scrub(lines.join('\n'), p.client).slice(0, 12000);
}

export function recallQuery(project) {
  return project?.id && project.id !== 'new'
    ? `Earlier conversations with this consultant about the project "${str(project.title, 140)}": what was already covered, open questions, evidence still missing, and how they like to be interviewed.`
    : 'This consultant\'s previous projects, what they already told ATLAS, and how they like to be interviewed.';
}

export function hindsight(env, fetcher = fetch) {
  const base = String(env.HINDSIGHT_URL || HINDSIGHT_CLOUD).replace(/\/+$/, ''), key = env.HINDSIGHT_API_KEY || '';
  if (!base || !key) return null;
  const call = async (method, path, body, timeoutMs = 8000) => {
    const r = await fetcher(base + path, { method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw Object.assign(new Error('Hindsight HTTP ' + r.status), { status: r.status });
    return r.status === 204 ? {} : r.json().catch(() => ({}));
  };
  const bank = b => '/v1/default/banks/' + encodeURIComponent(b);
  const ready = new Set();
  return {
    async ensureBank(b) {
      if (ready.has(b)) return;
      await call('PUT', bank(b), { retain_mission: RETAIN_MISSION, reflect_mission: REFLECT_MISSION, enable_observations: true });
      ready.add(b);
    },
    async retain(b, items) {
      await this.ensureBank(b);
      return call('POST', bank(b) + '/memories', { items, async: true }, 15000);
    },
    async recall(b, query, { tags, maxTokens = 700, timeoutMs = 3000 } = {}) {
      const res = await call('POST', bank(b) + '/memories/recall', { query, budget: 'low', max_tokens: maxTokens, ...(tags ? { tags, tags_match: 'any' } : {}) }, timeoutMs);
      return (Array.isArray(res.results) ? res.results : []).map(x => ({ text: str(x?.text, 400), tags: Array.isArray(x?.tags) ? x.tags : [], when: str(x?.mentioned_at || '', 40), documentId: str(x?.document_id || '', 80) })).filter(x => x.text);
    },
    documents: b => call('GET', bank(b) + '/documents'),
    forgetDocument: (b, id) => call('DELETE', bank(b) + '/documents/' + encodeURIComponent(id)),
    forgetAll: b => call('DELETE', bank(b)).finally(() => ready.delete(b)),
    stats: b => call('GET', bank(b) + '/stats'),
  };
}

// Items for one interview: the project document (upserted by id) plus a dated conversation note.
export function retainItems(payload, now = new Date().toISOString()) {
  const localId = safeId(payload.localId);
  if (!localId) throw Object.assign(new Error('A project id is required.'), { status: 400 });
  const tags = ['atlas', 'project:' + localId];
  const items = [{ content: projectDocument(payload), context: 'ATLAS project interview state (self-reported, not evidence)', document_id: 'project-' + localId, timestamp: now, tags, update_mode: 'replace' }];
  const said = str(payload.conversation, 6000);
  if (said) items.push({ content: scrub(said, payload.client), context: 'What the consultant said in an ATLAS interview on ' + now.slice(0, 10), document_id: 'conversation-' + localId + '-' + now.replace(/\D/g, '').slice(0, 14), timestamp: now, tags });
  return items;
}

// The talker's private-memory note (bounded; labelled continuity, not evidence).
export function memoryNote(memories) {
  if (!memories.length) return '';
  return 'PRIVATE MEMORY (what this consultant told you in earlier conversations; self-reported, not evidence):\n' + memories.slice(0, 8).map(m => '- ' + m.text).join('\n').slice(0, 1800);
}

// JEV check: keep other-project or general memories only when they help this interview (TypeSafe Noul; optional).
export async function jevRelevant(env, memories, project, fetcher = fetch) {
  const current = 'project:' + safeId(project?.id);
  const own = memories.filter(m => m.tags.includes(current)), other = memories.filter(m => !m.tags.includes(current));
  if (!env.TYPESAFE_API_KEY || !other.length) return { memories, checked: 0 };
  const questions = Object.fromEntries(other.map((m, i) => ['m' + i, { type: 'noul',
    instructions: `Would \`memories[${i}]\` help an interviewer talking with this consultant about the project in \`project\`, either as a preference about how they like to be interviewed or as information about this same project, rather than about a different project?` }]));
  const r = await fetcher('https://api.typesafe.ai/v1/systemone', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(2500),
    headers: { Authorization: 'Bearer ' + env.TYPESAFE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.JEV_MODEL || 'jev-latest', state: { project: { title: str(project?.title, 140), stage: str(project?.stage, 40), sector: str(project?.sector, 80) }, memories: other.map(m => m.text) }, questions }) });
  if (!r.ok) throw new Error('JEV HTTP ' + r.status);
  const a = (await r.json())?.answers || {};
  const keep = other.filter((_, i) => typeof a['m' + i]?.noul === 'number' && a['m' + i].noul >= 0.5);
  return { memories: [...own, ...keep], checked: other.length };
}
