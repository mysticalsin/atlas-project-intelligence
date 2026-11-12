import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paid } from '../src/meter.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MESSAGE = "This month's AI budget is used up.";

function parseJsonc(text) {
  return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
}

test('(a) the preview build binds SPEND_LEDGER, the v3 migration, and enforce or unset', async () => {
  const { previewLedgerReady } = await import('../src/preview.js');
  assert.equal(typeof previewLedgerReady, 'function');
  const cfg = parseJsonc(readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));
  assert.equal(previewLedgerReady(cfg).ok, true, JSON.stringify(previewLedgerReady(cfg)));
  const dropBinding = structuredClone(cfg);
  dropBinding.previews.durable_objects.bindings = dropBinding.previews.durable_objects.bindings.filter(b => b.name !== 'SPEND_LEDGER');
  assert.equal(previewLedgerReady(dropBinding).ok, false);
  const dropMigration = structuredClone(cfg);
  dropMigration.migrations = dropMigration.migrations.filter(m => m.tag !== 'v3');
  assert.equal(previewLedgerReady(dropMigration).ok, false);
  for (const mode of ['off', 'observe', 'nope']) {
    const bad = structuredClone(cfg);
    bad.previews.vars.LEDGER_MODE = mode;
    assert.equal(previewLedgerReady(bad).ok, false, mode);
  }
  const unset = structuredClone(cfg);
  delete unset.previews.vars.LEDGER_MODE;
  assert.equal(previewLedgerReady(unset).ok, true);
  const dir = mkdtempSync(path.join(tmpdir(), 'preview-guard-'));
  const badFile = path.join(dir, 'wrangler.jsonc');
  writeFileSync(badFile, JSON.stringify(dropBinding));
  const refused = spawnSync(process.execPath, [path.join(root, 'preview-guard.mjs'), badFile], { encoding: 'utf8' });
  assert.equal(refused.status, 1, refused.stderr || refused.stdout);
  const ok = spawnSync(process.execPath, [path.join(root, 'preview-guard.mjs')], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr || ok.stdout);
});

test('(c) a preview with no SPEND_LEDGER refuses every AI call', async () => {
  for (const mode of [undefined, 'enforce', 'off', 'observe']) {
    let runs = 0;
    const env = {
      ATLAS_PREVIEW: '1',
      ...(mode === undefined ? {} : { LEDGER_MODE: mode }),
      AI: { async run() { runs += 1; return { ok: true }; }, async toMarkdown() { runs += 1; return 'x'; } },
    };
    const door = paid(env);
    await assert.rejects(() => door.run(() => ({ kind: 'stt', model: '@cf/deepgram/nova-3', audioMs: 1000 }), 'model', {}), /no_ledger|Spend ledger refused/);
    await assert.rejects(() => door.fetch(() => ({ kind: 'tts', provider: 'elevenlabs', chars: 10 }), async () => { runs += 1; return new Response('x'); }, 'https://provider.example'), /no_ledger|Spend ledger refused/);
    await assert.rejects(() => door.call(() => ({ kind: 'talker', model: 'm', inputTokens: 1, outputTokens: 1 }), async () => { runs += 1; return 'x'; }), /no_ledger|Spend ledger refused/);
    await assert.rejects(() => door.hold(() => ({ kind: 'talker', model: 'm', inputTokens: 1, outputTokens: 1 })), /no_ledger|Spend ledger refused/);
    assert.equal(runs, 0, String(mode));
  }
  assert.equal(MESSAGE.length > 0, true);
});
