# QA report — ATLAS @ `02a83b320fdf635cdd8d603a54b791a3fef59152`

Read-only QA on **2026-11-19** (UTC). Synthetic data only; local `deploy/cloudflare-edge/dev/local-edge.mjs` (node:sqlite library stand-in, mocked AI/Access JWT via `?as=` + `idp` roles). No Entra, no deploy, no live providers, no microphone.

## Head binding
- **Commit:** `02a83b320fdf635cdd8d603a54b791a3fef59152`
- **Evidence branch:** `qa/main-02a83b32-full` (screenshots + this report only)
- **Report path:** `qa-evidence/main-02a83b32/QA-main-02a83b32.md`

## Roles exercised (from auth source)
| Role key | Entra / Access claims | `libraryRole` (edge bootstrap) | Fixture |
|---|---|---|---|
| Consultant / employee | `ATLAS.Interview` | `user` | `consultant@example.test`, `alex@mantu.com` via `?as=` |
| Trusted manager (N+1) | `ATLAS.Interview` + directory trust row | `user` (manager lane) | `manager@example.test` + `POST /__trust` in library tests |
| Pre-sales / bid | `ATLAS.Presales` / `ATLAS.Publish` | `presales` | `presales@example.test` + `idp` roles JSON |
| Reviewer | `ATLAS.Reviewer` / `ATLAS.Review` | `reviewer` | `rev@example.test` |
| Verified admin | `ATLAS.Admin` | `admin` | `admin@example.test` |
| External confirmer | Access external mailbox policy | `external` | `client@acme.example` in edge tests |
| Stranger (negative) | Interview role only, no grants | `user` | `stranger@example.test` |

Canonical mapping: `deploy/cloudflare-edge/src/authz.js`, persona chips `src/journey-ui.js:5-10`, local runner env `deploy/cloudflare-edge/dev/local-edge.mjs:88-89`.

## Automated suite counts (this run)
| Suite | Count | Fail | Log |
|---|---:|---:|---|
| Root `node --test tests/*.test.js` | 409 tests (408 pass, 1 skipped) | 0 | `logs/node-root.txt` |
| `pytest tests/test_*.py -q` | 308 passed | 0 | `logs/pytest.txt` |
| Edge `node --test deploy/cloudflare-edge/test/*.test.js` | 815 passed | 0 | `logs/test-edge.txt` |
| UI Playwright (`make test-ui` set) | 805 `PASS` lines + `csp_console_browser.py` (3 silent asserts, no stdout) | 0 (all scripts exit 0) | `logs/ui/*.txt` |
| `scripts/check_handoff.py .` | 11 checks: **1 FAIL** (`manifest-content` — tree differs from frozen `MANIFEST.json` after `build.py`); 10 PASS | 1 | `logs/check_handoff.txt` |
| Supplemental journey matrix (this QA) | 120 rows | 4 FAIL, remainder PASS/WARN/NOT_RUN/Info | `qa_matrix.json` |

**Combined automated checks (excluding supplemental matrix):** 408 + 308 + 815 + 805 = **2,336** passing checks (plus 1 skipped Node test).

## Top findings
1. **All primary regression suites green** at head `02a83b32` under local mocked edge — no pytest, edge, or UI script failures.
2. **High — Admin denial via `/#admin` deep link (consultant):** Opening `/#admin` as a non-admin does not surface the verified-admin refusal copy tested in `admin_metrics_browser.py` (which reaches admin through the gated nav). Supplemental repro failed desktop + mobile; screenshots `screenshots/admin-denied_consultant_*.png`. Expected text per `src/journey-ui.js:84`.
3. **Medium — “Empty interview” sentinel on edge:** A brand-new `?as=` identity on the edge deployment shows the zero-config “Ready” conversation chrome (`zero_config_edge` PASS) rather than `#emptyInterview` (`src/app.js:53`). Supplemental empty-state probe failed; may be spec/UI drift, not a functional blocker.
4. **Info — `check_handoff` manifest drift:** Validating the live tree after `build.py` reports changed compiled HTML vs manifest; use packaged release verification separately.

