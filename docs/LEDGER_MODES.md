# Production spend meter: `LEDGER_MODE`

**Status (run70, local only):** implemented and tested offline with fakes. It has not been exercised live. Nothing is bound in the production `wrangler.jsonc`, and the shipped mode is **off**.

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

`LEDGER_MODE` is a Worker variable. It is set nowhere in this repository.

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

## Why off is the shipped default

Observe would also be safe to ship as the default: it cannot block a call, logs only numbers, and with no binding it is log-only. It is not shipped as the default for three reasons:
- it adds one log line to every paid call, including each streamed talker reply and each speech-synthesis piece, which changes log volume in production;
- it has not been run against a real deployment;
- the brief is that the default production behaviour must stay identical.

The suggested order is off, then observe for a period to compare estimates with the Cloudflare bill, then enforce.

## Production limit: $5 per UTC month

Tony's decision, relayed via Jarvis at 17:03 BRT on 2026-11-11: production voice spend is **$5 per calendar month** (UTC), fail closed. `PRODUCTION_MONTHLY_LIMIT_USD = 5` in `src/meter.js`. The earlier $15 per UTC day proposal is not the limit.

Admission is `month-to-date reserved nano + this call's worst case <= 5_000_000_000` nano-dollars (`Math.round(5 * 1e9)`). Equal to the cap is admitted. One nano over is `exhausted:usd`. Reservations are not refunded on settle, cancel or failure. The next UTC day in the same month does not reset the counter. At `YYYY-MM-01T00:00:00Z` the pure `rollover` event in `src/month-budget.js` opens the new month at zero. That file is the only writer of the month. `docs/STATE-MACHINE-STANDARD.md` is not vendored on this branch; the machine follows its rules (typed states and events, one pure transition, no I/O in the reducer, versioned persistence, unknown or legacy records deny and are not healed).

The worst case for STT, smart-turn, talker and TTS is the list-price ceiling plus the Workers AI binding proxy worst case, `0.30 / 1e6 + 300000 * 0.02 / 1e6` dollars (`PROXY_PER_CALL_NANO` = 6,000,300). Unpriced models stay unpriced and are refused under enforce. The live-test ledger's $1.50 cap is a different ledger and is unchanged.

The default applies when the limit is omitted. An explicit null, blank, zero, negative or unparseable `limitUsd` or `PRODUCTION_MONTHLY_LIMIT_USD` denies with `limit_unset`. A ledger read or write failure denies with `ledger_error`. A legacy day record, a bad version or a month that is not `YYYY-MM` denies with `unknown_month` and stays denied across the next month boundary. None of these fall through to an unmetered provider call. A refusal ends the voice session with `error` / `voice-unavailable` and the words "No unmetered call was made." The page already shows that error as the stable stopped state.

`LEDGER_MODE` is still unset in `wrangler.jsonc`, and `SPEND_LEDGER` is still not bound. Off remains the shipped mode, so this cap is what enforce admits against. Turning it on in production is a later configuration change, not part of this branch.

## Known limits

- **Unpriced calls are refused under enforce.** `src/prices.js` has sourced list prices only for nova-3, smart-turn-v2, llama-3.3-70b-instruct-fp8-fast and Aura en/es. The analyst model (gpt-oss-120b), the embeddings model (bge-m3), `toMarkdown`, ElevenLabs, TypeSafe and Hindsight are therefore refused under enforce until their prices are read from the providers' pricing pages and added. Under observe they are recorded with `usd: null`.
- **Estimates are ceilings, not bills.** Audio is rounded up to whole seconds; talker output is reserved at `max_tokens`; input tokens are UTF-8 bytes plus an allowance.
- **One global month budget.** There is no per-user or per-tenant limit, and the window is a UTC calendar month. `ProductionSpendLedger.apply` is the single writer. Its throughput under many simultaneous interviews has not been measured.
- **Latency.** Enforce adds a ledger round trip before every call, at most 1 s before it refuses.
- **How callers report a refusal.** Callers keep their existing failure handling. For example, `storyRater` reports a refused request as a `network` failure and retries within its own budget; each retry is refused too.
- **Enabling needs production configuration changes, which are not made here:**
  - setting the limit;
  - exporting `ProductionSpendLedger` from the Worker entry;
  - a Durable Object binding named `SPEND_LEDGER` plus a migration;
  - setting `LEDGER_MODE`.
- **The live test must not set `LEDGER_MODE`.** If it did, calls would be metered twice: by the live-test ledger and by `paid()`. Under enforce, that second reservation would also be refused, because the live-test ledger requires a session. `test/ledger-livetest.test.js` checks that the live-test configs do not set it.
- **The static check is a source scan.** It catches direct use, the bracket form `env['AI']` and destructuring from `env`. It does not catch deliberately obfuscated access.
- **The Python application (`atlas_voice/`) is not covered.**
- This is a cost control, not a security or compliance control, and it makes no claim to be complete.
