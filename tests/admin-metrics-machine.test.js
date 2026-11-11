// Admin metrics view: every legal transition, the full cross product of the rest, both sides of each guard,
// and legacy load plus round-trip. No DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_METRICS_EVENTS, ADMIN_METRICS_STATES, adminMetricsTransition, bootFailed, hasSeries, initialAdminMetrics, isAdminRole, loadAdminMetrics } from '../src/admin-metrics-machine.js';

const quiet = { log: () => {} };
const at = status => ({ version: 1, status });
const SHELL = ['loading', 'ready', 'empty', 'error'];

function expectLegal(status, type) {
  if (type === 'boot') return status === 'boot_loading';
  return SHELL.includes(status) && ['refresh', 'loaded', 'load_failed', 'export', 'export_failed'].includes(type);
}

test('every legal admin transition, and every other pair is rejected and logged', () => {
  const logged = [];
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => warns.push(args);
  let legal = 0, illegal = 0;
  try {
  for (const status of ADMIN_METRICS_STATES) {
    for (const type of ADMIN_METRICS_EVENTS) {
      const event = type === 'boot' ? { type, role: 'admin' } : type === 'loaded' ? { type, count: 2 } : { type };
      const result = adminMetricsTransition(at(status), event);
      if (expectLegal(status, type)) {
        legal++;
        assert.equal(result.ok, true, status + ' ' + type);
        assert.equal(result.illegal, false);
        assert.equal(result.rejection, undefined);
      } else {
        illegal++;
        assert.equal(result.ok, false, status + ' ' + type);
        assert.equal(result.illegal, true);
        assert.equal(result.state.status, status);
        assert.deepEqual(result.effects, []);
        logged.push(result.rejection);
      }
    }
  }
  } finally { console.warn = original; }
  assert.equal(warns.length, 0, 'the transition does not log');
  assert.equal(legal + illegal, ADMIN_METRICS_STATES.length * ADMIN_METRICS_EVENTS.length);
  assert.equal(logged.length, illegal);
  assert.ok(illegal > 0);
  assert.ok(logged.every(l => l.atlas_metric === 'admin_metrics' && l.illegal === true && l.event && Object.keys(l).every(k => ['atlas_metric', 'illegal', 'status', 'event'].includes(k))));
});

test('guards: isAdminRole, bootFailed and hasSeries, allow and deny', () => {
  assert.equal(isAdminRole('admin'), true);
  assert.equal(isAdminRole('reviewer'), false);
  assert.equal(isAdminRole(undefined), false);
  const allow = adminMetricsTransition(initialAdminMetrics(), { type: 'boot', role: 'admin' }, quiet);
  assert.equal(allow.state.status, 'loading');
  assert.deepEqual(allow.effects, ['mount_shell', 'fetch_metrics']);
  const deny = adminMetricsTransition(initialAdminMetrics(), { type: 'boot', role: 'consultant' }, quiet);
  assert.equal(deny.state.status, 'denied');
  assert.deepEqual(deny.effects, ['show_denied']);
  const noRole = adminMetricsTransition(initialAdminMetrics(), { type: 'boot', role: undefined }, quiet);
  assert.equal(noRole.state.status, 'denied', 'a resolved boot with no role is not an admin');

  assert.equal(bootFailed({ failed: true }), true);
  assert.equal(bootFailed({ failed: false }), false);
  assert.equal(bootFailed({}), false);
  const outage = adminMetricsTransition(initialAdminMetrics(), { type: 'boot', failed: true, role: 'admin' }, quiet);
  assert.equal(outage.state.status, 'boot_error');
  assert.deepEqual(outage.effects, ['show_boot_error']);
  const notOutage = adminMetricsTransition(initialAdminMetrics(), { type: 'boot', failed: false, role: 'admin' }, quiet);
  assert.equal(notOutage.state.status, 'loading');

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

test('boot_error is legal only from a failed boot, and every shell event there is illegal', () => {
  const logged = [];
  assert.equal(adminMetricsTransition(at('boot_loading'), { type: 'boot', failed: true }, quiet).state.status, 'boot_error');
  for (const type of ADMIN_METRICS_EVENTS) {
    const result = adminMetricsTransition(at('boot_error'), type === 'loaded' ? { type, count: 1 } : { type });
    assert.equal(result.illegal, true, type);
    assert.equal(result.state.status, 'boot_error');
    assert.deepEqual(result.effects, []);
    logged.push(result.rejection);
  }
  assert.equal(logged.length, ADMIN_METRICS_EVENTS.length);
  assert.ok(logged.every(l => Object.keys(l).every(k => ['atlas_metric', 'illegal', 'status', 'event'].includes(k))));
});

test('legacy and unknown views load as boot_loading; a known view round-trips', () => {
  assert.deepEqual(loadAdminMetrics(undefined), initialAdminMetrics());
  assert.deepEqual(loadAdminMetrics({ status: 'Loading admin metrics…' }), initialAdminMetrics());
  assert.deepEqual(loadAdminMetrics({ version: 1, status: 'nope' }), initialAdminMetrics());
  for (const status of ADMIN_METRICS_STATES) assert.deepEqual(loadAdminMetrics(at(status)), at(status));
});
