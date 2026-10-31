# Source and API map

**Application baseline v12; line references are for this packaged source and may move after edits.**

## Follow one user journey

`src/voice-client.js` obtains `/api/bootstrap`, then opens `/api/voice` after project selection and consent. `server.py` dispatches to the configured provider. Hosted `realtime.py` calls `quality.py` tools over consultant ASR text. Playback PCM goes to `voice-worklet.js`; its output-meter events drive `orb-ui.js` and `orb-renderer.js`. Notes are explicitly reviewed/applied to local project answers through the existing bridge, not automatically published.

`intelligence-ui.js` prepares a candidate and calls `knowledge_routes.py`; `WikiVault` stores Markdown plus registry state. Authorized non-author review and the correct audience make a specific revision eligible. Graph/export and JEV use the current authorized view. Hindsight is a separate explicitly consented per-subject continuity path.

## Backend entry points

| File | Symbols and baseline lines | Responsibility |
|---|---|---|
| `atlas_voice/config.py` | `Config` L24; `endpoint` L11 | Operator config and input validation |
| `atlas_voice/server.py` | `create_app` L40; `main` L385 | HTTP middleware, bootstrap, selected voice route and lifecycle |
| `atlas_voice/identity.py` | `Session` L16; `Identity` L28 | MSAL auth-code flow, session claims, roles, cookies |
| `atlas_voice/realtime.py` | `run` L23 | Hosted realtime transport, readiness, audio cancellation and tools |
| `atlas_voice/quality.py` | `InterviewLedger` L52; `session_config` L205 | 12-field candidate ledger, quote validation and next-question plan |
| `atlas_voice/interview.py` | `project_context` L23; `make_prompt` L41 | Bounded authorized/user-supplied project context and NVIDIA role prompt |
| `atlas_voice/memory.py` | `PrivateMemory` L9 | HMAC per-subject bank, bounded recall and explicit continuity CRUD |
| `atlas_voice/knowledge_routes.py` | `install` L17 | Authenticated wiki, memory, rewrite, export and JEV routes |
| `atlas_voice/wiki.py` | `clean_story` L27; `quality_gaps` L50; `markdown` L62; `WikiVault` L77 | Eight-section validation, immutable files and SQLite authority |
| `atlas_voice/wiki_export.py` | `export_view` L8 | Authorized current eligible Markdown snapshot |
| `atlas_voice/editor.py` | `parse_edit` L38; `StoryEditor` L76 | Referenced narrative suggestion; cannot save or approve |
| `atlas_voice/jev.py` | `parse_result` L28; `shortlist` L66; `JevRanker` L89 | Typed scores, customer shortlist and no-strong-match |
| `atlas_voice/notes.py` | `make_notes` L27 | Optional NVIDIA transcription and post-session assignment |

## Frontend editing map

| Source | Responsibility |
|---|---|
| `src/shell.html`, `voice-panel.html`, `intelligence-panel.html` | Actual interface/templates. Preserve IDs used by JS and tests. |
| `src/styles.css`, `voice.css`, `orb.css`, `sculpture.css`, `intelligence.css` | Existing cascade and responsive Mantu UI. Avoid adding conflicting duplicate state styling. |
| `src/ui.css` (loaded last), tokens at the top of `src/styles.css` | v2.2 F2 interface pass: one dark theme and one header for every view (`body.ui2`), light dialogs, type floor 12px, line icons from the sprite in `shell.html`, read-back card, End sheet, connections panel, privacy and language styling. `orb.css`, `orb-renderer.js`, `orb-ui.js`, `assets/Mantu.svg` and the orb rules of `sculpture.css` are not edited. Method credit: unslop by Damir Sokolovsky (CC BY 4.0). |
| `src/voice-client.js`, `voice-worklet.js` | Browser consent, mic/stream, PCM, playback acknowledgement and output energy. |
| `src/orb-renderer.js`, `orb-ui.js`, `studio-panels.js` | Particle sculpture, phrase articulation, real audio signals, silent preview and visible project context. |
| `src/engine.js`, `app.js` | Local profiles/projects, source excerpts, measurements, story versions, review UI, storage, backup. |
| `src/intelligence-core.js`, `intelligence-ui.js` | Quality lab, private resume, server wiki editor, narrative suggestion and matching workflow. |
| `src/studio-core.js`, `studio-connection.js` | Preview state and configured gateway address controls. |
| `build.py` | Standard-library template/asset inliner. `docs/BUILD_NOTES.md` and `docs/architecture.svg` are embedded build inputs. |

