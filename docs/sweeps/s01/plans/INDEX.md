# Atlas sweep 01 — fix plans

Planner only. No product code, no commit, no pull request.

Pinned inputs: confirmer `/cursor/stores/bot/atlas-sweeps/s01/confirm/confirm-report.md` sha256 `57c92dcb651ddef4b7abe9c23424065a2a59fa139d2cdfc6315ce227596eac1c`. Main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`. Red tests `96712474b59d6b058ef00479f2bb2d4eb065801e` (PR #31). External Lows from `/cursor/stores/bot/atlas-sweeps/s01/external/hammer-artex-security.md`, confirmed new at that main.

ATLAS-09 is not in these plans. It belongs to the backend writer (`wiki.py`, `knowledge_routes.py`). ATLAS-11 is already fixed by PR #30. It is not planned again.

`SHA256SUMS` in this directory lists the eight plan files and not this index, so the sums hash stays stable if the index is edited. sha256 of `SHA256SUMS`: `d0a4d6fd2f1bb73d7893cdad8b018798530d581490deb55aaa1e7f70d9985746`.

| Plan | sha256 |
|---|---|
| `group-1-scrub-redaction.md` | `f5b202fc0e6098c7b21ea093deb6486f3e724154550dd2e2cfbbcdc2bbc65210` |
| `group-9-profile.md` | `8442e7e5ac29ab454aa798b39b348e8bdeb17f42be15412a921809e60debb5a2` |
| `group-10-erasure-tenant.md` | `e2c246aac81cb820d02c03afdc9607c3f58a681b17d97bcf28614fccefa01d2f` |
| `group-11-voice-prompt-transport.md` | `9643c2a26ad4beea6f09072f0d9c18d26281da65ddb6597d5d777a281217ca64` |
| `group-13-worker-auth-routing.md` | `b699fb0d090f13ca792cc784846009d38a08345250ff0099a7d746770ef0019d` |
| `group-14-rate-limit-consent.md` | `0f3cd6f54cd61b32a29e59ef034127633d779c972999a19e8d8a513682bbae51` |
| `group-16-sign-in-state.md` | `f58a0aeab4ec2eb8e8b1eef22b2d90f3fd8f249e304a74671c501bdda4ca79fd` |
| `group-17-entra-bootstrap.md` | `b4d803f59c612a4cffbb8e2ae85d59a2408a93a67e425b25fa2afa2d31cf2613` |

## Dependency order

These seven can be built in parallel. Their product files do not overlap.

1. Group 1 — `memory.js`, `sheet.js`, `review.js`, `scrub.js`, new `name-match.js`.
2. Group 9 — `profile.js` only. It keeps the current `rateLimit(...)` call.
3. Group 10 — `subject-rights.js`, `outreach.js`. `teams-routes.js` is owned and should not change behavior.
4. Group 11 — `atlas_voice/server.py`, `atlas_voice/interview.py`.
5. Group 14 — `ratelimit.js`, `privacy.js`, and only `rateLimit` inside `util.js`. Parallel with group 9 because the call signature does not change. Land the `rateLimit` hunk before group 5 edits `email()` in the same file, or keep the hunks apart.
6. Group 16 — `atlas_voice/identity.py` only.
7. Group 17 — `deploy/cloudflare-edge/entra/enable_entra.sh` only. Do not run it.

Group 13 is last. Branch it from PR #30 head `d495233609c8e2a9105a35526ccd7bb4e485a8f1` (`cursor/atlas-oss-head-cleanup`), not from main. Rebase if that head moves. After PR #15, the only overlap to resolve is `deploy/cloudflare-edge/src/app.js`. Do not take `voice-client.js` or `security-log.js` from #15 into this branch. Do not edit `deploy.sh`.

Group 10 does not wait on group 3. Group 3 must leave the `sharedWith` write in `library.js` merge, because the B1 setup asserts it is present before erase.

Shared sweep-test files stay red for other groups. A writer proves their own tests with the name pattern in their plan. They do not edit another group's assertions, and they do not mark a test skipped or expected-failure.

## What each plan turns green

| Group | PR #31 tests | New red test the writer adds |
|---|---|---|
| 1 | H1, M1, L6 in `sweep01-a-logic.test.js` | `sweep01-g1-scrub-props.test.js` |
| 9 | L5 in the A file; both F2 tests in `sweep01-f-stress.test.js` | `sweep01-g9-people.test.js` (ATLAS-08) |
| 10 | B1, B2, both B3, B5 in `sweep01-b-security.test.js` | `sweep01-g10-erasure-props.test.js` |
| 11 | `tests/test_sweep01_b_prompt.py` (B4 and HAM-03) | `tests/test_sweep01_g11_headers.py` (ATLAS-10) |
| 13 | C-3 line PASS in `sweep01_c_browser.py`; E1 in `sweep01-setup.test.js` | `sweep01-g13-auth.test.js` (ATLAS-06 and ATLAS-12) |
| 14 | F3, F4, F8 in `sweep01-f-stress.test.js` | `sweep01-g14-limit.test.js` (ATLAS-07) |
| 16 | `tests/test_sweep01_ham.py` (HAM-04) | `tests/test_sweep01_g16_login_props.py` |
| 17 | HAM-05 in `tests/sweep01-ham.test.js` | optional `tests/sweep01-g17-entra-argv.test.js`; the PR #31 test is already the contract |

## Open questions that need the owner

The plans recommend a side for each of these. A reviewer can reject the recommendation. The owner is the one who can answer the facts.

1. PersonaPlex. Does the worker you would run accept the prompt as the first websocket text frame? The B4 test forbids the query parameter. Kyutai is the selected route and does not use this handshake. Group 11.
2. Access certs. Does `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` return 200 with no redirect? `redirect: 'manual'` fails closed and locks sign-in if it does. One HEAD from an operator network before deploy. Not requested from this agent. Group 13.
3. Python sign-in. Is `request.remote` the person, or one shared proxy or NAT? A shared address means the per-remote cap cannot separate the owner from an attacker. Do not use `X-Forwarded-For`. Is this gateway even the production sign-in, or is Worker Access the real path? Group 16.
4. Are consultant emails unique across ATLAS tenants? A blank `teams_conversations.atlas_tenant` is deleted by the first tenant that erases that email. Group 10.
5. Confirm group 5 will not edit `rateLimit` while group 14 owns that function inside `util.js`. Group 5 owns `email()` only. Group 14.
6. Confirm group 12 will not keep `Ready when you are` on a page that still loads under the refused production combination, and will not invent a different C-3 sentence. The sentence is the existing `productionDemoConflict` error. Group 13.
7. Confirm presales does not get arbitrary directory lookup. Admin and reviewer do. Presales still resolves people on stories they can fully open. Group 9.
8. Already-erased subjects. The address is not stored, so leftovers wait until that subject runs erase again. Is that acceptable, or do you want an operator tool? Group 10 does not add the tool.
9. A backward clock holds a spent rate-limit window until the clock catches the high-water mark. Confirm that lockout is preferred to a fresh window. Group 14. The F8 test requires the hold.
10. `ATLAS_CHECKPOINT` and `ATLAS_EVIDENCE_WORKFLOW` look dead. Confirm the runbook should stop naming them, rather than wiring them up. Group 13.
11. Ask and bid-edit rate-limit keys omit the tenant. Adding the tenant would give each tenant its own cap. The plan keeps the current keys. Confirm. Group 14.
