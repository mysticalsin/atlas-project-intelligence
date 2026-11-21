# Fix: consent trigger fallback

## Approach
`unparsedTail` is `splitStatements(sql).length > 1`. `privacy.ensure` no longer catches the trigger installs.

## Files
`deploy/cloudflare-edge/src/sql-text.js`, `deploy/cloudflare-edge/src/privacy.js`.

## Deviations
None. Alias and `EXPLAIN` attacks stay `SQL_MULTI`. `EXPLAIN QUERY PLAN` stays a read.
