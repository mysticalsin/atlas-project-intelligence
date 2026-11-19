# v12 decision log

Sentinel's delta on frozen `dd87761f93d3793b9aff95c9770e6279763d8b2e` is CHANGES REQUIRED. v11 is not amended. This head starts there. No new dependency. The branch is local and is not pushed. Cursor bc-1a397a61 is folded into the same head below. Not a production-ready claim. Live voice, identity, and multi-user checks in `handoff/ACCEPTANCE.md` remain open.

## Verdict

verified. On the fallback door, `WITH a AS (SELECT 1 AS [x(]) DELETE FROM refs`, the backtick form, and the double-quoted form are not proven reads, they are mutations, and a shut door returns `SQL_DOOR`. The same holds for the nested form `WITH a AS ((SELECT 1 AS [x(])) DELETE FROM refs`. `END` is refused on both paths. The v11 quoted-read, alias, healthy-chain, and standalone-verb tests stay green. `classifyChain` is unchanged.

## Red

`2185b74966a9d2783f2a9d4da34f8696bf84d4dc` adds `test/write-v12-cte.test.js` and puts `END` on the standalone list. The four CTE tests fail `AssertionError` `true !== false` on `provenRead`. The standalone test fails `END` native `ERR_SQLITE_ERROR !== SQL_DOOR`. `84010fbe1cd28cb114ce2ba7ea7e08b36ba43497` also requires the three quoted forms to be mutations. The fix does not edit those assertions.

## Statement position

`hasStatementVerb` walks `sqlTokens` and keeps the mode that opened each parenthesis. A parenthesis after `AS`, or while a statement is already expected, opens a statement. Closing it returns to statement position, so the `DELETE` after the CTE is a verb even when a quoted name contains `(`. A call, an alias, a dotted name, and a quoted name are not verbs. The WITH-body character scan now skips `[...]` and backticks as well as quotes, so a parenthesis inside those names does not hide a depth-0 write. That is Sentinel F-O.

`sqlTokens` does not emit a comma, so `next.text === ','` could not match. It is removed. A call argument is still not a verb when the next token is `)`.

`end` is in `VERBS`. Standalone `END` is `SQL_DOOR` on both paths. `SELECT 1 AS end` and `SELECT "end" FROM audit` stay proven reads.

## Chain line 226

The source regex is removed. A comment could have satisfied it. Deleting `if (start === null) return 'tampered'` does not change a verdict. `find` returns `null` when the captured search misses, and it returns `undefined` when the row is absent. The `null` check and the later `start && sameText(start.prev_hash, GENESIS)` both fall through to `tampered`. The signed-row test stays green with that line deleted. There is no input, and no way to replace the captured `find` from a test, that makes the two paths differ. No product change. The signed-row test still kills the signed-before line: deleting it makes that chain verify, `true !== false`.

## Mutants

Each change was restored and was not committed. `test/write-v12-cte.test.js` and `test/write-v11-verb.test.js` were 8 pass before each one. Each mutant turned one test red and left the other seven green.

- The bracket skip removed from the WITH scan: the bracket test fails, `false !== true`.
- The backtick skip removed from the WITH scan: the backtick test fails, `false !== true`.
- The double-quote skip removed from the WITH scan: the double-quote test fails, `false !== true`.
- A second parenthesis does not push a frame: the nested test fails, `true !== false`.
- `end` removed from `VERBS`: the standalone test fails, `END` native `ERR_SQLITE_ERROR !== SQL_DOOR`.

The fix is `0deaa77e2d89584eff9e58160948b52f1e1de933`. The six gates were not run on that commit.

## Cursor bc-1a397a61

verified. `WITH \`x(y\` AS (SELECT 1) DELETE FROM audit`, and the same shape with `UPDATE`, `INSERT`, and `REPLACE`, in both the backtick and the `[x(y]` form, are `SQL_DOOR` on the native door and on the fallback door. The audit chain-start row stays, and its count stays 1. `EXPLAIN WITH x AS (SELECT 1) DELETE FROM audit` is a mutation on both doors. `END` and `END TRANSACTION` are verbs. `WITH x AS (SELECT 1) SELECT 1` stays a read. The v10, v11, and earlier v12 write tests stay green.

These strings were already refused on `0deaa77e` because the token walk put the main verb back in statement position. The remaining gap was a second character scan in `mutatingBody`. That scan is gone. `hasStatementVerb`, `readWords`, and `mutatingBody` now use `sqlTokens`. After a WITH list closes at depth 0, the next keyword is in statement position. A parenthesis inside a quoted name is one token, so it does not change that depth.

`openingVerb` is still the first word. That is the right check for `END` and `END TRANSACTION`. `WITH` is not itself a verb, so the WITH path asks the same token walk. `readWords` still uses the first word to choose a read, then the same walk. `EXPLAIN QUERY PLAN` of a write stays a description: native allows it, and the fallback door refuses it because it is not a proven read. A shut door still refuses `WITH \`x(y\` AS (SELECT 1) DELETE FROM sqlite_master` because that statement is a mutation. `splitStatements` remains its own quote-aware splitter and fails closed when it sees more than one statement.

## Chain line 226, again

Still no behavioral kill. The source regex stays removed. Deleting `if (start === null) return 'tampered'` does not change a verdict: `find` returns `null` when the captured search misses and `undefined` when the row is absent, and both paths fall through to `tampered`. No product change. The signed-row test still kills the signed-before line.

