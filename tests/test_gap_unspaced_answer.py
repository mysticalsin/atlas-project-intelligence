"""A gap answer in a script that does not space its words still counts.

Synthetic phrases only. No provider, Entra, Hindsight, or Teams calls.
"""
from atlas_voice.gaps import gap_guidance, gap_status

ASKS = [{'id': 'G1', 'field': 'outcome', 'label': 'Observed outcome', 'ask': 'Proof the bid needs: a measured change'}]


def status(text, attempts=0):
    return gap_status(ASKS, {'G1': attempts} if attempts else {}, {'G1': [text]}, [])[0]['status']


def test_chinese_japanese_and_thai_answers_count_letters():
    # "processing time fell from nine days to four" with no spaces between words
    chinese = '\u5904\u7406\u65f6\u95f4\u4ece\u4e5d\u5929\u964d\u5230\u4e86\u56db\u5929'
    japanese = '\u51e6\u7406\u6642\u9593\u3092\u4e5d\u65e5\u304b\u3089\u56db\u65e5\u306b\u77ed\u7e2e\u3057\u307e\u3057\u305f'
    thai = '\u0e40\u0e27\u0e25\u0e32\u0e08\u0e31\u0e14\u0e01\u0e32\u0e23\u0e25\u0e14\u0e08\u0e32\u0e01\u0e40\u0e01\u0e49\u0e32\u0e27\u0e31\u0e19\u0e40\u0e1b\u0e47\u0e19\u0e2a\u0e35\u0e48\u0e27\u0e31\u0e19'
    for text in (chinese, japanese, thai):
        assert ' ' not in text and status(text) == 'answered_unverified'
    rows = gap_status(ASKS, {}, {'G1': [japanese]}, [])
    plan = gap_guidance(ASKS, rows)
    assert plan['action'] == 'reflect_and_confirm' and plan['askId'] is None


def test_a_short_unspaced_reply_stays_open():
    assert status('\u306f\u3044') == 'open'
    assert status('\u7ed3\u679c\u662f\u4e5d\u65e5') == 'open'
    assert status('\u7ed3\u679c\u662f\u4e5d\u65e5\u4e86') == 'answered_unverified'
    assert status('\u306f\u3044', attempts=2) == 'deferred'


def test_spaced_languages_keep_the_whitespace_count():
    assert status('one two three four five') == 'open'
    assert status('one two three four five six') == 'answered_unverified'
    assert status('\uac00 \ub098 \ub2e4 \ub77c \ub9c8') == 'open'
    assert status('\uac00 \ub098 \ub2e4 \ub77c \ub9c8 \ubc14') == 'answered_unverified'


def test_an_unknown_phrase_still_beats_a_long_unspaced_answer():
    japanese = '\u51e6\u7406\u6642\u9593\u3092\u4e5d\u65e5\u304b\u3089\u56db\u65e5\u306b\u77ed\u7e2e\u3057\u307e\u3057\u305f'
    assert status(japanese + ' unknown') == 'unknown'
