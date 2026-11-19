# Fix: gate head

## Approach
This status commit is the last git commit of the round. The gate commands run after it. Their counts are written to the round report and to the store copy of the PR body, both labeled with this commit. They are not copied back into git. Verified-by stays `{{CURSOR}}` `{{DEVIN}}` `{{INSPECTOR}}`.

## Files
`handoff/BUILD_STATUS.md`. The store body is not a git file.

## Deviations
None.
