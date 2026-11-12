# Production spend meter: `LEDGER_MODE`

**Status (cap v2):** production `wrangler.jsonc` sets `LEDGER_MODE=enforce`, exports `ProductionSpendLedger`, and binds it as `SPEND_LEDGER` (migration `v3`, `new_sqlite_classes`). No `PRODUCTION_MONTHLY_LIMIT_USD` override, so the $5 UTC-month default applies. Unset `LEDGER_MODE` means **enforce**. Explicit `off` is what the local voice scripts set, and it writes one log line. This branch does not carry the live-test ledger or early processing. It has not been exercised against a live provider.

## What goes through it

Every paid call in `deploy/cloudflare-edge/src` goes through one wrapper factory, `src/meter.js` `paid(env)`. `test/ledger-static.test.js` fails if any other source file reads the AI binding, names a paid provider endpoint, or adds a direct `fetch` beyond a counted list of unpaid ones.

| Call site | Upstream | Kind |
|---|---|---|
| `app.js` `workersAI().transcribe` | `env.AI.run` (STT model) | `stt` |
| `app.js` `workersAI().turnComplete` | `env.AI.run` (smart-turn) | `turn` |
| `app.js` `workersAI().synthesize` for en/es | `env.AI.run` (Aura) | `tts` |
| `app.js` `elevenLabs` (other languages, when its key is set) | ElevenLabs text-to-speech | `tts`, provider `elevenlabs` |
| `app.js` `workersAI().chatStream` | `env.AI.run` (talker, streamed) | `talker` |
| `app.js` `runReasoning`, used by `complete`, `report` and `analyst`, including its retry without `reasoning` | `env.AI.run` (analyst model) | `analyst` |
| `app.js` `workersAI().embed` | `env.AI.run` (embeddings) | `embed` |
| `app.js` sheet import `toMarkdown` | `env.AI.toMarkdown` | `markdown` |
| `memory.js` `hindsight()` (every method) | Hindsight API | `memory`, provider `hindsight` |
| `memory.js` `jevRelevant`, `jev.js` `jevRanker`, `classify.js` `classify`, `rating.js` `storyRater`, `customer-jev.js` `customerJev`, `memory-routes.js` admin test | TypeSafe JEV | `jev`, provider `typesafe` |

The `worker.js` paths (the Session's `ai`, `rankProbe`, and LibraryStore's `complete`, `embed` and story rater) reach those same functions, so they are metered there.

The Python gateway (`atlas_voice/`) reserves through the same Durable Object. `src/spend-route.js` accepts `POST /api/ledger/reserve` and `POST /api/ledger/settle` with bearer `ATLAS_LEDGER_TOKEN` and forwards them to `ProductionSpendLedger`. It does not call a provider. A failed settle is never 2xx. `atlas_voice/spend.py` is the client. Each listed paid call, including every Hindsight call in `atlas_voice/memory.py`, reserves before the upstream request. The Worker prices the usage; Python does not send a dollar amount. `spend.require_ledger` runs before the gateway binds a port: off starts only when `ATLAS_LEDGER_DEV` is `1`, `dev` or `test`, and a missing URL or token refuses.

The unpaid direct fetches are:
- the Access signing keys;
- the DNA directory;
- Microsoft identity and Bot Framework;
- the Durable Objects' own handlers;
- same-origin browser requests;
- the local live-test harness.

## The three modes

`LEDGER_MODE` is a Worker variable, and the same name on the Python process. Production sets `enforce`. `scripts/run_local_voice.sh` and `scripts/pod_setup.sh` set `off` explicitly.

- **unset, empty, or omitted** means enforce. A missing ledger refuses the call.
- **off** is explicit. Each call is made exactly as before: the same arguments, same count and order, and the same result object. No estimate is computed, and `SPEND_LEDGER` is never read. The factory writes one log line, `{atlas_metric:'ledger', mode:'off'}`. `test/ledger-off.test.js` compares the off scenario with a golden recorded on this branch.
- **observe** never blocks or delays a call.
  - Each call writes one log line: `atlas_metric: ledger`, the kind, the configured model or provider name, numbers (audio ms, token estimates, characters, files, requests) and an estimated USD figure, or `null` when unpriced. It never contains prompt, transcript, story or key text.
  - When a `SPEND_LEDGER` binding exists, the estimate is also sent to its `record()` without being awaited.
  - When the binding is missing, or a lookup or `record()` throws, rejects or hangs, the result is log-only and the call is unaffected.
