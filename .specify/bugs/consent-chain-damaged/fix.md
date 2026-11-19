# Fix: consent delete on a damaged chain

## Approach
Before the consent-retention delete, `chainVerdict()` must be ok. Otherwise `exec` throws `CHAIN_DAMAGED` and does not run the delete.

## Files
`deploy/cloudflare-edge/src/library.js`.

## Deviations
The first red did not damage the chain. The corrected test is a separate test commit. The product commit does not edit the test.
