# v12 decision log

Sentinel's delta on frozen `dd87761f93d3793b9aff95c9770e6279763d8b2e` is CHANGES REQUIRED. v11 is not amended. This head starts there. No new dependency. The branch is local and is not pushed. Cursor bc-1a397a61 and Inspector are still reviewing `dd87761f`. Not a production-ready claim. Live voice, identity, and multi-user checks in `handoff/ACCEPTANCE.md` remain open.

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

The fix is `0deaa77e2d89584eff9e58160948b52f1e1de933`. This commit is the local head. The six gates were not run. They stay ready for the freeze.