## Cursor mutants

Each change was restored and was not committed. On the fix, `test/write-v12-cursor.test.js`, `test/write-v12-cte.test.js`, `test/write-v11-verb.test.js`, and `test/write-v10-door.test.js` were green before each mutant.

- Closing a parenthesis does not return to statement position: all eight CTE-name writes and the `EXPLAIN WITH` test fail, native and fallback `ALLOW !== SQL_DOOR`. A direct run of the backtick `DELETE` then takes the audit count from 1 to 0 on both doors. The four earlier CTE tests fail with them. `END TRANSACTION` and the plain `WITH ... SELECT` stay green.
- The WITH path ignores the token walk: the eight CTE-name writes fail, native `ALLOW !== SQL_DOOR`. `EXPLAIN WITH` stays green, because that path is separate.
- `delete` removed from `VERBS`: the two `DELETE` forms and `EXPLAIN WITH` fail. `UPDATE`, `INSERT`, and `REPLACE` stay green.
- `update` removed from `VERBS`: only the two `UPDATE` forms fail.
- `insert` removed from `VERBS`: only the two `INSERT` forms fail.
- `replace` removed from `VERBS`: only the two `REPLACE` forms fail.
- The explain branch is removed: only `EXPLAIN WITH` fails, native `ALLOW !== SQL_DOOR`.
- `end` removed from `VERBS`: `END TRANSACTION` fails, native `ERR_SQLITE_ERROR !== SQL_DOOR`. The v11 standalone test fails on `END` as well.
- Every WITH is a write: only `WITH x AS (SELECT 1) SELECT 1` fails, `SQL_DOOR !== ALLOW`.

Both quote spellings of one verb are the same token path. Removing that verb kills both spellings. A quote-class change is not a separate kill, because the parenthesis inside the name never becomes a depth change once it is one token.

The tests are `b5464eb596de267bcbc6d647047a747661be74bf`. The fix is `7bb17cb6468177f65f79809306df5c4f1c1df445`. The six gates were not run on that commit.

## Devin, one lexer

verified. The fallback classifier uses one lexer. `sqlTokens` handles `'...'`, `"..."`, `[...]`, and `` `...` ``, drops comments, and stores parenthesis depth on each token. `hasStatementVerb`, `readWords`, and `mutatingBody` read those tokens and do not walk raw characters. The statement verb is the first verb keyword at depth 0 after the CTE list.

The explicit set has 293 statements. It includes `WITH "x(" AS (SELECT 1) DELETE FROM audit`, the alias form, and the empty single-quote, double-quote, bracket, and backtick names, in every quote style, for `DELETE`, `UPDATE`, `INSERT`, and `REPLACE`. The seeded generator uses seed `20261119` and adds 384 statements. Together that is 677 statements and 1354 door checks. Each one is `SQL_DOOR` on the native door and the fallback door, and the audit row does not change.

Dropping `"` from the lexer makes the explicit test fail: native `WITH "x(" AS (SELECT 1) DELETE FROM audit` is `ALLOW !== SQL_DOOR`. The quote-class change was restored and was not committed.

`splitBody` stays the trigger-boundary splitter. `scanSemi` stays the door's bare-semicolon check. Neither decides the statement verb. The record is in `handoff/untangle-decision-log.md`.

The tests are `51874d036609a23bb06b3ea60b0319065a2ec414`. The fix is `a64289cba866f655076880a283a721526912b8b9`. The six gates were not run.

## Devin, primary path

verified. On `dd87761f` the alias `[x(]` and the backtick form made `provenRead` true, and `WITH ... DELETE` removed a refs row on the fallback door and on the primary door. `"x("` was `SQL_DOOR` and the row stayed. The same lexer now backs both doors. `'...'`, `"..."`, `[...]`, and `` `...` `` are one token, so a parenthesis inside any of them does not hide the verb after the CTE list.

`hiddenWrite` asks `provenRead` for a statement whose first word is `WITH` or `EXPLAIN`. `EXPLAIN QUERY PLAN` is not that check: a plan of one `DELETE` stays allowed on the primary door and `SQL_DOOR` on the fallback door. The door is `isMutatingStatement` or `hiddenWrite` or, on the fallback door, not a proven read.

The regression is 32 refs statements and 32 audit statements: four quote styles, the name and the alias, `DELETE`, `UPDATE`, `INSERT`, and `REPLACE`. Each is not a proven read. Both doors return `SQL_DOOR`. The refs row stays at 1 with title `kept`, and the audit chain-start stays at 1. The quoted-paren fuzz, seed `20261119`, is 677 statements. It runs on both doors for audit (1354 checks) and again for refs (1354 checks).

Dropping backtick and bracket quotes makes `WITH a AS (SELECT 1 AS [x(]) DELETE FROM refs` a proven read, `true !== false`, and both doors `ALLOW`. A direct primary run then takes the refs count from 1 to 0. A door that consults `provenRead` only on the fallback path `ALLOW`s that write on the primary door. Returning false from the WITH branch of `mutatingBody` leaves the new tests green, because `hiddenWrite` still asks `provenRead`. Those mutants were restored and were not committed.

The tests are `dc76dc077ef9f269d69cd29ecbf733ce00e9d122`. The fix is `5796812ed0827ce68fe201f8fadc78c421cb8aad`. The fix does not edit those assertions.

This commit is the local head. The six gates were not run. They stay ready for the freeze.
