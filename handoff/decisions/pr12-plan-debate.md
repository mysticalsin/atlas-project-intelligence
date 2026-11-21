# post-build plan debate (retroactive)

Role: non-author plan debater. This record was written after the code landed. It is not a pre-build debate, and it does not authorise a commit, a push, a PR edit, or a GitHub comment.

HEAD checked with `git rev-parse HEAD`: `63779db38484471abeb95f56b767e7265e3f8736` on `cursor/atlas-invitation-tenant-erase`. That is the head of PR #12.

Inputs used:

- Decision record added in `af32757305add11e9f864147dc4361257dea76c4`: `handoff/decisions/invitation-tenant-erase.md` (that commit adds only this file).
- PR #12 body, https://github.com/mysticalsin/atlas-project-intelligence/pull/12 (draft; head `63779db38484471abeb95f56b767e7265e3f8736`; base `c14302590e78b0319baab5893ef8c378b1c0bdf1`).
- Diff of `deploy/cloudflare-edge/src/library.js`, `deploy/cloudflare-edge/src/operate.js`, and the tests against `c14302590e78b0319baab5893ef8c378b1c0bdf1`.
- `sameTenant` in `deploy/cloudflare-edge/src/authz.js`, the invitation readers and writers, `eraseMine` in `subject-rights.js`, `withTransaction` / `recorded`, and `memorySql.transactionSync`.

Tickets under debate, as built:

- INVITE-TENANT-UNENFORCED. `Library.updateInvitation` calls `sameTenant(inv.tenant, user.tenant, user.tenantEnforced === true)` before `this.recorded`.
- ERASE-LEAVES-INVITATIONS. Inside the existing privacy-delete transaction, invitations in the verified tenant whose `email` is the subject are deleted, and `source` on invitations in that tenant that the subject sent to someone else is set to an `erased:` token. The receipt reports `removed` and `scrubbed`.

Positions: PROPOSER defends the plan that was built (decision options C and F). CHALLENGER attacks it. Three rounds, then one agreed outcome per point.

## Evidence fixed before the rounds

`sameTenant(recordTenant, userTenant, enforced)` lowercases both sides and does not trim:

- Flag true: the user side must match `TENANT_ID`, and the two lowercased strings must be equal. An empty string fails `TENANT_ID`.
- Flag false: two non-empty strings must be equal; exactly one non-empty side is a refusal; two empty sides match.

Privacy delete takes the tenant from `journeyTenant`, which trims and lowercases, then requires `TENANT_ID` before `withTransaction`. `eraseInvitations` scopes with `lower(COALESCE(tenant, '')) = ?`. The token is `tokenOf({})`, which calls `crypto.getRandomValues` for 6 bytes and prefixes `erased:`. It does not read the subject. One token is applied to every scrubbed row in that call. `withTransaction` calls `lib.transactionSync`, which on `Library` is `recorded`, which runs inside SQL `transactionSync`. `memorySql` rolls back on throw.

Red run, required for point 7. Commit `5e394849871719758b31b3586154d98cd3500864`, parent `af32757305add11e9f864147dc4361257dea76c4`, tree `3589a59dc6f457a8fc37e945a45bc4e2bc6255c6`. `library.js` and `operate.js` are identical to base `c14302590e78b0319baab5893ef8c378b1c0bdf1`. The test file is identical to HEAD. Command: `node --test test/invitation-tenant-erase.test.js` on a `git archive` of that commit.

```
# tests 4
# pass 2
# fail 2
# skipped 0
EXIT:1
```

- Test (a), enforcement off: `Missing expected exception.` at the tenant-B `dismiss` (`assert.throws`, line 47). The same-tenant `schedule` above it had already succeeded.
- Test (b), enforcement on: pass.
- Test (c), erase: `2 !== 0` at the received-row count (line 103). The run stops there, so this execution does not reach the source, receipt, or audit assertions.
- Test (d), other rows: pass. On this commit nothing is erased, so the pass is vacuous. The PR says that.

## 1. Blank-tenant matching, enforcement on and enforcement off

Round 1. PROPOSER: The built check is the predicate `access` already uses. Enforcement on still requires equal UUIDs, so two blanks do not match and a blank does not match a present id. Enforcement off still matches two blanks, which is the local-synthetic sandbox the done-when names, and it refuses a present id against a blank. Option B (always pass `true`) would make that sandbox unable to update its own invitation. Option A is the bug.

Round 1. CHALLENGER: The ticket sentence "two blank tenants still match" has no flag on it. With the flag true, two blanks do not match, because `TENANT_ID` rejects `''`. With the flag false, every blank caller shares one writable pool, and a blank reviewer can update any blank invitation. That pool is wider than "the same user updating their own row."

