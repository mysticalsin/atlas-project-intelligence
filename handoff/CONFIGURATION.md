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
| `ATLAS_MAX_SECONDS` | `900` | Session cap; code accepts 30–1800 seconds. |
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
| `TYPESAFE_API_KEY` | Server-only TypeSafe authorization. Missing key must never produce a fabricated score. |
| `JEV_MODEL` | Example candidate `jev-1.13.0`; confirm API/account availability. Not claimed as latest. |

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
