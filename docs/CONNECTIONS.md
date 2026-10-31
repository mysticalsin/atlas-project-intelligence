# ATLAS connections: ready to plug

Every system in Tony's canonical workflow (`ATLAS Workflow` diagram) has a place to plug in, a draft contract and a readiness card below. **No connection to a system owned by someone else is configured or verified.** DNA, MiChat, IMP, Spotlight CMS, MAAP, Project Review and the CRM/opportunity source are all owner-unconfirmed (`DECISION_LOG` D1 to D5). This repository contains no real vendor URL, field name, credential or auth flow. When an owner hands over a base URL, an auth method, a schema and sample payloads, enabling the connection is configuration plus a contract test. It is not new code.

Status of the whole thing: implemented and locally verified against fake HTTP servers. Provider verified: none. Nothing was deployed and no real system was called.

## How it fits together

| Piece | Where | Role |
|---|---|---|
| Connection registry | `atlas_voice/config/connections.json` | One entry per connection. Python-owned and validated at import by `atlas_voice/connections_config.py`; emitted to the Worker as `CONNECTIONS_CONFIG` in `policy.generated.js` (run `python deploy/cloudflare-edge/build_edge.py --policy-only` after every edit). |
| Draft contracts | `atlas_voice/config/contracts/<id>/request.schema.json`, `response.schema.json` | Written from the pack's documented fields only and marked "draft — from Atlas side; owner to confirm". The request schema is the approved Atlas-side payload before mapping (the real payload builders are tested against it). The response schema is the normalised acknowledgement Atlas builds from the owner's raw response through `ack_rule`. |
| Generic HTTP connector | `deploy/cloudflare-edge/src/connectors.js` | Outbound: the same `send(envelope, payload)` interface as the mock adapters, used by `jobs.js` and `branches.js`. Inbound: a read-only fetch with an allowlist. Health call for the manual preflight. |
| Registry switch | `deploy/cloudflare-edge/src/adapters.js` (`adapterMode`, `adapterModeFor`, `liveAdapter`) and `branches.js` (`modeFor`) | Mock stays the default. Under `ATLAS_ADAPTERS=live` a destination uses HTTP only if its own connection is ready; every other destination stays `blocked_external`. |
| Preflight script | `scripts/connection_check.mjs` | Offline readiness report, sample validation, optional manual health call. |
| Tests | `deploy/cloudflare-edge/test/connectors.test.js`, `connectors-wiring.test.js`, `connection-contracts.test.js`; `tests/test_connections_config.py` | Fake servers per auth type, status mapping, refusal rules, minimisation, wiring into the fan-out, data-driven contract check, config consistency. |

### What the connector guarantees

- It runs only when all of these hold: the connection is `wired`, its status is `configured_untested` or higher, every secret named in `auth.secret_names` is present, `ATLAS_ADAPTERS=live`, the base URL variable is set (https; http only for loopback in tests), an endpoint is configured, `field_mapping` is not empty and the `ack_rule` is complete. Otherwise it returns `CONNECTION_NOT_READY:<code>` and makes no request.
- The request body is built **only** through `field_mapping`. An Atlas field that is not mapped is never sent. A payload or mapped body that contains a never-send key (transcript, internal notes, interview, session, ledger or item ids, source references, quotes, ASR metadata) is refused before any request.
- It never reports `mock: false` unless a real HTTP response satisfied the `ack_rule` (record id and version both present, echoes consistent). A connection flagged `sandbox: true` reports `mock: true, sandbox: true`, so a sandbox record can never read as synced or published.
- Spotlight: a 2xx is not publication. The CMS must echo the exact revision hash and report a published state, canonical URL and time, otherwise the job fails with `CMS_ACCEPTED_NOT_PUBLISHED`. The policy gate still decides `published` (it needs a non-mock acknowledgement bound to the revision).
- HTTP mapping: 2xx with a satisfied ack rule is success; 409 and 412 become `needs_reconciliation`; 429, 408, 5xx, timeout and network errors retry with the job envelope's backoff; 401, 403 and other 4xx fail with `HTTP_<code>`; redirects are never followed. Response bodies are never copied into errors or audit.
- Secrets are read from the Worker env by name at call time and are never returned, logged or stored. mTLS uses a Worker `mtls_certificates` binding named in `secret_names`.
- Idempotency: the job's `idempotency_key` is sent in the configured header (default `Idempotency-Key`) on every attempt.
- Inbound: GET only. Output passes an allowlist (`inbound.model_fields`, `inbound.display_only_fields`). Names, emails and the N+1 are display-only and never model-visible, even if a config lists them as model fields. Values are bounded scalars or short lists; nested objects are dropped. Unknown fields are dropped and reported by Atlas field name only.

