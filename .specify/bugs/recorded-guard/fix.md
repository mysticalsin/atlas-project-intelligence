# Fix: recorded guard

## Change
For kind `recorded`, refuse `DROP TRIGGER`, and `DROP`, `ALTER`, `DELETE`, or `UPDATE` of `audit`, `audit_anchor`, and `consent_receipts`. Other drops used by the profile rebuild stay. A failed `includes` refuses.

## Files
`deploy/cloudflare-edge/src/library.js`
