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
2. **Low / UX (triage) — `/#admin` deep link (consultant):** The hash does not switch views (`openFromHash` has no `#admin` handler), so the user stays on **Conversation** with an empty hidden `#admin` section—no refusal banner. **No admin metrics in DOM or network on load**; explicit `fetch` to admin APIs returns **403**. Gated navigation (`adminNav.click()` → `renderAdmin`) shows the refusal copy **without** calling metrics first. See **TRIAGE §1**.
3. **Test-expectation error (triage) — `#emptyInterview` on live edge:** On edge/zero-config, the intentional empty state is the **page intro + voice “Ready”** chrome, not the welcome card. `#emptyInterview` stays in the DOM but is **not shown** (`body.studio-view` + `orb.css`). Official suites: `zero_config_edge` / `WOW_ZERO_CONFIG.md` §3.8. See **TRIAGE §2**.
4. **Info — `check_handoff` manifest drift:** Validating the live tree after `build.py` reports changed compiled HTML vs manifest; use packaged release verification separately.
5. **Info — Edge count vs PR #9:** This head runs **815** edge tests (0 skipped). PR #9 (`cursor/atlas-write-chokepoint`, draft) reports **1027** with workerd (+ **4** skipped only when workerd is absent). Delta is PR9’s write-path / SQL-door suites—not a skipped suite on `02a83b32`. See **TRIAGE §3**.

## TRIAGE (read-only follow-up)

Evidence: `triage/admin_hash_evidence.json`, `triage/hash_admin.png`, `triage/hash_admin_navclick.png`, `triage/fresh_interview.png`.

### 1. Consultant loads `/#admin` — **severity: Low / UX** (not data exposure)

**What actually renders**

| Signal | `...#admin` (deep link only) | After `adminNav.click()` (gated path, matches `admin_metrics_browser.py:73–79`) |
|---|---|---|
| Active workspace view | **Conversation** (`#interview`, nav `interview` active) | **Admin** (`#admin` visible, nav `admin` active) |
| `#adminNav` | `hidden: true`, not visible | Still hidden for consultant, but click is programmatically allowed in tests |
| `#admin` section | `hidden: true`, `innerHTML` length **0**, no children | `hidden: false`, heading **Admin** + warning pill |
| Refusal copy (`journey-ui.js:84`) | **Absent** — `renderAdmin()` never runs | **Present:** `This dashboard is only for a verified admin. The API refuses everyone else.` |
| Metric cards / export / charts | **None** (`.metric-grid` count 0) | **None** (denied branch returns before `load()`) |

**DOM snippets (consultant, `ATLAS.Interview`, local edge)**

Deep link only — user sees Conversation chrome; admin panel is an empty hidden sibling:

```text
#interview  hidden=false  (activeView)
  page-intro: "Ready" / "No project selected" / zero-config voice chrome
#admin      hidden=true   innerText=""
#adminNav   hidden=true
location.hash = "#admin"   (hash is not consumed)
```

Gated `adminNav.click()` — same user, refusal without metrics shell:

```text
#admin      hidden=false  innerText:
  Admin

  This dashboard is only for a verified admin. The API refuses everyone else.
```

**Network after navigation**

`/#admin` load (consultant) — API requests observed (no admin routes):

| Method | URL | Status |
|---|---|---:|
| GET | `/api/bootstrap` | 200 |
| GET | `/api/library/profile` | 200 |
| GET | `/api/library` | 200 |
| GET | `/api/library/<id>` | 200 (×2, seeded synthetic refs for this persona) |

**No** `GET /api/library/admin/metrics` or `/api/library/admin/export` on this path.

Explicit probe from the same signed-in page (supplemental):

| Method | Path | Status | Body (truncated) |
|---|---|---:|---|
| GET | `/api/library/admin/metrics` | **403** | `{"error":"The admin dashboard is only for a verified admin."}` |
| GET | `/api/library/admin/export` | **403** | same |

