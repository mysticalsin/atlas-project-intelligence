import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { handle } from '../src/app.js';
import { callCeilingNano, PROXY_PER_CALL_NANO } from '../src/meter.js';
import { previewMigrationUpload } from '../src/preview.js';
import { dnaConfig, pushConfig } from '../src/profile.js';

const PRODUCTION_ORIGIN = 'https://atlas.tony-walteur.workers.dev';
const PRODUCTION_AUD = 'fc05e3d966db92b03ed3bf38b31e5c5254e1508bb0e090825a56ce12a933f386';
const PRODUCTION_TEAM = 'tony-walteur.cloudflareaccess.com';
const PREVIEW_AUD = 'preview-aud-distinct';
const SUFFIX = '-atlas.tony-walteur.workers.dev';
const PREVIEW_HOST = 'https://gate8-atlas.tony-walteur.workers.dev';

function parseJsonc(text) {
  return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
}

test('the preview block cannot reach production bindings, real data, or an unset ledger', () => {
  const cfg = parseJsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const preview = cfg.previews;
  assert.ok(preview && preview.vars, 'previews block');
  assert.equal(preview.vars.ATLAS_PREVIEW, '1');
  assert.equal(preview.vars.LEDGER_MODE, 'enforce');
  assert.equal(preview.vars.ATLAS_PREVIEW_HOST_SUFFIX, SUFFIX);
  assert.equal(preview.vars.DATA_MODE, undefined);
  assert.equal(preview.vars.ORIGIN, undefined);
  assert.equal(preview.vars.ACCESS_AUD, undefined);
  assert.equal(preview.vars.ACCESS_TEAM_DOMAIN, undefined);
  assert.equal(preview.vars.PRODUCTION_MONTHLY_LIMIT_USD, undefined);
  assert.equal(preview.triggers, undefined);
  assert.equal(preview.ai && preview.ai.binding, 'AI');
  assert.deepEqual(preview.durable_objects.bindings.map(b => [b.name, b.class_name, b.script_name]), [
    ['INTERVIEW', 'Interview', undefined],
    ['LIBRARY', 'LibraryStore', undefined],
    ['SPEND_LEDGER', 'ProductionSpendLedger', undefined],
  ]);
  const blob = JSON.stringify(preview);
  assert.equal(blob.includes(PRODUCTION_ORIGIN), false);
  assert.equal(blob.includes(PRODUCTION_AUD), false);
  assert.equal(blob.includes(PRODUCTION_TEAM), false);
  assert.equal(blob.includes('script_name'), false);
  for (const name of ['HINDSIGHT', 'TYPESAFE', 'ELEVENLABS', 'CSRF_SECRET', 'DIRECTORY_PUSH_SECRET', 'TRIGGER_SECRET', 'ATLAS_LEDGER_TOKEN']) {
    assert.equal(blob.includes(name), false, name);
  }
  assert.equal(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(blob), false);
  assert.equal(cfg.vars.LEDGER_MODE, 'enforce');
  assert.equal(cfg.vars.DATA_MODE, undefined);
});

test('a preview env still refuses real DNA', () => {
  const env = { ATLAS_PREVIEW: '1', LEDGER_MODE: 'enforce' };
  assert.equal(pushConfig(env).status, 'BLOCKED_EXTERNAL');
  assert.equal(dnaConfig(env).status, 'BLOCKED_EXTERNAL');
  assert.match(pushConfig(env).reason, /DATA_MODE/);
  assert.match(dnaConfig(env).reason, /DATA_MODE/);
});

function previewEnv(extra = {}) {
  return {
    ATLAS_PREVIEW: '1', ATLAS_PREVIEW_HOST_SUFFIX: SUFFIX, LEDGER_MODE: 'enforce', CSRF_SECRET: 'preview-test-secret',
    ACCESS_AUD: 'preview-aud', ACCESS_TEAM_DOMAIN: 'preview-team.cloudflareaccess.com', ...extra,
  };
}

