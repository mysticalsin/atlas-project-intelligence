# ATLAS integrations

## Roles
- Access mode: `ADMIN_EMAILS`, `REVIEWER_EMAILS` (comma separated, verified sign-in email). Everyone else is a consultant.
- Entra mode (`IDENTITY_SOURCE=entra`): app roles `ATLAS.Admin`, `ATLAS.Reviewer`; the library identity is `tid:oid`.
  Email lists are ignored in Entra mode.
- The N+1 named on a record can validate that record. Record people (owner, listed consultants, N+1) and reviewers see
  client details; everyone else sees published references with client details removed and scrubbed.

## Project-management system → interview invitations
`POST https://<atlas>/api/triggers` with `Authorization: Bearer <TRIGGER_SECRET>` and JSON:
```json
{ "email": "consultant@mantu.com", "reason": "project_end | milestone | periodic_review",
  "projectId": "PRJ-2291", "title": "Claims triage rollout", "slot": "2026-10-02T10:00" }
```
- `201` with the invitation. Repeated calls for the same person, reason and project return the open invitation.
- Set the secret: `npx wrangler secret put TRIGGER_SECRET`. Without it the endpoint answers `401`.
- Cloudflare Access protects the whole app, so add an Access **bypass** policy for the path `/api/triggers` only; the
  bearer secret (compared in constant time) protects it instead.
- A daily cron (`17 6 * * *`) invites the owner of every reference not updated for six months (`six_month_update`).
- Nothing is emailed. Consultants see invitations under Library → *Your interviews*, with an `.ics` calendar file.
  Microsoft Graph / Teams notifications need Entra and are not built (`BLOCKED_EXTERNAL`).

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
