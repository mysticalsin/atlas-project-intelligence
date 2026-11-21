# Untangle decision log (v9)

Parent is the frozen v8 head `b9d1ac135fd6ea5bf171a1832448419ea608e1f0`. No constitution file exists, and none was added. No specify CLI and no new dependency. `statementTail` in `test/sqlite.js` is unchanged.

## One token stream

`sqlTokens` in `deploy/cloudflare-edge/src/sql-text.js` is the scanner the classifiers use. It drops comments, omits string literals, unquotes identifiers, lowercases them, and keeps `=`, `(`, `)`, `.`, and `;` as their own tokens. A pragma name is the word after `PRAGMA`, or the word after a schema dot. A two-word name is accepted only across `.`. Any `=` token means the statement is not a read, including when the value is an allowlisted read name.

`leadingWords`, `pragmaClass`, `pragmaRead`, `pragmaSetter`, and `writableAssignment` read that stream. They do not scan the raw text for `=`.

`splitBody` still walks characters. It is the trigger-boundary splitter: `BEGIN` / `END` depth and a dotted `begin` are a state machine, and the three consent triggers depend on that split. Pragma classification does not use it to decide whether a name is quoted or whether an equals sign is an assignment. The whole string is classified with `sqlTokens` before `statementTail` or `exec`, so a pragma later in a multi-statement string is refused before the first statement is prepared.

## Fallback lexer (v12)

The fallback classifier had a third bypass of the same shape: a second scan disagreed with the lexer about a parenthesis inside a quote, so a WITH write was treated as a read and the door did not run. The fix is not another quote special case.

`sqlTokens` is the one lexer for that decision. It handles `'...'`, `"..."`, `[...]`, and `` `...` ``, drops comments, and records the parenthesis depth on every token. A parenthesis inside any of those quotes is not a depth change. `hasStatementVerb`, `readWords`, and `mutatingBody` read those tokens. None of them walks the raw characters. The statement verb is the first verb keyword at depth 0 after the CTE list. A name or an alias, including one spelled like a verb, is not that verb.

`provenRead` uses the same semicolon tokens for a second statement. `splitBody` remains the trigger-boundary splitter, and `scanSemi` remains the door's bare-semicolon check. Those two are not the verb decision.

The primary door asks that same lexer. `hiddenWrite` is `!provenRead` when the first word is `WITH` or `EXPLAIN`. `EXPLAIN QUERY PLAN` stays a description on the primary door. The door refuses a statement when it is a mutation, when `hiddenWrite` is true, or, on the fallback door, when it is not a proven read. A parenthesis inside `'...'`, `"..."`, `[...]`, or `` `...` `` cannot make a WITH write look like a read on either door.

## Authorizer

`node:sqlite` `DatabaseSync` on this host (Node v22.23.4) exposes `aggregate`, `applyChangeset`, `close`, `exec`, `function`, `prepare`, and the load-extension and session methods. It has no `authorizer` and no `setAuthorizer`. `StatementSync` has no `readonly` and no `readOnly`. `constants` has no `SQLITE_DBCONFIG_DEFENSIVE` and no db-config name. Devin's partial on `4c11808c` confirmed the same three gaps. The fallback path hides `process.getBuiltinModule('node:sqlite')`, so it cannot install a callback either. Both paths stay on the text classifier. A miss there is a direct bypass. No package was added.

## Empty trailing statements

`SELECT 1;;` is `SQL_MULTI` on both paths. One trailing semicolon on a proven read, including `PRAGMA user_version;` and `PRAGMA table_info(refs);`, is one statement. A second statement, including one after a pragma read, stays refused.

## Schema pragma setters

The schema door and a registered migration may set only `user_version` and `foreign_keys`, and only when that assignment is the whole statement. No registered migration sets a pragma. Every other non-read pragma, including `writable_schema`, `trusted_schema`, `recursive_triggers`, `journal_mode`, a `schema_version` assignment, and an unknown name, is `SQL_DOOR` before prepare in every door, including schema. `foreign_keys` applies at prepare, so a `foreign_keys` assignment outside schema and registered migrations is refused before `statementTail`.

## Manifest

`MANIFEST.json` is the received 12.1 package dated 2026-09-26. Regenerating it is out of scope. Inspector F-4 stays a residual. `scripts/check_handoff.py` failing `manifest-content` is that staleness.

## Reinstate body

