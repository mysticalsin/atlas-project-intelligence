# Configuration and commands
This is the map to **existing code**, not a claim that services are available. All commands run from the extracted `ATLAS_Project_Intelligence/` root. The intended application server is an approved Linux/Unix environment with Python 3.11+; the Mac can remain only a browser client. Local development can use macOS. Windows users need an appropriate shell for the included `.sh` scripts; native Windows server operation is not verified.

## Dependencies by task
| Task | Required |
|---|---|
| Compile HTML | Python standard library; no npm build |
| Standalone UI | Modern browser with Canvas; no provider key |
| Local gateway | `requirements.txt` (`aiohttp`) |
| Local tests | Node with `node --test`, Python test requirements, FFmpeg/libopus for codec tests, Playwright Chromium for UI tests |
| Hosted voice | Approved OpenAI key and accessible configured voice/transcription model |
| Entra | `msal`, actual app registration/role assignments and secrets |
| Hindsight | Compatible `hindsight-client`/generated Documents API and a private authorized fork service |
| PersonaPlex | Dedicated NVIDIA GPU worker, model prerequisites/terms and FFmpeg/libopus gateway codec |
| Riva notes | Separate Riva endpoint and `nvidia-riva-client` |
| JEV / editor | Server-side key and accessible selected model; aiohttp is already used |

`requirements-integrations.txt` installs **all** optional SDKs. To keep a hosted pilot small, use the new per-integration requirements files only when needed. Resolve and lock actual versions on the target host; `constraints-tested.txt` is an inherited snapshot, not a universal lock or compatibility guarantee.

## Local setup and complete checks
```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-test.txt
python -m playwright install chromium
python scripts/doctor.py --profile preview
python build.py
node --test tests/*.test.js
python -m pytest tests/test_*.py -q
python tests/studio_browser.py
python tests/sculpture_browser.py
python tests/intelligence_browser.py
python tests/depth_browser.py
```
Install FFmpeg with libopus using the approved OS package manager before Python codec tests. `CHROMIUM_PATH` may point to a known installed Chromium executable. Browser installation can require OS libraries; use the approved host procedure, not blind privileged commands. No tests above need a real provider key.

## One real hosted conversation
```sh
python -m pip install -r requirements.txt
cp .env.example .env   # only when .env does not already exist; never overwrite a working configuration
# Edit the operator-owned .env securely. Set OPENAI_API_KEY; keep the exact origin.
python scripts/doctor.py --profile hosted --env-file .env
bash scripts/start_gateway.sh
```
Open `http://localhost:8080` for the defaults. The safe preview is port 8000 and deliberately cannot activate voice. The launcher reads `.env`; running `python -m atlas_voice.server` directly does **not** load that file. The launcher sources it as shell code—inspect it and restrict its ownership/permissions. The offline doctor reads simple assignments without executing shell expressions.

### Core / selected voice
| Variable | Existing default / example | Meaning |
|---|---|---|
| `ATLAS_VOICE_PROVIDER` | `.env.example`: `openai`; bare Config: `personaplex` | Choose explicitly; restart to change. |
| `OPENAI_API_KEY` | empty | Hosted speech and optional editor key; server-only. |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-2.1` | Documented model ID checked for this handoff; account access still untested. |
| `OPENAI_REALTIME_VOICE` | `cedar` | Client/server supported list: cedar, marin, ash, sage, verse. Verify target availability. |
| `OPENAI_TRANSCRIBE_MODEL` | `gpt-transcribe` | Consultant input transcription; capture requires consent. |
| `ATLAS_ORIGIN` | `http://localhost:8080` | Exact scheme/host/port, no path. Must match browser, proxy and callbacks. |
| `ATLAS_BIND` / `ATLAS_PORT` | `127.0.0.1` / `8080` | Loopback in local mode. `localhost` versus `127.0.0.1` in the browser is not interchangeable under exact Host/Origin checks. |
| `ATLAS_AUTH` | `local` | `local` for one trusted developer; `entra` for shared use. |
| `ATLAS_MAX_SECONDS` | `900` | Whole-interview cap; code accepts 30–900 seconds (the interview is at most 15 minutes). |
| `ATLAS_MAX_INTERVIEWS` | `1` | Concurrent interviews per gateway process, 1–100; one per signed-in user. Must be 1 for the stock PersonaPlex worker. With `ATLAS_MAX_SECONDS` this bounds worst-case hosted spend. |
| `ATLAS_MAX_SESSIONS` | `500` | Signed-in sessions (1 hour each) held by one process, 10–20000. Size from peak sign-ins per hour during a campaign; beyond it new sign-ins get HTTP 503. |
| `ATLAS_HANDSHAKE_TIMEOUT` | `90` | Ready timeout; code accepts 5–180 seconds. |
| `ATLAS_WIKI_ROOT` | `.env.example`: `./data/wiki`; bare Config: empty | Private durable vault; back up Markdown and SQLite together. |

