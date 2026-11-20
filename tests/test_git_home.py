"""Git-home lifecycle. ATLAS-CHECKHANDOFF-REAPER, state machine S3.

The on-disk owner marker is ``.atlas-owner`` with one line ``pid startticks``.
Age is integer nanoseconds. Exactly 86400 seconds is kept. 86400.001 seconds
is removed. A live pid plus matching /proc start time is never reaped.
"""
import itertools
import os
import shutil
import stat
import threading
import time
from pathlib import Path

import pytest

STALE_NS = 86400 * 1_000_000_000
OVER_NS = STALE_NS + 1_000_000  # 86400.001 seconds
MARKER = '.atlas-owner'
NOW = 1_700_000_000
NOW_NS = NOW * 1_000_000_000


def _self_start() -> int:
    data = open('/proc/self/stat', 'rb').read()
    fields = data[data.rfind(b')') + 2:].split()
    return int(fields[19])


def _dead_pid() -> int:
    pid = os.getpid() + 1_000_000
    while os.path.exists('/proc/%d' % pid):
        pid += 1
    return pid


def _write_owner(path: Path, pid: int, start: int) -> None:
    (path / MARKER).write_text('%d %d\n' % (pid, start), encoding='ascii')


def _touch(path: Path, mtime_ns: int) -> None:
    os.utime(path, ns=(mtime_ns, mtime_ns))


def _age_past(path: Path, extra_seconds: int = 120) -> None:
    _touch(path, time.time_ns() - (STALE_NS + extra_seconds * 1_000_000_000))


def _file_bytes(root: Path) -> int:
    total = 0
    for dirpath, _dirnames, filenames in os.walk(root, followlinks=False):
        for name in filenames:
            path = os.path.join(dirpath, name)
            st = os.lstat(path)
            if stat.S_ISREG(st.st_mode):
                total += st.st_size
    return total


@pytest.fixture
def handoff_temp(tmp_path, monkeypatch):
    import scripts.check_handoff as handoff
    private = tmp_path / 'tmp'
    private.mkdir()
    monkeypatch.setattr(handoff.tempfile, 'gettempdir', lambda: str(private))
    previous = handoff._GIT_HOME
    yield handoff, private
    created = handoff._GIT_HOME
    handoff._GIT_HOME = previous
    if not created or created == previous:
        return
    created_path = Path(created)
    if private in created_path.parents:
        return
    if created_path.is_symlink():
        created_path.unlink(missing_ok=True)
    elif created_path.exists():
        shutil.rmtree(created_path, ignore_errors=True)


def test_sigkill_orphan_is_reaped_on_next_run(handoff_temp):
    import scripts.git_home as life
    handoff, private = handoff_temp
    killed = private / 'atlas-git-home-killed'
    killed.mkdir()
    (killed / 'payload').write_bytes(b'orphan')
    _write_owner(killed, _dead_pid(), 1)
    _touch(killed, time.time_ns() - (life.STALE_NS + 120 * 1_000_000_000))
    young = private / 'atlas-git-home-young'
    young.mkdir()
    (young / 'payload').write_bytes(b'young')
    _write_owner(young, _dead_pid(), 1)
    result = life.reap(str(private), now=time.time(), active=None)
    assert not killed.exists()
    assert young.is_dir()
    assert life.classify(str(young)) == life.State.ORPHANED
    assert ('atlas-git-home-killed', 'orphaned', 'reaped') in result.transitions
    nxt = private / 'atlas-git-home-next'
    nxt.mkdir()
    (nxt / 'payload').write_bytes(b'next')
    _write_owner(nxt, _dead_pid(), 1)
    _age_past(nxt)
    handoff._GIT_HOME = None
    handoff.git_environ()
    assert not nxt.exists()
    assert young.is_dir()
    assert (young / 'payload').read_bytes() == b'young'


