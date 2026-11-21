# Group 9 — profile

Plan only. Debate this before anyone edits product code.

Pinned inputs: confirmer report sha256 `57c92dcb651ddef4b7abe9c23424065a2a59fa139d2cdfc6315ce227596eac1c`, main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`, red tests `96712474b59d6b058ef00479f2bb2d4eb065801e` (PR #31). External review: ATLAS-08 in `/cursor/stores/bot/atlas-sweeps/s01/external/hammer-artex-security.md`.

Findings: L5, F2, ATLAS-08.

F4 is `privacy.js` (group 14). Do not edit it.

## Done when

1. The L5 test and both F2 tests in `sweep01-f-stress.test.js` / `sweep01-a-logic.test.js` pass.
2. A new ATLAS-08 test passes: a `role: "user"` lookup of a directory address that is not their own manager and not a person on a story they can open in full returns 403; `role: "admin"` and `role: "reviewer"` receive `name` and `title` and the body has no `manager_email` key.
3. `node --test deploy/cloudflare-edge/test/profile.test.js` still passes.
4. No test is skipped or marked expected-failure.

## Files this group may edit

`deploy/cloudflare-edge/src/profile.js` only, plus one new test file `deploy/cloudflare-edge/test/sweep01-g9-people.test.js`.

Do not edit `privacy.js`, `ratelimit.js`, `util.js`, `library.js`, `subject-rights.js`, or `authz.js`. The people route may call `lib.access`, `directoryManager`, and `lookupPerson`. Those already exist.

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

Setup: one tenant, a `directory` row for `alex@example.test` with a name and a title and a manager email, the caller's own directory row whose `manager_email` is `boss@example.test` with a name and title, and one story the caller owns that lists `ada@example.test` as a consultant. No DNA network.

- `GET` people as `role: "user"` for `alex@example.test` → 403, and the body does not contain the directory name.
- Same caller for `boss@example.test` → 200, `name` and `title` present, no `manager_email`.
- Same caller for `ada@example.test` → 200, because that address is on a story `lib.access` grants them in full.
- Same caller for `alex@example.test` with a prefix or a trailing domain character (`alex@example.test.au`, `xalex@example.test`) → 400 or 404, never 200 with Alex's name.
- `role: "admin"` and `role: "reviewer"` for `alex@example.test` → 200 without `manager_email`.
- `role: "presales"` for `alex@example.test`, when that address is on no story, → 403.
- A second library object is not required. The cap is group 14's problem. This test uses a single call so the in-memory cap does not matter.

## Threat model

Before, L5: `profile.daily` compares `seen_at` to `isoBefore(now, 395)`, which is always a `Z` string from `toISOString()`. A row written with the same instant as `+00:00` sorts earlier as text (`+` is before `Z`) and is deleted. A `seen_at` of `not-a-date` sorts earlier than any ISO string and is deleted too. A person who signed in at the cutoff, with an offset form, loses the profile row: edits, sign-in name, and both consent grants.

Before, F2: `editProfile` and the consent POST both `gather()` (read the row, then `await` DNA for up to 2.5s) and `save()` the whole `edits` or `consents` object from that snapshot. Two overlapping calls keep one field and one grant. The DNA response can also supply a name; the test shows the surviving name become `Dna Name` when the caller's `Ada Example` was the one that lost the write. Consent for `spokenAsk` or `jevRating` disappears the same way. `storedConsent` then tells the rater the person did not agree.

Before, ATLAS-08: any signed-in member of the tenant can `GET` people for any exact address. The body is `{ email, name, title, from }`. A 200 confirms the address is in the HR directory. A 404 confirms it is not. Manager email is already omitted. The cap is the in-memory limiter (ATLAS-07, group 14), so the harvest resumes after the Library Durable Object is evicted.

After: retention deletes a row only when `seen_at` parses to an instant strictly before the cutoff. The offset form of the cutoff instant survives, and an unparseable value survives. Two overlapping edits or grants both remain. A normal member resolves only their own manager and people already named on a story they can open in full. Admin and reviewer can resolve an arbitrary exact address and still do not receive `manager_email`. An unauthorized address is 403, so the caller does not learn whether the directory has it.

## Chosen design

L5. Inside the enforced branch of `daily`, parse `cutoff` once with `Date.parse`. Keep a row when `seen_at` is empty or `Date.parse` is `NaN`. Delete when the parsed instant is strictly less than the cutoff. Compare numbers, not strings. Keep the tenant fold and the rowid chunk delete that already exist. Directory-cache purge stays on its own string compare; those columns are written by this process as `Z` and are not the bug.

F2. `save` must not persist the object captured before the DNA await. `editProfile` passes the changed keys only (`set` and `clear`). The consent route passes one kind and whether it was granted. Inside `lib.recorded`, `save` reads the row again by rowid and merges:

- an edit key replaces or deletes only that key
- a consent grant sets only that kind to `{ version: 1, at }`
- a consent revoke deletes only that kind

The other keys stay as they are on the row just read. `gather` may still await DNA first; the test releases both fetches before either assertion. The merge is synchronous SQLite, so the second continuation sees the first commit. Retry once if `updated_at` changed between the read and the update inside that transaction. Do not hold a lock across the DNA `await`. A 2.5s directory read must not block the other field.

ATLAS-08. After the existing `rateLimit` call and the email-shape check:

- `admin` and `reviewer` may resolve any exact address in the tenant.
- Anyone else may resolve an address only when it is the manager email on their own directory row (`directoryManager` of the caller) or their stored `edits.managerEmail`, or when some `refs` row in the tenant has `lib.access(row, user) === 'full'` and the address is that row's owner, a `members` token, or a `details.consultants[].email`, compared as a whole address (lowercase, no prefix and no suffix).
- Otherwise 403, before `lookupPerson`.
- `lookupPerson` stays the response shape. Strip `manager_email` if a future change adds it. Do not add the manager to this response.

`presales` is not on the arbitrary-lookup list. They still resolve people on stories they can open in full, because `access` already returns `full` for that role. An address on no such story is 403.

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

## Open question for the owner

`presales` does not get arbitrary directory lookup. Admin and reviewer do. A presales caller still resolves a person named on a story they can open in full. Confirm that split before this lands. Widening it to every `access === 'full'` role makes ATLAS-08 a lookup of anyone named on any story.