The OpenAI IDs are recorded from official model pages on 2026-09-26: https://developers.openai.com/api/docs/models/gpt-realtime-2.1 and https://developers.openai.com/api/docs/models/gpt-transcribe . This confirms documented identifiers, **not** a real request or access in your account. No provider model silently substitutes for a rejected configuration.

### Shared Entra + private Hindsight
Install `requirements-entra.txt` and `requirements-hindsight.txt` as needed.

| Variable | Required value / contract |
|---|---|
| `ENTRA_TENANT_ID` | Actual tenant UUID; do not invent one. |
| `ENTRA_CLIENT_ID` | Actual confidential web-app client UUID. |
| `ENTRA_CLIENT_SECRET` | Server-held secret from the authorized secret store. |
| `ENTRA_REQUIRED_ROLE` | Defaults to `ATLAS.Interview`. Assign it to allowed users. |
| `HINDSIGHT_URL` | Actual approved private service base URL; verified TLS outside loopback. |
| `HINDSIGHT_API_KEY` | Service key when required by the deployment. Blank is accepted by existing code, not approval for public anonymous service. |
| `HINDSIGHT_BANK_SECRET` | Stable random secret, at least 32 characters; never rotate blindly or banks become differently addressed. |

Register exactly `<ATLAS_ORIGIN>/auth/callback`. Configure independent `ATLAS.Review` and `ATLAS.Publish` assignments according to real authority. All app users also need the base interview role. Same-origin CSRF and secure session cookies are application requirements, not optional demo obstacles.

Run `python scripts/doctor.py --profile shared --env-file .env` after configuration. It checks local prerequisites only. Test at least two distinct Entra identities and a non-author reviewer. Local workspace switching is **not** that test. `scripts/wiki_access.py --help` explains operator story grants; stop the pilot gateway before operator maintenance that requires a consistent single-process vault.

Requested Hindsight source: https://github.com/mysticalsin/hindsight at `a921929a0e0ea82fb49da1daa0ca3e152e41fcc1`. Use `docs/SOURCE_LOCK.json` and the pinned repository's own deployment instructions. The server source/weights are not vendored in this small application ZIP.

### Kyutai voice route (selected for scale)
`ATLAS_VOICE_PROVIDER=kyutai`. Variables, voice licensing, GPU setup and acceptance are in `docs/KYUTAI_SETUP.md`. Doctor: `--profile kyutai`. `KYUTAI_STT_URL`/`KYUTAI_TTS_URL` are ws(s) base URLs (paths `/api/asr-streaming`, `/api/tts_streaming` are added). The API key is sent as the `kyutai-api-key` header.

### Analyst brain (live evidence for any voice layer)
`atlas_voice/analyst.py`. Consultant transcript segments go to a text LLM tool call (`record_details` only), are validated by `InterviewLedger`, and produce a deterministic next-probe guidance. Wired into the Kyutai route (`cascade.py`); PersonaPlex wiring pending (see `SCALE_PLAN.md` §3b).

| Variable | Contract |
|---|---|
| `ANALYST_CHAT_URL` | Full OpenAI-compatible chat-completions URL with tool calling, e.g. Workers AI `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1/chat/completions`, self-hosted vLLM, or OpenAI. HTTPS except loopback. |
| `ANALYST_MODEL` | Required with the URL, e.g. `@cf/openai/gpt-oss-120b` (candidate; confirm tool-calling behaviour in the bake-off). |
| `ANALYST_API_KEY` | Server-side key; never sent to the browser. |