test('a preview page shows the fake-data banner and refuses production settings', async () => {
  const page = '<script>/* SERVER_RUNTIME */</script></body>';
  const open = await handle(new Request(PREVIEW_HOST + '/', { headers: {} }), previewEnv(), page);
  const html = await open.text();
  assert.equal(open.status, 401);
  assert.match(html, /id="atlas-preview-banner"/);
  assert.match(html, /Preview\. Fake data only\./);
  assert.equal(/id="atlas-preview-banner"[^>]*hidden/.test(html), false);

  const copied = await handle(new Request(PREVIEW_HOST + '/'), previewEnv({ ORIGIN: PRODUCTION_ORIGIN }), page);
  assert.equal(copied.status, 503);
  assert.match(await copied.text(), /production origin/);

  const audience = await handle(new Request(PREVIEW_HOST + '/'), previewEnv({ ACCESS_AUD: PRODUCTION_AUD }), page);
  assert.equal(audience.status, 503);
  assert.match(await audience.text(), /production Access audience/);

  const team = await handle(new Request(PREVIEW_HOST + '/'), previewEnv({ ACCESS_TEAM_DOMAIN: PRODUCTION_TEAM }), page);
  assert.equal(team.status, 401);
  assert.match(await team.text(), /Sign in to use ATLAS/);

  const real = await handle(new Request(PREVIEW_HOST + '/'), previewEnv({ DATA_MODE: 'production' }), page);
  assert.equal(real.status, 503);
  assert.match(await real.text(), /production data/);

  for (const mode of ['off', 'observe']) {
    const refused = await handle(new Request(PREVIEW_HOST + '/'), previewEnv({ LEDGER_MODE: mode }), page);
    assert.equal(refused.status, 503, String(mode));
    assert.match(await refused.text(), /ledger mode must be enforce/);
  }
  for (const mode of [undefined, '']) {
    const openMode = await handle(new Request(PREVIEW_HOST + '/'), previewEnv({ LEDGER_MODE: mode }), page);
    assert.equal(openMode.status, 401, String(mode));
  }

  const productionHost = await handle(new Request(PRODUCTION_ORIGIN + '/'), previewEnv(), page);
  assert.equal(productionHost.status, 403);
});

test('one hands-on session reserves $0.1223158 through callCeilingNano', () => {
  const vars = parseJsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')).previews.vars;
  assert.equal(PROXY_PER_CALL_NANO, 6_000_300);
  const speech = callCeilingNano({ kind: 'stt', model: vars.STT_MODEL, audioMs: 30_000 });
  const talker = callCeilingNano({ kind: 'talker', model: vars.TALKER_MODEL, inputTokens: 2000, outputTokens: 300 });
  const spoken = callCeilingNano({ kind: 'tts', model: vars.TTS_MODEL, chars: 400 });
  const analyst = callCeilingNano({ kind: 'analyst', model: vars.ANALYST_MODEL, inputTokens: 8000, outputTokens: 3000 });
  assert.equal(speech, 8_600_300);
  assert.equal(talker, 7_262_200);
  assert.equal(spoken, 18_000_300);
  assert.equal(analyst, 11_050_300);
  assert.equal(speech * 10 + talker + spoken + analyst, 122_315_800);
});

