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
Sweep plans read at PR #38 head `a5a24e1b4d2fd9d8683f4f08841dba27497fd74a`. v2 of those plans is in progress. This plan does not edit them.

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
- A package whose file count is greater than 20000 is refused the same way. The synthetic package the existing tests build, and this main's manifest (697 release files, shallow tree), stay under both caps.
- The caps are constants next to `package_files`. 32 and 20000 are this plan's recommendation. They sit above this repository and below an unbounded walk. A reviewer can change the numbers. The test names stay.
- F-1, the nested-git refusal, and the C-L1 checkout message are not rewritten.
- The four addenda are in the same change. This plan is not done while those tests are still red.

## Failing test

Name: `test_package_walk_stops_past_the_cap`

On this main a chain of 33 nested directories is walked and is not refused for depth.

TEST COMMAND:

```sh
python3 -m pytest tests/test_handoff.py::test_package_walk_stops_past_the_cap -q
```

The addenda name their own tests. One pytest command for the whole change, after all five tests exist:

```sh
python3 -m pytest tests/test_handoff.py::test_package_walk_stops_past_the_cap tests/test_handoff.py::test_dev_exclude_trailing_slash_is_not_a_substring tests/test_handoff.py::test_walk_onerror_refuses_an_unreadable_directory tests/test_handoff.py::test_release_hygiene_rejects_dev_vars_and_npmrc tests/test_handoff.py::test_is_dev_tree_rejects_symlinked_git_directory -q
```

## Files owned

- `scripts/check_handoff.py`
- `tests/test_handoff.py`

This writer also applies the four addenda in those two files. No other writer in this batch edits them. Do not edit `scripts/git_home.py` (PR #25 owns that). Do not edit `MANIFEST.json` except as the last regenerated pin if a listed path changes. This change does not add a release file, so the manifest should not need a new row.

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
| #25 | Overlaps `scripts/check_handoff.py`. #25 head `3d64934ee1eb` on `cursor/s3-checkhandoff-githome-lifecycle`. Rebase onto it. Do not edit `scripts/git_home.py`. |
| #27 | No. |
| #30 | No. |
| #35 | No. |
| #37 | No. `ci.yml` runs pytest. This plan does not edit the workflow. |
| #40 | No. |

Also open, and the parent of #25: PR #21 (`cursor/atlas-checkhandoff-residuals`, `bac4bec450ea`) edits `scripts/check_handoff.py` and `tests/test_handoff.py`. Rebase onto #25, which is stacked on #21, rather than onto main alone. Do not start this change in parallel with those two diffs.
