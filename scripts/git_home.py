"""Lifecycle of one check_handoff git HOME.

States are created, in use, cleaned, orphaned, and reaped. A home moves
only through the guarded edges in ``TRANSITIONS``. The reaper removes an
orphaned home when its age is greater than 86400 seconds. Exactly 86400
seconds stays. Age is integer nanoseconds from ``time.time_ns``. A live
owner (pid and /proc start time) stays. ``release`` deletes a directory
only when its marker names this process. Symlinks are not followed. A
temp root reached through any symlink is refused, and removal stays on
directory fds held open with ``O_DIRECTORY | O_NOFOLLOW``.
"""
from __future__ import annotations

import os
import stat
import tempfile
import time
from enum import Enum


PREFIX = 'atlas-git-home-'
MARKER_NAME = '.atlas-owner'
STALE_SECONDS = 86400
STALE_NS = STALE_SECONDS * 1_000_000_000

_OPEN_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


class State(str, Enum):
    CREATED = 'created'
    IN_USE = 'in_use'
    CLEANED = 'cleaned'
    ORPHANED = 'orphaned'
    REAPED = 'reaped'


TRANSITIONS = frozenset({
    ('created', 'in_use'),
    ('created', 'orphaned'),
    ('in_use', 'cleaned'),
    ('in_use', 'orphaned'),
    ('orphaned', 'reaped'),
})

_ALLOWED = frozenset((State(src), State(dst)) for src, dst in TRANSITIONS)


class TransitionError(ValueError):
    """A lifecycle edge is not allowed, or its guard failed."""


class ReapResult:
    """What one reap pass did. ``refused`` means the temp root was not used."""

    def __init__(self, reaped: tuple[str, ...], refused: bool, transitions: tuple[tuple[str, str, str], ...]):
        self.reaped = reaped
        self.refused = refused
        self.transitions = transitions


def transition(
    current: State,
    target: State,
    *,
    owner_live: bool | None = None,
    releasing: bool = False,
    age_ns: int | None = None,
) -> State:
    """Move ``current`` to ``target`` when that edge and its guard both hold."""
    if (current, target) not in _ALLOWED:
        raise TransitionError('%s -> %s' % (current.value, target.value))
    if target is State.IN_USE and owner_live is not True:
        raise TransitionError('in use requires a live owner')
    if target is State.ORPHANED and owner_live is not False:
        raise TransitionError('orphaned requires a dead owner')
    if target is State.CLEANED and (releasing is not True or owner_live is not True):
        raise TransitionError('cleaned requires the live owner to release')
    if target is State.REAPED:
        if owner_live is not False:
            raise TransitionError('reaped requires a dead owner')
        if isinstance(age_ns, bool) or not isinstance(age_ns, int) or age_ns <= STALE_NS:
            raise TransitionError('reaped requires age greater than 86400s')
    return target


def reap_decision(
    *,
    state: State,
    age_ns: int,
    entry_is_symlink: bool,
    root_is_symlink: bool,
) -> bool:
    """True only for a real created or orphaned home older than 86400 seconds."""
    if entry_is_symlink or root_is_symlink:
        return False
    if isinstance(age_ns, bool) or not isinstance(age_ns, int) or age_ns <= STALE_NS:
        return False
    return state in (State.CREATED, State.ORPHANED)


def _proc_is_directory() -> bool:
    try:
        st = os.lstat('/proc')
    except OSError:
        return False
    return stat.S_ISDIR(st.st_mode)


def start_ticks(pid: int) -> tuple[str, int | None]:
    """``('alive', ticks)``, ``('dead', None)``, or ``('unknown', None)``.

    A symlink ``/proc/<pid>/stat`` is unknown. The caller must not treat
    unknown as dead: a live home is kept when the owner cannot be proved gone.
    """
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return ('dead', None)
    if not _proc_is_directory():
        return ('unknown', None)
    path = '/proc/%d/stat' % pid
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return ('dead', None)
    except OSError:
        return ('unknown', None)
    if not stat.S_ISREG(st.st_mode):
        return ('unknown', None)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return ('dead', None)
    except OSError:
        return ('unknown', None)
    try:
        data = os.read(fd, 4096)
    finally:
        os.close(fd)
    end = data.rfind(b')')
    if end < 0:
        return ('unknown', None)
    fields = data[end + 2:].split()
    if len(fields) <= 19:
        return ('unknown', None)
    try:
        return ('alive', int(fields[19]))
    except ValueError:
        return ('unknown', None)