## What was NOT RUN (and why)
- **Live Microsoft Entra sign-in / role revocation:** Hard rule: no live Entra; local JWT via `?as=` + `idp` only.
- **Cloudflare Workers deploy or production Worker:** Hard rule: local `local-edge.mjs` only (node:sqlite, not workerd).
- **Azure / tunnel / Access production:** Hard rule: no cloud deploy.
- **Real OpenAI / Kyutai / PersonaPlex / Workers AI voice:** Hard rule: mocked `fake-model.mjs` / browser adapters; no mic.
- **Python aiohttp gateway live voice session:** Out of scope for edge-first QA path; pytest uses fixtures only.
- **GPU PersonaPlex native interoperability:** BLOCKED_EXTERNAL — no GPU worker in agent VM.
- **Teams bot, phone outreach, client SMS:** BLOCKED_EXTERNAL per `WOW_SPEC` / README.
- **Graphify export to external graph DB:** Optional consumer; not installed.
- **Entra `IDENTITY_SOURCE=entra` end-to-end browser:** Built but not enabled in local runner (`entra/README.md`).
- **Physical device 320px touch audio orb:** Playwright emulated mobile width only.

## Pass/fail matrix (supplemental browser journeys)

Sorted **High → Medium → Low → Info**. Studio/intelligence/depth/WOW depth remain covered by the UI suite above; this matrix adds **per-surface navigation** on local edge for every role at **1280×800** and **320×800** with full-page screenshots (`92` files under `screenshots/`).

### High

