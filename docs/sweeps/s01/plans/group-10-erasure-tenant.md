# Group 10 — erasure / tenant

Plan only. Debate this before anyone edits product code.

Pinned inputs: confirmer report sha256 `57c92dcb651ddef4b7abe9c23424065a2a59fa139d2cdfc6315ce227596eac1c`, main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`, red tests `96712474b59d6b058ef00479f2bb2d4eb065801e` (PR #31).

Findings: B1, B2, B3, B5.

## Done when

1. All five tests in `deploy/cloudflare-edge/test/sweep01-b-security.test.js` pass (B1, B2, both B3, B5).
2. `node --test --test-name-pattern "staffing and teams rows" deploy/cloudflare-edge/test/s1-review.test.js` still passes. That control deletes a Teams row whose `tenant_id` was seeded with the ATLAS tenant. The new delete still removes it.
3. After `eraseMine`, the erased address is not in `state.sharedWith`, not in live story JSON, and not in any revision of a story in that tenant. `lib.get` as that person throws 404 for the surviving story.
4. A Teams row whose `tenant_id` is a directory GUID other than the ATLAS tenant is removed when its email is the subject and its ATLAS-tenant column is blank or equal to this tenant. A row stamped with a different ATLAS tenant is kept.
5. A staffing import of `=sum(1)@example.com` does not come back from the staffing page as a live cell. No test is skipped or expected-failure.

## Files this group may edit

- `deploy/cloudflare-edge/src/subject-rights.js`
- `deploy/cloudflare-edge/src/outreach.js`
- `deploy/cloudflare-edge/src/teams-routes.js` is owned so no other group "fixes" B2 by comparing the Teams directory GUID to the ATLAS tenant. No functional edit is expected there. The ingress already refuses a missing `ATLAS_SYSTEM_TENANT` and forwards that tenant on `x-atlas-tenant`. The directory id and the ATLAS tenant stay different namespaces (`teams-routes.js` comments at the install forward).

Do not edit `library.js`, `library-routes.js`, `util.js`, `csvsafe.js`, `operate.js`, or `privacy.js`. `email()` must stay as it is. Group 5 owns the address cap. Rejecting a formula-shaped address inside `email()` would move B5 into group 5, which the confirmer forbade.

New tests, if the property loops do not fit in the PR #31 file: `deploy/cloudflare-edge/test/sweep01-g10-erasure-props.test.js`. Do not edit `test/sqlite.js` (PR #27).

## Failing tests from PR #31

File: `deploy/cloudflare-edge/test/sweep01-b-security.test.js`

| Test | Finding |
|---|---|
| `B1 erasing a merged contributor removes their access to the surviving story` | B1 |
| `B2 erasing a person removes their Teams conversation even when the directory tenant differs` | B2 |
| `B3 erasure removes an address from story text, contacts, and team notes` | B3 |
| `B3 erasure removes an address that appears only inside a sentence` | B3 |
| `B5 a staffing address that starts like a spreadsheet formula is not returned live` | B5 |

TEST COMMAND:

```sh
node --test deploy/cloudflare-edge/test/sweep01-b-security.test.js
node --test --test-name-pattern "staffing and teams rows" deploy/cloudflare-edge/test/s1-review.test.js
```

B4 is group 11. It is not in this file.

## Threat model

The attacker is a signed-in person in one verified tenant, or the data left after they call erase. They cannot forge `x-atlas-role`. The Worker overwrites the forwarded identity.

Before, B1: a reviewer merge copies the retired owner's address into `state.sharedWith` and `members` (`library.js` merge). Erasure strips `members` and rewrites consultants, and it writes `state` back without removing `sharedWith`. `Library.access` grants `full` when `sharedWith` contains the caller, which includes client name, location, contact, and the draft. After erase, Ada still `get`s Kim's in-review story. Same tenant. The story was not published.

Before, B2: `teams_conversations.tenant_id` is the Teams directory GUID. Erasure deletes that table with `tenant_id` compared to the ATLAS tenant, so a real install is left in place: email, Entra object id, conversation id, service URL, status `active`. `sendTeams` loads active rows by email with no ATLAS-tenant predicate. Teams send is `BLOCKED_EXTERNAL` until `TEAMS_*` is set, so this run does not deliver a message. The retained routing row is the defect. Any later tenant whose reviewer approves outreach to that email can select it.

Before, B3: the other-people walk selects `instr(data, '"'+email+'"')` and `instr(state, '"'+email+'"')`. An address inside a sentence is not a JSON string token, so the row is not selected. When the row is selected, the scrub rewrites `details.consultants[]` and `validation.manager` only. Answers, sheet contacts, and sheet team text keep the address, in the live row and in revisions.

Before, B5: the staffing import runs `neutralizeFormula` on project id, title, and manager name. The consultant address goes through `email()`, which accepts `=sum(1)@example.com`. The page returns it. A spreadsheet that opens the export executes the formula. The cell is also a stored identity key for staffing and manager trust.

After: erase removes the address from `sharedWith`, and `get` is 404. The Teams row for that email is gone when it is unstamped or stamped with this ATLAS tenant, even if `tenant_id` is a different directory. Story text, contacts, team notes, and revisions in this tenant no longer contain the address as a whole address. A formula-shaped staffing address is rejected at import and is not on the page. Another tenant's stamped Teams row and another tenant's stories stay.

## Chosen design

B1 and B3, in `eraseWithin`, same tenant only.

Select other people's `refs` when any of these is true: `members` contains the address as a comma-token (already), `manager_email` or `updated_by` equals it (already), `mentions(data, email)`, `mentions(state, email)`, or any `revisions.data` for that id `mentions` it. `mentions` is the existing whole-address check. Do not keep the quoted-token `instr` as the only selector.

On each selected row, walk every string in the parsed `data` and `state`, including answers, sheet exec contacts, sheet team, and `sharedWith`. Replace whole addresses via the existing `replaceAddress`. Filter `sharedWith` by equality as well, so a non-string element cannot survive. Then do the consultant and manager rewrites already there. Write revisions with the same walk. Leave `content_hash` alone. Do not touch a `refs` row whose tenant does not match.

B2. Add `atlas_tenant TEXT` on `teams_conversations` in the `outreach.js` ensure/migrate path (`ALTER TABLE` when the column is missing). The install `INSERT` writes `user.tenant` from the forwarded library user (the header `teams-routes.js` already sets). Do not copy `tenant_id` into that column.

Delete in `SUBJECT_TABLES` by email (every subject alias), not by `tenant_id = ATLAS tenant`:

```text
lower(email) = ? AND (atlas_tenant IS NULL OR lower(atlas_tenant) = ?)
```

A row with `atlas_tenant` set to another tenant is kept. Blank `atlas_tenant` is deleted for this email. The primary key is `subject` (`directoryTid:oid`), one row globally, so a blank row cannot be attributed after the fact.

`sendTeams` keeps treating `tenant_id` as the directory id. It skips a row whose `atlas_tenant` is a non-empty value other than the outreach tenant. A blank `atlas_tenant` stays eligible, so an install from before the column still routes. Several directories still refuse, as today.

B5. In `importCsv`, before `email()`, if the raw consultant cell or the raw manager cell matches `/^[=+\-@\t\r]/` (the same class `csvsafe.js` already uses; do not edit that file), push the row onto `rejected` and do not insert. The red test allows either an empty page with `rejected.length >= 1`, or a page whose cells fail that class. Rejection is the one that does not store the formula. Project id, title, and manager name stay on `neutralizeFormula`.

On `ensure`, delete staffing rows in every tenant whose `consultant_email` or `manager_email` matches that class, and delete `manager_trust` rows whose `email` or `owner` is that same string and whose `source` is `staffing`. Do this inside the existing schema migration, once, in a transaction.

## Alternatives rejected

1. B1: change `Library.access` so `sharedWith` is not a grant. Rejected because `library.js` belongs to group 3, and merge would still store the address. The privacy defect is the erase path leaving a grant it knows how to name.
2. B2: delete every Teams row with that email and ignore `atlas_tenant` even when it is stamped. Rejected because two ATLAS tenants would then erase each other's routing row. The column is what makes the namespaces separable.
3. B2: compare `tenant_id` to the ATLAS tenant and also to "any GUID". Rejected because that is the current bug. The directory GUID is not the ATLAS tenant, and the ingress comment says they are not compared.
4. B5: teach `util.email` to return `''` for a leading formula character. Rejected because group 5 owns `util.js` and was told not to absorb B5. A leading `+` is also a legal, if rare, mailbox form; the rejection belongs on the spreadsheet import, which is the injection surface, not on every address in the product.

## Invariants and properties

`deploy/cloudflare-edge/test/sweep01-g10-erasure-props.test.js`. `node:test`. No skip, no expected failure.

- B1: for a `sharedWith` list that mixes the subject, another person, and the subject with different case, erase leaves the other person and removes every case of the subject. `get` as the subject is 404. `get` as the owner still works.
- B2: a row with `atlas_tenant` equal to tenant B survives erase in tenant A. A row with `atlas_tenant` null and a directory `tenant_id` unequal to A does not survive. A row whose email merely contains the subject as a substring (`ada@example.test` vs `ada@example.test.au`) survives. The s1 control (directory id seeded with the ATLAS id, null `atlas_tenant`) is deleted.
- B3: the address inside a sentence, inside `sheet.exec.contacts`, inside `sheet.sections.team`, and inside a revision is gone. A longer address that contains it is unchanged. Another tenant's copy of the same sentence is unchanged.
- B5: each leading character in `=`, `+`, `-`, `@`, tab, and CR on `consultant_email` rejects the row. `sam@example.test` still imports. A value that only contains `=` after the first character imports.

Boundaries: erase of a person who is not on any story and has no Teams row still returns `erased: true` and does not throw. Empty `sharedWith`. Revision JSON that is not an object is left as-is rather than dropped.

## Data migration

Teams: `ALTER TABLE` adds a nullable `atlas_tenant`. Existing rows stay null. They are removed the next time that email is erased in any tenant, which is the behavior the B2 test requires for unstamped rows. There is no source of truth to backfill the ATLAS tenant onto old rows. Do not copy `tenant_id` into `atlas_tenant`.

Stories already erased: `erasure_log` stores a subject hash, not the address. This code cannot find "the sentences Ada left behind" without Ada's address. The next `eraseMine` by that same signed-in subject runs the new walk and cleans leftovers, including `sharedWith`. People who cannot sign in again keep whatever the old walk left, until an operator, with the address in hand, runs a later job. This plan does not add that job.

Staffing: the `ensure` delete above is the backfill for formula-shaped rows already stored. It runs inside the Library open path, once per process, against SQLite.

## Rollback

Revert the commit. New installs stop writing `atlas_tenant`. A column left in place is ignored by the old `INSERT` only if the old statement lists columns, which it does, so the extra column is harmless on rollback. Rows deleted by the formula backfill are not restored. Take that as accepted: a formula address is not a consultant.

## Open PRs #15–#30

No overlap with #15–#30's files. Group 3 owns `library.js`, including `merge`, which writes `sharedWith`. The B1 test asserts that the address is on `sharedWith` before erase. Group 3's findings (M3, F1, F5, F6, F7, HAM-02) do not require removing that write. If group 3's M3 edit touches the merge block, they must leave the `sharedWith` assignment so this test's setup assertion still holds. This group must not edit `library.js` to "help".

PR #27 edits `test/sqlite.js` and `sql-tail.js`. Do not.

## Owner lockout

Erasure of the owner's account is what they asked for. The risk is erasing someone else.

- Stamped Teams rows of another tenant survive.
- Unstamped Teams rows are global. The first tenant to erase that email removes the routing row. If the same mailbox exists in two ATLAS tenants, the other tenant loses Teams routing. That is the open question below.
- The formula backfill deletes staffing rows and staffing-sourced manager trust for addresses that start with `=`, `+`, `-`, `@`, tab, or CR. A real mailbox that starts with `+` would lose that staffing row. The import will also reject it from now on.

A failed migration must not run a partial erase. `eraseMine` already refuses when `transactionSync` is missing. Keep the new deletes inside that transaction.

## Diff size

About 220 lines of product code, plus about 160 lines of property tests. `teams-routes.js` should be a zero-line behavior change.

## Open questions for the owner

1. Are consultant emails unique across ATLAS tenants? If they are, deleting a null-`atlas_tenant` Teams row on erase is the right global cleanup. If the same mailbox can be a guest in two tenants, the first erase removes the other tenant's unstamped route, and the owner has to say so before this lands.
2. `erasure_log` stores a subject hash, not the address. Leftovers from an erase that already ran stay until that same subject calls erase again. People who cannot sign in again are not cleaned. This plan does not add an operator sweep. Confirm that waiting is acceptable.
