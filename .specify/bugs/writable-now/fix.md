# Fix: writable now

## Approach
`now` is defined with `Object.defineProperty`, `writable: false`, `configurable: false`. It is not part of the `Object.assign`.

## Files
`deploy/cloudflare-edge/src/library.js`.

## Deviations
None. Callers still read `lib.now()`.