Round 2. PROPOSER: The decision and the PR body already split the flag. Enforcement on is fail-closed: blanks do not match. Enforcement off matches blanks because `authz.js` defines two empty tenants as one sandbox, and a missing id never matches a present id. `productionDemoConflict` refuses `DATA_MODE=production` together with `ATLAS_TENANT_ISOLATION=local-synthetic`, and `libraryRoutes` returns 503 before the invitation write. The blank pool is the sandbox that already existed for `access`. This change stops a present tenant B from writing tenant A's row while that flag is off, which is what test (a) failed on.

Round 2. CHALLENGER: Then the contract is the decision, and the loose sentence is the hazard. A later editor who implements "blanks always match" would let a blank caller through while enforcement is on. The code does the stricter thing. The shared blank pool under the off flag is the documented sandbox, including the blank reviewer, and it is what the done-when asks to keep.

Round 3. PROPOSER: Agreed. Enforcement on: two blanks do not match; a present id does not match a blank; two equal UUIDs match. Enforcement off: two blanks match; a present id does not match a blank; two equal present values match. That is acceptable on both settings.

Round 3. CHALLENGER: Agreed. No change to the predicate.

Agreed outcome: plan OK.

## 2. Tenant normalisation (case, whitespace)

Round 1. PROPOSER: Both sides of `sameTenant` are lowercased, and the erase comparison is `lower(COALESCE(tenant, ''))`. A UUID that differs only by case matches on update and on erase. `tenantOf` already stores the Entra tid in lowercase. `TENANT_ID` is case-insensitive.

Round 1. CHALLENGER: Whitespace is a second rule, and the two doors do not share it. `sameTenant`, `invite`, and `invitations` do not trim. `journeyTenant` does. A header value `" uuid "` fails `TENANT_ID` inside `sameTenant`, so `updateInvitation` refuses it while enforcement is on, and the same header trims to a valid id before privacy delete, so the erase runs against the clean tenant. A row stored with padding matches neither a clean `sameTenant` compare nor the erase predicate.

Round 2. PROPOSER: Trimming cannot turn tenant A into tenant B. The production tid comes from `tenantOf`, whose regex has no whitespace. A padded header is outside the Entra path. Case folding is the normalisation the invitation rows actually need, because `invite` lowercases on write and both checks lowercase on read.

Round 2. CHALLENGER: The doors still disagree for a padded value, and that disagreement is enough to file. It does not let a second tenant's rows be updated or erased. Canonical UUIDs are handled. The follow-up is one trim-and-lower normaliser shared by `sameTenant`, `invite`, the list query, and `journeyTenant`, applied on write as well so a padded stored row cannot become an orphan.

Round 3. PROPOSER: Agreed. Case is handled. Whitespace trim is a follow-up, not a change to this merge.

Round 3. CHALLENGER: Agreed.

Agreed outcome: OK with a follow-up row. Case folding is consistent on update and erase. Whitespace is trimmed only on the privacy-delete tenant. Share one normaliser later. Canonical UUIDs are not a merge blocker.

## 3. Other invitation read and write paths without sameTenant

Round 1. PROPOSER: The hole was `updateInvitation` loading by id and skipping the tenant check whenever the flag was off. `invitations()` already filters `lower(COALESCE(tenant, ''))` to the caller's lowercased tenant, and it 403s first when enforcement is on and the tenant is not a UUID. `invite()` stamps the caller's tenant and rejects a body tenant that differs. Those paths do not need `sameTenant` to meet this done-when.

Round 1. CHALLENGER: Three writers still sit outside the new check. `outreach.js` `teamsActionBound` compares the user tenant to the invitation only when `tenantEnforced === true`; with the flag off it will `UPDATE` the invitation status after the outreach row matches. `scanStale` passes tenant `''` into `invite` whenever enforcement is off, even if the story matched a present user tenant, so the new predicate then refuses that present-tenant owner. `eraseMine` deletes `invitations.email` and does not scrub `source`, so `/api/me/erase` still leaves the subject's address on invitations they sent.

Round 2. PROPOSER: The done-when names `updateInvitation` and the privacy-delete transaction. The decision says `eraseMine` is not a second writer here. The Teams path still requires a bound outreach row, the recipient's object id, and the conversation; it is not the open library call test (a) failed. On the worker, `continuityScope` forces tenant `''` when enforcement is off, so the local-synthetic system user and the blank sandbox still match. Production refuses the off flag before `/api/`. Retention deletes by the tenant the sweep was given.

Round 2. CHALLENGER: Those limits are real, and they are why this is not a rewrite. They are also why the three paths have to be named. The Teams status write is the same bug class on a narrower door. The `scanStale` blank stamp plus the new check strands a present-tenant caller in tests and in any header-driven call that is not the worker's blank system user. `eraseMine` is the other erasure door, and the address in `source` survives it. Leaving them unnamed is how the next change misses them.