### The status ladder

| Status | Meaning | Required to be at this status |
|---|---|---|
| `not_configured` | Nothing is plugged in. | The shipped state of every external connection. |
| `configured_untested` | Owner, endpoint, mapping and ack rule are set; secrets can be present. The connector may run. | Confirmed owner (not null, not `TO CONFIRM`), endpoint, non-empty `field_mapping`, `ack_rule.record_id_path` and `version_path`, auth header name where needed, `wired: true`. |
| `contract_verified` | The owner's samples pass the contract test and the schemas are the owner's, not a draft. | `schema_status: owner_confirmed`; samples present and passing the contract test (step 5 below). |
| `live_verified` | A real acknowledgement from the owner's production system was observed and checked by a person. | `sandbox: false`. |

`connections_config.py` and `tests/test_connections_config.py` refuse a status that its prerequisites do not support.

### Configuration reference (generic; the names in this example are invented)

```jsonc
"endpoints": { "send": { "method": "POST", "path": "/v1/records" }, "health": { "method": "GET", "path": "/health" } },
// outbound: Atlas path -> destination path. `[]` maps array items one by one. Nothing unmapped is sent.
"field_mapping": { "entity_id": "record.external_ref", "assertions[].claim_id": "record.items[].id" },
"static_fields": { "record.schema": "v1" },            // constants the owner requires
"auth": { "type": "bearer", "secret_names": ["X_TOKEN"], "secret_roles": { "token": "X_TOKEN" } },
"ack_rule": { "kind": "write", "record_id_path": "data.id", "version_path": "data.version",
              "destination_revision_path": null, "revision_echo_path": null, "hash_echo_path": null, "hash_echo_required": false },
```

- `auth.type`: `none`, `bearer` (role `token`), `api_key_header` (role `key`, plus `header_name`), `oauth2_client_credentials` (roles `client_id`, `client_secret`, plus `token_url_var`, optional `scope_var`, `token_auth` `basic` or `post`; standard RFC 6749 section 4.4, token cached until expiry, one fresh token on a 401), `mtls` (role `binding`).
- `base_url_var` (and `token_url_var`, `scope_var`) are Worker variable **names**. Put the URL in `wrangler.jsonc` `vars`; put credentials only in `wrangler secret put`.
- Endpoint paths may contain `{source_entity_id}`, `{source_revision}`, `{destination}` (outbound) or `{<param>}` (inbound, from the `read(params)` call); values are URL-encoded.
- Inbound `field_mapping` runs the other way: Atlas field name to the path in the owner's response. Inbound `endpoints.read.query` maps a query parameter name to a `read(params)` key.
- `ack_rule.destination_revision_path`: if the destination reports a revision newer than the source, the job becomes `needs_reconciliation` and nothing is overwritten. `revision_echo_path` and `hash_echo_path`: if present, a mismatch is a conflict. Without echoes the acknowledgement is bound to the revision and hash Atlas sent (a 2xx to an idempotent write that returns a record id and a version).
- Retry, backoff and the dead letter come from `jobs.js` (5 attempts, exponential backoff with equal jitter, 15 minute cap). `rate_limit` is recorded for the owner agreement; the connector sends one request per job attempt.

## Enabling a connection

Do these in order, for one connection at a time. Nothing here needs new code.

1. **Collect from the owner** (see the card): base URL for a sandbox, auth method and credentials, schema, sample payloads (request and success response, synthetic or anonymised), acknowledgement semantics, rate limits, and the data-transfer or DPA approval where personal data leaves Mantu.
2. **Edit `connections.json`**: `owner`, `auth` (type, `header_name`, `token_url_var`), `endpoints`, `field_mapping`, `static_fields`, `ack_rule`, `rate_limit`, `timeout_ms`; keep `sandbox: true`; set `status` to `configured_untested`. Replace the draft schemas with the owner's confirmed ones only when they are (then `schema_status: owner_confirmed`).
3. **Set the base URL variable** in `wrangler.jsonc` `vars` (sandbox URL) and **put each secret**: `npx wrangler secret put <NAME>` for every name in `auth.secret_names`. Never commit a value, never put one in a URL.
4. **Regenerate and preflight**: `python deploy/cloudflare-edge/build_edge.py --policy-only`, then
   `node scripts/connection_check.mjs --vars-file .dev.vars --connection <id>` (prints secret names as present or missing, never values; lists blockers by code).
