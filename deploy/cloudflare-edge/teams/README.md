# ATLAS in Microsoft Teams: BUILT, NOT CONNECTED

This folder holds the Teams app package for ATLAS (WOW_SPEC §F4.3 to §F4.6). The code is built and tested locally with fake Microsoft endpoints only. **Nothing is connected**: there is no Mantu tenant, no app registration, no bot secret and no Azure Bot resource. Until the items below exist, both Teams paths answer `503 BLOCKED_EXTERNAL` and the bootstrap flag `features.teams` reads `BLOCKED_EXTERNAL`.

## What Teams does in ATLAS
- **A proactive card, only after approval.** When a project ends (webhook, staffing import or the daily sweep), ATLAS queues an `interview_invite` outreach row as `pending_approval`. A reviewer or admin approves that exact row in Insights; only then is the card sent. Nothing is ever sent automatically. In this build every Teams approval ends `blocked_external`.
- **The card** ("12 minutes while it's fresh?", Adaptive Card 1.5) has three actions:
  - "Start now" opens the browser app at `https://<ATLAS host>/#invitation/<id>`;
  - "Tomorrow" moves the invitation by one day;
  - "Not for this project" dismisses it.

  "Tomorrow" and "Not for this project" work only for the person the card was sent to (same Entra object id and tenant). Anyone else sees "This card belongs to someone else." and nothing changes.
- **Typing `stop`** in the bot chat stops further cards to that person. The bot never replies and never sends on its own.
- **The personal tab** is a launcher only: "Open ATLAS" opens the browser app. It shows no data and calls no API. There is no in-tab interview, no Teams SSO and no microphone permission (Q9).
- **The interview itself always runs in the browser**, signed in through Cloudflare Access as today.

## Credentials and IT checklist (WOW_SPEC §5)
Only Mantu IT, the Azure owner, the Teams admin or Tony can do these. Never simulate them.

| # | Item | Who | Where it goes |
|---|---|---|---|
| 1 | Mantu tenant (directory) ID | Mantu IT (Entra) | Worker var `TEAMS_TENANT_ID` |
| 2 | Single-tenant app registration "ATLAS Teams" | Mantu IT (Entra) | its Application (client) ID in `TEAMS_APP_ID` and `TEAMS_BOT_APP_ID` (the same value) |
| 3 | Client secret (or certificate) of that registration | Mantu IT | Worker secret `TEAMS_BOT_SECRET`, set by Tony with `wrangler secret put TEAMS_BOT_SECRET` (never in a file or a var) |
| 4 | Azure Bot resource: pricing tier F0, type Single Tenant, messaging endpoint `https://<ATLAS host>/api/teams/messages`, Microsoft Teams channel enabled | Azure subscription owner | Azure portal |
| 5 | Allow custom app upload, or publish the package to the org catalog; optionally a setup policy that pins the app | Teams admin | Teams admin center |
| 6 | Cloudflare Access **bypass** policy for exactly `/api/teams/messages` and `/teams/tab` (every other path stays behind Access) | Tony | Cloudflare Zero Trust dashboard |
| 7 | Worker vars `TEAMS_ENABLED=1`, `TEAMS_APP_ID`, `TEAMS_BOT_APP_ID`, `TEAMS_TENANT_ID` | Tony | manual deploy, when nobody is interviewing |
| 8 | Brand-approved icons: `color.png` 192×192 and `outline.png` 32×32 (white on transparent) | Mantu brand owner | replace the two placeholders in this folder |
| 9 | Device check that the launcher's `app.openLink` opens ATLAS in the browser on Windows, Mac, web, iOS and Android | Tony, with a test tenant | UNVERIFIED |

Optional: `TEAMS_SERVICE_HOSTS` (comma-separated host names) extends the connector host allow-list beyond `smba.trafficmanager.net`, for example for a government cloud.

