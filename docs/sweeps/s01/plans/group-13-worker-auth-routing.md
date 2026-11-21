# Group 13 — Worker auth / routing

Plan only. Debate this before anyone edits product code.

Pinned inputs: confirmer report sha256 `57c92dcb651ddef4b7abe9c23424065a2a59fa139d2cdfc6315ce227596eac1c`, main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`, red tests `96712474b59d6b058ef00479f2bb2d4eb065801e` (PR #31). External review: ATLAS-06 and ATLAS-12 in `/cursor/stores/bot/atlas-sweeps/s01/external/hammer-artex-security.md`. ATLAS-11 is already fixed by PR #30. Do not re-do it.

Findings: C-3, E1, ATLAS-06, ATLAS-12.

## Done when

1. The C-3 check in `tests/sweep01_c_browser.py` prints `PASS`. The other checks in that file are group 12 and may stay `FAIL`. This group does not edit them.
2. The E1 test in `tests/sweep01-setup.test.js` passes. The other tests in that file are group 15.
3. ATLAS-06: `verifyAccess` returns null for a token signed by a key that arrived via a 302, the fetcher was called with `redirect: 'manual'`, and a JWK that is not RSA / RS256 is not imported.
4. ATLAS-12: `POST /api/triggers` with a valid bearer, no `Content-Length`, and a body over 16384 bytes returns 413 and does not call the library stub.
5. On top of PR #30, a blank audience, the audience placeholder, and a team on `.example.test` still return null before any cert fetch. `DATA_MODE=production` without `local-synthetic`, `ATLAS_DEV_IDENTITY`, or `ATLAS_LOCAL_TENANT` still serves the voice page.
6. No skip, no expected failure.

## Files this group may edit

- `deploy/cloudflare-edge/src/app.js`
- `handoff/SECURITY_RUNBOOK.md` (the rollback-switch row, and only as much nearby prose as that row requires)
- `deploy/cloudflare-edge/test/sweep01-g13-auth.test.js` (new)

Owned and expected to stay unchanged: `deploy/cloudflare-edge/src/kill-switches.js`, `deploy/cloudflare-edge/src/security-log.js`, `src/voice-client.js`. The E1 test ignores the first two. Reading a switch only inside them does not make E1 pass. C-3 is fixed by not sending the voice page, so `voice-client.js` does not need a new sentence.

Do not edit `deploy.sh`, `wrangler.jsonc`, `authz.js`, `bounded.js`, `src/shell.html`, `src/app.js` (the browser one), or `handoff/CONFIGURATION.md`. Group 12 owns the shell. Group 15 owns `CONFIGURATION.md`. PR #30 owns `deploy.sh`.

## Failing tests from PR #31

| Test | File | Finding |
|---|---|---|
| `C-3 a refused production combination is named and does not invite a conversation` | `tests/sweep01_c_browser.py` | C-3 |
| `E1 every rollback switch named in the runbook is read by product code` | `tests/sweep01-setup.test.js` | E1 |

C-3 loads the local edge with `DATA_MODE=production`. That process also sets `ATLAS_TENANT_ISOLATION=local-synthetic` and `ATLAS_DEV_IDENTITY=1`. The body text must contain `DATA_MODE=production cannot be combined` and must not contain `Ready when you are` or `isn't answering`.

E1 parses the runbook line that matches `/rollback switches/`, then requires each `ATLAS_*` name on that line to be read by a `.js` or `.py` file under `deploy/cloudflare-edge/src`, `atlas_voice`, or `src`, excluding `kill-switches.js` and `security-log.js`.

TEST COMMAND:

```sh
node --test --test-name-pattern 'E1' tests/sweep01-setup.test.js
node --test deploy/cloudflare-edge/test/sweep01-g13-auth.test.js
CHROMIUM_PATH=/usr/bin/google-chrome python3 tests/sweep01_c_browser.py
```