- **enforce** is opt-in only. Before the upstream call, the ledger must return `{ ok: true, id }` from `reserve()`.
  - Each of these refuses the call with a `BudgetRefused` error and nothing reaches the upstream: no binding (`no_ledger`); a throw or rejection (`ledger_error`); no answer within 1 s (`ledger_timeout`); a malformed answer; or a refusal from the ledger (`exhausted:usd`, `unpriced`, `limit_unset`).
  - After the call, settle charges the usage the response returns and refunds the rest of the reservation. Usage above the ceiling is counted and flagged in the same step (`overruns`). Missing usage keeps the ceiling.
  - The analyst's reasoning retry is not attempted after a refusal.
- **Any other value**, for example a typo, refuses every paid call (`invalid_mode`). Setting the variable at all is an explicit opt-in, so a typo must not silently mean off.

The guarantee in each mode is only what is listed here. Off guarantees unchanged behaviour, not any spend limit. Observe guarantees records only when a working ledger is bound; otherwise it guarantees log lines. Only enforce bounds spend, and only to the extent of its known limits listed below.

## Why unset means enforce

Tony's decision, via Jarvis at 18:19 BRT on 2026-11-11: "Everything AI: price every model call and put all of it under the same $5." An unset variable must not leave a paid call unmetered. Production config is enforce and a test fails if it is off. Local and dev scripts that have no ledger set `LEDGER_MODE=off` in the file and write the log line. Observe stays available and never blocks.

## Production limit: $5 per UTC month

Tony's decision, relayed via Jarvis at 17:03 BRT on 2026-11-11: production voice spend is **$5 per calendar month** (UTC), fail closed. `PRODUCTION_MONTHLY_LIMIT_USD = 5` in `src/meter.js`. The earlier $15 per UTC day proposal is not the limit.

Admission is `month-to-date reserved nano + this call's worst case <= 5_000_000_000` nano-dollars (`Math.round(5 * 1e9)`). Equal to the cap is admitted. One nano over is `exhausted:usd`. Settle then replaces the ceiling with the actual nano when the response carries usage, refunding the difference, or adds the overrun and increments `overruns` when the actual is higher. A settle with no usage, including an error, keeps the ceiling. An open reservation older than 120 seconds is settled at its ceiling on the next reserve, so abandoned rows do not accumulate. The next UTC day in the same month does not reset the counter. At `YYYY-MM-01T00:00:00Z` the pure `rollover` event in `src/month-budget.js` opens the new month at zero. That file is the only writer of the month. `docs/STATE-MACHINE-STANDARD.md` is not vendored on this branch; the machine follows its rules (typed states and events, one pure transition, no I/O in the reducer, versioned persistence, unknown or legacy records deny and are not healed).

The worst case for a Workers AI binding call (`@cf/…` or `toMarkdown`) is the list-price ceiling plus the binding proxy worst case, `0.30 / 1e6 + 300000 * 0.02 / 1e6` dollars (`PROXY_PER_CALL_NANO` = 6,000,300). ElevenLabs, Hindsight and TypeSafe are direct fetches and do not get the proxy. A model or provider with no price still returns null from `priceOf` and is refused under enforce. Every kind production can call now has a positive ceiling, so that refusal is for a future unpriced kind, not for the current set. `test/priced-kinds.test.js` fails if a `paid()` estimate arrow names a kind or provider without one. The $1.50 live-test ledger is not on this branch.

The default applies when the limit is omitted. Production omits it. An explicit null, blank, zero, negative or unparseable `limitUsd` or `PRODUCTION_MONTHLY_LIMIT_USD` denies with `limit_unset`. A ledger read or write failure denies with `ledger_error`. A legacy day record, a bad version or a month that is not `YYYY-MM` denies with `unknown_month` and stays denied across the next month boundary. None of these fall through to an unmetered provider call. A voice session refused mid-call still ends with `error` / `voice-unavailable` and the shared sentence from `BUDGET_MESSAGE`.

## Prices (read 2026-11-11)

