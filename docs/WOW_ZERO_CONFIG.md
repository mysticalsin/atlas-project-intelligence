# ATLAS zero-setup start and profile prefill (amendment Z1-Z3 to WOW_SPEC)

Status: SPEC, not implemented. **Revision 2**, 2026-09-29. Revision 1 was reviewed; §14 maps every review finding to its resolution. Written against commit `0df6f43` plus the WOW build in progress in this working tree (T1-S0 and T4-S0 scaffolds landed, uncommitted; T1 steps 1-4, T2, T3 and T5 in progress). **Apply after WOW_SPEC §6.6 integration.** Until then every file listed in §10 belongs to a WOW track.

Source precedence: CLAUDE.md, then WOW_SPEC §0, then this amendment, then code. Where this amendment changes a WOW rule it says so (§3.9 rule-7 deviation, D1, D2). Code facts carry `file:line` as read on 2026-09-29. No test was run for this document; nothing was edited except this file.

Tony (product owner), verbatim:
1. "I dont want to have to fill all this to have the agent working. it should just work and ask for consent and thats it"
2. "Information should also be prefilled with the users information from our DNA (ERP) Name, email, title, ect — can be modified if needed too"

**In one paragraph.** On the live site a signed-in consultant presses Start, ticks one box and talks. There is nothing to configure. A profile (name, email, job title, N+1) fills in project forms, and every value can be edited. **Today** ATLAS runs as a test deployment on a personal Cloudflare account with email-PIN sign-in, so the profile comes only from the user's own edits and a name guessed from the email, confirmed with one click. DNA values (name, title, N+1) arrive only once ATLAS runs on a production deployment approved for personal data, and once Mantu IT connects DNA or HR supplies an export (§11).

---

## 0. Ground rules (in addition to WOW_SPEC §0, which still binds)

1. **Zero setup is not zero consent.** One tick before any recording or transcription stays mandatory. Its sentence names everything that happens to the conversation: the transcript and report, and **private memory whenever memory is configured and switched on** (a third-party service, Hindsight, extracts facts from the transcript). The browser's own microphone prompt still appears the first time.
2. **A missing external prerequisite never blocks the interview.** The feature is absent, or it shows one quiet line. Admins see `BLOCKED_EXTERNAL` with the reason and what is needed. Success is never simulated.
3. **No new cloud services.** No new bindings, DO classes, wrangler migrations, frameworks or npm build steps. New tables go in the existing `LibraryStore` with `CREATE TABLE IF NOT EXISTS`, created lazily (WOW §2.4 pattern).
4. **Profile data never reaches an AI model, with no exception.** The name is shown on screen only: it is never spoken by the model and never put in a prompt. Three choke points enforce this: `modelProject()` in the browser, and `projectContext` and `forModel` on the server (§5.9).
5. **Server-side secrets only.** The DNA key and the push secret travel in request headers. They never appear in a URL, HTML, log line or audit row.
6. **No invented endpoints.** DNA's URL, auth, lookup key and field map come from Mantu IT. The pull connector's shape is **ASSUMED** (§5.3). A push option (§5.4) needs no inbound network path into DNA. Until one of them is configured, DNA is `BLOCKED_EXTERNAL`.
7. **No real HR data on the test deployment.** The live Worker labels itself "TEST DEPLOYMENT · SYNTHETIC DATA ONLY" (`deploy/cloudflare-edge/src/app.js:136`, readiness `edge-deployment-test-data-only` at `:145`). It runs on a personal account (`atlas.tony-walteur.workers.dev`). Real enablement needs "a Mantu-owned Cloudflare account" (`entra/README.md:22`), and WOW §0 rule 3 says "Never send real data anywhere". So every path that brings in DNA or HR data (connector, push, export import) is gated by `DATA_MODE=production` (§5.6). Tony sets that variable only on an approved Mantu deployment.
8. **Nothing is auto-sent** (WOW §0 rule 6, unchanged).

---

## 1. What the user experiences

| Situation | Today | After this amendment |
|---|---|---|
| Opens the live site | Access sign-in (email PIN), then the orb. "Start conversation" works, but the page shows setup text ("Voice requires the included gateway…"), a "Not connected" pill and a "Set up conversational voice" card | The same sign-in. Once Entra is enabled it is usually silent on Mantu-managed browsers, with one Microsoft sign-in otherwise. There is no setup text. The pill reads "Ready", and Start opens the consent step at once |
| Consent | One agreement tick whose text promises private memory **even when memory is not configured**, a pre-ticked memory box the edge server ignores, and "Session identity: …" text | One agreement tick. Its sentence includes private memory only when memory is configured and on. A "Turn off memory" link beside it really turns memory off, and the sentence changes to match. The heading uses the first name when a reliable one is known |
| No project yet | Works (with a placeholder project), but the placeholder's consultant is the sign-in **email**, and that reaches the talker model | Works. The project is created after the interview, with name, title and N+1 prefilled from the profile. No name or email reaches a model |
| Comes back later (session-only mode, the default) | The Projects list is empty because the work lived only in the old tab. The "Save on this device?" prompt appears after every first interview | Projects reload from the user's own ATLAS library records. A follow-up interview updates the same record. The device-save prompt appears only when the library save failed, when the library is off, or after a proof (gap) interview |
| Opens a saved HTML file | An "Open your live workspace" form: type an address, tick "I trust it" | One "Open ATLAS" link to the live address, baked in at build time. The address form moves under "Use a different ATLAS address" |
| Session expires | Requests fail as "did not answer", the address form reappears, and a reload loses session-only work | A banner: "Your sign-in expired. Your work is kept on this page. [Reconnect]". Reconnect opens a small sign-in window, and the page itself is never reloaded while it holds unsaved work. An idle page with nothing unsaved reloads quietly. Mid-interview, the conversation continues and the banner waits |
| Old or deep link | Unknown paths answer JSON 404. Fragment links (`#gap/…`, `#library/…`, `/confirm#…`) may lose their fragment through an interactive sign-in (UNVERIFIED) | Unknown page paths redirect to `/`. New `/go/…` links for start, gap, invitation, bid, library record and confirmation survive sign-in |
| Profile today (test deployment, PIN sign-in) | None | The name is guessed from the email and confirmed with one click. Title and N+1 are typed once and remembered on the server. Everything is editable |
| Profile in production with DNA | None | Name, title and N+1 come from DNA (push, pull or export). With Entra, the sign-in name is used too. Everything is editable |
| Project form | Type the name, role, N+1 name and email | Prefilled from the profile, with each field labelled by its source, all editable |

---

## 2. Current behaviour (read from the code on 2026-09-29)

### 2.1 Entry points
- **Live site.** `deploy/cloudflare-edge/src/app.js` `handle()`: the host must equal `ORIGIN`, then `verifyAccess()` (RS256 Access JWT, `aud`, `iss`, `exp`), or else 401 "Sign in to use ATLAS.". `GET /` serves the page with `window.ATLAS_RUNTIME = {subjectKey, authMode: 'access', name: <verified email>}` (`:131-133`). The Python gateway injects `ATLAS_RUNTIME` the same way (`atlas_voice/server.py:104`). A saved file keeps the `/* SERVER_RUNTIME */` placeholder, so `ATLAS_RUNTIME` is absent there. Access today is email one-time PIN for `tony.walteur@gmail.com` only (`deploy/cloudflare-edge/README.md`).
- **Saved HTML file** (`file://`, any of the four `ATLAS_*.html` aliases). `src/voice-client.js` `check()` throws "The orb is running locally; a voice model is not connected…", and the catch shows `#gatewayOpenBox` in `#voiceConnectionDialog` (`src/shell.html`). There the user types an address. `src/studio-connection.js` `validate()` checks it with `AtlasStudioCore.gatewayOrigin` and requires the "I recognize and trust this application address" tick before the link is enabled.
- **Teams tab.** WOW F4.6: `GET /teams/tab` (pre-Access) will call `app.openLink(ORIGIN)`.
- **Old links.** Any path other than the known routes answers JSON 404 "This feature is not available in this deployment." (for example `/ATLAS_Voice.html`).

### 2.2 Bootstrap
- Worker `GET /api/bootstrap` (`app.js:140-145`) returns `{provider: 'workers', protocol: 'atlas-personaplex-pcm-v1', csrf, identity: {name: <email>, mode, subjectKey}, captureRequired: true, codecAvailable: true, memory: !!HINDSIGHT_API_KEY, library, libraryRole, readiness: 'edge-deployment-test-data-only', email, features: flags(env), …}`.
- Browser: `src/app.js` `bootInfo()` fetches it once and caches it (`{}` on `file://` or any error). `voice-client.js` `check()` fetches it again on every Start. Neither sends `X-Requested-With`.

### 2.3 `src/voice-client.js`
- **`status()`** (`:30`) writes "Not connected" to `#voiceState` for `idle`. `orb-ui.js:5` `names.idle` is also "Not connected".
- **`check()`** (`:35-42`): deduplicated by `checking`. Non-http(s) pages get the offline error. A 401 gives "…sign in with Entra."; not-ok gives "The ATLAS voice gateway did not answer…". Every failure shows `#gatewayOpenBox` (the address form).
- **`begin()`** (`:44-66`) sets the phase to `preparing` **before** `await check()` (`:46-47`). If `!b || !b.codecAvailable`, it opens the connection dialog (the setup form). In `captureRequired` mode it sets one agreement text (`:59`) that promises private memory **even when `b.memory` is false**. It pre-ticks `#memoryConsent` when `b.memory` (`:62`), which the edge ignores, and writes "Session identity: <email>…" (`:63`).
- **Restart reuse** (`:15`): `terms(b)` includes `memory: !!b.memory`, not the per-user memory switch.
- **`start()`**: the `start` frame carries `memory: $('memoryConsent').checked` (`:83`). A socket error calls `fail()` (`:85`), and a close before the end shows "The voice connection closed…" (`:86`).
- **`autoSave()`** (`:127`) calls `bridge.enableSave()` after 900 ms whenever the workspace is not persisted, **without waiting for the library sync**.

### 2.4 Memory
- After a full interview, `src/app.js:399` calls `rememberInterview(p, transcript)`. That function (`:166`) checks only `b.memory` and POSTs `/api/memory/remember` with `libraryPayload(p)` (client included) plus up to 6,000 characters of transcript.
- The Interview DO stores it in Hindsight Cloud (`memory.js:8`, `retainItems` `:90-98`), a third-party service that runs LLM extraction (`RETAIN_MISSION`, `:9`). Client names are scrubbed first, using `payload.client` (`memory.js:48, :96`).
- The DO reads `memoryOff` when the WebSocket connects (`worker.js:28`), and `/remember` refuses when it is set (`memory-routes.js:21`). `POST /api/memory/settings {off}` sets it (`:33-35`). No route reads the flag alone: `GET /api/memory` also lists Hindsight documents (`:14-17`).

### 2.5 Is a project required? Where does work live?
- A project is not required in the browser. `voiceSnapshot()` (`app.js:368`) returns a placeholder, `{id: 'new', title: 'New project, not yet named', consultant: <local workspace name, or ATLAS_RUNTIME.name>}`.
- `autoSave()` (`:374-399`) creates the project from the report headline, copies the N+1 from the most recent project that has one, then runs `syncToLibrary` and `rememberInterview` asynchronously. `startFromInvitation()` (`:246`) and `startFromGap()` (`:433-436`) create projects the same way.
- The "+ New project" form requires a title and a consultant name.
- **Session-only mode (`persisted = false`, the default) never reloads the user's own library records.** `projectFromLibrary` (`app.js:441`) is called only from `startFromGap` (`:435`). The library upsert matches on an explicit `id`, or else on `(owner, local_id)` (`library.js:121`). A follow-up interview on a fresh page therefore creates a new placeholder project, with a new local id, and a second library record.
- The library payload (`app.js:181`) carries answers, report, sources and details, but **not the interview transcript**.

### 2.6 Expired session
- Cloudflare Access answers an expired session with a redirect to its login page. It returns a 401 only for requests that carry `X-Requested-With: XMLHttpRequest` (VERIFIED, §13). ATLAS sends no such header, so `fetch` follows a cross-origin redirect and fails with a network error.
- In session-only mode all work is in memory, so a reload loses it. `enableStorage()` (`app.js:21`) warns that device storage is "without encryption", and the user's choice there is the only thing that puts content on disk today.

