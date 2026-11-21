# Backlog high-risk plans

Plans only. No product code.

Pinned inputs: triage `/cursor/stores/bot/atlas-triage/triage.md` sha256 `1901b48b1a44181c59cce7434460e4e1a82057b99c85b53b9f4e049261f1059d`. Main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`. Sweep 01 high-risk plans on PR #38, branch `cursor/atlas-s01-high-plans`, head `4d15c83c7485c6e73cd50d1f2eded3824a636526`. Devin r8a2f8337 pins #38 there, not `a5a24e1`. The branch tip at this freeze is `73dd4df385ee0dbf5f29d00afdf465ea95ea125b` (v4). These addenda cite `4d15c83c`. This batch does not edit `docs/sweeps/s01/plans/`.

`SHA256SUMS` lists the fifteen row files and not this index. sha256 of `SHA256SUMS`: `4741e8dc894feabb1929bb194173316b86048abe9a3c1f85c076e3c806b57ba5`.

## v2 freeze

Sentinel reviewed PR #46 at `2f890c3d130c33b8bbb7b9829abebcf5f208922a`. Report sha256 prefix `7343b668`. Rows 1–12 and 14 of that review were agreed. Row 13 (`ATLAS-HANDOFF-DENYLIST-DEVVARS`) was changed. Row 15 (`ATLAS-JOURNEY-MIXEDCASE-DUP`) stays blocked on Tony. The agreed rows below fold the low and info lines from that review.

Devin on the same head, report `r8a2f8337`: 13 PASS. REVISE `ATLAS-DEV-IDENTITY-CJK-EMAIL-500` and `ATLAS-PR10-SENTINEL-LOWS`. The medium and low lines from that report are in the row files. "Bring in" means an ordinary merge. Do not rebase a pushed branch.

| Review | Row | What v2 changed |
|---|---|---|
| R2, info | ATLAS-ERASE-COUNT-RUNTIME | The before count and the after count use the same predicate. |
| R3, low | ATLAS-INVITE-SOURCE-ALIAS-SPOOF | An empty actor is 400, or the stored source is the verified library identity. |
| R4, info | ATLAS-INVITE-SOURCE-200CAP | 254 is JavaScript `.length` (UTF-16 code units), not UTF-8 bytes. |
| R5, low | ATLAS-INVITE-REVOKE-ERASE | The token is `tokenOf({})`, not a sender hash. |
| R6, low | ATLAS-EXPORT-INVITES-ALIAS | Spoof lands before export. A truncated flag at the 2000 cap. |
| R7, low | ATLAS-ADMIN-TENANT-INVITE-ERASE | Count, delete, and count in one transaction. Audit the actor, tenant, and count. `confirm` is the tenant id. |
| R8, low | ATLAS-DO-TRUSTS-XATLAS-HEADERS | One table over every Durable Object fetch and every `x-atlas-*` header, including admin, subj, bank, and csrf. |
| R9, low | ATLAS-DEV-IDENTITY-CJK-EMAIL-500 | One guard after sign-in. It covers consent, privacy, and stored consent. The 400 does not echo the address. A Latin-1 test. |
| R10, low | ATLAS-PR10-SENTINEL-LOWS | The file count is enforced in all three walks. C-1 size and extraction stay open. |
| R11, low | ATLAS-CHECKHANDOFF-DEV-EXCLUDES | Refuse empty, `/`, `./`, absolute, and `..` excludes. Hygiene and nested-git are not exempt. |
| R12, low | ATLAS-CHECKHANDOFF-WALK-ONERROR | Any `OSError`, including an unreadable root, on all three walks. |
| R13, medium | ATLAS-HANDOFF-DENYLIST-DEVVARS | Case-insensitive names, including the existing `.env` rule. Also refuse `.dev.vars.<env>`. Two red tests. |
| R14, low | ATLAS-ISDEVTREE-GIT-SYMLINK | Tests for a `.git` file pointer and a symlinked `.git/HEAD`. `git_environ` drops the caller's `GIT_DIR`, `GIT_WORK_TREE`, and `GIT_CONFIG*`. |
| R15 | ATLAS-JOURNEY-MIXEDCASE-DUP | Unchanged. Still BLOCKED. |

`ATLAS-ERASE-TENANT-WHITESPACE` had no review line to fold. That file is unchanged from `2f890c3d`.

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

1. Group 10 writer, one change, after an ordinary merge of PR #34, PR #35, PR #2, and PR #41 for `library.js` and `operate.js`. Do not rebase those pushed branches. PR #41 also edits `operate.js` (living import, `privacyRoutes`). Those hunks do not overlap this writer's invitation hunks. Name #41 and keep its hunks. Do not edit `library-routes.js` (PR #34) or `util.js` `email()` (group 5, and PR #35). Do not edit `test/sqlite.js` (PR #27). Order inside the change:
   1. ATLAS-ERASE-TENANT-WHITESPACE, so later queries use one tenant and alias predicate.
   2. ATLAS-ERASE-COUNT-RUNTIME, so later receipts do not call `changes()`.
   3. ATLAS-INVITE-SOURCE-ALIAS-SPOOF and ATLAS-INVITE-SOURCE-200CAP, one expression in `invite`. Spoof is before export (review R6). The export reads the verified actor, not `body.source`.
   4. ATLAS-INVITE-REVOKE-ERASE. The token is `tokenOf({})`.
   5. ATLAS-EXPORT-INVITES-ALIAS, including the truncated flag at 2000.
   6. ATLAS-ADMIN-TENANT-INVITE-ERASE, last, because it uses the predicate and the count.
2. Group 13 writer, one change, brought in by an ordinary merge of PR #30 head `d495233609c8e2a9105a35526ccd7bb4e485a8f1`, as group 13 already requires. If PR #15 lands first, bring it in the same way and keep its identity-mismatch return. Do not rebase those pushed branches. Order inside `app.js`: ATLAS-DO-TRUSTS-XATLAS-HEADERS (strip `x-atlas-*`, derive the user, do not edit `worker.js`), then ATLAS-DEV-IDENTITY-CJK-EMAIL-500 (400 only on the paths that write the header; `GET /` stays 200). Do not edit `local-edge.mjs` or browser `src/app.js`.
3. Release-gate writer, one change, brought in by an ordinary merge of PR #25 (`3d64934ee1eb`), which stacks on PR #21, then of PR #41 and PR #42 before the `MANIFEST.json` hash refresh. Do not rebase those pushed branches. Do not edit `scripts/git_home.py`. Do not revert #41's `Makefile` row or #42's living rows. Order: ATLAS-CHECKHANDOFF-WALK-ONERROR, ATLAS-CHECKHANDOFF-DEV-EXCLUDES, ATLAS-HANDOFF-DENYLIST-DEVVARS, ATLAS-ISDEVTREE-GIT-SYMLINK, then the F-2 cap in ATLAS-PR10-SENTINEL-LOWS, then refresh the two existing manifest rows for `scripts/check_handoff.py` and `tests/test_handoff.py`. F-1, the nested-git refusal, and C-L1 are already on this main and are not rewritten.

ATLAS-JOURNEY-MIXEDCASE-DUP has no place in this order. It stays unscheduled. `journey.js` is untouched until Tony answers ATLAS-JOURNEY-DUPLICATES.

## File ownership

One writer per product file. Addenda do not take a second writer.

| Product file | Writer | Rows |
|---|---|---|
| `deploy/cloudflare-edge/src/subject-rights.js` | Group 10 (PR #38) | EXPORT-INVITES-ALIAS (query), ERASE-TENANT-WHITESPACE (`TENANT_SQL` only). B1/B3 stay the group's existing design. |
| `deploy/cloudflare-edge/src/operate.js` | Group 10, expanded by these addenda. PR #41's living import and `privacyRoutes` stay. Ordinary merge. The hunks do not overlap. | ERASE-TENANT-WHITESPACE (compare), ERASE-COUNT-RUNTIME (two count lines), ADMIN-TENANT-INVITE-ERASE (new admin branch). |
| `deploy/cloudflare-edge/src/library.js` | Group 10, expanded by these addenda. Ordinary merge of #34, #35, #2, and #41. Do not rebase. | ERASE-TENANT-WHITESPACE (tenant end-trim on store), INVITE-REVOKE-ERASE, INVITE-SOURCE-ALIAS-SPOOF, INVITE-SOURCE-200CAP. |
| `deploy/cloudflare-edge/test/backlog-g10-invite-erase.test.js` | Group 10 writer, new file | The group 10 addenda. |
| `deploy/cloudflare-edge/test/invitation-tenant-erase.test.js` | Group 10 writer, the 201-character pin only | INVITE-SOURCE-200CAP. Other pins stay. |
| `deploy/cloudflare-edge/src/app.js` (Worker) | Group 13 (PR #38) | DO-TRUSTS-XATLAS-HEADERS, DEV-IDENTITY-CJK-EMAIL-500. |
| `deploy/cloudflare-edge/test/sweep01-g13-auth.test.js` | Group 13 writer, new file | Both group 13 addenda. |
| `scripts/check_handoff.py` | ATLAS-PR10-SENTINEL-LOWS | That plan plus the four release-gate addenda. Refresh its `MANIFEST.json` row. |
| `tests/test_handoff.py` | ATLAS-PR10-SENTINEL-LOWS | Same, including its manifest row. |
| `MANIFEST.json` | ATLAS-PR10-SENTINEL-LOWS, last, after an ordinary merge of #41 and #42 | The two handoff rows only. Do not revert `Makefile` or living rows. |
| `deploy/cloudflare-edge/src/journey.js` | Nobody | JOURNEY-MIXEDCASE-DUP is BLOCKED. |

Not taken by anyone in this batch: `library-routes.js`, `worker.js`, `authz.js`, `util.js`, `local-edge.mjs`, browser `src/app.js`, `atlas_voice/identity.py`, `scripts/git_home.py`, `test/sqlite.js`, `outreach.js`, `teams-routes.js`.

## Open PRs named for this batch

| PR | Head | What a writer does |
|---|---|---|
| #15 | `8fc2d0d7c4fd` | Worker `app.js`. Group 13 keeps the identity-mismatch return. |
| #16 | `3783bc6eeeac` | Browser `src/app.js`. Not the Worker file. No row takes it. |
| #23 | `ea939ccf5c58` | Browser shell. No row takes it. |
| #25 | `3d64934ee1eb` | `scripts/check_handoff.py`. Release-gate writer brings this in with an ordinary merge. Does not edit `git_home.py`. Does not rebase. |
| #27 | `60ff6f5d98f9` | `test/sqlite.js`. No row edits it. |
| #30 | `d495233609c8e2` | Group 13's stack base. No row edits `deploy.sh`. |
| #35 | `f65a5f6ad8ee` | `library.js` and `util.js`. Group 10 brings the `invite` line in with an ordinary merge. Does not edit `email()`. Does not rebase. |
| #41 | `097c5c6680d1` | `MANIFEST.json`, `Makefile`, and `operate.js` (living import, `privacyRoutes`). Ordinary merge. Group 10 keeps those operate hunks. The release-gate writer does not revert the `Makefile` row. |
| #42 | `4457d69c713a` | `MANIFEST.json`, stacked on #41. Ordinary merge before the handoff hash refresh. Do not revert the living rows. |
| #37 | `f56ea9edac9b` | CI and workerd. No row edits the workflow. The count test does not claim a workerd run. |
| #40 | `7721d1993f39` | SQL-bound tests. No overlap. |

Also open, and named because they touch the same files: PR #2 (`operate.js`, `library.js`, Worker `app.js`, `worker.js`, `local-edge.mjs`), PR #21 (parent of #25, `check_handoff.py` and `test_handoff.py`), PR #34 (`library.js` and `library-routes.js`). No row edits `library-routes.js`, `worker.js`, or `local-edge.mjs`.

## Row hashes

| File | sha256 |
|---|---|
| `ATLAS-ADMIN-TENANT-INVITE-ERASE.md` | `7fbc14f7456877b763b0bf6fc40d10c6b2d116af94f6018c653754d9d5479f8e` |
| `ATLAS-CHECKHANDOFF-DEV-EXCLUDES.md` | `6dcaa92469542acd16c2735dc5d3cd3c997449c058c149a89deb4661f05b1c99` |
| `ATLAS-CHECKHANDOFF-WALK-ONERROR.md` | `91e81a9cd688b51654ea7c6e761a3b599cd47f98dce9f66dfd9abc0816040758` |
| `ATLAS-DEV-IDENTITY-CJK-EMAIL-500.md` | `0408861a99388b4d66a93544a8f69637695c3f6b074916d68f18f27bf605699e` |
| `ATLAS-DO-TRUSTS-XATLAS-HEADERS.md` | `134beb4f5c045875c21c8eaf5ce9562b79f4a47fbdd3da55a3aa30d9272becc5` |
| `ATLAS-ERASE-COUNT-RUNTIME.md` | `02d4623edbd4f676abd37d4a4d55a00f206a8b7892a06717f70dfcd7bf9203e9` |
| `ATLAS-ERASE-TENANT-WHITESPACE.md` | `a7d060ee575afde60e2b2cefd4f91280fc5e8cff7ad3be2d975c4cf9448e7d9a` |
| `ATLAS-EXPORT-INVITES-ALIAS.md` | `be603795d328f708552e606a1662bd73d5c8df850479355d16a9ba77b9b8b9fe` |
| `ATLAS-HANDOFF-DENYLIST-DEVVARS.md` | `0b645f0d6a63bf6fff485caccbc66c57021c7e3bbad1758ed09c1d72e39c6fdc` |
| `ATLAS-INVITE-REVOKE-ERASE.md` | `68473b1f0496544a7e2ecc3902d9ee846f2aac1d05f63040994405f304ee3b01` |
| `ATLAS-INVITE-SOURCE-200CAP.md` | `bbcb5142d7619df332b65a1ce19a76433e2b45a6cd9b8cccef520e1d156bdfaa` |
| `ATLAS-INVITE-SOURCE-ALIAS-SPOOF.md` | `7da83f5022db2018059ecd51f8b9020505dfd02c91c253377bf6e38a4a4bc060` |
| `ATLAS-ISDEVTREE-GIT-SYMLINK.md` | `4e0d0afde264f6fffce646c743685d18b4949cfde2ebd04756d1534ebb4571c3` |
| `ATLAS-JOURNEY-MIXEDCASE-DUP.md` | `620c7b9ce90cd0a7eb0cbd338fe319fc48f1f64a60b006e7f683bd8ef0d64ff2` |
| `ATLAS-PR10-SENTINEL-LOWS.md` | `f11dc6ae83f16fc6386ae46f20d270f0caa5fe8fd7099f830dce13db5cdc2073` |
