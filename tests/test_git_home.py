"""Git-home lifecycle. ATLAS-CHECKHANDOFF-REAPER, state machine S3.

The on-disk owner marker is ``.atlas-owner`` with one line ``pid startticks``.
Age is integer nanoseconds. Exactly 86400 seconds is kept. 86400.001 seconds
is removed. A live pid plus matching /proc start time is never reaped.
"""
import itertools
import os
import shutil
import stat
import subprocess
import sys
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


def _other_live_owner():
    """A different process that stays alive and prints ``pid startticks``."""
    script = (
        'import os, time\n'
        'data = open("/proc/self/stat", "rb").read()\n'
        'ticks = int(data[data.rfind(b")") + 2:].split()[19])\n'
        'print("%d %d" % (os.getpid(), ticks), flush=True)\n'
        'time.sleep(60)\n'
    )
    proc = subprocess.Popen(
        [sys.executable, '-c', script],
        stdout=subprocess.PIPE,
        text=True,
    )
    line = proc.stdout.readline()
    pid_text, ticks_text = line.split()
    return proc, int(pid_text), int(ticks_text)


def test_release_keeps_a_home_owned_by_another_live_pid(tmp_path):
    import scripts.git_home as life
    proc, pid, ticks = _other_live_owner()
    home = tmp_path / 'atlas-git-home-other'
    try:
        assert proc.poll() is None
        assert pid != os.getpid()
        home.mkdir()
        (home / 'payload').write_bytes(b'live-owner')
        _write_owner(home, pid, ticks)
        assert life.classify(str(home)) == life.State.IN_USE
        life.release(str(home))
        assert home.is_dir()
        assert (home / 'payload').read_bytes() == b'live-owner'
        assert (home / MARKER).read_text(encoding='ascii') == '%d %d\n' % (pid, ticks)
        assert life.classify(str(home)) == life.State.IN_USE
    finally:
        proc.kill()
        proc.wait(timeout=5)


def test_release_keeps_a_markerless_directory(tmp_path):
    import scripts.git_home as life
    home = tmp_path / 'atlas-git-home-bare'
    home.mkdir()
    (home / 'payload').write_bytes(b'not-ours')
    assert life.classify(str(home)) == life.State.CREATED
    life.release(str(home))
    assert home.is_dir()
    assert (home / 'payload').read_bytes() == b'not-ours'
    assert not (home / MARKER).exists()


def test_release_keeps_an_orphaned_home(tmp_path):
    import scripts.git_home as life
    home = tmp_path / 'atlas-git-home-orphan'
    home.mkdir()
    (home / 'payload').write_bytes(b'orphan')
    _write_owner(home, _dead_pid(), 1)
    assert life.classify(str(home)) == life.State.ORPHANED
    life.release(str(home))
    assert home.is_dir()
    assert (home / 'payload').read_bytes() == b'orphan'
    assert life.classify(str(home)) == life.State.ORPHANED


def test_release_keeps_a_home_when_start_ticks_differ(tmp_path):
    import scripts.git_home as life
    home = tmp_path / 'atlas-git-home-ticks'
    home.mkdir()
    (home / 'payload').write_bytes(b'reused')
    _write_owner(home, os.getpid(), _self_start() + 1)
    life.release(str(home))
    assert home.is_dir()
    assert (home / 'payload').read_bytes() == b'reused'
    text = (home / MARKER).read_text(encoding='ascii')
    assert int(text.split()[0]) == os.getpid()
    assert int(text.split()[1]) != _self_start()


def test_reap_removes_a_reused_pid_with_different_start_ticks(tmp_path):
    import scripts.git_home as life
    root = tmp_path / 'root'
    root.mkdir()
    home = root / 'atlas-git-home-reused'
    home.mkdir()
    (home / 'payload').write_bytes(b'reused')
    _write_owner(home, os.getpid(), _self_start() + 1)
    _touch(home, NOW_NS - (STALE_NS + 1_000_000))
    assert life.classify(str(home)) == life.State.ORPHANED
    life.reap(str(root), now=float(NOW), active=None)
    assert not home.exists()