### 2.7 Where the consultant's identity reaches a model today (defects found while reading)
1. **The sign-in email reaches the talker model.** When the local workspace still has its default name, `voiceSnapshot()`, `startFromInvitation()` and `startFromGap()` use `window.ATLAS_RUNTIME.name`, which is the verified email. `projectContext` keeps it, and `talkerMessages` sends it to `TALKER_MODEL`.
2. **The consultant's full name and role reach the review model** and every other `forModel` path. `review.js:67-68`: `forModel` drops `client`, `owner`, `validation`, `quality`, `details.consultants` and `details.from`, but keeps `consultant: {name, role}`. WOW's `recordView` (`scrub.js:222`) builds on `forModel`.
3. **Role reaches TypeSafe/JEV** (the `/api/jev/classify` body) **and Hindsight** (`memory.js:38` "Consultant role: …").
4. **Merged records carry a name or an email in the answers.** `library.js:269` writes ``Contribution by ${g.consultant.name || gone.owner}:`` into `answers[1]`, which reaches every model through `forModel` and `recordView`.

Z3 fixes all four (§5.9).

### 2.8 Deep links today
All ids are 32 lowercase hex (`library.js:87`; the browser matches `[a-f0-9]{32}` in `openFromHash`, `app.js:277-279`).
- `#library/<id>`: the N+1 validation email (`app.js:78` `emailN1`).
- `/confirm#<id>`: confirmation requests (`outreach.js:31` `PATH.confirmation_request`, `claims.js:175`).
- `#invitation/<id>`: `outreach.js:31`, and the Teams card `teams.js:151`.
- `#gap/<id>`: `outreach.js:31`, and the gap draft `gaps.js:136`.

---

## 3. Z1: zero-setup start

### 3.1 Entry points, target

| Entry | Target behaviour |
|---|---|
| Live site `/` | Access sign-in, then the page loads, `probe()` succeeds, the pill reads "Ready", and Start opens consent. No setup text appears anywhere in normal use |
| `/go/start` (new) | The Worker (post-Access) redirects 302 to `/#start`. The page opens the consent dialog on load. The microphone stays off until the Start click |
| `/go/{gap,invitation,bid,library}/<32hex>` (new) | 302 to `/#<kind>/<id>` |
| `/go/confirm/<32hex>` (new) | 302 to `/confirm#<id>`. Also answered inside the external-role block, so an external confirmer reaches it |
| `/go/signed-in` (new) | The re-sign-in landing page (§3.7) |
| Saved HTML file (`file://`), or a static server without `/api/bootstrap` | Start is replaced by one link, "Open ATLAS ↗", to `ATLAS_HOME + '/go/start'` (baked in by `build.py`, §3.10). The address form sits under "Use a different ATLAS address" |
| Teams tab launcher (T3, when Teams is connected) | `app.openLink(ORIGIN + '/go/start')` |
| Old page paths (`/ATLAS_Voice.html`, `/index.html`, anything unknown) | A GET **navigation** to a non-`/api/` path answers 302 `/`. A navigation is `Sec-Fetch-Mode: navigate`, or an `Accept` header containing `text/html`. API paths keep their JSON 404 |
| Python gateway on `localhost:8080` | Unchanged (developer path) |

A cross-host redirect for a future custom domain is not included, and the existing "wrong host → 403" assertion stays.

### 3.2 One auth helper for every request: `src/session-keeper.js` (new, `window.AtlasAuth`)

Loaded before `app.js`. Every same-origin API call in `app.js` (`bootInfo`, `libraryApi`, `memoryApi`, `sheetApi`, JEV) and in `voice-client.js` (`request`) goes through it.

```js
AtlasAuth.fetch(path, opts)  // fetch(path, {credentials:'same-origin', cache:'no-store', redirect:'manual', ...opts,
                             //   headers: {...opts.headers, 'X-Requested-With': 'XMLHttpRequest'}})
                             // r.status === 401 || r.type === 'opaqueredirect' → AtlasAuth.expired(); throws AtlasAuth.Expired
AtlasAuth.expired({resume})  // §3.7: marks the page signed out; reloads only when safe, else shows the banner
AtlasAuth.reconnect()        // §3.7: opens the sign-in window (called from a click only)
AtlasAuth.onSignedIn(fn)     // runs after the sign-in window reports success
AtlasAuth.dirty(fn)          // a panel registers "do I hold unsaved input?" (Bids brief, Ask box, answer input, project and profile forms)
AtlasAuth.pending            // Set of project ids whose library sync failed on a 401
AtlasAuth.mode               // 'live' | 'offline' | 'network' | 'expired' (set by probe())
```

`redirect: 'manual'` catches the redirect even if Access is configured without the 401 behaviour. Same-origin requests with `X-Requested-With` need no CORS preflight.

### 3.3 `voice-client.js` changes

- **`probe()`** (new). It runs once on load, and its promise is shared with `app.js` `bootInfo()`, so there is one bootstrap fetch per load.
  - `location.protocol` not http(s) → `'offline'`, with no request. The protocol test keeps the exact expression `!['http:','https:'].includes(location.protocol)`, because `tests/studio_browser.py:19` rewrites that string for its adapter mode.
  - **`window.ATLAS_RUNTIME` present** (both servers inject it): the page is live by definition. Bootstrap ok → `'live'`. Expired → `AtlasAuth.expired({resume: location.hash === '#start' ? 'start' : null})`. Anything else (a network error, a 5xx, a Cloudflare 52x HTML page, non-JSON) → `'network'`. **Never `'offline'`.**
  - **`ATLAS_RUNTIME` absent** (a saved copy served from a static server, or a test harness): bootstrap ok with the right `protocol` → `'live'`; anything else → `'offline'`.
  - It renders the start control. `live`: `#voiceStart` "Start conversation". `offline`: `#voiceOpenHome`, an `<a target="_blank" rel="noopener">` "Open ATLAS ↗" (a real link, so no popup blocker applies; the orb click forwards to it), or today's dialog with the advanced disclosure open when `ATLAS_HOME` is empty. `network`: "ATLAS isn't answering right now. [Try again]".
  - `live` and `location.hash === '#start'` → `history.replaceState(null, '', '/')`, then `begin()`.
- **`AtlasVoice.active()`** (new) returns `!!stream || (socket && socket.readyState <= 1)`, meaning the microphone is held or a socket is open or connecting. It is the only definition of "voice active" that §3.7 uses. **The phase label is never used for that**, because `begin()` sits in `preparing` while it awaits `check()`.
- **`check()`**: the same contract, through `AtlasAuth.fetch`. Failures no longer open the address form: an expiry throws `AtlasAuth.Expired`; other errors give "ATLAS isn't answering right now. Try again in a minute." `#connectionDetails` is filled only for the "Connection & privacy" dialog, which the user opens on purpose.
- **`begin()`**:
  - Its double-click guard on the phase label is kept.
  - If `check()` throws `AtlasAuth.Expired`, it **first** calls `status('idle', …)` (no microphone, no socket), **then** calls `AtlasAuth.expired({resume: 'start'})`, and returns. The page is therefore never stuck in `preparing`.
  - `!b.codecAvailable` (a misconfigured Python gateway; the Worker always sends `true`) shows "Voice isn't available right now. Your projects are safe." and never the setup dialog.
  - It awaits the returning-user rebuild (§3.6), capped at 3 s, before it builds the snapshot.
  - It reads the memory state for the consent sentence (§3.4).
  - `window.AtlasVoice` gains `begin` and `active`.
- **`start()`**: the protocol is unchanged. `project` is `snapshot.project`, which is now model-safe (§5.9), and `memory` sends the current switch state. **If the socket errors or closes before `ready`**, one handler runs per attempt (a `settled` flag, so `onerror` and `onclose` do not both act). It calls `stopDevices()`, then `status('idle', …)`, then `check()`. If that throws `Expired` → `AtlasAuth.expired({resume: 'start'})`; otherwise today's error message.
- **`status()`**: the `idle` label depends on the mode. `live` → "Ready", `offline` → "Not connected" (kept, so `tests/studio_browser.py:35,45` and `tests/sculpture_browser.py:23,30` still pass: they load with `set_content`, so they are offline), `network` → "Not reachable", `expired` → "Signed out". `orb-ui.js` `names.idle` follows the same mode.
- **`sync()`** reads display values from `c.display` (`{consultant, role}`), because `c.project` no longer carries the consultant's name.
- **Restart reuse**: `terms(b)` adds `memoryOn`, so a Restart after a memory change asks for consent again.
- **Sign out** (all modes) links to `/cdn-cgi/access/logout` on the Worker (VERIFIED endpoint, §13). `/api/logout` is kept only when `boot.provider` is a Python-gateway provider.

### 3.4 The one consent step (`#voiceConsentDialog`, edge / `captureRequired` mode)

- **One tick (`#modelConsent`), the only required action.** Its sentence is built from the facts at the moment the dialog opens:
  - always: "I agree that this conversation is transcribed and saved with a report to my project, and that, once reviewed and validated, it may be used as reference material for future Mantu projects." ("saved with a report" is asserted by `tests/autosave_browser.py:43`.)
  - **only when `boot.memory && memoryOn`**: "ATLAS also keeps a private memory of our conversations, stored with its memory service (Hindsight), so it can pick up where we left off. I can see or erase it in my profile."
  - always: "I am allowed to share this project's details."
- **`memoryOn`** comes from `GET /api/memory/settings`, a new route that returns `{off}`. It reads Interview DO storage only and never calls Hindsight. `begin()` fetches it after `check()` when `boot.memory`. If that read fails, the memory clause is included (the server default is on, and over-disclosure is the safe side).
- **The switch.** When `boot.memory` is true, `#memoryLine` beside the tick shows "Turn off memory for my conversations" or "Turn on memory". A click calls the existing `POST /api/memory/settings {off}`, and on success the sentence is re-rendered. **If the change adds memory to the sentence, the tick is cleared**, so the user agrees to the wider sentence. If it removes memory, the tick stays. `#memoryConsentRow` (the pre-ticked, ignored box) is removed in this mode.
- **Effect.** The DO reads `memoryOff` at WebSocket connect (`worker.js:28`), which happens after this dialog, so recall follows the switch for this conversation. `rememberInterview` also checks `memoryOn` and **does not POST `/api/memory/remember` when it is off**. The server's refusal (`memory-routes.js:21`) stays as the second guard.
- **`boot.memory` false**: no memory clause and no switch. This fixes today's false promise.
- **Default**: memory is on when configured, as today, but now inside the consented sentence. If the DPO asks for opt-in, the DO default becomes "off unless explicitly turned on" in one line (`memory-routes.js:10`, `worker.js:28`). Nothing else changes.
- Heading: "Ready when you are, {firstName}." only when a reliable first name exists (§5.7); otherwise the current "A conversation with ATLAS.".
- `#consentTip`: "Your browser will then ask to use your microphone. Headphones give the clearest conversation." The admin sentence stays ("Admin mode" is asserted by `tests/autosave_browser.py:44`).
- `#consentIdentity`: "Signed in as {name} · {email}" when a reliable name exists, otherwise "Signed in as {email}".
- The Python gateway's non-`captureRequired` dialog (optional transcript and memory ticks) is unchanged.

### 3.5 Project: created and prefilled automatically

- No project is required before an interview (true today, and kept).
- **Placeholder.** `voiceSnapshot()` for "no project" returns `project: modelProject({id: 'new', title: 'New project, not yet named', consultant: '', role: '', …})` and `display: {consultant: AtlasProfile.displayName(), role: ''}`. It **never** uses `ATLAS_RUNTIME.name`.
- **New project from `autoSave()`**:
  - `consultant = AtlasProfile.confirmedName() || 'Consultant'`. `confirmedName()` returns the name only when its source is `you`, `dna`, `dna_export` or `signin`, **never `guess`**.
  - `role = AtlasProfile.title()`, with `roleFrom: 'profile'`.
  - `validation.manager` comes from the profile, or else from the most recent project's N+1, as today.
  - `managerStaff` is never set from the profile.
- **Guessed name.** When the name is only guessed, the end-of-interview message adds "Is your name {guess}? [Yes, that's me] [Edit]". Yes → `POST /api/library/profile {confirmGuess: true}`, the project's consultant is set, and it syncs again. Edit opens the profile. It never blocks.
- `startFromInvitation()` and `startFromGap()` use the same prefill, then call `AtlasVoice.begin()`. That opens the consent step, and the microphone waits for the click.
- **`newProject()` prefill order**: the profile first, then the last project's N+1 (today's fallback).
- **Chips are computed at render time**: a field equal to the current profile value shows that profile field's source chip, and a different value shows "you edited". **The only provenance stored is `roleFrom`** (`'profile' | 'you' | ''`), because the model rule needs it (§5.9). On submit, `roleFrom` becomes `'you'` when the role differs from the profile title. `engine.js` persists `roleFrom` in `project()` and `cleanProject()`, and imports keep it.
- **Cleanup of old records.** Today's fallback wrote the sign-in email as the consultant. On the next `syncToLibrary` of a project whose consultant contains `@`, the value is replaced by `confirmedName()` or `'Consultant'`, logged as "Consultant name replaced: it was an email address", and resynced.

