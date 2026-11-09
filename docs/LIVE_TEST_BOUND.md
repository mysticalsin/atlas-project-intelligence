# Plan A live test: spend ledger and all-in bound

**Status:** Phase 1 (local, free) is implemented and verified with mocked AI. Phase 2 was unblocked on 2026-11-09 by a Workers AI-only token on Tony's account, created by the owner. On the same day Tony approved raising **only** the input-token cap, from 100,000 to 800,000, while keeping the $1.50 total. Every other cap is unchanged.

The privacy check is in `docs/LIVE_TEST_PRIVACY_CHECK.md`.

## What the ledger enforces

There is one authority: the `SpendLedger` Durable Object, defined in `deploy/cloudflare-edge/live-test/entry.js`, with its state logic in `src/spend-ledger.js`.

Every paid Workers AI call in the test path reserves with it before the request is made. That covers both baseline and Plan A:
- speech recognition;
- the smart-turn turn model;
- the talker, including discarded drafts;
- speech synthesis, including generating the synthetic test speech.

`meteredAI` wraps only those four methods. The analyst, report, embeddings, the JEV ranker and ElevenLabs are absent from it, so the test path cannot reach an unmetered paid call. Sessions run with `capture: false`, so the analyst and report are never needed.

Plan A's own admissions (`speculationConfig` with the ledger client, `scope: 'global'`) are the same reservations. The early transcription or draft is then *claimed* by the wrapper, once, by its own session and kind, so nothing is reserved twice.

The rules:
- **Admission before the request.** A refusal, a ledger error or a claim that fails means no upstream call. The session's existing 150 ms admission timeout also applies to Plan A's own admissions.
- **Conservative per-call ceiling** at official list prices, with no free allocation assumed:
  - audio is rounded up to whole seconds;
  - the turn model is limited to the 8 s that `turnComplete` sends;
  - talker input is the UTF-8 byte count of every message plus template allowance, which is at least the token count;
  - talker output is reserved at the full `max_tokens` of 300 for every call;
  - speech-synthesis characters are counted as UTF-8 bytes.
- **Never refunded.** A cancelled, withdrawn or discarded request, early transcription included, keeps its full reservation. What was actually observed is recorded separately at settle.
- **Latching hard stop.** Any exhausted cap, or an unpriced model or voice, stops all further reservations, sessions and turns. The stop persists in Durable Object storage across restarts.
- **Caps, combined across baseline and Plan A:**

  | Cap | Limit |
  |---|---|
  | Sessions | 10 |
  | Turns per session | 10 |
  | Audio (speech recognition and turn model together) | 30 minutes |
  | Audio requests | 100 |
  | Input tokens | 800,000 (raised from 100,000 by owner decision, 2026-11-09) |
  | Output tokens | 20,000 |
  | Speech-synthesis characters | 20,000 |
  | Dollars | $1.50 |
  | Requests in flight | 8 |

## All-in bound (arithmetic)

The prices come from the official pricing page, <https://developers.cloudflare.com/workers-ai/platform/pricing/>, last updated 2026-10-20 and read on 2026-11-09. Workers AI bills $0.011 per 1,000 Neurons. The free daily allocation of 10,000 Neurons is not assumed.

| Billable item | Official unit price | Cap | Worst case |
|---|---|---|---|
| `@cf/deepgram/nova-3`, HTTP batch | $0.0052 per audio minute (472.73 Neurons) | 30 min, shared with the turn model | 30 × 0.0052 = **$0.156** |
| `@cf/pipecat-ai/smart-turn-v2` | $0.00033795 per audio minute (the page also lists 0.51 Neurons = $0.0000056; the higher figure is used) | counted in the same 30 min, at most 8 s per call | covered by the line above, which prices every audio minute at the dearer Nova-3 rate |
| Same audio, if each request were billed as a full minute (no minimum is stated, so this is guarded by a call-count cap) | $0.0052 per request | 100 audio requests | 100 × 0.0052 = **$0.52** |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, input | $0.293 per M tokens (26,668 Neurons) | 800,000 | 0.8 × 0.293 = **$0.2344** |
| Same model, output | $2.253 per M tokens (204,805 Neurons) | 20,000 | 0.02 × 2.253 = **$0.04506** |
| `@cf/deepgram/aura-2-en` (and `aura-2-es`) | $0.030 per 1,000 characters (2,727.27 Neurons) | 20,000 characters | 20 × 0.030 = **$0.600** |

The audio term is the larger of the two audio rows, $0.52:
- **Provider bound from the unit caps:** 0.52 + 0.2344 + 0.04506 + 0.600 = **$1.39946**, which is at most $1.50.
- **Same, with audio bounded by duration alone:** 0.156 + 0.2344 + 0.04506 + 0.600 = $1.03546.
- **With the proxy worst case:** every call carries $0.0060003 on top of its provider ceiling. The ledger admits a call only while the sum of all reserved ceilings stays at or under **$1.50**, so provider plus proxy together can never pass $1.50. Which limit binds first depends on the number of calls: n calls carry n × $0.0060003 of proxy reservation.

