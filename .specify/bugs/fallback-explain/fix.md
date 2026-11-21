# Fix: fallback explain

## Change
`bareSemicolon` refuses a semicolon outside a quote, a comment, or a bracket unless the text is one of the three consent triggers. `provenRead` is true only for one `select`, `pragma`, `values`, or `with` that contains no write verb, including under `EXPLAIN` and `EXPLAIN QUERY PLAN`. The fallback path treats anything else as a write before the driver.

## Files
`deploy/cloudflare-edge/src/sql-text.js`, `deploy/cloudflare-edge/src/library.js`
