# ATLAS-HANDOFF-DENYLIST-DEVVARS

Disposition: **ADDENDUM** to `ATLAS-PR10-SENTINEL-LOWS`. Not a parallel plan.

That plan owns `scripts/check_handoff.py` and `tests/test_handoff.py`.

Pinned main: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
Triage: `triage.md` sha256 `1901b48b1a44181c59cce7434460e4e1a82057b99c85b53b9f4e049261f1059d`.

## APP-FIT

**FIT** against main `8b0972ec`. The release-hygiene loop (`scripts/check_handoff.py:464-471`) refuses font and key suffixes, a name of `.env`, and a name that starts with `.env.` except `.env.example`. It does not name `.dev.vars` or `.npmrc`. Neither file is in `MANIFEST.json` on this main. A manifest that listed one would still pass hygiene.

## Done when

- A manifest row whose final path component is `.dev.vars` or `.npmrc` fails `release-hygiene`. The detail names that path.
- `.env.example` still passes. `.env` and `.env.production` still fail, as they do today.
- The check stays a name check on listed manifest paths. It is not a content scan for secrets inside other files. The existing hygiene detail already says it is not a full content secret scan. That sentence stays.

## Failing test

Name: `test_release_hygiene_rejects_dev_vars_and_npmrc`

On this main a synthetic package that lists both names passes `release-hygiene`.

TEST COMMAND:

```sh
python3 -m pytest tests/test_handoff.py::test_release_hygiene_rejects_dev_vars_and_npmrc -q
```

## Files owned

None as a separate writer. The sentinel-lows writer adds the two names in the hygiene loop in `scripts/check_handoff.py` and adds the test in `tests/test_handoff.py`.

## Risk

High because the gate certifies a package. Refusing those two names does not delete a local `.dev.vars`. It stops a release manifest from listing them. A package that intentionally shipped a file with one of those names would fail the gate. This repository does not list either name.

## Rollback

Revert the two names. A manifest that lists them passes hygiene again. No file in the tree is removed.

## Dependencies

Same as `ATLAS-PR10-SENTINEL-LOWS`. #25 overlaps the file. #15, #16, #23, #27, #30, #35, #37, and #40 do not. Rebase onto #25 (parent #21).
