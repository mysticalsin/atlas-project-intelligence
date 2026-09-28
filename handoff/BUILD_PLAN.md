# Ordered build plan for Claude
Do not rewrite completed components just to check a box. Each work package starts by inspecting the named source and ends with evidence. Keep the existing architecture until a measured need justifies more.

## 0 — Reproduce and understand the baseline
**Inputs:** `CLAUDE.md`, current status, code map, compiled HTML and test report.

Run `scripts/check_handoff.py` before changes, `scripts/doctor.py --profile preview`, the standard-library build, full Node/Python tests and all four browser scripts. View the supplied screenshots beside a real rendered page. Save logs under a fresh `handoff/verification/local-<date>/` directory rather than overwriting the received evidence.

**Done:** build produces all four identical aliases, preserved logo hash matches, local suites pass or each failure has a reproducible regression issue. Record environment versions and distinguish fixture/native tests. No provider calls needed.

## 1 — Run one real conversational voice path
**Source:** `atlas_voice/config.py`, `server.py`, `realtime.py`, `quality.py`, `src/voice-client.js`, `voice-worklet.js`.

Start with the operator-approved provider. `.env.example` selects hosted Realtime. Confirm the current API contract and account access before an authorized synthetic call. Preserve NVIDIA as an alternative; install a private GPU worker only when selected. Use the gateway-served page, not the preview server.

Test start consent, first spoken question, an open answer, silence, interruption/correction, mute while the agent speaks, End while connecting, End while speaking, permission denial, network loss and session expiry. The orb must use played output energy and clear its speaking state when playback stops. Never substitute browser TTS, a test tone, synthetic transcript or timer for actual model behavior.

**Done:** a sanitized live-test record identifies selected provider/model, browser/device, actual spoken exchange, latency observations and interruption outcome. The client releases mic tracks and audio resources on every exit. No credentials in HTML/logs. Without credentials, keep this `BLOCKED_EXTERNAL` and continue other work.

## 2 — Make the interview demonstrably useful
**Source:** `quality.py` (`InterviewLedger`, policy, tools, `plan_probe`), `interview.py`, intelligence UI; `docs/EVALUATION_v12.md`.

Use the existing twelve dimensions behind six editing topics. Test vague percentages, “we did it”, no baseline, assessment-only work, adoption failure, conflicting numbers, confidentiality, long pauses and a returning consultant. Recover a concrete before/after mechanism even when measurement is unavailable. Ask the highest-value missing question rather than reading a sequence. Limit repeated unproductive probes; accept and preserve unknowns.

Check source item IDs, exact ASR quote membership, superseded claims and gaps. Never let the agent call review/publication or private-memory writes. Validate that microphone transcript and agent transcript remain separate and that explicit notes application does not overwrite unrelated project text.

**Done:** a delivery reviewer can identify what the consultant did, a meaningful trade-off, observed outcome, evidence owner/source, limitations, customer fit and poor fit—or see each missing item explicitly. Human evaluation finds no invented critical fact in the accepted test cases. The number of completed questions is not the success metric.

## 3 — Validate identity and private memory
**Source:** `identity.py`, `memory.py`, `knowledge_routes.py`; pinned fork in `docs/SOURCE_LOCK.json`.

Configure the actual Entra app and tenant, exact callback, required role and server secrets. Deploy the reviewed Hindsight fork or an explicitly approved equivalent fork endpoint; record the exact commit and SDK lock. Test distinct real test users A and B. Save, recall, replace and delete A's continuity; prove B cannot read it. A manager/reviewer role must not automatically grant private-bank access.

Keep recall bounded, optional for each consented session and untrusted as instruction data. Verify offline/unavailable Hindsight produces an honest warning rather than fake memory. Explicitly document deletion scope and source-retention policy. Test logout/session expiry during a voice connection and current role-revocation behavior.

**Done:** per-user isolation and native SDK operations are evidenced, no browser bank selector exists, and private memory never appears in story evidence by default. Use synthetic/non-confidential test context only.

## 4 — Complete the Markdown/review path before customer reuse
**Source:** `wiki.py`, `wiki_export.py`, `knowledge_routes.py`, `intelligence-ui.js`, optional `editor.py`; `docs/WIKI_SCHEMA.md`.

Persist one eight-section candidate to a private durable vault. Reload it after a gateway restart. Grant a real independently authorized reviewer access via the existing operator tool. Confirm author self-review is rejected. Record fact review and the intended audience's permission against the exact content hash, then edit the record and prove a new revision requires review again.

Test concurrent stale saves, withdrawal, permission expiry, tampered Markdown, cross-user denial and a withdrawal/edit during editor/ranking requests. Backup and restore Markdown plus registry together. Graph and export must contain only current accessible eligible stories; snapshots cannot self-authorize reuse. Do not edit historical `.md` revisions directly.

**Done:** real server files and registry survive restart/restore; approved customer-anonymized variants follow actual authority; new/changed/withdrawn revisions cannot inherit an old eligible label. A qualitative story can pass with evidence without an ROI figure. Mandatory account/brand decisions stay with the authorized owners.

## 5 — Make matching useful; keep Graphify optional
**Source:** `jev.py`, ranking handler, `wiki_export.py`; `docs/EVALUATION_v12.md`.

With authorized TypeSafe access, compare eligible stories against explicit problem/buyer/constraints/desired-outcome briefs. Inspect the lexical shortlist before judging semantic results. Include direct-fit, similar-language-but-poor-fit, old-source, low-confidence and no-suitable-story cases. Preserve source/record hashes, poor-fit caveats and no-strong-match. Never rank consultant worth or reward a large unsupported number.

Calibrate the proposed weights against blind human judgements; record disagreements instead of changing thresholds to force recommendations. Apply access/eligibility checks immediately before outbound calls and again before returning the response.

When Graphify is explicitly enabled, consume only an authorized exported snapshot with an approved semantic provider. Verify its resolved package/commit and EXTRACTED versus INFERRED edges. Do not make it required for the native Markdown/wiki launch or expose the vault to a crawler.

**Done:** real JEV schema and no-match behavior are verified and calibration is documented. Optional Graphify execution has its own evidence or remains accurately labelled unexecuted.

## 6 — Release a bounded pilot, not a fictional enterprise rollout
Run the complete tests again, perform native browser scenarios, and evaluate the live interview with a delivery reviewer and a customer-facing reviewer. Configure private durable storage, HTTPS proxy, websocket support, data-redacted logs, server secrets and an operator rollback/restore procedure. Confirm one-process/one-interview constraint and what happens to in-memory sessions on restart.

**Done:** all mandatory acceptance rows in `handoff/ACCEPTANCE.md` are evidenced for the selected scope; live dependencies and authorized data policy are recorded. Produce updated source ZIP, rebuilt HTML, sanitized environment template, dependency lock, test report, remaining limitations and exact run/rollback commands. Obtain actual deployment/publication authorization; do not push or go live merely because code compiles.

## Session continuation
Update `handoff/BUILD_STATUS.md` after each coherent change. Record the next exact command/task, tests run, touched files, pending decisions and external blockers. Do not leave secret values or raw client transcripts in handoff notes. A later Claude session should be able to resume from that file plus `CLAUDE.md`.
