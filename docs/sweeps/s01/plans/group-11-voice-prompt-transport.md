# Group 11 — voice prompt transport

Plan only. Debate this before anyone edits product code.

Pinned inputs: confirmer report sha256 `57c92dcb651ddef4b7abe9c23424065a2a59fa139d2cdfc6315ce227596eac1c`, main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`, red tests `96712474b59d6b058ef00479f2bb2d4eb065801e` (PR #31). External review: ATLAS-10 in `/cursor/stores/bot/atlas-sweeps/s01/external/hammer-artex-security.md`. HAM-03 is B4. One test covers both.

Findings: B4 / HAM-03, ATLAS-10.

## Done when

1. `python3 -m pytest tests/test_sweep01_b_prompt.py -q` passes. Both synthetic markers are absent from the upstream query and present in the first upstream websocket message.
2. A new header test passes: an HTTPS origin sends `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `Cross-Origin-Opener-Policy: same-origin`, and `Cross-Origin-Resource-Policy: same-origin`. An `http://127.0.0.1` origin does not send those three.
3. The gateway still sends the voice name as `voice_prompt` and still waits for the `0x00` model-ready byte before it accepts microphone audio.
4. No test is skipped or expected-failure. No provider is called. The B4 fixture is in-process.

## Files this group may edit

- `atlas_voice/server.py`
- `atlas_voice/interview.py`
- `tests/test_sweep01_g11_headers.py` (new)

Do not edit `atlas_voice/config.py` (group 15), `atlas_voice/identity.py` (group 16), `atlas_voice/kyutai.py`, or `deploy/cloudflare-edge/src/security-headers.js`. Copy the three header values. Cite `security-headers.js` in a comment. Do not import the Worker from Python.

## Failing tests from PR #31

| Test | File | Finding |
|---|---|---|
| `test_b4_upstream_url_does_not_carry_project_or_preference_text` | `tests/test_sweep01_b_prompt.py` | B4 and HAM-03 |

The test fails when either marker is in the upstream query or missing from the first upstream websocket message. Removing the query parameter and dropping the prompt does not pass. The fixture reads one message, then sends `0x00`.

TEST COMMAND:

```sh
python3 -m pytest tests/test_sweep01_b_prompt.py tests/test_sweep01_g11_headers.py -q
```

Needs the local test extras (`aiohttp`, `pytest`, `pytest-asyncio`). No Microsoft call, no NVIDIA call.

## Additional red test — ATLAS-10

`tests/test_sweep01_g11_headers.py`. Write it first.

Boot `create_app` with `ATLAS_ORIGIN=https://atlas.example` and `ATLAS_AUTH=entra` on a loopback socket. The Microsoft client is not started: the test only `GET`s `/` or any path the middleware wraps. If Entra construction needs a client id, use the same stub pattern as `tests/test_sweep01_ham.py` (a `Config` with `auth_mode` left as the default local mode is not sufficient, because local mode is HTTP). Set `auth_mode='entra'` only if `Identity` can be constructed without a network call. If `Identity.__init__` imports `msal` and builds a confidential client, monkeypatch `msal.ConfidentialClientApplication` to a stub, as HAM-04 already stubs the client at login time. Do not call `login.microsoftonline.com`.

Assert the three headers on the response. Repeat with `origin='http://127.0.0.1:9'` and assert the three header names are absent. The B4 test's origin is HTTP and must stay free of HSTS.

## Threat model

Before, B4: `server.py` puts `text_prompt` on the PersonaPlex websocket query. The prompt is the role, the project notes, and the private preference phrase from memory. It lands in the process URL, the proxy access log, and `Referer` if anything follows the URL. The first upstream frame does not carry it. The confirmer saw both synthetic markers in the query and in neither frame. The full prompt is not printed in the test output; keep it that way.

Before, ATLAS-10: the gateway sets `Cache-Control`, `nosniff`, `Referrer-Policy`, and a microphone `Permissions-Policy`. It does not set HSTS, COOP, or CORP. The Worker sets all three on every non-101 response (`security-headers.js`: HSTS `max-age=63072000; includeSubDomains`). A browser that talked to `https://atlas.example` will still accept a later `http://` navigation to that host. COOP and CORP are the isolation headers the Worker already sends.

After: the query carries the voice name only. The first upstream text frame is the prompt, and it is sent before the gateway waits for `0x00`. HTTPS responses carry the three headers. HTTP loopback does not, so a local preview does not plant HSTS for `127.0.0.1`.

What remains: the browser still sends the project to the gateway inside the authenticated websocket `start` message. That is the session, not a URL. Server logs that print the outbound URL will no longer contain the notes. A log line that prints the frame would. Do not add one.

## Chosen design

`interview.make_prompt` stays the only builder of the role and the project JSON. Stop measuring the budget with `urlencode({'text_prompt': ...})`. Measure the UTF-8 length of the prompt itself, cap 7400 bytes, and keep the existing shrink loop (preferences, then prior notes, then title fields) so a large project still fits a frame. The shrink must not run until the markers would be removed from the small fixture: the fixture notes are under the 220-character `clean` limit and the preference is under 500. Add an assertion in the existing unit area, or in the new header file's neighbor, that a short project comes back unchanged.

