# Page pin refresh

Low. The built page and the deploy pin disagree, so `deploy.sh` stops at exit 14 before wrangler.

Main checked before this branch: `3d9239c112b5c5853fc49ce15424bbd29d94cfb2`.

## Done when

- `bash scripts/verify_page_build.sh` exits 0 on this head.
- `node --test tests/page-pin.test.js` is red on `3d9239c112b5c5853fc49ce15424bbd29d94cfb2` and green on this head.
- The four HTML aliases and `deploy/cloudflare-edge/src/csp.generated.js` stay the bytes already at that parent. Only the pin line changes among those build outputs.

## Failing test

Name: `tests/page-pin.test.js` — `PAGE_SHA256.txt matches the built ATLAS_Voice.html`

On `3d9239c1` the pin field is `8b3328c681e6a126e2873a3737e2c72addaa1855363e58df65984943f8600921` and the built page is `7a290026b91b2e3f732b31146927a158bb30243ed2bea6fd74f517ae31dd7d4a`. The test exits 1. 1 test, 0 pass, 1 fail.

`scripts/verify_page_build.sh` is the same comparison after two `python3 build.py` runs. On `3d9239c1` both builds print 924015 bytes and the script exits 1 at `test "$actual" = "$expected"`. It prints no mismatch line. `deploy.sh` uses that comparison and exits 14.

That shell script is the step "Build the page twice and check the canonical hash" in `.github/workflows/ci.yml`. It is not a target of `make test` or `make test-ui`. `node --test tests/*.test.js` and pytest do not read `PAGE_SHA256.txt`. `check_handoff.py` checks the pin file against its own manifest row. A stale pin that is listed still passes. The release verify of `3d9239c1` recorded pytest, node, edge, test-ui, and check_handoff at exit 0, and `verify_page_build.sh` at exit 1.

Actions run `44736415395` on push of `3d9239c112b5c5853fc49ce15424bbd29d94cfb2` concluded failure. Job `136288811352` was created `2026-11-20T12:30:56Z` and completed `2026-11-20T12:30:59Z`, with no steps and `runner_id` 0. The log blob returned 404. The hash step did not run.

TEST COMMAND:

```sh
bash scripts/verify_page_build.sh
node --test tests/page-pin.test.js
```

## Risk

low

plan debate skipped: not high-risk (a recorded hash of the page already committed; no auth, session, permission, secret, schema, or deletion change)

State-machine discovery skipped. This does not add or change a status, a phase, or a transition.

## Where it breaks

`deploy/cloudflare-edge/generated/PAGE_SHA256.txt` on `3d9239c1` is the pin written at `ddb9226c242ef86e4800ea3a3a34fb8f173840f8`:

`8b3328c681e6a126e2873a3737e2c72addaa1855363e58df65984943f8600921  923969  ATLAS_HOME=https://atlas.tony-walteur.workers.dev  ATLAS_HOME_URL=unset`

That digest is `ATLAS_Voice.html` at `ddb9226` (923969 bytes).

The commit that should have updated the pin is `f55ff0617aec9f396a13cd3e7fd245ab132de9cc`. It is the merge of `196aee0ba367a4c8538a10a81efa11f925fd3092` and `ab2a6af5ff0c18f272321f9a532aa8ede5b7af93`. It rebuilt `ATLAS_Voice.html` and took main's pin line. No commit after it changes the page or the pin. HEAD `3d9239c1` still has that page blob.

| Commit | Pin | Page sha256 | Bytes |
|---|---|---|---:|
| `196aee0` (PR10 parent) | `dcf373397e1f8fb6063fdfa1f58224028fe0dc6bc9e697ed0ea404cb8e1bb93d` | `f9c2a2018c947b0c0fac7aa90a31206736fefba21529690a31b732530948f76c` | 924012 |
| `ab2a6af5` (main parent) | `8b3328c681e6a126e2873a3737e2c72addaa1855363e58df65984943f8600921` | `8b3328c681e6a126e2873a3737e2c72addaa1855363e58df65984943f8600921` | 923969 |
| `f55ff06` and `3d9239c1` | `8b3328c681e6a126e2873a3737e2c72addaa1855363e58df65984943f8600921` | `7a290026b91b2e3f732b31146927a158bb30243ed2bea6fd74f517ae31dd7d4a` | 924015 |

## What the page change is

`git diff ddb9226 HEAD -- ATLAS_Voice.html` is +46 bytes. Four edits:

- The app script hash `sha256-dqV6bOkbrvUGN7iCxgfJdaXbmx9lWJNMCkcDTN3pV90=` is replaced by `sha256-rsGHEDrOp0hEpUxqKptXCql8LDg7/E58i0uWRMpzQdU=`. The two hashes are the same length. `PAGE_SCRIPT_HASHES` in `deploy/cloudflare-edge/src/csp.generated.js` moves with them.
- The embedded `src/journey.css` loses its trailing newline (−1 byte). The media-query text is the same. The source file is 2302 bytes at `ddb9226` and 2301 bytes at HEAD, equal once the final newline is stripped.
- `openFromHash` gains ` if(h==='#admin'){switchView('admin');return;}`.

That is the PR10 page: the `#admin` deep link from `a9878d6`, and the journey stylesheet newline left when M-2 was dropped (`d545734`), rebuilt together at `f55ff06`. This refresh does not edit those sources.

## Decision

Regenerate the pin from the repo build. `ATLAS_HOME_URL` stays unset. `python3 build.py` prints `ATLAS_HOME: https://atlas.tony-walteur.workers.dev` and 924015 bytes. `sha256sum ATLAS_Voice.html` supplies the digest. The line keeps the existing spacing: digest, two spaces, byte count, two spaces, `ATLAS_HOME=`, two spaces, `ATLAS_HOME_URL=unset`.

The rebuild left the four aliases and `csp.generated.js` byte-identical to the parent. Each alias is `7a290026b91b2e3f732b31146927a158bb30243ed2bea6fd74f517ae31dd7d4a`, 924015 bytes. `csp.generated.js` is `7d54de0b2fed28db9dd1f20106b9cf4526cadd3a9641495c3e68762620bd6dbf`, 1675 bytes. Logo SHA-256 stays `92c5ff21779f09199097a2971c172453017f0d2581a0ced6f54fe486ba9b6c2b`.

`tests/page-pin.test.js` compares the pin's digest and byte count to `ATLAS_Voice.html`. The shell script still rebuilds twice.

## Rollback

Revert this branch to main `3d9239c112b5c5853fc49ce15424bbd29d94cfb2`. No migration and no stored rewrite.

## Loops

Verify and QA loops are capped at 3. A failed gate is fixed only for the failure that was shown.
