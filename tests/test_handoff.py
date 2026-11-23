"""Offline handoff utilities: no provider calls and no real credentials."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import zipfile
import pytest
from scripts.doctor import read_literal_env, probe, environment, main as doctor_main
from scripts.check_handoff import safe_relative, inspect, main, git_environ, _GIT_INVOCATION, git_index_file_list


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


def _mini_dev_repo(tmp_path, name='repo'):
    root = tmp_path / name
    root.mkdir()
    env_init, _ = _isolated_git_env(tmp_path)
    (root / 'notes').mkdir()
    (root / 'notes' / 'readme.txt').write_bytes(b'listed\n')
    subprocess.run(['git', 'init', '-q'], cwd=root, check=True, env=env_init)
    subprocess.run(['git', 'add', 'notes/readme.txt'], cwd=root, check=True, env=env_init)
    subprocess.run(['git', 'commit', '-qm', 'init'], cwd=root, check=True, env=env_init)
    data = b'listed\n'
    manifest = {
        'files': [{'path': 'notes/readme.txt', 'bytes': len(data),
                   'sha256': hashlib.sha256(data).hexdigest()}],
        'manifest_excludes': ['MANIFEST.json'],
    }
    (root / 'MANIFEST.json').write_text(json.dumps(manifest), encoding='utf-8')
    return root, env_init


def test_dev_git_fsmonitor_script_path_does_not_touch_canary(tmp_path):
    canary = tmp_path / 'canary-fsmonitor-script'
    mark = tmp_path / 'fsmonitor.sh'
    mark.write_text('#!/bin/sh\ntouch "' + str(canary) + '"\n', encoding='utf-8')
    mark.chmod(0o755)
    root, _ = _mini_dev_repo(tmp_path)
    (root / '.git' / 'config').write_text('[core]\n\tfsmonitor = ' + str(mark) + '\n', encoding='utf-8')
    assert not canary.exists()
    inspect(root, rebuild=False, dev_git_index=True)
    assert not canary.exists()
    env = git_environ()
    assert set(env) <= _GIT_ENV_ALLOWLIST
    assert 'GIT_DIR' not in env


def test_dev_git_fsmonitor_via_include_path_does_not_touch_canary(tmp_path):
    canary = tmp_path / 'canary-include'
    mark = tmp_path / 'fsmonitor-include.sh'
    mark.write_text('#!/bin/sh\ntouch "' + str(canary) + '"\n', encoding='utf-8')
    mark.chmod(0o755)
    include_cfg = tmp_path / 'attacker-gitinclude.cfg'
    include_cfg.write_text('[core]\n\tfsmonitor = ' + str(mark) + '\n', encoding='utf-8')
    root, _ = _mini_dev_repo(tmp_path)
    (root / '.git' / 'config').write_text(
        '[core]\n\trepositoryformatversion = 0\n[include]\n\tpath = ' + str(include_cfg) + '\n',
        encoding='utf-8',
    )
    assert not canary.exists()
    inspect(root, rebuild=False, dev_git_index=True)
    assert not canary.exists()
    env = git_environ()
    assert set(env) <= _GIT_ENV_ALLOWLIST
    assert 'GIT_DIR' not in env


def test_listed_symlink_file_to_in_package_target_fails(tmp_path):
    package = synthetic_package(tmp_path)
    data = b'shared symlink target bytes\n'
    legit = package / 'notes' / 'legit.txt'
    legit.write_bytes(data)
    readme = package / 'notes' / 'readme.txt'
    readme.unlink()
    readme.symlink_to(legit)
    manifest = json.loads((package / 'MANIFEST.json').read_text(encoding='utf-8'))
    manifest['files'].append({
        'path': 'notes/legit.txt',
        'bytes': len(data),
        'sha256': hashlib.sha256(data).hexdigest(),
    })
    for row in manifest['files']:
        if row['path'] == 'notes/readme.txt':
            row['bytes'] = len(data)
            row['sha256'] = hashlib.sha256(data).hexdigest()
    (package / 'MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    result = inspect(package, rebuild=False, dev_git_index=False)
    assert not result['passed']
    detail = ' '.join(c['detail'] for c in result['checks'])
    assert 'symlink' in detail.lower()


def test_listed_file_under_symlinked_dir_component_fails(tmp_path):
    package = synthetic_package(tmp_path)
    data = b'under symlinked directory\n'
    realdir = package / 'realdir'
    realdir.mkdir()
    (realdir / 'file.txt').write_bytes(data)
    (package / 'linkdir').symlink_to(realdir, target_is_directory=True)
    manifest = json.loads((package / 'MANIFEST.json').read_text(encoding='utf-8'))
    manifest['files'].append({
        'path': 'linkdir/file.txt',
        'bytes': len(data),
        'sha256': hashlib.sha256(data).hexdigest(),
    })
    (package / 'MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    result = inspect(package, rebuild=False, dev_git_index=False)
    assert not result['passed']
    detail = ' '.join(c['detail'] for c in result['checks'])
    assert 'symlink' in detail.lower()


def test_dev_git_index_fails_despite_git_index_file_env(tmp_path, monkeypatch):
    env_init, _ = _isolated_git_env(tmp_path)
    clean = tmp_path / 'clean'
    dirty = tmp_path / 'dirty'
    for d in (clean, dirty):
        d.mkdir()
        (d / 'notes').mkdir()
        (d / 'notes' / 'readme.txt').write_bytes(b'listed\n')
        subprocess.run(['git', 'init', '-q'], cwd=d, check=True, env=env_init)
        subprocess.run(['git', 'add', 'notes/readme.txt'], cwd=d, check=True, env=env_init)
        subprocess.run(['git', 'commit', '-qm', 'init'], cwd=d, check=True, env=env_init)
    (dirty / 'node_modules' / 'evil').mkdir(parents=True)
    (dirty / 'node_modules' / 'evil' / 'index.js').write_bytes(b'export default 1;\n')
    data = b'listed\n'
    manifest = {
        'files': [{'path': 'notes/readme.txt', 'bytes': len(data),
                   'sha256': hashlib.sha256(data).hexdigest()}],
        'manifest_excludes': ['MANIFEST.json'],
    }
    for d in (clean, dirty):
        (d / 'MANIFEST.json').write_text(json.dumps(manifest), encoding='utf-8')
    monkeypatch.setenv('GIT_DIR', str(clean / '.git'))
    monkeypatch.setenv('GIT_WORK_TREE', str(clean))
    monkeypatch.setenv('GIT_INDEX_FILE', str(clean / '.git' / 'index'))
    report = inspect(dirty, rebuild=False, dev_git_index=True)
    mc = next(c for c in report['checks'] if c['name'] == 'manifest-content')
    assert not mc['pass'], mc['detail']
    assert 'node_modules/evil' in mc['detail']


def test_dev_git_index_fails_despite_git_config_count_excludes_file(tmp_path, monkeypatch):
    root, _ = _mini_dev_repo(tmp_path)
    exclude = tmp_path / 'exclude-all'
    exclude.write_text('*\n', encoding='utf-8')
    monkeypatch.setenv('GIT_CONFIG_COUNT', '1')
    monkeypatch.setenv('GIT_CONFIG_KEY_0', 'core.excludesFile')
    monkeypatch.setenv('GIT_CONFIG_VALUE_0', str(exclude))
    (root / 'node_modules' / 'evil').mkdir(parents=True)
    (root / 'node_modules' / 'evil' / 'payload.js').write_bytes(b'export default 1;\n')
    report = inspect(root, rebuild=False, dev_git_index=True)
    mc = next(c for c in report['checks'] if c['name'] == 'manifest-content')
    assert not mc['pass'], mc['detail']
    assert 'node_modules/evil' in mc['detail']


def test_dev_git_index_fails_despite_git_work_tree_env(tmp_path, monkeypatch):
    env_init, _ = _isolated_git_env(tmp_path)
    clean = tmp_path / 'clean'
    dirty = tmp_path / 'dirty'
    for d in (clean, dirty):
        d.mkdir()
        (d / 'notes').mkdir()
        (d / 'notes' / 'readme.txt').write_bytes(b'listed\n')
        subprocess.run(['git', 'init', '-q'], cwd=d, check=True, env=env_init)
        subprocess.run(['git', 'add', 'notes/readme.txt'], cwd=d, check=True, env=env_init)
        subprocess.run(['git', 'commit', '-qm', 'init'], cwd=d, check=True, env=env_init)
    (dirty / 'node_modules' / 'evil').mkdir(parents=True)
    (dirty / 'node_modules' / 'evil' / 'index.js').write_bytes(b'export default 1;\n')
    data = b'listed\n'
    manifest = {
        'files': [{'path': 'notes/readme.txt', 'bytes': len(data),
                   'sha256': hashlib.sha256(data).hexdigest()}],
        'manifest_excludes': ['MANIFEST.json'],
    }
    for d in (clean, dirty):
        (d / 'MANIFEST.json').write_text(json.dumps(manifest), encoding='utf-8')
    monkeypatch.setenv('GIT_DIR', str(clean / '.git'))
    monkeypatch.setenv('GIT_WORK_TREE', str(clean))
    report = inspect(dirty, rebuild=False, dev_git_index=True)
    mc = next(c for c in report['checks'] if c['name'] == 'manifest-content')
    assert not mc['pass'], mc['detail']
    assert 'node_modules/evil' in mc['detail']


_GIT_ENV_ALLOWLIST = frozenset({
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT',
})


def test_git_environ_is_allowlist_without_git_star(monkeypatch):
    monkeypatch.setenv('GIT_DIR', '/tmp/evil-git-dir')
    monkeypatch.setenv('GIT_WORK_TREE', '/tmp/evil-work-tree')
    monkeypatch.setenv('GIT_INDEX_FILE', '/tmp/evil-index')
    monkeypatch.setenv('GIT_CONFIG', '/tmp/evil-config')
    monkeypatch.setenv('GIT_CONFIG_COUNT', '1')
    monkeypatch.setenv('GIT_CONFIG_KEY_0', 'core.excludesFile')
    monkeypatch.setenv('GIT_CONFIG_VALUE_0', '/tmp/evil-excludes')
    env = git_environ()
    assert set(env) <= _GIT_ENV_ALLOWLIST
    assert 'GIT_DIR' not in env
    assert 'GIT_WORK_TREE' not in env
    assert 'GIT_INDEX_FILE' not in env


def test_git_subprocess_argv_includes_hardening_flags(tmp_path, monkeypatch):
    captured = {}
    root, _ = _mini_dev_repo(tmp_path)

    def fake_check_output(cmd, stderr=None, env=None):
        captured['cmd'] = list(cmd)
        captured['env'] = env
        return b'notes/readme.txt\0'

    monkeypatch.setattr(subprocess, 'check_output', fake_check_output)
    git_index_file_list(root)
    cmd = captured['cmd']
    assert '-c' in cmd
    assert 'core.fsmonitor=false' in cmd
    assert 'core.hooksPath=/dev/null' in cmd
    assert '--no-optional-locks' in cmd
    env = captured['env']
    assert env.get('GIT_CONFIG_NOSYSTEM') == '1'
    assert env.get('GIT_CONFIG_GLOBAL') == '/dev/null'


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


def test_git_archive_of_head_passes_check_handoff(tmp_path):
    """A clean git archive of HEAD is the release package the checker scores."""
    repo = Path(__file__).resolve().parents[1]
    extracted = tmp_path / 'head'
    extracted.mkdir()
    archived = subprocess.run(['git', 'archive', '--format=tar', 'HEAD'], cwd=repo, capture_output=True)
    assert archived.returncode == 0, archived.stderr
    unpacked = subprocess.run(['tar', '-x', '-C', str(extracted)], input=archived.stdout)
    assert unpacked.returncode == 0, unpacked.stderr
    result = subprocess.run(
        [sys.executable, 'scripts/check_handoff.py', '.'],
        cwd=extracted, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


# Follow-ups on the package fence. Appended only; the nine fence tests above are unchanged.
# Rebuild env is the seven names captured from scripts.check_handoff.subprocess.run.
_REBUILD_ENV_ALLOWLIST = (
    'HOME',
    'LANG',
    'LC_ALL',
    'PATH',
    'PYTHONDONTWRITEBYTECODE',
    'PYTHONHASHSEED',
    'PYTHONNOUSERSITE',
)


def _manifest_detail(result):
    return next(c['detail'] for c in result['checks'] if c['name'] == 'manifest-content')


def _exclude(package, extra_paths):
    manifest = json.loads((package / 'MANIFEST.json').read_text(encoding='utf-8'))
    manifest['manifest_excludes'] = ['MANIFEST.json', *extra_paths]
    (package / 'MANIFEST.json').write_text(json.dumps(manifest), encoding='utf-8')


@pytest.mark.parametrize('rel,expected', [
    ('.git', True),
    ('.git/HEAD', True),
    ('.git/config', True),
    ('vendor/demo/.git/HEAD', True),
    ('vendor/demo/.git/config', True),
    ('vendor/demo/.git', True),
    ('vendor/demo/.git/', True),
    ('./.git/HEAD', True),
    ('vendor/./.git/HEAD', True),
    ('.gitignore', False),
    ('.gitattributes', False),
    ('.github/workflows/ci.yml', False),
    ('vendor/.github/workflows/ci.yml', False),
    ('something.git/README', False),
    ('foo/bar/.git.bak', False),
    ('notes/readme.txt', False),
    ('vendor\\.git\\HEAD', True),
])
def test_is_git_metadata_path_any_component(rel, expected):
    from scripts.check_handoff import is_git_metadata_path
    assert is_git_metadata_path(rel) is expected


@pytest.mark.parametrize('rel', [
    '.GIT/HEAD',
    'vendor/x/.Git/config',
    'Vendor/.Git/HEAD',
])
def test_git_metadata_path_refuses_case_variants(rel):
    """Windows and macOS fold the case of a .git component. The fence does too."""
    from scripts.check_handoff import is_git_metadata_path
    assert is_git_metadata_path(rel) is True


@pytest.mark.parametrize('rel', [
    '.gitignore',
    '.gitattributes',
    '.github/workflows/ci.yml',
    'vendor/.github/CODEOWNERS',
    'something.git/README',
])
def test_git_metadata_path_allows_near_names(rel):
    from scripts.check_handoff import is_git_metadata_path
    assert is_git_metadata_path(rel) is False


def test_manifest_excludes_cannot_hide_nested_git(tmp_path):
    """Ordering guard: a .git component is refused before manifest_excludes apply."""
    package = synthetic_package(tmp_path)
    for rel, data in {
        'vendor/demo/.git/HEAD': b'ref: refs/heads/main\n',
        'vendor/demo/.git/config': b'[core]\n\trepositoryformatversion = 0\n',
    }.items():
        path = package / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    _exclude(package, ['vendor/demo/.git/HEAD', 'vendor/demo/.git/config'])
    result = inspect(package, rebuild=False)
    detail = _manifest_detail(result)
    assert 'refused: vendor/demo/.git/HEAD' in detail, detail
    assert 'refused: vendor/demo/.git/config' in detail, detail
    assert result['passed'] is False


def test_excluded_gitlink_file_is_refused(tmp_path):
    package = synthetic_package(tmp_path)
    gitlink = package / 'vendor' / 'app' / '.git'
    gitlink.parent.mkdir(parents=True, exist_ok=True)
    gitlink.write_bytes(b'gitdir: /tmp/not-a-real-git\n')
    _exclude(package, ['vendor/app/.git'])
    result = inspect(package, rebuild=False)
    detail = _manifest_detail(result)
    assert 'refused: vendor/app/.git' in detail, detail
    assert result['passed'] is False


def test_unlisted_nested_git_is_refused(tmp_path):
    package = synthetic_package(tmp_path)
    path = package / 'vendor' / 'demo' / '.git' / 'HEAD'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'ref: refs/heads/main\n')
    result = inspect(package, rebuild=False)
    detail = _manifest_detail(result)
    assert 'refused: vendor/demo/.git/HEAD' in detail, detail
    assert result['passed'] is False


def test_dev_git_index_outside_checkout_exits_nonzero_without_traceback(tmp_path, capsys):
    package = synthetic_package(tmp_path)
    assert not (package / '.git' / 'HEAD').is_file()
    code = run_verify([str(package), '--dev-git-index', '--no-rebuild'])
    captured = capsys.readouterr()
    text = captured.out + captured.err
    assert code == 1
    assert 'dev-git-index requires a git checkout' in text
    assert 'Traceback' not in text
    assert 'UnboundLocalError' not in text


def test_clean_rebuild_build_py_sees_only_allowlist_env(tmp_path, monkeypatch):
    """The rebuild env is whatever scripts.check_handoff.subprocess.run receives."""
    monkeypatch.setenv('OPENAI_API_KEY', 'sk-caller-secret')
    monkeypatch.setenv('ATLAS_HOME_URL', 'https://evil.example')
    monkeypatch.setenv('PYTHONPATH', str(tmp_path / 'attacker-path'))
    monkeypatch.setenv('GIT_DIR', '/tmp/evil-git-dir')
    monkeypatch.setenv('LD_PRELOAD', '/tmp/attacker.so')
    monkeypatch.setenv('LD_LIBRARY_PATH', '/tmp/attacker-lib')
    captured = {}
    real_run = subprocess.run

    def spy(cmd, *args, **kwargs):
        command = list(cmd)
        if command and str(command[-1]).endswith('build.py'):
            captured['env'] = kwargs.get('env')
            captured['saw'] = True
        return real_run(cmd, *args, **kwargs)

    monkeypatch.setattr('scripts.check_handoff.subprocess.run', spy)
    package = synthetic_package(tmp_path)
    result = inspect(package, rebuild=True, dev_git_index=False)
    assert captured.get('saw') is True
    env = captured.get('env')
    assert isinstance(env, dict), env
    assert sorted(env) == list(_REBUILD_ENV_ALLOWLIST)
    assert env['LANG'] == 'C.utf8'
    assert env['LC_ALL'] == 'C.utf8'
    assert env['PYTHONHASHSEED'] == '0'
    assert env['PYTHONNOUSERSITE'] == '1'
    assert env['PYTHONDONTWRITEBYTECODE'] == '1'
    assert env['PATH'] == os.environ['PATH']
    assert env['HOME'] != str(Path.home())
    assert not Path(env['HOME']).exists()
    for banned in (
        'OPENAI_API_KEY', 'ATLAS_HOME_URL', 'PYTHONPATH', 'GIT_DIR',
        'LD_PRELOAD', 'LD_LIBRARY_PATH',
    ):
        assert banned not in env
    assert result['passed'], result


def test_git_environ_does_not_leak_a_home_per_call(monkeypatch):
    monkeypatch.setenv('PATH', '/usr/bin:/bin')
    first = git_environ()
    second = git_environ()
    assert first['HOME'] == second['HOME']
    assert Path(first['HOME']).is_dir()
    assert first['PATH'] == '/usr/bin:/bin'


def test_git_environ_documents_path_inheritance():
    doc = git_environ.__doc__ or ''
    assert 'PATH' in doc
    assert 'caller' in doc.lower()


# Loop 2. The backslash expectation above moved to True: a backslash spelling is refused.
_LOOKALIKE_COMPONENTS = (
    ('trailing-dot', '.git.'),
    ('trailing-space', '.git '),
    ('zwsp', '.g\u200bit'),
    ('zwnj', '.g\u200cit'),
    ('nbsp', '.git\u00a0'),
    ('bom', '\ufeff.git'),
    ('dotless-i', '.g\u0131t'),
    ('fullwidth-dot', '\uff0egit'),
    ('fullwidth-git', '.\uff27\uff29\uff34'),
    ('short-83', 'GIT~1'),
)


def _excluded_lookalike(tmp_path, component):
    package = synthetic_package(tmp_path)
    target = package / 'vendor' / 'demo' / component / 'HEAD'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b'ref: refs/heads/main\n')
    rel = target.relative_to(package).as_posix()
    parent = target.parent.relative_to(package).as_posix()
    _exclude(package, [rel, parent])
    return package, rel


@pytest.mark.parametrize('component', [item[1] for item in _LOOKALIKE_COMPONENTS], ids=[item[0] for item in _LOOKALIKE_COMPONENTS])
def test_excluded_lookalike_git_component_is_refused(tmp_path, component):
    """Fail closed: an exclude must not certify a disguised .git component."""
    package, rel = _excluded_lookalike(tmp_path, component)
    result = inspect(package, rebuild=False)
    detail = _manifest_detail(result)
    assert 'refused: ' + rel in detail, detail
    assert result['passed'] is False


@pytest.mark.parametrize('rel', [
    '.gitignore',
    '.gitattributes',
    '.github/workflows/ci.yml',
    'something.git/README',
    'foo/.git.bak',
])
def test_normalized_near_names_stay_allowed(rel):
    from scripts.check_handoff import is_git_metadata_path
    assert is_git_metadata_path(rel) is False


def test_listed_near_names_are_not_refused(tmp_path):
    package = synthetic_package(tmp_path)
    extra = {
        '.gitignore': b'*.log\n',
        '.gitattributes': b'* text\n',
        '.github/workflows/ci.yml': b'name: ci\n',
        'something.git/README': b'hi\n',
        'foo/.git.bak': b'old\n',
    }
    manifest = json.loads((package / 'MANIFEST.json').read_text(encoding='utf-8'))
    for rel, data in extra.items():
        path = package / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        manifest['files'].append({
            'path': rel,
            'bytes': len(data),
            'sha256': hashlib.sha256(data).hexdigest(),
        })
    (package / 'MANIFEST.json').write_text(json.dumps(manifest), encoding='utf-8')
    result = inspect(package, rebuild=False)
    detail = _manifest_detail(result)
    assert 'refused:' not in detail, detail
    assert result['passed'], detail


def test_empty_nested_git_directory_is_refused(tmp_path):
    package = synthetic_package(tmp_path)
    (package / 'vendor' / 'demo' / '.git').mkdir(parents=True)
    _exclude(package, ['vendor/demo/.git'])
    result = inspect(package, rebuild=False)
    detail = _manifest_detail(result)
    assert 'refused: vendor/demo/.git' in detail, detail
    assert result['passed'] is False


def test_backslash_git_spelling_is_refused_not_unlisted(tmp_path):
    package = synthetic_package(tmp_path)
    path = package / 'vendor\\.git\\HEAD'
    path.write_bytes(b'ref: refs/heads/main\n')
    result = inspect(package, rebuild=False)
    detail = _manifest_detail(result)
    shown = 'vendor\\.git\\HEAD'
    assert 'refused: ' + shown in detail, detail
    assert 'unlisted: ' + shown not in detail, detail
    assert result['passed'] is False


def test_index_allocation_git_name_is_refused_not_unlisted(tmp_path):
    package = synthetic_package(tmp_path)
    name = '.git::$INDEX_ALLOCATION'
    path = package / 'vendor' / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'dir\n')
    result = inspect(package, rebuild=False)
    detail = _manifest_detail(result)
    shown = 'vendor/' + name
    assert 'refused: ' + shown in detail, detail
    assert 'unlisted: ' + shown not in detail, detail
    assert result['passed'] is False


def test_package_walk_does_not_follow_directory_symlinks(tmp_path):
    package = synthetic_package(tmp_path)
    data = b'visible through the real directory\n'
    real = package / 'real'
    real.mkdir()
    (real / 'file.txt').write_bytes(data)
    (package / 'extras').symlink_to(real, target_is_directory=True)
    manifest = json.loads((package / 'MANIFEST.json').read_text(encoding='utf-8'))
    manifest['files'].append({
        'path': 'real/file.txt',
        'bytes': len(data),
        'sha256': hashlib.sha256(data).hexdigest(),
    })
    manifest['manifest_excludes'] = ['MANIFEST.json', 'extras']
    (package / 'MANIFEST.json').write_text(json.dumps(manifest), encoding='utf-8')
    result = inspect(package, rebuild=False)
    detail = _manifest_detail(result)
    assert 'extras/file.txt' not in detail, detail
    assert result['passed'], detail


def test_git_home_is_removed_at_process_exit():
    repo = Path(__file__).resolve().parents[1]
    script = 'import scripts.check_handoff as handoff\nprint(handoff.git_environ()["HOME"])\n'
    proc = subprocess.run([sys.executable, '-c', script], cwd=repo, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    home = Path(proc.stdout.strip())
    assert home.name.startswith('atlas-git-home-')
    assert not home.exists()


def test_git_home_cleanup_is_registered_once(monkeypatch):
    import atexit
    import shutil
    import scripts.check_handoff as handoff
    calls = []
    real_register = atexit.register

    def spy(callback, *args, **kwargs):
        calls.append(callback)
        return real_register(callback, *args, **kwargs)

    monkeypatch.setattr(handoff.atexit, 'register', spy)
    handoff._GIT_HOME = None
    if hasattr(handoff, '_GIT_HOME_CLEANUP'):
        handoff._GIT_HOME_CLEANUP = False
    first = handoff.git_environ()['HOME']
    shutil.rmtree(first)
    handoff._GIT_HOME = None
    handoff.git_environ()
    assert len(calls) == 1


def test_is_dev_tree_accepts_casefolded_git_directory(tmp_path):
    from scripts.check_handoff import is_dev_tree
    root = tmp_path / 'repo'
    (root / '.GIT').mkdir(parents=True)
    (root / '.GIT' / 'HEAD').write_text('ref: refs/heads/main\n', encoding='utf-8')
    assert is_dev_tree(root) is False


def test_release_hygiene_uses_the_git_metadata_helper(tmp_path):
    package = synthetic_package(tmp_path)
    data = b'[core]\n'
    rel = 'vendor/.git./config'
    path = package / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    manifest = json.loads((package / 'MANIFEST.json').read_text(encoding='utf-8'))
    manifest['files'].append({
        'path': rel,
        'bytes': len(data),
        'sha256': hashlib.sha256(data).hexdigest(),
    })
    (package / 'MANIFEST.json').write_text(json.dumps(manifest), encoding='utf-8')
    result = inspect(package, rebuild=False)
    hygiene = next(c for c in result['checks'] if c['name'] == 'release-hygiene')
    assert hygiene['pass'] is False
    assert rel in hygiene['detail']


def _mini_checkout(tmp_path):
    root = tmp_path / 'repo'
    root.mkdir()
    env_init, _env_commit = _isolated_git_env(tmp_path)
    subprocess.run(['git', 'init', '-q'], cwd=root, check=True, env=env_init)
    (root / 'notes').mkdir()
    (root / 'notes' / 'readme.txt').write_bytes(b'listed\n')
    (root / '.gitignore').write_text('vendor/\n', encoding='utf-8')
    subprocess.run(['git', 'add', 'notes/readme.txt', '.gitignore'], cwd=root, check=True, env=env_init)
    subprocess.run(['git', 'commit', '-qm', 'init'], cwd=root, check=True, env=env_init)
    rows = []
    for rel in ('notes/readme.txt', '.gitignore'):
        data = (root / rel).read_bytes()
        rows.append({'path': rel, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    manifest = {'files': rows, 'manifest_excludes': ['MANIFEST.json']}
    (root / 'MANIFEST.json').write_text(json.dumps(manifest), encoding='utf-8')
    return root


def test_dev_git_index_refuses_nested_git_under_gitignore(tmp_path, capsys):
    root = _mini_checkout(tmp_path)
    hidden = root / 'vendor' / 'demo' / '.git' / 'HEAD'
    hidden.parent.mkdir(parents=True)
    hidden.write_bytes(b'ref: refs/heads/main\n')
    code = run_verify([str(root), '--dev-git-index', '--no-rebuild'])
    text = capsys.readouterr().out + capsys.readouterr().err
    assert code == 1
    assert 'refused: vendor/demo/.git/HEAD' in text
    assert 'Traceback' not in text


def test_dev_git_index_does_not_refuse_the_checkout_git_dir(tmp_path):
    root = _mini_checkout(tmp_path)
    result = inspect(root, rebuild=False, dev_git_index=True)
    detail = _manifest_detail(result)
    assert 'refused: .git' not in detail
    assert 'refused: .git/' not in detail


# Loop 3. Any non-ASCII component is refused. Short names include a suffix.
_NON_ASCII_PATHS = (
    ('u0131', 'vendor/\u0131.txt'),
    ('u0456', 'vendor/\u0456.txt'),
    ('u0261', 'vendor/\u0261.txt'),
    ('u2024', 'vendor/\u2024.txt'),
    ('cafe', 'notes/caf\u00e9.txt'),
)


def _excluded_extra(tmp_path, rel, data=b'x\n'):
    package = synthetic_package(tmp_path)
    path = package / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    _exclude(package, [rel])
    return package


@pytest.mark.parametrize('rel', [item[1] for item in _NON_ASCII_PATHS], ids=[item[0] for item in _NON_ASCII_PATHS])
def test_excluded_non_ascii_component_is_refused(tmp_path, rel):
    package = _excluded_extra(tmp_path, rel)
    result = inspect(package, rebuild=False)
    detail = _manifest_detail(result)
    assert 'refused: non-ASCII path component' in detail, detail
    assert result['passed'] is False


@pytest.mark.parametrize('name', ['GIT~1.DIR', 'git~12.x'])
def test_git_short_name_with_suffix_is_refused(tmp_path, name):
    rel = 'vendor/' + name
    package = _excluded_extra(tmp_path, rel)
    result = inspect(package, rebuild=False)
    detail = _manifest_detail(result)
    assert 'refused: ' + rel in detail, detail
    assert result['passed'] is False


def test_dev_git_index_refuses_non_ascii_path(tmp_path, capsys):
    root = _mini_checkout(tmp_path)
    (root / 'notes' / 'caf\u00e9.txt').write_bytes(b'x\n')
    code = run_verify([str(root), '--dev-git-index', '--no-rebuild'])
    text = capsys.readouterr().out + capsys.readouterr().err
    assert code == 1
    assert 'refused: non-ASCII path component' in text
    assert 'Traceback' not in text


def test_write_manifest_refuses_non_ascii_path(tmp_path, capsys):
    root = _mini_checkout(tmp_path)
    (root / 'notes' / 'caf\u00e9.txt').write_bytes(b'x\n')
    before = (root / 'MANIFEST.json').read_bytes()
    code = run_verify([str(root), '--dev-git-index', '--write-manifest'])
    text = capsys.readouterr().out + capsys.readouterr().err
    assert code == 1
    assert 'refused: non-ASCII path component' in text
    assert (root / 'MANIFEST.json').read_bytes() == before


# Loop 4. Checkout detection is the exact top-level .git. Disguised top-level
# names are refused. The symlink refusal and the repeated trim are load-bearing.
def _disguised_checkout(tmp_path, dirname):
    root = tmp_path / 'pkg'
    root.mkdir()
    (root / dirname).mkdir()
    (root / dirname / 'HEAD').write_text('ref: refs/heads/main\n', encoding='utf-8')
    (root / 'MANIFEST.json').write_text(
        json.dumps({'files': [], 'manifest_excludes': ['MANIFEST.json']}),
        encoding='utf-8')
    return root


@pytest.mark.parametrize('dirname', ['.GIT', 'GIT~1'])
def test_disguised_checkout_dev_git_index_exits_clean(tmp_path, capsys, dirname):
    root = _disguised_checkout(tmp_path, dirname)
    code = run_verify([str(root), '--dev-git-index', '--no-rebuild'])
    text = capsys.readouterr().out + capsys.readouterr().err
    assert code == 1
    assert 'dev-git-index requires a git checkout' in text
    assert 'Traceback' not in text


@pytest.mark.parametrize('dirname', ['.GIT', 'GIT~1'])
def test_disguised_checkout_write_manifest_exits_clean(tmp_path, capsys, dirname):
    root = _disguised_checkout(tmp_path, dirname)
    before = (root / 'MANIFEST.json').read_bytes()
    code = run_verify([str(root), '--dev-git-index', '--write-manifest'])
    text = capsys.readouterr().out + capsys.readouterr().err
    assert code == 2
    assert 'dev-git-index requires a git checkout' in text
    assert 'Traceback' not in text
    assert (root / 'MANIFEST.json').read_bytes() == before


def test_git_failure_on_exact_dotgit_check_is_clean(tmp_path, capsys):
    root = _disguised_checkout(tmp_path, '.git')
    code = run_verify([str(root), '--dev-git-index', '--no-rebuild'])
    text = capsys.readouterr().out + capsys.readouterr().err
    assert code == 1
    assert 'dev-git-index requires a git checkout' in text
    assert 'Traceback' not in text


def test_git_failure_on_exact_dotgit_write_manifest_is_clean(tmp_path, capsys):
    root = _disguised_checkout(tmp_path, '.git')
    before = (root / 'MANIFEST.json').read_bytes()
    code = run_verify([str(root), '--dev-git-index', '--write-manifest'])
    text = capsys.readouterr().out + capsys.readouterr().err
    assert code == 2
    assert 'dev-git-index requires a git checkout' in text
    assert 'Traceback' not in text
    assert (root / 'MANIFEST.json').read_bytes() == before


@pytest.mark.parametrize('name', ['.GIT', '.git.', 'GIT~1', 'GIT~1.DIR'])
def test_dev_mode_refuses_top_level_disguised_git_dir(tmp_path, capsys, name):
    root = _mini_checkout(tmp_path)
    hidden = root / name / 'HEAD'
    hidden.parent.mkdir()
    hidden.write_bytes(b'ref: refs/heads/main\n')
    code = run_verify([str(root), '--dev-git-index', '--no-rebuild'])
    text = capsys.readouterr().out + capsys.readouterr().err
    refused = [line for line in text.splitlines() if 'refused:' in line]
    assert code == 1
    assert any(name in line for line in refused), text
    assert not any(line.endswith('refused: .git') or 'refused: .git/' in line for line in refused)
    assert 'Traceback' not in text


def test_dev_git_index_refuses_nested_git_symlink(tmp_path, capsys):
    root = _mini_checkout(tmp_path)
    target = tmp_path / 'elsewhere'
    target.mkdir()
    link = root / 'vendor' / 'demo' / '.git'
    link.parent.mkdir(parents=True)
    link.symlink_to(target, target_is_directory=True)
    code = run_verify([str(root), '--dev-git-index', '--no-rebuild'])
    text = capsys.readouterr().out + capsys.readouterr().err
    assert code == 1
    assert 'refused: vendor/demo/.git' in text
    assert 'Traceback' not in text


@pytest.mark.parametrize('name', ['.git. .', '.git . '])
def test_repeated_trailing_dot_and_space_is_refused(tmp_path, name):
    rel = 'vendor/' + name
    package = _excluded_extra(tmp_path, rel)
    result = inspect(package, rebuild=False)
    detail = _manifest_detail(result)
    assert 'refused: ' + rel in detail, detail
    assert result['passed'] is False


def test_dev_trailing_slash_exclude_is_exact_or_prefix():
    """A dev exclude ending in / is that directory or a child, not a substring.

    `b/` allows `b` and `b/c`. It does not allow `ab/c` or a later segment `a/b/c`.
    Package mode ignores a trailing-slash exclude.
    """
    from scripts.check_handoff import manifest_allows_path
    excludes = ['b/']
    assert manifest_allows_path('a/b/c', excludes, package_mode=False) is False
    assert manifest_allows_path('ab/c', excludes, package_mode=False) is False
    assert manifest_allows_path('foo/b/bar', excludes, package_mode=False) is False
    assert manifest_allows_path('bc', excludes, package_mode=False) is False
    assert manifest_allows_path('b', excludes, package_mode=False) is True
    assert manifest_allows_path('b/c', excludes, package_mode=False) is True
    assert manifest_allows_path('b/c', excludes, package_mode=True) is False