| Feature | Role | Viewport | Status | Ref | Screenshot | Repro (summary) |
|---|---|---|---|---|---|---|
| admin_denied | consultant | desktop | **FAIL** | `src/journey-ui.js:84` | `screenshots/admin-denied_consultant_desktop.png` | As consultant@example.test; Open /#admin; Expect denial banner in #admin |
| admin_denied | consultant | mobile | **FAIL** | `src/journey-ui.js:84` | `screenshots/admin-denied_consultant_mobile.png` | As consultant@example.test; Open /#admin; Expect denial banner in #admin |
| admin_metrics_api | consultant | desktop | **PASS** | `deploy/cloudflare-edge/src/library-routes.js` | `—` | As consultant; GET /api/library/admin/metrics; Expect 403 or empty denial in UI |
| admin_metrics_api | consultant | mobile | **PASS** | `deploy/cloudflare-edge/src/library-routes.js` | `—` | As consultant; GET /api/library/admin/metrics; Expect 403 or empty denial in UI |
| admin_nav_hidden | consultant | desktop | **PASS** | — | `—` | As consultant@example.test; Confirm #adminNav hidden |
| admin_nav_hidden | consultant | mobile | **PASS** | — | `—` | As consultant@example.test; Confirm #adminNav hidden |
| admin_nav_hidden | employee | desktop | **PASS** | — | `—` | As alex@mantu.com; Confirm #adminNav hidden |
| admin_nav_hidden | employee | mobile | **PASS** | — | `—` | As alex@mantu.com; Confirm #adminNav hidden |
| admin_nav_hidden | manager | desktop | **PASS** | — | `—` | As manager@example.test; Confirm #adminNav hidden |
| admin_nav_hidden | manager | mobile | **PASS** | — | `—` | As manager@example.test; Confirm #adminNav hidden |
| admin_nav_hidden | plain_denied | desktop | **PASS** | — | `—` | As stranger@example.test; Confirm #adminNav hidden |
| admin_nav_hidden | plain_denied | mobile | **PASS** | — | `—` | As stranger@example.test; Confirm #adminNav hidden |
| admin_nav_hidden | presales | desktop | **PASS** | — | `—` | As presales@example.test; Confirm #adminNav hidden |
| admin_nav_hidden | presales | mobile | **PASS** | — | `—` | As presales@example.test; Confirm #adminNav hidden |
| admin_nav_hidden | reviewer | desktop | **PASS** | — | `—` | As rev@example.test; Confirm #adminNav hidden |
| admin_nav_hidden | reviewer | mobile | **PASS** | — | `—` | As rev@example.test; Confirm #adminNav hidden |
| surface_admin | admin | desktop | **PASS** | — | `screenshots/admin_admin_desktop.png` | As admin@example.test (admin); Navigate to admin; Viewport 1280×800… |
| surface_admin | admin | mobile | **PASS** | — | `screenshots/admin_admin_mobile.png` | As admin@example.test (admin); Navigate to admin; Viewport 320×800… |
| surface_interview | admin | desktop | **PASS** | — | `screenshots/interview_admin_desktop.png` | As admin@example.test (admin); Navigate to interview; Viewport 1280×800… |
| surface_interview | admin | mobile | **PASS** | — | `screenshots/interview_admin_mobile.png` | As admin@example.test (admin); Navigate to interview; Viewport 320×800… |
| surface_interview | consultant | desktop | **PASS** | — | `screenshots/interview_consultant_desktop.png` | As consultant@example.test (consultant); Navigate to interview; Viewport 1280×800… |
| surface_interview | consultant | mobile | **PASS** | — | `screenshots/interview_consultant_mobile.png` | As consultant@example.test (consultant); Navigate to interview; Viewport 320×800… |
| surface_interview | employee | desktop | **PASS** | — | `screenshots/interview_employee_desktop.png` | As alex@mantu.com (employee); Navigate to interview; Viewport 1280×800… |
| surface_interview | employee | mobile | **PASS** | — | `screenshots/interview_employee_mobile.png` | As alex@mantu.com (employee); Navigate to interview; Viewport 320×800… |
| surface_interview | manager | desktop | **PASS** | — | `screenshots/interview_manager_desktop.png` | As manager@example.test (manager); Navigate to interview; Viewport 1280×800… |
| surface_interview | manager | mobile | **PASS** | — | `screenshots/interview_manager_mobile.png` | As manager@example.test (manager); Navigate to interview; Viewport 320×800… |
| surface_interview | plain_denied | desktop | **PASS** | — | `screenshots/interview_plain-denied_desktop.png` | As stranger@example.test (plain_denied); Navigate to interview; Viewport 1280×800… |
| surface_interview | plain_denied | mobile | **PASS** | — | `screenshots/interview_plain-denied_mobile.png` | As stranger@example.test (plain_denied); Navigate to interview; Viewport 320×800… |
| surface_interview | presales | desktop | **PASS** | — | `screenshots/interview_presales_desktop.png` | As presales@example.test (presales); Navigate to interview; Viewport 1280×800… |
| surface_interview | presales | mobile | **PASS** | — | `screenshots/interview_presales_mobile.png` | As presales@example.test (presales); Navigate to interview; Viewport 320×800… |
| surface_interview | reviewer | desktop | **PASS** | — | `screenshots/interview_reviewer_desktop.png` | As rev@example.test (reviewer); Navigate to interview; Viewport 1280×800… |
| surface_interview | reviewer | mobile | **PASS** | — | `screenshots/interview_reviewer_mobile.png` | As rev@example.test (reviewer); Navigate to interview; Viewport 320×800… |
| surface_journey | admin | desktop | **PASS** | — | `screenshots/journey_admin_desktop.png` | As admin@example.test (admin); Navigate to journey; Viewport 1280×800… |
| surface_journey | admin | mobile | **PASS** | — | `screenshots/journey_admin_mobile.png` | As admin@example.test (admin); Navigate to journey; Viewport 320×800… |
| surface_journey | consultant | desktop | **PASS** | — | `screenshots/journey_consultant_desktop.png` | As consultant@example.test (consultant); Navigate to journey; Viewport 1280×800… |
| surface_journey | consultant | mobile | **PASS** | — | `screenshots/journey_consultant_mobile.png` | As consultant@example.test (consultant); Navigate to journey; Viewport 320×800… |
| surface_journey | employee | desktop | **PASS** | — | `screenshots/journey_employee_desktop.png` | As alex@mantu.com (employee); Navigate to journey; Viewport 1280×800… |
| surface_journey | employee | mobile | **PASS** | — | `screenshots/journey_employee_mobile.png` | As alex@mantu.com (employee); Navigate to journey; Viewport 320×800… |
| surface_journey | manager | desktop | **PASS** | — | `screenshots/journey_manager_desktop.png` | As manager@example.test (manager); Navigate to journey; Viewport 1280×800… |
| surface_journey | manager | mobile | **PASS** | — | `screenshots/journey_manager_mobile.png` | As manager@example.test (manager); Navigate to journey; Viewport 320×800… |
| surface_journey | plain_denied | desktop | **PASS** | — | `screenshots/journey_plain-denied_desktop.png` | As stranger@example.test (plain_denied); Navigate to journey; Viewport 1280×800… |
| surface_journey | plain_denied | mobile | **PASS** | — | `screenshots/journey_plain-denied_mobile.png` | As stranger@example.test (plain_denied); Navigate to journey; Viewport 320×800… |
| surface_journey | presales | desktop | **PASS** | — | `screenshots/journey_presales_desktop.png` | As presales@example.test (presales); Navigate to journey; Viewport 1280×800… |
| surface_journey | presales | mobile | **PASS** | — | `screenshots/journey_presales_mobile.png` | As presales@example.test (presales); Navigate to journey; Viewport 320×800… |
| surface_journey | reviewer | desktop | **PASS** | — | `screenshots/journey_reviewer_desktop.png` | As rev@example.test (reviewer); Navigate to journey; Viewport 1280×800… |
| surface_journey | reviewer | mobile | **PASS** | — | `screenshots/journey_reviewer_mobile.png` | As rev@example.test (reviewer); Navigate to journey; Viewport 320×800… |
| surface_library | admin | desktop | **PASS** | — | `screenshots/library_admin_desktop.png` | As admin@example.test (admin); Navigate to library; Viewport 1280×800… |
| surface_library | admin | mobile | **PASS** | — | `screenshots/library_admin_mobile.png` | As admin@example.test (admin); Navigate to library; Viewport 320×800… |
| surface_library | consultant | desktop | **PASS** | — | `screenshots/library_consultant_desktop.png` | As consultant@example.test (consultant); Navigate to library; Viewport 1280×800… |
| surface_library | consultant | mobile | **PASS** | — | `screenshots/library_consultant_mobile.png` | As consultant@example.test (consultant); Navigate to library; Viewport 320×800… |
| surface_library | employee | desktop | **PASS** | — | `screenshots/library_employee_desktop.png` | As alex@mantu.com (employee); Navigate to library; Viewport 1280×800… |
| surface_library | employee | mobile | **PASS** | — | `screenshots/library_employee_mobile.png` | As alex@mantu.com (employee); Navigate to library; Viewport 320×800… |
| surface_library | manager | desktop | **PASS** | — | `screenshots/library_manager_desktop.png` | As manager@example.test (manager); Navigate to library; Viewport 1280×800… |
| surface_library | manager | mobile | **PASS** | — | `screenshots/library_manager_mobile.png` | As manager@example.test (manager); Navigate to library; Viewport 320×800… |
| surface_library | plain_denied | desktop | **PASS** | — | `screenshots/library_plain-denied_desktop.png` | As stranger@example.test (plain_denied); Navigate to library; Viewport 1280×800… |
| surface_library | plain_denied | mobile | **PASS** | — | `screenshots/library_plain-denied_mobile.png` | As stranger@example.test (plain_denied); Navigate to library; Viewport 320×800… |
| surface_library | presales | desktop | **PASS** | — | `screenshots/library_presales_desktop.png` | As presales@example.test (presales); Navigate to library; Viewport 1280×800… |
| surface_library | presales | mobile | **PASS** | — | `screenshots/library_presales_mobile.png` | As presales@example.test (presales); Navigate to library; Viewport 320×800… |
| surface_library | reviewer | desktop | **PASS** | — | `screenshots/library_reviewer_desktop.png` | As rev@example.test (reviewer); Navigate to library; Viewport 1280×800… |
| surface_library | reviewer | mobile | **PASS** | — | `screenshots/library_reviewer_mobile.png` | As rev@example.test (reviewer); Navigate to library; Viewport 320×800… |
| surface_projects | admin | desktop | **PASS** | — | `screenshots/projects_admin_desktop.png` | As admin@example.test (admin); Navigate to projects; Viewport 1280×800… |
| surface_projects | admin | mobile | **PASS** | — | `screenshots/projects_admin_mobile.png` | As admin@example.test (admin); Navigate to projects; Viewport 320×800… |
| surface_projects | consultant | desktop | **PASS** | — | `screenshots/projects_consultant_desktop.png` | As consultant@example.test (consultant); Navigate to projects; Viewport 1280×800… |
| surface_projects | consultant | mobile | **PASS** | — | `screenshots/projects_consultant_mobile.png` | As consultant@example.test (consultant); Navigate to projects; Viewport 320×800… |
| surface_projects | employee | desktop | **PASS** | — | `screenshots/projects_employee_desktop.png` | As alex@mantu.com (employee); Navigate to projects; Viewport 1280×800… |
| surface_projects | employee | mobile | **PASS** | — | `screenshots/projects_employee_mobile.png` | As alex@mantu.com (employee); Navigate to projects; Viewport 320×800… |
| surface_projects | manager | desktop | **PASS** | — | `screenshots/projects_manager_desktop.png` | As manager@example.test (manager); Navigate to projects; Viewport 1280×800… |
| surface_projects | manager | mobile | **PASS** | — | `screenshots/projects_manager_mobile.png` | As manager@example.test (manager); Navigate to projects; Viewport 320×800… |
| surface_projects | plain_denied | desktop | **PASS** | — | `screenshots/projects_plain-denied_desktop.png` | As stranger@example.test (plain_denied); Navigate to projects; Viewport 1280×800… |
| surface_projects | plain_denied | mobile | **PASS** | — | `screenshots/projects_plain-denied_mobile.png` | As stranger@example.test (plain_denied); Navigate to projects; Viewport 320×800… |
| surface_projects | presales | desktop | **PASS** | — | `screenshots/projects_presales_desktop.png` | As presales@example.test (presales); Navigate to projects; Viewport 1280×800… |
| surface_projects | presales | mobile | **PASS** | — | `screenshots/projects_presales_mobile.png` | As presales@example.test (presales); Navigate to projects; Viewport 320×800… |
| surface_projects | reviewer | desktop | **PASS** | — | `screenshots/projects_reviewer_desktop.png` | As rev@example.test (reviewer); Navigate to projects; Viewport 1280×800… |
| surface_projects | reviewer | mobile | **PASS** | — | `screenshots/projects_reviewer_mobile.png` | As rev@example.test (reviewer); Navigate to projects; Viewport 320×800… |
| surface_stories | admin | desktop | **PASS** | — | `screenshots/stories_admin_desktop.png` | As admin@example.test (admin); Navigate to stories; Viewport 1280×800… |
| surface_stories | admin | mobile | **PASS** | — | `screenshots/stories_admin_mobile.png` | As admin@example.test (admin); Navigate to stories; Viewport 320×800… |
| surface_stories | consultant | desktop | **PASS** | — | `screenshots/stories_consultant_desktop.png` | As consultant@example.test (consultant); Navigate to stories; Viewport 1280×800… |
| surface_stories | consultant | mobile | **PASS** | — | `screenshots/stories_consultant_mobile.png` | As consultant@example.test (consultant); Navigate to stories; Viewport 320×800… |
| surface_stories | employee | desktop | **PASS** | — | `screenshots/stories_employee_desktop.png` | As alex@mantu.com (employee); Navigate to stories; Viewport 1280×800… |
| surface_stories | employee | mobile | **PASS** | — | `screenshots/stories_employee_mobile.png` | As alex@mantu.com (employee); Navigate to stories; Viewport 320×800… |
| surface_stories | manager | desktop | **PASS** | — | `screenshots/stories_manager_desktop.png` | As manager@example.test (manager); Navigate to stories; Viewport 1280×800… |
| surface_stories | manager | mobile | **PASS** | — | `screenshots/stories_manager_mobile.png` | As manager@example.test (manager); Navigate to stories; Viewport 320×800… |
| surface_stories | plain_denied | desktop | **PASS** | — | `screenshots/stories_plain-denied_desktop.png` | As stranger@example.test (plain_denied); Navigate to stories; Viewport 1280×800… |
| surface_stories | plain_denied | mobile | **PASS** | — | `screenshots/stories_plain-denied_mobile.png` | As stranger@example.test (plain_denied); Navigate to stories; Viewport 320×800… |
| surface_stories | presales | desktop | **PASS** | — | `screenshots/stories_presales_desktop.png` | As presales@example.test (presales); Navigate to stories; Viewport 1280×800… |
| surface_stories | presales | mobile | **PASS** | — | `screenshots/stories_presales_mobile.png` | As presales@example.test (presales); Navigate to stories; Viewport 320×800… |
| surface_stories | reviewer | desktop | **PASS** | — | `screenshots/stories_reviewer_desktop.png` | As rev@example.test (reviewer); Navigate to stories; Viewport 1280×800… |
| surface_stories | reviewer | mobile | **PASS** | — | `screenshots/stories_reviewer_mobile.png` | As rev@example.test (reviewer); Navigate to stories; Viewport 320×800… |

