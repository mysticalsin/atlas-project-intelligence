# Decision: fail closed when the signed-in identity changes

Date: 2026-11-20
Owner: Atlas
Backlog: ATLAS-HROW10-IDENTITY-CHANGE-RESIDUAL

## Design

The signed-in person is the verified Cloudflare Access JWT. The page is established by the runtime block on `GET /`: `subjectKey`, `authMode`, `name`, plus two opaque bound keys. `boundSubject` is HMAC-SHA256 with the label `atlas-bound-subject-v1:` and the verified subject. `boundEmail` is HMAC-SHA256 with the label `atlas-bound-email-v1:` and the mailbox after trim and lower-case. Both are the first 32 hex characters. The label is not the one used for the log and storage pseudonym, so the header value is not that pseudonym.

The browser echoes those two keys on same-origin API calls as `X-Atlas-Bound-Subject` and `X-Atlas-Bound-Email`. It does not send the raw mailbox. The voice upgrade cannot set those headers, so it offers one `Sec-WebSocket-Protocol` token, `atlas-bound-` plus the subject key. When that token is accepted, the Worker returns the Durable Object upgrade as status 101 and echoes that one token. A list with more than one bound token is refused.

The compare runs in `route` after the person is known and before `sessionGuard`, the rate limiter, and any `LIBRARY` or `INTERVIEW` `get`. Each presented value must be lowercase hex of length 32. The Worker does not trim a value and does not lower-case it into a match. A wrong-length, non-hex, upper-case, whitespace-padded, or duplicated value is a mismatch. Equal values are compared with the existing constant-time helper. An empty server subject key does not skip the check: a presented bound header or token is still a mismatch. The `LOG_SALT` 503 stays only for a request that presents no bound header. A mismatch returns 409 `{ error: "The signed-in identity changed. Reload ATLAS and sign in again.", code: "IDENTITY_CHANGED" }` and writes one `identity_changed` security event. The event carries the route template, method, role, and the truncated subject pseudonym. It does not carry the email, the raw subject, or the bound values. `X-Atlas-Bound-*` and the bound subprotocol token are removed before a request is copied to a Durable Object.

On the page, a mismatched bootstrap or that 409 sets mode `identity-changed`, cancels the open voice socket, clears the visible app, and reloads once. The reload uses the existing `atlas.reauthAt` stamp in `session-keeper.js`. A recent stamp, or storage that throws, does not reload. The notice is: "The signed-in account changed. Close this tab and open ATLAS again. Anything not already saved on this device is discarded." It uses the existing `blocking-notice` style, `role="alert"`, and `aria-live="assertive"`. The whole document body is hidden, so the notice is appended to the document element: a child of the hidden body would be invisible and would not be announced. Registered page observers are disconnected before that clear, and the orb storage observer ignores a missing save control. Save and backup controls are disabled. An idle tab runs one fresh bound probe on focus, on `visibilitychange` to visible, and on an `atlas-auth` broadcast in every mode. Those probes share a one-second throttle. A's `mantu.atlas.workspace.v4.<subjectKey>` blob is not written and not deleted. The voice, memory, and library forwards each drop `X-Atlas-Bound-*` before the Durable Object fetch. Routes that build a fresh header set never copy those headers.

A missing bound header, and a missing subprotocol token, keep today's behavior.

## Plan debate

Sentinel, static read only, report sha256 `b2075991672e35c085b3d0fde0c0d23c828c83f444f318cb2aa7e8c7b75970cf`.

Verdict: ACCEPT WITH CHANGES. Five required changes, R1 to R5. Confidence medium-high. Not merge approval. Security Q&A was not run.

