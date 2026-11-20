# Decision: git home lifecycle

Date: 2026-11-20
Owner: Tony, carried out by Atlas
Tickets: ATLAS-CHECKHANDOFF-REAPER, state machine S3
Base: PR 21 `3ee42d607a7618ec9adfdfb2f2b765f3cda52a81`

`handoff/decisions/check-handoff-residuals.md` is unchanged. PR 21 owns that file.

## Threat model

This code deletes directories. The guards below are the ones that decide which directory, if any.

Actors:

- This `check_handoff` process. It creates one home and `release` removes it on a normal exit.
- Another live `check_handoff` process. Its home is in the same temp directory and must survive this process's `release` and `reap`.
- A process that was SIGKILLed. Its home stays on disk with whatever marker it wrote.
- A same-user writer who can rename, symlink, or replace entries in the temp directory between two path lookups.

Races:

- `release` is handed a path whose marker names a different live pid, names this pid with different start ticks, or has no marker.
- After a home is classified as orphaned, that name is replaced by a live home, or a live marker is written into the same inode, before the name is removed.
- The temp-root path reaches a real directory through a symlinked parent. `O_NOFOLLOW` on the final component does not see that parent.
- A young `atlas-git-home-*` symlink points at an old directory. A symlink also sits inside a home that is being removed.
- One home contains a child directory this user cannot open. Unlinking its siblings changes the home's mtime, and an exception stops the rest of the pass.
- `time.time()` is a float. At the current Unix time its resolution is a few hundred nanoseconds, so a home just past 86400 seconds can round back onto the keep side of the boundary.

Why the guards hold:

- `release` reads `.atlas-owner` on a directory fd opened with `O_DIRECTORY | O_NOFOLLOW`. It removes the directory only when the pid is `os.getpid()` and the start ticks equal field 22 of `/proc/<pid>/stat`. A missing marker, an orphan, another live pid, or a reused pid is left in place. The `in_use` → `cleaned` edge still requires `owner_live`.
- `reap` captures the home's mtime from `fstat` before it trusts the classification. It re-reads the marker on that same fd and compares the name's inode with the fd. A live or unknown marker stops the attempt. A name that no longer names the held inode is not removed. Children are unlinked relative to the held fd. `rmdir` of the name happens only after another inode comparison, so a swapped path is not the directory that is removed.
- The temp root is `realpath`'d, then each component is opened with `O_DIRECTORY | O_NOFOLLOW`. Any symlink, including a parent, refuses the pass. Listing and removal after that use the pinned directory fd.
- A symlink is not opened. A prefixed symlink stays, including a young one whose target is old. A symlink inside a home is unlinked rather than walked.
- A home that cannot be removed fails alone. The pass restores the mtime captured before the attempt and continues. A mode-000 child is opened in a preflight, before any unlink, so the failure leaves that home's bytes and its age.
- The sweep passes `time.time_ns()`. `reap` accepts only an integer nanosecond count. Age greater than `86400 * 10**9` is removed. There is no slack: `86400 * 10**9 + 1` and `86400 * 10**9 + 1000` are both removed. Exactly `86400 * 10**9` stays.

## States

A git home is one real directory whose name starts with `atlas-git-home-`. The states are `created`, `in_use`, `cleaned`, `orphaned`, and `reaped`.

| Edge | Guard |
| --- | --- |
| created → in_use | `create` writes the owner marker for this process, and that process is alive. `release` does not take this edge for a directory it did not mark. |
| created → orphaned | There is no live owner. An old directory with no marker takes this edge during reap. |
| in_use → cleaned | The marker names this process and its start ticks, and that owner releases the home. `atexit` does this on a normal exit. |
| in_use → orphaned | The recorded pid is gone, or the pid was reused and `/proc/<pid>` start time differs. |
| orphaned → reaped | Age is greater than 86400 seconds, the owner is not live, the entry is a real directory, and the temp root is a real directory. |

No other edge is allowed. `in_use` does not go to `reaped`. `cleaned` and `reaped` are terminal.

## Owner marker

`create` writes `.atlas-owner` inside the home: one ASCII line, `pid startticks`, mode `0600`. `startticks` is field 22 of `/proc/<pid>/stat` (the start time, in clock ticks). The reaper opens that file with `O_NOFOLLOW`. A missing file is `created`. A symlink, an unreadable file, or a line that does not parse is treated as in use, so the home is kept.

