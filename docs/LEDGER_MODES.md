# Production spend meter: `LEDGER_MODE`

**Status (run82):** production `wrangler.jsonc` sets `LEDGER_MODE=enforce`, exports `ProductionSpendLedger`, and binds it as `SPEND_LEDGER` (migration `v3`, `new_sqlite_classes`). No `PRODUCTION_MONTHLY_LIMIT_USD` override, so the $5 UTC-month default applies. Voice mode stays baseline: `speculationConfig(this.env, null)`, no `EARLY_STT` or `EARLY_DRAFT`. It has not been exercised against a live provider. The code default when the variable is unset is still **off**, which is what the live-test configs keep.

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

The live-test REST stand-in for the AI binding (`spend-ledger.js` `restBinding`) is the one other file with a paid endpoint. It is reachable only through `meteredRestAI`, and from there through `workersAI`, so through `paid()` too.

The unpaid direct fetches are:
- the Access signing keys;
- the DNA directory;
- Microsoft identity and Bot Framework;
- the Durable Objects' own handlers;
- same-origin browser requests;
- the local live-test harness.

## The three modes

`LEDGER_MODE` is a Worker variable. Production sets `enforce`. The live-test wrangler files do not set it.

- **off** is the default; unset, empty or `off` all mean off. Each call is made exactly as before: the same arguments, same count and order, and the same result object. No estimate is computed, and `SPEND_LEDGER` is never read. `test/ledger-off.test.js` compares 20 upstream calls and every output against a golden recorded at d88effdd.
- **observe** never blocks or delays a call.
  - Each call writes one log line: `atlas_metric: ledger`, the kind, the configured model or provider name, numbers (audio ms, token estimates, characters, files, requests) and an estimated USD figure, or `null` when unpriced. It never contains prompt, transcript, story or key text.
  - When a `SPEND_LEDGER` binding exists, the estimate is also sent to its `record()` without being awaited.
  - When the binding is missing, or a lookup or `record()` throws, rejects or hangs, the result is log-only and the call is unaffected.
- **enforce** is opt-in only. Before the upstream call, the ledger must return `{ ok: true, id }` from `reserve()`.
  - Each of these refuses the call with a `BudgetRefused` error and nothing reaches the upstream: no binding (`no_ledger`); a throw or rejection (`ledger_error`); no answer within 1 s (`ledger_timeout`); a malformed answer; or a refusal from the ledger (`exhausted:usd`, `unpriced`, `limit_unset`).
  - After the call, the reservation is settled, never refunded.
  - The analyst's reasoning retry is not attempted after a refusal.
- **Any other value**, for example a typo, refuses every paid call (`invalid_mode`). Setting the variable at all is an explicit opt-in, so a typo must not silently mean off.

The guarantee in each mode is only what is listed here. Off guarantees unchanged behaviour, not any spend limit. Observe guarantees records only when a working ledger is bound; otherwise it guarantees log lines. Only enforce bounds spend, and only to the extent of its known limits listed below.

## Why the code default stays off

Observe would also be safe as a code default: it cannot block a call, logs only numbers, and with no binding it is log-only. The code default stays off because:
- observe adds one log line to every paid call, including each streamed talker reply and each speech-synthesis piece;
- it has not been run against a real deployment;
- an unset variable, including every live-test config, must stay identical to the golden.

Production is the exception. Tony's decision, via Jarvis at 18:19 BRT on 2026-11-11: "Everything AI: price every model call and put all of it under the same $5." Production sets enforce. The live-test configs do not.

## Production limit: $5 per UTC month

Tony's decision, relayed via Jarvis at 17:03 BRT on 2026-11-11: production voice spend is **$5 per calendar month** (UTC), fail closed. `PRODUCTION_MONTHLY_LIMIT_USD = 5` in `src/meter.js`. The earlier $15 per UTC day proposal is not the limit.

Admission is `month-to-date reserved nano + this call's worst case <= 5_000_000_000` nano-dollars (`Math.round(5 * 1e9)`). Equal to the cap is admitted. One nano over is `exhausted:usd`. Reservations are not refunded on settle, cancel or failure. The next UTC day in the same month does not reset the counter. At `YYYY-MM-01T00:00:00Z` the pure `rollover` event in `src/month-budget.js` opens the new month at zero. That file is the only writer of the month. `docs/STATE-MACHINE-STANDARD.md` is not vendored on this branch; the machine follows its rules (typed states and events, one pure transition, no I/O in the reducer, versioned persistence, unknown or legacy records deny and are not healed).

The worst case for a Workers AI binding call (`@cf/…` or `toMarkdown`) is the list-price ceiling plus the binding proxy worst case, `0.30 / 1e6 + 300000 * 0.02 / 1e6` dollars (`PROXY_PER_CALL_NANO` = 6,000,300). ElevenLabs, Hindsight and TypeSafe are direct fetches and do not get the proxy. A model or provider with no price still returns null from `priceOf` and is refused under enforce. Every kind production can call now has a positive ceiling, so that refusal is for a future unpriced kind, not for the current set. `test/priced-kinds.test.js` fails if a `paid()` estimate arrow names a kind or provider without one. The live-test ledger's $1.50 cap is a different ledger and is unchanged.

The default applies when the limit is omitted. Production omits it. An explicit null, blank, zero, negative or unparseable `limitUsd` or `PRODUCTION_MONTHLY_LIMIT_USD` denies with `limit_unset`. A ledger read or write failure denies with `ledger_error`. A legacy day record, a bad version or a month that is not `YYYY-MM` denies with `unknown_month` and stays denied across the next month boundary. None of these fall through to an unmetered provider call. A voice session refused mid-call still ends with `error` / `voice-unavailable` and the words "Voice is paused for this month. No unmetered call was made."

## Prices (read 2026-11-11)

