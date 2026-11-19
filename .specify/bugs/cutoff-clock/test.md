# Test: consent clock

## Reproduction
`node --test test/write-cutoff-clock.test.js`

## Result
verified

Before the fix the receipt count is 0. After the fix the receipt stays and the housekeeping error is undefined. The existing caller-date cutoff test still passes.