Round 3. PROPOSER: Agreed as follow-ups. This diff stays on the two doors the done-when names.

Round 3. CHALLENGER: Agreed. Not a must-change of the built predicate or the built erase.

Agreed outcome: OK with a follow-up row. List and `invite` are already scoped to the caller's tenant string. Follow-ups: Teams status update when enforcement is off; `scanStale` stamping a blank tenant whenever enforcement is off; `eraseMine` deleting received rows and leaving `source` intact.

## 4. Erase scope: sent vs received, pending vs accepted, audit and log copies, other tenants

Round 1. PROPOSER: Received means `email` is the subject (sign-in or verified mail), and those rows are deleted in the verified tenant at every status. Sent means `source` is the subject and `email` is someone else, and those rows stay with `source` replaced. A row that is both is deleted once, because the sent query excludes the subject's addresses. Other people, other tenants, and blank-tenant rows are outside `lower(COALESCE(tenant, '')) = ?` after `journeyTenant` has required a UUID. Audit history stays, and the note says so. Stories and staffing stay.

Round 1. CHALLENGER: `invite` writes an audit detail `` `${reason} for ${to}` ``, so the recipient address remains in the chain after the row is gone. The privacy-delete line stores `user.email` as the actor. There is no status predicate, and the tests only insert `open`, so done, dismissed, and scheduled are unshown. The kept sent row still has title, project, slot, and the other person's email. Outreach rows that point at the invitation are untouched.

Round 2. PROPOSER: The done-when says audit history is not deleted. The receipt sentence is the same contract. Rewriting the chain is the subject-rights tombstone path (`pseudonymiseAudit`, `isTombstoneActor`), and this plan does not open it. The SQL has no status filter, so open, scheduled, done, and dismissed received rows are deleted and sent rows are scrubbed. There is no stored status `accepted`. Keeping the sent row, including the recipient and the project, is option F: the other person's invitation remains, without the subject's address in `source`.

Round 2. CHALLENGER: Then the outcome has to say the audit copies remain on purpose. The concrete survivors are the `interview invitation` detail `for ${to}`, the actor on that line, and the actor on `privacy delete`. The receipt must not be read as "the address is gone from the library." Status coverage is a test gap (point 7), and the SQL already covers every status. Outreach can sit on the `eraseMine` follow-up. The row scope itself matches the done-when.

Round 3. PROPOSER: Agreed. Row scope stands. Audit and log copies are a named follow-up, not a change to this transaction.

Round 3. CHALLENGER: Agreed.

Agreed outcome: OK with a follow-up row. Received rows in the tenant are deleted at every status; sent rows whose recipient is someone else are scrubbed and kept; other subjects, other tenants, and blank-tenant rows are untouched. Follow-up: invitation audit details and the privacy-delete actor still carry the address, which this plan retains on purpose.

## 5. Whether the `erased:` token derives from the subject identifier

Round 1. PROPOSER: `eraseInvitations` calls `tokenOf({})`. Empty context fails the `erased:` + 12 hex check, so `erasureToken()` draws 6 bytes from `crypto.getRandomValues`. The subject email, mail, and oid are not inputs. The test's `ada` check is consistent with that.

Round 1. CHALLENGER: One token is reused for every sent row in the call, so a tenant admin can still group those invitations as one sender. The `ada` assertion would also pass for a hash that happens not to contain those three letters, and a random token can contain the substring `ada` (12 hex chars, on the order of 1 in 400). Derivation is the question that matters.

Round 2. PROPOSER: Grouping is the cohort `source` already was, with the address removed. The token is not a function of the identifier, so it is not reversible to the subject. The same one-token-per-erase shape is what `eraseMine` uses. A per-row token would be a different design and is not required by the done-when. The `ada` substring check is a weak test, not evidence that the token is derived.

Round 2. CHALLENGER: Derivation is absent. The shared token does not re-identify the subject from the identifier. The flake belongs with the test follow-up. Do not block the merge on a per-row token.

Round 3. PROPOSER: Agreed. The token does not derive from the subject.

Round 3. CHALLENGER: Agreed.

Agreed outcome: plan OK.

## 6. Transaction atomicity and receipt leakage

Round 1. PROPOSER: `eraseInvitations`, the outcomes array, and `lib.log` run inside `withTransaction`. That calls `recorded`, which holds one SQL `transactionSync`. The HTTP body is built only after that returns. A throw rolls the delete, the scrub, and the audit line back. The handler then returns an error and does not return `outcomes`. `memorySql` issues `ROLLBACK` before rethrowing. The body carries counts, not ids, addresses, the token, or another tenant.

