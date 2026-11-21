# SQL text aliases and explain plans

High. It gates writes. `SELECT 1 VACUUM` and `SELECT 1 REINDEX` are column aliases. `EXPLAIN QUERY PLAN` of one write was not walked.

Base: `main` `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`. Branch: `cursor/atlas-sqltext-lows`.

Reviewer evidence: `/cursor/stores/bot/atlas-pr17/v15-delta-review-5c6430d6.md`. The module is `deploy/cloudflare-edge/src/sql-text.js`. There is no second copy.

## Verdict

`SELECT 1 VACUUM` and `SELECT 1 REINDEX` are reads. A real `VACUUM` or `REINDEX` statement stays a write. `EXPLAIN` of a write stays a mutation. `EXPLAIN QUERY PLAN` of one write verb stays a plan on the primary door and is not a proven read, so the fallback door still refuses it. A second verb, a nested write, or `VACUUM` / `REINDEX` outside alias position is a write on both doors.

Security first. A string SQLite runs as a write stays a write. A string whose shape is not an alias stays a write.

## What was measured

`node:sqlite` on this host, one fresh memory database and one `refs` row per probe.

- `SELECT 1 VACUUM` and `SELECT 1 REINDEX` each return one row. The column name is that word. The row count stays 1. `SELECT 1 AS VACUUM` is the same shape. `SELECT 1 FROM refs VACUUM` is a table alias. `SELECT 1 VACUUM FROM refs` is a column alias. Case and a comment in either place do not change that.
- `VACUUM`, `VACUUM main`, `REINDEX`, and `REINDEX refs` are statements. `WITH x AS (SELECT 1) VACUUM` is a syntax error and does not vacuum. `SELECT (VACUUM)` does not vacuum.
- `EXPLAIN DELETE FROM refs` returns bytecode and does not delete. `EXPLAIN QUERY PLAN DELETE FROM refs` returns plan columns and does not delete. The same holds for `INSERT`, `UPDATE`, `VACUUM`, and `REINDEX`.
- `EXPLAIN QUERY PLAN PRAGMA writable_schema = ON` leaves `writable_schema` at 1. A plan prefix does not make that assignment safe.
- `EXPLAIN QUERY PLAN SELECT 1 DELETE FROM refs` is a syntax error. Before this change the classifier called it a proven read, and both doors reached SQLite (`ERR_SQLITE_ERROR`).

## Alias

`trailingVerb` treated every depth-0 `vacuum` and `reindex` after a read as a second statement. `SELECT 1 AS VACUUM` was already a read, because `AS` blocks the verb. The bare alias was the inconsistent case. `write-v14-gap.test.js` lines 25-30 locked that false positive: `provenRead` false and `SQL_DOOR` on both doors.

Those two strings are no longer in that list. The same test now refuses `VACUUM`, `VACUUM main`, `REINDEX`, and `REINDEX refs`, plus the original `SELECT 1 DETACH other` and `SELECT 1 PRAGMA user_version`. That is the fail-closed assertion for the real statements. Removing `vacuum` and `reindex` from `VERBS` makes the primary door allow `VACUUM` and `REINDEX`. The gap test and the new table both go red.

A depth-0 `vacuum` or `reindex` is an alias only when the statement verb is `SELECT` or `VALUES` and the next token is absent, `;`, or a clause word: `FROM`, `WHERE`, `GROUP`, `HAVING`, `ORDER`, `LIMIT`, `OFFSET`, `UNION`, `EXCEPT`, `INTERSECT`. Those words are not a schema or table argument. Quoted `"VACUUM"`, `[REINDEX]`, and `` `VACUUM` `` were already not verbs.

These stay writes:

- `VACUUM`, `VACUUM main`, `REINDEX`, `REINDEX refs`
- `SELECT 1 VACUUM main`, `SELECT 1 REINDEX refs`
- `SELECT 1 VACUUM, 2` — a comma is not a token, so the next result column is not distinguished from an argument
- `SELECT (VACUUM)`, `SELECT (REINDEX)`, `WITH x AS (SELECT 1) VACUUM`

## Explain

`strayWrite` returned before reading the tokens when the text was `EXPLAIN QUERY PLAN`. The primary door allows a statement that is not a mutation and not a hidden write. That is why a one-verb plan was allowed, and why a second verb inside the plan was still a proven read.

The walk now runs. The one verb `topVerb` would return is the statement being described. SQLite returns a plan and does not run that verb, so that verb alone is not a mutation and not a proven read. The primary door allows it. The fallback door still refuses it, because a shut door has no prepare boundary. `EXPLAIN QUERY PLAN DELETE FROM refs` and the same shape for `INSERT`, `UPDATE`, `VACUUM`, and `REINDEX` stay on that split. The journey plan test calls `EXPLAIN QUERY PLAN` of `DELETE` and `UPDATE` on the primary door. This decision does not change that result.

Setting the explained index to `-1` makes `EXPLAIN QUERY PLAN DELETE FROM refs` a mutation. The table goes red. The primary door would refuse the journey plans.

