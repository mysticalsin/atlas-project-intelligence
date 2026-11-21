# ATLAS-INVITE-SOURCE-200CAP

Disposition: **ADDENDUM** to Sweep 01 group 10. Not a parallel plan.

Group 10 plan: `docs/sweeps/s01/plans/group-10-erasure-tenant.md` on PR #38, branch `cursor/atlas-s01-high-plans`, head `4d15c83c7485c6e73cd50d1f2eded3824a636526`. head `4d15c83c7485c6e73cd50d1f2eded3824a636526`. Devin r8a2f8337 pins PR #38 there, not `a5a24e1`. The branch tip at this freeze is `73dd4df385ee0dbf5f29d00afdf465ea95ea125b` (v4). These addenda cite `4d15c83c`. They do not edit `docs/sweeps/s01/plans/`.

Pinned main: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
Triage: `triage.md` sha256 `1901b48b1a44181c59cce7434460e4e1a82057b99c85b53b9f4e049261f1059d`.

Same `invite` store line as the spoof addendum. One writer, one expression. The spoof addendum drops `body.source`. This addendum drops the prefix cut on the actor that remains.

## APP-FIT

**ADAPT** against main `8b0972ec`.

The cut is still there: `str(b.source || actor, 200)` at `library.js:1375-1378`. `str` collapses whitespace and keeps 200 code points. Two actors that share that prefix store one `source`. Erase matches the full alias (`operate.js:109`), so erasing the 200-character actor scrubs the longer actor's row as well.

The adaptation: `invitation-tenant-erase.test.js` now pins the cut. `pinning: invite stores the first 200 characters of a 201-character actor` expects the stored source to be the first 200 characters. That pin locks the bug. The writer rewrites it, in the same change, to `pinning: invite stores a 201-character actor whole`. The stored source is those 201 characters, not a prefix. `email()` is not edited. Devin r8a2f8337. Leaving the old pin green means the fix cannot land.

A 73-character `tid:oid` and a normal mailbox are inside 200 today. They are not the collision. The collision is any actor longer than 200.

## Done when

- `invite` stores the verified actor with end-trim and without a prefix cut, for every actor whose JavaScript `.length` is 254 or less. 254 is UTF-16 code units, the measure `email()` already uses (`util.js:9`, `e.length <= 254`). It is not a UTF-8 byte length and not an `Array.from` code-point length. RFC 5321's 254 is octets. This addendum does not switch the check to bytes, and it does not edit `email()`. A BMP actor of 254 code units is stored whole. A BMP actor of 255 code units is 400. An actor whose `.length` is 254 and whose UTF-8 size is greater than 254 is still stored, because the bound this code already uses is `.length`. Sentinel v2, info on review `7343b668` of `2f890c3d` (R4), is this sentence. A `tid:oid` fits. 201 code units are stored whole.
- An actor longer than 254 characters is 400, and no invitation row is inserted. The function does not store a shared prefix.
- Erase of a 200-character actor scrubs only the row whose stored source is that whole actor. A longer actor that begins with those 200 characters is kept, source unchanged, and is not in the scrubbed count.
- The `<= 60` prefix arm in `operate.js:105` stays. `ATLAS-ERASE-PREFIX-ARM-TEST` is already fixed on main, and `ATLAS-LEGACY-PREFIX-RECEIPT` is still Tony's decision. This addendum does not delete that arm and does not scrub legacy 60-character prefixes.
- `util.js` `email()` is not edited. Its 200-character slice is a different cap, on addresses, owned by group 5.

## Failing test

Name: `erasing a 200-character actor does not scrub a longer actor that shares that prefix`

On this main both rows store the same 200 characters, and the erase reports both scrubbed.

The rewritten pin, same change: `pinning: invite stores a 201-character actor whole`. On this main that assertion fails because the store cuts at 200. After the fix it passes. The old pin name is removed so the suite cannot keep requiring the cut.

TEST COMMAND:

```sh
cd deploy/cloudflare-edge && node --test --test-name-pattern "does not scrub a longer actor" test/backlog-g10-invite-erase.test.js
cd deploy/cloudflare-edge && node --test --test-name-pattern "201-character actor" test/invitation-tenant-erase.test.js
```

## Files owned

None as a separate writer. The group 10 writer edits the stored-source expression in `deploy/cloudflare-edge/src/library.js` and rewrites the 201-character pin in `deploy/cloudflare-edge/test/invitation-tenant-erase.test.js`. The new collision test goes in `deploy/cloudflare-edge/test/backlog-g10-invite-erase.test.js`.

Do not edit `operate.js` for this row except to leave the 60-character arm alone. Do not edit `util.js`.

## Risk

High. Storing an unbounded actor would let a reviewer write a very large `source`. The 254 refusal is the bound, and it refuses instead of cutting. Two actors that differ only after 254 characters cannot both be stored. That pair cannot be a legal mailbox either. Rewriting the existing pin is required. A writer who only adds a new test and leaves the old pin will have a red suite after a correct fix, or will revert the fix to satisfy the pin.

## Rollback

Revert the store expression and restore the 201-character pin. Rows stored whole stay whole. Erase of a short actor no longer matches them, which is the safe direction. Legacy 60-character prefixes are unchanged.

## Dependencies

| PR | On this row |
|---|---|
| #15 | No. |
| #16 | No. |
| #23 | No. |
| #25 | No. |
| #27 | Do not edit `test/sqlite.js`. |
| #30 | No. |
| #35 | Overlaps `library.js` and `util.js`. Bring the `invite` line in with an ordinary merge of #35. Do not rebase that pushed branch. Do not edit `email()`. |
| #37 | No. |
| #40 | No. |

Also open: PR #34 and PR #2 edit `library.js`. Bring both in with an ordinary merge. Do not rebase those pushed branches. Apply this expression in the same edit as the spoof addendum so the line is written once.

## Branch base

main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`. Bring in, by ordinary merge, PR #34, PR #35, PR #2, and PR #41 (`097c5c6680d1b8cfd55db23d39cd027ff69c9133`, `cursor/atlas-living-cv`). Do not rebase those pushed branches. PR #41 also edits `operate.js` (living import, `privacyRoutes`). Those hunks do not overlap this addendum. Do not revert them.

## Known limits

- The new pin stores a 201-character actor whole. `email()` is not edited.
- 254 is JavaScript string `.length` (UTF-16 code units), the same measure `email()` uses. It is not a UTF-8 byte length.
- The `<= 60` prefix arm stays. ATLAS-LEGACY-PREFIX-RECEIPT remains Tony's decision and is not asked here.

## Ask

| Ask | None. This row does not ask Tony. The legacy 60-character prefix receipt is a different row. |

## Tony source

The backlog row has no separate tony-verbatim card. The title below is copied verbatim from `rows-full.txt`.

> invite() stores source cut at 200: erasing a 200-character identity scrubs a longer actor with the same prefix
