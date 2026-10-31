// G2: granular consent with receipts. Audit gap closed: Art 7 (one bundled tick, no receipt, no text version or hash, revoking deleted the entry), Art 25 (memory on by default).
// The start message carries separate purposes; the server records each CHANGE as an append-only receipt (subject, purpose, granted/withdrawn, notice version, SHA-256 of the exact
// wording, time, channel); the session checks the specific purposes (checkpoint only with the checkpoint choice, memory only with the memory choice).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Library } from '../src/library.js';
import * as privacy from '../src/privacy.js';
import { PRIVACY } from '../src/policy.generated.js';
import { memorySql } from './sqlite.js';
import test, { afterEach } from 'node:test';
import { rig, opened, startMsg, FakeStorage, PROJECT, settle, until, cleanup } from './reconnect-harness.js';
import { Session } from '../src/session.js';
import * as profile from '../src/profile.js';

afterEach(cleanup);
const SUBJ = 'ab'.repeat(16);
const lib = () => { let t = 0; return new Library(memorySql(), { now: () => new Date(Date.UTC(2026, 9, 31, 9, 0, t++)).toISOString() }); };
const sha = s => createHash('sha256').update(s).digest('hex');

test('G2 consent object: separate purposes, validated keys; a bare true is the old tick and means transcription only', () => {
  assert.deepEqual(privacy.parseConsent(true, { capture: true }), { purposes: { transcription: true, draft: true, checkpoint: false, memory: false, notice: false }, legacy: true });
  assert.equal(privacy.parseConsent(true, { capture: false, required: false }).purposes.draft, false, 'the draft follows the old capture flag');
  const full = privacy.parseConsent({ transcription: true, draft: true, checkpoint: true, memory: false, notice: true, version: privacy.NOTICE_VERSION });
  assert.deepEqual(full.purposes, { transcription: true, draft: true, checkpoint: true, memory: false, notice: true }); assert.equal(full.legacy, false);
  assert.equal(privacy.parseConsent({ transcription: true, draft: true }).purposes.memory, false, 'a missing purpose is not granted');
  for (const bad of [{ transcription: true, draft: true, marketing: true }, { transcription: 'yes', draft: true }, { transcription: true, draft: true, version: 'old' }, [], null, false, 'true', 1])
    assert.throws(() => privacy.parseConsent(bad, { capture: true }), undefined, JSON.stringify(bad));
  // a voice interview needs transcription AND the draft; a typed one needs only the draft (nothing is transcribed)
  assert.throws(() => privacy.parseConsent({ draft: true }), /Transcription consent is required/); assert.throws(() => privacy.parseConsent({ transcription: true }), /Transcription consent is required/);
  assert.deepEqual(privacy.parseConsent({ draft: true }, { mode: 'text' }).purposes.transcription, false);
  assert.deepEqual(privacy.parseConsent({ transcription: true, draft: true }, { mode: 'text' }).purposes.transcription, false, 'typing: nothing is transcribed, whatever the box said');
  assert.throws(() => privacy.parseConsent({ transcription: true }, { mode: 'text' }), /Transcription consent is required/);
});

test('G2 the wording: one required toggle, the rest optional, memory OFF, the text hash is the SHA-256 of the exact wording shown (text mode has its own)', () => {
  const v = privacy.bootstrapView();
  assert.equal(v.version, privacy.NOTICE_VERSION); assert.equal(v.noticeUrl, '/privacy');
  assert.deepEqual(Object.entries(v.toggles).filter(([, t]) => t.required).map(([k]) => k), ['capture']);
  assert.match(v.toggles.capture.text, /private draft/); assert.match(v.toggles.capture.text, /Submit for review/); assert.match(v.toggles.checkpoint.text, /24 hours/); assert.match(v.toggles.memory.text, /Nothing I keep private/);
  assert.match(v.special, /health, religion, politics, trade-union membership, sexual orientation or ethnic origin/);
  assert.equal(privacy.textHash('draft'), sha(PRIVACY.toggles.capture.text)); assert.equal(privacy.textHash('draft', 'text'), sha(PRIVACY.toggles.capture.text_mode_text));
  assert.notEqual(privacy.textHash('draft'), privacy.textHash('draft', 'text')); assert.equal(privacy.textHash('transcription'), privacy.textHash('draft'), 'one toggle, one wording');
  assert.equal(privacy.textHash('memory', 'text'), sha(PRIVACY.toggles.memory.text), 'only the capture toggle has a typed variant');
  assert.doesNotMatch(JSON.stringify(v), /compliant/i);
});

