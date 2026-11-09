# Build status — continue here
**Received state:** handoff 12.1 / application v12. The application is not deployed and live providers remain unvalidated.

## Next task
- **2026-09-29, JEV story rating ("make sure Atlas has Jev integreated into it so its very fast and relable to rate stories"):** built on `a45b140` in two tracks (EDGE, UI), then an integration review fixed 4 defects (a privacy gap for multi-word names and 3 no-key differences); locally verified, not committed, not deployed. Live JEV is `BLOCKED_EXTERNAL` until Tony sets `TYPESAFE_API_KEY` on the Worker and deploys (when nobody is interviewing). Read the session "2026-09-29 / JEV story rating" below first: "What Tony must do", the cost per rating, Tony's one open decision (§12.2: four other TypeSafe paths run without this consent) and the post-deploy checks.
- **2026-09-29, Voice quality ("Atlas doesnt speak well and is not totally undertsandable"):** fixed on top of `ae50fae` (live Worker aa3478f8), integrated and locally verified, not committed, not deployed. Read the session "2026-09-29 / Voice quality" below: what changed, the evidence, and what the logs of the next live session should show. Commit, then Tony deploys with `deploy.sh` when nobody is interviewing.
- **2026-09-29, WOW features F1-F7:** integrated and locally verified, not deployed. Before any deploy, read the session "2026-09-29 / WOW features F1-F7" below: Tony's pending decisions (Q12 first, because this build turns claim confirmations on) and the Access, vars and secrets each feature needs.
- **2026-09-29, WOW review fixes (26 confirmed findings on `71efb5b`):** all 26 fixed, integrated and locally verified, not committed, not deployed. Read the session "2026-09-29 / WOW review fixes" below first: it records the per-finding fixes, the exact suite results, and one item Tony must confirm before the commit (D1 is now `true` in `features.js`).
- **2026-09-29, Track Z (zero-setup start and profile prefill, `docs/WOW_ZERO_CONFIG.md`):** built on top of WOW, independently verified, not committed, not deployed. A new signed-in user needs 3 clicks (Start, the tick, Start conversation) and fills in nothing. Read the session "2026-09-29 / Track Z" below: it changes some WOW items (`SPOKEN_ASK` and `PDF_BRIEFS` variables removed, `TEAMS_ENABLED` removed) and lists the external items (§11) and Tony's D1.

0. Local suites all pass (2026-09-26). `MANIFEST.json` still describes the received 12.1 package, so `check_handoff.py` flags the intentionally changed files. Regenerate the manifest only when cutting a new release package.
1. The operator provisions the Cloudflare prerequisites in `deploy/cloudflare/README.md` (tunnel, Access app, Entra app, OpenAI key, durable host).
2. Phase 1 live voice through `https://<host>`: acceptance V01–V03.

## Work packages
| Phase | State on delivery | Next evidence |
|---|---|---|
| 0 Baseline | LOCAL_VERIFIED_ON_OPERATOR_MAC (2026-09-26; rerun green after Kyutai route) | Repeat after each change |
| 1 Real conversational voice | Kyutai route IMPLEMENTED + FIXTURE_VERIFIED; live BLOCKED_EXTERNAL (GPU + Kyutai servers, voice choice, Workers AI token). Hosting: Cloudflare Tunnel + Access | Approved account/endpoint, actual browser+mic exchange |
| 2 Interview quality | LOGIC_VERIFIED / LIVE_EVALUATION_PENDING | Scenario-based human review |
| 3 Entra + Hindsight | ADAPTERS_INCLUDED / LIVE_SETUP_PENDING | Real assignments, fork/SDK compatibility, A/B isolation |
| 4 Markdown + review | LOCAL_VERIFIED / OPERATIONS_PENDING | Durable restore and actual non-author review |
| 5 JEV / optional Graphify | FIXTURES_VERIFIED / LIVE_SETUP_PENDING | Real JEV and calibration; Graphify only if enabled |
| 6 Bounded pilot | NOT_RELEASED | Mandatory acceptance evidence and authorized deployment |

## Sessions

