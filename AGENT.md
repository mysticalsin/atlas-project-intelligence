# AGENT.md: the ATLAS interviewer as implemented (Agent Brain v2.1)

What the interviewing agent is, how a turn works, and which code does what, as it stands on branch `v21/T17` (upgrade T0 to T16, review-fix waves G1, S1, H1, H2 and X1). This describes the built behaviour. It is not a claim that the agent has been run against a live model, a live voice or a real consultant: nothing here has been provider verified (see `docs/agent-brain-v2.1/IMPLEMENTATION_STATUS.md`).

The spec pack (`docs/agent-brain-v2.1/02_Agent_Brain/AGENT.md` and the folders around it) says what Atlas should be. This file says what the code does. Where the two differ, `IMPLEMENTATION_STATUS.md` and `docs/agent-brain-v2.1/DECISION_LOG.md` record why.

## 1. Persona: one source

`atlas_voice/persona.py` is the only place the persona is written. Its blocks (`PERSONA_CORE`, `TURN_PATTERN`, `PRAISE_RULES`, `QUESTION_RULES`, `SITUATIONS`, `SAFETY`, `OPENING_BRIEF`) are composed into all three prompts: `cascade.TALKER_POLICY` (the edge and Kyutai talker), `quality.INTERVIEW_POLICY` (OpenAI Realtime) and `interview.ROLE` (PersonaPlex). The same module holds the banks the edge reads through `policy.generated.js`: `BANNED_PRAISE_SRC`, `ACKS` (English only), `PAUSE_LINES`, `RESUME_LINES`.

Character: a warm, curious, calm colleague. It says it is an AI and claims no feelings or memories. It acknowledges the specific thing said, praises only effort or a concrete achievement (never the person, never superlatives), and before a result's basis is known says only that it "sounds promising". It describes events, never people: no inference about a person's performance, feelings, sentiment or skill (decisions D6, D18; the policy gate denies `rate_consultant` and `infer_sentiment` for every role).

The consultant's name never reaches a model (`interview.py`, `session.js`; pinned by tests, including every evaluation scenario).

## 2. The turn pattern

Acknowledge, Explore, Clarify, Connect, Confirm (`TURN_PATTERN_STEPS`). In code, one consultant turn goes through these steps in this order (all in `deploy/cloudflare-edge/src/session.js`, `Session`):

1. **Hear.** Speech to text (Deepgram Nova-3 through the Workers AI binding) returns the words and, since T7, per-word confidences. A typed answer (`text` event, or the whole interview in text mode) enters at the same point.
2. **Pre-pass** (`turns.js analyzeTurn`, ported from `atlas_voice/turns.py`). Deterministic: intents (pause, resume, repeat, skip, dont_know, cannot_disclose, correction, rushed, stop, confirm, deny, question_to_atlas), cues that describe what the words do (metric, vague verb, team claim, setback, achievement, client praise, and so on) and field hints. English has the full set; French and Spanish have intents only.
3. **ASR check** (`asr.js uncertainSpans`, from `asr.py`). A number or proper noun heard below the threshold is confirmed aloud once, never silently converted.
4. **Select** (`selector.js select`, from `selector.py`). Synchronous and deterministic. Priority: wrap-up time, confirm an uncertain span, the consultant wants to stop, a correction, "I don't know" or "I can't share" (the field stays open and is not asked again), a contradiction, a metric without a basis (one part per question), a vague verb, a team claim, a technology list, a certification, client praise, one reflection, then the follow-up ladder (open, example, ownership, decision, evidence, impact, measurement, attribution). Redundancy is checked against the ledger, this turn's hints, the prefill and the asked log. The same point is never asked a third time (a calm offer to move on follows two attempts). Rushed mode asks only the essentials. The result is a Move (kind, intent, field, rung, say, why, reaction, ack_category). It never carries a score.
5. **Acknowledge** (`ack.js pickAck`). A short fixed line chosen from the cues, played from the audio cache while the reply is prepared. Categories include neutral, thanks_detail, no_number_fine, confidential_ok, correction_thanks, setback_neutral, setback_plain, earned_result and promising_unverified. Rules: a line is not repeated within the last four; "earned" praise at most one reply in three and only when the basis is known; never after the consultant asked ATLAS a question or when time is up; only after a real answer (8 words); other languages fall back to the neutral fillers.
6. **Talk.** The talker model (Workers AI Llama, `TALKER_MODEL`) gets the persona prompt, the history and a server-written `NEXT MOVE` note holding the Move's wording. The analyst (`ANALYST_MODEL`) files evidence into the ledger in parallel and refines the next turn.
7. **ReplyGuard** (`speech.js`, from `speech.py`). Applied to whatever the talker streams, in code, whatever the model writes: it keeps one question (cutting the stream after the first), drops standalone banned praise, drops an opener that repeats one of the last three, caps a reply at 45 words, and in a read-back removes any figure the consultant did not say. If the guard empties a reply, the Move's own wording is spoken.
8. **Speak** (Aura-2 English and Spanish; ElevenLabs for other languages if a key exists) and **record**. Barge-in clears the audio and the interruption is recorded.

