// The local stand-in for Cloudflare Durable Objects (dev only): one instance per name, each with an in-memory `storage` that has
// the key-value calls the code uses (get / put / delete / list / alarms) and an alarm that fires through setTimeout (never keeping
// the process alive). The REAL Interview class of src/worker.js runs on it. State lives until the process stops.
import { register } from 'node:module';

// worker.js imports 'cloudflare:workers' (the DurableObject base class) and the compiled page; neither exists in Node.
export function hookWorkerImports() {
  register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}', shortCircuit: true };
  if (spec.endsWith('.html')) return { url: 'data:text/javascript,export default \"\"', shortCircuit: true };
  return next(spec, ctx);
}
`));
}

export class LocalStorage {
  constructor(onAlarm) { this.m = new Map(); this.alarm = null; this.timer = null; this.onAlarm = onAlarm; }
  async get(k) { return Array.isArray(k) ? new Map(k.filter(x => this.m.has(x)).map(x => [x, structuredClone(this.m.get(x))])) : this.m.has(k) ? structuredClone(this.m.get(k)) : undefined; }
  async put(o, v) { for (const [k, x] of Object.entries(typeof o === 'string' ? { [o]: v } : o)) this.m.set(k, structuredClone(x)); }
  async delete(k) { if (Array.isArray(k)) { let n = 0; for (const x of k) if (this.m.delete(x)) n++; return n; } return this.m.delete(k); }
  async list({ prefix = '', limit } = {}) { return new Map([...this.m].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a < b ? -1 : 1).slice(0, limit || Infinity).map(([k, v]) => [k, structuredClone(v)])); }
  async getAlarm() { return this.alarm; }
  async setAlarm(t) {
    clearTimeout(this.timer); this.alarm = Number(t);
    this.timer = setTimeout(async () => { this.alarm = null; try { await this.onAlarm(); } catch (e) { console.error('alarm:', e?.message || e); } }, Math.min(Math.max(0, this.alarm - Date.now()), 2 ** 31 - 1));
    this.timer.unref?.();
  }
  async deleteAlarm() { clearTimeout(this.timer); this.alarm = null; }
}

// A namespace binding: idFromName(name) / get(id).fetch(request), one live instance per name, like the real thing.
export function localNamespace(Class, env) {
  const live = new Map();
  return { idFromName: name => name, get: id => ({ fetch: request => {
    if (!live.has(id)) { const ctx = { storage: new LocalStorage(() => live.get(id)?.alarm?.()), waitUntil: p => { Promise.resolve(p).catch(() => {}); } }; live.set(id, new Class(ctx, env)); }
    return live.get(id).fetch(request);
  } }) };
}
