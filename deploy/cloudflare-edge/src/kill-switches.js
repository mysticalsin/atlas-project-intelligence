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
export const externalOff = env => on(env?.ATLAS_EXTERNAL_OFF);
export const inboundOff = env => on(env?.ATLAS_INBOUND_OFF);
const blockedList = env => String(env?.ATLAS_BLOCKED_SUBS || '').toLowerCase().split(',').map(s => s.trim()).filter(s => /^[0-9a-f]{12,64}$/.test(s));
// Prefix match so the 16-character `subj` of a log line works as well as the full 32-character key.
export const blockedSubject = (env, subjectKey) => { const k = String(subjectKey || '').toLowerCase(); return !!k && blockedList(env).some(b => k.startsWith(b)); };
// Names of the switches that are on (no values), for the once-per-isolate flag_state log line.
export const activeSwitches = env => [['ATLAS_READ_ONLY', readOnly], ['ATLAS_AI_OFF', aiOff], ['ATLAS_EXTERNAL_OFF', externalOff], ['ATLAS_INBOUND_OFF', inboundOff]]
  .filter(([, f]) => f(env)).map(([n]) => n).concat(blockedList(env).length ? ['ATLAS_BLOCKED_SUBS'] : []);

export const READ_ONLY_MESSAGE = 'ATLAS is in read-only mode for maintenance. Nothing was saved or changed. Please try again later.';
export const AI_OFF_MESSAGE = 'The AI features are paused by the ATLAS owner for now. Your notes are safe, and you can still read and edit them. Please try again later.';
export const INTERVIEW_PAUSED_MESSAGE = 'Interviews are paused for a short while. Nothing you wrote has been lost. Please come back a little later.';
export const BLOCKED_MESSAGE = 'Access to ATLAS is suspended for this account. Please contact the ATLAS owner.';
export const EXTERNAL_OFF_MESSAGE = 'External confirmations are switched off for now.';
export const INBOUND_OFF_MESSAGE = 'This integration is switched off.';
