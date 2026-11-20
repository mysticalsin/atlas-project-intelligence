# SQL text aliases and explain plans

Low. `SELECT 1 VACUUM` and `SELECT 1 REINDEX` are column aliases. `EXPLAIN QUERY PLAN` of one write was not walked.

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

## Risk

low

plan debate skipped: not high-risk (aliases SQLite runs as reads become reads; every statement SQLite runs as a write stays a write; no auth, session, secret, schema, or deletion change)

State-machine discovery skipped. The classifier is a pure function. It does not add or change a status, a phase, or a transition. The breaker is untouched.

Not a production-ready claim. Live voice, identity, and multi-user checks in `handoff/ACCEPTANCE.md` remain open.
