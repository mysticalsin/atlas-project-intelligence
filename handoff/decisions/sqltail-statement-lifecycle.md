# Decision: SQL tail statement lifecycle

Date: 2026-11-20
Owner: Tony, carried out by Atlas
Tickets: ATLAS-SQLTAIL-EMPTY-ERRSTATE, state machine S4

## Done when

- Empty input, whitespace, `;`, a block comment, and a line comment do not change a refs row or an audit row.
- The primary door answers those inputs with `SQL_EMPTY`, status 500, and the message `This input prepares no statement.`
- The door does not throw `ERR_INVALID_STATE` and the message does not contain `finalized`.
- A comment in front of a real verb stays that verb. `/* note */ DELETE FROM refs` deletes. `/* c */ SELECT 1` returns a row. `SELECT '/* delete */'` returns that text.
- `SELECT 1; DELETE FROM refs` still reports the tail ` DELETE FROM refs`. The tail reader does not run the tail. `DROP TABLE refs` does not drop the scratch table.
- The lifecycle is one pure transition function. The cross product is 30 pairs. Ten are legal. Twenty are illegal. An unknown phase becomes idle and is rejected.
- `sourceIsPrefix` allows a prefix and denies a different source. A denied read does not become a tail.
- `preparesNoStatement` is true for empty input, `;`, `/* delete */`, and `-- drop`. It is false for `/* c */ DELETE FROM refs`, `; DELETE FROM refs`, and `SELECT '/* delete */'`.
- A NUL byte does not hide a following `DELETE`. The rows stay. The code is `SQL_EMPTY`.
- No new `skip` or `xfail`.

## What SQLite does

Measured with `node:sqlite` on this host, one memory database, one refs row.

- `''`, whitespace, `;`, `;;`, `/* delete */`, `-- drop`, and mixtures of those prepare a statement object whose `sourceSQL` throws `ERR_INVALID_STATE` (`statement has been finalized`). `all()` throws the same code. The row count stays 1.
- `/* c */ SELECT 1`, `-- c\nSELECT 1`, and `/* c */ DELETE FROM refs` prepare a live statement. `sourceSQL` is that text. Running the delete removes the row.
- `; DELETE FROM refs` and `/* c */; DELETE FROM refs` are one live statement. `sourceSQL` is the whole string. This machine does not reclassify them.
- A NUL byte ends the C string. `\0DELETE FROM refs` prepares nothing. The bytes after the NUL are not a statement.
- `\v` alone is `ERR_SQLITE_ERROR` (`unrecognized token`). It is not `SQL_EMPTY`. `sqliteRemainder` returns null and the fallback door decides.
- Preparing many comment-only strings and leaving the handles open crashes `node:sqlite` at process shutdown (`SIGSEGV`), including inside `DatabaseSync.close()`. The runner therefore does not call `prepare` when `preparesNoStatement` is true.

## Decision

Validation error, not a successful no-op.

A success with zero rows is what a delete that matched nothing looks like. `/* delete */` must not look like that delete. The door already refuses a bad string with a code (`SQL_TEXT`, `SQL_DOOR`, `SQL_MULTI`). Empty input is the same kind of answer: `SQL_EMPTY`. The throw happens in `sqliteRemainder`, before `Library.exec` reaches `_sql.exec`, so no row is written.

`ERR_INVALID_STATE` is the lifecycle fault. Callers do not see it. An illegal transition returns a rejection marker and `statementError` maps that marker to `SQL_EMPTY`. `statementTransition` does not log. `noteStatement` logs the marker. The marker fields are `atlas_metric`, `illegal`, `phase`, and `event`. The SQL text is not in the marker.

`prepare_failed` stays a null return. A syntax error is still the fallback door, not `SQL_EMPTY`.

## States and events

States: `idle`, `prepared`, `executed`, `remainder`, `finalized`.

Events: `prepare_live`, `prepare_empty`, `prepare_failed`, `execute`, `read_remainder`, `finalize`.

Legal pairs:

