# Fix: slice and push

## Change
`primordials.js` snapshots `slice`, `push`, and `charCodeAt` with the same uncurry, and checks the span and the stored value. `sql-text.js` uses those. `sql-tail.js` returns null when the slice is not the suffix.

## Files
`deploy/cloudflare-edge/src/primordials.js`, `sql-text.js`, `sql-tail.js`
