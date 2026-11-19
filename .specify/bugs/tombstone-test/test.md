# Test: tombstone test

## Reproduction
`node --test test/write-tombstone-test.test.js`

## Result
verified

Before the fix the actor becomes `not-a-tombstone`. After the fix the actor stays and the error is `AUDIT_ERASURE`. The existing erasure test still passes.
