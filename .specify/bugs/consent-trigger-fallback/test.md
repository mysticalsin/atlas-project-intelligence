# Test: consent trigger fallback

## Reproduction
`test/write-consent-trigger.test.js` on the parent: 3 tests, 0 pass, 3 fail, each an `AssertionError`. The node case expected the three trigger names and a kept receipt. Log `/tmp/v6-red-trigger.txt`.

## Result
verified

After `3e5f02d5c0f5dc5892eb7176193034f793709722` the file passes. Forcing every semicolon to be a tail: 0 pass, 1 fail, `AssertionError`, actual `SQL_MULTI` (`/tmp/v6-mut-trigger.txt`). Restored, not committed.