def test_cleaned_requires_a_live_owner():
    import scripts.git_home as life
    with pytest.raises(life.TransitionError):
        life.transition(
            life.State.IN_USE, life.State.CLEANED,
            releasing=True, owner_live=False,
        )
    with pytest.raises(life.TransitionError):
        life.transition(
            life.State.IN_USE, life.State.CLEANED,
            releasing=True, owner_live=None,
        )


def test_reap_does_not_delete_a_live_home_swapped_onto_the_name(tmp_path, monkeypatch):
    import scripts.git_home as life
    root = tmp_path / 'root'
    root.mkdir()
    slot = root / 'atlas-git-home-slot'
    slot.mkdir()
    (slot / 'payload').write_bytes(b'orphan')
    _write_owner(slot, _dead_pid(), 1)
    _age_past(slot)
    live = tmp_path / 'live-held'
    live.mkdir()
    (live / 'payload').write_bytes(b'live')
    _write_owner(live, os.getpid(), _self_start())
    aside = tmp_path / 'orphan-aside'
    swapped = {'done': False}
    real_classify = life.classify_fd

    def swap_once(fd):
        state = real_classify(fd)
        if state is life.State.ORPHANED and not swapped['done']:
            swapped['done'] = True
            os.rename(slot, aside)
            os.rename(live, slot)
        return state

    monkeypatch.setattr(life, 'classify_fd', swap_once)
    life.reap(str(root), now=time.time(), active=None)
    assert swapped['done'] is True
    assert slot.is_dir()
    assert (slot / 'payload').read_bytes() == b'live'
    assert life.classify(str(slot)) == life.State.IN_USE
    marker = '%d %d\n' % (os.getpid(), _self_start())
    assert (slot / MARKER).read_text(encoding='ascii') == marker


def test_reap_rechecks_the_marker_on_the_held_directory(tmp_path, monkeypatch):
    import scripts.git_home as life
    root = tmp_path / 'root'
    root.mkdir()
    home = root / 'atlas-git-home-flip'
    home.mkdir()
    (home / 'payload').write_bytes(b'stay')
    _write_owner(home, _dead_pid(), 1)
    _age_past(home)
    flipped = {'done': False}
    real_classify = life.classify_fd
    payload = ('%d %d\n' % (os.getpid(), _self_start())).encode('ascii')

    def flip_once(fd):
        state = real_classify(fd)
        if state is life.State.ORPHANED and not flipped['done']:
            flipped['done'] = True
            os.unlink(MARKER, dir_fd=fd)
            flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW
            marker_fd = os.open(MARKER, flags, 0o600, dir_fd=fd)
            try:
                os.write(marker_fd, payload)
            finally:
                os.close(marker_fd)
        return state

    monkeypatch.setattr(life, 'classify_fd', flip_once)
    life.reap(str(root), now=time.time(), active=None)
    assert flipped['done'] is True
    assert home.is_dir()
    assert (home / 'payload').read_bytes() == b'stay'
    assert (home / MARKER).read_text(encoding='ascii') == payload.decode('ascii')
    assert life.classify(str(home)) == life.State.IN_USE


def test_symlinked_parent_of_the_temp_root_is_refused(tmp_path):
    import scripts.git_home as life
    real_parent = tmp_path / 'real-parent'
    real_parent.mkdir()
    root = real_parent / 'temp'
    root.mkdir()
    orphan = root / 'atlas-git-home-orphan'
    orphan.mkdir()
    (orphan / 'payload').write_bytes(b'far-side')
    _write_owner(orphan, _dead_pid(), 1)
    _age_past(orphan)
    link_parent = tmp_path / 'link-parent'
    link_parent.symlink_to(real_parent, target_is_directory=True)
    via = link_parent / 'temp'
    assert via.is_dir()
    assert not via.is_symlink()
    assert link_parent.is_symlink()
    result = life.reap(str(via), now=time.time(), active=None)
    assert result.refused is True
    assert result.reaped == ()
    assert orphan.is_dir()
    assert (orphan / 'payload').read_bytes() == b'far-side'


