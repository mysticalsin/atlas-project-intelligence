"""Offline handoff utilities: no provider calls and no real credentials."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import zipfile
import pytest
from scripts.doctor import read_literal_env, probe, environment, main as doctor_main
from scripts.check_handoff import safe_relative, inspect, main


def test_env_reads_literals_without_execution(tmp_path):
    p=tmp_path/'env'
    p.write_text("# note\nATLAS_PORT=8080\nexport OPENAI_API_KEY='fake-$literal-key'\nEMPTY=\nNAME='value with spaces' # note\n")
    assert read_literal_env(p)=={'ATLAS_PORT':'8080','OPENAI_API_KEY':'fake-$literal-key','EMPTY':'','NAME':'value with spaces'}

@pytest.mark.parametrize('line',[
    'KEY=$(touch /tmp/atlas-should-not-exist)', 'KEY=${HOME}', 'KEY=`whoami`',
    'not assignment', 'KEY=two unquoted values', 'KEY="unterminated',
])
def test_env_rejects_ambiguous_shell_without_leaking_value(tmp_path,line):
    p=tmp_path/'env';p.write_text(line)
    with pytest.raises(ValueError) as error:read_literal_env(p)
    assert line not in str(error.value)


def test_env_missing_and_oversize(tmp_path):
    with pytest.raises(ValueError):read_literal_env(tmp_path/'absent')
    p=tmp_path/'big';p.write_text('A='+'a'*65537)
    with pytest.raises(ValueError):read_literal_env(p)


def test_environment_is_restored(monkeypatch):
    import os
    monkeypatch.setenv('ATLAS_TEST_SENTINEL','before')
    with environment({'ATLAS_TEST_SENTINEL':'during'}):assert os.environ['ATLAS_TEST_SENTINEL']=='during'
    assert os.environ['ATLAS_TEST_SENTINEL']=='before'


def test_hosted_missing_key_fails_without_network():
    r=probe('hosted',{'ATLAS_VOICE_PROVIDER':'openai'})
    assert not r['ready_for_local_prerequisites']
    assert r['live_verified'] is False
    assert any(c['name']=='hosted-key' and c['status']=='fail' for c in r['checks'])


def test_fake_configured_key_never_echoes(monkeypatch):
    import scripts.doctor as d
    monkeypatch.setattr(d,'available',lambda module:True)
    secret='fake-unit-test-secret-never-display'
    r=probe('hosted',{'ATLAS_VOICE_PROVIDER':'openai','OPENAI_API_KEY':secret})
    assert r['ready_for_local_prerequisites']
    assert secret not in json.dumps(r)
    assert not r['live_verified']


def test_shared_needs_real_identity_config():
    r=probe('shared',{'ATLAS_VOICE_PROVIDER':'openai','OPENAI_API_KEY':'fake'})
    assert not r['ready_for_local_prerequisites']
    assert any(c['name']=='entra-mode' and c['status']=='fail' for c in r['checks'])


def test_malformed_numeric_config_is_redacted():
    r=probe('hosted',{'ATLAS_VOICE_PROVIDER':'openai','ATLAS_PORT':'fake-secret-bad-port'})
    assert 'fake-secret-bad-port' not in json.dumps(r)
    assert not r['ready_for_local_prerequisites']


def test_cli_json_missing_env_redacts_path(tmp_path,capsys):
    assert doctor_main(['--env-file',str(tmp_path/'secret-name'), '--json'])==1
    result=capsys.readouterr().out
    assert 'secret-name' not in result
    assert json.loads(result)['offline_only']

@pytest.mark.parametrize('path',['../secret','/absolute','a/../../x','C:\\secret','a\\b','', 'C:/secret'])
def test_manifest_paths_reject_escape(path):assert not safe_relative(path)

@pytest.mark.parametrize('path',['CLAUDE.md','src/app.js','handoff/CONFIGURATION.md','.env.example'])
def test_manifest_relative_paths(path):assert safe_relative(path)


def test_invalid_manifest_reports_failure(tmp_path):
    assert not inspect(tmp_path,rebuild=False)['passed']
    (tmp_path/'MANIFEST.json').write_text('{}')
    assert not inspect(tmp_path,rebuild=False)['passed']


def test_tampered_file_and_font_detected(tmp_path):
    (tmp_path/'x.txt').write_text('changed')
    (tmp_path/'bad.woff2').write_bytes(b'not-a-font')
    m={'files':[{'path':'x.txt','bytes':3,'sha256':hashlib.sha256(b'old').hexdigest()},
                {'path':'bad.woff2','bytes':10,'sha256':hashlib.sha256(b'not-a-font').hexdigest()}]}
    (tmp_path/'MANIFEST.json').write_text(json.dumps(m))
    result=inspect(tmp_path,rebuild=False)
    assert not result['passed']
    assert any(c['name']=='manifest-content' and not c['pass'] for c in result['checks'])
    assert any(c['name']=='release-hygiene' and not c['pass'] for c in result['checks'])


def test_synthetic_candidate_matches_existing_schema():
    from atlas_voice.wiki import clean_story, quality_gaps
    root=Path(__file__).resolve().parents[1]
    s=json.loads((root/'examples/claude_synthetic_story.json').read_text())
    record=clean_story(s)
    assert not quality_gaps(record)
    assert record['audience']=='internal'
    assert 'FICTIONAL' in record['title']


def test_complete_make_targets():
    text=(Path(__file__).resolve().parents[1]/'Makefile').read_text()
    assert 'tests/test_*.py' in text
    assert 'tests/depth_browser.py' in text
    assert '\t$(PYTHON)' in text


HTML = b'<!doctype html><title>synthetic release</title>\n'
ALIASES = (
    'ATLAS_Project_Intelligence.html', 'ATLAS_Intelligence.html',
    'ATLAS_Voice_Studio.html', 'ATLAS_Voice.html',
)
REQUIRED = (
    '00_START_HERE.md', 'CLAUDE.md', 'CLAUDE_BUILD_PROMPT.md',
    'handoff/CURRENT_STATUS.md', 'handoff/BUILD_PLAN.md', 'handoff/CONFIGURATION.md',
    'handoff/ACCEPTANCE.md', 'handoff/CODE_MAP.md',
)
BUILD_PY = (
    'from pathlib import Path\n'
    'html = ' + repr(HTML) + '\n'
    'root = Path(__file__).resolve().parent\n'
    'for name in ' + repr(ALIASES) + ':\n'
    '    (root / name).write_bytes(html)\n'
).encode()


def run_verify(argv):
    try:
        return main(argv)
    except SystemExit as exc:
        return exc.code


def _write(root, rel, data):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _manifest(files):
    rows = [{'path': rel, 'bytes': len(files[rel]), 'sha256': hashlib.sha256(files[rel]).hexdigest()}
            for rel in sorted(files)]
    return json.dumps({'version': 'synthetic', 'manifest_excludes': ['MANIFEST.json'], 'files': rows}, indent=2).encode()


def synthetic_package(tmp_path, *, mutate=None, omit=None, extra=None):
    """A release directory whose listed files match, unless a tamper argument says otherwise."""
    root = tmp_path / 'release'
    repo = Path(__file__).resolve().parents[1]
    files = {
        'build.py': BUILD_PY,
        'assets/Mantu.svg': (repo / 'assets' / 'Mantu.svg').read_bytes(),
        'notes/readme.txt': b'hello release\n',
    }
    for name in ALIASES:
        files[name] = HTML
    for name in REQUIRED:
        files[name] = ('# ' + name + '\n').encode()
    disk = dict(files)
    if mutate:
        disk[mutate] = disk[mutate][:-1] + bytes([(disk[mutate][-1] + 1) % 256])
    if omit:
        del disk[omit]
    for rel, data in disk.items():
        _write(root, rel, data)
    if extra:
        for rel, data in extra.items():
            _write(root, rel, data)
    _write(root, 'MANIFEST.json', _manifest(files))
    return root


def real_release_package(tmp_path, *, extra=None):
    """Minimal copy of the real release tree (all MANIFEST-listed files) for package-mode tests."""
    repo = Path(__file__).resolve().parents[1]
    manifest = json.loads((repo / 'MANIFEST.json').read_text(encoding='utf-8'))
    root = tmp_path / 'release'
    for row in manifest['files']:
        rel = row['path']
        src = repo / rel
        if not src.is_file():
            pytest.skip('release source missing: ' + rel)
        dest = root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())
    (root / 'MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    if extra:
        for rel, data in extra.items():
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    return root


def archive_of(root, dest, kind, prefix=''):
    files = [p for p in root.rglob('*') if p.is_file()]
    if kind == 'zip':
        with zipfile.ZipFile(dest, 'w') as zf:
            for path in files:
                zf.write(path, prefix + path.relative_to(root).as_posix())
    else:
        with tarfile.open(dest, 'w:gz') as tf:
            for path in files:
                tf.add(path, arcname=prefix + path.relative_to(root).as_posix())
    return dest


def test_command_requires_a_package():
    assert run_verify([]) == 2


def test_clean_synthetic_package_passes(tmp_path, capsys):
    assert run_verify([str(synthetic_package(tmp_path))]) == 0
    out = capsys.readouterr().out
    assert 'FAIL' not in out
    assert 'PASS manifest-content:' in out


def test_clean_zip_and_tar_and_wrapped_directory_pass(tmp_path):
    package = synthetic_package(tmp_path)
    assert run_verify([str(archive_of(package, tmp_path / 'release.zip', 'zip'))]) == 0
    assert run_verify([str(archive_of(package, tmp_path / 'release.tar.gz', 'tar'))]) == 0
    wrapped = archive_of(package, tmp_path / 'wrapped.zip', 'zip', prefix='ATLAS_Project_Intelligence/')
    assert run_verify([str(wrapped)]) == 0


def test_changed_byte_fails(tmp_path, capsys):
    package = synthetic_package(tmp_path, mutate='notes/readme.txt')
    assert run_verify([str(package)]) == 1
    assert 'FAIL manifest-content: changed: notes/readme.txt' in capsys.readouterr().out


def test_missing_file_fails(tmp_path, capsys):
    package = synthetic_package(tmp_path, omit='notes/readme.txt')
    assert run_verify([str(package)]) == 1
    assert 'FAIL manifest-content: missing or symlink: notes/readme.txt' in capsys.readouterr().out


def test_unlisted_file_fails(tmp_path, capsys):
    package = synthetic_package(tmp_path, extra={'notes/extra.txt': b'not in the manifest\n'})
    assert run_verify([str(package)]) == 1
    assert 'FAIL manifest-content: unlisted: notes/extra.txt' in capsys.readouterr().out


def _isolated_git_env(tmp_path):
    home = tmp_path / 'home'
    home.mkdir()
    ident = {
        'GIT_AUTHOR_NAME': 'atlas-handoff',
        'GIT_AUTHOR_EMAIL': 'atlas@example.com',
        'GIT_COMMITTER_NAME': 'atlas-handoff',
        'GIT_COMMITTER_EMAIL': 'atlas@example.com',
    }
    full = {**os.environ, 'HOME': str(home), **ident}
    bare = {**os.environ, 'HOME': str(home)}
    return full, bare


def test_git_dev_tree_untracked_file_fails_manifest(tmp_path):
    """Listed index files plus an untracked notes/extra.txt must fail manifest-content."""
    root = tmp_path / 'repo'
    root.mkdir()
    env_init, env_commit = _isolated_git_env(tmp_path)
    subprocess.run(['git', 'init', '-q'], cwd=root, check=True, env=env_init)
    (root / 'notes').mkdir()
    (root / 'notes' / 'readme.txt').write_bytes(b'listed\n')
    subprocess.run(['git', 'add', 'notes/readme.txt'], cwd=root, check=True, env=env_init)
    subprocess.run(['git', 'commit', '-qm', 'init'], cwd=root, check=True, env=env_init)
    (root / 'notes' / 'extra.txt').write_bytes(b'untracked\n')
    data = b'listed\n'
    manifest = {'files': [{'path': 'notes/readme.txt', 'bytes': len(data),
                         'sha256': hashlib.sha256(data).hexdigest()}],
                'manifest_excludes': ['MANIFEST.json']}
    (root / 'MANIFEST.json').write_text(json.dumps(manifest), encoding='utf-8')
    result = inspect(root, rebuild=False, dev_git_index=True)
    assert not result['passed']
    detail = next(c['detail'] for c in result['checks'] if c['name'] == 'manifest-content')
    assert 'notes/extra.txt' in detail and ('unlisted:' in detail or 'untracked:' in detail)


def test_node_modules_payload_fails_without_git(tmp_path, capsys):
    package = synthetic_package(tmp_path, extra={'node_modules/payload.js': b'export default 1;\n'})
    assert run_verify([str(package)]) == 1
    assert 'unlisted: node_modules/payload.js' in capsys.readouterr().out


def test_claude_payload_fails_without_git(tmp_path, capsys):
    package = synthetic_package(tmp_path, extra={'.claude/payload.md': b'# not a release file\n'})
    assert run_verify([str(package)]) == 1
    assert 'unlisted: .claude/payload.md' in capsys.readouterr().out


@pytest.mark.parametrize('rel,payload', [
    ('node_modules/evil/index.js', b'module.exports = {};\n'),
    ('.claude/settings.json', b'{"model": "evil"}\n'),
    ('deploy/cloudflare-edge/node_modules/y/i.js', b'export default 1;\n'),
])
def test_real_manifest_hidden_payload_fails(tmp_path, capsys, rel, payload):
    package = real_release_package(tmp_path, extra={rel: payload})
    assert run_verify([str(package)]) == 1
    assert 'unlisted: ' + rel in capsys.readouterr().out


def test_listed_file_under_symlinked_parent_outside_root_fails(tmp_path):
    package = synthetic_package(tmp_path)
    outside = tmp_path / 'outside'
    outside.mkdir()
    payload = b'escaped-by-symlink-parent\n'
    (outside / 'payload.txt').write_bytes(payload)
    (package / 'portal').symlink_to(outside, target_is_directory=True)
    manifest = json.loads((package / 'MANIFEST.json').read_text(encoding='utf-8'))
    rel = 'portal/payload.txt'
    manifest['files'].append({
        'path': rel,
        'bytes': len(payload),
        'sha256': hashlib.sha256(payload).hexdigest(),
    })
    (package / 'MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    result = inspect(package, rebuild=False)
    details = ' '.join(c['detail'] for c in result['checks'])
    assert not result['passed']
    assert 'outside package root' in details.lower()


def test_html_alias_read_through_symlinked_parent_outside_root_fails(tmp_path):
    package = synthetic_package(tmp_path)
    outside = tmp_path / 'outside'
    outside.mkdir()
    escaped = b'<!doctype html><title>outside-alias</title>\n'
    (outside / 'ATLAS_Project_Intelligence.html').write_bytes(escaped)
    alias = package / 'ATLAS_Project_Intelligence.html'
    alias.unlink()
    alias.symlink_to(outside / 'ATLAS_Project_Intelligence.html')
    result = inspect(package, rebuild=False)
    details = ' '.join(c['detail'] for c in result['checks'])
    assert not result['passed']
    assert 'outside package root' in details.lower()


def _plant_attacker_dotgit(package: Path, tmp_path: Path, sentinel: Path) -> None:
    """Crafted .git that would run fsmonitor/hooks if inspect invoked git."""
    mark = tmp_path / 'fsmark.sh'
    mark.write_text('#!/bin/sh\ntouch "' + str(sentinel) + '"\n', encoding='utf-8')
    mark.chmod(0o755)
    hook_dir = tmp_path / 'hooks'
    hook_dir.mkdir()
    hook = hook_dir / 'pre-commit'
    hook.write_text('#!/bin/sh\ntouch "' + str(sentinel) + '"\n', encoding='utf-8')
    hook.chmod(0o755)
    include_cfg = tmp_path / 'attacker-include.cfg'
    include_cfg.write_text('[core]\n\thooksPath = ' + str(hook_dir) + '\n', encoding='utf-8')
    env_init, _ = _isolated_git_env(tmp_path)
    subprocess.run(['git', 'init', '-q'], cwd=package, check=True, env=env_init)
    exclude = package / '.git' / 'info' / 'exclude'
    exclude.parent.mkdir(parents=True, exist_ok=True)
    exclude.write_text('node_modules/\n.claude/\n', encoding='utf-8')
    subprocess.run(['git', 'add', '-A'], cwd=package, check=True, env=env_init)
    subprocess.run(['git', 'commit', '-qm', 'release'], cwd=package, check=True, env=env_init)
    cfg = package / '.git' / 'config'
    cfg.write_text(
        '[core]\n'
        '\trepositoryformatversion = 0\n'
        '\tfsmonitor = true\n'
        '\tfsmonitorHookPath = ' + str(mark) + '\n'
        '[include]\n'
        '\tpath = ' + str(include_cfg) + '\n',
        encoding='utf-8',
    )


def planted_dotgit_attack_package(tmp_path):
    sentinel = tmp_path / 'git-hook-sentinel'
    extra = {
        'node_modules/evil/index.js': b'export default 1;\n',
        '.claude/x': b'{"evil": true}\n',
    }
    package = real_release_package(tmp_path, extra=extra)
    _plant_attacker_dotgit(package, tmp_path, sentinel)
    return package, sentinel


def test_planted_dotgit_package_inspect_stays_package_mode(tmp_path):
  package, sentinel = planted_dotgit_attack_package(tmp_path)
  assert not sentinel.exists()
  result = inspect(package, rebuild=False, dev_git_index=False)
  assert not result['passed']
  assert not sentinel.exists()
  detail = next(c['detail'] for c in result['checks'] if c['name'] == 'manifest-content')
  details = ' '.join(c['detail'] for c in result['checks'])
  assert 'node_modules/evil' in details
  assert '.claude/x' in details
  assert '.git' in details


def test_planted_dotgit_package_cli_stays_package_mode(tmp_path, capsys):
  package, sentinel = planted_dotgit_attack_package(tmp_path)
  assert not sentinel.exists()
  assert run_verify([str(package)]) == 1
  assert not sentinel.exists()
  out = capsys.readouterr().out
  assert 'node_modules/evil' in out
  assert '.claude/x' in out
  assert '.git' in out


def test_write_manifest_requires_explicit_dev_git_index():
  repo = Path(__file__).resolve().parents[1]
  assert (repo / '.git' / 'HEAD').is_file()
  with pytest.raises(SystemExit) as error:
    main([str(repo), '--write-manifest'])
  assert error.value.code == 2


def test_dev_git_index_ignores_hostile_local_git_config(tmp_path):
  sentinel = tmp_path / 'sentinel-dev'
  root = tmp_path / 'repo'
  root.mkdir()
  env_init, _ = _isolated_git_env(tmp_path)
  (root / 'notes').mkdir()
  (root / 'notes' / 'readme.txt').write_bytes(b'listed\n')
  mark = tmp_path / 'dev-fsmark.sh'
  mark.write_text('#!/bin/sh\ntouch "' + str(sentinel) + '"\n', encoding='utf-8')
  mark.chmod(0o755)
  hook_dir = tmp_path / 'dev-hooks'
  hook_dir.mkdir()
  (hook_dir / 'pre-commit').write_text('#!/bin/sh\ntouch "' + str(sentinel) + '"\n', encoding='utf-8')
  (hook_dir / 'pre-commit').chmod(0o755)
  subprocess.run(['git', 'init', '-q'], cwd=root, check=True, env=env_init)
  subprocess.run(['git', 'add', 'notes/readme.txt'], cwd=root, check=True, env=env_init)
  subprocess.run(['git', 'commit', '-qm', 'init'], cwd=root, check=True, env=env_init)
  cfg = root / '.git' / 'config'
  cfg.write_text(
      '[core]\n\tfsmonitor = true\n\tfsmonitorHookPath = ' + str(mark) + '\n'
      '\thooksPath = ' + str(hook_dir) + '\n',
      encoding='utf-8',
  )
  data = b'listed\n'
  manifest = {'files': [{'path': 'notes/readme.txt', 'bytes': len(data),
                         'sha256': hashlib.sha256(data).hexdigest()}],
              'manifest_excludes': ['MANIFEST.json']}
  (root / 'MANIFEST.json').write_text(json.dumps(manifest), encoding='utf-8')
  assert not sentinel.exists()
  inspect(root, rebuild=False, dev_git_index=True)
  assert not sentinel.exists()


def test_inspect_does_not_execute_package_git_fsmonitor(tmp_path):
    marker = tmp_path / 'fsmonitor-ran'
    hook = tmp_path / 'mark.sh'
    hook.write_text('#!/bin/sh\ntouch "' + str(marker) + '"\n', encoding='utf-8')
    hook.chmod(0o755)
    root = synthetic_package(tmp_path)
    (root / '.git').mkdir()
    (root / '.git' / 'config').write_text('[core]\n\tfsmonitor = true\n\tfsmonitorHookPath = ' + str(hook) + '\n', encoding='utf-8')
    inspect(root, rebuild=False)
    assert not marker.exists(), 'inspect must not invoke git on a package .git directory'


def test_tampered_zip_fails(tmp_path, capsys):
    package = synthetic_package(tmp_path, mutate='notes/readme.txt')
    archive = archive_of(package, tmp_path / 'tampered.zip', 'zip')
    assert run_verify([str(archive)]) == 1
    assert 'changed: notes/readme.txt' in capsys.readouterr().out


def test_missing_package_and_unsafe_archive_fail(tmp_path, capsys):
    assert run_verify([str(tmp_path / 'no-such-release')]) == 1
    assert 'Package not found' in capsys.readouterr().out
    archive = tmp_path / 'escape.zip'
    with zipfile.ZipFile(archive, 'w') as zf:
        zf.writestr('../escape.txt', b'nope')
        zf.writestr('MANIFEST.json', b'{}')
    assert run_verify([str(archive)]) == 1
    assert 'Unsafe archive path' in capsys.readouterr().out


def test_make_verify_package_requires_an_extracted_package(tmp_path):
    repo = Path(__file__).resolve().parents[1]
    bare = subprocess.run(['make', 'verify-package'], cwd=repo, capture_output=True, text=True)
    bare_text = bare.stdout + bare.stderr
    assert bare.returncode != 0
    assert 'PACKAGE' in bare_text
    assert 'changed:' not in bare_text
    package = synthetic_package(tmp_path)
    checked = subprocess.run(['make', 'verify-package', f'PACKAGE={package}'], cwd=repo, capture_output=True, text=True)
    assert checked.returncode == 0, checked.stdout + checked.stderr
    recipe = (repo / 'Makefile').read_text().split('test: ', 1)[1].split('\n', 1)[0]
    assert 'verify-package' not in recipe


def test_repository_full_handoff_includes_clean_rebuild():
    """Release tree on disk must pass manifest checks and a source-only rebuild."""
    repo = Path(__file__).resolve().parents[1]
    report = inspect(repo, rebuild=True, dev_git_index=True)
    by_name = {c['name']: c for c in report['checks']}
    assert by_name.get('manifest-content', {}).get('pass'), by_name.get('manifest-content', {}).get('detail')
    assert by_name.get('clean-build', {}).get('pass'), by_name.get('clean-build', {}).get('detail')
    assert by_name.get('clean-build-byte-match', {}).get('pass'), by_name.get('clean-build-byte-match', {}).get('detail')
    assert report['passed']


def test_docs_do_not_use_the_checker_as_a_dev_gate():
    repo = Path(__file__).resolve().parents[1]
    start = (repo / '00_START_HERE.md').read_text()
    plan = (repo / 'handoff' / 'BUILD_PLAN.md').read_text()
    note = json.loads((repo / 'handoff' / 'verification' / 'RESULTS.json').read_text())['integrity_note']
    assert 'python3 scripts/check_handoff.py\n' not in start
    assert 'before editing' not in start
    assert 'check_handoff.py` before changes' not in plan
    assert 'before editing' not in note
    assert 'enumerates package files except itself' in note
