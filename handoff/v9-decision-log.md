# v9 decision log

Parent is the frozen v8 head `b9d1ac135fd6ea5bf171a1832448419ea608e1f0`. Cursor bc-9bb004c7 on that head is REQUEST CHANGES, so v8 is not the review head. v8 is not amended. This round folds Sentinel F-B2, F-E, F-G, F-H, and F-I, Cursor's pragma and temp-shadow findings, Inspector N-1, the recorded index note, and Inspector F-5, plus Devin's partial on `b9d1ac13`. The tokenizer and the missing authorizer are in `handoff/untangle-decision-log.md`.

No constitution file exists, and none was added. No specify CLI and no new dependency. No UI change. `statementTail` in `test/sqlite.js` stays. HEAD 2 stays parked at `89c630293019cf7285265a44fb7e03a4df333f8b`.

## Red

`4201f4868148188868dcaceff575b662cd0976f9` is tests only, parent `b9d1ac13`. `test/write-v9-door.test.js` is 11 tests, 0 pass, 11 fail. Each failure is an `AssertionError`. The product commit does not edit that file.

## Token stream and prepare

`PRAGMA writable_schema /* c */ = ON` and `PRAGMA "main"."writable_schema" = ON` are `SQL_DOOR` before prepare on the shut, recorded, housekeeping, and schema doors, on both paths, and the flag stays 0. The same holds for `= ON`, `= 1`, `= true`, `= 'on'`, `= yes`, mixed case, `main.`, parentheses, `= RESET`, a trailing statement, and `PRAGMA writable_schema = <each allowlisted read name>` and `PRAGMA <x> = writable_schema`.

`PRAGMA foreign_keys = table_info` and `PRAGMA trusted_schema = writable_schema` are assignments. The name is the word before `=`. The flags stay at the value they had.

A bare allowlisted pragma read, including one trailing semicolon, still runs. `SELECT 1;;` stays `SQL_MULTI` on both paths.

The schema door may set `user_version` and `foreign_keys` only. `PRAGMA journal_mode = WAL` is `SQL_DOOR` there. No registered migration sets a pragma.

## Guarded creates, rename, and indexes

`recorded()` refuses `CREATE` of `audit`, `audit_anchor`, `consent_receipts`, or `privacy_gate` in any schema, including `temp.` and `main.`, any quoting, and `CREATE TABLE temp.audit AS SELECT * FROM main.audit`. The check runs before prepare. `schema()` still creates the real `audit` table. `CREATE INDEX IF NOT EXISTS consent_receipts_subject` still installs through `schema()`, not through `recorded()`.

`CREATE INDEX` on `consent_receipts` or `privacy_gate` is `SQL_DOOR` in the recorded door only. It is not in `alwaysBlocked`.

`ALTER TABLE … RENAME TO` a guarded name is `SQL_DOOR`. Registered renames of other tables stay.

## Math.max and the lint

`Math.max` is captured at load the same way as `Math.min`. The three depth sites in `sql-text.js` use that copy. A selective `Math.max` that turns 0 into 99 does not hide `WITH c AS (SELECT 1) DELETE FROM refs`.

The lint flags `const { eval: e } = globalThis`, `const k = 'eval'; globalThis[k]()`, and `const [e] = [eval]`. `(0, eval)('1')` stays flagged.

## Insights body

`POST /api/library/insights` checks the role before reading the body. An empty body is `{}` after that check. An owner with no body gets 403, the same as `{}`. A reviewer with no body gets the same status as `{}`. There is no `j-api.mjs` in this checkout, so that journey file was not edited. Invalid JSON that is not empty is still 400, and an owner is still 403 before the body is read.

## Residuals

A registered migration may still `DROP` a live table. `'SELECT 1 AS begin; -- comment'` is still over-refused. `rewriteAudit` still accepts chain-start sequence 1. A damaged chain with no personal rows still returns no `auditRefused`. A profile rebuild on a damaged chain still leaves `merged_into` null, removes the finished invitation, and returns 409. `EXPLAIN QUERY PLAN` of one delete stays a plan read on the native path and a refusal on the fallback path. Inspector F-4 stays a residual: `MANIFEST.json` is the received 12.1 package dated 2026-09-26 and is not regenerated. Sentinel F-6 stays unnamed. The contact regex in `library.js` is outside the door.

## Fix

`821520a3bc6a7fc1e7eadcc86d879e51befb005d` is `library.js`, `library-routes.js`, `sql-text.js`, `primordials.js`, and `test/write-lint.js`. It does not edit `test/write-v9-door.test.js`.

## Mutations

Each one was restored and was not committed.

