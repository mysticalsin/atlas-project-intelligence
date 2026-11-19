# v6 decision log

Parent `29b0727385a54e32e646ea0f0867e9c0da7839df`. No constitution file exists at `.specify/memory/constitution.md`, and none was added. No specify CLI and no new dependency. No UI change.

## Hidden links

The classifier in `sql-text.js` had already captured `toLowerCase`, `RegExp.test`, and `RegExp.exec`, then called them through the live `Function.prototype.call`. A patch of `call` after load made `isMutatingStatement('DELETE FROM refs')` return false, `Library.exec` ran it, and the row was deleted. The same live prototypes remained on `trim`, `replace`, `some`, and `includes`, so a selective `trim` let a consent delete match the allowlist and `Array.prototype.some` returning true let a teams-seen delete match.

One module, `deploy/cloudflare-edge/src/primordials.js`, snapshots the unbound methods at load with `Function.prototype.bind.bind(Function.prototype.call)`. `sql-text.js` and the door checks in `library.js` use that module. A non-boolean, a null, or a throw counts as a write. A housekeeping or schema match counts only when the result is exactly `true`. A probe that fails at load leaves the snapshot unset, and every write is then classified as mutating.

`unparsedTail` was a second semicolon scan that did not know `BEGIN`/`END`, so a consent trigger body looked like two statements while `splitStatements` already counted it as one. The fallback is now `splitStatements(sql).length > 1`. An empty statement stays one statement. A trailing statement is still a tail. `EXPLAIN QUERY PLAN` stays a read. `EXPLAIN DELETE` still needs the door.

`privacy.ensure` caught every error from the three trigger installs, including `SQL_MULTI`, so a driver with no `node:sqlite` stored no trigger and `DELETE FROM consent_receipts` ran. `ensure` now lets that error out. `sql-tail.js` catches `DatabaseSync` throwing `Illegal constructor` and returns null, which is the same fallback.

## Surplus

`statementTail` in `deploy/cloudflare-edge/test/sqlite.js` (added in `e016bb508563597a8150bfa660fd373c290ad547`) stays. It is the test driver's mirror of the `sourceSQL` boundary the door asks for. `library.js` prefers `this.#sql.statementTail` when the driver has it. It was not required for the trigger red to fail, and it is not removed.

## Special cases left as they are

`EXPLAIN QUERY PLAN` of a delete is a read. `EXPLAIN DELETE` is a write.

The consent-retention delete still ignores the caller date and binds now minus the 2190-day policy. A 409 from the metadata log is still swallowed when the delete itself was allowed. A damaged chain is refused before that delete, and the receipt stays.

`'SELECT 1 AS begin; -- comment'` is still over-refused, because the split does not drop the comment. Left as a residual.

A registered migration may still `DROP` a live table. Those drops are the audited rebuild path. `rewriteAudit` still accepts chain-start sequence 1. A damaged chain with no personal rows still returns no `auditRefused`.

## Clock

`now` is defined once with `writable: false` and `configurable: false`. The constructor argument is the cutoff. A later assignment does not move it.