5. **Contract test**: save the owner's samples as `atlas_voice/config/contracts/<id>/samples/request.sample.json` (the Atlas-side payload) and `response.sample.json` (the raw success response). Run `node scripts/connection_check.mjs --contract <id> --sample <file>` and `--contract <id> --ack-sample <file>`, then `cd deploy/cloudflare-edge && node --test test/connection-contracts.test.js`. The last one checks the schemas, the never-send list, the mapping and the ack rule against the samples.
6. **Set `status: contract_verified`** (and `schema_status: owner_confirmed`), rerun the Python and edge suites.
7. **Sandbox round trip** in a staging Worker: set `ATLAS_ADAPTERS=live` (this is global, but only ready connections go live; every other destination stays `blocked_external`). Approve a synthetic evidence revision and confirm the card shows `mock_acknowledged` with `sandbox: true`, the destination shows the record once, and a replay creates no duplicate.
8. **Production**: owner's production URL and secrets, `sandbox: false`, redeploy. After the first real acknowledgement has been checked by a person against the destination, set `status: live_verified`. Only then does the policy gate allow `sync_complete` (or `published` for Spotlight).
9. **Optional manual health call**: `node scripts/connection_check.mjs --connection <id> --live --confirm-live`. It sends one request to `endpoints.health` and prints the status code and time only. It is refused when `CI` is set and it is never part of any test or pipeline.

**Rollback** (fastest first): set `ATLAS_ADAPTERS` to `mock` or `off` and redeploy, which stops all live delivery at once. Or set that connection's `status` back to `not_configured` and regenerate. Or `npx wrangler secret delete <NAME>`. Jobs that were in flight stop being delivered. Atlas cannot recall a record the destination has already accepted: use the withdrawal flow (D11), which flags derivatives for impact review, and ask the owner to remove the record.

## Workflow step map

The image numbers steps 1 to 7. Steps 8 to 11 are our labels for the unnumbered boxes, following the pack's sequence.

| Step | Image box | Connections |
|---|---|---|
| 1 | Identify consultant and project | `identity`, `staffing` |
| 2 | Prefill authorized context | `prefill_profile`, `opportunity` |
| 3 to 7 | Interview, follow-up, contribution evidence, artifacts and sources, manager or owner factual review | none (inside Atlas) |
| 8 | Accepted? | none |
| 9 | Approve evidence revision | none |
| 10 | Purpose-specific projections (DNA skills update, MiChat CV, IMP capability signal), MAAP Review, Project review, Spotlight story candidate | `dna_skills`, `michat_cv`, `imp_capability`, `maap_review`, `project_review` |
| 11 | Public release authorized? Publish approved Spotlight version | `spotlight_cms` |

## Readiness cards

Every card has the same blockers until the owner provides the data: `STATUS_NOT_CONFIGURED`, `ADAPTERS_NOT_LIVE`, `SECRET_MISSING:<NAME>`, `BASE_URL_MISSING`, `ENDPOINT_NOT_CONFIGURED`, `FIELD_MAPPING_EMPTY`, `ACK_RULE_MISSING`. Secret and variable names below are placeholders chosen by Atlas; the owner may rename them. The auth type on each card is a placeholder until the owner states theirs. In every card, Atlas **never** sends the raw transcript, internal notes, interview, session or ledger ids, source quotes or ASR metadata.

### identity (step 1, inbound, existing)
- **What it is**: Cloudflare Access JWT verification, or Microsoft Entra token validation (`IDENTITY_SOURCE=entra`). Existing code (`worker.js`, `identity.py`); not an HTTP connector. See `docs/INTEGRATIONS.md` (Roles).
- **Status**: `configured_untested`. Tested with synthetic tokens; never exercised against a real Access or Entra tenant from this repository.
- **Needs from the owner (IT)**: Access application and policy, Entra app registration with `ATLAS.Admin` and `ATLAS.Reviewer` roles, tenant id. Entra N+1 directory gap (`G1-1`) is open.

