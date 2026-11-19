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
