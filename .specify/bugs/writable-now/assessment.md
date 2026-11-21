# Assessment: writable now

## Symptom
`lib.now` is assigned in the constructor and stays writable. Replacing it with a clock of year 9999 makes the consent cutoff delete a current receipt.

## Expected
The clock passed to the constructor is the cutoff. A later assignment does not change it.

## Actual
On the parent, `lib.now()` became `9999-01-01T00:00:00.000Z`.

## Verdict
valid

## Severity
Low (L-A).