### staffing (step 1, inbound, existing)
- **What it is**: admin or reviewer CSV import (`POST /api/library/staffing/import`), header `project_id,consultant_email,manager_email,manager_name,project_title,end_date`. Existing code; no external system called. Contract: `contracts/staffing/request.schema.json`.
- **Status**: `contract_verified` on the Atlas-defined CSV format (tested locally with the real import).
- **Needs from the owner**: the staffing export owner and a scheduled export, if the CSV is to be automated. `POST /api/triggers` with secret `TRIGGER_SECRET` is the existing push path.

### prefill_profile (step 2, inbound)
- **Receives (draft, `contracts/prefill_profile/response.schema.json`)**: `role` (model-visible); `title`, `preferred_name`, `manager_name`, `manager_email` (display only, forms and consent heading). The consultant's name never reaches a model. Request: `consultant_id`.
- **Existing code**: `profile.js` already has a DNA pull with an **assumed** shape (`DNA_PROFILE_URL`, `DNA_AUTH_HEADER`, `DNA_FIELD_MAP`, secret `DNA_API_KEY`). It keeps working unchanged. When the owner confirms the contract, moving it onto this connector is a wiring change in `profile.js`.
- **Needs from the owner (DNA)**: base URL and a sandbox, auth method and credentials as Worker secrets (`DNA_API_KEY` or as they specify), the lookup key (oid, email or stable id), response schema and a sample, rate limits, freshness, DPA or transfer approval, and the `DATA_MODE=production` approval for real people data.
- **Variables**: `DNA_PROFILE_BASE_URL`. **Secrets**: `DNA_API_KEY`.
- **Blocks until then**: status `not_configured`; the profile still merges you, existing DNA push/export, sign-in and guess sources.

### opportunity (step 2, inbound)
- **Receives (draft)**: `opportunity_id`, `role` (model-visible); `mandatory_criteria`, `preferred_criteria`, `location_constraints`, `start_date`, `lifecycle_state`, `updated_at` (display only). Customer identity is not allowlisted. Request: `opportunity_id`. Mandatory eligibility stays deterministic; preferred fit is evidence-ranked (Integration Contracts section 4).
- **Needs from the owner (CRM or IMP, unconfirmed which)**: base URL and sandbox, auth (placeholder: OAuth2 client credentials), schema and sample, rate limits, which system is authoritative, DPA approval.
- **Variables**: `OPPORTUNITY_BASE_URL`, `OPPORTUNITY_TOKEN_URL`, `OPPORTUNITY_SCOPE`. **Secrets**: `OPPORTUNITY_CLIENT_ID`, `OPPORTUNITY_CLIENT_SECRET`.
- **Not built**: the IMP availability read (Integration Contracts section 3). IMP is authoritative for availability and Atlas must not compute it.

### dna_skills (step 10, outbound)
- **Sends (draft)**: `entity_id`, `source_revision`, `content_hash`, `approved_at`, `consultant_id`, `reviewer`, `effective_date`, and `assertions[]` of skill-type claims as `status: proposed` with `skill_taxonomy_id: null`, `level: null` and `evidence_refs` (claim id and revision). A story approval is not a skill approval; no unverified AI claim is written; client-attributed claims stay out.
- **Needs back**: acknowledgement with destination record id and version; conflict response; duplicate prevention.
- **Needs from the owner (DNA)**: base URL, sandbox, auth, write schema, the taxonomy (to fill `skill_taxonomy_id` and `level`, which Atlas will not invent), sample request and response, ack semantics, rate limits, DPA or transfer approval.
- **Permission in Atlas**: `evidence_approved` + `dna_permission` (purpose `skills_profile`, pending owner confirmation, D7) + `reviewer_approval`.
- **Variables**: `DNA_SKILLS_BASE_URL`. **Secrets**: `DNA_SKILLS_TOKEN`.

