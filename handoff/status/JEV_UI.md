# JEV story rating: UI track progress log

Spec: `docs/JEV_RATING.md` §14.2 (UI owns the gauge, record dialog, storage strip, profile line, browser tests).
Working copy: `/Users/tony/AI-Brain-build/atlas-project-intelligence` (git clone). No commits, no deploys, no wrangler.
No test or script calls `api.typesafe.ai` or any paid provider: the unit tests use §9.2 JSON fixtures, the browser suite uses
EDGE's local fake when present and otherwise a contract mock (Playwright routes) over the real local library.

## Status: UI done, verified against EDGE's engine and fake TypeSafe

`tests/jev_rating_browser.py` detects EDGE's fake (`FAKE_TYPESAFE=1`, `/__typesafe_mode`) and prints `BACKEND: ...`
first. It was built on a contract mock while EDGE was still landing, and now passes on both backends: EDGE's real
engine, library and fake TypeSafe (the default once the hook answers), and the contract mock (`JEV_BROWSER_MOCK=1`,
which also runs step 14, the null-quality timing paths).

## Baseline (2026-09-29, before any UI change)
- `node --test tests/*.test.js`: 381 tests, 380 pass, 1 skipped, 0 fail.
- `python tests/library_browser.py`: 14 PASS (no-key path).
- Today's gauge captured before editing: `tests/fixtures/quality-gauge-before-jev.json` (8 cases: legacy, legacy without
  agent score, needs work, review agent with `no_key` / `no_consent`, rules `no_story` / agent failed, null).
  `qualityGauge(q)` and `qualityGauge(q,{interactive:true})` gave identical HTML for every case.

## TypeSafe docs the UI relies on (read live 2026-09-29)
The UI renders the server's §9.2 fields; it computes no threshold itself. The copy and layout rest on:
- https://docs.typesafe.ai/primitives/score.md: "Different distributions can produce the same score"; read
  `probabilities` and `confidence` alongside it. So each meter is drawn at the server's most likely `level`, never at the
  expectation, and the per-level probabilities are in the tooltip and the text table.
- https://docs.typesafe.ai/primitives/noul.md: a Noul has no `confidence`. So a check chip shows yes / no / unsure from the
  server's `outcome`, and only its probability goes to the tooltip and the table.
- https://docs.typesafe.ai/confidence.md and https://docs.typesafe.ai/patterns/confidence-routing.md: the three bands
  (act, proceed with care, route to a person). The UI shows the server's `band` as words ("likely", "unsure", nothing for
  sure). Note: confidence.md shows 0.5 and 0.9 only as code examples, not as declared band limits; the 0.6 floor is from
  confidence-routing.md. Those numbers are EDGE's (spec §5.1); the UI never reads them.
- https://docs.typesafe.ai/models.md: English is the best-supported language, others "not equally well". Source of the
  gauge line "JEV reads English best; a person should check this rating." (shown when a language hold exists).

## Changes

| File | Change |
|---|---|
| `src/charts.js` | `qualityGauge(q, opts)` with `opts.jev` and `opts.admin`: engine line, JEV / rules track labels, 7 dimension rows (4-step meter at the most likely level, "likely" / "unsure" / "split reading" / "not written yet", unsure rows dashed and hatched), 3 check chips, "Fix first", the language line, the extra caption sentence, the admin `BLOCKED_EXTERNAL` line, and an `ag-sr` text table with the numbers. Every string through `esc`. New `ag-*` rules added to `EXPORT_CSS`. Without `opts.jev` and without a JEV rating the output is byte-identical to before. |
| `src/app.js` | Record dialog split into `openRecord` (fetch) and `showRecord` (render): engine in the quality line (" · JEV 92"), holds under "To check", "Rate again", the consent row (owner only, until "Not now" in this page session), "Rating this revision…" with polling (0.8, 1.6, 3.2 s then 5 s, at most 45 s, stops on close or another record), "The rating is taking longer than usual." with "Rate now", one automatic rating per revision only with `rating.jevAllowed` and `permissions.review`. Storage strip consent row after a successful library save; save toast "JEV is rating it now." when consented. Gauge gets `{jev, admin}` from the bootstrap. All of it is gated on bootstrap `jev`. |
| `src/profile-ui.js` | `consents.jevRating` parsed like `spokenAsk`; `jevRating()`, `grantJevRating()`, `revokeJevRating()`; the "Story rating by JEV: allowed · Turn off" line (only when bootstrap `jev`), and the "Story rating by JEV is off. ATLAS asks again next time." status. |
| `tests/charts.test.js` | U1–U4 added; U5: the `charts.js` ceiling raised from 54,000 to 57,000 (the only changed assertion; the reason is in the test name). |
| `tests/fixtures/quality-gauge-before-jev.json` (new) | U4 fixtures, captured from the unmodified `charts.js`. |
| `tests/jev_rating_browser.py` (new) | §13.4 steps 1–13, plus a mock-only step 14 for the null-quality timing paths. |
| `src/styles.css` | One scoped rule, `.jev-consent{color:var(--ink)}.jev-consent p{margin:0 0 10px}`: in the dark studio view `body` text is `--g1` and `.gap-note` paints a `--g1` background, so the strip's consent text was invisible (found on a screenshot). `.gap-note` itself is unchanged. |
| `.github/workflows/ci.yml` | `jev_rating` added to the browser loop. |
| `ATLAS_*.html`, `deploy/cloudflare-edge/src/atlas.html` | Regenerated only (`python3 build.py && cp ATLAS_Voice.html deploy/cloudflare-edge/src/atlas.html`). |

Not touched: `src/shell.html`, `src/charts.css`, any `deploy/cloudflare-edge/src/*.js`, `dev/*`, `test/*`, `atlas_voice/*`,
and every EDGE-owned doc.

