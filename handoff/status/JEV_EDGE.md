# JEV story rating: EDGE track progress log

Spec: `docs/JEV_RATING.md` §14.1 (EDGE owns engine, routes, library integration, edge tests, integration docs).
Working copy: `/Users/tony/AI-Brain-build/atlas-project-intelligence` (git clone). No commits, no deploys, no wrangler.
No test or script calls `api.typesafe.ai`: every test uses a fake fetcher; the fake key is `test-key-SECRET`.

## Baseline (2026-09-29, before any EDGE change)
- `cd deploy/cloudflare-edge && node --test test/*.test.js`: 447 tests, 447 pass.
- `node --test tests/*.test.js`: 381 tests, 380 pass, 1 skipped.
- `uv run ... python -m pytest tests/test_*.py -q` (sandbox off): 262 passed.

## TypeSafe contract re-read live (2026-09-29)
Every detail in spec §2 re-checked against the live docs:
- https://docs.typesafe.ai/api.md: endpoint, headers, `{model, state, questions}`, the three answer shapes (the
  api.md response examples are mirrored as parser fixtures in R5), errors 401/422/429/529.
- https://docs.typesafe.ai/primitives.md: question ids are not sent to the model; backticked dot paths; parallel.
- https://docs.typesafe.ai/primitives/score.md: 2-10 levels, `score` = Σ level × p, `legend`, divide by top level.
- https://docs.typesafe.ai/primitives/noul.md: `noul` only, no confidence; middle values to a person; raise the
  threshold when a false yes is costly.
- https://docs.typesafe.ai/primitives/choice.md: names and descriptions sent; up to 255 options; "other";
  language detection listed; `choice` = highest-probability option.
- https://docs.typesafe.ai/confidence.md: thresholds 0.5 (unsure) and 0.9 (act) appear as examples; the 3-option
  demo formula `(3 × largest − 1) / 2`.
- https://docs.typesafe.ai/patterns/confidence-routing.md: 0.6 floor, 0.85 for high stakes.
- https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook.md: uncertain band 0.30-0.70 inclusive; 111 ms.
- https://docs.typesafe.ai/sdk/python/api/retries.md: 408, 429, 500-599; 2 retries; 0.5 s doubling to 5 s; jitter
  0.25; honours Retry-After and retry-after-ms (precedence not stated).
