# Evaluation coverage: Agent Brain v2.1

Date: 2026-10-30. Written with task T16. Everything below is offline: synthetic data, no network, no provider, no live DNA, MiChat, IMP, MAAP or Spotlight. It shows what the code does, not how good the live model sounds.

Run it: `make test-eval` (conversation, workflow, rubric and core-flow tests, 59 tests) and `make test-ui` (adds `tests/humane_browser.py`). Both are part of the task's checks; neither is a human rating.

Status key:
- **PASS**: the requirement is met by the code, and the named test proves it offline.
- **PARTIAL**: part is proved; the text says what is not (usually because the capability is not built, or needs the owner).
- **NOT-OFFLINE-VERIFIABLE**: cannot be shown without live providers, real people or a deployment.

Test files (all under `deploy/cloudflare-edge/test/` unless stated):
`eval-conversation.test.js` (CONV), `eval-workflow.test.js` (WF), `eval-rubric.test.js` (RUB), `tests/humane_browser.py` (BROWSER), `tests/test_success_story.py` (STORY).

## How the conversation eval works

Each of the nine conversation scenarios plays through the real `Session` (selector, turn pre-pass, acknowledgements, ReplyGuard, state machine, ledger, summary, checkpoint, and for the read-back the real evidence store on node:sqlite), with ReplyGuard on and the default v2 flags. Only speech recognition, voice, the talker model and the evidence analyst are fakes. Each scenario runs twice:

- **scripted**: the talker says exactly the move's proposed wording.
- **adversarial**: the talker ignores it. It opens with "Amazing!", repeats the same opener every turn, asks two or three questions, and in the read-back adds figures of its own.

After every consultant turn the same invariants must hold: at most one question voiced; no banned praise voiced; an acknowledgement that fits (a setback is never met with an upbeat one, a figure with no known basis is never "earned"); no question asked twice or asked of what the prefill already holds; the expected transitions in the audit trail; no illegal transition; the consultant's name in no model message, voice line or event. In adversarial mode the guard must also have visibly acted (questions and praise dropped), and no two replies may start with the same sentence.

Mutation check, run by hand while writing (`EVAL_MUTATE` in the test file): with ReplyGuard off, 13 of the 14 conversation tests fail; with the legacy acknowledgements, 6 fail. The checks are not vacuous. `E0` is a negative control inside the suite.

## Pack evaluation scenarios (Evaluation Framework section 3)

