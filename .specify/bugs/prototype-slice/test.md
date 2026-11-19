# Test: slice and push

## Reproduction
`node --test test/write-prototype-slice.test.js`

## Result
verified

Before the fix: slice, last-only push, and `charCodeAt` each fail `0 !== 1`. After the fix those three, the fallback second-part push, and the built-in sweep pass.
