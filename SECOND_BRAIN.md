# Second brain — run72

## Completed this run
- Senior review of the run71 inventory was applied on `cursor/state-machines-atlas` from `50c2dc05`.
- Breaker: a probing fail re-opens even without `event.trial` (`07a613b`).
- Admin: `boot_error` is in the reducer and tested (`0663f26`). The page still shows the permissions banner. A new outage sentence was not approved.
- Publication: golden tests for every `deriveStatus` combination (`6fc9aa1`). No reducer. A revision resets validation, so an unapproved revision derives `in_review`, not `published`.
- Inventory rows 18–21: revision reopen (folded with row 9, LATER), invitation status (LATER), JEV consent (NOT A MACHINE), rating in flight (LATER).
- Suites at `6fc9aa1`: pytest 307; root node 389 pass and 1 skip (390 tests); edge 623; spend-ledger 16; early-processing 28; browser 21 scripts, 822 PASS.

## Lessons
- A half-open phase is the trial. A flag on the event can be omitted by a caller, and the phase still has to re-open the breaker.
- `open:succeed` and `open:fail` are legal because a request admitted while closed can settle after another request has opened the breaker.
- Do not invent dashboard copy to distinguish an outage from a permissions refusal. Put the state in the reducer, leave the sentence, and mark the paint LATER.
- A leftover `validated` flag publishes in `deriveStatus` (`library.js:109`). The revision writer at `library.js:288` replaces that object, so the stale flag is not what a revision stores. Pin both facts. Do not file an expected-fail for a shape the writer does not produce.
- Rejection logs stay ids, phase and event. The breaker has no id. It must not log the key.

## Follow-up
- Painting admin `boot_error` is LATER until an outage sentence is approved. The permissions banner is still what a thrown `bootInfo()` shows.
- Row 9 reducer is still unwritten. High rows 1–12 and 18 stay pending review. Invitation status (19) and in-flight rating (21) are medium and were not started.
- `deriveStatus` ignores `merged_into`. `merge` writes the status column to `withdrawn` directly (`library.js:593`). A later `setState` would recompute from `withdrawn`, which merge does not set. `storeRating` and `access` refuse a merged row, so the column is not rewritten by those paths.
- Run71 follow-ups still open: personality branch has no remote ref of its own; worker-coverage `52742f80` was not pushed; unpriced enforce calls; `LEDGER_MODE` remains off; the production daily limit is still unset.
- This note is not a security or compliance claim. Nothing here was exercised against a live provider.

# Second brain — run71

## Completed
- Part A. Pushed validated local heads to new isolated branches. `origin/main` stayed `80bab333cd28c2c488ef06fce0c3b77548b84f62`. No force, no hook bypass, no PR, no deploy.
- Part B inventory first (`docs/state-machines.md`, commit `1854dbd`), then only the medium item, the low item, and the two carried lows.
- Story-rating circuit breaker is an explicit machine (`deploy/cloudflare-edge/src/breaker.js`). The half-open trial stays closed to a second `rate()`.
- Admin metrics view is an explicit machine (`src/admin-metrics-machine.js`). `renderAdmin` is the only writer.
- Suites at `580079e`: pytest 307; root node 388 pass and 1 skip (389 tests); edge 619; spend-ledger 16; early-processing 28; browser 21 scripts, 822 PASS.

## Lessons
- Write the inventory and commit it before any behavior change. The standard's section 4 is a gate, not a note added afterwards.
- A half-open trial that clears its window before the request returns looks closed to the next caller. The phase has to stay blocking until the trial settles. `Library.review` single-flights one row, so the reproduction has to call `rate()` twice directly.
- A hanging trial's timer still rejects. The test has to catch that rejection or Node reports it as unhandled, and the background attempt budget is 2000 ms of real time even when the clock is frozen.
- `functionBody` must skip the parameter list. The first `{` in `restBinding` is the destructured argument, not the body.
- The page is a classic script. The machine file stays ESM for `node --test`, and `build.py` strips the `export ` keywords when it inlines it. Do not put the word `export` anywhere else in that file.
- High-risk machines (session, ledgers, voice, spend, publication, delete receipt, confirm, early speculation) stay pending review. Do not start them in the same run as the inventory.

## Follow-up
- High rows 1–12 in `docs/state-machines.md` are pending senior review. A later run fixes them, one machine per commit, after that review. Do not start them before then.
- `cursor/atlas-personality-59c9` (`db5b5abc`) was not given its own remote branch. It is in-flight (live model untested, non-English greetings need a native-speaker review). Its commits are ancestors of `69f0c01b`, so the objects are reachable from `cursor/atlas-ledger-coverage-69f0`.
- `cursor/worker-coverage-gaps-59c9` (`52742f80`) was not pushed. It is one test-only commit on `80bab333` with no recorded suite result, and it is not an ancestor of the ledger chain.
- Under enforce, unpriced calls are still refused: analyst, embeddings, toMarkdown, ElevenLabs, TypeSafe, Hindsight. `LEDGER_MODE` remains off and is not a machine. `PRODUCTION_DAILY_LIMIT_USD` is still the unset placeholder. The proposed $15/UTC day is Tony's decision in `docs/LEDGER_MODES.md`.
- This note is not a security or compliance claim. Nothing here was exercised against a live provider.