| # | Scenario | Test | Status | Notes |
|---|---|---|---|---|
| 1 | Vague "helped improve the platform" | CONV `S1` | PASS | Asks one concrete example (`vague_example`), then moves on. |
| 2 | Team result claimed individually | CONV `S2` | PASS | `team_ownership`, neutral wording, asked once; the personal contribution and the team outcome stay separate details. |
| 3 | 80% with no baseline | CONV `S3` | PASS | Kind, then period, then baseline: one part per turn. The first mention gets "promising", never an earned result. |
| 4 | Approximate metric | CONV `S4` | PASS | Filed as `uncertain`, shown on the read-back card as the consultant's estimate, stays `uncertain` in the evidence record. Invented figures in the adversarial read-back are dropped. |
| 5 | Client cannot be named | CONV `S5` | PASS | Accepted, anonymisation offered once, interview moves on. |
| 6 | User correction creates a revision | CONV `S6` (and WF `W8`, `G3`) | PASS | Old detail inactive but kept; new detail supersedes it; the read-back and the evidence draft carry only the corrected wording and link back to the replaced ledger id. A revision 2 after approval is WF `G3`. |
| 7 | ASR mishears a number or proper noun | CONV `S7`, `S7b` | PARTIAL | Logic is PASS: confirm aloud once, "no, thirty five" supersedes, "yes" settles it. The recogniser's real word confidences and the 0.55 threshold are not offline-verifiable (the fake supplies the confidences). |
| 8 | User interrupts Atlas | CONV `S8` | PARTIAL | Session logic is PASS: audio cleared, the interruption recorded, listening resumes with the new answer. Real echo cancellation, the browser's audio device and playback acknowledgements are NOT-OFFLINE-VERIFIABLE. |
| 9 | Disconnect, checkpoint restores | CONV `S9` | PARTIAL | Logic is PASS (a storage fake that enforces the real Durable Object limits): the unanswered question is said again with no model call; the answered one is not. Real Durable Object eviction, the 24-hour alarm and mobile network drops are NOT-OFFLINE-VERIFIABLE. |
| 10 | Manager and consultant disagree | WF `S10` | PASS | Rejection and dispute kept side by side with who said each; revision 1 stays readable after the amendment. |
| 11 | MAAP requested, rubric unconfigured | WF `S11` | PARTIAL | No rating exists anywhere, nothing is sent, the card says the rubric is not configured. But there is no MAAP review conversation to evaluate: the shell has no interview, only the gate. |
| 12 | Relevant to a prospect, no public permission | WF `S12` | PASS | Retrieval (JEV shortlist) finds it and carries no permission; internal use is allowed; publishing is denied at the gate with `PURPOSE_NOT_GRANTED:public_spotlight` and the CMS is never called. Live JEV ranking is NOT-OFFLINE-VERIFIABLE (needs the key). |
| 13 | DNA succeeds, MiChat fails | WF `S13` (and `W11`) | PASS | Per-card state; DNA delivered once; approval stands; no card says complete. Destinations are mocks, labelled so. |
| 14 | Duplicate webhook | WF `S14` | PASS | PM trigger twice gives one invitation; the interview's draft post twice (also concurrently) gives one record; fan-out and enqueue twice give one job and one delivery; the key is UNIQUE in the table. No inbound webhook from any destination exists. |
| 15 | Destination holds a newer revision | WF `S15` | PASS | The write is refused and flagged `needs_reconciliation`; the newer record is untouched; a job for an older source revision never delivers. |
| 16 | Permission revoked after publication | WF `S16` | PARTIAL | Revocation after approval and after the Spotlight hold flags exactly the affected branches and lists the derivatives; nothing more is sent. No real publication exists (the CMS is a mock that can only hold), so "after publication" means "after the hold". |


## v2.2 U2 scenarios (Tony, 2026-10-31): challenge, do not invite a way out

Not pack scenarios: they pin `DECISION_LOG.md` D-U2-1 to D-U2-4. They replace what the earlier "I don't know / skip is accepted at once" scenarios expected (`X3` still passes: a long answer that only contains "I do not know the exact numbers" next to real content is taken as said).

