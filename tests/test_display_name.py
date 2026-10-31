"""X3 / red-team retest L2: a gateway session's display name never keeps a bidi control or a zero-width character.

The set is the same as INVISIBLE in deploy/cloudflare-edge/src/util.js (the edge strips it from sign-in names); the test reads that file so the two cannot drift."""
import re
from pathlib import Path

from atlas_voice.identity import Identity, display_name

ROOT = Path(__file__).resolve().parents[1]
RANGES = [(0x202A, 0x202E), (0x2066, 0x2069), (0x200B, 0x200D), (0x200E, 0x200F), (0x061C, 0x061C), (0x2060, 0x2060), (0xFEFF, 0xFEFF)]


def test_every_bidi_and_zero_width_character_is_stripped_and_the_rest_is_kept():
    for lo, hi in RANGES:
        for c in range(lo, hi + 1):
            assert display_name('Tony' + chr(c) + ' Walteur') == 'Tony Walteur', hex(c)
    assert display_name('‮moc.utnam@ynot') == 'moc.utnam@ynot'
    assert display_name('  Zoë   Lefèvre ') == 'Zoë Lefèvre'
    assert display_name('محمد علي') == 'محمد علي'
    assert display_name('x' * 300) == 'x' * 100


def test_a_session_is_issued_with_the_clean_name_or_the_default():
    class Cfg:
        max_sessions = 5
    ident = Identity.__new__(Identity)
    ident.config, ident.sessions = Cfg(), {}
    ident.sweep = lambda: None
    _, session = ident.issue('t', 'o', 'Eve ‮redli​')
    assert session.name == 'Eve redli'
    _, session = ident.issue('t', 'o', '‮​')
    assert session.name == 'Mantu colleague'


def test_the_python_set_matches_the_edge_set():
    js = (ROOT / 'deploy/cloudflare-edge/src/util.js').read_text()
    body = re.search(r'export const INVISIBLE = /\[(.*?)\]/g', js).group(1)
    codes = set()
    for a, b in re.findall(r'\\u([0-9A-F]{4})(?:-\\u([0-9A-F]{4}))?', body):
        codes.update(range(int(a, 16), int(b or a, 16) + 1))
    assert codes == {c for lo, hi in RANGES for c in range(lo, hi + 1)}
