# ATLAS-JOURNEY-MIXEDCASE-DUP

Disposition: **BLOCKED**. Not planned.

Pinned main: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
Triage: `triage.md` sha256 `1901b48b1a44181c59cce7434460e4e1a82057b99c85b53b9f4e049261f1059d`.

No done-when, no test command, and no file ownership. A writer does not open `journey.js` for this row.

## Why it is still blocked

The backlog row still names Tony as the unblock owner. `rows-full.txt` blockers text: "Merge behaviour of existing mixed-case rows depends on Tony's ATLAS-JOURNEY-DUPLICATES cleanup answer (Jarvis batching)." `unblock_owner` is Tony. The next action on `ATLAS-JOURNEY-DUPLICATES` is "Awaiting a decision from Tony."

Checked on this main, and not resolved:

- `journey.js:68` copies mixed-case duplicates as stored. The migration does not merge them.
- `journey.js:82-84` says read and save choose one row and that nothing merges the duplicates. `JOURNEY_MATCH` (`journey.js:85`) is still case-insensitive, so read and erase already see every spelling.
- `handoff/decisions/` has no record that answers the cleanup. The twelve decision files were listed. None is the journey-duplicate decision.
- `ATLAS-JOURNEY-DUPLICATES` is classified BLOCKED in the same triage.

The proposed write-side normalisation (one new row per lowercased subject and tenant, without merging rows that already exist) is an Atlas proposal in the backlog text. It is not a recorded decision, and the row's blocker was not lifted. This batch does not plan that slice.

## APP-FIT

**FIT** as a live defect, and **BLOCKED** as work. Saving `A@x.com` and `a@x.com` in the same tenant can still produce two primary-key rows, because the key is the stored spelling (`journey.js:227`). That is unchanged. It is not a license to write the plan while Tony's cleanup answer is open.

## What a later plan would have to avoid

Merging the two stored payloads is the open question. Read, export, and erase already take every case-insensitive match. A later plan does not delete the older payload until Tony says which payload survives.

## Files

No writer. `deploy/cloudflare-edge/src/journey.js` stays with nobody in this batch. Group 10 does not edit it. The whitespace addendum says so.

## Dependencies

None. #15, #16, #23, #25, #27, #30, #35, #37, and #40 do not unblock Tony. `journey.js` is not in those diffs.
