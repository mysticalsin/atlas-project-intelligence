#!/usr/bin/env python3
"""Verify an extracted release package against its own MANIFEST.json.

Pass a directory or a .zip/.tar archive. Listed files must match the recorded
size and SHA-256. The manifest enumerates the package except exact paths in
``manifest_excludes`` (the received manifest excludes only itself in packages).
Dev checkouts must pass ``--dev-git-index`` to enumerate git-tracked paths.
Received packages are always verified by filesystem walk (package mode).

Usage:
  python3 scripts/check_handoff.py path/to/extracted-release
  python3 scripts/check_handoff.py . --dev-git-index
  make verify-package PACKAGE=path/to/extracted-release

Issue a new reviewed manifest when cutting a release package. This integrity
check is not a cryptographic signature or a security audit.

Dev-mode git copies PATH from the caller and passes no other caller variable.
A package rebuild runs build.py with seven names: PATH, a fresh HOME, LANG,
LC_ALL, PYTHONHASHSEED, PYTHONNOUSERSITE, and PYTHONDONTWRITEBYTECODE.
Inspection failures exit 1. argparse usage errors exit 2.

A git metadata component is one shared check. ASCII components are casefolded
and trailing dots and spaces are stripped. Any non-ASCII component is refused
with ``refused: non-ASCII path component``. A short name ``git~<digits>`` with
an optional suffix (``GIT~1.DIR``) is refused. Checkout detection is the exact
top-level name ``.git`` only. A git failure on that path exits cleanly with
``dev-git-index requires a git checkout`` (1 on the check, 2 on
``--write-manifest``). Owner decisions, 2026-11-20, Atlas.

A later run removes real ``atlas-git-home-*`` directories in the temp
directory that are older than 86400 seconds. SIGKILL still leaves the
current process's directory until that age. Symlinks are not removed.
"""
from __future__ import annotations
import atexit
import argparse
import hashlib
import json
import os
import re
import stat
import tarfile
import zipfile
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tempfile
import time


def safe_relative(value: str) -> bool:
    p = PurePosixPath(value)
    return bool(value) and not p.is_absolute() and '..' not in p.parts and '\\' not in value and ':' not in value


_ADS_SUFFIX = '::$index_allocation'
_GIT_SHORT = re.compile(r'^git~[0-9]+(\..*)?$')


def _strip_ads(part: str) -> str:
    text = part
    while text.casefold().endswith(_ADS_SUFFIX):
        text = text[:-len(_ADS_SUFFIX)]
    return text


def _normalize_component(part: str) -> str:
    """Casefold an ASCII component and strip trailing dots and spaces."""
    text = _strip_ads(part)
    text = text.casefold()
    while text.endswith('.') or text.endswith(' '):
        text = text[:-1]
    return text


def path_has_non_ascii(rel: str) -> bool:
    return any(any(ord(ch) > 127 for ch in part) for part in _path_components(rel))


class UnreadableDirectory(OSError):
    """A directory could not be listed. The check must not pass."""

    def __init__(self, rel: str):
        self.rel = rel
        super().__init__('unreadable: ' + rel)


def _walk_error_rel(root: Path, err: OSError) -> str:
    filename = getattr(err, 'filename', None)
    if not filename:
        return '.'
    try:
        rel = Path(os.fsdecode(filename)).relative_to(Path(root)).as_posix()
    except ValueError:
        return '.'
    return rel or '.'


def _walk(root: Path, errors: list[str]):
    """Walk root without following links. Record a directory that cannot be listed."""

    def onerror(err: OSError) -> None:
        rel = _walk_error_rel(root, err)
        if rel not in errors:
            errors.append(rel)

    return os.walk(root, followlinks=False, onerror=onerror)


