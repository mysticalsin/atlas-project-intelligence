# Plan A early processing (edge route): early batch transcription and an optional cancellable draft

Tony asked for Plan A from `atlas-low-latency-options` (2026-11-08). That comparison was planning input; its prices, caps and gains are not approved runtime configuration, and nothing here is a cost guarantee.

**Status:** implemented on the edge `Session` and verified with deterministic local fixtures only. It is off by default and cannot turn on in the deployed Worker, because no authoritative admission ledger is bound there. No live provider call, spend, telemetry read, microphone or deployment was used to build or test it.

## What it does
This is batch work during a pause, not streaming partials while the consultant talks.

1. **Phase 1, early transcription** (`EARLY_STT=1`). At the existing early pause (`EARLY_PAUSE` = 0.7 s of quiet after at least 0.6 s of speech, the same moment the turn model is asked), the utterance so far is sent once to the same batch speech recognition. Nothing about the end of turn changes: the turn model, `TURN_PROBABILITY`, `END_SILENCE` and `THINKING_PAUSE` decide exactly as before.
2. **Phase 2, text draft** (`EARLY_DRAFT=1`, only with `EARLY_STT=1`). If the early transcript returns while the pause is still open, a text draft of the reply is composed from the prompt the reply would have. It is buffered only.

Phase 1 can be evaluated on its own before drafts.

**Reuse rule.** At a reliable end of turn, the early transcript is used only if the audio being transcribed is the early audio extended by silence alone: no voice since, the same bytes as a prefix. The draft is adopted only if that transcript was used and the reply's actual prompt is byte-identical to the draft's prompt. That covers the history, guidance, per-turn notes, language note, acknowledgement and instruction. Anything else takes the existing path: the normal batch transcription, then a normally composed reply.

**Nothing speculative is committed.** Before a reliable end of turn there is:
- no on-screen text, `user_text`, audio, TTS, history entry or analyst/ledger call;
- no tool call, report or memory write;
- no `quality` event.

An adopted draft reaches the screen and speakers through the same paced path as any reply, after the end of turn.

**Withdrawal.** Everything started at a pause is withdrawn when:
- voice resumes (continued speech, a correction or negation);
- the utterance closes as a blip;
- the audio changes;
- the consultant barges in;
- the turn yields no words;
- End, discard, a disconnect, a failure or the time limit ends the session.

A withdrawn draft's stream is closed upstream (the existing `chatStream` `finally` cancels the reader). An early transcription cannot be aborted through the current adapter, so it runs to completion and its result is discarded. Late or reordered results are discarded by identity: only the current pause's request can be used. A failed or timed-out early transcription falls back to the normal call once. No retries of speculative requests exist, and a turn is committed exactly once, in order.

**Admission and fail-closed.** Before every speculative provider request, the session reserves it with the injected ledger. The reservation covers:
- audio milliseconds, every request counted in full, repeated audio included;
- estimated prompt tokens and the maximum output tokens;
- one request.

The ledger also counts requests still in flight. A refusal, error or answer slower than 150 ms means no request. An exhausted or unavailable ledger stops early processing for the rest of the session. A concurrency refusal skips only that pause. The interview itself is never affected.

Reservations are **never refunded** on cancel or discard, because a provider may bill audio or tokens already sent. Observed values (audio sent, output chunks and characters) are recorded separately at settle. Billing telemetry is never used as the barrier.

## Flags and ledger
| Setting | Where | Default |
|---|---|---|
| `EARLY_STT` | Worker env | unset: off |
| `EARLY_DRAFT` | Worker env | unset: off; ignored without `EARLY_STT` |
| Admission ledger | injected into `speculationConfig(env, ledger)` | **none bound**: off, logged as `early_unavailable` |

`speculationConfig` accepts only a ledger declaring `scope: 'global'`, meaning its authority spans every Durable Object instance and session. `MemoryLedger` (`src/speculation.js`) is a process-local implementation with explicit caps, used by the tests and the bench. It defaults to `scope: 'process'` and is refused for deployment: a session-local or isolate-local counter cannot enforce an experiment-wide cap. A real shared ledger would need a new binding or service, which this change does not provision.

Engineering bounds per request (`LIMITS`; these are not cost caps):

| Bound | Value |
|---|---|
| Maximum audio per early transcription | 30 s |
| Early transcriptions per turn | 3 |
| Draft `max_tokens` | 300, the same bound as a reply; `chatStream` `maxTokens` can only lower it |
| Draft prompt estimate | at most 12,000 tokens |
| Draft adoption window | 8 s |
| Ledger decision timeout | 150 ms |

## Accounting units (estimates are labelled)
- **Audio:** milliseconds of 24 kHz PCM16 sent, computed as bytes ÷ 48. This is what the session sends, not what a provider bills. The Nova-3 billing unit and rounding are not verified.
- **Prompt tokens:** an upper-bound estimate, the UTF-8 bytes of every message plus 8 per message plus 16. It assumes every token covers at least one byte, and it is not the provider's tokenizer count.
- **Output tokens:** the reserved maximum (300). Observed output is counted as streamed chunks and characters, not tokens.
- **Unknown:** turn-model, Workers and AI Gateway prices; whether a cancelled stream or an abandoned batch call stops billing; account discounts. No all-in invoice cap can be claimed.

## Route coverage
| Route | Plan A | Why |
|---|---|---|
| Edge Workers + Durable Object (`deploy/cloudflare-edge/src/session.js`) | **Implemented**, off by default, fail-closed | The only route with a batch speech recognition call after a local end-of-turn decision |
| Kyutai cascade (`atlas_voice/cascade.py`) | Unsupported, unchanged | A separate Python pipeline with no withdraw/merge machinery; it would need its own design and tests |
| Hosted OpenAI Realtime (`atlas_voice/realtime.py`) | Not applicable, unchanged | The provider runs turn detection and transcription on the stream; the server has no batch call to move earlier |
| PersonaPlex (`server.py`) | Not applicable, unchanged | A full-duplex speech model with no separate speech recognition stage |

## Conditional overlap (local bench, not a live gain)
`node deploy/cloudflare-edge/dev/early-overlap-bench.mjs` runs the real `Session` with mocked delays that are chosen inputs: turn model 0 or 0.3 s, speech recognition 0.3 or 0.8 s, talker first token 0.4 s. It shows what the design implies:
- **Turn model confident:** early transcription can hide at most the turn model's own time (0.3 s here). With an instant turn model it hides nothing, and drafts never start because the turn ends first.
- **Turn model unsure (plain silence, 1.2 s):** early transcription hides up to min(speech recognition time, 0.5 s). A draft additionally hides the talker's first-token time only when the early transcript returns before the end of turn.
- **Not measured:** real provider times, network, first audible audio, accuracy and live cost. The bench output is evidence of the mechanism only.

## What is still needed before any live evaluation
1. A shared, authoritative admission ledger with approved caps (a new binding or service, with its own review and spend).
2. Tony's approval of spend for repeated audio and discarded draft tokens.
3. Review and approval of the notice in `docs/EARLY_PROCESSING_NOTICE_DRAFT.md`, and of whether existing consent covers it. It must not be assumed.
4. A capped live measurement of first audible audio, not audio sent, with estimated and actual usage compared.
