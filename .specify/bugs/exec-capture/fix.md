# Fix: captured exec

## Change
`primordials.test` calls the captured `exec`. Audit error text uses a code-point search. The tombstone check is the separate code-point fix.

## Files
`deploy/cloudflare-edge/src/primordials.js`, `audit-chain.js`
