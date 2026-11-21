# ATLAS-EXPORT-INVITES-ALIAS

Disposition: **ADDENDUM** to Sweep 01 group 10. Not a parallel plan.

Group 10 plan: `docs/sweeps/s01/plans/group-10-erasure-tenant.md` on PR #38, branch `cursor/atlas-s01-high-plans`, head `a5a24e1b4d2fd9d8683f4f08841dba27497fd74a`. v2 of that plan is in progress and addresses Sentinel. This file does not edit that plan. The group 10 writer pastes this addendum after v2 settles. A second writer does not open `subject-rights.js`.

Pinned main: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
Triage: `triage.md` sha256 `1901b48b1a44181c59cce7434460e4e1a82057b99c85b53b9f4e049261f1059d`.

Group 10 already owns `deploy/cloudflare-edge/src/subject-rights.js` for B1, B2, B3, and B5. Those findings are a different defect (story text, Teams rows, formula-shaped staffing). This addendum is the invitation export query in the same file.

## APP-FIT

**FIT** against main `8b0972ec`. `exportMine` still selects invitations with `email = ?` and the sign-in identity only (`subject-rights.js:204`). `eraseSubjectInvitations` already deletes received rows for both aliases and scrubs sent rows. The export reports less than the erase removes. The query is case-sensitive `=`, so a stored mixed-case address is also omitted.

## Done when

- The export's `invitations` list, for subject S in tenant T, includes a row in T whose `email` is either subject alias (the sign-in identity and the verified mail), compared lowercased and with the same end-trim the whitespace addendum defines.
- It includes a row in T whose `source` is either alias and whose recipient is someone else (an invitation S sent).
- It does not include another tenant's row, a blank-tenant row, or an invitation that belongs to a different person.
- The 2000-row cap stays. Stories, audit history, and the B1/B3 scrub walk are unchanged.
- `source` on a sent row is the stored value. This addendum does not publish a second person's private notes. The recipient address is already the row's `email`.

## Failing test

Name: `export includes invitations sent by the subject and invitations addressed to the mail alias`

The test fails on this main: a sent row and a row addressed to the mail alias are absent from `exportMine`.

TEST COMMAND:

```sh
cd deploy/cloudflare-edge && node --test --test-name-pattern "export includes invitations sent by the subject" test/backlog-g10-invite-erase.test.js
```

The group 10 writer adds that file. Do not edit `test/sweep01-b-security.test.js` (PR #31) or `test/sqlite.js` (PR #27).

## Files owned

None as a separate writer. The group 10 writer adds the query hunk to `deploy/cloudflare-edge/src/subject-rights.js`, which that group already owns, and adds `deploy/cloudflare-edge/test/backlog-g10-invite-erase.test.js`, which the INDEX assigns to that same writer for every group 10 addendum.

Do not edit `library.js`, `operate.js`, `util.js`, or `outreach.js` for this row. The alias list is the one `eraseSubjectInvitations` already builds. The tenant predicate is the one in the whitespace addendum. Do not invent a second copy.

## Risk

High. A wide `OR` can pull another tenant's invitations into the export. The tenant predicate stays outside the subject `OR`, the same shape `whereSubject` already uses. A sent row names the recipient. That is the subject's own invitation, which the finding says the export omits.

## Rollback

Revert the export hunk. Erase behavior does not change. An export already downloaded is not recalled.

## Dependencies

| PR | On this row |
|---|---|
| #15 | No. Worker `app.js` only. The export route is already `GET /api/me/export`. |
| #16 | No. Browser `src/app.js`. |
| #23 | No. Browser shell. |
| #25 | No. |
| #27 | Do not edit `test/sqlite.js`. The new test uses the existing `memorySql`. |
| #30 | No. |
| #35 | No file in this row. `library.js` is #35; this addendum does not take it. |
| #37 | No. |
| #40 | No. |

Group 10's own rule stands for B5: do not edit `util.js` `email()`. PR #34 owns `library-routes.js`. This row does not take that file.
