# Invitation tenant check and privacy-erase receipt

Rows: ATLAS-INVITE-TENANT-UNENFORCED, ATLAS-ERASE-LEAVES-INVITATIONS.
Base: `main` `c14302590e78b0319baab5893ef8c378b1c0bdf1` (verified: `git rev-parse HEAD` on `main` matched that SHA before this branch).
Risk: **HIGH**. This is a tenant write and a privacy erase. No deploy, no new infrastructure, no secrets, no Cloudflare change.

## Done when

- With tenant enforcement off, `Library.updateInvitation` refuses a caller whose tenant differs from the invitation row. The row is unchanged. The refusal is 404 `Invitation not found.` A caller in the same tenant can still update that row when enforcement is off, including the blank-tenant local sandbox where both sides are blank.
- With tenant enforcement on, a caller from another tenant is still refused the same way, and a same-tenant update still succeeds.
- `POST /api/library/privacy/delete` for subject S in tenant T deletes invitations in T whose `email` is S (received, including the sign-in mail alias) and replaces `source` with an `erased:` token on invitations in T that S sent to someone else. The receipt's `outcomes` entry for `invitations` reports those two counts, and the note no longer says invitations are not deleted.
- The same request leaves other subjects' invitations, S's invitations in another tenant, and S's blank-tenant invitations unchanged.
- The invitation delete and the source scrub run inside the existing privacy-delete transaction, which is the recorded write door, and the existing `privacy delete` audit line includes the counts.
- Stories, staffing rows, and audit history are still not deleted.

## Tests

File: `deploy/cloudflare-edge/test/invitation-tenant-erase.test.js`.
Harness: `test/sqlite.js` `memorySql` (the existing Durable Object SQL stand-in). Workerd 2026-10-23 was not installed in this environment when the tests were written (`locateWorkerd()` is null). The full edge suite is still run with the binary when it is present, and again with `ATLAS_WORKERD_ROOT` pointed at a missing directory.

| Test name | What fails on this base |
|---|---|
| `with enforcement off, a caller from tenant B cannot update tenant A's invitation` | Cross-tenant `updateInvitation` succeeds and changes the row. |
| `with enforcement on, a caller from tenant B cannot update tenant A's invitation` | Regression. Already refused. |
| `a privacy erase removes or scrubs the subject's sent and received invitations and the receipt counts them` | Received rows stay, sent `source` still names S, and the note says invitations are not deleted. There is no invitations count. |
| `a privacy erase leaves other subjects' invitations untouched` | Regression. Nothing is erased, so other rows are unchanged. It stays a guard against deleting the wrong rows. |

Sent and received, as the invitation row is stored by `invite`:

- Received: `invitations.email` is the subject. `invite` writes the consultant address into `email`.
- Sent: `invitations.source` is the subject and `email` is someone else. `invite` writes `body.source` or the actor into `source`.

The privacy delete already treats the subject as the sign-in `email` and the verified `mail` (`subjectAliases` in `operate.js`). Both aliases count. Comparison is lowercase. The tenant predicate is `lower(trim(COALESCE(tenant, ''))) = ?` for the verified tenant only. `journeyTenant` already trims the caller. A stored tenant with a trailing space is the same tenant.

TEST COMMAND (this file):

```sh
cd deploy/cloudflare-edge && node --test test/invitation-tenant-erase.test.js
```

TEST COMMAND (edge suite, stub path, workerd probes skip):

```sh
cd deploy/cloudflare-edge && ATLAS_WORKERD_ROOT=/no/such/atlas-workerd node --test test/*.test.js
```

TEST COMMAND (edge suite, workerd 2026-10-23 on the default root when the binary is installed):

```sh
cd deploy/cloudflare-edge && env -u ATLAS_WORKERD_ROOT -u ATLAS_WORKERD_BIN node --test test/*.test.js
```

## Plan debate

Option A. Keep the tenant compare only when `user.tenantEnforced === true`.
Trade-off: matches the old line and leaves local-synthetic unrestricted. A caller who carries tenant B can dismiss or complete tenant A's invitation whenever the deployment is not enforcing. That is the bug. Rejected.

Option B. Always require `sameTenant(inv.tenant, user.tenant, true)`, including when enforcement is off.
Trade-off: both sides must be the same UUID. A local-synthetic sandbox whose invitation and caller are both blank can no longer update its own invitation, because a blank value fails `TENANT_ID`. Rejected.