| Kind | List price | Ceiling per call | Source |
|---|---|---|---|
| stt nova-3 | $0.0052 / audio minute | at most 60 s, whole seconds rounded up, plus proxy. Longer audio is cut locally before the call. A longer `audioMs` is not priced | Workers AI pricing table, last updated 2026-10-20, https://developers.cloudflare.com/workers-ai/platform/pricing/ |
| turn smart-turn-v2 | $0.00033795 / audio minute | at most 8 s, plus proxy. The call sends only that tail. Above 8 s is not priced. The page also lists 0.51 neurons / minute; the higher figure is used | same table |
| talker llama-3.3-70b | $0.293 / $2.253 per million input / output tokens | `max_tokens` 300 (no reasoning budget) and one input token per UTF-8 byte of the request body, plus proxy | same table |
| tts aura-2-en, aura-2-es | $0.030 / 1,000 characters | at most 4,000 characters, priced on the UTF-8 bytes of that text (at most 3 bytes per character), plus proxy. The provider bills characters, so the character cap is the enforced limit. 120 s is the speech time that cap is meant to cover, not a second price | same table |
| analyst gpt-oss-120b | $0.35 / $0.75 per million tokens. Reasoning tokens are output tokens; there is no separate reasoning price | `max_tokens` is the answer budget plus the same number again for reasoning, and that sum is what the call sends and what the ceiling prices. Input is one token per byte of the request. `max(completion, reasoning)` is the billed output. A figure above the sent `max_tokens` is an overrun | https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/ |
| embed bge-m3 | $0.012 per million input tokens | the text is cut to 8,000 characters and reserved at one token per UTF-8 byte of that text, plus proxy. The model page lists $0.0118; the higher figure is used | https://developers.cloudflare.com/workers-ai/models/bge-m3/ |
| markdown / toMarkdown | documents are free at list price. An image uses detr-resnet-50, which has **no published price**, then Gemma 4 26B at $0.100 / $0.300 per million tokens | the call is refused above 10 MB, above 1,600,000 image bytes, or above 30 visible PDF pages. An image reserves two Gemma calls at 8,192 input and 1,024 output tokens. A document that is allowed reserves that same pair for all 30 pages, because a page can take the image path. More files than 30 is not priced. Plus one proxy | https://developers.cloudflare.com/workers-ai/features/markdown-conversion/ and https://developers.cloudflare.com/workers-ai/features/markdown-conversion/how-it-works/ (updated 2026-10-15). Gemma is on the pricing table. https://developers.cloudflare.com/workers-ai/models/detr-resnet-50/ says the model is not in the catalog |
| tts ElevenLabs `eleven_flash_v2_5` | $0.04 / 1,000 characters, taxes excluded | the same 4,000-character cap as Aura, priced on UTF-8 bytes. No proxy | https://elevenlabs.io/pricing/api |
| memory Hindsight | retain $10 / million tokens. Recall is $0.75 / million. Reflect is $0.05 / call and ATLAS does not call it. ensureBank, stats, document list and forget have **no published unit** | the request is refused above 65,536 bytes. Input is one token per byte. Recall also sends `max_tokens` (700 on the edge, 300 on the gateway) and reserves that output at the recall rate. Every other operation reserves the request bytes at the retain rate. The flat $0.20 retain is not charged. Settle still uses the usage the response returns. No proxy | https://vectorize.io/pricing |
| jev TypeSafe 1.13 and 1.14 | $0.042 / million input tokens, output free. Default context 64k. ATLAS does not send the long-context header | every request reserves 64,000 input tokens: $0.002688. The body is refused above 64,000 bytes, one token per byte. No proxy | https://docs.typesafe.ai/models |
| realtime OpenAI | audio $32 / $64 per million input / output tokens on gpt-realtime-2.1. Text is $4 / $24. Audio is the dearer modality | the session reserves `min(duration, 900)` seconds at 10 input and 20 output tokens per second, plus one response capped at `max_output_tokens` 900. When observed usage reaches the per-second budget, or the clock reaches that many seconds, the session stops with `budget_exhausted`. Settle sums `response.done` usage and does not clamp. Missing usage keeps the ceiling | https://developers.openai.com/api/docs/models/gpt-realtime-2.1 read 2026-11-11. Audio token timing is about 10 input and 20 output tokens per second (https://dasha.ai/blog/openai-realtime-api, read 2026-11-12); OpenAI does not publish a numeric cap on the special-token variation |

## What is still not a true bound

These are named so they are not reserved as if they were capped. Settle still records an overrun. It does not clamp.

- Hindsight retain, bank setup, stats, document list and forget can bill tokens the service generates beyond the request body. No output cap is published. Worst case: not published. The reservation is the request, one token per byte, at the retain rate.
- OpenAI realtime audio is about 10 input and 20 output tokens per second, with special-token variation that has no published maximum. The session stops when observed usage reaches the reservation, and one in-flight response is inside the ceiling via `max_output_tokens`. A special-token bump on the response that crosses the line can still record an overrun. Worst case of that bump: not published.
- gpt-oss `max_tokens` is documented as the maximum generated in the response, and reasoning is billed as output. The ceiling is the `max_tokens` ATLAS sends, which includes the reasoning budget in `LIMITS`. If a response reports reasoning tokens above that number, the worst case is not published. The 128,000 context window is not a per-call bill.
- A PDF whose page objects sit in a compressed stream is not counted. A Word, HTML or other non-PDF file has no page count ATLAS can read. Both are refused above 10 MB and, when allowed, reserved at the 30-page cap. A compressed or non-PDF file under that byte cap can cause more image work than 30 pages. Worst case of that extra work: not published.
- A provider chat template can add tokens that are not in the UTF-8 body. No per-call maximum for that template is published. The input ceiling is one token per byte of the body that is sent. Worst case of the template: not published.
- Kyutai speech recognition and synthesis are continuous self-hosted sockets. They are not reserved on the month ledger, and there is no per-call audio-second cap on those sockets. Worst case against the $5 ledger: they add nothing to it. Worst case audio duration: the interview. No dollar price for that duration is published here.
- PersonaPlex is a local conversational socket. It is not reserved. Worst case against the $5 ledger: it adds nothing to it.
- Optional NVIDIA Riva transcription (`atlas_voice/notes.py`) sends the microphone recording in 25-second chunks, stops after 150 seconds, and stops the text at 60,000 characters. It is not reserved and it has no price in this table. Worst case dollar amount: not published.