Server gate: `deploy/cloudflare-edge/src/operate.js` (`user.role !== 'admin'` → 403).

**Why `admin_metrics_browser.py` passes but `/#admin` fails the supplemental matrix**

- The browser test uses **mocked** `bootInfo` and forces `document.getElementById('adminNav').click()`, which calls `switchView('admin')` → `AtlasJourney.render('admin')` → `renderAdmin()` → `adminMetricsTransition` **denied** at boot (`libraryRole !== 'admin'`) **before** any metrics `fetch` (`src/admin-metrics-machine.js:44–47`; `admin_metrics_browser.py:73–79` asserts `HELD` length unchanged).
- `openFromHash()` only handles `#library/…`, `#invitation/…`, `#bid|gap/…` — **not** `#admin` (`src/app.js:362–370`). The hash is therefore inert for admin; supplemental failure was **missing refusal copy on an unsupported deep link**, not missing authz on the API.

**Verdict:** No admin data in DOM or passive network on `/#admin`. APIs refuse 403 when called. **Regrade original “High” finding → Low / UX** (optional: wire `#admin` to `switchView('admin')` or strip hash).

### 2. `interview_empty` / `#emptyInterview` on edge — **test-expectation error** (not a product bug on this path)

**Observed for `freshuser@example.test` (no local projects)**

- **Visible UX:** Conversation `#interview` with zero-config copy: pill **Ready**, **No project selected**, Start/consent flow (`triage/fresh_interview.png`; matches `tests/zero_config_edge.py` PASS: *“fresh user: no project yet”*, *“pill reads Ready”*).
- **`#emptyInterview`:** In DOM with `hidden=false` but **`offsetParent === null`** (not painted). Root cause: compiled pages use `body.studio-view` and `src/orb.css:9`:

  `.studio-view #emptyInterview { display: none !important; }`

- **`renderInterview()`** (`src/app.js:53`) still toggles the `hidden` attribute for gateway/offline semantics, but CSS overrides display on this shell.
- **Spec:** `docs/WOW_ZERO_CONFIG.md` §3.8 — live mode removes gateway setup text on `#emptyInterview`; §5 / acceptance rows require **no setup text**, **Ready** pill, consent-at-Start — not the legacy welcome card.

**Verdict:** On edge/live, **`#emptyInterview` is not the designated empty state**; zero-config intro + voice panel is. Supplemental matrix FAIL rows are **false positives** vs `zero_config_edge` / WOW spec. **Not classified as a regression at `02a83b32`.** (`#emptyInterview` remains relevant for offline/gateway-only contexts without `studio-view` suppression, e.g. some `set_content` UI tests.)

### 3. Edge tests **815** here vs **1027** on PR #9

| Context | Command | pass | fail | skipped |
|---|---|---:|---:|---:|
| **This QA (`02a83b32`)** | `cd deploy/cloudflare-edge && node --test test/*.test.js` | **815** | 0 | **0** |
| **PR #9 head** (`dd87761f`, per [PR #9](https://github.com/mysticalsin/atlas-project-intelligence/pull/9) body) | Edge with **workerd** binary installed | **1027** | 0 | **0** |
| **PR #9** (same, no workerd) | `ATLAS_WORKERD_ROOT` unset / missing | **1023** | 0 | **4** (workerd-only cases) |

**Explanation**

- **Δ ≈ 212 tests** on PR #9 branch `cursor/atlas-write-chokepoint` vs `main` at `02a83b32`.
- `git diff --diff-filter=A 02a83b32..origin/cursor/atlas-write-chokepoint -- deploy/cloudflare-edge/test` adds **48 files**, including the `write-v8-door`, `write-v9-door`, `write-v10-door`, `write-v11-verb`, `write-sql-gate`, `write-recorded-guard`, … family from PR #9 (“write-path chokepoint”).
- Those files **do not exist** on `02a83b32`; this run did **not** omit them — they are simply not in the tree yet.
- On `02a83b32`, the edge suite completed with **zero skipped** (no workerd harness on this branch).

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