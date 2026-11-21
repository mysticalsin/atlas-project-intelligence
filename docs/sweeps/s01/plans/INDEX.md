# Atlas sweep 01 — fix plans

Planner only. No product code in this pull request. Frozen v4 after Sentinel re-review `e4e9dada` of `4d15c83c`. Group 14 is unchanged in this freeze.

Pinned inputs: confirmer `/cursor/stores/bot/atlas-sweeps/s01/confirm/confirm-report.md` sha256 `57c92dcb651ddef4b7abe9c23424065a2a59fa139d2cdfc6315ce227596eac1c`. Main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`. Red tests `96712474b59d6b058ef00479f2bb2d4eb065801e` (PR #31). External Lows from `/cursor/stores/bot/atlas-sweeps/s01/external/hammer-artex-security.md`, confirmed new at that main.

ATLAS-09 is not in these plans. It belongs to the backend writer (`wiki.py`, `knowledge_routes.py`). ATLAS-11 is already fixed by PR #30. It is not planned again.

`SHA256SUMS` in this directory lists the eight plan files and not this index, so the sums hash stays stable if the index is edited. sha256 of `SHA256SUMS`: `dc5cb5f642f8f3b68f3413e65534e9d2c0959eba56e114404d8ad63183dcbd4f`.

| Plan | sha256 |
|---|---|
| `group-1-scrub-redaction.md` | `65a3e4ade838ae9229a8d040655a373612af0632140c08cfd99997f741eef2a2` |
| `group-9-profile.md` | `bc5475aa8d955fc52e19b8efb19fd9f3f0fd7b205f61794fc52602e3e6b4a399` |
| `group-10-erasure-tenant.md` | `1d303dcec95302090d809a5538dce5dbba05875836a7ab330e3187fa39d69448` |
| `group-11-voice-prompt-transport.md` | `2cee610e699d545518b6ae5f26ea3af66f6a8ae7d900dc5245cece32c920ea17` |
| `group-13-worker-auth-routing.md` | `a4acef1226dedc5d9d69c1fd39e7356449a62ab17d0a0191f0a9ea768cc75374` |
| `group-14-rate-limit-consent.md` | `f1e947cca5e8f7747807b8e5cc69238b99e9b4023abcf023b8d0ea7ef76d2566` |
| `group-16-sign-in-state.md` | `d43838ae1f854f60d09204cf0d26299f3b1d43db382743d3282358f49b1bdba0` |
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
| 16 | `tests/test_sweep01_ham.py` (HAM-04) | `tests/test_sweep01_g16_login_props.py`: the five `test_m1_*` peer cases, `test_l1_flow_cookie_does_not_carry_another_flows_state`, `test_l2_flow_is_consumed_before_msal_redemption`, plus the earlier `test_q3_*`, `/64` eviction, and `test_m2_*` tests. Gated on question 3. |
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

## v4 — Sentinel `e4e9dada`

Agreed, wording or tests only: groups 1, 9, 10, and 13. Group 14 agreed and is not edited. Group 16 is the design change: `CF-Connecting-IP` only from loopback, the tunnel, or an allowlisted TCP peer, and only when the header is one IP literal. Otherwise the key is `request.remote`.

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
3. Python sign-in. Is `request.remote` the person, or one shared proxy or NAT? Do not use `X-Forwarded-For`. `CF-Connecting-IP` is used only when `ATLAS_TRUST_CF_CONNECTING_IP=1`, the TCP peer is loopback, the tunnel, or an allowlisted peer, and the header is one IP literal. Group 16 does not ship until this is answered.
4. Are consultant emails unique across ATLAS tenants? The plan follows Sentinel until Tony says otherwise: erase deletes the subject's own unstamped Teams row by exact email, and send does not use an unstamped row.
7. Presales lookup. The plan does not give presales the role-wide `full` grant, and it does not cross tenants. Tony can widen it later.
8. Already-erased subjects. Leftovers wait until that subject runs erase again. This plan does not add an operator tool.

Owner ruling inside group 9: the directory lookup cap is 30 distinct addresses per UTC day, and admin and reviewer are exempt. The red test uses 30 until Tony changes it.
