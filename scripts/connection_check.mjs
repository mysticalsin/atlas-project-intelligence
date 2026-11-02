#!/usr/bin/env node
// Offline-safe connection readiness and contract checker (v2.2 C1). Reads atlas_voice/config/connections.json and its draft schemas, and prints
// per connection whether it could run. It never prints a secret value: only secret NAMES and present/missing. By default it makes no network call.
//
//   node scripts/connection_check.mjs [--config path] [--vars-file .dev.vars] [--json] [--connection <id>] [--require-ready <id>]
//   node scripts/connection_check.mjs --contract <id> --sample payload.json [--direction request|response]
//   node scripts/connection_check.mjs --contract <id> --ack-sample raw_response.json [--revision N] [--hash H]
//   node scripts/connection_check.mjs --connection <id> --live --confirm-live     MANUAL ONLY: one health call to the real system. Never in CI.
//
// Exit codes: 0 ok, 1 configuration or contract problem, 2 usage or refused, 3 --require-ready connection not ready.
// ATLAS_ADAPTERS and the secrets are read from process.env (and --vars-file, a KEY=VALUE file such as .dev.vars; its values are never printed).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readiness, healthCheck, parseAck, allowlist, getPath, STATUS_ORDER } from '../deploy/cloudflare-edge/src/connectors.js';
import { validate, unsupported } from '../deploy/cloudflare-edge/src/schema-lite.js';
import { effectiveConfig } from '../deploy/cloudflare-edge/src/michat.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = n => args.includes(n);
const val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const out = [], line = s => out.push(s);
const usage = msg => { console.error(msg); process.exit(2); };

const configPath = resolve(val('--config') || resolve(ROOT, 'atlas_voice/config/connections.json'));
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
let config;
try { config = readJson(configPath); } catch (e) { console.error(`Cannot read ${configPath}: ${e.message}`); process.exit(1); }
// MiChat CV (X2, docs/MICHAT.md): with MICHAT_CV_CONTRACT=assumed the assumed contract is overlaid on michat_cv, as the Worker does.
config = effectiveConfig(process.env, config);
const CONFIG_DIR = dirname(configPath);

