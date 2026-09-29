# Current status and known limits
**Handoff 12.1, application baseline v12.** This is an implementation handoff, not a new feature release.

## Baseline
The supplied application was rebuilt and its existing suites rerun for this handoff: **104 Node unit checks, 120 Python tests, and 151 browser assertions: 375 in total, with zero failures.** Python reports 81 existing aiohttp warnings. Provider/audio/identity fixtures are explicit test doubles; no real account, microphone or GPU evaluation was performed. New handoff-tool tests are listed separately in `verification/RESULTS.json`.

The compiled primary HTML and its three aliases still match the v12 application byte-for-byte. Runtime `src/`, `atlas_voice/` and `assets/Mantu.svg` are preserved. Handoff changes are documentation, build/test entry points, dependency examples, packaging hygiene and offline diagnostics.

## Capability matrix
| Capability | Existing source | Status and remaining work |
|---|---|---|
| Orb, controls, responsive interface | `src/orb-renderer.js`, `orb-ui.js`, CSS | Locally rendered/tested; target-device performance and native audio still need evaluation. |
| Local authoring, evidence, draft/export | `src/engine.js`, `app.js` | Implemented; device storage is unencrypted/opt-in and not multiuser authorization. |
| Hosted two-way voice | `atlas_voice/realtime.py` | Protocol tested with fixtures; needs approved account, model access, actual speak-first/interrupt/mic testing. |
| Adaptive interview quality | `quality.py`, intelligence UI | Quote provenance, gaps and bounded probe planner tested. A planned question is not proof the model asked it well. |
| Kyutai voice route (selected for scale) | `cascade.py`, `kyutai.py`, `analyst.py` | Added 2026-09-26. Fixture-tested protocol and evidence path. Needs a private GPU with Kyutai STT/TTS, a commercially licensed voice, and conversation/analyst LLM endpoints. Live latency, barge-in, voice quality and concurrency are unmeasured. |
| NVIDIA PersonaPlex | `server.py`, `audio.py`, launcher | Transport/codec fixture-tested. Needs dedicated GPU worker and native interoperability tests. Live hosted tools are not implemented identically here. |
| User transcript | Hosted transcription; optional Riva | Model/provider transcription needs human review. NVIDIA agent text is never consultant testimony. |
| Entra sign-in | `identity.py` | Flow/claim logic included; tenant app, assignments, actual login/logout and role-revocation behavior remain unvalidated. |
| Hindsight continuity | `memory.py` | Per-subject bank/SDK paths included; optional SDKs are not bundled. Validate against the pinned fork deployment. |
| Markdown vault and native graph | `wiki.py`, `wiki_export.py` | Real local Markdown/SQLite behavior and ACL/review tests. Requires private durable storage, backup/restore and multiuser operational proof. |
| Source-grounded editing | `editor.py` | Structured validator tested; model unavailable until explicitly configured. Citation presence is not semantic truth. |
| JEV customer matching | `jev.py` | HTTP/typed-score/recheck logic tested with fixtures. Needs actual TypeSafe access and human-labelled calibration. |
| Graphify | Authorized export only | Not installed or run. Optional downstream integration; do not label it connected. |
| WOW features F1-F7 (bids and proof, gap interviews, claim confirmation, capture and Teams, live story board, Ask ATLAS, win loop) | `deploy/cloudflare-edge/src/{bids,ask,winloop,gaps,claims,outreach,teams}.js`, `src/{bids,ask,trust}-ui.js`, `src/storyboard-*.js`; `docs/WOW_SPEC.md` | Added 2026-09-29. Locally verified on the edge build (unit suites and the end-to-end `wow_edge_browser.py`); provider verified: none; not deployed. Teams, phone and client-contact confirmation are BLOCKED_EXTERNAL; Tony's decisions and the per-feature Access, vars and secrets are in `BUILD_STATUS.md` (session 2026-09-29) and `deploy/cloudflare-edge/README.md`. |

## Explicit boundaries Claude must not erase
- **Local mode has one synthetic server identity** (`local:single-developer`). Different browser workspace names are not different authenticated users and are not private Hindsight boundaries. Use distinct Entra subjects for the isolation test.
- The current hosted adapter has real-time ASR-linked quality tools. The NVIDIA route has optional Riva **post-session** transcription; preserve this distinction in product copy and acceptance.
- **One process / one interview** is the present pilot constraint for either route. In-memory sessions, locks and throttles are not distributed. Do not run multiple replicas against one worker/vault and claim safety.
- Project metadata/notes for the voice prompt originate in the authenticated user's local draft. They are untrusted user context, not an authenticated central project roster. Central draft collaboration or CRM import is new work, not already delivered.
- Hindsight is limited to explicitly reviewed preferences and resume continuity. Its fixed `atlas-continuity` deletion does not erase older preference records, backups, exported Markdown, provider logs or unrelated documents.
- Markdown review requires an authorized non-author. Local mode cannot perform corporate publication approval. A user holding both review roles can currently make both non-author decisions; a stricter separation policy is not encoded automatically.
- Access checks operate on the current ATLAS record and stored source excerpts. The app does not continuously watch external client systems for source changes; withdrawal/correction must be propagated deliberately.
- A source/date proxy is not proof a story is current. JEV weights/thresholds are proposed pilot settings, not calibrated revenue predictions.
- Locale quality is not certified. English is the current pilot default; admit another language only after native voice, ASR, wording and disclosure review.

## Known build/operations gaps to close, not claims of runtime failure
1. Resolve and lock optional integration dependencies in the deployment environment; `requirements-integrations.txt` is not a reproducible cross-platform lock.
2. Verify native microphone/playback/interrupt behavior on the target browsers and network. Current UI tests use adapters and `set_content`.
3. Test Entra assignment removal, session expiry and organizational logout policy. Application logout currently clears ATLAS's session; it is not a claimed organization-wide SSO sign-out.
4. Validate the Hindsight generated Documents API against the exact deployed fork and SDK.
5. Run backup/restore of Markdown **and** SQLite together, then recheck hashes, grants and review expiry. The vault has no automatic restore service.
6. Explicitly accept the single-process pilot boundary or implement measured concurrency work later. No automatic failover or HA claim.
7. Complete live interview-quality and story-relevance evaluation before calling the pilot ready. Automated structural checks do not replace delivery/account/brand review.

## Specific integration details to check during Phase 1
- The browser currently has a 60-second provider-ready timer in `src/voice-client.js`; the server default `ATLAS_HANDSHAKE_TIMEOUT` is 90 seconds. Align/document the effective deadline before a slow GPU pilot rather than claiming one setting controls both.
- The hosted transcript/quality tools require the distinct capture consent checkbox. Voice-only consent permits conversation but does not produce the quote-based record. Preserve consent and make the expected capture mode clear.
- Review flags are role/record-scoped, not proof the model's interpretation is true. The product intentionally requires source and human evaluation.

## Handoff fixes already made
- `make test` now includes every `tests/test_*.py` file; `make test-ui` also includes `depth_browser.py`.
- `.gitignore` now excludes private vaults, local environment files, credentials and exports; `.env.example` remains distributable.
- Offline preflight and manifest checks added. A preflight pass means prerequisites/configuration look consistent—not that a model or service has responded.
- Read order, executable commands, code/route map, resumption log and real-provider acceptance are now in the ZIP.
