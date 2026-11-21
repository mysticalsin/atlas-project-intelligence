# Atlas sweep 01 — fix plans

Planner only. No product code in this pull request. Revision v2 after Sentinel PLAN-CHANGES on PR #38 (`a5a24e1b`).

Pinned inputs: confirmer `/cursor/stores/bot/atlas-sweeps/s01/confirm/confirm-report.md` sha256 `57c92dcb651ddef4b7abe9c23424065a2a59fa139d2cdfc6315ce227596eac1c`. Main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`. Red tests `96712474b59d6b058ef00479f2bb2d4eb065801e` (PR #31). External Lows from `/cursor/stores/bot/atlas-sweeps/s01/external/hammer-artex-security.md`, confirmed new at that main.

ATLAS-09 is not in these plans. It belongs to the backend writer (`wiki.py`, `knowledge_routes.py`). ATLAS-11 is already fixed by PR #30. It is not planned again.

`SHA256SUMS` in this directory lists the eight plan files and not this index, so the sums hash stays stable if the index is edited. sha256 of `SHA256SUMS`: `e00f79df60e7a80fd7b1db43760214e7ae67f175e34383e44919f4a01aa83ac8`.

| Plan | sha256 |
|---|---|
| `group-1-scrub-redaction.md` | `abede6fc6f755968ffb24aea3e57fb7808a766dddf8151b2ca81c1ef44ded75e` |
| `group-9-profile.md` | `c5a6862ff124c5b1172d6a676d9df58bdb5d69df51bbf70f9c7c19c2a7a5769c` |
| `group-10-erasure-tenant.md` | `edd6f16fc2445d53e37fea0359c6da620f3d005723add4236e03439c6fbc1e82` |
| `group-11-voice-prompt-transport.md` | `7e657e9e880f5cdffe4a204c9b7a1cfb9312e8978ca9f65baf621c3d75e1a95d` |
| `group-13-worker-auth-routing.md` | `9e4a79054f06c6f0fe26d1e8589cc06f75578e56bcf28dd5d7900ec675c59471` |
| `group-14-rate-limit-consent.md` | `915d241a4814fdea6d93a4210026f8072efb9c19d5ce32dbe2ced20d8e794bc9` |
| `group-16-sign-in-state.md` | `ad5a536a1ce51afdb5e72835419eab57b743b062e745acccd98a68fb95110fa5` |
| `group-17-entra-bootstrap.md` | `0b0e6e8509bbadbb3919ab871fd6cdb678567264684057322a8fd18785429944` |

## Dependency order

These can be built in parallel. Their product files do not overlap, except the one call below.

1. Group 1 — `memory.js`, `sheet.js`, `review.js`, `scrub.js`, new `name-match.js`.
2. Group 9 — `profile.js` only. It keeps the current `rateLimit(...)` call.
3. Group 11 — `atlas_voice/server.py`, `atlas_voice/interview.py`.
4. Group 14 — `ratelimit.js`, `privacy.js`, and only `rateLimit` plus `eraseRateHits` inside `util.js`. Parallel with group 9 because the call signature does not change. Land the `rateLimit` hunk before group 5 edits `email()` in the same file, or keep the hunks apart.
5. Group 16 — `atlas_voice/identity.py` only. **Gated on owner question 3.**
6. Group 17 — `deploy/cloudflare-edge/entra/enable_entra.sh` only. Do not run it.

Group 10 — `subject-rights.js`, `outreach.js`. `teams-routes.js` is owned and should not change behavior. It calls `eraseRateHits` from group 14 and does not edit `util.js`. Land that call after group 14 exports the function, or in the same review once the signature is fixed. Group 10 does not wait on group 3. Group 3 must leave the `sharedWith` write in `library.js` merge, because the B1 setup asserts it is present before erase.

Group 13 is last, and **gated on owner question 2** (one HEAD to the live certs URL). Branch it from PR #30 head `d495233609c8e2a9105a35526ccd7bb4e485a8f1` (`cursor/atlas-oss-head-cleanup`), not from main. Rebase if that head moves. After PR #15, the only overlap to resolve is `deploy/cloudflare-edge/src/app.js`. Do not take `voice-client.js` or `security-log.js` from #15 into this branch. Do not edit `deploy.sh`.

Shared sweep-test files stay red for other groups. A writer proves their own tests with the name pattern in their plan. They do not edit another group's assertions, and they do not mark a test skipped or expected-failure.

## What each plan turns green

| Group | PR #31 tests | New red tests the writer adds |
|---|---|---|
| 1 | H1, M1, L6 in `sweep01-a-logic.test.js` | `sweep01-g1-scrub-props.test.js`, including `M1 a three-letter client name is masked in any case`, `L1 every retain item and sheet field is masked`, `L2 a client name of regex metacharacters is a literal and a pathological name finishes within one second` |
| 9 | L5 in the A file; both F2 tests in `sweep01-f-stress.test.js` | `sweep01-g9-people.test.js`: `M1 a caller-set manager email does not unlock directory lookup`, `M2 a self-written consultant does not unlock lookup`, `M2 the thirty-first distinct lookup in a day is refused after eviction`, `L1 a profile save that conflicts twice fails closed` |
| 10 | B1, B2, both B3, B5 in `sweep01-b-security.test.js` | `sweep01-g10-erasure-props.test.js`: `M1 sendTeams skips an unstamped row`, `M2 whitespace atlas_tenant is null and an empty tenant install is refused`, `M3 a formula address with a leading space or NBSP is rejected`, `L1 an empty alias list deletes no rows`, `L2 address match is case-insensitive and the selector does not use instr`, `L3 a non-object revision loses the address` |
| 11 | `tests/test_sweep01_b_prompt.py` (B4 and HAM-03) | `tests/test_sweep01_g11_headers.py`: `test_l1_non_loopback_upstream_is_wss`, `test_l2_prompt_markers_are_absent_from_logs_and_errors`, `test_l3_prompt_frame_is_sent_before_any_audio` |
| 13 | C-3 line PASS in `sweep01_c_browser.py`; E1 in `sweep01-setup.test.js` | `sweep01-g13-auth.test.js`: `M1 only alg RS256 is imported`, `M2 a cached JWKS older than one hour does not verify`, `M3 unknown kids share one refetch per minute`, `L1 fetch errors and token time claims fail closed`, `L2 the bearer is checked before the body and the body is read once`, `L3 a team value with a port, path, trailing dot, or IP is refused`, `L4 the refusal page escapes HTML`. Gated on question 2. |
| 14 | F3, F4, F8 in `sweep01-f-stress.test.js` | `sweep01-g14-limit.test.js`: `M1 a long clock step holds for one window and does not open a fresh window`, `L1 rate_hits older than one day are pruned and erasure removes the subject`, `L2 out-of-range limit parameters are refused`, `L3 the limit subject is the verified email`, `L4 a beforeCommit that hangs releases the lock` |
| 16 | `tests/test_sweep01_ham.py` (HAM-04) | `tests/test_sweep01_g16_login_props.py`: `test_q3_forwarded_headers_are_ignored_unless_the_operator_mode_is_on`, `test_m1_ipv6_64_shares_a_bucket_and_a_full_table_evicts_the_oldest_flow`, and the six `test_m2_*` cookie and flow-id tests. Gated on question 3. |
| 17 | HAM-05 in `tests/sweep01-ham.test.js` | `tests/sweep01-g17-entra-argv.test.js`: `L1 secret files are opened with mode 0o600`, `L2 a token with a newline or a quote is refused before the curl config is written`, `L3 curl writes stdout and stderr to temp files`, `L4 the EXIT trap is installed after mktemp` |

## Open questions that need the owner

The plans recommend a side for each of these. A reviewer can reject the recommendation. The owner is the one who can answer the facts. v2 marks the ones Sentinel already ruled.

1. PersonaPlex. Does the worker you would run accept the prompt as the first websocket text frame? The B4 test forbids the query parameter. Kyutai is the selected route and does not use this handshake. Group 11.
2. **Gate for group 13.** Access certs. Does `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` return 200 with no redirect? `redirect: 'manual'` fails closed and locks sign-in if it does. One HEAD from an operator network before deploy. Not requested from this agent. Group 13 does not ship until this is answered.
3. **Gate for group 16.** Python sign-in. Is `request.remote` the person, or one shared proxy or NAT? A shared address means the per-remote cap cannot separate the owner from an attacker. Do not use `X-Forwarded-For`. `CF-Connecting-IP` is read only when `ATLAS_TRUST_CF_CONNECTING_IP=1`, which is off by default. Is this gateway even the production sign-in, or is Worker Access the real path? Group 16 does not ship until this is answered.
4. Ruled by Sentinel. Erase deletes the subject's own unstamped Teams row by exact email. `sendTeams` does not use an unstamped row for any tenant until it is restamped. Group 10.
5. Confirm group 5 will not edit `rateLimit` or `eraseRateHits` while group 14 owns those functions inside `util.js`. Group 5 owns `email()` only. Group 14.
6. Confirm group 12 will not keep `Ready when you are` on a page that still loads under the refused production combination, and will not invent a different C-3 sentence. The sentence is the existing `productionDemoConflict` error. Group 13.
7. Confirm presales does not get arbitrary directory lookup. Admin and reviewer do. Presales still resolves people on stories someone else wrote, when they can open that story in full. A self-written consultant does not unlock lookup. Group 9.
8. Already-erased subjects. The address is not stored, so leftovers wait until that subject runs erase again. Is that acceptable, or do you want an operator tool? Group 10 does not add the tool.
9. Ruled by Sentinel. A backward clock holds a spent rate-limit window for at most one window, and a future-dated hit is clamped the same way. The hold does not open a fresh window. Group 14.
10. `ATLAS_CHECKPOINT` and `ATLAS_EVIDENCE_WORKFLOW` look dead. Confirm the runbook should stop naming them, rather than wiring them up. Group 13.
11. Ask and bid-edit rate-limit keys omit the tenant. Adding the tenant would give each tenant its own cap. The plan keeps the current keys. The subject inside the key is the verified email. Confirm. Group 14.

Owner ruling inside group 9, separate from the list above: the directory lookup cap is 30 distinct addresses per UTC day, and admin and reviewer are exempt. The red test uses 30 until the owner changes it.