## Build the package
```sh
# Draft (placeholders and placeholder icons kept): writes teams/dist/atlas-teams-DRAFT.zip and prints "DRAFT: not uploadable"
python3 deploy/cloudflare-edge/teams/build_teams_package.py --draft

# Real package: every value set and the brand icons in place, else it refuses and lists why
TEAMS_APP_ID=<guid> TEAMS_BOT_APP_ID=<guid> ATLAS_HOST=<host, no scheme> \
TEAMS_DEVELOPER_NAME='<name>' TEAMS_DEVELOPER_WEBSITE_URL=https://… TEAMS_PRIVACY_URL=https://… TEAMS_TERMS_URL=https://… \
python3 deploy/cloudflare-edge/teams/build_teams_package.py
```
- The builder fills the `{{NAME}}` placeholders of `manifest.template.json` from those environment variables. It refuses to build while any placeholder or placeholder icon remains, unless you pass `--draft`.
- It validates the manifest. If `schema/MicrosoftTeams.schema.v1.30.json` is vendored, it uses that schema (required fields, lengths, enums and patterns; other schema keywords are ignored). Otherwise it uses a built-in list of the required fields, lengths and enums this package uses.
- It checks the icon sizes and the outline transparency, then zips `manifest.json`, `color.png` and `outline.png` at the root of the archive.
- The Microsoft schema is **not vendored**: this build was not allowed to call Microsoft endpoints. To vendor it, download `https://developer.microsoft.com/json-schemas/teams/v1.30/MicrosoftTeams.schema.json` into `schema/MicrosoftTeams.schema.v1.30.json` and record its SHA-256 in `docs/THIRD_PARTY.md`.
- `--make-placeholder-icons` rewrites the two generated placeholders (a plain ring). They are marked inside the PNG as placeholders, and they are not the Mantu logo.

Tests: `python3 -m pytest tests/test_teams_package.py -q`.

## Security model of the bot endpoint (`src/teams.js`, `src/teams-routes.js`)
- **Pre-Access, on the main host, exactly two paths.** `POST /api/teams/messages` and `GET /teams/tab`. Any other `/api/teams/*` path stays behind Access. With `TEAMS_*` vars set but `TEAMS_ENABLED` unset, every other Worker response is unchanged (tested in `test/app.test.js`).
- **Bot Framework connector authentication, no SDK.** `verifyBotActivity` checks:
  - an RS256 token whose key comes from the Bot Framework OpenID metadata and JWKS. Keys are cached for 24 hours, and a refetch (expired cache or unknown key id) happens at most once per 5 minutes;
  - issuer `https://api.botframework.com` only (no Entra first-party issuer, no emulator token; Q5), audience `TEAMS_BOT_APP_ID`, and `exp`/`nbf` within 300 seconds;
  - the token's service URL claim equals the activity's `serviceUrl`, on the host allow-list;
  - channel `msteams`, and a signing key endorsed for `msteams`;
  - recipient `28:<bot id>`;
  - tenant `TEAMS_TENANT_ID`;
  - a body of at most 262,144 bytes.
- **Dedupe and binding in the LibraryStore.** Events are forwarded to the LibraryStore system word `teams-event`, which dedupes activity ids (`teams_seen`, pruned after 2 days by the daily sweep). A card action applies only when the actor's object id and tenant match the outreach row the card was sent on.
- **Outbound, only for an approved row.** `teamsClient` gets a tenant-specific client-credentials token (cached until 5 minutes before expiry). It posts to `{serviceUrl}v3/conversations/{id}/activities`, retries 429, 412, 502 and 504 at most twice, and refuses a service URL outside the allow-list. At install time it also looks the member up, to store an email **for routing only** (never for authorisation).

## Known behaviour of the launcher tab
TeamsJS 2.57.0 tries to fetch `https://res.cdn.office.net/teams-js/validDomains/json/validDomains.json` when it loads. The tab's CSP (`default-src 'none'`, as the spec requires) blocks that fetch, so the browser console shows a CSP message. TeamsJS then falls back to the valid-origins list bundled in the file ("Defaulting to fallback list" in the 2.57.0 source), which includes `teams.microsoft.com`. This was checked locally in Chromium: the bundle loads under the tab CSP with no page error, and outside Teams the button says so. If Tony wants Microsoft's live list instead, add `connect-src https://res.cdn.office.net` to `TAB_CSP` in `src/teams-routes.js`; that is a decision, not a fix.

## Not verified (needs a test tenant)
- Real Bot Framework tokens: the claim name of the service URL. The code accepts `serviceurl` (the Bot Framework SDK constant) or `serviceUrl`.
- The error codes Teams returns when a user blocks the bot. The code marks the conversation `stopped` on `403 MessageWritesBlocked`, as the spec says.
- Manifest schema v1.30: the version number and required fields come from the spec, not from a fetched schema.
- `app.openLink` behaviour on each Teams client (Q9).

## Phone interviews (F4.5): BLOCKED_EXTERNAL
There is no phone code. The `phone` outreach channel always answers `blocked_external`. It needs either a Twilio account (SID, Auth Token, number, budget and DPA), or Teams Phone with an existing Azure Communication Services resource (ACS stops accepting new customers on 2026-10-23). The seam, if it is ever built: a future `/api/phone/stream` would translate μ-law 8 kHz audio into the `Session.onBinary` PCM16 24 kHz input.