### 3.6 Returning user: rebuild the workspace from the library (new)

- **When:** mode `live`, `boot.library` true, `persisted` false, and the workspace holds no non-sample project. It runs once per load, after `bootInfo()`. Device-autosave mode keeps its own copy and is unchanged.
- **How:**
  - `GET /api/library?mine=1` returns up to 200 summaries with `mine`, `access`, `status` and `updatedAt` (`library.js:166-175`).
  - Keep the items with `mine && access === 'full' && status !== 'withdrawn'`, newest first, at most 50 (the workspace limit).
  - For each item, `GET /api/library/<id>`, 4 at a time, then `projectFromLibrary(r)` (existing, `app.js:441`), which links `library.id`.
  - Skip any id already linked by a local project.
  - If anything was restored, toast "Your projects are back from ATLAS.".
- **No duplicates.** A follow-up interview on a restored project syncs with `id: p.library.id`, so the upsert (`library.js:121`) updates the same record.
- **Not restored:** the raw interview transcript, because it is not in the library payload (`app.js:181`). Report, answers, sources, details and the reference sheet are restored.
- `begin()` awaits this promise (capped at 3 s), so `/go/start` after a reload offers the restored projects.

### 3.7 Expired session: re-sign-in without losing the page

VERIFIED (§13): when the application token expires but the global Access session is valid, Access issues a new token on the next **top-level navigation**, with no prompt. So the tab that holds unsaved work must never be the one that navigates.

- **Detection.** `AtlasAuth.fetch` sees a 401 or an `opaqueredirect`, then calls `AtlasAuth.expired({resume})`. In `syncToLibrary()`, a 401 adds the project to `AtlasAuth.pending`, and the project is never reported as saved.
- **`expired({resume})`:**
  1. Set mode `'expired'` and remember `resume`.
  2. **Voice active** (`AtlasVoice.active()`: the microphone is held or a socket is open or connecting): show nothing yet. The open WebSocket was authenticated at upgrade (whether it survives is UNVERIFIED, §13; interviews last at most 15 minutes against a 24 h default session). Continue with step 3 after the `ended` session event.
  3. **Clean page**: `pending` is empty, every registered `dirty()` check is false, no dialog is open, and there was no automatic reload in the last 5 minutes (`sessionStorage['atlas.reauthAt']`, a timestamp only). The page reloads with `location.replace('/' + (resume === 'start' ? '#start' : ''))`. Nothing is lost: server records come back through §3.6, and device-mode data is on disk.
  4. **Otherwise**, show the banner: "Your sign-in expired. Your work is kept on this page. [Reconnect]".
- **`reconnect()`** (the Reconnect click, so no popup blocker applies): `window.open('/go/signed-in', 'atlas-signin', 'popup,width=480,height=640')`.
  - The popup's top-level navigation goes through Access. It is silent when the global session is valid; otherwise the PIN or Microsoft screen appears.
  - The Worker answers `GET /go/signed-in` (post-Access) with a tiny HTML page under today's CSP, which already allows inline script (`app.js:68`): `new BroadcastChannel('atlas-auth').postMessage('ok'); close();`. It carries no data and no token.
  - BroadcastChannel is used rather than `window.opener`, so an opener-isolation policy cannot break it.
- **Back in the original tab**, on `'ok'` from `BroadcastChannel('atlas-auth')`:
  - hide the banner;
  - re-fetch the bootstrap (for a fresh CSRF token) and set mode `'live'`;
  - retry `syncToLibrary` for each id in `pending`;
  - honour `resume` (`'start'` → `begin()`);
  - toast "You're signed in again. Nothing was lost."
- **Popup blocked, or closed without `'ok'`**: the banner stays. After a second failed attempt within 5 minutes it adds "Signing you in didn't work. [Backup ↓] then [Reload and sign in]". Backup is the existing export. Reload is offered only after the backup, or when the page is clean.
- **No project content is ever written to `sessionStorage` or `localStorage` by this mechanism.** The user's "Save on this device?" choice stays the only way content reaches disk.

### 3.8 Setup text removed or changed (live mode)

- `#emptyInterview` tiny text "Voice requires the included gateway…": hidden in live mode.
- `#studioConnection`: the label depends on the mode (§3.3). Its `aria-label` becomes "Connection and privacy" (today "Check NVIDIA voice connection").
- `#cardConnection` "Set up conversational voice ↗": hidden in live mode; "Open ATLAS ↗" in offline mode.
- `#voiceConnectionDialog`: in live mode it is an information panel (identity, voice, memory, limits). `#gatewayOpenBox` and the two static gateway paragraphs render only in offline mode, inside `<details id="gatewayAdvanced"><summary>Use a different ATLAS address</summary>…</details>`.
- `studio-panels.js:6` reads `c.display` for the consultant line instead of `c.project.consultant`, which is blank after §5.9.
- `#storageStatus` on a signed-in live page shows the server state: "Saved to ATLAS", "Saving to ATLAS…" or "Not saved to ATLAS yet · kept in this tab · Retry".
- **The device-save prompt.** `bridge.autoSave()` returns `synced`, a promise of the library result. `voice-client.js` `autoSave()` awaits it (capped at 10 s) before deciding. The automatic "Save on this device?" prompt appears **when the library is off, when the sync failed or was still pending at 10 s, or after a gap-mode interview** (gap answers stay local by WOW §0 rule 6, so the strip reads "Not saved to ATLAS yet · kept in this tab"). It does not appear after a full interview that the library accepted.
  - `tests/autosave_browser.py:61` keeps passing: its `BOOT` has no `library`, so the prompt still appears.
  - Device autosave stays available in the profile dialog.

### 3.9 Worker routes (`deploy/cloudflare-edge/src/app.js`)

**Inside the existing external-role block** (`app.js:124-129`, before its final 403):
```js
if (request.method === 'GET') { const m = /^\/go\/confirm\/([a-f0-9]{32})$/.exec(url.pathname);
  if (m) return new Response(null, { status: 302, headers: headers(env, { Location: '/confirm#' + m[1] }) }); }
```
**After the external-role block**, for everyone else:
```js
if (request.method === 'GET' && url.pathname === '/go/signed-in') return new Response(SIGNED_IN_HTML, { headers: headers(env, { 'Content-Type': 'text/html; charset=utf-8' }) });
if (request.method === 'GET' && url.pathname.startsWith('/go/')) {
  const m = /^\/go\/(?:(start)|(gap|invitation|bid|library|confirm)\/([a-f0-9]{32}))$/.exec(url.pathname);
  const to = !m ? '/' : m[1] ? '/#start' : m[2] === 'confirm' ? '/confirm#' + m[3] : '/#' + m[2] + '/' + m[3];
  return new Response(null, { status: 302, headers: headers(env, { Location: to }) });
}
// … existing routes …
// Last, before the final JSON 404: a browser navigation to an unknown page goes home.
if (request.method === 'GET' && !url.pathname.startsWith('/api/') &&
    (request.headers.get('Sec-Fetch-Mode') === 'navigate' || /text\/html/.test(request.headers.get('Accept') || '')))
  return new Response(null, { status: 302, headers: headers(env, { Location: '/' }) });
```

**Links switch to the path form:**
- `emailN1` (`src/app.js:78`) → `location.origin + '/go/library/' + id`;
- `outreach.js:31` `PATH` → `/go/invitation/<id>`, `/go/gap/<id>`, `/go/confirm/<id>`;
- `claims.js:175` → `/go/confirm/<id>`;
- `teams.js:151` → `/go/invitation/<id>`;
- `gaps.js:136` → `/go/gap/<id>`.

Old fragment links keep working.

**Deviation from WOW §0 rule 7, recorded.** Rule 7 puts request ids "in the `#fragment`" only. With `/go/` links, ids appear in request paths, so they reach Cloudflare edge and Access logs and the browser history. This is accepted because the ids are random, non-secret and grant nothing without sign-in (authorization stays server-side). No token ever goes in a path. The Worker's own metrics never log `/go/` paths.

### 3.10 `ATLAS_HOME` at build time (`build.py`)

- `build.py` reads `deploy/cloudflare-edge/wrangler.jsonc`, drops full-line `//` comments (the `tests/test_edge.py` rule), runs `json.loads`, and takes `vars.ORIGIN`.
- An `ATLAS_HOME_URL` environment variable at build time overrides it (for a future Mantu domain).
- The value must match `^https://[a-z0-9.-]+$`, or else it becomes `''`.
- A new slot, `__ATLAS_HOME__`, renders as `<script>window.ATLAS_HOME="https://atlas.tony-walteur.workers.dev";</script>`.
- The value is public (it is already in the repo) and grants nothing, because the target is behind Access.

---

## 4. Z2: every variable, flag and decision, classified

(a) on by default with no setup · (b) replaced by a per-user consent prompt at the moment of use · (c) needs an external credential or decision: the feature is absent or shows one quiet line, and never blocks the interview.

