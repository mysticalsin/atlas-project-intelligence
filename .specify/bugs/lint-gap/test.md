# Test: lint gaps

## Reproduction
`node --test test/write-lint-gap.test.js`

## Result
verified

Before the fix all four plants fail. After the fix they pass, and the earlier plant files and `lintDir` stay clean.