### michat_cv (step 10, outbound)
- **Sends (draft)**: identity and revision fields, `consultant_id`, `profile_revision`, `language`, `target_role`, `template` (null until defined), `claims[]` (reviewed wording only; outcome and metric claims send structured value, unit, baseline, after state and period but no client text) and `permissions[]`.
- **Needs back**: CV document id, version, generated status, timestamp, validation warnings (Integration Contracts section 2).
- **Needs from the owner (MiChat)**: base URL, sandbox, auth, CV schema, template and language rules, sample request and response, ack semantics, rate limits, DPA or transfer approval, and the client-permission model that would let outcome text be sent.
- **Naming**: the pack's "MeChat" is a typo for MiChat (Tony). The connection id is `michat_cv`. The code-level adapter id is `MICHAT_CV`, the branch key `michat`, the job destination `MiChat` (renamed in M1; stored `mechat` / `MeChat` rows are migrated on read, see `AGENT.md`).
- **Permission in Atlas**: `evidence_approved` + `cv_permission` (purpose `cv`).
- **Variables**: `MICHAT_CV_BASE_URL`. **Secrets**: `MICHAT_CV_TOKEN`.

### imp_capability (step 10, outbound)
- **Sends (draft)**: identity and revision fields, `consultant_id`, `availability: null` (IMP's, never computed here), `signals[]` (skill-type claims) and `permissions[]`.
- **Needs back**: acknowledgement with record id and version.
- **Needs from the owner (IMP)**: base URL, sandbox, auth, signal schema, confirmation of the `matching` purpose, sample request and response, ack semantics, rate limits, DPA or transfer approval.
- **Permission in Atlas**: `evidence_approved` + `matching_permission` (purpose `matching`, pending owner confirmation, D7).
- **Variables**: `IMP_CAPABILITY_BASE_URL`. **Secrets**: `IMP_CAPABILITY_TOKEN`.

### maap_review (step 10, outbound, not wired)
- **Draft sends**: review metadata from the pack's `MAAPReview` data model (ids, period, type, country, status, due date, reviewer and participant ids, template version) and approved-evidence references; `rubric_version: null`.
- **Needs from the process owner first**: the official MAAP purpose, rubric, rating model, cadence, participants, country variants and retention (`MUST_BE_CONFIGURED_BY_PROCESS_OWNER`, D2). Atlas will not invent a rating scale.
- **Not config-only**: there is no payload builder or job wiring today (`wired: false`), so the connector refuses it with `NOT_WIRED` whatever the status. Enabling it is a later build once the methodology exists. Governance stays: no emotion, personality, health or attrition inference, no automated employment, pay or promotion outcome.
- **Variables**: `MAAP_REVIEW_BASE_URL`. **Secrets**: `MAAP_REVIEW_TOKEN`.

### project_review (step 10, outbound, not wired)
- **Draft sends**: review id, project id, trigger, focus (`alignment`, `quality`, `readiness`), approved-evidence references; `rubric_version: null`. The pack gives no Project Review data model, so these fields are Atlas-side placeholders to confirm.
- **Needs from the process owner first**: methodology, rubric, owners and cadence (D3). Not config-only (`wired: false`), same as MAAP. Project Review does not authorise a Spotlight story and cannot change MAAP outcomes.
- **Variables**: `PROJECT_REVIEW_BASE_URL`. **Secrets**: `PROJECT_REVIEW_TOKEN`.

### spotlight_cms (step 11, outbound)
- **Sends (draft)**: `audience: public`, `channel`, `story_revision_id`, `revision_hash`, `content_hash` and `story` (the public audience projection limited to the `public_story` visibility fields). Never consultant ids, approval state, internal notes or source references.
- **Needs back (all required)**: CMS id, canonical URL, publication state, publish timestamp and the **revision hash echoed**. Only the exact approved revision may publish; any content change invalidates the prior approval. `ack_rule.publication` also needs the CMS's own value(s) that mean "published".
- **Needs from the owner (Spotlight CMS)**: base URL, sandbox, auth, publication contract, channels, sample request and response, whether a draft or scheduled state exists (today a 2xx that is not published fails the job rather than showing as held), rate limits.
- **Permission in Atlas**: every Spotlight gate closed for this revision, `public_spotlight` grant, named channel (`spotlight_publish`).
- **Variables**: `SPOTLIGHT_CMS_BASE_URL`. **Secrets**: `SPOTLIGHT_CMS_TOKEN`.

## Follow-ups outside this change

- Route wiring for a connection status endpoint: `connectors.js` exports `connectionStatus(env)` (names and booleans only). Later wave.
- Moving the `profile.js` DNA pull onto the inbound connector once the DNA contract is confirmed.
- A "held" live state for a CMS that accepts but does not publish (needs a branch status and a gate change).
- Honouring `Retry-After` in `jobs.js` backoff (recorded on the attempt result today).
