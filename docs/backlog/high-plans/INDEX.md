# Backlog high-risk plans

Plans only. No product code.

Pinned inputs: triage `/cursor/stores/bot/atlas-triage/triage.md` sha256 `1901b48b1a44181c59cce7434460e4e1a82057b99c85b53b9f4e049261f1059d`. Main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`. Sweep 01 high-risk plans on PR #38, branch `cursor/atlas-s01-high-plans`, head `a5a24e1b4d2fd9d8683f4f08841dba27497fd74a`. v2 of those plans is in progress and addresses Sentinel. This batch does not edit `docs/sweeps/s01/plans/`.

`SHA256SUMS` lists the fifteen row files and not this index. sha256 of `SHA256SUMS`: `bdbe001fd4212b4aa8ad16237e6e33798043131852bf1a3229346c4b0d2140de`.

## Disposition

| Row | Disposition | APP-FIT |
|---|---|---|
| ATLAS-EXPORT-INVITES-ALIAS | Addendum to group 10 | FIT |
| ATLAS-ERASE-TENANT-WHITESPACE | Addendum to group 10 | FIT |
| ATLAS-ERASE-COUNT-RUNTIME | Addendum to group 10 | ADAPT |
| ATLAS-ADMIN-TENANT-INVITE-ERASE | Addendum to group 10 | FIT |
| ATLAS-INVITE-REVOKE-ERASE | Addendum to group 10 | FIT |
| ATLAS-INVITE-SOURCE-ALIAS-SPOOF | Addendum to group 10 | FIT |
| ATLAS-INVITE-SOURCE-200CAP | Addendum to group 10 | ADAPT |
| ATLAS-DO-TRUSTS-XATLAS-HEADERS | Addendum to group 13 | ADAPT |
| ATLAS-DEV-IDENTITY-CJK-EMAIL-500 | Addendum to group 13 | FIT |
| ATLAS-PR10-SENTINEL-LOWS | Plan. Owns the release-gate files | ADAPT |
| ATLAS-CHECKHANDOFF-DEV-EXCLUDES | Addendum to ATLAS-PR10-SENTINEL-LOWS | FIT |
| ATLAS-CHECKHANDOFF-WALK-ONERROR | Addendum to ATLAS-PR10-SENTINEL-LOWS | FIT |
| ATLAS-HANDOFF-DENYLIST-DEVVARS | Addendum to ATLAS-PR10-SENTINEL-LOWS | FIT |
| ATLAS-ISDEVTREE-GIT-SYMLINK | Addendum to ATLAS-PR10-SENTINEL-LOWS | FIT |
| ATLAS-JOURNEY-MIXEDCASE-DUP | BLOCKED. Not planned | FIT as a live defect, blocked on Tony |

Group 16 was checked. It owns `atlas_voice/identity.py` only. Neither identity row edits that file. The header forward and the CJK 500 are Worker `app.js`, which group 13 owns.

Group 10's current plan says not to edit `operate.js` or `library.js`. The erase rows overlap `subject-rights.js`, which group 10 does own, and the same invitation functions continue into those two files. The addenda expand that one writer. They do not open a second branch on `subject-rights.js`.

## Dependency order

Three writers, no shared product file. They can be built in parallel with each other. Inside a writer the order is fixed.

1. Group 10 writer, one change, after a rebase onto PR #34, PR #35, and PR #2 for `library.js` and `operate.js`. Do not edit `library-routes.js` (PR #34) or `util.js` `email()` (group 5, and PR #35). Do not edit `test/sqlite.js` (PR #27). Order inside the change:
   1. ATLAS-ERASE-TENANT-WHITESPACE, so later queries use one tenant and alias predicate.
   2. ATLAS-ERASE-COUNT-RUNTIME, so later receipts do not call `changes()`.
   3. ATLAS-INVITE-SOURCE-ALIAS-SPOOF and ATLAS-INVITE-SOURCE-200CAP, one expression in `invite`.
   4. ATLAS-INVITE-REVOKE-ERASE.
   5. ATLAS-EXPORT-INVITES-ALIAS.
   6. ATLAS-ADMIN-TENANT-INVITE-ERASE, last, because it uses the predicate and the count.
2. Group 13 writer, one change, branched from PR #30 head `d495233609c8e2a9105a35526ccd7bb4e485a8f1`, as group 13 already requires. Rebase onto PR #15 if that identity-change return lands first, and keep it. Order inside `app.js`: ATLAS-DO-TRUSTS-XATLAS-HEADERS (strip `x-atlas-*`, then set derived values), then ATLAS-DEV-IDENTITY-CJK-EMAIL-500 (400 before a non-ByteString value is set). Do not edit `local-edge.mjs` or browser `src/app.js`.
3. Release-gate writer, one change, rebased onto PR #25 (`3d64934ee1eb`), which stacks on PR #21. Do not edit `scripts/git_home.py`. Order: ATLAS-CHECKHANDOFF-WALK-ONERROR, ATLAS-CHECKHANDOFF-DEV-EXCLUDES, ATLAS-HANDOFF-DENYLIST-DEVVARS, ATLAS-ISDEVTREE-GIT-SYMLINK, then the F-2 cap in ATLAS-PR10-SENTINEL-LOWS. F-1, the nested-git refusal, and C-L1 are already on this main and are not rewritten.

ATLAS-JOURNEY-MIXEDCASE-DUP has no place in this order. `journey.js` has no writer until Tony answers ATLAS-JOURNEY-DUPLICATES.

## File ownership

One writer per product file. Addenda do not take a second writer.

| Product file | Writer | Rows |
|---|---|---|
| `deploy/cloudflare-edge/src/subject-rights.js` | Group 10 (PR #38) | EXPORT-INVITES-ALIAS (query), ERASE-TENANT-WHITESPACE (`TENANT_SQL` only). B1/B3 stay the group's existing design. |
| `deploy/cloudflare-edge/src/operate.js` | Group 10, expanded by these addenda | ERASE-TENANT-WHITESPACE (compare), ERASE-COUNT-RUNTIME (two count lines), ADMIN-TENANT-INVITE-ERASE (new admin branch). |
| `deploy/cloudflare-edge/src/library.js` | Group 10, expanded by these addenda. Rebase onto #34, #35, and #2. | ERASE-TENANT-WHITESPACE (tenant end-trim on store), INVITE-REVOKE-ERASE, INVITE-SOURCE-ALIAS-SPOOF, INVITE-SOURCE-200CAP. |
| `deploy/cloudflare-edge/test/backlog-g10-invite-erase.test.js` | Group 10 writer, new file | The group 10 addenda. |
| `deploy/cloudflare-edge/test/invitation-tenant-erase.test.js` | Group 10 writer, the 201-character pin only | INVITE-SOURCE-200CAP. Other pins stay. |
| `deploy/cloudflare-edge/src/app.js` (Worker) | Group 13 (PR #38) | DO-TRUSTS-XATLAS-HEADERS, DEV-IDENTITY-CJK-EMAIL-500. |
| `deploy/cloudflare-edge/test/sweep01-g13-auth.test.js` | Group 13 writer, new file | Both group 13 addenda. |
| `scripts/check_handoff.py` | ATLAS-PR10-SENTINEL-LOWS | That plan plus the four release-gate addenda. |
| `tests/test_handoff.py` | ATLAS-PR10-SENTINEL-LOWS | Same. |
| `deploy/cloudflare-edge/src/journey.js` | Nobody | JOURNEY-MIXEDCASE-DUP is BLOCKED. |

Not taken by anyone in this batch: `library-routes.js`, `worker.js`, `authz.js`, `util.js`, `local-edge.mjs`, browser `src/app.js`, `atlas_voice/identity.py`, `scripts/git_home.py`, `test/sqlite.js`, `outreach.js`, `teams-routes.js`.

## Open PRs named for this batch

| PR | Head | What a writer does |
|---|---|---|
| #15 | `8fc2d0d7c4fd` | Worker `app.js`. Group 13 keeps the identity-mismatch return. |
| #16 | `3783bc6eeeac` | Browser `src/app.js`. Not the Worker file. No row takes it. |
| #23 | `ea939ccf5c58` | Browser shell. No row takes it. |
| #25 | `3d64934ee1eb` | `scripts/check_handoff.py`. Release-gate writer rebases here. Does not edit `git_home.py`. |
| #27 | `60ff6f5d98f9` | `test/sqlite.js`. No row edits it. |
| #30 | `d495233609c8e2` | Group 13's stack base. No row edits `deploy.sh`. |
| #35 | `f65a5f6ad8ee` | `library.js` and `util.js`. Group 10 rebases the `invite` line. Does not edit `email()`. |
| #37 | `f56ea9edac9b` | CI and workerd. No row edits the workflow. The count test does not claim a workerd run. |
| #40 | `7721d1993f39` | SQL-bound tests. No overlap. |

Also open, and named because they touch the same files: PR #2 (`operate.js`, `library.js`, Worker `app.js`, `worker.js`, `local-edge.mjs`), PR #21 (parent of #25, `check_handoff.py` and `test_handoff.py`), PR #34 (`library.js` and `library-routes.js`). No row edits `library-routes.js`, `worker.js`, or `local-edge.mjs`.

## Row hashes

| File | sha256 |
|---|---|
| `ATLAS-ADMIN-TENANT-INVITE-ERASE.md` | `b25c8657ba5040b9a83894e7c292992363a2ec984bcd8f5485d2d7ad380ba97c` |
| `ATLAS-CHECKHANDOFF-DEV-EXCLUDES.md` | `20fcd0a64301fc2135938cb47422464e357e1bec8febf693ba3a8066bd0e88af` |
| `ATLAS-CHECKHANDOFF-WALK-ONERROR.md` | `3d4fa7e7a68aeb1b375c99260b9bf05ced7b69cbf843bcf27b1a66a909ea405a` |
| `ATLAS-DEV-IDENTITY-CJK-EMAIL-500.md` | `168793ac8a870e756a66064eaebfa184df8d3583e710dc9c2ba747be2546d2e0` |
| `ATLAS-DO-TRUSTS-XATLAS-HEADERS.md` | `b0170dd1a57c0817052cd59bc99b05befa1584cf49656fd0b00fe8b05c9282c2` |
| `ATLAS-ERASE-COUNT-RUNTIME.md` | `66e7eb5498bcff21912a0cf138ffd6741bad6c0549196160f96f33b4b697c277` |
| `ATLAS-ERASE-TENANT-WHITESPACE.md` | `399f62505cf63914737ce84ab2af100527fe35215041463e61e0b2f08d29fb45` |
| `ATLAS-EXPORT-INVITES-ALIAS.md` | `a98647d18366f4a33361184d13bf63e3ef8aa16736eab29dbed5ae8aaf527cb9` |
| `ATLAS-HANDOFF-DENYLIST-DEVVARS.md` | `8d2562036a15e601730f68e5ef18034c0f5d8e2ef9fe7e73f36e3d4cdbb711e6` |
| `ATLAS-INVITE-REVOKE-ERASE.md` | `77ece7a1d221baef301c6037202bd5603c40991d55de7fc1ae8c99df9dccea09` |
| `ATLAS-INVITE-SOURCE-200CAP.md` | `c4db4e116db425c220837ebd96bfbb23e856c5bfef69f803346b8d3101a358ae` |
| `ATLAS-INVITE-SOURCE-ALIAS-SPOOF.md` | `7c64ea6063440d9d9d0bb16fa89244368eb5aeb089e59d170ff1986dd5a38a1b` |
| `ATLAS-ISDEVTREE-GIT-SYMLINK.md` | `167eedd323ca1649f508e85853ed20f4772751bfa737a9d5322a6b103fa1fb86` |
| `ATLAS-JOURNEY-MIXEDCASE-DUP.md` | `14aa6613add20085c875cf876ce37ac59f6ee5d7bc1c7afbf565247d0e36b828` |
| `ATLAS-PR10-SENTINEL-LOWS.md` | `089efd0b003da7ab5fe7aa39dc6f2d09eb07842ed9a75f54696c69baca0209e8` |
