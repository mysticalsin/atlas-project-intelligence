# ATLAS-CHECKHANDOFF-DEV-EXCLUDES

Disposition: **ADDENDUM** to `ATLAS-PR10-SENTINEL-LOWS`. Not a parallel plan.

That plan owns `scripts/check_handoff.py` and `tests/test_handoff.py`. This row is Sentinel F-4 and Cursor C-L4 of the same bundle. The sentinel plan does not restate the fix. This file is the fix.

Pinned main: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
Triage: `triage.md` sha256 `1901b48b1a44181c59cce7434460e4e1a82057b99c85b53b9f4e049261f1059d`.

No Sweep 01 group owns this file.

## APP-FIT

**FIT** against main `8b0972ec`. `manifest_allows_path` (`scripts/check_handoff.py:301-315`) still has the third clause `('/' + bare + '/') in ('/' + rel)` when the exclude ends in `/` and `package_mode` is false. Exclude `a/` matches `data/a/secret.txt`. Package mode ignores trailing-slash excludes (`:308-309`). The hole is dev mode only.

## Done when

- A trailing-slash exclude matches that directory and its children as a path prefix. `a/` matches `a` and `a/secret.txt`. It does not match `data/a/secret.txt` or `ab/secret.txt`.
- An exclude without a trailing slash stays an exact path match.
- Package mode still ignores trailing-slash excludes.
- The match is on path components. It is not a substring of the whole path.
- Sentinel v2, low on review `7343b668` of `2f890c3d` (R11): an exclude that is empty, `/`, `./`, absolute, or contains `..` fails the inspection. `safe_relative` already skips some of these (`check_handoff.py:52-54`). Skipping is not a refusal. The detail names the exclude.
- An exclude never exempts release-hygiene and never exempts the nested-git check. A listed `.env` still fails hygiene when an exclude would hide it. A nested `.git` under an excluded directory still fails the nested-git check.

## Failing test

Name: `test_dev_exclude_trailing_slash_is_not_a_substring`

On this main `manifest_allows_path('data/a/secret.txt', ['a/'], package_mode=False)` is true.

TEST COMMAND:

```sh
python3 -m pytest tests/test_handoff.py::test_dev_exclude_trailing_slash_is_not_a_substring -q
```

Name: `test_dev_exclude_refuses_empty_root_dot_absolute_and_parent`

An exclude list of `''`, `/`, `./`, `/tmp/x`, or `a/../b` is a failed inspection on this main only if the writer adds the refusal. Today those entries are skipped or matched as text.

Name: `test_exclude_does_not_exempt_hygiene_or_nested_git`

A manifest row `.env` still fails `release-hygiene` when an exclude names it. A nested `.git` under an excluded directory still fails the nested-git check.

TEST COMMAND:

```sh
python3 -m pytest tests/test_handoff.py::test_dev_exclude_refuses_empty_root_dot_absolute_and_parent tests/test_handoff.py::test_exclude_does_not_exempt_hygiene_or_nested_git -q
```

## Files owned

None as a separate writer. The sentinel-lows writer edits `manifest_allows_path` in `scripts/check_handoff.py` and adds the test in `tests/test_handoff.py`.

## Risk

High. A prefix that is only a string prefix would let `a/` hide `ab/secret.txt`. Component boundaries are the requirement. Dev mode is how a checkout is verified. Hiding an untracked file is the release-gate hole.

## Rollback

Revert the predicate. Substring excludes return. No package contents change.

## Dependencies

Same as `ATLAS-PR10-SENTINEL-LOWS`. #25 overlaps the file. #15, #16, #23, #27, #30, #35, #37, and #40 do not. PR #21 is the parent of #25 and also edits this file. Bring #25 in with an ordinary merge. Do not rebase that pushed branch.

## Branch base

PR #25 head `3d64934ee1eb` (parent PR #21 `bac4bec450ea`), then PR #41 (`097c5c6680d1b8cfd55db23d39cd027ff69c9133`) and PR #42 (`4457d69c713a784aed9dbe997028bdbe37244d51`), each by ordinary merge, before the `MANIFEST.json` hash refresh. Do not rebase those pushed branches. Do not revert their `Makefile` row or their living rows.

## Known limits

- An exclude that is empty, `/`, `./`, absolute, or contains `..` fails the inspection. Skipping it is not enough.
- An exclude does not exempt release-hygiene or the nested-git check.
- Package mode still ignores a trailing-slash exclude.

## Ask

| Ask | None. This row does not ask Tony. |

## Tony source

The backlog row has no separate tony-verbatim card. The title below is copied verbatim from `rows-full.txt`.

> Plan debate: dev-mode trailing-slash excludes match as a substring; make them exact or prefix
