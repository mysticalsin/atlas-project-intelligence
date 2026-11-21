"""The directory wait and the docx dependency, as the 1fc76c8 review asked."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_directory_wait_follows_the_painted_status():
    src = (ROOT / 'tests' / 'zero_config_browser.py').read_text()
    assert "get_by_text('only synthetic addresses').wait_for" in src


def test_python_docx_is_a_declared_test_dependency():
    assert 'python-docx' in (ROOT / 'requirements-test.txt').read_text()
