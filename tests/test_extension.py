"""Adaptive interview length (Tony, 2026-10-31): 20 minutes planned, 30 hard, one polite offer to continue. The JS port is held to this by test/extension.vectors.json."""
import pytest
from atlas_voice import cascade, extension as x, selector
from atlas_voice.gaps import TIME_PLAN, time_plan

def test_20_minutes_planned_30_hard_with_a_proportional_closing_window():
    assert (cascade.INTERVIEW_LIMIT_S, x.INTERVIEW_HARD_S, cascade.SPEAKING_LIMIT_S, cascade.WRAP_S) == (1200, 1800, 800, 90)
    assert x.CLOSING_LEFT_S == TIME_PLAN['closing_left_s'] == selector.CONFIG['closing_left_s'] == 270 and selector.CONFIG['wrap_s'] == cascade.WRAP_S
    assert time_plan(1200, 'full') == {'depthAt': 540, 'closingAt': 930} and time_plan(x.hard_limit(1200), 'full')['closingAt'] == 1530
    assert x.hard_limit(1200) == 1800 and x.hard_limit(120) == 180

def test_the_offer_names_the_open_point_in_plain_words():
    assert x.offer_text('contribution', 'ask') == "We've covered most of it. Could we take a few more minutes on what you personally did?"
    assert x.offer_point(None, 'confirm_asr') == x.POINTS['_asr'] and x.offer_point(None, 'contradiction') == x.POINTS['_contradiction']
    assert x.offer_point('nonsense', 'ask') == x.POINTS['_other'] == x.offer_point('_asr', 'ask')

def test_the_offer_is_made_once_near_the_planned_end_to_a_consultant_in_no_hurry_and_only_while_a_question_is_still_essential():
    assert x.should_offer('ask', False, None, 270) and x.should_offer('confirm_asr', False, None, 100)
    assert not x.should_offer('ask', False, None, 271)           # not yet
    assert not x.should_offer('summary', False, None, 100) and not x.should_offer('close', False, None, 100)   # nothing essential is left: close early
    assert not x.should_offer('ask', True, None, 100)            # a hurry is never asked to stay
    for state in ('offered', 'accepted', 'refused'): assert not x.should_offer('ask', False, state, 100)       # at most once

@pytest.mark.parametrize('intents,words,want', [(['confirm'], 1, 'accepted'), ([], 6, 'refused'), ([], 5, 'refused'), (['confirm'], 14, 'accepted'), (['confirm'], 15, 'refused'), (['confirm'], None, 'refused'), ([], 40, 'refused'), (['deny'], 9, 'refused'), (['confirm', 'deny'], 3, 'refused'),
                                                (['rushed'], 12, 'refused'), (['stop'], 20, 'refused'), (['dont_know'], 8, 'refused'), ([], 0, 'refused'), (['pause'], 1, 'refused')])
# (v2.2 X2, red M9: a long reply with no refusing intent used to count as yes; now only an explicit short `confirm` does)
def test_only_a_clear_yes_extends(intents, words, want):
    assert x.reply(intents, words) == want

def test_config_accepts_up_to_the_wall_cap_and_defaults_to_the_planned_end():
    from atlas_voice.config import Config
    assert Config().duration == 1200
