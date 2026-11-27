// A paid call site whose kind has no price fails here. null is a refusal, so a new kind cannot ship unpriced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PROXY_PER_CALL_NANO, callCeilingNano, priceOf } from '../src/meter.js';
import { ELEVENLABS_USD_PER_1K_CHARS, HINDSIGHT_RETAIN_USD_PER_M, TYPESAFE_USD_PER_REQUEST, markdownFileUsd } from '../src/prices.js';

const SRC = new URL('../src/', import.meta.url);
const code = name => readFileSync(new URL(name, SRC), 'utf8').split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
const NANO = 1e9;

const SAMPLES = {
  stt: { kind: 'stt', model: '@cf/deepgram/nova-3', audioMs: 1000 },
  turn: { kind: 'turn', model: '@cf/pipecat-ai/smart-turn-v2', audioMs: 1000 },
  tts: { kind: 'tts', model: '@cf/deepgram/aura-2-en', chars: 100 },
  talker: { kind: 'talker', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', inputTokens: 10, outputTokens: 10 },
  analyst: { kind: 'analyst', model: '@cf/openai/gpt-oss-120b', inputTokens: 10, outputTokens: 10 },
  embed: { kind: 'embed', model: '@cf/baai/bge-m3', inputTokens: 10 },
  markdown: { kind: 'markdown', files: 1 },
  memory: { kind: 'memory', provider: 'hindsight', requests: 1 },
  jev: { kind: 'jev', provider: 'typesafe', requests: 1 },
};
const PROVIDERS = {
  elevenlabs: { kind: 'tts', provider: 'elevenlabs', chars: 1000 },
  hindsight: SAMPLES.memory,
  typesafe: SAMPLES.jev,
};

test('every paid call site names a kind that has a positive ceiling', () => {
  const kinds = new Set(), providers = new Set();
  for (const name of readdirSync(SRC).filter(f => f.endsWith('.js'))) {
    const c = code(name);
    if (!c.includes('paid(')) continue;
    for (const m of c.matchAll(/\(\)\s*=>\s*\(\{\s*kind:\s*'([a-z_]+)'/g)) kinds.add(m[1]);
    for (const m of c.matchAll(/\(\)\s*=>\s*\(\{\s*kind:\s*'([a-z_]+)'[^}]*provider:\s*'([a-z_]+)'/g)) providers.add(m[2]);
  }
  assert.deepEqual([...kinds].sort(), Object.keys(SAMPLES).sort());
  assert.deepEqual([...providers].sort(), Object.keys(PROVIDERS).sort());
  for (const [kind, sample] of Object.entries(SAMPLES)) {
    const nano = priceOf(sample), ceiling = callCeilingNano(sample);
    assert.equal(typeof nano, 'number', kind);
    assert.ok(Number.isInteger(nano) && nano > 0, kind + ' price');
    assert.ok(ceiling >= nano, kind + ' ceiling');
    const binding = sample.model?.startsWith('@cf/') || kind === 'markdown';
    assert.equal(ceiling, binding ? nano + PROXY_PER_CALL_NANO : nano, kind + ' proxy');
  }
  for (const [name, sample] of Object.entries(PROVIDERS)) {
    assert.ok(priceOf(sample) > 0, name);
    assert.equal(callCeilingNano(sample), priceOf(sample), name + ' is not a Workers AI binding call');
  }
});

test('provider and markdown ceilings match the cited list prices', () => {
  assert.equal(priceOf({ kind: 'tts', provider: 'elevenlabs', chars: 1000 }), Math.ceil(ELEVENLABS_USD_PER_1K_CHARS * NANO));
  assert.equal(priceOf({ kind: 'analyst', model: '@cf/openai/gpt-oss-120b', inputTokens: 1_000_000, outputTokens: 1_000_000 }), Math.ceil((0.35 + 0.75) * NANO));
  assert.equal(priceOf({ kind: 'embed', model: '@cf/baai/bge-m3', inputTokens: 1_000_000 }), Math.ceil(0.012 * NANO));
  assert.equal(priceOf({ kind: 'markdown', files: 2 }), Math.ceil(2 * markdownFileUsd() * NANO));
  assert.equal(priceOf({ kind: 'memory', provider: 'hindsight', requests: 1 }), Math.ceil(HINDSIGHT_RETAIN_USD_PER_M / 1e6 * NANO));
  assert.equal(priceOf({ kind: 'jev', provider: 'typesafe', requests: 1 }), Math.ceil(TYPESAFE_USD_PER_REQUEST * NANO));
  assert.equal(priceOf({ kind: 'jev', provider: 'typesafe' }), Math.ceil(TYPESAFE_USD_PER_REQUEST * NANO), 'a missing request count still has the context-cap ceiling');
});
