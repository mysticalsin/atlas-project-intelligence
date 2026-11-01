# Implementation status: Agent Brain v2.1

Filled in from `08_Implementation/IMPLEMENTATION_STATUS_TEMPLATE.md`. Date: 2026-10-31. Tree: branch `v21/T17` on `2380cd4` (tasks T0 to T16, review-fix waves G1, S1, H1, H2, X1, then T17). Baseline before the upgrade: `efb4948`.

**v2.2 (Wave 2, 2026-10-31).** On top of v2.1 the branch now carries: multilingual conversation (L1, C19), GDPR controls (G2, section 9), connections framework (C1, `docs/CONNECTIONS.md`), 20–30 minute interview (R2), MiChat naming (M1), strict CSP and safe rendering (F1, section 10), the unslop interface pass (F2, section 11), two red-team retests and their fixes (X1 section 12, X2 and X3 section 13), the local demo (D1, section 14) and the core end-to-end flow from the box session (`MERGE-NOTES.md`). Wording: privacy controls implemented; DPO sign-off required. Nothing is deployed.

**v2.2 U2 (2026-10-31, Tony's words, `DECISION_LOG.md` D-U2).** A visible **Stop interview** button (voice and typed; sheet: Stop and review what you said, Stop and discard, Cancel); **no invitation to skip or to say "I don't know"** (the opening in all 7 languages now carries one client-confidentiality line instead, native review due), no Skip control, "I don't know" / "pass" / "skip" met with up to two easier angles then recorded open, "that's all" held until the essentials are covered; and the **white disc behind the orb** while connecting (a disabled-button rule in `ui.css`) fixed with a regression check. Locally verified only: the live model's behaviour under the new prompts, and the six translated confidentiality lines, are unproven.

**Read this first.**
- **Provider verified: none.** No Workers AI model, no Deepgram or ElevenLabs voice, no Durable Object on a deployed Worker, no DNA, MiChat, IMP, MAAP, Project Review or Spotlight system, and no real consultant has touched any of this. Every "locally verified" below means an offline test on synthetic data against fakes and mocks passed.
- **Not deployed.** Nothing was pushed or published.
- **No claim of production readiness is made or implied.** The release gates in section 5 are mostly open, and the pack's own quality gate (conversation quality set with pilot users) has not started.
- A passing test shows the code does what the test says. It does not show the live model sounds humane, that a latency target is met, or that a destination system accepts a payload.

**Status key** (the template's words are extended to separate what exists from what was proved):
- **Implemented**: the code exists on the branch. Says nothing about quality.
- **Locally verified**: an offline test proves it, named as `file::test`. Paths are relative to `deploy/cloudflare-edge/test/` (`.test.js`) or `tests/` (`test_*.py`, `*_browser.py`) unless a full path is given.
- **Provider verified**: a real external service was exercised. The answer is **none** in every row; the column is kept so nobody has to infer it.
- **PARTIAL**: built in part; the row says what is missing.
- **BLOCKED_EXTERNAL**: needs an external system, key, schema or owner decision that does not exist in this repository. The row names the owner and the API needed.
- **Needs native review / uncalibrated / unverified**: collected in section 6.

Last verified date for every row: 2026-10-31 (offline suites on the tree above: root `node --test` 461 tests, 460 pass, 1 skipped by design; edge `node --test` 939; `pytest` 627; `make test-eval` 52; details in `handoff/BUILD_STATUS.md`, session T17).

## 1. Conversation behaviour

Rows follow `GAP_ANALYSIS.md`. Owner is Tony unless stated.

| ID | Requirement | Status | Evidence: code, and local test | Provider | Open items and next action |
|---|---|---|---|---|---|
| C1 | One persona, praise calibrated | Implemented; locally verified | `atlas_voice/persona.py` composed into all three prompts. `test_persona.py::test_talker_policy_is_short_and_has_no_filler_praise`, `::test_every_prompt_embeds_the_persona_blocks`, `::test_prompts_do_not_name_the_consultant_or_promise_publication`; `eval-rubric.test.js` (stock lines) | none | How well Llama follows the prompt is unverified. Next: pilot with consultants. |
| C2 | One question per turn | Implemented (code, not prompt); locally verified | ReplyGuard `speech.py`/`speech.js`. `test_speech.py::test_guard_first_question_ends_the_reply_and_the_stream`; `session-humane.test.js::b`; `eval-workflow.test.js::W4`; every eval scenario in adversarial mode | none | The guard enforces structure only. In a free reply a figure the talker invents is still voiced (it is removed only in the read-back); the prompt is the only control there. |
| C3 | Acknowledge, explore, clarify, connect, confirm | PARTIAL | `TURN_PATTERN` in the prompt; the Session orders acknowledge, select, talk, guard in code. `test_persona.py::test_talker_policy_has_the_turn_pattern_in_order`; `session-humane.test.js::c` | none | Acknowledge and the one question are enforced. Connect and Confirm rely on the talker following the NEXT MOVE note: Llama adherence to NEXT MOVE is unverified. |
| C4 | Opening | Implemented; locally verified | `languages.js` (two cached pieces), `persona.OPENING_BRIEF`, `cascade.OPENING`. `language.test.js` (opening pinned verbatim), `session-humane.test.js::e`, `::e2`; `test_persona.py::test_the_spoken_opening_covers_the_pack_points_in_every_prompt` | none | Full pack opening chosen by Tony (2026-10-30), about 22 s, which is long for a voice start. Since 2026-10-31 (D-U2) it no longer invites the consultant to skip or to say "I don't know" and carries one client-confidentiality line instead. Non-English greetings are translations that need native review (the new confidentiality sentence in all six included). Commit `c08e7ef` (short introduction) is superseded by Tony's decision; its test pin was replaced. |
| C5 | Question selection (ladder, no redundancy, prefill respected) | Implemented; locally verified | `selector.py`/`selector.js`. `test_selector.py` (full file), `selector.test.js` (229 parity vectors), `session-humane.test.js::a3` | none | Ranking weights are uncalibrated pilot values. Wording is English for every language. |
| C6 | Stale guidance (question lags a turn) | Implemented (fixed); locally verified | The move is chosen synchronously from the answer just heard. `session-humane.test.js::a`, `::a2`, `::d` (legacy flag reproduces the old lag) | none | none |
| C7 | Content-aware acknowledgements | Implemented; locally verified | `ack.js`, `persona.ACKS`. `ack.test.js` (setback, unverified figure, correction, no repeat in four); `session-humane.test.js::c` to `::c4` | none | English only; other languages fall back to the neutral fillers (and Russian, Hindi, Japanese have none). Needs native review. |
| C8 | Latency | PARTIAL | Acknowledgement pushed before the first talker token, synchronous selector, `TALKER_MAX_TOKENS` 160 (was 300), shorter prompt, turn timeline metrics. `session-humane.test.js::f`, `::c` | none | **Live latency is unmeasured.** `SPECULATIVE_STT` is a reserved no-op; `ANALYST_WAIT_MS` stays 0 (Tony, Q5). Next: measure on a deployed Worker. |
| C9 | ASR uncertainty | PARTIAL | `asr.py`/`asr.js`, per-word data kept by `transcribe`. `asr.test.js` (40+ parity vectors), `session-asr.test.js` (confirm, correct, no loop), `test_asr.py`; `eval-conversation.test.js::S7`, `::S7b` | none | The confirmation logic is complete. **Real Nova-3 word confidences through the Workers AI binding are unverified**, and the 0.55 threshold is uncalibrated. |
| C10 | Barge-in | Existing, extended; locally verified | `session.js interrupt()`. `eval-conversation.test.js::S8`; `session-text.test.js` (typing interrupts) | none | Real echo cancellation, device audio and playback acknowledgements are not verifiable offline. |
| C11 | Pause, resume, repeat | Implemented; locally verified | `session.js`, `voice-controls.js`. `session-pause.test.js` (pause, clock excluded, resume with no model call); `voice-controls-dom.test.js`; `humane_browser.py` | none | Wording says "press Resume" (audio is ignored while paused). |
| C12 | Checkpoint and reconnect | Implemented; locally verified | `checkpoint.js`, `worker.js`. `checkpoint.test.js`, `session-reconnect.test.js`, `session-s1.test.js` (absolute 24 h expiry, terminal never stored), `worker-interview.test.js`, `app-resume.test.js`; `eval-conversation.test.js::S9`; `humane_browser.py` | none | **DO eviction, the 24-hour alarm, storage limits and mobile network drops are unverified** (the tests use a storage fake that enforces the documented limits). Product calls in section 7. |
| C13 | Summary read-back and correction | Implemented; locally verified | `summary.js`, summary card. `summary.test.js`, `session-summary.test.js`, `summary-card-dom.test.js`, `h2-polish.test.js`; `eval-conversation.test.js::S4`, `::S6` | none | How natural the read-back sounds in a live voice is unverified. |
| C14 | State machine and audit | Implemented; locally verified | `conversation_state.py`/`conversation-state.js`. `test_conversation_state.py`, `conversation-state.test.js` (parity vectors), `eval-workflow.test.js::G5` | none | Three evidence events (`close_rejected`, `reopen_review`, `propose_downstream`) are defined but nothing fires them; `G5` pins that list. |
| C15 | Repetition guard | Implemented; locally verified | 3-gram similarity in the selector; opener rule in ReplyGuard. `test_selector.py`; `test_speech.py::test_guard_drops_a_leading_reaction_that_repeats_a_recent_opener`; adversarial runs in `eval-conversation.test.js` | none | none |
| C16 | Rushed, "I don't know" / "pass" / "skip" (challenged, 2 re-angles, then open; no Skip control, no invitation: D-U2), "can't share", "that's all" held until the essentials are covered (D-U2) | Implemented; locally verified | `turns.py`, `selector.py`. `eval-conversation.test.js::X2`, `::X3`, `::S5`, `::U2-*`; `h1-humane.test.js`; `session-humane.test.js::a3`; `session-pause.test.js`; `test_turns.py`; `test_selector.py` | none | Cues are English only; French and Spanish have intents only; other languages none. |
| C17 | Text interview (workflow W3) | Implemented; locally verified | X1 text mode, `voice-client.js`. `session-text.test.js` (14), `text-mode-dom.test.js`, `eval-workflow.test.js::W3`, `::W3b`; `humane_browser.py` | none | Text-mode replies follow the voice languages (product call). No "read replies aloud" toggle. |
| C19 | Multilingual conversation (v2.2 L1) | Implemented; locally verified; **no provider verified** | `atlas_voice/languages.py`, `lang-detect.js`, `languages.js`, `session.js`, `ack.js`, `summary.js`, `turns.py`, `persona.py`. `language-l1.test.js` (18), `lang-detect.test.js`, `language.test.js`, `ack.test.js`, `test_turns.py::test_l1_*`, `voice-controls*.test.js`, `humane_browser.py` section 9 (French typed interview). Coverage table in `AGENT.md` section 4b. | none | Which language per turn (speech tag checked by a text detector, typed text by the detector, hysteresis, a selector that fixes one), the talker replies in any language, fixed lines for seven languages and never cached English for any other, intents for seven, voice only where a provider speaks it (else text with one notice), `lang` on every detail. Unverified: how well Llama speaks each language and follows the language note, Nova-3 monolingual requests for a fixed language, ElevenLabs voices, RTL layout beyond `dir=auto`. |
| C18 | Output language per destination | PARTIAL | The success-story DOCX selects its language by the pinned template (`test_success_story.py::test_t10_...`). | none | No per-destination language setting for DNA, MiChat, IMP or Spotlight payloads (`language` is null until the owners define it, section 4). Reports stay English by design. |

## 2. Memory, evidence and review

| ID | Requirement | Status | Evidence: code, and local test | Provider | Open items and next action |
|---|---|---|---|---|---|
| E1 | Memory policy (private memory is not evidence) | Existing; locally verified | `memory.js`, `app.js`. `memory.test.js` | none (Hindsight not exercised) | Unchanged by v2.1. |
| E2 | Claim model, ledger linked to library claims | Implemented; locally verified | `evidence.js` (claims with session, item, ledger id, exact words, confidence). `evidence.test.js` (notes become claims; ledger ids unique) | none | Types `context` and `learning` are Atlas extensions (D13). |
| E3 | Review with exact revision and hash | Implemented; locally verified | `evidence.js`, `policy-gate.js`. `evidence.test.js`, `policy-gate.test.js` (revision and hash must match); `eval-workflow.test.js::W7`, `::W8`, `::G3` | none | The author of a revision cannot approve it (G1-2). A reviewer who rewrites needs a second reviewer. |
| E4 | Audit with version and reason | Implemented; locally verified | Transitions and approvals carry actor, revision, hash and reason code. `evidence.test.js`, `conversation-state.test.js` | none | none |
| E5 | Job envelope and idempotency | Implemented; locally verified | `jobs.js`. `jobs.test.js` (key unique in the table; key includes entity and revision, G1); `branches.test.js`; `eval-workflow.test.js::S14`, `::G4` | none | Live destinations must honour the idempotency key; not verifiable here. |
| E6 | Evaluation harness | Implemented; locally verified | `make test-eval`: `eval-conversation.test.js`, `eval-workflow.test.js`, `eval-rubric.test.js`; `eval/COVERAGE.md` | none | A regression aid, not a human rating of the live model. |
| E7 | Owner-only draft, explicit submit (Q2) | Implemented; locally verified | `session.js` (confirm summary), `evidence.js postDraftFromInterview`, summary card, Submit button. `session-summary.test.js`, `evidence.test.js`, `humane_browser.py` | none | Entra N+1 gap: see X8 in section 4. |

## 3. Governance and workflow

| ID | Requirement | Status | Evidence: code, and local test | Provider | Open items and next action |
|---|---|---|---|---|---|
| G1 | One deterministic default-deny policy gate | Implemented; locally verified | `policy-gate.js`, `atlas_voice/workflow_config.py`. `policy-gate.test.js`, `test_workflow_config.py`; `eval-workflow.test.js::G1`, `::G6` | none | An external security and privacy review is still needed (gate 1). |
| G2 | Purpose permissions (four pack purposes plus two) | Implemented; locally verified | `atlas_workflow.json`. `test_workflow_config.py::test_purposes_are_the_four_pack_ones_plus_two_pending`; `branches.test.js` | none | `matching` and `skills_profile` are `pending_owner_confirmation` (D7). A grant revoked or expired halts delivery (G1-3). |
| G3 | Entity statuses and seven branch cards | Implemented; locally verified | `branches.js`, `workflow-core.js`/`workflow-ui.js`. `branches.test.js`, `workflow-core.test.js`, `workflow-ui.test.js`; `humane_browser.py` | none | Cards read "Mock, not connected"; never an overall "complete". |
| G4 | Internal notes never exported | Implemented; locally verified | `success_story.py`, `story-projection.js`, `adapters.js`. `test_success_story.py::test_t6_...`, `::test_t7_...`; `story-projection.test.js` | none | `source_refs` are internal only (G1-5). |
| G5 | No people or sentiment inference | Implemented; locally verified | Turn cues describe events (D18); the gate denies `rate_consultant`, `infer_sentiment` and similar. `test_turns.py::test_output_key_allowlist_and_types`, `policy-gate.test.js` ("unknown and people-inference actions are denied") | none | Non-negotiable (D6). |
| G6 | No false "published" or "synced" | Implemented; locally verified | Mock acknowledgements are `mock_acknowledged`; `sync_complete` and `published` need `destination_ack.mock === false`. `branches.test.js`; `eval-workflow.test.js::G2`; the library label is "Shared in internal library" (D17; `bids_browser.py`) | none | none |
| G7 | Success-story template safety | Implemented; locally verified | `success_story.py` (pinned template sha256 and 13-table fingerprint). `test_success_story.py` T1 to T10 | none | **DOCX visual fidelity in Word or LibreOffice is unverified** (neither installed). |
| G8 | Withdrawal and impact review | Implemented; locally verified | `evidence.js`, `branches.js` (`impact_review`). `eval-workflow.test.js::S16`, `::G5` | none | Derivatives are listed, not recalled from any real destination. |

## 4. External systems

| ID | Requirement | Status | Evidence | Owner and API needed | Next action |
|---|---|---|---|---|---|
| X1 | DNA skills write-back | **BLOCKED_EXTERNAL**; mock only | `adapters.js` `DNA_SKILLS_WRITEBACK`. Proposal payload; `skill_taxonomy_id` and `level` are null. Tests: `branches.test.js`, `eval-workflow.test.js::S13` | Mantu DNA owners (IT): endpoint, authentication, skill taxonomy, level scale, write contract | Owners define the contract; then a live adapter behind `ATLAS_ADAPTERS=live` (today refused). |
| X2 | MiChat CV | **BLOCKED_EXTERNAL**; mock only | `MICHAT_CV`. `language`, `target_role`, `template` are null. CV claims carry reviewed wording only (G1-4). Tests: `branches.test.js` | MiChat owners: endpoint, CV schema, template and language rules, client-permission model | As above. "MiChat" is an internal label for this interview (D1); no UI rename. |
| X3 | IMP capability signal | **BLOCKED_EXTERNAL**; mock only | `IMP_CAPABILITY`. `availability` null; waits for its own `matching` permission. Tests: `branches.test.js` (W9) | IMP owners: endpoint, signal schema, matching purpose confirmation | As above. |
| X4 | Spotlight CMS | **BLOCKED_EXTERNAL**; mock holds, never publishes | `SPOTLIGHT_CMS`, `spotlight.js`. `eval-workflow.test.js::W12`, `::S12` | Spotlight CMS owners: API and publication contract; brand approval; per-revision authorization | Atlas never sets `published` (D4, D12). |
| X5 | MAAP review | **BLOCKED_EXTERNAL** (rubric); shell only | `createShell('MAAP')`. Rating or closing returns `MAAP_NOT_CONFIGURED`. `eval-workflow.test.js::S11`, `MAAP-1` to `MAAP-6` | Process owner: rubric, cadence, owners, data model (D2) | Nothing to build until supplied. No MAAP conversation exists. |
| X6 | Project Review | **BLOCKED_EXTERNAL** (rubric); shell only | `createShell('Project Review')`. `PROJECT_REVIEW_NOT_CONFIGURED`. `eval-workflow.test.js::W10` | Process owner (D3) | As X5. |
| X7 | JEV relevance matching | Existing; fixtures verified | `jev.js`, `customer-jev.js`. Ranks eligible stories for a customer brief, never consultants. Retrieval tested in `eval-workflow.test.js::S12` | `TYPESAFE_API_KEY` (Tony) | Live ranking and weight calibration need the key and labelled data. |
| X8 | Entra identity for N+1 | PARTIAL | G1-1 in `DECISION_LOG.md` | Directory owners: put the Entra id (`tid:oid`) next to the email in the staffing record or DNA directory | In Entra mode the resolved N+1 never matches, so only `ATLAS.Reviewer` or `ATLAS.Admin` can review. Fails closed. |

## 5. Pack acceptance, by ID

Details, test names and notes: `eval/COVERAGE.md`. Short test names (CONV, WF) live in `eval-conversation.test.js` and `eval-workflow.test.js`; STORY is `tests/test_success_story.py`. Provider verified: none for every row.

| Pack item | Status | Test | Why not fully proved |
|---|---|---|---|
| Scenario 1 vague answer | Locally verified | CONV `S1` | |
| 2 team result claimed individually | Locally verified | CONV `S2` | |
| 3 80% with no baseline | Locally verified | CONV `S3` | |
| 4 approximate metric | Locally verified | CONV `S4` | |
| 5 client cannot be named | Locally verified | CONV `S5` | |
| 6 correction creates a revision | Locally verified | CONV `S6`, WF `W8`, `G3` | |
| 7 ASR mishears a number or name | PARTIAL | CONV `S7`, `S7b` | Real confidences and the threshold. |
| 8 interruption | PARTIAL | CONV `S8` | Real echo cancellation and audio. |
| 9 disconnect, checkpoint restores | PARTIAL | CONV `S9` | Real DO eviction, alarm, mobile drops. |
| 10 manager and consultant disagree | Locally verified | WF `S10` | |
| 11 MAAP requested, rubric missing | PARTIAL | WF `S11` | No MAAP conversation exists; only the gate. |
| 12 relevant to a prospect, no public permission | Locally verified | WF `S12` | Live JEV ranking needs the key. |
| 13 DNA succeeds, MiChat fails | Locally verified (mocks) | WF `S13`, `W11` | Mock destinations. |
| 14 duplicate webhook | Locally verified | WF `S14` | No inbound webhook from any destination exists. |
| 15 destination holds a newer revision | Locally verified (mocks) | WF `S15` | |
| 16 permission revoked after publication | PARTIAL | WF `S16` | Nothing is ever published; "after the hold". |
| W1 consultant identified before prefill | PARTIAL | WF `W1` | The project context itself is not looked up server-side for the signed-in person. |
| W2 prefill only authorised fields | PARTIAL | WF `W2` | Nothing checks the page's role, sector and stage belong to the signed-in person. |
| W3 voice and text | Locally verified | WF `W3`, `W3b`, `session-text.test.js` | Live text quality not judged. |
| W4 one question per turn | Locally verified | WF `W4` | |
| W5 project facts apart from contribution | Locally verified | WF `W5` | |
| W6 evidence links per metric and artifact | PARTIAL | WF `W6` | No artifact upload or registry; an artifact is a sentence. |
| W7 reviewer required | Locally verified | WF `W7` | |
| W8 rejection routes, revision kept | Locally verified | WF `W8`, `S10` | |
| W9 approval creates independent branches | Locally verified (mocks) | WF `W9` | |
| W10 MAAP and Project Review separate | PARTIAL | WF `W10` | No review owners are named; neither can complete. |
| W11 one branch failing does not fail the rest | Locally verified | WF `W11`, `S13` | |
| W12 Spotlight needs exact-revision authorization | Locally verified (mock CMS) | WF `W12`, `S12` | |
| T1 to T10 success-story template | Locally verified | STORY `test_t1_...` to `test_t10_...` | DOCX rendering in Word or LibreOffice not checked. |
| MAAP section 8, tests 1 to 4 | PARTIAL | WF `MAAP-1` to `MAAP-4` | No MAAP record exists. |
| MAAP section 8, tests 5 and 6 | Locally verified (shell) | WF `MAAP-5`, `MAAP-6` | They assert what must not happen. |
| Release gate 1 privacy and permission bypass | PARTIAL | WF `G1` | Absence of a bypass cannot be proved by tests; external review needed. |
| Gate 2 unsupported claims published | PARTIAL | WF `G2` | Nothing can be published. |
| Gate 3 silent revision overwrite | Locally verified | WF `G3`, `S15` | |
| Gate 4 duplicate writes under retry | Locally verified (mocks) | WF `G4`, `S14` | |
| Gate 5 critical transitions covered | PARTIAL | WF `G5` | Three evidence events are unreachable. |
| Gate 6 human review of consequential decisions | Locally verified | WF `G6`, `W7`, `W12` | |
| Gate 7 conversation quality target with pilot users | **Not started** | none | Needs consultants. The rubric linter is a regression aid only. |

## 6. Needs native review, uncalibrated, or unverified

None of these can be settled offline.

**Needs native review**
- Cached greetings in French, Spanish, Portuguese, German, Italian and Dutch (`languages.js`): faithful translations of the English opening, authored by the agent. Text-mode users see the same greetings.
- v2.2 U2 (2026-10-31), authored by the agent and awaiting a native-speaker review in the six languages: the confidentiality sentence of the opening ("If something is client-confidential, say so and I'll note it without the details.", `languages.js`), the rewritten `no_number_fine` acknowledgements (the figure stays open, no invitation) and the new `reangle` acknowledgements (`persona.py`), and the turn-intent words added for a bare "pass" / "skip" / "no idea" (`turns.py`). The re-angle and "what is still missing" questions themselves are English wording (the talker says them in the consultant's language).
- v2.2 L1 banks, all translated by the agent and all awaiting a native-speaker review: acknowledgements (10 categories x 5 lines), pause and resume lines, confirm-summary lines (correction, prompt, saved, unsaved), read-back framing (opening, second round, reflection, the two closing questions) and screen notices (no voice, typed wait and busy, transcription failed, echo) in French, Spanish, Portuguese, German, Italian and Dutch (`atlas_voice/persona.py`, `atlas_voice/languages.py`), and the control-intent tables of `turns.py` for the same six. Question wording stays English guidance that the talker renders; turn cues exist in English only. Any other language: no fixed line, the talker writes it.
- The trailing-word lists in `languages.js` (pre-existing) also need a native-speaker pass.

**Uncalibrated**
- `ASR_CONFIRM_TAU` 0.55 and the selector's ranking weights are pilot values chosen by judgement.
- JEV weights (pre-existing).

**Unverified (no live run exists)**
- Live latency: the measures taken are in C8; nothing has been timed on a deployed Worker.
- Real Nova-3 word confidences through the Workers AI binding.
- Llama's adherence to the NEXT MOVE note and the persona; how humane the replies and Aura voice actually sound.
- DOCX visual fidelity in Word.
- Durable Object alarm and eviction behaviour, storage limits in practice, mobile network drops.
- Real echo cancellation and barge-in with a person speaking.
- The Entra N+1 gap (X8): fails closed, needs the directory to carry the Entra id.

## 7. Product calls for Tony

Each is built one way and can be changed; none was asked of the consultants.

1. **Closing the page keeps the interview (T10).** `pagehide` no longer discards when the server keeps a resumable interview, so the next load offers Resume. This follows the 24-hour checkpoint (Q3) but means a consultant who closes the tab has not discarded anything.
2. **Text mode language (X1, changed by L1).** A typist in any language is answered in that language (typed text is detected, a language can be fixed in the selector). Translated lines still need native review.
3. **Re-grant after a halted job needs a new revision (G1).** A job halted because a permission was revoked stays `needs_reconciliation` after the owner re-grants; it ends only with a new revision (a new job key).
4. **Withheld words stay in the owner-only ledger and checkpoint for 24 hours (S1, L7).** "Keep private" removes the whole utterance from the talker history, notes, report input and the draft, but the ledger's own record and its transcript item remain in the owner-only ledger and checkpoint until the interview ends or 24 hours pass (pinned by tests).
5. **The opening is about 22 seconds (Tony's full-pack choice, 2026-10-30).** The review marked tightening the second piece optional; it was not done because the opening is Tony's own wording, pinned verbatim, and six languages translate it.
6. **Consent wording and the 24-hour checkpoint (changed in v2.2 G2).** The consent dialog has a separate choice for keeping an interrupted interview for up to 24 hours (with its own receipt), and the notice says it. **It starts unticked, as does the memory choice (v2.2 X3, red-team M1: consent needs an affirmative act, GDPR Art 4(11) and 7, CJEU Planet49).** The only box that is ever shown ticked is one the person already ticked and stored, so starting an interview never silently withdraws it; a resume still works for a person who ticked it. Whether this is the right lawful basis for the saved interview is the DPO's call. The wording is a draft in `atlas_voice/config/privacy.json` and needs the DPO's and native review.

## 8. Known open items

- Evidence machine: `close_rejected` and `reopen_review` are never fired (G5 pins the list). `propose_downstream` is wired (v2.2 core, 2026-10-31): the system fires it once a destination (DNA skills, MiChat CV, IMP projects, Spotlight stories) holds a proposal for the approved revision.
- CV payload carries structured fields only until a person has reworded a claim (G1-4).
- A reviewer-amended claim needs a second reviewer; the owner is asked nothing (G1-2).
- Prefill is not authorised server-side (W1, W2). No artifact registry (W6). No MAAP or Project Review owners (W10).
- `intelligence-ui.js` keeps an unused map with the original words of a kept-private item in browser memory; it is never displayed.
- A comment in `deploy/cloudflare-edge/src/languages.js` points at `handoff/IMPLEMENTATION_STATUS.md`; this file lives here, in `docs/agent-brain-v2.1/`. The comment was left alone (documentation-only task).
- Browser suites run only with Chromium (build 1228) and outside the sandbox; the result of the T17 run is in `handoff/BUILD_STATUS.md`.
- `scripts/eval_live.mjs` is a manual stub that runs nothing and refuses to run without explicit authorisation.

## 9. Privacy controls (v2.2 G2)

**Controls implemented in code; DPO sign-off required.** This section lists what exists and was tested offline on synthetic data. It is not a statement that the processing is compliant, that any lawful basis has been chosen, or that any provider has been checked: lawful bases, controller and DPO details, transfer mechanisms and every retention period are placeholders or proposals (`docs/privacy/`). Nothing was deployed and no provider was called. The deployment still runs on a personal Cloudflare account (OWNER-DECISION: move to a Mantu-owned account before any real data; `docs/privacy/PROCESSORS.md`).

| Audit gap (`GDPR_AUDIT.md`) | Control | Status | Test |
|---|---|---|---|
| Art 5(1)(b): every interview auto-synced, visible to the N+1, reviewers, admins, auto-scored | An interview's reference is a **private draft** until the owner clicks Submit for review: owner-only, never listed, searched, asked, recommended, bid on, counted, exported, indexed, rated or confirmed-by-request; only `submit()` ends it; the page sends `draft: true` and the Library copy no longer says "automatically" | Implemented, locally verified | `g2-private-draft.test.js` |
| Art 7: one bundled tick, no receipt, revoking deleted the entry | Separate choices (transcribe and draft, saved interview, memory, notice); the `start` message carries an object (a bare `true` still means transcription only); an **append-only receipt** per change (subject key, purpose, granted or withdrawn, notice version, SHA-256 of the wording, time, channel); profile consents (spoken Ask, JEV rating) append receipts too; the session checks each purpose | Implemented, locally verified | `g2-consent.test.js`, `tests/test_privacy_config.py` |
| Art 25: memory on by default; Art 5(1)(c): raw conversation and a person profile in memory; `jevRelevant` sent memory to TypeSafe | Memory is **off** until ticked; facts only (no conversation), observations off, narrower mission, sensitive lines dropped, kept-private items never get there, per-person prune, TypeSafe no longer sees memory text | Implemented, locally verified | `memory.test.js`, `g2-special.test.js` |
| Art 15/20: no subject-wide export | `GET /api/me/export` (library material, evidence with claims, receipts, invitations, outreach, staffing, profile, audit ids only, saved interview, memory) | Implemented, locally verified; the memory service's per-document read is unverified on a live account | `g2-rights.test.js`, `g2-worker.test.js` |
| Art 17: nothing erased refs, evidence, audit, staffing, outreach | `POST /api/me/erase` (CSRF, Origin, a confirmation token step): tombstones, audit pseudonymised with the chain re-sealed, saved interview and memory purged, profile deleted; approved evidence, published references and bids are flagged **`erasure_pending_review`** for the DPO (legal-hold exception) and withdrawn from processing | Implemented, locally verified | `g2-rights.test.js`, `g2-worker.test.js` |
| Art 18/21: no restriction or objection | Per-person flags (restricted, objectScoring, objectMatching, objectMemory) honoured by rating, recommend, Ask, bids, analytics, insights and the win statistics, and by memory | Implemented, locally verified; downstream projections already queued are not stopped | `g2-rights.test.js` |
| Art 5(1)(e): no deletion anywhere | `atlas_voice/config/retention.json` (all proposals) executed by the daily `scan-stale` cron | Implemented, locally verified with a fake clock; never run live | `g2-retention.test.js` |
| Art 9: no warning, no detection | The notice and the consent ask people not to share such information; a phrase guard (seven languages) flags a sentence at the read-back and keeps it out of memory; it records nothing about the person | Implemented; wording and phrase lists need native and DPO review | `special.test.js`, `g2-special.test.js` |
| Art 12-14: no notice | `/privacy` (served from the same JSON as `docs/privacy/PRIVACY_NOTICE.md`), linked from the consent dialog and the footer; the banner no longer says "synthetic data only" | Implemented; placeholders remain | `g2-worker.test.js` |
| Art 32: email in the URL; reads not logged | The people lookup is a POST body; reads of others' records, reviewer exports and people lookups are audited (ids only); every library route is rate limited and the privacy routes leave numbers-only security events | Implemented, locally verified | `profile.test.js`, `g2-rights.test.js` |
| Art 28/30/35, Art 88 | `docs/privacy/{PROCESSORS,ROPA,DPIA_DRAFT,RETENTION_SCHEDULE,WORKS_COUNCIL_PACK,PRIVACY_NOTICE}.md` | Drafts for the DPO | `tests/test_privacy_config.py` |

Not done, deliberately or for lack of a decision: a lawful basis per activity; a legal-hold rule beyond the three kinds above; alerting and a breach runbook; stopping downstream projections when a person restricts; a bank-wide memory sweep; the DNA directory in the erasure; native review of the wording; a Mantu-owned Cloudflare account; a works-council consultation.

## 10. Strict CSP and safe rendering (v2.2 F1)

Implemented and locally verified (unit, edge and a real-Chromium run); never deployed, so no real browser and no real Cloudflare Access session has seen it yet.

| Control | Status | Test |
|---|---|---|
| No executable runtime injection: the server's per-person facts are a JSON data block (`<` and U+2028/2029 escaped), read by `src/runtime.js`; every executable inline script is static | Implemented (edge page, Python gateway, build) | `csp.test.js` (round trip with hostile e-mail), `tests/test_csp.py`, `csp_browser.py` |
| `build.py` hashes every executable inline script and writes `csp.generated.js`; the small pages are hashed at run time; the gateway hashes what it serves | Implemented | freshness tests in `csp.test.js` and `tests/test_csp.py` |
| One CSP builder for every HTML response (page, re-sign-in, confirm, privacy, Teams tab): `script-src` hashes + `blob:`, `script-src-attr 'none'`, `base-uri 'none'`, `object-src 'none'`, `frame-ancestors 'none'` (Teams only for the tab), `report-uri`/`report-to` + `Reporting-Endpoints`; the page `<meta>` carries the same script policy | Implemented; the Python gateway sends it without a report target | `csp.test.js`, `teams.test.js`, `security-headers.test.js`, byte parity of the two builders in `tests/test_csp.py` |
| `POST /api/csp-report` (8 KiB, per-person rate limit, 204, `csp_violation` event with directive + blocked origin only) | Implemented | `csp.test.js` |
| `ATLAS_CSP=report-only` rollout switch (old policy enforced, strict reported, `<meta>` dropped) | Implemented (edge and gateway) | `csp.test.js`, `tests/test_csp.py`, `csp_browser.py` |
| `src/safe-html.js` (`html`, `setHTML`, `insertHTML`, `join`, `trusted`) replaces five `esc` copies; every markup sink in `src/*.js` converted (app.js 43, bids-ui 17, trust-ui 9, intelligence-ui 7, ask-ui 5, storyboard-ui 1, voice-client 1); a node lint fails on raw `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`/`eval`, on any inline `on*=` and on a `trusted()` that is not one of the audited producers (9 uses) | Implemented | `tests/safe-html-lint.test.js` |
| The audited SVG producers (`charts.js`, `geo.js`, `bids-core.js`) have every interpolation escaped or validated (gaps found and fixed; prototype-key lookups) | Implemented | `charts`, `geo`, `bids-core` XSS regression tests |

Residual and not done: `style-src 'unsafe-inline'` remains (large inline styles and `style=` attributes; an injected tag can restyle but not run code); no Trusted Types; CSP delivery by the browser's own report path was not observable in the headless build (the endpoint and its log are tested directly); not verified in Safari or Firefox; nothing deployed, so a real week in `ATLAS_CSP=report-only` is still the recommended rollout.

## 11. Interface pass (v2.2 F2)

Implemented and locally verified (unit, edge, 22 Chromium suites, before and after screenshots at 1400 and 390); never seen by a real user, a real screen reader or Safari/Firefox. The design method is unslop by Damir Sokolovsky (@heydamir), licensed CC BY 4.0, https://heydamir.design/unslop; keep this credit in any copy.

| Item | Status | Test |
|---|---|---|
| One dark theme and one header for Conversation, Projects, Stories, Library and Bids (`body.ui2`, `src/ui.css`, tokens in `src/styles.css`); the orb files are untouched | Implemented | `tests/f2-ui.test.js`; all browser suites |
| Read-back card in the centre column, scrolled into view with focus on its title; quotes 16px, `dir=auto`, `lang`; one status line after Submit | Implemented | `f2-ui.test.js`, `summary-card-dom.test.js`, `humane_browser.py` |
| Test badge in normal flow, not fixed | Implemented (edge) | `test/app.test.js`; measured: no overlap with Start, the answer box or Confirm at 390 |
| End asks first (a sheet that also holds Restart); previews behind the disclosure; one progress caption; hero hidden while live | Implemented | `studio_browser.py`, `humane_browser.py`, `sculpture_browser.py` |
| Consent dialog, privacy panel, two-step Delete, language selector styling; wording from `bootstrap.privacy` | Implemented | `g2-privacy-ui.test.js`, `zero_config*_browser.py`, `humane_browser.py` |
| Reviewer sees the sentence around a claim (`source_refs.context`); `consultant_named` labelled; manager-staff explained | Implemented | `f2-ui.test.js` (structure); not covered by a browser test with a real evidence record |
| CSRF 403: one re-read of `/api/bootstrap` and one resend; calm banner for `readOnly` / `aiOff` | Implemented | `f2-ui.test.js` |
| Admin Connections panel and `GET /api/connections/status` (ready / mock / not_configured, no value, URL or token) | Implemented; **no connection has been exercised live** | `test/f2-connections.test.js` |

Residual: dialogs stay light (they are sheets over the dark page); the line under the orb ("Click the orb to mute or unmute...") and the connection pill labels come from `orb-ui.js`; the orb chrome (`.orb-corner`, `.orb-divider`, `.orb-kicker`) keeps its original size and contrast by decision; at 390 the Confirm button sits about 55px below the first screen after the read-back opens; no native-speaker review of any new string; Lighthouse and screen-reader passes not run.

### Addendum: start flow and viewport-fit layout (v2.2 U1)

Implemented and locally verified (`tests/ux_fit_browser.py`: getBoundingClientRect measurements at 1280x720, 1366x768, 1440x900 and 1512x982, plus 502x414 and 390x844; `tests/u1-start-flow.test.js`; edge `app.test.js`, `local-demo.test.js`); never seen by a real user, in Safari or Firefox, or with a real microphone. The orb files (`orb.css`, `orb-renderer.js`, `orb-ui.js`, the orb rules of `sculpture.css`) and `assets/Mantu.svg` are untouched: only the box around the orb (`.orb-screen`) is sized from the window height in the new `src/fit.css`.

| Item | Status | Test |
|---|---|---|
| A microphone that cannot be opened (declined, blocked, no device, no secure page) is a calm idle state with one sentence, **Continue by typing** (starts the typed interview at once with the consent already given: no second dialog) and **Try the microphone again**; no "connection stopped" heading | Implemented | `ux_fit_browser.py`, `u1-start-flow.test.js` |
| Bootstrap `voice: false` (only when the server sets `ATLAS_VOICE=off`; the local edge does) makes the typed interview the primary start, hides the voice button with a one-line reason; the orb starts the typed interview | Implemented (edge flag, page) | `app.test.js`, `local-demo.test.js`, `u1-start-flow.test.js` |
| Dialogs (consent, resume, end, restart, erase): sticky head and action footer, body scrolls inside; the microphone help is folded for a voice start (open for a typed start and for an admin); every consent sentence kept | Implemented | `ux_fit_browser.py` (502x414, 390x844, desktop) |
| Desktop (1024x560 and up): an app shell of exactly the window height; the page does not scroll in any phase; columns scroll inside; hero one line and sliding away while live; right rail: next question, then progress, then the story board with the twelve dimensions as a collapsed row of chips; left rail narrows while live; read-back card with its title, first item and a sticky Confirm | Implemented | `ux_fit_browser.py` |
| No programmatic window scroll while live (focus uses `preventScroll`; the shell clips), reduced motion respected, start row reserved until the server answers | Implemented | `ux_fit_browser.py`, `u1-start-flow.test.js` |

Round 6 polish: the newest two conversation lines are full contrast with a soft top edge; one next-question card (question, About, quote, ledger link); the read-back list scrolls inside its own box above a fixed Confirm, with a "More below" hint; meters and the sound check tidied; the left rail folds away while live with the project name as a chip.

Residual: the voice-mode layout was measured with a scripted voice socket and a synthetic microphone only; below 1024px wide or 560px tall the page scrolls as before (one column); the orb's two corner buttons are still 31px; a long ATLAS line (more than about six lines at 1280x720) scrolls inside the conversation box; no native-speaker review of the new strings.

## 12. Red-team retest fixes (v2.2 X1)

Implemented and locally verified (edge `x1-redteam.test.js`, 25 tests, each failing on e113613, plus the PoCs of `/tmp/claude-501/audit3/red/pocs` re-run on a local edge); never deployed. Controls implemented; DPO sign-off still required.

| Finding | Fix | Status |
|---|---|---|
| H1 erasure upgraded a self-named N+1 confirmation to `manager_confirmed` | `claims.by_source` records who answered each claim (back-filled once for older rows); erasure rewrites `by_mail` only where the person is the confirmer, `created_by` only where they are the creator | Fixed, locally verified |
| M2 AI_OFF did not stop the JEV bid ranker (or probes, rating, classify, memory) | One guard (`aiOff`, `assertAiOn`) in every model or third-party client; honest note | Fixed |
| M3 READ_ONLY did not freeze the cron | scan-stale returns before any write; `kill_switch READ_ONLY` logged | Fixed |
| M4 restriction/objection did not stop one-pager, use in bid, slides | `processable(owner, 'matching')` in all three | Fixed |
| M5 withdraw-then-erase bypassed the legal hold; M6 reviewer could reinstate a held reference | Hold when ever validated/published or used in a bid or one-pager; edit, validate, reinstate and merge refused while held | Fixed |
| M7 assignee's erasure took over the requester's gap request | Per-column rewrites | Fixed |
| M8 erasure and retention re-sealed a tampered chain | Chain verified first; refused, logged, DPO hold; both heads logged | Fixed |
| L1 one-pager and Ask/bid limits per isolate | Persistent (storage) limits | Fixed |
| L2 flags not announced | `flag_state` event and admin `securityFlags`; strict CSP kept on privacy, confirm and sign-in pages under report-only | Fixed |
| L3 connector placeholders | `.` and `..` refused; private, link-local and carrier-grade IP-literal base URLs refused | Fixed |
| L4 stores without a profile table | Every optional table checked; library failure stops the interview step | Fixed |
| L5 identity on others' records; L6 substring audit match; L7 objection for listed consultants; L8 DPO restriction; L9 receipts append-only; L10 token, channel, oracle | See `handoff/BUILD_STATUS.md` | Fixed |
| Win-loop skew (old L1); search in a URL (old L12) | Per-person cap per proof type and at least three people; `POST /api/library/search` | Fixed |

Not done (other owners or out of scope): H2, M1, M9 to M13 and the L11 to L14 prompt residuals; the downstream projections already queued are still not stopped by a restriction; the claim by_source back-fill is unproven on a store with years of rows.

## 13. Red-team retest fixes (v2.2 X2 conversation, X3 interface)

Implemented and locally verified (edge `x2-redteam.test.js`, `fold.test.js`, `tests/test_x2_guards.py`, X3 tests in `profile.test.js`, `safe-html-lint.test.js`, `g2-privacy-ui.test.js`, `voice-reconnect-dom.test.js`, `tests/test_display_name.py`; PoCs in `/tmp/claude-501/audit3/` re-run before and after). Reports: `RED_TEAM_RETEST.md` (backend, 22 earlier findings re-run: 15 pass, 7 partial, 0 fail before X1/X2) and `RED_UI_RETEST.md` (interface: no XSS, no CSP violation in any flow).

| Finding | Fix | Status |
|---|---|---|
| Erase during a live interview let the checkpoint come back | Erase, withdrawal and memory restriction revoke the live session first; a guard re-reads stored consent before every checkpoint write; the page shows the `consent_revoked` notice | Fixed |
| Start cap bypassed by a padded start message | 16 KiB byte cap in the Worker and `Session.onText`; an oversize first message counts as a start | Fixed |
| Refusing the extension still extended to 30 min | Only an explicit short yes extends, in every bank language | Fixed |
| ReplyGuard verification words and figure check English-only / homoglyph-blind | NFKC, confusables fold, zero-width strip; 7 bank languages' verification and number words | Fixed |
| A "stop" inside a normal answer ended the interview | Control intents only for short standalone utterances | Fixed |
| Language switch unthrottled | Throttled; old lines are never re-synthesized | Fixed |
| Special-category guard missed new languages and variants; "Church Street Bank" false positive | Same normalisation; phrase lists for the 7 bank languages plus ru, pl, ar, ja, zh; word-context rules | Fixed (lists need native and DPO review) |
| French/paraphrased steering of rerank and review; quote inversion | Fenced data framing; a steered record can only move down; multilingual negation context | Mitigated: models can still be steered by unlisted wording; the deterministic bounds are the control |
| Look-alike fence and role tags; memory label after memory | Normalised before matching; label first | Fixed |
| Read-back cut quotes mid-word | Cut at a word or clause boundary (CJK at punctuation) | Fixed |
| Optional consent boxes pre-ticked (Art 7) | Checkpoint and memory start unticked; only a stored choice re-ticks; notice version `2026-10-31.2` | Fixed |
| Bidi and zero-width characters in sign-in names | Stripped from names at the source (edge and Python), rendered in `<bdi>`; free text keeps ZWNJ/ZWJ (Persian, Indic, emoji) | Fixed |
| Safe-HTML lint gaps; `blob:` on pages without audio | Sink table (DOMParser, srcdoc, string timers, `trusted()` argument shape…); `blob:` only on the voice page | Fixed |
| Library search text in a URL | `POST /api/library/search`; `GET ?q=` ignored | Fixed |

Not done: Trusted Types; summary mode does not voice scripts without a number table (Cyrillic, Arabic, CJK, Greek; the card still shows); "Christian" as a first name is read as religion; names already stored keep their characters until re-read.

## 14. Local demo (v2.2 D1)

`docs/LOCAL_DEMO.md`. `deploy/cloudflare-edge/dev/local-edge.mjs` serves the interview WebSocket through the real `handle()` to the real Interview Durable Object class and Session, with an in-memory Durable Object stand-in, real Library storage and offline fake models (`dev/fake-interviewer.mjs`: replies in en/fr/es/pt/de/it/nl from the selector's next move). A typed interview runs end to end: consent receipts, read-back, Keep private, Correct, Confirm into an owner-only draft, Submit for review, export and the two-step erase. Voice needs a provider, so locally it is typed only. Test: `test/local-demo.test.js`.

## 15. Settings sheet and admin Voice settings (v2.2 V2)

| Item | Status |
|---|---|
| Settings sheet from the avatar and Ctrl/Cmd + comma: tabs Profile, Privacy, Workspace; Connections and Voice for admins only | **Implemented, locally verified** (node `tests/v2-settings-ui.test.js`, browser `tests/settings_browser.py` at 1440x900 and 390x844, which also checks the keyboard tabs, 44px targets, no CSP violation). The former profile dialog (`#profileDialog`) with every control id kept; Download my data and Delete my data are two clicks from any page; the four choices carry plain explanations and stay unticked |
| Connections as a table (name, state dot, what is missing; details disclosure) moved from the Library into Settings | **Implemented, locally verified.** Same data (`/api/connections/status`); names and yes/no only |
| ElevenLabs key stored by an admin: sealed (AES-GCM-256, HKDF of `SETTINGS_KEY`, random IV, AAD `atlas-settings:v1:elevenlabs`, `kid` for rotation), write-only, validated before it is stored | **Implemented, locally verified against a fake ElevenLabs** (`test/v2-settings.test.js`: round trip, wrong AAD, tamper, rotation, key text absent from every response, log line, audit row, export and page). **Provider verified: no.** The real `GET /v2/voices`, `/v1/user` and text-to-speech calls have not been made |
| Provider choice (Automatic, Workers AI, ElevenLabs), voice list from the account, model, Test voice (fixed phrase, played from a blob), Remove key | **Implemented, locally verified.** Voice previews are not played (media from `blob:` only) |
| `voiceConfig(env, library)` / `voiceStatus` for the voice engine: stored choice, then environment, then Workers AI; `ATLAS_SETTINGS_KEYS=off`; 60 s cache | **Implemented, unit tested.** Whether the Interview Durable Object uses it is V1's change: until then speech is unchanged |
| ElevenLabs as a processor | **Open for the DPO.** `PROCESSORS.md` and `ROPA.md` rows 13 and 14 are marked *to verify*; no contract, location or retention is known |

Open: `SETTINGS_KEY` must exist on the deployment (`deploy.sh` creates it on the next run); the cache means another isolate sees a change within a minute; the breaker and fallback state shown to the admin is the static description (the live state is the voice engine's); a real ElevenLabs key has never been entered.


## 2026-11-01: PR #1 review fixes

The privacy and checkpoint-concurrency findings, reconnect readiness and unsaved-correction defects are fixed and regression tested. Confirmation was revalidated: the existing snapshot/seal protects draft membership; the card now also exposes every ledger detail and its complete quote. Details, test results and remaining browser/environment limits: [PR1_REVIEW_FIXES.md](PR1_REVIEW_FIXES.md). Status remains **locally verified, provider verified: none, not deployed**.
