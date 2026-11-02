# MiChat CV: ready to connect (X2)

Status (2026-11-02): **built, not connected.** The MiChat owners have not sent an endpoint or a contract. Atlas ships a real adapter, a mapping to an
**assumed** payload, retries, an idempotency key, a health check and contract tests against a mock MiChat. Nothing is sent to MiChat until the Worker
variables below are set. Until then the CV branch behaves as before: mock (the outbox the reviewer sees) or `blocked_external` under live, and no
outbound call is made.

## How it works
- Registry: `atlas_voice/config/connections.json`, connection `michat_cv`. It stays `not_configured` with no owner, because nothing is confirmed.
- Assumed contract: `atlas_voice/config/contracts/michat_cv/assumed/contract.json`, with synthetic samples beside it. It is validated at build time
  like any configured connection (`connections_config.michat_assumed_connection`) and emitted to the Worker as `MICHAT_ASSUMED_CONTRACT`.
- The Worker overlays it on `michat_cv` only when `MICHAT_CV_CONTRACT=assumed` (`deploy/cloudflare-edge/src/michat.js`).
- Payload: `adapters.js` `buildPayload('MICHAT_CV')` builds it from the approved revision only. Outcome and metric text is never sent
  (`CLIENT_PERMISSION_UNKNOWN`), unreviewed speech-recognition quotes are never sent (`VERBATIM_ASR_NOT_REVIEWED`), and every other statement passes
  `cvTextMask`, which replaces any library client name with "a client", any contact with "a contact", and emails, phones and links with tags
  (Tony decision D-G14: no client names in CVs).
- Language: when `MICHAT_CV_LANGUAGE` is set, every statement is machine translated into it (`translate.js`, D-L2). Each entry carries
  `text_language` and `translation_confidence` (high, medium, low, none). The confidence is information for MiChat, never a gate.
- Delivery: the job pump (`jobs.js`) retries up to 5 attempts with exponential backoff and jitter. Every attempt carries the same `Idempotency-Key`
  (`<entity>:<revision>:<content hash>:MiChat`). HTTP 409 or 412 becomes `needs_reconciliation`; 408, 429 and 5xx are retried; other 4xx fail with a code.
- Sandbox: by default MiChat's acknowledgement is treated as sandbox (`mock: true`), so a record is never shown as synced. Set
  `MICHAT_CV_SANDBOX=false` only once MiChat confirms production.
- Health: `GET /api/connections/michat/health` (ATLAS admins only) calls MiChat's health endpoint once and returns the status code and time, never a
  body, URL or token. `node scripts/connection_check.mjs` reads the same readiness.

## Worker settings (names only)
| Name | Kind | Who sets it | Value |
|---|---|---|---|
| `MICHAT_CV_BASE_URL` | variable | Tony, from the MiChat owners | MiChat's base URL, https |
| `MICHAT_CV_TOKEN` | secret (`wrangler secret put`) | Tony, from the MiChat owners | MiChat's API token |
| `MICHAT_CV_CONTRACT` | variable | Tony | `assumed` to use the assumed contract below |
| `ATLAS_ADAPTERS` | variable | Tony | `live` (this also turns every other ready connection live; the others stay `blocked_external`) |
| `MICHAT_CV_SANDBOX` | variable | Tony, after MiChat confirms production | `false` |
| `MICHAT_CV_LANGUAGE` | variable | Tony or the MiChat owners | the CV language, any tag (`en`, `fr`, `pt-BR`, `ja`) |
| `MICHAT_CV_TEMPLATE` | variable | the MiChat owners | the template name MiChat expects (up to 80 characters) |
| `TRANSLATE_GLOSSARY` | variable, optional | Tony | terms kept as they are, comma or newline separated, or `term=rendering` |

## What to fill in when the owners send the contract
Edit `atlas_voice/config/contracts/michat_cv/assumed/contract.json` (or, once confirmed, move it into `connections.json` and drop `MICHAT_CV_CONTRACT`):
1. `owner`: the MiChat owner's name or team.
2. `auth`: if MiChat uses an API key header, set `"type": "api_key_header"` and `"header_name"`; for OAuth2 client credentials see `docs/CONNECTIONS.md`.
3. `endpoints.send` and `endpoints.health`: method and path (assumed `POST /v1/cv-entries`, `GET /v1/health`). `{source_entity_id}` and
   `{source_revision}` placeholders are allowed in a path.
4. `field_mapping`: left side is the Atlas payload field (do not change), right side is MiChat's field path. One `[]` level is supported
   (`claims[].statement` to `entries[].text`). Delete any line MiChat does not accept.
5. `static_fields`: fixed values MiChat requires (assumed `source_system: atlas`).
6. `ack_rule`: where MiChat's response puts the document id (`record_id_path`) and version (`version_path`); set the echo paths if MiChat
   returns the revision or hash Atlas sent, and `hash_echo_required: true` if it always does.
7. `timeout_ms`: MiChat's response time budget.
8. Replace `assumed/request.sample.json` and `assumed/response.sample.json` with the owners' samples (synthetic or anonymised, never real people
   or clients), then run `make test`. `connection-contracts.test.js` and `michat-connector.test.js` check them.
9. Update `atlas_voice/config/contracts/michat_cv/request.schema.json` and `response.schema.json` if MiChat's schema differs.
10. Ask the owners for rate limits, the template list, the language rules and the DPA or transfer approval; record them in `docs/CONNECTIONS.md`.

## Turning it on
1. `cd deploy/cloudflare-edge && npx wrangler secret put MICHAT_CV_TOKEN`
2. Set `MICHAT_CV_BASE_URL`, `MICHAT_CV_CONTRACT=assumed`, `MICHAT_CV_LANGUAGE`, `MICHAT_CV_TEMPLATE` and `ATLAS_ADAPTERS=live` as Worker variables
   (dashboard or `wrangler.jsonc` `vars`), then deploy.
3. As an admin, open `/api/connections/michat/health` (expect `ok: true`) and `/api/connections/status` (`michat_cv` should read `ready`).
4. Approve one synthetic test record and check the job reaches `succeeded` with a sandbox acknowledgement. Then set `MICHAT_CV_SANDBOX=false`.