def non_ascii_paths(root: Path, errors: list[str] | None = None) -> list[str]:
    """Every file or directory under root with a non-ASCII component."""
    found = []
    unread: list[str] = [] if errors is None else errors
    for dirpath, dirnames, filenames in _walk(root, unread):
        base = Path(dirpath)
        rel_base = base.relative_to(root).as_posix()
        if rel_base == '.':
            rel_base = ''
        for name in list(dirnames):
            rel = name if not rel_base else rel_base + '/' + name
            path = base / name
            if path_has_non_ascii(rel):
                found.append(rel)
            if path.is_symlink():
                dirnames.remove(name)
        for name in filenames:
            rel = name if not rel_base else rel_base + '/' + name
            if path_has_non_ascii(rel):
                found.append(rel)
    if errors is None and unread:
        raise UnreadableDirectory(unread[0])
    return found


def _refuse_non_ascii(bad: list[str], rel: str, seen: set[str]) -> bool:
    if not path_has_non_ascii(rel):
        return False
    for msg in ('refused: non-ASCII path component: ' + rel, 'refused: ' + rel):
        if msg not in seen:
            bad.append(msg)
            seen.add(msg)
    return True


def is_git_metadata_component(part: str) -> bool:
    """True when one path component is git metadata after normalization."""
    if part in ('', '.', '..'):
        return False
    normalized = _normalize_component(part)
    if normalized == '.git':
        return True
    return _GIT_SHORT.fullmatch(normalized) is not None


def _path_components(rel: str) -> tuple[str, ...]:
    text = rel.replace('\\', '/')
    return tuple(part for part in PurePosixPath(text).parts if part not in ('', '.'))


def is_git_metadata_path(rel: str) -> bool:
    """True when any component is git metadata.

    Windows and macOS fold ``.GIT`` onto the git metadata name. A component
    that only contains those letters (``.gitignore``, ``.github``,
    ``something.git``, ``.git.bak``) is not metadata. Backslash spellings
    and ``::$INDEX_ALLOCATION`` names are metadata.
    """
    return any(is_git_metadata_component(part) for part in _path_components(rel))


class CheckoutRequired(Exception):
    """Git could not read an exact top-level checkout."""


def _exit_checkout_required() -> None:
    """Exit 2. The message is on stdout so a caught SystemExit stays visible."""
    print('dev-git-index requires a git checkout')
    raise SystemExit(2)


def _is_checkout_metadata(rel: str) -> bool:
    """The checkout's own top-level directory, the exact name ``.git`` only."""
    parts = _path_components(rel)
    return bool(parts) and parts[0] == '.git'


def is_dev_tree(root: Path) -> bool:
    """True only when top-level ``.git`` is a real directory and ``HEAD`` is a regular file.

    A symlink ``.git`` is not a checkout. Neither path is followed.
    """
    git = root / '.git'
    head = git / 'HEAD'
    try:
        git_mode = os.lstat(git).st_mode
        if stat.S_ISLNK(git_mode) or not stat.S_ISDIR(git_mode):
            return False
        head_mode = os.lstat(head).st_mode
    except OSError:
        return False
    return stat.S_ISREG(head_mode)


_GIT_HOME: str | None = None
_GIT_HOME_CLEANUP = False


def _remove_shared_git_home() -> None:
    home = _GIT_HOME
    if home and os.path.isdir(home):
        shutil.rmtree(home, ignore_errors=True)


_STALE_GIT_HOME_SECONDS = 86400
_GIT_HOME_PREFIX = 'atlas-git-home-'


def _sweep_stale_git_homes(now: float | None = None) -> None:
    """Remove real atlas-git-home directories older than the sweep window.

    Symlinks are left alone. This process's active home is left alone.
    SIGKILL still leaves the active directory until a later run sees it
    older than ``_STALE_GIT_HOME_SECONDS``.
    """
    current = time.time() if now is None else now
    try:
        temp_dir = tempfile.gettempdir()
        names = os.listdir(temp_dir)
    except OSError:
        return
    active = _GIT_HOME
    active_key = os.path.normcase(os.path.abspath(active)) if active else None
    for name in names:
        if not name.startswith(_GIT_HOME_PREFIX):
            continue
        path = os.path.join(temp_dir, name)
        if active_key and os.path.normcase(os.path.abspath(path)) == active_key:
            continue
        try:
            st = os.lstat(path)
        except OSError:
            continue
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
            continue
        if current - st.st_mtime <= _STALE_GIT_HOME_SECONDS:
            continue
        shutil.rmtree(path, ignore_errors=True)


