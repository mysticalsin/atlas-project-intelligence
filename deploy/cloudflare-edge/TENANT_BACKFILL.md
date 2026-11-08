# Tenant backfill plan

This is an operator plan. This change does not run a migration against a production database and does not assign a tenant to an existing row.

## What the code does now

When the deployment env is present (`DATA_MODE`, `ATLAS_TENANT_ISOLATION`, `ORIGIN`, or `CSRF_SECRET`), tenant enforcement comes from that env. `x-atlas-tenant-enforced` cannot turn it off. `DATA_MODE=production` with `ATLAS_TENANT_ISOLATION=local-synthetic` or with `ATLAS_DEV_IDENTITY` returns 503 before a durable-object fetch.

Enforced reads, approvals, exports, metrics, DSAR export, DSAR delete, and journey load use the caller's verified tenant. The journey primary key is `(subject, tenant)`. A save for one tenant does not overwrite another tenant's row. An older journey table is rebuilt in process by copying `tenant` as stored, including blank. That rebuild is not a production data migration and does not invent a tenant.

Telemetry purge deletes only rows whose `tenant` equals the caller's tenant. Metrics apply that same predicate before `LIMIT`. A staffing import with enforcement on and no UUID tenant throws before it writes staffing, trust, or invitations. Imported staffing rows store the caller's tenant. Rows with a blank tenant stay blank and are not returned to a verified tenant.

The daily cron does not run a cross-tenant sweep unless `ATLAS_SYSTEM_TENANT` is a verified tenant id. `/api/triggers` and `/api/directory/push` use that same configured tenant and the enforced flag. If the value is missing or not a tenant id, those routes return 503 before the durable object. A tenant on the request header or in the JSON body is not accepted unless it is exactly that configured id. Neither route calls a directory or HR service from this check. Active profile rows use the primary key `(subject, tenant)`. Only a blank legacy profile remains quarantined, and a DSAR delete does not erase it. The active schema is not subject-only. Vendor logs are not contacted. `vendorDeletion` stays `not-asserted` and DSAR `complete` stays false. An enforced Hindsight bank and Interview object are `tenant:subject`. A missing tenant does not open the older subject-only key, and that key is not deleted.

## What an operator does later

1. Export row ids out of band (story id, journey subject, trust pair, telemetry id, staffing key). Do not invent a tenant from email or a header.
2. Map each id to a verified Entra `tid`. Unmapped rows stay blank.
3. Review that mapping. A separate, reviewed migration may then write the mapped `tid`.
4. Until that migration runs, enforced reads continue to exclude the blank rows.

`ATLAS_DEV_IDENTITY` values `0`, `false`, `off`, and empty do not count as demo identity. Only any other value, together with `DATA_MODE=production`, is a refused deployment. `local-synthetic` with production is refused on its own.

Staffing's primary key is `(project_id, consultant_email, tenant)`. An older table is copied with a blank tenant when the column was absent. A later import does not take over that row. The staffing list applies the tenant predicate before `LIMIT`. Invitations dedupe on email, reason, project, reference, and tenant, so one tenant's open invitation does not suppress another's. Nothing is sent.

An enforced maintenance sweep expires only that tenant's gap requests, confirmation requests, unseen profiles, and that tenant's directory pull cache and staged imports. Directory rows are keyed by `(key, source, tenant)`. Blank rows stay blank. Rows that were overwritten before this key existed cannot be reconstructed, and this code does not invent a mapping for them. The cron and the bearer ingresses refuse to run when `ATLAS_SYSTEM_TENANT` is missing or not a tenant id. `DATA_MODE`, including `test`, is a deployment signal: it does not let `x-atlas-tenant-enforced` turn enforcement off. The header is read only when the process has no deployment signal at all. `local-synthetic` without `DATA_MODE=production` is the only isolation exception.

## Memory and Interview objects

An enforced bank id is an HMAC of `tenant:subject`. An enforced Interview object name is `tenant:subject`. A missing tenant does not open the older subject-only bank or object. Those older keys are quarantined: they are not read, not assigned a tenant, and not deleted. No vendor API is called. An operator who must erase a legacy Hindsight bank does that in the memory service itself, after listing banks out of band. This deployment does not do it. `vendorDeletion` stays `not-asserted`. A DSAR response lists covered local stores and retained or quarantined stores, and `complete` is false.

Manager trust is unique on `(owner, email, tenant)`. A conflict updates the source and the time. It does not replace the tenant. A blank legacy row stays blank and does not approve a verified tenant. Story identity `(owner, local_id, tenant)` is the same rule. The `tenant` column is copied from the tenant already stored on the story. Blank stays blank.

Directory rows and staged imports are unique on `(key, source, tenant)` and `(batch, tenant)`. Reads, the shrink replace, clear, retention, and a DSAR delete of the subject's own row use that tenant. A blank directory row is not returned to a verified tenant and is not assigned one. Quarantine is not deletion. Erasing a legacy Hindsight bank or a subject-only Interview object is operator work outside this process. No vendor API is called.

Do not treat this document as a completed backfill.
