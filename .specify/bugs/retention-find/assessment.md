# Assessment: retention-find

## Symptom
Array.prototype.find that rewrites only the drafts category into a consent window of -24 hours sweeps a current receipt.

## Expected
The receipt stays. The category is the consent_receipts row from the policy.

## Actual
consentCutoff uses the live find. A find that always returns a fake category fails closed in the chain classifier, so the red is selective.

## Verdict
valid

## Severity
Medium. Cursor bc-f37cd093. The site is library.js consentCutoff.
