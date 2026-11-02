#!/usr/bin/env python3
"""Verify received package hashes and rebuild reproducibility without network access.

Run before edits. Expected digest changes after editing do not mean modifications
are forbidden: issue a new reviewed release manifest for the changed package.
This integrity check is not a cryptographic signature or a security audit.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def safe_relative(value: str) -> bool:
    p = PurePosixPath(value)
    return bool(value) and not p.is_absolute() and '..' not in p.parts and '\\' not in value and ':' not in value


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
                # build.py also imports atlas_voice.quality and bakes the ORIGIN from wrangler.jsonc into the pages, so a source-only rebuild needs both.
                if rel in ('build.py','deploy/cloudflare-edge/wrangler.jsonc') or rel.startswith(('src/','assets/','docs/','atlas_voice/')):
                    target=dest/rel;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/rel,target)
            result=subprocess.run([sys.executable,str(dest/'build.py')],capture_output=True,text=True,timeout=30,check=False)
            check('clean-build',result.returncode==0,'Build executed in a temporary source-only directory.')
            same=result.returncode==0 and all((dest/p).is_file() and (dest/p).read_bytes()==(root/p).read_bytes() for p in aliases)
            check('clean-build-byte-match',same,'Temporary clean source rebuild must match all delivered HTML aliases.')
    return {'passed':all(c['pass'] for c in checks),'offline_only':True,'checks':checks,
            'scope':'Received manifest and clean rebuild; no providers, deployment, digital signature or production-security certification.'}


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--no-rebuild',action='store_true')
    p.add_argument('--json',action='store_true')
    args=p.parse_args(argv)
    try:report=inspect(ROOT,rebuild=not args.no_rebuild)
    except (OSError,ValueError,subprocess.TimeoutExpired):
        report={'passed':False,'checks':[{'name':'verification','pass':False,'detail':'Verification could not complete; inspect local files and build prerequisites.'}]}
    if args.json:print(json.dumps(report,indent=2))
    else:
        for c in report['checks']:print(('PASS' if c['pass'] else 'FAIL')+' '+c['name']+': '+c['detail'])
    return 0 if report['passed'] else 1

if __name__=='__main__':raise SystemExit(main())
