# v8 decision log

Parent is the frozen v7 head `2299005396b172933e2eae0bb759abe0a1c9309d`. This round does not amend it. No constitution file exists at `.specify/memory/constitution.md`, and none was added. No specify CLI and no new dependency. No UI change. `statementTail` in `test/sqlite.js` stays. It is the test driver's mirror of the `sourceSQL` boundary.

Sentinel ACCEPT WITH RESIDUALS on `22990053` (F-A, F-B, F-C, F-D), Cursor bc-f37cd093 REQUEST CHANGES, Devin FAIL, and Inspector's trailing-semicolon finding are folded here. Inspector F-4 and F-5 are residuals, not code changes.

## Red

`5e51716782cc577b6ccf6689e5c57e216e078b0d` is tests only, parent `22990053`. `test/write-v8-door.test.js` is 13 tests, 0 pass, 13 fail. Each failure is an `AssertionError`. The product commit does not edit that file.

## Qualified names, OR, insert, and the belt

`recorded()` refuses a schema-qualified or quoted name, an `OR REPLACE` / `OR IGNORE` / `OR FAIL` / `OR ABORT` / `OR ROLLBACK` clause, and `INSERT` or `REPLACE` of `audit`, `audit_anchor`, `consent_receipts`, and `privacy_gate`. A plain `INSERT INTO consent_receipts` stays allowed. `CREATE TEMP` or `CREATE TEMPORARY` of a table or view with one of those names is refused. An index named `audit`, `audit_one_chain_start`, or `audit_…`, or an index `ON audit` or `ON audit_anchor`, is refused. `refs_owner_local` and `consent_receipts_subject` still install.

After a recorded mutation that is not a receipt, `anchoredVerdict(verifyChain)` runs again before commit. A throw or a verdict that is not ok is `CHAIN_DAMAGED`, and the transaction rolls back. A receipt-only transaction does not take that second check. `appendAudit` and `ensureChain` still use the raw handle.

Head mutation, restored and not committed. `recordedForbidden` returning false: `recorded refuses qualified, quoted, OR, insert, and index writes` was 0 pass, 1 fail, `AssertionError` `CHAIN_DAMAGED !== SQL_DOOR` (`/tmp/v8-mut-guard.txt`).

## writable_schema, ATTACH, DETACH

`PRAGMA writable_schema = ON` and the parenthesised form are refused in every door, before `statementTail`, because preparing that pragma runs it. A bare `PRAGMA writable_schema` still reads the flag. `ATTACH` and `DETACH` are refused in every door on both paths. `EXPLAIN QUERY PLAN` of those statements is refused the same way. `SELECT`, `PRAGMA user_version`, and a read of `sqlite_master` stay allowed.

Head mutation, restored and not committed. Removing those refusals: the matrix was 0 pass, 1 fail, `AssertionError` expected `0` actual `1` on `writable_schema` (`/tmp/v8-mut-pragma.txt`).

## One trailing semicolon

One semicolon whose remainder is only whitespace or comments is one statement, on both paths. `SELECT 1;`, `SELECT 1; -- tail`, and `EXPLAIN QUERY PLAN SELECT 1;` run. `SELECT 1;;` and `SELECT 1; DELETE FROM refs` are `SQL_MULTI`. `''` and `';'` still split to length 0. The three consent triggers still have internal semicolons and stay on the exact allowlist. A comment-only leftover is not a second prepare in the test driver. `statementTail` itself is unchanged.

`EXPLAIN QUERY PLAN` of one `DELETE` or `UPDATE` stays a plan read when a prepare boundary proves there is no tail, and it stays a refusal on the fallback path. That difference is not in the parity matrix.

Head mutation, restored and not committed. Treating every semicolon as a second statement: the matrix was 0 pass, 1 fail, `AssertionError` actual `ALLOW` expected `SQL_MULTI` (`/tmp/v8-mut-semi.txt`). Native still allows `SELECT 1;` because SQLite consumes that semicolon. The fallback then returns `SQL_MULTI`.

## Clock, some, Date.parse, find

The production clock is `Date.now` and `toISOString` captured at load. `Library` uses that clock when the caller does not pass `now`. A `toISOString` that returns `9999-01-01T00:00:00.000Z` does not stamp the audit line.

