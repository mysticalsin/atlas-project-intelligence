# Assessment: insights-body

## Symptom
POST /api/library/insights with no body returns 400 Invalid JSON before the role check.

## Expected
The role check runs first. An empty body then matches {}. An owner gets 403. A reviewer gets the same status as {}.

## Actual
library-routes.js parses request.json() for every POST, and an empty body throws.

## Verdict
valid

## Severity
Low. Inspector F-5 / J05r. j-api.mjs is not in this checkout.
