# ATLAS security incident runbook

Status: written by the B1 hardening task (2026-10-31). The commands and the log fields are verified against the code in this tree; no step has been rehearsed on a deployed Worker, so **run the drill in section 9 once on the test deployment before relying on this**. Nothing here is legal advice: the GDPR steps list what the engineering side must provide to the DPO, who decides on notification.

Scope: the edge Worker (`deploy/cloudflare-edge`, Cloudflare Access in front) and the Python gateway (`atlas_voice/server.py`). Owners and contacts are the first thing to fill in before the pilot (section 1).

## 1. Roles and severity

| Role | Who | Does |
|---|---|---|
| Incident owner | Tony Walteur (ATLAS owner) | Decides containment, runs this book, keeps the timeline |
| Mantu SecOps | to be named by Mantu IT | Access policy, SIEM, wider investigation |
| DPO | to be named by Mantu | Decides on notification to the authority and to people |
| Cloudflare account admin | to be named | Secret rotation, rollback, Access sessions |

| Severity | Examples | Target |
|---|---|---|
| SEV1 | Content of interviews or the library exposed to someone not entitled; signs of account takeover; `audit_chain_break`; a leaked secret in use | Contain within 1 hour; DPO told the same day |
| SEV2 | Repeated failed access from one pseudonym; a model or provider misbehaving; a kill switch needed to stop cost | Contain the same day |
| SEV3 | Single failed request, a user report that turns out benign | Next working day |

## 2. Detect

Everything the Worker records goes to the Worker log as one JSON line with `atlas_sec` set. View it with `npx wrangler@4.156.0 tail --format json | grep atlas_sec`, in the dashboard (Observability is enabled), or in a Workers Logpush / Tail Worker sink once Mantu SecOps provides one (not configured; a Tony / infra decision).

Fields (`security-log.js`): `ts`, `event`, `route` (a template: ids and addresses become `:id`), `method`, `status`, `reason` (a stable code), `subj` (first 16 characters of the HMAC subject key: pseudonymous, never an e-mail), `role`, `ip_h` (keyed hash of the network address), `colo`, `ray`, `n`, `bucket`, `head`. Nothing else is ever logged: no e-mail, name, token, path parameter, query string or content.

| `event` | Meaning | Look at |
|---|---|---|
| `authn_fail` | No or invalid Access token | many from one `ip_h`: probing |
| `csrf_fail`, `origin_fail` | A state-changing request without the session token or from another origin | more than 20 in 10 minutes for one `subj`: a script or a cross-site attempt; a single one after a long idle tab or a re-sign-in is normal (the token is bound to the sign-in; if they are frequent for ordinary users, see `ATLAS_CSRF_BIND` in `handoff/CONFIGURATION.md`) |
| `external_denied` | An external confirmer asked for something outside `/confirm` | any |
| `bearer_fail` | Wrong secret on `/api/triggers`, `/api/directory/push`, Teams | more than 5 per minute: someone is guessing a secret |
| `access_denied` | A 403 from the library, the evidence gate or an owner check, surfaced at the Worker | spikes per `subj` |
| `rate_limited` | A per-person limit (`reason` `RATE:<BUCKET>`) | one `subj` repeatedly: scripted use |
| `body_too_large` | An oversized request | any burst |
| `header_spoof` | The browser sent `x-atlas-*` headers (stripped); `n` is how many | any: a tampering attempt |
| `subject_blocked`, `kill_switch`, `inbound_off`, `flag_state` | A kill switch refused a request, or one is on (names only) | confirms a containment took effect |
| `audit_chain_break` | The library audit trail no longer verifies; `reason` HASH_MISMATCH or LINK_BROKEN, `n` the first broken row | **SEV1**, see section 5 |
| `audit_chain_ok` | Daily verification passed; `n` rows, `head` is the chain head | keep the daily `head`: it is the external anchor (see 5) |
| `internal_error` | An unexpected exception (no message is logged) | any repeat |

