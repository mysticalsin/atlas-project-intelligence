# ATLAS-ISDEVTREE-GIT-SYMLINK

Disposition: **ADDENDUM** to `ATLAS-PR10-SENTINEL-LOWS`. Not a parallel plan.

That plan owns `scripts/check_handoff.py` and `tests/test_handoff.py`.

Pinned main: `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
Triage: `triage.md` sha256 `1901b48b1a44181c59cce7434460e4e1a82057b99c85b53b9f4e049261f1059d`.

## APP-FIT

**FIT** against main `8b0972ec`. `is_dev_tree` (`scripts/check_handoff.py:155-161`) requires `.git/HEAD` to be a regular file and not itself a symlink. `Path.is_file` follows a symlink on `.git`. Measured on this main: a directory `.git` that is a symlink to a real git directory returns true. A `.git` that is a symlink to a regular `HEAD` file returns false, because the joined `HEAD` path is not a regular file. The hole is the directory symlink.

Dev mode is selected only by `--dev-git-index`. This function does not turn a package into dev mode by itself. Once the flag is set, a symlinked `.git` is treated as the checkout and git runs against that link's target.

## Done when

- `is_dev_tree` is false when the top-level `.git` is a symlink, whether the target is a directory containing `HEAD` or a file.
- `is_dev_tree` is false when `.git` is a file, including a `gitdir:` pointer. `is_dev_tree` is false when `.git` is a real directory and `HEAD` is a symlink. Sentinel v2, low on review `7343b668` of `2f890c3d` (R14). Both cases get their own tests.
- `git_environ` does not pass the caller's `GIT_DIR`, `GIT_WORK_TREE`, or any caller `GIT_CONFIG*` into the git subprocess. The function's own `GIT_CONFIG_NOSYSTEM` and `GIT_CONFIG_GLOBAL` pins stay. The test sets the caller names on the process environment and asserts the dict given to `subprocess` lacks `GIT_DIR` and `GIT_WORK_TREE` and does not carry the caller's `GIT_CONFIG_COUNT` or `GIT_CONFIG_SYSTEM`. Do not edit `scripts/git_home.py`.
- `is_dev_tree` stays true for a real `.git` directory whose `HEAD` is a regular file and not a symlink.
- The case-folded `.GIT` directory stays false. `test_is_dev_tree_accepts_casefolded_git_directory` already asserts that and stays green. The exact name `.git` is still the only checkout directory, which is the comment at `:149-152`.
- A package inspected without `--dev-git-index` does not call git. This addendum does not change mode selection.

## Failing test

Name: `test_is_dev_tree_rejects_symlinked_git_directory`

On this main that case returns true. Confirmed in this planning run: `is_dev_tree` on a symlinked `.git` directory was true, and on a real `.git` directory was true.

TEST COMMAND:

```sh
python3 -m pytest tests/test_handoff.py::test_is_dev_tree_rejects_symlinked_git_directory -q
```

Name: `test_is_dev_tree_rejects_git_file_pointer`

`.git` is a regular file whose text starts with `gitdir:`. On this main `is_dev_tree` is already false for that shape. The test locks it.

Name: `test_is_dev_tree_rejects_symlinked_git_head`

`.git` is a real directory and `HEAD` is a symlink to a regular file. On this main `is_dev_tree` is already false because of `head.is_symlink()`. The test locks it.

Name: `test_git_environ_drops_caller_git_dir_and_config`

The process environment has `GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG_COUNT`, and `GIT_CONFIG_SYSTEM` set. `git_environ()` does not return those caller values. It still returns the function's own `GIT_CONFIG_NOSYSTEM` and `GIT_CONFIG_GLOBAL`.

TEST COMMAND:

```sh
python3 -m pytest tests/test_handoff.py::test_is_dev_tree_rejects_git_file_pointer tests/test_handoff.py::test_is_dev_tree_rejects_symlinked_git_head tests/test_handoff.py::test_git_environ_drops_caller_git_dir_and_config -q
```

## Files owned

None as a separate writer. The sentinel-lows writer edits `is_dev_tree` in `scripts/check_handoff.py` and adds the test in `tests/test_handoff.py`.

The check uses `os.lstat` on `.git` and treats a link as not a checkout. It does not call `Path.resolve`, which would follow the link and then look like a real checkout.

## Risk

High. A developer checkout whose `.git` is a symlink (a linked worktree uses a file, which already returns false; some tools symlink the directory) will no longer pass `--dev-git-index`. They run package mode, which refuses `.git` rather than running git. That is fail-closed. The existing case-fold test must stay, so the new lstat check cannot start accepting `.GIT`.

## Rollback

Revert `is_dev_tree`. A symlinked `.git` directory counts as a checkout again. No package contents change.

## Dependencies

Same as `ATLAS-PR10-SENTINEL-LOWS`. #25 overlaps the file. #15, #16, #23, #27, #30, #35, #37, and #40 do not. Bring #25 in with an ordinary merge. #25's parent is #21. Do not rebase either pushed branch.

## Branch base

PR #25 head `3d64934ee1eb` (parent PR #21 `bac4bec450ea`), then PR #41 (`097c5c6680d1b8cfd55db23d39cd027ff69c9133`) and PR #42 (`4457d69c713a784aed9dbe997028bdbe37244d51`), each by ordinary merge, before the `MANIFEST.json` hash refresh. Do not rebase those pushed branches. Do not revert their `Makefile` row or their living rows.

## Known limits

- A `.git` directory symlink, a `.git` file pointer, and a symlinked `.git/HEAD` are not a checkout.
- `git_environ` does not pass the caller's `GIT_DIR`, `GIT_WORK_TREE`, or `GIT_CONFIG*`. The function's own `GIT_CONFIG_NOSYSTEM` and `GIT_CONFIG_GLOBAL` stay.
- `scripts/git_home.py` is not edited.

## Ask

| Ask | None. This row does not ask Tony. |

## Tony source

The backlog row has no separate tony-verbatim card. The title below is copied verbatim from `rows-full.txt`.

> A top-level .git symlink passes is_dev_tree (Sentinel L-1, PR14)
