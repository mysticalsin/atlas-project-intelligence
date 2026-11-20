# Decision: git home lifecycle

Date: 2026-11-20
Owner: Tony, carried out by Atlas
Tickets: ATLAS-CHECKHANDOFF-REAPER, state machine S3
Base: PR 21 `3ee42d607a7618ec9adfdfb2f2b765f3cda52a81`

`handoff/decisions/check-handoff-residuals.md` is unchanged. PR 21 owns that file.

## States

A git home is one real directory whose name starts with `atlas-git-home-`. The states are `created`, `in_use`, `cleaned`, `orphaned`, and `reaped`.

| Edge | Guard |
| --- | --- |
| created → in_use | The owner marker records this process, and that process is alive. |
| created → orphaned | There is no live owner. An old directory with no marker takes this edge. |
| in_use → cleaned | The live owner releases the home. `atexit` does this on a normal exit. |
| in_use → orphaned | The recorded pid is gone, or the pid was reused and `/proc/<pid>` start time differs. |
| orphaned → reaped | Age is greater than 86400 seconds, the owner is not live, the entry is a real directory, and the temp root is a real directory. |

No other edge is allowed. `in_use` does not go to `reaped`. `cleaned` and `reaped` are terminal.

## Owner marker

`create` writes `.atlas-owner` inside the home: one ASCII line, `pid startticks`, mode `0600`. `startticks` is field 22 of `/proc/<pid>/stat` (the start time, in clock ticks). The reaper opens that file with `O_NOFOLLOW`. A missing file is `created`. A symlink, an unreadable file, or a line that does not parse is treated as in use, so the home is kept.

## Reaper

`git_environ` reaps at the start of every call, then creates or reuses this process's home.

Age is `now_ns - st_mtime_ns` from `lstat`. Exactly 86400 seconds (`86400 * 10**9` nanoseconds) is kept. 86400.001 seconds (`86400 * 10**9 + 10**6` nanoseconds) is removed. This is the same boundary PR 21 implemented with `mtime` and `<= 86400`.

The reaper keeps:

- this process's active home, compared by device and inode
- a home whose marker names a live pid with the same start time
- a home whose marker cannot be proved dead
- a symlink, either as the temp root, as a home entry, or as a child of a home

The temp root is opened with `O_DIRECTORY | O_NOFOLLOW` after `lstat`. Every removal uses that directory file descriptor and a single path component. A symlink child is unlinked. Its target is not opened. A symlinked temp root returns without listing the target.

Two runs may reap the same orphan. The second sees the name already gone.

## Known limits

SIGKILL does not run `atexit` and does not reap. That process's home remains until a later run sees an age greater than 86400 seconds. A younger orphan remains. The window is not closed inside the killed process.

If `/proc` is not a real directory, a marker cannot be proved dead, so a stamped home is kept. An old home with no marker is still reaped.

A symlink named `atlas-git-home-*` is left in place.

## Tests

`tests/test_git_home.py`

- `test_sigkill_orphan_is_reaped_on_next_run`
- `test_live_concurrent_home_is_never_reaped`
- `test_reap_boundary_keeps_86400_and_removes_86400_001`
- `test_symlink_inside_home_is_not_followed`
- `test_symlinked_temp_root_is_refused`
- `test_disk_growth_is_bounded_across_killed_runs`
- `test_transition_table_allows_only_the_lifecycle_edges`
- `test_reap_decision_property`
- `test_concurrent_reapers_keep_a_live_home`
- `test_create_then_release_removes_an_in_use_home`

## Done when

- The ten tests above pass.
- A killed home older than 86400 seconds is gone after the next `git_environ`.
- A live home older than 86400 seconds is still there, payload included.
- Age 86400 seconds remains. Age 86400.001 seconds is gone.
- A symlink inside a reaped home does not delete its target. A symlinked temp root does not delete the target's home.
- After 32 simulated killed homes, one reap leaves fewer bytes than those 32 payloads.
- The transition table rejects every edge outside the five above, and rejects a reap at exactly 86400 seconds.
- `tests/test_handoff.py` still passes once `MANIFEST.json` matches the tree.
