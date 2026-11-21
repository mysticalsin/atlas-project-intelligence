// Ownership fence for a replaced interview. The store records only the current
// session id. It does not store the interview body: that needs the saved-interview
// consent, which this slice does not change. A session whose owner token is no
// longer current cannot move the id.
export const SUSPEND_WAIT_MS = 3000;
const SESSION_ID = /^[a-f0-9]{32}$/;
export const CURRENT_KEY = 'cp:current';

export class CheckpointError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'CheckpointError'; }
}

export class CheckpointStore {
  constructor(storage, { isCurrent = () => true } = {}) {
    if (!storage || typeof storage.put !== 'function') throw new TypeError('checkpoint storage is required');
    this.storage = storage;
    this.isCurrent = isCurrent;
  }

  async save(doc) {
    if (!this.isCurrent()) throw new CheckpointError('replaced', 'this session no longer owns the checkpoint');
    const id = doc && doc.sessionId;
    if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new CheckpointError('session', 'invalid session id');
    await this.storage.put(CURRENT_KEY, id);
  }
}

// Revoke the previous writer before waiting for it to suspend, then return the
// token the replacement must keep. A later handoff replaces the token, so a
// slow suspension cannot install itself afterwards.
export async function handoffInterview(holder, suspend) {
  const owner = Symbol('checkpoint');
  holder.checkpointOwner = owner;
  const session = holder.session;
  if (session && !session.finished) {
    let timer;
    try {
      await Promise.race([
        Promise.resolve(suspend(session)),
        new Promise(resolve => { timer = setTimeout(resolve, SUSPEND_WAIT_MS); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  return owner;
}
