# Fix: lint gaps

## Change
The walk flags a `Reflect.apply` whose argument is an exec member, `eval` after a comma or on `globalThis`, an assignment of `WeakMap.prototype`, and a default object pattern whose right-hand side is a raw handle.

## Files
`deploy/cloudflare-edge/test/write-lint.js`
