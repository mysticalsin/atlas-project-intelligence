# confirmation debate, pinning tests on ed353c4

Role: non-author plan debater. This record was written after the two commits landed. It does not authorise a commit, a push, a PR edit, or a GitHub comment.

HEAD checked with `git rev-parse HEAD`: `ed353c4f3c67cc4cef01b3df1bd6cb1b807386bf`. Tree `f6e849cdb10c57e5a14d51d06bfc99adcc69673e`. Working tree clean (`git status --porcelain` empty). That is the head of PR #12 (https://github.com/mysticalsin/atlas-project-intelligence/pull/12), draft, base `c14302590e78b0319baab5893ef8c378b1c0bdf1`.

Prior consensus: `/cursor/stores/bot/atlas-pr12/pr12-plan-debate-5e5c5bb.md`, sha256 `927cf826319858c04a74bf6ec73d37b206c83d861d95c39994f7b17ae395d3e6`. CONSENSUS: AGREED on `5e5c5bb7b8e978bb52d4ded63c28bc9c91b8d9fd`. That file's last line is `CONSENSUS: AGREED`. The PR body binds that consensus to `5e5c5bb` and says a confirmation of the final head had not yet been given.

Delta under review: `5e5c5bb7b8e978bb52d4ded63c28bc9c91b8d9fd..ed353c4f3c67cc4cef01b3df1bd6cb1b807386bf`.

- `4d8a573095484e223277ede0083db1a1d17b43d0`, parent `5e5c5bb7b8e978bb52d4ded63c28bc9c91b8d9fd`. Test file only. 160 insertions.
- `ed353c4f3c67cc4cef01b3df1bd6cb1b807386bf`. `MANIFEST.json` only. The invitation-test entry moves from 22374 bytes / `820be12180c34d36d4ba16fe5ee4af8bb1c4836696cbadf362ccda45dc4bbc70` to 31251 bytes / `64e8e9a94bdc49dd11f19ff3d9e3bc42614eab9dcbce7bb2ca09667528649bee`. The file on this head matches that size and sha256.

Positions: PROPOSER defends the delta. SKEPTIC attacks it. Three questions, three rounds each, then one agreed outcome per question. The invitation file was run once on this working tree. Mutants were applied on a detached worktree at this head, then restored, and the worktree was removed. Nothing in this debate was written into the git tree.

## Evidence fixed before the rounds

`git diff --stat 5e5c5bb7b8e978bb52d4ded63c28bc9c91b8d9fd..ed353c4f3c67cc4cef01b3df1bd6cb1b807386bf`:

```
 MANIFEST.json                                      |   4 +-
 deploy/cloudflare-edge/test/invitation-tenant-erase.test.js | 160 +++++++++++++++++++++
 2 files changed, 162 insertions(+), 2 deletions(-)
```

`git diff --name-only` for that range is those two paths. `git diff` of the same range with `MANIFEST.json` and `deploy/cloudflare-edge/test` excluded is 0 bytes and names no file.

`eraseSubjectInvitations` is unchanged. `alias.length <= 60` still gates `str(alias, 60)`. `invite` still stores `str(b.source || actor, 200)`. Scrubbed is still the sum of `changes()` after each per-row update. `eraseMine` still calls that helper and `bump` still skips a zero.

One run, on this working tree:

```
cd deploy/cloudflare-edge && node --test test/invitation-tenant-erase.test.js
```

`# tests 28`, `# pass 28`, `# fail 0`, `# skipped 0`, `duration_ms 616.394634`, exit 0. Nine of those tests are named `pinning:`.

Mutants of a detached copy, each restored before the next. The whole file unless noted.

