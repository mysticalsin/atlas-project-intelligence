# Fix: recorded trigger

## Approach
A `CREATE TRIGGER` whose door is not `schema` or `registered` throws `SCHEMA_DML` before the driver runs it. The three consent triggers are still installed inside `schema`.

## Files
`deploy/cloudflare-edge/src/library.js`.

## Deviations
None.
