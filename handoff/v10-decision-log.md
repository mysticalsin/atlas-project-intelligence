# v10 decision log

Cursor bc-0baf72cc on frozen `4c11808ca219d2b8c8dcd83a537d27f20c9cefa5` is REQUEST CHANGES, so v9 is not the review head. v9 is not amended. This head starts from `2578349bd0d2d9951aff2e4d233bec9e33c5e644`, which already holds the Sentinel name-resolver, pragma-verb, eval-plant, and scanner fixes. No constitution file exists, and none was added. No specify CLI and no new dependency. No UI change. `statementTail` in `test/sqlite.js` stays. HEAD 2 stays parked at `89c630293019cf7285265a44fb7e03a4df333f8b`.

## Red

`f8bd2a49003f011572f429bbba778348a7229cea` is tests only. `test/write-v10-door.test.js` is 4 tests, 0 pass, 4 fail. Each failure is an `AssertionError`. The product commit does not edit that file.

## Pragma tail

A parenthesized setter ends at the closing parenthesis plus one optional semicolon. It does not use the token length. `PRAGMA foreign_keys(OFF); SELECT 1` and `PRAGMA foreign_keys = OFF; SELECT 1` are `SQL_DOOR` before prepare on the schema door and on a registered migration, on both paths, and `foreign_keys` stays at the value it had. A bare `PRAGMA foreign_keys(OFF)` is still a whole-statement setter and still runs in `schema()`. An unclosed parenthesis does not consume the rest of the string.

The registered door only executes a named migration. The test enters that door and swaps the one migration exec for the attack string. None of the registered strings is a pragma.

## Eval, the chain, and shut-door verbs

`isEvalValue` peels a sequence expression the same way a call callee is peeled. `const e = (0, eval)`, `let e; e = (0, eval)`, `const e = (0, globalThis.eval)`, and `const [e] = [(0, eval)]` are violations. The plants that already passed stay.

`classifyChain` uses the captured `some` and `find`. A result that is not a boolean is tampered. A patched `Array.prototype.some` that returns false does not make a row committed before the chain-start into an open chain. Chain-start sequence numbers are copied by index. The index-definition check does not call `String.prototype.includes`. `verifiedSeqs` is written by index. The hash hex encoder and the MAC field pushes stay: a patched `map` or `push` there corrupts the digest, and verify fails closed.

`analyze`, `begin`, `commit`, `rollback`, `savepoint`, and `release` are verbs. A shut door refuses them on both paths before exec. Preparing `ANALYZE` does not create `sqlite_stat1`; exec did. `COMMIT` and `ROLLBACK` are the same shape as `BEGIN`: the native driver rejected them after prepare, and the fallback was already `SQL_DOOR`.

## Already closed on the parent

`quotedName` consumes a doubled `"` or `` ` `` before it treats that character as the closer. The unreachable branch Sentinel named on `4c11808c` is the one the parent replaced. This round does not edit it. `DELETE FROM "audit""tail"` stays `ERR_SQLITE_ERROR`, and the four scanners share `test/write-v9-sentinel.test.js`.

`pytest-asyncio` and `python-docx` are already declared in `requirements-test.txt`. No runtime dependency was added.

## Fix

`2ef51ba321acbb015c8495c2b94305be965c5eb5` is `sql-text.js`, `audit-chain.js`, and `test/write-lint.js`. It does not edit `test/write-v10-door.test.js`.

## Reinstate and the 320 px controls

Inspector's partial on `4c11808c` is folded here. `POST /api/library/:id/reinstate` with no body was 400 before the role check. `{}` was 403 for an owner. The insights change does not cover that path. The choice is in `handoff/untangle-decision-log.md`: the generic parser stays strict, and an empty reinstate body is the same call as `{}`.

Red `a9d8676b2f5535c577368174bf6bab98306582d6` is `test/write-v10-reinstate.test.js` only: 1 test, 0 pass, 1 fail, `AssertionError` expected `403` actual `400`. Fix `c896702eba8a5e51eaeb01fd6c82026f338493fb` does not edit that test. Removing the reinstate exception was 0 pass, 1 fail, the same assertion (`/tmp/v10-mut-reinstate.txt`).

Mute, Restart, and End at 320 px are `tests/studio_browser.py` line 121. `src/orb.css`, `src/voice.css`, `src/sculpture.css`, `src/shell.html`, the studio HTML aliases, and that test are identical to main `02a83b320fdf635cdd8d603a54b791a3fef59152`. PR9 does not change the UI. The overflow stays a pre-existing item. No unslop table.

## Mutations

Each one was restored and was not committed.

- The parenthesized setter consuming every remaining token: the schema native tail was 0 pass, 1 fail, `AssertionError` `SQL_MULTI !== SQL_DOOR` (`/tmp/v10-mut-paren.txt`).
- `isEvalValue` not peeling a sequence: the first comma plant was 0 pass, 1 fail, `AssertionError` expected `true` actual `false` (`/tmp/v10-mut-eval.txt`).
- `classifyChain` calling live `rows.some`: the poisoned verdict was 0 pass, 1 fail, `AssertionError` expected `false` actual `true` (`/tmp/v10-mut-some.txt`).
- Treating a null `some` result as not tampered: the same verdict was 0 pass, 1 fail, `AssertionError` expected `false` actual `true` (`/tmp/v10-mut-some-null.txt`).
- Removing `analyze` from the verb list: a shut `ANALYZE` was 0 pass, 1 fail, `AssertionError` `ALLOW !== SQL_DOOR` (`/tmp/v10-mut-analyze.txt`).
