// Legacy rows are main's rows: the status column and the fields are real, and state.version was never stored.
// An unknown version keeps its fields. Its decoded status fails safe, and CAS still matches the stored column.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PUBLICATION_EVENTS, PUBLICATION_PHASES, publicationPairs, publicationStatus, publicationTransition } from '../src/publication.js';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const OWNER = { email: 'ada@example.test', role: 'user' };
const OTHER = { email: 'kim@example.test', role: 'user' };
const ADMIN = { email: 'admin@example.test', role: 'admin' };
const REVIEWER = { email: 'rev@example.test', role: 'reviewer' };
const N1 = { email: 'sam@example.test', role: 'user' };
const PRE = { email: 'pre@example.test', role: 'presales' };
const SYS = { email: 'directory', role: 'system' };

// Withdrawing what is already withdrawn is not a second withdrawal.
// Reinstating is only from withdrawn. A lane decision or an admin publish does not apply to a withdrawn row.
// reviewed stays legal there: a rating that is already in flight still settles, and withdrawn still wins the status.
const ILLEGAL = new Set([
  'withdrawn:withdrawn',
  'withdrawn:decided',
  'withdrawn:admin_published',
  ...PUBLICATION_PHASES.filter(phase => phase !== 'withdrawn').map(phase => phase + ':reinstated'),
]);

function library() {
  let t = 0;
  return new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 8, 27, 0, 0, t++)).toISOString() });
}

const publishedFields = () => ({
  withdrawn: false,
  test: false,
  quality: { status: 'ready', score: 90 },
  validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved', by: '', at: '', note: '', managerStaffIgnored: false },
});

function plant(l, id, phase) {
  const raw = JSON.parse(l.rows('SELECT state FROM refs WHERE id = ?', id)[0].state);
  delete raw.version;
  const status = phase === 'published' ? 'published' : phase === 'withdrawn' ? 'withdrawn' : 'in_review';
  const fields = phase === 'in_review'
    ? { withdrawn: false, test: false, quality: null, validation: { status: 'pending', managerDecision: 'pending', presalesDecision: 'pending', by: '', at: '', note: '', managerStaffIgnored: false } }
    : { ...publishedFields(), withdrawn: phase === 'withdrawn' };
  const state = { ...raw, ...fields };
  const json = JSON.stringify(state);
  assert.equal(Object.hasOwn(JSON.parse(json), 'version'), false);
  l.sql.exec('UPDATE refs SET state = ?, status = ? WHERE id = ?', json, status, id);
  return json;
}

async function story(l, localId) {
  return l.upsert(OWNER, { localId, reference: { title: localId } });
}

test('version-less rows keep their status and a future version is the safe in-review state', async () => {
  const l = library();
  const saved = await story(l, 'live');
  const json = plant(l, saved.id, 'published');
  const read = l.row(saved.id);
  assert.equal(read.status, 'published');
  assert.equal(read.state.validation.managerDecision, 'approved');
  assert.equal(read.state.withdrawn, false);
  assert.equal(l.list(OTHER).total, 1);
  assert.equal(l.list(OTHER).items[0].status, 'published');
  const raw = l.rows('SELECT state, status FROM refs WHERE id = ?', saved.id)[0];
  assert.equal(raw.state, json);
  assert.equal(raw.status, 'published');

  const hidden = await story(l, 'hidden');
  plant(l, hidden.id, 'withdrawn');
  assert.equal(l.row(hidden.id).status, 'withdrawn');
  assert.equal(l.row(hidden.id).state.withdrawn, true);
  assert.equal(l.list(OTHER).total, 1);
});

test('every publication event can be written on a legacy row, except the illegal pairs', async () => {
  const writes = ['revised', 'reviewed', 'decided', 'admin_published', 'withdrawn', 'reinstated', 'merged'];
  for (const phase of ['published', 'withdrawn', 'in_review']) {
    for (const event of writes) {
      const l = library();
      const saved = await story(l, phase + '-' + event);
      plant(l, saved.id, phase);
      const key = phase + ':' + event;
      if (ILLEGAL.has(key)) {
        await assert.rejects(apply(l, saved.id, event), e => e.status === 409 && !/changed/.test(e.message), key);
        assert.equal(l.rows('SELECT status FROM refs WHERE id = ?', saved.id)[0].status, phase === 'in_review' ? 'in_review' : phase);
        continue;
      }
      await apply(l, saved.id, event);
      const column = l.rows('SELECT status, state FROM refs WHERE id = ?', saved.id)[0];
      assert.equal(column.status, publicationStatus(JSON.parse(column.state)), key);
    }
  }
});

