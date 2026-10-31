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
  tenant, service URL and size) and `GET /teams/tab` (a launcher tab whose "Open ATLAS" opens `<ORIGIN>/go/start` in the
  browser). Both answer 503 `BLOCKED_EXTERNAL` until Teams is connected: `TEAMS_APP_ID`, `TEAMS_TENANT_ID` and the secret
  `TEAMS_BOT_SECRET` all set. There is no on switch (`TEAMS_ENABLED` is no longer read), and `TEAMS_BOT_APP_ID` defaults
  to `TEAMS_APP_ID` (set it only when the bot has its own app registration).
- Secret `TEAMS_BOT_SECRET` (`wrangler secret put`, by Tony). Optional var `TEAMS_SERVICE_HOSTS` (comma-separated host
  names) extends the connector allow-list beyond `smba.trafficmanager.net`.
- Access needs a **bypass** policy for exactly `/api/teams/messages` and `/teams/tab`; every other path stays behind Access.
- Package and IT checklist: `deploy/cloudflare-edge/teams/README.md` (manifest v1.30 template, placeholder icons, builder
  that refuses placeholders). TeamsJS 2.57.0 is vendored in `teams/vendor/` (version and SHA-256 in
  `docs/THIRD_PARTY.md` and `docs/SOURCE_LOCK.json`). No Microsoft endpoint has been called.

## Claim confirmation page (F3)
- A confirmation request gives the requester a `mailto:` draft whose body is only `<ORIGIN>/go/confirm/<request id>`
  (it answers 302 to `/confirm#<request id>`, also for an external confirmer): no claim text and no client name. The id
  is not a secret; the confirmer must sign in with the addressed email.
- The N+1 who confirms: the staffing record (F4) first, then the owner's N+1 in the stored DNA directory (a `dna` or
  `dna_export` row, never the owner's own profile edits; badge "N+1 from DNA"), then the N+1 named on the reference.
