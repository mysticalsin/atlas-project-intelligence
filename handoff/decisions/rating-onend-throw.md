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