- R1: echo exactly one accepted `Sec-WebSocket-Protocol` token on the 101, and refuse a mismatched or duplicated bound token without opening `INTERVIEW`.
- R2: an idle tab probes on focus, on becoming visible, and on `atlas-auth`, with a throttle.
- R3: reuse the five-minute reload guard, tested with storage that keeps the stamp, and blank the whole app root.
- R4: one check in front of every Durable Object route, including the email-only case whose csrf is still valid.
- R5: opaque fixed-length hex bound keys, a separate domain label from the log pseudonym, constant-time compare, and malformed values refused. A non-Latin-1 mailbox does not throw and is not placed in a header.

Low items taken with the fix: the `identity_changed` event, stripping the bound headers before the Durable Object, and the known limits below.

## Owner decisions

- Q1. In Entra mode, an email change with the same `tid:oid` fails closed. The email key changes. The subject key does not have to.
- Q2. The Python cookie session is out of scope.
- Q3. The in-progress voice view is discarded. A's Durable Object is not deleted and not read for B.
- Q4. A's localStorage blob stays in place and is not read by the mismatched document.

## Inspector, first QA

Report sha256 `745fba3ef3c2dcac708c68b37228159b01734a19ba96ab45d355c2452ca1f32a`. Verdict: PASS WITH NOTES.

- F-1. The orb storage observer no longer throws after the body is cleared. It is disconnected with the other page observers, and the callback does nothing when the save control is gone.
- F-2. The notice is an assertive alert in the existing blocking-notice style. No new sentence was added. It stays on the document element because the body is hidden.
- F-3. A table covers every Durable Object forward. Removing the strip on the voice route, the memory route, or the library route each fails that table.

## Exact-head gate

Devin, report `/cursor/stores/bot/atlas-pr15/PREMERGE-atlas-pr15-b60694e.md`. File sha256 `ccdb92351485495408e11f6d41ebe842e5acbbb00ca5618c1da17a064e8d66c7`. The report's last line claims `fb0519bf4bedc60333d3e8178dbd97f55da3cda2d6cabe4fb3631b046651e0ff`. Verdict on `b60694e3`: CODE INCOMPLETE. Three mutants survived.

- D-1. Reject non-lowercase hex. Do not normalize. An upper-case copy of the server-minted subject key is 409 and opens no Durable Object. Lower-casing both sides before `HEX_KEY` turns that case into a match.
- D-2. Do not trim before `sameKey`. A minted key wrapped in U+00A0 is a mismatch. Fetch removes leading and trailing ASCII space and tab before the Worker sees the value, so that padding cannot reach the compare. U+00A0 is whitespace that `String.prototype.trim` removes and the header parser keeps. Trimming before the hex check turns that case into a match.
- D-3. An empty server subject key does not skip the check. Production without `LOG_SALT` mints none. A presented email key, with the subject header absent or empty, is 409 `IDENTITY_CHANGED` and opens no Durable Object. Returning "no mismatch" when `boundSubject` is empty falls through to the `LOG_SALT` 503 only after the identity check is skipped, which this test refuses.

## Exact-head gate, loop 2

Devin on `281742422039ad23d0764213be1455a2ecc49bbc`, tree `4b8012864178b6693ef73f1ce2e47b25dd39e348`: CODE INCOMPLETE and BODY FAIL. `git merge-tree` onto `main` `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec` was clean. Inspector DELTA r2 on that head was PASS WITH NOTES, report `/cursor/stores/bot/atlas-pr15/QA-inspector-28174242.md`. That inspector result is superseded by the next head.

`sameKey` already compared all 32 characters, and the orb already registered its storage observer. The new tests pass on `28174242` and fail on the named mutants. They are not a product change.

- A 32-character key that shares the first 8 characters, or every character but the last, is 409 and opens no Durable Object. The same is true of the email key. Cutting `timingSafe` to `slice(0, 8)` opens the library (status 200) for those three shapes. A presented 64-character value that shares its first 63 characters with `key + key` and differs at the last character is not a 32-character key, so it is rejected before the compare. `slice(0, 63)` on a 32-character key is the whole key, so that cut stays green. The last character of the 32-character key is what forces every shorter prefix, including 8, to fail.
- The storage observer copies the status text while the page is up. After the identity blank it does not run again, and the blank throws nothing. Removing `watchObserver(storageObserver)` leaves the observer connected, so the post-blank mutation runs the callback. The clean-console test stays green under that removal because the null guard swallows it.