## The visible stop

`exhausted:usd` is the one month-stop outcome. `src/budget-stop.js` is a pure reducer: `pending` plus `refusal` / `exhausted:usd` becomes `{ phase: 'exhausted', code: 'budget_exhausted', message: "This month's AI budget is used up." }`. Any other known refusal becomes `closed` with no user message. Effects stay outside the reducer.

Where a feature would have shown model output, the page shows that one sentence and no helper text. A keyword or lexical result may stay, with the same sentence and without the method line. HTTP routes that have no partial result return 429 `{ error, code }` and do not return 502. Ask and recommend stay HTTP 200 with the lexical cards and `{ budget: { code, message } }`, because a partial result plus the sentence beats a 429 that drops the cards. A voice session refused for the month sends `code` `budget_exhausted` and shows that same sentence, read from `BUDGET_MESSAGE`. The page keys on the code. Other voice failures keep `voice-unavailable` and their own copy. Other `BudgetRefused` reasons still throw. They are not shown as the month sentence and they are not turned into an empty success.

Admin metrics attach `spend` from `ProductionSpendLedger` beside the telemetry rollup: the ledger mode and month-to-date reserved dollars (ceilings still open, plus settled actuals). `queryMetrics` itself stays a pure telemetry rollup. If the ledger read fails, the page says the month-to-date figure was not read. It does not show $0 for a failed read.

## Known limits

- **An unpriced call is refused under enforce.** Every kind production calls today has a ceiling in the table above. `detr-resnet-50` and the Hindsight operations other than retain and recall have no published price; they are covered by the flagged ceilings, not by a null. A future kind with no ceiling is refused. Under observe an unpriced estimate is recorded with `usd: null`.
- **The numbers in `LIMITS` are the ceilings.** Each call passes that `max_tokens`, audio cap or character cap, and reserves the same number. Input text is one token per UTF-8 byte of the body. Audio is rounded up to whole seconds and refused above its cap. The kinds in "What is still not a true bound" are the ones this does not cover. An actual above the reserved ceiling is still recorded as an overrun. Settle does not clamp it.
- **One global month budget.** There is no per-user or per-tenant limit, and the window is a UTC calendar month. `ProductionSpendLedger.apply` is the single writer. Its throughput under many simultaneous interviews has not been measured.
- **Latency.** Enforce adds a ledger round trip before every call, at most 1 s before it refuses.
- **How callers report the month stop.** `exhausted:usd` becomes the one sentence. `storyRater` rethrows `BudgetRefused` and does not retry it as a network error. A review, a slide deck, insights, a one-pager, a sheet draft and spoken Ask transcription return 429 with that sentence. Recommend, Ask and bid match may keep a lexical result and carry `budget` so the page shows the sentence without a method line. Indexing a reference embeds in the background and has no AI-output surface; a refusal writes no vector and shows nothing new.
- **Production configuration is set.** `worker.js` exports `ProductionSpendLedger`. `wrangler.jsonc` binds `SPEND_LEDGER`, migrates it as `v3` `new_sqlite_classes`, and sets `LEDGER_MODE` to `enforce` with no limit override. A test fails if that file sets off.
- **This branch has no live-test ledger.** The local scripts set `LEDGER_MODE=off` themselves. They do not share a second cap with `paid()`.
- **The static check is a source scan.** It catches direct use, the bracket form `env['AI']` and destructuring from `env`. It does not catch deliberately obfuscated access.
- **The Python application uses the same ledger.** `realtime.py`, `editor.py`, `jev.py`, `speech.py` (Workers AI transcribe and synthesize), `analyst.py`, `report.py`, `kyutai.py` `stream_chat`, `notes.py` and `memory.py` (recall, retain, continuity replace, document read and delete) reserve before the upstream request. Local Kyutai STT/TTS sockets are self-hosted and are not in that list. `scripts/run_local_voice.sh` and `scripts/pod_setup.sh` set `LEDGER_MODE=off` and `ATLAS_LEDGER_DEV=1`. `start_gateway.sh` relies on `spend.require_ledger`.
- This is a cost control, not a security or compliance control, and it makes no claim to be complete.
