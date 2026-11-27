// Operator kill switches (handoff/SECURITY_RUNBOOK.md §3). Plain environment variables read on every request; a change needs
// a deploy (`wrangler deploy --var NAME:value` or the dashboard), so a switch is a containment tool, not a feature flag.
//   ATLAS_READ_ONLY=1       every mutating request (anything but GET/HEAD) and every new interview answers 503
//   ATLAS_AI_OFF=1          no model call anywhere (talker, analyst, STT/TTS, sheet, JEV, rating, review); interviews refused politely
//   ATLAS_BLOCKED_SUBS=a,b  subject keys (the pseudonymous `subj` of the security log, at least 12 hex characters) answer 403
//   ATLAS_EXTERNAL_OFF=1    the external-confirmer role and /confirm, /api/library/confirmations/* answer 403
//   ATLAS_INBOUND_OFF=1     the bearer-secret integrations (triggers, DNA push, Teams bot and tab) answer 503 before any secret is checked
const on = v => /^(1|true|on|yes)$/i.test(String(v ?? '').trim());
export const readOnly = env => on(env?.ATLAS_READ_ONLY);
export const aiOff = env => on(env?.ATLAS_AI_OFF);
// X1 (red M2): the ONE guard every model or third-party client consults before anything leaves the Worker (TypeSafe JEV ranker, rating, classify, ask and bid rankers, Hindsight
// memory, Workers AI and ElevenLabs). The clients return null / unavailable or throw this coded error; none calls out while ATLAS_AI_OFF is on.
export const aiOffError = () => Object.assign(new Error('AI is switched off by the operator.'), { status: 503, code: 'AI_OFF' });
export const assertAiOn = env => { if (aiOff(env)) throw aiOffError(); };
export const externalOff = env => on(env?.ATLAS_EXTERNAL_OFF);
export const inboundOff = env => on(env?.ATLAS_INBOUND_OFF);
const blockedList = env => String(env?.ATLAS_BLOCKED_SUBS || '').toLowerCase().split(',').map(s => s.trim()).filter(s => /^[0-9a-f]{12,64}$/.test(s));
// Prefix match so the 16-character `subj` of a log line works as well as the full 32-character key.
// A longer entry, such as the 64-character HMAC before that cut, still blocks the same key.
// The shared prefix has to be at least 12 characters, so a one-character subject matches nothing.
export const blockedSubject = (env, subjectKey) => {
  const k = String(subjectKey || '').toLowerCase();
  if (!k) return false;
  return blockedList(env).some(b => {
    const n = Math.min(k.length, b.length);
    return n >= 12 && (k.startsWith(b) || b.startsWith(k));
  });
};
// Names of the switches that are on (no values), for the once-per-isolate flag_state log line.
export const activeSwitches = env => [['ATLAS_READ_ONLY', readOnly], ['ATLAS_AI_OFF', aiOff], ['ATLAS_EXTERNAL_OFF', externalOff], ['ATLAS_INBOUND_OFF', inboundOff]]
  .filter(([, f]) => f(env)).map(([n]) => n).concat(blockedList(env).length ? ['ATLAS_BLOCKED_SUBS'] : []);

// X1 (red L2): every security-relevant NON-DEFAULT setting, by name (never a value), so an operator and the admin readiness view see it: the kill switches, the CSP rollout switch
// (report-only puts the legacy policy back), the CSRF binding rollback, the reply-guard rollback, and any destination adapters that are not off. Written once per isolate as a
// flag_state event (security-log.js announceFlags) and listed in an admin's /api/bootstrap.
const lc = v => String(v ?? '').trim().toLowerCase();
export const securityFlags = env => {
  const out = [...activeSwitches(env)];
  if (lc(env?.ATLAS_CSP) === 'report-only') out.push('ATLAS_CSP:report-only');
  if (lc(env?.ATLAS_CSRF_BIND) === 'sub') out.push('ATLAS_CSRF_BIND:sub');
  if (lc(env?.ATLAS_REPLY_GUARD) === 'off') out.push('ATLAS_REPLY_GUARD:off');
  if (['live', 'mock'].includes(lc(env?.ATLAS_ADAPTERS))) out.push('ATLAS_ADAPTERS:' + lc(env.ATLAS_ADAPTERS));
  return out;
};

export const READ_ONLY_MESSAGE = 'ATLAS is in read-only mode for maintenance. Nothing was saved or changed. Please try again later.';
export const AI_OFF_MESSAGE = 'The AI features are paused by the ATLAS owner for now. Your notes are safe, and you can still read and edit them. Please try again later.';
export const INTERVIEW_PAUSED_MESSAGE = 'Interviews are paused for a short while. Nothing you wrote has been lost. Please come back a little later.';
export const BLOCKED_MESSAGE = 'Access to ATLAS is suspended for this account. Please contact the ATLAS owner.';
export const EXTERNAL_OFF_MESSAGE = 'External confirmations are switched off for now.';
export const INBOUND_OFF_MESSAGE = 'This integration is switched off.';
