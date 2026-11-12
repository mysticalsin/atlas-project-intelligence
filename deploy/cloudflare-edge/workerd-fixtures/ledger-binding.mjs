export { ProductionSpendLedger } from '../src/worker.js';
export default {
  async fetch(request, env) {
    const stub = env.SPEND_LEDGER.get(env.SPEND_LEDGER.idFromName('production'));
    const body = await request.json();
    if (body.op === 'reserve') return Response.json(await stub.reserve(body.req));
    if (body.op === 'settle') return Response.json({ settled: await stub.settle(body.id, body.observed || {}) });
    if (body.op === 'snapshot') return Response.json(await stub.snapshot());
    return new Response('no', { status: 400 });
  },
};