test('a preview on the production team verifies its own audience and still refuses the production audience', async () => {
  const page = '<script>/* SERVER_RUNTIME */</script></body>';
  const b64u = bytes => Buffer.from(bytes).toString('base64url');
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'gate8-access' };
  const previousFetch = globalThis.fetch;
  const certUrls = [];
  globalThis.fetch = async url => {
    certUrls.push(String(url));
    assert.equal(String(url), `https://${PRODUCTION_TEAM}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys: [jwk] }));
  };
  async function token(aud, iss = `https://${PRODUCTION_TEAM}`) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', kid: 'gate8-access' };
    const body = { aud: [aud], iss, sub: 'preview-user', email: 'preview@example.com', exp: now + 600, iat: now };
    const input = b64u(JSON.stringify(header)) + '.' + b64u(JSON.stringify(body));
    return input + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input)));
  }
  const ask = async (audEnv, teamEnv, jwtAud, iss) => {
    const headers = {};
    if (jwtAud) headers['cf-access-jwt-assertion'] = await token(jwtAud, iss);
    return handle(new Request(PREVIEW_HOST + '/', { headers }), previewEnv({ ACCESS_AUD: audEnv, ACCESS_TEAM_DOMAIN: teamEnv }), page);
  };
  const failed = [];
  const check = async (label, fn) => {
    try { await fn(); }
    catch (error) { failed.push(label + ': ' + error.message); }
  };
  try {
    await check('1 same team and a distinct preview aud verifies that aud', async () => {
      const res = await ask(PREVIEW_AUD, PRODUCTION_TEAM, PREVIEW_AUD);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /window\.ATLAS_RUNTIME=/);
      assert.match(html, /preview@example\.com/);
      assert.equal(certUrls.at(-1), `https://${PRODUCTION_TEAM}/cdn-cgi/access/certs`);
    });
    await check('2 the production aud still returns 503', async () => {
      const res = await ask(PRODUCTION_AUD, PRODUCTION_TEAM);
      assert.equal(res.status, 503);
      assert.match(await res.text(), /production Access audience/);
    });
    await check('3 a production-aud jwt presented to the preview aud is rejected', async () => {
      const res = await ask(PREVIEW_AUD, PRODUCTION_TEAM, PRODUCTION_AUD);
      assert.equal(res.status, 401);
      const html = await res.text();
      assert.match(html, /Sign in to use ATLAS/);
      assert.equal(html.includes('window.ATLAS_RUNTIME='), false);
    });
    await check('issuer stays the configured team domain', async () => {
      const res = await ask(PREVIEW_AUD, PRODUCTION_TEAM, PREVIEW_AUD, 'https://other.cloudflareaccess.com');
      assert.equal(res.status, 401);
      assert.equal((await res.text()).includes('window.ATLAS_RUNTIME='), false);
    });
    await check('4 a missing aud or team still returns 403', async () => {
      for (const extra of [
        { ACCESS_AUD: '', ACCESS_TEAM_DOMAIN: PRODUCTION_TEAM },
        { ACCESS_AUD: undefined, ACCESS_TEAM_DOMAIN: PRODUCTION_TEAM },
        { ACCESS_AUD: PREVIEW_AUD, ACCESS_TEAM_DOMAIN: '' },
        { ACCESS_AUD: PREVIEW_AUD, ACCESS_TEAM_DOMAIN: undefined },
      ]) {
        const res = await handle(new Request(PREVIEW_HOST + '/'), previewEnv(extra), page);
        assert.equal(res.status, 403, JSON.stringify(extra));
        assert.equal(await res.text(), 'Preview Access is not configured.');
      }
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.deepEqual(failed, []);
});

test('a production audience wrapped in whitespace is refused before any cert fetch', async () => {
  const page = '<script>/* SERVER_RUNTIME */</script></body>';
  const b64u = bytes => Buffer.from(bytes).toString('base64url');
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'gate8-pad' };
  const previousFetch = globalThis.fetch;
  const certUrls = [];
  globalThis.fetch = async url => { certUrls.push(String(url)); return new Response(JSON.stringify({ keys: [jwk] })); };
  const token = async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', kid: 'gate8-pad' };
    const body = { aud: [PRODUCTION_AUD], iss: `https://${PRODUCTION_TEAM}`, sub: 'preview-user', email: 'preview@example.com', exp: now + 600, iat: now };
    const input = b64u(JSON.stringify(header)) + '.' + b64u(JSON.stringify(body));
    return input + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input)));
  };
  const wraps = [
    ['leading space', aud => ` ${aud}`],
    ['trailing space', aud => `${aud} `],
    ['trailing newline', aud => `${aud}\n`],
    ['leading tab', aud => `\t${aud}`],
    ['trailing crlf', aud => `${aud}\r\n`],
    ['nbsp', aud => `\u00a0${aud}\u00a0`],
    ['bom', aud => `\ufeff${aud}`],
    ['em and ideographic space', aud => `\u2003${aud}\u3000`],
    ['form feed and vertical tab', aud => `\f${aud}\v`],
  ];
  const failed = [];
  try {
    const jwt = await token();
    for (const [label, wrap] of wraps) {
      certUrls.length = 0;
      const res = await handle(new Request(PREVIEW_HOST + '/', { headers: { 'cf-access-jwt-assertion': jwt } }), previewEnv({ ACCESS_AUD: wrap(PRODUCTION_AUD), ACCESS_TEAM_DOMAIN: PRODUCTION_TEAM }), page);
      const html = await res.text();
      const problems = [];
      if (res.status !== 503) problems.push('status ' + res.status);
      if (!/production Access audience/.test(html)) problems.push('body');
      if (html.includes('window.ATLAS_RUNTIME=')) problems.push('runtime');
      if (certUrls.length !== 0) problems.push('certs ' + certUrls.length);
      if (problems.length) failed.push(label + ': ' + problems.join(', '));
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.deepEqual(failed, []);
});