Time (Tony, 2026-10-31: "20-30 min to get everything we need"; was 15): 20 minutes of active interview are planned (paused and disconnected time excluded) and 30 is the hard cap. With 270 s of the planned end left, if the selector still has an essential question (essential fields, open speech doubts, disagreeing figures), ATLAS asks ONCE whether the consultant can give a few more minutes on that point (`atlas_voice/extension.py`, `extension.js`, `Session.decide`): a clear yes moves the end to 30 minutes, anything else goes to the read-back now, a rushed consultant is never asked, and if the essentials are covered the interview closes early. ATLAS's own speaking is capped at 800 s, the read-back/closing window is the last 270 s of the effective end, the wrap-up the last 90 s, and the 45-minute wall-clock cap (`WALL_CAP_S`) is unchanged.

## 3. What the agent can do besides ask

| Capability | Where | Behaviour |
|---|---|---|
| Opening | `languages.js` (cache), `persona.OPENING_BRIEF`, `cascade.OPENING` | Tony's full pack opening (2026-10-30): purpose, what is captured, that nothing is reused without permission, skip / "I don't know" / "I can't share", and that a summary is read back before anything goes to review. Four short sentences in two cached spoken pieces, about 22 seconds. English authored; fr, es, pt, de, it, nl are faithful translations that need native review. A resumed interview says "it's ATLAS again". |
| Pause, resume, repeat, skip | `session.js`, `voice-controls.js`, `voice-panel.html` | Buttons and spoken words. Paused time is excluded from the 20 minutes and the microphone watchdog; resume says one stock line and the last unanswered question again, with no model call. Skip is an event; the field records `skipped_by_user`. |
| Typed turns and text mode | `session.js`, `voice-client.js` | A typed answer takes the same path as a spoken one (provenance `consultant_typed`). In text mode (X1, "Type instead" before starting) no microphone is requested, no audio is sent, nothing is synthesised, and replies arrive as text. Typing while ATLAS speaks interrupts it. Typed turns are rate limited. |
| ASR confirmation | `asr.js`, selector `confirm_asr` | One uncertain span per turn is read back ("Did you say thirty-five?"); yes settles it, a correction supersedes the detail. |
| Checkpoint and reconnect | `checkpoint.js`, `worker.js` | Only with transcript consent, in the person's own Interview Durable Object, for 24 hours from the first write (absolute, a DO alarm purges it), chunked under the storage limit. A dropped socket suspends the interview; the browser reconnects up to three times (1, 2, 4 s) or offers Resume on the next page load. A discard, withdrawal, clean end or fresh start purges at once. Gap mode is not resumable. |
| Summary read-back | `summary.js`, `session.js`, summary card | At the close the facts come from the ledger in the consultant's own words, with open points listed, and the question "What have I misunderstood or missed?". The card offers Correct (a typed correction supersedes the item), Keep private (the whole utterance is replaced by `[kept private]` in the history, notes and report input) and Confirm. A spoken "that's right" does not confirm; the button does. |
| Evidence draft and submission | `evidence.js`, `library-routes.js` | Confirming creates an owner-only `evidence_draft` (server to server, under the verified identity). "Submit for review" is a separate explicit click that names the revision. |
| Review and approval | `policy-gate.js`, `evidence.js` | An accountable reviewer (resolved N+1, or a reviewer role) approves one exact revision and content hash. Not the owner, not the author of the revision. A new revision voids earlier approvals. |
| Branches | `branches.js`, `jobs.js`, `adapters.js` | Approval creates seven independent branch records (evidence, MAAP, Project Review, DNA, MeChat, IMP, Spotlight). Destination adapters are mocks, shown as "Mock, not connected". See section 6. |

