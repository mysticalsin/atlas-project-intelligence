# Fix: consent clock

## Change
`isoFrom` calls the captured `toISOString` and accepts it only when it is a 24-character finite ISO string of the same millisecond. `consentCutoff` throws `SQL_DOOR` otherwise.

## Files
`deploy/cloudflare-edge/src/primordials.js`, `library.js`
