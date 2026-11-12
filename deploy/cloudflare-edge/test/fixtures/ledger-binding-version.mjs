// Test-only door. Plants a month document, then uses the same ledger core the Worker binds.
import { DurableObject } from 'cloudflare:workers';
import { ProductionSpendLedger as LedgerCore } from '../../src/meter.js';

export class ProductionSpendLedger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new LedgerCore(ctx, env);
  }
  async plant(doc) {
    await this.core.storage.put('budget', doc);
    this.core.ledger = null;
    return { ok: true };
  }
  async stored() { return { doc: await this.core.storage.get('budget') }; }
  reserve(req) { return this.core.reserve(req); }
  snapshot() { return this.core.snapshot(); }
}

export default {
  async fetch(request, env) {
    const stub = env.SPEND_LEDGER.get(env.SPEND_LEDGER.idFromName('production'));
    const body = await request.json();
    if (body.op === 'plant') return Response.json(await stub.plant(body.doc));
    if (body.op === 'stored') return Response.json(await stub.stored());
    if (body.op === 'reserve') return Response.json(await stub.reserve(body.req));
    if (body.op === 'snapshot') return Response.json(await stub.snapshot());
    return new Response('no', { status: 400 });
  },
};
