# v13 decision log

Sentinel's delta on frozen `8cdef0629c5755006f66a0dfcf753d7e7e87fa94` is CHANGES REQUIRED, M-2. v12 is not amended and is not pushed. This branch is local `cursor/v13-named-variable-660c`. The report file was not in this checkout. The repros below are the ones named with that delta. Report sha `dbeda4d8`. No new dependency. Not a production-ready claim. Live voice, identity, and multi-user checks in `handoff/ACCEPTANCE.md` remain open. Cursor bc-9e93ee0a and Inspector on `8cdef06` are still open, so this head is not frozen.

## Verdict

verified on this host, not frozen. A `$` `:` `@` `#` token is one token, including `::` segments and a TCL `(...)` suffix. A quote, a parenthesis, or a comment inside that suffix does not hide the write after it. `provenRead` is false for each repro. Both doors return `SQL_DOOR` before prepare, and the refs row and the audit row stay. `?` and `?NNN` still bind. `SELECT 1 AS x$y` stays a read: `$` inside an identifier is not a parameter.

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

Explicit: 20 statements, both tables, both doors. That is the four writes after `WITH x AS (SELECT $a(') )`, plus `WITH x AS (SELECT :a(((x)) DELETE`, `WITH x AS (SELECT @a(--)) DELETE`, `WITH x AS (SELECT @a(/*)) DELETE`, `SELECT $a(') ; DELETE`, `WITH x(a) AS MATERIALIZED (SELECT 1) DELETE`, and `WITH x(a) AS NOT MATERIALIZED (SELECT 1) DELETE`, each for refs and for audit.

Variable fuzz seed `20261120`. Generated 96 audit statements and the same 96 rewritten for refs. 192 audit door checks and 192 refs door checks. Each is `provenRead` false and `SQL_DOOR`, and the row stays. The alphabet of the suffix is `$ : @ # ? ( ' " - / * ; x a` plus the `::` form and the `(...)` form.

The quoted-paren fuzz seed stays `20261119`. Its alphabet now also has `$ : @ # ?`. Counts stay 293 explicit, 384 generated, 677 statements, 1354 door checks for audit and 1354 for refs.

## Mutants

Each change was restored and was not committed. On the fix, `test/write-v13-variable.test.js` was 4 pass before each one.

- `takeVariable` returns null: the hidden-write test, the door test, and the fuzz fail `true !== false`. `SELECT $a` is no longer `SQL_DOOR`.
- `namedVariable` returns false: the boundary repro is `SQL_MULTI !== SQL_DOOR`, because the semicolon is visible once the suffix is one token. `SELECT $a` is `ALLOW`. The provenRead test stays green.

The fix is `3f8729654c97017a754fc8e957afa9af9b3b0947`. The edge suite on this host was 1054 pass, 0 fail. The six gates were not run. This branch is not pushed.
