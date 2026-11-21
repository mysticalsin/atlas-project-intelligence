# Decision: check_handoff residuals

Date: 2026-11-20
Owner: Atlas

Four Low rows left from PR 14. Base `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.

## ISDEVTREE-GIT-SYMLINK

A top-level `.git` that is a symlink is not a dev tree. `is_dev_tree` uses `os.lstat`. The link is not followed. `.git` must be a real directory and `HEAD` must be a regular file.

`--dev-git-index` and `--write-manifest` then use the existing non-checkout exit: `dev-git-index requires a git checkout` (1 on the check, 2 on `--write-manifest`), with no traceback.

Not chosen: resolve the symlink and treat the target as the checkout. `Path.is_file` already follows the link, and the target can be a repository outside this directory. A nested `.git` symlink is already refused.

## CHECKHANDOFF-WALK-ONERROR

Every `os.walk` passes `onerror` through one helper. A directory that cannot be listed is recorded relative to the package root. `inspect` fails with `unreadable: <rel>`. `--write-manifest` prints that line, exits 1, and does not rewrite `MANIFEST.json`. Links are still not followed.

## CAPSYS-DOUBLE-READ

Tests that assert the absence of a traceback call `capsys.readouterr()` once and assert on both `captured.out` and `captured.err`. A second call in the same expression only saw stdout.

## GIT-HOME-SIGKILL-RESIDUAL

`git_environ` still keeps one home for the process and removes it with `atexit` on a normal exit. At the start of each call it also removes real `atlas-git-home-*` directories in the temp directory whose mtime is older than 86400 seconds. Symlinks are not removed. The active home is not removed, even when its mtime is older than the window.

## Sweep boundary

The age check is `current - st_mtime <= 86400`. A home aged 86399 seconds stays. A home aged exactly 86400 seconds stays. A home aged 86401 seconds is removed. `_STALE_GIT_HOME_SECONDS` is the literal 86400. A test that reads the constant back and subtracts it does not pin the literal: changing 86400 to 86401 still passes that test. `now` passed into `_sweep_stale_git_homes` is a POSIX second count, the same unit as `st_mtime`.

Pull request 25 replaces this sweep with `scripts/git_home.py` and measures age in integer nanoseconds. That branch retargets this test's clock when it rebases. The boundary it has to preserve is the same: exactly 86400 seconds stays, and one second past it is removed.

## Symlink homes

An `atlas-git-home-*` symlink is not a home. The sweep `lstat`s it and continues on `S_ISLNK` before `rmtree`. The link stays. The directory it names stays, including a file inside that directory. A real directory aged 86401 seconds in the same temp directory is still removed, so the sweep did run.

## SIGTERM

Not chosen: a `SIGTERM` handler in `scripts/check_handoff.py` that calls the same cleanup and then re-raises the default signal.

Pull request 25, stacked on this branch, owns the git-home lifecycle in `scripts/git_home.py`. `release` deletes a home only when the owner marker names that live process. Removal uses a directory fd opened with `O_DIRECTORY | O_NOFOLLOW`, not `shutil.rmtree` on a path. A handler here would be a second removal path, by path, in the file that pull request rewrites. Immediate cleanup on `SIGTERM` belongs in that release path.

Chosen: disclose the limit. `SIGTERM` does not run `atexit`. The home and a file written into it remain. A later sweep leaves that home while it is younger than 86400 seconds and removes it once its mtime is 86401 seconds behind the sweep clock. There is still no pid file and no external reaper.

## Known limits

SIGKILL does not run `atexit` and does not run the sweep. The killed process's `atlas-git-home-*` directory remains. A later `git_environ()` removes it only after its mtime is older than 86400 seconds. A leftover younger than that window stays. That window cannot be closed inside the killed process.

SIGTERM does not run `atexit` either. The same later sweep removes that orphan on the same 86400-second rule. A younger SIGTERM orphan stays. This branch does not install a signal handler.

A home that is still in use after 86400 seconds can be removed by a different process. This command does not hold the directory that long. There is no pid file and no external reaper. A temp directory that cannot be listed is left as it is. A symlink named `atlas-git-home-*` is left in place and is not followed.

## Tests

- `test_is_dev_tree_rejects_symlinked_git_directory`
- `test_unreadable_directory_is_reported`
- `test_dev_unreadable_directory_is_reported`
- `test_write_manifest_reports_unreadable_directory`
- `test_traceback_assertion_reads_capsys_once`
- `test_stale_git_home_is_swept_at_start`
- `test_git_home_age_threshold_is_the_literal_day`
- `test_stale_git_home_symlink_is_not_followed`
- `test_sigterm_orphaned_git_home_is_swept_after_the_window`

The nine PR14 fence tests are unchanged. The loop-1 tests are appended. `scripts/check_handoff.py` is unchanged in this loop: the three surviving mutants were missing pins, and the SIGTERM limit is the disclosure above. Red is shown by mutants.
