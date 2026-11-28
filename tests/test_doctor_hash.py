"""The env reader must keep a hash that bash keeps inside an assignment.

Synthetic values only. No provider, network, or secret is used.
"""
import pytest

from atlas_voice.config import Config
from scripts.doctor import environment, read_literal_env


def test_unquoted_hash_stays_inside_the_assignment(tmp_path):
    path = tmp_path / 'env'
    path.write_text('ATLAS_ORIGIN=https://atlas.example#portal\nKEY=#note\n')
    got = read_literal_env(path)
    assert got['ATLAS_ORIGIN'] == 'https://atlas.example#portal'
    assert got['KEY'] == '#note'
    with environment(got):
        with pytest.raises(ValueError, match='fragment'):
            Config.env()


def test_hash_that_begins_a_later_word_is_a_comment(tmp_path):
    path = tmp_path / 'env'
    path.write_text("NAME='value with spaces' # note\nKEY=abc #def\nEMPTY= # gone\n")
    assert read_literal_env(path) == {
        'NAME': 'value with spaces',
        'KEY': 'abc',
        'EMPTY': '',
    }


def test_a_word_after_an_attached_hash_is_rejected(tmp_path):
    path = tmp_path / 'env'
    line = 'KEY=foo#bar baz'
    path.write_text(line + '\n')
    with pytest.raises(ValueError) as error:
        read_literal_env(path)
    assert 'quote spaces' in str(error.value)
    assert line not in str(error.value)
