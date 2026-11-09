// Shared fixture for the ledger tests: every paid call site the edge app has, driven against fake upstreams
// (fake env.AI, recording fetchers). No provider, no network, no spend.
import { createHash } from 'node:crypto';
import { workersAI } from '../src/app.js';
import { hindsight, jevRelevant } from '../src/memory.js';
import { jevRanker } from '../src/jev.js';
import { classify } from '../src/classify.js';
import { InterviewLedger, guidance } from '../src/ledger.js';

const sha = b => createHash('sha256').update(b).digest('hex');

export async function ser(v) {
  if (v === undefined) return { undefined: true };
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Uint8Array) return { bytes: v.length, sha256: sha(v) };
  if (v instanceof ArrayBuffer) return { arrayBuffer: v.byteLength, sha256: sha(new Uint8Array(v)) };
  if (v instanceof ReadableStream) return { stream: await ser(new Uint8Array(await new Response(v).arrayBuffer())) };
  if (typeof AbortSignal !== 'undefined' && v instanceof AbortSignal) return { abortSignal: true };
  if (Array.isArray(v)) return Promise.all(v.map(ser));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = await ser(x);
  return out;
}

export const ENV = { STT_MODEL: '@cf/deepgram/nova-3', TTS_MODEL: '@cf/deepgram/aura-2-en', TTS_VOICE: 'asteria', TALKER_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  ANALYST_MODEL: '@cf/openai/gpt-oss-120b', EMBED_MODEL: '@cf/baai/bge-m3', TTS_MODEL_ES: '@cf/deepgram/aura-2-es', ELEVENLABS_API_KEY: 'fake-eleven-key', ELEVENLABS_MODEL: 'eleven_flash_v2_5',
  HINDSIGHT_URL: 'https://hs.example/', HINDSIGHT_API_KEY: 'hs-key', HINDSIGHT_OPT_IN: '1', TYPESAFE_API_KEY: 'k' };

export function fakeAI(calls) {
  let analystCalls = 0;
  return {
    async run(...args) {
      calls.push({ to: 'AI.run', args: await ser(args) });
      const [model, inputs] = args;
      if (model === ENV.STT_MODEL) return { results: { channels: [{ alternatives: [{ transcript: 'synthetic words', languages: ['en'] }] }] } };
      if (model.includes('smart-turn')) return { is_complete: true, probability: 0.91 };
      if (model.includes('aura')) return new Uint8Array(9).fill(3);
      if (model === ENV.TALKER_MODEL) return new ReadableStream({ start(c) { const e = new TextEncoder(); c.enqueue(e.encode('data: {"response":"Which "}\n')); c.enqueue(e.encode('data: {"response":"team?"}\n\ndata: [DONE]\n')); c.close(); } });
      if (model === ENV.EMBED_MODEL) return { data: [[0.25, 0.5]] };
      if (model === ENV.ANALYST_MODEL) {
        analystCalls += 1;
        if (analystCalls === 1 && inputs.reasoning) throw new Error('reasoning not accepted'); // exercises the retry path once
        return { choices: [{ message: { content: 'analysed', tool_calls: [{ id: 't1', function: { name: 'record', arguments: '{"a":1}' } }] } }] };
      }
      throw new Error('unexpected model ' + model);
    },
    async toMarkdown(...args) { calls.push({ to: 'AI.toMarkdown', args: await ser(args) }); return [{ name: 'a.pdf', data: '# text' }]; },
  };
}
export const recordingFetch = (calls, respond) => async (...args) => { calls.push({ to: 'fetch', args: await ser(args) }); return respond(...args); };

// extra: added to env (e.g. SPEND_LEDGER). Without it, SPEND_LEDGER is a getter that throws: off mode must not look it up.
export async function scenario(mode, extra = null) {
  const calls = [], outputs = {};
  const env = { ...ENV, ...(mode === undefined ? {} : { LEDGER_MODE: mode }) };
  if (extra) Object.assign(env, extra);
  else Object.defineProperty(env, 'SPEND_LEDGER', { get() { throw new Error('SPEND_LEDGER looked up in off mode'); }, enumerable: false });
  env.AI = fakeAI(calls);
  const pcm = new Uint8Array(4800).map((_, i) => i % 251);
  const ai = workersAI(env);
  outputs.transcribe = await ai.transcribe(pcm);
  outputs.turn = await ai.turnComplete(pcm);
  outputs.ttsEn = await ser(await ai.synthesize('Hello there.', 'atlas', 'en'));
  outputs.ttsEs = await ser(await ai.synthesize('Hola.', 'atlas', 'es'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = recordingFetch(calls, async () => new Response(new Uint8Array(7).fill(5)));
  try { outputs.ttsFr = await ser(await ai.synthesize('Bonjour.', 'atlas', 'fr')); } finally { globalThis.fetch = realFetch; }
  let said = ''; for await (const d of ai.chatStream([{ role: 'user', content: 'hi' }], { affinity: 'aff-1', maxTokens: 120 })) said += d;
  outputs.talker = said;
  said = ''; for await (const d of ai.chatStream([{ role: 'user', content: 'hi' }])) said += d;
  outputs.talkerNoAffinity = said;
  outputs.complete = await ai.complete([{ role: 'user', content: 'summarise' }]);
  outputs.report = await ai.report([{ role: 'user', content: 'report' }]);
  outputs.analyst = await ai.analyst([{ role: 'user', content: 'analyse' }]);
  outputs.embed = await ai.embed('some words');
  const ok = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const hs = hindsight(env, recordingFetch(calls, async (url) => ok(url.endsWith('/memories/recall') ? { results: [{ text: 'remembered', tags: ['project:p-1'] }] } : {})));
  await hs.ensureBank('bank-1');
  outputs.recall = await hs.recall('bank-1', 'query', { tags: ['project:p-1'] });
  outputs.documents = await hs.documents('bank-1');
  await hs.retain('bank-1', [{ content: 'x' }]);
  await hs.stats('bank-1');
  const mem = [{ text: 'own', tags: ['project:p-1'] }, { text: 'other', tags: ['project:p-2'] }];
  outputs.jevRelevant = await jevRelevant(env, mem, { id: 'p-1', title: 'Claims' }, recordingFetch(calls, async () => ok({ answers: { m0: { noul: 0.8 } } })));
  const l = new InterviewLedger('Delivery');
  for (const [i, [field, text]] of [['problem', 'Tickets bounced between three teams'], ['contribution', 'I personally rebuilt the routing rules']].entries()) {
    l.addTranscript('u' + i, text); l.call('c' + i, 'record_details', { details: [{ field, item_id: 'u' + i, quote: text }] });
  }
  const plan = l.planProbe();
  const rank = jevRanker(env, recordingFetch(calls, async () => ok({ answers: {} })));
  outputs.jevRanker = await rank(plan, guidance(plan)).catch(e => 'threw:' + e.message);
  const project = { title: 'Service triage (synthetic)', role: 'Data engineer', sector: 'Insurance', stage: 'Pilot',
    answers: ['Tickets bounced between three teams.', 'I built the routing rules.', 'We added an ML classifier.', 'Triage time fell from 42 to 26 minutes.', 'Service desk report, March 2026.', 'Useful for any support organisation.'] };
  outputs.classify = await classify(env, project, recordingFetch(calls, async () => ok({ answers: {} }))).catch(e => 'threw:' + e.message);
  return { calls, outputs: await ser(outputs) };
}