- `createShadow` returning false: `CREATE TABLE temp.audit AS SELECT` was 0 pass, 1 fail, `AssertionError` `ALLOW !== SQL_DOOR` (`/tmp/v9-mut-create.txt`).
- Skipping the writable refusal before prepare: the quoted form was 0 pass, 1 fail, `AssertionError` expected `0` actual `1` (`/tmp/v9-mut-writable.txt`).
- Treating an allowlisted value after `=` as the pragma name: `PRAGMA foreign_keys = table_info` was 0 pass, 1 fail, `AssertionError` `ALLOW !== SQL_DOOR` (`/tmp/v9-mut-equals.txt`).
- The WITH-body depth site calling live `Math.max`: the delete was 0 pass, 1 fail, `AssertionError` expected `1` actual `0` (`/tmp/v9-mut-max.txt`).
- `renameGuarded` returning false: the rename was 0 pass, 1 fail, `AssertionError` `ALLOW !== SQL_DOOR` (`/tmp/v9-mut-rename.txt`).
- Schema accepting every setter: `PRAGMA journal_mode = WAL` was 0 pass, 1 fail, `AssertionError` `ALLOW !== SQL_DOOR` (`/tmp/v9-mut-setter.txt`).
- `receiptIndex` returning false: the consent index was 0 pass, 1 fail, `AssertionError` `ERR_SQLITE_ERROR !== SQL_DOOR` (`/tmp/v9-mut-index.txt`). Without the check SQLite reports `no such table: main.consent_receipts` because that table is not installed on this path. The door refuses first.
- Removing the eval-binding walk: the object-pattern plant was 0 pass, 1 fail, `AssertionError` expected `true` actual `false` (`/tmp/v9-mut-eval.txt`).
- Parsing the insights body before the role check: the owner with no body was 0 pass, 1 fail, `AssertionError` `400 !== 403` (`/tmp/v9-mut-insights.txt`).

## Local follow-up, not pushed

Sentinel accepted `4c11808ca219d2b8c8dcd83a537d27f20c9cefa5` with residuals. That head stays frozen. This branch is `cursor/v9-sentinel-residuals-660c` and is not pushed. It ships only if another round is asked for.

The name resolver keeps clause words and known table and index names in frozen arrays. It writes names by index and asks the captured `includes`. `provenRead` treats a pragma as a read only when the statement's verb is `PRAGMA`, including `EXPLAIN` and `EXPLAIN QUERY PLAN`. The eval tripwire also flags `[eval][0]()`, `({e: eval}).e`, `Reflect.apply(eval)`, `.map(eval)`, and `Function` that is not a bare identifier. A doubled quote inside `"..."` or `` `...` `` stays inside the identifier. `[...]` and doubled backticks are not placeholders, and a doubled backtick does not end the quoted span in the statement split or the semicolon scan. `DELETE FROM "audit""tail"` is `ERR_SQLITE_ERROR` on the recorded door. The four scanners are compared in `test/write-v9-sentinel.test.js`.

Red `c84d7d23e7323a876fb1b3c1835d75d79db3fae3` is that test only: 4 tests, 0 pass, 4 fail, each an `AssertionError`. Fix `b2f7db8df5192abb097ce03c9599370a7a6eeaf0` is `library.js`, `sql-text.js`, and `test/write-lint.js`. It does not edit that test. After that commit, the new file is 4 pass, 0 fail, and `test/write-*.test.js` is 202 pass, 0 fail. The six gates were not run.

Each mutation below was restored and was not committed.

- Index assignment replaced by live `push`: `DELETE FROM audit` was 0 pass, 1 fail, `AssertionError` `CHAIN_DAMAGED !== SQL_DOOR` (`/tmp/v9s-mut-push.txt`).
- `clauseWord` returning true: `DELETE FROM main.audit` was 0 pass, 1 fail, `AssertionError` `CHAIN_DAMAGED !== SQL_DOOR` (`/tmp/v9s-mut-clause.txt`).
- `listedName` refusing `refs_owner_local`: Library construction threw `SCHEMA_DML` before the assertion, 0 pass, 1 fail (`/tmp/v9s-mut-known.txt`).
- `provenRead` returning on any later pragma read: `DELETE FROM refs PRAGMA user_version` was 0 pass, 1 fail, `AssertionError` expected `false` actual `true` (`/tmp/v9s-mut-pragma.txt`).
- The new eval-call checks removed: the first plant was 0 pass, 1 fail, `AssertionError` expected `true` actual `false` (`/tmp/v9s-mut-eval.txt`).
- The doubled-quote loop restored to the dead branch: the quoted identifier split into `a;` and `b?`, 0 pass, 1 fail, `AssertionError` (`/tmp/v9s-mut-quote.txt`).