## Reaper

`git_environ` reaps at the start of every call, then creates or reuses this process's home.

Age is `time.time_ns() - st_mtime_ns` from `fstat` of the held directory. Exactly 86400 seconds (`86400 * 10**9` nanoseconds) is kept. 86400.001 seconds (`86400 * 10**9 + 10**6` nanoseconds) is removed. So is 1000 nanoseconds past the boundary, and so is 1 nanosecond past it. This is the same keep-at-exactly-86400 boundary PR 21 implemented with `mtime` and `<= 86400`, counted in integers.

The reaper keeps:

- this process's active home, compared by device and inode
- a home whose marker names a live pid with the same start time
- a home whose marker cannot be proved dead
- a symlink, either as any component of the temp root, as a home entry, or as a child of a home
- a home whose removal fails, at the mtime captured before that attempt

The temp root is `realpath`'d and opened by walking each component with `O_DIRECTORY | O_NOFOLLOW`. A symlink anywhere in that chain returns without listing the target. Every later removal uses a held directory fd and a single path component. The marker and the inode are read again on those fds before unlink. A symlink child is unlinked. Its target is not opened.

`release` removes a home only when the held marker names this process. A markerless directory is not deleted by `release`. An old markerless directory can still be reaped.

Two runs may reap the same orphan. The second sees the name already gone.

## Known limits

SIGKILL does not run `atexit` and does not reap. That process's home remains until a later run sees an age greater than 86400 seconds. A younger orphan remains. The window is not closed inside the killed process.

If `/proc` is not a real directory, a marker cannot be proved dead, so a stamped home is kept. An old home with no marker is still reaped. `release` does not delete that markerless directory.

A symlink named `atlas-git-home-*` is left in place. A temp path that traverses a symlink is not reaped. `create` still marks the real directory `mkdtemp` just created when the temp directory itself is reached through a symlink. `release` of that home removes the inode the marker names.

A home that cannot be fully removed, including one with a mode-000 child, stays, keeps the mtime from before the attempt, and does not stop the other homes in the pass.

`check_handoff` sets `sys.dont_write_bytecode` before it imports this module. Package mode walks the directory it is checking. A `__pycache__` file created by that import would be `unlisted`.

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
- `test_release_keeps_a_home_owned_by_another_live_pid`
- `test_release_keeps_a_markerless_directory`
- `test_release_keeps_an_orphaned_home`
- `test_release_keeps_a_home_when_start_ticks_differ`
- `test_reap_removes_a_reused_pid_with_different_start_ticks`
- `test_cleaned_requires_a_live_owner`
- `test_reap_does_not_delete_a_live_home_swapped_onto_the_name`
- `test_reap_rechecks_the_marker_on_the_held_directory`
- `test_symlinked_parent_of_the_temp_root_is_refused`
- `test_young_prefixed_symlink_to_an_old_directory_is_not_followed`
- `test_mode000_child_keeps_its_age_and_the_pass_continues`
- `test_one_thousand_nanoseconds_past_the_boundary_is_removed`
- `test_sweep_clock_is_integer_nanoseconds`

## Done when

- The twenty-three tests above pass.
- A killed home older than 86400 seconds is gone after the next `git_environ`.
- A live home older than 86400 seconds is still there, payload included.
- Age 86400 seconds remains. Age 86400.001 seconds is gone. So are 1 nanosecond and 1000 nanoseconds past 86400 seconds.
- `release` leaves a home owned by another live pid, a markerless directory, an orphan, and a home whose start ticks do not match.
- A live home swapped onto an orphan's name after classification is not deleted. A live marker written into the held directory stops that removal.
- A symlink inside a reaped home does not delete its target. A symlinked temp root does not delete the target's home. A symlinked parent of the temp root refuses the pass. A young prefixed symlink does not delete an old target.
- A mode-000 child does not refresh the home's mtime and does not stop the other homes in the pass.
- The sweep clock is `time.time_ns`.
- After 32 simulated killed homes, one reap leaves fewer bytes than those 32 payloads.
- The transition table rejects every edge outside the five above, and rejects a reap at exactly 86400 seconds.
- `tests/test_handoff.py` still passes once `MANIFEST.json` matches the tree.
