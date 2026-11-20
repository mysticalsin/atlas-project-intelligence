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

## Known limits

SIGKILL does not run `atexit` and does not run the sweep. The killed process's `atlas-git-home-*` directory remains. A later `git_environ()` removes it only after its mtime is older than 86400 seconds. A leftover younger than that window stays. That window cannot be closed inside the killed process.

A home that is still in use after 86400 seconds can be removed by a different process. This command does not hold the directory that long. There is no pid file and no external reaper. A temp directory that cannot be listed is left as it is.

## Tests

- `test_is_dev_tree_rejects_symlinked_git_directory`
- `test_unreadable_directory_is_reported`
- `test_dev_unreadable_directory_is_reported`
- `test_write_manifest_reports_unreadable_directory`
- `test_traceback_assertion_reads_capsys_once`
- `test_stale_git_home_is_swept_at_start`

The nine PR14 fence tests are unchanged.