Round 1. CHALLENGER: `removed` and `scrubbed` are the SELECT lengths, not `changes()`. `outcomeDetail` drops `scrubbed 0` from the audit text. The 500 text says nothing was removed, which is thin if the failed work was a scrub. There is no test that forces a throw after the first delete.

Round 2. PROPOSER: The same callback deletes and updates those ids with the tenant bound again. Nothing else in the callback rewrites invitation tenants, and the library write is single-threaded inside the transaction. The receipt object still has `scrubbed: 0` when the count is zero; the audit text omits it only when the count is zero, which is what the PR says. A rolled-back scrub is undone with the deletes. The missing throw-test is point 7, not a hole in the door.

Round 2. CHALLENGER: The mechanism holds. Counts are not returned unless the transaction returns. The receipt does not carry another person's address or the token. No change.

Round 3. PROPOSER: Agreed.

Round 3. CHALLENGER: Agreed.

Agreed outcome: plan OK.

## 7. Whether the tests prove the done-when, including the red commit

Round 1. PROPOSER: The red commit was run in this debate. Tree `3589a59dc6f457a8fc37e945a45bc4e2bc6255c6`. Product files unchanged against base. Result: 4 tests, 2 pass, 2 fail, exit 1. Test (a) failed with `Missing expected exception.` Test (c) failed with `2 !== 0`. Tests (b) and (d) passed. That is the PR's red claim, reproduced. On HEAD the same file asserts the cross-tenant 404 and an unchanged row, the same-tenant schedule with the flag off and on, both mail aliases deleted, both sent sources scrubbed, receipt counts 2 and 2, the note without the word invitations, the audit line `invitations 2 scrubbed 2`, and the other person, the other tenant, and the blank tenant left unchanged.

Round 1. CHALLENGER: Test (d) passes on the red commit because nothing is erased, so it does not prove the guard. Test (c) dies on the received count, so this run never shows the old note or the old `source`. The file never calls `updateInvitation` with two blanks, never refuses a present id against a blank, never uses a non-open status, and never throws inside the transaction. The blank-sandbox update is the clause that separates option C from option B. `invitation-tenant.test.js` locks list and create for a blank tenant. It does not lock this update.

Round 2. PROPOSER: The PR already says test (d) passes on the base because nothing is erased, and that it stays as a guard. Test (b) passing on the red commit is the regression lock: enforcement on was already a refusal. The blank match is `sameTenant` with the flag false, the same function `access` uses: two empty strings return true, and the flag true returns false because `TENANT_ID` fails. The executed red failures are the two bugs. The green assertions cover the done-when clauses the file names.

Round 2. CHALLENGER: A later edit that passes `true` as the third argument would still go green in this file, and the blank list test would still pass. That is a real gap against the done-when. It is a missing test, and the code at HEAD does the blank match. I will not call the product wrong. The follow-up tests are: two blanks can update when enforcement is off; a present id cannot update a blank row; a done or dismissed received row is deleted; a throw after the first invitation write rolls back and returns no counts. The `includes('ada')` check can flake and should not be the proof that the token is independent of the subject.

Round 3. PROPOSER: Agreed. The red tests prove the two bugs on `5e394849871719758b31b3586154d98cd3500864`. The green file proves the cross-tenant refusal, the UUID same-tenant update, the received delete, the sent scrub, the receipt, and the untouched rows. The blank-sandbox update and the rollback are follow-up tests.

Round 3. CHALLENGER: Agreed. Not a must-change of the built code.

Agreed outcome: OK with a follow-up row. Red result, run here: tests 4, pass 2, fail 2, exit 1; (a) `Missing expected exception.`; (c) `2 !== 0`; (b) and (d) passed. Follow-up tests: blank-blank update with enforcement off, present-versus-blank refusal, a non-open received row, and a rollback that must not return counts.

## Outcomes

1. Blank-tenant matching: plan OK. Enforcement on, blanks do not match. Enforcement off, two blanks match and a present id does not match a blank.
2. Tenant normalisation: OK with a follow-up row. Case is folded. Whitespace trim is not shared.
3. Other invitation paths: OK with a follow-up row. Teams when enforcement is off, `scanStale`'s blank stamp, and `eraseMine` leaving `source`.
4. Erase scope: OK with a follow-up row. Row scope matches the done-when. Audit and log copies of the address remain on purpose.
5. `erased:` token: plan OK. It does not derive from the subject identifier.
6. Transaction and receipt: plan OK. Writes and the audit line commit together; a throw does not return the counts.
7. Tests: OK with a follow-up row. The red tests fail on `5e394849871719758b31b3586154d98cd3500864` as claimed. They do not yet lock the blank-sandbox update or rollback.

No point is MUST CHANGE before merge.

CONSENSUS: AGREED
