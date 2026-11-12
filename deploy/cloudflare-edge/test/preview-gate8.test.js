import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handle } from '../src/app.js';
import { dnaConfig, pushConfig } from '../src/profile.js';

const PRODUCTION_ORIGIN = 'https://atlas.tony-walteur.workers.dev';
const PRODUCTION_AUD = 'fc05e3d966db92b03ed3bf38b31e5c5254e1508bb0e090825a56ce12a933f386';
const PRODUCTION_TEAM = 'tony-walteur.cloudflareaccess.com';
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
    ACCESS_AUD: 'preview-aud', ACCESS_TEAM_DOMAIN: 'preview.example.access', ...extra,
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
  assert.equal(team.status, 503);
  assert.match(await team.text(), /production Access team/);

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
