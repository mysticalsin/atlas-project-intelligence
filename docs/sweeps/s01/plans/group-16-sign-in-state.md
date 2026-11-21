# Group 16 — sign-in state

Plan only. Debate this before anyone edits product code. Revision v4 (Sentinel re-review `e4e9dada` of `4d15c83c`). **This group does not ship until owner question 3 is answered.** Never trust `X-Forwarded-For`. `CF-Connecting-IP` is read only when `ATLAS_TRUST_CF_CONNECTING_IP=1`, the TCP peer is loopback, the tunnel, or an operator allowlist, and the header is exactly one IP literal. That mode is off by default. The v4 section wins where an earlier sentence trusts the header from any peer.

Pinned inputs: confirmer report sha256 `57c92dcb651ddef4b7abe9c23424065a2a59fa139d2cdfc6315ce227596eac1c`, main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`, red tests `96712474b59d6b058ef00479f2bb2d4eb065801e` (PR #31).

Finding: HAM-04.

## Done when

1. `python3 -m pytest tests/test_sweep01_ham.py -q` passes.
2. One `request.remote` cannot fill the pending-sign-in table. Expired flows are evicted before the cap is applied. After that remote is refused, a different `request.remote` still receives the 302 to the stub authorization URL.
3. The test client stays a stub. No call to Microsoft. No edit to `atlas_voice/server.py`.
4. No skip, no expected failure.

## Files this group may edit

`atlas_voice/identity.py` only.

Do not edit `server.py` (group 11), `config.py` (group 15), or the HAM-04 test except to fix an assertion that this plan has made obsolete. The test should not need an edit. Its assertions are the contract:

- 100 expired flows are swept, one login returns 302, and `len(flows)` is 1.
- The attacker remote is refused with 429 before 500 pending sign-ins.
- A different remote then gets 302.

## Failing test from PR #31

| Test | File | Finding |
|---|---|---|
| `test_ham04_one_client_cannot_fill_the_sign_in_table` | `tests/test_sweep01_ham.py` | HAM-04 |

TEST COMMAND:

```sh
python3 -m pytest tests/test_sweep01_ham.py -q
```

The Microsoft client in the test is `FakeMsal`. `Identity.client` is assigned after construction. Do not construct a real `ConfidentialClientApplication`.

## Threat model

Before: `login` sweeps expired flows, then refuses everyone when `len(self.flows) >= 100`. The cap is global. One client that completes `initiate_auth_code_flow` 100 times, without finishing the callback, fills the table for ten minutes (the flow TTL). Every other `request.remote`, including the owner, gets HTTP 429. Expired rows are already dropped by `sweep`, so the attack uses live rows. The flows hold the MSAL auth-code state. They do not hold the client secret. The damage is availability of sign-in, and a table that grows to the cap.

After: a single remote key is refused well before 500 live flows. A different remote still gets a redirect. Expired rows are gone before either decision. The table cannot grow without a bound. When the global table is full, the oldest flow in the table is dropped so a remote that is under its own cap still gets a redirect. IPv6 addresses in one /64 share a key.

What remains: if every employee shares one `request.remote` (a reverse proxy or a NAT that aiohttp sees as a single address), the per-remote cap is a cap on all of them together. `X-Forwarded-For` is never a key. `CF-Connecting-IP` is a key only in the operator mode below, which is off until owner question 3 says the edge is Cloudflare and the TCP peer is one this process trusts. An IPv6 /64 and IPv4 address churn are residuals, stated in v4. They are not new caps.

## Chosen design

Sweep first, as today. The test's 100 expired rows disappear, and the following insert leaves `len(flows) == 1`.

Then:

- The remote key is `request.remote`. Use `CF-Connecting-IP` only when every one of these holds. Otherwise fall back to `request.remote`, including when the header is present. Never read `X-Forwarded-For` or `X-Real-IP`. Off by default. Empty remote shares one bucket.
  - `ATLAS_TRUST_CF_CONNECTING_IP` is exactly `1`.
  - `request.remote` is loopback (`127.0.0.1` or `::1`), or it equals `ATLAS_TUNNEL_PEER` when that value is one IP literal, or it is one of the IP literals in `ATLAS_TRUSTED_PEERS` (comma-separated). A hostname in either variable is not a peer.
  - The header, after one strip of surrounding whitespace, is exactly one IP literal. A list, a port, a hostname, or a second address is not used.
- An IPv6 address is grouped by its /64. `2001:db8:1:2::1` and `2001:db8:1:2::abcd` share a bucket. A different /64 does not. An IPv4 address stays the whole address. IPv4-mapped IPv6 is grouped as that IPv4.
- Per remote key, at most 20 live flows. The 21st `login` from that key raises `HTTPTooManyRequests`. Do not evict to let that same key continue. That is what makes HAM-04 return 429 before 500.
- Global live flows at most 100. When the table is full and the caller is under their per-remote cap, drop the oldest flow in the whole table, then insert, and return 302. Do not return 429 only because the global table is full.
- Flow id is at least 128 bits from `secrets` (`token_bytes(16)` or stronger), single use, and checked against the stored state. A mismatch is 401. TTL stays 600 seconds. The authorize URL carries a nonce that callback checks. The login cookie is `HttpOnly` and `SameSite=Lax`, `Secure` when the request scheme is https, and `Path=/auth`. A cookie for flow A presented with flow B's `state` is 401 and does not redeem B.
- `callback` removes the flow from the table before it calls MSAL. A second callback, and a callback that arrives while redemption is in progress, finds no flow.

`callback` of an evicted or reused flow fails the existing "Sign-in expired. Start again." path. The cookie name and the session cap in `issue` stay.

Store the remote key on the flow tuple so eviction can group by it. The tuple is in-process only.

## Alternatives rejected

1. Raise the global cap from 100 to 1000 and leave it global. Rejected because one remote still fills it and the second remote in the test still gets 429. The test fails, and the owner is still locked out by one client.
2. Cap by the `atlas_login_flow` cookie. Rejected because the cookie is set on the response of a successful `login`. The attacker's first requests have no cookie. The only pre-auth discriminator the test provides is `request.remote`.
3. Read `X-Forwarded-For` and cap that. Rejected because the client can send that header. The hammer review called this out. `ATLAS_TUNNEL_PEER` and `ATLAS_TRUSTED_PEERS` name TCP peers. They do not name a header the client sets.

## Invariants and properties

Add cases to a new `tests/test_sweep01_g16_login_props.py` so the PR #31 file stays the contract it already is. `pytest`. No `skip`, no `xfail`. Stub MSAL the same way. Monkeypatch `time.monotonic`.

- Property: for attacker counts 1, 20, 21, 100, the attacker is refused at or before the 21st live flow, and `len(flows)` never exceeds 100.
- A second remote, after that refusal, gets 302, and the attacker's flows are still present (we did not wipe them to make room, unless the global cap forced an eviction of the attacker's oldest because the new remote had zero).
- Expired flows: a table of 100 rows whose deadline is `now - 1` plus one live row from the attacker becomes one live row after sweep, and the new remote's login is 302.
- When the table is at 100, the next login from a new remote returns 302 and the oldest flow, whichever remote it belonged to, is gone. The 21st live flow from one key is still 429, and that key's oldest flow is not evicted to make room for a 22nd.
- `callback` with an evicted cookie is 401 "Sign-in expired. Start again."

Boundaries: `request.remote` of `None` and `''` share a bucket. Two remotes that differ only by case are different if the test's strings differ; do not lowercase, because the test uses IP literals.

## Data migration

None. The table is process memory. A restart clears it, which is the current behavior and which logs everyone out of *pending* sign-in only. Established sessions are the other map.

## Rollback

Revert `identity.py`. The global cap of 100 returns. One client can lock sign-in again. No persisted rows to migrate.

## Open PRs #15–#30

No PR in #15–#30 edits `atlas_voice/identity.py`. PR #15 is the Worker Access identity-change path (`app.js`, `voice-client.js`). It does not use this flow table. Do not "align" the two caps in one patch.

Group 11 edits `server.py` in the same process (prompt transport and HSTS). The login route stays in `Identity.login`. Group 11 must not need a change in this file to set response headers; the middleware wraps the `HTTPFound` this function returns, as long as the response is not prepared. `HTTPFound` is not prepared when raised or returned through the middleware. Confirm that in group 11's plan, not by editing `server.py` here.

## Owner lockout

The owner is locked out of *this* sign-in if their `request.remote` is the attacker's remote. That happens when a reverse proxy presents one peer address for every client. Per-remote 20 then means the 21st concurrent pending login from that proxy gets 429, and eviction will drop the oldest of those 20, which might be the owner's half-finished login. Their callback then says the sign-in expired. They start again.

This plan will not read a forwarding header to avoid that, because a forged header is a worse failure. The Worker Access path is a different sign-in and is not limited by this table. If the Python gateway is behind a proxy and is the production sign-in, the owner has to say so before this cap ships. See the question.

A remote with zero flows can still get a redirect while some other remote holds many. That is the case the red test builds, and it is the case that stops one laptop from locking a second laptop.

`issue` still returns 503 when `sessions` is at `max_sessions`. This plan does not change that. Filling pending flows must not be a way to fill sessions: `login` does not call `issue`.

## Diff size

About 70 lines in `identity.py` and about 80 lines of property tests.

## v2 — Sentinel

Devin's plan debate (`6c17bee6`) is PASS for this group. No design change from that pass. **Gated on owner question 3, which is parked for Tony.** File: `tests/test_sweep01_g16_login_props.py`. Write these before the fix. No skip, no xfail. Stub MSAL. Do not call Microsoft.

| Sentinel | Change | Red test |
|---|---|---|
| never XFF | With the operator mode unset, `X-Forwarded-For` and `CF-Connecting-IP` do not change the bucket. With the mode on and the peer outside loopback, the tunnel, and the allowlist, `CF-Connecting-IP` still does not. `X-Forwarded-For` never does. | `test_q3_forwarded_headers_are_ignored_unless_the_operator_mode_is_on` |
| M1 | Two addresses in one IPv6 /64 share the cap of 20. A third address in another /64 still receives 302. When 100 live flows fill the table, the next login from a new remote returns 302 and the oldest flow is gone. It does not return 429. The 21st login from the same key still returns 429. | `test_m1_ipv6_64_shares_a_bucket_and_a_full_table_evicts_the_oldest_flow` |
| M2 | The flow id has at least 128 bits. | `test_m2_flow_id_is_at_least_128_bits` |
| M2 | A second callback with the same flow id is 401. | `test_m2_flow_id_is_single_use` |
| M2 | A callback whose state does not match the stored state is 401. | `test_m2_state_mismatch_is_401` |
| M2 | A flow older than 600 seconds is rejected. | `test_m2_flow_expires_at_600_seconds` |
| M2 | The authorize redirect URL has a nonce, and callback rejects a missing or different nonce. | `test_m2_authorize_url_has_a_nonce` |
| M2 | On an https request the login cookie is `HttpOnly`, `Secure`, and `SameSite=Lax`. | `test_m2_login_cookie_is_httponly_secure_samesite_lax` |

## v4 — Sentinel re-review `e4e9dada`

G1, G9, G10, G13, and G14 were AGREED on that review. This group was PLAN-CHANGES. File: `tests/test_sweep01_g16_login_props.py`. Write these before the fix. No skip, no xfail. Stub MSAL. Do not call Microsoft.

| Sentinel | Change | Red test |
|---|---|---|
| M1 | Mode on, peer `127.0.0.1`, header one IPv4 literal. The bucket is that header, not the loopback peer. | `test_m1_loopback_peer_trusts_one_cf_connecting_ip` |
| M1 | Mode on, `ATLAS_TUNNEL_PEER` set to the TCP peer, header one IPv6 literal. The bucket is that header. | `test_m1_tunnel_peer_trusts_one_cf_connecting_ip` |
| M1 | Mode on, the TCP peer listed in `ATLAS_TRUSTED_PEERS`, header one IP literal. The bucket is that header. | `test_m1_allowlisted_peer_trusts_one_cf_connecting_ip` |
| M1 | Mode on, TCP peer `203.0.113.8`, which is none of the three. Header `198.51.100.7`. The bucket is `203.0.113.8`. | `test_m1_any_other_peer_ignores_cf_connecting_ip` |
| M1 | Mode on, peer loopback, header `198.51.100.7, 203.0.113.8` or `198.51.100.7:443` or `client.example`. The bucket is the loopback peer. | `test_m1_a_header_that_is_not_one_ip_literal_falls_back_to_remote` |
| L1 | Flow A's cookie with flow B's `state` is 401. The `Set-Cookie` path is `/auth`, not `/`. | `test_l1_flow_cookie_does_not_carry_another_flows_state` |
| L2 | When the stub `acquire_token_by_auth_code_flow` is entered, the flow id is already absent from the table. | `test_l2_flow_is_consumed_before_msal_redemption` |
| L3 | No new control. State the residual below. | none |

L3 residual. An IPv6 /64 shares one cap, so a person who is given another address in an attacker's /64 shares that attacker's 20. An IPv4 key is the whole address, so a client that changes IPv4 source gets a new cap of 20 each time. Five such addresses can fill the global table of 100, and the next login evicts the oldest flow. That churn does not raise the per-address cap above 20. This plan does not add a broader IPv4 prefix or a tighter /64.

## Open question for the owner

**Gate for this group.** In the deployment that actually runs this gateway, is `request.remote` the person, or one shared proxy or NAT address? If it is shared, a per-remote cap locks the owner together with the attacker. This plan does not trust `X-Forwarded-For`. `CF-Connecting-IP` is used only when `ATLAS_TRUST_CF_CONNECTING_IP=1` and the TCP peer is loopback, `ATLAS_TUNNEL_PEER`, or `ATLAS_TRUSTED_PEERS`, and the header is one IP literal. The mode stays off until you say the edge in front of this process is Cloudflare and name that peer. The Worker Access sign-in does not use this table. Say which sign-in is in front of users before this lands.