## Server API — same-origin authenticated application, not a public arbitrary proxy

Every non-GET/HEAD action uses the current session, exact Origin and `X-Atlas-CSRF`; websocket start separately requires its CSRF token and consent. All stored input is untrusted data. The runtime code is the executable schema; this table is its navigation aid.

| Method / path | Payload / scope | Handler |
|---|---|---|
| `GET /`, `/ATLAS_Voice.html` | Sign-in page or compiled app with authenticated runtime marker | `server.index` |
| `GET /auth/login`, `/auth/callback` | Confidential Entra flow and issued server session | `identity.py` |
| `POST /api/logout` | Clears ATLAS session; not a claimed global IdP logout | `server.logout` |
| `GET /api/bootstrap` | Selected provider/model, voices, CSRF, capability flags and identity | `server.bootstrap` |
| `GET /api/voice` (WS upgrade) | `start` with `csrf`, `consent`, `project`, `voice`, `capture`, `memory`; then audio/control frames | `server.voice` / `realtime.run` |
| `POST /api/preference` | `preference` (bounded text); server chooses private bank | `server.preference` |
| `GET /api/intelligence` | Wiki/memory/editor/JEV configuration and current roles; configuration is not connectivity | `knowledge_routes.status` |
| `GET /api/wiki?audience=internal` | Current accessible non-withdrawn records for exact audience | `knowledge_routes.stories` |
| `POST /api/wiki` | `story`, optional `id` and `expected_hash` for update | `knowledge_routes.save` |
| `GET /api/wiki/{id}` | Authorized current record, Markdown, hash, quality gaps and review state | `knowledge_routes.get` |
| `POST /api/wiki/{id}/refine` | `expected_hash`, `objective`, `consent` | `knowledge_routes.refine` |
| `POST /api/wiki/{id}/review` | `kind` (facts/permission), `expected_hash`, `reference`, `expires_at` (epoch seconds) | `knowledge_routes.review` |
| `POST /api/wiki/{id}/withdraw` | `expected_hash`; author or publication authority | `knowledge_routes.withdraw` |
| `GET /api/wiki/graph?audience=internal` | Current accessible eligible graph only | `knowledge_routes.graph` |
| `POST /api/wiki/export` | `audience`, `consent`; binary ZIP snapshot | `knowledge_routes.export` |
| `POST /api/wiki/rank` | `customer_brief`, `audience=customer-anonymized`, optional `story_ids`, `consent` | `knowledge_routes.rank` |
| `GET /api/memory/context` | Read own fixed continuity document | `knowledge_routes.memory_read` |
| `POST /api/memory/context` | `content`, `consent`; replace own continuity | `knowledge_routes.memory_write` |
| `DELETE /api/memory/context` | Delete fixed continuity document only | `knowledge_routes.memory_delete` |

Valid server story audiences are `internal` and `customer-anonymized`. Local authoring labels map to those server values; do not send UI labels as new API enums.

## Data shape / fixtures

`WikiVault.clean_story` accepts title, sections, tags, sources, kind, stage, audience, customer_brief. All eight section keys are required: `challenge`, `contribution`, `approach`, `outcome`, `evidence`, `limitations`, `customer_fit`, `poor_fit`. Each source has exactly `id`, `version`, `excerpt`, `supports`. Unknowns are legitimate drafts but may block approval. Saving does not verify a claim.

`examples/claude_synthetic_story.json` is an explicitly fictional valid candidate, not an approved reference. `examples/claude_customer_brief.json` is a fictional four-field matching brief. `examples/story-template.md` remains the human-readable drafting scaffold.

## Test map

