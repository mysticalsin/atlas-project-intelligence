# Assessment: eval-binding

## Symptom
const { eval: e } = globalThis, const k = 'eval'; globalThis[k](), and const [e] = [eval] are not lint violations.

## Expected
Each plant is a violation. (0, eval)('1') stays a violation.

## Actual
The alias walk only records an Identifier initialized from eval or from a member named eval.

## Verdict
valid

## Severity
Low. Cursor bc-9bb004c7.