- https://docs.typesafe.ai/sdk/python/api/constants.md: `TYPESAFE_API_KEY`; default timeout 10 s.
- https://docs.typesafe.ai/model-jaggedness/jev-1.13.md: weaknesses #1-#9; "Math using score".
- https://docs.typesafe.ai/models.md: `jev-1.13.0` (= `jev-latest`, `jev-preview`); pin the version; $0.042 per
  million input tokens, output free; 64k per request, 32k for state plus the longest question; English best.
  **Drift from spec §2:** the live page now gives throughput as 100K tokens/s and 40 requests/s ("Rate limits are
  adjusting dynamically"), not 250,000 tokens/s and 1,200 requests/min. No code depends on these limits.

## Progress

## Status: EDGE done. `handoff/BUILD_STATUS.md` entry written after `JEV_UI.md` reported UI done (spec §14.1).

### Files (EDGE only)
| File | Change |
|---|---|
| `deploy/cloudflare-edge/src/rating.js` (new) | Rubric constants, masking (`sensitiveTerms`, `ownMask`), containment `guard`, `estimateTokens`, `ratingInput`, `questionPlan`, `requestBody`, all-or-nothing `parseAnswers`, `compose` (weights, blockers, holds, robustness check, status, issues, fixed advice, summary), `agentQuality`, `noStoryQuality`, `sha256Hex`, `storyRater` (interactive hedge, background retries, circuit breaker, auth block). |
| `deploy/cloudflare-edge/src/library.js` | Constructor `rater`, `metric`; `inflight`; `review(user, id, { budget, waitUntil })` with engine resolution, generations (`refs.state.ratingGen`), join/supersede, reuse (`refs.state.lastJev`), escalation (`secondOpinion`), metrics; `get()` adds `rating.running` and `jevAllowed` (full access) and the public reduction of `state.quality`. |
| `deploy/cloudflare-edge/src/library-routes.js` | Save and merge: `{ budget: 'background', waitUntil }`; `/:id/review`: `{ budget: 'interactive', waitUntil }`; rating also starts when only JEV exists. |
| `deploy/cloudflare-edge/src/worker.js` | `LibraryStore` passes `rater: storyRater(env)`. |
| `deploy/cloudflare-edge/src/profile.js` | `jevRating` consent kind; `build()` lists each kind only when stored; `storedConsent`, `storedNames`. `GET /profile/consents` unchanged. |
| `deploy/cloudflare-edge/dev/fake-typesafe.mjs` (new) | Generic deterministic fake (`ok`, `down` = 529, `unsure`), model `fake-jev-local`, checks the key. |
| `deploy/cloudflare-edge/dev/local-edge.mjs` | `FAKE_TYPESAFE=1`: local key, fake TypeSafe, `/__typesafe_mode?m=`; the Library always gets a rater (as worker.js); without the flag every request to api.typesafe.ai is refused. |
| `deploy/cloudflare-edge/test/rating.test.js` (new) | R1-R21 plus constants and a storage-failure regression (28 tests). |
| `deploy/cloudflare-edge/test/library.test.js`, `test/profile.test.js` | Additions only (6 and 3 tests). No existing assertion changed. |
| `deploy/cloudflare-edge/README.md`, `docs/INTEGRATIONS.md`, `docs/THIRD_PARTY.md`, `handoff/CONFIGURATION.md`, `handoff/CODE_MAP.md` | Docs per spec §14.1. |

### Decisions and deviations (each deliberate; spec section in brackets)
1. **ownMask uses the guard's own matching rule** (§3.2, §3.3): every own value that is not a single stoplist word is
   masked case-insensitively, as a substring from 5 characters, word-bounded below that. So masked text can never trip
   the guard, and the guard only ever catches a bypass (R3a). A single stoplist-word value (a contact "Will", a project id
   "Delta") is not rewritten (it would turn every "will" into a label); if one remains, the guard refuses and the review
   agent rates. Name WORDS still use `nameMatcher(..., { contacts: true })` as the spec says.
2. **The guard decodes the JSON before searching** (§3.3 "checks the bytes"): it parses the exact `state.reference` text
   and searches every decoded string. Searching the raw bytes misses a short name right after an escaped newline
   (`\nAlex`: the `n` defeats the word boundary) and any value with a `"` or `\`. Unparseable text fails closed. Tested.
3. **Source excerpts are masked, then cut** (§3.1 writes `mask(excerpt.slice(0, 600))`): cutting raw text first can leave
   a fragment of a name ("Zebrac") that no term matches. The trims to 200 and '' also act on masked text.
4. **`storedConsent` / `storedNames` create no table** (§8.4 says "runs ensure(lib)"): they read the `profiles` row and
   answer false / [] when the table does not exist yet (no profile means no consent and no stored name). This keeps R20
   strict: rating creates no table.
5. **Holds are display strings**, like `blockers`, one per Score (a split reading wins over "unsure"; R10b's evidence is
   "low and split, so a hold"). The UI track built on strings too.
6. **`split` needs a second level with probability > 0**: with `p = [0, 0, 0, 1]` the "second most probable level" is a
   zero, which must not read as split.
7. **An empty story** (`rules`, `no_story`) gets 0.8 × completeness and its core `Missing:` blockers only, not the
   agent's "did not answer; run the review again" (no agent was asked). Its four core fields are empty, so never ready.
8. **Summary on escalation**: "…is running." while the second opinion runs; if it does not answer (or there is no review
   agent at all) that sentence becomes "JEV rated this ready but was unsure. The second opinion did not answer; a reviewer
   should check the unsure parts." (never both "running" and "did not answer").
9. **Metrics**: the JEV row of an escalated rating carries `escalated: 1`; the second opinion's own row carries
   `fallback: 13` with `engine: 2` (answered) or `3` (did not answer) and `escalated: 0`. So the escalation share is
   Σ `escalated` / count(`engine` = 1), exactly once per escalation. `fixFirst` is `{ id, field, label }` (id added).
10. **`rating.running`** ends when the rating (and any second opinion) is stored, not when the index finishes; found by
    replaying browser step 10 (an interactive "Rate again" answered `running: true` for a finished rating). Regression
    test in `test/library.test.js`.
11. **An unexpected (non-RatingError) error on the JEV path** falls back to the review agent with `fallbackReason`
    `rejected` (metric 7). A storage error after a valid answer is not a JEV failure: it propagates and the agent is not
    called (regression test).

### For the UI track
- "Rate again" on an unchanged story body reuses the saved JEV answer (R12), in every fake mode. Browser steps 8 and 9
  already edit the story first; keep it that way.
- After `m=down`, the breaker is open for 60 s: "Rate again" then falls back with `circuit_open` (0 requests).
- Step 10's server side, replayed against `FAKE_TYPESAFE=1` (consent off, then "Rate again"): the response is
  `engine: 'review-agent'`, `fallbackReason: 'no_consent'`, `rating.running: false`.

## Commands and results (EDGE, final tree, after the last code change)
| Command | Result |
|---|---|
| `cd deploy/cloudflare-edge && node --test test/*.test.js` | 484 tests, 484 pass (baseline 447) |
| `node --test test/rating.test.js test/library.test.js` x 8 | 49/49 every run (real-timer budget tests are stable) |
| `node --test tests/*.test.js` | 385 tests, 384 pass, 1 skipped (the UI track added 4) |
| `pytest tests/test_*.py -q` (sandbox off) | 262 passed |
| `python tests/jev_rating_browser.py` (sandbox off; EDGE's fake) | 35 PASS, 0 FAIL, rc 0 (INFO: step 9 "To check" not caught, step 14 needs the mock) |
| `python tests/{library,reuse,autosave,sheet,report,memory}_browser.py` (sandbox off) | rc 0: 14, 19, 33, 17, 19, 9 PASS, 0 FAIL (the index now runs in waitUntil on "Rate again") |
| Mutation checks (scratch copies, restored) | each of 10 safeguards removed alone fails its intended tests |
| `FAKE_TYPESAFE=1 node dev/local-edge.mjs` smoke | bootstrap `jev: true`; consented save rated by JEV (`fake-jev-local`); classify via the fake 200; down mode falls back |
| `node dev/local-edge.mjs` smoke (no flag) | bootstrap `jev: false`; review agent, `no_key`; api.typesafe.ai refused |
| `worker.js` with a stub `cloudflare:workers` loader (scratch) | `LibraryStore.lib.rater` present; `available()` follows `TYPESAFE_API_KEY` at call time |
| `grep -rn api.typesafe.ai tests deploy/cloudflare-edge/test` | fake-fetcher assertions and constants only |

No commit, branch, stash, checkout, reset, restore or clean; no wrangler or deploy; no call to TypeSafe or any provider.