Suggested alerts (for Mantu's SIEM): `csrf_fail` > 20 per 10 minutes per `subj`; any `audit_chain_break`; `bearer_fail` > 5 per minute; no `audit_chain_ok` for 36 hours (the cron or the log is broken); `header_spoof` > 0.

Also: user reports to the owner, and the Cloudflare Access logs (who signed in) held by Mantu IT.

## 3. Contain (minutes)

First decide the blast radius, then use the narrowest switch. The kill switches are Worker variables read on every request. A change needs a deploy of the Worker variable (`npx wrangler@4.156.0 deploy --var NAME:value` from `deploy/cloudflare-edge`, or the dashboard Settings → Variables, then Deploy). A deploy ends live interviews (they resume from their 24-hour checkpoint when the person returns). Every switch is logged (`flag_state` once per isolate, `kill_switch` / `subject_blocked` / `inbound_off` on each refusal).

| Situation | Switch | Effect |
|---|---|---|
| One person's account is suspected | `ATLAS_BLOCKED_SUBS=<subj>[,<subj>]` | That pseudonym gets 403 on every path. Use the `subj` from the log (16 hex characters is enough; at least 12). Also revoke the Access session (section 4) |
| Data may be changing wrongly, or you need a quiet system to investigate | `ATLAS_READ_ONLY=1` | Every mutation and every new interview answers 503 "read-only for maintenance"; reading still works. The daily cron is frozen too (X1): it still verifies the audit chain, but runs no retention erasure, no audit re-seal, no stale-reference invitations, no housekeeping and no destination retries, and logs `kill_switch READ_ONLY` |
| A model or provider misbehaves, cost is running away, or a prompt-injection campaign is suspected | `ATLAS_AI_OFF=1` | No model or third-party call that carries content, anywhere (talker, analyst, STT/TTS, sheet drafting, JEV interview ranker, JEV bid ranker, JEV rating and classify, review, embeddings, Hindsight create/retain/recall, the admin health probes); each client checks `kill-switches.js` itself (X1). Interviews are refused politely; notes can still be read and edited. A person's export and erasure (including forgetting their memory bank) still work: they carry no story text |
| The external confirmation channel is abused | `ATLAS_EXTERNAL_OFF=1` | The external role and `/confirm`, `/api/library/confirmations/*` answer 403 |
| An integration secret leaked (triggers, DNA push, Teams) | `ATLAS_INBOUND_OFF=1` | Those endpoints answer 503 before any secret is compared |
| Unknown, serious, and needs everything stopped | `ATLAS_READ_ONLY=1` and `ATLAS_AI_OFF=1`, and if still needed remove the Access policy so nobody can sign in | |
| A bad release | `npx wrangler@4.156.0 rollback` to the last good version | |
| A product behaviour (not a security switch) | the v2.1 rollback switches (`ATLAS_CHECKPOINT`, `ATLAS_EVIDENCE_WORKFLOW`, `ATLAS_ADAPTERS`, `ATLAS_REPLY_GUARD`; `handoff/CONFIGURATION.md`) | |

Also available per person without a deploy: the person's own memory switch and the "start over" discard. Cloudflare-side options (Tony / infra): the Workers Rate Limiting binding and WAF rate rules, which need a custom-domain zone (not available on `workers.dev`).

Record the time of each switch in the incident timeline.

## 4. Revoke and rotate

Order matters because of the couplings below. Rotate secrets one at a time, redeploy, then verify with a test sign-in.

1. **Access sessions**: in Cloudflare Zero Trust, revoke the user's active sessions (Access → Users → revoke), remove them from the Access policy, and for the Entra deployment disable the account in Entra. The CSRF token is bound to the session (`iat`), so a revoked and re-issued session also invalidates every token the old one held.
2. **Integration bearer secrets** (independent, no data coupling): `TRIGGER_SECRET`, `DIRECTORY_PUSH_SECRET`, `TEAMS_BOT_SECRET` (`npx wrangler@4.156.0 secret put NAME`). Tell the owning system (project-management system, DNA job, Azure Bot) the new value over a secure channel.
3. **Provider keys**: `TYPESAFE_API_KEY`, `ELEVENLABS_API_KEY`, `DNA_API_KEY`, `HINDSIGHT_API_KEY`. Revoke at the provider first, then put the new one. An ElevenLabs key saved by an admin in Settings → Voice is sealed in the LibraryStore (v2.2 V2): revoke it at ElevenLabs first, then **Remove key** in Settings (or `ATLAS_SETTINGS_KEYS=off` to ignore it at once, with a deploy), then save the new one.
3a. **`SETTINGS_KEY`** (seals the stored ElevenLabs key; `deploy.sh` creates it): to rotate, `secret put SETTINGS_KEY` with a new value of at least 32 characters, and put the old value in `SETTINGS_KEY_PREVIOUS` so the stored key stays readable; save the key again in Settings → Voice (that seals it under the new secret), then delete `SETTINGS_KEY_PREVIOUS`. If the old value is lost, the stored key is unreadable (the Voice tab says so, ATLAS falls back to Workers AI or the environment key) and the key is simply saved again. The secret is not recoverable from the sealed record, and the sealed record is useless without it. Admin changes leave `voice.key_set`, `voice.key_removed`, `voice.key_invalid`, `voice.provider_changed` and `voice.settings_changed` audit rows (no values) and `voice_settings` security events (`KEY_SET`, `KEY_REMOVED`, `KEY_INVALID`, `KEY_UNVERIFIED`, `PROVIDER_CHANGED`, `VOICE_CHANGED`).
4. **`CSRF_SECRET`**: safe to rotate on its own **only once `HINDSIGHT_BANK_SECRET` is set** (below). Rotating it signs everyone's tokens out of the page: they reload and get a new one. The Worker refuses to serve memory when `HINDSIGHT_API_KEY` is set but `HINDSIGHT_BANK_SECRET` is not.
5. **`HINDSIGHT_BANK_SECRET`**: never rotate during an incident. It addresses every person's private memory bank; changing it orphans all banks. Rotate it only as a planned migration (export, re-address, verify).
6. **`LOG_SALT`** (optional): rotating it only changes the pseudonyms of hashed addresses in later log lines.
7. **GitHub `CLOUDFLARE_API_TOKEN`**: revoke and re-issue in Cloudflare (scope: Workers Scripts:Edit on this account only), update the repository secret.

**Migrating a deployment that already has memory banks and no `HINDSIGHT_BANK_SECRET`** (do this once, before the next deploy of this version, or memory is switched off with a clear message until you do): set `HINDSIGHT_BANK_SECRET` to the literal text `atlas-hindsight:` followed by the current value of `CSRF_SECRET` (for example by `printf 'atlas-hindsight:%s' "$CSRF" | npx wrangler secret put HINDSIGHT_BANK_SECRET`). The derivation is unchanged, so no bank moves. Alternatively set `HINDSIGHT_ALLOW_DERIVED_BANK=1` for a short transition (bank ids stay tied to `CSRF_SECRET`; do not rotate it while this is on). Verified in `test/memory-bank-secret.test.js`.

## 5. Preserve evidence, then purge

**Preserve first** (before deleting or restoring anything):
1. Export the Worker log for the period (the `atlas_sec` lines are content-free by design) and the Cloudflare Access logs.
2. Export the library: signed in as an admin, `GET /api/library/export` (references, revisions, audit). Keep the file in the incident folder, access-restricted. (Whether the export also carries every evidence revision and workflow transition row has not been checked; if the incident touches the evidence store, take a Durable Object backup as in step 4.)
3. Verify the audit chain: the daily cron logs `audit_chain_ok` with the chain head. If `audit_chain_break` appears, the first broken audit row is `n` (`reason` HASH_MISMATCH: a row was altered; LINK_BROKEN: a row was removed or inserted before it). The chain proves integrity of the rows it holds; it does not detect removal of the newest rows or of the oldest (a retention sweep), so compare the latest logged `head` with the chain head you can compute from the export.
4. Durable Object point-in-time recovery for the SQLite-backed library: **ASSUMED, verify the bookmark API on your Cloudflare plan before relying on it**; take a bookmark before any destructive step.

**Purge** (only after the DPO agrees what must go):
- A person's interview data: the person's own "start over" / checkpoint discard; there is no admin tool that discards another person's checkpoint; it expires on its own. Checkpoints expire by themselves 24 hours after the first write.
- Library entries: withdraw through the library (`POST /api/library/<id>/withdraw`, the owner or an admin); never hard-delete evidence the DPO wants preserved.
- Private memory: `POST /api/memory/forget` with `{"all":true}` for that person's bank (the person, or an admin acting through their session), or delete the Hindsight bank at Hindsight.
- Provider-side copies: ask Hindsight, TypeSafe, ElevenLabs per their processor terms (processor registry: Wave B documents).

## 6. Notify (GDPR, 72 hours)

1. The clock starts when ATLAS or Mantu becomes aware that personal data was breached: note the time in the timeline.
2. Within hours, give the DPO: what happened (event names and times from section 2), which data classes (interview transcripts and notes, library references including client details, the audit trail, private memory, e-mail addresses in the library), how many people (the number of distinct `subj` values in the affected events; the library holds the identities), whether the data was encrypted or content-free (the security log is content-free by design), containment taken (section 3), and what is still unknown.
3. The DPO decides on notification of the supervisory authority (Art. 33, within 72 hours of awareness) and of the people (Art. 34), and on client confidentiality notifications (the governance document, section 7, `docs/agent-brain-v2.1/06_*`). Engineering does not notify anyone outside Mantu itself.
4. Keep the contact with SecOps and the DPO in one thread; keep the decisions and who made them in the timeline.

## 7. Recover and verify

1. Fix the root cause on a branch with a regression test; run the full suite (`make test`, `make test-ui`).
2. Deploy the fix, then lift the kill switches in reverse order of impact (`ATLAS_BLOCKED_SUBS` last).
3. Verify: a test sign-in; the daily `audit_chain_ok` (or run it by waiting for the cron); no new `csrf_fail` / `bearer_fail` spikes; the library list and one interview work.
4. Tell the affected people what happened, in plain words, if the DPO decided so.

## 8. After the incident

Within a week: a short blameless review (timeline, what detected it, what slowed containment, what to change), the actions with owners, and a lesson appended to the lessons log. Update this runbook with anything that did not work.

## 9. Drill before the pilot (not done)

On the test deployment, once: set each kill switch and observe the refusal and the log line; block a test `subj`; trigger a CSRF failure and find it in the log; rotate `TRIGGER_SECRET`; roll back one version; break the audit chain in a copy and see `audit_chain_break`. Record the date and result here.

## Content-Security-Policy (v2.2 F1)

**What it enforces.** Every HTML response (the page, the re-sign-in page, `/confirm`, `/privacy`, the Teams tab) carries `script-src 'sha256-...' blob:` (the SHA-256 of each executable inline script, plus `blob:` for the AudioWorklet module), `script-src-attr 'none'` (no inline event handlers), `default-src 'none'`, `connect-src 'self'` + the websocket origin, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'` (the Teams tab allows Teams only) and `report-uri` / `report-to` + `Reporting-Endpoints`. There is no `'unsafe-inline'` and no `'strict-dynamic'` for script. The server's per-person facts travel in a JSON data block (`<script type="application/json" id="atlas-runtime">`, `<` escaped), never as script, so every executable script is static. Data responses get `default-src 'none'; frame-ancestors 'none'`. The page also carries the same script policy in a `<meta>` (offline copies). **Residual:** `style-src 'unsafe-inline'` stays (the page has large inline styles; an injected tag can restyle, not run code or reach the network); removing it is a design-system change. The gateway (`atlas_voice/server.py`) sends the same policy without a report target (no report endpoint there).

**Where the hashes come from.** `python3 build.py` computes them from the built page and writes `deploy/cloudflare-edge/src/csp.generated.js` (never edit it). The re-sign-in, confirm and Teams pages are hashed at run time from their own text (`src/csp.js`); the gateway hashes the page it serves. If any inline script changes and the generated module is stale the page is blocked; `deploy/cloudflare-edge/test/csp.test.js` and `tests/test_csp.py` fail first (freshness check: rebuild, then `git diff --exit-code deploy/cloudflare-edge/src/csp.generated.js`).

**Violation reports.** `POST /api/csp-report` (signed-in people only, no CSRF token because the browser posts it, at most 8 KiB, 120 per person per hour) logs one `csp_violation` event (`atlas_sec`) with only the violated `directive` and the blocked ORIGIN; no path, query, sample or document URL is kept. Find them with `wrangler tail | grep csp_violation`. An unexpected `script-src-elem` / `script-src-attr` report with an `inline` blocked origin is either an injected script (treat as Sev 2: see section 3) or a stale hash after a deploy.

**Rollout / rollback switch.** `ATLAS_CSP=report-only` (Worker var; gateway environment variable) enforces the previous policy and only REPORTS the strict one (the page `<meta>` is dropped from the response so it cannot enforce). Default (unset or anything else) is `enforce`. Use report-only for the first week on a real deployment, then unset it; set it again to roll back instantly without a deploy of code.

**Developing.** No inline `on*=` attributes, no `innerHTML` assignment: markup is built with `html` and set with `setHTML` from `src/safe-html.js`; `tests/safe-html-lint.test.js` fails the build otherwise. `tests/csp_browser.py` loads the built page under the enforced header and asserts zero violations across boot, consent, a typed interview, the Library view and the privacy panel.

## Reference: where each control lives

| Control | File |
|---|---|
| Security headers (HSTS, COOP, CORP, Permissions-Policy, nosniff, no-referrer) on every response; the gateway has the same set | `src/security-headers.js`, `atlas_voice/server.py` |
| Security event log | `src/security-log.js` |
| Per-person rate limits, persisted in Durable Object storage (interview starts 6/hour and 20/day; sheet 20/hour; JEV classify 30/hour; transcribe 60/hour; each overridable by `RL_<NAME>`). Transcribe checks the spoken-ask consent before the limiter, so a missing consent is 403 when the limiter would otherwise be unavailable. The local edge answers `/api/limit` with the same `limitRoute` as the Worker. | `src/ratelimit.js`, wired in `app.js`, `worker.js` and `memory-routes.js` |
| Bounded streaming body reads | `src/bounded.js` |
| Kill switches | `src/kill-switches.js` |
| Audit hash chain and daily verification | `src/audit-chain.js`, `worker.js` (`scan-stale`), single hook in `library.js` `log` |
| Bank secret requirement | `src/memory.js` `bankSecretStatus` |
| CSRF binding, inbound header stripping, signing-key handling | `src/app.js` |
| Strict script CSP (hashes), JSON runtime block, report endpoint, `ATLAS_CSP` switch | `src/csp.js`, `src/csp-report.js`, `src/csp.generated.js` (from `build.py`), `atlas_voice/csp.py`, `atlas_voice/server.py` |
| Safe HTML rendering and its lint | `src/safe-html.js`, `tests/safe-html-lint.test.js` |

## Announced settings, audit chain and erasure behaviour (v2.2 X1)

- **Non-default security settings are announced.** `ATLAS_CSP=report-only`, `ATLAS_CSRF_BIND=sub`, `ATLAS_REPLY_GUARD=off`, `ATLAS_ADAPTERS=live|mock` and every kill switch are written once per isolate as a `flag_state` event (names only, no values) and listed in an admin's `/api/bootstrap` (`securityFlags`). While `ATLAS_CSP=report-only` is on, the enforced `Content-Security-Policy` on `/privacy`, `/confirm` and `/go/signed-in` is that page's own strict policy (no `script-src 'unsafe-inline'`, no `blob:`). `legacyCsp` is the enforced policy of the main voice page only. A production CSP report without `LOG_SALT` returns 503 and does not hash the address with `CSRF_SECRET`. Outside production the labelled `CSRF_SECRET` derivation remains. Other security events omit `ip_h` when production has no `LOG_SALT`.
- **A privacy rewrite does not reseal the chain.** Each row stores `commit = HMAC(key, canonical(seq, id, action, at, actor, detail))`, plus the tenant when that column exists, and `hash = SHA-256(prev, id, action, at, commit)`. The key is `LOG_SALT`, or outside production the same `subject-v1:` derivation as the subject pseudonym. Production without `LOG_SALT` fails closed. Erasure writes a tombstone (`actor` matches `erased:` plus 12 hex characters, `detail` empty) and `tombstone = HMAC(key, JSON.stringify(['tombstone', seq, commit, actor, id, action, at]))`, plus the tenant when that column exists. The older proof, which covered only seq, commit and actor, is not accepted. `prev_hash`, `hash` and `commit` stay, so a later row, including another tenant's, is not rewritten. The chain is verified first. If the keyed chain does not verify (`HASH_MISMATCH`, `LINK_BROKEN`, `UNSEALED`, `COMMIT_MISMATCH`, `TAMPERED`) keyed rows are left unchanged, an `audit_chain_break` event with reason `REWRITE_REFUSED` is logged, and the erasure still removes the person's content but leaves a hold of kind `audit` for the DPO. A successful pseudonym logs `audit_chain_ok` / `AUDIT_PSEUDONYMISED` and the head does not move. The daily anchor stores `n` and `head`. A shorter chain is `TRUNCATED`. The stored head must still be the hash at that position, so a prefix truncate padded with new rows is `ANCHOR_MOVED` and the anchor is not moved. Commit, tombstone, row hash and anchor compares use the shared `timingSafe` helper after a length check.
- **No reseal, and no legacy seal.** The server key signs a row only when this process writes it. A database from `main` (`80bab333`) has no hashes and no commits. Opening it appends one keyed `chain-start` row whose detail records the legacy row count and the max seq. A second `chain-start` is refused. Rows before that marker stay legacy and unverified: they are counted, they are never signed, and they are not an `audit_chain_break`. The daily check reports `CHAIN_VERIFIED` for the keyed rows and a separate `legacy` count. A copied commit fails, because the MAC binds seq, id, action, at, actor, detail, and the tenant when that column exists, and the anchor does not advance. A hash or previous-link column with no `commit` column is `TAMPERED` even when every value is null. That state does not migrate and does not clear the anchor. A NULL `commit` after the column exists stays `UNSEALED` and is not a chain-start. The one-start index is partial (`commit IS NOT NULL`), so an unsigned `chain-start` row does not block the real one. Erasure tombstones legacy rows without signing them and does not refuse because of them. Keyed erasure still stores the tombstone proof and leaves later hashes alone; a broken keyed chain is not rewritten. `Library.get` marks a row older than `chain-start` as legacy and unverified. If the `commit` column is absent, every audit line is unverified. An existing `audit_one_chain_start` index whose SQL does not require `"commit" IS NOT NULL` is dropped and recreated as that partial index. Pre-chain rows cannot be proved untampered. The daily anchor still stores `n` and `head` for the keyed chain only. Once an `audit_anchor` row exists, or the `commit` column exists, a missing signed `chain-start`, keyed values that are all null, or a chain of only unsigned rows is `TAMPERED`. That state is not migrated again, a new `chain-start` is not written, and the anchor is not deleted. A main-shaped database with no anchor row and no `commit` column still gets one `chain-start`. The first migration deletes anchor rows only in that case, and it does not drop the table. Rows signed under `a5ba30cd` (the MAC covered actor and detail only) verify as `COMMIT_MISMATCH`. There is no upgrade. Adding an `audit.tenant` column later would do the same to rows signed now, because those MACs did not include a tenant. Neither exists outside tests. This PR has not merged and has not been deployed. A previous-link compare uses `timingSafe` after a length check. A null previous link is the start of the keyed chain. `91e5f2c1` and `1b1ea05f` are not on `main` and not on the recorded live commit (`efb4948`). There is no reseal route and no upgrade. Do not invent one.
- **Tenant delete and subject erasure are different.** `POST /api/library/privacy/delete` passes `mode: 'tenant'` and keeps main's outcome for that path: the subject's own manager-trust rows for that tenant are deleted, and only directory rows whose key is the subject's mail or `oid:` plus the subject id are deleted. It does not replace another person's `manager_email`, a manager-only trust address, another profile's `edits.managerEmail`, an import author, or an outreach payload. Subject erasure replaces those addresses when they match `user.email` or `user.mail`, in this tenant, as a whole address, and tombstones same-tenant audit lines that name either address. An outreach row whose `to_email` is either address is deleted. The other tenant is left as stored. Privacy delete requires `transactionSync`. A store without it is refused and nothing is deleted. A failed receipt rolls the delete back. A direct erase whose body is not `confirmed: true` is refused before the library limiter spends.
- **Erasure holds.** A reference that was ever validated or published, cited in a bid, used or put in a one-pager is held for the DPO even if its owner withdrew it first. A held reference cannot be edited, validated, reinstated or merged by anyone; only the DPO's resolution deals with it. The person cannot lift the restriction that erasure set until the DPO has resolved every hold.
- **The erase confirmation is single-use** (token `exp.nonce.mac`; the nonce is recorded in the person's own object). If the library part of an erasure fails, the interview part (checkpoint, memory, consent state) is not run and the answer says `complete: false`.

