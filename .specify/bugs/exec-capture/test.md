# Test: captured exec

## Reproduction
`node --test --test-name-pattern 'patched exec does not' test/write-exec-capture.test.js`

## Result
verified

On `f8121280` the verdict is `false`. After the fix it is `true`, and the three doors still refuse. Mutation: call the captured `RegExp.prototype.test` again. The test fails `null !== true`. Restored, not committed.
