# ATLAS-DEV-IDENTITY-CJK-EMAIL-500

Disposition: **ADDENDUM** to Sweep 01 group 13. Not a parallel plan.

Group 13 plan: `docs/sweeps/s01/plans/group-13-worker-auth-routing.md` on PR #38, branch `cursor/atlas-s01-high-plans`, head `4d15c83c7485c6e73cd50d1f2eded3824a636526`. head `4d15c83c7485c6e73cd50d1f2eded3824a636526`. Devin r8a2f8337 pins PR #38 there, not `a5a24e1`. The branch tip at this freeze is `73dd4df385ee0dbf5f29d00afdf465ea95ea125b` (v4). These addenda cite `4d15c83c`. They do not edit `docs/sweeps/s01/plans/`.

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

- One helper, called only on the paths that write `x-atlas-user` into a header: `/api/library`, `/api/voice`, `/api/consent`, and `/api/me/erase`. `/api/me/export` uses the same privacy header object as erase, so it takes the same 400. `storedSpokenAsk` writes `x-atlas-user` too, so it uses the same helper. A code point above 255 in the email or in the library user returns 400 from that helper, before `headers.set`. Devin r8a2f8337 (HIGH). Sentinel R9's single guard stays, and it is not wrapped around `GET /`.
- `GET /` and `/api/bootstrap` stay 200 for a CJK email. On this main they already do. They do not write `x-atlas-user`. This plan does not add a refusal there.
- The 400 body is a short plain error. It does not contain the address. It is not 500 and it is not `Something went wrong.`
- A Latin-1 email, a code point from 128 through 255, is a ByteString. On `/api/library` it is not 400 and not 500. The CJK case on the four write paths stays 400.
- An ASCII email on those routes is unchanged.
- The Worker does not put the non-ByteString email into a header. It returns before `headers.set` throws.
- `?as=` stays unread on the production Worker. The local edge may keep minting the token. A CJK `?as=` that then hits library, voice, consent, or erase receives the 400. A CJK `?as=` that only loads `GET /` stays 200.
- No Entra call is added. The re-check behind a live Entra tenant stays `BLOCKED_EXTERNAL` until an operator runs it. This plan does not request that access.

## Failing test

Four red tests, one per path that writes the header. The address is `用户@example.test`. On this main `GET /api/library` returns 500. Voice, consent, and erase also set `x-atlas-user` and are in the same file.

Names:

- `a CJK email on GET /api/library is 400`
- `a CJK email on /api/voice is 400`
- `a CJK email on POST /api/consent is 400`
- `a CJK email on POST /api/me/erase is 400`

`GET /` with the same token stays 200. That assertion is in the library test's file and is not a new refusal. Name: `a CJK email on GET / stays 200`.

The group 13 writer adds the cases to `deploy/cloudflare-edge/test/sweep01-g13-auth.test.js`. Same file as the header addendum. One writer, one file.

TEST COMMAND:

```sh
cd deploy/cloudflare-edge && node --test --test-name-pattern "CJK email on" test/sweep01-g13-auth.test.js
```

The Latin-1 case, same file. Name: `a Latin-1 email in the verified token is not a 400`. The address uses U+00E9. On a correct guard this stays off the 400 path and off the 500 path.

TEST COMMAND:

```sh
cd deploy/cloudflare-edge && node --test --test-name-pattern "Latin-1 email in the verified token" test/sweep01-g13-auth.test.js
```

## Files owned

None as a separate writer. The hunk is in `deploy/cloudflare-edge/src/app.js` and in `deploy/cloudflare-edge/test/sweep01-g13-auth.test.js`.

Do not edit `deploy/cloudflare-edge/dev/local-edge.mjs`, browser `src/app.js`, or `atlas_voice/identity.py`.

## Risk

High. Treating every non-ASCII email as 400 locks out a person whose real Access email is not ASCII, instead of letting them in. The acceptance asks for a handled non-500, and a header value cannot carry that email on this runtime. Mapping only the header to an empty mail, and still signing them in, would drop `x-atlas-email` while `x-atlas-user` in Access mode is that same email, so the library identity would be empty and the request would look unsigned. 400 is the failure that does not pretend they signed in. An operator who needs those addresses has to change the header encoding in a later decision. This plan does not invent a new encoding.

The header-strip addendum deletes `x-atlas-*` and then sets the derived values. The 400 helper runs on the paths that write the header, after sign-in verification and before that set. `GET /` does not call it. The 400 body does not echo the address.

## Rollback

Revert the guard. Those requests return 500 again. ASCII sign-in is unchanged.

## Dependencies

| PR | On this row |
|---|---|
| #15 | Overlaps Worker `app.js`. Same ordinary-merge rule as group 13 and as the header addendum. Do not rebase that pushed branch. Keep #15's identity-mismatch return. |
| #16 | Browser `src/app.js` only. The historical note said `src/app.js:195`. On this main the 500 string is Worker `app.js:195`. Do not edit the browser file. |
| #23 | Browser shell. No. |
| #25 | No. |
| #27 | No. |
| #30 | Same stack base as group 13, #30 head `d495233609c8e2a9105a35526ccd7bb4e485a8f1`. |
| #35 | No. |
| #37 | No. |
| #40 | No. |

Also open: PR #2 edits Worker `app.js` and `local-edge.mjs`. Bring the Worker hunk in with an ordinary merge of #2. Do not rebase that pushed branch. Do not edit `local-edge.mjs` on that branch. PRs #1 and #4 also edit `local-edge.mjs`. Leaving that file alone is what avoids them.

## Branch base

PR #30 head `d495233609c8e2a9105a35526ccd7bb4e485a8f1`, brought in by ordinary merge. If PR #15 has landed, bring it in the same way and keep its identity-mismatch return. Do not rebase those pushed branches.

## Known limits

- The 400 is limited to the paths that write `x-atlas-user`: library, voice, consent, and erase. Export uses the same privacy header object. `storedSpokenAsk` uses the same helper.
- `GET /` and `/api/bootstrap` stay 200 for a CJK email. This plan does not add a refusal there.
- A Latin-1 email (U+00E9) is not 400.
- The 400 body does not contain the address.
- A re-check behind a live Entra tenant stays `BLOCKED_EXTERNAL`. This plan does not request that access.

## Ask

| Ask | None. This row does not ask Tony. The live Entra re-check is blocked on an operator run, not on a decision. |

## Tony source

The backlog row has no separate tony-verbatim card. The title below is copied verbatim from `rows-full.txt`.

> N-3 (Info, pre-existing on main): a CJK / non-ASCII email in the dev identity returns 500 (app.js:195)