test('a padded preview audience still verifies through the same trim', async () => {
  const page = '<script>/* SERVER_RUNTIME */</script></body>';
  const b64u = bytes => Buffer.from(bytes).toString('base64url');
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'gate8-preview-pad' };
  const previousFetch = globalThis.fetch;
  const certUrls = [];
  globalThis.fetch = async url => { certUrls.push(String(url)); return new Response(JSON.stringify({ keys: [jwk] })); };
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: 'gate8-preview-pad' };
  const body = { aud: [PREVIEW_AUD], iss: `https://${PRODUCTION_TEAM}`, sub: 'preview-user', email: 'preview@example.com', exp: now + 600, iat: now };
  const input = b64u(JSON.stringify(header)) + '.' + b64u(JSON.stringify(body));
  const jwt = input + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input)));
  try {
    const res = await handle(new Request(PREVIEW_HOST + '/', { headers: { 'cf-access-jwt-assertion': jwt } }), previewEnv({ ACCESS_AUD: ` ${PREVIEW_AUD}\n`, ACCESS_TEAM_DOMAIN: PRODUCTION_TEAM }), page);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /window\.ATLAS_RUNTIME=/);
    assert.match(html, /preview@example\.com/);
    assert.equal(certUrls.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('a preview with no Access audience or team returns 403 and does not spend', async () => {
  const vars = parseJsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')).previews.vars;
  assert.equal(vars.ACCESS_AUD, undefined);
  assert.equal(vars.ACCESS_TEAM_DOMAIN, undefined);
  let reserves = 0;
  const env = {
    ...vars, CSRF_SECRET: 'preview-test-secret', ATLAS_LEDGER_TOKEN: 'tok',
    SPEND_LEDGER: { idFromName() { return 'id'; }, get() { return { async reserve() { reserves += 1; return { ok: true, id: 'P1' }; } }; } },
  };
  const page = '<script>/* SERVER_RUNTIME */</script></body>';
  const home = await handle(new Request(PREVIEW_HOST + '/'), env, page);
  assert.equal(home.status, 403);
  assert.match(await home.text(), /Preview Access is not configured/);
  const spent = await handle(new Request(PREVIEW_HOST + '/api/ledger/reserve', {
    method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: '{}',
  }), env, page);
  assert.equal(spent.status, 403);
  assert.match(await spent.text(), /Preview Access is not configured/);
  assert.equal(reserves, 0);
});

test('the preview upload payload carries the top-level v3 migration', () => {
  const cfg = parseJsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(cfg.previews.migrations, undefined);
  const first = previewMigrationUpload(cfg.migrations);
  assert.equal(first.new_tag, 'v3');
  assert.equal(first.old_tag, undefined);
  assert.deepEqual(first.steps.map(step => step.new_sqlite_classes), [
    ['Interview'], ['LibraryStore'], ['ProductionSpendLedger'],
  ]);
  const rest = previewMigrationUpload(cfg.migrations, 'v2');
  assert.equal(rest.old_tag, 'v2');
  assert.equal(rest.new_tag, 'v3');
  assert.deepEqual(rest.steps, [{ new_sqlite_classes: ['ProductionSpendLedger'] }]);
  assert.equal(previewMigrationUpload(cfg.migrations, 'v3'), undefined);
  const installed = ['/tmp/atlas-wrangler/node_modules/wrangler/wrangler-dist/cli.js'].find(existsSync);
  if (!installed) return;
  const src = readFileSync(installed, 'utf8');
  const start = src.indexOf('function getPreviewMigrationsToUpload');
  const end = src.indexOf('function buildResultToDeploymentModules');
  assert.ok(start > 0 && end > start);
  const script = new vm.Script(src.slice(start, end) + '\ngetPreviewMigrationsToUpload(workerName, config, current)');
  const run = current => {
    const sandbox = { workerName: 'atlas', current, config: { migrations: cfg.migrations, configPath: 'wrangler.jsonc', userConfigPath: 'wrangler.jsonc' }, logger: { warn() {} }, configFileName: () => 'wrangler.jsonc' };
    vm.createContext(sandbox);
    return script.runInContext(sandbox);
  };
  const plain = value => JSON.parse(JSON.stringify(value ?? null));
  assert.deepEqual(plain(run(undefined)), first);
  assert.deepEqual(plain(run('v2')), rest);
  assert.equal(run('v3'), undefined);
});
