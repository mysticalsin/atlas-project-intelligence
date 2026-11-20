# Plan: build generated files and pages in the pipeline (R1+R2)

Plan phase only. This file is the only change. No product code, no pipeline code, no deploy, no secret, no edit to a workflow timeout, and no Cloudflare setting.

Base of this plan: `main` `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec` (merge of PR #14).

Tony approved the direction of R1 and R2. Coding starts after the debate on the questions below, and after pull requests #15–#21 have merged. Each implementation PR is still its own gate. This document does not merge them.

## Scope fence

R1 is `MANIFEST.json` and `handoff/BUILD_STATUS.md`. R2 is the four HTML aliases and `deploy/cloudflare-edge/generated/PAGE_SHA256.txt`. `deploy/cloudflare-edge/src/csp.generated.js` is written by the same `build.py` run as the pages. This plan puts it in the R2 cutover. Question 1 asks the debate to strike it if it should stay committed.

Left where they are:

- `deploy/cloudflare-edge/src/policy.generated.js`. Another generator (`deploy/cloudflare-edge/build_edge.py:37-49`). CI already fails a stale copy (`.github/workflows/ci.yml:24-25`).
- `deploy/cloudflare-edge/src/atlas.html`. Already gitignored (`deploy/cloudflare-edge/.gitignore:1`). Deploy and the local edge copy the built page onto it.
- Commit `52742f80`. `SECOND_BRAIN.md:67` records it as `cursor/worker-coverage-gaps-59c9`, one unpushed test commit on `80bab333`, not an ancestor of the ledger chain. This sequence does not cherry-pick, push, or edit it. The same sentence is at `SECOND_BRAIN.md:44`.
- No identifier `D3` exists in this tree. `docs/state-machines.md:14` row 3 is the Python interview run (`atlas_voice/cascade.py:154`), status LATER. This sequence does not schedule that machine and does not edit `cascade.py`.

## Why these files collide

Every open PR in the named queue edits the same generated paths. Name-only diffs against their heads, read on 2026-11-20. All seven are drafts. All seven use base `main`. They are parallel, not a GitHub stack.

| PR | Head branch | Generated paths in the diff |
|---|---|---|
| #15 | `cursor/atlas-identity-change-residual` | four HTML aliases, `MANIFEST.json`, `PAGE_SHA256.txt`, `csp.generated.js`, `handoff/BUILD_STATUS.md` |
| #16 | `cursor/atlas-record-dialog-lows` | four HTML aliases, `MANIFEST.json`, `PAGE_SHA256.txt`, `csp.generated.js`, `handoff/BUILD_STATUS.md` |
| #17 | `cursor/atlas-rating-onend-throw` | `MANIFEST.json`, `handoff/BUILD_STATUS.md` |
| #18 | `cursor/atlas-askrunner-count` | `MANIFEST.json`, `handoff/BUILD_STATUS.md` |
| #19 | `cursor/atlas-sqltext-lows` | `MANIFEST.json`, `handoff/BUILD_STATUS.md` |
| #20 | `cursor/atlas-long-title-overflow` | four HTML aliases, `MANIFEST.json`, `PAGE_SHA256.txt`, `handoff/BUILD_STATUS.md` |
| #21 | `cursor/atlas-checkhandoff-residuals` | `MANIFEST.json`, `handoff/BUILD_STATUS.md` |

Also open, and outside this queue: #1 (`feature/agent-brain-v2.1`, base `main`), #2 (`cursor/plan-a-cap-v2`, base `main`), #4 (`cursor/atlas-preview-gate8`, base `cursor/plan-a-cap-v2`). This sequence does not stack on them. If one of them still carries these paths when the cutover lands, it follows the same in-flight rule at the end of this plan.

The four aliases are one byte string. `MANIFEST.json:624-641` lists each at 924015 bytes and sha256 `7a290026b91b2e3f732b31146927a158bb30243ed2bea6fd74f517ae31dd7d4a`. `handoff/BUILD_STATUS.md` is 346929 bytes (`MANIFEST.json:2284-2286`). A one-line status note changes that row, so the manifest rewrite follows the status edit. `handoff/BUILD_STATUS.md:1632` and `:1641` record that order: the note is written, then `python3 scripts/check_handoff.py . --dev-git-index --write-manifest`.

`docs/WOW_SPEC.md:1506` already said each track rebuilds the aliases and does not commit them, and that CI builds its own copy. The integration step was supposed to commit them once (`docs/WOW_SPEC.md:1498`). The current tree commits them on every PR. CI's build is `bash scripts/verify_page_build.sh` (`.github/workflows/ci.yml:22-23`), which runs `build.py` twice and then compares the result to the committed page (`scripts/verify_page_build.sh:39-48`).

## 1. Inventory

Line numbers are from `8b0972ec`. A path that only stores a past session is listed once, at the line that shows the read or the write.

### 1.1 Writers

| Writer | Lines | What it writes |
|---|---|---|
| `build.py` | 69-72 | `deploy/cloudflare-edge/src/csp.generated.js` from `script_hashes` of the assembled page |
| `build.py` | 73-79 | The same byte string to `ATLAS_Project_Intelligence.html`, `ATLAS_Intelligence.html`, `ATLAS_Voice_Studio.html`, `ATLAS_Voice.html`. The three `title` replaces run before those four writes. |
| `build.py` | 15-25, 55 | `ATLAS_HOME` from `ATLAS_HOME_URL` or `deploy/cloudflare-edge/wrangler.jsonc` `vars.ORIGIN`, baked into the page |
| `scripts/check_handoff.py` `write_manifest` | 359-368 | Rewrites `MANIFEST.json` `files` (path, bytes, sha256). Leaves the header keys, including `"date": "2026-09-26"` (`MANIFEST.json:4`). |
| `scripts/check_handoff.py` CLI | 622-644 | `--write-manifest` requires `--dev-git-index`, refuses a missing manifest, refuses a non-checkout, refuses a non-ASCII path, then calls `write_manifest`. |
| `scripts/verify_page_build.sh` | 41, 66 | Runs `python3 build.py`, which writes the four aliases and `csp.generated.js`. The script does not write the pin. |
| `scripts/verify_page_build.sh` | 60 | Copies `ATLAS_Voice.html` to `deploy/cloudflare-edge/src/atlas.html` (gitignored). |
| `deploy/cloudflare-edge/deploy.sh` | 18-24 | Runs `python3 ../../build.py`, then copies `ATLAS_Voice.html` to `src/atlas.html`. Does not write the pin. |
| `deploy/cloudflare-edge/build_edge.py` | 44-49 | Writes `policy.generated.js`. The full run copies `ATLAS_Voice.html` onto `src/atlas.html`. `--policy-only` skips that copy. |
| Authors, by rule | `CLAUDE.md:35` | Append `handoff/BUILD_STATUS.md`. No program writes that file. |

There is no program that writes `PAGE_SHA256.txt`. The current line was written by hand from `sha256sum` (`handoff/decisions/page-pin-refresh.md:68`). The file is one line:

```
7a290026b91b2e3f732b31146927a158bb30243ed2bea6fd74f517ae31dd7d4a  924015  ATLAS_HOME=https://atlas.tony-walteur.workers.dev  ATLAS_HOME_URL=unset
```

`scripts/check_handoff.py:345` drops `MANIFEST.json` itself from the git file list. `MANIFEST.json:9-11` excludes only itself. Every other tracked path, including the four pages, the pin, `csp.generated.js`, and `handoff/BUILD_STATUS.md`, is a manifest row. Adding one tracked file makes `manifest-content` fail until the rewrite.

### 1.2 Makefile targets

`Makefile`:

| Target | Lines | Relation |
|---|---|---|
| `build` | 3-4 | `python3 build.py`. Writes the four aliases and `csp.generated.js`. |
| `preview` | 5-6 | Depends on `build`, then `scripts/preview.py`. |
| `gateway` | 7-8 | Depends on `build`, then `scripts/start_gateway.sh`. |
| `test` | 9-11 | Depends on `build` and `test-edge`, then `node --test tests/*.test.js` and pytest. |
| `test-edge` | 12-13 | Edge tests only. Does not build. CI runs the page build before this (`ci.yml:22-29`). |
| `test-ui` | 16-42 | Depends on `build`, then the browser scripts. |
| `doctor` | 43-44 | Does not build. `scripts/doctor.py:77-78` requires the compiled HTML to already exist. |
| `verify-package` | 45-48 | `scripts/check_handoff.py` on an extracted release. Reads that package's `MANIFEST.json`. |
| `verify-dev-tree` | 49-51 | `scripts/check_handoff.py . --dev-git-index`. Not a CI step. |

`tests/test_handoff.py:113-117` (`test_complete_make_targets`) locks that the Makefile still names `tests/test_*.py` and `tests/depth_browser.py`. `tests/test_handoff.py:703-714` locks the `verify-package` usage string and locks that the `test` recipe does not call `verify-package`.

### 1.3 CI and deploy steps

`.github/workflows/ci.yml`:

- 22-23. "Build the page twice and check the canonical hash" runs `bash scripts/verify_page_build.sh`.
- 24-25. `build_edge.py` then `git diff --exit-code` on `policy.generated.js` only. `csp.generated.js` is not in that diff.
- 26-37. Unit tests, edge tests, pytest, browser suites. They read the pages the verify step just wrote.
- No step runs `check_handoff.py`. `timeout-minutes` is 30 (`ci.yml:12`). This plan does not change that number.

`.github/workflows/deploy.yml`:

- 5-9. `workflow_dispatch`, input `confirm`.
- 14-16. Job runs only when `confirm == DEPLOY` and `github.ref == refs/heads/main`.
- 26-30. `bash deploy/cloudflare-edge/deploy.sh` with the two Cloudflare secrets. `timeout-minutes` is 15 (`deploy.yml:18`). This plan does not change that number, the environment name, the ref check, or the secret names.

`deploy/cloudflare-edge/deploy.sh`:

| Lines | Step | Exit |
|---|---|---|
| 18-20 | `python3 ../../build.py` | 11 `build` |
| 22-24 | copy to `src/atlas.html` | 12 `copy` |
| 26-28 | `node --test test/*.test.js` | 13 `test` |
| 30-37 | read `generated/PAGE_SHA256.txt` field 1 and compare to `sha256sum src/atlas.html` | 14 `hash` |
| 39-45 | stub, or `npx --yes wrangler@4 deploy` | 0 |

The hash runs after the tests because the tests can rewrite the page (`deploy.sh:4-5`). A failed build leaves a page that was already there (`page-guard.test.js:95-106`).

`scripts/verify_page_build.sh` exits, from the script and from `handoff/decisions/page-pin-refresh.md:88`:

| Exit | Lines | Meaning |
|---|---|---|
| 23 | 34-36, 42-44, 51-53, 67-69 | Committed page missing, or `build.py` did not write an alias |
| 24 | 46-48 | Fresh build differs from the committed snapshot |
| 25 | 55-57 | An alias differs from `ATLAS_Voice.html` |
| 21 | 71-74 | Second build differs from the first |
| 22 | 79-82 | Edge copy differs |
| 1 | 84-86 | Pin digest differs. The compare is the bare command `test "$actual" = "$expected"`. |
| 130 / 143 | 28-29 | INT / TERM |

The script unsets `ATLAS_HOME_URL` (`verify_page_build.sh:6`) before either build.

### 1.4 `check_handoff.py` rules

`inspect` (`scripts/check_handoff.py:371-516`) records these checks:

| Check | Line | What it requires |
|---|---|---|
| `manifest` | 377-379 | `MANIFEST.json` parses. Failure returns immediately. |
| `manifest-entries` | 381 | `files` is a non-empty list. |
| `manifest-content` | 386-460 | Each row's bytes and sha256 match the file. No duplicate, symlink, escape, missing file, unlisted path, or refused git metadata. Dev mode also refuses untracked files that are not excluded (`426-428`) and a checkout that is not exactly `.git/HEAD` (`415-423`). |
| `required:<path>` | 461-462 | Eight handoff files exist. `handoff/BUILD_STATUS.md` is not in this list. |
| `release-hygiene` | 463-472 | No font, key, sqlite, real `.env`, or secret-shaped directory in the manifest rows. |
| `html-aliases` | 473-486 | The four alias names are byte-identical. |
| `logo` | 487-492 | `assets/Mantu.svg` sha256 is `92c5ff21779f09199097a2971c172453017f0d2581a0ced6f54fe486ba9b6c2b`. |
| `html-logo-files` | 478, 483, 494 | Used when an alias or the logo cannot be read. |
| `clean-build` | 495-511 | `build.py` exits 0 in a temp directory. Timeout 30 seconds. Env is the seven names in `rebuild_environ` (`tests/test_handoff.py:758-767`). |
| `clean-build-byte-match` | 512-514 | The temp rebuild matches the four alias bytes in the package. |

Clean-rebuild copy set (`include_in_clean_rebuild`, `321-322`): `build.py` and paths under `src/`, `assets/`, `docs/`, `atlas_voice/`, `deploy/cloudflare-edge/`. `scripts/` is not copied. A pin helper that `build.py` imported from `scripts/` would break this rebuild. `build.py` stays on its current imports.

`manifest_allows_path` (`301-315`): a trailing-slash exclude hides a directory only in dev mode. Package mode ignores that form.

`tests/test_handoff.py:728-737` (`test_docs_do_not_use_the_checker_as_a_dev_gate`) forbids `00_START_HERE.md` and `handoff/BUILD_PLAN.md` from telling a reader to run the checker before editing, and it requires the sentence "enumerates package files except itself" to remain in `handoff/verification/RESULTS.json`. Later doc edits have to keep that test green.

Real-tree tests that read the committed manifest and the committed aliases:

| Test | Lines | What it does |
|---|---|---|
| `test_repository_full_handoff_includes_clean_rebuild` | 717-725 | `inspect` on the repo with `dev_git_index=True` and rebuild. |
| `test_git_archive_of_head_passes_check_handoff` | 740-753 | `git archive HEAD` is treated as the release package and must pass package-mode `check_handoff.py`. |
| `test_make_verify_package_requires_an_extracted_package` | 703-714 | Bare `make verify-package` fails. A synthetic package passes. |
| `test_write_manifest_requires_explicit_dev_git_index` | 418 | `--write-manifest` without the flag is an error. |
| `test_write_manifest_refuses_non_ascii_path` | 1213 | Write leaves the manifest bytes unchanged. |
| `test_disguised_checkout_write_manifest_exits_clean` | 1248 | Same, for a disguised git dir. |
| `test_git_failure_on_exact_dotgit_write_manifest_is_clean` | 1268 | Git failure on `--write-manifest` exits 2 and does not write. |

The other `test_handoff.py` tests build a synthetic package. They stay on package mode.

### 1.5 Page and pin consumers

Runtime:

| Consumer | Lines | Read |
|---|---|---|
| `atlas_voice/server.py` | 123 | Reads `ATLAS_Voice.html` for a signed-in response. |
| `atlas_voice/server.py` | 415 | `GET /ATLAS_Voice.html` uses that handler. `Makefile:7` builds before the gateway. |
| `scripts/preview.py` | 8, 21-24 | Serves `ATLAS_Voice_Studio.html`. Missing file is 503 "Run python3 build.py first". `Makefile:5` builds first. |
| `deploy/cloudflare-edge/src/worker.js` | 3, 20 | `import page from './atlas.html'` and passes it to `handle`. |
| `deploy/cloudflare-edge/dev/local-edge.mjs` | 27-29 | `readCanonicalPage` on `src/atlas.html` and `ATLAS_Voice.html`. |
| `deploy/cloudflare-edge/dev/page-guard.mjs` | 5-9 | Serves the edge file. If the root alias exists and differs, it throws. |
| `deploy/cloudflare-edge/src/csp.js` | 15 | Imports `PAGE_SCRIPT_HASHES` and `RUNTIME_BLOCK` from `csp.generated.js`. |
| `scripts/doctor.py` | 77-78 | Requires `ATLAS_Project_Intelligence.html` and `ATLAS_Voice.html` on disk. |
| `scripts/runpod_bakeoff.sh` | 68 | Rsync exclude of three aliases. `ATLAS_Voice.html` is not excluded. |
| `scripts/capture_pr10_evidence.py` | 160, 193, 222-225 | Reads the four aliases. |
| `scripts/capture_v12.py` | 8 | Reads `ATLAS_Project_Intelligence.html`. |
| `scripts/measure_journey_overflow.py` | 71 | Reads `ATLAS_Project_Intelligence.html`. |

Pin readers:

| Consumer | Lines | What it compares |
|---|---|---|
| `scripts/verify_page_build.sh` | 84-86 | Field 1 of the pin file to `sha256sum ATLAS_Voice.html`. |
| `deploy/cloudflare-edge/deploy.sh` | 30-36 | Field 1 to `sha256sum src/atlas.html`. Missing file exits 14. |
| `tests/page-pin.test.js` | 12, 16-20, 79-90 | Digest and byte count of all four aliases. `atlas.html` only when `git ls-files` tracks it. |
| `tests/page-pin.test.js` | 95-151 | Same-length byte flip, one-nibble pin flip, wrong pin, tampered page, missing page, build that writes `ATLAS_Voice.moved.html`. |
| `deploy/cloudflare-edge/test/page-guard.test.js` | 95-145, 147-159 | Deploy exits 11 and 14, stub deploy once, verify exits 21, 22, 130, 143. Plants `PAGE_SHA256.txt` in a fake tree. |
| `scripts/check_handoff.py` | 406, via the row | The pin file is hashed like any other listed file. A stale pin whose own bytes match its row still passes (`handoff/decisions/page-pin-refresh.md:21`). |

`node --test tests/*.test.js` and pytest do not read `PAGE_SHA256.txt` except `tests/page-pin.test.js` (`handoff/decisions/page-pin-refresh.md:21`). `make test` does not run `verify_page_build.sh`.

Browser and Python tests that read a committed alias at import or at the start of the file:

| File | Line | Alias |
|---|---|---|
| `tests/admin_metrics_browser.py` | 9 | `ATLAS_Project_Intelligence.html` |
| `tests/ask_browser.py` | 11 | `ATLAS_Voice.html` |
| `tests/autosave_browser.py` | 9 | `ATLAS_Voice.html` |
| `tests/bids_browser.py` | 11 | `ATLAS_Voice.html` |
| `tests/depth_browser.py` | 7 | `ATLAS_Project_Intelligence.html` |
| `tests/intelligence_browser.py` | 5 | `ATLAS_Intelligence.html` |
| `tests/orb_touch_browser.py` | 26 | `ATLAS_Voice.html` |
| `tests/report_browser.py` | 10 | `ATLAS_Project_Intelligence.html` |
| `tests/sculpture_browser.py` | 6 | `ATLAS_Voice_Studio.html` |
| `tests/storyboard_browser.py` | 9 | `ATLAS_Voice.html` |
| `tests/studio_browser.py` | 18, 169 | `ATLAS_Voice_Studio.html` |
| `tests/trust_browser.py` | 10 | `ATLAS_Voice.html` |
| `tests/zero_config_browser.py` | 14, 321 | `ATLAS_Voice.html` |
| `tests/zero_config_edge_browser.py` | 22, 98-101, 120-121, 383 | `src/atlas.html` and `ATLAS_Voice.html` |
| `tests/wow_edge_browser.py` | 5, 18 | Requires `src/atlas.html`. The header says to copy `ATLAS_Voice.html`. |
| `tests/test_page_harness.py` | 29 | `ATLAS_Project_Intelligence.html` |
| `tests/test_preview.py` | 17 | Paths `/` and `/ATLAS_Voice_Studio.html` |
| `tests/test_csp.py` | 22, 35-46 | `ATLAS_Voice.html` against `csp.generated.js`, and the other three aliases equal to it |
| `tests/test_build_home.py` | 11, 40-44 | All four aliases on disk. Isolated builds use a temp copy (`24-37`) so the working tree is not rewritten. |
| `tests/test_bakeoff.py` | 21, 26 | Expects the rsync exclude list, and expects `ATLAS_Voice.html` to remain in the archive names. |
| `tests/test_handoff.py` | 120-123, 342-345 | Alias names in the synthetic package, and a symlink escape through `ATLAS_Project_Intelligence.html`. |
| `deploy/cloudflare-edge/test/s1-09ada7d.test.js` | 102-103 | Imports `csp.generated.js` and reads `ATLAS_Voice.html`. |
| `deploy/cloudflare-edge/test/app.test.js` | 509-517 | HTTP path `/ATLAS_Voice.html` on the worker. This is a route, not a disk read. |

`Makefile:9` and `Makefile:16` run `build` before `test` and `test-ui`. CI runs `verify_page_build.sh` before those suites. A bare `node --test tests/*.test.js` on a tree with no HTML file fails the imports above. The cutover keeps that order. It does not teach each test to call `build.py`.

### 1.6 Docs that tell a person to read or write these artifacts

| Doc | Lines | Instruction |
|---|---|---|
| `00_START_HERE.md` | 24, 28 | Open `ATLAS_Project_Intelligence.html`. The gateway serves `ATLAS_Voice.html`. Edit `src/`, then `python3 build.py`. |
| `00_START_HERE.md` | 37-41 | `make verify-package` checks a package against its own `MANIFEST.json`. On a checkout, `make verify-dev-tree`. Issue a manifest with `--dev-git-index --write-manifest`. |
| `CLAUDE.md` | 20, 47 | `build.py` produces four identical aliases. The test block starts with `python3 build.py`. |
| `CLAUDE.md` | 35 | Rule 8: maintain `handoff/BUILD_STATUS.md` in the tree. |
| `CLAUDE_BUILD_PROMPT.md` | 11 | Keep `handoff/BUILD_STATUS.md` updated across sessions. |
| `README.md` | 18, 93 | Open the primary HTML. `python3 build.py`. |
| `docs/REPOSITORY_MAP.md` | 5-6 | Names the primary HTML and `ATLAS_Voice.html` as committed builds. |
| `handoff/CODE_MAP.md` | 48 | `GET /` and `GET /ATLAS_Voice.html` are `server.index`. |
| `handoff/BUILD_PLAN.md` | 7 | Baseline includes the compiled HTML. `make verify-package` checks `MANIFEST.json`. |
| `handoff/verification/RESULTS.json` | 83 | `integrity_note`: the manifest enumerates package files except itself. |
| `handoff/SECURITY_RUNBOOK.md` | 121, 141 | `build.py` writes `csp.generated.js`. The runbook names a freshness check `git diff --exit-code deploy/cloudflare-edge/src/csp.generated.js`. That diff is not a CI step. `tests/test_csp.py:35-37` compares hashes in memory. |
| `docs/CLOUD_WORKFLOW.md` | 16-22, 24-25 | Deploy runs `deploy.sh`. `src/atlas.html` is generated and is not in the repository. |
| `docs/WOW_SPEC.md` | 666 | `build_edge.py --policy-only` does not copy the page. The full run does. |
| `docs/WOW_SPEC.md` | 1463, 1483, 1488, 1497-1498, 1502, 1506 | Integration owns `BUILD_STATUS.md`, `MANIFEST.json`, the four aliases, and `atlas.html`. Tracks rebuild locally and the integration commit writes the pages once. |
| `docs/WOW_ZERO_CONFIG.md` | 49-51, 109-111, 269-271, 638, 690, 741 | Saved-file and old-path behavior, and `ATLAS_HOME` baked by `build.py`. |
| `docs/JEV_RATING.md` | 991, 1018, 1030, 1036, 1045 | UI regenerates the aliases and `atlas.html`. The edge track writes the one `BUILD_STATUS.md` entry. |
| `docs/SOLUTION.md` | 95 | Points at `BUILD_STATUS.md` for unverified connections. |
| `deploy/cloudflare/README.md` | 62 | Record a live acceptance result in `BUILD_STATUS.md`. |
| `deploy/cloudflare-edge/README.md` | 20, 39, 70 | Cites a `BUILD_STATUS.md` session. Old `/ATLAS_Voice.html` navigations redirect. The documented build command is `build.py` plus the copy to `src/atlas.html`. |
| `handoff/decisions/MANIFEST-regenerate.md` | 7-13 | The write command, and the consequence that listed files then match. |
| `handoff/decisions/check-handoff-rebuild.md` | 5-15 | Clean rebuild includes `atlas_voice/` and `deploy/cloudflare-edge/`. |
| `handoff/decisions/check-handoff-git-metadata.md` | 24, 36 | Non-ASCII refusal and the `--write-manifest` exit 2. |
| `handoff/decisions/page-pin-refresh.md` | 7-29, 42-72, 82-100 | The pin line, the CI step, the deploy exit 14, and the three mutants Devin's gate still has to kill. |
| `handoff/CHANGELOG.md` | 15 | "The package manifest is regenerated for this handoff." |
| `.specify/bugs/gate-head-binding/fix.md` | 3-7 | The status commit is the last git commit. Gate counts go to the round report and the store copy of the PR body. They are not copied back into git. |
| `.specify/bugs/gate-head-binding/assessment.md` | 1-16 | A gate number must name the commit that was pushed. |
| `.specify/bugs/gate-head-binding/test.md` | 4-9 | The gate commands include `scripts/verify_page_build.sh` and run after that commit. |

Past records of a manifest rewrite, or of leaving it stale, not a second writer: `handoff/BUILD_STATUS.md:6`, `:35`, `:66`, `:93`, `:166`, `:1610-1641`; `handoff/status/JEV_EDGE.md:37`; `handoff/status/JEV_UI.md:48`, `:90`; `handoff/status/T1.md:182`, `:185-186`; `handoff/status/T2.md:3`, `:91`, `:121`; `handoff/status/T4.md:49`, `:55`, `:60`, `:87`; `handoff/status/T5.md:56`, `:60`, `:65`; `handoff/status/Z.md:9`, `:100`, `:138`, `:147`, `:171`, `:184`; `handoff/untangle-decision-log.md:37`; `handoff/v8-decision-log.md:55`; `handoff/v9-decision-log.md:41`; `handoff/CURRENT_STATUS.md:25`.

### 1.7 What the exact-head gate is today

Devin's gate is not a file in this repository. The contract the repo records is:

- The gate checks out one commit SHA (`handoff/v7-decision-log.md:5`, `docs/STATE-MACHINE-STANDARD.md:35`).
- Commands run after the last commit of the round. Counts are written to the agent store `gates-<head>` and to the store copy of the PR body. They are not committed (`.specify/bugs/gate-head-binding/fix.md:3-7`, `handoff/BUILD_STATUS.md:1608`, `:1632`, `:1641`).
- The command list includes `scripts/verify_page_build.sh` (`.specify/bugs/gate-head-binding/test.md:4`).
- On `344c0c47` the gate was incomplete while three mutants still passed: the hash compare replaced with `true`, an early `exit 0`, and `build.py` writing `ATLAS_Voice.moved.html` (`handoff/decisions/page-pin-refresh.md:84-98`). The repaired verifier makes each of those exit 1.

## 2. Target design

Git stores source. The verify step and the deploy step each run `build.py`. Neither step commits the result.

`build.py` keeps its current job and its current imports. It keeps writing the four aliases at the repo root and `csp.generated.js` at the path `csp.js` imports. Those paths become gitignored. Readers listed in section 1.5 keep their paths. `make test`, `make test-ui`, `make preview`, and `make gateway` already depend on `build`.

A new stdlib module, `scripts/artifact_lifecycle.py`, is the only writer of the pin line and the only writer of the artifact state. `build.py` does not import it. The clean rebuild copies `build.py` and not `scripts/` (`check_handoff.py:321-322`), so the page build stays independent of the state machine. The shell scripts are the effect runner: they call the module, then perform the I/O the returned state names.

### What stops being committed

| Path | Stops in | Replacement |
|---|---|---|
| Four `ATLAS_*.html` | P4 | `build.py` during verify, during deploy, and during the release cut |
| `deploy/cloudflare-edge/generated/PAGE_SHA256.txt` | P4 | The pin line in the gate packet. The release cut writes the same line into the package. |
| `deploy/cloudflare-edge/src/csp.generated.js` | P4, unless question 1 strikes it | `build.py` writes it at the import path before edge tests and before wrangler. Gitignored, same as `atlas.html`. |
| `MANIFEST.json` | P6 | Generated into the release package and into the packet. Dev inspect generates it in a temp file. |
| `handoff/BUILD_STATUS.md` | P7 | Authored notes are one new file per change under `handoff/status/`. The current log is moved once to `handoff/status/archive/BUILD_STATUS.md` and then left alone. The rollup is generated into the package and the packet. |

`policy.generated.js` stays committed. `atlas.html` stays gitignored.

### Where each artifact is generated

Both the verify step and the deploy step run `build.py`. They do not share a page blob. The pin in the packet is the contract between them.

Verify (`scripts/verify_page_build.sh`, the CI step that already calls it, and Devin's gate on that same script):

1. Build twice in the worktree. The two `ATLAS_Voice.html` bytes match. The four aliases match. The edge copy matches. Exits 21, 22, 23, 25 stay.
2. Ask the lifecycle module for the pin line of those bytes. The digest, the byte count, and the `ATLAS_HOME` annotation have to match the build. `ATLAS_HOME_URL` stays unset in this script (`verify_page_build.sh:6`).
3. Write the gate packet outside the worktree. CI uploads that directory as the artifact `gate-packet-<head>`. Devin copies the same directory to the store `gates-<head>`.
4. From P6, write `MANIFEST.json` into the packet directory by hashing the source list plus the built outputs. From P7, write the status rollup there too.

Deploy (`deploy/cloudflare-edge/deploy.sh`, still the only publisher, still ending in `npx --yes wrangler@4 deploy`):

1. Run `build.py` again. Copy `ATLAS_Voice.html` to `src/atlas.html`. A failed build still exits 11 and does not deploy a page that was already there.
2. Hash the copied page before the edge tests. Run the tests. Hash again. A mismatch exits 14 and does not call wrangler. This is the current "tests can rewrite the page" rule, expressed as two hashes of the page this run built.
3. On GitHub Actions the workflow downloads `gate-packet-<github.sha>` and sets `ATLAS_GATE_PACKET`. The post-test hash must equal the packet pin, and `packet.head` must equal `github.sha`, and `packet.source` must be `ci`. A missing packet, a wrong head, or a wrong pin exits 14. Wrangler is not called.
4. A local run with `ATLAS_GATE_PACKET` unset keeps the same-run hash check and prints the pin. It does not claim to be the CI packet. Question 2 asks whether that local path stays.
5. The worker still receives the page as `src/atlas.html` (`worker.js:3`). No wrangler binding, var, route, or account setting changes. `deploy.yml` still requires `confirm == DEPLOY` and `refs/heads/main`.

Release package, from P4 for the pages and P6 for the manifest:

`python3 scripts/cut_release.py DEST` archives `HEAD` into `DEST`, runs `build.py` there, writes the pin, and (P6) writes `MANIFEST.json` from a directory walk. P7 adds the status rollup before the manifest so the manifest row covers the rollup. `make verify-package PACKAGE=DEST` is unchanged: it checks that directory against the manifest inside it. Package mode does not learn git.

### Gate packet

The packet is a directory, not a git path. `packet.json` version 1:

| Field | Meaning |
|---|---|
| `version` | `1`. Any other value is an illegal transition. The deploy step does not publish. |
| `head` | `git rev-parse HEAD`, forty hex digits. |
| `base` | The commit the page diff was built from. CI passes `github.event.pull_request.base.sha` on a pull request and `github.event.before` on a push. The script fetches that one SHA. It does not set `fetch-depth: 0`. |
| `source` | `ci` or `local-run`. |
| `pin` | The pin line, two spaces between fields, the same shape as today's file. |
| `page_sha256` | Field 1 of `pin`. |
| `bytes` | Field 2. |
| `atlas_home` | The origin `build.py` printed. |
| `atlas_home_url` | `unset`, or the override value. |
| `page_diff` | `page.diff`, or null when this commit is the base. |
| `manifest_sha256` | Null until P6. |
| `status_rollup_sha256` | Null until P7. |

`page.diff` is `diff -u` between `ATLAS_Voice.html` built at `base` and `ATLAS_Voice.html` built at `head`. The base build uses a temp archive, the same isolation as `tests/test_build_home.py:24-37`. No new output flag on `build.py`.

The current page is thousands of lines and line 3 of `ATLAS_Voice.html` is one CSS line. A one-token CSS change makes a large hunk. The packet still carries that diff, because that is the rendered page, and it carries the two pins so a reviewer can see whether the bytes moved before opening the hunk. This plan does not add a pretty-printer.

CI uploads the directory. Devin stores it at `gates-<head>`. The git diff of the PR remains the source diff. The packet is the page diff. Gate counts stay out of git (`.specify/bugs/gate-head-binding/fix.md:5`).

### How the pin is checked

CI, on the verify step:

- Two builds match (exits 21 and 23).
- Four aliases match (exit 25).
- Edge copy matches (exit 22).
- Pin digest equals `sha256sum` of the built page. The compare stays a bare `test "$actual" = "$expected"` so the existing mutant still applies.
- Byte count and `ATLAS_HOME` annotation match. Those are new checks beside the digest compare, not a replacement of it.
- `packet.head` equals `git rev-parse HEAD` of the checkout. A mismatch exits 26.
- After P4, a `PAGE_SHA256.txt` that exists and disagrees exits 14 on deploy and fails verify. Absence is the normal case. A leftover local file fails closed.

Devin's exact-head gate, on that same SHA:

- Check out the SHA. Re-run the verify script. Recompute the pin from the page that checkout just built.
- Fail if the recomputed pin differs from `packet.json`.
- Fail if `packet.head` differs from the checkout SHA.
- Fail if `packet.version` is not 1.
- Keep the mutants that already have to fail: hash compare replaced with `true`, `exit 0` immediately after `cd`, `build.py` writing `ATLAS_Voice.moved.html`, digest assert removed while the length assert remains (`handoff/decisions/page-pin-refresh.md:92-99`).
- From P4, also fail if any generated path in the cutover set is tracked by `git ls-files`.
- Write the result to `gates-<head>`. Do not commit the pin, the page, or the counts.

`check_handoff.py` on a received package still checks the pin file as a manifest row. That row is produced by the cut, and it is checked because the bytes are in the package, which is the current `manifest-content` rule.

### How a reviewer sees a page change

The PR diff shows `src/` and `build.py`. The Actions artifact `gate-packet-<head>`, and the same files under `gates-<head>`, contain `page.diff` and the pin line. A reviewer opens that artifact. The page is not committed in order to make the diff visible.

## 3. Artifact lifecycle

This is the machine in `scripts/artifact_lifecycle.py`. It follows `docs/STATE-MACHINE-STANDARD.md`: one state, named events, one pure `transition(state, event) -> state | IllegalTransition`, guards named and tested, side effects only in the shell runners.

The machine describes one commit's artifacts. An `edit` event always returns to `SourceChanged` and drops the pin. A packet whose `head` is a different commit is not loaded.

### States

| State | Data | Meaning |
|---|---|---|
| `SourceChanged` | `head` | This commit has no accepted build. |
| `Built` | `head`, `page_sha256`, `bytes`, `atlas_home` | `build.py` exited 0, the two builds match, the four aliases match. |
| `Pinned` | `Built` plus `pin` | The pin line was computed from those bytes and names this `head`. |
| `Verified` | `Pinned` plus `packet_version`, `source` | The verify step accepted the packet for this `head`. |
| `Deployed` | `Verified` | Wrangler was called with a page whose post-test hash equals this pin. |

### Events

| Event | Source |
|---|---|
| `edit` | A new commit, or a dirty input of the page. |
| `build_ok` / `build_fail` | `build.py` and the double-build compares. |
| `pin_ok` / `pin_fail` | The lifecycle module's pin writer. |
| `verify_ok` / `verify_fail` | CI verify, or Devin's recomputation. |
| `deploy_request` | `deploy.yml` or a local `deploy.sh`. |
| `publish_ok` / `publish_refused` | The post-test hash and the wrangler call. |

### Guards

| Guard | Allow | Deny |
|---|---|---|
| `g_double_build` | The second build's bytes equal the first, and `build.py` wrote `ATLAS_Voice.html`. | Exit 21 or 23. |
| `g_four_aliases` | The four alias byte strings are equal. | Exit 25. |
| `g_same_head` | The state's `head` equals the checkout `git rev-parse HEAD`. | A packet or a pin from another commit. |
| `g_pin_matches_bytes` | Field 1 equals sha256 of the page and field 2 equals the byte length. | Digest or length mismatch. |
| `g_home_annotation` | The `ATLAS_HOME=` field equals the origin `build.py` printed, and `ATLAS_HOME_URL=` is `unset` or that override. | A pin line that names a different origin than the page. |
| `g_packet_head` | `packet.head` equals the checkout and `packet.version` is 1. | Exit 26, or an unknown version. |
| `g_ci_packet` | GitHub deploy sees `source == ci`. | A `local-run` packet on `deploy.yml`. |
| `g_main_ref` | `github.ref == refs/heads/main`. | The existing `deploy.yml:15` condition. |
| `g_confirm_deploy` | `confirm == DEPLOY`. | The existing `deploy.yml:15` condition. |
| `g_post_test_hash` | The hash after the edge tests equals the hash taken before them, and equals the packet pin when a packet is required. | Exit 14. Wrangler is not called. |
| `g_stale_pin_file` | No `PAGE_SHA256.txt`, or its digest equals the built page. | A leftover file that disagrees. |

`g_main_ref` and `g_confirm_deploy` stay in `deploy.yml`. The module records them as guards so the table is complete. The shell runner reads the workflow inputs. The reducer does not read the environment.

### Transitions

| From | Event | Guard | To | Side effect, outside the reducer |
|---|---|---|---|---|
| `SourceChanged` | `edit` | | `SourceChanged` | none |
| `SourceChanged` | `build_ok` | `g_double_build` and `g_four_aliases` | `Built` | pages and `csp.generated.js` are on disk |
| `SourceChanged` | `build_fail` | | `SourceChanged` | log the build exit |
| `Built` | `pin_ok` | `g_same_head` and `g_pin_matches_bytes` and `g_home_annotation` | `Pinned` | the pin line exists in memory |
| `Built` | `pin_fail` | | `Built` | log |
| `Built` | `edit` | | `SourceChanged` | drop the build |
| `Pinned` | `verify_ok` | `g_packet_head` and `g_same_head` | `Verified` | write the packet directory |
| `Pinned` | `verify_fail` | | `Pinned` | log, do not upload a passing artifact |
| `Pinned` | `edit` | | `SourceChanged` | the old packet is not reused |
| `Verified` | `deploy_request` | `g_main_ref` and `g_confirm_deploy` and `g_packet_head` and `g_ci_packet` | `Verified` | start `deploy.sh`. State stays until publish. |
| `Verified` | `publish_ok` | `g_post_test_hash` and `g_same_head` | `Deployed` | wrangler |
| `Verified` | `publish_refused` | | `Verified` | exit 14, no wrangler |
| `Verified` | `edit` | | `SourceChanged` | do not publish this pin |
| `Deployed` | `edit` | | `SourceChanged` | a later commit is not deployed |

Anything not in this table is illegal and is logged. That includes `publish_ok` from `SourceChanged`, `Built`, or `Pinned`; `verify_ok` from `Built`; `pin_ok` from `SourceChanged`; `deploy_request` from `Pinned`. A local deploy that has no CI packet still walks `build_ok` → `pin_ok` → `verify_ok` with `source: local-run` inside that one process, and then `publish_ok` under `g_post_test_hash`. It does not jump to `Deployed`.

```mermaid
stateDiagram-v2
  [*] --> SourceChanged
  SourceChanged --> SourceChanged: edit
  SourceChanged --> Built: build_ok
  SourceChanged --> SourceChanged: build_fail
  Built --> Pinned: pin_ok
  Built --> Built: pin_fail
  Built --> SourceChanged: edit
  Pinned --> Verified: verify_ok
  Pinned --> Pinned: verify_fail
  Pinned --> SourceChanged: edit
  Verified --> Verified: deploy_request
  Verified --> Deployed: publish_ok
  Verified --> Verified: publish_refused
  Verified --> SourceChanged: edit
  Deployed --> SourceChanged: edit
```

### Persistence

The packet is version 1. Loading version 0, a missing version, or a future version returns `IllegalTransition` and does not deploy. The committed pin file is not a packet. Until P4, the verify script still compares it. From P4, `g_stale_pin_file` is the only reading of it. The packet is not written back into the commit.

## 4. Migration sequence

Six PRs, after #15–#21 have merged, each from `main`, each gated on its own. The first commit of each PR is the failing test and does not change the product. The fix commit does not weaken a source, access, consent, or approval check.

`timeout-minutes` stays 30 in `ci.yml` and 15 in `deploy.yml`. A step that would need a higher number stops the PR. The extra work is one page build of the base commit. `build.py` is a local string assembly. It is not a reason to raise the budget.

### P1. Lifecycle module

Foundation. No caller. `build.py`, `verify_page_build.sh`, `deploy.sh`, and `check_handoff.py` stay byte-identical.

Done when:

- `transition` implements the table in section 3.
- Every legal row is accepted. Every other `(state, event)` pair is `IllegalTransition`. The test builds that cross product.
- Each guard has an allow case and a deny case.
- The current pin line in `PAGE_SHA256.txt` parses, and the writer emits that same line for those bytes, that origin, and `ATLAS_HOME_URL=unset`.
- An unknown packet version is `IllegalTransition`.
- `git diff` of `build.py`, the two shell scripts, and `check_handoff.py` is empty.

Failing test first: `tests/test_artifact_lifecycle.py::test_publish_from_source_changed_is_illegal`

That test calls `publish_ok` on `SourceChanged` and expects `IllegalTransition`. On the red commit the module is absent, so the test fails at import.

TEST COMMAND:

```sh
python3 -m pytest tests/test_artifact_lifecycle.py::test_publish_from_source_changed_is_illegal -q
```

Rollback: revert the PR to its parent on `main`. No data migration.

### P2. Gate packet, committed files still decide

`scripts/verify_page_build.sh` keeps exits 21–25 and the committed-page compare (exit 24). After those pass, it writes the packet directory given by `ATLAS_GATE_PACKET`. CI sets that variable and uploads `gate-packet-<head>`. `deploy.sh` is not edited.

The page diff fetches only `packet.base`. Checkout `fetch-depth` stays the workflow default.

Done when:

- A packet written for this checkout has `head` equal to `git rev-parse HEAD` and `pin` equal to the committed pin line.
- A packet whose `head` is forty `a`s exits 26.
- `page.diff` is empty when the base SHA equals `HEAD`.
- The existing `node --test tests/page-pin.test.js` stays green, including the three mutants.
- Deploy is untouched. `bash deploy/cloudflare-edge/deploy.sh` is not run against Cloudflare.

Failing test first: `tests/test_gate_packet.py::test_packet_head_must_equal_checkout`

On the red commit the script writes no packet, so the test fails.

TEST COMMAND:

```sh
python3 -m pytest tests/test_gate_packet.py::test_packet_head_must_equal_checkout -q
```

Rollback: revert the PR. The committed pin is still the verify witness, which it was before this PR.

### P3. Deploy binds to the packet

HIGH. This is the deploy path. `deploy.sh` still reads the committed pin, and it also reads the packet when `ATLAS_GATE_PACKET` is set or `GITHUB_ACTIONS` is `true`. Both witnesses must agree. A missing packet on GitHub Actions exits 14, logs stage `hash`, and does not call wrangler. A local run with the variable unset keeps today's same-run behavior and the committed pin.

`deploy.yml` downloads the artifact for `github.sha` and exports `ATLAS_GATE_PACKET`. It does not change `timeout-minutes`, `environment`, the `confirm` input, the ref condition, or the secret names. `wrangler.jsonc` is not edited.

Done when:

- The existing `page-guard.test.js` deploy tests stay at exits 11, 14, and 0 with the stub.
- GitHub Actions with no packet exits 14 and the stub log does not contain `wrangler@4 deploy`.
- A packet whose pin matches the page and whose `head` matches the checkout reaches the stub once.
- A packet with `source: local-run` exits 14 on the GitHub path.
- The committed pin and the packet pin must be equal. A one-nibble difference exits 14.
- No live `wrangler deploy`. `ATLAS_DEPLOY_STUB` covers the new test. The Cloudflare account is not contacted.

Failing test first: `deploy/cloudflare-edge/test/page-guard.test.js` test name `deploy.sh on GitHub Actions refuses a missing packet and does not deploy`

Current `deploy.sh` does not read `GITHUB_ACTIONS`, so a stubbed run with that variable set still deploys. The new test expects exit 14 and no stub call.

TEST COMMAND:

```sh
node --test --test-name-pattern "missing packet" deploy/cloudflare-edge/test/page-guard.test.js
```

Rollback: revert the PR. `deploy.sh` returns to reading only the committed pin. No Cloudflare state changed, so there is no remote rollback.

### P4. Stop committing the pages, the pin, and `csp.generated.js`

HIGH. The committed witnesses leave git. Verify and deploy already know how to rebuild.

`git rm` the four aliases, `PAGE_SHA256.txt`, and `csp.generated.js`. Gitignore those paths. `build.py` still writes them at the same paths.

`verify_page_build.sh` drops the committed-snapshot compare (exit 24). Exits 21, 22, 23, 25, 130, and 143 stay. The pin compare reads the line the lifecycle module just computed. Exit 26 stays. `g_stale_pin_file` fails a leftover pin file that disagrees.

`deploy.sh` stops treating a pin file as the authority. It hashes before the tests and after the tests. On GitHub Actions the post-test hash must equal the packet. A pin file that exists and disagrees still exits 14.

`scripts/cut_release.py DEST` archives `HEAD`, runs `build.py` in the archive, and writes the pin line into the destination. `make verify-package` on that destination passes `html-aliases`, `logo`, `clean-build`, and `clean-build-byte-match`. The destination's manifest is still written with the existing `--write-manifest` only if the destination is a checkout; until P6 the cut's package-mode check is the four aliases and the logo, and `manifest-content` runs only when the caller passes a manifest. P6 makes the manifest part of the cut. The gap is explicit: between P4 and P6 a full `check_handoff.py` package needs a manifest produced beside the cut, and P6 is the PR that closes that.

`scripts/doctor.py:77` stops requiring the compiled HTML. It still requires `build.py`, `src/shell.html`, and `assets/Mantu.svg`.

`tests/test_build_home.py:40-44` and `tests/test_csp.py:44-46` run after a build, which `make test` already does. `test_git_archive_of_head_passes_check_handoff` encodes "the git archive is the package". The red commit does not edit it. The fix commit points it at `cut_release.py` output and says so in the PR, because that sentence stops being true. The new test added in the red commit is the one that has to pass unchanged.

`tests/test_bakeoff.py:26` expects `ATLAS_Voice.html` inside a git archive. The fix updates the bakeoff expectation to "the archive has the sources, and the page is present after `build.py`". `scripts/runpod_bakeoff.sh:68` excludes three aliases from an rsync of a tree that may already have been built. The fix leaves the excludes, so a built tree still does not upload three of the four copies, and it builds `ATLAS_Voice.html` before the rsync if the file is absent.

`00_START_HERE.md:24` says the file is produced by `python3 build.py` and then opened. The edit keeps `tests/test_handoff.py:728-737` green.

Done when:

- `git ls-files` does not list the four aliases, the pin, or `csp.generated.js`.
- A tree that tracks `ATLAS_Voice.html` fails the new dev check.
- `bash scripts/verify_page_build.sh` exits 0 on this head after the files are absent from git, and the packet pin equals the built page.
- `make test` and the CI order still build before the suites that import the HTML.
- `node --test deploy/cloudflare-edge/test/page-guard.test.js` passes, including the missing-packet test from P3.
- `python3 scripts/cut_release.py DEST && python3 scripts/check_handoff.py DEST --no-rebuild` reports `PASS html-aliases` and `PASS logo`. Full manifest pass is P6.
- No live deploy.

Failing test first: `tests/test_handoff.py::test_tracked_page_is_refused`

The test builds a dev fixture that tracks `ATLAS_Voice.html` and expects the check to refuse it. Current `inspect` accepts a tracked alias, so the test fails.

TEST COMMAND:

```sh
python3 -m pytest tests/test_handoff.py::test_tracked_page_is_refused -q
```

Rollback: revert the PR. That restores the four files, the pin, and `csp.generated.js` from the parent commit. `deploy.sh` returns to the P3 behavior, which still knows how to read a committed pin. No Cloudflare state changed.

### P5. Stop committing `MANIFEST.json`

`write_manifest` gains an explicit destination path and is called by `cut_release.py`. It refuses to write a `MANIFEST.json` that `git ls-files` tracks. Dev `inspect` builds the manifest in a temp file from `git ls-files` plus the generated outputs of the build it just ran, then runs the existing `manifest-content` compare against that generated manifest. Untracked files, git metadata, non-ASCII paths, and the hygiene rules stay.

Package mode is unchanged. A received archive is still walked from disk, still requires its own `MANIFEST.json`, and still refuses `.git`.

A tracked `MANIFEST.json` fails a new check, `generated-not-tracked`.

`00_START_HERE.md:41` tells the reader to cut a package with `cut_release.py` and then run `make verify-package` on that directory. It keeps the forbidden phrases out of `test_docs_do_not_use_the_checker_as_a_dev_gate`.

CI's verify step runs the dev inspect after the page build, in the same job. `timeout-minutes` stays 30. The inspect reuses the pages the verify script just built instead of adding a second clean rebuild on top of the two builds already done. The clean-rebuild check still runs once, inside `inspect`, on a temp copy. If that pushes the job against 30 minutes, the PR stops and reports the duration. It does not edit the timeout.

Done when:

- `git ls-files MANIFEST.json` is empty.
- `make verify-dev-tree` exits 0.
- `python3 scripts/cut_release.py DEST && make verify-package PACKAGE=DEST` exits 0, including `manifest-content` and `clean-build-byte-match`.
- A package whose manifest row was edited by one byte still fails `manifest-content`.
- A tracked `MANIFEST.json` fails `generated-not-tracked`.
- The synthetic package tests in `test_handoff.py` stay green without editing their fixtures, except the real-tree test named above, which the red commit does not touch and the fix retargets at the cut.

Failing test first: `tests/test_handoff.py::test_tracked_manifest_is_refused`

Current `write_manifest` updates a tracked manifest and returns 0. The test expects a refusal and an unchanged file.

TEST COMMAND:

```sh
python3 -m pytest tests/test_handoff.py::test_tracked_manifest_is_refused -q
```

Rollback: revert the PR. `MANIFEST.json` returns from the parent. Package mode was not changed, so already-cut packages still verify.

### P6. Stop committing the shared status log

`git mv handoff/BUILD_STATUS.md handoff/status/archive/BUILD_STATUS.md`. That archive is authored history. Later PRs do not append to it.

A change records its session as a new file `handoff/status/<change-id>.md`. The change id is the branch slug. It must be a new path. The existing `handoff/status/T1.md` and its siblings stay and are inputs to the rollup.

`scripts/build_status.py` concatenates the archive and `handoff/status/*.md` in path order, with a generated header that names the `head` and the packet version. `cut_release.py` writes that rollup into the package before `write_manifest`, so the manifest hashes the rollup the package actually contains. The rollup in the worktree is not a git path. A tracked `handoff/BUILD_STATUS.md` fails `generated-not-tracked`.

`CLAUDE.md` rule 8 points at the per-change file. `CLAUDE_BUILD_PROMPT.md:11` gets the same sentence. The required-file list in `check_handoff.py:461` does not gain `BUILD_STATUS.md`. The package contains the rollup because the cut wrote it, and `manifest-content` checks that copy.

Done when:

- Two new status files in one fixture produce a rollup that contains both bodies and the archive body.
- The rollup path is not tracked.
- A second run of the generator on the same tree produces the same bytes.
- `make verify-package` on a cut package passes, and the package's `handoff/BUILD_STATUS.md` hash equals `packet.status_rollup_sha256`.
- No secret and no customer excerpt is added by the generator. It only concatenates files already in git.

Failing test first: `tests/test_build_status.py::test_tracked_build_status_is_refused`

The test expects a tracked `handoff/BUILD_STATUS.md` to fail. Today that path is an ordinary tracked file, so the test fails.

TEST COMMAND:

```sh
python3 -m pytest tests/test_build_status.py::test_tracked_build_status_is_refused -q
```

Rollback: revert the PR. `git mv` reverses with the revert. Status notes that landed as new files stay. They do not depend on the rollup.

## 5. Risks, rollback, and the two gates

### Risks

| ID | Risk | Where | What the PR does |
|---|---|---|---|
| HIGH | Deploy publishes a page the verify step did not pin, or blocks every deploy. | P3 and P4, `deploy.sh` | Fail closed. Missing packet, wrong head, wrong pin, and a post-test hash change all exit 14 before wrangler. The stub tests cover each one. A compare replaced with `true` is still a failing mutant. |
| HIGH | P4 removes the pin file the current deploy trusts, before the packet path is proven. | P4 | P3 lands first and keeps the committed pin as a second witness. P4 deletes it only after that witness and the packet have to agree. |
| MEDIUM | Package mode starts requiring a git checkout, and a received release stops verifying. | P5 | Package mode stays the directory walk. The new git checks run only behind `--dev-git-index`. The synthetic package tests are the guard. |
| MEDIUM | A suite imports HTML before `build.py` has run. | P4 | `make test`, `make test-ui`, and CI already build first. The PR does not reorder them and does not add a build call inside each test. |
| MEDIUM | `test_git_archive_of_head_passes_check_handoff` is edited and the edit drops a real check. | P4 and P5 | The red commit adds a new test and does not edit the old one. The fix retargets the old test at `cut_release.py` and the PR says that. The cut package still has to pass `manifest-content`, `html-aliases`, and `clean-build-byte-match`. |
| LOW | A reviewer looks only at the git diff and misses a rendered change. | P2 | The packet carries `page.diff` and both pins. CI fails the packet step when the base SHA cannot be fetched. |
| LOW | The status archive and a new note disagree. | P6 | The archive is frozen. New notes are new files. The rollup concatenates. It does not rewrite history. |

`deploy.yml` `timeout-minutes`, the `production` environment, the `confirm` string, the `main` ref check, the Cloudflare secret names, and `wrangler.jsonc` are unchanged in every PR. No PR runs a live deploy.

### Rollback

Each PR reverts to its parent. P1–P3 have no committed generated output to restore. P3's revert restores a `deploy.sh` that reads the pin file, which is still in git at that point. P4's revert restores the four HTML files, the pin, and `csp.generated.js` from the parent blobs. P5's revert restores `MANIFEST.json`. P6's revert restores `handoff/BUILD_STATUS.md` at its old path. None of these reverts rewrite Cloudflare, because none of the PRs deploy.

### What Devin's gate changes

| When | The gate gains | The gate keeps |
|---|---|---|
| P2 | Read `packet.json`. Fail if `head` differs from the checkout SHA. Fail if `version` is not 1. Store the packet, including `page.diff`, under `gates-<head>`. | `verify_page_build.sh`, the mutants, counts kept out of git. |
| P3 | On a deploy review, fail the packet if `source` is not `ci` or if the pin disagrees with the page the gate just built. The gate does not call wrangler. | Tony's `DEPLOY` confirmation stays the human publish switch. |
| P4 | Fail if `git ls-files` lists a page, the pin, or `csp.generated.js`. The committed-snapshot compare (exit 24) is gone, so the mutant for "build writes the file somewhere else" is the missing-file exit 23, which stays. | Recompute the pin. Do not write it back into the commit. |
| P5 | Fail if `MANIFEST.json` is tracked. Recompute `manifest_sha256` and compare it to the packet. | Package-mode review of a cut directory still uses `check_handoff.py` with no git flag. |
| P6 | Fail if `handoff/BUILD_STATUS.md` is tracked. The per-change file is the authored note the gate reads. | The rollup hash in the packet has to match a fresh concatenation. |

### What `check_handoff.py` changes

| When | Change |
|---|---|
| P1–P3 | None. |
| P4 | Dev mode fails `generated-not-tracked` for the four aliases, the pin, and `csp.generated.js`. `clean-build-byte-match` compares the temp rebuild to the pages `build.py` just wrote in that same inspect, which are on disk and not from `git ls-files`. Package mode is unchanged for a package that still contains the aliases. |
| P5 | `--write-manifest` requires a destination that is not a tracked path. Dev inspect generates the manifest in temp. `generated-not-tracked` includes `MANIFEST.json`. Package mode still requires the manifest inside the package and still walks the directory. |
| P6 | `generated-not-tracked` includes `handoff/BUILD_STATUS.md`. The required-file list at line 461 is not extended. The rollup is a package file produced by the cut, so a package that contains it has a manifest row for it. |

`html-aliases`, `logo`, `release-hygiene`, the git-metadata refusal, the non-ASCII refusal, and the seven-name rebuild environment stay.

## 6. In-flight pull requests

Start P1 only after #15, #16, #17, #18, #19, #20, and #21 have merged. They are parallel drafts on `main`. Each one edits `MANIFEST.json` and `handoff/BUILD_STATUS.md`. #15, #16, and #20 also edit the pages and the pin. Landing this sequence on top of them recreates the collision this plan removes.

While they are open, each of them keeps today's freeze: merge `main`, rebuild, rewrite the manifest, append the status note, and only then run the exact-head gate. This plan does not change that freeze for those seven.

If one of them is still open when P4, P5, or P6 merges, the resolution is an ordinary merge from `main`. The merge takes `main`'s deletion of the generated paths. The PR does not regenerate those files. A status paragraph that the PR had appended to `handoff/BUILD_STATUS.md` moves to a new `handoff/status/<branch>.md`. No rebase, no force push.

#1, #2, and #4 are not in this queue. This sequence does not stack on them. The same merge resolution applies if they still contain these paths.

A stacked PR opened after P4 uses the parent as `packet.base` when CI sets `github.event.pull_request.base.sha`. The page diff is that PR's rendered change. The parent has already dropped the generated files, so the child does not reintroduce them.

## 7. Questions for a non-author debate

1. `csp.generated.js` is in the P4 cutover because `build.py:69-72` writes it in the same run as the pages and PRs #15 and #16 already collide on it. Should it stay committed instead, with the runbook's `git diff --exit-code` added to CI?

2. A local `deploy.sh` with no packet keeps the same-run hash and can publish. GitHub deploy requires a `ci` packet. Should a local publish also require a packet from CI?

3. Is a frozen `handoff/status/archive/BUILD_STATUS.md` plus one new file per change the right split, or should the historical log stay at `handoff/BUILD_STATUS.md` and only new sessions move?

4. `policy.generated.js` stays committed and stays on the CI diff. Is that out of scope for this sequence?

5. `git archive HEAD` stops being a finished release. The cut adds the pages, the pin, the manifest, and the rollup. Is a separate cut command acceptable, or should verify-dev-tree remain the only package?

6. The page diff is `diff -u` of two built `ATLAS_Voice.html` files, against `github.event.pull_request.base.sha`. Line 3 of the current page is a single CSS line, so some hunks will be large. Is that artifact enough, or does the packet also need a list of the source files whose bytes differ?

7. Devin's PASS stays a review result in `gates-<head>`. `deploy.yml` gates on the CI packet, `confirm == DEPLOY`, and `refs/heads/main`. Should wrangler also refuse to run until a Devin PASS for that SHA is on record?

8. The pin line keeps two spaces and the `ATLAS_HOME_URL=unset` token so the current file parses. Is that spelling frozen?

9. This plan file is unlisted in `MANIFEST.json`. Adding it without a manifest rewrite makes `test_repository_full_handoff_includes_clean_rebuild` and `test_git_archive_of_head_passes_check_handoff` fail `manifest-content` (`unlisted:`). CI runs those tests. Regenerating the manifest in this plan PR is the R1 collision. Should this draft stay red until P5, or does merging the plan include one last manifest write?

10. #15–#21 are the queue this plan waits for. #1, #2, and #4 are also open. Does the wait include those three?

## 8. Before and after

```mermaid
flowchart TB
  subgraph before [Before: generated files are committed]
    src1[src shell assets atlas_voice] --> build1[build.py]
    build1 --> html1[four HTML aliases committed]
    html1 --> pin1[PAGE_SHA256.txt committed by hand]
    html1 --> csp1[csp.generated.js committed]
    note1[every PR appends BUILD_STATUS.md] --> man1[write-manifest]
    html1 --> man1
    pin1 --> man1
    man1 --> manifest1[MANIFEST.json committed]
    html1 --> verify1[verify_page_build.sh cmp to committed page]
    pin1 --> verify1
    pin1 --> deploy1[deploy.sh hash then wrangler]
    html1 --> deploy1
    manifest1 --> collide[parallel PRs conflict on these paths]
    note1 --> collide
    html1 --> collide
    pin1 --> collide
  end
  subgraph after [After: verify and deploy build, git stores source]
    src2[src shell assets atlas_voice] --> verify2[verify step runs build.py twice]
    verify2 --> packet[gate packet: head, pin, page.diff]
    packet --> upload[CI artifact gate-packet-sha and store gates-head]
    upload --> devin[Devin recomputes the pin on that exact SHA]
    src2 --> deploy2[deploy step runs build.py again]
    packet --> deploy2
    deploy2 --> hash2{post-test hash equals packet pin and head}
    hash2 -->|yes, main, DEPLOY| wrangler[wrangler, page via atlas.html]
    hash2 -->|no| stop14[exit 14, wrangler not called]
    status2[handoff/status one new file per change] --> cut[cut_release.py]
    verify2 --> cut
    cut --> package[package contains pages, pin, rollup, MANIFEST.json]
    package --> pkgcheck[make verify-package, package mode, no git]
  end
```