def test_live_concurrent_home_is_never_reaped(handoff_temp):
    handoff, private = handoff_temp
    active = private / 'atlas-git-home-active'
    live = private / 'atlas-git-home-live'
    stale = private / 'atlas-git-home-stale'
    fresh = private / 'atlas-git-home-fresh'
    for path in (active, live, stale, fresh):
        path.mkdir()
        (path / 'payload').write_bytes(path.name.encode())
    _write_owner(live, os.getpid(), _self_start())
    for path in (active, live, stale):
        _age_past(path)
    handoff._GIT_HOME = str(active)
    assert handoff.git_environ()['HOME'] == str(active)
    assert active.is_dir()
    assert live.is_dir()
    assert (live / 'payload').read_bytes() == b'atlas-git-home-live'
    assert (live / MARKER).is_file()
    assert fresh.is_dir()
    assert not stale.exists()


def test_reap_boundary_keeps_86400_and_removes_86400_001(handoff_temp):
    handoff, private = handoff_temp
    kept = private / 'atlas-git-home-kept'
    gone = private / 'atlas-git-home-gone'
    kept.mkdir()
    gone.mkdir()
    (kept / 'k').write_bytes(b'k')
    (gone / 'g').write_bytes(b'g')
    _write_owner(kept, _dead_pid(), 1)
    _write_owner(gone, _dead_pid(), 1)
    _touch(kept, NOW_NS - STALE_NS)
    _touch(gone, NOW_NS - OVER_NS)
    handoff._GIT_HOME = None
    handoff._sweep_stale_git_homes(now=float(NOW))
    assert kept.is_dir()
    assert (kept / 'k').read_bytes() == b'k'
    assert not gone.exists()
    kept_age = NOW_NS - os.lstat(kept).st_mtime_ns
    assert kept_age == STALE_NS
    assert kept_age <= STALE_NS
    assert OVER_NS > STALE_NS


def test_symlink_inside_home_is_not_followed(handoff_temp, tmp_path):
    handoff, private = handoff_temp
    home = private / 'atlas-git-home-killed'
    home.mkdir()
    (home / 'own.txt').write_bytes(b'own')
    nested = home / 'nested'
    nested.mkdir()
    (nested / 'n.txt').write_bytes(b'n')
    precious_file = tmp_path / 'precious.txt'
    precious_file.write_text('file-keep', encoding='ascii')
    precious_dir = tmp_path / 'precious-dir'
    precious_dir.mkdir()
    (precious_dir / 'keep.txt').write_text('dir-keep', encoding='ascii')
    (home / 'file-link').symlink_to(precious_file)
    (home / 'dir-link').symlink_to(precious_dir, target_is_directory=True)
    outside = tmp_path / 'outside-dir'
    outside.mkdir()
    (outside / 'secret.txt').write_text('secret', encoding='ascii')
    link_home = private / 'atlas-git-home-link'
    link_home.symlink_to(outside, target_is_directory=True)
    marker_target = tmp_path / 'marker-target'
    marker_target.write_text('1 1\n', encoding='ascii')
    guarded = private / 'atlas-git-home-guarded'
    guarded.mkdir()
    (guarded / 'payload').write_bytes(b'guarded')
    (guarded / MARKER).symlink_to(marker_target)
    _age_past(home)
    _age_past(guarded)
    handoff._GIT_HOME = None
    handoff.git_environ()
    assert not home.exists()
    assert precious_file.read_text(encoding='ascii') == 'file-keep'
    assert (precious_dir / 'keep.txt').read_text(encoding='ascii') == 'dir-keep'
    assert link_home.is_symlink()
    assert (outside / 'secret.txt').read_text(encoding='ascii') == 'secret'
    assert guarded.is_dir()
    assert (guarded / 'payload').read_bytes() == b'guarded'
    assert marker_target.read_text(encoding='ascii') == '1 1\n'


