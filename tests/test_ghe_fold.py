"""Cyrillic ghe with upturn is the letter that looks like g. The fold must read it as g."""
import unicodedata

from atlas_voice import privacy_config as pc
from atlas_voice.textfold import fold, plain

GHE = '\u0491'  # CYRILLIC SMALL LETTER GHE WITH UPTURN


def test_ghe_with_upturn_reads_as_g():
    assert unicodedata.name(GHE) == 'CYRILLIC SMALL LETTER GHE WITH UPTURN'
    assert fold(GHE) == 'g'
    assert fold(GHE + 'ood') == 'good'
    assert plain(GHE + 'ood') == 'good'
    assert fold('\u0261ood') == 'good'  # Latin script g stays g
    assert fold('\u0435') == 'e'  # Cyrillic ie still reads as e
    assert fold('\u0433') == '\u0433'  # ordinary Cyrillic ghe is a real letter and stays itself


def test_a_health_sentence_written_with_ghe_upturn_is_the_phrase_a_reader_sees():
    seen = 'I was dia' + GHE + 'nosed with fatigue'
    assert pc.special_categories(seen) == ['health']
    assert pc.special_categories('I was diagnosed with fatigue') == ['health']
    assert pc.special_categories('The patient had cancer') == ['health']
    # The same letter at the end of "cance" reads as g, so the word is not "cancer".
    assert pc.special_categories('The queue was cance' + GHE) == []
    assert pc.special_categories('A race condition and a union of two sets.') == []