Inspector J05r on `4c11808c`: an owner `POST /api/library/:id/reinstate` with no body is 400 `Invalid JSON.` from the generic parse, before `reinstate()` and its role check. The same call with `{}` is 403. The insights empty-body change does not cover this path. Reinstate does not read the body.

The generic parser stays strict. An empty body on upsert and the other body-using POSTs is still invalid JSON. A role check copied into the route, before the row lookup, would return 403 for a missing id, while `{}` returns 404. Those two statuses would still disagree.

The route that does not use the body is the layer that changes. An empty reinstate body is `{}`, and then `reinstate()` runs. Non-empty invalid JSON is still 400. An owner of an existing row gets 403 either way. A reviewer gets the same status either way. A missing id is 404 either way.

## Variable tokens (v13)

`sqlTokens` follows SQLite `tokenize.c` for `?NNN` and for `$` `:` `@` `#`. A named token includes `::` segments and one `(...)` suffix. That suffix stops at the first `)`, at sqlite3Isspace (tab, LF, VT, FF, CR, space), or at the end. A quote or a comment inside the suffix is text. `splitBody`, `scanSemi`, and `placeholderCount` skip the same span, so a semicolon inside it is not a second statement and a `?` inside it is not a bind hole. `$` inside an identifier, as in `x$y`, stays part of that word.

`Library.exec` calls `namedVariable` before prepare and before the multi-statement check. A `$` `:` `@` `#` token with at least one IdChar is `SQL_DOOR` on both doors. `?` and `?NNN` are not. An unterminated quote, identifier, or block comment is the same refusal. A write verb inside a CTE body, or after the depth-0 verb, is a write on both doors. `REPLACE(` stays a function. `EXPLAIN QUERY PLAN` of one delete stays allowed on the primary door and `SQL_DOOR` on the fallback. The record is in `handoff/v13-decision-log.md`.

## Artifact lifecycle (A21 P1)

The page pipeline's publish rule is a reducer in `scripts/artifact_lifecycle.py`. `transition(state, event)` returns the next state or `IllegalTransition`. It does not read the environment, write a file, or call wrangler.

`publish_ok` is illegal unless the state is `Verified` and `g_verified_packet` passes: a version-1 packet, `verified` true, and head and tree equal to the checkout named on the event. A state whose name is `Verified` and whose packet is missing is the same refusal.

Callers stay on the shell. `build.py`, `scripts/verify_page_build.sh`, `deploy/cloudflare-edge/deploy.sh`, and `scripts/check_handoff.py` do not import this module. Deploy still compares `generated/PAGE_SHA256.txt`. Wiring the reducer into deploy is P3. That step is release gating and is not this change.

The pin writer emits the committed line: lowercase sha256, two spaces, byte length, `ATLAS_HOME=`, two spaces, `ATLAS_HOME_URL=`. The committed file on `8b0972ec` uses `ATLAS_HOME_URL=unset`. Question 8 of the R1+R2 plan stays open. This writer matches that file. It does not decide that the token is frozen.

## Artifact lifecycle, loop 2

Inspector on `25867728`: `True` and `1.0` passed `version != 1` and `publish_ok` reached `Deployed`. The version is the integer 1. `type(value) is int` rejects a boolean, a float, and a string. `load_packet`, `g_packet_head`, and `g_verified_packet` share that check.

The built length field is `bytes`, the name in the A21 state table. The pin parser returns that same key.

`g_stale_pin_file` is on `pin_ok` and on `publish_ok`. A leftover pin whose digest differs from the built page is `IllegalTransition`. No leftover file still passes.

`g_verified_packet` reads the packet stored on the state. It does not borrow a packet from the event. `verify_ok` still takes the packet from the event, because that is the step that stores it.

The reducer stays unwired. P2 is the first caller, when the verify script writes the gate packet. P3 is the slice that connects `publish_ok` to `deploy.sh`. This loop does not edit those scripts.

Devin on the same head, gate `r4b48a352`: negating each of the 70 `if` tests left five survivors. A present `deploy_record` whose `packet_sha256` is not the packet digest is `IllegalTransition` at `g_packet_witness`, and so is a record that is not a dict. A missing record still verifies. A packet pin whose page digest is not `hash_before` is `IllegalTransition` at `g_post_test_hash`. An edit event carries a different head and a different tree from the state, and both are copied. `g_stale_pin_file` stays on `pin_ok` and `publish_ok`.