def _parse_marker(data: bytes) -> tuple[int, int] | None:
    if not data or len(data) > 64 or not data.endswith(b'\n'):
        return None
    pid_text, sep, start_text = data[:-1].partition(b' ')
    if sep != b' ' or not pid_text.isdigit() or not start_text.isdigit():
        return None
    pid = int(pid_text)
    start = int(start_text)
    if pid <= 0:
        return None
    return pid, start


def _read_marker(dir_fd: int) -> tuple[str, int | None, int | None]:
    """``absent``, ``live`` numbers, or ``unknown``. Never follows a symlink."""
    try:
        fd = os.open(MARKER_NAME, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dir_fd)
    except FileNotFoundError:
        return ('absent', None, None)
    except OSError:
        return ('unknown', None, None)
    try:
        data = os.read(fd, 65)
    finally:
        os.close(fd)
    parsed = _parse_marker(data)
    if parsed is None:
        return ('unknown', None, None)
    return ('present', parsed[0], parsed[1])


def _write_marker(dir_fd: int, pid: int, start: int) -> None:
    payload = ('%d %d\n' % (pid, start)).encode('ascii')
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW
    fd = os.open(MARKER_NAME, flags, 0o600, dir_fd=dir_fd)
    try:
        os.write(fd, payload)
    finally:
        os.close(fd)


def _owner_state(pid: int, start: int) -> str:
    """``live`` when pid is alive and its start ticks match, else ``dead`` or ``unknown``."""
    owner, ticks = start_ticks(pid)
    if owner == 'unknown':
        return 'unknown'
    if owner == 'alive' and ticks == start:
        return 'live'
    return 'dead'


def classify_fd(dir_fd: int) -> State:
    kind, pid, start = _read_marker(dir_fd)
    if kind == 'absent':
        return State.CREATED
    if kind != 'present' or pid is None or start is None:
        return State.IN_USE
    state = _owner_state(pid, start)
    if state == 'dead':
        return State.ORPHANED
    return State.IN_USE


def classify(path: str) -> State:
    fd = os.open(path, _OPEN_DIR)
    try:
        return classify_fd(fd)
    finally:
        os.close(fd)


def _now_ns(now: int | None) -> int:
    """Integer nanoseconds. ``None`` reads ``time.time_ns`` and there is no slack."""
    if now is None:
        return time.time_ns()
    if isinstance(now, bool) or not isinstance(now, int):
        raise TypeError('now must be integer nanoseconds')
    return now


def _child_names(dir_fd: int) -> list[str]:
    names = []
    for name in os.listdir(dir_fd):
        if name in ('', '.', '..') or '/' in name or '\\' in name:
            raise OSError('refusing to leave the directory')
        names.append(name)
    return names


def _open_real_dir(dir_fd: int, name: str) -> int | None:
    """Open one real child directory. A symlink is not opened and not followed."""
    if name in ('', '.', '..') or '/' in name or '\\' in name:
        return None
    try:
        st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except OSError:
        return None
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        return None
    try:
        fd = os.open(name, _OPEN_DIR, dir_fd=dir_fd)
    except OSError:
        return None
    try:
        held = os.fstat(fd)
    except OSError:
        os.close(fd)
        return None
    if (held.st_dev, held.st_ino) != (st.st_dev, st.st_ino) or not stat.S_ISDIR(held.st_mode):
        os.close(fd)
        return None
    return fd


def _open_chain(path: str) -> int | None:
    """Walk ``path`` one component at a time. Any symlink refuses the open."""
    if not isinstance(path, str) or not path or '\0' in path:
        return None
    try:
        fd = os.open(os.sep if os.path.isabs(path) else '.', _OPEN_DIR)
    except OSError:
        return None
    try:
        for part in path.split(os.sep):
            if part in ('', '.'):
                continue
            if part == '..':
                os.close(fd)
                return None
            nxt = _open_real_dir(fd, part)
            os.close(fd)
            if nxt is None:
                return None
            fd = nxt
        return fd
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        return None


def _pin_directory(path: str) -> int | None:
    """Pin ``path`` on a directory fd.

    ``realpath`` resolves the path, then every component is opened with
    ``O_DIRECTORY | O_NOFOLLOW``. A symlink anywhere in the chain refuses
    the pin. Later removal uses the returned fd, not the path string.
    """
    try:
        real = os.path.realpath(path, strict=True)
    except (OSError, ValueError):
        return None
    fd = _open_chain(path)
    if fd is None:
        return None
    real_fd = _open_chain(real)
    if real_fd is None:
        os.close(fd)
        return None
    try:
        if (os.fstat(fd).st_dev, os.fstat(fd).st_ino) != (os.fstat(real_fd).st_dev, os.fstat(real_fd).st_ino):
            os.close(fd)
            return None
    finally:
        os.close(real_fd)
    return fd


