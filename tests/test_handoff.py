"""Offline handoff utilities: no provider calls and no real credentials."""
import hashlib
import json
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
    report = inspect(repo, rebuild=True)
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
