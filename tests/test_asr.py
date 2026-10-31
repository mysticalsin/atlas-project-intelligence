"""Uncertain speech spans (atlas_voice/asr.py): numbers, percent/currency neighbours and proper nouns below the threshold."""
import pytest
from atlas_voice.asr import uncertain_spans, replacement, tau_from, TAU, MAX_WORDS, MAX_SPANS, EDGE_CONSTANTS


def w(spec, conf=0.95):
    out = []
    for i, tok in enumerate(spec.split()):
        word, _, c = tok.partition(':')
        out.append({'w': word, 'c': float(c) if c else conf, 's': round(i * 0.4, 3), 'e': round(i * 0.4 + 0.35, 3)})
    return out


def texts(spec, tau=TAU):
    return [(s['text'], s['kind']) for s in uncertain_spans(w(spec), tau)]


def test_number_words_merge_into_one_span_with_the_weakest_confidence_and_times():
    assert uncertain_spans(w('it took twenty:0.4 five:0.5 minutes')) == [{'text': 'twenty five', 'kind': 'number', 'min_conf': 0.4, 'start': 0.8, 'end': 1.55}]


def test_one_weak_word_flags_the_whole_number():
    assert texts('it took twenty five:0.2 minutes') == [('twenty five', 'number')]


def test_high_or_missing_confidence_gives_nothing():
    assert texts('it took twenty five minutes') == []
    assert uncertain_spans([{'w': 'five'}, {'w': 'Contoso'}]) == []        # no confidence is no evidence of doubt
    assert uncertain_spans([{'w': 'five', 'c': 'low'}, {'w': 'six', 'c': True}]) == []


def test_digits_percent_and_currency():
    assert texts('we saved 35:0.3 percent') == [('35 percent', 'number')]
    assert texts('we saved 35%:0.3 a year') == [('35%', 'number')]
    assert texts('it cost $ 5:0.4 million') == [('$ 5 million', 'number')]
    assert texts('we saved dirty:0.3 percent') == [('dirty percent', 'number')]    # a misheard figure next to a percent sign
    assert texts('we saved dirty:0.3 euros') == []                                  # only % and currency symbols make a neighbour suspect
    assert texts('in 2023:0.4 we moved') == [('2023', 'number')]


def test_two_figures_are_two_spans():
    assert texts('five:0.3 percent ten:0.4 percent') == [('five percent', 'number'), ('ten percent', 'number')]


def test_proper_nouns_must_not_start_a_sentence():
    assert texts('Contoso:0.2 hired us') == []
    assert texts('we worked with Contoso:0.4 on it') == [('Contoso', 'proper_noun')]
    assert texts('It was big. Then Contoso:0.3 signed') == [('Contoso', 'proper_noun')]
    assert texts('We hired Kyle:0.3 Johnson last year') == [('Kyle Johnson', 'proper_noun')]
    assert texts("I:0.2 led it and I'm:0.2 sure") == []


def test_threshold_is_strict_and_configurable():
    assert texts('we saved 35:0.55 percent') == []
    assert texts('we saved 35:0.5499 percent') == [('35 percent', 'number')]
    assert texts('we saved 35:0.45 percent', 0.4) == []
    assert texts('we saved 35:0.45 percent', 0.5) == [('35 percent', 'number')]


def test_numbers_come_first_then_the_weakest():
    assert [t for t, _ in texts('ten:0.4 Contoso:0.2 five:0.3')] == ['five', 'ten', 'Contoso']


def test_bounded_and_malformed_input_is_safe():
    assert len(uncertain_spans([{'w': '7' if i % 2 == 0 else 'x', 'c': 0.1} for i in range(MAX_WORDS * 3)])) <= MAX_SPANS
    for bad in (None, 'five', 7, {}, [None, 3, 'x', []], [{'w': 5, 'c': 0.1}]):
        assert uncertain_spans(bad) == []


def test_replacement_takes_the_last_figure_or_name():
    assert replacement('no, thirty five', 'number') == 'thirty five'
    assert replacement('it was thirty five minutes, not twenty five', 'number') == 'twenty five'
    assert replacement('no, it was Contoso', 'proper_noun') == 'Contoso'
    assert replacement('no', 'number') is None and replacement('no, it was Contoso', 'number') is None and replacement(None, 'number') is None


@pytest.mark.parametrize('raw,expected', [(None, TAU), ('0.3', 0.3), (' 0.7 ', 0.7), ('.5', 0.5), ('1', 1.0), (0.2, 0.2), ('0', TAU), ('2', TAU), ('-1', TAU), ('abc', TAU), ('1e-1', TAU), (True, TAU), ('', TAU)])
def test_tau_from_env_value(raw, expected):
    assert tau_from(raw) == expected


def test_edge_constants_are_namespaced_and_json_ready():
    import json
    assert all(k.startswith('ASR_') for k in EDGE_CONSTANTS) and json.dumps(EDGE_CONSTANTS)
