# v7 decision log

Parent of this round is the local residual head `ecd6137eed3a1e79e7c5c0873704c5bfd5241112`, which already had the unpushed F-1, F-2, F-3, F-4, and F-7 fixes. The reviewed head is `f81212806df269e1f6e1461dfd872499e2744536`. No constitution file exists at `.specify/memory/constitution.md`, and none was added. No specify CLI and no new dependency. No UI change.

Cursor bc-130a631f on `f8121280` is REQUEST CHANGES. Devin's exact-head check of `f8121280` is FAIL. Both are folded here. The inspector report was not in this checkout.

## Corrections

`splitStatements('')` and `splitStatements(';')` return length 0. `exec` still refuses them because the length is not 1. They are not one statement.

The `Library` constructor argument is the clock function (`now`). The consent cutoff is that clock minus the 2190-day policy. The constructor argument is not the cutoff.

## Fallback reads

On the path with no `statementTail` and no `node:sqlite`, a string runs only when it is one statement. A semicolon outside a quote, a comment, or a bracket is a second statement, unless the text is one of the three consent triggers. That check does not look at the word `begin`.

`EXPLAIN` and `EXPLAIN QUERY PLAN` are reads only when the explained statement is itself a read. `CREATE TRIGGER`, `DROP`, `DELETE`, and the other DDL and DML verbs are not reads on that path, so the driver is not called. When a prepare boundary proves there is no tail, `EXPLAIN QUERY PLAN` of one delete or update stays a plan read. The journey plan test still uses that path.

On `f8121280` the fallback matrix sent `EXPLAIN QUERY PLAN CREATE TRIGGER t BEFORE INSERT ON refs BEGIN SELECT 1 AS begin; END; DELETE FROM audit` to the driver (`AssertionError`, sent count 65, expected 64). After this fix the same matrix, including every alias body, `WHEN begin`, `EXPLAIN`, `EXPLAIN QUERY PLAN`, `DELETE`, and `DROP`, does not call the driver. The workerd proof does not send those strings either.

Head mutation, restored and not committed. Treating every fallback statement as a non-write: `fallback refuses explain of ddl or dml` was 0 pass, 1 fail, `AssertionError` `69 !== 68` (`/tmp/v7-mut-fallback.txt`).

## Slice, push, and charCodeAt

`slice`, `push`, and `charCodeAt` are captured with the same uncurry as the other primordials. A slice that is not the requested span, or a push that does not store the value, is not a read. `sql-tail.js` uses that slice and returns null when the span is wrong.

A slice returning `false`, `true`, `0`, or `-1`, with `statementTail` still reporting the real tail, refuses `DELETE FROM refs`. A push that keeps only the last value refuses the same delete. `charCodeAt` returning `0` refuses it. A push that drops the second part refuses `SELECT 1; DELETE FROM refs` on the fallback path. The sweep poisons `toLowerCase`, `trim`, `some`, `includes`, `every`, `exec`, `test`, `hasOwn`, `keys`, and `Reflect.apply` and still refuses.

## Cutoff, recorded door, tombstone

The consent cutoff is `Date.prototype.toISOString` captured at load. A result that is not a finite ISO string of that same millisecond is refused. A later patch that returns `9999-01-01T00:00:00.000Z` does not sweep a receipt stamped at the clock. `Date.parse` of the clock string is still the live function. That is a residual.

`recorded()` refuses `DROP TRIGGER`, `DROP` or `ALTER` of `audit`, `audit_anchor`, and `consent_receipts`, and `DELETE` or `UPDATE` of those tables. The housekeeping consent sweep still deletes an old receipt. Registered migrations still drop and rename the rebuild tables. `rewriteRows` writes through the raw handle, and it only updates a row when the actor is a tombstone.

A tombstone is `erased:` plus twelve lowercase hex digits, checked by code points. `null` or any other result is a refusal in `rewriteAudit` and `rewriteRows`. A `RegExp.prototype.test` that returns true for that shape does not rewrite `not-a-tombstone`. Audit error text is matched the same way, with no `RegExp.prototype.test`.

## Exec and lint

`primordials.test` calls the `exec` captured at load. It does not call `RegExp.prototype.test`, which looks `exec` up on the live prototype. On `f8121280`, after `exec` returned null, that test was `false` (`AssertionError` `false !== true`). A direct, schema, and housekeeping `DELETE FROM refs` stay refused. Classification in `sql-text.js` still has no regex.

Head mutation, restored and not committed. `test` calling the captured `RegExp.prototype.test` again: `a patched exec does not change the captured test` was 0 pass, 1 fail, `AssertionError` `null !== true` (`/tmp/v7-mut-exec.txt`).

The lint flags `Reflect.apply(_sql.exec, _sql, ...)`, `(0, eval)(...)`, `globalThis.eval(...)`, `proto = WeakMap.prototype`, and `function leak({exec} = rawSql(this))`.

## Left as they are

A registered migration may still `DROP` a live table. Those drops are the audited rebuild path. `'SELECT 1 AS begin; -- comment'` is still over-refused. `rewriteAudit` still accepts chain-start sequence 1. A damaged chain with no personal rows still returns no `auditRefused`. A profile rebuild on a damaged chain still leaves `merged_into` null, removes the finished invitation, and returns 409.

F-5 and F-6 from the Sentinel note are still unnamed here. The report file is not in this checkout. `library.js` still uses a contact regex outside the door and the audit path.

The one opt-in check is `regeneration from the pinned sources is byte-identical to the committed asset`. It stays out of CI.
