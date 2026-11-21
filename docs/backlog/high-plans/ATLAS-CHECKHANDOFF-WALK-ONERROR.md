# ATLAS-CHECKHANDOFF-WALK-ONERROR

Disposition: **ADDENDUM** to `ATLAS-PR10-SENTINEL-LOWS`. Not a parallel plan.

That plan owns `scripts/check_handoff.py` and `tests/test_handoff.py`. The F-2 depth cap in that plan and this `onerror` land in the same three walks. One writer.

Pinned main: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
Triage: `triage.md` sha256 `1901b48b1a44181c59cce7434460e4e1a82057b99c85b53b9f4e049261f1059d`.

## APP-FIT

**FIT** against main `8b0972ec`. Three `os.walk` calls pass `followlinks=False` and no `onerror`:

- `non_ascii_paths` at `check_handoff.py:84`
- `package_files` at `:257`
- `nested_git_metadata_paths` at `:276`

An unreadable directory is skipped. Its children are absent from the unlisted, non-ASCII, and nested-git scans, and the check can still pass.

## Done when

- Each of those three walks passes an `onerror` that records the directory and fails the inspection. A skipped directory is not a pass.
- The failure is any `OSError`, not only `PermissionError`. An unreadable root is a failure. The same test calls `non_ascii_paths`, `package_files`, and `nested_git_metadata_paths`. Sentinel v2, low on review `7343b668` of `2f890c3d` (R12).
- The failure is `manifest-content` (or the same check that directory was being scanned for), with the path in the detail. It is not an uncaught traceback.
- A readable tree is unchanged. The F-2 cap still applies to a walk that can be listed.
- `chmod 000` is not the test. The process that runs pytest may be root, and root ignores that mode. The test monkeypatches `os.scandir` to raise `OSError` for the walk root and for one child directory. That is the portable red case.

## Failing test

Name: `test_walk_onerror_refuses_an_unreadable_directory`

On this main the planted file under the unreadable directory is invisible and `inspect` does not fail for it.

TEST COMMAND:

```sh
python3 -m pytest tests/test_handoff.py::test_walk_onerror_refuses_an_unreadable_directory -q
```

## Files owned

None as a separate writer. The sentinel-lows writer adds the `onerror` callback at the three `os.walk` calls in `scripts/check_handoff.py` and adds the test in `tests/test_handoff.py`.

## Risk

High. An `onerror` that raises out of `os.walk` turns a permission error into a traceback, which is the C-L1 shape this bundle already closed. The callback records the path and lets the walk finish, and the inspection then returns `passed: false`. A directory the operator cannot read fails the gate instead of being certified.

## Rollback

Revert the three callbacks. Unreadable directories are skipped again. No package contents change.

## Dependencies

Same as `ATLAS-PR10-SENTINEL-LOWS`. #25 overlaps the file. #15, #16, #23, #27, #30, #35, #37, and #40 do not. Bring #25 in with an ordinary merge. #25's parent is #21. Do not rebase either pushed branch.

## Branch base

PR #25 head `3d64934ee1eb` (parent PR #21 `bac4bec450ea`), then PR #41 (`097c5c6680d1b8cfd55db23d39cd027ff69c9133`) and PR #42 (`4457d69c713a784aed9dbe997028bdbe37244d51`), each by ordinary merge, before the `MANIFEST.json` hash refresh. Do not rebase those pushed branches. Do not revert their `Makefile` row or their living rows.

## Known limits

- Any `OSError` fails the inspection, including an unreadable root. `PermissionError` is not the only case.
- The same test covers `non_ascii_paths`, `package_files`, and `nested_git_metadata_paths`.
- `chmod 000` is not the test. Root ignores that mode.

## Ask

| Ask | None. This row does not ask Tony. |

## Tony source

The backlog row has no separate tony-verbatim card. The title below is copied verbatim from `rows-full.txt`.

> os.walk in check_handoff has no onerror, so unreadable directories are skipped silently (Sentinel L-2, PR14)
