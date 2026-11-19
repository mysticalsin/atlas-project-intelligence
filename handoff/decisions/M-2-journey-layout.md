# M-2 — Journey layout overflow (reviewer, presales, admin)

## Context
`journey.css` fixed a 260px sidebar minimum and kept four stage columns until 800px, so mid-width viewports could widen `#journey` past the viewport.

## Decision
- Drop the 260px track floor; use `minmax(0, …)` on the two-column layout.
- Collapse the layout to one column at 960px (not 800px). Leave PR9’s `.recording-live` rule unchanged for a clean rebase.
- Let stage cards shrink with `min-width:0` and `overflow-wrap:anywhere`.

## Consequence
Journey content stays within `#journey` at 320, 375 and 1280px for reviewer, presales and admin roles.

## Evidence
`tests/journey_layout_browser.py`