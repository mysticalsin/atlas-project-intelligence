// Minimal storage stub for the rate-limit tests. The interview reconnect harness (checkpoints, evidence) is a later slice.
export class FakeStorage {
  constructor() { this.map = new Map(); }
  async get(keys) {
    if (Array.isArray(keys)) {
      const out = new Map();
      for (const k of keys) if (this.map.has(k)) out.set(k, this.map.get(k));
      return out;
    }
    return this.map.get(keys);
  }
  async put(obj) { for (const [k, v] of Object.entries(obj)) this.map.set(k, v); }
  async delete(keys) { for (const k of [].concat(keys)) this.map.delete(k); }
  async list({ prefix } = {}) {
    const out = new Map();
    for (const [k, v] of this.map) if (!prefix || String(k).startsWith(prefix)) out.set(k, v);
    return out;
  }
  keys() { return [...this.map.keys()]; }
}
