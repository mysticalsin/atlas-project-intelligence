"""A trailing dot or space after ::$INDEX_ALLOCATION is still git metadata.

Windows drops those characters. The checker refuses the name either way.
Synthetic path names only.
"""
import pytest

from scripts.check_handoff import is_git_metadata_component, is_git_metadata_path


@pytest.mark.parametrize('name', [
    '.git::$INDEX_ALLOCATION.',
    '.git::$INDEX_ALLOCATION ',
    '.GIT::$INDEX_ALLOCATION.',
    '.git::$INDEX_ALLOCATION::$INDEX_ALLOCATION.',
    'git~1::$INDEX_ALLOCATION.',
    '.git::$INDEX_ALLOCATION .',
])
def test_trailing_dot_or_space_after_index_allocation_is_git_metadata(name):
    assert is_git_metadata_component(name) is True
    assert is_git_metadata_path('vendor/' + name) is True


@pytest.mark.parametrize('name', [
    '.gitignore',
    '.github',
    'something.git',
    '.git.bak',
    '.git::$DATA',
    '.git::$INDEX_ALLOCATION.txt',
])
def test_ordinary_names_are_not_git_metadata(name):
    assert is_git_metadata_component(name) is False
    assert is_git_metadata_path('vendor/' + name) is False
