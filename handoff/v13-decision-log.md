# v13 decision log

Sentinel's delta on frozen `8cdef0629c5755006f66a0dfcf753d7e7e87fa94` is CHANGES REQUIRED, M-2. v12 is not amended. Cursor's review of that head is APPROVE WITH RESIDUALS, 0 High, 0 Medium. Every review of v12 is in. This commit is the v13 freeze head. The push is an ordinary fast-forward onto `cursor/atlas-write-chokepoint`. `main` is not updated. The report file was not in this checkout. The repros below are the ones named with that delta. Report sha `dbeda4d8`. No new dependency. Not a production-ready claim. Live voice, identity, and multi-user checks in `handoff/ACCEPTANCE.md` remain open. Gate counts are not in this file.

## Verdict

verified on this host. A `$` `:` `@` `#` token is one token, including `::` segments and a TCL `(...)` suffix. A quote, a parenthesis, or a comment inside that suffix does not hide the write after it. An unterminated quote, identifier, or block comment is not a proven read. A write verb inside a CTE body, or after the depth-0 verb, is not a proven read. Both doors return `SQL_DOOR` before prepare, and the refs row and the audit row stay. `?` and `?NNN` still bind. `SELECT 1 AS x$y` stays a read: `$` inside an identifier is not a parameter. `REPLACE(` stays a function.

## Named parameters

Searched `deploy/cloudflare-edge/src` and the rest of the repo for a SQL bind that is not `?`. `placeholders()` in `deploy/cloudflare-edge/src/sql-bound.js` is the only builder of a bind list, and it emits `?`. `exec` and `prepare` strings use `?`. No statement uses `$name`, `:name`, `@name`, or `#name`. `$schema` in an Adaptive Card, `:id` in a URL path, and `${}` in a template are not SQL parameters.

The door refuses a named parameter because the application never binds one. A sigil inside a string literal or a quoted identifier is not that token. `?` and `?NNN` are not named.

## Red

`3183faad7a80da46075aae74fdf9b15895a2611d` adds `test/write-v13-variable.test.js`. The hidden-write test fails `AssertionError` `true !== false` on `provenRead`. The door test fails the same way. `SELECT $a` fails `ALLOW !== SQL_DOOR`. The fix does not change those assertions. The audit-only fuzz snap no longer reads a refs title when no refs row was seeded. That harness change is in the fix commit.

## Lexer

Node's SQLite on this host is 3.53.4. `tokenize.c` (`CC_VARNUM`, `CC_DOLLAR`, `CC_VARALPHA`) is the rule. `?` then digits is one numeric variable. `$` `:` `@` `#` then IdChar, then `::`, then one `(...)`, is one token. IdChar is a letter, a digit, `_`, `$`, or a code unit at or above 128. The suffix stops at the first `)`, at sqlite3Isspace (tab, LF, VT, FF, CR, space), or at the end. A no-break space does not stop it. Quotes and comments inside the suffix are characters. `n == 0` is not a named parameter. A bare `$` or a bare `:` is that case. `$1(')` is named, because a digit is IdChar. `#1` is the same token shape. This SQLite build then rejects `#1` at parse; the door refuses it first.

`sqlTokens` emits that span as one `var` token and does not change parenthesis depth for a suffix. `splitBody` and `scanSemi` skip the same span, so `SELECT $a(') ; DELETE FROM refs` is two statements. `placeholderCount` does not count a `?` inside the suffix. `x$y` stays one word.

`namedVariable` is true when a var token is named. `Library.exec` calls it before `statementTail` and before the multi-statement check. The boundary repro is `SQL_DOOR`, not `SQL_MULTI`.

`afterCteList` skips a column list and `NOT MATERIALIZED` before the CTE body. `WITH x(a) AS MATERIALIZED (SELECT 1) DELETE FROM refs` is not a proven read. `WITH x(a) AS NOT MATERIALIZED (SELECT 1) SELECT 2` is a proven read. The forward scan already saw the `DELETE`. The list walker now lands on the statement after the CTE.

## Counts

Explicit variable statements: 20, both tables, both doors. That is the four writes after `WITH x AS (SELECT $a(') )`, plus `WITH x AS (SELECT :a(((x)) DELETE`, `WITH x AS (SELECT @a(--)) DELETE`, `WITH x AS (SELECT @a(/*)) DELETE`, `SELECT $a(') ; DELETE`, `WITH x(a) AS MATERIALIZED (SELECT 1) DELETE`, and `WITH x(a) AS NOT MATERIALIZED (SELECT 1) DELETE`, each for refs and for audit.

Variable fuzz seed `20261120`. Every form is in the set: `?`, `?NNN`, `:name`, `@name`, `$name`, `#name`, `$name(...)`, and `$a::b`, including an unbalanced parenthesis, a quote, or a comment marker inside the suffix. 26 forms, each with the four audit writes, plus 96 generated statements. 200 audit statements and the same 200 rewritten for refs. 400 audit door checks and 400 refs door checks. Each is `provenRead` false and `SQL_DOOR`, and the row stays. `?` and `?12` stay bound reads in the named-parameter test. `SELECT ?1` stays a bound read.

The quoted-paren fuzz seed stays `20261119`. Its alphabet now also has `$ : @ # ?`. Counts stay 293 explicit, 384 generated, 677 statements, 1354 door checks for audit and 1354 for refs. That set includes the explicit `/* */` forms `WITH /*(*/ "x(" AS (SELECT 1) /*;*/ DELETE FROM audit` and the three other quote styles.