`auditReady` uses the captured `some`. A sqlite error still means the audit table is not ready. A throw or a result that is not `true` or `false` is `CHAIN_DAMAGED`. `some` returning false no longer lets a recorded delete commit on a damaged chain.

`consentCutoff`, `isoFrom`, and `finiteIso` use `Date.parse` captured at load. A selective parse of the clock stamp does not move the cutoff. The retention category is read with the captured `find`. A find that rewrites the drafts category into a negative consent window does not sweep a current receipt.

Head mutations, restored and not committed. Live `new Date().toISOString()`: 0 pass, 1 fail, `AssertionError` expected `false` actual `true` (`/tmp/v8-mut-clock.txt`). Live `some` with `catch { return false }`: 0 pass, 1 fail, expected `1` actual `0` (`/tmp/v8-mut-some.txt`). Live `Date.parse`: 0 pass, 1 fail, expected `1` actual `0` (`/tmp/v8-mut-parse.txt`). Live `find`: 0 pass, 1 fail, expected `1` actual `0` (`/tmp/v8-mut-find.txt`).

## Math.min, String, dotted begin, eval alias

`Math.min` and `String` are captured at load. The comment scanner, the splitter, and the tail checks use that `Math.min`. `lower`, `trim`, `replace`, `slice`, and `charCodeAt` coerce with the captured `String`. `sql-tail.js` does too.

A `begin` preceded by `.` does not open a trigger body. `WHEN NEW.begin BEGIN` stays one statement, and the following statement is the second. `BEGIN` inside a real trigger body still opens it.

The lint taints a binding whose initializer is `eval` or a member named `eval`, and a later assignment of the same shape. `const e = eval; e('1')` is a violation. The existing plants stay violations. `lintDir(src)` stays empty.

Head mutations, restored and not committed. The word scan calling live `Math.min`: the comment delete was 0 pass, 1 fail, `AssertionError` expected `1` actual `0` (`/tmp/v8-mut-min-scan.txt`). Calling live `Math.min` at every bound instead makes the split empty, so the same test stays green as `SQL_MULTI` (`/tmp/v8-mut-min.txt`). The word-scan result is the one that deletes the row. Live `String` in `mustText`: 0 pass, 1 fail, `AssertionError` expected `true` actual `undefined` (`/tmp/v8-mut-string.txt`). Removing the dotted-begin check: 0 pass, 1 fail, expected `2` actual `1` (`/tmp/v8-mut-begin.txt`). `isEvalCall` ignoring aliases: 0 pass, 1 fail, expected `true` actual `false` (`/tmp/v8-mut-eval.txt`).

## Inspector F-4 and F-5

F-4 is not a write-path defect. `scripts/check_handoff.py` checks an extracted release package against `MANIFEST.json`. That file is the received 12.1 manifest, date `2026-09-26`. On this git checkout the content check fails because listed files have changed since that package. The first detail is `changed: .env.example; changed: .gitignore; changed: 00_START_HERE.md` and twenty-two further `changed:` rows. `00_START_HERE.md` says to issue a new manifest when cutting a release package. This PR does not regenerate `MANIFEST.json`.

F-5 is not reproduced. No suite in this checkout reports 127 pass and 128 tests. The Inspector report is not in this checkout. `deploy/cloudflare-edge/test/journey-subject.test.js` is the journey coverage here. The failing case is not named, and it is not invented.

## Residuals that stay

A registered migration may still `DROP` a live table on the audited rebuild path. `'SELECT 1 AS begin; -- comment'` is still over-refused. `rewriteAudit` still accepts chain-start sequence 1. A damaged chain with no personal rows still returns no `auditRefused`. The profile rebuild on a damaged chain still leaves `merged_into` null, removes the finished invitation, and returns 409. The contact regex in `library.js` is outside the door and the audit path. `EXPLAIN QUERY PLAN` of one `DELETE` or `UPDATE` is allowed on the native path and refused on the fallback path. Inspector F-4 and F-5 stay as above. Sentinel F-5 and F-6 from the earlier note stay unnamed because that report is not in this checkout. `Date.parse` of the clock is no longer a residual.
