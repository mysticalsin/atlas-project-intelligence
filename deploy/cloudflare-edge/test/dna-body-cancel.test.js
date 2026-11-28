// A DNA reply that declares it is over the cap must stop the download.
// The mapped profile is not stored. Synthetic records only. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as profile from '../src/profile.js';
import { Library } from './hold.js';
import { memorySql } from './sqlite.js';

const NOW = '2026-11-26T12:00:00.000Z';
const ADA = { email: 'ada@example.test', role: 'user' };
const MAP = JSON.stringify({ name: 'name' });
const PULL = {
  DATA_MODE: 'production',
  DNA_PROFILE_URL: 'https://dna.example/people/{email}',
  DNA_FIELD_MAP: MAP,
  DNA_API_KEY: 'synthetic-dna-key',
};

function library() {
  return new Library(memorySql(), { now: () => NOW });
}

function who() {
  return { idp: {}, mail: ADA.email, email: ADA.email, role: ADA.role };
}

function reply(body, headers, onCancel, close) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(body);
      if (close) controller.close();
    },
    cancel() { onCancel(); },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function quiet(fn) {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); }
  finally { console.log = log; }
}

test('a DNA reply that declares it is over the cap cancels the body and stores nothing', async () => {
  const lib = library();
  let cancelled = 0;
  const fetcher = async () => reply(new Uint8Array([123, 125]), { 'Content-Length': '70000' }, () => { cancelled += 1; }, false);
  const result = await quiet(() => profile.resolveProfile(lib, PULL, who(), {}, { fetcher }));
  assert.equal(result.sources[0].state, 'error');
  assert.equal(result.fields.name.from, 'guess');
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM directory')[0].n, 0);
  assert.equal(cancelled, 1);
});

test('a DNA reply read past the cap cancels the body and stores nothing', async () => {
  const lib = library();
  let cancelled = 0;
  const fetcher = async () => reply(new Uint8Array(70000), {}, () => { cancelled += 1; }, false);
  const result = await quiet(() => profile.resolveProfile(lib, PULL, who(), {}, { fetcher }));
  assert.equal(result.sources[0].state, 'error');
  assert.equal(lib.rows('SELECT COUNT(*) AS n FROM directory')[0].n, 0);
  assert.equal(cancelled, 1);
});

test('a small DNA reply is kept and its body is not cancelled', async () => {
  const lib = library();
  let cancelled = 0;
  const payload = new TextEncoder().encode(JSON.stringify({ name: 'Ada Example' }));
  const fetcher = async () => reply(payload, { 'Content-Length': String(payload.length) }, () => { cancelled += 1; }, true);
  const result = await quiet(() => profile.resolveProfile(lib, PULL, who(), {}, { fetcher }));
  assert.equal(result.sources[0].state, 'ok');
  assert.equal(result.fields.name.value, 'Ada Example');
  assert.equal(result.fields.name.from, 'dna');
  assert.equal(lib.rows('SELECT name FROM directory')[0].name, 'Ada Example');
  assert.equal(cancelled, 0);
});