The agent's tools and prompts cannot approve, publish, grant access, write private memory or file anything but an owner-only draft.

## 4. Architecture of the live edge path

```mermaid
flowchart TD
  subgraph Browser
    UI[voice-client.js, voice-controls.js<br/>orb, pause, type, summary card]
  end
  subgraph Worker["Cloudflare Worker (app.js)"]
    AUTH[Access / Entra identity, Origin, CSRF<br/>bootstrap flags]
  end
  subgraph IDO["Interview Durable Object (worker.js, one per person)"]
    S[Session session.js]
    TURNS[turns.js pre-pass]
    ASR[asr.js uncertain spans]
    SEL[selector.js next move]
    ACK[ack.js acknowledgement]
    GUARD[speech.js ReplyGuard]
    SM[conversation-state.js<br/>interview machine, audit]
    LED[ledger.js evidence ledger]
    SUM[summary.js read-back]
    CK[checkpoint.js 24 h, consent only]
  end
  subgraph Models["Workers AI (and ElevenLabs for other languages)"]
    STT[Nova-3 speech to text]
    LLM[Talker and analyst models]
    TTS[Aura-2 speech]
  end
  subgraph LDO["LibraryStore Durable Object"]
    EV[evidence.js claims, revisions]
    GATE[policy-gate.js default deny]
    BR[branches.js, jobs.js]
    AD[adapters.js mocks]
  end
  PY[("atlas_voice Python modules<br/>policy source of truth")] -. build_edge.py generates .-> GEN[policy.generated.js]
  GEN -. constants and tables .-> S
  UI <-->|WebSocket: audio, events| AUTH
  AUTH --> S
  S --> STT --> TURNS --> ASR --> SEL --> ACK
  SEL --> LLM --> GUARD --> TTS --> UI
  LLM -. analyst .-> LED
  S --- SM
  S --- SUM
  S --- CK
  SUM -->|confirm: owner-only draft| EV
  EV --> GATE --> BR --> AD
  AD -->|"mock_acknowledged, never synced or published"| BR
```

Layers, bottom up: Python policy and pure logic (`atlas_voice/`: persona, turns, selector, asr, conversation_state, workflow_config, success_story, plus the ledger in `quality.py`); generated edge constants (`deploy/cloudflare-edge/src/policy.generated.js`, never edited by hand); parity-tested JavaScript ports (`turns.js`, `selector.js`, `asr.js`, `speech.js`, `conversation-state.js`, `story-projection.js`, `ledger.js`); the Session that orders a turn; the Worker and Durable Objects that hold identity and storage; the browser. Python is the source of truth: a policy change is made in Python, `build_edge.py` regenerates the constants, and the parity vectors under `deploy/cloudflare-edge/test/` must still pass.

The Python `cascade.py` route (Kyutai) shares the persona and the pure modules but does not run the v2 conversation: the v2 turn handling is wired into the edge only (decision D15).

## 5. Switches, defaults and rollback

All are Worker variables. Each default is the new behaviour; the legacy value restores the earlier one. Rolling back a deployed Worker is a Worker version rollback done by Tony.