async function apply(l, id, event) {
  if (event === 'revised') {
    const data = l.row(id).data;
    data.title += ' revised';
    return l.upsert(OWNER, { id, reference: data });
  }
  if (event === 'reviewed') {
    const row = l.row(id);
    const stored = l.storeRating(row, Number(row.state.ratingGen) || 0, { status: 'ready', score: 90 }, OWNER.email);
    if (!stored) throw Object.assign(new Error('That publication change is not allowed.'), { status: 409 });
    return l.row(id);
  }
  if (event === 'decided') {
    l.bindTrust(SYS, { owner: OWNER.email, email: N1.email, source: 'directory', sandbox: true });
    return l.validate(N1, id, { decision: 'request_changes', lane: 'manager', note: 'Name the source.' });
  }
  if (event === 'admin_published') return l.adminPublish(ADMIN, id, { test: false });
  if (event === 'withdrawn') return l.withdraw(OWNER, id, { note: 'pause' });
  if (event === 'reinstated') return l.reinstate(REVIEWER, id);
  const keep = await l.upsert(OWNER, { localId: 'keep-' + id, reference: { title: 'Keep ' + id } });
  return l.merge(REVIEWER, { keep: keep.id, merge: id });
}

test('a merge with a legacy keeper completes or rolls back, and a conflict does not leave it half done', async () => {
  const l = library();
  const keep = await story(l, 'keeper');
  const gone = await story(l, 'folded');
  const contributed = l.row(gone.id).data;
  contributed.answers[1] = 'I built the routing model.';
  l.sql.exec('UPDATE refs SET data = ? WHERE id = ?', JSON.stringify(contributed), gone.id);
  plant(l, keep.id, 'published');
  assert.equal(l.rows('SELECT merged_into FROM refs WHERE id = ?', gone.id)[0].merged_into, null);
  await l.merge(REVIEWER, { keep: keep.id, merge: gone.id });
  const source = l.rows('SELECT merged_into, status FROM refs WHERE id = ?', gone.id)[0];
  assert.equal(source.merged_into, keep.id);
  assert.equal(source.status, 'withdrawn');
  assert.match(l.row(keep.id).data.answers[1], /another consultant/);

  const conflicted = library();
  const keeper = await story(conflicted, 'keeper');
  const other = await story(conflicted, 'other');
  const exec = conflicted.sql.exec.bind(conflicted.sql);
  conflicted.sql.exec = (q, ...p) => {
    const text = String(q);
    if (text.includes('UPDATE refs SET title=?')) exec('UPDATE refs SET revision = revision + 1 WHERE id = ?', keeper.id);
    return exec(q, ...p);
  };
  await assert.rejects(conflicted.merge(REVIEWER, { keep: keeper.id, merge: other.id }), e => e.status === 409);
  assert.equal(conflicted.rows('SELECT merged_into FROM refs WHERE id = ?', other.id)[0].merged_into, null);
});

test('upsert conflicts on the stored revision and does not write the new revision', async () => {
  const l = library();
  const saved = await story(l, 'one');
  const exec = l.sql.exec.bind(l.sql);
  l.sql.exec = (q, ...p) => {
    const text = String(q);
    if (text.includes('UPDATE refs SET title=?')) exec('UPDATE refs SET revision = revision + 1 WHERE id = ?', saved.id);
    return exec(q, ...p);
  };
  const data = l.row(saved.id).data;
  data.title += ' edited';
  await assert.rejects(l.upsert(OWNER, { id: saved.id, reference: data }), e => e.status === 409 && /changed/.test(e.message));
  const raw = l.rows('SELECT revision, title FROM refs WHERE id = ?', saved.id)[0];
  assert.equal(raw.revision, 2);
  assert.equal(raw.title, 'one');
});

