# Assessment: pragma-equals

## Symptom
PRAGMA foreign_keys = table_info and PRAGMA trusted_schema = writable_schema are classified as reads.

## Expected
Any equals sign outside a string or a comment is an assignment. The pragma name is not the word after the equals sign.

## Actual
pragmaRead takes words[i + 2] when the first word is not on the read list, and leadingWords drops the equals sign, so the value is treated as the name.

## Verdict
valid

## Severity
High. Cursor bc-9bb004c7.
