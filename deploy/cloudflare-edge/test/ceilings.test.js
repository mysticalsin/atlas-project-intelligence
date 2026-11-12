// Each kind's ceiling has to cover the worst case under the limit that call actually enforces.
// An actual above that ceiling stays an overrun. Settle is not clamped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '../src/prices.js';
import { BudgetState, callCeilingNano, capPcm, capText, generationTokens, inputTokenCeiling, markdownPlan, priceOf, realtimeReservation } from '../src/meter.js';
import { usageFrom } from '../src/usage.js';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const edge = name => read('../src/' + name);
const py = name => read('../../../atlas_voice/' + name);
const NANO = 1e9;
const NOVA = '@cf/deepgram/nova-3';
const TURN = '@cf/pipecat-ai/smart-turn-v2';
const LLAMA = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const GPT = '@cf/openai/gpt-oss-120b';
const AURA = '@cf/deepgram/aura-2-en';
const BGE = '@cf/baai/bge-m3';

test('settle still records an overrun and does not clamp it', () => {
  const src = edge('month-budget.js');
  assert.match(src, /if \(charged > ceiling\)/);
  assert.match(src, /next\.overruns\.requests \+= 1/);
  assert.doesNotMatch(src, /Math\.min\(charged, ceiling\)/);
  const b = new BudgetState({ now: () => Date.parse('2026-11-12T00:00:00Z') });
  const req = { kind: 'stt', model: NOVA, audioMs: 1000 };
  const reserved = b.reserve(req);
  const ceiling = b.snapshot().reserved.nanoUsd;
  assert.equal(b.settle(reserved.id, { actualNano: ceiling + 50_000 }), true);
  assert.equal(b.snapshot().overruns.requests, 1);
  assert.equal(b.snapshot().overruns.nanoUsd, 50_000);
  assert.equal(b.snapshot().exhausted, true);
  assert.equal(b.reserve(req).reason, 'exhausted:usd');
});

test('a settle that stores $6 keeps the real amount, and an overrun under $5 still exhausts the month', () => {
  const lines = [];
  const orig = console.log;
  console.log = line => lines.push(String(line));
  try {
    const six = new BudgetState({ limitUsd: 5, now: () => Date.parse('2026-11-12T00:00:00Z') });
    const held = six.reserve({ kind: 'stt', model: NOVA, audioMs: 1000 });
    const open = six.reserve({ kind: 'stt', model: NOVA, audioMs: 1000 });
    assert.equal(six.settle(held.id, { actualNano: 6_000_000_000 }), true);
    const blown = six.snapshot();
    assert.ok(blown.reserved.nanoUsd >= 6_000_000_000, 'the $6 is stored');
    assert.equal(blown.phase, 'exhausted');
    assert.equal(blown.exhausted, true);
    assert.equal(six.settle(open.id, { actualNano: 1 }), true, 'a hold that is already open still settles');
    assert.ok(six.snapshot().observed.nanoUsd >= 6_000_000_000, 'the spend stays visible');
    const logged = lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).find(row => row && row.event === 'overrun');
    assert.equal(logged.id, held.id);
    assert.equal(logged.month, '2026-11');
    assert.equal(logged.usd, undefined);
    assert.equal(logged.nanoUsd, undefined);

    const under = new BudgetState({ limitUsd: 5, now: () => Date.parse('2026-11-12T00:00:00Z') });
    const req = { kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: 1000, outputTokens: 100 };
    const reserved = under.reserve(req);
    const ceiling = callCeilingNano(req);
    assert.equal(under.snapshot().reserved.nanoUsd, ceiling, 'the hold is the known input plus the max output');
    assert.equal(under.settle(reserved.id, { usage: { inputTokens: 4_000_000, outputTokens: 0 } }), true);
    const snap = under.snapshot();
    assert.ok(snap.reserved.nanoUsd > ceiling);
    assert.ok(snap.reserved.nanoUsd < 5e9, 'this overrun is still under $5');
    assert.equal(snap.overruns.requests, 1);
    assert.equal(snap.exhausted, true);
    assert.equal(snap.phase, 'exhausted');
    assert.equal(under.reserve(req).reason, 'exhausted:usd');
  } finally {
    console.log = orig;
  }
});

