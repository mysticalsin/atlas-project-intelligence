// A typed draft grant is a different sentence from the voice grant.
// The receipt stores the hash of the sentence that was shown.
// Synthetic subject keys only. No provider call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';
import { applyState, consentText, recordReceipts, textHash } from '../src/privacy.js';

const SUBJECT = 'ab'.repeat(16);
const NOW = '2026-11-25T12:00:00.000Z';

function library() {
  return new Library(memorySql(), { now: () => NOW });
}

function hashes(lib) {
  return lib.rows('SELECT purpose, granted, text_sha256 FROM consent_receipts ORDER BY rowid').map(row => ({
    purpose: row.purpose,
    granted: row.granted,
    hash: row.text_sha256,
  }));
}

function memoryStorage() {
  const data = new Map();
  return {
    async get(key) { return data.get(key); },
    async put(key, value) { data.set(key, value); },
  };
}

test('a typed draft grant stores the typed sentence, and a repeat does not', () => {
  const voice = textHash('draft', 'voice');
  const typed = textHash('draft', 'text');
  assert.notEqual(consentText('draft', 'voice'), consentText('draft', 'text'));
  assert.notEqual(voice, typed);
  const lib = library();
  const first = recordReceipts(lib, SUBJECT, [{ purpose: 'draft', granted: true, mode: 'voice' }]);
  assert.equal(first.recorded.length, 1);
  assert.deepEqual(hashes(lib), [{ purpose: 'draft', granted: 1, hash: voice }]);
  const second = recordReceipts(lib, SUBJECT, [{ purpose: 'draft', granted: true, mode: 'text' }]);
  assert.equal(second.recorded.length, 1);
  assert.equal(second.recorded[0].granted, true);
  assert.deepEqual(hashes(lib), [
    { purpose: 'draft', granted: 1, hash: voice },
    { purpose: 'draft', granted: 1, hash: typed },
  ]);
  const again = recordReceipts(lib, SUBJECT, [{ purpose: 'draft', granted: true, mode: 'text' }]);
  assert.equal(again.recorded.length, 0);
  assert.equal(hashes(lib).length, 2);
});

test('a purpose with one sentence does not gain a receipt when the mode label changes', () => {
  assert.equal(textHash('checkpoint', 'voice'), textHash('checkpoint', 'text'));
  const lib = library();
  recordReceipts(lib, SUBJECT, [{ purpose: 'checkpoint', granted: true, mode: 'voice' }]);
  const again = recordReceipts(lib, SUBJECT, [{ purpose: 'checkpoint', granted: true, mode: 'text' }]);
  assert.equal(again.recorded.length, 0);
  assert.equal(hashes(lib).length, 1);
  const withdrawn = recordReceipts(lib, SUBJECT, [{ purpose: 'checkpoint', granted: false, mode: 'text' }]);
  assert.equal(withdrawn.recorded.length, 1);
  assert.equal(withdrawn.recorded[0].granted, false);
});

test('the interview state asks for a new receipt when the draft sentence changes', async () => {
  const storage = memoryStorage();
  const seen = [];
  const voice = await applyState(storage, { draft: true }, { mode: 'voice', now: NOW, beforeCommit: async changes => { seen.push(...changes); } });
  assert.equal(voice.changes.length, 1);
  assert.equal(voice.changes[0].mode, 'voice');
  const same = await applyState(storage, { draft: true }, { mode: 'voice', now: NOW });
  assert.equal(same.changes.length, 0);
  const typed = await applyState(storage, { draft: true }, { mode: 'text', now: NOW, beforeCommit: async changes => { seen.push(...changes); } });
  assert.equal(typed.changes.length, 1);
  assert.equal(typed.changes[0].mode, 'text');
  assert.equal(typed.state.purposes.draft.mode, 'text');
  assert.deepEqual(seen.map(change => change.mode), ['voice', 'text']);
  const held = await applyState(storage, { draft: true }, { mode: 'text', now: NOW });
  assert.equal(held.changes.length, 0);
});
