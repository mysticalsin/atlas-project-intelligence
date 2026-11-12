// Ledger coverage, static (docs/LEDGER_MODES.md): no file but the wrapper (src/meter.js) calls env.AI.run, the AI
// binding or a paid provider endpoint. Imports nothing from src, so it runs unchanged against any revision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, ROOT), 'utf8');
const sources = () => {
  const src = readdirSync(new URL('src/', ROOT)).filter(f => f.endsWith('.js')).map(f => 'src/' + f);
  let live = [];
  try { live = readdirSync(new URL('live-test/', ROOT)).filter(f => /\.(m?js)$/.test(f)).map(f => 'live-test/' + f); } catch { /* the live-test ledger is not on this branch */ }
  return [...src, ...live];
};
// Line comments are removed so prose about env.AI does not count; '//' inside a URL (https://) is kept.
const code = p => read(p).split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

// The only files allowed to touch a paid upstream: the wrapper, and the live-test REST stand-in for the AI binding
// (restBinding, reachable only through meteredRestAI and then through workersAI, i.e. through paid() as well).
const WRAPPER = 'src/meter.js';
const PAID_HOSTS = /api\.typesafe\.ai|api\.elevenlabs\.io|api\.cloudflare\.com|\/ai\/run\/|gateway\.ai\.cloudflare\.com|api\.openai\.com|api\.anthropic\.com/;
// Direct fetch calls that reach no paid provider, by file and count. A new direct fetch anywhere fails this test.
const UNPAID_FETCHES = {
  'src/app.js': 1,          // Cloudflare Access signing keys (cdn-cgi/access/certs)
  'src/profile.js': 1,      // Mantu DNA directory (production data mode only)
  'src/teams.js': 6,        // Microsoft identity / Bot Framework (default arguments and calls)
  'src/teams-routes.js': 1, // default fetcher argument
  'src/worker.js': 2,       // the Durable Objects' own fetch handlers
  'src/confirm-page.js': 3, // same-origin browser requests in the served page
  'live-test/entry.js': 1,  // the test Worker's own fetch handler
  'live-test/run.mjs': 2,   // the local harness calling wrangler dev on 127.0.0.1
};

test('static: no file but the wrapper calls env.AI.run, the AI binding or a paid provider endpoint', () => {
  const offenders = [];
  for (const p of sources()) {
    if (p === WRAPPER) continue;
    const c = code(p);
    if (/\.AI\b/.test(c) || /\[\s*['"]AI['"]\s*\]/.test(c) || /\{[^}]*\bAI\b[^}]*\}\s*=\s*(this\.)?env\b/.test(c)) offenders.push(p + ': reads the AI binding');
    if (PAID_HOSTS.test(c)) offenders.push(p + ': names a paid endpoint');
    const direct = (c.match(/(^|[^\w.$])(fetch|fetcher|fetchImpl)\s*\(/g) || []).length;
    if (direct !== (UNPAID_FETCHES[p] || 0)) offenders.push(`${p}: ${direct} direct fetch calls, ${UNPAID_FETCHES[p] || 0} allowed (all unpaid)`);
  }
  assert.deepEqual(offenders, []);
  // Each module that owns a paid call site uses the wrapper.
  for (const p of ['src/app.js', 'src/memory.js', 'src/memory-routes.js', 'src/jev.js', 'src/classify.js', 'src/rating.js', 'src/customer-jev.js'])
    assert.match(read(p), /from '\.\/meter\.js'/, p);
  assert.ok((read('src/app.js').match(/paid\(env\)/g) || []).length >= 3, 'app.js: workersAI, ElevenLabs, toMarkdown');
  assert.match(read('src/app.js'), /analystCall\(env/, 'runReasoning reserves once, including the reasoning retry');
});

