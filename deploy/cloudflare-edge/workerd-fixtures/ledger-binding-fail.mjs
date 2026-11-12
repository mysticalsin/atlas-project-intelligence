// Same Durable Object shape as worker.js, with one storage.put failure armed from the test.
// The production class stays the one wrangler binds. This script only injects the put failure.
import { DurableObject } from 'cloudflare:workers';
import { ProductionSpendLedger as Core } from '../src/meter.js';

export class ProductionSpendLedger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.failPuts = 0;
    const storage = ctx.storage;
    const put = storage.put.bind(storage);
    const door = this;
    storage.put = async (key, value) => {
      if (door.failPuts > 0 && key === 'budget') {
        door.failPuts -= 1;
        throw new Error('put failed');
      }
      return put(key, value);
    };
    this.core = new Core({ storage }, env);
  }
  reserve(req) { return this.core.reserve(req); }
  settle(id, observed) { return this.core.settle(id, observed); }
  snapshot() { return this.core.snapshot(); }
  arm() { this.failPuts += 1; }
}

export default {
  async fetch(request, env) {
    const stub = env.SPEND_LEDGER.get(env.SPEND_LEDGER.idFromName('production'));
    const body = await request.json();
    if (body.op === 'reserve') return Response.json(await stub.reserve(body.req));
    if (body.op === 'settle') return Response.json({ settled: await stub.settle(body.id, body.observed || {}) });
    if (body.op === 'snapshot') return Response.json(await stub.snapshot());
    if (body.op === 'arm') { await stub.arm(); return Response.json({ armed: true }); }
    return new Response('no', { status: 400 });
  },
};
