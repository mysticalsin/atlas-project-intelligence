# ATLAS-R15-ONEND-THROW-UNSETTLED

Low. A throwing `opts.onEnd` never settles the interactive rating promise.

Main checked before this branch: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`. `origin/main` was that same commit.

## Done when

- A throwing `onEnd` still settles `interactive()`. The promise resolves with the outcome already built. It does not reject.
- `rate()` keeps the existing success shape: `answers`, `inputTokens`, `model`, `attempts`, `hedged`, `http`, `ms`.
- A normal `onEnd` runs exactly once. A late `end()` does not call it again.
- The throw does not escape the launch `.then`.

## Failing tests

File: `deploy/cloudflare-edge/test/rating.test.js`

- `a throwing onEnd still resolves the interactive rating`
- `a throwing onEnd does not escape the rating call`

`a normal onEnd runs exactly once and a late settle does not call it again` passes on the parent. It locks the success keys and the single callback. The existing test `end() after settle does not resolve or callback again` stays as it is.

TEST COMMAND:

```sh
cd deploy/cloudflare-edge && node --test test/rating.test.js
```

On the red commit that command exits 1. 39 tests, 37 pass, 2 fail. Both failures are `throwing onEnd still settles the rating (yield cap 20)`.

## Risk

low

plan debate skipped: not high-risk (an optional observer around an already built outcome; no auth, session, permission, secret, schema, or deletion change)

State-machine discovery skipped. This does not add or change a status, a phase, or a transition. The breaker is untouched.

## Where it breaks

`interactive` returns `new Promise(resolve => {` at `deploy/cloudflare-edge/src/rating.js:491` on the parent. The executor takes no `reject`.

`end` on the parent, lines 494-499:

- Line 495 returns once `settled` is true, so a later `end()` cannot resolve either.
- Line 496 sets `settled = true` and aborts the controllers.
- Line 498 calls `opts.onEnd(result)`.
- Line 499 calls `resolve(result)` only if that call returns.

A throw skips line 499. The deadline path at lines 518-521 cannot resolve it either. `rate()` awaits that promise at line 481 and never reaches the success return at line 483.

The launch callback at lines 506-512 is a `.then` with no `.catch`. The same throw rejects that callback.

`background` does not call `onEnd`. This row does not add a callback there. Production callers do not pass `onEnd`.

## Decision

Resolve with the outcome, then call `onEnd` inside `try/catch`.

The promise resolves. It does not reject. `rate()` at lines 483-484 turns an `ok` outcome into the existing success object and any other outcome into a `RatingError`. A rejection would skip that. `Library.runRating` at `deploy/cloudflare-edge/src/library.js:1141-1142` stores a non-`RatingError` as fallback `rejected` and drops `done`. A valid answer would be discarded because an observer threw.

The `try` keeps the throw off the launch `.then`. Resolving in `finally` after `onEnd`, with no `catch`, would still settle `rate()` and would still reject that `.then`.

The success object stays `{ answers, inputTokens, model, attempts, hedged, http, ms }`. `onEnd` still receives `{ ...o, attempts, hedged, http }` once.

The tests hold the runner's `unhandledRejection` listener so the yield-cap assertion can report, then put that listener back. The escape test reads the leaks that listener would have seen. That hold is test-only.

No `python3 build.py`. `build.py` does not read this file. The page aliases stay as they are.

## Red on the parent

Test commit `62ff749f9ee241bb7ee5d98cbbfba87e26a4f24c`. `rating.js` matched main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`. Exit 1. 39 tests, 37 pass, 2 fail. The once-only test passed.

## Rollback

Revert this branch to main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`. No migration and no stored rewrite.

## Loops

Verify and QA loops are capped at 3. A failed gate is fixed only for the failure that was shown.

## Round 1 — order and the observer error

Devin's exact-head gate on `85cea81320743b098eac851f24d92e43a0f1f457` (tree `b5d7e26397eee3c287b1ebc4311bd0ff9ac7f42a`) was code incomplete. Two gaps:

- Moving `onEnd` above `resolve` and keeping the `try/catch` still settled, and all 39 tests passed.
- The `catch` discarded the observer error.

The contract stays: resolve the outcome, then call `onEnd`. A throw does not reject. The `catch` now reports it. `emit` writes `{ atlas_metric: 'rating', event: 'onend_throw', name }`. `name` is the error name when it is a short identifier, otherwise `Error`. The message and the key are not logged. A throw from the logger is caught and does not unsettle the promise.

On this head, `deploy/cloudflare-edge/src/rating.js` `end` is:

- Line 498 calls `resolve(result)`.
- Line 500 calls `opts.onEnd(result)` inside `try`.
- Line 501 catches the observer error.
- Line 504 calls `emit`.

### Tests

File: `deploy/cloudflare-edge/test/rating.test.js`

- `resolve runs before onEnd and a throw still settles` records the `resolve` of the outcome (`ok` and `attempts`) and requires that record before `onEnd`. The promise still resolves when `onEnd` throws.
- `a throwing onEnd is reported and the rating still resolves` requires the log line above, the existing success keys, and no key or observer message in the log. The promise still resolves.

The three earlier tests stay.

TEST COMMAND is the same:

```sh
cd deploy/cloudflare-edge && node --test test/rating.test.js
```

Red commit `9385eb713019e554c25f2449e294e8d7d0d687fd` adds those tests and does not change `rating.js`. Exit 1. 41 tests, 40 pass, 1 fail: `a throwing onEnd is reported and the rating still resolves` (the log is `[]`). The order test passed on that commit because `resolve` was already first.

Fix commit `88d9b96d1037d03331d25f7e24835edfd400bdd2`. Same command: exit 0, 41 pass, 0 fail. `rating.js` sha256 `62b375f2d1c3b3bcacf0e140f4f188f8359be86b61e1765d289ac9ccfdf7c112`.

### Mutants

Each mutant was restored. `rating.js` is that same sha256. None of these are committed.

- `onEnd` above `resolve`, `try/catch` and the log kept: exit 1, 41 tests, 40 pass, 1 fail. Kills `resolve runs before onEnd and a throw still settles`. Actual order `['onEnd', 'resolve']`, expected `['resolve', 'onEnd']`. The report test stayed green, and the throw still settled.
- Empty `catch` (the error is discarded again), `resolve` stays first: exit 1, 41 tests, 40 pass, 1 fail. Kills `a throwing onEnd is reported and the rating still resolves` (the log is `[]`). The order test stayed green.
- Drop the `try` and leave `resolve` first: exit 1, 41 tests, 39 pass, 2 fail. Kills `a throwing onEnd does not escape the rating call` (`1 !== 0`) and `a throwing onEnd is reported and the rating still resolves`.
- Call `onEnd` twice inside the `try`: exit 1, 41 tests, 39 pass, 2 fail. Kills `a normal onEnd runs exactly once` (`2 !== 1`) and the existing `end() after settle does not resolve or callback again` (`2 !== 1`).
