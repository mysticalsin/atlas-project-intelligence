// Interview invitation status. Pure transitions. updateInvitation and the Teams card are the writers.
// The row is the stored state. An unknown status is rejected and is not rewritten.
export const INVITATION_STATUSES = Object.freeze(['open', 'scheduled', 'dismissed', 'done']);
export const INVITATION_EVENTS = Object.freeze(['schedule', 'dismiss', 'done']);
export const INVITATION_CLOSED = 'INVITATION_CLOSED';
export const INVITATION_REFUSAL = 'This invitation is closed. Nothing was changed.';
export const OPEN_INVITATION_SQL = "status IN ('open', 'scheduled')";

const OPEN = new Set(['open', 'scheduled']);
const NEXT = { schedule: 'scheduled', dismiss: 'dismissed', done: 'done' };

export function invitationTransition(state, event) {
  const type = event?.type;
  const phase = INVITATION_STATUSES.includes(state?.status) ? state.status : 'unknown';
  const name = INVITATION_EVENTS.includes(type) ? type : 'unknown';
  if (!OPEN.has(state?.status) || !INVITATION_EVENTS.includes(type)) {
    return {
      ok: false, illegal: true, state, effects: [],
      rejection: { id: String(state?.id || 'invitation'), phase, event: name },
    };
  }
  return { ok: true, illegal: false, state: { id: state.id, status: NEXT[type] }, effects: ['set_' + NEXT[type]] };
}

export function noteInvitation(result, emit) {
  const log = emit || (line => { try { console.warn(JSON.stringify(line)); } catch { /* logging never changes the decision */ } });
  if (result?.rejection) log({ id: result.rejection.id, phase: result.rejection.phase, event: result.rejection.event });
  return result;
}
