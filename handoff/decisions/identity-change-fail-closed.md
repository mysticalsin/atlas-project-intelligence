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

## Known limits

- A caller that sends no bound header, and a tab loaded before this page was deployed, keeps today's behavior. The server identity is still the JWT, so that caller receives only the JWT's own data. The old page does not learn that the person changed until it is reloaded.
- These paths cannot carry the bound headers: a browser navigation, an `<a download>`, `window.open` of `/go/signed-in`, and the Access logout navigation (`/cdn-cgi/access/logout`).
- Rotating `LOG_SALT` or `CSRF_SECRET` changes every bound key. An open tab gets one 409 and one reload. That is fail-closed.
- Q3: if local saving is off, the in-progress voice interview is discarded on the reload. The notice says so and shows no project data. A's Durable Object is left as it was.
- The Python gateway cookie session (`atlas_voice/identity.py`) is not covered.
- The blank notice is a child of the document element, not of the hidden body. Putting it in the body would hide it and remove it from the accessibility tree.
- ASCII space and tab around a bound key are removed by the Fetch header parser before `sameKey`. The Worker still refuses any surrounding whitespace the parser keeps, including U+00A0, rather than trimming it into a match.
