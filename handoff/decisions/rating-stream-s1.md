# Interactive rating stream (S1)

Ask row A22. The interactive attempt lifecycle in `storyRater` was local variables. This record makes that lifecycle one reducer.

APP-FIT: **FIT**. The phases match the code that already ran: idle, one or two attempts in flight, then settled.

This run's HIGH is auth, tenant isolation, erasure, or release gating. S1 is none of those. The breaker stays the only writer of breaker state. `background()` is unchanged. Row 17 stays NOT A MACHINE.

## Done when

- `ratingStreamTransition` is the only writer of the interactive phase, attempts, pending, and the hedged flag.
- Eight phase/event pairs are legal. The other ten are refused. The refusal is `{ id: 'rating-stream', phase, event }` and the stored state is unchanged.
- A launch with no room, or with no remaining attempts, stays in the current phase. It is not a refusal.
- A retryable result starts another attempt only while room and budget remain. Otherwise it settles when nothing is still in flight, and it waits when another attempt is.
- No phase is unreachable from idle. `settled` is the only terminal phase, and it is reachable.
- `interactive()` applies that reducer. `resolve` runs before `onEnd`. A throwing `onEnd` still settles `rate()`. The log line is `{ atlas_metric: 'rating', event: 'onend_throw', name }` with no `message` and no key.
- The runner logs a rejection as id, phase, and event only.

## Tests

- `deploy/cloudflare-edge/test/rating-stream.test.js` — legal pairs, refused pairs, guards, reachability.
- `deploy/cloudflare-edge/test/rating-stream-wire.test.js` — the rater calls the reducer, and a throwing observer cannot leave `rate()` unsettled.

TEST COMMAND:

```sh
cd deploy/cloudflare-edge && node --test test/rating-stream.test.js test/rating-stream-wire.test.js
```

## Rollback

```sh
git revert <head-sha>
```

That is an ordinary revert of this branch's commits. No reset, no force push.