def test_young_prefixed_symlink_to_an_old_directory_is_not_followed(tmp_path):
    import scripts.git_home as life
    root = tmp_path / 'root'
    root.mkdir()
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'payload').write_bytes(b'keep')
    _write_owner(outside, _dead_pid(), 1)
    _age_past(outside)
    link = root / 'atlas-git-home-young'
    link.symlink_to(outside, target_is_directory=True)
    assert link.is_symlink()
    assert (time.time_ns() - link.lstat().st_mtime_ns) < life.STALE_NS
    life.reap(str(root), now=time.time(), active=None)
    assert link.is_symlink()
    assert outside.is_dir()
    assert (outside / 'payload').read_bytes() == b'keep'
    assert (outside / MARKER).is_file()


def _files_before_dirs(real_listdir):
    def ordered(path):
        names = list(real_listdir(path))

        def rank(name):
            try:
                if isinstance(path, int):
                    st = os.stat(name, dir_fd=path, follow_symlinks=False)
                else:
                    st = os.lstat(os.path.join(os.fspath(path), name))
            except OSError:
                return (2, name)
            if stat.S_ISREG(st.st_mode):
                return (0, name)
            if stat.S_ISDIR(st.st_mode):
                return (1, name)
            return (2, name)

        return sorted(names, key=rank)

    return ordered


def test_mode000_child_keeps_its_age_and_the_pass_continues(tmp_path, monkeypatch):
    import scripts.git_home as life
    root = tmp_path / 'root'
    root.mkdir()
    blocked = root / 'atlas-git-home-a-blocked'
    blocked.mkdir()
    (blocked / 'payload').write_bytes(b'keep')
    locked = blocked / 'locked'
    locked.mkdir()
    (locked / 'secret').write_bytes(b'secret')
    _write_owner(blocked, _dead_pid(), 1)
    other = root / 'atlas-git-home-b-other'
    other.mkdir()
    (other / 'payload').write_bytes(b'other')
    _write_owner(other, _dead_pid(), 1)
    original = NOW_NS - (STALE_NS + 5_000_000_000)
    _touch(blocked, original)
    _touch(other, original)
    locked.chmod(0)
    monkeypatch.setattr(os, 'listdir', _files_before_dirs(os.listdir))
    try:
        life.reap(str(root), now=float(NOW), active=None)
        assert not other.exists()
        assert blocked.is_dir()
        assert (blocked / 'payload').read_bytes() == b'keep'
        assert locked.is_dir()
        age = NOW_NS - os.lstat(blocked).st_mtime_ns
        assert age > STALE_NS
        assert os.lstat(blocked).st_mtime_ns == original
    finally:
        try:
            locked.chmod(0o700)
        except OSError:
            pass


def test_one_thousand_nanoseconds_past_the_boundary_is_removed(tmp_path):
    import scripts.git_home as life
    root = tmp_path / 'root'
    root.mkdir()
    slack = root / 'atlas-git-home-slack'
    one = root / 'atlas-git-home-one'
    exact = root / 'atlas-git-home-exact'
    for path in (slack, one, exact):
        path.mkdir()
        (path / 'payload').write_bytes(b'p')
        _write_owner(path, _dead_pid(), 1)
    _touch(exact, NOW_NS - STALE_NS)
    _touch(one, NOW_NS - (STALE_NS + 1))
    _touch(slack, NOW_NS - (STALE_NS + 1000))
    life.reap(str(root), now=float(NOW), active=None)
    assert exact.is_dir()
    assert (exact / 'payload').read_bytes() == b'p'
    assert not one.exists()
    assert not slack.exists()


def test_sweep_clock_is_integer_nanoseconds(handoff_temp, monkeypatch):
    import scripts.git_home as life
    handoff, private = handoff_temp
    true_now = 1795215759681969262
    mtime = true_now - life.STALE_NS - 1
    buggy = int(round(float(true_now / 1_000_000_000) * 1_000_000_000))
    assert true_now - mtime > life.STALE_NS
    assert buggy - mtime <= life.STALE_NS
    home = private / 'atlas-git-home-ns'
    home.mkdir()
    (home / 'payload').write_bytes(b'ns')
    _write_owner(home, _dead_pid(), 1)
    _touch(home, mtime)
    monkeypatch.setattr(time, 'time_ns', lambda: true_now)
    monkeypatch.setattr(time, 'time', lambda: true_now / 1_000_000_000)
    handoff._GIT_HOME = None
    handoff._sweep_stale_git_homes()
    assert not home.exists()