The browser file exits 1 until group 12 fixes C-1, C-2, C-4, and C-5. Done for this group is the C-3 line reading `PASS`. Do not edit the other checks to force exit 0.

The page the browser serves is `deploy/cloudflare-edge/src/atlas.html`, gitignored, copied from `python3 build.py`. This group does not rebuild the shell.

## Additional red tests

`deploy/cloudflare-edge/test/sweep01-g13-auth.test.js`. Write both before the fix.

ATLAS-06. A fetcher that, on `https://team.example/cdn-cgi/access/certs`, returns 302 with `Location: https://attacker.example/jwks` and does not follow it. `verifyAccess` is null. The fetcher's init has `redirect: 'manual'`. A second case: the fetcher returns 200 with a JWK of `kty: 'oct'`. `verifyAccess` is null and `crypto.subtle.importKey` is not asked to verify that token (spy, or a key that would throw). A third case: `ACCESS_TEAM_DOMAIN` of `user@attacker.example` builds no URL with a username; `verifyAccess` is null and the fetcher is not called. A fourth case, on the PR #30 base: `ACCESS_AUD` of `replace-me` or a team `foo.example.test` does not call the fetcher.

A positive control stays: a 200 from `https://<configured-host>/cdn-cgi/access/certs` with an RSA `sig` JWK, `alg` `RS256` or absent, still verifies a token with the matching `kid`, `iss`, and `aud`. Existing `deploy/cloudflare-edge/test/app.test.js` cases must keep passing.

ATLAS-12. `POST /api/triggers` with the test bearer, `Content-Length` omitted, body 20 KiB. Status 413. The library binding's `fetch` is not called. A 100-byte body with a valid bearer still reaches the stub. A `Content-Length: 0` with a 20 KiB chunked body is also 413. Use the same `boundedBytes` the directory push already uses. Do not edit `bounded.js`.

## Threat model

Before, C-3: `/api/*` returns 503 with `productionDemoConflict`'s error when production is combined with the local demo switches. `GET /` still returns the voice shell. The shell says `Ready when you are`. A failed bootstrap can paint `isn't answering`. An operator who set `DATA_MODE=production` on the local demo, or who left `local-synthetic` on a production deploy, is shown a product that invites a conversation the API will refuse.

Before, E1: the runbook's rollback row names `ATLAS_CHECKPOINT`, `ATLAS_EVIDENCE_WORKFLOW`, `ATLAS_ADAPTERS`, and `ATLAS_REPLY_GUARD`. Nothing in the scanned tree reads the first two. The last two are read only in `kill-switches.js`, which the test skips, and only to announce `flag_state`. An operator who sets `ATLAS_CHECKPOINT` during an incident changes nothing.

Before, ATLAS-06: the cert fetch uses default `fetch`, which follows redirects, and the host is the string interpolation of `ACCESS_TEAM_DOMAIN`. A 302, or a domain of `user@attacker.example`, replaces the trust anchor. `importKey` then accepts whatever JWK came back. A forged RS256 JWT with the configured `iss` and `aud` becomes a signed-in user. An unknown `kid` refetches on every request.

Before, ATLAS-12: `/api/triggers` treats `Content-Length` as the cap, then `request.text()` reads the rest. A missing or zero length with a multi-megabyte body is forwarded to the Library Durable Object as role `system`. The bearer is still required. The directory push already uses `boundedBytes`.

After: `GET /` during a refused combination is a short page that quotes the API error and has no invitation copy and no script that calls bootstrap. The rollback row no longer names switches the product does not honor. Certs are fetched only from `https://<configured-host>/cdn-cgi/access/certs`, with `redirect: 'manual'`, and only RSA signature keys are imported. A trigger body past 16384 bytes is 413 and is not forwarded.

## Chosen design

Stack this branch on PR #30 head `d495233609c8e2a9105a35526ccd7bb4e485a8f1` (`cursor/atlas-oss-head-cleanup`), not on main. That commit already returns from `verifyAccess` before any cert fetch when the audience or team is blank, the audience is `replace-me`, or the team is `example.test` or `*.example.test`.

