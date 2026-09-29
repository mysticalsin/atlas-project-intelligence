# ATLAS integrations

## Roles
- Access mode: `ADMIN_EMAILS`, `REVIEWER_EMAILS` (comma separated, verified sign-in email). Everyone else is a consultant.
- Entra mode (`IDENTITY_SOURCE=entra`): app roles `ATLAS.Admin`, `ATLAS.Reviewer`; the library identity is `tid:oid`.
  Email lists are ignored in Entra mode.
- The N+1 named on a record can validate that record. Record people (owner, listed consultants, N+1) and reviewers see
  client details; everyone else sees published references with client details removed and scrubbed.
- External confirmer (Access mode only): a verified email listed exactly in `EXTERNAL_EMAILS` (never a domain rule). It
  reaches only `GET /confirm`, a reduced `/api/bootstrap`, `GET /api/library/confirmations/inbox` and
  `POST /api/library/confirmations/:id`; `GET /` answers 303 to `/confirm` and everything else 403. Unset by default.
- Gap requests (F2) and claim confirmations (F3) authorise people by the Access-verified email, so they run in Access
  mode only; with `IDENTITY_SOURCE=entra` their words answer 404 and their `features` flags are false.

## Project-management system → interview invitations
`POST https://<atlas>/api/triggers` with `Authorization: Bearer <TRIGGER_SECRET>` and JSON:
```json
{ "email": "consultant@mantu.com", "reason": "project_end | milestone | periodic_review",
  "projectId": "PRJ-2291", "title": "Claims triage rollout", "slot": "2026-10-02T10:00" }
```
- Optional fields `managerEmail`, `managerName` and `endDate` (`YYYY-MM-DD`) also store a staffing row (the N+1 of
  record for F3 confirmations) and queue two outreach rows (Teams and email draft) waiting for approval.
- `201` with the invitation. Repeated calls for the same person, reason and project return the open invitation.
- Set the secret: `npx wrangler secret put TRIGGER_SECRET`. Without it the endpoint answers `401`.
- Cloudflare Access protects the whole app, so add an Access **bypass** policy for the path `/api/triggers` only; the
  bearer secret (compared in constant time) protects it instead.
- A daily cron (`17 6 * * *`) invites the owner of every reference not updated for six months (`six_month_update`).
- The same cron also expires gap and confirmation requests, invites consultants whose staffing end date is due, queues
  their outreach rows and prunes old Teams events. It never sends anything.
- Nothing is emailed. Consultants see invitations under Library → *Your interviews*, with an `.ics` calendar file.
  Teams messages are built but not connected (`BLOCKED_EXTERNAL`, see *Teams* below).

## Staffing import and the outreach queue (F4; admins and reviewers)
- `POST /api/library/staffing/import {csv}` (≤ 200,000 characters, ≤ 2,000 rows). Header row
  `project_id,consultant_email,manager_email,manager_name,project_title,end_date`. Any other column, and so any client,
  customer or account column, is dropped unread and listed in `ignoredColumns`. Rejected rows come back with line
  numbers. A row whose end date is between 30 days ago and 7 days ahead, with no reference yet, gets a `project_end`
  invitation plus outreach rows. `GET /api/library/staffing?project=<id>` lists stored rows.
- `GET /api/library/outreach` lists rows; `POST /api/library/outreach/:id {action: approve | dismiss}` acts on one row:
  an approved email becomes a draft `{to, subject, body, ics?}` the approver sends from their own mail client; an
  approved Teams row ends `blocked_external` with the reason until Teams is connected; phone is always
  `blocked_external`; a row whose invitation or request is no longer open is dismissed, never sent.

## Teams (F4): built, not connected
- Pre-Access endpoints: `POST /api/teams/messages` (Bot Framework activities, verified signature, issuer, audience,
  tenant, service URL and size) and `GET /teams/tab` (a launcher tab that opens ATLAS in the browser). Both answer 503
  `BLOCKED_EXTERNAL` until `TEAMS_ENABLED=1`, `TEAMS_APP_ID`, `TEAMS_BOT_APP_ID` and `TEAMS_TENANT_ID` are set.