- `GET /confirm` is a self-contained page (no external script or URL) that lists the signed-in person's open requests
  and posts their decisions (confirm, correct with a note, can't say).
- Client contacts as confirmers stay off until `CLIENT_CONFIRM=1`, their exact emails in `EXTERNAL_EMAILS` and an Access
  One-time PIN policy for them (Tony's Q3).

## Spoken Ask (F6): follows D1
`POST /api/transcribe` (raw `audio/L16;rate=24000`, ≤ 30 s, Origin and CSRF) answers 404 while `SPOKEN_ASK_APPROVED` (a
code constant in `deploy/cloudflare-edge/src/features.js`, not a variable; the old `SPOKEN_ASK` is gone) is false. It is
`true` in this tree: D1 was recorded as approved on 2026-09-29 (docs/WOW_ZERO_CONFIG.md §4). Every request needs the consent prompt's
header `X-Atlas-Consent: spoken-ask-v1; once|always` (403 "Voice questions need your consent first." without it). The
header is a UI gate; for `always` the Worker also reads the person's stored consent (`GET /api/library/profile/consents`,
with the verified identity) and refuses when it is missing or revoked. The reminder "Don't say client names" and a
recording indicator show on every recording.

## Links that survive sign-in (`/go/`)
`GET /go/start` → `/#start` (opens the consent step; the microphone waits for the click), `/go/{gap,invitation,bid,library}/<32 hex>`
→ `/#<kind>/<id>`, `/go/confirm/<32 hex>` → `/confirm#<id>` (also for an external confirmer), anything else under `/go/` → `/`.
`/go/signed-in` is the small re-sign-in window: it posts `'ok'` on `BroadcastChannel('atlas-auth')` and closes, with no
data. Emails, outreach rows and Teams cards use these links. The ids are random and grant nothing without sign-in (a
recorded deviation from WOW rule 7); no token ever goes in a path. A page navigation to an unknown path goes to `/`.

## People directory and the profile (DNA prefill; docs/WOW_ZERO_CONFIG.md §5-§7)
- The profile fills project forms and the consent heading only; it never reaches an AI model. Sources, merged per field:
  the person's own edits, then DNA (push or pull), then the DNA export (CSV), then the sign-in name claims (Entra), then
  a guess from the email (confirmed with one click).
- `DATA_MODE` gates every DNA and HR path. Unset (the test deployment): the push and the pull answer `BLOCKED_EXTERNAL` and
  the CSV import accepts only reserved test addresses (`example.com/.org/.net`, `.test`, `.example`, `.invalid`).
  `DATA_MODE=production` only on an approved Mantu-owned deployment (Mantu IT approval, DPO sign-off on the six columns).
- **Push (recommended):** a DNA or HR job run by Mantu IT posts
  `{batch: <32 hex>, part: 1..40, final: true|false, rows: [{email, name?, givenName?, familyName?, title?, managerName?, managerEmail?}] (≤ 500)}`
  (≤ 262,144 bytes) to `POST https://<atlas>/api/directory/push` with `Authorization: Bearer <DIRECTORY_PUSH_SECRET>`
  (compared in constant time). Add an Access **bypass** for `/api/directory/push` only. The final part replaces the
  earlier DNA rows; a final part that would shrink the directory below 80% is refused (409), and a push cannot confirm it.
  Unknown keys are rejected per row, by row number only. Without the secret: 401; in test mode: `BLOCKED_EXTERNAL`.
- **Pull (shape ASSUMED, nothing confirmed by Mantu IT):** `DNA_PROFILE_URL` (https template with exactly one `{email}` or
  `{oid}`, no credential in the query), `DNA_AUTH_HEADER` (default `Authorization`), `DNA_FIELD_MAP` (JSON: `root`, `name`,
  `givenName`, `title`, `managerName`, `managerEmail` → dotted paths) and the secret `DNA_API_KEY` (the whole header value).
  It works only if DNA answers HTTPS from the internet (no fixed Worker egress IP), with a static header or bearer key (no
  mTLS), and can look one person up by email or `oid`. Called only for the signed-in person's own profile, 2.5 s cap,
  manual redirects, ≤ 64 KB JSON, mapped fields only, cached 24 h. If push is set, pull is never called.
- **Export CSV:** an admin uploads it in Insights → People directory. The browser reads only the approved columns (email,
  name, first name, job title, N+1 name, N+1 email) and drops every other column before upload; the server rejects
  unknown keys again. Rows go in batches of 500; the screen shows "This replaces N rows with M." first.
- `GET /api/library/people?email=` gives any signed-in user one exact email's `{email, name, title, from}` from the stored
  rows only (never the N+1, never a profile edit, never a DNA call), 30 lookups per hour. It fills the gap assignee name.

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
| GET | `/api/library/:id` (adds `rating.running`; `jevAllowed` at full access), `/api/library/:id/revisions/:n` | record people / reviewers; others: published only |
| POST | `/api/library/:id/review` ("Rate again": JEV when configured and the owner allowed it, else the review agent), `/withdraw` | record people / reviewers |
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
| GET/POST | `/api/library/profile` `{set?, clear?, confirmGuess?}`, `/profile/delete`, `/profile/consent` `{kind: 'spokenAsk' | 'jevRating', version: 1, granted}`, GET `/profile/consents` | the signed-in person, their own profile only (not external) |
| GET | `/api/library/people?email=` | everyone (not external); 30 per hour |
| GET/POST | `/api/library/directory`, `/directory/import`, `/directory/clear` | admins (import also the DNA push, as `system`) |

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
  projects that would not help this interview. This JEV check asks no consent of its own (only the interview consent);
  whether to gate it behind the `jevRating` consent is Tony's decision (docs/JEV_RATING.md §12.2; see "TypeSafe (JEV)").
- API contract checked against `@vectorize-io/hindsight-client` 0.10.1: `PUT /v1/default/banks/{bank}` (missions),
  `POST .../memories` `{items, async}`, `POST .../memories/recall`, `GET .../documents`, `DELETE .../documents/{id}`,
  `DELETE .../banks/{bank}`, `Authorization: Bearer <key>`.
- People control it in their profile: list, forget one, forget everything, switch off (`memoryOff` in their own
  Durable Object). Admins can test the Hindsight and JEV connections there.
- Secrets: `bash deploy/cloudflare-edge/set-keys.sh` (hidden dialogs → `HINDSIGHT_API_KEY` (Hindsight Cloud `https://api.hindsight.vectorize.io` is the default; `HINDSIGHT_URL` only for self-hosting),
  `TYPESAFE_API_KEY`). Memory is private continuity, never evidence, and never feeds the library or a report as fact.

## TypeSafe (JEV)
One server-side secret, `TYPESAFE_API_KEY`, switches on every path below; without it each one is off and nothing is faked.
Every call is `POST https://api.typesafe.ai/v1/systemone` with the key only in `Authorization: Bearer` (never in a URL,
log, audit row, stored rating or page). **Only story rating asks the per-owner consent below**; the other paths are
recorded here as they are (the choice is Tony's, docs/JEV_RATING.md §12.2).

| Path | Code | When it runs | What it sends | Consent |
|---|---|---|---|---|
| Story rating | `deploy/cloudflare-edge/src/rating.js`, `library.js` `review` | Save, merge, "Rate again" | The story's title, industry, service lines, six answers and up to 10 sources (name, version, excerpt), after `scrub.recordView` and the record's own values masked: client name, location, contact, project id, link hosts, and the consultant's, colleagues', N+1's and owner's stored names. A containment guard refuses to send if any own value remains. Abbreviations, product names and other clients fused into longer words are not masked (docs/JEV_RATING.md §3.5). Model pinned to `jev-1.13.0` | The story owner's `jevRating` consent (asked once; revocable in the profile) |
| Private-memory relevance | `memory.js` `jevRelevant` | Before a live interview, when Hindsight recalls memories from other projects | The project's title, stage and sector as typed (the title is not masked) and the texts of those recalled memories (client name, location and contact were replaced before storage) | None beyond the interview consent |
| Next-question ranker | `jev.js` `jevRanker` | During a live interview, when the ledger leaves a free choice | The interview's structure only: fields covered, statuses, flags, stage. No transcript text, quotes or project names | None |
| Project classification ("Score impact") | `classify.js`, `/api/jev/classify` | A person clicks | Title, role, sector, stage and the six answers as typed (up to 3,000 characters each); client fields are refused, but names typed inside the text are not masked | The click |
| Bid ranking | `customer-jev.js` via `bids.js` | A bid match with "use JEV" and its consent ticked | The customer brief in placeholder form and the eligible published stories' sections and source metadata | Per run (`useJev` and `jevConsent`) |
| Admin connection test | `memory-routes.js` `GET /api/memory/test` | An admin clicks "test" | One fixed synthetic sentence; no user content | Admins only |

Story rating in detail (docs/JEV_RATING.md):
- **One request, typed answers.** Up to 11 questions (7 Scores, 3 Nouls, 1 Choice for the language) in one request; code
  combines them (completeness 0.45, JEV 0.55; weights in `rating.js`). The rule blockers stay decisive. A rating is `ready`
  only when no blocker applies, the score reaches `READY_SCORE`, and no uncertain answer could change that verdict.
- **Fast and reliable.** A person waiting: 2 s hard cap with one hedged duplicate at 0.7 s. Save and merge: 6 s with up to
  two retries (0.5 s doubling, `retry-after-ms` preferred over `Retry-After`). The last answer is reused when the story
  body is unchanged (`refs.state.lastJev`, 0 requests). A circuit breaker skips JEV for 60 s after 3 consecutive timeouts,
  network errors or 5xx; a 401/403 skips it until the key changes.
- **Fallback, never a fake.** No key, no consent, a failure or an open breaker: today's review agent rates. Uncertainty
  that could change a `ready` verdict, a non-English story, or a manager-staff story (no N+1) whose answers are not in the
  0.9+ band escalates to the review agent as a second opinion.
- **Metrics** (`story_rating`, numbers only): engine, fallback code, status, ms, attempts, hedged, http, cached, asked,
  holds, escalated, strict, language, input_tokens. Escalation share = Σ `escalated` / count(`engine` = 1); the second
  opinion's own row carries `fallback` 13 and `engine` 2 (answered) or 3 (did not answer). Cost = Σ `input_tokens` × $0.042
  per million (https://docs.typesafe.ai/models.md).
- **Local runs:** `FAKE_TYPESAFE=1 node deploy/cloudflare-edge/dev/local-edge.mjs` uses the local fake (model id
  `fake-jev-local`; `/__typesafe_mode?m=ok|down|unsure`). Without it, a local run refuses every request to api.typesafe.ai.

## Languages
- Understanding: Deepgram Nova-3 on Workers AI with `STT_LANGUAGE=multi` (automatic detection and code-switching):
  English, French, Spanish, Portuguese, German, Italian, Dutch, Russian, Hindi, Japanese.
- The browser's language opens the conversation; after that ATLAS switches with the consultant once two consecutive
  clear utterances (three words or more, not an echo) are heard in the same other language. One misdetected utterance
  changes nothing (Nova-3 `multi` gives no confidence to trust a single one). The talker gets a LANGUAGE note every turn.
- Speaking: English (Aura-2 `harmonia`) and Spanish (Aura-2 `aura-2-es`, `TTS_VOICE_ES`, default `celeste`) on Workers
  AI with no extra key. Every other language uses ElevenLabs Flash v2.5 (`ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`,
  raw `pcm_24000`, 32 languages). Without that key ATLAS still understands the language, answers in English and says so
  once.
- Reports and the shared library stay in English (faithful translation), so search and review work across languages;
  the interview transcript keeps the original words.

## Destination adapters and the evidence workflow (Agent Brain v2.1)
Contract-driven **mocks only**. No DNA, MeChat, IMP or Spotlight CMS endpoint, schema or credential exists in this repository, so no adapter makes a network call. Every mock acknowledgement carries `mock: true`, the card says "Mock, not connected", and a mock result is never "synced" or "published" (D12): `record_sync_complete` and `record_published` are refused by the policy gate unless `destination_ack.mock === false`. Code: `deploy/cloudflare-edge/src/adapters.js`, `branches.js`, `jobs.js`, `spotlight.js`; decisions D1 to D7 and D12 in `docs/agent-brain-v2.1/DECISION_LOG.md`; status per system in `docs/agent-brain-v2.1/IMPLEMENTATION_STATUS.md` (X1 to X6).

| Adapter | Destination | Status | Payload (from the approved revision's claims only) | Fields left null until the owner defines them | Owner and API needed |
|---|---|---|---|---|---|
| `DNA_SKILLS_WRITEBACK` | DNA | `BLOCKED_EXTERNAL`, mock | Skill-type claims as `status: proposed` assertions with evidence references. A story approval is not a skill approval. | `skill_taxonomy_id`, `level` (DNA's taxonomy and level scale) | Mantu DNA owners: endpoint, authentication, taxonomy, write contract |
| `MECHAT_CV` | MeChat | `BLOCKED_EXTERNAL`, mock | Reviewed contribution claims. A claim's statement is sent only after a person has reworded it (400 characters at most); outcome and metric claims send structured fields only (no client permission model exists). "MiChat" is an internal label for this interview (D1). | `language`, `target_role`, `template` | MeChat owners: endpoint, CV schema, template and language rules, client-permission model |
| `IMP_CAPABILITY` | IMP | `BLOCKED_EXTERNAL`, mock | Capability signals; waits for its own `matching` permission, which is `pending_owner_confirmation` (D7) | `availability` (IMP's, never computed here) | IMP owners: endpoint, signal schema, confirmation of the matching purpose |
| `SPOTLIGHT_CMS` | Spotlight | `BLOCKED_EXTERNAL`, mock that can only hold | The public audience projection (`story-projection.js`); the mock refuses anything with `internal_notes`, `source_refs`, ledger, session or item ids | `canonical_url`, `published_at` (a hold has none) | Spotlight CMS owners: API and publication contract. Atlas never sets `published` (D4). |
| MAAP review, Project Review | none | `BLOCKED_EXTERNAL`, shells | none. The rubric is `MUST_BE_CONFIGURED_BY_PROCESS_OWNER`; rating or closing is denied with `MAAP_NOT_CONFIGURED` or `PROJECT_REVIEW_NOT_CONFIGURED` (D2, D3). | the whole rubric, cadence, owners, data model | Process owner |

Payloads never contain the interview transcript, quotes, ledger ids, session ids or ASR metadata. Delivery uses the job envelope `{job_id, idempotency_key, source_entity_id, source_revision, destination, payload_hash, status, attempt, max_attempts, next_attempt_at, destination_ack, last_error, created_at}`. The key is `entity:revision:hash:destination` and is UNIQUE, so enqueueing twice is a no-op; retries back off exponentially with jitter (5 attempts, 1 s base, 15 min cap), then dead-letter to `failed`, recovered only by a reviewer; a destination holding a newer revision is never overwritten (`needs_reconciliation`). Every delivery attempt re-runs the `project_destination` gate against the grants as they stand then; a revoked or expired grant halts the job.

**Switches** (Worker variables):
- `ATLAS_ADAPTERS` = `off` (default; branch cards read `projection_pending` with reason `ADAPTERS_OFF`) | `mock` (the four mocks run). `live` is refused and reported `BLOCKED_EXTERNAL`. Any other value is `off`.
- `ATLAS_EVIDENCE_WORKFLOW` = `on` (default) | `off`. Off turns off the fan-out, the status route and the sync route (rollback); a confirmed summary is then confirmed but not filed, and the browser is told so.
- Moving from a mock to a live adapter is a new task with the owner's contract, a live round-trip test with the destination's acknowledgement, and Tony's approval. Until then, never report a destination as connected, synced or published.

**Evidence API** (same-origin, signed-in; POST needs `Origin` and `X-Atlas-CSRF`). The browser can read, submit, review, grant and sync; it can never create a draft (the interview's Durable Object posts it server to server under the verified identity).

| Method | Path | Who |
|---|---|---|
| GET | `/api/library/evidence`, `/api/library/evidence/:id[?revision=n]` | the owner; after submission also the resolved N+1 and reviewers |
| GET | `/api/library/evidence/:id/status` | same; seven cards, never one overall "done" |
| POST | `/api/library/evidence/:id/submit` `{expected_revision}` | the owner (explicit "Submit for review") |
| POST | `/api/library/evidence/:id/review` `{action: approve | amend | clarify | dispute | reject | withdraw | complete_impact_review, …}` | reviewers and the N+1; not the owner; the author of the current revision cannot approve it |
| POST | `/api/library/evidence/:id/permissions`, `/permissions/:grant/revoke` | grant: the owner; revoke: the owner or an admin (purposes `internal_knowledge`, `cv`, `bid_client_facing`, `public_spotlight`, plus `skills_profile` and `matching`) |
| POST | `/api/library/evidence/:id/sync` | a reviewer who is not the owner: re-check, run due jobs, recover one failed job |
| GET, POST | `/api/checkpoint`, `/api/checkpoint/discard` | the signed-in person's own interview checkpoint (Origin and CSRF on the POST) |

**Identity gap (Entra).** In Entra mode `user.email` is `tid:oid`, which never equals the email a staffing record or the DNA directory names as the N+1, so the resolved N+1 never matches and the lookup fails closed: only `ATLAS.Reviewer` and `ATLAS.Admin` can review until the directory carries the Entra identifier (G1-1). An N+1 the consultant typed on the reference (`self_declared`) is never an approver, in either mode.

## Privacy and consent wording for the interview (Agent Brain v2.1)
Facts the consent wording and any data protection review must match. The consent dialog is in `src/shell.html` and `src/voice-client.js`; the current text says the interview takes at most fifteen minutes and can be paused or stopped, and does not mention the points marked **not yet in the UI**. No UI text was changed by this documentation task; Tony and the data protection owner approve wording first.
- **Checkpoint (24 hours, absolute).** With transcript consent only, an interrupted interview (history, evidence ledger, state, and the consultant's words including any "kept private" items) is stored in that person's own Interview Durable Object for 24 hours from the first write. Reconnecting, resuming or pausing never extends this; at 24 hours the stored copy is deleted by an alarm and nothing is written after that point. It is deleted at once on discard ("Start over"), withdrawal, a clean end, any end that is not an interruption, and a fresh start. Without transcript consent nothing is stored. `ATLAS_CHECKPOINT=off` stores nothing. **Not yet in the UI.** Proposed sentence: "If the connection drops, your interview is kept for up to 24 hours so you can continue; after that, or if you start over, it is deleted." Closing the page does not discard the interview (product call).
- **Text mode (X1).** "Type instead" starts an interview with no microphone request and no audio sent; ATLAS answers in text and nothing is synthesised. The same consent, transcript handling, 15-minute clock, checkpoint and summary apply. Typed words are stored like spoken ones (provenance `consultant_typed`). Replies follow the voice languages. **Not yet in the UI** beyond the consent tip "Typing: no microphone is used and no audio is sent."
- **Keep private.** At the read-back the consultant can keep a detail private. It is excluded from the evidence draft, the notes, the report input and the memory payload, and the whole utterance is replaced by `[kept private]` in the talker history. The ledger's own record and its transcript item stay in the owner-only ledger and checkpoint until the interview ends or 24 hours pass (S1, L7).
- **Draft and submission.** Confirming the summary creates a draft visible to its owner only. Nothing reaches a reviewer until the owner clicks "Submit for review". Nothing is reused externally without a purpose permission, and approval binds one revision.
- **What is never sent to a model:** the consultant's name.