def _shared_git_home() -> str:
    global _GIT_HOME, _GIT_HOME_CLEANUP
    if not _GIT_HOME_CLEANUP:
        atexit.register(_remove_shared_git_home)
        _GIT_HOME_CLEANUP = True
    _sweep_stale_git_homes()
    if _GIT_HOME is None or not os.path.isdir(_GIT_HOME):
        _GIT_HOME = tempfile.mkdtemp(prefix=_GIT_HOME_PREFIX)
    return _GIT_HOME


def git_environ() -> dict[str, str]:
    """Environment for every git subprocess.

    PATH is copied from the caller, or ``/usr/bin:/bin`` when the caller
    has no PATH, so the operator's git is the binary that runs. The
    package cannot choose it. HOME is one empty directory for this
    process and is removed at exit. A home left by a killed process is
    removed on a later run once it is older than 86400 seconds.
    """
    return {
        'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
        'HOME': _shared_git_home(),
        'LANG': 'C',
        'LC_ALL': 'C',
        'GIT_CONFIG_NOSYSTEM': '1',
        'GIT_CONFIG_GLOBAL': '/dev/null',
        'GIT_TERMINAL_PROMPT': '0',
    }


def rebuild_environ(home: str) -> dict[str, str]:
    """Seven names for one package rebuild. PATH is the caller's.

    HOME is an empty directory removed by the caller. build.py does not
    see ATLAS_HOME_URL or any other caller variable. LD_PRELOAD and
    LD_LIBRARY_PATH are omitted.
    """
    return {
        'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
        'HOME': home,
        'LANG': 'C.utf8',
        'LC_ALL': 'C.utf8',
        'PYTHONHASHSEED': '0',
        'PYTHONNOUSERSITE': '1',
        'PYTHONDONTWRITEBYTECODE': '1',
    }


def resolve_in_package(root: Path, rel: str) -> Path:
    root_res = root.resolve()
    target = (root / rel).resolve()
    if target != root_res and root_res not in target.parents:
        raise ValueError('Outside package root: ' + rel)
    return target


def symlink_in_package_path(root: Path, rel: str) -> bool:
    """True when any path component under root is a symlink (lstat; does not follow)."""
    if not safe_relative(rel):
        return True
    cur = root
    for part in PurePosixPath(rel).parts:
        cur = cur / part
        try:
            st = os.lstat(cur)
        except OSError:
            return False
        if stat.S_ISLNK(st.st_mode):
            return True
    return False


def read_package_bytes(root: Path, rel: str) -> bytes:
    if symlink_in_package_path(root, rel):
        raise ValueError('symlink in package path: ' + rel)
    target = resolve_in_package(root, rel)
    if not target.is_file():
        raise OSError('not a regular file: ' + rel)
    return target.read_bytes()


def package_files(root: Path, errors: list[str] | None = None) -> list[str]:
    """Files, symlink directories, and git-metadata directories. Do not follow links."""
    found = []
    unread: list[str] = [] if errors is None else errors
    for dirpath, dirnames, filenames in _walk(root, unread):
        base = Path(dirpath)
        rel_base = base.relative_to(root).as_posix()
        if rel_base == '.':
            rel_base = ''
        for name in dirnames:
            path = base / name
            rel = name if not rel_base else rel_base + '/' + name
            if path.is_symlink() or is_git_metadata_component(name):
                found.append(rel)
        for name in filenames:
            rel = name if not rel_base else rel_base + '/' + name
            found.append(rel)
    if errors is None and unread:
        raise UnreadableDirectory(unread[0])
    return found