- Secret `TEAMS_BOT_SECRET` (`wrangler secret put`, by Tony). Optional var `TEAMS_SERVICE_HOSTS` (comma-separated host
  names) extends the connector allow-list beyond `smba.trafficmanager.net`.
- Access needs a **bypass** policy for exactly `/api/teams/messages` and `/teams/tab`; every other path stays behind Access.
- Package and IT checklist: `deploy/cloudflare-edge/teams/README.md` (manifest v1.30 template, placeholder icons, builder
  that refuses placeholders). TeamsJS 2.57.0 is vendored in `teams/vendor/` (version and SHA-256 in
  `docs/THIRD_PARTY.md` and `docs/SOURCE_LOCK.json`). No Microsoft endpoint has been called.

## Claim confirmation page (F3)
- A confirmation request gives the requester a `mailto:` draft whose body is only `<ORIGIN>/confirm#<request id>`: no
  claim text and no client name. The id is not a secret; the confirmer must sign in with the addressed email.
- `GET /confirm` is a self-contained page (no external script or URL) that lists the signed-in person's open requests
  and posts their decisions (confirm, correct with a note, can't say).
- Client contacts as confirmers stay off until `CLIENT_CONFIRM=1`, their exact emails in `EXTERNAL_EMAILS` and an Access
  One-time PIN policy for them (Tony's Q3).

## Spoken Ask (F6): off
`POST /api/transcribe` (raw `audio/L16;rate=24000`, ≤ 30 s, Origin and CSRF) answers 404 unless `SPOKEN_ASK=1`. It sends
question audio to Workers AI speech-to-text outside the interview consent, so it stays off until Tony approves (Q11).

## Spotlight Ref exchange (`atlas.reference.v1`)
- Export (reviewers): `GET /api/library/export` →
  `{ "schema": "atlas.reference.v1", "exportedAt", "references": [{ "id", "owner", "status", "revision", "updatedAt", "quality", "reference": {…} }] }`
  The export includes confidential client details: handle it as internal data.
- Import (reviewers): `POST /api/library/import` with `{ "references": [{ "externalId": "sp-123", "reference": {…} }] }`
  (max 500 per call). Imports are idempotent on `externalId`, bounded by the same server validation as interviews,
  reviewed by the review agent and published only after N+1 validation, like any other record.
- `reference` fields: `title, stage, sector, consultant{name,role}, client{name,location,contact}, details{projectId,
  country, start, end, duration, teamSize, teamRoles[], technologies[], deliverables[], serviceLines[],
  consultants[{name,email,role}], links[{label,url}]}, answers[6] (context, contribution, approach, outcome, evidence,
  customer relevance), report, jev, validation{manager{name,email}, managerStaff}, sources[{name,version,url,excerpt}]`.

## Library API (signed-in users; POST needs `Origin` + `X-Atlas-CSRF` from `/api/bootstrap`)
| Method | Path | Who |
|---|---|---|
| GET | `/api/library?q&status&country&industry&practice&service&tech&mine` | everyone (visibility rules apply) |
| POST | `/api/library` `{localId, id?, reference}` | owner / record people / reviewers |
| GET | `/api/library/:id`, `/api/library/:id/revisions/:n` | record people / reviewers; others: published only |
| POST | `/api/library/:id/review`, `/withdraw` | record people / reviewers |
| POST | `/api/library/:id/validate` `{decision: validate | request_changes, note}` | the record's N+1 / reviewers |
| POST | `/api/library/:id/reinstate`, `/api/library/merge` `{keep, merge}` | reviewers |
| POST | `/api/library/recommend` `{query, limit}` | everyone |
| POST | `/api/library/:id/slides` `{context, includeClient}` | published, or record people |
| GET | `/api/library/analytics` | everyone (client counts: reviewers) |
| POST | `/api/library/insights` | reviewers |
| GET/POST | `/api/library/invitations[/:id]` | own invitations; reviewers create for others |
| POST | `/api/library/bids` `{title, alias, prospectNames?, briefText}`; GET `/api/library/bids[?all=1]`, `/:id` | everyone creates their own; owner, reviewers, admins read |
| POST | `/api/library/bids/:id/requirements`, `/match`, `/onepager`, `/use`, `/outcome`, `/delete` | owner (and admins); match, one-pager, use, outcome also reviewers |
| POST/GET | `/api/library/gaps`, `/gaps/:id`, `/gaps/:id/interview`, `/answer`, `/dismiss` | bid owner creates; assignee answers (Access mode only) |
| GET/POST | `/api/library/claims/:refId`, `/api/library/claims` | full access to the reference / editors (Access mode only) |
| GET/POST | `/api/library/confirmations`, `/confirmations/inbox`, `/confirmations/:id`, `/:id/cancel` | editors create; the addressed email decides (Access mode only) |
| POST | `/api/library/ask` `{question, limit?}` | everyone (not external) |
| GET | `/api/library/wins`, `/api/library/wins/guidance` | everyone (per-story rows: reviewers, admins, the story's own people) |
| GET/POST | `/api/library/outreach[/:id]`, `/api/library/staffing[/import]` | reviewers, admins |

Every new word answers 404 while its module is not READY (`deploy/cloudflare-edge/src/features.js`). Contracts and
types: `docs/WOW_SPEC.md` §3.

## Private memory (Hindsight, hindsight.vectorize.io)
- One bank per person: `atlas-` + HMAC(`HINDSIGHT_BANK_SECRET`, or a labelled derivation of `CSRF_SECRET`, over the
  verified subject). The Worker sets it in `x-atlas-bank`; the browser never names a bank.
- After each interview the browser asks the server to remember it: one `project-<id>` document (upserted with
  `update_mode: replace`, so it never duplicates) and one dated `conversation-<id>-<time>` document, tagged
  `project:<id>`. Client name, location and contact are replaced by "the client" before anything leaves ATLAS.
- Before each interview the person's Durable Object recalls (`budget: low`, tag-scoped to the project, 3.5 s cap)
  and gives the talker a PRIVATE MEMORY note. With `TYPESAFE_API_KEY`, JEV (Noul) drops recalled memories from other
  projects that would not help this interview.
- API contract checked against `@vectorize-io/hindsight-client` 0.10.1: `PUT /v1/default/banks/{bank}` (missions),
  `POST .../memories` `{items, async}`, `POST .../memories/recall`, `GET .../documents`, `DELETE .../documents/{id}`,
  `DELETE .../banks/{bank}`, `Authorization: Bearer <key>`.
- People control it in their profile: list, forget one, forget everything, switch off (`memoryOff` in their own
  Durable Object). Admins can test the Hindsight and JEV connections there.
- Secrets: `bash deploy/cloudflare-edge/set-keys.sh` (hidden dialogs → `HINDSIGHT_API_KEY` (Hindsight Cloud `https://api.hindsight.vectorize.io` is the default; `HINDSIGHT_URL` only for self-hosting),
  `TYPESAFE_API_KEY`). Memory is private continuity, never evidence, and never feeds the library or a report as fact.

## Languages
- Understanding: Deepgram Nova-3 on Workers AI with `STT_LANGUAGE=multi` (automatic detection and code-switching):
  English, French, Spanish, Portuguese, German, Italian, Dutch, Russian, Hindi, Japanese.
- The browser's language opens the conversation; after that ATLAS follows each clear utterance (three words or more,
  not an echo) and switches with the consultant. The talker gets a LANGUAGE note every turn.
- Speaking: English (Aura-2 `harmonia`) and Spanish (Aura-2 `aura-2-es`, `TTS_VOICE_ES`, default `celeste`) on Workers
  AI with no extra key. Every other language uses ElevenLabs Flash v2.5 (`ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`,
  raw `pcm_24000`, 32 languages). Without that key ATLAS still understands the language, answers in English and says so
  once.
- Reports and the shared library stay in English (faithful translation), so search and review work across languages;
  the interview transcript keeps the original words.