test('text and reasoning ceilings are the max_tokens the call sends', () => {
  const specs = ['talker', 'analyst', 'analystReport', 'analystComplete', 'analystSheet', 'analystVisuals', 'gatewayAnalyst', 'notes', 'editor', 'gatewayReport'];
  for (const name of specs) {
    const spec = LIMITS[name];
    const cap = generationTokens(spec);
    assert.equal(cap, spec.maxTokens + spec.reasoningTokens, name);
    const billed = usageFrom({ usage: { prompt_tokens: 4, completion_tokens: cap, completion_tokens_details: { reasoning_tokens: cap } } });
    assert.equal(billed.outputTokens, cap, name + ' bills the higher of completion and reasoning, inside the cap');
    const model = name === 'talker' ? LLAMA : GPT;
    const kind = name === 'talker' ? 'talker' : 'analyst';
    const atCap = priceOf({ kind, model, inputTokens: 8, outputTokens: cap });
    const over = priceOf({ kind, model, inputTokens: 8, outputTokens: cap + 1 });
    assert.equal(callCeilingNano({ kind, model, inputTokens: 8, outputTokens: cap }), atCap + (model.startsWith('@cf/') ? 6_000_300 : 0));
    assert.ok(over > atCap, name);
  }
  const app = edge('app.js');
  assert.match(app, /generationTokens\(LIMITS\.talker\)/);
  assert.match(app, /generationTokens\(spec\)/);
  for (const name of ['analyst', 'analystReport', 'analystComplete']) {
    assert.match(app, new RegExp('LIMITS\\.' + name + '\\b'));
  }
  assert.match(edge('sheet.js'), /LIMITS\.analystSheet/);
  assert.match(edge('sheet.js'), /LIMITS\.analystVisuals/);
  for (const [file, key] of [['kyutai.py', 'talker'], ['analyst.py', 'gatewayAnalyst'], ['notes.py', 'notes'], ['editor.py', 'editor'], ['report.py', 'gatewayReport']]) {
    assert.match(py(file), new RegExp("output_tokens\\('" + key + "'\\)"));
  }
});