## Decisions and discrepancies (for EDGE and Tony)
1. **Where the strip row goes.** §8.2 says "after `#storageDetail` in the storage strip", but `#storageDetail` is inside the
   profile dialog (`src/shell.html`), not the strip. The row is inserted right after the visible storage strip
   (`.environment`, which holds `#storageStatus`), which is what §13.4 step 1 checks. No `shell.html` change.
2. **`charts.css` is unchanged.** The export-stylesheet test requires every `ag-*` class in `C.EXPORT_CSS`, so all new rules
   live there; the `charts.css` ceiling stays 3,400. `charts.js` measures 56,971 bytes (cap 57,000).
3. **Holds are display strings**, like `blockers` (§5.4 gives each as a sentence). The gauge's language line keys on a hold
   starting "JEV reads English best". If EDGE stores holds as objects, the dialog's "To check" list and this line need
   the text field.
4. **"JEV did not answer"** is shown for any `fallbackReason` other than `null`, `no_key`, `no_consent`, `no_story` and
   `escalated` (so every §7.2 failure code, including `guard`, `too_long` and `circuit_open`).
5. **Seconds format:** under 0.1 s reads "< 0.1 s", under 10 s one decimal ("0.4 s"), otherwise whole seconds ("14 s").
6. **Without the key nothing new appears**, including the in-progress text and polling: they are gated on bootstrap `jev`
   (§0 "no new text"). The admin `BLOCKED_EXTERNAL` hint is the only exception, as specified.
7. **The strip's dismissal flag** is `localStorage['atlas.jevRatingAsked'] = '1'`, set by either strip button, read and
   written in `try/catch`. It holds no content and does not start with `mantu.atlas` (the workspace key prefix).
8. **§13.4 steps 8 and 9 conflict with §6.4 and §6.3 (spec discrepancy).** "Rate again" on an unchanged story reuses
   JEV's saved answer (§6.4, R12) whatever the fake's mode, so as written step 8 still shows "Rated by JEV · instant"
   (confirmed against EDGE: it failed exactly so). And a "down" background rating makes 3 failed attempts, which opens
   the 60 s breaker (§6.3) and would turn a later "unsure" step into `circuit_open`. The suite therefore runs step 9
   before step 8, and each first edits the story text (a new revision whose body JEV has not seen). Against EDGE,
   step 8's "Rate again" then reports `circuit_open`, which is the breaker working as specified.
9. **Step 9 against EDGE:** the fake review agent answers at once, so the second opinion can land before the dialog
   redraws. The suite asserts the POST response (JEV `needs_work` with holds), then waits for the dialog's quality to be
   the second opinion **of that same generation** (`gen`) and to read "Second opinion by the review agent · JEV was
   unsure", without a reload. "To check" on screen is asserted with the mock and reported as INFO against EDGE.
10. **Side effect of the existing suites:** `tests/intelligence_browser.py` rewrites `preview/v11/*.png` on every run
   (they show as modified after the browser loop). Not a UI change; left for whoever commits to keep or drop.

## Commands and results (UI track, 2026-09-29)
All from the repo root; browser suites and pytest run outside the sandbox (they bind loopback ports), with
`UV_CACHE_DIR=/tmp/claude-501/uvcache uv run --no-project --offline --with-requirements requirements.txt --with-requirements
requirements-test.txt --with msgpack --with pyjwt --with cryptography [--with playwright --with python-docx] python ...` and
`CHROMIUM_PATH` set to the local headless shell. Final run, after the last UI edit and with EDGE's code in the tree:

| Command | Result |
|---|---|
| `python3 build.py && cp ATLAS_Voice.html deploy/cloudflare-edge/src/atlas.html` | built; the four aliases are byte-identical; the edge copy matches |
| `node --test tests/*.test.js` | 385 tests, 384 pass, 1 skipped, 0 fail (baseline 381/380/1) |
| `node --test tests/charts.test.js` | 36 pass, incl. U1–U5. Against the unmodified `charts.js`, U1–U4 fail (they test the new behaviour) |
| `python tests/jev_rating_browser.py` (EDGE's fake) | 35 PASS, 0 FAIL; INFO: step 9 "To check" not caught (second opinion faster than the redraw), step 14 needs the mock |
| `JEV_BROWSER_MOCK=1 python tests/jev_rating_browser.py` | 42 PASS, 0 FAIL (step 14 backoff measured 0.86, 1.62, 3.22 s; 12 GETs in 45 s, none after) |
| `python tests/{studio,sculpture,intelligence,depth,autosave,orb_touch,library,reuse,memory,sheet,report,bids,ask,trust,storyboard,confirm,wow_edge,zero_config,zero_config_edge}_browser.py` | all rc 0: 79, 40, 26, 20, 33, 8, 14, 19, 9, 17, 19, 70, 31, 51, 52, 27, 32, 87, 54 PASS, 0 FAIL |
| `python -m pytest tests/test_*.py -q` | 262 passed |
| `cd deploy/cloudflare-edge && node --test test/*.test.js` (EDGE's suite, run for information) | 484 tests, 484 pass |
| `grep -rn api.typesafe.ai tests/ src/` | only the existing fake-fetcher assertion in `tests/test_quality.py:166`; nothing in UI files |

Screens checked by eye (scratch screenshots, not committed): the JEV gauge in the record dialog, the unsure / escalated /
admin variants, and the storage-strip consent row at 1400 px and 390 px. The last check found the invisible-text defect
fixed in `src/styles.css`.

No commit, branch, stash, checkout, reset, restore or clean; no wrangler or deploy; no call to TypeSafe or any provider.
