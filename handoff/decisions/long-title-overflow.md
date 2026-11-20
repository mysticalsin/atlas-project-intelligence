# ATLAS-UI-LONG-STORY-TITLE-OVERFLOW

Low. A very long story or record title overflows its container and breaks the layout.

Main checked before this branch: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`. Branch `cursor/atlas-long-title-overflow`.

## Done when

Browser checks at 320, 375, and 1280, for a 5000-character title, a 5000-character token with no spaces, and a long title with emoji and RTL characters:

- `document.documentElement.scrollWidth <= document.documentElement.clientWidth`
- every measured title stays inside its parent
- list and card titles clamp to two lines
- detail, the record dialog, and the export preview wrap with `overflow-wrap: anywhere` and keep the full string
- the dialog title's flex child has an author `min-width` of `0`

## Failing test

File: `tests/long_title_browser.py`, last line of `make test-ui`.

Names that fail on the parent:

- `list title is clamped`
- `detail title wraps with overflow-wrap anywhere`
- `dialog title flex child can shrink`
- `export preview wraps with overflow-wrap anywhere`
- `no horizontal overflow` for the unbroken token
- `dialog has no horizontal overflow` for the unbroken token

`story title wraps in the detail` already passes. `#storyPaper h2` already has `overflow-wrap: anywhere` in `src/styles.css` (the long rule that also sets `.project-card{min-width:0}`).

TEST COMMAND:

```sh
CHROMIUM_PATH=/usr/bin/google-chrome python3 tests/long_title_browser.py
```

## Risk

low

plan debate skipped: not high-risk (shared title CSS only; no auth, session, permission, secret, schema, or deletion change)

State-machine discovery skipped. This does not add or change a status, a phase, or a transition.

## Where it breaks

`src/styles.css` already wraps `.project-card h2` and `#storyPaper h2`. The other title nodes do not.

- Library cards use `h3` (`src/app.js:247`). The `h2` rule does not apply. The card clips with `overflow: hidden`.
- `.detail-title` is a flex row. At `max-width: 800px` it becomes a block. An unbroken title is still the flex item's min-content and widens the page.
- `.dialog-head` is a flex row. `#recordTitle` (`src/app.js:283`, `src/shell.html:41`) does not wrap, so the dialog's `scrollWidth` exceeds `clientWidth`.
- `.sheet-preview h2` (`src/app.js:168`) has no wrap.
- `.experience-path strong` (`src/app.js:385`) does not wrap.
- Wiki rows, rank cards, recommendation titles, journey queue titles, and invitation titles have no clamp.

`src/engine.js:20` slices a stored project title to 140 characters and `src/engine.js:160` slices a story title to 200. A 5000-character string never survives those writers. The layout still breaks on an unbroken token at the stored length. The browser test builds the nodes through the app, then writes the long strings into them. No edit to `src/app.js`.

## Decision

One block at the end of `src/styles.css`. No per-component patch. No copy, tagline, or helper text.

List and card titles clamp to two lines: `.project-card > h2`, `.project-card > h3`, `.wiki-row > h4`, `.rank-card > h4`, `.rec > .impact-head > strong`, `.ask-result > .impact-head > strong`, `.bid-result > .impact-head > strong`, `#journey article > strong`, `.invite > div > b`, `.story-in-progress > h2`.

Detail, dialog, and preview titles wrap and are not clamped: `.detail-title h2`, `.dialog-head h2`, `.paper-head h2`, `.sheet-preview h2`, `#slidePreview b`, `.experience-path strong`.

The flex and grid children that hold those titles get `min-width: 0`. On `.detail-title` that is `div:first-child` only. The actions are also a `div`. Giving every direct `div` `min-width: 0` squeezed `.actions` to 3px, and the Continue interview button (`.btn.primary`, 82px) painted at `right: 1282` on a 1280 viewport. The title column shrinks. The buttons keep their width.

The full string stays the text of the detail heading and of `#recordTitle`. A `title` attribute would be a markup edit in `src/app.js`, and that file is owned by another PR, so it is not used. Lists keep the same string in the DOM and show two lines.

The check reads `min-width` from the author rule. In this Chrome a style rule also exposes an empty `cssRules` list, so a walk that recurses first never sees the declaration. Computed `min-width` is `0px` even when the author value is `auto`, so a computed-style check would not kill the mutant.

## Unslop

| What was broken | What changed |
| --- | --- |
| A long title on a library card was clipped with no ellipsis. The project card, the detail row, the record dialog, and the sheet preview let an unbroken token widen the page. | One shared CSS block. Lists clamp to two lines. Detail, dialog, and preview titles wrap with `overflow-wrap: anywhere`. The flex child that holds the dialog title can shrink. |
| The detail action row was crushed and the primary button stuck out by 2px at 1280. | `min-width: 0` is on the title column only. The buttons keep their width. |
| No new sentence, tagline, or helper text. | Nothing was added to the page copy. |

## Red

Test commit `379335f43f01470db11edfa084df1eb401b74bd6`. `src/styles.css` matched main. `CHROMIUM_PATH=/usr/bin/google-chrome python3 tests/long_title_browser.py` exited 1. CHECKS 83, PASS 17, FAIL 66. The story-paper checks passed. The token widened the document (320: scrollWidth 85583, clientWidth 320).

## Fix

`ed384a3db2988f19c42f9b08e8a35c8b080a8c5d` is `src/styles.css` and the author-rule walk. After it, the same command is CHECKS 83, PASS 83, FAIL 0. `c4f2dd1` only changes where the screenshot is framed. The checks are the same.

## Mutants

Restored and not committed. Each exits 1.

1. Remove `overflow-wrap: anywhere` from the detail, dialog, and preview rule. CHECKS 83, PASS 44, FAIL 39. The first failure is `320 spaced: detail title wraps with overflow-wrap anywhere` (`wrap=normal`).
2. Remove the line clamp from the list rule. CHECKS 83, PASS 65, FAIL 18. The first failure is `320 spaced: list title is clamped` (`clamp=none`).
3. Remove `min-width: 0` from the flex-child rule. CHECKS 83, PASS 74, FAIL 9. Every failure is `dialog title flex child can shrink` (`min-width []`).

## Rollback

Revert this branch to main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`. No migration and no stored rewrite.

## Loops

Verify and QA loops are capped at 3. A failed gate is fixed only for the failure that was shown.
