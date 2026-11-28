"""A pilot coming out of testing is project speech, not a disclosure.

"coming out" on its own, and "coming out of the closet", still flag.
Synthetic sentences only. No provider call.
"""
from atlas_voice.privacy_config import special_categories


def test_a_pilot_coming_out_of_testing_is_not_a_disclosure():
    assert special_categories('The pilot is coming out of testing.') == []
    assert special_categories('Coming out of the pilot, the queue was shorter.') == []
    assert special_categories('I am coming out.') == ['sexual_orientation']
    assert special_categories('I had my coming-out last year.') == ['sexual_orientation']
    assert special_categories('Coming out of the closet was the sentence.') == ['sexual_orientation']
