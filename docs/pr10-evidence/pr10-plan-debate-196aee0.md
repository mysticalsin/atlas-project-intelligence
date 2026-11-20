# PR #10 re-debate — loop 6 closure only

Bound to `196aee0ba367a4c8538a10a81efa11f925fd3092`, tree `07a2956dede98eab233bf79921c1ce061730c225`, branch `cursor/atlas-post-pr9-fixes`.
Commits since `281bd0b`: `e2af3d8` red (env allowlist + `GIT_WORK_TREE`), `1921461` fix (git env allowlist), `1fabc88` red (symlinks, `GIT_INDEX_FILE`, `CONFIG_COUNT`), `196aee0` fix (lstat symlink components).
Scope: do these changes close the two MUST CHANGEs from the `281bd0b` debate? Follow-up rows stay in Backlog and are not reopened.
Read-only. The writer mutant table at `/cursor/stores/bc-a35ce6aa-bbcc-5d82-a8a0-a13011db8372/pr10-gates-196aee0/mutants-loop6.txt` was not mounted here. The mutants below were re-run in scratch against this tree. Git 2.43.0. The nine targeted tests on the unmodified tree passed.

## MUST CHANGE 1 — lstat before resolve, leaf and directory

**Proposer.** `symlink_in_package_path` `lstat`s every component and does not follow. `inspect` treats a hit as `missing or symlink` before `read_package_bytes` / `resolve()`, for manifest rows, the four HTML aliases, and the logo. `test_listed_symlink_file_to_in_package_target_fails` and `test_listed_file_under_symlinked_dir_component_fails` both pass on this head.

**Challenger.** On `281bd0b` an in-package symlink to a listed file passed, and the outside-symlink tests never exercised `is_symlink()` after `resolve()`. Show that turning the lstat check off makes these two tests red, not merely that the suite is green.

**Proposer.** With `symlink_in_package_path` forced false, both tests go red (`AssertionError`). With the function restored, both pass. The directory case is a symlink component (`linkdir` → `realdir`), not only a symlink leaf. That is the control the previous debate required.

**Verdict: closed.**

## MUST CHANGE 2 — allowlist mutants, and no behavioural claim for the extra flags

**Proposer.** `git_environ` returns only `PATH`, `HOME` (an empty temp directory), `LANG`, `LC_ALL`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, and `GIT_TERMINAL_PROMPT=0`. It does not copy `os.environ`. Behavioural tests pass for a script-valued `core.fsmonitor` directly and via `include.path` (canary not created), for `GIT_DIR`+`GIT_WORK_TREE`, for `GIT_INDEX_FILE` together with those two, and for `GIT_CONFIG_COUNT` / `core.excludesFile=*`. `test_git_subprocess_argv_includes_hardening_flags` stubs `check_output` and only asserts that `core.hooksPath=/dev/null`, `--no-optional-locks`, `GIT_CONFIG_NOSYSTEM`, and `GIT_CONFIG_GLOBAL` are present. Nothing in that test or in the four commit messages says those four stop an attack.

**Challenger.** Replacing `git_environ` with `{**os.environ, ...}` makes `test_dev_git_index_fails_despite_git_index_file_env`, `test_dev_git_index_fails_despite_git_config_count_excludes_file`, and `test_dev_git_index_fails_despite_git_work_tree_env` red. Each false-passes: `1 release files match size and SHA-256.` Putting only `GIT_INDEX_FILE` back into an otherwise allowlisted environment makes `test_git_environ_is_allowlist_without_git_star` red. `GIT_INDEX_FILE` alone does not false-pass `inspect`, because `ls-files -o` still reports the on-disk file (`untracked: hidden/payload.txt`). The behavioural test that carries the `GIT_INDEX_FILE` name also sets `GIT_DIR` and `GIT_WORK_TREE`, and that bundle is what false-passes. The key-absence assertion is what fails for an index-only leak. That still matches the required mutant: a scrub that lets `GIT_INDEX_FILE` through does not stay green.

Removing `-c core.fsmonitor=false` and leaving the other argv flags makes both canary tests red (direct and `include.path`). Removing `core.hooksPath=/dev/null`, or `--no-optional-locks`, or `GIT_CONFIG_NOSYSTEM` and `GIT_CONFIG_GLOBAL`, leaves both canary tests green. Removing `core.hooksPath=/dev/null` makes only the stubbed argv test red, and that test does not run git. There is no behavioural claim left for `hooksPath`, `--no-optional-locks`, or `NOSYSTEM`/`GLOBAL`.

**Verdict: closed.**

CONSENSUS: AGREED