def nested_git_metadata_paths(root: Path, errors: list[str] | None = None) -> list[str]:
    """Git metadata under the checkout, not the checkout's own top-level git dir."""
    found = []
    unread: list[str] = [] if errors is None else errors
    for dirpath, dirnames, filenames in _walk(root, unread):
        base = Path(dirpath)
        rel_base = base.relative_to(root).as_posix()
        if rel_base == '.':
            rel_base = ''
        for name in list(dirnames):
            rel = name if not rel_base else rel_base + '/' + name
            if _is_checkout_metadata(rel):
                dirnames.remove(name)
                continue
            path = base / name
            if path.is_symlink():
                if is_git_metadata_path(rel):
                    found.append(rel)
                dirnames.remove(name)
                continue
            if is_git_metadata_component(name):
                found.append(rel)
        for name in filenames:
            rel = name if not rel_base else rel_base + '/' + name
            if is_git_metadata_path(rel) and not _is_checkout_metadata(rel):
                found.append(rel)
    if errors is None and unread:
        raise UnreadableDirectory(unread[0])
    return found


def manifest_allows_path(rel: str, excludes: list, *, package_mode: bool) -> bool:
    if not isinstance(excludes, list):
        return False
    for item in excludes:
        if not isinstance(item, str) or not safe_relative(item):
            continue
        if item.endswith('/'):
            if package_mode:
                continue
            bare = item.rstrip('/')
            if rel == bare or rel.startswith(item) or ('/' + bare + '/') in ('/' + rel):
                return True
        elif rel == item:
            return True
    return False


_REBUILD_SOURCE_PREFIXES = ('src/', 'assets/', 'docs/', 'atlas_voice/', 'deploy/cloudflare-edge/')


def include_in_clean_rebuild(rel: str) -> bool:
    return rel == 'build.py' or rel.startswith(_REBUILD_SOURCE_PREFIXES)


_GIT_INVOCATION = (
    'git',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    '--no-optional-locks',
)


def _git_z_lines(root: Path, *extra: str) -> list[str]:
    prefix = list(_GIT_INVOCATION) + ['-C', str(root)] + list(extra)
    try:
        raw = subprocess.check_output(prefix, stderr=subprocess.DEVNULL, env=git_environ())
    except (OSError, subprocess.CalledProcessError) as error:
        raise CheckoutRequired('dev-git-index requires a git checkout') from error
    return [line for line in raw.decode('utf-8', 'surrogateescape').split('\0') if line]


def git_index_file_list(root: Path) -> tuple[list[str], list[str]]:
    tracked = sorted(
        line for line in _git_z_lines(root, 'ls-files', '-z')
        if line and line != 'MANIFEST.json' and safe_relative(line))
    untracked = sorted(
        line for line in _git_z_lines(root, 'ls-files', '-o', '--exclude-standard', '-z')
        if line and safe_relative(line))
    return tracked, untracked


def release_file_list(root: Path, *, dev_git_index: bool = False) -> list[str]:
    if dev_git_index:
        tracked, _ = git_index_file_list(root)
        return tracked
    return sorted(rel for rel in package_files(root) if rel != 'MANIFEST.json')