The header-strip table, the upper-case minted key, and the U+00A0-wrapped key were already green on the code they were added to. They are regression guards. Their mutants go red. They are not red-first proofs.

## Exact-head gate, loop 3

Devin on `a7c1855c94db43af6b0e5a6cb31c9a8fa0c7a6a9`: CODE INCOMPLETE and BODY FAIL. The report named is `PREMERGE-atlas-pr15-a7c1855.md`. Four mutants left the previous tests green. No product source changed. The test commit is `d4753fe75d7a781673038121fd179843ad4361c9`.

- `timingSafe` in `deploy/cloudflare-edge/src/timing-safe.js`, loop bound cut to `Math.min(8, a.length)`. A bearer secret and a CSRF token that differ only in the last character were accepted. Red: bearer 201 instead of 401, CSRF 200 instead of 403, and both forwards ran. The real secret stayed 201 and the real CSRF stayed 200. Green on the restored tree: the same test passes, 47 identity tests, 0 fail.
- `runtimeBlock` at `deploy/cloudflare-edge/src/app.js`, `boundSubject` and `boundEmail` removed. `app.test.js` stayed 39 pass, 0 fail. Red: `GET /` embedded empty keys and the library call returned 409 `IDENTITY_CHANGED` with no Durable Object. Green: both keys are the minted 32-hex values and the library call is 200 with `opened: ['global']`.
- `src/session-keeper.js`, the identity notice appended to `document.body` after that body is hidden. The older alert test stayed green. Red: the parent walk reported `body`. Green: the chain has no `hidden`, `display:none`, or `aria-hidden` ancestor, the notice is a child of the document element, and it has `role=alert` or `aria-live`.
- `watchObserver(storageObserver)` removed from `src/orb-ui.js`. Red is no longer only `3 !== 2`. The save control copied the status written during the blank. Green: that text stays the pre-blank copy and the observer does not run again.

GitHub Actions was not run. CI is budget-blocked.

## Known limits

- A caller that sends no bound header, and a tab loaded before this page was deployed, keeps today's behavior. The server identity is still the JWT, so that caller receives only the JWT's own data. The old page does not learn that the person changed until it is reloaded.
- These paths cannot carry the bound headers: a browser navigation, an `<a download>`, `window.open` of `/go/signed-in`, and the Access logout navigation (`/cdn-cgi/access/logout`).
- Rotating `LOG_SALT` or `CSRF_SECRET` changes every bound key. An open tab gets one 409 and one reload. That is fail-closed.
- Q3: if local saving is off, the in-progress voice interview is discarded on the reload. The notice says so and shows no project data. A's Durable Object is left as it was.
- The Python gateway cookie session (`atlas_voice/identity.py`) is not covered.
- The blank notice is a child of the document element, not of the hidden body. Putting it in the body would hide it and remove it from the accessibility tree.
- ASCII space and tab around a bound key are removed by the Fetch header parser before `sameKey`. The Worker still refuses any surrounding whitespace the parser keeps, including U+00A0, rather than trimming it into a match.
- The early return in `identityMismatch` when the server subject key is not 32 lowercase hex characters is redundant with `sameKey`. A non-hex server key already fails the later compare. The early return is defence in depth. Removing only that line does not change the behavioural pin. On `28174242` the inspector marked it at `app.js:174`.
- Without workerd, the edge suite skips four SQL tail tests that require workerd 2026-10-23. This VM has `ATLAS_WORKERD_ROOT` unset and no `/tmp/atlas-workerd-20261023`. The measured skip count is in `handoff/BUILD_STATUS.md`. A workerd install is a different environment.