| Mutant | Result |
| --- | --- |
| `alias.length <= 60` changed to `< 60` | 28 tests, 27 pass, 1 fail, exit 1. Only `pinning: an alias of exactly 60 characters scrubs the source str collapses`. |
| `alias.length <= 60` changed to `<= 61` | 28 tests, 27 pass, 1 fail, exit 1. Only `pinning: an alias of exactly 61 characters leaves a different 60-character prefix`. |
| `prefixes` forced to `[]` | 28 tests, 27 pass, 1 fail, exit 1. Only the 60-character collapsed-source test. |
| `str(b.source \|\| actor, 200)` changed to `str(..., 199)` | 28 tests, 26 pass, 2 fail, exit 1. The 200-character actor and the 201-character actor. |
| the 200 cap removed (`str` with no bound) | 28 tests, 27 pass, 1 fail, exit 1. Only the 201-character actor. |
| `str(..., 200)` put back to `str(..., 60)` | Pinning pattern: 9 tests, 5 pass, 4 fail, exit 1. The 61-character prefix, the 200-character actor, the 201-character actor, and `POST /api/me/erase` long-email twin. |
| `prefixes` built for every alias, length filter removed | 28 tests, 25 pass, 3 fail, exit 1. The older privacy-delete prefix test, the 61-character pinning test, and `pinning: POST /api/me/erase leaves a legacy 60-character prefix and does not count it`. |
| `scrubbed` set to `sent.length` before the same updates | 28 tests, 27 pass, 1 fail, exit 1. Only `pinning: the scrub count is changes() when that differs from the pre-write select`. |
| Tenant predicate replaced with a parenthesized tautology that still consumes the tenant parameter | Pinning `POST /api/me/erase` pattern: 4 tests, 3 pass, 1 fail, exit 1. Only `leaves the same sender in another tenant`. Actual source `erased:cc9511f1c454`, expected `ada@example.test`. |

The 60-character alias is `'a'` 28 times, two spaces, `'b'` 30 times. Length 60. `str` collapses it to 59 characters. `subjectAliases` trims and lowercases. It does not collapse. `invite` stores the collapsed form, so the full-alias compare misses that row. The `<= 60` arm is what scrubs it.

PR #12 body, read from the open draft at head `ed353c4f3c67cc4cef01b3df1bd6cb1b807386bf`. The line `Risk: HIGH` is present, alone, after the opening paragraph. The consensus sentence in the body is bound to `5e5c5bb7b8e978bb52d4ded63c28bc9c91b8d9fd` and to sha256 `927cf826319858c04a74bf6ec73d37b206c83d861d95c39994f7b17ae395d3e6`. `63779db38484471abeb95f56b767e7265e3f8736` appears as the commit whose review requested Fix round 1, and as the historical manifest-refresh measurement. The body does not bind this head, or this confirmation, to `63779db`.

Residuals, quoted from that body:

- ATLAS-ADMIN-TENANT-INVITE-ERASE: there is no admin operation that erases every invitation in a tenant. Out of scope for this head.
- ATLAS-INVITE-REVOKE-ERASE: dismissing or updating an invitation does not erase `source`. There is no invite-revoke erase. Out of scope for this head.

Code on this head: `UPDATE invitations SET source` exists in `eraseSubjectInvitations` only. `updateInvitation` writes status, slot, or `reference_id`. The system `scan-stale` path calls `retentionSweep`, which deletes invitations whose status is `done` or `dismissed` and whose `created_at` is older than the outreach cut. That is not every invitation in the tenant, and it is not a dismiss that clears `source`.

## 1. Production code and behaviour

Round 1. PROPOSER: The range contains two commits. `4d8a573` adds lines to `deploy/cloudflare-edge/test/invitation-tenant-erase.test.js`. `ed353c4` rewrites that file's size and sha256 in `MANIFEST.json` and leaves every other manifest entry as it was. `git diff --stat` lists those two paths. The diff with the test directory and `MANIFEST.json` excluded is empty. `library.js` and `operate.js` are byte-identical to `5e5c5bb`, and so is every other non-test, non-manifest file. The worker does not import the test file. A manifest hash of a test file does not change erase, invite, or the receipt.

Round 1. SKEPTIC: The body's measured section names only `library.js` and `operate.js`. A change could sit in `subject-rights.js`, `app.js`, or the retention sweep and still leave those two files identical. The manifest is a tracked file. If a runtime reader used it to choose a code path, regenerating it would be a behaviour change. The test file's header comment now states that there is no admin whole-tenant erase and no invite-revoke erase. A comment is not a behaviour change, and it is also not a test.