Unclosed fuzz seed `20261121`. Five openers: `'`, `"`, `[`, `` ` ``, and `/*`. 144 statements. 288 door checks. Each is `SQL_DOOR` and the row stays. A finished quote, identifier, or block comment stays a read.

Nested writes: 12 statements, both tables. `DELETE`, `UPDATE`, `REPLACE INTO`, and `INSERT ... ON CONFLICT DO UPDATE` inside a CTE, plus a `DELETE` after the depth-0 verb and a `DELETE` in a subquery. `WITH select(a) AS (SELECT 1) DELETE` is the column-list case, for refs and for audit.

## Mutants

Each change was restored and was not committed. On the fix, `test/write-v13-variable.test.js` and `test/write-v13-cursor.test.js` were green before each one. None of these kills is a source regex.

- Drop the `$` suffix parenthesis in `takeVariable`. Killed by `a dollar suffix parenthesis stays inside the variable` (`true !== false`). The hidden-write test, the door test, and the variable fuzz also go red, because those statements contain a suffix. `a variable is not a bare word` and `a named parameter is refused on both doors` stay green.
- `takeVariable` returns null, so the name is a bare word. Killed by `a variable is not a bare word`: `provenRead('WITH x AS (SELECT 1) $delete FROM refs')` is false. It also turns the other variable tests red. The cursor door tests then fail while seeding, `CHAIN_DAMAGED`, because `?` is no longer a placeholder. That is collateral of the same mutant.
- `namedVariable` returns false. Killed by `a named parameter is refused on both doors` (`ALLOW !== SQL_DOOR`). `both doors refuse a named variable and keep refs and audit` also goes red: the boundary repro is `SQL_MULTI !== SQL_DOOR`. The suffix proven-read test and `a variable is not a bare word` stay green.
- `unclosedLexeme` returns false. Killed by `an unterminated lexeme is refused on both doors`. `SELECT 1 /*` is `ALLOW`. The proven-read test and the unclosed fuzz also go red. `a write verb inside a read is refused on both doors` stays green.
- `strayWrite` returns false. Killed by `a write verb inside a read is refused on both doors` (`true !== false`, then the door is not `SQL_DOOR`). The column-list test, `REPLACE(`, and the `EXPLAIN QUERY PLAN` residual stay green.

Devin's paren-depth mutant is the v12 one: a second parenthesis does not push a frame. It is killed by the nested CTE test in `test/write-v12-cte.test.js`, `true !== false`. It was restored and was not committed. The record is in `handoff/v12-decision-log.md`.

Inspector's depth-0 miss, returning `''` from the WITH step, is killed by `provenRead('WITH x AS (SELECT 1) DELETE FROM audit')`. The record is in `handoff/v12-decision-log.md`.

## Cursor L1

`skipQuote` used to return the end of the input when `'` never closed. The same swallow is in the `"`, `[`, and `` ` `` identifier scan, and in the `/*` scan. The statement stayed a proven read. `SELECT '` prepared as an error. `SELECT 1 /*` prepared and ran.

`sqlTokens` now marks that span unclosed. `unclosedLexeme` is true, `provenRead` is false, and `Library.exec` throws `SQL_DOOR` before prepare, on both doors. A finished `'...'`, `"..."`, `[...]`, `` `...` ``, or `/* */` is unchanged. A quote or a comment marker inside a variable suffix is still part of that token.

The red commit is `801e2dd51ecbbc3a2fddb2611310121b0bcf7c92`. `provenRead("SELECT '")` fails `true !== false`. The door fails `ERR_SQLITE_ERROR !== SQL_DOOR`. The fix does not edit those assertions.

## Cursor L2

`topVerb` returns the first depth-0 verb and ignored a write keyword anywhere else. `WITH x AS (DELETE FROM refs RETURNING *) SELECT 1` was a proven read. On this host SQLite 3.53.4 rejects that statement at parse (`near "DELETE"`), so the door returned `ERR_SQLITE_ERROR` and the row stayed. The classifier still has to refuse it. `INSERT`, `UPDATE`, `REPLACE INTO`, and `INSERT ... ON CONFLICT DO UPDATE` inside a CTE body are the same rule, and so is a write verb after the depth-0 verb, including `SELECT 1 DELETE FROM refs` and a `DELETE` in a subquery.

`strayWrite` is that rule. `REPLACE(` is the function and stays a read. `WITH select(a) AS (SELECT 1) DELETE FROM refs` was already `SQL_DOOR`: the column list is skipped and `DELETE` is the depth-0 verb. The test locks it.

## Cursor L3 and F-L

`EXPLAIN QUERY PLAN DELETE FROM refs` stays allowed on the primary door and `SQL_DOOR` on the fallback door. The row stays either way. No code change. The comma-eval lint residual stays accepted: `forEach(eval)`, `eval.call`, and `const F = Function` are not caught. Both are listed in the PR body.

## Chain line 226

No product change. Deleting `if (start === null) return 'tampered'` does not change a verdict. `find` returns null when the captured search misses and undefined when the row is absent. Both fail the genesis check and return tampered. The source regex is gone. The record is in `handoff/v12-decision-log.md`.

The variable fix is `3f8729654c97017a754fc8e957afa9af9b3b0947`. The form coverage is `bada15b7045e863081b4d5425fe50a4ff26b3c1b`. The unclosed and nested-write fix is `07f8a304c2b9688b5139cc5caa89dc18fb1521de`. This commit is the freeze head. Gate counts are not in this file.