| Area | Tests |
|---|---|
| Local authoring/geometry/audio | `tests/*.test.js` including phrase gesture/worklet/engine suites |
| Gateway/identity/protocol | `test_voice.py`, `test_realtime.py`, `test_preview.py` |
| Evidence/quality/wiki/JEV | `test_quality.py`, `test_depth.py` |
| Editor consent/stale versions | `test_editor_routes.py` |
| Runtime UI / orb / quality / editorial | `studio_browser.py`, `sculpture_browser.py`, `intelligence_browser.py`, `depth_browser.py` |
| New offline handoff tools | `test_handoff.py` |

## Interpretation notes

- The protocol name `atlas-personaplex-pcm-v1` is retained for compatibility even with the hosted provider. Do not infer the selected model from that string.
- Progress is captured information, not inferred user emotion or proven story quality. Private user and project contexts are not automatically cross-shared.
- Runtime defaults and exact source behavior can differ from examples; use CONFIGURATION.md and the doctor before launching.
- Host/Origin middleware, server role checks, external-call consent, review invalidation and Hindsight routing are deliberate boundaries; do not bypass them to unblock a screenshot.

## Added 2026-09-26
- `atlas_voice/capacity.py` — `VoiceCapacity`: bounded concurrent interviews, one per signed-in subject (`ATLAS_MAX_INTERVIEWS`). Used by `server.py` and `realtime.py`.
- `atlas_voice/analyst.py` — analyst brain: `Analyst.hear(item_id, text)` feeds a transcript to the LLM `record_details` proposals, validated by `InterviewLedger`, and returns `plan_probe` guidance. `chat_completer()` for OpenAI-compatible endpoints. Not yet wired to a route.
- `deploy/cloudflare/` — Tunnel + Access runbook and templates. `scripts/doctor.py --profile cloudflare`.
- `atlas_voice/kyutai.py` — Kyutai STT/TTS msgpack protocol, `TurnDetector` (pause prediction), PCM conversion, `stream_chat` (SSE).
- `atlas_voice/cascade.py` — `ATLAS_VOICE_PROVIDER=kyutai` route: same browser protocol as `realtime.py`; talker without tools, analyst guidance, barge-in, notes. Dispatched from `server.py` `voice()`.
- `docs/KYUTAI_SETUP.md` — GPU services, voice licensing, env vars, acceptance.
- Tests: `tests/test_cloudflare.py`, `tests/test_capacity.py`, `tests/test_analyst.py`, `tests/test_cascade.py`.

## Added 2026-09-29
- `deploy/cloudflare-edge/src/rating.js` — JEV story rating (docs/JEV_RATING.md): the rubric (`DIMENSIONS`, `CHECKS`, `LANGUAGE`), masking and the containment guard (`sensitiveTerms`, `ownMask`, `guard`, `ratingInput`), `requestBody`, `parseAnswers` (all or nothing), `compose` (weights, blockers, holds, robustness check, status), and `storyRater` (budgets, hedge, retries, circuit breaker). Called from `library.js` `review()`; wired in `worker.js`. Tests: `deploy/cloudflare-edge/test/rating.test.js`; local fake `dev/fake-typesafe.mjs`.

## Added 2026-10-30 to 2026-10-31: Agent Brain v2.1
Spec pack and status: `docs/agent-brain-v2.1/` (`README.md`, `DECISION_LOG.md`, `GAP_ANALYSIS.md`, `IMPLEMENTATION_STATUS.md`, `eval/COVERAGE.md`). How the agent works, with a diagram and the switches: `AGENT.md`. **Python is the source of truth; the edge ports are parity-tested against it.** Regenerate constants and vectors, never hand-edit them: `python deploy/cloudflare-edge/build_edge.py` (a Python with aiohttp, the project venv) writes `deploy/cloudflare-edge/src/policy.generated.js` (modules register in `EDGE_MODULES`), and `deploy/cloudflare-edge/test/gen_*_parity.py` write `*.vectors.json`.

