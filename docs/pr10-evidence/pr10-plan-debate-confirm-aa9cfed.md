# PR #10 re-confirmation after the PR11 and PR12 merges

Role: non-author plan debater. This record checks `aa9cfed` only. It does not authorise a change to the PR10 branch, the PR body, or main.

Head `aa9cfed832cf1e766887dbd8fd4e61cf85f76082`. Tree `36dc13af5edf1718a434b349a4417f5dbd5d45e8`. Parents `f55ff0617aec9f396a13cd3e7fd245ab132de9cc` and `9b81dff77fbbfc6b6975658963805ef16d58c27a` (merge of PR #12). `f55ff06` itself is the merge of `196aee0ba367a4c8538a10a81efa11f925fd3092` and `ab2a6af5ff0c18f272321f9a532aa8ede5b7af93` (merge of PR #11).

Prior agreement: `docs/pr10-evidence/pr10-plan-debate-196aee0.md` on `qa-assets/pr10-196aee0` at `9a2b9ed`, and `/cursor/stores/bot/atlas-pr10/pr10-plan-debate-196aee0.md`. CONSENSUS: AGREED on `196aee0`. Its two closed controls are lstat-before-resolve for a symlink leaf and a symlink directory component, and the git environment allowlist.

Positions: PROPOSER defends the merged tree. SKEPTIC attacks it. Probes ran in a detached worktree at `aa9cfed`. The worktree was restored. Nothing here was written onto the PR branch.

## 1. The checker and its tests

`scripts/check_handoff.py` is blob `bcbd2c7ef5d9c25b8d4f8bbb8b76a5efcb06a0dd` on `196aee0`, on `f55ff06`, and on `aa9cfed`. `git diff 196aee0 aa9cfed -- scripts/check_handoff.py` is empty.

`tests/test_handoff.py` is not that same blob. `196aee0` is `93f5d36e59a054def7509f89b47251c911431788`. `f55ff06` and `aa9cfed` are `b609ec0b7709015981c137bc80bb4eea1093b831`. The diff against `196aee0` is 17 added lines: `import sys`, and `test_git_archive_of_head_passes_check_handoff`, which archives `HEAD` and runs `scripts/check_handoff.py` on the extract. No earlier test was edited. `f55ff06` to `aa9cfed` has no test diff.

Round 1. PROPOSER: The production checker is the `196aee0` file. The test diff is the PR11 archive test, auto-merged onto the fence tests. It calls the checker. It does not replace `git_environ` or `symlink_in_package_path`.

Round 1. SKEPTIC: "Byte-identical tests" is false. The new test runs `git archive` with the ambient environment, then scores a tree that has no `.git`. That path does not exercise the allowlist. A later reader can treat a green archive test as proof the fence ran.

Round 2. PROPOSER: The archive test is an extra call to the same checker. The fence tests are still in the file, unchanged, and they are the ones that fail when the checks are removed. Package mode on an archive does not turn those tests off.

Round 2. SKEPTIC: Agreed, once the diff is stated. The checker is identical. The test file gained one caller and no edit to the two controls.

Agreed outcome: `check_handoff.py` is byte-identical to `196aee0`. `tests/test_handoff.py` differs by the PR11 archive test only. That diff does not change the two controls.

## 2. The two controls still fail closed

On the unmodified `aa9cfed` tree, these nine tests passed, 0 failed, 0.15s, exit 0:

- `test_listed_symlink_file_to_in_package_target_fails`
- `test_listed_file_under_symlinked_dir_component_fails`
- `test_dev_git_fsmonitor_script_path_does_not_touch_canary`
- `test_dev_git_fsmonitor_via_include_path_does_not_touch_canary`
- `test_dev_git_index_fails_despite_git_index_file_env`
- `test_dev_git_index_fails_despite_git_config_count_excludes_file`
- `test_dev_git_index_fails_despite_git_work_tree_env`
- `test_git_environ_is_allowlist_without_git_star`
- `test_git_subprocess_argv_includes_hardening_flags`

`symlink_in_package_path` still `lstat`s each component and does not follow. `git_environ` still returns only `PATH`, an empty temp `HOME`, `LANG`, `LC_ALL`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, and `GIT_TERMINAL_PROMPT=0`.

Mutants, each restored:

- `symlink_in_package_path` forced to `return False`. Both symlink tests failed, exit 1. The leaf test is `assert not True`. The directory test (`linkdir` → `realdir`) no longer reports `symlink`.
- `git_environ` changed to `{**os.environ, ...}`. Four tests failed, exit 1. The three dev-git-index tests false-pass with `1 release files match size and SHA-256.` The allowlist test fails because the returned keys are no longer the seven names.

Round 1. PROPOSER: The same two disable-the-check mutants the `196aee0` debate required are red on this tree. The leaf and the directory component both depend on the lstat. The allowlist is what stops the git-index false pass.

Round 1. SKEPTIC: A green suite on an unmodified tree was not enough last time. These two mutants are the control, and both went red for the same reasons as on `196aee0`. I will not ask for a third mutant in this confirmation.

Round 2. PROPOSER: Agreed.

Round 2. SKEPTIC: Agreed.

Agreed outcome: Both MUST CHANGE controls still hold on `aa9cfed`.

## 3. What PR11 and PR12 brought in

`git merge-tree` conflicts for `f55ff06` are the seven paths named in the request: the four `ATLAS_*.html` files, `MANIFEST.json`, `deploy/cloudflare-edge/src/csp.generated.js`, and `scripts/check_handoff.py`. The conflict in `check_handoff.py` was resolved by keeping `196aee0`. Main's blob is `75d259cc9e916b9050d76a15b251f1d75a4c477c`. That file has neither `symlink_in_package_path` nor `git_environ`. `9b81dff` still has that older blob. `aa9cfed` does not.

`git merge-tree` for `aa9cfed` conflicts on `MANIFEST.json` only. `handoff/BUILD_STATUS.md` auto-merged. The merged manifest has 692 entries, the tree has 693 paths, the list is every path except `MANIFEST.json` in tree order, and every size and SHA-256 matches the blob. No conflict markers.

Files that differ from `f55ff06` and equal `9b81dff` are the PR12 invitation files: `library.js`, `operate.js`, `subject-rights.js`, the invitation tests, and the two decision records. None of them call `check_handoff`. The only callers on this tree are `Makefile` lines 48 and 51, `scripts/check_handoff.py`, and `tests/test_handoff.py`. The Makefile diff since `196aee0` adds `tests/record_dialog_quality_browser.py` to `test-ui`. It does not change the two checker lines. `src/app.js` is the PR11 quality-dialog optional chaining. The HTML diff is those same quality lines. `csp.generated.js` is a two-line hash change.

Round 1. PROPOSER: PR11 and PR12 do not replace the checker, do not add a second package reader, and do not pass a flag that skips `inspect`. The resolved checker is the stricter blob. The manifest records that blob.

Round 1. SKEPTIC: An auto-merged `src/app.js` and a regenerated HTML page can hide a second copy of a check. I looked for `check_handoff` outside the Makefile, the script, and the test file. There is no other caller. The invitation erase does not open the package fence.

Round 2. PROPOSER: Agreed.

Round 2. SKEPTIC: Agreed. Nothing merged in weakens the fence or bypasses `check_handoff`.

Agreed outcome: The merges keep the `196aee0` fence. PR11 and PR12 do not bypass it.

## MUST CHANGE

None.

CONSENSUS: AGREED on aa9cfed832cf1e766887dbd8fd4e61cf85f76082
