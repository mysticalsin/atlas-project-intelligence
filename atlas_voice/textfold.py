"""One normal form for matching text against word lists (v2.2 X2, red M10 / M13 / L12).

A guard that matches words must see the text as a reader sees it: compatibility forms folded (full-width letters, ligatures), invisible format
characters gone (zero width, soft hyphen, bidi marks), and letters of another script that look like Latin ones read as the Latin letter ("vеrified"
with a Cyrillic е is "verified"). fold() does exactly that, nothing more: it never rewrites the words themselves, it is only used to MATCH, and the
text that is voiced, shown or stored is never replaced by it. The word lists that are matched against folded text are folded the same way
(fold_list), so a word written in Cyrillic, Greek or Armenian still matches itself.

The confusable table is a small hand-made subset of UTS #39 (the letters that are visually identical in common fonts), not the full table: it is a
defence against the cheap tricks, and the deterministic bounds elsewhere (the policy gate, the bounded rerank merge) are what the system relies on.
The edge port of fold() moves to the interview slice with the phrase matcher that uses it.
Pure stdlib."""
import unicodedata

# lower-case letter of another script -> the lower-case Latin letter it looks like
CONFUSABLES = {
    # Cyrillic
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's',
    'ԁ': 'd', 'һ': 'h', 'ԛ': 'q', 'ԝ': 'w', 'ѵ': 'v', 'к': 'k', 'ӏ': 'l', 'ґ': 'g',  # U+0491 ghe with upturn looks like g
    # Greek
    'ο': 'o', 'ν': 'v', 'ρ': 'p', 'ι': 'i', 'α': 'a', 'κ': 'k', 'υ': 'u', 'χ': 'x',
    # Armenian and a few Latin look-alikes that NFKC leaves alone
    'օ': 'o', 'ս': 'u', 'ո': 'n', 'ı': 'i', 'ɑ': 'a', 'ɡ': 'g',
}
_TABLE = {ord(k): v for k, v in CONFUSABLES.items()}


def fold(text):
    """The text as a reader sees it, lower case: NFKC, invisible format characters (category Cf) removed, look-alike letters as the Latin letter."""
    t = unicodedata.normalize('NFKC', str(text if text is not None else ''))
    t = ''.join(c for c in t if unicodedata.category(c) != 'Cf')
    return t.lower().translate(_TABLE)


# Letters that NFKD does not take apart, written the way a plain keyboard would (so "straße" and "strasse" are one word).
_FLAT = {'\u00df': 'ss', '\u00e6': 'ae', '\u0153': 'oe', '\u00f8': 'o', '\u0142': 'l', '\u0111': 'd', '\u00f0': 'd', '\u00fe': 'th'}
_FLAT_TABLE = {ord(k): v for k, v in _FLAT.items()}


def plain(text):
    """fold() with accents removed as well (NFKD, every mark dropped, ß æ œ ø ł as plain letters): "Vérifié" and "verifie" are one word."""
    t = unicodedata.normalize('NFKD', fold(text))
    return ''.join(c for c in t if not unicodedata.category(c).startswith('M')).translate(_FLAT_TABLE)


def fold_list(words):
    """A word list folded the same way as the text it is matched against."""
    return [fold(w) for w in words]


EDGE_CONSTANTS = {'FOLD_CONFUSABLES': CONFUSABLES, 'FOLD_FLAT': _FLAT}