**Remote-binding proxy.** `wrangler dev` runs the Worker and the ledger Durable Object locally. Only the AI binding is remote, reached through Wrangler's proxy session (<https://developers.cloudflare.com/workers/development-testing/>, updated 2026-10-28). That page says remote interactions incur the standard costs of the services used, such as AI requests. It does not say whether the proxy itself bills as Worker usage.

So every reservation also carries the Workers Standard worst case per call (<https://developers.cloudflare.com/workers/platform/pricing/>, updated 2026-10-02): $0.30 per million requests plus the 5-minute CPU maximum per invocation at $0.02 per million CPU ms. That is 0.0000003 + 300,000 × 0.02 / 1,000,000 = **$0.0060003 per call**.

**The all-in bound is the ledger's hard stop, $1.50.**
- Each call is admitted only while the sum of reserved ceilings stays at or under $1.50.
- Each ceiling is at least that call's provider cost plus its proxy worst case.
- Nothing is refunded.

The provider terms alone are also bounded by the unit caps at $1.39946, independently of the dollar cap. `node deploy/cloudflare-edge/live-test/bound.mjs` recomputes these figures from the same constants the ledger uses.

**Where the ledger binding lives.** Only in the test-only configs `deploy/cloudflare-edge/live-test/wrangler.jsonc` and `wrangler.mock.jsonc`, used only by the local dev process. The production `deploy/cloudflare-edge/wrangler.jsonc` and its bindings are unchanged. No other paid or remote resource is created. Plan B (Flux) is out of scope.

**Not billed in this design:**
- The Worker and the ledger Durable Object run locally, beyond the proxy term above.
- No AI Gateway, no Vectorize, no R2 and no D1.
- No ElevenLabs: there is no key, and `meteredAI` refuses any language other than English or Spanish.

## Unknowns stated, not assumed away

- **Billing rounding or a per-request minimum** is not stated on the pricing page. The audio-request cap covers a one-minute minimum per audio request. No minimum is stated for talker tokens or synthesis characters either.
- **Cancelled or abandoned requests:** whether they bill is not stated, so they are counted in full and never refunded.
- **The smart-turn price discrepancy** on the page: the higher figure is used.
- **Account-specific discounts or plan terms** are not known. The bound uses list prices.
- **Provider-reported usage** has not been read, so it is unknown until a live run.

## Expected size of a live run under these caps

The talker prompt for the opening alone is estimated at about 10.3k input tokens. Under the original 100,000 input-token cap, that allowed roughly nine talker calls. The raised 800,000 cap allows about 55 to 75 calls of 10–14k each.

Other limits now bind first:
- **Output tokens:** 20,000 at 300 reserved per call allows about 66 talker calls.
- **Audio requests:** 100, at about 3 to 5 per turn.
- **Dollars:** the $0.0060003 proxy reservation on every call, so about 250 calls use the whole $1.50.

A free mock run of the harness under workerd reserved 77,864 input tokens for:
- two sessions of two turns each (baseline, then Plan A transcription only);
- eight talker calls, one of them a reply withdrawn at a mid-answer pause.

Under the original cap the driver stopped on headroom before drafts. With the raised cap, the driver plans each session against every remaining cap, including the dollar cap, from the spend actually observed per session so far. The ledger remains the authority.

## How Phase 2 runs

```sh
cd deploy/cloudflare-edge
wrangler dev -c live-test/wrangler.jsonc --var LIVE_TEST_LOCAL:1 --ip 127.0.0.1 --port 8787 --persist-to /tmp/run62/live-state
node live-test/run.mjs http://127.0.0.1:8787 /tmp/run62/live-run.json 1 2
```

The Worker answers only on localhost, and only with `LIVE_TEST_LOCAL=1` passed on the command line. Its config has no routes, no `workers_dev` and no previews, and it must never be deployed.

## Free harness check (mock)

`live-test/wrangler.mock.jsonc` has no AI binding. Run with `--var LIVE_TEST_MOCK_AI:1`, it uses the same entry, the same local ledger and the same driver. A fixed-delay fake replaces every provider call. It checks the harness and the Durable Object under workerd, but it is not a measurement.

## Measurement definitions

| Term | Definition |
|---|---|
| End of speech | The moment the last voiced 20 ms frame (any absolute sample value above 1000) of the final synthetic speech part is handed to the session. The harness streams microphone frames continuously on a drift-corrected 20 ms schedule, as the browser does. |
| Transcript | The session's `stt` metric for the turn. |
| First token | The first `agent_text` event of the reply sent to the client. |
| First audible | A server-side proxy: the first reply PCM chunk handed to the socket (`sendBytes`) after end of speech. This includes a cached acknowledgement if one is played. There is no browser, speaker or client network in the path, so real first-audible would be later by the client's network and jitter buffer. |
| Cold and warm | Cold is the first consultant turn of a session; warm is later turns. |
