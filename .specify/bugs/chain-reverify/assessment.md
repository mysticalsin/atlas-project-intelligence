# Assessment: chain-reverify

## Symptom
A callback can UPDATE audit through the raw handle and DELETE FROM refs through exec. The chain was healthy before the callback, so the write commits.

## Expected
The transaction rolls back with CHAIN_DAMAGED. The ref and the audit detail stay as they were.

## Actual
The damage check runs before the callback. A write that damages the chain during the callback, and does not call log(), is not checked again.

## Verdict
valid

## Severity
High. Cursor bc-f37cd093. This is the belt behind the denylist.
