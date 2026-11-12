// The Python gateway's door to the same Durable Object. No second ledger.
// A bearer token the operator sets (ATLAS_LEDGER_TOKEN) is required. The browser never holds it.
// This file does not call a provider.
import { PRODUCTION_LEDGER_NAME, priceOf } from './meter.js';

// Compare the whole bearer, including a missing secret or a different length. Empty is never a match.
export function bearerMatches(secret, given) {
  const a = String(secret ?? '');
  const b = String(given ?? '');
  const n = Math.max(a.length, b.length, 1);
  let d = a.length ^ b.length;
  if (a.length === 0) d |= 1;
  for (let i = 0; i < n; i++) {
    const av = i < a.length ? a.charCodeAt(i) : 0;
    const bv = i < b.length ? b.charCodeAt(i) : 0;
    d |= av ^ bv;
  }
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
  if (!bearerMatches(secret, given) || !ns || typeof ns.get !== 'function' || typeof ns.idFromName !== 'function') {
    return json({ ok: false, reason: 'no_ledger' }, 401);
  }
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, reason: 'refused' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ ok: false, reason: 'refused' }, 400);
  const stub = ns.get(ns.idFromName(PRODUCTION_LEDGER_NAME));
  if (url.pathname === '/api/ledger/reserve') {
    const r = await stub.reserve(body);
    return json(r, r?.ok ? 200 : 429);
  }
  const estimate = body.estimate && typeof body.estimate === 'object' && !Array.isArray(body.estimate) ? body.estimate : {};
  const usage = body.usage && typeof body.usage === 'object' && !Array.isArray(body.usage) ? body.usage : null;
  let actualNano = usage ? priceOf({ ...estimate, ...usage }) : undefined;
  if (!Number.isInteger(actualNano) || actualNano < 0) actualNano = undefined;
  const settled = await stub.settle(body.id, { ...(actualNano === undefined ? {} : { actualNano }), error: body.error || undefined });
  const ok = settled === true || settled?.ok === true;
  const failure = settled && typeof settled === 'object' && settled.reason ? { reason: settled.reason } : {};
  return json(ok ? { ok: true } : { ok: false, ...failure }, ok ? 200 : 409);
}