`server.py` `ws_connect` params become `{ voice_prompt: voice_name }` only. Drop the 7800-byte check on `urlencode(params)`. After the socket is up, `send_str(prompt)` (one text frame), then start the existing `model_ready` / `client_cancel` wait. Sending after the wait deadlocks the fixture: it will not send `0x00` until it has read the prompt, and the gateway will not send the prompt until it has read `0x00`.

The microphone path is unchanged: audio is still refused until `first.data == b'\x00'`.

ATLAS-10, in the `boundary` middleware, next to the headers already set when `response.prepared` is false: if `urlsplit(config.origin).scheme == 'https'`, set the three headers to the Worker values. Do not set them for `http`. Do not overwrite a header the handler already set. WebSocket responses that are already prepared skip this block today; leave that. The red test is a normal `GET`.

Do not log `prompt`, the query string of the upstream URL, or the header values.

## Alternatives rejected

1. Send the prompt both as a query parameter and as the first frame, so a stock PersonaPlex that only reads the query still works. Rejected because the red test fails if either marker is in the query. Dual-send is the bug.
2. Put the prompt in a custom HTTP header on the websocket upgrade. Rejected because headers are logged as readily as query strings, and the test requires the first websocket message.
3. Add HSTS on every origin, including loopback HTTP. Rejected because the finding says to leave the headers off for the loopback HTTP origin, and HSTS on `http://127.0.0.1` does not stick in browsers anyway. The HTTPS test is the one that must see the header.
4. Import or shell out to `security-headers.js` for the strings. Rejected because the gateway is Python and that file is not this group's to wrap. Three constants, commented with the source path, are the whole coupling.

## Invariants and properties

`tests/test_sweep01_g11_headers.py` and, if the prompt budget needs its own cases, functions in that file. `pytest`. No `skip`, no `xfail`.

- For origins `https://atlas.example`, `https://atlas.example:8443`, the three headers are present and the HSTS value is exactly `max-age=63072000; includeSubDomains`.
- For origins `http://127.0.0.1:9` and `http://localhost:9`, the three names are absent, and the existing four headers are still present.
- Property of the budget: a project whose JSON is under 7400 bytes is returned unchanged. A project whose prior note is longer than the cap comes back at or under 7400 bytes, still starts with the role, and does not contain the uncut note. The shrink never returns an empty string for a project that has a title.
- The B4 markers survive `make_prompt` for the fixture project and the fixture preference.

Boundaries: `voice_prompt` query value is the voice file name only. A prompt that contains `&`, `?`, and a newline is still absent from the query after connect. Percent-encoding the prompt into the query fails the test even if a log would decode it.

## Data migration

None. No stored prompts. Live interviews disconnect on process restart, which is the existing deploy behavior.

## Rollback

Revert the two Python files. The prompt returns to the query string. HTTPS responses lose HSTS, COOP, and CORP again. No schema.

If a stock PersonaPlex rejects a handshake that has no `text_prompt` query, rollback is the immediate recovery. See the open question. Do not ship a config flag that puts the prompt back on the URL: the red test would have to be weakened to allow it, and this plan does not allow that.

## Open PRs #15–#30

No PR in #15–#30 edits `server.py` or `interview.py`. PR #30 changes Worker `verifyAccess` and `deploy.sh`. This path is the Python gateway. Group 16 owns `identity.py` and will change the sign-in cap. Do not edit `identity.py` while adding headers. The middleware reads `config.origin` only.

The selected voice route on 2026-09-26 is Kyutai. This defect is the PersonaPlex alternative, which `Config` still defaults to when the provider is not switched. Fix the path the red test exercises. Do not add a fallback provider.

## Owner lockout

The header change cannot lock the owner out of HTTP loopback. On an HTTPS deployment, HSTS tells the browser to stay on HTTPS for two years, including subdomains. A mistaken `includeSubDomains` on a host that also serves an HTTP-only subdomain will break that subdomain for every browser that has seen this response. The Worker already sends this exact value. Matching it is the finding. If the gateway's public host is not the Worker's host, the owner confirms the host has no HTTP-only sibling before deploy. That is the lockout risk.

The handshake change can lock voice: if the upstream worker never sees a prompt it understands, nobody gets a model-ready byte, and the interview ends at the handshake timeout. The page still loads. Notes are not deleted. Rollback restores the query-string handshake.

## Diff size

About 80 lines in the two Python modules and about 100 lines of tests.

## Open question for the owner

The red test is the contract: the prompt is the first upstream text frame, and it is not on the URL. Stock PersonaPlex, as this repo's comments describe it, reads `text_prompt` from the query. Does the build you would actually run accept the frame instead? Kyutai is the selected route and does not use this handshake. If the answer is no, this plan must not land against a live PersonaPlex, and the test has to change in a later decision. Do not land a dual-send to paper over that.