| Variable | Default | Values and effect | Verified in |
|---|---|---|---|
| `ATLAS_SELECTOR` | `v2` | `legacy`: the analyst's guidance is used one turn late and the selector is off | `session.js sessionFlags` |
| `ATLAS_REPLY_GUARD` | `on` | `off`: no code enforcement of one question, praise, openers, length | `session.js sessionFlags` |
| `ATLAS_ACKS` | `content` | `legacy`: the content-blind stock fillers | `session.js sessionFlags` |
| `ANALYST_WAIT_MS` | `0` | milliseconds (capped at 1500) to wait for the analyst while the acknowledgement plays, then re-select | `session.js sessionFlags` |
| `TALKER_MAX_TOKENS` | `160` | maximum tokens of a spoken reply (was 300) | `app.js` |
| `SPECULATIVE_STT` | off | Reserved: read but has no effect; speculative transcription is not implemented | `session.js sessionFlags` |
| `ASR_CONFIRM_TAU` | `0.55` | confidence below which a number or name is confirmed aloud; a pilot value, not calibrated | `asr.js tauFrom`, `asr.py` |
| `ATLAS_CHECKPOINT` | on | `off`: no checkpoints, a dropped interview is not resumable | `checkpoint.js checkpointEnabled` |
| `ATLAS_EVIDENCE_WORKFLOW` | `on` | `off`: a confirmed summary is not filed, and the fan-out, status and sync routes are off | `adapters.js evidenceWorkflowOn` |
| `ATLAS_ADAPTERS` | `off` | `mock`: the four destination mocks run; `live` is allowed per connection only when it is configured and ready (`docs/CONNECTIONS.md`), otherwise `BLOCKED_EXTERNAL`; anything else is `off` | `adapters.js adapterMode` |

Endpointing and temperature are unchanged (Tony, Q5). `SPECULATIVE_STT` and `ANALYST_WAIT_MS` stay off.

## 6. What is deliberately not done

- **D2 and D3: MAAP and Project Review ratings.** The rubric is `MUST_BE_CONFIGURED_BY_PROCESS_OWNER`. Only the shell and the gate exist. Rating or closing a review returns `MAAP_NOT_CONFIGURED` or `PROJECT_REVIEW_NOT_CONFIGURED`.
- **D4: Spotlight publication.** `SPOTLIGHT_CMS` is a mock that can hold, never publish. The library's old "published" label is now "Shared in internal library" (D17) and the gate refuses to map it to Spotlight.
- **D5: live DNA, MeChat, IMP.** `BLOCKED_EXTERNAL`: no endpoint, schema or credential exists in this repository. The mocks answer from memory and every acknowledgement is `mock: true`, shown as "not synced". `sync_complete` and `published` need a non-mock acknowledgement.
- **D6: people inference.** Turnover, peer comparison, sentiment and performance scoring are out of scope and denied by the gate. Non-negotiable.
- **Not built, not claimed:** an artifact upload or registry (an artifact is a sentence naming it); a server-side check that the prefilled project context belongs to the signed-in person; review owners for MAAP or Project Review; non-English selection wording or cues (English wording is used for every language); translated acknowledgements and stock lines; a "read replies aloud" toggle in text mode; speculative transcription.
- **Never done by the agent:** approving, publishing, granting access, writing private memory, or telling a consultant how their words will be judged.

## 7. Where to look

- Spec pack: `docs/agent-brain-v2.1/` (start at `README.md`). Decisions: `DECISION_LOG.md`. Gap analysis at baseline: `GAP_ANALYSIS.md`. Status per requirement: `IMPLEMENTATION_STATUS.md`. Evaluation: `eval/COVERAGE.md`.
- Code map: `handoff/CODE_MAP.md` (section "Agent Brain v2.1"). Build log: `handoff/BUILD_STATUS.md`. Integration contracts: `docs/INTEGRATIONS.md`.
- Tests: `make test` (everything), `make test-eval` (offline conversation, workflow and rubric evaluation, 52 tests), `make test-ui` (browser suites, needs Chromium).
