# ATLAS-ADMIN-TENANT-INVITE-ERASE

Disposition: **ADDENDUM** to Sweep 01 group 10. Not a parallel plan.

Group 10 plan: `docs/sweeps/s01/plans/group-10-erasure-tenant.md` on PR #38, branch `cursor/atlas-s01-high-plans`, head `4d15c83c7485c6e73cd50d1f2eded3824a636526`. head `4d15c83c7485c6e73cd50d1f2eded3824a636526`. Devin r8a2f8337 pins PR #38 there, not `a5a24e1`. The branch tip at this freeze is `73dd4df385ee0dbf5f29d00afdf465ea95ea125b` (v4). These addenda cite `4d15c83c`. They do not edit `docs/sweeps/s01/plans/`.

Pinned main: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
Triage: `triage.md` sha256 `1901b48b1a44181c59cce7434460e4e1a82057b99c85b53b9f4e049261f1059d`.

`operate.js` reaches this writer through the whitespace and count addenda. The admin route is the same file. `library-routes.js` already forwards `id === 'admin'` to `adminRoutes`. This addendum does not edit `library-routes.js` (PR #34).

## APP-FIT

**FIT** against main `8b0972ec`. `adminRoutes` (`operate.js:155-174`) is metrics, export, and publish. Nothing deletes every invitation in a tenant. `invitation-tenant-erase.test.js:7-8` states that gap. Subject erase deletes one person's rows. It is not this operation.

## Done when

- `POST /api/library/admin/erase-invitations` with a verified admin in an enforced tenant deletes every invitation whose stored tenant matches that admin's tenant under the whitespace addendum's end-trim. The receipt reports the number removed, using the count addendum's before-and-after count, not `changes()`.
- Sentinel v2, low on review `7343b668` of `2f890c3d` (R7): the count, the delete, and the second count run in one transaction. A failure rolls all three back. Both counts use the same predicate.
- The audit line records the actor, the verified tenant, and the count. It does not record invitation addresses.
- The confirm field is bound to the verified tenant id. A body whose confirm is missing, or is any other value, is refused and deletes nothing. A boolean `true` is not confirmation. The body cannot name a different tenant to delete. A non-admin is 403. A reviewer is 403.
- With tenant enforcement off, the route is 403. The blank local sandbox is not wiped. Two blank tenants are not "the" tenant for a whole-tenant delete.
- Another tenant's invitations, including a tab-padded other tenant, stay. Stories, staffing, and audit history stay.
- The existing subject erase is unchanged. This route does not scrub one person's sent rows and leave the rest. It removes the tenant's invitation rows.

## Failing test

Name: `an admin erase deletes every invitation in the verified tenant and leaves the other tenant`

On this main the route is 404 `Not found.` and both tenants' rows stay. The same test sends `confirm` equal to the verified tenant and expects the delete, then sends `confirm: true` and a different tenant and expects no delete. The audit row names the actor, the tenant, and the count.

TEST COMMAND:

```sh
cd deploy/cloudflare-edge && node --test --test-name-pattern "admin erase deletes every invitation" test/backlog-g10-invite-erase.test.js
```

## Files owned

None as a separate writer. The group 10 writer adds the branch inside `adminRoutes` in `deploy/cloudflare-edge/src/operate.js`, and the test in `deploy/cloudflare-edge/test/backlog-g10-invite-erase.test.js`.

Do not edit `library-routes.js`, `library.js`, or `subject-rights.js` for this route.

## Risk

High. A body-selected tenant would let an admin erase a tenant they are not in. The verified tenant is the only scope, and the unenforced sandbox is refused. The audit line uses the existing `lib.log` with the count, not the invitation addresses.

## Rollback

Revert the route branch. Invitations already deleted by an admin call stay deleted. Subject erase is untouched.

## Dependencies

| PR | On this row |
|---|---|
| #15 | No. |
| #16 | No. |
| #23 | No. |
| #25 | No. |
| #27 | Do not edit `test/sqlite.js`. |
| #30 | No. |
| #35 | No. This route does not edit `library.js`. |
| #37 | No. |
| #40 | No. |

Also open: PR #2 edits `operate.js`. Bring that head in with an ordinary merge. Do not rebase that pushed branch. Build this route after the whitespace predicate and the count hunk in the same change, so the receipt and the scope exist once.

## Branch base

main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`. Bring in, by ordinary merge, PR #34, PR #35, PR #2, and PR #41 (`097c5c6680d1b8cfd55db23d39cd027ff69c9133`, `cursor/atlas-living-cv`). Do not rebase those pushed branches. PR #41 also edits `operate.js` (living import, `privacyRoutes`). Those hunks do not overlap this addendum. Do not revert them.

## Known limits

- The route deletes every invitation in the verified tenant. It does not replace subject erase.
- `confirm` must be that tenant id. A boolean `true` deletes nothing.
- Tenant enforcement off is 403. The blank sandbox is not wiped.

## Ask

| Ask | None. This row does not ask Tony. |

## Tony source

The backlog row has no separate tony-verbatim card. The title below is copied verbatim from `rows-full.txt`.

> PR12 F-1 (Info, carried, not waived): no admin operation erases every invitation in a tenant
