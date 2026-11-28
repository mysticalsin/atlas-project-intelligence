// A consultant's added value is their own scope. The project impact is the whole project.
// Both hang off the shared project id. Attaching stores a new scope revision on that
// consultant's reference and does not rewrite the story body, its hash, or its revision.
// Private memory is refused. Nothing here approves, publishes, or ranks a person.
import { fail, obj, para } from './util.js';

const MEMORY = /memory|hindsight/i;

function memorySource(value) {
  return MEMORY.test(String(obj(value).source || ''));
}

function consented(value) {
  return obj(value).consent === true;
}

export function prepareProjectValue(body) {
  const incoming = obj(body);
  const scope = incoming.consultantAddedValue;
  const impact = incoming.projectImpact;
  if (scope == null && impact == null) return;
  if (memorySource(incoming) || memorySource(scope) || memorySource(impact)) {
    throw fail(400, 'Private memory is not evidence and cannot be attached as a project claim.');
  }
  if (scope != null && !consented(scope)) throw fail(400, 'Attaching a consultant added value needs consent.');
  if (impact != null && !consented(impact)) throw fail(400, 'Recording the project impact needs consent.');
  const scopeText = scope == null ? '' : para(obj(scope).scope, 6000);
  const impactText = impact == null ? '' : para(obj(impact).text, 6000);
  if (scope != null && !scopeText) throw fail(400, 'The consultant added value needs their scope.');
  if (impact != null && !impactText) throw fail(400, 'The project impact needs the effect of the whole project.');
  if (scopeText && impactText && scopeText === impactText) {
    throw fail(400, 'Project impact is the whole project. The consultant added value is their own scope.');
  }
}

function assertOwnScope(lib, user, body) {
  if (body?.consultantAddedValue == null || !body.id) return;
  const row = lib.row(body.id);
  if (!row) return;
  if (!lib.access(row, user)) throw fail(404, 'Reference not found.');
  if (row.owner !== user.email) throw fail(403, 'A consultant attaches their own added value.');
}

function revisionsOf(share, key) {
  const list = share && Array.isArray(share[key]) ? share[key] : [];
  return list.map(item => ({ ...item }));
}

function peers(lib, user, projectId) {
  const key = projectId.toLowerCase();
  return lib.visibleRows(user).map(([row]) => row).filter(row => String(row.data?.details?.projectId || '').trim().toLowerCase() === key);
}

export function attachProjectValue(lib, user, id, body) {
  prepareProjectValue(body);
  const row = lib.row(id);
  if (!row || !lib.access(row, user)) throw fail(404, 'Reference not found.');
  if (!lib.canEdit(row, user)) throw fail(403, 'You cannot edit this reference.');
  const projectId = String(row.data?.details?.projectId || '').trim();
  if (!projectId) throw fail(400, 'A project id is required before a consultant value can be attached.');
  const share = obj(row.state?.projectShare);
  const next = { scopeRevisions: revisionsOf(share, 'scopeRevisions'), impactRevisions: revisionsOf(share, 'impactRevisions') };
  if (body.consultantAddedValue != null) {
    if (row.owner !== user.email) throw fail(403, 'A consultant attaches their own added value.');
    const added = obj(body.consultantAddedValue);
    const scope = para(added.scope, 6000);
    if (next.scopeRevisions.length >= 30) throw fail(400, 'This consultant already has the maximum number of scope revisions.');
    const storyHash = String(row.content_hash || '');
    if (added.storyHash != null && added.storyHash !== '' && added.storyHash !== storyHash) {
      throw fail(409, 'The story revision does not match. Reload it before attaching.');
    }
    next.scopeRevisions.push({
      revision: next.scopeRevisions.length + 1,
      text: scope,
      at: lib.now(),
      storyRevision: row.revision,
      storyHash,
    });
  }
  if (body.projectImpact != null) {
    const text = para(obj(body.projectImpact).text, 6000);
    let max = 0;
    for (const peer of peers(lib, user, projectId)) {
      for (const item of peer.state?.projectShare?.impactRevisions || []) if (item.revision > max) max = item.revision;
    }
    if (next.impactRevisions.length >= 30) throw fail(400, 'This project impact already has the maximum number of revisions.');
    next.impactRevisions.push({ revision: max + 1, text, at: lib.now() });
  }
  lib.setState(row, { ...row.state, projectShare: next }, user.email, 'project value', body.consultantAddedValue != null && body.projectImpact != null ? 'scope and impact' : body.consultantAddedValue != null ? 'scope' : 'impact');
}

export function projectViewFor(lib, user, row) {
  const projectId = String(row?.data?.details?.projectId || '').trim();
  if (!projectId) return null;
  let best = null;
  const added = [];
  for (const peer of peers(lib, user, projectId)) {
    if (peer.state?.withdrawn) continue;
    const share = peer.state?.projectShare;
    if (!share) continue;
    for (const item of share.impactRevisions || []) {
      if (!item?.text) continue;
      if (!best || item.revision > best.revision || (item.revision === best.revision && String(item.at) > String(best.at))) {
        best = { text: item.text, revision: item.revision };
      }
    }
    const scopes = Array.isArray(share.scopeRevisions) ? share.scopeRevisions : [];
    const latest = scopes[scopes.length - 1];
    if (!latest?.text) continue;
    const name = para(peer.data?.consultant?.name, 100);
    added.push({ consultant: name || 'Consultant', scope: latest.text, revision: latest.revision, customerClaim: false });
  }
  if (!best && !added.length) return null;
  added.sort((a, b) => a.consultant.localeCompare(b.consultant) || a.revision - b.revision);
  return { projectId, projectImpact: best, addedValues: added };
}

export function withProjectValue(lib) {
  const read = lib.get.bind(lib);
  const save = lib.upsert.bind(lib);
  lib.get = (user, id) => {
    const body = read(user, id);
    const row = lib.row(id);
    const projectView = row ? projectViewFor(lib, user, row) : null;
    return projectView ? { ...body, projectView } : body;
  };
  lib.upsert = async (user, body) => {
    const extra = body && (body.consultantAddedValue != null || body.projectImpact != null);
    if (extra) {
      prepareProjectValue(body);
      assertOwnScope(lib, user, body);
    }
    const saved = await save(user, body);
    if (!extra) return saved;
    attachProjectValue(lib, user, saved.id, body);
    const projectView = projectViewFor(lib, user, lib.row(saved.id));
    return projectView ? { ...saved, projectView } : saved;
  };
  return lib;
}