### Hosting on Cloudflare (Tunnel + Access)
Selected hosting shape (2026-09-26): the unchanged gateway on one always-on host, published through a Cloudflare named tunnel with Cloudflare Access as an outer gate. Runbook and templates: `deploy/cloudflare/README.md`, `config.yml.example`, `atlas.env.example`, `atlas-gateway.service.example`. Requires `ATLAS_AUTH=entra`, loopback bind and `ATLAS_ORIGIN` equal to the public `https://` hostname pinned by `httpHostHeader`. Local mode is rejected off loopback by design. Check with `python scripts/doctor.py --profile cloudflare --env-file .env` (offline only).

### Cloudflare edge Worker (the live test deployment): zero-setup start and profile
The live site (`deploy/cloudflare-edge/`, docs/WOW_ZERO_CONFIG.md) needs nothing per person: sign in, press Start, tick one box, talk. Its variables are named (without values) as comments in `deploy/cloudflare-edge/wrangler.jsonc`; secrets are set with `npx wrangler secret put <NAME>` by Tony only. Everything below is unset by default, and a missing item never blocks the interview: the feature is absent, or `BLOCKED_EXTERNAL` in the admin view.

| Variable / decision | Contract |
|---|---|
| `DATA_MODE` | Unset = test mode: the "TEST DEPLOYMENT · SYNTHETIC DATA ONLY" banner, readiness `edge-deployment-test-data-only`, DNA push and pull `BLOCKED_EXTERNAL`, the DNA-export CSV accepts reserved test addresses only (`example.com`, `.test`, …). `production` only on a Mantu-owned Cloudflare account after Mantu IT approval and DPO sign-off on the six columns (email, name, first name, job title, N+1 name, N+1 email) and on the memory consent sentence. |
| `DIRECTORY_PUSH_SECRET` (secret) | DNA push, the recommended option: a DNA/HR job posts rows to `POST /api/directory/push` with this bearer secret; add a Cloudflare Access bypass for `/api/directory/push` only. Production mode only. |
| `DNA_PROFILE_URL`, `DNA_AUTH_HEADER`, `DNA_FIELD_MAP`, `DNA_API_KEY` (secret) | DNA pull, shape **ASSUMED** (not confirmed by Mantu IT): https template with one `{email}` or `{oid}`, header name (default `Authorization`), JSON field map, and the full header value. Never called when push is set. Production mode only. |
| DNA export CSV | An admin uploads it in Insights → People directory; only the six approved columns leave the browser. Real exports only in production mode. |
| `ATLAS_HOME_URL` (build time) | Overrides the live address baked into saved HTML copies (their one "Open ATLAS" link). Default: `vars.ORIGIN` in `wrangler.jsonc`. Must match `^https://[a-z0-9.-]+$`, else empty. |
| Teams | Connected once `TEAMS_APP_ID`, `TEAMS_TENANT_ID` and the secret `TEAMS_BOT_SECRET` are set; `TEAMS_ENABLED` is gone and `TEAMS_BOT_APP_ID` defaults to `TEAMS_APP_ID`. |
| Entra name claims | `entra/enable_entra.sh` appends `name`, `given_name`, `family_name` after the identity claims (Access trims from the end). Mantu IT adds the `given_name`/`family_name` optional claims. |
| Removed | `SPOKEN_ASK` and `PDF_BRIEFS` (replaced by D1 and D2), `TEAMS_ENABLED`. |
| **D1** spoken Ask (Tony confirms) | A code constant, `SPOKEN_ASK_APPROVED` in `deploy/cloudflare-edge/src/features.js`, `true` in this tree (D1 recorded as approved on 2026-09-29; set it back to `false` and spoken Ask is simply absent). A voice question in Ask asks for consent at the moment of use ("Allow this time" / "Always allow for me", stored in the profile, revocable), shows "Don't say client names" and a recording indicator on every recording, and the Worker checks the consent before transcribing. |
| **D2** PDF briefs (recorded) | PDF briefs follow bids. Workers AI `toMarkdown` on a PDF is text extraction (re-verified 2026-09-29), run with PDF metadata off; images stay refused; a scanned PDF with no text gets an explicit message. Re-check at each dependency review. |

Private memory stays in the one consent sentence whenever `HINDSIGHT_API_KEY` is set and the person's memory switch is on; without the key the sentence and the switch are absent.

