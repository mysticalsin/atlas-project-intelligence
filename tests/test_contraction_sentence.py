"""A full stop after a contraction ends the sentence.

The letter after the apostrophe is not an initial, so the voice can speak
that sentence on its own.
"""
from atlas_voice.speech import Phrases, sentences


def test_a_contraction_before_a_full_stop_ends_the_sentence():
    assert sentences("I don't. Next") == (["I don't."], 'Next')
    assert sentences("I don't. ") == (["I don't."], '')
    assert sentences("We can't. Then") == (["We can't."], 'Then')
    assert sentences("We won't. And") == (["We won't."], 'And')
    assert sentences("That isn't. ") == (["That isn't."], '')
    assert sentences("It's. Next") == (["It's."], 'Next')
    assert sentences("I don\u2019t. Next") == (["I don\u2019t."], 'Next')
    spoken = Phrases()
    assert spoken.feed("I don't. ") == ["I don't."]
    assert spoken.flush() == []


def test_initials_and_abbreviations_still_keep_the_sentence_open():
    assert sentences('Dr. Patel led it. And') == (['Dr. Patel led it.'], 'And')
    assert sentences('We used A.I. to triage. Then we') == (['We used A.I. to triage.'], 'Then we')
    assert sentences('The U.S. team stayed. Next') == (['The U.S. team stayed.'], 'Next')
    assert sentences('1. We migrated. 2. We trained. 3') == (['1. We migrated.', '2. We trained.'], '3')
