# Fix: sql shape trim

## Approach
`sqlShape` runs `replace`, `trim`, and `lower` from `primordials.js`. Any result that is not a string becomes an empty shape, which matches no allowlist entry.

## Files
`deploy/cloudflare-edge/src/primordials.js`, `deploy/cloudflare-edge/src/sql-text.js`.

## Deviations
None. This is the same commit as the call poison.
