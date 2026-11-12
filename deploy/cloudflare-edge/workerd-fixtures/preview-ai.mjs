// Preview host, real ProductionSpendLedger, one AI call. The AI binding here only counts.
// A provider fetch is a counted run. The month stop uses the same sentence as the app.
import { ProductionSpendLedger } from '../src/worker.js';
import { paid } from '../src/meter.js';
import { httpBudget } from '../src/budget-stop.js';
import { allowedOrigin } from '../src/preview.js';

export { ProductionSpendLedger };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const stub = env.SPEND_LEDGER ? env.SPEND_LEDGER.get(env.SPEND_LEDGER.idFromName('production')) : null;
    if (url.pathname === '/exhaust') {
      if (!stub) return Response.json({ ok: false, reason: 'no_ledger' }, { status: 503 });
      const reserved = await stub.reserve({ kind: 'memory', provider: 'hindsight', operation: 'recall', inputTokens: 1000, outputTokens: 100 });
      if (!reserved.ok) return Response.json(reserved);
      await stub.settle(reserved.id, { usage: { inputTokens: 4000000, outputTokens: 0 } });
      return Response.json(await stub.snapshot());
    }
    const origin = allowedOrigin(env, url);
    if (!origin) return new Response('Host is not the configured ATLAS origin.', { status: 403 });
    let fetches = 0;
    const aiEnv = {
      ...env, ORIGIN: origin,
      AI: {
        async run() { fetches += 1; return { ok: true }; },
        async toMarkdown() { fetches += 1; return 'x'; },
      },
    };
    try {
      await paid(aiEnv).run(() => ({ kind: 'stt', model: '@cf/deepgram/nova-3', audioMs: 1000 }), '@cf/deepgram/nova-3', {});
      return Response.json({ called: true, fetches });
    } catch (e) {
      const stopped = httpBudget(e);
      if (stopped) return Response.json({ ...stopped.body, fetches }, { status: stopped.status });
      return Response.json({ reason: e.reason || '', name: e.name || '', fetches }, { status: 403 });
    }
  },
};