| From | Event | To |
|---|---|---|
| idle | prepare_live | prepared |
| idle | prepare_empty | finalized |
| idle | prepare_failed | idle |
| prepared | read_remainder | remainder, when `sourceIsPrefix` |
| prepared | execute | executed |
| prepared | finalize | finalized |
| executed | read_remainder | remainder, when `sourceIsPrefix` |
| executed | finalize | finalized |
| remainder | execute | executed |
| remainder | finalize | finalized |

`read_remainder` from `prepared` or `executed` with a source that is not a prefix is denied, not illegal. The state stays. The runner then finalizes and returns null.

`sqliteRemainder` walks idle, prepared, remainder, finalized for a live statement. It walks idle, finalized for input that prepares nothing. It does not execute the statement. `executed` is in the table so a caller that runs a live statement has one legal place to record that, and a second execute is illegal.

## Plan

Red commit, tests only. Product source unchanged.

Failing tests in `deploy/cloudflare-edge/test/write-sqltail-lifecycle.test.js`:

- empty input
- whitespace-only input
- `;`
- a block comment
- a line comment
- a comment before a real verb
- the transition table
- `sourceIsPrefix`
- comment and whitespace boundaries
- 80 random comment and whitespace inputs, seed `20261120`

The tail of a real statement already matched and that test passed on the red commit.

TEST COMMAND:

```sh
cd deploy/cloudflare-edge && node --test test/write-sqltail-lifecycle.test.js
```

## Fix

`deploy/cloudflare-edge/src/sql-tail.js` is the machine and the runner.

`deploy/cloudflare-edge/test/sqlite.js` `statementTail` returns null when `preparesNoStatement` is true, so the test driver does not prepare that input. `Library.exec` already catches a throw from `statementTail` and then calls `sqliteRemainder`.

`library.js` is not edited. `python3 build.py` is not required. `build.py` does not embed this file.

## Mutants

Each one is restored and not committed. The same TEST COMMAND. Fourteen mutants, fourteen killed, none survived.

| Mutant | Result |
|---|---|
| drop the `preparesNoStatement` branch | killed, `SIGSEGV` |
| `preparesNoStatement` returns true | killed, the verb and the tail tests fail |
| `sourceIsPrefix` returns true | killed, the guard deny fails |
| add `finalized:read_remainder` to the legal set | killed, the transition table fails |
| an illegal pair returns ok | killed, the transition table fails |
| `statementSource` reads with no catch | killed, a thrown `ERR_INVALID_STATE` leaves the guard |
| `noteStatement` does not warn | killed, the transition table fails |
| the tail is always `''` | killed, the tail tests fail |
| no-statement returns null instead of `SQL_EMPTY` | killed, the empty tests fail |
| the message is `Empty.` | killed, the empty tests fail |
| status 400 | killed, the empty tests fail |
| `execute` drops the tail | killed, the transition table fails |
| an unknown phase is kept | killed, the transition table fails |
| `statementTail` prepares no-statement input | killed, `SIGSEGV` |

## Rollback

Revert this branch onto PR #19 head `b1fa82d2772bee79b45e97197bcb5728c707b241`. No migration and no stored rewrite.

## Risk

Low. The new code throws only for input that prepared no statement. A live statement still returns the same tail string. The fallback door is unchanged when `node:sqlite` is absent or prepare throws.

## Known limits

- An unclosed `/*` is `SQL_DOOR` from `unclosedLexeme` before this machine.
- `; DELETE FROM refs` is one live statement in this `node:sqlite`. The tail is empty. The existing door still classifies the verb.
- Workerd 2026-10-23 has no `sourceSQL`. `sqliteRemainder` returns null there.
- Repeating a prepare that compiles nothing crashes `node:sqlite` at shutdown. The scanner stops at a NUL when the prefix is only noise, and does not call prepare. `statementSource` still catches a thrown `ERR_INVALID_STATE`. The suite checks that with a thrown error, not with another native prepare.
- `\v` alone is a syntax error, not `SQL_EMPTY`.