def test_symlinked_temp_root_is_refused(tmp_path, monkeypatch):
    import scripts.check_handoff as handoff
    real = tmp_path / 'real'
    real.mkdir()
    link = tmp_path / 'linkroot'
    link.symlink_to(real, target_is_directory=True)
    killed = real / 'atlas-git-home-killed'
    killed.mkdir()
    (killed / 'payload').write_bytes(b'orphan')
    _write_owner(killed, _dead_pid(), 1)
    _age_past(killed)
    precious = real / 'precious.txt'
    precious.write_text('keep', encoding='ascii')
    monkeypatch.setattr(handoff.tempfile, 'gettempdir', lambda: str(link))
    previous = handoff._GIT_HOME
    handoff._GIT_HOME = None
    created = None
    try:
        home = handoff.git_environ()['HOME']
        created = handoff._GIT_HOME
        assert killed.is_dir()
        assert (killed / 'payload').read_bytes() == b'orphan'
        assert precious.read_text(encoding='ascii') == 'keep'
        assert link.is_symlink()
        assert os.path.basename(home).startswith('atlas-git-home-')
        assert Path(home) != killed
    finally:
        handoff._GIT_HOME = previous
        if created and created != previous and os.path.isdir(created):
            shutil.rmtree(created, ignore_errors=True)


def test_disk_growth_is_bounded_across_killed_runs(handoff_temp):
    handoff, private = handoff_temp
    payload = b'k' * 4096
    n_killed = 32
    n_young = 4
    dead = _dead_pid()
    for i in range(n_killed):
        home = private / ('atlas-git-home-dead-%02d' % i)
        home.mkdir()
        (home / 'payload').write_bytes(payload)
        _write_owner(home, dead, 1)
        _age_past(home)
    youngs = []
    for i in range(n_young):
        home = private / ('atlas-git-home-young-%d' % i)
        home.mkdir()
        (home / 'payload').write_bytes(payload)
        _write_owner(home, dead, 1)
        youngs.append(home)
    live = private / 'atlas-git-home-live'
    live.mkdir()
    (live / 'payload').write_bytes(payload)
    _write_owner(live, os.getpid(), _self_start())
    _age_past(live)
    active = private / 'atlas-git-home-active'
    active.mkdir()
    handoff._GIT_HOME = str(active)
    assert handoff.git_environ()['HOME'] == str(active)
    for i in range(n_killed):
        assert not (private / ('atlas-git-home-dead-%02d' % i)).exists()
    assert live.is_dir()
    assert (live / 'payload').read_bytes() == payload
    for home in youngs:
        assert home.is_dir()
        assert (home / 'payload').read_bytes() == payload
    assert active.is_dir()
    remaining = _file_bytes(private)
    cap = (n_young + 1) * (len(payload) + 128) + 4096
    assert remaining >= len(payload)
    assert remaining <= cap
    assert remaining < n_killed * len(payload)


def test_transition_table_allows_only_the_lifecycle_edges():
    import scripts.git_home as life
    allowed = {
        ('created', 'in_use'),
        ('created', 'orphaned'),
        ('in_use', 'cleaned'),
        ('in_use', 'orphaned'),
        ('orphaned', 'reaped'),
    }
    names = ('created', 'in_use', 'cleaned', 'orphaned', 'reaped')
    assert set(life.TRANSITIONS) == allowed
    satisfying = dict(owner_live=False, releasing=True, age_ns=life.STALE_NS + 1_000_000)
    for src in names:
        for dst in names:
            if (src, dst) in allowed:
                continue
            with pytest.raises(life.TransitionError):
                life.transition(life.State(src), life.State(dst), **satisfying)
    assert life.transition(life.State.CREATED, life.State.IN_USE, owner_live=True) == life.State.IN_USE
    assert life.transition(life.State.CREATED, life.State.ORPHANED, owner_live=False) == life.State.ORPHANED
    assert life.transition(
        life.State.IN_USE, life.State.CLEANED, releasing=True, owner_live=True,
    ) == life.State.CLEANED
    assert life.transition(life.State.IN_USE, life.State.ORPHANED, owner_live=False) == life.State.ORPHANED
    reaped = life.transition(
        life.State.ORPHANED, life.State.REAPED,
        owner_live=False, age_ns=life.STALE_NS + 1_000_000,
    )
    assert reaped == life.State.REAPED
    with pytest.raises(life.TransitionError):
        life.transition(life.State.ORPHANED, life.State.REAPED, owner_live=False, age_ns=life.STALE_NS)
    with pytest.raises(life.TransitionError):
        life.transition(
            life.State.ORPHANED, life.State.REAPED,
            owner_live=True, age_ns=life.STALE_NS + 1_000_000,
        )
    with pytest.raises(life.TransitionError):
        life.transition(life.State.CREATED, life.State.IN_USE, owner_live=False)
    with pytest.raises(life.TransitionError):
        life.transition(life.State.IN_USE, life.State.CLEANED, releasing=False, owner_live=True)