A later verb, a nested write, or a trailing verb outside alias position is a write on both doors. That includes `EXPLAIN QUERY PLAN SELECT 1 DELETE FROM refs`, `DROP`, `INSERT`, `UPDATE`, `EXPLAIN QUERY PLAN DELETE FROM refs VACUUM`, `EXPLAIN QUERY PLAN SELECT (DELETE FROM refs)`, and `EXPLAIN QUERY PLAN WITH x AS (DELETE FROM refs RETURNING id) SELECT 1`. Restoring the early return makes the `SELECT 1 DELETE` form a proven read again. The table goes red.

`EXPLAIN` without `QUERY PLAN` of a write stays a mutation. That is the existing fail-closed rule. This change does not widen it.

A leading comment is not the bare plan. `/* x */ EXPLAIN QUERY PLAN DELETE FROM refs` stays a write. A comment between the words does not change the one-verb plan.

`EXPLAIN QUERY PLAN PRAGMA table_info(refs)` stays a proven read. The explained `PRAGMA` is that statement. `EXPLAIN QUERY PLAN PRAGMA writable_schema = ON` stays a write through `writableAssignment`.

## Red

`73edbf5d8f494e1e1a0a3310eb232058ca8fcec1` is tests only. `sql-text.js` matches the base.

`node --test test/write-sqltext-alias-explain.test.js test/write-v14-gap.test.js`: 5 tests, 4 pass, 1 fail, exit 1. The failure is `alias and explain table`. Alias rows are `read false !== true` and `SQL_DOOR !== ALLOW` on both doors. `EXPLAIN QUERY PLAN SELECT 1 DELETE FROM refs` is `read true !== false`, and both doors return `ERR_SQLITE_ERROR`. The gap test passes: real `VACUUM` and `REINDEX` were already writes.

## Fix

`9c72ebeca5e6e0ac4011f1cbe56a1cd8d4a39a6b` is `deploy/cloudflare-edge/src/sql-text.js` only. It does not edit the tests.

`readAlias` exempts alias position from `trailingVerb`. `strayWrite` walks a bare `EXPLAIN QUERY PLAN` and skips only the explained verb, or the explained `PRAGMA` when there is no statement verb. `hiddenWrite` for that prefix returns the same `strayWrite` result. `topVerb` reads `topVerbAt`.

No `python3 build.py`. `build.py` does not embed this file. `library.js` is not edited.

## Mutants

Each change was restored and was not committed. The command was the red command above. On the fix it is 5 tests, 5 pass, exit 0.

- The `readAlias` exemption removed: exit 1, 4 pass, 1 fail. `SELECT 1 VACUUM` is `read false !== true`. Real `VACUUM` stays a write.
- `vacuum` and `reindex` removed from `VERBS`: exit 1, 3 pass, 2 fail. `VACUUM` is `mut false !== true`. The gap test fails with it. `EXPLAIN QUERY PLAN VACUUM` also becomes a mutation.
- The early `EXPLAIN QUERY PLAN` return restored in `strayWrite`: exit 1, 4 pass, 1 fail. `EXPLAIN QUERY PLAN SELECT 1 DELETE FROM refs` is `read true !== false`.
- The explained index forced to `-1`: exit 1, 4 pass, 1 fail. `EXPLAIN QUERY PLAN DELETE FROM refs` is `mut true !== false`. `EXPLAIN QUERY PLAN PRAGMA table_info(refs)` becomes a mutation.

## Rollback

Revert this branch to `main` `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`. No migration and no stored rewrite.

## Threat model

A misclassified write is a string the door treats as a proven read. On the fallback path there is no prepare boundary, so `provenRead` is what keeps that door shut. If it returns true for a write-shaped string, the fallback door allows the string. A delete, insert, update, or drop on that path can change rows. Attach can open another database. Vacuum can rebuild the file. The primary door allows the string as well when `isMutatingStatement` and `hiddenWrite` are both false.

These tests prove that does not happen for the shapes a changed-line mutant opened:

- `deploy/cloudflare-edge/test/write-sqltext-survivors.test.js` — `SELECT 1 DROP`, `CREATE`, `ALTER`, `ATTACH`, `DETACH`, `PRAGMA`, and `VALUES (1) DROP` are not proven reads. Both doors return `SQL_DOOR`. The refs row and the audit row stay. `EXPLAIN QUERY PLAN WITH x AS (SELECT 1) DELETE FROM refs`, and the same shape for `INSERT` and `UPDATE`, are not proven reads. The primary door allows the plan. The fallback door returns `SQL_DOOR`. `EXPLAIN ANALYZE` stays a hidden write, so both doors return `SQL_DOOR`.
- `deploy/cloudflare-edge/test/write-v14-gap.test.js` — a real `VACUUM` or `REINDEX` stays a write on both doors.
- `deploy/cloudflare-edge/test/write-sqltext-alias-explain.test.js` — a second verb inside a plan stays a write, and a one-verb plan stays not a proven read.

