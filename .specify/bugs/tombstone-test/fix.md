# Fix: tombstone test

## Change
`isTombstoneActor` checks code points through the captured `slice` and `charCodeAt`. `rewriteAudit` and `rewriteRows` accept only `true`.

## Files
`deploy/cloudflare-edge/src/audit-chain.js`, `library.js`
