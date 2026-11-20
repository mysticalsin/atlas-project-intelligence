# ATLAS-PR16-LOWS

Low. Umbrella for the inspector notes on `ba26520b55c368fd013d77a2cacbc84f30259b77`.

Children: ROLE-OBJECT, DETAIL-OBJECT, CHARTS-RULES-MUTANT.

Stacked on GitHub PR #16 (`cursor/atlas-record-dialog-lows`). No new page and no new control.

## Done when

- A consultant role that is an object no longer renders `Ada ([object Object])` at 1280×800 or 390×800. A role object with its own `label` shows that label. A role object with no string or finite-number label shows `—`. A string role and a numeric role stay text. A null role adds no parentheses.
- An issue `detail` that is an object no longer renders `[object Object]`. A detail object with its own `label` shows that label. Null, an array, and a nested object show `—`. A string detail and a numeric detail stay text.
- Both sites call one shared formatter, `displayValue` in `src/display-value.js`. The module does not write markup.
- `tests/charts.test.js` kills the `e==='rules'` formula-guard mutant: with JEV on and completeness missing, the rules arm does not print `score = 0.8 × completeness`. Completeness `0` still prints that note. Removing the `c?` guard fails that test and leaves the other charts tests green. `src/charts.js` is not edited.

## Failing tests

On parent `ba26520b55c368fd013d77a2cacbc84f30259b77`, red commit `f1bc396d75617c57cd236b4b8bb7685c5b213b15`.

`node --test tests/display-value.test.js tests/charts.test.js` exits 1. 44 tests, 38 pass, 6 fail. The six failures are the formatter tests, because `src/display-value.js` is not on that commit. The charts guard test passes there: the guard is already in `src/charts.js`, and the older charts tests never enter `e==='rules'` with a missing completeness.

`CHROMIUM_PATH=/usr/bin/google-chrome python3 tests/display_value_browser.py` exits 1. 21 checks, 11 pass, 10 fail. At both widths the dialog shows `Ada ([object Object])`, `Sam ([object Object])`, and `vague metric: [object Object]`. String and number values already render as text.

TEST COMMAND:

```sh
node --test tests/display-value.test.js tests/charts.test.js
CHROMIUM_PATH=/usr/bin/google-chrome python3 tests/display_value_browser.py
```

## Where it breaks

- `src/app.js` `who` concatenates `c.role`. An object becomes the default object text inside the Consultants cell.
- `src/app.js` issue row interpolates `i.detail` through `html``. A plain object is stringified, then escaped, so the dialog shows the text `[object Object]`.
- `src/charts.js` line 173 guards the rules formula with `c?`. `e` is `q.engine` only when `opts.jev` is on. `tests/charts.test.js` called `qualityGauge({engine:'rules'})` without `{jev:true}`, so that arm was untested. Dropping `c?` still passed.

## Decision

`displayValue` is the only new formatter.

- A string is returned as text, including an empty string.
- A finite number is returned as its decimal text. `-0` is `0`.
- A plain object with its own `label`, when that label is a string or a finite number, returns that label. `name` and `text` are not labels for this function. A nested label is not followed.
- Anything else, including `null`, an array, a boolean, a non-finite number, and an object whose `toString` returns `[object Object]`, returns `—` (U+2014).
- The function never calls the DOM.

The Consultants cell calls it for a present role. A null or empty role still adds no parentheses, which is the existing empty-role line. The issue line calls it for the field and the detail, so a null detail is `—` instead of a blank colon.

`src/charts.js` stays at 56992 bytes. The new charts test passes `{jev:true}` with completeness omitted, `0`, and `40`, and checks that a review-agent score does not take the rules sentence.

## Unslop

| Surface | Removed | What the reader sees |
| --- | --- | --- |
| Consultants, 1280×800 and 390×800 | `Ada ([object Object])`, `Sam ([object Object])`, `Ivo (Lead)` from an array | `Ada (Delivery lead)`, `Sam (—)`, `Ivo (—)`. `Noor (Analyst)` and `Kai (2)` stay. `Ren` has no parentheses. |
| Issues found, same widths | `vague metric: [object Object]`, `missing source: [object Object]`, `nested detail: [object Object]`, a blank colon after `blank detail` | The label `Queue delay was not measured`, or `—`. `The pilot covered one queue.` and `4` stay. |

No new control, no new page, no new sentence. The em dash is the existing "not text" mark for this dialog, not a status.

## Red

Commit `f1bc396d75617c57cd236b4b8bb7685c5b213b15`. Counts are in the Done when section. Screenshots of that page are `issues-1280.png`, `issues-390.png`, `consultants-1280.png`, and `consultants-390.png` in the before set.

## Fix

Commit `df1913e419b273b10911f7759f5ccde553ae6739`. The same TEST COMMAND exits 0. Node: 44 pass, 0 fail, 160 ms. Browser: 21 pass, 0 fail. `tests/record_dialog_lows_browser.py`: 13 pass, 0 fail. `tests/page-pin.test.js`: 6 pass, 0 fail. Page pin `7c45b14413945a5c4107af65cafd5f4beb946b182faacab054c77d1b0167d08d`, 926037 bytes. Logo SHA-256 stays `92c5ff21779f09199097a2971c172453017f0d2581a0ced6f54fe486ba9b6c2b`.

The boundary assertion no longer stringifies `Object.create(null)` in its message. That call throws, so the red run never reached it. The fix commit is the one that makes the assertion safe.

## Mutants

Each one was restored and was not committed.

1. Rules formula guard. `src/charts.js` `e==='rules'` arm always appends `No rating engine answered (score = 0.8 × completeness)`, dropping `c?`. `node --test tests/charts.test.js` exits 1. 38 tests, 37 pass, 1 fail. The failure is `the rules formula guard hides the 0.8 note when completeness is not a finite number`. The older missing-completeness test stays green, which is why this mutant survived on `ba26520b`.
2. Formatter default string. `displayValue` returns `String(value)` for every non-string, non-finite-number, non-label value. `node --test tests/display-value.test.js` exits 1. 6 tests, 3 pass, 3 fail. The failures are null/array/nested, the boundary list, and the random-value property. Strings and label objects stay green.

## Risk

low

plan debate skipped: not high-risk (display text for values the dialog already prints; no auth, session, permission, secret, schema, or deletion change)

State-machine discovery skipped. This does not add or change a status, a phase, or a transition.

## Rollback

Revert this branch to `ba26520b55c368fd013d77a2cacbc84f30259b77`. No migration and no stored rewrite. Rebuild is `python3 build.py` with `ATLAS_HOME_URL` unset. The pin on that parent is `64228da2a3cf3ba103587d6c273bac5fa09137d6760564818bfc0e006ea2467e`, 924833 bytes.

## Known limits

`name` and `text` are not labels for `displayValue`. List items in blockers, holds, missing, and recommendations still use `item()`, which reads `label`, `name`, and `text`. A null role still omits the parentheses. `src/charts.js` and the world map are unchanged. Workerd 2026-10-23 is not installed on this machine, so the edge workerd probes skip. Not a production-ready claim. Live voice, identity, and multi-user checks in `handoff/ACCEPTANCE.md` remain open.