The public functions are unchanged: `isMutatingStatement`, `provenRead`, `hiddenWrite`, `explainThenMore`, `namedVariable`, `unclosedLexeme`, and `pragmaClass` keep their signatures. No export was added or removed.

## Loop 1

Devin's exact-head gate on `b1fa82d2772bee79b45e97197bcb5728c707b241` was CODE INCOMPLETE / BODY FAIL. Report sha `e9c82d89`. Red is shown by mutants. There is no clean-tree failure: the new tests pass on the classifier. Restoring a mutant makes the same command exit 1.

`e388761e4da741d08a4d0f387bc6e5d81eed564c` adds the survivor tests. `2c2be2e63d00c3ccdf721746950b6f8fd23e0bf8` removes four lines whose deletion did not change `provenRead`, `isMutatingStatement`, or `hiddenWrite` on 191 strings. `03b30739a7bdc54ecc8839ec9ebf6866e9709379` pins `EXPLAIN ANALYZE`.

```sh
cd deploy/cloudflare-edge && node --test test/write-sqltext-survivors.test.js test/write-sqltext-alias-explain.test.js test/write-v14-gap.test.js
```

On `03b30739a7bdc54ecc8839ec9ebf6866e9709379` that command is 8 tests, 8 pass, 0 fail, exit 0. Deleting the vacuum/reindex-only guard exits 1 on `a trailing word other than vacuum or reindex is not a proven read`. Deleting the top-verb text exits 1 on `a with-write inside explain query plan is not a proven read`. Replacing the plan conjunction with `||` exits 1 on `explain analyze stays a hidden write`. Dropping `group`, `having`, `order`, `limit`, `offset`, `union`, `except`, or `intersect` from the clause list exits 1 on the clause test. The loop-1 note called the pragma conjunction and `topVerbAt` returning `0` equivalent. Loop 2 withdraws that claim.

## Loop 2

Inspector delta 1 on `7bd6c29f6727126303c854066f3d189a66e42729` is PASS WITH NOTES, report sha `0921be8c`. Devin agreed. Two survivors are not equivalent.

`2d838fefeadd0e113a38cc716450cb334a60cfe3` is tests only. On that commit the command above is 11 tests, 11 pass, 0 fail, exit 0. `sql-text.js` is unchanged.

`topVerbAt` returning `0` instead of `-1` (`sql-text.js:261`) makes `isMutatingStatement` true for `''`, whitespace, `'-- c\n'`, and `'/* c */'`. The same command on that mutant is 9 pass, 2 fail, exit 1. The failure that kills it is `empty text and a comment are not a mutation`.

Replacing the first `&&` with `||` on the pragma test in `explainedAt` (`sql-text.js:197`) makes `hiddenWrite` false for `EXPLAIN QUERY PLAN PRAGMA user_version PRAGMA writable_schema = ON`. The door can still return `SQL_DOOR` because `isMutatingStatement` stays true. The same command on that mutant is 10 pass, 1 fail, exit 1. The failure is `a second pragma inside an explain plan is a hidden write`, which asserts `hiddenWrite` directly.

Restoring the file after each mutant is 11 pass, 0 fail, exit 0.

The full changed-line table on that test commit is 79 rows, 65 killed, 14 survive. The 14 survivors, each with a one-line proof:

- Eleven comment deletions. A comment is not executed, so the three classifiers are the same function.
- `sql-text.js:194` `>=` to `>`. `explainedAt` runs only for `EXPLAIN QUERY PLAN`, whose first token is `explain`, so `topVerbAt` never returns 0 and both comparisons select the same index.
- `sql-text.js:195` `i < tokens.length` to `i <= tokens.length`. The extra iteration reads `tokens[tokens.length]`, which is `undefined`, the pragma predicate is false, and the function still returns `undefined`.
- `sql-text.js:265` `at < 0` to `at <= 0`. They differ only at index 0. A write there is already a mutation through `openingVerb`. A read there is not in `VERBS`, and `''` is not in `VERBS` either, so `readWords` takes the same branch. Empty input still has `topVerbAt` return `-1`.

## Known limits

Notes only. Not fixed in this loop.

- `deploy/cloudflare-edge/src/library.js:683` prepares the statement before the write gate. A temp name inside `PRAGMA database_list` can be prepared before classification refuses it.
- `deploy/cloudflare-edge/src/sql-tail.js:40` reads `stmt.sourceSQL` outside the prepare `try`. A throw from that read is pre-existing and is not caught there.

## Risk

high

This loop classifies the change as high because the classifier is the write gate. The earlier line that called it not high-risk is withdrawn. Sentinel `CONSENSUS: AGREED` is not claimed here. It is bound to the head only after Devin is green.

State-machine discovery skipped. The classifier is a pure function. It does not add or change a status, a phase, or a transition. The breaker is untouched.

Not a production-ready claim. Live voice, identity, and multi-user checks in `handoff/ACCEPTANCE.md` remain open.