test('input ceilings are one token per byte of the body that is sent', () => {
  assert.equal(inputTokenCeiling(0), 1);
  assert.equal(inputTokenCeiling(40), 40);
  const body = '{"messages":[{"role":"user","content":"hi"}]}';
  assert.equal(inputTokenCeiling(new TextEncoder().encode(body).length), body.length);
  assert.match(edge('app.js'), /inputTokenCeiling\(/);
  assert.match(edge('memory.js'), /inputTokenCeiling\(/);
  assert.match(py('limits.py'), /len\(raw\)/);
  assert.match(py('kyutai.py'), /input_tokens\(/);
});

test('STT and TTS stay inside the audio and character caps', () => {
  const pcm = new Uint8Array((LIMITS.stt.maxAudioMs + 1000) * LIMITS.pcmBytesPerMs);
  const capped = capPcm(pcm, LIMITS.stt.maxAudioMs);
  assert.equal(capped.length, LIMITS.stt.maxAudioMs * LIMITS.pcmBytesPerMs);
  const at = priceOf({ kind: 'stt', model: NOVA, audioMs: LIMITS.stt.maxAudioMs });
  assert.equal(at, Math.ceil(LIMITS.stt.maxAudioMs / 60000 * 0.0052 * NANO));
  assert.equal(priceOf({ kind: 'stt', model: NOVA, audioMs: LIMITS.stt.maxAudioMs + 1000 }), null);
  const turn = capPcm(pcm, LIMITS.turn.maxAudioMs);
  assert.equal(turn.length, LIMITS.turn.maxAudioMs * LIMITS.pcmBytesPerMs);
  assert.equal(priceOf({ kind: 'turn', model: TURN, audioMs: LIMITS.turn.maxAudioMs }), Math.ceil(LIMITS.turn.maxAudioMs / 60000 * 0.00033795 * NANO));
  assert.equal(priceOf({ kind: 'turn', model: TURN, audioMs: LIMITS.turn.maxAudioMs + 1000 }), null);
  const spoken = capText('é'.repeat(LIMITS.tts.maxChars + 50), LIMITS.tts.maxChars);
  assert.equal([...spoken].length <= LIMITS.tts.maxChars || spoken.length === LIMITS.tts.maxChars, true);
  assert.equal(spoken.length, LIMITS.tts.maxChars);
  const worstChars = LIMITS.tts.maxChars * 3;
  const tts = priceOf({ kind: 'tts', model: AURA, chars: worstChars });
  assert.ok(tts > 0);
  assert.equal(priceOf({ kind: 'tts', model: AURA, chars: worstChars + 1 }), null);
  assert.equal(priceOf({ kind: 'tts', provider: 'elevenlabs', chars: worstChars + 1 }), null);
  assert.match(edge('app.js'), /capPcm\(pcm, LIMITS\.stt\.maxAudioMs\)/);
  assert.match(edge('app.js'), /LIMITS\.turn\.maxAudioMs/);
  assert.match(edge('app.js'), /capText\(/);
  assert.match(py('speech.py'), /cap_pcm\(pcm, LIMITS\['stt'\]\['maxAudioMs'\]\)/);
  assert.match(py('speech.py'), /cap_text\(/);
});

test('realtime reservation is the session limit plus one capped response', () => {
  const book = realtimeReservation(LIMITS.realtime.maxSeconds + 100);
  assert.equal(book.seconds, LIMITS.realtime.maxSeconds);
  assert.equal(book.stopInput, book.seconds * LIMITS.realtime.inputTokensPerSecond);
  assert.equal(book.stopOutput, book.seconds * LIMITS.realtime.outputTokensPerSecond);
  assert.equal(book.outputTokens, book.stopOutput + LIMITS.realtime.maxResponseTokens);
  const worst = priceOf({ kind: 'realtime', provider: 'openai', inputTokens: book.inputTokens, outputTokens: book.outputTokens });
  const past = priceOf({ kind: 'realtime', provider: 'openai', inputTokens: book.inputTokens, outputTokens: book.outputTokens + 1 });
  assert.equal(callCeilingNano({ kind: 'realtime', provider: 'openai', inputTokens: book.inputTokens, outputTokens: book.outputTokens }), worst);
  assert.ok(past > worst);
  assert.match(py('realtime.py'), /realtime_increment\(/);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const opened = spawnSync('python3', ['-c', `
import asyncio, os
os.environ['LEDGER_MODE'] = 'enforce'
from atlas_voice.realtime import RealtimeMeter
from atlas_voice.spend import BudgetRefused, use

class Ledger:
    async def reserve(self, estimate):
        raise BudgetRefused('no_ledger')
    async def settle(self, *args):
        return None

async def main():
    use(Ledger())
    meter = RealtimeMeter(object(), 'gpt-realtime-2.1', None, now=lambda: 1.0)
    try:
        await meter.open_increment()
    except BudgetRefused as error:
        print(error.reason)
        return
    print('none')

asyncio.run(main())
`], { cwd: root, encoding: 'utf8' });
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(opened.stdout.trim(), 'no_ledger');
  assert.match(py('realtime.py'), /refusal_event\(refused\)/);
  assert.match(py('spend.py'), /return BUDGET_MESSAGE, 'budget_exhausted'/);
  assert.match(py('quality.py'), /LIMITS\['realtime'\]\['maxResponseTokens'\]/);
});

test('embeddings and memory ceilings use the enforced caps', () => {
  const sliced = capText('水'.repeat(LIMITS.embed.maxChars + 10), LIMITS.embed.maxChars);
  assert.equal(sliced.length, LIMITS.embed.maxChars);
  const bytes = new TextEncoder().encode(sliced).length;
  assert.equal(bytes, LIMITS.embed.maxChars * 3);
  const embed = priceOf({ kind: 'embed', model: BGE, inputTokens: inputTokenCeiling(bytes) });
  assert.equal(embed, Math.ceil(bytes * 0.012 / 1e6 * NANO));
  assert.match(edge('app.js'), /LIMITS\.embed\.maxChars/);
  const recallOut = generationTokens({ maxTokens: LIMITS.memoryRecall.maxTokens, reasoningTokens: 0 });
  const recall = priceOf({ kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: LIMITS.memoryBody.maxBytes, outputTokens: recallOut });
  const recallBody = priceOf({ kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: LIMITS.memoryBody.maxBytes, outputTokens: 0 });
  assert.ok(recall > recallBody, 'recall output is inside the ceiling');
  const retain = priceOf({ kind: 'memory', provider: 'hindsight', operation: 'retain', inputTokens: LIMITS.memoryBody.maxBytes, outputTokens: 0 });
  assert.equal(retain, Math.ceil(LIMITS.memoryBody.maxBytes * 10 / 1e6 * NANO));
  assert.match(edge('memory.js'), /LIMITS\.memoryRecall\.maxTokens/);
  assert.match(edge('memory.js'), /LIMITS\.memoryBody\.maxBytes/);
  assert.match(py('memory.py'), /output_tokens\('gatewayRecall'\)/);
  assert.match(py('memory.py'), /LIMITS\['memoryBody'\]\['maxBytes'\]/);
});

test('toMarkdown is refused past the byte and page caps and priced from that page cap', () => {
  const overBytes = new Uint8Array(LIMITS.markdown.maxBytes + 1);
  assert.equal(markdownPlan(overBytes, 'a.pdf', 'application/pdf').ok, false);
  const overImage = new Uint8Array(LIMITS.markdown.maxImageBytes + 1);
  assert.equal(markdownPlan(overImage, 'a.png', 'image/png').ok, false);
  const tooMany = new TextEncoder().encode('%PDF-1.4\n' + '/Type /Page\n'.repeat(LIMITS.markdown.maxPages + 1));
  assert.equal(markdownPlan(tooMany, 'a.pdf', 'application/pdf').ok, false);
  const one = markdownPlan(new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'brief.pdf', 'application/pdf');
  assert.equal(one.ok, true);
  assert.equal(one.estimate.files, LIMITS.markdown.maxPages);
  assert.equal(one.estimate.media, 'document');
  const priced = priceOf(one.estimate);
  assert.ok(priced > 0);
  assert.equal(priceOf({ kind: 'markdown', files: LIMITS.markdown.maxPages + 1, media: 'document' }), null);
  const image = markdownPlan(new Uint8Array([1, 2, 3]), 'diagram.png', 'image/png');
  assert.equal(image.ok, false);
  assert.equal(image.code, 'unpriced_model');
  assert.equal(priceOf({ kind: 'markdown', files: 1, media: 'image' }), null);
  assert.match(edge('app.js'), /markdownPlan\(/);
  assert.match(edge('sheet.js'), /markdownPlan\(/);
});

test('JEV reserves the published context cap and refuses a larger body', () => {
  const nano = priceOf({ kind: 'jev', provider: 'typesafe', requests: 1 });
  assert.equal(nano, Math.ceil(LIMITS.jev.contextTokens * 0.042 / 1e6 * NANO));
  assert.match(edge('meter.js'), /function boundedJevBody/);
  for (const name of ['classify.js', 'customer-jev.js', 'jev.js', 'memory.js', 'memory-routes.js', 'rating.js']) {
    assert.match(edge(name), /boundedJevBody\(/);
  }
  assert.match(py('jev.py'), /jev_body\(/);
  assert.doesNotMatch(edge('customer-jev.js') + py('jev.py') + edge('classify.js'), /long-context|long_context/);
});
