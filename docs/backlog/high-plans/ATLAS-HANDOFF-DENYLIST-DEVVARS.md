# ATLAS-HANDOFF-DENYLIST-DEVVARS

Disposition: **ADDENDUM** to `ATLAS-PR10-SENTINEL-LOWS`. Not a parallel plan.

That plan owns `scripts/check_handoff.py` and `tests/test_handoff.py`.

Pinned main: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
Triage: `triage.md` sha256 `1901b48b1a44181c59cce7434460e4e1a82057b99c85b53b9f4e049261f1059d`.

## APP-FIT

**FIT** against main `8b0972ec`. The release-hygiene loop (`scripts/check_handoff.py:464-471`) refuses font and key suffixes, a name of `.env`, and a name that starts with `.env.` except `.env.example`. It does not name `.dev.vars` or `.npmrc`. Neither file is in `MANIFEST.json` on this main. A manifest that listed one would still pass hygiene.

## Done when

- The final path component is compared case-insensitively. The existing `.env` rule is included. `.Env` and `.ENV.production` fail. `.Env.example` still passes. `.Dev.Vars` fails, because a case-insensitive volume ships that name as the secrets file `.dev.vars`. `.Npmrc` fails with `.npmrc`. Sentinel v2 of review `7343b668` on `2f890c3d` (R13, medium). This is the change that review asked for. The other rows in this batch were agreed.
- A manifest row whose final path component is `.dev.vars` or `.npmrc` fails `release-hygiene`. The detail names that path.
- `.dev.vars.<env>` fails. `.dev.vars.production` and `.DEV.VARS.staging` fail. There is no `.dev.vars.example` exception.
- `.env.example` still passes. `.env` and `.env.production` still fail, as they do today, and the case-folded spellings fail with them.
- The check stays a name check on listed manifest paths. It is not a content scan for secrets inside other files. The existing hygiene detail already says it is not a full content secret scan. That sentence stays.

## Failing test

Name: `test_release_hygiene_rejects_dev_vars_and_npmrc`

On this main a synthetic package that lists both names passes `release-hygiene`.

The two red tests R13 adds:

Name: `test_release_hygiene_rejects_dev_vars_regardless_of_case`

A manifest that lists `.Dev.Vars`, `.Npmrc`, `.Env`, and `.ENV.production` fails hygiene, and the detail names those paths. A manifest that lists only `.Env.example` still passes.

Name: `test_release_hygiene_rejects_dev_vars_env_suffix`

A manifest that lists `.dev.vars.production` fails hygiene. `.env.example` still passes.

TEST COMMAND:

```sh
python3 -m pytest tests/test_handoff.py::test_release_hygiene_rejects_dev_vars_and_npmrc tests/test_handoff.py::test_release_hygiene_rejects_dev_vars_regardless_of_case tests/test_handoff.py::test_release_hygiene_rejects_dev_vars_env_suffix -q
```

## Files owned

None as a separate writer. The sentinel-lows writer changes the hygiene name compare in `scripts/check_handoff.py` to be case-insensitive, adds `.dev.vars` and a `.dev.vars.` prefix next to the existing `.env` rule, and adds the three tests in `tests/test_handoff.py`.

## Risk

High because the gate certifies a package. Refusing those names does not delete a local `.dev.vars`. It stops a release manifest from listing them, in any case, including `.dev.vars.<env>`. A package that intentionally shipped a file with one of those names would fail the gate. This repository does not list them. `.Env.example` stays allowed, which is the existing example exception, compared without case.

## Rollback

Revert the name compare. A manifest that lists `.Dev.Vars` or `.dev.vars.production` passes hygiene again. No file in the tree is removed.

## Dependencies

Same as `ATLAS-PR10-SENTINEL-LOWS`. #25 overlaps the file. #15, #16, #23, #27, #30, #35, #37, and #40 do not. Bring #25 in with an ordinary merge. #25's parent is #21. Do not rebase either pushed branch.

## Branch base

PR #25 head `3d64934ee1eb` (parent PR #21 `bac4bec450ea`), then PR #41 (`097c5c6680d1b8cfd55db23d39cd027ff69c9133`) and PR #42 (`4457d69c713a784aed9dbe997028bdbe37244d51`), each by ordinary merge, before the `MANIFEST.json` hash refresh. Do not rebase those pushed branches. Do not revert their `Makefile` row or their living rows.

## Known limits

- Names are compared without case, including the existing `.env` rule. `.Env.example` still passes. `.Dev.Vars` fails.
- `.dev.vars.<env>` fails. There is no `.dev.vars.example` exception.
- The check is a path-name check. It is not a scan of file contents.

## Ask

| Ask | None. This row does not ask Tony. |

## Tony source

The backlog row has no separate tony-verbatim card. The title below is copied verbatim from `rows-full.txt`.

> PR11 F-2 (Info): the check_handoff release-hygiene denylist lacks .dev.vars and .npmrc (pre-existing)
