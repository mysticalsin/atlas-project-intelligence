# M-2 — Journey layout (withdrawn on PR #10)

## Context
PR #10 originally added a `@media (max-width:960px)` collapse and `tests/journey_layout_browser.py`. Pre-merge inspection (Devin, head `bb14e2e`) showed the test passes on **main** `c143025` with that CSS restored after rebuild. Before/after M-2 PNGs were byte-identical.

## Measurement (synthetic fixtures, `#journey`, reviewer / presales / admin)

Command: `python3 scripts/measure_journey_overflow.py <tree>`

On **main** `c143025` and on PR10 head, every row is `scrollWidth == clientWidth` (no `#journey` overflow):

| Role | Width | scroll / client | Page overflow |
|------|------:|-----------------|---------------|
| reviewer, presales, admin | 320 | 284 / 284 | no |
| reviewer, presales, admin | 375 | 339 / 339 | no |
| reviewer, presales, admin | 1280 | 1100 / 1100 | no |

**600 px** top-bar overflow (`.top-actions` to 615 px, admin nav to 671 px) is **pre-existing on main** and is **out of scope** (Backlog).

## Decision
**Option (b):** PR9 on `main` already satisfies journey fit at 320 / 375 / 1280 for the fixtures used. Drop the **960px** rule, remove `tests/journey_layout_browser.py`, and align `src/journey.css` with `main` `c143025` (keep PR9 `.recording-live` wrap). M-2 is not a PR #10 deliverable.

## Alternatives rejected
- **Keep 960px + browser test:** Test does not go red on main; not factory red-first (loop 1 FAIL).
- **New scrollWidth assertion without reproduction:** No measured overflow on main at committed widths.

## Evidence
`scripts/measure_journey_overflow.py` on `/tmp/atlas-main-c143` and repo root after withdrawal.