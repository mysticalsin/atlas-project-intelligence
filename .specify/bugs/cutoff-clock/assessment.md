# Assessment: consent clock

## Symptom
`Date.prototype.toISOString` returning `9999-01-01T00:00:00.000Z` moves the consent cutoff. A receipt stamped at the clock is swept.

## Expected
The cutoff is formatted from a method captured at load, and refused unless it is a finite ISO string of that millisecond.

## Actual
The red leaves 0 receipts. `AssertionError` `0 !== 1`.

## Verdict
valid

## Severity
Medium. Cursor bc-130a631f. `Date.parse` of the clock string is still live.
