# Test: primordial call

## Reproduction
`node --test test/write-primordial-call.test.js` on the parent: 4 tests, 1 pass, 3 fail. The three failures are `AssertionError` `0 !== 1`. The passing test is the recorded insert under the same poison. Log `/tmp/v6-red-primordial.txt`.

## Result
verified

After `e31b2ee20560f103f644562cd68a65353991483d` the same file passes. Re-run with the other v6 reds: 18 pass, 0 fail. Re-breaking `verbOf` to use live `.call` and to treat null as not a verb: 3 pass, 1 fail, `AssertionError` expected 1 actual 0 (`/tmp/v6-mut-call.txt`). Restored, not committed.
