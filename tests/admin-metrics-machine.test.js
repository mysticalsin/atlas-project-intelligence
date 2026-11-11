// Admin metrics view: every legal transition, the full cross product of the rest, both sides of each guard,
// and legacy load plus round-trip. No DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_METRICS_EVENTS, ADMIN_METRICS_STATES, adminMetricsTransition, hasSeries, initialAdminMetrics, isAdminRole, loadAdminMetrics } from '../src/admin-metrics-machine.js';

const quiet = { log: () => {} };
const at = status => ({ version: 1, status });
const SHELL = ['loading', 'ready', 'empty', 'error'];

function expectLegal(status, type) {
  if (type === 'boot') return status === 'boot_loading';
  return SHELL.includes(status) && ['refresh', 'loaded', 'load_failed', 'export', 'export_failed'].includes(type);
}

test('every legal admin transition, and every other pair is rejected and logged', () => {
  const logged = [];
  let legal = 0, illegal = 0;
  for (const status of ADMIN_METRICS_STATES) {
    for (const type of ADMIN_METRICS_EVENTS) {
      const event = type === 'boot' ? { type, role: 'admin' } : type === 'loaded' ? { type, count: 2 } : { type };
      const result = adminMetricsTransition(at(status), event, { log: line => logged.push(line) });
      if (expectLegal(status, type)) {
        legal++;
        assert.equal(result.ok, true, status + ' ' + type);
        assert.equal(result.illegal, false);
      } else {
        illegal++;
        assert.equal(result.ok, false, status + ' ' + type);
        assert.equal(result.illegal, true);
        assert.equal(result.state.status, status);
        assert.deepEqual(result.effects, []);
      }
    }
  }
  assert.equal(legal + illegal, ADMIN_METRICS_STATES.length * ADMIN_METRICS_EVENTS.length);
  assert.equal(logged.length, illegal);
  assert.ok(illegal > 0);
  assert.ok(logged.every(l => l.atlas_metric === 'admin_metrics' && l.illegal === true && l.event));
});

test('guards: isAdminRole and hasSeries, allow and deny', () => {
  assert.equal(isAdminRole('admin'), true);
  assert.equal(isAdminRole('reviewer'), false);
  assert.equal(isAdminRole(undefined), false);
  const allow = adminMetricsTransition(initialAdminMetrics(), { type: 'boot', role: 'admin' }, quiet);
  assert.equal(allow.state.status, 'loading');
  assert.deepEqual(allow.effects, ['mount_shell', 'fetch_metrics']);
  const deny = adminMetricsTransition(initialAdminMetrics(), { type: 'boot', role: 'consultant' }, quiet);
  assert.equal(deny.state.status, 'denied');
  assert.deepEqual(deny.effects, ['show_denied']);
  const failedBoot = adminMetricsTransition(initialAdminMetrics(), { type: 'boot', role: undefined }, quiet);
  assert.equal(failedBoot.state.status, 'denied', 'a failed bootInfo leaves no role, which is not an admin');

  assert.equal(hasSeries(3), true);
  assert.equal(hasSeries(0), false);
  const ready = adminMetricsTransition(at('loading'), { type: 'loaded', count: 3 }, quiet);
  assert.equal(ready.state.status, 'ready');
  assert.deepEqual(ready.effects, ['show_metrics']);
  const empty = adminMetricsTransition(at('loading'), { type: 'loaded', count: 0 }, quiet);
  assert.equal(empty.state.status, 'empty');
  assert.deepEqual(empty.effects, ['show_empty']);
});

test('refresh, failure, and export stay on the shell and do not run from boot or denied', () => {
  for (const status of SHELL) {
    assert.equal(adminMetricsTransition(at(status), { type: 'refresh' }, quiet).state.status, 'loading');
    assert.equal(adminMetricsTransition(at(status), { type: 'load_failed' }, quiet).state.status, 'error');
    const exp = adminMetricsTransition(at(status), { type: 'export' }, quiet);
    assert.equal(exp.state.status, status);
    assert.deepEqual(exp.effects, ['download']);
    const failed = adminMetricsTransition(at(status), { type: 'export_failed' }, quiet);
    assert.equal(failed.state.status, status);
    assert.deepEqual(failed.effects, ['append_warning']);
  }
  assert.equal(adminMetricsTransition(at('denied'), { type: 'export' }, quiet).illegal, true);
  assert.equal(adminMetricsTransition(at('boot_loading'), { type: 'refresh' }, quiet).illegal, true);
});

test('legacy and unknown views load as boot_loading; a known view round-trips', () => {
  assert.deepEqual(loadAdminMetrics(undefined), initialAdminMetrics());
  assert.deepEqual(loadAdminMetrics({ status: 'Loading admin metrics…' }), initialAdminMetrics());
  assert.deepEqual(loadAdminMetrics({ version: 1, status: 'nope' }), initialAdminMetrics());
  for (const status of ADMIN_METRICS_STATES) assert.deepEqual(loadAdminMetrics(at(status)), at(status));
});
