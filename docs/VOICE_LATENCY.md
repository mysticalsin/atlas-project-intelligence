# Voice turn latency: what the edge pipeline does today, and what anticipation would need

Tony, 2026-11-08 23:06 BRT, asked for very low latency: start processing the next answer before the person has finished.

This is the selected edge route only: `deploy/cloudflare-edge/src/session.js` and `app.js` `workersAI`. It makes no assumptions about how other products do this.

## Current pipeline (source-backed)
| Stage | What happens | Model or setting | Partial or streaming? | Cancellable? |
|---|---|---|---|---|
| Voice activity | `EnergyTurns` (speech.js) on 20 ms PCM frames, in the Durable Object | local | n/a | n/a |
| Semantic end of turn | At `EARLY_PAUSE` = 0.7 s of quiet (after at least 0.6 s of speech), the buffered audio (last 8 s) goes once to the turn model, with a 350 ms race. A verdict of complete with probability ≥ `TURN_PROBABILITY` (0.85) ends the turn. | `TURN_MODEL`, default `@cf/pipecat-ai/smart-turn-v2` | audio-only verdict; no words | result ignored if speech resumes |
| Plain-silence end | `END_SILENCE` = 1.2 s, or `THINKING_PAUSE` = 2.5 s when the turn model heard an unfinished thought | local | n/a | n/a |
| Speech recognition | One batch call on the whole utterance, after the turn has ended. Calls are serialised (`sttChain`). | `STT_MODEL` `@cf/deepgram/nova-3` (multi) | no partials | no; a late result is still ordered and merged |
| Talker | Starts as soon as the transcript is in, in parallel with the evidence analyst; the reply is never held for the analyst | `TALKER_MODEL` `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, `stream: true` | streams tokens | stale generations are dropped (`gen`). The upstream body is now cancelled when the session stops reading. |
| Speech synthesis | Per phrase, pipelined (`SYNTH_AHEAD` = 2). A cached acknowledgement ("Right.") goes first after answers of 12 words or more. | `TTS_MODEL` `@cf/deepgram/aura-2-en` (es: aura-2-es; others: ElevenLabs if configured) | per phrase | queue cleared on withdraw or interrupt |
| Playback gate | No reply audio is sent while the detector hears speech or a transcription is pending. A browser playback report is required before `LEAD_MS` = 300 ms ahead. | local | n/a | n/a |

**Revise or discard already exists at turn level:**
- If the consultant speaks again while ATLAS is still transcribing or composing, or within `CONTINUE_MS` = 1.2 s of her reply actually being heard, the started reply is withdrawn. It is removed from the screen and the history, and both parts are answered as one turn.
- A barge-in on audible speech stops the reply and clears the browser's playback.
- `test/turn-latency.test.js` binds these on deterministic fixtures:
  - a negation that corrects a figure;
  - a late transcript;
  - barge-in;
  - stale tokens;
  - the end-of-turn windows;
  - no work during short pauses.

## Measured locally (synthetic)
The bench is `node deploy/cloudflare-edge/dev/latency-bench.mjs 20`. It uses the real `Session`, mocked AI with zero provider delay, and a virtual clock at 20 ms frame resolution.

Each cell has 20 samples, as cold (first answer of a fresh session) and warm (a later answer). The cold and warm values were identical:

| Scenario | Last sound → transcription starts → first talker text → first reply audio sent |
|---|---|
| Turn model confident | 0.70 s |
| Turn model unsure, or no turn model | 1.20 s |
| Unfinished thought | 2.50 s |

In-process Node overhead from the transcription call to the first audio send has a p50 of 0.07 to 0.11 ms per cell, with a maximum of 1.9 ms on a cold first sample.

These are the pipeline's own waits. A real reply adds on top:
- the turn model call (≤ 0.35 s);
- Nova-3 recognition time;
- the talker's time to first token;
- the first phrase's synthesis, or the cached acknowledgement;
- network and `LEAD_MS`;
- browser playback.

None of these provider times was measured here. Live values exist only as production telemetry (`reply_gap`, `stt`, `reply` first_text_ms / first_audio_ms, `turn_check`), which was not read.

## What starting before the end of the answer would need (approval questions)
Options 1 and 2 below are now implemented as Plan A, off by default and fail-closed without an authoritative admission ledger (none is bound): see `docs/EARLY_PROCESSING.md`. Their spend, the ledger and the notice still need approval before any live use.

The current interfaces have no partial transcript and no streaming recognition. Anything earlier than the end-of-turn windows means extra provider calls on the same audio, a new model, or a product trade-off. None of it is enabled.

1. **Speculative transcription at the early pause.**
   - What: at 0.7 s, transcribe the buffered utterance in parallel with the turn model. If the turn then ends with no new voiced audio, use that transcript; otherwise discard it.
   - Saves: about one Nova-3 recognition time on every turn, and up to 0.5 s more on the plain-silence path, where the talker could start at about 0.7 s instead of 1.2 s.
   - Cost: one extra Nova-3 transcription of the same audio, sent again to the same provider, for every mid-answer pause of 0.7 s or more that is followed by more speech. The source comment rejected this for billing.
   - Needs approval: the extra Workers AI recognition spend, and transmitting the same audio again.
2. **A speculative talker draft from that transcript.**
   - What: composed but never sent, shown or played until the end of turn is reliable; discarded if the transcript changes or speech resumes.
   - Cost: talker tokens for every discarded draft, and the analyst ordering would need care.
   - Needs approval: (1) plus the token spend.
3. **Streaming recognition with partial words and end-of-turn events.**
   - Status: not in the pinned code.
   - Needs:
     - a current Workers AI (or other) model contract checked against official documentation;
     - a model ID and a WebSocket integration inside the Durable Object;
     - a consent and provider review;
     - a live latency and accuracy evaluation.
   - Needs approval: the provider and model choice, spend, and the evaluation.
4. **Shorter windows** (`EARLY_PAUSE`, `END_SILENCE`, `TURN_PROBABILITY`).
   - Cost: none, but a product trade-off. The code says turn-taking is patient on purpose, and shorter windows would interrupt people who are thinking.
   - Needs: Tony's decision, plus a live evaluation of false end-of-turns.
5. **A live baseline first.** An aggregate export of the existing telemetry above would show where the real time goes, before any spend.
