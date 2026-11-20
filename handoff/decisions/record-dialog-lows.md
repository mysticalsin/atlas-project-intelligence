# ATLAS-RECORD-DIALOG-LOWS

Low. The Northwind seed dialog prints threshold and completeness with no numbers, and a corrupt stored list throws out of `openRecord`.

Main checked before this branch: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.

## Done when

- `CHROMIUM_PATH=/usr/bin/google-chrome python3 tests/record_dialog_lows_browser.py` exits 0.
- The seeded Northwind record renders with no blank labels. The quality line is `Ready for use`. The gauge center is `of 100`. There is no Completeness row with an empty meter, and no invented threshold `75`.
- A non-array list, a null list, a malformed JSON list, and a wrong item type each open the dialog with no unhandled rejection and a safe empty or fallback list.
- The seed quality object stays `{status: "ready", score: 80, engine: "rules"}`.

## Failing tests

File: `tests/record_dialog_lows_browser.py`

- `seed record at 1280 renders with no blank labels`
- `seed record at 375 renders with no blank labels`
- `non-array list opens with a safe empty list`
- `null list opens with a safe fallback list`
- `malformed JSON list opens with a safe empty list`
- `wrong item types open with a safe empty list`

TEST COMMAND:

```sh
CHROMIUM_PATH=/usr/bin/google-chrome python3 tests/record_dialog_lows_browser.py
```

On the parent those six checks fail. The two seed-shape checks pass. Exit 1. `2 pass, 6 fail`.

## Risk

low

plan debate skipped: not high-risk (display guards for numbers and lists the seed already omits; no auth, session, permission, secret, schema, or deletion change)

State-machine discovery skipped. This does not add or change a status, a phase, or a transition.

## Where it breaks

- Seed: `deploy/cloudflare-edge/dev/local-edge.mjs` line 105. Quality is `{ status: 'ready', score: 80, engine: 'rules' }`. No `readyScore` and no `completeness`. The twin at line 108 is the same shape with score 70.
- Quality line: `src/app.js` line 284 always printed `· threshold ${q.readyScore} · completeness ${q.completeness}`. `html` prints nothing for `undefined`, so the words stayed and the numbers did not.
- Gauge: `src/charts.js` line 171 used `75` when `readyScore` was not a number, and `tr` still emitted a Completeness row with an empty meter when `completeness` was missing.
- Lists: `src/app.js` line 278 defined `list` as `(a||[]).join`. A string such as `[not-json` is truthy and has no `join`. Line 285 used `q.blockers?.length` and then `.map`. A string has a length and no `map`. The same hole was on `holds`, `missing`, and `recommendations`. Line 286 called `i.kind.replace` with no string check. Line 291 read `d.answers[i]`. A null `answers` throws. Line 277 called `showRecord` outside the `try`.

## Decision

No new sentence and no new label.

`showRecord` appends ` · threshold N` and ` · completeness N` only when the value is a finite number. `0` still prints. A missing `aiScore` stays `!= null`.

`qualityGauge` draws the threshold tick, the aria label, and the center text only when `readyScore` is a finite number. It does not substitute `75`. A track row is drawn only when a value was passed and that value is a finite number. A one-argument note (`Review agent unavailable` / `No rating engine answered`) stays the empty-meter row. Numeric fixtures in `tests/fixtures/quality-gauge-before-jev.json` stay byte-identical. The seed still shows `Review agent unavailable (score = 0.8 × completeness)` because that sentence is the no-JEV gauge for a rules object, and switching it would break the U4 lock. `src/charts.js` stays at or under 57000 bytes. The comment above `qualityGauge` was shortened so the guard fits. The file is 56998 bytes.

A stored list is used only when `Array.isArray`. Otherwise it is `[]`. Joined cells keep strings and numbers. Issue rows render only when `kind` is a string. Consultant and link items render only when they are objects. `answers` uses the same array guard. A missing answer stays `Not covered yet`. An empty table cell stays `Missing - to confirm`.

`openRecord` toasts `e.message` if `showRecord` throws. The dialog opens because the list guard runs first. A rethrow in that catch stays green once `showRecord` no longer throws, so the tests lock the guard.

`tests/record_dialog_quality_browser.py` had locked the blank line. Those two expected strings are now `Ready for use` and `Ready for use · review agent 0`. The dialog, title, `Quality 80`, and console checks stay. The seed is not filled in.

## Red, then fix

Red `f97b37c15405b7323dbd2b832529f3d223335697` is the new browser test and the Makefile line. `src/` matched main. Exit 1. `2 pass, 6 fail`. The seed line was `Ready for use · threshold · completeness`. The gauge center was `of 100 · threshold 75`. The corrupt lists rejected with `q.blockers.map is not a function`, `Cannot read properties of null (reading '0')`, `(a || []).join is not a function`, and `i.kind.replace is not a function`.

