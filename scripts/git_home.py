"""Lifecycle of one check_handoff git HOME.

States are created, in use, cleaned, orphaned, and reaped. A home moves
only through the guarded edges in ``TRANSITIONS``. The reaper removes an
orphaned home when its age is greater than 86400 seconds. Exactly 86400
seconds stays. A live owner (pid and /proc start time) stays. Symlinks
are not followed, and a symlinked temp root is refused.
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


def classify_fd(dir_fd: int) -> State:
    kind, pid, start = _read_marker(dir_fd)
    if kind == 'absent':
        return State.CREATED
    if kind != 'present' or pid is None or start is None:
        return State.IN_USE
    owner, ticks = start_ticks(pid)
    if owner == 'unknown':
        return State.IN_USE
    if owner == 'alive' and ticks == start:
        return State.IN_USE
    return State.ORPHANED


def classify(path: str) -> State:
    fd = os.open(path, _OPEN_DIR)
    try:
        return classify_fd(fd)
    finally:
        os.close(fd)


def _now_ns(now: float | None) -> int:
    if now is None:
        return time.time_ns()
    return int(round(float(now) * 1_000_000_000))


def _identity(path: str) -> tuple[int, int] | None:
    try:
        st = os.lstat(path)
    except OSError:
        return None
    if stat.S_ISLNK(st.st_mode):
        return None
    return (st.st_dev, st.st_ino)


def _remove_name(dir_fd: int, name: str) -> None:
    """Remove ``name`` under ``dir_fd``. A symlink is unlinked, not followed."""
    if name in ('', '.', '..') or '/' in name or '\\' in name:
        raise OSError('refusing to leave the temp root')
    for _ in range(4):
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
        try:
            child = os.open(name, _OPEN_DIR, dir_fd=dir_fd)
        except FileNotFoundError:
            return
        except OSError:
            try:
                os.unlink(name, dir_fd=dir_fd)
            except OSError:
                return
            return
        try:
            for entry in os.listdir(child):
                _remove_name(child, entry)
        finally:
            os.close(child)
        try:
            os.rmdir(name, dir_fd=dir_fd)
            return
        except FileNotFoundError:
            return
        except OSError:
            continue
    raise OSError('could not remove ' + name)


def _empty_refused() -> ReapResult:
    return ReapResult(reaped=(), refused=True, transitions=())


def reap(root: str, now: float | None = None, active: str | None = None) -> ReapResult:
    """Reap orphaned homes under ``root``. A symlink ``root`` is refused."""
    try:
        root_stat = os.lstat(root)
    except OSError:
        return _empty_refused()
    if stat.S_ISLNK(root_stat.st_mode) or not stat.S_ISDIR(root_stat.st_mode):
        return _empty_refused()
    try:
        root_fd = os.open(root, _OPEN_DIR)
    except OSError:
        return _empty_refused()
    now_ns = _now_ns(now)
    active_id = _identity(active) if active else None
    reaped: list[str] = []
    transitions: list[tuple[str, str, str]] = []
    try:
        opened = os.fstat(root_fd)
        if (opened.st_dev, opened.st_ino) != (root_stat.st_dev, root_stat.st_ino):
            return _empty_refused()
        for name in os.listdir(root_fd):
            if not name.startswith(PREFIX) or '/' in name or name in ('.', '..'):
                continue
            try:
                st = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
            except OSError:
                continue
            if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
                continue
            if active_id is not None and (st.st_dev, st.st_ino) == active_id:
                continue
            age_ns = now_ns - st.st_mtime_ns
            try:
                home_fd = os.open(name, _OPEN_DIR, dir_fd=root_fd)
            except OSError:
                continue
            try:
                held = os.fstat(home_fd)
                if (held.st_dev, held.st_ino) != (st.st_dev, st.st_ino):
                    continue
                state = classify_fd(home_fd)
            finally:
                os.close(home_fd)
            if not reap_decision(
                state=state, age_ns=age_ns,
                entry_is_symlink=False, root_is_symlink=False,
            ):
                continue
            if state is State.CREATED:
                state = transition(state, State.ORPHANED, owner_live=False)
                transitions.append((name, 'created', 'orphaned'))
            if state is not State.ORPHANED:
                continue
            transition(state, State.REAPED, owner_live=False, age_ns=age_ns)
            transitions.append((name, 'orphaned', 'reaped'))
            _remove_name(root_fd, name)
            reaped.append(name)
    finally:
        os.close(root_fd)
    return ReapResult(reaped=tuple(reaped), refused=False, transitions=tuple(transitions))


def create() -> str:
    """Create a home and mark it in use by this process."""
    path = tempfile.mkdtemp(prefix=PREFIX)
    fd = os.open(path, _OPEN_DIR)
    try:
        pid = os.getpid()
        kind, ticks = start_ticks(pid)
        if kind != 'alive' or ticks is None:
            raise OSError('cannot record a live owner for the git home')
        _write_marker(fd, pid, ticks)
        transition(State.CREATED, State.IN_USE, owner_live=True)
    except Exception:
        os.close(fd)
        fd = -1
        parent = os.path.dirname(path) or '.'
        parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            _remove_name(parent_fd, os.path.basename(path))
        finally:
            os.close(parent_fd)
        raise
    finally:
        if fd >= 0:
            os.close(fd)
    return path


def release(path: str) -> None:
    """Clean a home this process owns. A symlink is not followed."""
    if not path:
        return
    try:
        st = os.lstat(path)
    except OSError:
        return
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        return
    try:
        state = classify(path)
    except OSError:
        return
    if state is State.CREATED:
        state = transition(state, State.IN_USE, owner_live=True)
    if state is not State.IN_USE:
        return
    transition(state, State.CLEANED, releasing=True, owner_live=True)
    parent = os.path.dirname(path) or '.'
    parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        _remove_name(parent_fd, os.path.basename(path))
    finally:
        os.close(parent_fd)
