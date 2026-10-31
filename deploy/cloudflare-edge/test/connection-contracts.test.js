// Data-driven contract test (v2.2 C1). For each connection, once the owner's sample payloads exist under
// atlas_voice/config/contracts/<id>/samples/ (request.sample.json: the Atlas-side payload; response.sample.json: the destination's raw success response,
// or for an inbound connection its raw read response), this checks them against the schemas, the never-send list, the field_mapping and the ack_rule.
// A connection cannot be at contract_verified or above without its samples. No samples ship in the repository: the owners have supplied none.
// Samples must be synthetic or anonymised, never real consultant or client data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CONNECTIONS_CONFIG } from '../src/policy.generated.js';
import { STATUS_ORDER, mapOutbound, findForbidden, parseAck, allowlist, getPath } from '../src/connectors.js';
import { validate } from '../src/schema-lite.js';

const CONFIG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../atlas_voice/config');
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const samplesOf = id => { const d = resolve(CONFIG_DIR, 'contracts', id, 'samples'), f = n => existsSync(resolve(d, n)) ? readJson(resolve(d, n)) : null; return { request: f('request.sample.json'), response: f('response.sample.json') }; };

// -> list of problems (empty when the samples satisfy the contract). Pure: tests below feed it synthetic samples.
export function checkContract(conn, samples, config = CONNECTIONS_CONFIG, schemaOf = ref => readJson(resolve(CONFIG_DIR, ref))) {
  const out = [], never = [...config.data_minimisation.never_send_keys, ...(conn.never_send_extra || [])];
  if (conn.direction === 'outbound') {
    if (!samples.request) out.push('request.sample.json missing');
    else {
      const r = validate(schemaOf(conn.request_schema), samples.request);
      out.push(...r.errors.map(e => `request ${e.path} ${e.code}`));
      const bad = findForbidden(samples.request, never); if (bad) out.push(`request holds never-send key ${bad}`);
      try { const body = mapOutbound(conn, samples.request); if (!Object.keys(body).length) out.push('field_mapping produces an empty body'); const b2 = findForbidden(body, never); if (b2) out.push(`mapped body holds never-send key ${b2}`); } catch (e) { out.push(`mapping error ${e.message}`); }
    }
    if (!samples.response) out.push('response.sample.json missing');
    else {
      const a = parseAck(conn, samples.response, { source_revision: samples.request?.source_revision ?? 1, payload_hash: null }, samples.request || {});
      if (!a.ack) out.push(`ack_rule fails: ${a.result.error}`);
      else if (conn.response_schema) {
        const norm = Object.fromEntries(Object.entries(a.ack).filter(([k]) => ['destination_record_id', 'destination_version', 'destination_revision', 'revision', 'hash', 'publication_state', 'canonical_url', 'published_at', 'revision_hash'].includes(k)));
        out.push(...validate(schemaOf(conn.response_schema), norm).errors.map(e => `ack ${e.path} ${e.code}`));
      }
    }
  } else if (conn.managed_by === 'http_connector') {
    if (!samples.response) out.push('response.sample.json missing');
    else {
      for (const p of conn.ack_rule?.required_paths || []) if (getPath(samples.response, p) === undefined) out.push(`required path ${p} absent`);
      const values = {}; for (const [f, p] of Object.entries(conn.field_mapping)) { const v = getPath(samples.response, p); if (v !== undefined) values[f] = v; }
      const a = allowlist(conn, values, config);
      if (!Object.keys(a.model_fields).length && !Object.keys(a.display_fields).length) out.push('no allowlisted field came out of the sample');
      if (conn.response_schema) out.push(...validate(schemaOf(conn.response_schema), { ...a.model_fields, ...a.display_fields }).errors.map(e => `fields ${e.path} ${e.code}`));
    }
  }
  return out;
}

test('every connection at contract_verified or above has samples that satisfy its contract; any samples present are checked whatever the status', () => {
  for (const c of CONNECTIONS_CONFIG.connections.filter(x => x.managed_by === 'http_connector')) {
    const s = samplesOf(c.id), has = s.request || s.response, needs = STATUS_ORDER.indexOf(c.status) >= STATUS_ORDER.indexOf('contract_verified');
    if (needs || has) assert.deepEqual(checkContract(c, s), [], `${c.id} contract`);
  }
});

test('the contract check catches a bad sample: wrong shape, a never-send key, an empty mapping, an ack rule that does not match', () => {
  const dna = JSON.parse(JSON.stringify(CONNECTIONS_CONFIG.connections.find(c => c.id === 'dna_skills')));
  Object.assign(dna, { field_mapping: { entity_id: 'ref', 'assertions[].statement': 'skills[].text' }, ack_rule: { ...dna.ack_rule, record_id_path: 'data.id', version_path: 'data.version' } });
  const request = { entity_id: 'e', source_revision: 1, content_hash: 'h', consultant_id: 'p', assertions: [] }, response = { data: { id: 'r1', version: 2 } };
  assert.deepEqual(checkContract(dna, { request, response }), []);
  assert.ok(checkContract(dna, { request: { ...request, source_revision: 'one' }, response }).some(p => p.startsWith('request #/source_revision TYPE')));
  assert.ok(checkContract(dna, { request: { ...request, transcript: 'x' }, response }).some(p => /never-send key transcript/.test(p)));
  assert.ok(checkContract({ ...dna, field_mapping: { nothing: 'x' } }, { request, response }).includes('field_mapping produces an empty body'));
  assert.ok(checkContract(dna, { request, response: { data: { id: 'r1' } } }).includes('ack_rule fails: ACK_RULE_UNSATISFIED'));
  assert.deepEqual(checkContract(dna, { request: null, response: null }), ['request.sample.json missing', 'response.sample.json missing']);
  const inbound = JSON.parse(JSON.stringify(CONNECTIONS_CONFIG.connections.find(c => c.id === 'prefill_profile')));
  Object.assign(inbound, { field_mapping: { role: 'p.job', name: 'p.n' } });
  assert.deepEqual(checkContract(inbound, { response: { p: { job: 'Engineer', n: 'Real Name' } } }), []);
  assert.ok(checkContract({ ...inbound, field_mapping: { name: 'p.n' } }, { response: { p: { n: 'Real Name' } } }).includes('no allowlisted field came out of the sample'));
});
