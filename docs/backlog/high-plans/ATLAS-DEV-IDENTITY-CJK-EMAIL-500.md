# ATLAS-DEV-IDENTITY-CJK-EMAIL-500

Disposition: **ADDENDUM** to Sweep 01 group 13. Not a parallel plan.

Group 13 plan: `docs/sweeps/s01/plans/group-13-worker-auth-routing.md` on PR #38, branch `cursor/atlas-s01-high-plans`, head `a5a24e1b4d2fd9d8683f4f08841dba27497fd74a`. v2 of that plan is in progress and addresses Sentinel. This file does not edit that plan.

Pinned main: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
Triage: `triage.md` sha256 `1901b48b1a44181c59cce7434460e4e1a82057b99c85b53b9f4e049261f1059d`.

Group 16 was checked. It owns `atlas_voice/identity.py` only. The 500 is thrown in the Worker `handle` catch (`deploy/cloudflare-edge/src/app.js:195`), which group 13 owns. The Python sign-in cap is a different defect.

## APP-FIT

**FIT** against main `8b0972ec`.

Production does not read `?as=` or `&idp=` (`app.js:254`). The local edge still mints a JWT from `?as=` (`deploy/cloudflare-edge/dev/local-edge.mjs:136` and `:152`). `decodeURIComponent` on a CJK address does not throw. The throw is later.

`Headers.set` and `new Request` reject a value that is not a ByteString. On this runtime, setting `x-atlas-user` to `用户@example.test` throws `TypeError: Cannot convert argument to a ByteString because the character at index 0 has a value of 29992 which is greater than 255.` `handle` catches that and returns 500 `Something went wrong.` (`app.js:193-195`).

The library user in Access mode is `who.email` (`app.js:288`). A verified token whose email contains a code point above 255 hits the same throw on any path that copies that email into a header, including a real Access token. The dev query string is only how the local edge produces that token.

`local-edge.mjs` is in PRs #1, #2, and #4. This addendum does not edit it. The fix is the Worker's response, which is the production path too.

## Done when

- A verified token whose email contains a code point above 255 produces a handled response on `GET /` and on `GET /api/library`. The status is 400. The body is a short plain error. It is not 500 and it is not `Something went wrong.`
- An ASCII email on those routes is unchanged.
- The Worker does not put the non-ByteString email into a header. It returns before `headers.set` throws.
- `?as=` stays unread on the production Worker. The local edge may keep minting the token. A CJK `?as=` then receives the 400 from `handle`, which is the handled response the acceptance asks for.
- No Entra call is added. The re-check behind a live Entra tenant stays `BLOCKED_EXTERNAL` until an operator runs it. This plan does not request that access.

## Failing test

Name: `a CJK email in the verified token is not a 500`

The test signs a local Access JWT the way the existing security harness signs one, with email `用户@example.test`, and calls `handle`. On this main `GET /api/library` returns 500.

The group 13 writer adds the case to `deploy/cloudflare-edge/test/sweep01-g13-auth.test.js`. Same file as the header addendum. One writer, one file.

TEST COMMAND:

```sh
cd deploy/cloudflare-edge && node --test --test-name-pattern "CJK email in the verified token" test/sweep01-g13-auth.test.js
```

## Files owned

None as a separate writer. The hunk is in `deploy/cloudflare-edge/src/app.js` and in `deploy/cloudflare-edge/test/sweep01-g13-auth.test.js`.

Do not edit `deploy/cloudflare-edge/dev/local-edge.mjs`, browser `src/app.js`, or `atlas_voice/identity.py`.

## Risk

High. Treating every non-ASCII email as 400 locks out a person whose real Access email is not ASCII, instead of letting them in. The acceptance asks for a handled non-500, and a header value cannot carry that email on this runtime. Mapping only the header to an empty mail, and still signing them in, would drop `x-atlas-email` while `x-atlas-user` in Access mode is that same email, so the library identity would be empty and the request would look unsigned. 400 is the failure that does not pretend they signed in. An operator who needs those addresses has to change the header encoding in a later decision. This plan does not invent a new encoding.

The header-strip addendum deletes `x-atlas-*` and then sets the derived values. The 400 happens when a derived value is not a ByteString, after the strip, before the set. Order inside the one function: strip, then reject a non-ByteString identity, then set.

## Rollback

Revert the guard. Those requests return 500 again. ASCII sign-in is unchanged.

## Dependencies

| PR | On this row |
|---|---|
| #15 | Overlaps Worker `app.js`. Same rebase rule as group 13 and as the header addendum. Keep #15's identity-mismatch return. |
| #16 | Browser `src/app.js` only. The historical note said `src/app.js:195`. On this main the 500 string is Worker `app.js:195`. Do not edit the browser file. |
| #23 | Browser shell. No. |
| #25 | No. |
| #27 | No. |
| #30 | Same stack base as group 13, #30 head `d495233609c8e2a9105a35526ccd7bb4e485a8f1`. |
| #35 | No. |
| #37 | No. |
| #40 | No. |

Also open: PR #2 edits Worker `app.js` and `local-edge.mjs`. Rebase the Worker hunk onto #2. Do not edit `local-edge.mjs` on that branch. PRs #1 and #4 also edit `local-edge.mjs`. Leaving that file alone is what avoids them.