### Python (`atlas_voice/`)
| File | Responsibility |
|---|---|
| `persona.py` | The one persona: blocks composed into `cascade.TALKER_POLICY`, `quality.INTERVIEW_POLICY`, `interview.ROLE`; `ACKS`, `BANNED_PRAISE_SRC`, pause and resume lines |
| `turns.py` | `analyze_turn`: intents, event cues, field hints, numbers for one utterance (no person description, D18); control intents for en fr es pt de it nl (v2.2 L1), cues English only |
| `languages.py` | v2.2 L1: language names, the bank languages, `detect(text)` (script ranges plus stopwords), fixed lines (screen notices, confirm-summary lines, read-back framing); exported as `LANG_*` |
| `selector.py` | `select`: deterministic next move (question ladder, redundancy, deferrals, ASR confirm, summary, close); `QUESTION_BANK` |
| `asr.py` | `uncertain_spans`, `replacement`, `TAU` (0.55; `ASR_CONFIRM_TAU`) |
| `conversation_state.py` | Interview and evidence state machines with audit (D8 to D11) |
| `workflow_config.py`, `config/atlas_workflow.json`, `config/field_visibility_policy.json`, `config/success_story_template.schema.json` | Pack YAML as validated JSON; purposes, branches, visibility |
| `success_story.py` | Schema validation, audience projection, pinned Spanish DOCX template filling (`assets/templates/amaris_success_story_es.docx`), leak scan; CLI `scripts/fill_success_story.py` |
| `speech.py` (extended) | `ReplyGuard`: one question, no empty praise, no repeated opener, 45-word cap, read-back figure rule |
| `quality.py` (extended) | Ledger provenance and withheld details; `inspect` feeds the selector |

### Edge Worker (`deploy/cloudflare-edge/src/`)
| File | Responsibility |
|---|---|
| `session.js` (extended) | One turn: hear, `turns.js`, `asr.js`, `selector.js`, `ack.js`, talker, ReplyGuard, speak; pause, resume, repeat, skip, typed and text mode; checkpoint; summary; evidence draft; flags (`sessionFlags`) |
| `prompt-data.js` (R2) | Untrusted text for prompts: `cleanText` (bounds, drops control/invisible characters, neutralises chat-role tags in any spelling) and `fenced` (per-session random fences, one USER-role data message; the system role is policy only). Used by `session.js` (project, gap list, memory), `memory.js`. |
| `extension.js` (R2) | Port of `atlas_voice/extension.py`: the one polite offer to continue from 20 to at most 30 minutes (`shouldOffer`, `extensionReply`, `hardLimit`, `offerText`). Wired in `Session.decide`. |
| `turns.js`, `selector.js`, `asr.js`, `speech.js`, `conversation-state.js`, `story-projection.js` | JavaScript ports (parity-tested) |
| `ack.js` | Content-aware acknowledgements |
| `summary.js` | Read-back facts, card items and open points from the ledger |
| `checkpoint.js` | `CheckpointStore`, `serialize`/`restore`, 24 h absolute expiry; `ATLAS_CHECKPOINT`; routes `GET /api/checkpoint`, `POST /api/checkpoint/discard` (wired in `app.js`, `worker.js`) |
| `evidence.js` | Evidence store and review in the `LibraryStore` DO: claims, revisions, approvals, grants; `postDraftFromInterview` (server to server); routes `/api/library/evidence[/:id[/status|submit|sync|review|permissions[/:gid/revoke]]]` (browser) and `/api/evidence` (Interview DO only) via `library-routes.js` |
| `policy-gate.js` | `decide(actor, action, entity, ctx)`: pure, default deny, stable reason codes |
| `branches.js`, `jobs.js`, `adapters.js`, `spotlight.js` | Seven branch cards, job envelope with idempotency and retry, mock destination adapters and MAAP/Project Review shells, Spotlight hold; `ATLAS_ADAPTERS`, `ATLAS_EVIDENCE_WORKFLOW` |
| `security-headers.js`, `security-log.js`, `ratelimit.js`, `bounded.js`, `kill-switches.js`, `audit-chain.js` | B1 platform security: headers on every response (`secure`), pseudonymous security events (`secEvent`), persistent per-person rate limits (`consume`, `enforce` for the library routes), streaming bounded body reads, operator kill switches, the tamper-evident audit hash chain (`appendAudit` is the single hook in `library.js` `log`; `verifyChain` runs in the daily `scan-stale`). Runbook: `handoff/SECURITY_RUNBOOK.md` |
| `csp.js`, `csp-report.js`, `csp.generated.js` (generated by `build.py`), `atlas_voice/csp.py` | The strict script CSP for every HTML response (hashes of inline scripts, `blob:`, no inline handlers), the JSON runtime block, POST `/api/csp-report`, the `ATLAS_CSP` rollout switch. Browser side: `src/safe-html.js` (`html`, `setHTML`, `trusted`), `src/runtime.js`; lint `tests/safe-html-lint.test.js`, browser proof `tests/csp_browser.py` |
| `privacy.js`, `privacy-routes.js`, `me-routes.js`, `subject-rights.js`, `retention.js`, `special.js` (G2) | Consent purposes, `parseConsent`, the consent state in the person's Interview DO (`applyState`, `recordConsent`) and the append-only `consent_receipts` in the LibraryStore; restriction and objection flags (`processable`, `blockedOwners`); the notice (`renderNoticeHtml`, `bootstrapView`); the library's internal `/api/privacy/*` (receipts, flags, export, erase); the Interview DO's `/api/consent`, `/api/me/export`, `/api/me/erase`; export, erasure and the DPO hold list; the daily retention sweep; the special-category phrase guard (port of `atlas_voice/privacy_config.py`, parity `special.vectors.json`). Config: `atlas_voice/config/{privacy,retention,special_categories}.json`. Docs: `docs/privacy/` |
| `app.js`, `worker.js` (extended) | `TALKER_MAX_TOKENS`, bootstrap `resumable` and `textMode`, `Interview` DO wiring (checkpoint store, evidence poster, alarm) |
| `languages.js` (extended) | Language names (any BCP-47 code), the per-turn language note, two-piece cached greetings in seven languages, screen notices and read-back words per language, `languageList` for the bootstrap (translations need native review) |
| `lang-detect.js` | `detect(text)`: script ranges plus stopword sets for typed or transcribed text; parity with `atlas_voice/languages.py` (`test/lang.vectors.json`) |

