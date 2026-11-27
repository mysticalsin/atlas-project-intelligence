# Assessment: date-parse

## Symptom
Date.parse that rewrites only the clock stamp sweeps a current consent receipt during the retention delete.

## Expected
The receipt stays. The cutoff is the captured parse of the clock minus the policy window.

## Actual
consentCutoff, isoFrom, and finiteIso call the live Date.parse. A constant 9999 return fail-closes in the round trip, so the red is selective.

## Verdict
valid

## Severity
Medium. Cursor bc-f37cd093. This removes the v7 Date.parse residual.