| Scenario | Test | Status | Notes |
|---|---|---|---|
| "I don't know" is not accepted at once | CONV `U2-A` | PASS | Two easier angles on the same point (`reangle_example`, then `reangle_saw` for the consultant's own part; a figure gets `reangle_scale` then `reangle_who`), each with the `reangle` acknowledgement; the third "I don't know" records the point open (`dont_know:<field>`, `ledger.deferred`, the card's open points, the plan's `deferred_fields`) and ATLAS moves on; the point is never asked again; no line invites a skip. |
| "skip", "pass", "next question" | CONV `U2-B` | PASS | The same two angles, then the point is left open; the state machine records no skip; an old client's `{type:'skip'}` gets the polite refusal `SKIP_DECLINED` and nothing else. All seven bank languages are covered by `tests/test_turns.py::test_u2_pass_and_no_idea_are_recognised_in_every_bank_language` and the parity vectors. |
| "That's all" before the essentials | CONV `U2-C` | PASS | Held twice with "I'm still missing the problem, your part and the result" plus one question; the third request goes to the read-back. With the essentials covered, or in the closing window, it is respected at once (`S4`, `S6` run their last turn after 960 s of interview time). |

## Workflow acceptance tests W1 to W12

| # | Requirement | Test | Status | Notes |
|---|---|---|---|---|
| W1 | Consultant identified before prefill | WF `W1` | PARTIAL | Proved: no verified identity means no bootstrap and no interview; the forwarded identity and role come from the token, never the browser. Not built: the project context itself (role, sector, stage) is supplied by the page; there is no server-side lookup of the consultant's own projects behind the identity. |
| W2 | Prefill only authorised fields | WF `W2` | PARTIAL | Proved: a fixed set of keys, the name dropped, unknown keys refused, a reference visible only to its owner and N+1. Not built: nothing checks that the role, sector and stage the page sends belong to the signed-in person. |
| W3 | Voice and text | WF `W3`, `W3b`, `session-text.test.js`, BROWSER typed interview | PASS | Both modes are real. A typed answer takes the same path as a spoken one (same selector, ledger, audit; labelled `consultant_typed`). A text-only interview (X1): the consultant chooses "Type instead" before starting, no microphone is requested and no audio is sent, ATLAS's replies, acknowledgements and the greeting arrive as text, nothing is synthesised, the microphone watchdog is off, the interview clock, pause, summary, evidence draft and checkpoint/resume all work in text (the mode is stored and restored). Typed text stays in the box until the server takes it; typing while ATLAS speaks interrupts her. Offline only: what ATLAS says to a real typist, and non-English text replies (the reply language still follows the voice's supported languages), are not judged here. |
| W4 | One primary question per turn | WF `W4`; every CONV scenario | PASS | Enforced in code by ReplyGuard whatever the model writes. |
| W5 | Project facts and contribution claims separate | WF `W5` | PASS | Separate records, `project` and `person` subjects; "we" decisions stay `team`. |
| W6 | Evidence links support each metric and artifact | WF `W6` | PARTIAL | Each claim carries session, item, ledger id, exact words, recognition confidence; a metric's figures stay null until a person fills them. Not built: there is no artifact upload or registry; an "artifact" is a sentence naming one. |
| W7 | Reviewer required before approval | WF `W7` | PASS | No approval by the owner or as oneself; the approval names revision and hash. |
| W8 | Rejection routes to clarify, correct or dispute; previous revision kept | WF `W8`, `S10` | PASS | |
| W9 | Approval creates independent branches | WF `W9` | PASS | Seven records; IMP waits for its own permission while DNA and MiChat go ahead. Destinations are mocks. |
| W10 | MAAP and Project Review separate state, owner, completion | WF `W10` | PARTIAL | Separate state, completion status, reasons and shells. No owner is assigned: the process owners are not named in the pack, and neither review can complete. |
| W11 | One branch failing does not fail the rest | WF `W11`, `S13` | PASS | |
| W12 | Spotlight needs exact-revision authorization and every permission | WF `W12`, `S12` | PASS | Gate order, channel, and a new revision voids earlier approvals. Against a mock CMS only. |

## Success-story template tests T1 to T10 (mapping only)

These exist in `tests/test_success_story.py` (task T14) and run in `make test`; T16 adds no new ones. All run against the real pinned template with a TEST_ONLY fixture. Word and LibreOffice rendering of the output is not verified (neither is installed here).

| # | Requirement | Test | Status |
|---|---|---|---|
| T1 | Field mapping covers metadata and narrative | STORY `test_t1_field_mapping_covers_every_metadata_and_narrative_field` | PASS |
| T2 | At most three KPIs, unsupported omitted | STORY `test_t2_at_most_three_kpis_and_unsupported_ones_are_omitted` | PASS |
| T3 | KPI keeps baseline, after, unit, period, method, source | STORY `test_t3_kpi_preserves_baseline_after_unit_period_method_and_source` | PASS |
| T4 | No numeric impact invented | STORY `test_t4_no_numeric_impact_is_invented` | PASS |
| T5 | Quotation verbatim and permission-checked | STORY `test_t5_quote_is_verbatim_and_permission_checked_and_paraphrase_never_quoted` | PASS |
| T6 | Internal notes stored separately | STORY `test_t6_internal_notes_are_a_separate_restricted_object` | PASS |
| T7 | External DOCX has no internal notes | STORY `test_t7_external_docx_has_no_internal_notes_heading_or_values` | PASS |
| T8 | Internal DOCX keeps the notes | STORY `test_t8_internal_docx_retains_the_restricted_notes` | PASS |
| T9 | 13-table layout pinned, fails safely | STORY `test_t9_template_layout_is_version_pinned_and_fails_safely` | PASS |
| T10 | Spanish labels stay; output language by destination | STORY `test_t10_spanish_labels_remain_and_output_language_is_selected_by_pinned_*` | PASS |

