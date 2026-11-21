# Test: illegal constructor

## Reproduction
The second and third tests in `test/write-consent-trigger.test.js` on the parent: `AssertionError` actual `Illegal constructor`, including the workerd body at compatibility 2026-09-01. The test skips with `workerd 2026-10-23 is not installed; set ATLAS_WORKERD_ROOT` when the binary is absent.

## Result
verified

Both cases pass after `3e5f02d5c0f5dc5892eb7176193034f793709722` on workerd 2026-10-23.