Round 2. PROPOSER: The unrestricted name-only diff is the answer to the first objection. Two paths. The excluded diff is 0 bytes, so `subject-rights.js`, `app.js`, `retention.js`, and the rest of the tree are unchanged. `MANIFEST.json` is the handoff content list. This delta changes one entry, the test file that `4d8a573` edited, to the hash of that file. No production module reads that entry to decide an erase. The comment documents the residuals. It does not call them.

Round 2. SKEPTIC: Then the behaviour claim has to be the full tree, and the body's narrower sentence is still true. I will not call a manifest refresh of a test hash a production change. The agreed plan's code on `5e5c5bb` is the code on this head.

Round 3. PROPOSER: Agreed.

Round 3. SKEPTIC: Agreed.

Agreed outcome: The delta changes no production code and no production behaviour. `git diff --stat` is the test file and `MANIFEST.json`. The full diff of non-test, non-manifest files is empty.

## 2. Whether the new tests pin the agreed plan

Round 1. PROPOSER: The prior debate's open test gap was the `<= 60` arm. Forcing `prefixes` to `[]` was green on the 19 tests. On this head that mutant fails the new 60-character test, and only that test. The alias is 60 characters and differs from `str(alias, 60)`. A gate of `< 60` fails that same test. A gate of `<= 61` fails the 61-character test: the seeded 60-character prefix becomes an `erased:` token. The 200-character actor is stored whole, so a cap of 199 fails it. The 201-character actor is stored as `str(actor, 200)`, so a cap of 199 and a removed cap both fail it. Replacing the `changes()` sum with `sent.length` fails the trigger test: the receipt would say 2 while one update was ignored. `POST /api/me/erase` has four pinning tests. A short alias is scrubbed and `invitationSources` is 1. The long-email twin's stored source is left and the count is 1. Putting the store back to 60 fails that twin test. The same sender in tenant B is left. A parenthesized match of every tenant rewrites that row to an `erased:` token and leaves the other three me/erase pinning tests green. A legacy row seeded as `str(LONG_MAIL, 60)` stays, and the body has neither `counts.invitationSources` nor `counts.invitations`. Building the 60-character form for every alias fails that legacy test.

Round 1. SKEPTIC: The short-alias test uses `ada@example.test`. `invite` stores it whole, so the full-alias compare scrubs it with the arm deleted. That test does not pin `<= 60`. The long-email twin is stored in full. Matching `str(alias, 60)` for every alias left that twin test green, because `LONG_COM` is not the 60-character prefix. The 61-character gate and the legacy row are what go red. The `changes()` test depends on `RAISE(IGNORE)` skipping one row. The 200 and 201 tests call `lib.invite` directly. They pin the store. They do not pin the residual where a 200-character identity and a longer actor share those 200 stored characters. The me/erase legacy test locks the current omission of a zero key. It does not make the receipt say that a truncated sender was left.

Round 2. PROPOSER: The short alias is the route pin the checklist asked for. The gate boundaries are the 60 and 61 tests, and both routes call `eraseSubjectInvitations`. Removing the arm fails the 60-character test, which is the follow-up the prior debate left open. The long-email twin test is the me/erase outcome: one full long address scrubbed, the address that differs after 60 characters left, count 1. The store-at-60 mutant fails it, so a return to the shared prefix is red on that route. The widened gate is red on the 61-character test and on the me/erase legacy test. The trigger test passed on this SQLite, and the `sent.length` mutant failed only that test, so the receipt is the writes. The 200-character collision stays the residual ATLAS-INVITE-SOURCE-200CAP. The legacy receipt stays the residual ATLAS-LEGACY-PREFIX-RECEIPT. Pinning those behaviours is what a characterization test does. Tony's decision on the one-off is unchanged.

