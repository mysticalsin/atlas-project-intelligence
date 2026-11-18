// A timeout is recognized by err.code. The message text is not the signal.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as profile from '../src/profile.js';
import { Session } from '../src/session.js';
import { Library } from '../src/library.js';
import { memorySql } from './sqlite.js';

const PROD = { DATA_MODE: 'production' };
const PULL = { ...PROD, DNA_PROFILE_URL: 'https://dna.example/people/{email}', DNA_API_KEY: 'synthetic-key',
  DNA_FIELD_MAP: JSON.stringify({ name: 'name' }) };
const ALEX = { email: 'alex.martin@example.com', role: 'user' };

test('a DNA error with code timeout is recorded as timeout', async () => {
  const lib = new Library(memorySql(), { now: () => '2026-11-18T00:00:00.000Z', auditKey: 'synthetic-log-salt' });
  const fetcher = async () => { throw Object.assign(new Error('The operation was aborted'), { code: 'timeout' }); };
  await profile.resolveProfile(lib, PULL, { ...ALEX, idp: {} }, {}, { fetcher, timeoutMs: 50 });
  const status = profile.routes ? null : null;
  const view = await import('../src/profile.js');
  const admin = { email: 'ada@example.test', role: 'admin', idp: {} };
  const page = await view.routes({ method: 'GET', parts: ['directory'], user: admin, lib, env: PULL, url: new URL('https://atlas.test/api/library/directory') });
  assert.equal(page.body.sources.pull.lastError, 'timeout');
});

test('a report timeout is recognized by code', async () => {
  const metrics = [];
  const ai = {
    async transcribe() { return ''; },
    async synthesize() { return new Uint8Array(8); },
    async *chatStream() { yield 'Hello.'; },
    async report() { throw Object.assign(new Error('The operation was aborted'), { code: 'timeout' }); },
  };
  const s = new Session({ io: { send() {}, sendBytes() {}, close() {} }, ai, csrf: 'tok', voice: 'atlas', now: () => 1, sleep: () => Promise.resolve(), metric: (name, values) => metrics.push([name, values]) });
  s.ledger = { transcripts: new Map([['i1', 'Synthetic queue words.']]), notes: () => [], stage: 'Pilot' };
  s.history = [];
  const out = await s.report();
  assert.equal(out, null);
  assert.equal(metrics.find(row => row[0] === 'report_error')[1].name, 'Timeout');
});