ATLAS-06, after that early return. Build the certs URL with `new URL('https://<team>/cdn-cgi/access/certs')` where `<team>` is the trimmed, lowercased `ACCESS_TEAM_DOMAIN`. Refuse, without calling the fetcher, when the URL has a username, a password, or a hostname other than that team. Call `fetcher(url, { redirect: 'manual' })`. Treat any status outside 200 as a failed refresh and keep the previous cache. Keep a JWK only when `kty === 'RSA'`, `use` is `sig` or absent, and `alg` is `RS256` or absent. Cache a missing `kid` for the same 600000 ms the success cache uses, so a random `kid` does not refetch every request. `iss` remains `https://<team>` and `aud` remains the configured audience. Do not require a `.cloudflareaccess.com` suffix: the configured hostname is the pin. A suffix check would reject a custom Access host and lock sign-in.

C-3. Where `route` is about to return the voice page for `GET /`, if `productionDemoConflict(env)` is set, return `htmlResponse` of a document with no script. The visible text is the `error` string from that function, which already contains `DATA_MODE=production cannot be combined`. Do not include `Ready when you are` or `isn't answering`. Status 503. Do not serve that document when the conflict helper returns null. `/api/*` already returns the JSON 503. Leave `/privacy` as the notice. Agree the sentence with group 12: they must not add this sentence to the shell, and they must not depend on the shell being present when the combination is refused.

E1. The rollback row stops naming `ATLAS_CHECKPOINT`, `ATLAS_EVIDENCE_WORKFLOW`, `ATLAS_ADAPTERS`, and `ATLAS_REPLY_GUARD`. Replace it with the action that exists: `npx wrangler rollback` to the last good version, which the previous row already describes. Do not add decoy `process.env.ATLAS_CHECKPOINT` reads. `ATLAS_ADAPTERS` and `ATLAS_REPLY_GUARD` stay in the later `flag_state` paragraph, because `securityFlags` does read them. That paragraph is not the line the test scans. Do not edit `CONFIGURATION.md`.

ATLAS-12. Replace the `Content-Length` branch and `request.text()` on `/api/triggers` with `boundedBytes(request, 16384)`. `null` is 413 and returns before `env.LIBRARY.get`. The byte helper already treats a declared length over the cap as too big and also stops reading the stream past the cap, so a lying `Content-Length: 0` still fails.

## Alternatives rejected

1. C-3: edit `src/voice-panel.html` or `voice-client.js` to change the invitation sentence. Rejected because group 12 owns the shell, and a production deploy that is configured correctly must still say `Ready when you are`. The invitation is wrong only when the combination is refused. The Worker chooses the document.
2. E1: read the four names from `app.js` so the runbook line can stay. Rejected because `ATLAS_CHECKPOINT` and `ATLAS_EVIDENCE_WORKFLOW` have no behavior. A read that does not change a decision tells the operator the switch works. During an incident that is worse than a missing switch.
3. ATLAS-06: follow redirects if the final host is `*.cloudflareaccess.com`. Rejected because the redirect target is the attacker's chance to become the trust anchor, and a live 302 has not been confirmed. Fail closed. The open question covers the one HEAD an operator should do before deploy.
4. ATLAS-12: cap with `Content-Length` and also call `boundedBytes`. Rejected as two mechanisms. The helper is the cap. The route stops reading `Content-Length` itself.

## Invariants and properties

In `sweep01-g13-auth.test.js`. `node:test`. No skip, no expected failure.

