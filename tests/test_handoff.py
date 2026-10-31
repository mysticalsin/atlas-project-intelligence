"""Offline handoff utilities: no provider calls and no real credentials."""
import hashlib
import json
from pathlib import Path
import pytest
from scripts.doctor import read_literal_env, probe, environment, main as doctor_main
from scripts.check_handoff import safe_relative, inspect


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


def test_setup_steps_are_automated():
    root=Path(__file__).resolve().parents[1]
    make=(root/'Makefile').read_text()
    assert 'cp ATLAS_Voice.html deploy/cloudflare-edge/src/atlas.html' in make
    assert 'test-edge: build' in make and 'test-eval: build' in make
    assert 'scripts/chromium_path.py' in make and (root/'scripts/chromium_path.py').exists()
    assert 'python-docx' in (root/'requirements-test.txt').read_text()
