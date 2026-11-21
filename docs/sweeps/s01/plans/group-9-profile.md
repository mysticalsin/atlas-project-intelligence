# Group 9 — profile

Plan only. Debate this before anyone edits product code. Revision v4 (Sentinel re-review `e4e9dada` of `4d15c83c`, AGREED). The v2 section wins where an earlier sentence still trusts `edits.managerEmail`, a ref the caller wrote, or `access() === 'full'` for presales. The sentence under ATLAS-08 that still says presales resolve every story they can open in full is stale and does not.

Pinned inputs: confirmer report sha256 `57c92dcb651ddef4b7abe9c23424065a2a59fa139d2cdfc6315ce227596eac1c`, main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`, red tests `96712474b59d6b058ef00479f2bb2d4eb065801e` (PR #31). External review: ATLAS-08 in `/cursor/stores/bot/atlas-sweeps/s01/external/hammer-artex-security.md`.

Findings: L5, F2, ATLAS-08.

F4 is `privacy.js` (group 14). Do not edit it.

## Done when

1. The L5 test and both F2 tests in `sweep01-f-stress.test.js` / `sweep01-a-logic.test.js` pass.
2. A new ATLAS-08 test passes: a `role: "user"` lookup of a directory address that is not their own manager and not a person on a story they can open in full returns 403; `role: "admin"` and `role: "reviewer"` receive `name` and `title` and the body has no `manager_email` key.
3. `node --test deploy/cloudflare-edge/test/profile.test.js` still passes.
4. No test is skipped or marked expected-failure.

## Files this group may edit

`deploy/cloudflare-edge/src/profile.js`, one new test file `deploy/cloudflare-edge/test/sweep01-g9-people.test.js`, and the one `erasePeopleLookups` call in the profile `DELETE` block of `subject-rights.js`. No other line in that file.

Do not edit `privacy.js`, `ratelimit.js`, `util.js`, `library.js`, or `authz.js`. The people route may call `lib.access`, `directoryManager`, and `lookupPerson`. Those already exist.

## Failing tests from PR #31

| Test | File | Finding |
|---|---|---|
| `L5 profile retention compares instants, and keeps a seen_at it cannot parse` | `deploy/cloudflare-edge/test/sweep01-a-logic.test.js` | L5 |
| `F2 two profile edits that overlap a directory read both survive` | `deploy/cloudflare-edge/test/sweep01-f-stress.test.js` | F2 |
| `F2 two consent grants that overlap a directory read both survive` | same | F2 |

TEST COMMAND:

```sh
node --test --test-name-pattern 'L5|F2' deploy/cloudflare-edge/test/sweep01-a-logic.test.js deploy/cloudflare-edge/test/sweep01-f-stress.test.js
node --test deploy/cloudflare-edge/test/sweep01-g9-people.test.js
node --test deploy/cloudflare-edge/test/profile.test.js
```

The pattern-limited command is how this group proves its three PR #31 tests without requiring the rest of those files (other groups) to be green. The new file must exit 0 on its own.

## Additional red test — ATLAS-08

`deploy/cloudflare-edge/test/sweep01-g9-people.test.js`. Write it first and see it fail on current `profile.js`.

Setup: one tenant, a `directory` row for `alex@example.test` with a name and a title and a manager email, the caller's own directory row whose `manager_email` is `boss@example.test` with a name and title, one story the caller wrote that lists `ada@example.test` as a consultant, and one story someone else wrote (`updated_by` is not the caller) that lists `sam@example.test` and that `lib.access` grants the caller in full. No DNA network.

- `GET` people as `role: "user"` for `alex@example.test` → 403, and the body does not contain the directory name.
- Same caller for `boss@example.test` → 200, `name` and `title` present, no `manager_email`. The directory row is the only manager source.
- Same caller for `ada@example.test` → 403, because the caller wrote that consultant.
- Same caller for `sam@example.test` → 200, because someone else wrote that ref and the caller can open the story in full.
- Same caller for `alex@example.test` with a prefix or a trailing domain character (`alex@example.test.au`, `xalex@example.test`) → 400 or 404, never 200 with Alex's name.
- `role: "admin"` and `role: "reviewer"` for `alex@example.test` → 200 without `manager_email`.
- `role: "presales"` for `alex@example.test`, when that address is on no story, → 403.
- A second library object is not required. The cap is group 14's problem. This test uses a single call so the in-memory cap does not matter.

## Threat model

Before, L5: `profile.daily` compares `seen_at` to `isoBefore(now, 395)`, which is always a `Z` string from `toISOString()`. A row written with the same instant as `+00:00` sorts earlier as text (`+` is before `Z`) and is deleted. A `seen_at` of `not-a-date` sorts earlier than any ISO string and is deleted too. A person who signed in at the cutoff, with an offset form, loses the profile row: edits, sign-in name, and both consent grants.

Before, F2: `editProfile` and the consent POST both `gather()` (read the row, then `await` DNA for up to 2.5s) and `save()` the whole `edits` or `consents` object from that snapshot. Two overlapping calls keep one field and one grant. The DNA response can also supply a name; the test shows the surviving name become `Dna Name` when the caller's `Ada Example` was the one that lost the write. Consent for `spokenAsk` or `jevRating` disappears the same way. `storedConsent` then tells the rater the person did not agree.

Before, ATLAS-08: any signed-in member of the tenant can `GET` people for any exact address. The body is `{ email, name, title, from }`. A 200 confirms the address is in the HR directory. A 404 confirms it is not. Manager email is already omitted. The cap is the in-memory limiter (ATLAS-07, group 14), so the harvest resumes after the Library Durable Object is evicted.

After: retention deletes a row only when `seen_at` parses to an instant strictly before the cutoff. The offset form of the cutoff instant survives, and an unparseable value survives. Two overlapping edits or grants both remain. A third write that conflicts twice is 409 and leaves the row unchanged. A normal member, including presales, resolves only their directory manager and people named on a same-tenant story someone else wrote, and only when they would still have full access as role `user`. The presales role grant does not count. A story in another tenant does not count. A manager email they typed into `edits`, and a consultant they wrote themselves, do not resolve. Admin and reviewer can resolve an arbitrary exact address and still do not receive `manager_email`. An unauthorized address is 403. Past 30 distinct addresses in a UTC day, a non-admin caller gets 429.

## Chosen design

L5. Inside the enforced branch of `daily`, parse `cutoff` once with `Date.parse`. Keep a row when `seen_at` is empty or `Date.parse` is `NaN`. Delete when the parsed instant is strictly less than the cutoff. Compare numbers, not strings. Keep the tenant fold and the rowid chunk delete that already exist. Directory-cache purge stays on its own string compare; those columns are written by this process as `Z` and are not the bug.

F2. `save` must not persist the object captured before the DNA await. `editProfile` passes the changed keys only (`set` and `clear`). The consent route passes one kind and whether it was granted. Inside `lib.recorded`, `save` reads the row again by rowid and merges:

- an edit key replaces or deletes only that key
- a consent grant sets only that kind to `{ version: 1, at }`
- a consent revoke deletes only that kind

The other keys stay as they are on the row just read. `gather` may still await DNA first; the test releases both fetches before either assertion. The merge is synchronous SQLite, so the second continuation sees the first commit. If `updated_at` changed between the read and the update, retry the read-merge once. If it changed again, return 409 and do not write. Do not hold a lock across the DNA `await`. A 2.5s directory read must not block the other field.

ATLAS-08. After the existing `rateLimit` call and the email-shape check:

- `admin` and `reviewer` may resolve any exact address in the tenant.
- Anyone else, including `presales`, may resolve an address only when it is `directoryManager` of the caller (the directory row's `manager_email` in the caller's tenant), or when a `refs` row has the same tenant as the caller, `updated_by` is present and is not the caller, the address is a `members` token or a `details.consultants[].email` on that row, and the caller would still have `full` access if their role were `user`. `access() === 'full'` from the `presales` role (`library.js` line 821) does not count. That role is `full` on every story in the tenant, which is the arbitrary lookup this plan rejected. Compare addresses as a whole (lowercase, no prefix and no suffix). A row whose tenant is not the caller's tenant does not count.
- `edits.managerEmail` is not a source. The caller can set it in one request and look it up in the next.
- Otherwise 403, before `lookupPerson`.
- `lookupPerson` stays the response shape. Strip `manager_email` if a future change adds it. Do not add the manager to this response.
- **Owner ruling.** Roles other than `admin` and `reviewer` may resolve at most 30 distinct addresses per UTC day, including 403s. Store them in SQLite (`people_lookup`, created with `lib.exec` from this file) so a new `Library` on the same database still counts. Key each row by caller email, UTC day, and address. On lookup, delete rows whose day is before today. `erasePeopleLookups(lib, email)` deletes that caller's rows; the profile `DELETE` inside `eraseMine` calls it. That call is the only line this group adds outside `profile.js`. The 31st distinct address is 429 and does not call `lookupPerson`. Another caller's first lookup is not 429. The owner can change 30. This plan uses 30 until they do.

`presales` is not on the arbitrary-lookup list. `access()` returning `full` for that role does not unlock a lookup. A presales caller resolves an address only under the same rule as role `user`: their directory manager, or a same-tenant story someone else wrote that they could still open in full as role `user`. An address that fails that rule is 403.

Leave the `rateLimit(...)` call in place with the same arguments. Group 14 makes that function durable. Changing the call would edit a line group 14 also needs, and changing `util.js` is not this group's file.

## Alternatives rejected

1. L5: store every `seen_at` as `Z` on write and keep the string compare. Rejected because rows already stored with `+00:00` would still be deleted on the next sweep, which is the failing test, and a later writer can insert either form.
2. F2: a mutex around `gather` plus `save`. Rejected because the mutex would include the DNA await. The test happens to pass (the second call waits), and a slow directory then blocks consent. The lost update is fixed by merging the delta onto a fresh row. A mutex is the wrong layer.
3. ATLAS-08: return 404 for unauthorized addresses. Rejected because 404 and 200 become a directory oracle again. 403 is the same answer whether or not the row exists.
4. ATLAS-08: allow every `access === 'full'` role, including presales, to query arbitrary addresses. Rejected because the finding names admin and reviewer for the arbitrary case. Presales already see stories; they do not get a tenant-wide directory probe.

## Invariants and properties

New cases live in `sweep01-g9-people.test.js` and a small block next to it for L5 and F2. `node:test` only. No skip, no expected failure, no new dependency.

- L5 property: for offsets `Z`, `+00:00`, `-00:00`, and `+0000` of one instant, either all four are kept or all four are deleted together. An instant one millisecond before the cutoff is deleted. An instant equal to the cutoff is kept. `not-a-date`, `''`, and `2026-13-40T00:00:00Z` are kept.
- F2 property: for a random partition of the editable text fields into two disjoint sets, two overlapping `POST`s leave every key from both sets on the row. For the two consent kinds, both grants remain, and revoking one in a third overlapping call removes only that one.
- ATLAS-08 property: for addresses that share a prefix with a stored directory key and are not equal to it, a user, an admin, and a reviewer all fail to receive the stored name. Admin success is exact equality only.

Boundaries: caller with no directory row, story in another tenant, published story the caller can see only as `public` (must not unlock the consultant's directory title), email longer than the util cap (group 5 owns that cap; pass a normal address here).

## Data migration

None. Profiles already deleted by the string compare are gone; the erasure log does not keep `seen_at`, and this group must not invent rows. The next `daily` run uses instant comparison and will not delete the offset form again.

Consent rows already lost to the race are gone. The person grants again. Do not infer a grant from DNA.

Directory rows are unchanged. ATLAS-08 is a read check.

## Rollback

Revert the one file. Daily retention returns to text order. Profile writes return to last-snapshot-wins. People lookup returns to any tenant member. No schema change.

## Open PRs #15–#30

No PR in #15–#30 edits `profile.js`. PR #30 and PR #15 edit the Worker `app.js` around identity. This group does not. The people route is reached through the library Durable Object, which already receives the role the Worker verified.

Group 14 will change `util.rateLimit` without changing its call shape. Do not "help" by switching this file to `enforce()`.

## Owner lockout

A too-strict people check can stop the owner, if their role is not `admin` or `reviewer`, from seeing a colleague's title. Their own manager and people on stories they fully open still resolve. Profile edit and consent are not gated by ATLAS-08.

The retention change cannot lock anyone out of sign-in. It only decides which stale profile rows the sweep deletes. Keeping unparseable `seen_at` means a corrupt timestamp is kept until a later edit writes a real one. That is the test's requirement.

The merge write cannot drop a field the caller did not send. A bug that merges the DNA body as if it were the caller's patch would overwrite `Ada Example` with `Dna Name`. Do not write DNA fields inside `save`. DNA stays a read source in `gather`.

## Diff size

About 120 lines in `profile.js` and about 180 lines of tests.

## v2 — Sentinel

File: `deploy/cloudflare-edge/test/sweep01-g9-people.test.js`, except the conflict test, which lives in the same file. Write these before the fix.

| Sentinel | Change | Red test |
|---|---|---|
| M1 | Trust only the directory manager. A caller who `POST`s `edits.managerEmail` to a directory address, then `GET`s people for that address, gets 403 and the body does not contain the directory name. `boss@example.test` from the directory row still returns 200. | `M1 a caller-set manager email does not unlock directory lookup` |
| M2 | A consultant or member on a row whose `updated_by` is the caller does not unlock lookup. The same address on a row `updated_by` someone else, which the caller can open in full, does. | `M2 a self-written consultant does not unlock lookup` |
| M2, owner ruling | 30 distinct addresses per UTC day for roles other than admin and reviewer, stored in SQLite. After 30 distinct 403s, construct `new Library(sameSql)` and the 31st distinct address is 429. Admin is not capped. | `M2 the thirty-first distinct lookup in a day is refused after eviction` |
| L1 | Two overlapping saves still both stick (F2). A third save that loses the compare twice returns 409, and its field is absent from the row. | `L1 a profile save that conflicts twice fails closed` |
| Devin | `presales` plus `access() === 'full'` is not a grant. A presales caller in tenant A does not resolve an address that appears only on a story in tenant B, including a story they would fully open if the tenant check were skipped. A presales caller also does not resolve an address that appears only on a same-tenant story they can see solely because their role is presales. | `D1 a presales lookup does not cross tenants` |
| L2 | `people_lookup` is keyed by caller email, UTC day, and address. A row whose day is before today is deleted on the next lookup and does not count. Erasing the caller deletes their rows. Caller A spending 30 does not make caller B's first lookup 429. | `L2 one caller's lookups do not spend the other caller's cap` |
| L3 | No new control. A missing `updated_by` does not unlock lookup. A later save by someone other than the caller does unlock an address already on that row, even when that editor did not add it. The daily cap still counts the lookup. | none |

## Open questions for the owner

1. Parked for Tony (question 7). The plan does not wait on it. Presales does not get the role-wide `full` grant, and lookup is limited to the caller's tenant. Admin and reviewer still resolve an arbitrary exact address in that tenant.
2. **Owner ruling.** The distinct-address cap is 30 per UTC day, and admin and reviewer are exempt. Say if the number or the exemption should change. The red test uses 30.