- Property: for a list of bad hosts (`user@team.example`, `team.example.evil`, `team.example@attacker.example`, empty, `foo.example.test` on the #30 base), the fetcher is called zero times.
- Property: for statuses 301, 302, 303, 307, 308, and a 200 whose body is not JSON, `verifyAccess` is null and the previous good key cache is unchanged.
- Property: bodies of size 16384, 16385, and 20000, with `Content-Length` absent, `0`, and equal to the real size. Only a real size at or under 16384 reaches the library.
- C-3 unit-level, without Chrome: `handle` of `GET /` with the refused combination returns a body that contains the error sentence and does not contain the two invitation phrases. `GET /` with `DATA_MODE=production` and none of the three demo switches still returns the voice page (the `page` argument echoed). This is the lockout guard.

Boundaries: `redirect: 'error'` is not a substitute for `'manual'`. The test asserts the string `manual`.

## Data migration

None. No Durable Object schema. PR #30's placeholder wrangler values stay.

## Rollback

Revert this branch. Cert fetch follows redirects again. Triggers trust `Content-Length` again. `GET /` serves the shell during a refused combination again. The runbook names the dead switches again. No data migration to undo.

If the cert pin locks a live tenant, rollback of this commit restores sign-in even when the certs URL redirects. Do that before debugging the URL. See lockout.

## Open PRs #15–#30

This group stacks on #30. `verifyAccess` on that head is the base. Do not re-implement `accessConfigured`. Do not edit `deploy.sh` or `wrangler.jsonc`. If #30 moves, rebase.

PR #15 also edits `deploy/cloudflare-edge/src/app.js`, `security-log.js`, and `src/voice-client.js` (identity-change 409, bound-header strip). This plan does not edit the last two, so the overlap is `app.js` only. Land #30, then this branch. If #15 merges first, keep its identity-mismatch return and its header strip, and put the cert pin and the `GET /` refusal and the trigger cap on top. Do not take #15's `voice-client.js` into this branch.

PR #16, #20, #23 edit the browser shell and built HTML. They do not edit Worker `app.js`. C-3's refusal document is not the shell, so those PRs do not change its text.

PR #29 rewrites `README.md`. Not this group's file. ATLAS-11 stays in #30.

No other PR in the range edits `SECURITY_RUNBOOK.md`.

## Owner lockout

This is the highest lockout risk in the set.

- ATLAS-06 fail-closed: if the real `https://<team>/cdn-cgi/access/certs` returns a redirect, every sign-in becomes 401, including the owner. PR #30 already 401s when the audience is still the placeholder. The pin can 401 a correctly configured team. Confirm the URL with one HEAD from an operator network before deploy. Rollback is the recovery. Do not follow the redirect to keep the owner in.
- A hostname compare that lowercases one side only will 401 a mixed-case team. Lowercase the configured team and compare it to `URL.hostname` (which is already lowercase).
- C-3: a bug that treats every `DATA_MODE=production` as a conflict replaces the product with the refusal page. The condition is `productionDemoConflict(env)`, which returns null for production alone. The unit control above is what stops that lockout.
- E1 does not turn any switch on or off. Removing the names cannot lock the owner out. It stops an operator from thinking a dead name will.

`boundedBytes` on triggers does not affect the owner's browser session. A project-management system that posted large bodies will start getting 413. That is the cap the route already claimed to have.

## Diff size

About 120 lines in `app.js`, about 10 lines in the runbook, about 200 lines of tests.

## Open questions for the owner

1. Does `https://<the live ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` return 200 with no redirect? This plan fails closed if it does not. One HEAD, from an approved network, before deploy. This review did not request that URL.
2. Group 12 must leave the C-3 sentence to this page. Confirm they will not quote `DATA_MODE=production cannot be combined` inside the shell, and will not keep the shell mounted when this Worker returns the refusal.
3. `ATLAS_CHECKPOINT` and `ATLAS_EVIDENCE_WORKFLOW` are read nowhere. `ATLAS_ADAPTERS` and `ATLAS_REPLY_GUARD` are read only inside `kill-switches.js`, which the E1 scan skips. This plan removes all four names from the rollback-switches row and does not wire the dead ones. Confirm the runbook should stop naming them. Wiring them is a product change, and a half-wired switch can turn a feature off.