test('G2 receipts: appended on change only, withdrawal is recorded and deletes nothing, an UPDATE is refused (append-only), the state is the latest row', () => {
  const l = lib(), r1 = privacy.recordReceipts(l, SUBJ, [{ purpose: 'transcription', granted: true }, { purpose: 'draft', granted: true }, { purpose: 'checkpoint', granted: true }, { purpose: 'memory', granted: false }, { purpose: 'notice', granted: false }], { channel: 'consent-dialog' });
  assert.deepEqual(r1.recorded.map(x => x.purpose), ['transcription', 'draft', 'checkpoint'], 'a purpose never granted and not granted now leaves no row');
  const rows = privacy.receiptsOf(l, SUBJ);
  assert.deepEqual(rows.map(r => [r.purpose, r.granted, r.channel, r.noticeVersion]), [['transcription', true, 'consent-dialog', privacy.NOTICE_VERSION], ['draft', true, 'consent-dialog', privacy.NOTICE_VERSION], ['checkpoint', true, 'consent-dialog', privacy.NOTICE_VERSION]]);
  assert.equal(rows[2].textSha256, sha(PRIVACY.toggles.checkpoint.text)); assert.match(rows[0].at, /^2026-10-31T09:00:/);
  // the same choices again: nothing new
  assert.equal(privacy.recordReceipts(l, SUBJ, [{ purpose: 'checkpoint', granted: true }, { purpose: 'draft', granted: true }]).recorded.length, 0);
  // withdrawal: a new row, the grant stays
  const w = privacy.recordReceipts(l, SUBJ, [{ purpose: 'checkpoint', granted: false }], { channel: 'profile' });
  assert.equal(w.recorded[0].granted, false); assert.equal(privacy.receiptsOf(l, SUBJ).filter(r => r.purpose === 'checkpoint').map(r => r.granted).join(), 'true,false', 'granted, then withdrawn: both are kept');
  assert.equal(privacy.stateFromReceipts(l, SUBJ).checkpoint.granted, false); assert.equal(privacy.stateFromReceipts(l, SUBJ).checkpoint.channel, 'profile');
  // a new grant after a withdrawal is a new row again
  privacy.recordReceipts(l, SUBJ, [{ purpose: 'checkpoint', granted: true }]); assert.equal(privacy.receiptsOf(l, SUBJ).filter(r => r.purpose === 'checkpoint').length, 3);
  assert.throws(() => l.sql.exec("UPDATE consent_receipts SET granted = 1 WHERE purpose = 'checkpoint'"), /append-only/);
  assert.throws(() => privacy.recordReceipts(l, 'not a subject', [{ purpose: 'memory', granted: true }]), /subject key/);
  assert.equal(privacy.recordReceipts(l, SUBJ, [{ purpose: 'marketing', granted: true }, { purpose: 'memory', granted: 'yes' }]).recorded.length, 0, 'unknown purposes and non-booleans are ignored');
  // another person's receipts are theirs
  assert.deepEqual(privacy.receiptsOf(l, 'cd'.repeat(16)), []);
});

test('G2 receipts: a typed interview is receipted with the typed wording; the profile consents (spoken Ask, JEV rating) append receipts too and survive the profile being deleted', async () => {
  const l = lib();
  privacy.recordReceipts(l, SUBJ, [{ purpose: 'draft', granted: true, mode: 'text' }], { channel: 'consent-dialog' });
  assert.equal(privacy.receiptsOf(l, SUBJ)[0].textSha256, sha(PRIVACY.toggles.capture.text_mode_text));
  const call = (path, body) => profile.routes({ method: 'POST', parts: path.split('/'), user: { email: 'alex@mantu.com', mail: 'alex@mantu.com', role: 'user', subj: SUBJ, idp: {} }, lib: l, body, env: {} });
  await call('profile/consent', { kind: 'jevRating', version: 1, granted: true }); await call('profile/consent', { kind: 'spokenAsk', version: 1, granted: true }); await call('profile/consent', { kind: 'jevRating', version: 1, granted: false });
  assert.deepEqual(privacy.receiptsOf(l, SUBJ).filter(r => r.purpose.includes('_')).map(r => [r.purpose, r.granted, r.channel]), [['jev_rating', true, 'profile'], ['spoken_ask', true, 'profile'], ['jev_rating', false, 'profile']]);
  await call('profile/delete', {});
  assert.equal(privacy.receiptsOf(l, SUBJ).length, 4, 'deleting the profile does not delete the receipts: they are the record that a choice was made');
});

