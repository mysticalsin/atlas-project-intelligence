# v11 decision log

Cursor bc-fdd1abd4 on frozen `ab1850b9658ddd783cf894d561a790ef8e5e8c9e` is REQUEST CHANGES, with one Medium. v10 is not amended. This head starts there. No new dependency. No constitution file exists, and none was added. `statementTail` in `test/sqlite.js` stays. Not a production-ready claim. Live voice, identity, and multi-user checks in `handoff/ACCEPTANCE.md` remain open.

## Verdict

verified. A word is a verb only when it is an unquoted keyword in statement position. On the fallback door, a quoted name and an alias stay proven reads, and a healthy chain is not reported as unverified. Standalone `ANALYZE`, `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, and `RELEASE` stay refused on both paths. `classifyChain` is unchanged. At 320 px the page does not grow past the screen, and End stays inside it.

## Red

`b6b8a81500c5924a5eef5c346e7d94777e6d366b` is tests only. `test/write-v11-verb.test.js` is 5 tests, 3 pass, 2 fail. Both failures are `AssertionError` `false !== true`, on `provenRead('SELECT "commit" FROM audit LIMIT 0')` and `provenRead('SELECT 1 AS begin')`. The studio check fails `AssertionError: A 320 px page stays on screen and the three controls stay inside`. `6686911c540341e50fc65b68925410d2a1f4cc51` only moves the signed predecessor to seq 0 so the chain-start hash still verifies. The verb fix and the layout fix do not edit those assertions.

## Verb position

`sqlTokens` keeps a quoted identifier marked. A word in `VERBS` counts only at the start of a statement, after `EXPLAIN` or `PLAN`, or as a parenthesized write followed by a clause. A quoted name, a word after `AS`, a word after a dot, and a call argument are not verbs. The production store has no `statementTail` and no `node:sqlite`, so a shut door refuses anything that is not a proven read. `SELECT "commit" FROM audit LIMIT 0` and `SELECT 1 AS begin` are proven reads there. `auditLines` runs that probe and does not mark a healthy line `unverified`. `WITH x AS (DELETE FROM audit) SELECT 1` stays not a proven read. `EXPLAIN DELETE` stays a mutation. `EXPLAIN QUERY PLAN DELETE` stays a description.

## Chain lines

`classifyChain` is unchanged. A signed row at seq 0 before the one genesis chain-start is `TAMPERED`. Deleting `if (signedBefore !== false) return 'tampered'` makes that chain verify: `AssertionError` `true !== false`. Deleting `if (start === null) return 'tampered'` does not change that verdict. A null start still fails `start && sameText(start.prev_hash, GENESIS)` and returns `tampered`. The source test requires both lines. No product change.

## 320 px

Synthetic live session, 320 by 740, scroll 0. Labels stay `Mute microphone`, `Restart conversation`, and `End interview`.

| control | before | after |
| --- | --- | --- |
| page scrollWidth | 320 | 320 |
| Mute | 27, 615.9, 146, 661.9 | 27, 595.9, 146, 641.9 |
| Restart | 158, 615.9, 292.9, 661.9 | 158, 595.9, 292.9, 641.9 |
| End | 110, 673.9, 210, 719.9, 20.1 px clear | 110, 653.9, 210, 699.9, 40.1 px clear |
| hint under End | bottom 746.1, 6.1 px past 740 | bottom 726.1, 13.9 px inside |
| recording pill | `width:max-content`, 282 px | `max-width:100%`, 284 px |

On this host the document was already 320 px wide. The pill rule was still `width:max-content`. It is gone, and the 320 px orb is 200 px so End and the hint under it stay inside the viewport. The controls wrap.

## Mutants

Each change was restored and was not committed. `test/write-v11-verb.test.js` was 5 pass before each one.

- A quoted verb word returns true from anywhere: the quoted-read test and the alias test fail, `AssertionError` `false !== true`. The alias test also asserts `SELECT 1 AS "commit"`. The other three stay green.
- Any unquoted verb word counts, with position ignored: only the alias test fails, `AssertionError` `false !== true`.
- `analyze`, `begin`, `commit`, `rollback`, `savepoint`, and `release` removed from `VERBS`: only the standalone test fails, `ANALYZE` native `ALLOW !== SQL_DOOR`.
- The null-start return deleted: only the source test fails. The signed-row test stays green.
- The signed-before return deleted: the signed-row test fails, `true !== false`, and the source test fails.

## Stale notes

The v10 opening said "No UI change" before the 320 px control fix in that same round. The v9 follow-up note said the sentinel branch was not pushed. Those commits are on the review branch as of v10.

The verb fix is `ed02b3940091ccba99a65e74a24ee198f4273a46`. The layout fix is `1191fb601ac93a9f341fdfe2b424d4e87a668791`. This commit is the gate head. The numeric results are not in this file.