Fix `383ab2df23c434d6000c0eaf95cf98282c73255a`. The same command exits 0. `8 pass, 0 fail`. `node --test tests/charts.test.js` is 36 pass. The page pin is `60986164a5d2b0fe6a96d4f2ac62137c42d0211d281d1bfb2b6726885562ed0a`, 924451 bytes.

## Rollback

Revert this branch to main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`. No migration and no stored rewrite.

## Loops

Verify and QA loops are capped at 3. A failed gate is fixed only for the failure that was shown.

## Fix round 1

Inspector QA on `499004d35c65b1b678de488949f1a062cda5c3c9` is PASS WITH NOTES. No Devin note had landed when this round was written. The GitHub `test` job did not start: Actions budget. That is not a code change.

Object items in blockers, holds, missing, and recommendations use `label`, `name`, or `text` when that value is a string or a number. Anything else is dropped. The cell never prints `[object Object]`. A consultant uses the same rule. An array has no name, so it is dropped and does not print `undefined`. A link that is not a plain object with a url is dropped the same way.

`openRecord` already toasts a throw from `showRecord`. The new check installs a getter on the fetched record that throws `record field threw`. The dialog stays closed, the toast shows that message, and there is no unhandled rejection. Removing the `try` makes that check fail.

A track with a label and a non-finite value is the dashed `is-tbd` placeholder, not an omitted row. A blank label is still omitted. The sentence `score = 0.8 × completeness` is rendered only when completeness is a finite number, including 0. Numeric fixtures stay byte-identical. `src/charts.js` is 56992 bytes. The seed quality line stays `Ready for use` and the center stays `of 100`. The seed now also shows the Completeness placeholder and does not show the formula.

Red `58c0402a72286f697534fb924a51fb9b9b91e8cc` is tests only. `tests/record_dialog_lows_browser.py` exits 1, 10 pass, 3 fail: object items, consultant arrays, and the placeholder. The throwing-field check already passes. `tests/charts.test.js` is 36 pass, 1 fail, on the placeholder assertion.

Fix `1fd36ea9a87ca5926902f3cb892f05fb04003abc`. The browser command exits 0, 13 pass. The charts file is 37 pass. The page pin is `64228da2a3cf3ba103587d6c273bac5fa09137d6760564818bfc0e006ea2467e`, 924833 bytes. The seed assertion now expects the placeholder. That is the inspector's correction, not a weaker blank-label check. The quality line still must not say threshold or completeness without a number.

## Fix round 2

Loop 2 of 3. Devin's gate on `ba26520b55c368fd013d77a2cacbc84f30259b77` is CODE INCOMPLETE. Four mutants still passed. This round adds tests for those four. `#23` (`cursor/pr16-lows-safe-render`) is stacked on this branch and appends to `tests/charts.test.js`. The new gauge checks are in `tests/record_dialog_lows_gauge.test.js`. The browser file gains two cases at the end. `tests/charts.test.js` is not edited.

A nameless object in a list is dropped. The quality text does not contain `{` or `"`. An empty track label, a whitespace label, `null`, and `undefined` draw no row. A label with text still draws. With JEV on, a rules engine omits `No rating engine answered (score = 0.8 × completeness)` when completeness is missing or `NaN`, and shows it when completeness is `0`. An array link is dropped. An object link with a url stays.

The whitespace check failed on the parent. `tr` used `l`, and a space is truthy, so the row was drawn. That is the one product change: `l?.trim()`. `src/charts.js` is 57000 bytes. U4 stays byte-identical.

Tests `6906e27c15188703bdc072bfd13abb04a4919313` are the two test files. On that commit the gauge file exits 1, 1 pass, 1 fail, on the space label. The browser file exits 0, 15 pass.

Fix `f9212e93a3d40d3345d8a0c4570fc6f8b439ee83`. The gauge file exits 0, 2 pass. The browser file exits 0, 15 pass. The page pin is `a67b88e1aee140292de864fba322d3c3d6963c34fa77a2e74839e8e88c7ad0da`, 924841 bytes.

Mutants, each restored, each exit 1:

- Object branch replaced with `return JSON.stringify(x)`. Browser 14 pass, 1 fail: `a nameless object list item is dropped and not JSON`. The older object-list check stays green.
- `tr=(l,v)=>true?`. Gauge file 1 pass, 1 fail: `an empty or whitespace track label renders no row`, on label `""`.
- Rules formula always rendered. Gauge file 1 pass, 1 fail: `formula absent missing`. `tests/charts.test.js` stays 37 pass, 0 fail.
- `Array.isArray(l)||` deleted. Browser 14 pass, 1 fail: `an array link is dropped and an object link stays`.