### Medium

| Feature | Role | Viewport | Status | Ref | Screenshot | Repro (summary) |
|---|---|---|---|---|---|---|
| interview_empty | consultant | desktop | **FAIL** | `src/app.js:53` | `screenshots/interview-empty_fresh_desktop.png` | New synthetic user; Open Conversation; Expect #emptyInterview visible |
| interview_empty | consultant | mobile | **FAIL** | `src/app.js:53` | `screenshots/interview-empty_fresh_mobile.png` | New synthetic user; Open Conversation; Expect #emptyInterview visible |
| project_form_required | consultant | desktop | **PASS** | `src/app.js:423` | `screenshots/project-invalid_desktop.png` | Open new project dialog; Submit empty form; HTML5 validation blocks submit |
| project_form_required | consultant | mobile | **PASS** | `src/app.js:423` | `screenshots/project-invalid_mobile.png` | Open new project dialog; Submit empty form; HTML5 validation blocks submit |
| surface_bids | admin | desktop | **PASS** | — | `screenshots/bids_admin_desktop.png` | As admin@example.test (admin); Navigate to bids; Viewport 1280×800… |
| surface_bids | admin | mobile | **PASS** | — | `screenshots/bids_admin_mobile.png` | As admin@example.test (admin); Navigate to bids; Viewport 320×800… |
| surface_bids | consultant | desktop | **PASS** | — | `screenshots/bids_consultant_desktop.png` | As consultant@example.test (consultant); Navigate to bids; Viewport 1280×800… |
| surface_bids | consultant | mobile | **PASS** | — | `screenshots/bids_consultant_mobile.png` | As consultant@example.test (consultant); Navigate to bids; Viewport 320×800… |
| surface_bids | employee | desktop | **PASS** | — | `screenshots/bids_employee_desktop.png` | As alex@mantu.com (employee); Navigate to bids; Viewport 1280×800… |
| surface_bids | employee | mobile | **PASS** | — | `screenshots/bids_employee_mobile.png` | As alex@mantu.com (employee); Navigate to bids; Viewport 320×800… |
| surface_bids | manager | desktop | **PASS** | — | `screenshots/bids_manager_desktop.png` | As manager@example.test (manager); Navigate to bids; Viewport 1280×800… |
| surface_bids | manager | mobile | **PASS** | — | `screenshots/bids_manager_mobile.png` | As manager@example.test (manager); Navigate to bids; Viewport 320×800… |
| surface_bids | plain_denied | desktop | **PASS** | — | `screenshots/bids_plain-denied_desktop.png` | As stranger@example.test (plain_denied); Navigate to bids; Viewport 1280×800… |
| surface_bids | plain_denied | mobile | **PASS** | — | `screenshots/bids_plain-denied_mobile.png` | As stranger@example.test (plain_denied); Navigate to bids; Viewport 320×800… |
| surface_bids | presales | desktop | **PASS** | — | `screenshots/bids_presales_desktop.png` | As presales@example.test (presales); Navigate to bids; Viewport 1280×800… |
| surface_bids | presales | mobile | **PASS** | — | `screenshots/bids_presales_mobile.png` | As presales@example.test (presales); Navigate to bids; Viewport 320×800… |
| surface_bids | reviewer | desktop | **PASS** | — | `screenshots/bids_reviewer_desktop.png` | As rev@example.test (reviewer); Navigate to bids; Viewport 1280×800… |
| surface_bids | reviewer | mobile | **PASS** | — | `screenshots/bids_reviewer_mobile.png` | As rev@example.test (reviewer); Navigate to bids; Viewport 320×800… |

