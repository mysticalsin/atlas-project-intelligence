# Test: writable now

## Reproduction
`test/write-now.test.js` on the parent: 1 test, 0 pass, 1 fail, `AssertionError` expected `2026-11-17T05:00:00.000Z` actual `9999-01-01T00:00:00.000Z`. Log `/tmp/v6-red-now.txt`.

## Result
verified

After `b85aeace5c6530fc484c7d7ad625a4a9334f84cf` the now test and the cutoff test pass. Restoring a writable assignment: 0 pass, 1 fail, the same `AssertionError` (`/tmp/v6-mut-now.txt`). Restored, not committed.