test('G2 session gating: the saved-interview choice is what makes an interview resumable; the legacy tick keeps nothing', async () => {
  const off = rig(); await opened(off, { consent: true });
  assert.ok(!off.events.find(e => e.type === 'ready').resumable, 'a bare true: no checkpoint');
  await settle(60); assert.deepEqual(off.storage.keys(), [], 'nothing is written to the person\'s storage'); await off.s.end(false);
  const no = rig(); await opened(no, { consent: { transcription: true, draft: true, checkpoint: false } });
  assert.ok(!no.events.find(e => e.type === 'ready').resumable); assert.equal(no.s.checkpointable(), false);
  const yes = rig(); await opened(yes, { consent: { transcription: true, draft: true, checkpoint: true } });
  assert.equal(yes.events.find(e => e.type === 'ready').resumable, true); assert.equal(yes.s.checkpointable(), true);
  // a resume with the choice off is refused with the same message as any other refusal
  const refused = rig({ storage: yes.storage }); await refused.s.onText(startMsg({ consent: { transcription: true, draft: true, checkpoint: false }, resume: yes.s.sessionId }));
  await settle(30); assert.equal(refused.events.find(e => e.type === 'error')?.code, 'resume-unavailable');
});

test('G2 session gating: private memory is recalled only when the memory choice is on', async () => {
  const run = async consent => { let asked = 0; const h = rig({ session: { memory: async () => { asked++; return 'PRIVATE MEMORY: x'; } } }); await h.s.onText(startMsg({ consent })); await settle(60); await h.s.end(false); return asked; };
  assert.equal(await run(true), 0, 'the old tick: no recall'); assert.equal(await run({ transcription: true, draft: true, memory: false }), 0); assert.equal(await run({ transcription: true, draft: true, memory: true }), 1);
});

test('G2 session start: every change is receipted BEFORE anything is kept (the hook gets the purposes); a hook that fails starts nothing; a bad consent object is refused', async () => {
  const seen = []; const h = rig({ session: { consentHook: async x => { seen.push(x); } } });
  await h.s.onText(startMsg({ consent: { transcription: true, draft: true, checkpoint: true, memory: true, notice: true } })); await until(() => h.events.some(e => e.type === 'ready'));
  assert.deepEqual(seen[0].purposes, { transcription: true, draft: true, checkpoint: true, memory: true, notice: true }); assert.equal(seen[0].mode, 'voice'); assert.equal(seen[0].legacy, false); assert.equal(seen[0].resume, false);
  await h.s.end(false);
  const bad = rig({ session: { consentHook: async () => { throw new Error('library down'); } } }); await bad.s.onText(startMsg({ consent: { transcription: true, draft: true, checkpoint: true } }));
  const err = bad.events.find(e => e.type === 'error'); assert.equal(err.code, 'consent-failed'); assert.match(err.message, /nothing was started/); assert.ok(!bad.events.some(e => e.type === 'ready'), 'no interview'); await settle(30); assert.deepEqual(bad.storage.keys(), []);
  for (const consent of [{ transcription: true, draft: true, marketing: true }, { transcription: 1, draft: true }, { draft: true }, 'yes', false, { transcription: true, draft: true, version: 'stale' }]) {
    const x = rig({ session: { captureRequired: true } }); await x.s.onText(startMsg({ consent })); assert.ok(x.events.find(e => e.type === 'error'), JSON.stringify(consent)); assert.ok(!x.events.some(e => e.type === 'ready'));
  }
  const typed = rig({ session: { consentHook: async x => { seen.push(x); } } }); await typed.s.onText(startMsg({ consent: { draft: true }, mode: 'text' })); await until(() => typed.events.some(e => e.type === 'ready'));
  assert.equal(seen.at(-1).mode, 'text'); assert.equal(seen.at(-1).purposes.transcription, false); await typed.s.end(false);
});

test('G2 state in the person\'s object: applyState returns only changes, nothing is committed when the receipt fails, memory needs the grant and no block', async () => {
  const st = new FakeStorage();
  let r = await privacy.applyState(st, { checkpoint: true, memory: false, notice: true }, { channel: 'consent-dialog' });
  assert.deepEqual(r.changes.map(c => [c.purpose, c.granted]), [['checkpoint', true], ['notice', true]]);
  assert.equal((await privacy.applyState(st, { checkpoint: true })).changes.length, 0);
  await assert.rejects(privacy.applyState(st, { memory: true }, { beforeCommit: async () => { throw new Error('no receipt'); } }));
  assert.equal(privacy.grantedIn(await privacy.loadState(st), 'memory'), false, 'a choice is never in force without its receipt');
  await privacy.applyState(st, { memory: true }); assert.equal(privacy.memoryAllowed(await privacy.loadState(st)), true);
  await privacy.setBlocked(st, { memory: true }); assert.equal(privacy.memoryAllowed(await privacy.loadState(st)), false, 'a restriction or objection blocks memory even while the choice stands');
  await privacy.setBlocked(st, { memory: false }); assert.equal(privacy.memoryAllowed(await privacy.loadState(st)), true);
  r = await privacy.applyState(st, { memory: false }); assert.equal(r.changes[0].granted, false); assert.equal(privacy.memoryAllowed(r.state), false);
  // postReceipts without a library binding writes nothing and says so
  assert.deepEqual(await privacy.postReceipts({}, { user: 'a' }, [{ purpose: 'memory', granted: true }]), { receipted: false });
});
