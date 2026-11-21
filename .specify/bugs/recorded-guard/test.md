# Test: recorded guard

## Reproduction
`node --test test/write-recorded-guard.test.js`

## Result
verified

Before the fix the destructive cases fail as assessed. The housekeeping case already passes. After the fix all four pass, and the profile rebuild tests still pass.