| Kind | List price | Ceiling per call | Source |
|---|---|---|---|
| stt nova-3 | $0.0052 / audio minute | whole seconds, rounded up, plus proxy | Workers AI pricing table, last updated 2026-10-20, https://developers.cloudflare.com/workers-ai/platform/pricing/ |
| turn smart-turn-v2 | $0.00033795 / audio minute | at most 8 s, plus proxy. The page also lists 0.51 neurons / minute; the higher figure is used | same table |
| talker llama-3.3-70b | $0.293 / $2.253 per million input / output tokens | `max_tokens` output plus the input estimate, plus proxy | same table |
| tts aura-2-en, aura-2-es | $0.030 / 1,000 characters | the character count, plus proxy | same table |
| analyst gpt-oss-120b | $0.35 / $0.75 per million tokens | the call's input and output token estimates, plus proxy. The model page lists the same dollars | https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/ |
| embed bge-m3 | $0.012 per million input tokens | the input token estimate, plus proxy. The model page lists $0.0118; the higher figure is used | https://developers.cloudflare.com/workers-ai/models/bge-m3/ |
| markdown / toMarkdown | documents are free. An image uses detr-resnet-50, which has **no published price**, then Gemma 4 26B at $0.100 / $0.300 per million tokens | every file, including a document, reserves two Gemma calls at 8,192 input and 1,024 output tokens: $0.0022528 per file, plus one proxy. The detector is reserved at the same Gemma ceiling | https://developers.cloudflare.com/workers-ai/features/markdown-conversion/ and https://developers.cloudflare.com/workers-ai/features/markdown-conversion/how-it-works/ (updated 2026-10-15). Gemma is on the pricing table. https://developers.cloudflare.com/workers-ai/models/detr-resnet-50/ says the model is not in the catalog |
| tts ElevenLabs `eleven_flash_v2_5` | $0.04 / 1,000 characters, taxes excluded | the character count. No proxy | https://elevenlabs.io/pricing/api |
| memory Hindsight | retain $10 / million tokens. Recall is $0.75 / million. Reflect is $0.05 / call and ATLAS does not call it. ensureBank, stats, document list and forget have **no published unit** | every request reserves a 20,000-token retain: $0.20. No proxy | https://vectorize.io/pricing |
| jev TypeSafe 1.13 and 1.14 | $0.042 / million input tokens, output free. Default context 64k. ATLAS does not send the long-context header | every request reserves 64,000 input tokens: $0.002688. The sites send `requests: 1` and not a measured body, so this is the published context cap. No proxy | https://docs.typesafe.ai/models |

## The visible stop

`exhausted:usd` is the one month-stop outcome. `src/budget-stop.js` is a pure reducer: `pending` plus `refusal` / `exhausted:usd` becomes `{ phase: 'exhausted', code: 'budget_exhausted', message: "This month's AI budget is used up." }`. Any other known refusal becomes `closed` with no user message. Effects stay outside the reducer.

Where a feature would have shown model output, the page shows that one sentence and no helper text. A keyword or lexical result may stay, with the same sentence and without the method line. HTTP routes return 429 `{ error, code }` and do not return 502. A voice session refused mid-call keeps the existing voice-unavailable sentence. Other `BudgetRefused` reasons still throw. They are not shown as the month sentence and they are not turned into an empty success.

Admin metrics do not show month-to-date reserved spend. `queryMetrics` rolls up telemetry rows, and its cost figure is the optional operator token rate (`costStatus: not-configured` when those rates are unset). Reserved spend lives in `ProductionSpendLedger`, a different store. Mixing them would make the metrics function impure or present the telemetry figure as the $5 cap.

## Known limits

- **An unpriced call is refused under enforce.** Every kind production calls today has a ceiling in the table above. `detr-resnet-50` and the Hindsight operations other than retain and recall have no published price; they are covered by the flagged ceilings, not by a null. A future kind with no ceiling is refused. Under observe an unpriced estimate is recorded with `usd: null`.
- **Estimates are ceilings, not bills.** Audio is rounded up to whole seconds; talker output is reserved at `max_tokens`; input tokens are UTF-8 bytes plus an allowance.
- **One global month budget.** There is no per-user or per-tenant limit, and the window is a UTC calendar month. `ProductionSpendLedger.apply` is the single writer. Its throughput under many simultaneous interviews has not been measured.
- **Latency.** Enforce adds a ledger round trip before every call, at most 1 s before it refuses.
- **How callers report the month stop.** `exhausted:usd` becomes the one sentence. `storyRater` rethrows `BudgetRefused` and does not retry it as a network error. A review, a slide deck, insights, a one-pager, a sheet draft and spoken Ask transcription return 429 with that sentence. Recommend, Ask and bid match may keep a lexical result and carry `budget` so the page shows the sentence without a method line. Indexing a reference embeds in the background and has no AI-output surface; a refusal writes no vector and shows nothing new.
- **Production configuration is set.** `worker.js` exports `ProductionSpendLedger`. `wrangler.jsonc` binds `SPEND_LEDGER`, migrates it as `v3` `new_sqlite_classes`, and sets `LEDGER_MODE` to `enforce` with no limit override. Voice stays `speculationConfig(this.env, null)`.
- **The live test must not set `LEDGER_MODE`.** If it did, calls would be metered twice: by the live-test ledger and by `paid()`. Under enforce, that second reservation would also be refused, because the live-test ledger requires a session. `test/ledger-livetest.test.js` checks that the live-test configs do not set it.
- **The static check is a source scan.** It catches direct use, the bracket form `env['AI']` and destructuring from `env`. It does not catch deliberately obfuscated access.
- **The Python application (`atlas_voice/`) is not covered.**
- This is a cost control, not a security or compliance control, and it makes no claim to be complete.
