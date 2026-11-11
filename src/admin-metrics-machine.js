// Admin metrics view. Pure transitions. renderAdmin in journey-ui.js is the only writer and the only thing that
// touches the DOM. The view is not stored, so there is no snapshot codec.
export const ADMIN_METRICS_VERSION = 1;
export const ADMIN_METRICS_STATES = Object.freeze(['boot_loading', 'boot_error', 'denied', 'loading', 'ready', 'empty', 'error']);
export const ADMIN_METRICS_EVENTS = Object.freeze(['boot', 'refresh', 'loaded', 'load_failed', 'export', 'export_failed']);

const SHELL = new Set(['loading', 'ready', 'empty', 'error']);

export function initialAdminMetrics() {
  return { version: ADMIN_METRICS_VERSION, status: 'boot_loading' };
}

export function isAdminRole(role) {
  return role === 'admin';
}

// A thrown bootInfo is not the same event as a resolved boot with no admin role.
export function bootFailed(event) {
  return event?.failed === true;
}

export function hasSeries(count) {
  return Number(count) > 0;
}

function legal(status, type) {
  if (type === 'boot') return status === 'boot_loading';
  if (type === 'refresh' || type === 'loaded' || type === 'load_failed' || type === 'export' || type === 'export_failed') return SHELL.has(status);
  return false;
}

function ok(status, effects) {
  return { ok: true, illegal: false, state: { version: ADMIN_METRICS_VERSION, status }, effects };
}

export function adminMetricsTransition(state, event) {
  const type = event?.type;
  if (!ADMIN_METRICS_STATES.includes(state?.status) || !legal(state.status, type)) {
    // Previous state, plus a marker. status and event only. No role, address, or response body.
    return {
      ok: false, illegal: true, state, effects: [],
      rejection: { atlas_metric: 'admin_metrics', illegal: true, status: state?.status || 'unknown', event: type || 'unknown' },
    };
  }
  if (type === 'boot') {
    if (bootFailed(event)) return ok('boot_error', ['show_boot_error']);
    if (!isAdminRole(event.role)) return ok('denied', ['show_denied']);
    return ok('loading', ['mount_shell', 'fetch_metrics']);
  }
  if (type === 'refresh') return ok('loading', ['show_loading', 'fetch_metrics']);
  if (type === 'loaded') return ok(hasSeries(event.count) ? 'ready' : 'empty', [hasSeries(event.count) ? 'show_metrics' : 'show_empty']);
  if (type === 'load_failed') return ok('error', ['show_error']);
  if (type === 'export') return { ok: true, illegal: false, state, effects: ['download'] };
  return { ok: true, illegal: false, state, effects: ['append_warning'] };
}

