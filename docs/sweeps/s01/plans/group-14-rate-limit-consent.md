# Group 14 — rate limit / consent

Plan only. Debate this before anyone edits product code.

Pinned inputs: confirmer report sha256 `57c92dcb651ddef4b7abe9c23424065a2a59fa139d2cdfc6315ce227596eac1c`, main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`, red tests `96712474b59d6b058ef00479f2bb2d4eb065801e` (PR #31). External review: ATLAS-07 in `/cursor/stores/bot/atlas-sweeps/s01/external/hammer-artex-security.md`.

Findings: F3, F4, F8, ATLAS-07.

## Done when

1. F3, F4, and F8 in `sweep01-f-stress.test.js` pass.
2. A new ATLAS-07 test passes: after the bid-create cap is spent, a new `Library` on the same SQLite still returns false from `rateLimit` until the window expires. A new SQLite allows the call (the cap is not a global secret).
3. `node --test deploy/cloudflare-edge/test/ratelimit` existing files, and the privacy consent tests that already pass, stay green.
4. No skip, no expected failure. `rateLimit(lib, key, max, windowMs)` keeps that signature so group 9's people route does not change.

## Files this group may edit

- `deploy/cloudflare-edge/src/ratelimit.js`
- `deploy/cloudflare-edge/src/privacy.js` (`applyState` and the lock it needs; not the receipt schema)
- `deploy/cloudflare-edge/src/util.js`, the `rateLimit` function and its comment only (today lines 23–34). Do not edit `email`, `str`, `para`, or `inList`.
- `deploy/cloudflare-edge/test/sweep01-g14-limit.test.js` (new)

Group 5 owns `email()` in the same `util.js`. The carve is the debate point: this group owns `rateLimit`, group 5 owns `email`, and neither rewrites the other's function. If the reviewer refuses a shared file, the fallback is a one-line delegate inside `rateLimit` to a new `library-limit.js` that only this group edits, and group 5 still does not touch `rateLimit`.

Do not edit `profile.js`, `ask.js`, `bids.js`, `library.js`, or `library-routes.js`. Those call `rateLimit` and must keep working.

## Failing tests from PR #31

File: `deploy/cloudflare-edge/test/sweep01-f-stress.test.js`

| Test | Finding |
|---|---|
| `F3 a shared limit cannot be passed by overlapping consumes` | F3 |
| `F4 overlapping consent writes keep every purpose that was granted` | F4 |
| `F8 a clock that moves backward does not open a fresh rate-limit window` | F8 |

The F3 storage double yields on `get` and `put` and has no `transaction`. Forty `Promise.all` calls with `max: 5` must allow at most 5. F4's double yields inside `beforeCommit`. Both `transcription` and `draft` stay granted. F8 spends 3 of 3, then a `now` one window earlier is still refused.

TEST COMMAND:

```sh
node --test --test-name-pattern 'F3|F4|F8' deploy/cloudflare-edge/test/sweep01-f-stress.test.js
node --test deploy/cloudflare-edge/test/sweep01-g14-limit.test.js
```

## Additional red test — ATLAS-07

`deploy/cloudflare-edge/test/sweep01-g14-limit.test.js`. Write it first.

Use a real `Library` on `memorySql()`. Call `rateLimit(lib, 'bid-create:tenant:ada@example.test', 30, 864e5)` thirty times and assert the thirty-first is false. Construct `new Library(sameSql)` (heap gone, database kept) and assert the next call is still false. Advance `lib.now` by more than the window and assert the next call is true. A second `memorySql()` allows a fresh thirty.

Do not assert on `ask.js` or `bids.js`. The bug is the map inside `rateLimit`. Callers stay.

## Threat model

Before, F3: `consume` reads the counter, yields, then writes `n + 1` from the value it read. Forty overlapping calls with max 5 all succeed. On a Durable Object this is one isolate, and the yield is every `await storage.get`. The sheet, classify, transcribe, and library `enforce` paths all use this function. A burst past the cap is a cost and an abuse path.

Before, F4: `applyState` loads `consent`, yields in `beforeCommit` (the receipt post), then stores the whole state. One of two overlapping grants is lost. The session then runs without the purpose the person accepted, or the receipt and the state disagree. The comment on the function says a choice is never in force without its receipt. A lost grant is the reverse: the receipt may have been posted and the state forgot the purpose.

Before, F8: the window key is `floor(now / windowMs)`. After the limit is spent, a `now` one window earlier addresses an empty key and is allowed. Tests pass `now`. Production uses `Date.now()`. A clock step backward, or any caller that supplies `now`, opens a fresh budget.

Before, ATLAS-07: `util.rateLimit` keeps hits in a `WeakMap` on the library object. Ask (60/hour), bid create (30/day), bid edit, bid match, and people lookup (30/hour) use it. Evicting the Library Durable Object drops the map. The same person creates another 30 bids that day. The key is the verified email, which the client cannot spoof. `X-Forwarded-For` is not a key.

After: overlapping `consume` calls allow at most `max`. Overlapping consent grants both stick, and a thrown `beforeCommit` still leaves the previous state. A backward `now` does not open a new window. The library caps survive a new `Library` on the same SQLite.

## Chosen design

F3 and F8 live in `ratelimit.js`. F4 lives in `privacy.js`. ATLAS-07 lives in `util.rateLimit` and a SQLite table.

F3. The red-test storage has no compare-and-swap. An in-isolate mutex, one chain per storage object (`WeakMap` of promises), wraps the `get`, the decision, and the `put`. The second caller waits until the first `put` finishes, then reads the updated `n`. If `storage.transaction` exists, use it inside the same mutex so a real Durable Object write is atomic as well. The mutex is what makes the test pass. Release it in `finally`, including when `put` throws.

F8. Store `{ n, exp, seen }` where `seen` is the greatest `now` accepted or refused for that subject and bucket. When `now < seen`, choose the window key from `seen`, not from `now`. A backward clock stays in the spent window. When `now` moves past the end of that window, a new key starts at zero, as today. Do not delete the high-water mark just because the window key changed; keep `seen` on the new record, initialized to `max(now, previousSeen)` if you read the old key, or store `seen` under a stable key `rl:<bucket>:<subj>:seen` that is not windowed. The stable key is the one that survives a backward step into a different `floor`. One extra `get`/`put` of that key, inside the same mutex.

F4. The same mutex pattern around `applyState`, keyed by the storage object. The critical section includes `loadState`, the purpose merge, `beforeCommit`, and `put`. A throw from `beforeCommit` skips `put` and releases the mutex. The second grant then loads the state the first one stored. Do not write the whole state from a snapshot taken before the other call's `put`. `beforeCommit` for the real caller posts receipts. Holding the mutex across that post serializes one person's consent changes. It does not include a DNA call.

ATLAS-07. `rateLimit` stops using the `WeakMap` as the source of truth. It creates, via `lib.exec`, 

```text
CREATE TABLE IF NOT EXISTS rate_hits (bucket TEXT NOT NULL, at_ms INTEGER NOT NULL)
```

and counts rows with `at_ms` in the same window the function uses today: `now - t < windowMs` (a hit exactly `windowMs` old does not count). `now` is `Date.parse(lib.now())` when that is finite, else `Date.now()`, which is the current clock. Insert one row when under `max`, and delete rows older than the window for that bucket. The function stays synchronous and returns a boolean. A `Library` rebuilt on the same SQL sees the rows. That is the Durable Object database, which survives eviction. Interview-object `storage.get` is the wrong store: ask, bids, and people run in the Library object, and their callers do not receive `ctx.storage`.

Keep the key strings the callers already pass (`bid-create:<tenant>:<email>`, `ask:<email>`, and so on). Do not add a tenant onto keys that omit one. That would give each tenant a fresh budget and loosen the cap.

`consume` and `rateLimit` stay two mechanisms. `consume` is async Interview storage. `rateLimit` is sync Library SQL. Unifying them onto `enforce()` would edit `profile.js`, `ask.js`, and `bids.js`.

## Alternatives rejected

1. F3: optimistic version field without a mutex. Rejected because the test double's `put` overwrites blindly. Both callers read `n = 0` and both write `n = 1`. There is no CAS to retry against.
2. F8: reject any `now` less than `Date.now() - skew`. Rejected because the test passes an explicit `now` and production's bug is a stepped clock, not a client field. The high-water mark matches the test without a second clock source.
3. ATLAS-07: route ask, bids, and people through `enforce(storage)`. Rejected because those calls are synchronous, the files are not this group's (`profile.js` is group 9), and `libraryRoutes`'s `storage` argument is the Interview-style map only when the Worker passes it. The Library SQLite is the store that actually survives eviction for these routes.
4. ATLAS-07: leave the `WeakMap` and also write SQLite, and accept when either allows. Rejected because the memory map would allow a burst the table had already closed, inside one isolate, if the two ever disagree.

## Invariants and properties

`sweep01-g14-limit.test.js`. `node:test`. No skip, no expected failure. No new dependency.

- F3 property: for `max` in 1, 2, 5 and concurrency in 1, 8, 40, the number of `ok` results is at most `max`, and a later call after those settle is refused when `max` were allowed.
- F4 property: for every non-empty subset pair of the consent purposes, two overlapping `applyState` calls leave every granted purpose true. A `beforeCommit` that throws leaves the other call's grant intact and does not store the throwing call's purpose.
- F8 property: for a random sequence of `now` values that jump forward and backward inside two windows, the number of allows whose high-water mark falls in one window is at most `max`. A `now` equal to the spent window's start is refused after the cap. A `now` equal to `seen + windowMs` is allowed.
- ATLAS-07 property: the boolean for a given key depends on the SQL rows and `lib.now()`, not on which `Library` instance is used. Exactly-`windowMs`-old hits do not count. `windowMs - 1` hits do.

Boundaries: `max` of 1. Empty checks array in `consume` still returns ok (current contract). `rateLimit` with a `lib` that has no `exec` throws a clear error in tests rather than silently using a `WeakMap`. Production `Library` has `exec`.

## Data migration

`rate_hits` is created on first use. No backfill: the old map held nothing durable, so the first process after deploy starts from an empty window. That is one free window at the moment of deploy. Accepted. Do not try to reconstruct history.

Consent state already lost to the race is not rebuilt. The person grants again.

## Rollback

Revert the commit. `consume` races again. Consent last-write-wins again. `rateLimit` returns to the `WeakMap`. The `rate_hits` table can stay; the old function ignores it. Dropping it is optional and is not required to roll back.

## Open PRs #15–#30

No PR in #15–#30 edits `ratelimit.js`, `privacy.js`, or `util.js`.

Group 5 will edit `email()` in `util.js` for L1. Land this group's `rateLimit` hunk and group 5's `email` hunk as different regions. Do not reformat the file.

Group 9 calls `rateLimit` from the people route and must not switch to `enforce`. This group must not change the signature they call.

Group 3 owns library routes, including F6's 503 mapping. They must not wrap `rateLimit`.

## Owner lockout

F8: if the platform clock steps backward after the owner has spent a window, the owner stays limited until the clock catches the stored high-water mark and then finishes that window. A step of days is a lockout of days for that bucket. That is the trade for not opening a fresh window. Rollback clears it only if the new code is gone and the `seen` key is unread; document the key name in the runbook line this group is allowed to add inside `SECURITY_RUNBOOK.md` only if group 13 has not taken the file. This group does not own the runbook. Put the key name in a comment in `ratelimit.js` instead.

F3's mutex is per isolate. A stuck `put` that never resolves holds the chain. `storage.put` on the test double resolves. On the Durable Object, a hung storage call already fails the request. The `finally` still releases if it throws.

ATLAS-07 does not tighten the numeric caps. It makes the published caps true across eviction. The owner who was relying on eviction to reset a cap will now wait for the window. That is the fix, not an accident.

F4's mutex serializes consent for one storage object. Two purposes from one person wait for each other. They do not wait for another person's object.

## Diff size

About 180 lines of product code and about 200 lines of tests.

## Open questions for the owner

1. Confirm the `util.js` carve: group 14 owns `rateLimit`, group 5 owns `email()`, same file, no other lines. If that shared file is refused, this group adds `library-limit.js` and `rateLimit` becomes a delegate, which is a larger diff and the same behavior.
2. A clock that steps backward holds a spent window until wall time passes the stored high-water mark. Confirm that lockout is preferred to opening a fresh window. The red test requires the hold.
3. The ask and bid-edit keys do not include the tenant. This plan keeps those strings. Adding the tenant would give each tenant its own cap and loosen the limit. Confirm the keys stay as they are.
