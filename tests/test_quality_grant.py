"""Operator story grants record the authorization reference that was supplied.

A missing, cut, or multi-line reference must not change access. Synthetic vault only.
"""
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

from atlas_voice.wiki import SECTIONS, WikiVault

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts' / 'wiki_access.py'
OWNER = 'a' * 32
RECIPIENT = 'b' * 32


def story():
    return {
        'title': 'Fictional queue pilot',
        'stage': 'Pilot',
        'kind': 'qualitative',
        'audience': 'internal',
        'tags': ['service-operations'],
        'sections': {key: 'Fictional ' + key + ' account for one synthetic queue.' for key in SECTIONS},
        'sources': [{
            'id': 'E1',
            'version': 'fictional-v1',
            'excerpt': 'Synthetic acceptance record, not a real customer source.',
            'supports': ['challenge', 'contribution', 'approach', 'outcome'],
        }],
        'customer_brief': 'Operations teams seeking a predictable intake.',
    }


def open_vault(tmp_path):
    vault = WikiVault(tmp_path / 'vault')
    saved = vault.save(SimpleNamespace(subject_key=OWNER), story())
    vault.close()
    return saved['id']


def run(tmp_path, story_id, reference, revoke=False):
    command = [
        sys.executable, str(SCRIPT),
        '--vault', str(tmp_path / 'vault'),
        '--story', story_id,
        '--owner-key', OWNER,
        '--recipient-key', RECIPIENT,
        '--authorization-reference', reference,
    ]
    if revoke:
        command.append('--revoke')
    env = {
        'PATH': os.environ.get('PATH', ''),
        'PYTHONIOENCODING': 'utf-8',
        'PYTHONDONTWRITEBYTECODE': '1',
    }
    return subprocess.run(command, capture_output=True, text=True, env=env)


def access_keys(tmp_path):
    vault = WikiVault(tmp_path / 'vault')
    try:
        return [row[0] for row in vault.db.execute('SELECT user_key FROM access ORDER BY user_key')]
    finally:
        vault.close()


def operator_actions(tmp_path):
    vault = WikiVault(tmp_path / 'vault')
    try:
        return [row[0] for row in vault.db.execute(
            "SELECT action FROM audit WHERE action LIKE 'operator-%' ORDER BY id")]
    finally:
        vault.close()


def test_an_empty_reference_does_not_grant(tmp_path):
    story_id = open_vault(tmp_path)
    result = run(tmp_path, story_id, '')
    assert result.returncode != 0
    assert access_keys(tmp_path) == []
    assert operator_actions(tmp_path) == []


def test_a_whitespace_reference_does_not_grant(tmp_path):
    story_id = open_vault(tmp_path)
    result = run(tmp_path, story_id, '   ')
    assert result.returncode != 0
    assert access_keys(tmp_path) == []
    assert operator_actions(tmp_path) == []


def test_a_reference_past_200_characters_is_not_cut_and_stored(tmp_path):
    story_id = open_vault(tmp_path)
    reference = 'T' * 201
    result = run(tmp_path, story_id, reference)
    assert result.returncode != 0
    assert access_keys(tmp_path) == []
    assert operator_actions(tmp_path) == []


def test_a_reference_with_a_newline_does_not_grant(tmp_path):
    story_id = open_vault(tmp_path)
    result = run(tmp_path, story_id, 'OPS-1\napprove-facts')
    assert result.returncode != 0
    assert access_keys(tmp_path) == []
    assert operator_actions(tmp_path) == []


def test_a_200_character_reference_is_stored_whole_and_can_be_revoked(tmp_path):
    story_id = open_vault(tmp_path)
    reference = 'OPS-' + ('1' * 196)
    assert len(reference) == 200
    granted = run(tmp_path, story_id, reference)
    assert granted.returncode == 0, granted.stderr
    assert access_keys(tmp_path) == [RECIPIENT]
    assert operator_actions(tmp_path) == ['operator-grant: ' + reference]
    refused = run(tmp_path, story_id, '', revoke=True)
    assert refused.returncode != 0
    assert access_keys(tmp_path) == [RECIPIENT]
    assert operator_actions(tmp_path) == ['operator-grant: ' + reference]
    revoked = run(tmp_path, story_id, reference, revoke=True)
    assert revoked.returncode == 0, revoked.stderr
    assert access_keys(tmp_path) == []
    assert operator_actions(tmp_path) == [
        'operator-grant: ' + reference,
        'operator-revoke: ' + reference,
    ]
