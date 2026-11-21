# Track Z zero-setup start and profile prefill: status

Track Z (docs/WOW_ZERO_CONFIG.md revision 2, §0-§9, §10 schedule; WOW_SPEC §0 still binds). Working copy `/Users/tony/AI-Brain-build/atlas-project-intelligence` (HEAD 71efb5b). No commits, branches or stashes by this track. No deploy, no wrangler, no provider calls, no network from tests. Nothing was built with `build.py` or `build_edge.py` in Z-S0.

## State
- **Z-S0 (edge): done.** Implemented and locally verified. `profile.READY = false`: the profile, people and directory words answer 404 until the zero-config acceptance suites pass (WOW_SPEC §2.1); the flip belongs to the step that runs `tests/zero_config_edge_browser.py`. Provider verified: none (DNA is `BLOCKED_EXTERNAL` by design; its connector shape is ASSUMED).
- **Z-S1 (browser): done.** Implemented and locally verified; see "Z-S1" below. `python3 build.py` was run (the four aliases are rebuilt); `build_edge.py` was not (so `deploy/cloudflare-edge/src/atlas.html` is still the old page until Z-S2/verification copies it). Provider verified: none.
- **Z-S2 (hooks, docs): done.** Implemented and locally verified; see "Z-S2" below. `profile.READY = true` (flipped after `tests/zero_config_edge_browser.py` and `tests/zero_config_browser.py` passed). `python3 build.py` and the full `build_edge.py` were run; `deploy/cloudflare-edge/src/atlas.html` is the zero-config page. `SPOKEN_ASK_APPROVED` stays false (D1 is Tony's). Provider verified: none.
- **Independent verification: done.** Every build and suite was rerun on the final tree, and the product owner's path was walked on the local edge (3 actions: Start, the tick, Start conversation). Two defects and one stale doc line were fixed; see "Verification" below. Merged into `handoff/BUILD_STATUS.md` (session "2026-09-29 / Track Z").

## Plan (Z-S0)
- [x] `atlas_voice/interview.py` `project_context` drops `consultant` (source of truth; the key is still accepted), `make_prompt` shrink loop no longer re-adds it; `tests/test_voice.py` +1 test.
- [x] `session.js` `projectContext` port drops `consultant`.
- [x] `review.js` `forModel` drops `consultant`; `library.js` merge text "Contribution by another consultant:"; `scrub.js` legacy merge prefix.
- [x] `memory-routes.js` `GET /api/memory/settings` → `{off}` (DO storage only).
- [x] `profile.js` (new): §5, §6, §7.
- [x] `features.js` words, `MODULE`, `SYSTEM_WORDS.directory`, `SPOKEN_ASK_APPROVED`, flags `profile`, `spokenAsk`, `pdfBriefs`.
- [x] `library-routes.js` `ctx.user.idp`; `profile.daily` in `scan-stale` (only once `profile.READY`).
- [x] `app.js`: `signinClaims`, `x-atlas-idp`, `/go/*` (and `/go/confirm` in the external block), `/go/signed-in`, navigation fallback, `/api/directory/push`, `DATA_MODE` banner and readiness, `/api/transcribe` consent gate, PDF `metadata: false`.
- [x] `dev/local-edge.mjs` `&idp=` claims and passthrough; `wrangler.jsonc` comments.
- [x] Tests: `test/profile.test.js` (new, 19 tests), additions to `app` (+8), `features` (+1), `library` (+2), `memory` (+2) tests.
- [x] Edge and Python suites green.

## Changes
1. **`deploy/cloudflare-edge/src/profile.js`** (new). Exports `READY, routes, ensure, resolveProfile, firstName, emailGuess, lookupPerson, directoryManager, dnaConfig, pushConfig, testAddress, daily` (§6), plus `nameClaims`, `idpClaims`, `DNA_TIMEOUT_MS`.
   - Tables `profiles`, `directory`, `directory_imports` (`CREATE TABLE IF NOT EXISTS`, memoised per Library instance). Staged import rows live in `directory` under `source = 'staged:<batch>'` until the final part; readers only ever read `dna` and `dna_export`.
   - Merge per field, `you > dna > dna_export > signin > guess`; `newer` from each edit's `basis`; a guess never produces `newer`. The guess's given name fills the `preferredName` field (for the form, with its "please check" chip) but `firstName()` never uses it.
   - Routes: `GET/POST profile`, `POST profile/delete`, `POST profile/consent`, `GET profile/consents` (reads the row only, creates nothing), `GET people?email=` (stored rows only, 30/h, never the N+1), `GET directory`, `POST directory/import`, `POST directory/clear` (admin), and `POST directory/import` for the `system` push (source `dna`, `BLOCKED_EXTERNAL` 503 unless `pushConfig` is on).
   - DNA pull (ASSUMED): header-only secret, `redirect: 'manual'`, 2.5 s cap (a race, so a fetcher that ignores the abort is still capped), JSON content type, 64 KB bound, mapped fields only, 404 cached as a miss, 24 h cache with `waitUntil` refresh, numbers-only `dna_lookup` log. Never called when push is configured or outside `DATA_MODE=production`.
   - Import: rows ≤ 500 per part, parts 1..40, unknown keys and non-text values rejected per row, test mode accepts reserved test addresses only (N+1 email too), rejections carry row numbers and reasons only, shrink guard 409 (a push can never confirm), audit counts only.
   - `daily`: profiles unseen 395 days, pull-cache rows older than 30 days (push rows stay), staged batches older than a day.
2. **`src/app.js`**: `/api/directory/push` pre-Access (bearer, constant-time, production only, bounded 262,144 bytes, forwarded as `dna-push`/`system` with `x-atlas-idp: e30`); `/go/confirm/<id>` inside the external block; `/go/signed-in` (`SIGNED_IN_HTML`, BroadcastChannel `atlas-auth`, no data); `/go/*` 302s; banner and `readiness` follow `DATA_MODE`; `x-atlas-idp` always overwritten on every `/api/library` forward from `signinClaims(request)` (the already verified token; `verifyAccess` unchanged); `/api/transcribe` requires `X-Atlas-Consent: spoken-ask-v1; once|always`, and `always` a stored consent read from `GET /api/library/profile/consents` with the verified identity; GET navigation fallback to `/` before the JSON 404; `/api/sheet/*` `toMarkdown` with `{conversionOptions: {pdf: {metadata: false}}}` (VERIFIED against the Workers AI "Conversion Options" page on 2026-09-29). `handle()` gained a `flagsOf` option (test seam, default `flags`).
3. **`src/features.js`**: words `profile`, `people`, `directory` (not external, not email-auth); `SYSTEM_WORDS.directory`; `MODULE` entries; `SPOKEN_ASK_APPROVED = false`; `flags(env, ready, {spokenAskApproved})`: `spokenAsk = on('ask') && approved`, `pdfBriefs = on('bids')`, `profile = on('profile')` (appended last).
4. **`src/library-routes.js`**: `user.idp = profile.idpClaims(x-atlas-idp)`; `scan-stale` adds `profile.daily` once READY.
5. **`src/review.js`**: `forModel` drops `consultant`. **`src/library.js`**: merge text names nobody; `anonymise` (people-facing published view) and the `list` search keep the consultant, own-client scrubbed exactly as before (they are not model input). **`src/scrub.js`**: `recordText` rewrites a line-leading legacy "Contribution by <x>:" to "Contribution by another consultant:", which covers `recordView` and snippets.
6. **`src/memory-routes.js`**: `GET /api/memory/settings`. **`src/session.js`**: `projectContext` drops `consultant`.
7. **`dev/local-edge.mjs`**: `&idp=<URL-encoded JSON>` puts custom claims into the local token (remembered in a `dev_idp` cookie; empty clears); passthrough of `DATA_MODE`, `DNA_*`, `DIRECTORY_PUSH_SECRET` (unset by default); `SPOKEN_ASK` and `PDF_BRIEFS` removed. **`wrangler.jsonc`**: comment lines only (new names; `SPOKEN_ASK`, `PDF_BRIEFS` removed; `TEAMS_ENABLED` line left for Z-S2/T3).

### Intentional assertion changes (§9)
- `features.test.js` flags: `pdfBriefs` equals `on('bids')`; `spokenAsk` needs `SPOKEN_ASK_APPROVED`; `profile` key appended; the old `SPOKEN_ASK=1`/`PDF_BRIEFS=1` opt-in assertions replaced. WORDS/SYSTEM_WORDS key lists extended.
- `app.test.js`: `FEATURE_KEYS` + `profile`; bootstrap `SPOKEN_ASK=1` now turns nothing on; the T1 `/api/transcribe` test runs through `flagsOf` with D1 approved and sends the consent header (all its limits unchanged).
- `test/reuse.test.js:43` (outside the listed test files, unowned in §10): the merge assertion now expects "Contribution by another consultant:". One line; required by the owned `library.js` change.

## Commands run (real output)
- `cd deploy/cloudflare-edge && node --test test/*.test.js` → before: 360 pass, 0 fail; after: **392 pass, 0 fail**.
- `uv run … python -m pytest tests/test_*.py -q` (sandbox off for local port binding) → **253 passed**. A first run showed 1 failure in `tests/test_build_home.py` (a Z-S1 file) while the parallel engineer was rebuilding the aliases; that file alone then passed (12 passed) and the full rerun passed.
- `uv run … python tests/wow_edge_browser.py` (committed `src/atlas.html`, this Worker) → exit 0, 32 PASS, 0 FAIL. `tests/confirm_browser.py` → exit 0, 27 PASS.
- Local edge smoke (`node dev/local-edge.mjs 8797` + curl): `/go/start` 302 `/#start`; `/go/gap/<id>` 302; `/go/signed-in` has `BroadcastChannel('atlas-auth')`; navigation to `/ATLAS_Voice.html` 302 `/`, non-navigation 404; bootstrap `edge-deployment-test-data-only`, `profile` false, `pdfBriefs` true, `spokenAsk` false; `/api/library/profile` 404 (not READY); `/api/memory/settings` `{"off":false}`; `&idp=` sets `dev_idp`; push with a wrong bearer 401.
- Mutation checks of the leak test (scratch copy): it fails when `forModel` keeps `consultant`, when the merge text names the consultant, and when `projectContext` keeps `consultant`.

## Blockers and cross-track notes
- `profile.READY` stays false until the zero-config acceptance suites pass; the Z-S1 UI must treat a 404 from `/api/library/profile` as "no profile yet".
- D1: `ask-ui.js` must send `X-Atlas-Consent: spoken-ask-v1; once|always` (and store "Always allow" with `POST /api/library/profile/consent`) before `SPOKEN_ASK_APPROVED` flips, or `/api/transcribe` answers 403.
- D2: `pdfBriefs` is now on wherever bids is on. The PDF path is `/api/sheet/ingest` (app.js, done), not `bids.js`. The explicit "no text in this PDF (a scan?)" message is not done: `bids-ui.js` still says "No text was found in this file."
- Docs still describe `SPOKEN_ASK=1` / `PDF_BRIEFS`: `deploy/cloudflare-edge/README.md:30`, `docs/INTEGRATIONS.md:64`, and `handoff/CONFIGURATION.md` (Z-S2 docs).
- Z-S2 hooks ready to use: `profile.directoryManager` (claims.js `manager_source: 'directory'`), `profile.lookupPerson` (gaps.js assignee name); `/go/…` routes are live for the outreach, claims, teams and gaps links.

## Z-S1 (browser)

### Plan
- [x] `src/session-keeper.js` (new, `window.AtlasAuth`): `fetch` (X-Requested-With, `redirect:'manual'`, 401/opaqueredirect → `expired()` + `Expired`), one shared bootstrap (`boot`), `probe` (mode live/offline/network/expired), `expired`, `reconnect`, `onSignedIn`, `dirty`, `pending`.
- [x] `src/profile-core.js` (new, UMD `AtlasProfileCore`): chips, form mapping, `modelProject`, `roleFrom`, first-name check, CSV reader, header suggestions, approved-columns-only rows.
- [x] `src/profile-ui.js` (new, `window.AtlasProfile`): profile section, project-form chips, the guessed-name question, spoken-Ask consent store, admin People directory.
- [x] `src/voice-client.js` (§3.3, §3.4, §3.8), `src/app.js` (§3.5-§3.8, §5.9), `src/shell.html`, `src/voice-panel.html`, `src/engine.js` (`roleFrom`), `src/orb-ui.js`, `src/studio-panels.js`, `src/ask-ui.js` (D1), `src/bids-ui.js`, `build.py` (`ATLAS_HOME`, slots), `Makefile`, `ci.yml`.
- [x] Tests: `tests/profile-core.test.js` (10), `tests/test_build_home.py` (12), `tests/zero_config_browser.py` (75 checks, §9 cases 1-9 + directory minimisation), `tests/engine.test.js` (+2).
- [ ] `src/studio-connection.js`: no change was needed (the advanced disclosure is markup plus `paintSetup()` in voice-client.js; its validation copy never shows in live mode).

### Changes
1. **Start control and modes (§3.3, §3.8).** `AtlasAuth.probe()` runs once per load; `ATLAS_RUNTIME` present → live or network (never offline); absent → live only with the right protocol. The protocol test keeps the exact `!['http:','https:'].includes(location.protocol)` expression. Live: Start, pill "Ready", `#emptyVoiceNote` and `#cardConnection` hidden. Offline with `ATLAS_HOME`: `#voiceOpenHome` "Open ATLAS ↗" (`target=_blank rel=noopener`, href `ATLAS_HOME/go/start`), the orb and the card forward to it; the connection panel shows the offline copy with the address form inside `<details id="gatewayAdvanced">` (open when `ATLAS_HOME` is empty). Network: "ATLAS isn't answering right now. [Try again]". Idle labels: Ready / Not connected / Not reachable / Signed out (pill and orb). `#studioConnection` aria-label "Connection and privacy". `#start` (a `/go/start` link) opens the consent step on load. Sign out on the Worker goes to `/cdn-cgi/access/logout`; `/api/logout` only for Python providers. `#remotePreferenceBox` hidden on the Worker (it posts to `/api/preference`, which only the Python gateway serves).
2. **One consent step (§3.4).** One tick; the sentence adds the Hindsight memory clause only when `boot.memory` and the switch is on (unknown counts as on); `#memoryLine` "Turn off memory for my conversations" / "Turn on memory" posts `/api/memory/settings {off}`; widening the sentence clears the tick. Heading "Ready when you are, {first}." only with a reliable first name; footer "Signed in as {name} · {email}" or "Signed in as {email}". The start frame's `memory` is the switch; `terms()` includes it (a Restart after a change asks again). `rememberInterview` skips the POST when the switch is off and sends `modelProject(libraryPayload(p), p.roleFrom)`.
3. **Model boundary (§5.9).** `voiceSnapshot()` returns `project: modelProject(…)` (no name, never the sign-in email; a profile title never) and `display: {consultant, role}` for the screen (voice-client `sync()`, studio-panels). JEV classify uses `modelProject`. `ATLAS_RUNTIME.name` is no longer read anywhere.
4. **Project prefill (§3.5).** `prefill()`: confirmed name (never a guess) → renamed workspace → "Consultant"; title with `roleFrom:'profile'`; N+1 from the profile, else the last project's; `managerStaff` never from the profile. Used by `autoSave`, `startFromInvitation`, `startFromGap` (both then open the consent step, live only) and `projectFromLibrary` (no email fallback; restored `roleFrom` compared with the profile title). The project form: profile first, chips computed at render time, top line and role hint; `roleFrom` on submit. The guessed-name question after an interview ("Is your name …? [Yes, that's me] [Edit]") → `POST profile {confirmGuess}` → `ATLAS_APP.adoptProfileName` → resync. Legacy email consultants are replaced on the next sync and logged "Consultant name replaced: it was an email address".
5. **Returning user (§3.6).** `rebuild()` once per load (live, library, session-only, no non-sample project): `GET /api/library?mine=1`, full access, not withdrawn, newest first, ≤50, records 4 at a time, `projectFromLibrary(r,'after a reload')`, toast "Your projects are back from ATLAS."; not auto-selected. `begin()` waits for it (3 s cap).
6. **Expiry (§3.7).** One handling per episode (a deferred decision, so a caller's `resume:'start'` is merged). Voice active → wait for `ended` (or the socket/microphone to go). Clean page (nothing pending, no dirty check, no open dialog, no reload in 5 min) → reload; otherwise the banner (`#authBanner`, Reconnect → `/go/signed-in` popup, BroadcastChannel `'ok'` → fresh bootstrap, pending syncs retried, resume honoured, toast). Two failed attempts in 5 min → "Signing you in didn't work. [Backup ↓] then [Reload and sign in]" (Reload only after the backup or on a clean page). Dirty checks: unsynced session-only work (payload hash differs from the last accepted sync, gap notes, local preferences), profile form, unsent Ask question, Bids brief. Only `atlas.reauthAt` reaches `sessionStorage`. `beforeunload` warns only when a reload would lose something.
7. **Storage strip and device prompt (§3.8).** Live + library + session-only: "Saved to ATLAS" / "Saving to ATLAS…" / "Not saved to ATLAS yet · kept in this tab · Retry" (Retry syncs unsynced projects; gap-only work has no Retry). `bridge.autoSave()` returns `synced`; the device prompt appears only when the library is off, the sync failed or was pending at 10 s, or after a gap interview.
8. **Spoken Ask (D1)** in `ask-ui.js`: the tick became a prompt at the moment of use ("Ask by voice"; "Allow this time" / "Always allow for me" (only with `features.profile`) / "Cancel"); "Always" stored with `POST /api/library/profile/consent`; the recording line "Recording · {s}s · Don't say client names; type them." on every recording; `X-Atlas-Consent: spoken-ask-v1; once|always`. Revoke in the profile. Still absent while `SPOKEN_ASK_APPROVED` is false.
9. **Profile UI (§5, §8).** Profile section at the top of `#profileDialog` (live, `features.profile` only): six labelled fields, email read-only, source chips, guess question, "DNA now says … [Use it] [Keep mine]", Save (only changes; own-email and bad N+1 checked first), Delete my profile, privacy text, voice-question consent. Avatar initials from the profile name. Admin People directory in Insights: CSV read in the browser, header suggestions (FR/EN), only the six approved columns built into rows, "This replaces N rows with M" (N = DNA-export rows) with the shrink confirmation, batches of 500 under one 32-hex batch id, skipped rows by spreadsheet row number.
10. **Build (§3.10).** `ATLAS_HOME` from `wrangler.jsonc` `vars.ORIGIN` (full-line `//` comments dropped), `ATLAS_HOME_URL` overrides, `^https://[a-z0-9.-]+$` or `''`. Slots `__ATLAS_HOME__`, `__SESSION_KEEPER__`, `__PROFILE_CORE__`, `__PROFILE_UI__` (replaced last), loaded after `SERVER_RUNTIME` and before the engine and app.
11. Two fixes found by the tests: after `ended` the client closes the socket (an open socket would read as "voice active" forever); a clean-page reload uses `history.replaceState` + `location.reload()` because `location.replace('/#start')` from `/` only changes the fragment (§3.7's literal form reloads nothing). D2: `bids-ui.js` says a PDF with no text is probably a scan.

### Existing suites whose expectations changed (deliberate, §3.3/§3.8 and D1)
- `tests/studio_browser.py`: the offline page shows "Open ATLAS" instead of Start; the address-form checks now open "Connection & privacy" and the "Use a different ATLAS address" disclosure first (the form checks themselves are unchanged); the responsive check looks for the start link.
- `tests/sculpture_browser.py`: the 1366×768 and canvas-failure checks use `#voiceOpenHome` (offline).
- `tests/orb_touch_browser.py`: offline, the orb click opens the "Open ATLAS" tab; the test aborts and records every request, so nothing reaches the network.
- `tests/ask_browser.py`: D1 prompt instead of the tick; the transcribe request carries `X-Atlas-Consent: spoken-ask-v1; once`.
- Running `intelligence_browser.py`, `studio_browser.py` and `sculpture_browser.py` rewrites `preview/v11/*.png` and `tests/{studio,sculpture}-browser-results.json` (tracked artifacts; they now show the new start control).

### Commands run (real output)
- `python3 build.py` → "Built 867752 bytes; ATLAS_HOME: https://atlas.example.test".
- `node --test tests/*.test.js` → 368 tests, **367 pass, 0 fail**, 1 skipped (pre-existing: the Natural Earth regeneration test needs `ATLAS_NE_SRC`).
- `uv run … python -m pytest tests/test_build_home.py -q` → **12 passed**. Full `pytest tests/test_*.py` in a scratch copy of this tree → **253 passed** (not in the shared tree: some Python tests regenerate vector files).
- Browser, harness (a)/(b), this tree: studio 79, sculpture 40, intelligence 26, depth 20, autosave 33, orb_touch 8, report 19, bids 66, ask 31, trust 43, storyboard 51, **zero_config 75**: all exit 0, 0 FAIL.
- Browser, harness (c) (local edge): run in a scratch copy with the new page as `src/atlas.html` (the shared `atlas.html` was not touched): library 14, reuse 19, memory 9, sheet 17, confirm 27, wow_edge 32: all exit 0. Edge unit tests with the new page: 392 pass, 0 fail (same as the shared tree).
- Contract smoke, scratch copy with `profile.READY = true` there only, real `profile.js` through the local edge: guessed name → confirm → "you edited" and first name; title and N+1 saved; own email as N+1 refused ("Your N+1 can't be you."); test-mode import accepted `jane@example.com` and rejected `jane@mantu.com` as "rows 3: this test deployment accepts synthetic addresses only"; Jane's profile and new-project form show "from the DNA export". No page errors.

### Assumptions and notes
- The server's rejected-row numbers are 1-based across the whole batch (read from `profile.js`); the UI maps them back to spreadsheet rows.
- Restored projects carry no stored `roleFrom`: a role equal to the profile title is treated as `'profile'` (kept from the model), the conservative side.
- In offline and protocol-less harness pages (`ask`, `bids`, `trust`, `storyboard` BOOTs have no `protocol`) the page is in offline mode; `ATLAS_APP.bootInfo()` still returns the fetched bootstrap, as before.
- `scripts/check_handoff.py` (not a Z file): run on 2026-09-29, it already fails `manifest-content` (MANIFEST.json is stale for many files, pre-existing), so its clean rebuild is skipped. Read from its code, not observed: that rebuild copies only `build.py`, `src/`, `assets/`, `docs/`, so it would bake `ATLAS_HOME = ''` (no `deploy/cloudflare-edge/wrangler.jsonc`) and could not import `atlas_voice.quality` (T4-S0); it needs both paths when the manifest is refreshed.
- `src/intelligence-ui.js` (Python-gateway wiki/continuity actions, not a Z file) still uses raw `fetch`, so those calls do not carry X-Requested-With.

## Z-S2 (hooks, docs)

### Plan
- [x] `claims.js`: N+1 source `staffing` → `directory` (the owner's stored `dna`/`dna_export` row via `profile.directoryManager`, never the owner's own edits) → `self_declared`; the draft link `/go/confirm/<id>`.
- [x] `gaps.js`: a blank `assignee_name` from `profile.lookupPerson` (stored rows only); the draft link `/go/gap/<id>`.
- [x] `outreach.js` `PATH` → `/go/invitation|gap|confirm/<id>` (rows queued earlier keep their stored fragment path, which still works).
- [x] `teams.js` / `teams-routes.js`: no `TEAMS_ENABLED`; connected once `TEAMS_APP_ID`, `TEAMS_TENANT_ID` and `TEAMS_BOT_SECRET` are set; `TEAMS_BOT_APP_ID` defaults to `TEAMS_APP_ID` (`botAppId`); the card link `/go/invitation/<id>`; the launcher's "Open ATLAS" opens `/go/start` ("Your pending interviews" still opens `/`).
- [x] `session.js` `projectContext` (done in Z-S0): `test/session.test.js` now asserts it (no consultant, no "Zelda" in any talker or analyst input, the greeting unchanged).
- [x] Spoken Ask end to end: `test/app.test.js` stores "Always allow" through the Worker's library forward into the real `profile.js` and has `/api/transcribe` read it back (per person, revocable). The browser side (`ask-ui.js`) was done in Z-S1. `SPOKEN_ASK_APPROVED` stays false.
- [x] `entra/enable_entra.sh` claims `["tid","oid","roles","preferred_username","name","given_name","family_name"]`; `entra/README.md` (name claims, trimming order, the per-user role gate with group assignment or an Access policy); `tests/test_entra_claims.py` (new, 3 tests).
- [x] Docs: `handoff/CONFIGURATION.md` (edge section: `DATA_MODE`, DNA push/pull/export, `ATLAS_HOME_URL`, Teams, removed vars, D1, D2), `deploy/cloudflare-edge/README.md`, `docs/INTEGRATIONS.md`.
- [x] `tests/zero_config_edge_browser.py` (new, harness (c), 50 checks); registered in `Makefile` and `ci.yml`.
- [x] Wiring defects between Z-S0 and Z-S1 fixed (below). `profile.READY = true`.
- [x] `python3 build.py`, full `build_edge.py`; every suite.

### Changes
1. **Hooks.** `claims.js` `managerOf` adds `directory` between staffing and self-declared (the independence check applies unchanged; `manager_source` is a TEXT column, no ALTER). `gaps.js` fills a blank assignee name from the stored directory (a name on the reference is kept). Both call `profile.js` only while `profile.READY` (WOW_SPEC §2.1 stub rule). `trust-ui.js` badge: "Confirmed by N+1 (N+1 from DNA)" for a `directory` request (spec §5.8; one hunk in a file §10 does not list).
2. **Links.** `/go/` in the confirmation draft, the gap draft, every outreach row (email body and Teams card) and the Teams invitation card.
3. **Teams.** `teamsStatus` = app id + tenant id + bot secret; `verifyBotActivity`, `teamsClient` and `eventOf` use `botAppId(env)`; `teamsRoutes` answers only when `teamsStatus` is `connected` (so the ids without the secret keep every Worker response unchanged). `wrangler.jsonc` and `teams/README.md` rows updated.
4. **Local edge (dev only).** `/__expire` test hook: requests carry no token (the Worker answers 401) until the next top-level navigation, which is signed in again, as Access does (§3.7, §13). Never deployed.
5. **`profile.READY = true`.**

### Wiring defects found and fixed
- **Unsaved profile typing was wiped after signing in again.** `AtlasAuth.onSignedIn` reloads the profile (`load({fresh:true})`), and `profile-ui.js` `set()` re-rendered the open section, discarding the typed values that the dirty registry had just protected; reopening the dialog re-rendered it too. Now a profile that arrives while the section holds unsaved typing never re-renders it, and reopening keeps it; the answer to the section's own POST (Save, Use it, Keep mine) still re-renders. Regression check in `tests/zero_config_edge_browser.py` (fails on the old code: checked on a scratch copy).
- Browser suites asserting the old links, updated for the deliberate §3.9 change: `tests/wow_edge_browser.py` (the `/go/confirm/<id>` link, now opened through the real 302) and `tests/confirm_browser.py` (the draft body).

### Intentional assertion changes (§3.9, §4)
- `test/teams.test.js`: `ENV` has no `TEAMS_ENABLED`; `ON` adds the secret; teamsStatus, the 503 rule, the bot-id default, the card and launcher links.
- `test/app.test.js`: the T1-S0 Teams invariant now uses the ids without the secret (`TEAMS_ENABLED` ignored) and adds the connected case.
- `test/outreach.test.js`, `test/claims.test.js`, `test/gaps.test.js`: links `/go/…`.

### Commands run (real output)
- `cd deploy/cloudflare-edge && node --test test/*.test.js` → before: 392 pass; after: **397 pass, 0 fail** (+1 claims, +1 gaps, +1 outreach, +1 session, +1 app).
- `node --test tests/*.test.js` → 368 tests, **367 pass, 0 fail**, 1 skipped (pre-existing `ATLAS_NE_SRC` test).
- `uv run … python -m pytest tests/test_*.py -q` (sandbox off for local sockets) → **256 passed** (253 + 3 `test_entra_claims.py`); the tree was unchanged by the run.
- `python3 build.py` → "Built 868272 bytes; ATLAS_HOME: https://atlas.example.test"; the four aliases identical. `uv run … python deploy/cloudflare-edge/build_edge.py` → "edge constants + page generated"; `policy.generated.js` unchanged; `src/atlas.html` = `ATLAS_Voice.html`.
- Browser, all exit 0, 0 FAIL: **zero_config_edge 50**, zero_config 75, wow_edge 32, confirm 27, library 14, reuse 19, memory 9, sheet 17, ask 31, trust 43, studio 79, sculpture 40, intelligence 26, depth 20, autosave 33, orb_touch 8, report 19, bids 66, storyboard 51. `zero_config_edge` was run 3 more times in a row: 3/3 green.
- Mutation checks (scratch copy): the claims directory test fails when the directory step is removed or when it reads the owner's profile edits; the gaps test fails without the name fill; the session test fails when `projectContext` keeps the consultant; the teams tests fail when `TEAMS_ENABLED` is required again (6 tests); the outreach and claims tests fail with the old fragment links; `test_entra_claims.py` fails when the name claims come first; the edge browser suite fails on the old `profile-ui.js`.

### Not done / notes
- `SPOKEN_ASK_APPROVED` stayed false in Track Z: D1 is Tony's decision; spoken Ask was verified end to end only with the test seam (`flagsOf`). (Later: set to `true` in the WOW review fix round, 2026-09-29; see `handoff/BUILD_STATUS.md`.)
- The N+1 name from a typed N+1 email on the project form (§5.8, `GET /api/library/people?email=`) is not wired in the browser: §10 assigns it to no browser file. The server route works; the gap assignee name is filled server-side.
- `docs/THIRD_PARTY.md:57` still says the launcher opens `<ATLAS origin>/` (it now opens `/go/start`); not a Z file.
- UNVERIFIED on the real Access app (§13): WebSocket survival across app-token expiry, fragment and path survival through an interactive sign-in. The local edge only imitates Access (`/__expire`).
- `handoff/BUILD_STATUS.md` was not updated (the track log is this file, WOW §6.7). No commit was made: the aliases and `atlas.html` are ready for one integration commit.

## Verification (independent, 2026-09-29)

Re-ran everything on the final tree, walked the product owner's path, fixed what it found. No commit, no deploy, no wrangler, no network or provider from any test. Sandbox off only for loopback ports and Chromium.

### Product owner's path, walked (Playwright, local edge: real Worker `handle()`, real LibraryStore and `profile.js`; the voice WebSocket is a scripted stand-in because the local edge serves none)
A trusted-event counter in the page recorded every click and every typed field:
- **Brand-new admin (`owner@example.test`, empty library, no DNA, test mode) opens `/`: 3 actions, 0 fields to fill.** `click voiceStart` → `click modelConsent` (the one tick) → `click voiceConsentStart`. On load: no dialog open, pill "Ready", no setup word (`gateway|localhost|GPU|.env|NVIDIA|address|set up|configure|API key`) in the conversation view or the consent dialog. The consent dialog's only visible field is the tick; "Start conversation" is disabled until it is ticked; the microphone is not held before the click. Heading "A conversation with ATLAS." (a guess is never used), footer "Signed in as owner@example.test", memory clause present (memory configured on the local edge). The start frame's project is `{id:'new', consultant:'', role:''}`, with no email. After the interview: the report opens by itself, strip "Saved to ATLAS", one `POST /api/library`, one `POST /api/memory/remember`, no "Save on this device?" prompt, no page errors.
- Brand-new non-admin (`marie.dupont@mantu.com`): the same 3 actions and 0 fields.
- `/go/start` link: the consent step is already open on load, so **2 actions** (the tick, Start conversation).
- Saved HTML file: one "Open ATLAS ↗" link to `ATLAS_HOME/go/start` (asserted by `zero_config_edge_browser.py`), then the `/go/start` path: **3 actions** in all. This was composed from the two verified pieces and not walked end to end, because the link's target is the real remote origin.
- 320 px: the same 3 actions; no horizontal overflow on the page or in the report dialog.
- Not counted (outside the page): the Access sign-in itself (email PIN today), and the browser's own microphone prompt the first time (spec §0.1).

### Defects found and fixed
1. **The guessed-name question was out of sight (product-owner path).** After an interview the report opens by itself and switches to Projects, but "Is your name Tony Walteur? [Yes, that's me] [Edit]" was only in `#voiceAfter`, in the hidden Conversation view. On today's deployment (PIN sign-in, no DNA) every auto-created project therefore stayed "Consultant", unless the user went back to the Conversation tab. `tests/zero_config_browser.py` case 8 did not see this because its `close_dialogs()` clicks back to the Conversation view first.
   - Fix: `src/app.js` `showReport()` also renders `AtlasProfile.guessPrompt` in `#reportStatus` for a placeholder project (consultant `Consultant` or an email, the same condition as `adoptProfileName`). `showReport` rewrites that line on every render, so nothing accumulates. `src/profile-ui.js`: after "Yes, that's me", every copy of the question says "Thanks, {first}." (the server's `confirmGuess` is idempotent).
   - Regression: `tests/zero_config_edge_browser.py` gained a brand-new user with no DNA (`noor.haddad@example.net`) and 4 checks: one field in the consent step; exactly three trusted actions (`voiceStart`, `modelConsent`, `voiceConsentStart`); the auto-opened report asks "Is your name Noor Haddad?"; "Yes, that's me" confirms the name (`from: 'you'`) and the project and its library record carry it. Mutation: with the `showReport` line removed from a scratch copy of `atlas.html`, the suite fails on exactly that check (44 PASS, then FAIL).
2. **`tests/storyboard_browser.py` was flaky** (1 failure in 5 runs: `EvalError … 'unsafe-eval' is not an allowed source`). Two `wait_for_function` calls used a bare string. Playwright re-`eval`s a string on every poll, which the page CSP refuses, while it evaluates a function once and caches it. So the wait passed only when the condition was already true on the first check. Proven on the built page: a condition that turns true 500 ms later fails as a string and passes as `()=>…`. Fix: both calls are now function predicates. They were the only two string predicates in `tests/*_browser.py`.
3. `docs/THIRD_PARTY.md:57` (stale since Z-S2): the Teams launcher opens `/go/start`, and Teams needs `TEAMS_APP_ID`, `TEAMS_TENANT_ID` and `TEAMS_BOT_SECRET` (`TEAMS_ENABLED` is gone).

### Commands run on the final tree (real output)
- `python3 build.py` → exit 0, "Built 868709 bytes; ATLAS_HOME: https://atlas.example.test"; the four aliases are identical (sha1 `0ff0dee2…`). Before the fixes the rebuild was byte-identical to the Z-S2 output (868272 bytes, `0391dd41…`).
- `uv run … python deploy/cloudflare-edge/build_edge.py` (full) → exit 0, "edge constants + page generated"; `src/atlas.html` equals `ATLAS_Voice.html`. **`src/policy.generated.js` is unchanged** (byte-identical to HEAD). This is expected: the only Python change in track Z is `atlas_voice/interview.py` `project_context` / `make_prompt`, which are functions. `build_edge.py` imports only `TOPICS` from that module, and it did not change.
- `node --test tests/*.test.js` → 368 tests, 367 pass, 0 fail, 1 skipped (pre-existing: needs `ATLAS_NE_SRC`).
- `cd deploy/cloudflare-edge && node --test test/*.test.js` → 397 tests, 397 pass, 0 fail.
- `uv run … python -m pytest tests/test_*.py -q` (sandbox off) → 256 passed.
- Every browser suite of `make test-ui` (which includes `wow_edge`, `zero_config` and `zero_config_edge`), each exit 0 with 0 FAIL: studio 79, sculpture 40, intelligence 26, depth 20, autosave 33, orb_touch 8, library 14, reuse 19, memory 9, sheet 17, report 19, bids 66, ask 31, trust 43, storyboard 51, confirm 27, wow_edge 32, zero_config 75, **zero_config_edge 54** (50 + 4 new).
- Before the fixes (same tree as Z-S2): the same results except storyboard (exit 1 at line 120, the CSP `EvalError`; then 4/4 green on reruns) and zero_config_edge 50.
- Tree check: apart from the five edited files and the rebuilt pages, the only files the runs changed are the tracked `preview/v11/{desktop,mobile,speaking-preview}.png` (rewritten by `intelligence_browser.py`). No other file changed during this verification.

### Observations, not changed
- "Edit" in the guessed-name question opens the profile. A name saved there fills every later project, but the project just created keeps "Consultant" (only "Yes, that's me" calls `adoptProfileName`). The spec asks only that "Edit opens the profile"; worth a product decision.
- The interview itself ran against a scripted WebSocket stand-in, so live audio, STT, TTS and the Interview DO are not exercised by any of these suites.
- The N+1 name from a typed N+1 email (§5.8, `GET /api/library/people?email=`) is still not wired in the browser.
- UNVERIFIED on the real Access app (§13): WebSocket survival across app-token expiry, and path/fragment survival through an interactive sign-in.
- `scripts/check_handoff.py` still fails on the stale `MANIFEST.json` (pre-existing).

## Next
Integration: review, then one commit with the four HTML aliases (Tony or the orchestrator). Before live use: the §11 external items (who can sign in, `DATA_MODE=production` on an approved deployment, a DNA source, Entra claims) and Tony's D1.