## Multilingual conversation (v2.2 L1, Tony 2026-10-31)

Offline only: a fake recogniser reports the language, a fake talker records the policy and notes it is given. What the model then writes, how each language sounds and whether the recogniser takes a locked language are NOT-OFFLINE-VERIFIABLE.

| Requirement | Test | Status |
|---|---|---|
| The talker is told to reply in the consultant's language, keeping proper nouns and never translating quotes, for fr es de pl ja; the next-move wording is English guidance | CONV `language-l1.test.js` first test | PASS |
| The language follows speech and typed text with hysteresis; one English word does not flip it; a selector fixes one | `language-l1.test.js` (switching, typed, lock tests), `language.test.js`, `lang-detect.test.js` plus `lang.vectors.json` (Python/JS parity) | PASS |
| No cached English is played to a speaker of any other language (pl ja ar tr); bank languages get their own lines | `language-l1.test.js`, `ack.test.js` | PASS |
| A language with no voice is answered as text, told once, never in English | `language-l1.test.js` (TTS honesty) | PASS |
| Control intents for seven languages | `test_turns.py::test_l1_*`, `turns.vectors.json`, `language-l1.test.js` | PASS (native review open) |
| Evidence keeps the original language and a tag | `language-l1.test.js` (evidence), `summary-card-dom.test.js` | PASS |
| Typed interview in French in a real browser | `tests/humane_browser.py` section 9 | PASS |
| Quality of the model's replies and voices in each language | none | NOT-OFFLINE-VERIFIABLE |

## MAAP Review Specification, section 8

MAAP is a shell: the official rubric, cadence, owners and data model were not supplied (decision D2). The tests assert what must NOT happen. None of this proves a MAAP review works.

| # | Acceptance test | Test | Status | Notes |
|---|---|---|---|---|
| 1 | Cannot close with mandatory sections or actions missing | WF `MAAP-1` | PARTIAL | Close is denied for every role, always (`MAAP_NOT_CONFIGURED`). There are no configured sections to be missing. |
| 2 | Acknowledgement is distinct from agreement | WF `MAAP-2` | PARTIAL | Neither action exists; both are denied as unknown. The distinction cannot be tested until the review is built. |
| 3 | Disagreement retained and visible to permitted reviewers | WF `MAAP-3` | PARTIAL | Proved at the evidence level (rejection and dispute side by side, visible to owner, reviewer and adjudicator, 404 for others). Not a MAAP record. |
| 4 | Closed reviews cannot be overwritten | WF `MAAP-4` | PARTIAL | No MAAP tables exist. Proved instead: an approved evidence revision is never edited in place. |
| 5 | Summary cannot reach Spotlight without independent permission | WF `MAAP-5` | PASS (shell) | MAAP is not a purpose; no purpose grant opens the Spotlight gate; no MAAP content is in anything the CMS receives. |
| 6 | Outcome cannot change DNA proficiency or employment status | WF `MAAP-6` | PASS (shell) | No such action exists for any role; DNA receives approved evidence only. |

## Release gates (Evaluation Framework section 4)

