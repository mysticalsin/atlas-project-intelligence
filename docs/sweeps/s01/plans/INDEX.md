# Atlas sweep 01 — fix plans

Planner only. No product code in this pull request. Frozen v2 after Sentinel PLAN-CHANGES on PR #38 and Devin's plan debate `6c17bee6`.

Pinned inputs: confirmer `/cursor/stores/bot/atlas-sweeps/s01/confirm/confirm-report.md` sha256 `57c92dcb651ddef4b7abe9c23424065a2a59fa139d2cdfc6315ce227596eac1c`. Main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`. Red tests `96712474b59d6b058ef00479f2bb2d4eb065801e` (PR #31). External Lows from `/cursor/stores/bot/atlas-sweeps/s01/external/hammer-artex-security.md`, confirmed new at that main.

ATLAS-09 is not in these plans. It belongs to the backend writer (`wiki.py`, `knowledge_routes.py`). ATLAS-11 is already fixed by PR #30. It is not planned again.

`SHA256SUMS` in this directory lists the eight plan files and not this index, so the sums hash stays stable if the index is edited. sha256 of `SHA256SUMS`: `1a66487893d26ddd6d10f45d562891dba41984f34defa0d05b24e361d42e3557`.

| Plan | sha256 |
|---|---|
| `group-1-scrub-redaction.md` | `876d4cec1b0a3ca002c6d1b48ea80f9b1b812907989a059bfbdf299dd1331e3d` |
| `group-9-profile.md` | `9caa3fc6cc4e9cdf2906fc722d4a898969a6a418f73db35efdc98fcffb8b22f3` |
| `group-10-erasure-tenant.md` | `bcdce6fe7e0ede9dffe120fa1398cc6f39d8ae4093fc49941a38c18d22f9777f` |
| `group-11-voice-prompt-transport.md` | `2cee610e699d545518b6ae5f26ea3af66f6a8ae7d900dc5245cece32c920ea17` |
| `group-13-worker-auth-routing.md` | `3c102544fd6d883e007a5bb2470b729996c8c49bd1c98f63068b6f9d1591220e` |
| `group-14-rate-limit-consent.md` | `f1e947cca5e8f7747807b8e5cc69238b99e9b4023abcf023b8d0ea7ef76d2566` |
| `group-16-sign-in-state.md` | `11253b092649806d3b853a0d04dcef73a2d9f929bde836b92a825e8c46673930` |
| `group-17-entra-bootstrap.md` | `53f5d40b67e135881884fdd356ad6016642b10a6db8cdef4f9e5fe19d8959fdd` |

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

## Devin and Sentinel

Devin `6c17bee6`: groups 11, 14, 16, and 17 PASS with no design change. Groups 1, 9, 10, and 13 were REVISE and are updated above. Sentinel's earlier rows still stand.

| Group | Devin | What v2 does |
|---|---|---|
| 1 | REVISE | One matcher. Client names are not passed with `{ contacts: true }`. Stoplist names `Air` and `Will` stay masked in the stored and upper-case spellings. Contacts of those words are skipped. Non-stoplist names of 3+ characters are whole-word and case-insensitive. Red test `D1 a stoplist client name stays masked and the same word as a contact does not`. |
| 9 | REVISE | Presales `access() === 'full'` is not a lookup grant. Lookup is limited to the caller's tenant. Red test `D1 a presales lookup does not cross tenants`. |
| 10 | REVISE | Sentinel's delete wins. The s1 teams fixture changes: the other tenant survives only with an `atlas_tenant` stamp. An unstamped row is deleted by exact email, which is what B2 requires. Red test `D1 an unstamped teams row is deleted by exact email and a stamped other-tenant row remains`. |
| 11 | PASS | No change. Question 1 parked for Tony. |
| 13 | REVISE | The rollback-switches line names `ATLAS_TENANT_ISOLATION`, `ATLAS_DEV_IDENTITY`, and `ATLAS_LOCAL_TENANT`. `team.example.evil` is not a refuse-before-fetch fixture. The 302 double follows unless `redirect` is `'manual'`. Red tests `D1 team.example.evil is not the pinned host` and `D1 a followed redirect would authenticate and manual refuses`. Question 2 parked for Tony. |
| 14 | PASS | No design change. Questions 5, 9, and 11 are decided here. |
| 16 | PASS | No design change. Question 3 parked for Tony. |
| 17 | PASS | No design change. |

## Open questions

Decided in this v2:

5. Group 5 owns `email()` only. Group 14 owns `rateLimit` and `eraseRateHits`.
6. Group 12 keeps the existing `productionDemoConflict` sentence and does not show "Ready when you are" under the refused combination. The refusal page is that sentence.
9. The backward-clock hold is clamped to one window, per Sentinel group 14 M1. Red test `M1 a long clock step holds for one window and does not open a fresh window`.
10. Kill-switch names stay where they are read. The rollback-switches line names `ATLAS_TENANT_ISOLATION`, `ATLAS_DEV_IDENTITY`, and `ATLAS_LOCAL_TENANT`. `ATLAS_CHECKPOINT` and `ATLAS_EVIDENCE_WORKFLOW` are not on that line. `ATLAS_ADAPTERS` and `ATLAS_REPLY_GUARD` stay in `kill-switches.js` and the flag_state paragraph.
11. Ask and bid-edit keys stay tenant-free. The subject is the verified email.

Parked for Tony. The plans do not wait on an engineering choice for these. Groups 13 and 16 still do not ship until Tony answers 2 and 3.

1. PersonaPlex. Does the worker you would run accept the prompt as the first websocket text frame? The B4 test forbids the query parameter. Kyutai is the selected route and does not use this handshake. Group 11.
2. Access certs. Does `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` return 200 with no redirect? `redirect: 'manual'` fails closed. One HEAD from an operator network before group 13 ships.
3. Python sign-in. Is `request.remote` the person, or one shared proxy or NAT? Do not use `X-Forwarded-For`. `CF-Connecting-IP` is off unless `ATLAS_TRUST_CF_CONNECTING_IP=1`. Group 16 does not ship until this is answered.
4. Are consultant emails unique across ATLAS tenants? The plan follows Sentinel until Tony says otherwise: erase deletes the subject's own unstamped Teams row by exact email, and send does not use an unstamped row.
7. Presales lookup. The plan does not give presales the role-wide `full` grant, and it does not cross tenants. Tony can widen it later.
8. Already-erased subjects. Leftovers wait until that subject runs erase again. This plan does not add an operator tool.

Owner ruling inside group 9: the directory lookup cap is 30 distinct addresses per UTC day, and admin and reviewer are exempt. The red test uses 30 until Tony changes it.