Option C, chosen. Always call `sameTenant(inv.tenant, user.tenant, user.tenantEnforced === true)` before the recorded update. This is the predicate `access` already uses.
Trade-off: when enforcement is on, the check is the one that already exists (UUID equality). When enforcement is off, two present tenants must be equal, a present id does not match a missing id, and two blanks still match. That last case is the local-synthetic sandbox described on `sameTenant`. A stored invitation that already has a tenant is no longer writable from another tenant, even in dev. Same-tenant dev updates keep working. No new write function. The update still goes through `this.recorded`.

Option D. On erase, only add a sentence to the receipt.
Trade-off: the disclosure stays true and the subject's address stays in `invitations`. Rejected. The row is the bug.

Option E. Delete every invitation whose `email` or `source` is the subject.
Trade-off: a invitation S sent to someone else disappears for that other person. Rejected.

Option F, chosen. Inside the existing privacy-delete `withTransaction` (the recorded door, same `lib.exec` and `lib.log` as the other stores): delete received rows in this tenant, and set `source` to an `erased:` token on sent rows whose recipient is someone else. `outcomes` reports `removed` and `scrubbed`. Drop `invitations` from the sentence that lists what is not deleted. Stories, staffing, and audit history stay in that sentence.
Trade-off: a sent invitation remains for the recipient, without S's address in `source`. The receipt has to say scrubbed as well as removed, or the count would call a scrub a delete. Subject-rights `eraseMine` does not cover that route. Before fix round 1 it deleted `invitations` only where `email` was the sign-in identity, and it did not scrub `source`. Both routes now call one helper.

## Effect on stored invitations and on the receipt

No migration. Rows stay until a privacy delete for that subject and tenant runs. After this change, that delete removes received rows and scrubs `source` on sent rows in that tenant only. Other tenants, other people, and blank-tenant rows are not written.

The cross-tenant refusal applies to rows already stored. A same-tenant update still succeeds. A blank invitation and a blank caller in local-synthetic still match.

Receipt wording, after the behavior is fixed:

`Stories, staffing, and audit history are not deleted.`

The invitations clause is removed from that sentence because it would be false. `outcomes` gains `{ store: 'invitations', removed, scrubbed, error: null }`. `coveredLocal` names those invitation rows. The directory-and-audit retained note no longer says the response reports no other row.

## Rollback

Revert this branch's commits. The parent is `main` `c14302590e78b0319baab5893ef8c378b1c0bdf1`. No schema change to undo. Reverting the code does not restore invitations a delete already removed or scrubbed. Those rows stay as the delete left them.

## Fix round 1

Review of `63779db38484471abeb95f56b767e7265e3f8736` requested changes. `Library.invite` stores `str(actor, 60)`. An Entra `tid:oid` is 73 characters, and a long email can be 68. The stored prefix matched neither full alias, so `POST /api/library/privacy/delete` left `source` in place and reported `scrubbed: 0`. `POST /api/me/erase` forwards to `eraseMine` / `eraseWithin`, which deleted `invitations.email` for the sign-in identity only and did not scrub `source`. The sentence above that said `eraseMine` already covered `invitations.email` was wrong for that reason.

The plan debate in this record was written with the first change. A separate post-build debate, `handoff/decisions/pr12-plan-debate.md`, was run after `63779db38484471abeb95f56b767e7265e3f8736`. Its consensus is AGREED. It did not catch the 60-character truncation. Fix round 1 addresses that finding. The debate is not a pre-build approval of this round.

`eraseSubjectInvitations` in `operate.js` is the only invitation erase. `eraseInvitations` and `eraseWithin` both call it.

- A received row in this tenant is deleted when `lower(email)` is either subject address (the sign-in identity and the verified mail).
- A sent row is scrubbed when `lower(source)` is an alias or `str(alias, 60).toLowerCase()`, and `lower(email)` is not a subject address. A row whose recipient is also the subject is deleted, not scrubbed.
- The tenant compare is `lower(trim(COALESCE(tenant, '')))`.
- Each sent row gets a fresh `tokenOf({})`.
- `removed` and `scrubbed` are `changes()` after the write, not the length of an earlier select.
- `outcomeDetail` writes `scrubbed N` on the invitations outcome, including 0.

No new table and no second writer. Stories, staffing, and audit history stay. Other tenants, other people, and a blank tenant stay.
