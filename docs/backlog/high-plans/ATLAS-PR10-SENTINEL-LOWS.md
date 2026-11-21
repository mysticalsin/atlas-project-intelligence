# ATLAS-PR10-SENTINEL-LOWS

Disposition: **PLAN**. This writer owns `scripts/check_handoff.py` and `tests/test_handoff.py` for the release-gate rows in this batch.

The four sibling rows are addenda, applied in this same change, not parallel branches:

- `ATLAS-CHECKHANDOFF-DEV-EXCLUDES` (Sentinel F-4 and Cursor C-L4)
- `ATLAS-CHECKHANDOFF-WALK-ONERROR`
- `ATLAS-HANDOFF-DENYLIST-DEVVARS`
- `ATLAS-ISDEVTREE-GIT-SYMLINK`

No Sweep 01 high-risk group owns this file. Groups 10, 13, and 16 were checked. Their files are `subject-rights.js` / `outreach.js`, Worker `app.js`, and `atlas_voice/identity.py`.

Pinned main: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
Triage: `triage.md` sha256 `1901b48b1a44181c59cce7434460e4e1a82057b99c85b53b9f4e049261f1059d`.
Sweep plans are cited at PR #38 head `4d15c83c7485c6e73cd50d1f2eded3824a636526`. head `4d15c83c7485c6e73cd50d1f2eded3824a636526`. Devin r8a2f8337 pins PR #38 there, not `a5a24e1`. The branch tip at this freeze is `73dd4df385ee0dbf5f29d00afdf465ea95ea125b` (v4). These addenda cite `4d15c83c`. They do not edit `docs/sweeps/s01/plans/`.

## APP-FIT

**ADAPT** against main `8b0972ec`. The bundle is not one open fix. Each id is dispositioned below. Only F-2 is a new behavior in this file. F-4 is the excludes addendum. The other open siblings have their own addenda. Closed items are not rebuilt.

## Disposition

The pinned `rows-full.txt` detail is cut after "the package_files walk (:37-53) has no d". The plan debate in `/cursor/stores/bot/atlas-pr13/pr10-plan-debate.md` (sha256 `e31bc807668cf25e828e57cda1c71c7f62c6b5afdb404ffb554c932d06eea174`) says the walk has no depth or count bound and that F-2 already records it. Sentences that are not in those inputs are not invented.

| Id | On this main | This plan |
|---|---|---|
| F-1 | Per-component symlink check is `symlink_in_package_path` (`check_handoff.py:229-241`), used by `read_package_bytes` and by the alias/logo reads. Tests: `test_listed_file_under_symlinked_parent_outside_root_fails`, `test_html_alias_read_through_symlinked_parent_outside_root_fails`. | Already on main. No edit. |
| F-2 | `package_files` (`:254-270`) and the other walks have no depth cap and no entry cap. | This plan. |
| F-3 | The F-3 sentence is not in the truncated detail. Nested `.git` is already refused before the exclude allow (`:444-446`). That follow-up landed as PR #14, which is this main (`8b0972e`). | No new behavior. If the sentinel file's F-3 sentence is something else, it stays unnamed until that file is read. The sentinel sha is `b39450c9d13f825af420bb4a932722ec892bb76a178dbaebde5031060f6780ca`. It is not in this checkout. |
| F-4 | Trailing-slash excludes still match as a substring (`:307-312`). | `ATLAS-CHECKHANDOFF-DEV-EXCLUDES`. Not restated here. |
| F-5 | The sentence is not in the pinned inputs. | No code. Unstated. |
| C-L1 | `inspect` assigns `present = []` when the tree is not a checkout (`:414-417`) and does not raise `UnboundLocalError`. Alias `ATLAS-CHECKHANDOFF-DEVFLAG-CRASH`. That row is not one of these 15. | Already on main. No edit. |
| C-L2, C-L3, C-L5, C-L6 | Sentences are not in the pinned inputs. | No code. Unstated. |
| C-L4 | Same defect as F-4. | The excludes addendum. |

## Done when

- A package whose directory depth is greater than 32 is refused. `manifest-content` does not pass. The refusal names the cap.
- A package whose file count is greater than 20000 is refused the same way. The count is enforced inside all three walks: `non_ascii_paths`, `package_files`, and `nested_git_metadata_paths`. Counting only `package_files` is not done. Sentinel v2, low on review `7343b668` of `2f890c3d` (R10). The synthetic package the existing tests build, and this main's manifest (697 release files, shallow tree), stay under both caps.
- C-1, the size cap and the extraction cap, stays open. This plan does not add either one.
- The caps are constants next to `package_files`. 32 and 20000 are this plan's recommendation. They sit above this repository and below an unbounded walk. A reviewer can change the numbers. The test names stay.
- F-1, the nested-git refusal, and the C-L1 checkout message are not rewritten.
- The four addenda are in the same change. This plan is not done while those tests are still red.
- `scripts/check_handoff.py` and `tests/test_handoff.py` are already rows in `MANIFEST.json` (on this main, 25828 bytes `13c2d7ee1e44db14291abfef2f3d30696dbbd2d3e3ca6a9e588e59d183fc3f2a`, and 53489 bytes `c2f0a00daea024cde0a7a83562820a9bc66ff424141c8ce5e4fd188b9e70bae4`). Editing either file changes its sha256. The last step refreshes both rows, bytes and sha256, from the merged tree. Leaving the old hashes fails `manifest-content`. Devin r8a2f8337 (HIGH). Do not add a new row for either path.
- PR #41 (`097c5c6680d1b8cfd55db23d39cd027ff69c9133`) and PR #42 (`4457d69c713a784aed9dbe997028bdbe37244d51`) both edit `MANIFEST.json`. Bring each in with an ordinary merge before that hash refresh. Do not rebase those pushed branches. Do not revert their `Makefile` row or their living rows. The refresh writes the two handoff rows. It does not restore an older `Makefile` or an older living row.