### Agent Brain v2.1 switches (Cloudflare edge Worker variables)
All optional; each default is the new behaviour and the legacy value is the rollback. Verified in code (`session.js sessionFlags`, `app.js`, `checkpoint.js`, `adapters.js`); not exercised against a deployed Worker. Rollback of a deployed build is a Worker version rollback (Tony). Overview with the reasoning: `AGENT.md` section 5.

| Variable | Default | Contract |
|---|---|---|
| `ATLAS_SELECTOR` | `v2` | `legacy` restores the analyst guidance one turn late (selector off) |
| `ATLAS_REPLY_GUARD` | `on` | `off` removes the code enforcement of one question, praise, repeated openers and length |
| `ATLAS_ACKS` | `content` | `legacy` restores the content-blind fillers |
| `ANALYST_WAIT_MS` | `0` | Milliseconds (at most 1500) to wait for the analyst while the acknowledgement plays; Tony chose 0 |
| `TALKER_MAX_TOKENS` | `160` | Maximum tokens of a spoken reply (was 300) |
| `SPECULATIVE_STT` | off | Reserved. Read, no effect: speculative transcription is not built |
| `ASR_CONFIRM_TAU` | `0.55` | Recogniser confidence below which a number or name is confirmed aloud. Uncalibrated pilot value |
| `ATLAS_CHECKPOINT` | on | `off`: no interview checkpoints (no resume). Checkpoints need transcript consent and last 24 hours from the first write |
| `ATLAS_EVIDENCE_WORKFLOW` | `on` | `off`: a confirmed summary is not filed; fan-out, status and sync routes off |
| `ATLAS_ADAPTERS` | `off` | `mock` runs the four destination mocks; `live` is refused (`BLOCKED_EXTERNAL`: no owner contract exists) |

Privacy facts for the consent text (24-hour checkpoint, text mode, keep private, drafts): `docs/INTEGRATIONS.md`, "Privacy and consent wording for the interview". The consent dialog does not yet mention the checkpoint.

### Platform security (B1, 2026-10-31; runbook: `handoff/SECURITY_RUNBOOK.md`)
Verified in code and unit tests; not exercised against a deployed Worker.

| Variable | Default | Contract |
|---|---|---|
| `HINDSIGHT_BANK_SECRET` (secret) | none | **Required whenever `HINDSIGHT_API_KEY` is set.** Without it memory is switched off with a clear message (bootstrap `memory:false`, `/api/memory` 503, interviews start without memory). Derivation unchanged when set. Existing deployment: set it to `atlas-hindsight:` + the current `CSRF_SECRET` to keep every bank |
| `HINDSIGHT_ALLOW_DERIVED_BANK` | off | `1`: the old derivation from `CSRF_SECRET` for a short transition (do not rotate `CSRF_SECRET` while on) |
| `ATLAS_READ_ONLY` | off | `1`: every non-GET request and every new interview answers 503 |
| `ATLAS_AI_OFF` | off | `1`: no model call anywhere; interview start and sheet/classify/transcribe answer 503 politely; library review/embeddings/JEV rating off |
| `ATLAS_BLOCKED_SUBS` | none | Comma list of subject keys from the security log (`subj`, at least 12 hex characters): 403 for those people |
| `ATLAS_EXTERNAL_OFF` | off | `1`: the external confirmer role, `/confirm` and `/api/library/confirmations/*` answer 403 |
| `ATLAS_INBOUND_OFF` | off | `1`: triggers, DNA push, Teams bot and tab answer 503 before any secret is checked |
| `RL_INTERVIEW_HOUR`, `RL_INTERVIEW_DAY` | 6, 20 | Fresh interview starts per person (a resume is not a start). Product-visible: Tony decides the numbers |
| `RL_SHEET_HOUR`, `RL_CLASSIFY_HOUR`, `RL_TRANSCRIBE_HOUR` | 20, 30, 60 | Requests per person per hour |
| `ATLAS_CSRF_BIND` | bound to the sign-in | `sub`: bind the CSRF token to the person only (the old behaviour). A rollback for one risk: if Access re-mints the application token (a new `iat`) while a page stays open, an open page's token goes stale until it reloads. **Not yet observed on a real Access deployment**; if 403 CSRF errors appear after long idle periods, set this and tell the owner |
| `LOG_SALT` (secret, optional) | derived from `CSRF_SECRET` | Key for the hashed network address in security events |
| `ACCESS_JWKS_TIMEOUT_MS` | 3000 | Timeout of the Access signing-key fetch (50 to 10000) |

