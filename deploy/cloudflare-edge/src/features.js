// Feature registry and handler contract (WOW_SPEC §2.1). library-routes.js asks featureRoutes before the generic
// /:id routes; a word whose module is not READY answers 404, so a deployed but unaccepted module is unreachable.
// Later edits only by T1 (to add a word).
import * as bids from './bids.js';      import * as ask from './ask.js';        import * as winloop from './winloop.js';
import * as gaps from './gaps.js';      import * as claims from './claims.js';  import * as outreach from './outreach.js';
import { teamsStatus } from './teams.js';
import * as profile from './profile.js';

// profile, people and directory (WOW_ZERO_CONFIG §6) work in both identity modes (keyed by x-atlas-user); externals get 403.
export const WORDS = { bids: bids.routes, ask: ask.routes, wins: winloop.routes, gaps: gaps.routes,
  claims: claims.routes, confirmations: claims.routes, outreach: outreach.routes, staffing: outreach.routes,
  profile: profile.routes, people: profile.routes, directory: profile.routes };
// `directory`: the DNA push forward (POST directory/import only; the Worker checked the bearer secret).
export const SYSTEM_WORDS = { 'teams-event': outreach.system, directory: profile.routes };
export const EXTERNAL_WORDS = new Set(['confirmations']);      // the only word an 'external' role may reach
export const EMAIL_AUTH_WORDS = new Set(['gaps', 'claims', 'confirmations']); // Access mode only (Q6)
const MODULE = { bids, ask, wins: winloop, gaps, claims, confirmations: claims, outreach, staffing: outreach, 'teams-event': outreach,
  profile, people: profile, directory: profile };
// D1 (WOW_ZERO_CONFIG §4): spoken Ask is a per-user consent prompt at the moment of use, not a deployment variable.
// A code constant like READY: false until Tony confirms D1, then flipped once in a commit.
export const SPOKEN_ASK_APPROVED = false;

// The identity-mode gate on top of a readiness test: email-authorised words are off in Entra mode (the email is a
// mutable claim there). Tests pass their own `isReady` to exercise the gate before a module's READY flips.
export const readyGate = (word, env, isReady) => !!isReady(word) && (env?.IDENTITY_SOURCE !== 'entra' || !EMAIL_AUTH_WORDS.has(word));
export const readyOf = (word, env) => readyGate(word, env, w => MODULE[w]?.READY);

export async function featureRoutes(ctx, ready = readyOf) {
  const word = ctx.parts[0], map = ctx.user.role === 'system' ? SYSTEM_WORDS : WORDS, h = Object.hasOwn(map, word) ? map[word] : null;
  if (!h) return null;
  if (ctx.user.role === 'external' && !EXTERNAL_WORDS.has(word)) return { status: 403, body: { error: 'Not available to external confirmers.' } };
  if (!ready(word, ctx.env)) return { status: 404, body: { error: 'This feature is not available in this deployment.' } };
  return h(ctx);
}

// Bootstrap `features` (§2.5). `ready` defaults to readyOf; tests may pass another to exercise the opt-in vars, and
// `spokenAskApproved` to exercise D1 before it flips. PDF briefs follow bids (D2: PDF conversion is text extraction,
// metadata off; images stay refused).
export function flags(env = {}, ready = readyOf, { spokenAskApproved = SPOKEN_ASK_APPROVED } = {}) {
  const on = w => ready(w, env);
  return { bids: on('bids'), ask: on('ask'), spokenAsk: on('ask') && spokenAskApproved === true, wins: on('wins'),
    customerJev: on('bids') && !!env.TYPESAFE_API_KEY, pdfBriefs: on('bids'),
    gaps: on('gaps'), gapInterview: on('gaps'), claims: on('claims'),
    clientConfirm: on('claims') && env.CLIENT_CONFIRM === '1' && !!env.EXTERNAL_EMAILS,
    outreach: on('outreach'), staffing: on('outreach'), teams: teamsStatus(env), phone: 'BLOCKED_EXTERNAL', profile: on('profile') };
}
