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

## Failing test

Name: `test_dev_exclude_trailing_slash_is_not_a_substring`

On this main `manifest_allows_path('data/a/secret.txt', ['a/'], package_mode=False)` is true.

TEST COMMAND:

```sh
python3 -m pytest tests/test_handoff.py::test_dev_exclude_trailing_slash_is_not_a_substring -q
```

## Files owned

None as a separate writer. The sentinel-lows writer edits `manifest_allows_path` in `scripts/check_handoff.py` and adds the test in `tests/test_handoff.py`.

## Risk

High. A prefix that is only a string prefix would let `a/` hide `ab/secret.txt`. Component boundaries are the requirement. Dev mode is how a checkout is verified. Hiding an untracked file is the release-gate hole.

## Rollback

Revert the predicate. Substring excludes return. No package contents change.

## Dependencies

Same as `ATLAS-PR10-SENTINEL-LOWS`. #25 overlaps the file. #15, #16, #23, #27, #30, #35, #37, and #40 do not. PR #21 is the parent of #25 and also edits this file. Rebase onto #25.