## Failing test

Name: `test_package_walk_stops_past_the_cap`

On this main a chain of 33 nested directories is walked and is not refused for depth.

TEST COMMAND:

```sh
python3 -m pytest tests/test_handoff.py::test_package_walk_stops_past_the_cap -q
```

The addenda name their own tests. One pytest command for the whole change, after all five tests exist:

```sh
python3 -m pytest tests/test_handoff.py::test_package_walk_stops_past_the_cap tests/test_handoff.py::test_dev_exclude_trailing_slash_is_not_a_substring tests/test_handoff.py::test_dev_exclude_refuses_empty_root_dot_absolute_and_parent tests/test_handoff.py::test_exclude_does_not_exempt_hygiene_or_nested_git tests/test_handoff.py::test_walk_onerror_refuses_an_unreadable_directory tests/test_handoff.py::test_release_hygiene_rejects_dev_vars_and_npmrc tests/test_handoff.py::test_release_hygiene_rejects_dev_vars_regardless_of_case tests/test_handoff.py::test_release_hygiene_rejects_dev_vars_env_suffix tests/test_handoff.py::test_is_dev_tree_rejects_symlinked_git_directory tests/test_handoff.py::test_is_dev_tree_rejects_git_file_pointer tests/test_handoff.py::test_is_dev_tree_rejects_symlinked_git_head tests/test_handoff.py::test_git_environ_drops_caller_git_dir_and_config -q
```

## Files owned

- `scripts/check_handoff.py`
- `tests/test_handoff.py`

This writer also applies the four addenda in those two files. No other writer in this batch edits them. Do not edit `scripts/git_home.py` (PR #25 owns that). `MANIFEST.json` is edited last, and only to refresh the two existing rows for `scripts/check_handoff.py` and `tests/test_handoff.py` after the ordinary merge of #41 and #42. Do not revert their `Makefile` or living rows.

## Risk

High because this is the release gate. A cap under the real tree makes `check_handoff` fail on main. 697 files and a shallow tree are the measured size on this main. A hostile package deeper than 32 or wider than 20000 is refused instead of hashed. That is the point of F-2. The debate said the missing cap does not by itself turn a finite extra file into a pass. The refusal is fail-closed.

## Rollback

Revert the cap. Deep packages are walked again. The four addenda roll back with the same commit. F-1 and the nested-git check stay, because this plan does not own their current code.

## Dependencies

| PR | On this row |
|---|---|
| #15 | No. |
| #16 | No. |
| #23 | No. |
| #25 | Overlaps `scripts/check_handoff.py`. #25 head `3d64934ee1eb` on `cursor/s3-checkhandoff-githome-lifecycle`. Bring it in with an ordinary merge. Do not rebase that pushed branch. Do not edit `scripts/git_home.py`. |
| #27 | No. |
| #30 | No. |
| #35 | No. |
| #37 | No. `ci.yml` runs pytest. This plan does not edit the workflow. |
| #40 | No. |
| #41 | Edits `MANIFEST.json` and `Makefile`. Ordinary merge before the hash refresh. Do not revert the `Makefile` row. Do not rebase. |
| #42 | Edits `MANIFEST.json`. Stacked on #41. Ordinary merge before the hash refresh. Do not revert the living rows. Do not rebase. |

Also open, and the parent of #25: PR #21 (`cursor/atlas-checkhandoff-residuals`, `bac4bec450ea`) edits `scripts/check_handoff.py` and `tests/test_handoff.py`. Bring #25 in with an ordinary merge. #25 is stacked on #21. Do not rebase those pushed branches, and do not start from main alone. Do not start this change in parallel with those two diffs.

## Branch base

PR #25 head `3d64934ee1eb` (parent PR #21 `bac4bec450ea`), then PR #41 (`097c5c6680d1b8cfd55db23d39cd027ff69c9133`) and PR #42 (`4457d69c713a784aed9dbe997028bdbe37244d51`), each by ordinary merge, before the `MANIFEST.json` hash refresh. Do not rebase those pushed branches. Do not revert their `Makefile` row or their living rows.

## Known limits

- The 20000 file count is enforced in all three walks. C-1, the size cap and the extraction cap, stays open.
- `scripts/check_handoff.py` and `tests/test_handoff.py` are already in `MANIFEST.json`. Their rows are refreshed or `manifest-content` fails.
- PR #41 and PR #42 are brought in by ordinary merge before that refresh. Their `Makefile` and living rows are not reverted.
- F-1, the nested-git refusal, and C-L1 are already on this main and are not rewritten.

## Ask

| Ask | None. This row does not ask Tony. The loop-4 option named on the backlog row is not taken here. |

## Tony source

The backlog row has no separate tony-verbatim card. The title below is copied verbatim from `rows-full.txt`.

> Atlas PR10 loop-3 Lows on head 70de4261: Sentinel F-1..F-5 plus Cursor review C-L1..C-L6 (next Atlas PR after PR10 merges)