// env: process.env plus an optional vars file. Values stay in this object; nothing below prints one.
const env = { ...process.env };
if (val('--vars-file')) {
  const f = resolve(val('--vars-file'));
  if (!existsSync(f)) usage(`No such vars file: ${f}`);
  for (const l of readFileSync(f, 'utf8').split('\n')) { const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(l); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
}

// ---- configuration problems (the Python tests are authoritative; these are the ones worth catching before a deploy) ----
const problems = [];
const need = (ok, msg) => { if (!ok) problems.push(msg); };
need(Array.isArray(config.connections) && config.connections.length, 'no connections');
need(JSON.stringify(config.status_order) === JSON.stringify(STATUS_ORDER), 'status_order does not match the ladder');
const ids = (config.connections || []).map(c => c.id);
need(new Set(ids).size === ids.length, 'duplicate connection id');
const schemas = {};
for (const c of config.connections || []) {
  need(STATUS_ORDER.includes(c.status), `${c.id}: unknown status ${c.status}`);
  need(['inbound', 'outbound'].includes(c.direction), `${c.id}: direction`);
  for (const n of c.auth?.secret_names || []) need(/^[A-Z][A-Z0-9_]{2,63}$/.test(n), `${c.id}: secret name ${n} is not an UPPER_SNAKE name (names only, never values)`);
  need(c.base_url_var == null || /^[A-Z][A-Z0-9_]{2,63}$/.test(c.base_url_var), `${c.id}: base_url_var must be an env var name`);
  for (const k of ['request_schema', 'response_schema']) {
    if (!c[k]) continue;
    const f = resolve(CONFIG_DIR, c[k]);
    if (!existsSync(f)) { problems.push(`${c.id}: ${k} ${c[k]} is missing`); continue; }
    try {
      const s = readJson(f); schemas[`${c.id}:${k}`] = s;
      const bad = unsupported(s);
      need(!bad.length, `${c.id}: ${k} uses unsupported keywords at ${bad.join(', ')}`);
      if (c.schema_status === 'draft_from_atlas_side') need(String(s['x-status'] || '').startsWith('draft — from Atlas side'), `${c.id}: ${k} must be marked as a draft`);
    } catch (e) { problems.push(`${c.id}: ${k} is not valid JSON`); }
  }
  const never = new Set([...(config.data_minimisation?.never_send_keys || []), ...(c.never_send_extra || [])].map(x => x.toLowerCase()));
  if (c.direction === 'outbound') for (const src of Object.keys(c.field_mapping || {})) need(!src.replace(/\[\]/g, '').split('.').some(s => never.has(s.toLowerCase())), `${c.id}: field_mapping source ${src} names a never-send key`);
  need(!(c.status !== 'not_configured' && c.managed_by === 'http_connector' && c.wired === false), `${c.id}: an unwired connection cannot leave not_configured`);
  need(!(STATUS_ORDER.indexOf(c.status) >= 2 && c.managed_by === 'http_connector' && c.schema_status !== 'owner_confirmed'), `${c.id}: contract_verified needs owner-confirmed schemas`);
}

// ---- --contract: validate a sample against the draft schema, or apply the ack rule to a raw response sample ----
if (val('--contract')) {
  const c = (config.connections || []).find(x => x.id === val('--contract'));
  if (!c) usage(`Unknown connection ${val('--contract')}`);
  if (val('--sample')) {
    const dir = val('--direction') || 'request', schema = schemas[`${c.id}:${dir}_schema`];
    if (!schema) usage(`${c.id} has no ${dir} schema`);
    let sample;
    try { sample = readJson(resolve(val('--sample'))); } catch { usage('The sample is not valid JSON.'); }
    const r = validate(schema, sample);
    console.log(`${c.id} ${dir} sample: ${r.valid ? 'PASS' : 'FAIL'} (schema ${c.schema_status}${c.schema_status === 'draft_from_atlas_side' ? ': draft, the owner has not confirmed it' : ''})`);
    for (const e of r.errors.slice(0, 50)) console.log(`  ${e.path} ${e.code}`);
    process.exit(r.valid ? 0 : 1);
  }
  if (val('--ack-sample')) {
    let raw;
    try { raw = readJson(resolve(val('--ack-sample'))); } catch { usage('The response sample is not valid JSON.'); }
    if (c.direction === 'outbound') {
      const rev = Number(val('--revision') || 1), env0 = { source_revision: rev, payload_hash: null }, hash = val('--hash') || 'sample-hash';
      const r = parseAck(c, raw, env0, { content_hash: hash, revision_hash: hash });
      if (!r.ack) { console.log(`${c.id} ack rule: FAIL (${r.result.conflict ? 'conflict ' : ''}${r.result.error})`); process.exit(1); }
      const check = schemas[`${c.id}:response_schema`] ? validate(schemas[`${c.id}:response_schema`], Object.fromEntries(Object.entries(r.ack).filter(([k]) => ['destination_record_id', 'destination_version', 'destination_revision', 'revision', 'hash', 'publication_state', 'canonical_url', 'published_at', 'revision_hash'].includes(k)))) : null;
      console.log(`${c.id} ack rule: PASS (record ${r.ack.destination_record_id}, version ${r.ack.destination_version}; mock=${r.ack.mock})`);
      if (check && !check.valid) { console.log('  normalised ack does not satisfy the response schema:'); for (const e of check.errors) console.log(`  ${e.path} ${e.code}`); process.exit(1); }
    } else {
      const values = {};
      for (const [f, p] of Object.entries(c.field_mapping || {})) { const v = getPath(raw, p); if (v !== undefined) values[f] = v; }
      const a = allowlist(c, values, config);
      console.log(`${c.id} inbound mapping: model_fields ${Object.keys(a.model_fields).join(', ') || '(none)'}; display_fields ${Object.keys(a.display_fields).join(', ') || '(none)'}; dropped ${a.dropped.join(', ') || '(none)'}`);
    }
    process.exit(0);
  }
  usage('--contract needs --sample <file> or --ack-sample <file>');
}

// ---- --live: one health call, manual only ----
if (flag('--live')) {
  if (env.CI) usage('Refused: --live never runs in CI.');
  if (!flag('--confirm-live')) usage('Refused: --live calls the real system. Add --confirm-live to confirm you mean it.');
  const id = val('--connection');
  if (!id) usage('--live needs --connection <id>');
  healthCheck(id, { env, config }).then(r => { console.log(`${id} health: ${r.ok ? 'OK' : 'NOT OK'}${r.status ? ` HTTP ${r.status}` : ''}${r.error ? ` ${r.error}` : ''}${r.reasons ? ` blockers: ${r.reasons.join(', ')}` : ''}${r.ms !== undefined ? ` ${r.ms} ms` : ''}`); process.exit(r.ok ? 0 : 1); });
} else {
  // ---- readiness report (no network) ----
  const rows = (config.connections || []).filter(c => !val('--connection') || c.id === val('--connection')).map(c => {
    const r = readiness(c, env), auth = c.auth || {};
    const existing = c.managed_by === 'existing_code';
    return { id: c.id, direction: c.direction, step: c.workflow_step, status: c.status, schema: c.schema_status, ready: r.eligible, existing, blockers: existing ? [] : r.reasons,
      secrets: Object.fromEntries((auth.secret_names || []).map(n => [n, filled(env[n]) || typeof env[n]?.fetch === 'function' ? 'present' : 'missing'])) };
  });
  if (flag('--json')) console.log(JSON.stringify({ config_ok: problems.length === 0, problems, connections: rows }, null, 2));
  else {
    line(`Connections (${configPath})`); line('');
    for (const r of rows) {
      line(`${r.id.padEnd(16)} ${r.direction.padEnd(8)} step ${String(r.step).padEnd(2)} ${r.status.padEnd(20)} ${r.existing ? 'existing code' : r.ready ? 'READY' : 'not ready'}`);
      for (const [n, s] of Object.entries(r.secrets)) line(`    secret ${n}: ${s}`);
      if (!r.ready && !r.existing) line(`    blockers: ${r.blockers.join(', ')}`);
    }
    line('');
    line(problems.length ? `Configuration problems (${problems.length}):` : 'Configuration: no problems found.');
    for (const p of problems) line(`  - ${p}`);
    console.log(out.join('\n'));
  }
  const want = val('--require-ready'), target = (config.connections || []).find(c => c.id === want);
  if (want && !target) usage(`Unknown connection ${want}`);
  process.exit(problems.length ? 1 : target && !readiness(target, env).eligible ? 3 : 0);
}
function filled(v) { return typeof v === 'string' && v.trim() !== ''; }
