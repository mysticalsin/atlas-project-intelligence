// Verified admin and reviewer binding. Privilege comes from the signed token's roles or an
// operator subject list. Email lists, the manager-staff checkbox and typed personas grant nothing.
// An explicit empty ATLAS_ADMIN_ROLES / ATLAS_ADMIN_SUBJECTS pair means nobody is an admin.

export const CANONICAL_ADMIN_ROLES = Object.freeze(['ATLAS.Admin']);
export const CANONICAL_PRESALES_ROLES = Object.freeze(['ATLAS.Presales', 'ATLAS.Publish']);
export const CANONICAL_REVIEWER_ROLES = Object.freeze(['ATLAS.Reviewer', 'ATLAS.Review']);

const split = value => String(value ?? '').split(',').map(s => s.trim()).filter(Boolean);

// No fallback. A missing or blank variable is an empty list, never a built-in role name.
export function configuredRoles(env, key) {
  if (!env || env[key] == null) return [];
  return split(env[key]);
}

// Production must name its elevated roles. This does not grant them; it only reports readiness.
export function privilegeReadiness(env = {}) {
  if (!tenantEnforced(env)) return { ok: true, mode: 'local-synthetic', errors: [] };
  const errors = [];
  if (!configuredRoles(env, 'ATLAS_ADMIN_ROLES').length && !split(env.ATLAS_ADMIN_SUBJECTS).length) errors.push(`Set ATLAS_ADMIN_ROLES (intended name ${CANONICAL_ADMIN_ROLES.join(', ')}) or ATLAS_ADMIN_SUBJECTS. Missing admin config grants nobody.`);
  if (!configuredRoles(env, 'ATLAS_PRESALES_ROLES').length) errors.push(`Set ATLAS_PRESALES_ROLES (intended names ${CANONICAL_PRESALES_ROLES.join(', ')}). Missing pre-sales config grants nobody.`);
  if (!configuredRoles(env, 'ATLAS_REVIEWER_ROLES').length) errors.push(`Set ATLAS_REVIEWER_ROLES (intended names ${CANONICAL_REVIEWER_ROLES.join(', ')}). Missing reviewer config grants nobody.`);
  return { ok: errors.length === 0, mode: 'enforced', errors };
}

export function tokenRoles(who) {
  const raw = who?.roles ?? who?.custom?.roles;
  return Array.isArray(raw) ? raw.filter(r => typeof r === 'string') : [];
}

const has = (roles, allowed) => allowed.some(r => roles.includes(r));

export function isVerifiedAdmin(env = {}, who = {}) {
  const roles = configuredRoles(env, 'ATLAS_ADMIN_ROLES');
  const subjects = split(env.ATLAS_ADMIN_SUBJECTS).map(s => s.toLowerCase());
  const sub = String(who.sub || '').toLowerCase();
  if (sub && subjects.includes(sub)) return true;
  if (!roles.length && !subjects.length) return false;
  return has(tokenRoles(who), roles);
}

// null: not an elevated library role (caller may still apply the external-confirmer allow-list).
export function elevatedRole(env = {}, who = {}) {
  const roles = tokenRoles(who);
  if (isVerifiedAdmin(env, who)) return 'admin';
  if (has(roles, configuredRoles(env, 'ATLAS_PRESALES_ROLES'))) return 'presales';
  if (has(roles, configuredRoles(env, 'ATLAS_REVIEWER_ROLES'))) return 'reviewer';
  return null;
}

// A verified tenant is the Entra tid carried in a tid:oid subject. A custom claim named tenant,
// and any browser header, are not a tenant.
export const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tenantOf(who = {}) {
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/i.exec(String(who.sub || ''));
  return m ? m[1].toLowerCase() : '';
}

// Production fails closed: both sides must be the same verified tenant id.
// The local synthetic demo sets ATLAS_TENANT_ISOLATION=local-synthetic. There, two empty
// tenants are one isolated sandbox. A missing id never matches a present id.
export function tenantEnforced(env = {}) {
  return env.ATLAS_TENANT_ISOLATION !== 'local-synthetic';
}

// The durable object must not trust x-atlas-tenant-enforced. A real deployment env
// (DATA_MODE or ATLAS_TENANT_ISOLATION) decides. Unit tests omit both and may still pass the header.
// An omitted or forged 0 cannot turn enforcement off once the deployment env is present.
export function resolveTenantEnforcement(env = {}, header) {
  if (env.ATLAS_TENANT_ISOLATION === 'local-synthetic' && env.DATA_MODE !== 'production') return false;
  // Any DATA_MODE, including "test", is a deployment signal. It does not trust the request header.
  if (env.DATA_MODE || Object.prototype.hasOwnProperty.call(env, 'ATLAS_TENANT_ISOLATION') || env.ORIGIN || env.CSRF_SECRET) return tenantEnforced(env);
  return header === '1';
}

// Query-string personas exist only on the local demo process, and only when both switches are set.
// The production Worker never calls this and never reads ?as= or &idp=.
export function devIdentityEnabled(env = {}) {
  return env.ATLAS_DEV_IDENTITY === '1' && env.ATLAS_TENANT_ISOLATION === 'local-synthetic';
}

// Any non-off value counts. Production must not carry the demo switch at all.
function switchConfigured(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text !== '' && text !== '0' && text !== 'false' && text !== 'off';
}
export function demoIdentityConfigured(env = {}) {
  return switchConfigured(env.ATLAS_DEV_IDENTITY);
}

// local-synthetic skips tenant equality. That is the local demo only.
// DATA_MODE=production with that switch, with demo identity, or with ATLAS_LOCAL_TENANT, is a refused deployment.
export function productionDemoConflict(env = {}) {
  if (env.DATA_MODE !== 'production') return null;
  const reasons = [];
  if (env.ATLAS_TENANT_ISOLATION === 'local-synthetic') reasons.push('ATLAS_TENANT_ISOLATION=local-synthetic');
  if (demoIdentityConfigured(env)) reasons.push('ATLAS_DEV_IDENTITY');
  if (switchConfigured(env.ATLAS_LOCAL_TENANT)) reasons.push('ATLAS_LOCAL_TENANT');
  if (!reasons.length) return null;
  return {
    ok: false,
    error: `Refused before any story, trust, or metric read. DATA_MODE=production cannot be combined with ${reasons.join(' or ')}.`,
  };
}

export function sameTenant(recordTenant, userTenant, enforced = false) {
  const left = String(recordTenant || '').toLowerCase();
  const right = String(userTenant || '').toLowerCase();
  if (enforced) return TENANT_ID.test(right) && left === right;
  if (left && right) return left === right;
  if (left || right) return false;
  return true;
}