| Item (WOW §2, §5, §7 and the Worker config) | Class | Behaviour after this amendment | Who unblocks (c) |
|---|---|---|---|
| `ORIGIN`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | (a) | Deployment constants already in `wrangler.jsonc` | |
| `CSRF_SECRET` | (a) | Generated by `deploy.sh` on first deploy | |
| Access policy admitting pilot users | (c) | Only Tony can sign in until it changes. An Access "Emails ending in" rule for the Mantu domains (VERIFIED selector, §13) needs **no per-user step**. On the current test deployment, admitting colleagues also means real project data on a personal account: the §11 item 2 prerequisite applies (WOW §0 rule 3) | Tony (Cloudflare dashboard); domain list from Mantu IT |
| `IDENTITY_SOURCE`, `ENTRA_TENANTS`, `ENTRA_REQUIRED_ROLE`, Entra connector | (c) | Today: PIN sign-in. With Entra: usually silent on Mantu-managed browsers, one Microsoft sign-in otherwise, plus sign-in name claims (§5.5). **Per-user gate:** `ENTRA_REQUIRED_ROLE=ATLAS.Interview` (`entra/README.md:24`, enforced at `app.js:53`) admits only people assigned that app role. Assign it to **a group that covers all consultants**, or leave `ENTRA_REQUIRED_ROLE` unset and gate with an Access policy on the Entra group or the Mantu email domains | Mantu IT (`entra/README.md`); Tony runs `enable_entra.sh` |
| `ADMIN_EMAILS` | (a) | Set | |
| `REVIEWER_EMAILS` | (a) | Empty by default; affects only the review queue | |
| `EXTERNAL_EMAILS` | (c) + legal | Safe default unset; never on the interview path | Tony and legal (Q3) |
| `STT_MODEL`, `TTS_MODEL`, `TTS_VOICE`, `TALKER_MODEL`, `ANALYST_MODEL`, `EMBED_MODEL`, `STT_LANGUAGE`, `TTS_MODEL_ES`, `TTS_VOICE_ES`, `TURN_MODEL`, `READY_SCORE`, `ELEVENLABS_MODEL`, `ELEVENLABS_VOICE_ID`, `JEV_MODEL`, `HINDSIGHT_URL`, `HINDSIGHT_BANK_SECRET` | (a) | Defaults in `wrangler.jsonc` or code | |
| `ELEVENLABS_API_KEY` | (c) | Without it, ATLAS understands other languages and answers in English or Spanish, with the existing one-line `language` note | Tony (optional key) |
| `HINDSIGHT_API_KEY` | (c) | Without it: no memory clause in the consent sentence, no switch, no memory panel (this fixes today's false promise). With it: the memory clause and switch (§3.4) | Tony (optional key) |
| `TYPESAFE_API_KEY` | (c) | Without it, the interview's `rankProbe` and memory relevance are skipped silently | Tony (optional key) |
| Customer JEV ranking in bids | (b) | Already per-request consent (WOW F1.5) | |
| `TEST_VOICE` | (a) | Test only; off | |
| `TRIGGER_SECRET` + Access bypass for `/api/triggers` | (c) | PM-system invitations absent; the interview is unaffected | Staffing tool owner |
| Module `READY` constants | (a) | Flipped at WOW integration by acceptance tests; not a variable | |
| `SPOKEN_ASK` | (b) | **Variable removed.** `features.spokenAsk = on('ask') && SPOKEN_ASK_APPROVED`. The first voice question shows a consent prompt (§8): "Allow this time" or "Always allow for me" (stored server-side in `profiles.consents`, revocable). The reminder and a recording indicator show on **every** recording. See D1 | D1 approved by Tony (recorded 2026-09-29) |
| `PDF_BRIEFS` | (a) | **Variable removed, no constant.** `features.pdfBriefs = on('bids')`. PDFs go through `toMarkdown` with `conversionOptions: {pdf: {metadata: false}}`. Images stay refused. A PDF that yields no text (a scan) gives an explicit message. See D2 | |
| `CLIENT_CONFIRM` | (c) + legal | Safe default off; not on the interview path | Tony and legal (Q3), Access PIN policy |
| `TEAMS_ENABLED`, `TEAMS_APP_ID`, `TEAMS_BOT_APP_ID`, `TEAMS_TENANT_ID`, `TEAMS_BOT_SECRET` | (c) | Simplification (T3 file): Teams counts as enabled when the ids and the secret are all present (no `TEAMS_ENABLED`), and `TEAMS_BOT_APP_ID` defaults to `TEAMS_APP_ID`. When absent, only the reviewer outreach queue shows its chip | Mantu IT, Azure owner, Teams admin (WOW §5) |
| TeamsJS vendoring | (c) | The launcher answers 503 until vendored | T3 or Tony |
| Phone | (c) | Absent | Mantu procurement |
| Staffing CSV import (F4) | (a) | Works today (admin) | |
| Rate limits | (a) | Code constants | |
| Q1 PDF conversion | resolved | VERIFIED as text extraction, re-checked for this revision (§13). D2 | |
| Q2 thresholds | (a) | Labelled uncalibrated | |
| Q3 client confirmation | (c) | Safe default off | Tony and legal |
| Q4 N+1 authority | (a) | Staffing, then the directory (DNA or export, server rows only), then self-declared | |
| Q5 bot issuer | (c) | Test tenant | Mantu IT |
| Q6 Entra-mode email features | (c) | Unchanged. The profile works in both modes (keyed by `x-atlas-user`) | Mantu IT |
| Q7 defects | partly fixed | The ignored memory checkbox is fixed: memory is in the consented sentence and the switch works (§3.4). Self-declared `managerStaff` is unchanged and never prefilled true. Others are unchanged | |
| Q8 sentence split, Q10 residual inference | (a) | | |
| Q9 in-tab Teams | (c) | Launcher only | Tony, Mantu IT |
| Q11 spoken Ask | (b) | D1, approved: `SPOKEN_ASK_APPROVED = true` | |
| Q12 claim currency, Q13 per-story win rates | (a) | Safe defaults; not on the interview path | Tony; HR/legal before reviewers use Q13 |
| **New:** `ATLAS_HOME` | (a) | From `wrangler.jsonc` at build | |
| **New:** `DATA_MODE` | (c) | Unset means test mode: the banner and readiness string stay as today; DNA connector and push are `BLOCKED_EXTERNAL`; the export import accepts reserved test addresses only (§5.6). `production`: no banner, readiness `production`, HR-data paths allowed when configured | Tony, only on a Mantu-owned Cloudflare account after Mantu IT approval and DPO sign-off (§11 item 2) |
| **New:** `DNA_PROFILE_URL`, `DNA_AUTH_HEADER`, `DNA_FIELD_MAP`, secret `DNA_API_KEY` (pull, ASSUMED shape) | (c) | `BLOCKED_EXTERNAL` with the `needs` of §5.3 | Mantu IT / DNA owner |
| **New:** secret `DIRECTORY_PUSH_SECRET` + Access bypass for `/api/directory/push` (push) | (c) | `BLOCKED_EXTERNAL` until set; production mode only | Mantu IT / HR job owner; Tony adds the bypass |
| **New:** DNA export CSV | (c) | Real exports only in production mode. In test mode: synthetic rows only | HR / DNA owner supplies the file after DPO sign-off; an admin imports it |
| **New:** Access IdP claims `name`, `given_name`, `family_name` (Entra optional claims `given_name` and `family_name`) | (c) | Absent: no sign-in name source | Mantu IT, with Entra enablement |

**Decision confirmed by Tony (recorded 2026-09-29): "it should just work and ask for consent and that's it".** It is a code constant in `features.js`, not a deployment variable, now flipped: `SPOKEN_ASK_APPROVED = true` (like a `READY` flag), so `features.spokenAsk` follows `features.ask`. The consent prompt at the moment of use and the server-side consent check below are unchanged. Set back to `false`, the feature is simply absent again. It never blocks an interview.
- **D1 (spoken Ask, Q11).** Tony's direction ("ask for consent and that's it") is read as replacing the flag with a consent prompt at the moment of use. This **extends WOW rule 4's single STT exception** from "a consented live interview" to "a consented spoken Ask question".
  - The prompt asks the user not to say client names, and a one-line reminder plus a recording indicator stay visible next to the microphone button on every recording, including after "Always allow".
  - The transcript is shown and editable, and it is pseudonymised before any other model (WOW §2.3, unchanged).
  - `X-Atlas-Consent: spoken-ask-v1; once|always` is a **UI gate**: it proves the page showed the prompt, not that the person agreed.
  - For `always`, the Worker checks the stored `profiles.consents.spokenAsk` through `GET /api/library/profile/consents` before transcribing, and a missing or revoked consent gets 403.
- **D2 (PDF briefs, Q1): recorded, not pending.** WOW Q1 kept PDFs off "until someone verifies this in the current Cloudflare docs and records the answer". That verification is in §13, and it was repeated for this revision: PDF conversion extracts metadata and per-page text (through the `StructTree` or as-is), and models are used only for **images**. The refinement to WOW rule 4: `toMarkdown` on a PDF is not a model call; `toMarkdown` on an image still is, and images stay refused. The residual risk is that Cloudflare changes the PDF pipeline, so the check is repeated at each dependency review.

---

## 5. Z3: profile prefill from DNA

### 5.1 Profile fields (minimal)

| Field | Meaning | Editable | Used for |
|---|---|---|---|
| `email` | Verified sign-in email | **No.** It is the identity: gap assignees and confirmers are authorised by it, so an editable value would allow impersonation | Display |
| `name` | Full name | Yes | Project consultant (only when not a guess, §3.5), avatar initials, consent footer |
| `preferredName` | "First name shown on screen" | Yes. Its default is the source `givenName` (§5.7) | Consent heading |
| `title` | Job title | Yes | Project role prefill (`roleFrom: 'profile'`), people lookup |
| `managerName`, `managerEmail` | N+1 | Yes (`managerEmail` ≠ own email, and not in `EXTERNAL_EMAILS`) | Project N+1 prefill |

Provenance per field, `from`: `'you'` (you edited or confirmed) · `'dna'` (connector or push) · `'dna_export'` (admin CSV import) · `'signin'` (Access / Entra claims) · `'guess'` (from the email). Business unit, location, languages and a manager-staff flag are **not** built: no feature uses them (§5.10).

### 5.2 Sources and precedence

`SOURCES = ['you', 'dna', 'dna_export', 'signin', 'guess']`, merged **per field**: the first source with a non-empty value wins. This is Tony's requested order (DNA first, editable). Per-field merging means DNA still supplies title and N+1 when the sign-in claims give only a name.

| Source | Works today? | Gives | Key |
|---|---|---|---|
| `you` | **yes** | any field | `profiles.edits` |
| `dna` (push §5.4, or pull §5.3) | no: needs `DATA_MODE=production` and Mantu IT configuration | name, given name, title, N+1 name and email | sign-in email, or `oid` in Entra mode |
| `dna_export` | no for real data (production only, §5.6); synthetic rows in test mode | the approved columns | email |
| `signin` claims | no with the PIN; only with Entra plus claims (§5.5) | name, given name | the verified JWT |
| `guess` | **yes** | name, and a given name when the email's local part has one (§5.7) | email |

**Stated plainly:** on today's deployment (PIN sign-in, test mode), the profile comes **only from the user's own edits and the email guess**. Title and N+1 are typed once, in the profile or on the first project form (today's "last project's N+1" fallback carries it forward, and §3.6 brings it back after a reload), and they are remembered server-side in `profiles.edits`.

**Edits are not forever.** Each edit stores `basis`, the winning source value at the time of the edit. When a source later reports a different value (after a reorganisation, say), the `Profile` field carries `newer: {value, from}`. The profile shows "DNA now says {value}. [Use it] [Keep mine]". Use it clears the edit; Keep mine re-saves the edit with the new basis.

### 5.3 DNA pull connector (generic HTTPS JSON; **shape ASSUMED**)

Nobody has confirmed how DNA is reached. This connector works only if **all** of the following hold. They are listed verbatim in its `BLOCKED_EXTERNAL` `needs`:
- "DNA answers HTTPS from the public internet (Cloudflare Workers have no fixed egress IP, so an IP allow-list cannot work)";
- "authentication is a static header or bearer key (mTLS would need a new binding, which is not allowed)";
- "one person can be looked up by email or Entra object id";
- "a production deployment (`DATA_MODE=production`)".

If any of these fails, use the push option (§5.4) or the export (§5.6). Nothing quietly falls back.

- **Variables:** `DNA_PROFILE_URL` (a template), `DNA_AUTH_HEADER` (a header name, default `Authorization`), `DNA_FIELD_MAP` (JSON), and the secret `DNA_API_KEY` (the full header value, as IT specifies). Tony sets them with `wrangler secret put`. They are documented as full-line comments in `wrangler.jsonc` with no values.
- **`dnaConfig(env)`** answers `{status: 'BLOCKED_EXTERNAL', reason, needs}` unless `DATA_MODE === 'production'`, push is not configured (if both are set, push wins and pull is never called), and all four variables exist and validate:
  - the template is `https:`, has no user-info or fragment, and has exactly one placeholder, `{email}` or `{oid}` (substituted with `encodeURIComponent`);
  - no query key matches `/key|token|secret|sig|password|auth/i` (no credentials in URLs);
  - the map is JSON with keys drawn from `root, name, givenName, title, managerName, managerEmail`. Each value is a dotted path matching `^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+){0,7}$`, and at least `name` or `givenName` is present.
- **Request:** `GET`, `redirect: 'manual'` (any 3xx is an error and is never followed), a 2.5 s timeout, `Accept: application/json` and `{[DNA_AUTH_HEADER]: DNA_API_KEY}`, through the injectable `fetcher` (WOW §0 rule 3).
- **Response:** 200 with a JSON content type and at most 65,536 bytes, or else an error. `root` is applied, then each mapped path. Strings are bounded as in §6, and emails are validated. 404 → `not_found`; 401/403 → "DNA refused the key (HTTP n)" (admin view only). **Only mapped fields are stored, never the raw response.**
- **Called only for the signed-in subject's own profile.** It is never called for a third party (people lookup, F2, F3 read stored rows only, §5.8).
- **Cache:** a `directory` row `(key, 'dna')`, fresh for 24 h. When stale, the cached value is served and the refresh runs in `waitUntil`. A cold first profile read waits at most 2.5 s, then returns what it has.
- **Logs:** `{atlas_metric: 'dna_lookup', ms, status}`, numbers only.

### 5.4 DNA push (equal option; no inbound path into DNA, no new binding)

- **Flow:** a DNA or HR job that Mantu IT runs POSTs directory rows to `POST /api/directory/push` on the Worker, with `Authorization: Bearer <DIRECTORY_PUSH_SECRET>`. This is the **same pattern as `/api/triggers`** (`app.js:98-104`): pre-Access, an Access bypass on that path only, a timing-safe comparison, and a forward to `LibraryStore` as role `system`.
- **Body:** `{batch: 32hex, part: 1..40, final: boolean, rows: DirectoryRow[≤500]}`, at most 262,144 bytes. It reuses the directory import code (§5.6) with `source: 'dna'`. The final part replaces the older `dna` rows, subject to the shrink guard (§5.6).
- **Gates:** `DIRECTORY_PUSH_SECRET` set and `DATA_MODE === 'production'`, or else 401 / `BLOCKED_EXTERNAL`. Only the approved columns are accepted, and unknown keys are rejected per row.
- **Recommended to Mantu IT** as the default: DNA needs no internet-facing API, the job controls what leaves DNA, and ATLAS keeps no DNA credential.

### 5.5 Access sign-in claims (VERIFIED, §13)

- Custom OIDC claims configured on the Access IdP arrive in the Access JWT's **`custom`** object, "best effort". Access trims the serialized `custom` **from the end of the list first** when it exceeds about 1 KB.
- **Order matters.** `enable_entra.sh:9` today lists `["tid","oid","roles","preferred_username"]`. The name claims are **appended after** `preferred_username`, giving `["tid","oid","roles","preferred_username","name","given_name","family_name"]`, so a long name or many roles trims the name claims first and never the identity claims that `entraIdentity` (`app.js:47-55`) needs. `groups` must not be added.
- The documented `get-identity` fields do not list a name, so ATLAS does not call `get-identity`.
- Entra v2 ID tokens carry `given_name` and `family_name` only as optional claims requiring the `profile` scope (VERIFIED). `name` is a standard `profile` claim (ASSUMED; check in the test tenant).
- **Worker:** after `verifyAccess()` succeeds, a new `signinClaims(request)` decodes the same, already verified, JWT payload's `custom` and keeps `name`, `given_name` and `family_name`, each a string of at most 100 characters (`name` is composed from the other two when absent). `verifyAccess`'s return value is unchanged, so its existing `deepEqual` assertion holds. The Worker **always overwrites** `x-atlas-idp = base64url(JSON)` (`e30` for `{}`) on every `/api/library` forward, so a browser can never inject it.

### 5.6 DNA export CSV, and the test-mode guard

- **Class (c).** A real export may be imported only when `DATA_MODE === 'production'`. The prerequisites: a Mantu-owned Cloudflare account or a production sign-off, the test banner removed (the same variable does it), and DPO sign-off on the column list.
- **Test mode** (`DATA_MODE` unset): `POST /api/library/directory/import` accepts only rows whose email is under a reserved test domain (`example.com`, `example.org`, `example.net`, or the `.test`, `.example` or `.invalid` top-level domains; RFC 2606 / 6761). Any other row is rejected as "row n: this test deployment accepts synthetic addresses only". Real HR data therefore cannot land on the test deployment by accident, and the import can still be tested.
- **Admin UI** (Insights → "People directory"):
  - The admin chooses a CSV, and the browser parses it (UTF-8 with or without BOM; `,`, `;` or tab delimiter; RFC 4180 quotes).
  - It suggests a column for **only the approved fields**, as UI defaults the admin confirms: email (`e-mail`, `mail`, `adresse e-mail`, `courriel`); name (`name`, `nom complet`, `display name`); given name (`first name`, `prénom`); title (`title`, `job title`, `fonction`, `poste`); N+1 name and N+1 email (`manager`, `N+1`, `responsable`, with or without `mail`).
  - **Every other column is dropped in the browser before upload**, and the payload is built from the mapped columns only. The server rejects unknown row keys as a second guard.
- **Import:**
  - Rows are sent in batches of at most 500 and staged under the batch id.
  - On `final`, the old rows of that source are replaced. **Shrink guard:** before the final part, the UI shows "This replaces {N} rows with {M}." When M < 0.8·N, a second confirmation is required, and the server enforces it: a final part with M < 0.8·N and no `confirmShrink: true` answers 409 and discards the staged batch. A push job cannot confirm, so a shrunken push is refused and shown in the admin view.
  - Rejected rows are reported by row number only, never by value.
- Admin only. Audit: `directory_import`, with row counts only.

### 5.7 Email guess and the on-screen first name

- **`emailGuess(email)`**: take the local part, split on `.`, `_` or `-`, drop digits, capitalise. It returns `{name, givenName?}`, where `givenName` is the first part only when there are at least two parts and that part has at least two letters. `tony.walteur` → name "Tony Walteur", given name "Tony". `j.dupont` → "J. Dupont", no given name. `jdupont` → "Jdupont". The source is always `'guess'`.
- **`firstName(profile)`** (display only, for the consent heading), in order:
  1. `preferredName` from `you`;
  2. `givenName` from `dna`, `dna_export` or `signin`;
  3. a confirmed guess's `givenName` (after "Yes, that's me", which turns it into `'you'`);
  4. otherwise `''`.
- It **never uses the first word of `name`**: HR exports often read "DUPONT Jean". It never uses an unconfirmed guess.
- Validation: `^[\p{L}\p{M}](?:[\p{L}\p{M}'’. -]{0,28}[\p{L}\p{M}.])?$`, at most two words, no brackets or digits; otherwise `''`. Rendered with `textContent` only.

### 5.8 Where the profile is used

| Use | How |
|---|---|
| Project form | Prefill with chips computed at render time (§3.5) |
| Auto-created projects (after an interview, invitation or gap) | Prefill, with `roleFrom` (§3.5) |
| Consent heading and footer | First name and name, on screen only (§3.4) |
| N+1 name from a typed email; gap assignee name (F2 `#gapEmail`) | `GET /api/library/people?email=` returns `{name, title}` from **stored `directory` rows only** (`dna`, `dna_export`). It never calls DNA and never reads another user's `profiles.edits` |
| F3 confirmer | `claims.js` confirmer resolution becomes staffing, then **`directory`** (the owner's N+1 from a stored `dna` or `dna_export` row, never the owner's own edits), then `self_declared`. `manager_source` gains the value `'directory'` (TEXT column, no `ALTER`); the badge reads "N+1 from DNA" |
| F2 server | `gaps.js` fills a blank `assignee_name` from `lookupPerson()` (stored rows only) |
| Avatar | `#profileButton` shows initials instead of "ME" |

`managerStaff` is never prefilled true (it skips N+1 validation, WOW Q7). Only the human tick sets it.

### 5.9 Model boundary (rule 0.4)

| Model path | Today | After |
|---|---|---|
| Talker (`talkerMessages`, `projectContext`) | `consultant` (name, sometimes the email), `role` | `projectContext` **drops `consultant`**. This is done first in `atlas_voice/interview.py` `project_context` (the source of truth), then in the JS port (the key is still accepted, for older pages). The browser sends `consultant: ''`, and sends `role` only when `roleFrom` is not `'profile'` |
| Greeting | Fixed text | Unchanged. No name is spoken |
| Report model | History | Unchanged (no name in the history) |
| Review, index embeddings, recommend, insights, slides, bids, Ask (`forModel` / `recordView`) | `consultant: {name, role}`, plus merge text with a name or email | `forModel` also drops `consultant`. `forModel` output is not hashed (WOW §2.3), so no record reopens. **The merge text becomes "Contribution by another consultant:"** (`library.js:269`), and `recordView` strips a legacy `Contribution by <x>:` prefix from stored answers |
| JEV classify, Hindsight retain | `role`; the whole `libraryPayload` | Built with `modelProject()` (below) |
| DNA | none | Not a model. It receives the email or `oid` only |

**`modelProject(x, roleFrom)`** lives in `src/profile-core.js`. It returns a copy of a project-shaped object with the consultant name blanked (`x.consultant`, or `x.consultant.name` in the library payload shape). It also blanks the role (`x.role` or `x.consultant.role`) when `roleFrom === 'profile'`. **Every other key is kept, `client` included**, because the server scrubs with it (`memory.js:48, :96` `scrub(…, payload.client)`). It is the only producer of project data for `voiceSnapshot`, the `/api/jev/classify` body and `rememberInterview` (`modelProject(libraryPayload(p), p.roleFrom)`). `syncToLibrary` keeps the full payload: the library is not a model, and `forModel` strips it server-side.

### 5.10 Privacy: minimal fields, retention, readers

- **Minimal.** The approved list is email, name, given name, job title, N+1 name and N+1 email. Business unit, location, languages and manager-staff flags are not fetched, imported or stored (GDPR data minimisation). DPO sign-off on this list is part of the production prerequisite (§11). French works-council consultation is Tony's call.

| Data | Stored | Who can read it | Retention |
|---|---|---|---|
| Own profile (edits, sign-in claims, consents) | `LibraryStore.profiles`, keyed by `x-atlas-user` | The subject only (`GET /profile`). No admin, reviewer or people-lookup route reads it | Deleted by the user ("Delete my profile") or by `profile.daily()` 395 days after `seen_at` |
| Directory rows (`dna`, `dna_export`) | `directory` | Server code. Any signed-in user can resolve **one exact email to `{name, title}`**, 30 lookups per hour (for N+1 and gap-assignee forms). Admins see counts | Replaced by each full import or push. `clear` removes all. Pull-cache rows are fresh for 24 h and purged after 30 days |
| Audit | existing `audit` | As today | Field names and counts only, never values |

- **For the DPO:** the people lookup lets a colleague who knows an exact Mantu email see that person's name and job title (never the N+1), which matches an internal address book. There is no search, wildcard or listing.
- **"Delete my profile"** removes `profiles` data (edits, claims, consents). It does **not** remove the person's DNA or export row, which is admin-managed and replaced by the next import or push. The dialog says so.
- **Entra switch:** the key changes from email to `tid:oid`, so edits made under the email are not carried over. Sources refill the profile, and users re-edit if needed (documented, accepted).

---

## 6. API contracts

All `/api/library/*` paths go through the existing Worker forward: Access identity, `x-atlas-user`, `x-atlas-role` and `x-atlas-email` overwritten, plus the new `x-atlas-idp`. POST needs `Origin` equal to `ORIGIN` and `X-Atlas-CSRF` (Worker-enforced). The 262,144-character body limit applies. New words in `features.js` `WORDS`: `profile`, `people` and `directory` → `profile.routes`, with `MODULE` entries so the `READY` gate applies. They are not in `EXTERNAL_WORDS` or `EMAIL_AUTH_WORDS`, so they work in both identity modes and externals get 403. Errors and `BLOCKED_EXTERNAL` follow WOW §2.6.

| Method, path | Who | Request | Response |
|---|---|---|---|
| `GET /api/library/profile` | user, reviewer, admin | none | `Profile` (awaits a cold pull source for at most 2.5 s) |
| `POST /api/library/profile` | same | `{set?: Partial<{name ≤100, preferredName ≤40, title ≤100, managerName ≤100, managerEmail ≤200}>, clear?: FieldName[], confirmGuess?: true}` | `Profile`. 400 on a bad value ("Your N+1 can't be you.", "Check the N+1 email address.") |
| `POST /api/library/profile/delete` | same | `{}` | `{deleted: true}` |
| `POST /api/library/profile/consent` | same | `{kind: 'spokenAsk', version: 1, granted: boolean}` | `Profile` |
| `GET /api/library/profile/consents` | same; also the Worker for `/api/transcribe` | none | `{spokenAsk: {version, at} \| null}` (reads the `profiles` row only; no sources) |
| `GET /api/library/people?email=` | user, reviewer, admin | exact email | `{email, name, title, from}` from stored `directory` rows, or 404. 429 beyond 30 per hour. Never the N+1, no search or wildcard, never a DNA call, never `profiles` |
| `GET /api/library/directory` | admin | none | `DirectoryStatus` |
| `POST /api/library/directory/import` | admin; `system` (push forward) | `{batch: 32hex, part: 1..40, final: boolean, rows: DirectoryRow[≤500], confirmShrink?: true}` | `{accepted, rejected: [{row, reason}], replaced?: {from: N, to: M}}`. 409 on a final part with M < 0.8·N and no `confirmShrink` |
| `POST /api/library/directory/clear` | admin | `{}` | `{cleared: n}` |
| `POST /api/directory/push` (Worker, pre-Access, bypass) | bearer `DIRECTORY_PUSH_SECRET` | as import | as import; `source: 'dna'` |
| `GET /api/memory/settings` (Interview DO, new) | signed-in | none | `{off: boolean}` (DO storage only; no Hindsight call) |
| `POST /api/transcribe` (WOW F6, T1) | signed-in, not external | unchanged, plus the header `X-Atlas-Consent: spoken-ask-v1; once\|always` (403 "Voice questions need your consent first." without it, or for `always` without a stored consent) | unchanged; gated by `features.spokenAsk` |
| `GET /go/…` (Worker) | signed-in (`/go/confirm/…` also external) | none | 302, or the signed-in page (§3.9) |

```ts
FieldName = 'name'|'preferredName'|'title'|'managerName'|'managerEmail'
Source = 'you'|'dna'|'dna_export'|'signin'|'guess'
ProfileField = { value: string, from: Source, at: string /* ISO */, newer?: { value: string, from: Source } } | null
Profile = { email: string, fields: Record<FieldName, ProfileField>, firstName: string, guessed: boolean /* name is only a guess */,
  consents: { spokenAsk?: { version: 1, at: string } },
  sources: { id: Exclude<Source, 'you'>, state: 'ok'|'not_found'|'off'|'error' }[] /* 'off' = not configured; no reasons for non-admins */,
  updatedAt: string }
DirectoryRow = { email: string, name?: string, givenName?: string, familyName?: string, title?: string, managerName?: string, managerEmail?: string }
SourceStatus = { status: 'on'|'BLOCKED_EXTERNAL'|'error', reason?: string, needs?: string[], lastOkAt?: string, lastError?: string /* HTTP status only */ }
DirectoryStatus = { dataMode: 'test'|'production', rows: { dna: number, dna_export: number },
  lastImport: null | { at, by, source, rows, rejected }, sources: { pull: SourceStatus, push: SourceStatus, dna_export: SourceStatus, signin: SourceStatus } }
```

**Bootstrap (additive):**
- `features.profile = on('profile')`, gated by `profile.READY` like every WOW module (WOW §2.1, §2.5).
- `features.spokenAsk = on('ask') && SPOKEN_ASK_APPROVED` (D1).
- `features.pdfBriefs = on('bids')` (D2). This intentionally changes the T1-S0 assertion "`pdfBriefs` false without `PDF_BRIEFS`" (§9).
- `readiness` is `'production'` when `DATA_MODE === 'production'`, else today's `'edge-deployment-test-data-only'`, and the `GET /` banner follows it.

**`profile.js` exports** (asserted by `test/features.test.js`): `READY, routes(ctx), ensure(lib), resolveProfile(lib, env, user, idp, {fetcher, now}), firstName(profile), emailGuess(email), lookupPerson(lib, email), directoryManager(lib, email), dnaConfig(env), pushConfig(env), testAddress(email), daily(lib, now)`. `lookupPerson` and `directoryManager` take no fetcher: they read stored rows only.

**`Session`** (T2 file): no new option. `projectContext` drops `consultant` (§5.9). `languages.js` is unchanged.

---

## 7. Storage (LibraryStore SQLite; new tables only; `profile.ensure(lib)` memoised per instance)

```sql
CREATE TABLE IF NOT EXISTS profiles (subject TEXT PRIMARY KEY /* x-atlas-user: email (Access) or tid:oid (Entra) */,
  email TEXT /* verified sign-in email at last visit, may be '' */,
  edits TEXT /* JSON {field: {value, at, basis}}; the user's own values and the source value they replaced */,
  signin TEXT /* JSON {name, givenName, at}; mapped claims only */,
  consents TEXT /* JSON {spokenAsk: {version, at}} */,
  created_at TEXT, updated_at TEXT, seen_at TEXT /* updated at most daily */);
CREATE TABLE IF NOT EXISTS directory (key TEXT /* lower-case email, or 'oid:<oid>' */, source TEXT /* dna | dna_export */,
  name TEXT, given_name TEXT, title TEXT, manager_name TEXT, manager_email TEXT, batch TEXT, fetched_at TEXT,
  PRIMARY KEY (key, source));
CREATE TABLE IF NOT EXISTS directory_imports (batch TEXT PRIMARY KEY, source TEXT, by TEXT, started_at TEXT, finished_at TEXT,
  rows INTEGER, rejected INTEGER, state TEXT /* staged | applied | refused */);
```

- `profile.daily(lib, now)` is called from the existing system `scan-stale` block in `library-routes.js`, next to `outreach.daily`. It deletes profiles with `seen_at` older than 395 days, pull-cache `dna` rows older than 30 days (rows from a push are replaced by the next push instead), and staged batches older than 1 day. It returns counts.
- **Browser storage:** only the `atlas.reauthAt` timestamp in `sessionStorage` (§3.7). The engine keeps one provenance field, `roleFrom` (§3.5).

---

## 8. UI copy

**Consent (edge):**
- Eyebrow: "BEFORE WE START".
- Heading: "Ready when you are, {first name}." or "A conversation with ATLAS."
- Body (unchanged): "ATLAS will ask about this project out loud and listen to your answers. It takes fifteen minutes at most, and you can pause or stop at any time."
- The one tick (memory on): "I agree that this conversation is transcribed and saved with a report to my project, and that, once reviewed and validated, it may be used as reference material for future Mantu projects. ATLAS also keeps a private memory of our conversations, stored with its memory service (Hindsight), so it can pick up where we left off. I can see or erase it in my profile. I am allowed to share this project's details."
- The one tick (memory off or not configured): the same without the two memory sentences.
- Memory switch: "Turn off memory for my conversations" / "Turn on memory".
- Tip: "Your browser will then ask to use your microphone. Headphones give the clearest conversation."
- Button: "Start conversation".
- Footer: "Signed in as {name} · {email}" or "Signed in as {email}".

The memory sentence is new consent copy: the DPO reviews it together with the column list (§11).

**After an interview with a guessed name:** "Is your name {guess}? [Yes, that's me] [Edit]".

**Offline copy:**
- Start link: "Open ATLAS ↗".
- Dialog: "This is an offline copy of ATLAS." / "Conversations run in the live ATLAS workspace. It opens in a new tab and signs you in with your Mantu account."
- When local projects exist: "Projects saved in this offline copy stay here. To take them with you, use Backup ↓ here, then Import in ATLAS."
- Disclosure: "Use a different ATLAS address".

**Network (live origin not answering):** "ATLAS isn't answering right now. [Try again]"

**Sign-in:**
- "Your sign-in expired. Your work is kept on this page. [Reconnect]"
- "You're signed in again. Nothing was lost."
- "Signing you in didn't work. [Backup ↓] then [Reload and sign in]"
- Signed-in window (`/go/signed-in`, visible for a moment): "You're signed in. This window closes by itself."

**Returning user:** "Your projects are back from ATLAS."

**Storage strip (live):** "Saved to ATLAS" · "Saving to ATLAS…" · "Not saved to ATLAS yet · kept in this tab · Retry".

**Profile section** (top of `#profileDialog`, live only):
- Title: "You". Intro: "ATLAS fills in forms with this, so you don't have to. Change anything that's wrong."
- Labels: "Name", "First name shown on screen", "Email (your sign-in)", "Job title", "N+1 (line manager)", "N+1 email".
- Chips: "from DNA" · "from the DNA export ({date})" · "from your sign-in" · "guessed from your email: please check" · "you edited".
- Guess: "Is this right? [Yes, that's me] [Edit]".
- Newer source value: "DNA now says {value}. [Use it] [Keep mine]".
- Buttons: "Save" · "Delete my profile".
- Delete confirmation: "This deletes your edits and consents. Values from DNA come back from DNA; ask your admin if they are wrong."
- Privacy: "Only you can open this profile. ATLAS's AI never reads it. DNA values refresh daily and your edits win until DNA changes. Colleagues who type your exact email see only your name and job title. Unused profiles are deleted after 13 months."
- Voice questions: "Voice questions: allowed · Revoke".

**Project form:**
- Top line: "Filled in from your profile. Changes here apply to this project only."
- Chips as above.
- Role hint: "Your job title from your profile. If your role on this project was different, change it. ATLAS's AI only sees a role you typed yourself."

**Spoken Ask:**
- Prompt title: "Ask by voice".
- Prompt body: "Your question is recorded (up to 30 seconds) and turned into text by ATLAS's speech recognition. Nothing is kept. Please don't say client names: type them instead, because typed names are masked before any AI step."
- Buttons: "Allow this time" · "Always allow for me" · "Cancel".
- Next to the microphone button, on every recording: "Recording · {s}s · Don't say client names; type them."

**Admin, People directory:**
- Production: "Upload the DNA export as CSV. Only email, name, first name, job title and N+1 are read; every other column stays on your computer. Nobody can browse this directory."
- Test mode: "Test deployment: only synthetic addresses (example.com, .test) are accepted. Real DNA data needs the production deployment."
- Before the final part: "This replaces {N} rows with {M}." and, when M < 0.8·N, "That is far fewer people than before. Replace anyway?"
- Result: "{n} people imported · {k} rows skipped (rows 18, 403: no valid email)".
- Source lines: "DNA push: not connected (needs the push secret from Mantu IT and the production deployment)" · "DNA pull: not connected (needs {needs})".

---

## 9. Tests to add

**Edge (`deploy/cloudflare-edge/test/`, `node --test`):**
- **`profile.test.js`** (new):
  - per-field precedence across the five sources, and provenance;
  - `newer` appears when a source value differs from the edit's `basis`; Keep mine updates the basis;
  - `emailGuess` cases (including `givenName` only for two or more parts);
  - `firstName`: guess → `''`; `confirmGuess` → given name; "DUPONT Jean" from `name` alone → `''`; invalid names (`<system>`, digits, three words) → `''`;
  - edits, clear and delete (delete leaves `directory` rows);
  - validation (lengths, own email as N+1, an `EXTERNAL_EMAILS` N+1);
  - `dnaConfig`:
    - test mode → `BLOCKED_EXTERNAL` naming `DATA_MODE`;
    - each missing variable → `BLOCKED_EXTERNAL`, whose `needs` include the three ASSUMED-shape items;
    - bad templates are rejected (`http:`, user-info, two placeholders, `?api_key=`); an invalid map;
    - push configured → pull never called;
  - DNA fake `fetcher`: mapped fields; 3xx, oversize, non-JSON, timeout and 404 handled; **the secret never appears in any URL, log line or audit row**; only mapped fields stored;
  - 24 h cache and `waitUntil` refresh;
  - **`people`**:
    - exact email only, `{name, title}` only, 429 at 31 per hour, external 403;
    - **never calls the fetcher** (a throwing fake);
    - never reads `profiles.edits`;
  - **directory import**:
    - admin only, batches, final replace;
    - rejected row numbers without values; clear;
    - **test mode rejects `jane@mantu.com` and accepts `jane@example.com`**;
    - unknown row keys rejected;
    - **shrink guard 409 without `confirmShrink`**, and the staged batch is discarded;
  - `daily` purges;
  - the old-schema test (two `Library` instances on one SQL; WOW §2.4);
  - a **leak test**: a profile named "Zelda Quintero" with title "Principal Zebra" (`roleFrom: 'profile'`) never appears in any captured `complete` or `embed` input across review, bids and Ask, **including a merged record** (`library.merge` of two records by different consultants).
- **`app.test.js`:**
  - a browser-sent `x-atlas-idp` is overwritten, and built only from the verified JWT `custom`;
  - the `verifyAccess` result is unchanged (existing assertion);
  - `/go/start` → `/#start`; `/go/gap/<id>` → `/#gap/<id>`; **`/go/library/<id>` → `/#library/<id>`**; **`/go/confirm/<id>` → `/confirm#<id>` for a user and for an external**; an external's `/go/gap/<id>` → 403; a bad `/go/x` or a non-hex id → `/`;
  - `/go/signed-in` returns HTML that contains `BroadcastChannel('atlas-auth')` and no token or email;
  - a GET navigation to `/ATLAS_Voice.html` → 302 `/`; a non-navigation stays 404; `/api/wiki` stays 404; the wrong host stays 403;
  - `/api/directory/push`: 401 without the secret; `BLOCKED_EXTERNAL` in test mode; forwarded as `system` in production mode;
  - banner and `readiness` follow `DATA_MODE`;
  - `/api/transcribe`: 403 without the consent header when `spokenAsk` is on; 403 for `always` with no stored consent; 404 when `spokenAsk` is off (Ask not READY, or the `spokenAskApproved: false` test seam now that D1 is approved).
- **`session.test.js`:** `projectContext({title, consultant: 'Zelda Quintero'})` has no `consultant`, and `talkerMessages` contains no "Zelda". The greeting is unchanged (existing assertions).
- **`library.test.js`:** `forModel` has no `consultant`, and record hashes are unchanged. A merge writes "Contribution by another consultant:". `recordView` strips a legacy "Contribution by x@y.com:" prefix.
- **`memory.test.js`** (existing file or new) — **Hindsight payload leak test**: `retainItems(modelProject(libraryPayload(p), 'profile'))` contains neither the consultant name nor the profile title, and the client name is still scrubbed (`client` kept). `GET /api/memory/settings` returns `{off}` without calling the Hindsight fake.
- **`features.test.js`:** `profile`, `people` and `directory` words with the `READY` gate; external 403; `flags` keys; `profile` false while `profile.READY` is false; `pdfBriefs` equals `on('bids')` (intentional assertion change, recorded in the Z status file).
- **`claims.test.js`:** `manager_source: 'directory'` precedence (staffing, then directory, then self-declared); a user-edited N+1 never counts as directory; the confirmation link uses `/go/confirm/`.
- **`gaps.test.js`:** a blank `assignee_name` is filled from stored directory rows; the draft link uses `/go/gap/`.
- **`outreach.test.js`, `teams.test.js`:** links use `/go/…`.

**Python:**
- `tests/test_voice.py`: `project_context` drops `consultant`, and `make_prompt` output does not contain the consultant name.
- `tests/test_entra_claims.py` (new, stdlib): parses the claims list in `deploy/cloudflare-edge/entra/enable_entra.sh` and asserts it equals `["tid","oid","roles","preferred_username","name","given_name","family_name"]` (identity claims first).
- `tests/test_build_home.py` (new, stdlib): `ATLAS_HOME` equals the `wrangler.jsonc` ORIGIN in all four aliases; the environment override works; invalid values give `''`.

**App node tests (`tests/*.test.js`):**
- `tests/profile-core.test.js` (new, UMD `AtlasProfileCore`):
  - chip labels computed from profile versus field value;
  - profile → form mapping;
  - `modelProject` on both shapes (name blanked; role blanked only for `roleFrom: 'profile'`; `client` kept);
  - CSV parser (BOM, `;`, quotes, CRLF);
  - header suggestions in French and English;
  - **column minimisation: a CSV with `Salaire`, `Date de naissance` and `Site` columns produces rows with only the approved keys**.
- `tests/engine.test.js`: `roleFrom` survives `validateState` and `importBackup`.

**Playwright:**
- **`tests/zero_config_browser.py`** (harness (a): built HTML, mocked `/api/bootstrap`, `/api/library/*`, `/api/memory/*` and the voice WebSocket, as in `tests/autosave_browser.py`; `ATLAS_RUNTIME` injected where a case says "live origin"):
  1. **Fresh user → consent → interview, zero setup:**
     - no project; a profile with name "Tony Walteur" from `dna`;
     - no visible text matching `/gateway|localhost|GPU|\.env|NVIDIA|address/i` in `#interview` or the consent dialog, and `#gatewayOpenBox` hidden; the pill reads "Ready";
     - Start → consent with exactly one visible checkbox, heading containing "Tony";
     - tick → the `start` frame has `project.consultant === ''` and no email anywhere in it;
     - `notes` → the project is created with consultant "Tony Walteur" and the N+1 from the profile;
     - library sync 201 → no "Save on this device?" dialog, strip "Saved to ATLAS".
  2. **Memory consent:**
     - `boot.memory = true`, settings `{off: false}`: the tick text contains "private memory", and after the interview exactly one `/api/memory/remember` POST is made;
     - Turn off → POST `{off: true}`, the text loses "private memory", and the tick stays;
     - Turn on → the tick is cleared;
     - off during the interview → **no `/api/memory/remember` request**;
     - `boot.memory = false`: no "memory" anywhere in the dialog and no remember request.
  3. **Expired session:**
     - every fetch carries `X-Requested-With`;
     - the library POST answers 401 → the banner shows, **no reload**, and project content is not in `sessionStorage` or `localStorage`;
     - Reconnect opens `/go/signed-in` in a popup, and a mocked `BroadcastChannel('atlas-auth')` `'ok'` → the sync is retried, the project is saved, and the toast shows;
     - **clean page + 401 → exactly one reload**; a second 401 within 5 minutes → the banner instead;
     - **open-overnight tab: Start with bootstrap 401 while `preparing` → phase `idle`, then exactly one `expired` handling (reload on a clean page, banner otherwise), never stuck**;
     - **socket error before `ready` → `check()` → 401 → `expired({resume: 'start'})`**;
     - 401 while `AtlasVoice.active()` → nothing until `ended`;
     - unsaved text in the Bids brief or Ask box blocks the automatic reload.
  4. **Local file and network:**
     - `page.goto('file://…/ATLAS_Voice.html')` → an "Open ATLAS" link whose `href` is `ATLAS_HOME + '/go/start'`, with `target=_blank` and `rel` including `noopener`; the address field hidden until the disclosure opens; no network request;
     - **live origin (`ATLAS_RUNTIME` present) with bootstrap answering a 522 HTML page → mode `network`, "Try again", never "Open ATLAS"**.
  5. **`#start`:** the consent dialog opens on load, and `AtlasVoice.status().hasMicrophone` stays false until Start.
  6. **Returning user:**
     - interview → sync 201 (record id R);
     - reload with an empty workspace → `GET /api/library?mine=1` lists R → the project appears in Projects, linked to R;
     - a second interview on it → the library POST carries `id: R`, and no second record is created.
  7. **Gap mode:** after a gap interview the strip reads "Not saved to ATLAS yet · kept in this tab", the device-save prompt appears, and no `/api/library` POST is made.
  8. **Guessed name:** a profile with only a guess → the new project's consultant is "Consultant"; "Is your name …? [Yes, that's me]" → POST `{confirmGuess: true}`, the consultant is updated and synced. A legacy project whose consultant is an email → the next sync sends the profile name or "Consultant".
  9. **Profile prefill, edit and provenance:**
     - the profile dialog shows the chips;
     - editing the title POSTs `{set: {title}}` and the chip reads "you edited";
     - `newer` shows "DNA now says …";
     - the new-project form is prefilled with chips;
     - `managerStaff` stays unticked;
     - 320 px has no overflow; no page errors.
- **`tests/zero_config_edge_browser.py`** (harness (c), local edge; `dev/local-edge.mjs` gains a dev-only `&idp=` query that puts custom claims into the local token, and passes `DATA_MODE` through, unset by default):
  - admin imports a CSV with extra columns → the upload body carries only approved keys; `jane@example.com` imports, and `jane@mantu.com` is rejected in test mode; the user `?as=jane@example.com` sees "from the DNA export";
  - an edit survives a reload;
  - user B cannot read user A's profile;
  - the `people` lookup returns name and title only;
  - `/go/…` and navigation redirects, including `/go/library/` and `/go/confirm/`;
  - the DNA pull and push show `BLOCKED_EXTERNAL` in the admin view (test mode, then production mode with no secrets).
- **Existing suites:** `tests/autosave_browser.py` stays unchanged and green (its `BOOT` has no `library`, so the device-save prompt at `:61` still appears; consent assertions at `:43-44` hold). `tests/studio_browser.py` and `tests/sculpture_browser.py` keep "Not connected" (offline mode).

---

## 10. Files touched, current owner, schedule

| File | Change | Owner today (WOW §6.4) |
|---|---|---|
| `deploy/cloudflare-edge/src/profile.js` | **new** (§5, §6, §7) | none (track Z) |
| `deploy/cloudflare-edge/src/app.js` | `signinClaims`, `x-atlas-idp`, `/go/*` (including the external block), `/go/signed-in`, navigation fallback, `/api/directory/push`, `DATA_MODE` banner and readiness, `/api/transcribe` consent gate | T1 |
| `deploy/cloudflare-edge/src/features.js` | words and `MODULE` entries; `flags` (`profile`, `spokenAsk`, `pdfBriefs`) | T1 |
| `deploy/cloudflare-edge/src/library-routes.js` | `ctx.user.idp`; `profile.daily` in `scan-stale` | T1 |
| `deploy/cloudflare-edge/src/library.js` | merge text (`:269`) | T1 |
| `deploy/cloudflare-edge/src/review.js`, `scrub.js` | `forModel` drops `consultant`; `recordView` strips the legacy merge prefix | T1 |
| `deploy/cloudflare-edge/src/bids.js` | PDF `metadata: false`; the empty-text message (D2) | T1 |
| `deploy/cloudflare-edge/dev/local-edge.mjs` | `&idp=` claims; `DATA_MODE`, `DNA_*` and `DIRECTORY_PUSH_SECRET` passthrough (unset by default) | T1 |
| `deploy/cloudflare-edge/wrangler.jsonc` | comment lines: new names; remove `SPOKEN_ASK` and `PDF_BRIEFS` | T1 |
| `deploy/cloudflare-edge/README.md`, `docs/INTEGRATIONS.md` | `DATA_MODE`, DNA push and pull, CSV sections | T1 |
| `deploy/cloudflare-edge/src/session.js` | `projectContext` drops `consultant` | T2 |
| `deploy/cloudflare-edge/src/gaps.js` | assignee name; `/go/gap/` link | T2 |
| `src/voice-client.js` | §3.3, §3.4, the device-save rule (§3.8) | T2 |
| `deploy/cloudflare-edge/src/claims.js` | the `'directory'` manager source; `/go/confirm/` link | T3 |
| `deploy/cloudflare-edge/src/outreach.js`, `teams.js`, `teams-routes.js` | `/go/` links; `TEAMS_*` simplification | T3 |
| `deploy/cloudflare-edge/entra/README.md` | name claims; per-user role gate and group assignment | T3 |
| `src/app.js` | `AtlasAuth` use, the dirty registry, returning-user rebuild, profile prefill, `voiceSnapshot` / `autoSave` (`synced` promise) / `startFrom*`, `emailN1` link, `rememberInterview` switch check, storage strip, legacy consultant cleanup | T4 |
| `src/shell.html` | profile section, chips, offline link and advanced disclosure, banner, memory line, slots `__ATLAS_HOME__`, `__SESSION_KEEPER__`, `__PROFILE_CORE__`, `__PROFILE_UI__` | T4 |
| `src/engine.js` | `roleFrom` | T4 |
| `src/ask-ui.js`, `src/bids-ui.js` | spoken Ask prompt and recording line; `AtlasAuth.dirty` registration | T4 |
| `build.py` | `ATLAS_HOME`, new slots | T4 |
| `Makefile`, `.github/workflows/ci.yml` | new suites | T4 |
| `tests/engine.test.js` | `roleFrom` | T4 |
| `src/voice-panel.html` | pill and card copy | T5 |
| `deploy/cloudflare-edge/src/memory-routes.js` | `GET /api/memory/settings` | none |
| `src/session-keeper.js`, `src/profile-core.js`, `src/profile-ui.js` | **new** | none (track Z) |
| `src/orb-ui.js`, `src/studio-panels.js`, `src/studio-connection.js` | mode-aware labels; `c.display`; advanced disclosure | none |
| `atlas_voice/interview.py`, `tests/test_voice.py` | `project_context` | none |
| `deploy/cloudflare-edge/entra/enable_entra.sh` | claims appended after `preferred_username` | none |
| `handoff/CONFIGURATION.md` | new variables, D1, D2, `DATA_MODE` | none |
| Tests: `test/profile.test.js`, `tests/profile-core.test.js`, `tests/test_build_home.py`, `tests/test_entra_claims.py`, `tests/zero_config_browser.py`, `tests/zero_config_edge_browser.py` | **new** | none (track Z) |
| Tests: `app`, `features`, `library`, `session`, `claims`, `gaps`, `outreach`, `teams`, `memory` (`.test.js`) | additions (§9) | T1, T2, T3, none |

Not touched (revision 1 touched them): `languages.js`, `worker.js`, and the `Session` constructor.

**Schedule (one track "Z", after WOW §6.6 integration, no deploy):**
- **Z-S0, edge:** `profile.js`, the Worker header and routes (`/go/*`, push, `DATA_MODE`), `review.js`, `scrub.js`, `library.js`, `memory-routes.js`, and `interview.py` plus the `projectContext` port; edge and Python suites green.
- **Z-S1, browser:** `session-keeper.js`, `profile-core.js`, `profile-ui.js`, `voice-client.js`, `app.js`, `shell.html`, `engine.js`, `build.py`, panel copy; then `python3 build.py` and `build_edge.py` (full run).
- **Z-S2, hooks:** `claims.js`, `gaps.js`, `outreach.js`, the Teams links, spoken Ask, `enable_entra.sh`; docs; then every suite, and the HTML aliases committed once.
- Rough effort: 3 track-days. `handoff/status/Z.md` follows WOW §6.7.

---

## 11. Still external (short list)

1. **Who can sign in.** Tony adds an Access "Emails ending in" rule for the Mantu domains, with the domain list from Mantu IT. It needs no per-user step. Until then, only Tony signs in. Opening the **test** deployment to colleagues means real project data on a personal account, so item 2 applies first.
2. **A production deployment approved for personal data.** This is the prerequisite for every DNA path, and for real use generally:
   - a Mantu-owned Cloudflare account, or an explicit production sign-off (`entra/README.md:22`);
   - Mantu IT approval;
   - DPO sign-off on the column list (email, name, given name, job title, N+1 name, N+1 email) and on the memory consent sentence.
   Then Tony sets `DATA_MODE=production`, which also removes the test banner.
3. **DNA data, one of three.** Mantu IT, the DNA owner or HR choose:
   - **push (recommended):** a DNA or HR job POSTs rows to `/api/directory/push` with `DIRECTORY_PUSH_SECRET`, and Tony adds the Access bypass for that path;
   - **pull:** only if DNA is HTTPS-reachable from Cloudflare, with header or bearer auth and lookup by email or `oid` (§5.3). IT supplies the URL template, header, key and field map;
   - **export CSV:** HR supplies the file, and an admin uploads it.
4. **Entra sign-in and name claims.** Mantu IT, and Tony runs `enable_entra.sh`. It is **usually silent on Mantu-managed browsers, with one Microsoft sign-in otherwise**. Per-user gate: `ENTRA_REQUIRED_ROLE=ATLAS.Interview` admits only people assigned that role, so IT assigns it to a group that covers all consultants, or leaves it unset and gates with an Access policy on the Entra group or the email domains. The Entra app also needs the `given_name` and `family_name` optional claims.
5. **One confirmation from Tony** (not a credential): D1, spoken Ask with consent. **Done** (recorded 2026-09-29): `SPOKEN_ASK_APPROVED = true`.

**Works today, with nothing from anyone:** start, consent, interview, the auto-created project, the returning-user rebuild, re-sign-in without loss, `/go/` links, and a profile from your own edits plus the email guess.

Unchanged and never blocking the interview: Teams, phone, the staffing webhook, the Hindsight / TypeSafe / ElevenLabs keys, and client-contact confirmation (legal).

---

## 12. Cost and risk

**Cost.**
- No new Cloudflare product, binding or DO class.
- One extra `LibraryStore` read per page load (the profile). One Interview DO storage read per Start (`/api/memory/settings`).
- Returning-user rebuild: one list call plus at most 50 record reads (4 at a time), only when a live page opens with an empty workspace.
- Storage: about 1 KB per profile and about 200 B per directory row (10,000 people ≈ 2 MB).
- Workers AI: slightly fewer input tokens (the consultant name is dropped). No extra speech synthesis (no spoken name).
- DNA: pull makes at most 1 call per user per 24 h, and push costs whatever IT schedules. DNA's own cost is Mantu IT's.
- Spoken Ask cost as in WOW §4.

**Risks and mitigations.**

| Risk | Mitigation |
|---|---|
| HR personal data on a test deployment | `DATA_MODE` gate; test mode accepts reserved test addresses only; DNA pull and push `BLOCKED_EXTERNAL` |
| HR personal data in production (GDPR, French works council) | Six approved columns, others dropped in the browser and rejected by the server; no raw responses stored; subject-only profile reads; 13-month purge; DPO sign-off as a prerequisite |
| Memory without agreement | Memory is inside the one consented sentence whenever it is on; the switch removes it; no remember call when off; opt-in is one line if the DPO asks |
| Stale or wrong DNA N+1 → wrong validator | Provenance is visible and editable; "DNA now says…" after a change; F3 independence checks unchanged; staffing still outranks the directory |
| A partial export or push wipes the directory | Staged batches; the shrink guard (M < 0.8·N needs a second confirmation, and a push is refused) |
| `managerStaff` bypassing validation | Never prefilled true |
| A wrong guessed name in shared records | A guess never becomes the consultant until confirmed; "Consultant" meanwhile; legacy emails cleaned on the next sync |
| Losing work on expiry | No reload while anything is unsaved; re-sign-in in a popup; `pending` sync retried; no content in browser storage |
| Popup blocked or closed | Banner stays; Backup ↓, then reload |
| WebSocket behaviour when Access expires mid-interview | UNVERIFIED. Test with a 1-minute policy session on a test Access application before relying on it |
| Fragment loss through an interactive sign-in | UNVERIFIED; `/go/` path links avoid it |
| Request ids in paths (WOW rule 7 deviation) | Ids are random, non-secret and useless without sign-in; no tokens in paths; `/go/` paths not logged by ATLAS metrics |
| DNA connector SSRF or secret leak | Host fixed by an admin variable; placeholder encoded; manual redirects; size and time caps; header-only secret; tests |
| DNA shape different from the assumption | Explicit `needs`; push and export as equal options; nothing falls back silently |
| People lookup used to enumerate staff | Exact email only; name and title only; 30 per hour; stored rows only; documented for the DPO |
| Custom claims trimmed over 1 KB | Name claims appended after the identity claims; no `groups`; missing name claims fall through to the next source |
| Entra per-user role blocks new joiners | Group assignment, or an Access policy instead of `ENTRA_REQUIRED_ROLE` (§11 item 4) |
| Entra switch resets edits | Documented; sources refill |
| Cloudflare changes the PDF pipeline | Re-check at each dependency review (D2) |

---

## 13. Verification log and open items

| Claim | Source | Result |
|---|---|---|
| Access returns 401 for an expired session only with `X-Requested-With: XMLHttpRequest` | developers.cloudflare.com, Access session management, "AJAX" (updated 2026-09-04) | VERIFIED (revision 1) |
| Expired app token + valid global session → new token issued automatically on navigation; defaults 24 h | same page | VERIFIED (revision 1) |
| Logout at `<app-domain>/cdn-cgi/access/logout` | same page | VERIFIED (revision 1) |
| Custom OIDC claims in `custom`, best effort, trimmed from the end of the list above about 1 KB | Access "Application token" (updated 2026-06-25) | VERIFIED (revision 1) |
| `get-identity` documented fields (no name) | same page | VERIFIED; contents of `idp` UNVERIFIED |
| `given_name` and `family_name` are v2 optional claims needing the `profile` scope | Entra "Optional claims reference" (updated 2026-08-20) | VERIFIED (revision 1) |
| Graph `GET /users/{id}/manager`: application permission "Not supported" | Graph "List manager" (v1.0, updated 2025-07-23) | VERIFIED (revision 1); the reason Graph is not a source (§14) |
| `toMarkdown` PDF: metadata, then per page a `StructTree` or as-is text; images: object detection, then a vision model; `pdf` metadata option | Workers AI "Markdown conversion: How it works" and "Conversion options"; changelog 2026-03-04 | **VERIFIED again 2026-09-29** (this revision) |
| Access policy selectors "Emails ending in" and "Entra group" | Cloudflare One "Policies" and "Infrastructure apps" pages | **VERIFIED 2026-09-29** |
| `ATLAS_RUNTIME` injected by both servers, absent in a saved file | `deploy/cloudflare-edge/src/app.js:131-133`, `atlas_voice/server.py:104`, `src/shell.html:61` | VERIFIED (code) |
| Test banner, readiness string, "Mantu-owned Cloudflare account" | `app.js:136, :145`; `entra/README.md:22` | VERIFIED (code) |
| `ENTRA_REQUIRED_ROLE` requires the role claim per person | `app.js:53`; `entra/README.md:19, :24` | VERIFIED (code) |
| `begin()` enters `preparing` before `check()` | `src/voice-client.js:46-47` | VERIFIED (code) |
| Memory transcript to Hindsight; consent text promises memory unconditionally | `src/app.js:166`, `memory.js:9, :90-98`, `voice-client.js:59` | VERIFIED (code) |
| `projectFromLibrary` only from the gap path; upsert by `id` or `(owner, local_id)` | `src/app.js:435, :441`; `library.js:121` | VERIFIED (code) |
| The CSP allows inline scripts (needed by `/go/signed-in`) | `app.js:68` | VERIFIED (code) |
| `name` claim in Entra ID tokens with `profile` | not fetched | ASSUMED (standard); check in the test tenant |
| Access returns to the originally requested **path** after an interactive sign-in | not fetched | ASSUMED (standard); check once on the real Access app before switching links |
| An open WebSocket survives app-token expiry | none found | UNVERIFIED |
| A URL fragment survives an interactive Access sign-in | none found | UNVERIFIED |
| DNA's API: reachability, auth, lookup key, fields | none (internal to Mantu) | UNKNOWN; connector shape ASSUMED; push and export offered; `BLOCKED_EXTERNAL` by design |

---

## 14. Revision 2: review findings and resolutions

| # | Finding (severity) | Resolution |
|---|---|---|
| 1 | Consent no longer covered memory (blocker) | Memory is back in the one sentence whenever it is configured and on, and out of it otherwise; the switch opts out; widening the sentence clears the tick; no remember call when off; tests for both `boot.memory` values (§0.1, §3.4, §8, §9 Playwright 2) |
| 2 | DNA export treated as working today on a test deployment (blocker) | Reclassified (c); `DATA_MODE=production` gate with test-mode reserved addresses; the profile today is edits plus guess only, stated plainly; six approved columns, others dropped in the browser and rejected by the server; tests (§0.7, §4, §5.2, §5.6, §11) |
| 3 | Returning consultant finds an empty workspace (major) | Rebuild from `GET /api/library?mine=1` with `projectFromLibrary`, linked by `library.id`; the follow-up updates the same record; test (§3.6, §9 Playwright 6) |
| 4 | Rescue in `sessionStorage` overrode the device-storage choice; dirty inputs lost (major) | Rescue removed. Popup to `/go/signed-in` + `BroadcastChannel('atlas-auth')`; the tab keeps its memory and retries `pending`; auto-reload only on a clean page, with a dirty-input registry (§3.2, §3.7) |
| 5 | Reconnect stuck while `preparing` or `connecting` (major) | "Voice active" means the microphone is held or a socket is open (`AtlasVoice.active()`); `begin()` and the pre-`ready` socket failure go idle first, then call `expired({resume: 'start'})`; tests (§3.3, §9) |
| 6 | Missing `/go/library` and `/go/confirm` (major) | Added, with `/go/confirm` in the external block; `emailN1`, outreach `PATH`, `claims.js`, `teams.js` and `gaps.js` switched; rule-7 deviation recorded; tests (§3.9) |
| 7 | DNA connector assumptions unconfirmed (major) | Shape marked ASSUMED; the assumptions are listed in `needs`; push offered as an equal (recommended) option reusing the import code (§5.3, §5.4, §11) |
| 8 | Microsoft 365 source over-privileged and wrong key (major) | Removed entirely: no Graph app, secret, token cache, `graphConfig` or tests. Sources: you > dna > dna_export > signin > guess (§5.2) |
| 9 | Spoken named greeting: latency, cache churn, "DUPONT" (major) | The spoken name is dropped: no rule-4 exception, no greeting route, no `greetName`, no `languages.js` change. The name is on screen only, never from the first word of `name` (§0.4, §5.7) |
| 10 | Entra not zero setup per person; "silent" overstated (major) | Per-user role gate named, with group assignment or Access-policy gating recommended; the PIN pilot uses "Emails ending in"; reworded to "usually silent" (§4, §11) |
| 11 | People lookup could pull third-party HR data (minor) | Stored rows only, never DNA, never `profiles.edits`; 30 per hour; documented for the DPO; delete-profile scope stated; tests (§5.8, §5.10) |
| 12 | Offline detection guessed from responses (minor) | `ATLAS_RUNTIME` present → live, so failures are `network`; offline only when it is absent; 522 test (§3.3) |
| 13 | Entra claims order (minor) | Appended after `preferred_username`; `test_entra_claims.py` (§5.5) |
| 14 | `PDF_TEXT_OK` gate unnecessary (minor) | Dropped; `pdfBriefs = on('bids')`; re-verified; empty-text message (D2) |
| 15 | Spec gaps: READY, status text, studio-panels, autosave test (minor) | `on('profile')`; mode-aware `status()` and `names.idle`; `studio-panels.js` reads `c.display`; existing browser assertions shown to hold (§3.3, §3.8, §6, §9) |
| 16 | Gap-mode answers left with no prompt (minor) | Gap mode keeps "kept in this tab" and the device-save prompt; test (§3.8) |
| 17 | A guessed name reaches shared records; legacy emails (minor) | A guess never becomes the consultant; "Is your name…?" after the interview; email-shaped consultant values replaced on the next sync; test (§3.5) |
| 18 | Merge text and Hindsight scrubbing holes (minor) | "Contribution by another consultant"; the legacy prefix stripped in `recordView`; `modelProject` keeps `client`; merge and Hindsight leak tests (§5.9) |
| 19 | Scope creep and risky import defaults (minor) | Unused fields and the refresh and reset routes removed; chips computed at render time; only `roleFrom` stored; shrink guard; "DNA now says…" (§3.5, §5.1, §5.2, §5.6) |
| 20 | Spoken Ask "Always allow" and the header (minor) | Reminder and recording indicator on every recording; the header described as a UI gate; `always` checked server-side against the stored consent (D1) |
| 21 | Missing tests (minor) | All listed cases added (§9) |
