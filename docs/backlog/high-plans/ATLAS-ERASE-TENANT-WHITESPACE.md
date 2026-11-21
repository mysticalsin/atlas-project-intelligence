# ATLAS-ERASE-TENANT-WHITESPACE

Disposition: **ADDENDUM** to Sweep 01 group 10. Not a parallel plan.

Group 10 plan: `docs/sweeps/s01/plans/group-10-erasure-tenant.md` on PR #38, branch `cursor/atlas-s01-high-plans`, head `a5a24e1b4d2fd9d8683f4f08841dba27497fd74a`. v2 of that plan is in progress and addresses Sentinel. This file does not edit that plan. The group 10 writer pastes this addendum after v2 settles.

Pinned main: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
Triage: `triage.md` sha256 `1901b48b1a44181c59cce7434460e4e1a82057b99c85b53b9f4e049261f1059d`.

This row touches `subject-rights.js`, which group 10 owns, and also `operate.js` and `library.js`, which group 10's current text says not to edit. Folding the row here is what keeps a second writer off `subject-rights.js`. The debate accepts that expansion, limited to the hunks below. It does not give this writer B1's `library.js` merge, and it does not give them `email()`.

## APP-FIT

**FIT** against main `8b0972ec`.

- `eraseSubjectInvitations` scopes with `lower(trim(COALESCE(tenant, '')))` (`operate.js:106`). SQLite `trim()` with no second argument strips spaces only. A tenant stored as the verified id plus a tab or a newline does not match.
- `journeyTenant` (`journey.js:96-97`) uses JavaScript `trim()`, which strips tab and newline. The caller and the stored invitation are not compared the same way. Under-erasure, not a cross-tenant write.
- `subject-rights.js:30` `TENANT_SQL` is `lower(COALESCE(tenant, '')) = ?` with no trim. `requireTenant` trims the caller.
- `library.js:1366` stores `String(user.tenant || '').toLowerCase()` with no trim. `library.js:1378` stores `source` through `str()`, which collapses internal whitespace and cuts at 200. End padding on an already-stored `source` or `email` is not trimmed by the erase compare (`operate.js:109-110`).

`journey.js` is not edited. The Tony block on mixed-case journey rows stays in `ATLAS-JOURNEY-MIXEDCASE-DUP`.

## Done when

- A privacy erase for caller tenant `A` removes or scrubs invitation rows in that tenant whose stored tenant is `A` plus leading or trailing space, tab, newline, carriage return, vertical tab, or form feed. A stored tenant that is a different id, including `A` with a character inserted in the middle, is kept.
- The same end-trim applies to stored `email` and stored `source` when those columns are matched to a subject alias. An alias that merely contains the subject as a substring is not matched. Internal spaces stay significant.
- `TENANT_SQL` in `subject-rights.js` uses that same end-trim, so a profile or other subject-rights row stored with a trailing tab is in scope for that tenant and out of scope for every other tenant.
- New invitations store the tenant and the source already end-trimmed. They do not prefix-cut the source. The 200-cap addendum owns the cut. This addendum only stops a new row being stored with end whitespace the erase would then have to rediscover.
- A tenant that is only whitespace stays the blank tenant. It does not become some other tenant. Blank-tenant rows stay quarantined, which is the current `requireTenant` rule.

SQLite `trim(x)` cannot express JavaScript's full Unicode trim. The character set is the six ASCII characters above, passed as the second argument of `trim`. A stored non-breaking space is still unmatched. That remainder is named here and is not silently treated as fixed.

## Failing test

Name: `a tenant stored with a trailing tab is erased for the trimmed caller, and a padded source is scrubbed`

On this main the tab-padded tenant row survives, and a source stored as the alias with a trailing newline is not scrubbed.

TEST COMMAND:

```sh
cd deploy/cloudflare-edge && node --test --test-name-pattern "trailing tab is erased" test/backlog-g10-invite-erase.test.js
```

## Files owned

None as a separate writer. Hunks the group 10 writer adds, and that no other plan takes:

- `deploy/cloudflare-edge/src/operate.js` — the invitation tenant, email, and source compare only.
- `deploy/cloudflare-edge/src/subject-rights.js` — `TENANT_SQL` only. B1/B3 stay the group's existing design.
- `deploy/cloudflare-edge/src/library.js` — the tenant value stored by `invite`, end-trim only. The source cut is the 200-cap addendum. The body `source` spoof is the spoof addendum.
- `deploy/cloudflare-edge/test/backlog-g10-invite-erase.test.js`

Do not edit `journey.js`, `util.js`, or `test/sqlite.js`.

## Risk

High. A trim that is applied in the middle of the id, or a `LIKE`, would join two tenants. The predicate strips only the six ASCII characters, and only at the ends. A failing test keeps a tenant of `A` plus a tab plus `B` out of tenant `A` and out of tenant `B`.

`library.js` is also in PR #34 and PR #35. This hunk is rebased onto those heads. It is not edited in parallel with them.

## Rollback

Revert the hunks. Rows already stored with padding stay padded. A later erase uses the old space-only `trim` again and can miss them. No schema change.

## Dependencies

| PR | On this row |
|---|---|
| #15 | No. |
| #16 | No. |
| #23 | No. |
| #25 | No. |
| #27 | Do not edit `test/sqlite.js`. |
| #30 | No. |
| #35 | Overlaps `library.js`. Rebase this hunk onto #35. Do not take #35's other library edits into a whitespace-only reading of the diff. |
| #37 | No. |
| #40 | No. |

Also open, not in that list, and blocking a clean apply: PR #2 edits `operate.js` and `library.js`. PR #34 edits `library.js`. The group 10 writer rebases onto those heads before the hunk is final. Group 10 does not wait on group 3 for B1. This addendum does wait on #34 and #35 for the one `invite` store line.