### Info

| Feature | Role | Viewport | Status | Ref | Screenshot | Repro (summary) |
|---|---|---|---|---|---|---|
| bootstrap | admin | desktop | **PASS** | — | `—` | Open /?as=admin@example.test; libraryRole=admin |
| bootstrap | admin | mobile | **PASS** | — | `—` | Open /?as=admin@example.test; libraryRole=admin |
| bootstrap | consultant | desktop | **PASS** | — | `—` | Open /?as=consultant@example.test; libraryRole=user |
| bootstrap | consultant | mobile | **PASS** | — | `—` | Open /?as=consultant@example.test; libraryRole=user |
| bootstrap | employee | desktop | **PASS** | — | `—` | Open /?as=alex@mantu.com; libraryRole=user |
| bootstrap | employee | mobile | **PASS** | — | `—` | Open /?as=alex@mantu.com; libraryRole=user |
| bootstrap | manager | desktop | **PASS** | — | `—` | Open /?as=manager@example.test; libraryRole=user |
| bootstrap | manager | mobile | **PASS** | — | `—` | Open /?as=manager@example.test; libraryRole=user |
| bootstrap | plain_denied | desktop | **PASS** | — | `—` | Open /?as=stranger@example.test; libraryRole=user |
| bootstrap | plain_denied | mobile | **PASS** | — | `—` | Open /?as=stranger@example.test; libraryRole=user |
| bootstrap | presales | desktop | **PASS** | — | `—` | Open /?as=presales@example.test; libraryRole=presales |
| bootstrap | presales | mobile | **PASS** | — | `—` | Open /?as=presales@example.test; libraryRole=presales |
| bootstrap | reviewer | desktop | **PASS** | — | `—` | Open /?as=rev@example.test; libraryRole=reviewer |
| bootstrap | reviewer | mobile | **PASS** | — | `—` | Open /?as=rev@example.test; libraryRole=reviewer |

## UI suite feature coverage (regression)

- **Interview / voice UX:** `studio, sculpture, orb_touch, autosave, autosave_chain, refusal, wow_edge, zero_config, zero_config_edge`
- **Studio authoring:** `studio, depth, report, sheet, storyboard, intelligence`
- **Library / journey / roles:** `library, reuse, trust, jev_rating, admin_metrics`
- **WOW modules:** `bids, ask, confirm, wow_edge, trust`
- **Admin / metrics / CSP:** `admin_metrics, csp_console, audit_marker`
- **Memory / Hindsight (mocked):** `memory`

## Integrity

`sha256sum -c SHA256SUMS` from `qa-evidence/main-02a83b32/`.

## Environment notes
- Chromium: Playwright build 1255 (headless).
- Local edge: `FAKE_TYPESAFE=1` for JEV-rated paths in supplemental run.
- No secrets, tokens, or customer content appear in logs or screenshots.