#!/usr/bin/env python3
"""Verify an extracted release package against its own MANIFEST.json.

Pass a directory or a .zip/.tar archive. Listed files must match the recorded
size and SHA-256. The manifest enumerates the package except manifest_excludes
(the received manifest excludes only itself). The same pass checks release
hygiene, required handoff files, identical HTML aliases, the supplied logo,
and a clean source rebuild.

Usage:
  python3 scripts/check_handoff.py path/to/extracted-release
  make verify-package PACKAGE=path/to/extracted-release

Issue a new reviewed manifest when cutting a release package. This integrity
check is not a cryptographic signature or a security audit.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import stat
import tarfile
import zipfile
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tempfile


def safe_relative(value: str) -> bool:
    p = PurePosixPath(value)
    return bool(value) and not p.is_absolute() and '..' not in p.parts and '\\' not in value and ':' not in value


def package_files(root: Path):
    found=[]
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        base=Path(dirpath)
        for name in list(dirnames):
            path=base/name
            if path.is_symlink():
                found.append(path.relative_to(root).as_posix())
                dirnames.remove(name)
        for name in filenames:
            found.append((base/name).relative_to(root).as_posix())
    return found


def inspect(root: Path, *, rebuild=True) -> dict:
    checks=[]
    def check(name, ok, detail):
        checks.append({'name':name,'pass':bool(ok),'detail':detail})
    try:
        manifest=json.loads((root/'MANIFEST.json').read_text(encoding='utf-8'))
    except (OSError,ValueError):
        return {'passed':False,'checks':[{'name':'manifest','pass':False,'detail':'Missing or invalid MANIFEST.json'}]}
    files=manifest.get('files',[])
    check('manifest-entries',isinstance(files,list) and bool(files),'Manifest must enumerate the received release files.')
    if not isinstance(files,list): files=[]
    seen=set();bad=[]
    for row in files:
        if not isinstance(row,dict) or not safe_relative(str(row.get('path',''))):
            bad.append('invalid manifest path');continue
        rel=row['path'];p=root/rel
        if rel in seen:bad.append('duplicate: '+rel);continue
        seen.add(rel)
        if not p.is_file() or p.is_symlink():bad.append('missing or symlink: '+rel);continue
        try:data=p.read_bytes()
        except OSError:bad.append('unreadable: '+rel);continue
        if len(data)!=row.get('bytes') or hashlib.sha256(data).hexdigest()!=row.get('sha256'):
            bad.append('changed: '+rel)
    # The manifest lists every package file except manifest_excludes. The received
    # manifest excludes only itself, so an extracted package with an extra file fails.
    allowed={'MANIFEST.json'}
    excludes=manifest.get('manifest_excludes', ['MANIFEST.json'])
    if isinstance(excludes, list):
        for item in excludes:
            if isinstance(item, str) and safe_relative(item):
                allowed.add(item)
    for rel in sorted(package_files(root)):
        if rel not in seen and rel not in allowed:
            bad.append('unlisted: '+rel)
    check('manifest-content',not bad, '; '.join(bad[:25]) if bad else f'{len(seen)} release files match size and SHA-256.')
    for name in ('00_START_HERE.md','CLAUDE.md','CLAUDE_BUILD_PROMPT.md','handoff/CURRENT_STATUS.md','handoff/BUILD_PLAN.md','handoff/CONFIGURATION.md','handoff/ACCEPTANCE.md','handoff/CODE_MAP.md'):
        check('required:'+name,(root/name).is_file(),'Required source/handoff file.')
    # Only release-manifest files are assessed, not the user's legitimate local .env.
    disallowed=[]
    for rel in seen:
        p=PurePosixPath(rel)
        if p.suffix.lower() in ('.ttf','.otf','.woff','.woff2','.pem','.key','.p12','.pfx','.sqlite','.sqlite3','.db'):
            disallowed.append(rel)
        if p.name=='.env' or (p.name.startswith('.env.') and p.name!='.env.example'):
            disallowed.append(rel)
        if any(x in ('data','vault','knowledge-vault','secrets','credentials','backups','.git','.venv','__pycache__') for x in p.parts):
            disallowed.append(rel)
    check('release-hygiene',not disallowed, '; '.join(disallowed[:20]) if disallowed else 'No known secret/runtime/font paths in the manifest; this is not a full content secret scan.')
    aliases=['ATLAS_Project_Intelligence.html','ATLAS_Intelligence.html','ATLAS_Voice_Studio.html','ATLAS_Voice.html']
    try:
        contents=[(root/p).read_bytes() for p in aliases]
        check('html-aliases',len(set(contents))==1,'Four compatibility aliases must be byte-identical.')
        check('logo',hashlib.sha256((root/'assets/Mantu.svg').read_bytes()).hexdigest()=='92c5ff21779f09199097a2971c172453017f0d2581a0ced6f54fe486ba9b6c2b','Preserve the supplied Mantu asset bytes.')
    except OSError:
        check('html-logo-files',False,'Missing compiled alias or logo.')
    if rebuild and not bad:
        with tempfile.TemporaryDirectory(prefix='atlas-rebuild-') as td:
            dest=Path(td)
            for rel in seen:
                if rel=='build.py' or rel.startswith(('src/','assets/','docs/')):
                    target=dest/rel;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/rel,target)
            result=subprocess.run([sys.executable,str(dest/'build.py')],capture_output=True,text=True,timeout=30,check=False)
            check('clean-build',result.returncode==0,'Build executed in a temporary source-only directory.')
            same=result.returncode==0 and all((dest/p).is_file() and (dest/p).read_bytes()==(root/p).read_bytes() for p in aliases)
            check('clean-build-byte-match',same,'Temporary clean source rebuild must match all delivered HTML aliases.')
    return {'passed':all(c['pass'] for c in checks),'offline_only':True,'checks':checks,
            'scope':'Extracted package manifest and clean rebuild; no providers, deployment, digital signature or production-security certification.'}


def archive_rel(value: str):
    name=value.strip()
    if name.endswith('/'):name=name.rstrip('/')
    if name in ('', '.'):return None
    if not safe_relative(name):
        raise ValueError('Unsafe archive path: '+value)
    return name


def contained(dest: Path, rel: str) -> Path:
    root=dest.resolve()
    target=(dest/rel).resolve()
    if target!=root and root not in target.parents:
        raise ValueError('Unsafe archive path: '+rel)
    return target


def _extract_zip(path: Path, dest: Path) -> None:
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            rel=archive_rel(info.filename)
            if rel is None:continue
            mode=info.external_attr>>16
            if stat.S_ISLNK(mode):
                raise ValueError('Unsafe archive path: '+info.filename)
            target=contained(dest, rel)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True);continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(info))


def _extract_tar(path: Path, dest: Path) -> None:
    with tarfile.open(path) as archive:
        for member in archive.getmembers():
            rel=archive_rel(member.name)
            if rel is None:continue
            if not (member.isdir() or member.isfile()):
                raise ValueError('Unsafe archive path: '+member.name)
            target=contained(dest, rel)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True);continue
            source=archive.extractfile(member)
            if source is None:
                raise ValueError('Unreadable archive member: '+member.name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read())


def extract_archive(path: Path, dest: Path) -> None:
    if zipfile.is_zipfile(path):
        _extract_zip(path, dest);return
    _extract_tar(path, dest)


def manifest_root(dest: Path) -> Path:
    if (dest/'MANIFEST.json').is_file():return dest
    entries=list(dest.iterdir())
    dirs=[p for p in entries if p.is_dir() and not p.is_symlink() and p.name!='__MACOSX']
    files=[p for p in entries if not p.is_dir()]
    if not files and len(dirs)==1 and (dirs[0]/'MANIFEST.json').is_file():
        return dirs[0]
    raise ValueError('Archive has no MANIFEST.json at its root or in one top-level directory.')


def _is_tar(path: Path) -> bool:
    try:return tarfile.is_tarfile(path)
    except (OSError, tarfile.TarError):return False


@contextmanager
def open_package(path: Path):
    if not path.exists():
        raise FileNotFoundError('Package not found: '+str(path))
    if path.is_dir():
        yield path;return
    if zipfile.is_zipfile(path) or _is_tar(path):
        with tempfile.TemporaryDirectory(prefix='atlas-release-') as temporary:
            dest=Path(temporary)
            extract_archive(path, dest)
            yield manifest_root(dest)
        return
    raise ValueError('Package must be a directory or a .zip/.tar archive: '+str(path))


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('package', help='Extracted release directory, or a .zip/.tar archive of one.')
    p.add_argument('--no-rebuild', action='store_true')
    p.add_argument('--json', action='store_true')
    args=p.parse_args(argv)
    try:
        with open_package(Path(args.package)) as root:
            report=inspect(root, rebuild=not args.no_rebuild)
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        report={'passed':False,'checks':[{'name':'verification','pass':False,'detail':str(error)}]}
    if args.json:print(json.dumps(report,indent=2))
    else:
        for c in report['checks']:print(('PASS' if c['pass'] else 'FAIL')+' '+c['name']+': '+c['detail'])
    return 0 if report['passed'] else 1

if __name__=='__main__':raise SystemExit(main())
