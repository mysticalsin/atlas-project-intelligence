// The Python gateway's door to the same Durable Object. No second ledger.
// A bearer token the operator sets (ATLAS_LEDGER_TOKEN) is required. The browser never holds it.
import { PRODUCTION_LEDGER_NAME, priceOf } from './meter.js';

function timingSafe(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export async function spendRoute(request, env) {
  const url = new URL(request.url);
  if (request.method !== 'POST') return json({ ok: false, reason: 'refused' }, 405);
  if (url.pathname !== '/api/ledger/reserve' && url.pathname !== '/api/ledger/settle') return null;
  const secret = String(env.ATLAS_LEDGER_TOKEN || '');
  const given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const ns = env.SPEND_LEDGER;
  if (!secret || !ns || typeof ns.get !== 'function' || typeof ns.idFromName !== 'function' || given.length !== secret.length || !timingSafe(given, secret)) {
    return json({ ok: false, reason: 'no_ledger' }, 401);
  }
  let body = {};
  try { body = await request.json(); } catch { return json({ ok: false, reason: 'refused' }, 400); }
  const stub = ns.get(ns.idFromName(PRODUCTION_LEDGER_NAME));
  if (url.pathname === '/api/ledger/reserve') {
    const r = await stub.reserve(body && typeof body === 'object' ? body : {});
    return json(r, r?.ok ? 200 : 429);
  }
  const estimate = body.estimate && typeof body.estimate === 'object' ? body.estimate : {};
  const usage = body.usage && typeof body.usage === 'object' ? body.usage : null;
  const actualNano = usage ? priceOf({ ...estimate, ...usage }) : undefined;
  const settled = await stub.settle(body.id, { ...(Number.isInteger(actualNano) ? { actualNano } : {}), error: body.error || undefined });
  return json({ ok: settled === true || settled?.ok === true }, settled ? 200 : 409);
}