Switch values are `1`, `true`, `on` or `yes`; anything else is off. Switches are Worker variables: a change needs a deploy. The CSRF token is now bound to the Access sign-in (it changes at each new sign-in); the page re-reads it after its own re-sign-in flow, but not after a silent token re-issue (see `ATLAS_CSRF_BIND`; a later frontend wave should re-read `/api/bootstrap` once on a CSRF 403).

### Optional NVIDIA / Riva route
Use `ATLAS_VOICE_PROVIDER=personaplex`; follow `docs/NVIDIA_SETUP.md`. Run `doctor.py --profile nvidia` for local prerequisite checks. Hosted credentials do not create a NVIDIA service.

| Variable | Contract |
|---|---|
| `PERSONAPLEX_WS_URL` | Defaults to dedicated `ws://127.0.0.1:8998/api/chat`; no public raw worker. |
| `PERSONAPLEX_VOICE` | Default `NATM1.pt`; allowed natural preset list in `config.py`. |
| `FFMPEG` | Executable name/path, default `ffmpeg`; libopus required for NVIDIA codec. |
| `RIVA_URI` / `RIVA_SSL` | Actual `host:port`, default SSL true; remote Riva needs TLS. |
| `RIVA_API_KEY`, `RIVA_FUNCTION_ID`, `RIVA_MODEL` | Actual deployment-specific metadata/model; do not guess values. |
| `NOTES_CHAT_URL` | Full approved chat-completions URL for optional exact-excerpt assignment. |
| `NOTES_MODEL` / `NOTES_API_KEY` | Required actual model with that URL; key when required. |

Riva capture is separately consented; without it PersonaPlex can converse but does not supply a consultant transcript. These optional integrations are not equivalent to the hosted live tool ledger.

### Optional narrative and matching
| Variable | Contract |
|---|---|
| `STORY_EDITOR_MODEL` | Empty disables external rewriting. Operator selects an approved structured-output model. Uses `OPENAI_API_KEY`. |
| `TYPESAFE_API_KEY` | Server-only TypeSafe authorization. Missing key must never produce a fabricated score. It enables five paths (story rating, private-memory relevance, the next-question ranker, project classification, bid ranking) plus the admin connection test; **only story rating asks per-owner consent** (`jevRating`). See `docs/INTEGRATIONS.md` "TypeSafe (JEV)". |
| `JEV_MODEL` | Example candidate `jev-1.13.0`; confirm API/account availability. Not claimed as latest. Story rating does **not** read it: it pins `jev-1.13.0` in `rating.js`, so setting `JEV_MODEL` for another path never re-pins story rating or invalidates its calibration. |

JEV's four required brief fields are `problem`, `buyer`, `constraints`, `desired_outcome`. Only current eligible `customer-anonymized` stories enter this route after explicit consent. The Graphify consumer has no runtime environment variable because native Graphify execution is not part of this application.

## Common mistakes
| Symptom | Check |
|---|---|
| Orb works, no voice | A static file/preview has no voice backend. Open the configured gateway; verify credentials and model readiness. |
| HTTP 403 | Exact Host/Origin, CSRF and correct session; do not disable protections. |
| Voice key appears ignored | Launcher sources `.env`; a direct module launch only sees exported environment. Check explicit provider selection. |
| Busy interview | One active session per gateway; end it or wait. Do not add replicas as a workaround. |
| Cannot approve a story | Author is not allowed to self-approve; reviewer needs Entra role **and** story access; missing source/unknowns also block. |
| Hindsight changes not visible | Distinct authenticated subject, stable bank secret, actual SDK/fork compatibility and explicit save/recall consent. |
| JEV returns no match | May be correct: no eligible record, no shortlist overlap, poor fit or unresolved evidence/date/confidence. |
| Vault lost after redeploy | Configure a private persistent path and joint backup/restore; ephemeral container storage is not durability. |