const PHASE = {
  in_review: { quality: null, validation: { status: 'pending' } },
  needs_work: { quality: { status: 'needs_work' }, validation: { status: 'pending' } },
  changes_requested: { quality: { status: 'ready' }, validation: { status: 'changes_requested', managerDecision: 'pending', presalesDecision: 'pending' } },
  awaiting_validation: { quality: { status: 'ready' }, validation: { status: 'pending', managerDecision: 'approved', presalesDecision: 'pending' } },
  published: { quality: { status: 'ready' }, validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved' } },
  admin_test: { test: true, validation: { status: 'admin_bypass' } },
  withdrawn: { withdrawn: true, quality: { status: 'ready' }, validation: { status: 'validated', managerDecision: 'approved', presalesDecision: 'approved' } },
};

test('illegal publication pairs are exactly the pairs the table leaves out', () => {
  const legal = publicationPairs();
  const product = [];
  for (const phase of PUBLICATION_PHASES) {
    assert.equal(publicationStatus(PHASE[phase]), phase);
    for (const type of PUBLICATION_EVENTS) {
      const key = phase + ':' + type;
      product.push(key);
      const event = { type, id: 'story-1', tenant: 'tenant-1', lane: 'manager', decision: 'approved', by: 'sam@example.test', at: '2026-11-12T00:00:00.000Z', note: '', mergedInto: '', quality: { status: 'ready', score: 90 }, test: false };
      const result = publicationTransition(PHASE[phase], event);
      if (ILLEGAL.has(key)) {
        assert.equal(result.illegal, true, key);
        assert.equal(result.ok, false, key);
      } else {
        assert.equal(result.ok, true, key);
        assert.equal(legal.has(key), true, key);
      }
    }
  }
  const missing = product.filter(key => !legal.has(key));
  assert.deepEqual(missing.sort(), [...ILLEGAL].sort());
  assert.equal(missing.length, ILLEGAL.size);
  assert.ok(missing.length > 0);
});

// Column published, story validated with no lane decision: the read decodes awaiting_validation.
// CAS has to use the column. A test whose decoded status equals the column stays green if that is reverted.
function mismatch(l, id) {
  const raw = JSON.parse(l.rows('SELECT state FROM refs WHERE id = ?', id)[0].state);
  delete raw.version;
  const state = { ...raw, withdrawn: false, test: false, quality: { status: 'ready', score: 90 }, validation: { status: 'validated' } };
  delete state.validation.managerDecision;
  delete state.validation.presalesDecision;
  l.sql.exec('UPDATE refs SET state = ?, status = ? WHERE id = ?', JSON.stringify(state), 'published', id);
  const row = l.row(id);
  assert.equal(row.storedStatus, 'published');
  assert.equal(row.status, 'awaiting_validation');
  assert.equal(l.rows('SELECT status FROM refs WHERE id = ?', id)[0].status, 'published');
  return row;
}

test('a legacy published column that decodes to awaiting_validation can withdraw, validate, upsert and merge', async () => {
  const withdrawn = library();
  const paused = await story(withdrawn, 'pause');
  mismatch(withdrawn, paused.id);
  assert.equal(withdrawn.withdraw(OWNER, paused.id, { note: 'pause' }).status, 'withdrawn');
  assert.equal(withdrawn.rows('SELECT status FROM refs WHERE id = ?', paused.id)[0].status, 'withdrawn');

  const checked = library();
  const lane = await story(checked, 'lane');
  mismatch(checked, lane.id);
  checked.bindTrust(SYS, { owner: OWNER.email, email: N1.email, source: 'directory', sandbox: true });
  const validated = checked.validate(N1, lane.id, { decision: 'validate', lane: 'manager' });
  assert.equal(validated.status, 'awaiting_validation');
  assert.equal(checked.rows('SELECT status FROM refs WHERE id = ?', lane.id)[0].status, 'awaiting_validation');
  assert.equal(checked.row(lane.id).state.validation.managerDecision, 'approved');

  const edited = library();
  const draft = await story(edited, 'draft');
  mismatch(edited, draft.id);
  const data = edited.row(draft.id).data;
  data.title += ' revised';
  const saved = await edited.upsert(OWNER, { id: draft.id, reference: data });
  assert.equal(saved.title, 'draft revised');
  assert.equal(edited.rows('SELECT status FROM refs WHERE id = ?', draft.id)[0].status, 'in_review');

  const retired = library();
  const keep = await story(retired, 'keep');
  const gone = await story(retired, 'gone');
  mismatch(retired, gone.id);
  await retired.merge(REVIEWER, { keep: keep.id, merge: gone.id });
  assert.equal(retired.rows('SELECT merged_into, status FROM refs WHERE id = ?', gone.id)[0].merged_into, keep.id);
  assert.equal(retired.rows('SELECT status FROM refs WHERE id = ?', gone.id)[0].status, 'withdrawn');

  const keeper = library();
  const held = await story(keeper, 'held');
  const other = await story(keeper, 'other');
  mismatch(keeper, held.id);
  await keeper.merge(REVIEWER, { keep: held.id, merge: other.id });
  assert.equal(keeper.rows('SELECT merged_into FROM refs WHERE id = ?', other.id)[0].merged_into, held.id);
  assert.ok(keeper.row(held.id).revision > 1);

  const bumped = library();
  const stale = await story(bumped, 'stale');
  mismatch(bumped, stale.id);
  const exec = bumped.sql.exec.bind(bumped.sql);
  bumped.sql.exec = (q, ...p) => {
    if (String(q).includes('UPDATE refs SET state = ?')) exec('UPDATE refs SET revision = revision + 1 WHERE id = ?', stale.id);
    return exec(q, ...p);
  };
  assert.throws(() => bumped.withdraw(OWNER, stale.id, { note: 'pause' }), e => e.status === 409 && /changed/.test(e.message));
  assert.equal(bumped.rows('SELECT status FROM refs WHERE id = ?', stale.id)[0].status, 'published');
});

test('merge without a transaction is refused and does not retire the story', async () => {
  const l = library();
  const keep = await story(l, 'keep');
  const gone = await story(l, 'gone');
  l.transactionSync = null;
  await assert.rejects(l.merge(REVIEWER, { keep: keep.id, merge: gone.id }), e => e.status === 503 && e.message === 'Atomic reference changes need storage.transactionSync.');
  assert.equal(l.rows('SELECT merged_into FROM refs WHERE id = ?', gone.id)[0].merged_into, null);
});

test('index parses every other row before writing, so one bad row is not a partial update', async () => {
  const l = library();
  const a = await l.upsert(OWNER, { localId: 'a', reference: { title: 'A', details: { projectId: 'PRJ-SAME' } } });
  const b = await l.upsert(OWNER, { localId: 'b', reference: { title: 'B', details: { projectId: 'PRJ-SAME' } } });
  const c = await l.upsert(OWNER, { localId: 'c', reference: { title: 'C', details: { projectId: 'PRJ-SAME' } } });
  const broken = '{';
  l.sql.exec('UPDATE refs SET state = ? WHERE id = ?', broken, c.id);
  await l.index(a.id);
  const bState = JSON.parse(l.rows('SELECT state FROM refs WHERE id = ?', b.id)[0].state);
  const aState = JSON.parse(l.rows('SELECT state FROM refs WHERE id = ?', a.id)[0].state);
  assert.ok((bState.duplicates || []).some(d => d.id === a.id));
  assert.ok((aState.duplicates || []).some(d => d.id === b.id));
  assert.equal((aState.duplicates || []).some(d => d.id === c.id), false);
  assert.equal(l.rows('SELECT state FROM refs WHERE id = ?', c.id)[0].state, broken);
});

test('scanStale uses the stored status: a legacy published row is invited and a legacy withdrawn row is not', async () => {
  const l = library();
  const live = await story(l, 'due');
  const hidden = await story(l, 'gone');
  plant(l, live.id, 'published');
  plant(l, hidden.id, 'withdrawn');
  l.sql.exec('UPDATE refs SET next_review = ?', '2000-01-01T00:00:00.000Z');
  assert.equal(l.scanStale(), 1);
  assert.equal(l.scanStale(), 1);
});

test('a malformed story is skipped by the batch readers and the tenant still lists the good row', async () => {
  const l = library();
  const good = await story(l, 'good');
  const bad = await story(l, 'bad');
  l.sql.exec('UPDATE refs SET state = ? WHERE id = ?', '{', bad.id);
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => warns.push(args);
  try {
    assert.equal(l.list(OWNER).total, 1);
    assert.equal(l.list(OWNER).items[0].id, good.id);
    assert.equal(l.exportAll(ADMIN).references.length, 1);
    l.sql.exec('UPDATE refs SET next_review = ?', '2000-01-01T00:00:00.000Z');
    assert.equal(l.scanStale(), 1);
  } finally {
    console.warn = original;
  }
  assert.ok(warns.some(args => String(args[0]).includes(bad.id)));
  assert.ok(warns.every(args => !String(args[0]).includes('good')));
});