### Browser (`src/`)
`voice-controls.js` (pause, repeat, skip, typed turns, text-mode log; pure helpers), `voice-client.js` (consent, `Type instead`, reconnect, resume prompt, summary actions), `voice-panel.html`, `shell.html`, `voice.css`, `workflow-core.js` / `workflow-ui.js` / `workflow.css` (seven status cards), `storyboard-ui.js`. Rebuild every alias after a change (`python3 build.py`, then `build_edge.py`).

### Tests
| Area | Tests |
|---|---|
| Python policy and pure logic | `tests/test_persona.py`, `test_turns.py`, `test_selector.py`, `test_asr.py`, `test_conversation_state.py`, `test_workflow_config.py`, `test_success_story.py`, `test_speech.py`, `test_edge.py` (generated constants current, vectors) |
| Edge parity | `test/turns.test.js`, `selector.test.js`, `asr.test.js`, `conversation-state.test.js`, `story-projection.test.js`, `speech.test.js`, `parity.test.js` with `*.vectors.json` |
| Edge session | `test/session-humane.test.js`, `session-asr.test.js`, `session-pause.test.js`, `session-reconnect.test.js`, `session-summary.test.js`, `session-text.test.js`, `session-s1.test.js`, `h1-humane.test.js`, `h2-polish.test.js`, `worker-interview.test.js`, `app-resume.test.js`, `checkpoint.test.js` |
| Edge workflow | `test/policy-gate.test.js`, `evidence.test.js`, `branches.test.js`, `jobs.test.js` |
| Offline evaluation (`make test-eval`) | `test/eval-conversation.test.js`, `eval-workflow.test.js`, `eval-rubric.test.js`, fixtures `test/fixtures/eval/`, `docs/agent-brain-v2.1/eval/conversation_rubric.json` |
| Browser client | `tests/voice-controls.test.js`, `voice-controls-dom.test.js`, `text-mode-dom.test.js`, `summary-card-dom.test.js`, `voice-reconnect-dom.test.js`, `workflow-core.test.js`, `workflow-ui.test.js`, `tests/humane_browser.py` |