def test_reap_decision_property(tmp_path):
    import scripts.git_home as life
    ages = (
        0,
        1,
        1_000_000_000,
        life.STALE_NS - 1,
        life.STALE_NS,
        life.STALE_NS + 1_000_000,
        life.STALE_NS + 1_000_000_000,
    )
    for state, age, entry_link, root_link in itertools.product(
        list(life.State), ages, (False, True), (False, True),
    ):
        got = life.reap_decision(
            state=state, age_ns=age,
            entry_is_symlink=entry_link, root_is_symlink=root_link,
        )
        expect = (
            not entry_link
            and not root_link
            and age > life.STALE_NS
            and state in (life.State.CREATED, life.State.ORPHANED)
        )
        assert got is expect, (state.value, age, entry_link, root_link, got)
    root = tmp_path / 'root'
    root.mkdir()
    samples = {
        'atlas-git-home-young': NOW_NS,
        'atlas-git-home-exact': NOW_NS - life.STALE_NS,
        'atlas-git-home-over': NOW_NS - (life.STALE_NS + 1_000_000),
        'atlas-git-home-old': NOW_NS - (life.STALE_NS + 5_000_000_000),
    }
    for name, mtime in samples.items():
        path = root / name
        path.mkdir()
        (path / 'payload').write_bytes(b'p')
        _write_owner(path, _dead_pid(), 1)
        _touch(path, mtime)
    live = root / 'atlas-git-home-alive'
    live.mkdir()
    (live / 'payload').write_bytes(b'p')
    _write_owner(live, os.getpid(), _self_start())
    _touch(live, NOW_NS - (life.STALE_NS + 5_000_000_000))
    life.reap(str(root), now=float(NOW), active=None)
    assert (root / 'atlas-git-home-young').is_dir()
    assert (root / 'atlas-git-home-exact').is_dir()
    assert not (root / 'atlas-git-home-over').exists()
    assert not (root / 'atlas-git-home-old').exists()
    assert live.is_dir()
    assert (live / 'payload').read_bytes() == b'p'


def test_concurrent_reapers_keep_a_live_home(tmp_path):
    import scripts.git_home as life
    root = tmp_path / 'root'
    root.mkdir()
    live = root / 'atlas-git-home-live'
    live.mkdir()
    (live / 'payload').write_bytes(b'live')
    _write_owner(live, os.getpid(), _self_start())
    _age_past(live)
    dead_homes = []
    dead = _dead_pid()
    for i in range(6):
        home = root / ('atlas-git-home-dead-%d' % i)
        home.mkdir()
        (home / 'payload').write_bytes(b'dead')
        _write_owner(home, dead, 1)
        _age_past(home)
        dead_homes.append(home)
    errors = []

    def once():
        try:
            life.reap(str(root), now=time.time(), active=None)
        except Exception as exc:
            errors.append(exc)

    threads = [threading.Thread(target=once) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []
    assert live.is_dir()
    assert (live / 'payload').read_bytes() == b'live'
    for home in dead_homes:
        assert not home.exists()


def test_create_then_release_removes_an_in_use_home():
    import scripts.git_home as life
    path = life.create()
    try:
        assert life.classify(path) == life.State.IN_USE
        text = Path(path, MARKER).read_text(encoding='ascii')
        pid_text, start_text = text.split()
        assert int(pid_text) == os.getpid()
        assert int(start_text) == _self_start()
        assert Path(path).name.startswith('atlas-git-home-')
    finally:
        if os.path.isdir(path) and not os.path.islink(path):
            life.release(path)
    assert not os.path.exists(path)
