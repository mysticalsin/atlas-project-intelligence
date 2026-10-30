// Agent brain v2.1 conversation state machines (plan §3i, D8-D11, D19): a parity-tested port of atlas_voice/conversation_state.py,
// the source of truth. The tables come from policy.generated.js; test/gen_state_parity.py records the Python behaviour into
// test/state.vectors.json and test/conversation-state.test.js replays it here. Pure: the clock is read only when `at` is omitted.
import { CONVERSATION_WORKFLOW_VERSION as WORKFLOW_VERSION, CONVERSATION_FOCUS, CONVERSATION_STATES as STATES, CONVERSATION_EVENTS as EVENTS,
  CONVERSATION_TRANSITIONS as TRANSITIONS, CONVERSATION_STATUS as STATUS } from './policy.generated.js';

export { WORKFLOW_VERSION, STATES, EVENTS, TRANSITIONS, STATUS };
export const FOCUS_AREAS = CONVERSATION_FOCUS;
export const MACHINES = Object.keys(STATES);
const RETURN = '$return';
const FIELD = /^[a-z][a-z0-9_]{0,63}$/; // a skipped field is an internal field id, never free text
const trim = text => text.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, ''); // the same four characters Python trims

// An illegal or malformed move. `code` is stable across Python and JavaScript.
export class StateError extends Error {
  constructor(code, message) { super(message); this.name = 'StateError'; this.code = code; }
}

const INDEX = Object.fromEntries(MACHINES.map(kind => [kind, new Map(TRANSITIONS[kind].map(([e, f, t]) => [e + '\0' + f, t]))]));
const own = (o, k) => Object.hasOwn(o, k) ? o[k] : undefined;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const equal = (a, b) => {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (isObject(a)) { const ka = Object.keys(a), kb = Object.keys(b ?? {}); return isObject(b) && ka.length === kb.length && ka.every(k => Object.hasOwn(b, k) && equal(a[k], b[k])); }
  return a === b;
};

export class Machine {
  constructor(kind = 'interview') {
    if (!MACHINES.includes(kind)) throw new StateError('corrupt', `unknown machine ${JSON.stringify(kind)}`);
    this.kind = kind;
    this.state = STATES[kind].initial;
    this.focus = kind === 'interview' ? FOCUS_AREAS[0] : null;
    this.skipped = []; // fields the consultant chose to skip: skipped_by_user, never empty or negative
    this.returns = []; // states remembered by pause/disconnect, innermost last
    this.audit = [];
  }

  get terminal() { return STATES[this.kind].terminal.includes(this.state); }

  // The canonical entity status; a paused or suspended interview reports the status of the state it returns to.
  get status() {
    const state = STATES[this.kind].transient.includes(this.state) && this.returns.length ? this.returns[0] : this.state;
    return STATUS[this.kind][state];
  }

  availableEvents() { return TRANSITIONS[this.kind].filter(([, from]) => from === this.state).map(([e]) => e); }

  canFire(event, actor = null) {
    const spec = typeof event === 'string' ? own(EVENTS[this.kind], event) : undefined;
    return spec !== undefined && INDEX[this.kind].has(event + '\0' + this.state) && (actor === null || spec.actors.includes(actor));
  }

  // Take one transition and return the new state. Checks run in a fixed order and nothing changes on error.
  fire(event, actor, { reason = null, at = null, data = null } = {}) {
    const spec = typeof event === 'string' ? own(EVENTS[this.kind], event) : undefined;
    if (spec === undefined) throw new StateError('unknown_event', `${this.kind} has no event ${JSON.stringify(event)}`);
    let target = INDEX[this.kind].get(event + '\0' + this.state);
    if (target === undefined) throw new StateError('illegal_transition', `${this.kind}: ${event} is not allowed from ${this.state}`);
    if (typeof actor !== 'string' || !spec.actors.includes(actor)) throw new StateError('actor_not_allowed', `${event} may only be taken by ${spec.actors.join(', ')}`);
    if (reason !== null && typeof reason !== 'string') throw new StateError('bad_reason', 'reason must be text');
    reason = (reason !== null ? trim(reason) : null) || null;
    if (spec.reason && !reason) throw new StateError('reason_required', `${event} needs a reason`);
    const payload = payloadOf(event, spec, data);
    if (at === null) at = new Date().toISOString();
    else if (typeof at !== 'string' || !trim(at)) throw new StateError('bad_time', 'at must be a timestamp string');
    if (spec.restore && !this.returns.length) throw new StateError('corrupt', `${event} has no remembered state`);
    const before = this.state;
    if (spec.remember) this.returns.push(before);
    if (target === RETURN) target = this.returns.pop();
    if (STATES[this.kind].terminal.includes(target)) this.returns = [];
    this.state = target;
    if (payload) {
      if (event === 'focus') this.focus = payload.focus;
      else if (event === 'skip' && !this.skipped.includes(payload.field)) this.skipped.push(payload.field);
    }
    const entry = { from: before, to: target, event, actor, at, workflow_version: WORKFLOW_VERSION, reason };
    if (payload) entry.data = payload;
    this.audit.push(entry);
    return target;
  }

  toDict() {
    return structuredClone({ kind: this.kind, workflow_version: WORKFLOW_VERSION, state: this.state, focus: this.focus,
      skipped: this.skipped, returns: this.returns, audit: this.audit });
  }

  // Restore by replaying the audit trail through the table, then requiring the stored fields to match the replay: a
  // tampered, truncated or hand-edited snapshot is `corrupt`; another workflow version is not guessed at.
  static fromDict(d) {
    if (!isObject(d) || !MACHINES.includes(d.kind)) throw new StateError('corrupt', 'not a machine snapshot');
    if (d.workflow_version !== WORKFLOW_VERSION) throw new StateError('version_mismatch', `snapshot is ${JSON.stringify(d.workflow_version)}, this is ${WORKFLOW_VERSION}`);
    if (!Array.isArray(d.audit)) throw new StateError('corrupt', 'audit must be a list');
    const m = new Machine(d.kind);
    try {
      for (const entry of d.audit) {
        if (!isObject(entry)) throw new StateError('corrupt', 'audit entry is not an object');
        m.fire(entry.event, entry.actor, { reason: entry.reason ?? null, at: entry.at ?? null, data: entry.data ?? null });
        if (!equal(m.audit.at(-1), entry)) throw new StateError('corrupt', 'audit entry differs from its replay');
      }
    } catch (err) {
      if (err instanceof StateError) throw new StateError('corrupt', `audit does not replay: ${err.message}`);
      throw err;
    }
    if (!equal(m.toDict(), d)) throw new StateError('corrupt', 'snapshot fields differ from its audit trail');
    return m;
  }
}

function payloadOf(event, spec, data) {
  const want = spec.data;
  if (data !== null && !isObject(data)) throw new StateError('bad_data', `${event} data must be an object`);
  if (want === null) {
    if (data && Object.keys(data).length) throw new StateError('bad_data', `${event} takes no data`);
    return null;
  }
  const keys = data ? Object.keys(data) : [];
  if (keys.length !== 1 || keys[0] !== want.key) throw new StateError('bad_data', `${event} needs exactly ${want.key}`);
  const value = data[want.key];
  if (typeof value !== 'string' || !(want.values !== null ? want.values.includes(value) : FIELD.test(value))) throw new StateError('bad_data', `${event} ${want.key} is not allowed`);
  return { [want.key]: value };
}