def _open_final(path: str) -> int | None:
    """Open the final directory of ``path``. A symlink as that component is refused.

    Parent components are not a temp-root pin. ``reap`` does not use this.
    """
    try:
        st = os.lstat(path)
    except OSError:
        return None
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        return None
    try:
        fd = os.open(path, _OPEN_DIR)
    except OSError:
        return None
    try:
        held = os.fstat(fd)
    except OSError:
        os.close(fd)
        return None
    if (held.st_dev, held.st_ino) != (st.st_dev, st.st_ino) or not stat.S_ISDIR(held.st_mode):
        os.close(fd)
        return None
    return fd


def _name_id(dir_fd: int, name: str) -> tuple[int, int] | None:
    try:
        st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except OSError:
        return None
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        return None
    return (st.st_dev, st.st_ino)


def _owns(dir_fd: int) -> bool:
    """True only when the marker names this process and its start ticks."""
    kind, pid, start = _read_marker(dir_fd)
    if kind != 'present' or pid is None or start is None or pid != os.getpid():
        return False
    return _owner_state(pid, start) == 'live'


def _blocks_reap(dir_fd: int) -> bool:
    """True when the marker on this fd is live, unknown, or not a dead owner.

    A missing marker does not block. An old directory with no marker can
    still be reaped. The read is against ``dir_fd``, not the path name.
    """
    kind, pid, start = _read_marker(dir_fd)
    if kind == 'absent':
        return False
    if kind != 'present' or pid is None or start is None:
        return True
    return _owner_state(pid, start) != 'dead'


def _ensure_removable(dir_fd: int) -> None:
    """Raise before any unlink when a child directory cannot be opened."""
    for name in _child_names(dir_fd):
        st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
            continue
        child = os.open(name, _OPEN_DIR, dir_fd=dir_fd)
        try:
            held = os.fstat(child)
            if (held.st_dev, held.st_ino) != (st.st_dev, st.st_ino):
                raise OSError('directory changed during removal')
            _ensure_removable(child)
        finally:
            os.close(child)


def _remove_name(dir_fd: int, name: str) -> None:
    """Remove ``name`` under ``dir_fd``. A symlink is unlinked, not followed."""
    if name in ('', '.', '..') or '/' in name or '\\' in name:
        raise OSError('refusing to leave the temp root')
    try:
        st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        try:
            os.unlink(name, dir_fd=dir_fd)
        except FileNotFoundError:
            return
        return
    child = os.open(name, _OPEN_DIR, dir_fd=dir_fd)
    try:
        held = os.fstat(child)
        if (held.st_dev, held.st_ino) != (st.st_dev, st.st_ino):
            raise OSError('directory changed during removal')
        for entry in _child_names(child):
            _remove_name(child, entry)
    finally:
        os.close(child)
    os.rmdir(name, dir_fd=dir_fd)


def _remove_children(dir_fd: int) -> None:
    for name in _child_names(dir_fd):
        _remove_name(dir_fd, name)


def _restore_mtime(dir_fd: int, mtime_ns: int) -> None:
    try:
        os.utime(dir_fd, ns=(mtime_ns, mtime_ns))
    except OSError:
        return


def _empty_refused() -> ReapResult:
    return ReapResult(reaped=(), refused=True, transitions=())


def _active_id(active: str | None) -> tuple[int, int] | None:
    if not active:
        return None
    fd = _open_final(active)
    if fd is None:
        return None
    try:
        st = os.fstat(fd)
    finally:
        os.close(fd)
    return (st.st_dev, st.st_ino)


def _decision(state: State, age_ns: int) -> bool:
    return reap_decision(
        state=state, age_ns=age_ns,
        entry_is_symlink=False, root_is_symlink=False,
    )


def _reap_one(
    root_fd: int,
    home_fd: int,
    name: str,
    now_ns: int,
    active_id: tuple[int, int] | None,
    reaped: list[str],
    transitions: list[tuple[str, str, str]],
) -> None:
    """Reap one held directory, or leave it. Removal stays on ``home_fd``."""
    held = os.fstat(home_fd)
    held_id = (held.st_dev, held.st_ino)
    original = held.st_mtime_ns
    if active_id is not None and held_id == active_id:
        return
    if _name_id(root_fd, name) != held_id:
        return
    age_ns = now_ns - original
    state = classify_fd(home_fd)
    if not _decision(state, age_ns):
        return
    # Marker and name are read again on the fds still held. A live marker
    # written into this inode, or a different directory swapped onto this
    # name, is not removed.
    if _blocks_reap(home_fd) or _name_id(root_fd, name) != held_id:
        return
    state = classify_fd(home_fd)
    if _blocks_reap(home_fd) or _name_id(root_fd, name) != held_id:
        return
    if not _decision(state, age_ns):
        return
    from_created = state is State.CREATED
    if from_created:
        state = transition(state, State.ORPHANED, owner_live=False)
    if state is not State.ORPHANED:
        return
    try:
        transition(state, State.REAPED, owner_live=False, age_ns=age_ns)
        _ensure_removable(home_fd)
        if _blocks_reap(home_fd) or _name_id(root_fd, name) != held_id:
            return
        _remove_children(home_fd)
        if _blocks_reap(home_fd) or _name_id(root_fd, name) != held_id:
            _restore_mtime(home_fd, original)
            return
        os.rmdir(name, dir_fd=root_fd)
    except OSError:
        _restore_mtime(home_fd, original)
        return
    if from_created:
        transitions.append((name, 'created', 'orphaned'))
    transitions.append((name, 'orphaned', 'reaped'))
    reaped.append(name)