def write_manifest(root: Path, *, dev_git_index: bool = False) -> int:
    path = root / 'MANIFEST.json'
    meta = json.loads(path.read_text(encoding='utf-8'))
    rows = []
    for rel in release_file_list(root, dev_git_index=dev_git_index):
        data = read_package_bytes(root, rel)
        rows.append({'path': rel, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    meta['files'] = rows
    path.write_text(json.dumps(meta, indent=2) + '\n', encoding='utf-8')
    return len(rows)


def inspect(root: Path, *, rebuild=True, dev_git_index: bool = False) -> dict:
    package_mode = not dev_git_index
    checks = []
    def check(name, ok, detail):
        checks.append({'name': name, 'pass': bool(ok), 'detail': detail})
    try:
        manifest = json.loads((root / 'MANIFEST.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {'passed': False, 'checks': [{'name': 'manifest', 'pass': False, 'detail': 'Missing or invalid MANIFEST.json'}]}
    files = manifest.get('files', [])
    check('manifest-entries', isinstance(files, list) and bool(files), 'Manifest must enumerate the received release files.')
    if not isinstance(files, list):
        files = []
    seen = set()
    bad = []
    for row in files:
        if not isinstance(row, dict) or not safe_relative(str(row.get('path', ''))):
            bad.append('invalid manifest path')
            continue
        rel = row['path']
        if rel in seen:
            bad.append('duplicate: ' + rel)
            continue
        seen.add(rel)
        if symlink_in_package_path(root, rel):
            bad.append('missing or symlink: ' + rel)
            continue
        try:
            data = read_package_bytes(root, rel)
        except ValueError:
            bad.append('outside package root: ' + rel)
            continue
        except OSError:
            bad.append('missing or symlink: ' + rel)
            continue
        if len(data) != row.get('bytes') or hashlib.sha256(data).hexdigest() != row.get('sha256'):
            bad.append('changed: ' + rel)
    excludes = manifest.get('manifest_excludes', ['MANIFEST.json'])
    allowed = {'MANIFEST.json'}
    if isinstance(excludes, list):
        for item in excludes:
            if isinstance(item, str) and safe_relative(item) and not item.endswith('/'):
                allowed.add(item)
    walk_errors: list[str] = []
    if dev_git_index:
        if not is_dev_tree(root):
            bad.append('dev-git-index requires a git checkout')
            present = []
        else:
            try:
                tracked, untracked_dev = git_index_file_list(root)
            except CheckoutRequired:
                bad.append('dev-git-index requires a git checkout')
                present = []
            else:
                present = tracked
                for rel in untracked_dev:
                    if rel not in allowed and not manifest_allows_path(rel, excludes, package_mode=False):
                        bad.append('untracked: ' + rel)
                for rel in nested_git_metadata_paths(root, walk_errors):
                    bad.append('refused: ' + rel)
    else:
        present = package_files(root, walk_errors)
    non_ascii_seen: set[str] = set()
    for rel in non_ascii_paths(root, walk_errors):
        _refuse_non_ascii(bad, rel, non_ascii_seen)
    for rel in walk_errors:
        bad.append('unreadable: ' + rel)
    for rel in sorted(present):
        try:
            resolve_in_package(root, rel)
        except ValueError:
            bad.append('outside package root: ' + rel)
            continue
        if _refuse_non_ascii(bad, rel, non_ascii_seen):
            continue
        if is_git_metadata_path(rel) and not (dev_git_index and _is_checkout_metadata(rel)):
            bad.append('refused: ' + rel)
            continue
        if rel in seen or rel in allowed or manifest_allows_path(rel, excludes, package_mode=package_mode):
            continue
        bad.append('unlisted: ' + rel)
    if bad:
        def _bad_key(item: str) -> tuple[int, str]:
            if item.startswith('unlisted:'):
                return (0, item)
            if item.startswith('refused:'):
                return (2, item)
            return (1, item)
        detail_bad = '; '.join(sorted(bad, key=_bad_key)[:25])
    else:
        detail_bad = f'{len(seen)} release files match size and SHA-256.'
    check('manifest-content', not bad, detail_bad)
    for name in ('00_START_HERE.md', 'CLAUDE.md', 'CLAUDE_BUILD_PROMPT.md', 'handoff/CURRENT_STATUS.md', 'handoff/BUILD_PLAN.md', 'handoff/CONFIGURATION.md', 'handoff/ACCEPTANCE.md', 'handoff/CODE_MAP.md'):
        check('required:' + name, (root / name).is_file(), 'Required source/handoff file.')
    disallowed = []
    for rel in seen:
        p = PurePosixPath(rel)
        if p.suffix.lower() in ('.ttf', '.otf', '.woff', '.woff2', '.pem', '.key', '.p12', '.pfx', '.sqlite', '.sqlite3', '.db'):
            disallowed.append(rel)
        if p.name == '.env' or (p.name.startswith('.env.') and p.name != '.env.example'):
            disallowed.append(rel)
        if any(is_git_metadata_component(x) or x in ('data', 'vault', 'knowledge-vault', 'secrets', 'credentials', 'backups', '.venv', '__pycache__') for x in p.parts):
            disallowed.append(rel)
    check('release-hygiene', not disallowed, '; '.join(disallowed[:20]) if disallowed else 'No known secret/runtime/font paths in the manifest; this is not a full content secret scan.')
    aliases = ['ATLAS_Project_Intelligence.html', 'ATLAS_Intelligence.html', 'ATLAS_Voice_Studio.html', 'ATLAS_Voice.html']
    try:
        contents = []
        for name in aliases:
            if symlink_in_package_path(root, name):
                check('html-logo-files', False, 'missing or symlink: ' + name)
                break
            try:
                contents.append(read_package_bytes(root, name))
            except (ValueError, OSError):
                check('html-logo-files', False, 'missing or symlink: ' + name)
                break
        else:
            check('html-aliases', len(set(contents)) == 1, 'Four compatibility aliases must be byte-identical.')
            try:
                logo = read_package_bytes(root, 'assets/Mantu.svg')
            except (ValueError, OSError):
                check('logo', False, 'outside package root: assets/Mantu.svg')
            else:
                check('logo', hashlib.sha256(logo).hexdigest() == '92c5ff21779f09199097a2971c172453017f0d2581a0ced6f54fe486ba9b6c2b', 'Preserve the supplied Mantu asset bytes.')
    except OSError:
        check('html-logo-files', False, 'Missing compiled alias or logo.')
    if rebuild and not bad:
        with tempfile.TemporaryDirectory(prefix='atlas-rebuild-') as td:
            dest = Path(td)
            for rel in seen:
                if include_in_clean_rebuild(rel):
                    target = dest / rel
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if symlink_in_package_path(root, rel):
                        continue
                    shutil.copy2(resolve_in_package(root, rel), target)
            with tempfile.TemporaryDirectory(prefix='atlas-rebuild-home-') as home:
                result = subprocess.run(
                    [sys.executable, str(dest / 'build.py')],
                    capture_output=True, text=True, timeout=30, check=False,
                    env=rebuild_environ(home),
                )
            check('clean-build', result.returncode == 0, 'Build executed in a temporary source-only directory.')
            same = result.returncode == 0 and all(
                (dest / p).is_file() and (dest / p).read_bytes() == read_package_bytes(root, p) for p in aliases)
            check('clean-build-byte-match', same, 'Temporary clean source rebuild must match all delivered HTML aliases.')
    return {'passed': all(c['pass'] for c in checks), 'offline_only': True, 'checks': checks,
            'scope': 'Extracted package manifest and clean rebuild; no providers, deployment, digital signature or production-security certification.'}


def archive_rel(value: str):
    name = value.strip()
    if name.endswith('/'):
        name = name.rstrip('/')
    if name in ('', '.'):
        return None
    if not safe_relative(name):
        raise ValueError('Unsafe archive path: ' + value)
    return name


def contained(dest: Path, rel: str) -> Path:
    root = dest.resolve()
    target = (dest / rel).resolve()
    if target != root and root not in target.parents:
        raise ValueError('Unsafe archive path: ' + rel)
    return target


def _extract_zip(path: Path, dest: Path) -> None:
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            rel = archive_rel(info.filename)
            if rel is None:
                continue
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise ValueError('Unsafe archive path: ' + info.filename)
            target = contained(dest, rel)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(info))


def _extract_tar(path: Path, dest: Path) -> None:
    with tarfile.open(path) as archive:
        for member in archive.getmembers():
            rel = archive_rel(member.name)
            if rel is None:
                continue
            if not (member.isdir() or member.isfile()):
                raise ValueError('Unsafe archive path: ' + member.name)
            target = contained(dest, rel)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            source = archive.extractfile(member)
            if source is None:
                raise ValueError('Unreadable archive member: ' + member.name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read())


def extract_archive(path: Path, dest: Path) -> None:
    if zipfile.is_zipfile(path):
        _extract_zip(path, dest)
        return
    _extract_tar(path, dest)


def manifest_root(dest: Path) -> Path:
    if (dest / 'MANIFEST.json').is_file():
        return dest
    entries = list(dest.iterdir())
    dirs = [p for p in entries if p.is_dir() and not p.is_symlink() and p.name != '__MACOSX']
    files = [p for p in entries if not p.is_dir()]
    if not files and len(dirs) == 1 and (dirs[0] / 'MANIFEST.json').is_file():
        return dirs[0]
    raise ValueError('Archive has no MANIFEST.json at its root or in one top-level directory.')


def _is_tar(path: Path) -> bool:
    try:
        return tarfile.is_tarfile(path)
    except (OSError, tarfile.TarError):
        return False


@contextmanager
def open_package(path: Path):
    if not path.exists():
        raise FileNotFoundError('Package not found: ' + str(path))
    if path.is_dir():
        yield path
        return
    if zipfile.is_zipfile(path) or _is_tar(path):
        with tempfile.TemporaryDirectory(prefix='atlas-release-') as temporary:
            dest = Path(temporary)
            extract_archive(path, dest)
            yield manifest_root(dest)
        return
    raise ValueError('Package must be a directory or a .zip/.tar archive: ' + str(path))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('package', help='Extracted release directory, or a .zip/.tar archive of one.', nargs='?')
    p.add_argument('--no-rebuild', action='store_true')
    p.add_argument('--dev-git-index', action='store_true',
                   help='Dev checkout only: enumerate tracked git paths and reject untracked non-ignored files.')
    p.add_argument('--json', action='store_true')
    p.add_argument('--write-manifest', action='store_true',
                   help='Refresh MANIFEST.json hashes from the tree (requires --dev-git-index on a git checkout).')
    args = p.parse_args(argv)
    if args.write_manifest:
        if not args.package:
            p.error('PACKAGE path is required with --write-manifest')
        if not args.dev_git_index:
            p.error('--write-manifest requires --dev-git-index')
        root = Path(args.package)
        if not (root / 'MANIFEST.json').is_file():
            p.error('MANIFEST.json is missing in ' + str(root))
        if not is_dev_tree(root):
            _exit_checkout_required()
        unread: list[str] = []
        blocked = non_ascii_paths(root, unread)
        if unread:
            for rel in unread:
                print('FAIL manifest-content: unreadable: ' + rel)
            return 1
        if blocked:
            for rel in blocked:
                print('FAIL manifest-content: refused: non-ASCII path component: ' + rel)
            return 1
        try:
            count = write_manifest(root, dev_git_index=True)
        except CheckoutRequired:
            _exit_checkout_required()
        print(f'Wrote {count} file entries to MANIFEST.json')
        return 0
    if not args.package:
        p.error('PACKAGE path is required')
    try:
        with open_package(Path(args.package)) as root:
            report = inspect(root, rebuild=not args.no_rebuild, dev_git_index=bool(args.dev_git_index))
    except (OSError, ValueError, subprocess.TimeoutExpired, subprocess.CalledProcessError) as error:
        report = {'passed': False, 'checks': [{'name': 'verification', 'pass': False, 'detail': str(error)}]}
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        for c in report['checks']:
            print(('PASS' if c['pass'] else 'FAIL') + ' ' + c['name'] + ': ' + c['detail'])
    return 0 if report['passed'] else 1

if __name__ == '__main__':
    raise SystemExit(main())