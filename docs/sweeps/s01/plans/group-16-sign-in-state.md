# Group 16 — sign-in state

Plan only. Debate this before anyone edits product code.

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

After: a single remote is refused well before 500 live flows. A different remote still gets a redirect. Expired rows are gone before either decision. The table cannot grow without a bound. A remote that has no pending flow can still obtain one when the global table is full, by displacing the oldest flow of the remote that holds the most, and only when that remote holds more than one.

What remains: if every employee shares one `request.remote` (a reverse proxy or a NAT that aiohttp sees as a single address), the per-remote cap is a cap on all of them together. This plan does not read `X-Forwarded-For`. The hammer review recorded that forwarding headers are not rate-limit keys.

## Chosen design

Sweep first, as today. The test's 100 expired rows disappear, and the following insert leaves `len(flows) == 1`.

Then:

- Per remote, at most 20 live flows. The 21st `login` from that remote raises `HTTPTooManyRequests`. Twenty is enough for a small office that truly has one address and several people mid-login, and it is far below the test's 500.
- Global live flows at most 100, the current memory bound.
- When the global table is full and the caller has zero flows, drop the oldest flow of the remote that currently holds the largest count, if that count is greater than 1, then insert. A brand-new remote is not stuck behind a single attacker who opened many flows from one other address.
- When the caller is already at 20, do not evict their own oldest flow to let them continue. They are the attacker in the test, and they must see 429.
- Key the remote with `str(request.remote or '')`. Empty remote shares one bucket. Do not parse `X-Forwarded-For`, `X-Real-IP`, or `CF-Connecting-IP`.

`callback` is unchanged: a flow that was evicted fails the existing "Sign-in expired. Start again." path. The cookie name, the 600-second TTL, and the session cap in `issue` stay.

Store the remote on the flow tuple so eviction can group by it. The tuple is in-process only.

## Alternatives rejected

1. Raise the global cap from 100 to 1000 and leave it global. Rejected because one remote still fills it and the second remote in the test still gets 429. The test fails, and the owner is still locked out by one client.
2. Cap by the `atlas_login_flow` cookie. Rejected because the cookie is set on the response of a successful `login`. The attacker's first requests have no cookie. The only pre-auth discriminator the test provides is `request.remote`.
3. Read `X-Forwarded-For` and cap that. Rejected because the client can send that header. The hammer review called this out. A proxy that this process trusts would be an operator configuration, and there is no such setting in `identity.py` today.

## Invariants and properties

Add cases to a new `tests/test_sweep01_g16_login_props.py` so the PR #31 file stays the contract it already is. `pytest`. No `skip`, no `xfail`. Stub MSAL the same way. Monkeypatch `time.monotonic`.

- Property: for attacker counts 1, 20, 21, 100, the attacker is refused at or before the 21st live flow, and `len(flows)` never exceeds 100.
- A second remote, after that refusal, gets 302, and the attacker's flows are still present (we did not wipe them to make room, unless the global cap forced an eviction of the attacker's oldest because the new remote had zero).
- Expired flows: a table of 100 rows whose deadline is `now - 1` plus one live row from the attacker becomes one live row after sweep, and the new remote's login is 302.
- Eviction does not drop a flow that belongs to the remote that has only one, while some other remote has more than one.
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

## Open question for the owner

In the deployment that actually runs this gateway, is `request.remote` the person, or one shared proxy or NAT address? If it is shared, a per-remote cap locks the owner together with the attacker, and this fix should not be described as per-person. The Worker Access sign-in does not use this table. Say which sign-in is in front of users before this lands.
