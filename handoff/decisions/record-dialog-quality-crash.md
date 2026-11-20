# ATLAS-RECORD-DIALOG-QUALITY-CRASH

Medium. Display crash when a seeded reference is opened.

Main checked before this branch: `c14302590e78b0319baab5893ef8c378b1c0bdf1`. `origin/main` was that same commit. It had not moved.

## Done when

- `python3 tests/record_dialog_quality_browser.py` exits 0.
- The local edge seed for Northwind queue pilot is still exactly `{status: "ready", score: 80, engine: "rules"}`. The object has no `blockers` key and no `missing` key.
- Opening that record renders the reference dialog, with the title `Northwind queue pilot` and the text `Quality 80`, and with no page error and no console error.
- That holds for reviewer (`ATLAS.Reviewer`), pre-sales (`ATLAS.Presales`), and admin (`ATLAS.Admin`), each at 320 px and at 1280 px.
- A mutant that puts `.length` back on those arrays makes that same test fail. The mutant is not committed.

## Failing test

Name: `tests/record_dialog_quality_browser.py`

The checks that fail on the parent are the six render checks and the six console checks. The first one is `reviewer 320 dialog renders the sparse quality record`.

TEST COMMAND:

```sh
python3 tests/record_dialog_quality_browser.py
```

## Risk

low

plan debate skipped: not high-risk (a display guard for arrays the seed already omits; no auth, session, permission, secret, schema, or deletion change)

State-machine discovery skipped. This does not add or change a status, a phase, or a transition. `publicationStatus` is untouched.

## Where it breaks

- Seed: `deploy/cloudflare-edge/dev/local-edge.mjs` lines 105 and 108. Older notes said lines 80 and 83. The current lines write `quality: { status: 'ready', score: 80, engine: 'rules' }` and the same shape with score 70.
- UI: `src/app.js` `showRecord`, line 285. Older notes said lines 262 and 285. The current line reads `q.blockers.length` and `q.missing.length`. `q.holds?.length` on that same line already tolerates a missing array. Line 286 reads `q.issues.length` and `q.recommendations.length`. The seed omits those too, so guarding only the first pair still throws `Cannot read properties of undefined (reading 'length')`.

## Decision

The UI treats a missing `blockers`, `missing`, `issues`, or `recommendations` array as empty, with the same `?.length` already used for `holds`. An empty list renders nothing. That is the existing branch. No new sentence is added.

The seed does not gain empty arrays. Filling `blockers` and `missing` on the seed would hide the crash, and reverting the guard would leave the new test green. The test requires the Northwind quality object to stay exactly `{status, score, engine}`.

## Rollback

Revert this branch to main `c14302590e78b0319baab5893ef8c378b1c0bdf1`. No migration and no stored rewrite.

## Loops

Verify and QA loops are capped at 3. A failed gate is fixed only for the failure that was shown.
