# VibeApps packaging

The gateway that VibeApps runs is still one process. This note records that limit, the headers and path the platform uses, and the Key Vault secret names. It does not connect to Postgres, Blob storage, or Key Vault. The adapters in `atlas_voice/multiinstance.py` refuse to connect.

`ATLAS_PORT` defaults to **8080**. That default is the port the VibeApps application manifest publishes. The process listens on `ATLAS_PORT` and does not open a second port. `ATLAS_ORIGIN` stays `scheme://host:port` with no path. The platform must preserve the Host header so it matches that origin.

## What one process holds today

| State | Where it lives | What breaks with a second process |
|---|---|---|
| Signed-in sessions | `Identity.sessions`, an in-memory dict (`atlas_voice/identity.py`) | A session cookie issued on one process is unknown on another. |
| Pending Entra sign-ins | `Identity.flows`, capped at 100 in the same dict | The cap and the flow record are per process. |
| Interview slots | `VoiceCapacity.holders`, an in-memory set (`atlas_voice/capacity.py`) | Two processes can each fill `ATLAS_MAX_INTERVIEWS`. |
| Live voice sockets | `active` dict in `server.py`, and the same map passed into `realtime.py` and `cascade.py` | Logout on one process cannot close a socket on another. |
| Ranking and editor locks | `rank_gate` and `editor_gate`, `asyncio.Lock` inside `knowledge_routes.install` | Two processes can run two rankings or two edits at once. |
| Preference throttle | `preference_times` dict in `server.py` (10 seconds, map capped at 1000) | Each process counts separately. |
| Analyst turn order | `Analyst.lock`, one `asyncio.Lock` per interview | It only orders turns inside that process. |
| Wiki registry | SQLite file `registry.sqlite3` in `WikiVault` (`stories`, `access`, `approvals`, `audit`) | SQLite is one writer. Two processes on one file are not a shared registry. |
| Story revisions | Markdown files under the vault directory, one immutable file per revision | Those files are local disk, not shared Blob storage. |

Private memory stays a separate Hindsight service. It is not the wiki registry and it is not evidence.

## What more than one instance requires

Postgres for the shared rows: sessions, the interview lock, the ranking and editor locks, the preference throttle, and the wiki tables `stories`, `access`, `approvals`, and `audit`.

Blob storage for the immutable Markdown revisions. The registry row points at a revision. The bytes of that revision have to be readable from every instance.

`PostgresAdapter` and `BlobAdapter` are the names of that contract. Constructing one does not connect. `connect`, `session`, `lock`, `throttle`, `registry`, `put`, and `get` raise `AdapterRefused`. They do not keep the DSN or the Blob URL. The running gateway does not call them. Do not treat an import of the module as a connected database.

## Identity

`ATLAS_AUTH` is `local`, `entra`, or `vibeapps`.

`vibeapps` accepts identity only from these three headers, each exactly once:

- `X-Forwarded-User-Email`
- `X-Forwarded-User-Name`
- `X-Forwarded-User-Id`

Any other `X-Forwarded-User-*` header is rejected. A missing or repeated header is rejected. `Authorization` is not an identity. A cookie from `local` or `entra` is not an identity in this mode. `local` and `entra` ignore the three headers.

The subject is `vibeapps` plus `X-Forwarded-User-Id`. The email is checked and is not the subject key. The name is the display name. No header on this list carries `ATLAS.Review`, `ATLAS.Publish`, or `ATLAS.Admin`, so this mode cannot approve or publish. Those roles stay on the Entra path.

The platform is the only legitimate source of the three headers. The app trusts them in `vibeapps` mode. Do not expose that mode except through the platform.

`vibeapps` requires `APP_BASE_PATH` to be `/run/atlas/` or `/run/atlas-dev/`. It does not require an Entra client secret. Off loopback, `ATLAS_ORIGIN` is still `https://`.

## Path

`APP_BASE_PATH` is empty, `/run/atlas/`, or `/run/atlas-dev/`. Empty means the current root routes, which is the local and Entra default. A value without the trailing slash is accepted and stored with one.

When the prefix is set, the page and `/api/*` and `/auth/*` are served under it. `/api/bootstrap` at the host root is not the app, and a request outside the prefix does not open a session. The page runtime JSON includes `basePath` so same-origin fetches and the voice socket use that prefix. The session cookie path is the prefix without a trailing slash, so `/run/atlas` and `/run/atlas/` share it and `/run/atlas-dev` does not.

## Key Vault secret names

Names only. No values are written here, in `.env.example`, or in the adapters. The process does not read Key Vault.

| Key Vault secret name | Environment variable |
|---|---|
| `openai-api-key` | `OPENAI_API_KEY` |
| `kyutai-api-key` | `KYUTAI_API_KEY` |
| `conversation-api-key` | `CONVERSATION_API_KEY` |
| `analyst-api-key` | `ANALYST_API_KEY` |
| `typesafe-api-key` | `TYPESAFE_API_KEY` |
| `entra-client-secret` | `ENTRA_CLIENT_SECRET` |
| `hindsight-api-key` | `HINDSIGHT_API_KEY` |
| `hindsight-bank-secret` | `HINDSIGHT_BANK_SECRET` |
| `riva-api-key` | `RIVA_API_KEY` |
| `notes-api-key` | `NOTES_API_KEY` |
| `workers-ai-api-key` | `WORKERS_AI_API_KEY` |

Edge Worker secrets (Teams, directory push, DNA) are set on that Worker. They are not in this table.