### Session: 2026-09-26 / baseline + Cloudflare hosting
- Goal and chosen provider: reproduce the baseline. Tony asked to host on Cloudflare "fully end to end" and chose **Tunnel + Access** over Containers or a Workers rewrite. The voice provider stays hosted OpenAI Realtime (`.env.example`).
- Host: macOS 27.2, Node v22.22.3, Python 3.14.6 (venv outside OneDrive at `~/AI-Brain-build/atlas-venv`, installed with `uv` because pip TLS failed in the sandbox). FFmpeg with libopus is present; Playwright Chromium 1228 is cached.
- Commands / exit codes: `check_handoff.py` 0 (145 files match, before edits). `doctor.py --profile preview` 0. `build.py` 0 (4 aliases identical, sha256 `dd7c5627…d314`, logo `92c5ff21…9b6c2b` unchanged). `node --test tests/*.test.js` 0: **104/104**. `pytest tests/test_*.py`: **131 passed, 18 failed, 10 errors**. All 28 non-passes are `PermissionError: bind 127.0.0.1:0 — operation not permitted` from the Claude Code sandbox, not from application code. All 4 browser scripts exit 1 because Chromium cannot launch inside the macOS Seatbelt sandbox (`ProcessSingleton` / `sandbox_extension_issue_file_to_process failed`). Browser suites: **NOT EXECUTED** on this host.
- Changes: `deploy/cloudflare/{README.md,config.yml.example,atlas.env.example,atlas-gateway.service.example}`; `scripts/doctor.py` (`--profile cloudflare`); `tests/test_cloudflare.py` (10 new tests, all pass, no port binding); `handoff/CONFIGURATION.md`; `handoff/CHANGELOG.md`. Gateway runtime (`atlas_voice/`, `src/`) and compiled HTML unchanged. Existing Host/Origin/CSRF/secure-cookie logic already works behind a Host-pinned tunnel, so no server patch was needed.
- Evidence: `handoff/verification/local-2026-09-26/` (build, hashes, node, python, browser logs, environment, pip freeze).
- External blockers (BLOCKED_EXTERNAL): Cloudflare account/zone/Zero Trust access and `cloudflared` (not installed); OpenAI key with Realtime access; Entra app registration and role assignments; an always-on durable host; optional Hindsight/TypeSafe. None of these was contacted and nothing was deployed.
- Operator rerun outside the sandbox (Tony's shell, same session): `PYTHON=<venv> CHROMIUM_PATH=<Playwright Chromium 1228> make test test-ui` → build OK; Node **104/104**; pytest **159 passed, 0 failed** (149 inherited + 10 new Cloudflare), 90 warnings (aiohttp NotAppKeyWarning / deprecated returned HTTPException, as inherited); browser studio **65**, sculpture **40**, intelligence **26**, depth **20** = **151/151**, no JS errors. Scope: fixtures + headless Chromium only; no provider, microphone or Cloudflare contact.
- Working-tree state: not a git repository. `MANIFEST.json` was not regenerated, so `check_handoff.py` will now report the intentionally edited files.

### Session: 2026-09-26 (cont.) / concurrency + scale plan
- Requirement (Tony): 12,000 consultants, interviews every 3–6 months, many simultaneous users, cost control. Tony asked about PersonaPlex on a fixed-cost GPU. Analysis in `handoff/SCALE_PLAN.md`: the stock PersonaPlex server serves 1 interview per GPU; batched serving is experimental. Decision: pilot on hosted `gpt-realtime-2.1-mini` with bounded concurrency, measure, and run a PersonaPlex bake-off with a cost/quality gate. Awaiting Tony's confirmation of this plan.
- Changes: new `atlas_voice/capacity.py` (`VoiceCapacity`: N slots, one per subject, `locked()` compatible with the former Lock API). `config.py` adds `ATLAS_MAX_INTERVIEWS` (1–100, default 1; PersonaPlex must be 1). `server.py` and `realtime.py` use it. `.env.example` sets 1, `deploy/cloudflare/atlas.env.example` sets 20. `CLAUDE.md` and `CONFIGURATION.md` updated. New `tests/test_capacity.py` (9 tests).
- Sandbox run: pytest 139 passed. All 29 non-passes are `bind 127.0.0.1:0 EPERM` (28 inherited + the new concurrency integration test). **Operator rerun of `make test test-ui` still needed** to verify the hosted concurrent-session test and regressions.
- Next task: make the identity session cap (500 per process in `identity.py`) configurable; then run a load test of 20–50 synthetic concurrent streams (SCALE_PLAN §5).

### Session: 2026-09-26 (cont.) / analyst brain
- Decision (Tony): go with the two-brain route (SCALE_PLAN §3b). Keep cost low and quality very high.
- Changes: new `atlas_voice/analyst.py`. Per consultant turn it makes one bounded tool call (`record_details` only, temperature 0, ≤800 output tokens, last 3 segments + 20 active candidates as context). Each proposed quote is validated per detail by the existing `InterviewLedger`; invented quotes are rejected, non-record tools ignored. The next probe is planned by the deterministic ledger (two-probe budget, unknowns preserved). An LLM timeout or failure yields `analyst-unavailable`, and the conversation continues. Turns are serialised in speech order. `chat_completer` targets any OpenAI-compatible endpoint (Workers AI / vLLM / OpenAI). `config.py` adds `ANALYST_CHAT_URL`/`ANALYST_MODEL`/`ANALYST_API_KEY` (HTTPS, model required). New `tests/test_analyst.py` (11 tests). Docs: CONFIGURATION, cloudflare env example, SCALE_PLAN.
- Sandbox: pytest 150 passed. The 29 non-passes are all bind EPERM (sandbox). Node 104/104. Operator `make test test-ui` rerun still pending (it also covers the concurrency integration test).
- Not yet done: wiring the analyst to a live ASR stream and a voice layer; no LLM or provider was called.
- Next task: step 2 infrastructure. (a) Streaming-ASR adapter (Kyutai STT self-hosted or Workers AI nova-3) that emits `(item_id, text)` final segments to `Analyst.hear`. (b) Voice-layer adapters: PersonaPlex + inner-monologue injection (fork of `abhinavpgagi/personaplex-tool-calling`; review its source first) and Kyutai Unmute (LLM context injection). (c) Bake-off harness. Needs Tony's GPU rental and keys for the live part.

### Session: 2026-09-26 (cont.) / Kyutai voice route (primary for scale)
- Finding: the PersonaPlex tool-calling fork is one conversation per process, and shared-GPU workers "collapsed" (the fork's own README). Tony's goal is lowest cost, high voice quality and many users, so the primary route is now Kyutai STT/TTS (batched, many streams per GPU) plus a conversation LLM plus the analyst.
- New: `atlas_voice/kyutai.py` (moshi-server msgpack protocol verified against kyutai-labs/unmute source; pause-based `TurnDetector`; PCM conversion; SSE `stream_chat`). `atlas_voice/cascade.py` (`ATLAS_VOICE_PROVIDER=kyutai`: same browser protocol as the hosted route, talker without tools, analyst guidance, barge-in clears queued audio, the last analyses are awaited before notes, honest errors, no fallback voice). `docs/KYUTAI_SETUP.md`. `scripts/load_kyutai.py` (GPU concurrency measurement). `requirements.txt` adds `msgpack`.
- Changed: `config.py` (kyutai/conversation variables; refuses the non-commercial `expresso/` and `ears/` voices; `ATLAS_MAX_SESSIONS` 10–20000). `identity.py` (configurable session cap). `server.py` (dispatch plus bootstrap `providerLabel`/`liveLedger`/`playbackAck`/`capacity`). `src/voice-client.js` (provider-agnostic labels, consent text, playback-ack gating, capacity row; HTML rebuilt). `scripts/doctor.py` (`--profile kyutai`). Env examples: the Cloudflare example now selects kyutai. Docs: CLAUDE.md, CONFIGURATION, CURRENT_STATUS, SCALE_PLAN, CODE_MAP.
- Sandbox results: pytest 159+ passed. Every non-pass is `bind EPERM`: the 28 inherited socket tests plus the new concurrency and Kyutai full-session tests. Node 104/104. Build OK, logo hash unchanged. **Unverified until the operator runs them:** `tests/test_cascade.py::test_cascade_session_speaks_listens_records_evidence_and_notes`, `tests/test_capacity.py::test_hosted_interviews_run_concurrently_up_to_limit`, and the 4 browser scripts after the voice-client edits.
- Operator run (Tony's Mac): Node 104/104; pytest **188 passed, 1 failed**. The Kyutai full-session test passed. The failure was a genuine ordering bug in `capacity.py`: when all slots were full, a user who already had an interview got 'full' instead of 'duplicate'. Fixed (duplicate is checked first) and a regression assertion added; capacity unit tests pass. Operator rerun after the fix: build OK (logo hash unchanged); Node **104/104**; pytest **189/189** (98 inherited-type aiohttp warnings); browser studio **65**, sculpture **40**, intelligence **26**, depth **20** = **151/151**, no JS errors. Scope: fixtures + headless Chromium only.
- Not contacted: any Kyutai server, LLM, GPU or provider. PersonaPlex + analyst wiring deferred (cost finding above).
- Bake-off needs (BLOCKED_EXTERNAL): hourly L40S/H100 rental with Kyutai STT/TTS installed; a commercially licensed voice choice; a Workers AI token (conversation + analyst); optionally an OpenAI key for the reference comparison.

### Session: 2026-09-26 (cont.) / Workers AI model check (live provider, synthetic data)
- Tony connected his Cloudflare account through the Cloudflare API connector (OAuth). Read-only findings: personal account (not Mantu-owned); **no zones/domains**; no tunnels; Access has One-time PIN only (no Entra IdP); Workers AI offers gpt-oss-120b/20b, llama-3.3-70b-fast, llama-4-scout, mistral-small-3.1, gemma-4, qwen3.
- **PROVIDER_VERIFIED (synthetic text only):** the analyst on gpt-oss-120b produced exact quotes via tool calls 3/3 and ignored the injection. After a policy fix, the talker on llama-3.3-70b-fp8-fast asked exactly one question 6/6, followed the guidance and took 0.6–1.5 s. Evidence: `handoff/verification/workers-ai-2026-09-26/RESULTS.md`.
- Code: `cascade.py` TALKER_POLICY now requires exactly one question of about 25 words, no bundled sub-questions, no verbatim guidance (regression assertion added). Defaults were set in the Cloudflare env example and KYUTAI_SETUP.
- Cost observed: analyst ~32–43 neurons/turn (≈$0.02 per 40-turn interview). Total spend for this check ≈ a few cents.
- No secrets were created or printed. The Workers AI API token for the gateway should be created by the operator in the dashboard (Workers AI read + run scope) and placed directly in `.env`.
- Still BLOCKED_EXTERNAL: a domain on Cloudflare (needed for the Tunnel hostname), the decision on a personal vs Mantu-owned account, GPU provider + budget, Entra app, voice choice.

### Session: 2026-09-26 (cont.) / RunPod bake-off automation
- Tony decisions: personal Cloudflare account **for testing with synthetic data only**, no domain yet, RunPod with a **$50 prepaid cap**.
- RunPod: account signed in by Tony. An API key `atlas-bakeoff` was created in the console via browser automation. Saving it to disk was blocked by the permission system (credential guard), so Tony will save it himself. Balance **$0.00**: credit not yet loaded. A Playwright page snapshot may contain the key: **delete the `atlas-bakeoff` key after the bake-off** (the `down` command reminds). `.gitignore` now excludes `.playwright-mcp/` and `*.key`.
- New: `scripts/runpod_bakeoff.sh` (plan/up/logs/fetch/tunnel/status/down; keys read from files and passed via an fd header, never argv/stdout; dedicated SSH key; SSH-only pod). `scripts/pod_setup.sh` (Unmute dockerless procedure, moshi-server 0.6.4, `--addr 127.0.0.1`, random Kyutai key, batch STT 64/TTS 32, ATLAS kyutai `.env` with the selected Workers AI models, readiness check, doctor, gateway, load test). `tests/test_bakeoff.py` (4 tests pass). Verified externally: image tag `runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04` exists; `moshi-server worker` supports `--addr`; voice `vctk/p225_023.wav` exists (CC BY 4.0).
- Not yet executed: no pod created, nothing billed. The pod scripts are untested on real hardware; expect first-run fixes during `up`.
- Next: Tony saves both keys and loads $50, then runs `bash scripts/runpod_bakeoff.sh up` in Terminal. Claude reviews `handoff/verification/runpod-<date>/`, then `tunnel` for a live interview, then `down`.

### Session: 2026-09-26 (cont.) / E2E demo + JARVIS-style orb
- `scripts/e2e_demo.py`: the real page, gateway, cascade, analyst and ledger through a visible Chromium, with simulated STT/TTS/LLM and a fake mic. Operator run: **11/11 checks passed**. Screenshots in `handoff/verification/e2e-2026-09-26/` were reviewed (orb speaking, ledger 3 quoted details, next probe "before and after values", notes dialog quotes by topic, stories page, mobile). Fixes made along the way: CSP-safe polling (the gateway CSP blocks `unsafe-eval`, as intended), zero checks now count as a failure, and the demo is muted by default (`--sound` to hear the placeholder tone, which is not a voice).
- UX fix: ATLAS replies now appear as separate paragraphs in the transcript (cascade `agent_text`); assertion added to the Kyutai full-session test.
- RunPod key: now valid (API 200) via the osascript hidden dialog. Workers AI key: the file is still invalid (400) and needs re-entry.
- Orb: Tony asked for the look of his JARVIS orb (said the current one "sucks"). `src/orb-renderer.js` v12 adds the `Swarm` class (Canvas2D port, permission recorded in the header) and a new draw(); the public API and MotionRig/geometry exports are kept. `tests/swarm.test.js` has 8 new tests; Node **112/112**. HTML rebuilt (330,881 bytes; logo hash unchanged). **Browser suites and the visual check are pending the operator rerun.**

### Session: 2026-09-26 (cont.) / orb life cues
- A visual harness (the real `orb-renderer.js` in the operator's visible Playwright window, with simulated levels) was used to judge frames. First v12 frames: idle flat and dim, speaking muddy. The v13 speaking state then **blew past the canvas**: the root cause was hotter-than-JARVIS audio envelopes plus unbounded perspective. Fixed by rescaling, a soft outer wall and a perspective clamp, and verified numerically (edge ≤ 1.1 across idle, listening, 30 s of speaking, idle).
- Added breathing, glances, mic-driven attention with neural link flashes, played-audio exhale, a luminous nucleus, depth colour and twinkle. Node 112/112. HTML rebuilt. Screenshots are in `.playwright-mcp/orb-v1[2-5]-*.png` (local, git-ignored).
- Operator e2e demo with the new orb: **11/11**. In-app screenshots reviewed: the idle cloud overlapped the status caption, so the scale was reduced from .40 to .36 of the canvas.
- **Pending:** operator run of `make test-ui` (pixel, pause and reduced-motion checks).

### Session: 2026-09-26 (cont.) / Cloudflare voice route, full screen, mic diagnostics, Git
- The mic "asks permission but doesn't hear me" report is explained: the e2e demo intentionally uses Chromium's fake microphone. Real gaps were still fixed: 6 s silent-mic diagnostics naming the device and pointing to OS privacy settings; explicit NotFound/NotReadable messages.
- Full screen: the focus button now also puts `#voicePanel` into true browser full screen with an enlarged orb; Esc exits both.
- New `atlas_voice/speech.py`: a speech-backend interface. `KyutaiSpeech` is the existing protocol, moved. `WorkersSpeech` is Cloudflare Workers AI over HTTPS: `EnergyTurns` (adaptive noise floor, 80 ms onset, 750 ms end, raised threshold during agent playback against echo), nova-3 per utterance, aura-1 per sentence as linear16 24 kHz PCM. `cascade.py` now runs on either backend (`ATLAS_VOICE_PROVIDER=kyutai|workers`). Config: `WORKERS_AI_ACCOUNT`, `WORKERS_AI_API_KEY`, `WORKERS_STT_MODEL`, `WORKERS_TTS_MODEL`, `WORKERS_TTS_VOICE` (validated against the aura-1 speaker enum from the model schema). `tests/test_speech.py`: 9 tests pass.
- `scripts/run_local_voice.sh` runs the local gateway on the Cloudflare voice route, taking the key from `~/.config/atlas/workers-ai.key` at launch; nothing is written to the synced project folder. `scripts/check_workers_speech.py` is the live aura→nova round trip.
- **UNVERIFIED LIVE:** the nova-3 REST binary-body contract (query params + `audio/wav`) and aura-1 raw PCM are inferred from the model schema. The Workers AI key file is still invalid (HTTP 400), so run `check_workers_speech.py` once it's fixed.
- Operator full run after the speech-backend refactor, full screen and mic diagnostics: Node **112/112**, pytest **202/202** (the Kyutai full-session and concurrency integration tests pass on the refactored `KyutaiSpeech`), browser **151/151** (studio 65, sculpture 40, intelligence 26, depth 20). Scope: fixtures and headless Chromium.
- Git: the sandbox cannot write `.git/config`, and the gh token in the keyring is invalid. `scripts/git_publish.sh` (secret/private-file guards, private repo) plus `handoff/COMMIT_MSG.txt` are ready for the operator to run.

### Session: 2026-09-26 (cont.) / Cloudflare edge deployment (live test instance)
- Tony: "open it on the web … on a Cloudflare instance … real back end and front end". Built `deploy/cloudflare-edge/`: a Worker plus a Durable Object per person, Workers AI via binding (no provider keys), Cloudflare Access identity (RS256 JWT verified in-Worker, fail closed), CSRF HMAC, strict CSP and a test-data banner.
- **Parity with Python:** policies/fields/regexes are generated from Python (`build_edge.py`). JS ledger parity: 56 ops across 4 scenarios identical (after fixing the vector generator, which captured Python's aliased detail objects late). EnergyTurns/sentences parity 7/7. Edge Node tests **20/20** (parity, speech, sessions, Access JWT, routes, adapters). `tests/test_edge.py` (3) fails when generated files are stale. `make test` now includes `test-edge`.
- **Access app created via API** (live, account change): "ATLAS (test deployment)", domain `atlas.tony-walteur.workers.dev`, One-time PIN IdP, policy allow `tony.walteur@gmail.com`, session 24 h, aud `fc05e3d9…f386` (public identifier, in `wrangler.jsonc`).
- **Not yet deployed:** Worker upload needs `npx wrangler login` (interactive) then `deploy/cloudflare-edge/deploy.sh`. Workers AI binding call shapes (nova-3 audio body, aura-1 linear16, streamed llama SSE, gpt-oss tool calls) are handled defensively but unverified until the first live session.

### Session: 2026-09-27 / LIVE on Cloudflare
- **Deployed** `atlas` Worker (versions c010bf47 → 84684943) at https://atlas.tony-walteur.workers.dev behind Cloudflare Access (verified: unauthenticated and forged-header requests are 302-redirected to login). Deploys can now run from the Claude sandbox (`WRANGLER_LOG_PATH=$TMPDIR/... npm_config_cache=$TMPDIR/...`), using the operator's wrangler login.
- **PROVIDER_VERIFIED (live, synthetic project):** Access sign-in → the real page with a verified identity → `/api/bootstrap` 200 → WebSocket to the Durable Object → `ready` in 2.6 s → the opening question streamed by llama-3.3 and **spoken by aura-1** (first audio 3.7 s after Start) → the orb animated from played PCM.
- **Live bugs found and fixed (with regression tests):** (1) room noise during composition cancelled the opening forever. Barge-in now only stops audible playback; noise-only interruptions trigger a re-ask. (2) Speaker echo cut ATLAS off, and its transcript could have become "consultant testimony". Now: a stricter barge-in while audible (4× floor, 450 ms, Python/JS parity) plus an echo filter (≥70% word overlap with recent agent text is ignored and reported). (3) The badge was inserted inside a script string (the page contains two `</body>`). (4) A session closed at 14 s: the cause was a redeploy during the session ("script has been upgraded"), not an app bug. Rule: never deploy during a live test.
- Content-free metrics are now in Worker logs (`atlas_metric`: stt, reply first_text/first_audio, analyst, barge_in, echo_ignored, errors by name).
- Edge tests **24/24**. Python speech/edge tests pass. **Still unverified live:** nova-3 transcription of a real voice, the gpt-oss analyst via the binding, notes at the end. Needs Tony to speak in his Chrome with headphones.

### Session: 2026-09-27 (cont.) / live fixes, Windows sign-in (built, off)
- Live E2E (automation browser, synthetic): the opening question played fully (6.7 s audio, no overlap, no barge-in, no errors) after fixing **playback overflow over the internet**. Wall-clock pacing let network jitter exceed the browser's 350 ms ring. Now the pacer uses **ack-based flow control** (never >300 ms ahead of audio the browser has actually played; falls back to wall-clock without acks), and bootstrap enables `playbackAck` for the edge. Regression test added.
- Tony's "Start doesn't talk": my automation sessions used his Access identity and occupied his one-per-person slot, so his start was refused as busy. Fix: **newest window takes over** (the old session ends with a clear message). NOT YET DEPLOYED: Tony must re-run `wrangler login` + deploy. My sandbox wrangler run invalidated his OAuth token (it refreshed but couldn't persist). Never run wrangler from the sandbox again.
- The virtual-microphone harness (`/api/test-voice`, TEST_VOICE=1 only, behind Access) played its synthetic answers, but the server detected no speech. Unresolved (likely AudioContext activation in the harness); not an app finding. Remove TEST_VOICE after testing.
- **Windows / Microsoft 365 sign-in: built, not enabled.** `entra/README.md`, `entra/enable_entra.sh` (refuses without `--i-have-it-approval`), and the Worker `IDENTITY_SOURCE=entra` path (tenant allow-list, UUID `tid`/`oid`, required app role, person key `tid:oid` = Python Entra scheme). Test added; edge **27/27**.

### Session: 2026-09-27 (cont.) / "I don't hear it"
- Evidence: the server produced and sent ATLAS's voice for Tony's session (reply first_text 554 ms, first_audio 1023 ms). A later instrumented run received 6.2 s of voice, the output meter moved (0.30–0.56) and the orb was speaking, so the break is between the browser and Tony's ears (output device, muted tab, or the automation window's simulated mic).
- Product fix instead of instructions: a two-note **chime on connect** straight to the speakers (proves the output path; bypasses the worklet so the orb still moves only with ATLAS's voice); a **"Can't hear ATLAS?"** panel listing audio outputs with in-app switching (`AudioContext.setSinkId`) and a test sound, with Mac/Windows instructions where switching isn't supported; a blocked-autoplay prompt; the AudioContext now runs at the device's native rate (the worklet already resamples to/from 24 kHz). Node 112/112, edge 27/27, HTML rebuilt. Browser suites pending the operator run.
- Deploy pending: Tony must `wrangler login` again, then deploy (without TEST_VOICE, which removes the test endpoint).

### Session: 2026-09-27 (cont.) / voice, consent, continuity, JEV, open questions
- Tony: the voice "seems annoying"; wants better UX, JEV-assisted question choice, one best voice (no picker), consent covering transcription + reuse for future projects, conversation surviving window/screen changes, and open questions so people say the most up front.
- **Voice:** `@cf/deepgram/aura-2-en` "harmonia" (Deepgram: empathetic, clear, calm, confident), replacing aura-1 "asteria" ("energetic"). There is no picker; the server accepts only the default. Python Workers route aligned (curated aura-2 list, default harmonia).
- **Manner** (TALKER_POLICY, Python source → generated edge): calm senior colleague; no "Thanks/Great" openers, no exclamation marks, contractions, minimal acknowledgements; prefers open questions; lets long answers run. **Opening**: one broad invitation to tell the whole story. **Turn-taking**: end-of-turn silence 0.75 → 1.1 s, max utterance 90 s (Python/JS parity regenerated).
- **Consent:** one plain-language consent in the real dialog (`src/shell.html`; `src/voice-dialogs.html` is an unused orphan): transcription + reuse of reviewed/approved notes as reference for future Mantu projects. Edge bootstrap sets `captureRequired`; the Session refuses a start without capture (tested).
- **Continuity:** screen changes (Conversation/Projects/Stories), read-only dialogs and a background tab/window no longer stop the conversation. Project/workspace/profile changes, destructive confirms and project edits still do. A **live pill** (listening · Mute · End · Back to conversation) shows on other screens. `studio_browser.py` assertion updated to the new behaviour (pending operator run).
- **JEV:** `deploy/cloudflare-edge/src/jev.js` next-question ranker, OFF unless the `TYPESAFE_API_KEY` secret is set. It ranks only when the ledger leaves a free choice, sends the interview *shape* only (no transcript/quotes/names), and overrides only on a +0.5 score and ≥0.6 confidence; any failure keeps the ledger choice. Tests: `test/jev.test.js` plus a session integration test.
- Tests: edge **35/35**, Node 112/112, Python speech/edge/analyst 24/24. Browser suites pending the operator run. **Not deployed**: needs Tony's `bash deploy/cloudflare-edge/deploy.sh`.

### Session: 2026-09-27 (cont.) / JEV classification, confidential client, warmer manner
- Tony: JEV fully set up to classify and score projects by impact and practice area; record the confidential client (who/where) per project; ATLAS should sound warmer ("hmm, interesting", "thanks for sharing").
- **Manner:** TALKER_POLICY now asks for natural, varied reactions before each question, never praising unverified numbers as fact, at most one exclamation per conversation. Regenerated the edge policy.
- **JEV classify:** `deploy/cloudflare-edge/src/classify.js` + `POST /api/jev/classify` (Access + Origin + CSRF, 64 KB cap). Asks System One for one practice-area Choice (8 areas + other), a Noul per area for secondary areas (>= 0.6), and five 0-4 Scores (business impact .30, evidence .25, reusability .20, differentiation .10, showcase readiness .15). Code owns weights and composite (0-100); weights are uncalibrated. Retries 429/529 twice. 503 without `TYPESAFE_API_KEY`.
- **Confidential client:** project form section (client name, where, with whom), kept in the local project, shown on the card with a lock. `projectState()` rejects any non-allowlisted field, so client details cannot reach JEV; the voice snapshot and story generation do not read them (regression tests).
- **Projects screen:** "Score impact with JEV" (only when the server reports JEV configured), impact bar, category chips, dimension scores, "answers changed - rescore" when the record revision moves, sort by impact, filter by practice area (primary or secondary).
- Tests: Node 114/114 (+2 engine: client bounded and absent from story; JEV result clamped/dropped when malformed), edge 42/42, Python 176 passed + 30 sandbox-only EPERM bind errors (operator run needed). Browser: scratch Playwright run with mocked `/api/bootstrap` and `/api/jev/classify`, 13/13 (client saved, card, CSRF, client not in request, impact, chips, persistence, sort, filters, stale flag, no page errors).
- **Blocked external:** live JEV needs a TypeSafe key as the Worker secret `TYPESAFE_API_KEY`. Not deployed.

### Session: 2026-09-27 (cont.) / ATLAS ends the interview, writes the report, N+1 validation
- Tony: when the interview is done ATLAS closes the mic, writes a report from the conversation that he sees; the consultant's N+1 is asked to validate it unless the consultant is manager staff.
- **Ending:** TALKER_POLICY "ENDING" rule (ask once if there is anything to add; warm close; say the report is being prepared; end with `[[END]]`). `EndMarker` strips the token across split deltas so it is never spoken, shown or kept in history (Python `atlas_voice/report.py`, edge `src/report.js`, parity vectors `test/report.vectors.json`). After the closing line has played (edge: acknowledged playback; Python: queue drained) the server sends `wrap_up`; the browser runs its normal End, so notes follow the existing clean path. Never on the opening.
- **Report:** at clean end with capture on, the analyst model (edge: `ANALYST_MODEL` via the AI binding; Python: `ANALYST_CHAT_URL`) drafts JSON from the transcript tail (24k chars) + quote-linked notes: headline, summary, six topics, highlights, gaps, follow-ups; client referred to only as "the client"; parsed and bounded (`parseReport`/`parse_report`), 25 s budget, failure = `report: null` and the notes still arrive. Browser shows it at the top of the end-of-interview dialog ("Your interview report."); saving stores `project.report` (engine `cleanReport`) even with no topic notes checked.
- **N+1 validation:** project form "Validation" section (N+1 name, email, "I am manager staff"), prefilled from the last project. Saving a report sets `validation.status` to `awaiting` (or `not_required` for manager staff). Card and report dialog show status; "Email N+1 for validation" opens a mailto draft the consultant sends (client name excluded, <= 1800 chars, not-verified footer); "Record N+1 validation" (confirm) sets `validated`; any later record change reopens it; imports never carry `validated`. Local records, not authenticated approvals.
- **Blocked external / not built:** automatic notification (Microsoft Graph sendMail or Teams) and automatic N+1 lookup (Graph `/me/manager`, manager-staff detection) need Entra sign-in and server-side project storage; the N+1 cannot open the consultant's browser-local project. Manual email draft is the honest interim.
- Tests: Node 117/117 (+3 engine: validation lifecycle, email excludes client and keeps footer, report bounds/round trip), edge 52/52 (+8 report/marker parity, +2 session: token never spoken/shown, wrap_up after playback, report in notes; report failure keeps notes), Python `tests/test_report.py` 4/4. Browser (scratch Playwright, mocked server): 23/23 incl. N+1 saved, bridge saves report, awaiting, card, report dialog, mailto content (no client), validation recorded, no page errors. Not browser-tested: the live `wrap_up` -> End round trip over a real WebSocket (covered by the session unit test only).
- Needs Tony's deploy. Live check: finish an interview by saying "that's everything", confirm ATLAS closes, the report appears, and save it.

### Session: 2026-09-27 (cont.) / seamless save, no provider branding, speaking budget, admin mode
- Tony: when ATLAS finishes, create/update the project with story and context automatically (no click); no visible voice preset or "Cloudflare"; 10 min max of HER speaking; best overview questions; she knows Tony Walteur created her but never says it; admin mode for Tony (faster, ends when he says so).
- **Seamless save:** interviews can start with no project (placeholder context). On `notes`, the browser calls `bridge.autoSave`: creates the project if needed (title = report headline, N+1 carried from the last project), appends the quote-linked notes, saves the report (awaiting N+1), keeps the transcript as `project.interview` (unverified ASR, 60k cap, not evidence), assembles the story draft with the report's topic paragraphs, then opens the report. Any failure (e.g. the project was edited during the call) falls back to the review dialog; nothing is lost. Consent text now says the conversation is saved with a report to the project and reused only once reviewed and validated.
- **Branding:** bootstrap/ready say "ATLAS voice"; the only advertised voice is the alias `atlas` (server maps it to `TTS_VOICE`); 401/404 texts are neutral. Test asserts no cloudflare/harmonia/"workers ai" in bootstrap, 401 or the page. Code comments, file paths and the Access sign-in page itself still say Cloudflare (not ATLAS UI).
- **Speaking budget:** edge meters ATLAS audio actually sent (`spokenMs`); 600 s limit (`SPEAKING_LIMIT_S`), then the next reply is the TIME_UP close and `wrap_up`. Whole-call safety cap 45 min (was 15). Every talker call gets a server INTERVIEW PACE note: minutes used, areas with no notes yet (names only), "nearly up" at 90 s left.
- **Questions:** TALKER_POLICY "OVERVIEW FIRST" (touch every area once with an open question, then deepen the one or two most valuable gaps).
- **Creator:** policy "ABOUT YOU": created by Tony Walteur; never mention the creator, even if asked.
- **Admin:** `ADMIN_EMAILS` var (tony.walteur@gmail.com) matched against the verified Access email; the Worker always overwrites `x-atlas-admin` (spoof test); the DO adds ADMIN_NOTE (short replies, no pleasantries, ends immediately with [[END]] when he says finish). Bootstrap exposes `admin` (not used in UI yet).
- Not ported to the Python/Kyutai route: speaking budget, pace notes, admin (policy text is shared).
- Tests: Node 118/118, edge 55/55 (+admin spoofing/branding, speaking limit -> TIME_UP -> wrap_up, admin/pace notes), Python 180 passed + 30 sandbox EPERM. Browser (mocked server): auto-save 8/8, earlier Projects flow re-run without failures.

### Session: 2026-09-27 (cont.) / end-to-end client test, stray-cancel fix, Python parity
- **New permanent test** `tests/autosave_browser.py` (added to `make test-ui` and CLAUDE.md): real Chromium, fake microphone, mocked voice socket. After Start there are no clicks: ATLAS `wrap_up` -> page sends `end` -> reporting/notes -> project created, report opens, mic released, status "Saved to ...". 11/11.
- **Bug found by it and fixed:** auto-save switched the current project while the session was closing; the voice client's project watcher then cancelled (stray `discard`, status overwritten with "Project changed"). `autoSave` now detaches the finished session first; the final status names the saved project.
- **Python route parity:** `SPEAKING_LIMIT_S`, `TIME_UP`, `AREAS` and `pace_notes()` now live in `atlas_voice/cascade.py` and are generated for the edge (`paceNotes` port, `test/pace.vectors.json`). Python route meters its own sent audio, forces the TIME_UP close + `wrap_up`, adds pace notes, and enables ADMIN_NOTE for the Entra app role `ATLAS.Admin` (`ENTRA_ADMIN_ROLE`); `ATLAS_SPEAKING_SECONDS` (60-1800, default 600). Python integration still needs the operator run (sockets blocked in the sandbox).
- Admin hint in the consent dialog when the server flags admin.
- Tests: Node 118/118, edge 56/56, Python 182 passed + 30 sandbox EPERM, autosave browser 11/11. Memory index corrected (deploys only through Tony's `!`).

### Session: 2026-09-27 (cont.) / "make sure this is the best we can do": three independent reviews, 28 findings, fixes
- Method: three read-only review agents (server session + security; browser auto-save/report/N+1; interview prompt design). Each finding checked against the code before fixing; the server race was reproduced with a script before and after (before: 2 reports/2 notes/2 ended and replies during the end wait; after: 1/1/1, none).
- **Prompts:** TALKER_POLICY is now one standalone voice policy (no longer INTERVIEW_POLICY + "ignore the above"): speech rules, story contract, breadth-then-depth order, stale-hint rule, situations (questions to ATLAS, off-topic, cannot share, English only, injection), two-turn ending, creator known but never confirmed/denied. ADMIN_NOTE explicitly overrides manner/order/ending and never ends on its own. Pace note names only the next uncovered area. REPORT_POLICY: interviewer lines are context not facts, number attribution rule, names generalised in every field, schema described in prose.
- **End token:** near misses ([END], [[ end ]], [[End]]) stripped; a split "[[END]" + "]" no longer leaks a "]"; a reply that still asks a question never ends the interview (admin excepted). Parity vectors extended.
- **Report input:** interleaved ATLAS/Consultant transcript (was consultant-only), head + tail kept for long interviews. gpt-oss via the binding may answer in Responses API shape: `responseText`/`responseToolCalls` accept Chat Completions, Responses and legacy shapes (this likely also affected the analyst's tool calls, never verified live); reasoning effort "low" with automatic retry without it; report max_tokens 3000; one retry on an unusable report; timer cleared.
- **Server races:** single shared `end()` (no duplicate reports/notes/saves at the wall cap), no replies while closing, the consultant's last utterance is still transcribed and recorded, wrap-up waits while they are mid-sentence and cancels if they add something, wall-clock fallback when playback acks are missing, speaking budget re-checked on every reply (an interrupted closing or noise re-ask cannot escape it). Classify: early Content-Length 413, input errors 400 (checked before the key), other failures 502 generic. Shared limit constants in bootstrap; admin never from an Entra username fallback. Python route: same budget re-check, question backstop, wrap-up cancel.
- **Browser:** auto-save is all-or-nothing (rollback of a created project), manual fallback works with no project, revision check only covers answers/deferred (editing story/sources during a call no longer loses the report), edited stories are never overwritten (buyer/audience kept), earlier transcripts kept, recorded client details scrubbed from the report before storing (`E.scrubReport`), honest "Saved" wording and a device-save opt-in prompt when storage is off, report included in the fallback export, filters fully reset, placeholder no longer hides the fictional example, report dialog refreshes after emailing the N+1.
- **Also found by the first full run of the older browser suites:** focus-mode full screen could arrive after Escape and hide the side panels (fixed in `orb-ui.js`); two stale test assertions updated to the intended behaviour (placeholder context is not a project; live track check counts only the current session).
- Tests: Node 119/119, edge 61/61, Python 182 passed + 30 sandbox-only socket tests (operator run), browser suites all green: studio 66 (x3 stable), sculpture 40, intelligence 26, depth 20, autosave 19.
- Not verified live: any of this with real speech and the real models; needs Tony's deploy and a spoken test.

### Session: 2026-09-27 (cont.) / orb: rotation, wander, click and drag (JARVIS reference)
- Tony: make the orb more like his JARVIS reference: rotating, moving around, and reacting when clicked or dragged with the mouse.
- `src/orb-renderer.js` Swarm touch layer: per-state resting spin (`SWARM[state].rate`) + wobble, bounded wander of the whole body, hover repulsion (cursor mapped into model space), click flinch (`poke`: scatter, spin kick, spark flurry, core flash, re-forms), drag (`drag`: turns with the hand, pulled along within bounds, fling inertia, springs back). `create()` wires pointerdown/move/up/cancel with pointer capture; a drag suppresses the orb-button click, a click still starts / mutes and also flinches; keyboard activation flinches. `inspect().touch` exposes spin/offset/flash for tests. CSS: grab cursor, `touch-action: pan-y` on the canvas.
- Honesty rules kept: speech motion only from played PCM, no wave/ring, reduced motion and pause disable the layer. Docs: `docs/ORB_DESIGN.md` "Touch layer".
- Tests: swarm unit tests 14 (+6: resting turn per state, bounded wander, click flinch then re-form vs an untouched twin, drag turn/pull/spring-back/clamps, hover repulsion bounded, junk input), new `tests/orb_touch_browser.py` 8/8 (rotates, wanders, drag turns and never opens the start dialog, fling coasts, click flinches and still starts). Node 125/125, edge 61/61, all browser suites green.

### Session: 2026-09-27 (cont.) / the brief: reference creation and reuse platform (P1-P4)
- Tony: make sure ATLAS covers every feature and pain point of the "Expected Tool / Platform" brief; just us (no reviewers, no Dust).
- **Trace:** `docs/REQUIREMENTS_TRACE.md` (every line → where → test → status); solution, two operating models, record, backend options and open decisions in `docs/SOLUTION.md`; contracts in `docs/INTEGRATIONS.md`; plan `handoff/PLAN_REFERENCE_PLATFORM.md`.
- **P1 capture:** interviewer states the purpose, asks the template details once (timeline, team, technologies, deliverables, service line, country), separates activities from outcomes, ends only after the details were asked; report extracts stated facts only (parity-tested `parse_facts`); project "Reference details" section (project ID, country, dates, team, technologies, deliverables, service lines, other consultants, links) auto-filled from the interview without overwriting typed values; Word-compatible reference record; confidential client prompt in the report.
- **P2 repository + quality:** `LibraryStore` Durable Object (SQLite, migration v2) with `library.js`: records, immutable revisions, audit trail, roles (ADMIN/REVIEWER emails; Entra app roles ATLAS.Admin/Reviewer, identity tid:oid), record people vs anonymised public view, automatic sync after interviews, automatic review agent (`review.js`: weighted completeness of the template + anonymised model review; blockers: missing core fields, unclear client value, unsupported claims, no agent answer), publication = ready + N+1 validated (or manager staff), in-app N+1 validation via deep link, withdraw/reinstate, Library view.
- **P3 reuse:** meeting recommendations (understand context → semantic retrieval with bge-m3 embeddings, lexical fallback → model rerank with why/transferable/caveat; published or own only; anonymised), duplicates (same project ID or similarity ≥ 0.9, strongest first) and reviewer merge preserving consultants and contributions, client-context slides (fact/interpretation, invented numbers removed, client name only by code for allowed readers) written to .pptx by `src/pptx.js` (validated with python-pptx).
- **P4 operations + analytics:** interview invitations (PM webhook `POST /api/triggers` with bearer secret; reviewer scheduling; daily six-month cron), `.ics`, start-from-invitation, invitation closed after the interview syncs; analytics (country, service line, practice, industry, technology, consultant, confidential clients for reviewers, practice x country coverage and gaps, strongest, needs enrichment, activity without reference), commercial insights (reviewers, interpretation, cited ids), Spotlight export/import (`atlas.reference.v1`).
- **Local demo / test harness:** `deploy/cloudflare-edge/dev/local-edge.mjs` runs the real Worker and library offline with a switchable test user and a deterministic stand-in model (`dev/fake-model.mjs`). Never deployed.
- Also fixed: four nav tabs overflowed at 320px; library filters on phones.
- Tests: app 129/129 (+pptx), edge 81/81 (+library, reuse, routes, roles, trigger), Python 182 + 30 sandbox EPERM, browser: studio 66, sculpture 40, intelligence 26, depth 20, autosave 19, orb touch 8, library 14 (new), reuse 19 (new).
- **Deploy needs:** Tony's `deploy.sh` (adds the LibraryStore migration and the daily cron). Optional: `REVIEWER_EMAILS` in wrangler.jsonc, `npx wrangler secret put TRIGGER_SECRET` + an Access bypass for `/api/triggers`, `TYPESAFE_API_KEY` for JEV practice areas.
- **Not verified live:** model answers for review/recommend/slides/insights on real data, the Library DO in production, Entra, Teams/Graph notifications, real PM/Spotlight connections.

### Session: 2026-09-27 (cont.) / private memory with Hindsight + JEV
- Tony: "perfect memory based on the user" with hindsight.vectorize.io, "and the JEV one too".
- Hindsight API verified from live docs and the official client source (`@vectorize-io/hindsight-client` 0.10.1).
- Edge: `src/memory.js` (bank id per verified subject, Hindsight client, project document with client scrub, retain items, recall query, memory note, JEV Noul relevance filter), `src/memory-routes.js` (list, remember, forget one/all, off switch, admin connection test for Hindsight and JEV) served by each person's Interview DO; the Session recalls before the opening (3.5 s cap, never blocks) and passes a PRIVATE MEMORY note on every talker turn; TALKER_POLICY + OPENING use it without reciting it or treating it as evidence.
- Browser: remembers every interview after the automatic save; profile "What ATLAS remembers" (list, forget, forget everything, switch off, admin connection test); consent mentions private memory.
- Keys: `deploy/cloudflare-edge/set-keys.sh` (hidden dialogs → Worker secrets; nothing printed or stored).
- Tests: edge 88/88 (+7 memory: bank derivation, scrub, endpoints/auth/body shapes, JEV filter, routes, session injection and failure), app 129/129, `tests/memory_browser.py` 9/9 against a stand-in Hindsight with the same HTTP API.
- Not verified live: needs the keys + deploy, then the admin connection test and a second interview on the same project ("last time you mentioned…"). The Python/Kyutai route keeps its older preferences-only memory.

### Session: 2026-09-27 (cont.) / languages (FR, EN, ES, PT and more)
- Verified from provider docs: Nova-3 on Workers AI understands en, es, fr, de, hi, ru, pt, ja, it, nl with `multi`; Workers AI voices exist only for English (aura-2-en) and Spanish (aura-2-es); MeloTTS returns MP3 (not used); ElevenLabs Flash v2.5 (`eleven_flash_v2_5`) speaks 32 languages as `pcm_24000`.
- Edge: `src/languages.js` (language table, detection from Nova-3 results, language note); transcribe returns `{text, language}` with `language: multi`; `synthesize(text, voice, lang)` routes en → Aura-2 EN, es → Aura-2 ES, others → ElevenLabs when keyed; the Session starts in the browser's language and follows clear switches (event `language`, metric `language_switch`), one voice per reply; talker gets a LANGUAGE note; without a voice for the language it answers in English and says so once.
- Fixed for every script (Python and JS in parity): echo filter tokenised only a-z (accents split, Japanese/Russian/Hindi never matched); sentence splitter ignored 。！？ and ।.
- Policy: "always speak English" replaced by "follow the LANGUAGE note"; report stays English with faithful translation.
- Python route accepts the `language` start field (ignored there; the Python route stays English).
- Tests: edge 94/94 (+ language routing, ElevenLabs request shape, session start/switch/fallback, cross-script echo/sentence parity), app 129/129, Python 182 + 30 sandbox EPERM, all browser suites green.
- Keys: `set-keys.sh` now also asks for `ELEVENLABS_API_KEY`. Needs deploy; not verified live with real French/Portuguese speech yet.

### Session: 2026-09-27 (cont.) / Git + cloud workflow
- Private GitHub repository via `Publish to GitHub.command` (GitHub sign-in if needed, then `scripts/git_publish.sh`, which refuses staged secrets or private files). Dry run: 257 files, 8.0 MB, no key patterns, no excluded paths staged.
- `.github/workflows/ci.yml`: every push/PR runs build, generated-policy freshness, app, edge, full Python (including socket tests) and all nine browser suites.
- `.github/workflows/deploy.yml`: manual only (type DEPLOY, main branch, `production` environment), runs `deploy.sh`; needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.
- `docs/CLOUD_WORKFLOW.md`; README section; `.gitignore` adds `.wrangler/`, `node_modules/`; removed a real client example name from the requirements trace.
- Not yet run: the first push and the first CI run (needs Tony's GitHub sign-in).

### Session: 2026-09-28 / reference sheet in Tony's Amaris/Mantu template
- Tony: ATLAS challenges the user for the best output, and the output follows his reference-sheet template exactly.
- Wizard (4 steps, `src/app.js` + `src/shell.html`): Opp ID first (or "pending"), sources (upload PDF/Word/Excel/ODT/CSV/HTML via Workers AI `toMarkdown`; .pptx text and embedded images read in the browser by `src/office.js`; or manual), grouped gap questions ("challenges", at most 3 groups x 4), validation (visuals, country of business or solution entity HEMA/SOLLAN/ACT/CRO, confirmation), generate.
- Edge `src/sheet.js`: `SHEET_POLICY` (never invent, "To be completed", English only, no consultant names in the summary, no client name in the text, no consultant counts in Tools), `/api/sheet/ingest|draft|visuals`; client details scrubbed before any model.
- `src/docx.js`: title Heading 1, Executive Summary (5 bold-labelled paragraphs), one 8 x 2 table with a 3 cm label column, optional visuals with captions, Calibri on every run, A4. File name `[Opp ID] - [country | entity (+country)] - [client] - [title].docx` (`sheetFileName` in `src/engine.js`).
- Engine: `cleanSheet`, `sheetIssues`, `scrubPart1`, `sheetFromProject`, `mergeSheet` (fills only empty / "To be completed" fields). Library Word button produces the template .docx; the review agent never sees contacts, price or the file name.
- Tests: `tests/office.test.js`, engine sheet tests, edge `test/sheet.test.js`, `tests/sheet_browser.py` 17/17 (docx opened with python-docx: fonts, table geometry, labels, captions).

### Session: 2026-09-28 (cont.) / opening, challenge, human tone, low latency
- Tony: ATLAS explains why she is there at the start ("Hi, I'm ATLAS, I'm here to interview you to understand your project and how we can leverage it to win more opportunities like this"), challenges consultants, sounds human ("hmm", "yeah", "oh wow, that's amazing"), and has very low latency with caching.
- Opening: fixed greeting per language (`GREETINGS`, `WELCOME_BACK` in `deploy/cloudflare-edge/src/languages.js`) played from cached audio before the model answers; noise cannot cut it (protected until the browser confirms playback, capped at greeting length + 3 s); `OPENING` now asks for the Opp ID first when missing, then one broad invitation, and never repeats the greeting (the Python route, which has no cached greeting, introduces itself in one sentence).
- Talker policy (`atlas_voice/cascade.py`, generated into the edge): varied natural reactions and enthusiasm, then still "how do you know?"; new CHALLENGE section (personal role vs team, what changed vs what was done, what proves it, one concrete example; once or twice per point, then move on). Admin mode: no introduction, no reactions.
- Latency (edge `src/session.js`, `src/app.js`): cached greeting; short acknowledgement fillers ("Mm-hm.", "Yeah."…) from a warmed audio cache while the model starts (never in admin mode or after time-up, never twice in a row; the model is told they were already said); semantic end of turn with `@cf/pipecat-ai/smart-turn-v2` at a 0.45 s pause, raced against 350 ms, then one transcription (a speculative transcription at every pause was tried and removed: long answers pause often, so it billed the same audio several times to save one short round trip); first-clause flush to the voice; module-level PCM LRU cache (12 MB); prompt-cache-friendly message order (policy + project, then append-only history, then per-turn notes; `HISTORY` 16 → 40) and `x-session-affinity` on talker calls; talker temperature 0.7.
- Commands / results: `build_edge.py` + all four parity generators; edge `node --test test/*.test.js` 101/101; app `node --test tests/*.test.js` 134/134; Python `pytest tests/test_*.py` 212/212 (run with local socket binding allowed); `build.py` (aliases identical); browser studio 66, sculpture 40, intelligence 26, depth 20, autosave 19, orb touch 8, library 14, reuse 19, memory 9, sheet 17 = 238/238.
- Not measured live: actual latency gains, prompt-cache hit rate and smart-turn accuracy on real speech need the deploy and a real call. Not deployed; not committed (last commit e69d3ec).

### Session: 2026-09-28 (cont.) / patient turn-taking ("she answers too quick")
- Tony, after a call: "she answers too quick and it feels awkward". Cause in code: the turn model was asked at a 0.45 s pause and a p 0.6 "complete" ended the turn, a fixed 1.1 s silence ended it even when the model heard an unfinished thought, a reply could start over a consultant who had resumed, and the continuation was then answered as a separate fragment; "Mm-hm" (a continuer meaning "keep going") played just as ATLAS took the floor.
- Process: design panel (3 independent designs: human-conversation research, robust end-of-turn, minimal change; judge synthesis with 4 verified defects) and an adversarial review workflow on the result.
- Edge `src/session.js`: EARLY_PAUSE 0.7 s, TURN_PROBABILITY 0.85, END_SILENCE 1.2 s applied by the session, THINKING_PAUSE 2.5 s when the model says unfinished (EnergyTurns built with it; shared speech.js/speech.py defaults and parity vectors unchanged); audio never starts while the consultant speaks or is being transcribed; continuation within 1.2 s of her real reply (acknowledgement excluded) withdraws the reply (`agent_retract`, not stored) and merges the answer; a noise only delays; a failed transcription counts as no words; a thought left hanging waits 2.5 s from the last sound and gets the STILL_THINKING nudge instruction; acknowledgements only after 12+ words, not after a question; numbers-only metrics `reply_gap`, `turn_check`, `turn_resumed`, `reply_withdrawn`, `turn_merged`, `still_thinking`.
- `src/languages.js`: FILLERS are uptake words ("Right.", "I see.") not continuers; `unfinished(text, lang)` per-language, precision-first lists (never a question or a capitalised last word). Browser `src/voice-client.js` handles `agent_retract`.
- Docs: `deploy/cloudflare-edge/README.md` "Turn-taking"; `docs/EVALUATION_v12.md` adds "Resumes after a pause".
- Tests: edge 118/118 (x4 runs; new: continuation merge, trailing hold from last sound, speaking during transcription, noise keeps the reply, filler rules, verdict unfinished/unsure, pronoun/name/question endings, failed-STT fall-through for continuation and barge-in, filler excluded from the window, reply_gap without text, detector scope), language table 17 true / 23 false, autosave browser 20/20 (retract removes the text on screen); app 134/134, Python 212/212, all browser suites green.
- Adversarial review (3 lenses, each verified) confirmed and fixed: a fully composed reply withdrawn from the screen stayed in history (a cough then left ATLAS silent; words were not merged); a held reply cut by a new turn was recorded after it and missing from the next prompt; reply text reached the screen before its audio; admin mode skipped the wait on trailing words; "...intake. And" was not seen as unfinished; the no-words branches ignored a consultant already speaking again; no transcription timeout; clicks held her reply for ~1.6 s; the continuation window was ~0.45 s of heard reply rather than 1.2 s; Spanish "este"; a metric reported an unrelated reply; timing tests too loose. Edge now 125/125 (x3), app 134/134, Python 212/212, browser 239/239.
- Second adversarial round confirmed and fixed: a withdrawn/interrupted reply still winding down counted as busy (a cough left a turn unanswered or skipped the re-ask); ATLAS's own withdrawn words coming back through the speakers were merged as the consultant's (echo reference now includes the live and last withdrawn reply); greeting protection outlived a cut greeting; End mid-reply recorded sentences never voiced; text still ran ahead of audio (now emitted by pace() with the chunk that carries it); the first ~70 ms of real speech did not hold her reply; a click during transcription delayed the answer; "Dr. A" read as a new sentence. Edge 132/132 (x3), app 134/134, Python 212/212, browser 239/239.
- Third round confirmed and fixed: a withdrawn reply stayed in the echo reference for the rest of the call (a later real answer using its words was dropped as echo; it now counts only for the next transcript, within 10 s, and only what was sent); a click during transcription let a reply start inside a still-open sound, so speech resuming in it was talked over (clicks now close after 0.15 s of quiet and the gate holds while any sound is open); the first chunk's text included the next sentence's first token. Every new regression test was checked to fail on the pre-fix code. Edge 135/135 (x3), app 134/134, Python 212/212, browser 239/239.
- Fourth round confirmed and fixed: closing a click after 0.15 s cut comma pauses ("So, … one more thing" lost its first word and let a held reply start into the pause) and dropped "No, no."; now 0.45 s, and the closed sound is joined to speech within 1 s or transcribed when idle. The echo filter had no timing: an answer mirroring her question ("I owned the budget") was dropped as echo, leaving silence; echo now requires speech that starts while she is audible or within 0.5 s, matched only against the reply that was playing. Edge 141/141 (x3; every new test fails on the pre-fix code), app 134/134, Python 212/212, browser 239/239.
- Fifth round confirmed and fixed: a breath just after her question carried "possible echo" onto the real answer joined to it (answer dropped, silence); echo timing by server wall-clock could be fooled by uplink bursts or playback lag (now measured on the ordered microphone stream against the browser's playback reports); an expired click was transcribed while the answer was, holding her reply; a short sound could be dropped at the join boundary (now judged by speech onset, and never dropped unless it may be echo). Two findings were rejected by the verifier as accepted trade-offs (a quick mirrored answer inside the old window; a reply released into a pause after a one-word opener). Edge 146/146 (x3; each new test fails on the pre-fix code), app 134/134, Python 212/212, browser 239/239.
- Sixth round confirmed and fixed: after a barge-in the browser never reports the cut reply as finished, so every later utterance counted as possible echo (stopping her now marks playback ended within the unplayed lead); speech starting between two of her sentences was taken for echo of the second (playback restart position recorded); a short sound expired in the last 60 ms before it would have joined (expiry judged by speech onset). One finding rejected as an accepted trade-off. Final: edge 148/148 (x3; each new test fails on the pre-fix code), app 134/134, Python 212/212 (incl. edge policy freshness), browser 239/239. Review loop stopped after round six: findings had narrowed to timing corner cases in the newest code; the live metrics are the next evidence.
- Deployed by Tony 2026-09-28: Worker version bd28a7db-fdc7-4452-9fb9-796fb1e53f95 (deploy.sh ran the edge suite first). Includes the reference sheet, cost/latency work and this turn-taking change. Not yet pushed to GitHub (last commit e69d3ec).
- Not measured live: real smart-turn accuracy on ATLAS audio, and the actual reply gap. After deploy, read `reply_gap` and `turn_check` in Workers Logs; if more than ~15% of turns take the thinking path, lower THINKING_PAUSE to 2.0.

### Session: 2026-09-28 (cont.) / 15-minute interview
- Tony: "Session limit should be 15 minutes max so make sure Atlas ask the best questions, challenges and tries to make it in that time."
- Policy (`atlas_voice/cascade.py`, generated to the edge): INTERVIEW_LIMIT_S 900 (whole call), WRAP_S 75, SPEAKING_LIMIT_S 600 kept as a second cap; TIME plan in ORDER OF THE INTERVIEW (open 1 min, breadth 6-7, depth/challenge 4-5, close 1-2; every question must earn its place); reference details skippable when time is short (the sheet wizard asks later); ENDING turn A also when the pace note says time is nearly up; admin still closes when the server says time is up; TIME_UP wording.
- Pacing (`pace_notes` / `paceNotes`, parity vectors regenerated): elapsed interview time; breadth before 45%, then "challenge the one or two claims that matter most" with the still-uncovered areas, then under 3.5 minutes "only the single most important remaining question, then ENDING".
- Edge session: MAX_SECONDS = 900; the next reply is the closing once 75 s remain (or her speaking cap is used); in the last 30 s with nobody talking she closes on her own; at 15:00 a clean end (notes and report). Python route: same rules. Consent text: "fifteen minutes at most".
- Tests: edge 151/151 (+ pacing phases, 75 s closing, proactive close and clean end at the limit), app 134/134, Python 212/212.

### Session: 2026-09-28 (cont.) / Restart the conversation
- Tony: "make it so the user can restart the chat too if needed."
- Mapped with a workflow (client state machine, server session lifecycle) and designed from it. No server change: {type:'discard'} already ends a session with no notes, report, autosave or memory.
- Browser: "Restart conversation" (#voiceRestart, between Mute and End) shown while connecting or live, and after an error when the consent given on this page can be reused; hidden in idle (Start does it), preparing and ending (after End, "nothing saved" can no longer be promised). Live/connecting: a confirmation dialog (#voiceRestartDialog, "Keep talking" focused, Esc keeps talking) says plainly that nothing from the conversation is saved and restates the choices reused; confirm discards (never "end"), waits up to 3 s for the old socket to close, then starts a new session with the same consent only if the workspace, project, terms and voice are unchanged, otherwise the normal consent dialog. The dialog closes itself if ATLAS wraps up meanwhile. After an error: restarts at once. The last-heard quote is cleared on a new session.
- Tests: studio browser +11 (offered while live, confirmation text, keep talking changes nothing, keyboard path, double confirm starts exactly one session, consent reused without a dialog, old microphone released, nothing saved, 320 px fit, wrap_up race, error path), autosave browser +3 (server sees start, discard, start; no project, library or memory calls; discarded words gone from the screen), edge +2 (discard: no notes/report and nothing heard afterwards; End then discard: one set of notes). Edge 153/153, app 134/134, Python 212/212, browser 253/253.

- Adversarial review of Restart + 15-minute limit (3 lenses, verified): fixed the consultant's words in progress at 15:00 being dropped (now transcribed and recorded, not answered; "time_up" message shown); ENDING turn A now requires the challenge phase (or time nearly up, or they must leave); the closing prompt carries no analyst guidance and its pace note says "close now, with no question"; the Python route checks the consultant is not speaking before closing on its own and before wrap_up; the Python route reads a discard while connecting (memory recall, STT open) and frees the slot at once; the Python interview limit is capped at 900 s; Restart clears the discarded conversation on every path, keeps keyboard focus on a control and announces the restart; the confirmation describes the reused choices accurately per server; a busy bootstrap right after a slow teardown is retried briefly. Three findings rejected by the verifiers. Each new test fails on the pre-fix code. Edge 155/155, app 134/134, Python 213/213, browser 254/254.

- Deployed by Tony 2026-09-28: Worker version 846c0cd6-7e38-48c5-a92f-6fb51424ee06 (Restart + 15-minute interviews + review fixes). Not yet pushed to GitHub (last push d0c94f6).

- "Project at a glance" dashboard in the DRAFT / UNVERIFIED story report (`src/charts.js`, `src/charts.css`, `src/geo.js`, `assets/geo/world-110m.json`, `scripts/build_world_map.py`): delivery map (Natural Earth 1:110m, projected at build time, countries resolved from what the consultant said; unplaceable places such as "Remote" are listed, never guessed), timeline, team, scope, quality gauge, evidence and outcome cards, portfolio map in Insights. Plain JS/SVG in the bklit visual language (MIT, attributed in `docs/THIRD_PARTY.md`). Interview-sourced values are hatched and labelled "from interview · unverified"; gaps say "To be completed", never an invented number. Exports carry static SVG only (no script, no handlers, CSP kept); Markdown gets an "At a glance" summary.
- Adversarial review of the dashboard: 14 confirmed findings fixed. Country resolver: place-type names (Benin City, Niger Delta, South China Sea, North Cyprus…) stay unresolved, city-states allow-listed, US context applies to every hit, "Georgia" ambiguous without Caucasus context, export crop keeps 4:3. Charts: provenance on sheet squares and on the sector (`sectorFrom`, set by the interview fill and cleared when the consultant retypes the sector), accessible names/groups, click-to-pin with pointer capture only on drag, keyboard pan, tooltip clamped on screen, stale pins cleared, container-width layout rules. New `tests/report_browser.py` (19 checks, in `make test-ui` and CI); the sector-retype check fails on the pre-fix code.
- Working copy moved out of OneDrive to `~/AI-Brain-build/atlas-project-intelligence` (clone of GitHub). OneDrive had evicted the files ("dataless") and its File Provider stopped serving reads ("Operation timed out"). 17 source files unreadable on disk were rebuilt by replaying the session's recorded edits on d0c94f6: all match the byte sizes OneDrive reports, 4 match independent copies by md5 and 6 intermediate checkpoints match by md5.
- Deploy from GitHub: Workers Builds on branch `live` (setup in `deploy/cloudflare-edge/README.md`). `main` stays the working branch; `git push origin main:live` releases. Not yet connected; deploys stay manual via `deploy.sh`.
- Tests (2026-09-28): app `node --test tests/*.test.js` 325 (324 pass, 1 skipped: Natural Earth regeneration needs `ATLAS_NE_SRC`); edge 155/155; Python 213/213; browser 11 suites 273/273 (studio 78, sculpture 40, intelligence 26, depth 20, autosave 23, orb touch 8, library 14, reuse 19, memory 9, sheet 17, report 19). GitHub Actions still blocked by the account's Actions budget, so CI has not run on GitHub.

- Deployed by Tony 2026-09-29 from the clone with `deploy.sh` (edge tests passed first): Worker version c77b4d63-fc7d-4fb0-a553-362af24d1def = commit 331c99c (dashboard + map, Restart, 15-minute interviews, review fixes). Before the deploy the dashboard browser suite was rerun under the Worker's exact Content-Security-Policy: no violations, no page errors.

### Session: 2026-09-29 / WOW features F1-F7 (five tracks + integration, `docs/WOW_SPEC.md` revision 2)
Merged from `handoff/status/T1.md` … `T5.md` (each keeps the full per-track detail, decisions and mutation checks). Built on `00fbd39` in the clone; not committed by the tracks, not deployed, no paid provider or Microsoft endpoint called, no real data used.

**Implemented**
- T1 edge platform and proof engine: `util.js` (single helper copy), `scrub.js` (pseudonymisation, record masking, display rule), `snippets.js`, `features.js` registry (READY gate, Entra rule, external role), the `library-routes.js` / `app.js` / `worker.js` hooks, the existing-leak fixes (review, index, recommend, insights, slides now send only `recordView` / pseudonymised text; `parseRerankStrict`), F1 `bids.js` + `customer-jev.js` (JEV port with Python parity vectors), F6 `ask.js` + `/api/transcribe` (off), F7 `winloop.js` + `fetchWinHint`.
- T2 focused gap interview: `atlas_voice/gaps.py` (policy first), `cascade.py` (`TIME_UP_MESSAGE`, `TIME_PLAN`, talker gap list, `run()` refuses gap), `build_edge.py --policy-only`, `gap-policy.js` (parity vectors), `session.js` gap mode (300 s, no memory recall, no report, answer windows, never-awaited win hint), `gaps.js` backend, `voice-client.js` gap start key and the `atlas-session` event bus.
- T3 trust and capture: `claims.js` (sentence-level confirmations, staffing N+1 first, independence, `sentence` and `revision` currency), the self-contained `/confirm` page, `outreach.js` (approval queue, staffing CSV import, trigger fields, daily sweep), Teams bot endpoint and launcher tab (built, not connected), `teams/` package builder, TeamsJS 2.57.0 vendored with pinned SHA-256.
- T4 workspace UI: `build.py` slots and `window.ATLAS_POLICY`, Bids view (brief, alias, masked preview, verdicts, one-pager with footnotes, `.docx`/`.md`/print), Ask ATLAS with the map, claims block and badges, proof requests, outreach queue and staffing import, `startFromGap` / `applyGapNotes`, `engine.js` persistence of `library`, `invitationId`, `quality`, `gapNotes` (dropped on backup import).
- T5 live interview UI: `storyboard-core.js` / `storyboard-ui.js` (twelve dimensions, figures as exact quote slices, cued country pins, countdown and phase, gap checklist) and the proof-answers card with the two explicit buttons (send to the bid team, add to my reference).
- READY: `bids`, `ask`, `wins`, `gaps`, `claims`, `outreach` are all true; every acceptance suite below passes, so none was turned back off. `/api/bootstrap` `features` shows `spokenAsk`, `customerJev`, `pdfBriefs`, `clientConfirm` false and `teams`, `phone` `BLOCKED_EXTERNAL` until their vars are set.

**Integration step (WOW_SPEC §6.6)**
- `python3 build.py` → "Built 815098 bytes; original logo SHA256: 92c5ff21…ba9b6c2b"; the four aliases are identical. Full `uv run --with aiohttp --with msgpack python3 deploy/cloudflare-edge/build_edge.py` → "edge constants + page generated"; `src/policy.generated.js` is byte-identical to T2's file (`cmp`), and `src/atlas.html` equals `ATLAS_Voice.html`.
- Integration defects found by `tests/wow_edge_browser.py` (its first end-to-end run) and fixed in that test only; no module changed:
  - the claims `<details>` is open by default when a reference has no claim yet, so the test's click on its summary closed it: the test now opens it only when closed;
  - the outreach approval ran after the proof and confirmation requests were answered, and the backend (correctly) dismisses approval of a row whose request is no longer open: the test now checks that dismissal, then queues an open interview invitation through the Insights staffing import (UI, with an extra `client_name` column that must be ignored) and approves that invitation's email and Teams rows;
  - the Ask question did not clear the 0.35 semantic floor under the local lexical fake embedding: the question now shares words with the reference (as T1 noted), the check is unchanged.
- `deploy/cloudflare-edge/wrangler.jsonc`: comment naming the optional `TEAMS_SERVICE_HOSTS` var (T3 request). `docs/INTEGRATIONS.md` and `deploy/cloudflare-edge/README.md` updated (external role, trigger fields, staffing and outreach, Teams, `/confirm`, Spoken Ask, the new library routes, the stale scope line).
- A scratch browser check (not committed) drove the real page with the repo's WebSocket test adapter: `startFromGap` → consent names the proof request → the start frame carries the gap id → the gap is consumed on `ready` → the story board shows the countdown and the gap checklist → `quality.gap_status` updates it → gap `notes` show the exact quote on the proof card, `p.gapNotes` is set for that request, `p.answers` unchanged, no page errors: 12 PASS, 0 FAIL. It is the only run that joins T4's bridge, T2's voice client and T5's board; the suites test each side with synthetic events.

**Locally verified (integration run, 2026-09-29, macOS, Node 22, Chromium headless shell; sandbox off for loopback ports and Chromium)**
- `node --test tests/*.test.js`: 356 tests, 355 pass, 1 skipped (Natural Earth regeneration needs `ATLAS_NE_SRC`), 0 fail.
- `cd deploy/cloudflare-edge && node --test test/*.test.js`: 360 tests, 360 pass, 0 fail.
- `python -m pytest tests/test_*.py -q` (uv, requirements + msgpack, pyjwt, cryptography): 240 passed. It includes `test_parity_vectors_are_current` for all five generators (parity, speech, pace, gap, JEV); every vector file was byte-identical before and after (checked with `cmp` against a copy).
- Browser suites of `make test-ui` (each exit 0, 0 FAIL, no page errors): studio 78, sculpture 40, intelligence 26, depth 20, autosave 33, orb_touch 8, report 19, storyboard 51, library 14, reuse 19, memory 9, sheet 17, bids 66, ask 28, trust 43, confirm 27, **wow_edge 32** (end to end on the local edge: reference published and validated, bid with alias, honest verdict, one-pager with footnotes and `.md` export, gap request to a colleague who sees his own words while the owner sees the answer unverified and masked, claims confirmed on `/confirm` with the record and footnote badges flipping, outreach email drafted and Teams `BLOCKED_EXTERNAL`, Ask with the map lit and no `@` for a public reader, the reviewer's win rate with its interval at n=5 and no story table for a plain user, no overflow at 320 px).
- Existing tests unchanged: `git diff --numstat` shows 0 removed lines in `session.test.js` (75 existing tests), `app.test.js`, `library.test.js`, `reuse.test.js`, `engine.test.js`, `autosave_browser.py`, `test_cascade.py`; `tests/test_edge.py` was refactored into a parametrised loop with the same checks.

**Provider verified:** none. Every WOW model call (bid requirements, rank and one-pager on `ANALYST_MODEL`, embeddings, Ask) ran only against `dev/fake-model.mjs` and `dev/fakes/*`. No TypeSafe, Teams, Graph or telephony call was made.

**Blocked (BLOCKED_EXTERNAL, WOW_SPEC §5)**
- Pilot users: the Access policy admits only Tony, so F2 assignees and F3 N+1s cannot sign in yet; extend the Access policy (emails or an Entra group), set `REVIEWER_EMAILS`, and admit the Mantu group email domains Mantu IT lists.
- Client-contact confirmation: Access One-time PIN policy for the named client emails, the same emails in `EXTERNAL_EMAILS`, `CLIENT_CONFIRM=1`, and the Q3 decision.
- Staffing webhook: the staffing tool owner calls `/api/triggers` with `TRIGGER_SECRET` (existing) through the existing Access bypass, with the new optional fields.
- Teams bot, card and launcher tab: the nine items in `deploy/cloudflare-edge/teams/README.md` (tenant ID, app registration, `TEAMS_BOT_SECRET`, Azure Bot F0, Teams admin approval, Access bypass for exactly `/api/teams/messages` and `/teams/tab`, `TEAMS_ENABLED=1` + `TEAMS_APP_ID` + `TEAMS_BOT_APP_ID` + `TEAMS_TENANT_ID`, brand icons, device check).
- In-tab Teams interview (Q9), phone interviews (Twilio or Teams Phone with ACS; ACS closes to new customers on 2026-10-23), JEV ranking (`TYPESAFE_API_KEY`, per-request consent), Entra mode for F2/F3 (identity-mapping design, Q6).
- Any deploy: Tony only, when nobody is interviewing; no new Durable Object class or migration is needed.

**Tony's pending decisions (WOW_SPEC §5 and §7)**
- **Q12 (decide before deploying this build):** claim currency. Code default `CURRENCY = 'sentence'` (a confirmation stays current while the exact sentence is unchanged); strict `'revision'` is implemented and tested. `claims.READY` is true, so a deploy turns confirmations on for everyone Access admits.
- Q11 Spoken Ask (off, `SPOKEN_ASK` unset); Q13 per-story win rates for reviewers (HR/legal); Q10 residual membership inference; Q3 client contacts; Q1 PDF briefs (off); Q2 calibration of `SIM_FLOOR`, `STRONG`, `MIN_N` and the boosts (labelled uncalibrated); Q5 bot issuer set; Q8 naive sentence split; Q9 in-tab Teams interview.
- T3: whether to widen the Teams tab CSP with `connect-src https://res.cdn.office.net` (TeamsJS falls back to its bundled domain list without it).

**Deviations from the spec text, for review (reasons in the track files)**
- T1: identical spans share a placeholder only when exactly equal (not case-insensitively), and the bid author view only un-masks (model output is record-masked before it is stored): both avoid a library-membership oracle (ground rule 5).
- T2: a gap ask's attempt is counted at the first audio chunk of the reply that carries it (not at `audio_turn`, which fires on the greeting before the reply exists), and the gap plan is recomputed as soon as a turn ends. Worth a note in §F2.4.
- T3: staffing invitations only for end dates from 30 days ago to 7 days ahead; one submit decides every point of a request; approving a row whose request is closed dismisses it; `daily` returns only non-zero counts.
- T5: uncued city names are neither pinned nor listed; "3 percentage points" gives no chip; the ledger flag reads "No measurement recorded".

**Gates still open**
- Live checks of every new prompt on Workers AI (requirements, rank, one-pager, Ask) with synthetic briefs, and a live gap interview through the real voice path.
- The per-ask gap results live only in the story board's memory: after a reload or a new conversation, "Send these answers to the bid team" is gone while "Add these answers to my reference" (`p.gapNotes`) survives. Spec silent; decide whether to persist them.
- `teams-routes.js` imports `../teams/vendor/teams-js.mjs` (outside `src/`): wrangler bundling of it has not been run. The Teams manifest v1.30 schema is not vendored; the real-token service-URL claim name, `MessageWritesBlocked` and `app.openLink` per client are unverified.
- CI has not run this work (GitHub Actions budget, see 2026-09-28). The `ci.yml` browser loop now includes `bids ask trust storyboard confirm wow_edge`.
- The optional `.pptx` one-pager export (F1.8, not an acceptance item) is not built. Pre-existing defects listed in Q7 are unchanged.
- Working tree: `tests/intelligence_browser.py` rewrites the tracked `preview/v11/{desktop,mobile,speaking-preview}.png`; exclude them from the commit unless the new screenshots are wanted.

**Next task:** Tony decides Q12 (and Q11/Q13 if those features will be used), extends the Access policy to the pilot users, then deploys manually when nobody is interviewing. After the deploy: live checks of the new prompts with synthetic data, then a first real gap interview.

### Session: 2026-09-29 / Track Z: zero-setup start and profile prefill (`docs/WOW_ZERO_CONFIG.md` revision 2)
Merged from `handoff/status/Z.md`, which keeps the full per-step detail, decisions and mutation checks. Built on the uncommitted WOW tree (HEAD `71efb5b`) in steps Z-S0 (edge), Z-S1 (browser) and Z-S2 (hooks, docs), then independently verified. Not committed, not deployed, no wrangler, no paid provider, no network from tests, no real HR data. Tony's words: "it should just work and ask for consent and thats it"; the profile should be "prefilled with the users information from our DNA (ERP) Name, email, title, ect — can be modified if needed too".

**Implemented**
- Z-S0 edge:
  - `profile.js` (new): tables `profiles`, `directory` and `directory_imports`. Merge per field in the order you > dna > dna_export > signin > guess, with provenance and "DNA now says…" (`newer`). Email guess; first name for display only. People lookup reads stored rows only: 30 per hour, name and title only, never the N+1.
  - Directory import and push: staged, test mode accepts synthetic addresses only, shrink guard 409, audit counts only.
  - DNA pull connector: shape ASSUMED, `BLOCKED_EXTERNAL` until `DATA_MODE=production` and Mantu IT configuration. Daily purges.
  - Worker (`app.js`):
    - sign-in name claims come only from the verified token, and `x-atlas-idp` is always overwritten;
    - `/go/{start,gap,invitation,bid,library,confirm}` redirects (`/go/confirm` also for externals), plus `/go/signed-in`;
    - navigations to unknown pages go to `/`;
    - `/api/directory/push` (bearer secret, production only);
    - the banner and readiness follow `DATA_MODE`;
    - `/api/transcribe` needs `X-Atlas-Consent`;
    - PDF conversion with `metadata: false`.
  - `GET /api/memory/settings`.
  - Model boundary: `forModel`, `projectContext` (Python first, then the JS port) and the merge text ("Contribution by another consultant:") no longer carry the consultant. Legacy prefixes are rewritten before any model sees them.
- Z-S1 browser:
  - `session-keeper.js` (`AtlasAuth`: `X-Requested-With`, `redirect:'manual'`, one bootstrap, the modes live/offline/network/expired, and re-sign-in through a popup and `BroadcastChannel('atlas-auth')` without reloading a page that holds work).
  - `profile-core.js` (`modelProject`, chips, CSV reader with approved columns only) and `profile-ui.js` (profile section, chips, guessed-name question, admin People directory).
  - `voice-client.js`:
    - the start control follows the mode; the offline copy shows one "Open ATLAS ↗" link to the baked `ATLAS_HOME/go/start`;
    - ONE consent tick, whose memory clause appears only when memory is configured and on, with a working switch;
    - the device-save prompt only when the library save failed or is off, or after a gap interview.
  - `app.js`:
    - every API call goes through `AtlasAuth`;
    - model-safe `voiceSnapshot` (no name or email reaches a model);
    - profile prefill: never a guess; title with `roleFrom`; N+1; `managerStaff` never set from the profile;
    - returning-user rebuild from the library;
    - storage strip, legacy email-consultant cleanup, `/go/library` link.
  - `build.py` bakes `ATLAS_HOME` from `wrangler.jsonc`, overridable with `ATLAS_HOME_URL`.
- Z-S2 hooks:
  - `claims.js` N+1 order: staffing, then the stored directory row ("N+1 from DNA"), then self-declared.
  - `gaps.js` fills a blank assignee name from stored rows.
  - `/go/` links in outreach, claims, gaps and the Teams card.
  - Teams simplification: no `TEAMS_ENABLED`; connected once the app id, tenant id and bot secret are set.
  - `enable_entra.sh` appends the name claims after the identity claims.
  - Docs updated: `handoff/CONFIGURATION.md`, the edge README, `docs/INTEGRATIONS.md`, `teams/README.md`.
  - `profile.READY = true`, flipped after the acceptance suites passed. `SPOKEN_ASK_APPROVED = false` (D1 is Tony's).

**Changes to the WOW session above (deliberate, WOW_ZERO_CONFIG §4)**
- The `SPOKEN_ASK` variable is removed. `features.spokenAsk = on('ask') && SPOKEN_ASK_APPROVED`, a code constant flipped only by Tony's D1, with a per-use consent prompt.
- The `PDF_BRIEFS` variable is removed. `pdfBriefs = on('bids')` (D2: PDF conversion is text extraction, not a model call; images stay refused). This turns Q1 into a recorded decision.
- `TEAMS_ENABLED` is removed from the Teams blocked list above. Teams needs `TEAMS_APP_ID`, `TEAMS_TENANT_ID` and `TEAMS_BOT_SECRET`, and `TEAMS_BOT_APP_ID` defaults to `TEAMS_APP_ID`.
- Links in drafts are `/go/…` paths (a recorded deviation from WOW §0 rule 7: random, non-secret ids in paths). Old fragment links still work.

**Independent verification (final tree, macOS, Node 22, Chromium headless shell 1228; sandbox off only for loopback ports and Chromium)**
- The product owner's path was walked with Playwright on the local edge, with a trusted-event counter in the page.
  - **A brand-new signed-in user opening `/` needs 3 clicks (Start, the one tick, Start conversation) and fills in 0 fields.** This held for the admin and for a non-admin. The consent dialog's only field is the tick, and there is no setup text anywhere.
  - Via `/go/start`: 2 clicks. From a saved HTML file: "Open ATLAS ↗", then the same 2 clicks.
  - Not counted: the Access sign-in and the browser's first microphone prompt.
  - The interview ran against a scripted WebSocket stand-in; the local edge has no voice route.
- Defects found and fixed:
  1. The "Is your name …? [Yes, that's me]" question after an interview was only in the hidden Conversation view, because the report opens by itself on Projects. So on today's deployment every auto-created project stayed "Consultant". It is now also in the auto-opened report (`src/app.js` `showReport`), and "Yes" thanks the user in every copy (`src/profile-ui.js`). `tests/zero_config_edge_browser.py` gained 4 checks for a brand-new user without DNA, including the exact 3-action count; they fail when the fix is removed.
  2. `tests/storyboard_browser.py` was flaky (CSP `EvalError`): its two bare-string `wait_for_function` predicates are now functions. The mechanism was proven on the built page.
  3. `docs/THIRD_PARTY.md:57` was stale on the Teams launcher and its variables.
- Results:
  - `python3 build.py`: exit 0, 868709 bytes, four identical aliases.
  - Full `build_edge.py`: exit 0. `src/atlas.html` equals `ATLAS_Voice.html`. `policy.generated.js` is byte-identical to HEAD, because the only Python change (`interview.py` `project_context`) is a function, not an exported constant.
  - `node --test tests/*.test.js`: 367 pass, 0 fail, 1 skipped (`ATLAS_NE_SRC`).
  - Edge `node --test test/*.test.js`: 397 pass, 0 fail.
  - `pytest tests/test_*.py`: 256 passed.
- Browser suites of `make test-ui`, each exit 0 with 0 FAIL: studio 79, sculpture 40, intelligence 26, depth 20, autosave 33, orb_touch 8, library 14, reuse 19, memory 9, sheet 17, report 19, bids 66, ask 31, trust 43, storyboard 51, confirm 27, wow_edge 32, zero_config 75, zero_config_edge 54.

**Provider verified:** none. DNA is `BLOCKED_EXTERNAL` by design, and its pull shape is ASSUMED.

**Blocked / external (WOW_ZERO_CONFIG §11)**
1. Who can sign in: an Access "Emails ending in" rule for the Mantu domains. It needs item 2 first, because the test deployment is on a personal account.
2. A production deployment approved for personal data: a Mantu-owned account or a production sign-off, Mantu IT approval, and DPO sign-off on the column list and on the memory consent sentence. Then `DATA_MODE=production`.
3. A DNA source: push (recommended, `DIRECTORY_PUSH_SECRET` plus an Access bypass), pull (URL template, header, key and field map from IT), or an export CSV.
4. Entra sign-in and the name claims (`enable_entra.sh`; `given_name` and `family_name` optional claims; the role gate assigned to a group that covers all consultants).
5. Tony's D1: spoken Ask with consent.

**Gates still open**
- UNVERIFIED on the real Access app (§13): whether an open WebSocket survives app-token expiry, and whether a path or fragment survives an interactive sign-in.
- The N+1 name from a typed N+1 email is not wired in the browser (the server route works).
- "Edit" in the guessed-name question leaves the just-created project as "Consultant" (later projects use the saved name): product decision.
- `scripts/check_handoff.py` still fails on the stale `MANIFEST.json`. `src/intelligence-ui.js` (Python-gateway actions) still uses plain `fetch` without `X-Requested-With`.
- Working tree: `preview/v11/*.png` are rewritten by `tests/intelligence_browser.py`. Exclude them from the commit unless the new screenshots are wanted.

**Next task:** review, then one integration commit (WOW plus Z, including the four HTML aliases), made by Tony or the orchestrator. Before live use: the §11 items above and D1, then a manual deploy when nobody is interviewing.

### Session: 2026-09-29 / WOW review fixes
Built on the uncommitted WOW + Z tree (HEAD `d748c7a`) in the clone `~/AI-Brain-build/atlas-project-intelligence`. The review of `71efb5b` confirmed 26 findings. Five fix groups (masking, bids, gaps, trust, frontend) worked on separate files, then one integration pass handled the cross-group items. For each finding, a regression test was run and shown failing on the unfixed code, then shown passing after the fix. Not committed, not deployed, no wrangler, no network or paid provider in tests, and no real data.

**Per finding** (file: fix; test)
1, 3. Evidence source name and version: `snippets.js` masks them like the text, for one-pager footnotes (every viewer) and non-full Ask readers. Integration: `ask.js` gives a full-access reader the raw name, from the server-only `rawSource`, like the raw sentence (§2.3). Tests: `snippets.test.js`, `masking-routes.test.js`.
2, 4. Map-cap membership oracle: `scrub.js` has no cap and no `[company]` fallback (indexed lookup, 5,001 placeholders in 81 ms). `bids.js` rebuilds the map from the entries still in use on each requirements edit, and limits edits to 60 per hour. Integration: `create` stores only the entries the alias, requirements and customer use (a 400-address brief stored 401 entries, now 2). Tests: `scrub.test.js`, `bids.test.js`, `masking-routes.test.js`.
5. NFD bypass: NFC normalisation in every matcher and scrub (`scrub.js`, `review.js`). NFKC is deliberately not used.
6. Self-assigned gap request: `gaps.js` answers 400 "Ask someone else for proof." when the assignee is the requester or the bid owner, and `interview()` answers 404 to the owner.
7. Quadratic email regex: `scrub.js` EMAIL_RE is bounded (bid GET went from about 1.9 s to 7 ms). Integration, same class: `util.email` refuses more than 254 characters before its regex (reviewer probe_email2 went from 34,830 ms to 0 ms for 250,000 characters). Tests: `scrub.test.js`, `masking-routes.test.js`.
8, 9. Gap answer windows: `session.js`. After reflect-and-confirm or the closing, a turn is not filed under the last ask. A still-thinking reply that asks the next item counts as asking it. Full-mode trace byte-identical before and after. Test: `session.test.js`.
10. Stale match: `bids.js` answers 409 "The requirements changed while the match ran. Run the match again." and stores nothing.
11. Win rates: `winloop.js` counts distinct decided bids, not uses.
12. Display rule: `scrub.js` `{ authorText }`. Integration wiring: bid create (the text sent to the model), Ask, `Library.recommend` and `Library.slides`. Other views and the one-pager still apply full masking. Test: `masking-routes.test.js` (p3 now "Orange juice…").
13. "Name (role)" contacts: `review.contactLead` in `scrub.js` and `review.js`. Integration: the Library.get public view (`library.js anonymise`) also masks a one-word lead under the contact rules ("Dupont, CFO"). A stoplist lead ("Will") is left alone.
14. Confirmation views: `claims.js` masks PII before the own-client scrub.
15. Gap ask cut: `gaps.js` cuts after rendering, in the caller's view.
16. Unbounded bodies: `teams-routes.js` answers 401 without a token before reading, then reads through a bounded reader. Integration: the `/api/library` forward (`app.js`) uses `boundedBytes` (a streamed 20 MB body had been read in full, now it stops at 256 KiB). Test: `teams.test.js`, `app.test.js`.
17. Bid delete: `bids.js` erases the customer and the match, closes open gap requests and nulls their maps. `getRequirement` answers 409.
18. Decided claims: `claims.js` stops a decided claim from being re-asked or overwritten while its sentence is current. The first decision wins, and other open requests go stale.
19. Gap quotes: `bids-ui.js` labels the quotes "unverified speech recognition" for every status.
20. Requirement ids: `bids.js` never reuses an id the bid had or a gap request names.
21. JEV: `bids.js` does not ask JEV when a customer field is blank and says which field. "JEV failed" is kept for real failures.
22. Gap answers after a reload: integration across `engine.js` (cleanGapNotes keeps the bounded per-ask results; imports still drop the notes), `voice-client.js`, `app.js` (`sendGapAnswers`, `gapAnswersSent`, `dropGapResults`; adding answers to the reference keeps unsent results), `trust-ui.js` ("Send these answers to the bid team" on the open request's Library card, explicit click plus confirm) and `storyboard-ui.js` (a send from the panel clears the stored results). Tests: `engine.test.js`, `trust_browser.py`, `storyboard_browser.py`.
23. Story-board pins: `storyboard-core.js` also searches each resolved country's own name.
24. Ask client filter: `ask.js` has no similarity floor on the filtered path, plus its own "none" note.
25. Email draft after reload: `outreach.js` reissues the draft of a drafted email row while its subject is open. Integration: `trust-ui.js` adds "Show the draft again". Tests: `outreach.test.js`, `trust_browser.py`.
26. One-pager claim kind: `bids.js` treats only an explicit "fact" as a fact. Anything else is "interpretation".
Not a finding: WOW_ZERO_CONFIG §5.8 is now wired (the N+1 name is filled from a typed N+1 email, with a source chip; `profile-ui.js`, `app.js`). This supersedes the Track Z gate "not wired in the browser".

**Tony must confirm before the commit: D1.** In this round the trust group set `SPOKEN_ASK_APPROVED = true` (`features.js`, `docs/WOW_ZERO_CONFIG.md`), citing "it should just work and ask for consent and that's it". Track Z recorded the same words and still left D1 pending. The approval reached this round through the fix-round task text, so Tony should confirm it. The consent header and the server-side stored-consent check are unchanged. Reverting is one line: `app.test.js` and `zero_config_edge_browser.py` now follow the constant, and only `features.test.js` pins its value. Docs updated to match: `deploy/cloudflare-edge/README.md`, `docs/INTEGRATIONS.md`, `handoff/CONFIGURATION.md`, `handoff/status/Z.md`. `docs/WOW_SPEC.md` §2.3 no longer says "Maps are bounded to 200 entries".

**Results (final tree; the build is the one the browser suites ran)**
- `python3 build.py`: 875,201 bytes. The 4 aliases and `deploy/cloudflare-edge/src/atlas.html` are identical (sha256 `0c6e76c4…bed4a6`). `build_edge.py` ran; `policy.generated.js` and `atlas_voice/` are unchanged.
- `node --test tests/*.test.js`: 370 tests, 369 pass, 0 fail, 1 skipped. Edge `node --test test/*.test.js`: 431 tests, 431 pass.
- `pytest tests/test_*.py` (sandbox off): 256 passed. `tests/test_edge.py::test_parity_vectors_are_current`: 5 passed (parity, speech, pace, gap, jev vectors current).
- `make test-ui` suites, each exit 0 with 0 FAIL: studio 79, sculpture 40, intelligence 26, depth 20, autosave 33, orb_touch 8, library 14, reuse 19, memory 9, sheet 17, report 19, bids 70, ask 31, trust 51, storyboard 51 (52 with the added panel check), confirm 27, wow_edge 32, zero_config 87, zero_config_edge 54. After the last edge edits: library 14, wow_edge 32 and zero_config_edge 54 were re-run, all green.
- Reviewer probes (`/tmp/claude-501/review-scratch`, re-pointed at the clone) show the fixed behaviour for every finding they cover. The notes for 12, 13, 16 and 22 above give the numbers.

**Still open (none blocks the commit)**
- D1 confirmation (above).
- Product calls: "couldn't say" counts as a decided claim (#18), and there is no create-time guard against a claim already in an open request.
- Ask banner, on the filtered path when the ranker returns nothing: it still says "Nothing in the library answers this yet." above the note "…judged none of them relevant". This is true, but the copy could be sharper.
- Suggested gap assignees can include the bid owner. The server then answers 400 "Ask someone else for proof.".
- Outreach queued for a purged bid's gap requests stays pending until an approver acts. Approving it dismisses it ("no longer open") and drafts nothing (probe).
- Library.get public view (pre-existing, human readers only): an email inside a source name is client-scrubbed but not PII-masked (`jane.doe@the client.example`, reviewer probe p1). Ask and the one-pager mask it.
- `/api/jev/classify` and `/api/triggers` still call `request.text()` after the Content-Length check. Both are authenticated. This is the same pattern as #16's second part.
- A removed requirement id that no gap names and that was the highest can come back in a later edit (no persistent high-water mark without an ALTER).
- Purge residue: WOW has never been deployed, so no production bid was purged under the old code, and there is nothing to clean.
- `preview/v11/*.png` are rewritten by `intelligence_browser.py`: exclude them from the commit. `MANIFEST.json` is still stale (pre-existing).

**Next task:** Tony confirms D1, then one integration commit (WOW + Z + these fixes, the four HTML aliases, and the new `deploy/cloudflare-edge/test/masking-routes.test.js`). Deploy manually when nobody is interviewing.

- Deployed by Tony 2026-09-29 with `deploy.sh` (edge tests passed first): Worker version aa3478f8-5cc0-4c06-9c5f-59b6361022dc = commit b67808b (WOW F1-F7, zero-setup start + profile prefill, 26 review fixes). Upload 1483.66 KiB (gzip 451.41 KiB), startup 2 ms. Provider verification (live Workers AI prompts, real voice gap interview) happens on first live use; Access still admits only Tony.

### Session: 2026-09-29 / Voice quality
Tony, after a live session on aa3478f8: "Atlas doesnt speak well and is not totally undertsandable". Worked in the clone `~/AI-Brain-build/atlas-project-intelligence` on HEAD `ae50fae`. Two engineers worked in parallel (browser audio; server speech), then one integration pass. Not committed, not deployed, no wrangler, no network or paid provider in tests.

**Evidence (before the fix)**
- Browser: the AudioContext runs at the device rate (48 kHz, 44.1 kHz, or 16/24 kHz on a Bluetooth headset in call mode). `src/voice-worklet.js` converted ATLAS's 24 kHz voice to that rate, and the microphone to 24 kHz, by plain linear interpolation with no filter. Measured on HEAD: speech at 10 kHz was 4.0 dB down at 48 kHz and 5.3 dB down at 44.1 kHz (muffled). Mirror images of her voice reached -5 to -23 dB (metallic sizzle), and on a 16 kHz headset 10-11 kHz content folded into the speech band at -4/-5 dB (garbled). A 15 kHz microphone tone reached the 24 kHz stream at full level.
- Worker logs of Tony's session: `language_switch` en to hi to en to fr within minutes. One utterance of 3+ words heard in another language (nova-3 `multi`) switched her language, and the language note then made her announce it.
- Every `turn_check` logged `complete:-1 probability:-1` (no verdict from smart-turn), and the code hid whether it was the 350 ms timeout or an error.
- `reply`: first text 0.55-2.4 s, first audio 1.9-4.1 s, `reply_gap` 3.4-5.5 s. Gaps between spoken pieces were not measured.
- Splitting: "e.g.", "i.e.", "A.I.", "U.S." and "data..." each ended a spoken piece (falling intonation and a pause mid-sentence). Pieces were synthesised one after another inside the model stream, and markdown such as `**Great**` went to the voice.

**Root causes and fixes**
1. Resampler (`src/voice-worklet.js`): band-limited polyphase FIR (Kaiser-windowed sinc, beta 8, cutoff 0.45 x the lower rate, 32 lower-rate samples each side). State carries across blocks, buffers are allocated once, and the samples-per-block schedule is identical to before, so the ring buffer, 480-sample frames and playback acknowledgements are unchanged. `flush` also clears the filter memory. `src/voice-client.js` no longer puts the 11 kHz biquad in front of it: Web Audio treats that Q as resonance in dB, giving +1.74 dB near 9 kHz. Integration: `src/ask-ui.js` (Ask ATLAS recording, same worklet) had the same biquad and now connects straight in too, because the WOW spec says it records exactly as `voice-client.js` does.
2. Phrasing (`deploy/cloudflare-edge/src/speech.js` and `atlas_voice/speech.py`, parity-tested): sentence ends skip initialisms, common abbreviations, a stop before a lowercase word, decimals and list numbers. `Phrases` sends the first sentence at once (or a first clause of 40+ characters; it was 24), then joins sentences under 40 characters to the next one while text is streaming. Every piece is an exact slice of the text on screen. `speakable()` strips markdown and list markers for the voice only.
3. Pipelined synthesis (`session.js`; Python `WorkersSpeech.speak`): the next piece is synthesised while the previous one is being synthesised or waiting for the floor (`SYNTH_AHEAD` 2). Delivery stays strictly in order through the unchanged turn-taking waits. An interruption drops what is in flight.
4. Language hysteresis (`session.js`, `languages.js`): the language switches only after two consecutive clear utterances in the same other language; an utterance in the session language clears the candidate. The same-language note no longer says "switch whenever they switch".
5. Diagnostics (numbers and type names only; a test checks that no transcript or error message is logged): `tts {ms, audio_ms, chars, cached}` per spoken piece, `underrun {gap_ms}`, `language_candidate {language}`, and `turn_check` gains `reason: 'timeout'` or `reason: 'error'` plus `name`. `app.js`: a smart-turn response without a boolean `is_complete` is now "no verdict" (logged `NoVerdict`), not "unfinished" (which held the turn 2.5 s).
6. `to16k()` (smart-turn input): 48-tap windowed low-pass at 7.2 kHz before the 1.5x decimation. Re-measured in integration: 9/10/11 kHz leaked 0.757/0.730/0.713 of the input before, 0.0004/0.0003/0.0003 now; 5 kHz 0.903 before, 1.000 now; 7 kHz 0.707 (the -3 dB point); 6.1 ms per 8 s call.
Docs: `deploy/cloudflare-edge/README.md` (pipeline line, new metrics), `docs/INTEGRATIONS.md` (language rule).

**Independent re-measurement (integration, own method: joint least-squares fits and windowed DFT at the exact image/alias frequency, HEAD vs new worklet)**
- Passband: 24k to 48k at 10 kHz: -4.02 dB before, -0.04 dB after. 24k to 44.1k: -5.28 before, -0.04 after. 16k to 24k at 6.5 kHz: -4.48 before, 0.00 after. The designed transition band starts above that: -1.81 dB at 10.5 kHz, -11.1 dB at 11 kHz.
- Speech-like multitone (70 harmonics up to 10.5 kHz), signal to everything-else: 24k to 48k 19.8 to 104.6 dB, 24k to 44.1k 22.5 to 99.5, 24k to 16k 26.3 to 122.8, 16k to 24k 20.6 to 105.6, 44.1k to 24k 34.1 to 106.3. Through the real `AtlasDuplexProcessor` at 48/44.1/16 kHz: 19.8/22.6/26.3 to 77.4/77.4/80.7 dB (the new figure is the 16-bit quantisation floor of the test signal).
- Images and aliases: 24k to 48k 10 kHz image -4.6 to -91.7 dB; 24k to 16k 10/11 kHz aliases -4.0/-5.0 to -96.8/-99.9 dB; microphone 48k to 24k 15/20 kHz aliases -0.0/-0.0 to -96.8/-114.0 dB. End-to-end microphone frames at 48 and 44.1 kHz: a 15 kHz tone at 16,384 LSB arrived at 15,136 and 15,628 LSB before, 0 LSB after.
- Delay (phase of a 200 Hz tone): 1.31-1.35 ms at 44.1/48 kHz, 1.98-2.02 ms at 16 kHz (about 0.02 ms before). These match the browser engineer's numbers to within 0.1 dB and 0.01 ms.

**Splitter probe (voice pieces, HEAD vs now; JS and Python identical, token-by-token streaming)**
- "Triage went from 3.5 days to 1.2 days. That is a big drop.": unchanged, 2 pieces; decimals were never split.
- "You mentioned e.g. the claims team. Who owned it?": 3 pieces ("You mentioned e.g." / "the claims team." / ...) now 2.
- "We used A.I. models on the U.S. data... then moved on. What next?": 5 pieces ("We used A.I." / "models on the U.S." / "data..." / "then moved on." / ...) now 2.
- "**Great**, so the first step was: mapping the flows. What was second?": HEAD streamed "**Great**, so the first step was:" as a separate clause with the asterisks voiced; now "Great, so the first step was: mapping the flows." / "What was second?".

**Tests (final tree)**
- `python3 build.py`: 878,496 bytes; the 4 aliases and `deploy/cloudflare-edge/src/atlas.html` are identical (sha256 `0b7a13a4…0ab8`). `build_edge.py` (full) ran; `policy.generated.js` is unchanged (no Python policy changed).
- `node --test tests/*.test.js`: 381 tests, 380 pass, 0 fail, 1 skipped (Natural Earth, needs `ATLAS_NE_SRC`). Edge `node --test test/*.test.js`: 445/445 (431 at HEAD).
- `pytest tests/test_*.py` (sandbox off): 261 passed. Parity/policy freshness: 7 passed; `speech.vectors.json` regenerates byte-identical.
- `make test-ui` suites, each exit 0 with 0 FAIL: studio 79, sculpture 40, intelligence 26, depth 20, autosave 33, orb_touch 8, library 14, reuse 19, memory 9, sheet 17, report 19, bids 70, ask 31 (incl. "about 1.5 s of audio at 24 kHz" through the worklet, no biquad), trust 51, storyboard 52, confirm 27, wow_edge 32, zero_config 87, zero_config_edge 54.
- Test-first: each engineer showed each new test failing on HEAD. The ask-ui guard (added to `tests/resampler.test.js`) failed before the one-line fix.
- Mutation check (scratch copy; each fix reverted alone): every revert makes its guard fail. Resampler to HEAD: 7 of 11 resampler tests fail. No flush reset: 1. Biquad back in `voice-client.js` or `ask-ui.js`: 1 each. JS/Python sentence exceptions removed: 4 / 2. No phrase joining: 3 / 2. First clause back to 24: JS 2; Python only through the parity freshness test. `speakable` off: 3 / 2. `to16k` back to linear: 1. One-utterance language switch: 2. Old language note: 1. No `turn_check` reason: 1. Old `is_complete` handling: 1. No `tts` metric: 1. No `underrun` metric: 1. Sequential synthesis: JS 2 / Python 2.
- One reviewed test changed (server engineer): "a held reply cut short by a new turn" now checks `roles.slice(1, 4)`, because pipelining can compose her next answer earlier. The final history on HEAD and on the new code is identical for that scenario.

**What the next live session's logs should show (Workers Logs, `atlas_metric`)**
- `turn_check` with `complete:-1` now carries `reason`. All `timeout` means smart-turn takes over 350 ms: raise the race, or measure its latency. `error` with `name: NoVerdict` means the model's response has no boolean `is_complete`, so the input or output schema is wrong. Any other `name` is a thrown error of that type. This is still the open root cause of the null verdicts.
- `language_switch` should be absent in an English-only session. One `language_candidate` for a misheard utterance is expected and harmless.
- `tts`: `ms` per piece is the synthesis latency (1.3-1.8 s was the first-piece figure before). Pieces after the first should overlap her playback.
- `underrun`: counted only after the reply's own composed speech has started. The planned wait after a greeting or acknowledgement is not logged (fixed after integration; test 'the planned wait after a greeting before the model speaks is not an underrun' failed with gap_ms 1400 before the fix).
- `reply` first audio should be about the same (first sentence at once), or slightly later when a 24-39 character first clause used to go early.
- By ear: laptop speakers (48 kHz) and a Bluetooth headset (16 kHz call mode) should sound clear, with no sizzle or garble, no pause after "e.g." or "A.I.", and no language flip on one misheard sentence.

**Still open**
- Root cause of the null smart-turn verdicts (the `reason` field above will tell).
- The Python `KyutaiSpeech` streaming path (word by word to Kyutai TTS) does not strip markdown; only `WorkersSpeech` uses `Phrases`/`speakable`.
- "Well... " with the lowercase next word arriving in a later chunk still splits there (the end of the streamed text counts as a sentence end, so first audio is never later than before).
- `preview/v11/*.png` were rewritten by `intelligence_browser.py`: exclude them from the commit. `MANIFEST.json` is still stale (pre-existing).

**Next task:** one commit (these files plus the four HTML aliases and the new `tests/resampler.test.js`), then Tony deploys with `deploy.sh` when nobody is interviewing, holds a session on laptop speakers and on a Bluetooth headset, and reads `turn_check.reason`, `tts`, `underrun` and `language_*` in Workers Logs.

- Deployed by Tony 2026-09-29 with `deploy.sh` (edge tests passed first): Worker version 4cbbd8b8-cd50-47a7-9a57-962a7a44b183 = commit acfb849 (voice intelligibility: band-limited resampling, language hysteresis, natural phrasing, tts/underrun/turn_check diagnostics). Next: read the new metrics from Tony's first session on laptop speakers and on a Bluetooth headset.

- Deployed by Tony 2026-09-29 with `deploy.sh`: Worker version b4d8671c-2cf0-4964-bd2b-370955229835 = commit f3a066a (short opening without review talk; smart-turn-v2 now sent a base64 WAV after live AiError on every turn). Working tree verified clean at deploy time.

- Deployed by Tony 2026-09-30 with `deploy.sh` (working tree clean at 03ff83c): Worker version 1faba0bd-3cd0-467c-8cc1-6579cb2290e8 = JEV story rating live (TYPESAFE_API_KEY set). Next: confirm live ratings and smart-turn verdicts in the logs after Tony's next session.

- Deployed by Tony 2026-09-30 with `deploy.sh` (tree clean at 3d1950d): Worker version cb2555d3-35cd-4e27-b255-e7a543ede836. Verified in the deployed script (Cloudflare API, script content): rounding-aware JEV checks (0.025 / 0.05) in the ranker and customer ranking, smart-turn base64 input, jev-1.13.0 pinned. Open: smart-turn answers in 0.7-1.9 s (REST timing), over its 350 ms budget; proposal to start the check earlier on a shorter tail awaits Tony.

- Deployed by Tony 2026-10-02 with `deploy.sh` (tree clean at e5699b5): Worker version 8f5a97f9-cfde-415f-9bfb-25a24e69f7e6. ATLAS always opens with the spoken introduction (admin included); welcome-back line mentions the interview. Verified in the deployed script.

## Per-session update template
Copy this section for each session. Do not put secrets, private keys, customer source text or raw audio in this file.

### Session: YYYY-MM-DD / short task
- Goal and chosen provider:
- Files inspected:
- Changes and rationale:
- Commands actually executed / exit codes:
- Evidence files:
- Remaining failures and risks:
- External blocker / exact safe action needed:
- Next task and source entry point:
- Git commit or working-tree state (when a repo is actually initialized):

## Definition of done
See `ACCEPTANCE.md`. Local fixtures plus attractive HTML are not a completed live implementation. Conversely, do not spend the pilot adding scale infrastructure that is not required by the approved scope.

### Session: 2026-09-29 / JEV story rating (`docs/JEV_RATING.md`)
Tony: "make sure Atlas has Jev integreated into it so its very fast and relable to rate stories" and "it should just work and ask for consent and thats it". Built in the clone `~/AI-Brain-build/atlas-project-intelligence` on `a45b140` (clean tree) in two tracks with one owner per file: EDGE (engine, routes, library, edge tests, integration docs; log `handoff/status/JEV_EDGE.md`) and UI (gauge, record dialog, storage strip, profile, browser suite; log `handoff/status/JEV_UI.md`). Not committed, not deployed.

**What it does**
- One TypeSafe request (`POST https://api.typesafe.ai/v1/systemone`, model pinned to `jev-1.13.0`; `JEV_MODEL` is not read) asks up to 11 typed questions about the anonymised story: 7 Scores, 3 Nouls, the story's language. Code composes them (completeness 0.45 + JEV 0.55, weights in `rating.js`); rule blockers stay decisive; a story is `ready` only when no uncertain answer could change that verdict, otherwise the review agent gives a second opinion. Manager-staff stories (no N+1) need every answer in the 0.9+ band; non-English stories are never made ready by JEV alone.
- Speed: 2 s cap with one hedged duplicate at 0.7 s when a person waits; 6 s with two retries on save/merge; an unchanged story body reuses the last answer (0 requests); a circuit breaker (3 consecutive failures, 60 s) and an auth block (until the key changes). gpt-oss is no longer called on the JEV path; it is the fallback and the second opinion.
- Privacy: the state is built from `scrub.recordView`, reduced to title, industry, service lines, the six answers and source names/versions/excerpts, with the record's own values (client, location, contact, project id, link hosts, consultant, colleagues, N+1, the owner's stored names) masked also inside longer tokens; a containment guard refuses to send if any own value remains. The key is only in the `Authorization` header. Every rating names its engine; per-dimension detail is at full access only; no quality figure per person.
- Consent: asked once per story owner (storage strip after the first library save; the record dialog as fallback), stored as the profile consent `jevRating`, revocable in the profile. The owner's consent applies whoever triggers the rating.
- Without `TYPESAFE_API_KEY`: today's review agent and today's gauge, byte-identical (U4); only admins see "JEV: BLOCKED_EXTERNAL, needs TYPESAFE_API_KEY".

**Touched files**
- EDGE: `deploy/cloudflare-edge/src/rating.js` (new), `src/library.js`, `src/library-routes.js`, `src/worker.js`, `src/profile.js`, `dev/fake-typesafe.mjs` (new), `dev/local-edge.mjs`, `test/rating.test.js` (new), `test/library.test.js` and `test/profile.test.js` (additions only), `deploy/cloudflare-edge/README.md`, `docs/INTEGRATIONS.md` (new "TypeSafe (JEV)" section), `docs/THIRD_PARTY.md`, `handoff/CONFIGURATION.md`, `handoff/CODE_MAP.md`, `handoff/status/JEV_EDGE.md`.
- Integration review: `deploy/cloudflare-edge/src/rating.js` (`termRe`), `src/library.js` (`engineFor`, `auditDetail`, the join cap), `test/rating.test.js` (R2b) and `test/library.test.js` (3 "JEV off" tests), additions only; `Makefile` (`test-ui` runs `jev_rating_browser.py`); `docs/JEV_RATING.md`; this entry.
- UI: `src/charts.js`, `src/app.js`, `src/profile-ui.js`, `src/styles.css`, `tests/charts.test.js` (U5 raised the `charts.js` size ceiling to 57,000: the only changed existing assertion), `tests/fixtures/quality-gauge-before-jev.json` (new), `tests/jev_rating_browser.py` (new), `.github/workflows/ci.yml` (`jev_rating` in the browser loop), rebuilt `ATLAS_*.html` and `deploy/cloudflare-edge/src/atlas.html`, `handoff/status/JEV_UI.md`.

**What Tony must do (once, from his own terminal; builders never handle the key)**
1. Get a key at console.typesafe.ai/keys.
2. Store it as a Worker secret: double-click `deploy/cloudflare-edge/Set ATLAS keys.command` (it asks, hidden, for "TypeSafe (JEV) API key"; the other prompts can be left empty), or run `cd deploy/cloudflare-edge && npx wrangler secret put TYPESAFE_API_KEY`. If the secret is already set for the other JEV paths, skip this step.
3. Commit this build, then deploy it with `bash deploy/cloudflare-edge/deploy.sh` when nobody is interviewing (never mid-session).
4. Check: ATLAS → profile → "Test Hindsight and JEV connections" (one fixed sentence to TypeSafe). Then save one story: the storage strip asks the consent once; "Allow for my stories" gives "Rated by JEV · 0.x s" in the record dialog.
Nothing else is needed for story rating: no variable, binding, migration or setting; `JEV_MODEL` is not read. Each consultant clicks "Allow" once for their own stories.

**Cost per rating** (https://docs.typesafe.ai/models.md, re-read 2026-09-29: $0.042 per million input tokens, output tokens free; the tokenizer is not documented, so tokens are ASSUMED at 4 characters each)
- Typical story (6 answers of about 110 words, 2 sources, 11 questions): request body 10,154 characters ≈ 2,540 tokens ≈ **$0.00011 per rating** (about 1 US cent per 95 ratings).
- Slow tail with the hedged duplicate: ≈ $0.00021. Largest story `cleanReference` allows (6 × 6,000 characters, 10 sources): 47,767 characters ≈ 11,900 tokens ≈ $0.0005 (≈ $0.001 hedged).
- "Rate again" on unchanged text, re-opening a record, metadata-only edits: $0 (the saved answer is reused, 0 requests).
- An escalated rating adds one gpt-oss call on Workers AI (today's cost), not a TypeSafe call. Actual cost after deploy: Σ `input_tokens` × 0.042e-6 from the `story_rating` metric.

**Integration review (2026-09-29, after both tracks reported done)**
Adversarial review against `docs/JEV_RATING.md`, WOW §0.4/§0.7/§0.8 and Tony's "it should just work". Four defects found, each fixed test-first (the new test failed on the tracks' code, passes now):
1. **Privacy: multi-word names written fused or with other separators reached TypeSafe** and passed the guard (both used the same rule). Probe with client `Crédit Agricole`, location `Saint-Quentin`, consultant `Alex Martin`, project `PRJ-ZEBRA-7`: the body carried `#CréditAgricoleOps`, `CréditAgricoleClaims_Q3.xlsx`, `AlexMartin`, `alex.`, `PRJ ZEBRA 7`, `PRJZEBRA7`, `jane.doe@intranet` and `Saint Quentin`. Fix (`rating.js` `termRe`, shared by `ownMask` and the guard): inside a 5+-character term, a space, hyphen, underscore or dot matches any run of those, or none when the fused form still has 5+ characters (so `Jo Li` never matches inside "joli"). Test R2b (`test/rating.test.js`).
2. **No key: "Run quality review" during the save's own review returned after 2 s with no rating** ("has not scored this revision yet" plus a "Done." toast), because the join cap assumed the JEV dialog's polling, which is off without the key. Before JEV the click waited for its own review. Fix (`library.js` `review`): the 2 s cap applies only when JEV is configured; otherwise the call waits for the rating in flight.
3. **No key: a story with no text was rated by "rules"** and the gauge said "Review agent unavailable", which was false. Fix (`library.js` `engineFor`): without the key it goes to the review agent, as before JEV. With the key, `rules` / `no_story` is unchanged (R4).
4. **No key: the audit line gained "· rules only"** when the review agent did not answer. Fix (`library.js` `auditDetail`): the suffix is not added for `no_key`. Tests 2-4: "JEV off (no key)" in `test/library.test.js`.
Also: `Makefile` `test-ui` now runs `tests/jev_rating_browser.py` (CI already did). `docs/JEV_RATING.md` §3.3, §3.5, §4.1, §6.6, §7.3 and §7.5 record the four fixes and the residual limits.

Review answers:
- **Can a confidential value reach TypeSafe?** Probe: two records full of client, location, contact, email (5 spellings), phone (4 spellings), URL, host, project-id, consultant, colleague, N+1 and stored-profile names, plus `sheet` contacts and price, a report headline, other-library clients and contacts; the exact body was inspected. After fix 1, none of the record's own values, emails, phones, http(s)/www links, `mantu.com`, the key or the sheet reaches the body. What remains is listed in §3.5: parts of the client contact typed alone (`Jane`, `Doe` from `Jane Doe (Head of Claims)`), 2-letter first names (`Jo`), abbreviations and misspellings (`Zebra-corp`, `ZebraClaims`), other library clients fused into a longer token (`OrbitelNetworksOps`), and bare or non-http links not in the record (`sharepoint.com/...`, `ftp://...`). The consent text says "it recognises ... abbreviations or product names may remain".
- **Can a low-confidence or failed rating show as `ready` or as JEV?** Failed, invalid, guarded, too-long, breaker and auth outcomes store `engine: review-agent` (or `rules`) with `jev: null`; the UI says "JEV did not answer". A JEV `ready` with a low-confidence dimension is possible only by design (§5.5, R10a): no decisive hold, and the pessimistic reading still reaches 75; the hold is shown under "To check" and an N+1 still validates. Manager staff (no N+1) need every answer in the 0.9+ band, else the review agent decides. `rules` is never `ready`.
- **Key exposure:** only `Authorization: Bearer` (R1, R17, probe); bootstrap exposes a boolean; `RatingError` text is fixed; metrics are numbers only.
- **No key = today:** after fixes 2-4 the UI and stored behaviour match pre-JEV (U4 byte-identical gauge; jev_rating step 13). Remaining differences, all invisible to non-admins: stored quality objects and `GET /:id` carry the new fields (`engine`, `ms`, `gen`, `rating`, `jevAllowed`); a `story_rating` metric line is logged per rating; after "Run quality review" the index (duplicate scan) finishes in `waitUntil` instead of before the response (§6.6); admins see "JEV: BLOCKED_EXTERNAL, needs TYPESAFE_API_KEY" (ZERO_CONFIG §0.2).
- **Watch after deploy (not changed):** a Score counts as "split" whenever its two most likely levels are not adjacent, however small the second (§5.4 as written). A confident answer such as `[0.004, 0.001, 0.003, 0.992]` would show "split reading" and, for manager staff, escalate. The `holds` and `escalated` metrics will show whether this happens; a mass floor on the runner-up (for example `PESSIMISTIC_Q`) is the one-line re-tune if it does.

**Measured latency** (fake JEV answering in 300 ms; the real routes, `Library`, `rating.js` and node:sqlite; server side only, excluding the network, Access and TypeSafe's own round trip; script in the integration session scratchpad)
- Uncached "Rate again" / consent "Allow" (`POST /:id/review`, interactive): p50 306.7 ms, p95 329.3 ms (n = 20); `quality.ms` p50 303 ms; 1 request each.
- Save → background JEV rating stored: p50 306.5 ms, p95 311.0 ms (n = 10); the save itself answers 201 in 2.1 ms.
- "Rate again" on unchanged text (saved answer reused): p50 1.7 ms, p95 2.9 ms, 0 requests (n = 20).
- Re-opening a rated record (`GET /:id`): p50 0.1 ms, p95 0.3 ms, 0 model calls (n = 60).
- Slow tail (first request 1.5 s, hedged duplicate at 0.7 s answering in 300 ms): p50 1,007 ms, 2 requests (n = 5).
- TypeSafe hangs: the 2 s interactive deadline, then the review agent (8 s stand-in): 10,008 ms, `fallbackReason: timeout`, 2 requests. Today's agent takes 6-34 s live.

**Commands and results (integration run on the final tree; browser suites and pytest outside the sandbox)**
- `python3 build.py`: built 888,787 bytes; the 4 `ATLAS_*.html` aliases are byte-identical. `python deploy/cloudflare-edge/build_edge.py` (uv): "edge constants + page generated"; `policy.generated.js` unchanged; `src/atlas.html` identical to `ATLAS_Voice.html`.
- `cd deploy/cloudflare-edge && node --test test/*.test.js`: 488 tests, 488 pass (the tracks' 484 + 4 integration tests); `rating.test.js` + `library.test.js` 53/53 in 5 of 5 repeated runs.
- `node --test tests/*.test.js`: 385 tests, 384 pass, 1 skipped, 0 fail.
- `pytest tests/test_*.py -q`: 262 passed. Parity: `tests/test_edge.py -k parity` 5 passed; the 6 `test/*.vectors.json` files are byte-identical before and after (`cmp`).
- Every `make test-ui` suite, rc 0 and 0 FAIL: studio 79, sculpture 40, intelligence 26, depth 20, autosave 33, orb_touch 8, library 14, reuse 19, memory 9, sheet 17, report 19, bids 70, ask 31, trust 51, storyboard 52, confirm 27, wow_edge 32, zero_config 87, zero_config_edge 54, jev_rating 35 (EDGE's fake; INFO: step 9 "To check" not caught because the second opinion lands before the redraw, step 14 is mock-only), and `JEV_BROWSER_MOCK=1` jev_rating 42 (backoff measured 0.82 / 1.61 / 3.21 s, 12 GETs in 45 s then stop).
- The tracks' earlier results (EDGE 484/484, mutation checks, local smoke with and without `FAKE_TYPESAFE`) are in `handoff/status/JEV_EDGE.md` and `JEV_UI.md`.
- `grep -rn api.typesafe.ai tests deploy/cloudflare-edge/test`: only fake-fetcher assertions and constants. No test or script called TypeSafe or any paid provider; no key exists in the tree. No commit, no deploy, no wrangler run.
- `intelligence_browser.py` rewrites `preview/v11/*.png` on every run; they show as modified. Keep or drop them at commit time.

**TypeSafe contract** re-read live on 2026-09-29 (URLs per detail in `handoff/status/JEV_EDGE.md`). Drift found: https://docs.typesafe.ai/models.md now gives throughput as 100K tokens/s and 40 requests/s ("adjusting dynamically"), not the 250,000/s and 1,200/min in the spec; no code depends on it. Re-read again by the integration review: https://docs.typesafe.ai/api.md (endpoint, headers, body, answer fields, 401/422/429/529), https://docs.typesafe.ai/models.md (`jev-1.13.0` = `jev-latest`, $0.042 per million input tokens, output free, 100K tokens/s and 40 requests/s, 64k per request, 32k for state plus the longest question), https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook.md (uncertain from 0.30 through 0.70 inclusive; 111 ms mean; `jev-1.13.0`) and https://docs.typesafe.ai/confidence.md, which describes the three bands in words and shows 0.5 and 0.9 only in a code example, so `SURE_AT` 0.9 and `HOLD_BELOW` 0.6 stay pilot values.

**Deviations from the spec** (reasons in `handoff/status/JEV_EDGE.md` "Decisions" and `JEV_UI.md` "Decisions"): the guard decodes the JSON before searching (raw bytes miss `\nAlex` and escaped quotes); `ownMask` uses the guard's own rule so masked text never trips it; excerpts are masked before being cut; `storedConsent`/`storedNames` create no table; the escalation metric counts once per escalation (share = Σ `escalated` / count(`engine` = 1)); the storage-strip consent row sits after the visible strip (`#storageDetail` is inside the profile dialog).

**Tony decides** (nothing is blocked on it)
- §12.2: the same key also turns on private-memory relevance, the next-question ranker, project classification and bid ranking, none of which asks this consent. A: gate memory relevance and classification behind `jevRating` (small follow-up); B: accept as is. Recorded in `docs/INTEGRATIONS.md` "TypeSafe (JEV)".
- TypeSafe's data terms (no training on customer data; ZDR for enterprise, https://docs.typesafe.ai/legal.md) before any production deployment with real client data.

**Status by category**
- Implemented and locally verified: everything above.
- Provider verified: nothing (no key; no call to TypeSafe was made).
- **JEV key and provider check (2026-09-29):** `TYPESAFE_API_KEY` is set on the live Worker (secrets listed by name: `CSRF_SECRET`, `TYPESAFE_API_KEY`). Provider-verified from the Mac with synthetic stories through the real code (`questionPlan` -> `requestBody` -> `storyRater.rate` -> `parseAnswers` -> `compose`): jev-1.13.0 answered 11 questions in 262 ms (strong story: 70, needs_work, engine jev) and 7 in 220 ms (weak story: 14, insufficient), one attempt each; the existing classify path answered in 317 ms (impact 77.7). Remaining step: Tony deploys this commit when nobody is interviewing. Recommended: rotate the TypeSafe key (it appeared in the conversation) and replace the secret.
- Open after deploy: the latency targets (p50 ≤ 400 ms, p95 ≤ 1,200 ms) are ASSUMED from the docs until the `story_rating` metric's `ms` confirms them; thresholds and weights are uncalibrated pilot values; acceptance is an escalation share under 20% over the first 100 JEV ratings (Workers Logs, `atlas_metric: story_rating`), else re-tune in code (answers are stored, no new calls needed).

### Session: 2026-11-08 / tenant fail-closed and role config
- Working tree only. No commit, push, pull request, deploy, grant, or live provider call. Baseline remains `efb4948fdc3fe03205c6ba149afd181f04904143`.
- Frozen patch before this pass stays `1adf17eb8edce3ad76132e08124cf56b89a083561d1200a94ee02dbec6b948af` (196144 bytes). Updated source patch SHA256 `8f58e909fe1ed0fe1b4b41af617d7bbc78dc966f0d14ad0d857271f090f8c754` (223931 bytes). That patch excludes generated HTML and this status log. Report: `/opt/cursor/artifacts/atlas-implementation-report.md`.
- Production protected reads, approvals, export, and metrics require a verified caller tenant equal to the row tenant. Empty-tenant trust imports are refused. Legacy rows are not assigned a tenant (`deploy/cloudflare-edge/TENANT_BACKFILL.md`). Missing admin, pre-sales, and reviewer env config grants nobody. `?as=` and `&idp=` are local-demo only.
- Commands: `node --test deploy/cloudflare-edge/test/*.test.js tests/*.test.js` 884 passed, 1 skipped, 0 failed. `pytest tests/test_*.py -q` 264 passed. Browser: studio 79, sculpture 40, storyboard, intelligence 26, depth 20, autosave, orb_touch 8, report, bids, ask, trust passed after the 768px nav wrap. library, confirm, wow_edge, jev_rating, reuse, memory, zero_config, and zero_config_edge still fail under the new approval and admin rules or a missing `python-docx` (sheet). Not relaxed.

### Session: 2026-11-08 / run4 production demo guard and browser fixtures
- Same working tree. No commit, push, pull request, deploy, or live provider call. Frozen run2 and run3 patches were not overwritten.
- `DATA_MODE=production` with `ATLAS_TENANT_ISOLATION=local-synthetic` or with `ATLAS_DEV_IDENTITY` returns 503 on `/api/*` before a durable-object fetch, and the library route returns 503 before SQL. The local demo leaves `DATA_MODE` unset and still serves.
- Synthetic browser fixtures use `/__trust` plus explicit `ATLAS.Admin`, `ATLAS.Presales`, and `ATLAS.Reviewer` roles. A typed manager and a mailbox without those roles are negative checks. They do not publish or open admin screens.
- Node after this session: 886 passed, 1 skipped, 0 failed. Browser results and the patch hash are in the run4 report artifact, not in this log.

### Session: 2026-11-08 / run5 tenant scope
- Run4 patch and delta were copied aside and not overwritten. No commit, push, deploy, or live call.
- Telemetry purge and metrics are SQL-scoped to the caller tenant. Journey primary key is subject plus tenant. Staffing import refuses a missing enforced tenant before it writes. Production enforcement follows the deployment env, not the tenant-enforced header. The cron does not sweep every tenant.
- Node 887 passed, 1 skipped, 0 failed. Pytest 264 passed. The run5 hash is in the run5 report artifact.

### Session: 2026-11-08 / run6 profile ownership and system ingress
- Same working tree. No commit, push, pull request, deploy, grant, or live provider call. Run5 artifacts and `snapshot-run5-frozen` were not overwritten. The hash of this candidate is in the run6 report, not here.
- Profile rows use primary key `(subject, tenant)`. Reads, saves, consent, export, and delete use both. A DSAR delete removes only that pair. An older profiles table is copied with a blank tenant when the column was absent. Blank stays blank. `quarantineReport` only counts those rows.
- `/api/triggers` and `/api/directory/push` forward `ATLAS_SYSTEM_TENANT` when enforcement is on. A missing or malformed value returns 503 before the durable object. A different tenant on the request is rejected. The bearer secret is still required. No directory or HR service was called.
- Recommendation coverage in `tests/reuse_browser.py` now creates and approves a story outside the seed list and checks that recommendation and export see it, and that an unapproved story is not recommended.
- Vendor deletion remains `not-asserted`. This is not a GDPR certification. Access-mode Hindsight banks and Interview object names stay keyed by the verified subject and were not rekeyed.

### Session: 2026-11-08 / run7 staffing, invitations, pages, maintenance
- Same working tree. No commit, push, pull request, deploy, or live call. Run5 and run6 artifacts were not overwritten. The hash is in the run7 report.
- Staffing's primary key is project, consultant, and tenant. A blank legacy row stays blank. Invitations dedupe per tenant. Metrics and staffing pages keep the date window on every page and pass the cursor through the admin routes. An enforced sweep maintains only that tenant's profiles, gaps, and confirmation requests.
- An enforced memory bank and Interview object use tenant plus subject. A missing tenant does not open the subject-only key. Those older keys are not deleted. DSAR `complete` stays false.
- Synthetic helper routes refuse `DATA_MODE=production` and any dev switch other than `ATLAS_DEV_IDENTITY=1` with `local-synthetic`. `0`, `false`, and `off` do not count as demo identity.

### Session: 2026-11-08 / run8 trust and directory keys
- Same working tree. No commit, push, pull request, deploy, or live call. Run7 artifacts were not overwritten. Run7 is a superseded intermediate. The hash of this candidate is in the evidence archive, not here.
- Manager trust is unique on owner, email, and tenant. Story local identity includes the stored tenant. Directory rows and staged imports include tenant on the key. A blank legacy row stays blank. A DSAR delete removes only that tenant's covered rows and still reports deletion incomplete.

### Session: 2026-11-08 / run9 combined gate
- Same working tree. No commit, push, pull request, deploy, grant, or live call. Run2 through run8 artifacts were not overwritten. The hash of this candidate is in the run9 evidence archive, not here.
- Bids, gap lists, confirmation inbox, outreach, invitations, duplicate links, merge, and reinstate check the verified tenant before a write or a page. A request body cannot choose the tenant. Background review uses the saver's tenant. Staffing pages order by time, project, and consultant. DSAR deletes use the verified subject and the verified mail, report each store, and stay incomplete. `DATA_MODE=test` does not turn enforcement off.
- Vendor deletion stays `not-asserted`. Quarantine is not deletion. Blank legacy rows and subject-only banks were not erased.

### Session: 2026-11-08 / run10 combined gates
- Same working tree. No commit, push, pull request, deploy, or live call. Run9 artifacts were not overwritten. This note is not part of the code patch. The hash is in the run10 evidence archive.
- Run9 was not accepted. The cloud gate reported no high or medium findings and two low findings. The Mac command-line gate reported one high and six medium findings. The confirmed code issues are fixed in this candidate. One backfill prose citation did not match the current text and was left unconfirmed.
- A stored duplicate link to another tenant is not returned by get. Invitation audit, bid purge, claim decisions, win totals, the Teams ingress, and directory deletion stay inside the verified tenant. An Entra subject deletes its mail key and its `oid:` key, not another person's key. Outreach rejection for a missing tenant is HTTP 403 and does not create the outreach tables. Opening the library still initializes the reference schema.
- Vendor deletion stays `not-asserted`. Quarantine is not deletion.

### Session: 2026-11-08 / run11 combined gates
- Same working tree. No commit, push, pull request, deploy, or live call. Run10 and earlier archives were not overwritten. This note is not part of the code patch.
- Run10 was not accepted. Duplicate links now require the caller to be able to open the other story. Historical duplicate audit text is not returned. Teams card actions stay in one tenant. Invitation reads use the verified subject and the verified mail. A reference id the caller cannot open is rejected before a write. Confirmation inbox and cancel check the linked story tenant before they show or change it. Bids, claims, gaps, and profile check the tenant before they initialize their tables.
- The edge page is generated. It is not tracked. A clean baseline plus this patch, with ATLAS_HOME_URL unset, produced the same page hash on two builds. The local runner serves that file and refuses a different ATLAS_Voice.html.
- Vendor deletion stays `not-asserted`. Quarantine is not deletion. The reference schema is still created when a library object is constructed.

### Session: 2026-11-08 / run12 combined gates
- Same working tree. No commit, push, pull request, deploy, or live call. Run11 and earlier archives were not overwritten. This note is not part of the code patch.
- Run11 was not accepted. Invitation update, manager approval, and the stale scan use the verified subject and the verified mail. A stored invitation reference the caller cannot open is rejected before the row changes. A Teams card action is bound before the dedupe read. The page build check fails when the first comparison fails. The generated page is not tracked.
- Vendor deletion stays `not-asserted`. Quarantine is not deletion. Stored duplicate links are not purged.

### Session: 2026-11-08 / run13 combined gates
- Same working tree. No commit, push, pull request, deploy, or live call. Run12 and earlier archives, including the run12 input supplement, were not overwritten. This note is not part of the code patch. The candidate hash is in the run13 evidence archive.
- Run12 was not accepted. The staffing import still stores the consultant mail as the trust owner. Approval and the due-row check also accept the profile mail of that subject in the same tenant. The stale scan invites that verified mail and skips a subject that has none, instead of rejecting the address. Ask refuses a missing enforced tenant before the rate limit and before the audit write. A Teams decline or schedule resolves story access before the invitation update and writes the audit on the story only when that access exists. The Teams directory tenant and the configured ATLAS tenant stay different namespaces. A mismatch inside either namespace does not change the invitation.
- New duplicate index rows do not copy the other title. Reads use the live title after an access check. Older stored titles and older duplicate audit text remain in SQLite. Get, list, export, revision, and recommend do not return a title the caller cannot open. Those rows were not deleted.
- deploy.sh builds, copies, and checks the supplied page hash as separate commands. A failed build or a different hash does not call wrangler. The page verifier uses a unique temporary file. A corrupted first snapshot makes that script exit nonzero. SOURCE_LOCK still checks the vendored string against itself. It does not prove the bytes came from npm.
- Vendor deletion stays `not-asserted`. Quarantine is not deletion. Legacy DSAR complete stays false. The reference schema is still created when a library object is constructed.

### Session: 2026-11-08 / run14 combined gates
- Same working tree. No commit, push, pull request, deploy, or live call. Run13 and earlier archives were not overwritten. This note is not part of the code patch. The candidate hash is in the run14 evidence archive.
- Run13 was not accepted. A staffing replacement now grants the new manager and revokes only a staffing grant that is no longer an active assignment for that consultant and tenant. A directory grant, a grant in another tenant, a blank legacy source, and a manager who still has another project stay. The grant change is one transaction. A failed replacement leaves the previous grant and staffing row.
- An invitation list omits the linked story id, title, and project when the caller cannot open that story. Dismiss and schedule still change only the invitation. Done still requires access to the story. The inbox omits the consultant name and role, and the story id, when access is not full.
- A Teams send uses one active conversation's directory tenant. It does not require that id to equal the ATLAS tenant. Several directories are refused. The deploy script hashes the page after the tests. A failed build does not deploy a page that was already present.
- Vendor deletion stays `not-asserted`. Quarantine is not deletion. Stored duplicate titles were not deleted.

### Session: 2026-11-08 / run15 combined gates
- Same working tree. No commit, push, pull request, deploy, or live call. Run14 and earlier archives were not overwritten. This note is not part of the code patch. The candidate hash is in the run15 evidence archive.
- Run14 was not accepted. Staffing replacement uses storage.transactionSync. Application code does not send SQL BEGIN. The node sqlite adapter rejects BEGIN and SAVEPOINT and emulates transactionSync. A Cloudflare Durable Object runtime was not executed here.
- A staffing grant approves only the project on the current assignment. A directory grant stays owner-wide. Subject and mail aliases are revoked together. A failed replacement does not count as saved, does not invite, and the webhook does not create the invitation first.
- A confirmer without full access gets an opaque request handle. Decline of an inaccessible linked story changes only the invitation and writes no audit. Schedule and snooze do not. A sent Teams row stores its destination directory. A blank legacy directory is not guessed.
- Vendor deletion stays `not-asserted`. Quarantine is not deletion. Stored duplicate titles were not deleted.

### Session: 2026-11-08 / run16 combined gates
- Same working tree. No commit, push, pull request, deploy, or live call. Run15 and earlier archives were not overwritten. This note is not part of the code patch. The candidate hash is in the run16 evidence archive.
- Run15 was not accepted. A staffing project id is one lowercase key. A second spelling updates that row. Two already-stored spellings are refused and do not grant. Profile lookup errors inside the transaction are not swallowed. The webhook invitation is in the same transaction as the staffing change. Done checks the existing link and the supplied link before any write, and a done with no reference is refused.
- A sent Teams row stores the conversation id. An action must match that conversation, the directory, the ATLAS tenant, and the actor. The deploy script's production npx command is what the positive stub records. A second page comparison has its own stage. The Durable Object runtime was not executed.
- Vendor deletion stays `not-asserted`. Quarantine is not deletion. Stored duplicate titles were not deleted.

### Session: 2026-11-08 / run17 combined gates
- Same working tree. No commit, push, pull request, deploy, or live call. Run16 and earlier archives were not overwritten. This note is not part of the code patch. The candidate hash is in the run17 evidence archive.
- Run16 was not accepted. A staffing row is matched on the lowercased project id, the lowercased consultant email, and the lowercased tenant UUID. Email and tenant UUID are normalized on that one row. The stored project spelling is kept. A new row keeps the caller's project spelling. Two stored rows for the same logical assignment are refused, and nothing is written. The managerless import uses that same reconcile. The old manager loses a replaced assignment. An ambiguous pair does not grant.
- Invitation dedupe for a project end compares the project id case-insensitively. A refused Teams snooze does not write teams_seen, so the same activity can still decline. A profile query error rolls back the webhook. A CSV failure rolls back only that row. Earlier CSV rows stay. The import audit records the saved count. A missing profiles table is not a query error.
- The factory test counts storage.transactionSync and requires the original error. Removing that wiring fails the test. The node sqlite adapter is still an emulation. A Cloudflare Durable Object runtime was not executed.
- The deploy stub records one `wrangler@4 deploy` and one `secret list`. `secret put` did not run. No network.
- Vendor deletion stays `not-asserted`. Quarantine is not deletion. Stored duplicate titles were not deleted.

### Session: 2026-11-08 / run18 combined gates
- Same working tree. No commit, push, pull request, deploy, or live call. Run17 and earlier archives were not overwritten. This note is not part of the code patch. The candidate hash is in the run18 evidence archive.
- Run17 was not accepted. A staffing-sourced confirmation is checked again when it is shown and when it is decided. A manager removed from that assignment cannot confirm through the old handle. The request stays open and the claims stay unverified. A directory-sourced request, another project's current assignment, presales approval, and the verified-admin check stay. Gap requests name an assignee, not a staffing grant, and were not changed.
- Webhook invitation dedupe uses the same project and email comparison as import. The story id stays an exact opaque key.
- The tenant-case fixture uses a UUID that contains letters. A failed webhook replacement restores the preexisting staffing, trust, invitation, audit, and outreach rows. The thrown error is the injected object. A blocked CSV still writes one summary audit and does not change staffing, trust, invitations, or claims.
- Vendor deletion stays `not-asserted`. Quarantine is not deletion. Stored duplicate titles were not deleted. A Cloudflare Durable Object runtime was not executed.

### Session: 2026-11-08 / run19 combined gates
- Same working tree. No commit, push, pull request, deploy, or live call. Run18 and earlier archives were not overwritten. This note is not part of the code patch. The candidate hash is in the run19 evidence archive.
- Run18 was not accepted. A staffing confirmation now counts a blank-manager row in the same logical assignment. A managed row plus a case-variant blank row is ambiguous at claim creation, inbox, and decide. Nothing is rewritten. One blank row is not a staffing grant. One managed row still is. Directory confirmation, another project, and another tenant stay.
- Rollback snapshots now read every column of staffing, trust, invitations, audit, and outreach. A library built without the factory transaction rejects the webhook with a different error and leaves those rows in place.
- `docs/BUILD_NOTES.md` is a page-build input. `build.py` inlines it. The code archive holds the file body. This note does not.
- Vendor deletion stays `not-asserted`. Quarantine is not deletion. Stored duplicate titles were not deleted. A Cloudflare Durable Object runtime was not executed.

### Session: 2026-11-08 / local main, privacy delete scope
- The frozen run19 archives were not rewritten. This note is the later local-main continuation.
- A privacy delete now requires a verified tenant UUID before it writes. A blank tenant does not match quarantined rows. The response still says deletion is incomplete and vendor deletion is not-asserted. Stories, staffing, invitations, audit, blank profiles, and other tenants stay.
- No push, deploy, or live provider call.

### Session: 2026-11-08 / local main, privacy delete receipt
- Parent remains the prior local-main commit. This note is the next forward commit. No push, pull request, deploy, or live call. Frozen run19 archives and the prior packet were not rewritten.
- The privacy-delete JSON no longer returns retained row counts. It returns this subject and tenant's own removal counts, complete false, and vendor deletion not-asserted. Adding or removing another tenant's rows, or another subject's rows, does not change that JSON. Those rows stay in the database.
- The Worker rejects POST /api/library/privacy/delete and POST /api/library/profile/delete before it asks for the library object when the verified subject has no tenant UUID. A browser tenant header does not supply that UUID. A direct library call on an already constructed store can still have had its schema created earlier; that path is not a zero-write claim.
- Profile delete requires a tenant UUID even when tenant enforcement is off, so a blank-tenant profile is not erased. On the Worker, tenant enforcement is on unless ATLAS_TENANT_ISOLATION is local-synthetic, and production refuses that combination. There is no public Durable Object route.
- Quarantine is not deletion. Vendor deletion stays not-asserted. A Cloudflare Durable Object runtime was not executed.

### Session: 2026-11-08 / local main, delete path variants
- Parent is the privacy-receipt commit. This note is the next forward commit. No push, pull request, deploy, or live call.
- The Worker uses the library's own path match for a privacy or profile delete. A trailing slash, a repeated slash, a query string, and a later privacy segment take the same missing-tenant rejection before the library object is requested. A profile path with a third segment is not a delete. Percent-encoded slashes and a different letter case are not that match. The page was not rebuilt.
- Quarantine is not deletion. Vendor deletion stays not-asserted. A Cloudflare Durable Object runtime was not executed.

### Session: 2026-11-08 / owned stories in a verified tenant
- Parent is the ffmpeg CI commit. This note is the next forward commit on an unpublished local branch. No push, pull request, merge, deploy, or live call.
- A privacy delete for verified subject S in verified tenant T now removes story rows whose owner is S and whose tenant is T, and every revision of those stories. Blank-tenant rows, other tenants, another owner in T, a malformed tenant, staffing, invitations, and existing audit rows stay. complete stays false. Vendor deletion stays not-asserted. Quarantine is not deletion.

### Session: 2026-11-08 / block another owner's merge target
- Parent is the owned-story delete commit. This note is the next forward commit on an unpublished local branch. No push, pull request, merge, deploy, or live call. The prior commit was not amended.
- A privacy delete does not remove an owned story when another owner's story has been merged into it. The receipt names that story id and the reason another-owner-merge-target. The other owner's row is not changed. Other owned stories in the same tenant are still removed. complete stays false. Vendor deletion stays not-asserted.
- The journey button, the non-atomic revision delete, and the index continuation are unchanged.

### Session: 2026-11-08 / delete confirmation, atomic story delete, late index
- Parent is the merge-target block commit. Code commit b629dbc6; this note is the next forward commit on an unpublished local branch. No push, pull request, merge, deploy, live data, provider call, or provider deletion. No earlier commit was amended.
- Touched: src/journey-ui.js, deploy/cloudflare-edge/src/operate.js, deploy/cloudflare-edge/src/library.js, deploy/cloudflare-edge/test/policy.test.js, tests/privacy_delete_browser.py, Makefile, and the four rebuilt HTML aliases.
- The journey page offers deletion only after the server disclosure loads. A confirmation lists what is deleted and what is not, and needs a tick before Delete permanently sends one POST. Cancel sends nothing. The disclosure returns the same scope as the delete receipt.
- Story selection, revision deletes and story deletes run in one storage.transactionSync. A failure rolls them all back and the receipt says delete-failed with 0 removed for both. Without a transaction, stories are not touched. Other stores keep their own receipts. The direct merge-target block is unchanged.
- An index that resumes after the embedding returns stops when its story is gone. It writes no duplicate pointer to a deleted row.
- Still open, not implemented: the indirect merge chain and a same-email source in another or a blank tenant (D3 extension). Pointers written before this change, claims, bids, gaps, invitations, staffing and audit rows that point at a deleted story are not cleaned up. complete stays false. Vendor deletion stays not-asserted. This is not a GDPR certification.
- Commands: python3 build.py; python3 deploy/cloudflare-edge/build_edge.py; node --test deploy/cloudflare-edge/test/*.test.js; node --test tests/*.test.js; python3 -m pytest tests/test_*.py -q; python3 tests/privacy_delete_browser.py; a local Miniflare/workerd run of the bundled Worker (synthetic data, local stand-ins only).

### Session: 2026-11-08 / delete confirmation corrections
- Parent is the delete confirmation writer note (6d9afb93). Code commit a590eaea; this note is the next forward commit on an unpublished local branch. No push, pull request, merge, deploy, live data, provider call, or provider deletion. No earlier commit was amended.
- Touched: src/journey-ui.js, tests/privacy_delete_browser.py, and the four rebuilt HTML aliases. Worker source, the story delete transaction, the late-index guard and the merge-target block are unchanged.
- The confirmation states the verified-tenant scope. A story that another person's story was merged into is kept with its revisions, and the receipt names it. The text no longer promises every owned story or all data.
- While a delete is pending, the tick, Cancel and Delete permanently are disabled. Unticking and reticking, clicks and keys cannot send a second request. Before the fix, two POSTs reached the handler.
- Only the disclosure for the current render can enable deletion. A disclosure without a deletion scope says why deletion is not offered. A pending or failed disclosure still offers nothing.
- Still open, not implemented: the D3 extension (indirect chain, same-email source in another or a blank tenant), cleanup of older pointers and of rows that point at a deleted story. complete stays false. Vendor deletion stays not-asserted. This is not a GDPR certification.
- Commands: python3 build.py; python3 deploy/cloudflare-edge/build_edge.py; python3 tests/privacy_delete_browser.py; a local Miniflare/workerd browser run of the bundled Worker with synthetic tenant tokens (local stand-ins only).

### Session: 2026-11-09 / delete confirmation lifetime and wording
- Parent is the delete confirmation corrections writer note (ba6f3bb8). Code commit 42782cf8; this note is the next forward commit on an unpublished local branch. No push, pull request, merge, deploy, live data, provider call, or provider deletion. No earlier commit was amended.
- Touched: src/journey-ui.js, tests/privacy_delete_browser.py, and the four rebuilt HTML aliases. All of deploy/cloudflare-edge is byte-identical to the parent.
- The pending delete and the last receipt are kept outside any one render or dialog. A re-render, or navigating away and back, keeps deletion disabled until the pending request settles, and the result appears in the current page. Before this change, two POSTs reached the handler and only the second, empty receipt was shown.
- A journey render that finishes after a newer render no longer replaces it. An empty deletion scope does not enable deletion. A new receipt replaces the previous one, so there are no duplicate ids. Focus moves to the receipt, or back to the opener after an error.
- The confirmation says Atlas will try to delete the listed stores. It says the receipt reports each store, a store that fails keeps its data, and only a direct merge target is kept.
- Still open, not implemented: the D3 extension, cleanup of older pointers and orphans, and server idempotency. complete stays false. Vendor deletion stays not-asserted. This is not a GDPR certification.
- Commands: python3 build.py; python3 deploy/cloudflare-edge/build_edge.py; python3 tests/privacy_delete_browser.py; a local Miniflare/workerd browser harness outside the repository, run on the bundled Worker with synthetic tenant tokens and a synthetic SQLite failure trigger (local stand-ins only).

### Session: 2026-11-09 / earlier receipt after a failed attempt
- Parent is the delete confirmation lifetime and wording note (e59fd725). Code commit 19591704; this note is the next forward commit on an unpublished local branch. No push, pull request, merge, deploy, CI change, live data, provider call, or provider deletion. No earlier commit was amended.
- Touched: src/journey-ui.js, tests/privacy_delete_browser.py, and the four rebuilt HTML aliases. All of deploy/cloudflare-edge is byte-identical to the parent.
- A failed delete after an earlier successful receipt no longer shows that receipt as if it were the latest result. It is titled Earlier deletion receipt and says it is not from the latest attempt, also after a re-render. The warning says the latest deletion request did not complete. A later success is shown as the current receipt again.
- Still open: the D3 extension, cleanup of older pointers and orphans, and server idempotency. complete stays false. Vendor deletion stays not-asserted.
- Commands: python3 build.py; python3 deploy/cloudflare-edge/build_edge.py; python3 tests/privacy_delete_browser.py; the existing local workerd receipt harness outside the repository, run on the bundled Worker.