Round 2. SKEPTIC: The suite, taken together, pins the checklist. I will not ask the short-alias test to do the gate's job. I will not ask the long-email twin test to fail a widened gate when the twin is stored in full. The 61-character test and the legacy me/erase test cover that widening. The direct `invite` calls are the right layer for the cap. The zero-key assertion is the agreed `bump` behaviour, and the residual still says the receipt does not explain the leftover.

Round 3. PROPOSER: Agreed.

Round 3. SKEPTIC: Agreed.

Agreed outcome: The new tests pin the agreed plan. Gate boundaries: 60 scrubs the collapsed form, 61 leaves a different 60-character prefix, and deleting the arm fails the 60-character test. Actor cap: 200 stored whole, 201 stored as the first 200. `changes()`: the receipt is 1 when the pre-write select length is 2. `POST /api/me/erase`: short alias scrubbed and counted, long-email twin left and the count is 1, the same sender in another tenant left, legacy 60-character prefix left and uncounted.

## 3. Residuals in the PR body

Round 1. PROPOSER: The body has `Risk: HIGH` as its own line. ATLAS-ADMIN-TENANT-INVITE-ERASE says there is no admin operation that erases every invitation in a tenant. No such operation exists. Privacy delete and `POST /api/me/erase` are per subject. The system retention sweep deletes old `done` and `dismissed` invitations only. ATLAS-INVITE-REVOKE-ERASE says dismiss and update do not erase `source`, and there is no invite-revoke erase. `updateInvitation` does not write `source`. The only `source` update is the subject scrub. `63779db` is named as the reviewed ancestor and as a past measurement. The live consensus sentence is bound to `5e5c5bb`, and the body says a confirmation of this head was still ahead.

Round 1. SKEPTIC: Retention is a tenant-scoped delete of invitations. Calling the residual "no admin operation" can be read as "no invitation delete exists besides the subject erase." The test comment repeats the residual and does not assert it, so the body is making a code claim the new tests do not prove. The linked `handoff/decisions/pr12-plan-debate.md` still records its own HEAD as `63779db`. A reader who follows that link can think the current agreement is that older debate. The body also says the confirmation of this head has not been given. If this record agrees, that sentence becomes stale only after this record exists. It was accurate when the body was written.

Round 2. PROPOSER: The residual's words are "every invitation in a tenant." Open and scheduled rows are outside the retention cut, and the sweep is the system daily, not an admin erase-all. The dismiss residual is about `source` on update. Both match the code. The tests are not the evidence for those two sentences. The search of this tree is. The decision file is the record of the debate that ran on `63779db`. The body says that debate missed the 60-character truncation and that Fix round 1 addressed it. It then binds the later consensus to `5e5c5bb` by full sha and by the sha256 of the store file, which matches the file read for this confirmation. That is a historical citation of `63779db`, and a current binding to `5e5c5bb`.

Round 2. SKEPTIC: The two residual sentences are honest on this head. `Risk: HIGH` is present. I will not call the ancestor measurements a binding of `ed353c4` to `63779db`. The confirmation sentence in the body was the right claim before this record. This record is the confirmation it deferred.

Round 3. PROPOSER: Agreed.

Round 3. SKEPTIC: Agreed.

Agreed outcome: The residuals are honestly stated. `Risk: HIGH` is present. ATLAS-ADMIN-TENANT-INVITE-ERASE and ATLAS-INVITE-REVOKE-ERASE match the tree. The body does not bind this head to `63779db`.

## Outcomes

1. Production code and behaviour: unchanged from `5e5c5bb`. Diff stat is the invitation test and `MANIFEST.json`. The non-test, non-manifest diff is empty.
2. Pinning tests: they pin the agreed plan. The one invitation-file run on this head is 28 pass, 0 fail, exit 0. The mutants above go red on the boundary each test names.
3. Residuals: ATLAS-ADMIN-TENANT-INVITE-ERASE and ATLAS-INVITE-REVOKE-ERASE are accurate. `Risk: HIGH` is present. No stale `63779db` binding.

## MUST CHANGE

None.

CONSENSUS: AGREED on ed353c4f3c67cc4cef01b3df1bd6cb1b807386bf
