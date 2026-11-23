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
| `atlas_voice/identity.py` | `Session` L16; `Identity` L28 | Local, Entra auth-code, or VibeApps forwarded headers; session claims, roles, cookies |
| `atlas_voice/multiinstance.py` | `PostgresAdapter`; `BlobAdapter` | Stubs for shared sessions, locks, throttles, the registry, and revision files. They refuse to connect. |
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