| Gate | Test | Status | Notes |
|---|---|---|---|
| 1. Zero critical privacy or permission bypasses | WF `G1`, plus the gate, evidence and branch suites | PARTIAL | Default deny holds across every known action for a role-less actor, and unknown or people-inference actions are denied for everyone. Absence of a bypass cannot be proved by tests. An external review is still needed. |
| 2. Zero unsupported claims published | WF `G2` | PARTIAL | Nothing can be published (mock destinations only). A hand-typed claim carries no interview source and is not validated until a reviewer approves its revision. A live channel is not offline-verifiable. |
| 3. Zero silent revision overwrites | WF `G3`, `S15` | PASS | Every change is a revision with its own hash; earlier revisions read back as they were; destinations holding newer revisions are not overwritten. |
| 4. Zero duplicate writes under retry | WF `G4`, `S14` | PASS | Against the mock destinations. Live destinations must honour the idempotency key; not verifiable here. |
| 5. All critical workflow transitions covered | WF `G5`, `conversation-state.test.js` | PARTIAL | Every machine transition is parity-tested, and the evidence machine is driven through every reachable one here. Two events (`close_rejected`, `reopen_review`) are defined in the machine but nothing fires them yet; `propose_downstream` is fired by the system once a destination holds the approved knowledge, and both post-approval withdrawals are driven. `G5` pins the remaining list so wiring one fails the pin. |
| 6. Human review for configured consequential decisions | WF `G6`, `W7`, `W12` | PASS | The system actor cannot approve, reject, grant, revoke, close a gate, publish or withdraw. |
| 7. Conversation quality target set with pilot users | none | NOT-OFFLINE-VERIFIABLE | Needs consultants. The rubric linter (RUB) is a regression aid and says so in its own file. |

## Rubric linter (RUB)

`docs/agent-brain-v2.1/eval/conversation_rubric.json` holds 43 annotated examples: the pack's own lines as good (rated 4 or 5) and its anti-patterns as bad (rated 1 or 2), plus four bad lines authored from the rubric's level-1 description (marked "authored"). `eval-rubric.test.js` rates each with deterministic rules and requires good at least 4 and bad at most 2, and that each bad line breaks exactly the rules it is annotated with. It also lints every stock line ATLAS can say (134 lines: questions, acknowledgements, read-back, pause and resume, greeting) and all pass at 4 or better. It is not a human rating.

## Browser (BROWSER, `tests/humane_browser.py`)

Chromium against the local edge (real Worker, library, evidence store, mock destinations); the voice socket is a scripted stand-in because the local edge serves no WebSocket. Covered: controls hidden unless announced; the resume prompt (Resume, Start over with CSRF); Pause (caption, orb, clock stops), Resume, Repeat, Skip; a typed answer; reconnect status and automatic resume; the read-back card (Correct by keyboard, a correction under five characters refused, Keep private, Confirm); "Saved as a private draft" and a separate Submit for review that posts `expected_revision`; the server state (private, then reviewer queue); the seven workflow cards with "Mock — not connected" and no overall complete; aria names; no overflow at 390 px; no page errors. Not covered: audio, the real microphone path, and what ATLAS says.

## Not offline-verifiable at all

Real latency gains; Workers AI word confidences and the 0.55 threshold; real echo cancellation and barge-in with a person speaking; Durable Object eviction and alarms; how humane Llama and Aura actually sound; non-English cues (English only); DOCX fidelity in Word; live DNA, MiChat, IMP, MAAP, Project Review and Spotlight. `scripts/eval_live.mjs` is a manual-only stub that refuses to run without explicit authorisation and, even then, runs nothing.

## Findings from writing the evaluation

1. **"I don't have the numbers" is recognised as a deferral (fixed in H1).** It was read as an ordinary answer, so ATLAS did not use its accept line (it still did not demand the figure again). The `dont_know` cue in `turns.py` now also takes "I don't have the numbers / that data / the figures". Pinned in CONV `X3`.
2. **The pack's Example 1 and its Achievement reaction praise a result before its basis is known**, which the pack's own praise rules forbid. The rubric rates them 4, not 5; ATLAS's acknowledgement gate would say "That sounds promising." instead.
3. **ReplyGuard blocks invented figures only in a read-back**, by design. In a free reply, a figure the talker makes up is voiced. The adversarial talker proves the read-back case; the free-reply case is covered by the prompt only.
4. **Three evidence-machine events are unreachable** (see gate 5).
5. **The prefill is not authorised server-side** (W1, W2). *(W3 is closed by X1: there is now a text-only interview.)*
6. `test/fixtures/` is git-ignored in `deploy/cloudflare-edge/.gitignore`; T16 re-includes `test/fixtures/eval/` so the scenario fixtures are committed.
