# Group 17 — Entra bootstrap

Plan only. Debate this before anyone edits product code. Revision v2 (Sentinel PLAN-CHANGES on PR #38). L1 through L4 below are agreed. The v2 section wins where an earlier sentence relies on `umask` alone, prints curl's body, or sets the trap before `mktemp`.

Pinned inputs: confirmer report sha256 `57c92dcb651ddef4b7abe9c23424065a2a59fa139d2cdfc6315ce227596eac1c`, main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`, red tests `96712474b59d6b058ef00479f2bb2d4eb065801e` (PR #31).

Finding: HAM-05.

## Done when

1. `node --test --test-name-pattern 'HAM-05' tests/sweep01-ham.test.js` passes.
2. The script source, with comments stripped the way the test strips them, has no line that both names `CLOUDFLARE_API_TOKEN` and contains `curl` or `-H`, no `echo` or `printf` of `CLOUDFLARE_API_TOKEN` or `ENTRA_CLIENT_SECRET`, and no `--data "$idp"` / `--data "${idp}"` while the secret is still in the file.
3. `curl` is invoked with `--config` or with `--data-binary @-` (the test requires at least one; this plan uses both).
4. The script is not executed. Cloudflare and Entra are not called. No token is printed by a test.

## Files this group may edit

`deploy/cloudflare-edge/entra/enable_entra.sh` only.

Do not edit `requirements-integrations.txt` (group 15, HAM-01), `entra/README.md` unless a command in it tells the operator to put the secret on the shell command line. If the README shows a sample `curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"`, that sample is group 15's docs only if the file is not this group's. This group does not own the README. Change the script. If the README contradicts the script, name that in the PR text and leave the README to group 15.

## Failing test from PR #31

| Test | File | Finding |
|---|---|---|
| `HAM-05 the Entra bootstrap script does not put the client secret or API token on curl argv` | `tests/sweep01-ham.test.js` | HAM-05 |

The test reads the script, strips comments, and fails on:

- a line matching `CLOUDFLARE_API_TOKEN` and `curl` or `-H`
- a line matching `echo` or `printf` and `$CLOUDFLARE_API_TOKEN` or `$ENTRA_CLIENT_SECRET` (with or without braces)
- `--data "$idp"` or `--data "${idp}"` anywhere in the file while `ENTRA_CLIENT_SECRET` appears
- the absence of both `--config` and `--data @-` / `--data-binary @-`

TEST COMMAND:

```sh
node --test --test-name-pattern 'HAM-05' tests/sweep01-ham.test.js
```

Do not run `bash deploy/cloudflare-edge/entra/enable_entra.sh`. The existing header comment says BUILT, NOT RUN. Keep that.

## Threat model

Before: the script puts `$CLOUDFLARE_API_TOKEN` in a `curl` `-H` argument and expands the JSON, including `ENTRA_CLIENT_SECRET`, into `--data "$idp"`. Both values are on the process argv. They are visible to `ps`, to shell history if the operator traced the script, and to any crash reporter that captures argv. The script also builds the JSON with `python3 -c` reading the environment, which is fine, and then hands that JSON to `curl` as an argument, which is not. `set -x` is not on; do not turn it on. The missing-variable check prints the variable *name*, via `${!v:-}`, not the value. Keep it that way.

After: the token reaches `curl` only inside a mode-600 config file passed with `--config`, or the JSON body reaches `curl` on stdin with `--data-binary @-`. Neither value is an argument. Neither value is written to stdout. The config file is removed on exit, including on failure. The IdP id and a fixed success sentence are the only new output.

What remains: the values still exist in the operator's environment and in Cloudflare after a real run. This script does not change that. A core dump of the Python process can still contain them. The argv leak is the finding.

## Chosen design

Keep `set -euo pipefail` and the `--i-have-it-approval` gate.

Replace the `auth=(-H ...)` array and the `--data "$idp"` expansions.

The shell creates the directory with `mktemp -d`, and the next line sets `trap 'rm -rf "$dir"' EXIT`. Do not set the trap before `mktemp` succeeds. `umask 077` stays, and it is not the mode check.

One Python process, started as `python3 -` with a quoted heredoc so the shell does not expand the body, reads `CLOUDFLARE_API_TOKEN`, `ENTRA_CLIENT_SECRET`, and the other variables from `os.environ`. Before it writes the curl config, it refuses a token or client secret that is empty or contains a character outside visible ASCII without space, quote, backslash, backtick, or newline. On that refusal it exits non-zero and writes no file. It then opens the secret files with `os.open(..., os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o600)`:

- a curl config whose `header` line is `Authorization: Bearer <token>` and whose `header` line is `Content-Type: application/json`
- the identity-provider JSON, same object as today (`name`, `type` `azureAD`, `client_id`, `client_secret`, `directory_id`, `support_groups` false, the same claim order)

The shell then:

```text
curl --silent --show-error --config "$dir/curl.cfg" --output "$dir/body" --stderr "$dir/err" --url "$API/identity_providers" --request POST --data-binary @"$dir/idp.json"
```

and the same `--config`, `--output`, and `--stderr` for the PATCH, with the PATCH body also a file the Python wrote (`allowed_idps`, `auto_redirect_to_identity`). The PATCH body does not contain the client secret. Curl's response does not go to the terminal. Python reads the output file, prints the created IdP id, and on failure exits non-zero with the fixed sentence `Cloudflare refused the identity provider request.` It does not print the error file. The shell may `echo` the id. It must not `echo` or `printf` either secret.

Do not pass the secret as a Python `sys.argv` element. Do not use `curl -H @file` on a line that also expands the token. The `--config` line in the shell contains the directory variable, not the token.

Claim order stays: `tid`, `oid`, `roles`, `preferred_username`, then the name claims. Do not add `groups`. `support_groups` stays false.

## Alternatives rejected

1. `curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"` with the variable quoted. Rejected because it is still argv, and it is the line the test rejects.
2. `printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN"`. Rejected because the test treats `printf` of that variable as an echo of the secret, even when the destination is a file.
3. Rely on curl's own environment to pick up `CLOUDFLARE_API_TOKEN`. Rejected because curl does not read that name. Inventing a wrapper that exports it into `http_proxy` style variables would put the secret in the environment of every child, which is a wider leak, and would not move the JSON body off argv.
4. Fetch the token from a URL inside the script. Rejected because that is a new network hop and a new place to log the token. The operator's environment remains the source.

## Invariants and properties

The PR #31 test is a static property of the source. Extend it only in a new file if more cases are needed: `tests/sweep01-g17-entra-argv.test.js`. Do not weaken the existing test. No skip, no expected failure.

Properties of the script text, comments stripped:

- No line contains both `CLOUDFLARE_API_TOKEN` and (`curl` or `-H` or `--header`).
- No line contains `echo` or `printf` together with either secret name.
- No `--data`, `--data-binary`, or `--data-raw` is followed by an unquoted or quoted `$` expansion. `@-` and `@"$dir/..."` are the allowed forms. A quoted heredoc passed to Python is not a curl data argument.
- `--config` appears, and `--data-binary` appears with `@`.
- `set -x` and `curl -v` / `--trace` do not appear.
- The approval gate and the required-variable names stay.

Do not execute the script to prove this. A test that runs it would need a token.

Boundaries: a comment line that mentions `curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"` is stripped before the assertion, so a comment does not satisfy the test and also does not fail it. Do not hide the old invocation in a comment. Delete it.

## Data migration

None. The script has not been run by this work. Cloudflare state is untouched.

## Rollback

Revert the shell file. The next operator run goes back to argv. There is no half-migrated Access application from this change, because the script is not run here.

If a later real run writes the IdP and fails before the PATCH, that is the existing two-step behavior. The trap removes the local files either way. It does not delete the remote IdP. Say that in the script's header comment in one sentence, without echoing secrets.

## Open PRs #15–#30

No PR in #15–#30 edits `enable_entra.sh`. Group 15 owns `requirements-integrations.txt` and was told not to edit this script. PR #29 and PR #30 touch `.gitleaks.toml` and README. A secret that appears only as the variable name `ENTRA_CLIENT_SECRET` is not a secret value. Do not put an example token in the script to "show the shape".

## Owner lockout

This script switches the Access application to the Entra identity provider. A bad run can lock everyone out of Access, including the owner, until IT puts the previous IdP back. This plan does not run the script, so it cannot cause that lockout by itself.

The code change can still cause it the next time someone passes `--i-have-it-approval`. Mitigations that stay inside the file: keep the approval flag, keep `set -euo pipefail` so a failed POST does not continue into a PATCH with an empty id, and print a fixed error so a failure is visible without printing the secret. Do not add `--fail-early` behavior that deletes the existing IdP. The script creates a connector and points the app at it. Rollback of a *real* run is an IT action in the Cloudflare dashboard, not a git revert. The header comment should keep saying that.

A `trap` that removes the config directory on EXIT must not remove the operator's home directory. Use the `mktemp -d` path only.

## Diff size

About 60 lines in the shell script. About 40 more if the extra static test file is added. The existing HAM-05 test is enough for the finding; the extra file is the property list above, still static.

## v2 — Sentinel

Agreed. Devin's plan debate (`6c17bee6`) is PASS for this group. No design change from that pass. File: `tests/sweep01-g17-entra-argv.test.js`. Static read of the script after comments are stripped. Do not run the script. No skip, no expected failure. The HAM-05 test stays as it is.

| Sentinel | Change | Red test |
|---|---|---|
| L1 | The Python that writes the config and the JSON opens those files with mode `0o600`. `umask` alone does not satisfy the test. | `L1 secret files are opened with mode 0o600` |
| L2 | The character check on `CLOUDFLARE_API_TOKEN` and `ENTRA_CLIENT_SECRET` appears before any write of the curl config. A newline or a quote is in the refused set. | `L2 a token with a newline or a quote is refused before the curl config is written` |
| L3 | Every `curl` invocation includes `--output` and `--stderr` pointed at files under the temp directory, and the script does not print those files. | `L3 curl writes stdout and stderr to temp files` |
| L4 | The `trap` line comes after the `mktemp` line and before `curl`. | `L4 the EXIT trap is installed after mktemp` |

## Known limits

The script is not executed by this group. A token character outside the allowed set is refused before the curl config is written. The owner decides whether IT runs the script after the argv change.

## Open question for the owner

None that blocks the debate. The script stays unrun. The owner decides when, and whether, IT executes it after the argv change. That execution is not part of this group.
