import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/voice-client.js', import.meta.url), 'utf8');
const PHASES = ['idle', 'preparing', 'connecting', 'live', 'ending', 'error'];
const LEGAL = {
  idle: ['preparing', 'idle', 'ending', 'error'],
  preparing: ['idle', 'preparing', 'connecting', 'ending', 'error'],
  connecting: ['live', 'idle', 'ending', 'error'],
  live: ['ending', 'idle', 'error', 'live'],
  ending: ['idle', 'ending', 'error'],
  error: ['preparing', 'idle', 'error', 'ending'],
};

function load() {
  const start = src.indexOf('function voicePhase(');
  if (start < 0) throw new Error('voicePhase is not defined');
  let depth = 0, seen = false, end = start;
  for (; end < src.length; end++) {
    const ch = src[end];
    if (ch === '{') { depth += 1; seen = true; }
    else if (ch === '}') { depth -= 1; if (seen && depth === 0) { end += 1; break; } }
  }
  return vm.runInNewContext(`${src.slice(start, end)}\nvoicePhase;`, {});
}

test('every legal voice phase pair, and every other pair is refused', () => {
  const voicePhase = load();
  let legal = 0, illegal = 0;
  for (const phase of PHASES) {
    for (const event of PHASES) {
      const before = { phase };
      const result = voicePhase(before, { type: event });
      if (LEGAL[phase].includes(event)) {
        legal += 1;
        assert.equal(result.ok, true, `${phase} ${event}`);
        assert.equal(result.illegal, false);
        assert.equal(result.rejection, undefined);
        assert.equal(result.state.phase, event);
        assert.notEqual(result.state, before);
      } else {
        illegal += 1;
        assert.equal(result.illegal, true, `${phase} ${event}`);
        assert.equal(result.ok, false);
        assert.equal(result.state, before);
        assert.deepEqual(result.effects, []);
        assert.deepEqual(result.rejection, { id: 'voice-phase', phase, event });
      }
    }
  }
  assert.equal(legal, 24);
  assert.equal(illegal, 12);
});

test('an unknown phase or event keeps the stored state', () => {
  const voicePhase = load();
  const before = { phase: 'archived' };
  const result = voicePhase(before, { type: 'idle' });
  assert.equal(result.state, before);
  assert.deepEqual(result.rejection, { id: 'voice-phase', phase: 'unknown', event: 'idle' });
  const named = voicePhase({ phase: 'idle' }, { type: 'reopen' });
  assert.deepEqual(named.rejection, { id: 'voice-phase', phase: 'idle', event: 'unknown' });
});

test('no voice phase is unreachable and there is no terminal phase', () => {
  const voicePhase = load();
  const seen = new Set();
  const queue = [{ phase: 'idle' }];
  let steps = 0;
  while (queue.length && steps < 200) {
    const state = queue.shift();
    if (seen.has(state.phase)) continue;
    seen.add(state.phase);
    steps += 1;
    for (const event of PHASES) {
      const result = voicePhase(state, { type: event });
      if (result.ok) queue.push(result.state);
    }
  }
  for (const phase of PHASES) assert.equal(seen.has(phase), true, phase);
  const terminals = PHASES.filter(phase => PHASES.every(event => {
    const result = voicePhase({ phase }, { type: event });
    return !result.ok || result.state.phase === phase;
  }));
  assert.deepEqual(terminals, []);
});

test('status is the only phase writer after the initial idle', () => {
  assert.match(src, /function status\(state,heading,message\)\{const step=voicePhase\(\{phase\},\{type:state\}\);if\(!step\.ok\)return;phase=step\.state\.phase;/);
  assert.equal(src.includes("phase='live'"), false);
});