def reap(root: str, now: int | None = None, active: str | None = None) -> ReapResult:
    """Reap orphaned homes under ``root``.

    ``now`` is integer nanoseconds. The root is pinned with ``realpath``
    and a directory fd. A symlink anywhere in that chain refuses the pass.
    Every later open, unlink, and rmdir is relative to a held directory fd.
    """
    root_fd = _pin_directory(root)
    if root_fd is None:
        return _empty_refused()
    now_ns = _now_ns(now)
    active_id = _active_id(active)
    reaped: list[str] = []
    transitions: list[tuple[str, str, str]] = []
    try:
        for name in os.listdir(root_fd):
            if not name.startswith(PREFIX) or '/' in name or name in ('.', '..'):
                continue
            home_fd = _open_real_dir(root_fd, name)
            if home_fd is None:
                continue
            try:
                _reap_one(root_fd, home_fd, name, now_ns, active_id, reaped, transitions)
            finally:
                os.close(home_fd)
    finally:
        os.close(root_fd)
    return ReapResult(reaped=tuple(reaped), refused=False, transitions=tuple(transitions))


def _rmdir_inode(path: str, home_fd: int, *, require_owner: bool) -> None:
    """Remove the directory entry that still names ``home_fd``."""
    held = os.fstat(home_fd)
    held_id = (held.st_dev, held.st_ino)
    original = held.st_mtime_ns
    real = os.path.realpath(path)
    parent = os.path.dirname(real) or os.sep
    name = os.path.basename(real)
    parent_fd = _pin_directory(parent)
    if parent_fd is None:
        raise OSError('cannot pin the parent of the git home')
    try:
        if _name_id(parent_fd, name) != held_id:
            raise OSError('git home path no longer names this directory')
        if require_owner and not _owns(home_fd):
            raise OSError('git home owner changed')
        _ensure_removable(home_fd)
        if _name_id(parent_fd, name) != held_id:
            raise OSError('git home path changed during removal')
        if require_owner and not _owns(home_fd):
            raise OSError('git home owner changed during removal')
        _remove_children(home_fd)
        # Children include the owner marker. The inode check is what stops
        # rmdir from landing on a directory swapped onto this name.
        if _name_id(parent_fd, name) != held_id:
            _restore_mtime(home_fd, original)
            raise OSError('git home path changed during removal')
        os.rmdir(name, dir_fd=parent_fd)
    except OSError:
        _restore_mtime(home_fd, original)
        raise
    finally:
        os.close(parent_fd)


def create() -> str:
    """Create a home and mark it in use by this process."""
    path = tempfile.mkdtemp(prefix=PREFIX)
    fd = _open_final(path)
    if fd is None:
        raise OSError('cannot open a real directory for the git home')
    try:
        pid = os.getpid()
        kind, ticks = start_ticks(pid)
        if kind != 'alive' or ticks is None:
            raise OSError('cannot record a live owner for the git home')
        _write_marker(fd, pid, ticks)
        transition(State.CREATED, State.IN_USE, owner_live=True)
    except Exception:
        try:
            _rmdir_inode(path, fd, require_owner=False)
        except OSError:
            pass
        raise
    finally:
        os.close(fd)
    return path


def release(path: str) -> None:
    """Remove a home whose marker names this process and its start ticks.

    Any other directory is left in place, including a markerless directory,
    an orphan, and a home owned by a different live pid. A symlink is not
    followed. The marker is read again on the held fd before rmdir.
    """
    if not path:
        return
    home_fd = _open_final(path)
    if home_fd is None:
        return
    try:
        if not _owns(home_fd):
            return
        transition(State.IN_USE, State.CLEANED, releasing=True, owner_live=True)
        if not _owns(home_fd):
            return
        _rmdir_inode(path, home_fd, require_owner=True)
    except OSError:
        return
    finally:
        os.close(home_fd)
