# Bound a call when the provider reports no usage

Branch `cursor/plan-a-bound-overshoot`, from `c02a5aca`. Specs live in `docs/` (`docs/LEDGER_MODES.md`, `docs/WOW_SPEC.md`). There is no separate Spec Kit tree.

Tony's rule: every AI call is priced and sits under the same $5 month, fail closed. The stop is the existing month sentence. Unset `LEDGER_MODE` stays enforce. Observe mode is out of scope.

## Paths

A call can cost more than its reserved ceiling, or leave that cost out of the ledger, when the provider never gives a usage number.

1. Edge talker stream. `deploy/cloudflare-edge/src/app.js:469-484` yields every text delta. `app.js:460` sends `max_tokens`, and `app.js:495` settles with no usage when none arrived. The settle then keeps the ceiling (`meter.js:301-311`, `month-budget.js:157-158`). The text already handed to the interview can be longer than that ceiling (`prices.js` talker `maxTokens` 300, `meter.js:37-38`). The extra is not in the ledger.

2. Python talker stream. `atlas_voice/kyutai.py:121-143` yields every delta. `kyutai.py:112` sends `max_tokens`. `kyutai.py:155` settles `seen`, which stays `None` when no usage arrives. Same gap. Cascade speech uses this generator (`atlas_voice/cascade.py:192`).

3. Realtime session. `atlas_voice/realtime.py:267-276` forwards every provider audio frame. `realtime.py:279-283` counts a response only when `usage_from` returns numbers. `realtime.py:95-97` ignores a response with no usage. `realtime.py:314-320` stops on the session clock, up to `maxSeconds` 900 (`prices.js`), not on the open increment. One increment is `atlas_voice/limits.py:50-57` plus one `maxResponseTokens` (`realtime.py:66`). Further responses and further audio in that window are not reserved again until a usage number arrives.

4. A zero measurement is priced at $0 and the ceiling is refunded. `meter.js:143` (realtime, no tokens), `meter.js:148` (transcribe, no milliseconds) and `meter.js:161` (Hindsight, no tokens) return 0 when settling. `month-budget.js:157-162` then subtracts `ceiling - charged`. Callers that hit this with no real measurement: `realtime.py:74` (drop a just-opened increment), `realtime.py:135` (a seen session whose remaining tokens are 0) and `realtime.py:138` (transcribe milliseconds of 0). The reserved dollars leave the month. The provider may already have billed the ceiling.

5. A failed settle does not drop the ceiling. `meter.js:463-476` and `meter.js:510-521` leave the hold when settle returns false. `kyutai.py:144-152` and `realtime.py:53-62` do the same when settle raises. The dollars stay in the open hold.

6. An absent settle does not drop the ceiling. The hold stays until the TTL sweep (`meter.js:259-266`). The sweep marks it expired and keeps the ceiling (`month-budget.js:147-152`).

Paths 5 and 6 are already bounded at the ceiling. They become a real-dollar bound only together with the cuts in paths 1–3. This slice does not change the sweep or the failed-settle hold.

These are not this bound:

- Observe records without reserving (`meter.js:443-450`, `atlas_voice/spend.py:193-201`). Left as it is.
- Explicit off skips the ledger (`meter.js:422-432`, `spend.py:188-190`).
- Kyutai STT and TTS sockets (`atlas_voice/speech.py:201-248`) have no price and no reservation. They are not an overshoot of a ceiling.
- A finished non-streaming body (`atlas_voice/analyst.py:95-102`, `editor.py:95-107`, `notes.py:99-108`, `report.py:133-135`, `memory.py:80-90`, `speech.py:283-316`). The request already carries the same cap that was reserved. The body comes back whole.

## The bound

No usage means the call is charged its full reserved ceiling, and that charge is not refunded later.

A streamed talker stops accepting text once the accepted characters reach the reserved output cap. The cap is the same `max_tokens` already sent. One token is at least one character, so the accepted text cannot be more output tokens than were reserved, for a provider that counts one character as at most one token.

A realtime session with no usage stops when the audio already forwarded, priced at `outputTokensPerSecond`, or the unmetered responses, each priced at `maxResponseTokens`, no longer fit in the open holds. If the month still has room, the existing increment reserve runs first. If that reserve is refused, the session stops with the month sentence. The provider socket closes in the existing `finally`.

No new ledger, no new service. The month reducer stays the only writer.

## Invariant

Month spend plus open holds is at most the cap plus X.

X is 0. Its name is the missing-usage overshoot.

Spend is the settled nano-dollars. Open holds are the ceilings still reserved. A call with no usage settles at its ceiling or stays open at its ceiling. Both were admitted under the cap. Neither adds an overrun. So spend plus open holds stays at most the cap.

A later call that does report usage above its ceiling can still add an overrun. That number is the reported usage, and the month already latches exhausted. It is not X.

## What stays impossible

A provider that ignores the cap it was sent, bills the extra, and still reports no usage. A non-streaming body cannot be cut after it has arrived. A stream can be cancelled, and the tokens the provider generated after the cancel and never reported have no number on our side. The ledger still keeps the ceiling, and the next reserve is refused once that ceiling fills the month. That hidden extra is not a finite X.

Kyutai STT and TTS stay unpriced. Putting a price on them would be a new reservation, not this bound.
