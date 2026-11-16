"""The trust browser must not assign a string to an HTML sink. The page requires TrustedHTML."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_trust_browser_injects_record_buttons_through_the_dom():
    src = (ROOT / 'tests' / 'trust_browser.py').read_text()
    assert 'insertAdjacentHTML' not in src
