"""Gap mode (the bid-proof interview), v2.2 U2 (Tony, 2026-10-31): the same challenge rule as the full interview (DECISION_LOG D-U2-7).
"I don't know", "no idea", "pass", "next question" get GAP_REANGLES easier angles on the same ask before it is recorded unknown; confidentiality is accepted at once;
no prompt invites a skip."""
import re

import pytest

from atlas_voice import gaps
from atlas_voice.gaps import GAP_NOTE, GAP_REANGLE, GAP_REANGLES, gap_guidance, gap_status

ASKS = [{'id': 'G1', 'field': 'outcome', 'label': 'Observed outcome', 'ask': 'x'}, {'id': 'G2', 'field': 'customer_fit', 'label': 'Customer relevance', 'ask': 'y'},
        {'id': 'G3', 'field': 'evidence', 'label': 'Supporting artifact', 'ask': 'z'}]
status = lambda turns, attempts, lang='en', ask=ASKS[0]: gap_status([ask], {ask['id']: attempts}, {ask['id']: turns}, [], lang)[0]


def test_the_gap_prompt_invites_no_skip_and_names_the_rule():
    assert not re.search(r"accept 'I don't know'", GAP_NOTE)
    assert 'never accept it at once and never tell them they may skip' in GAP_NOTE and 'ask the narrower angle in ANALYST_GUIDANCE (reangle), at most twice' in GAP_NOTE
    assert 'confidential or they cannot share it, accept that and move on' in GAP_NOTE
    for kind, angles in GAP_REANGLE.items():
        assert len(angles) == GAP_REANGLES
        for q in angles:
            assert q.count('?') == 1 and not re.search(r"skip|pass\b|leave it|don't have to|no need", q, re.I), q


@pytest.mark.parametrize('turns,attempts,expected', [
    (["I don't know"], 1, ('open', 1)), (["I don't know", 'no idea'], 2, ('open', 2)), (["I don't know", 'no idea', 'pass'], 3, ('unknown', 3)),
    (['pass', 'next question', 'skip it'], 3, ('unknown', 3)), (['no clue'], 1, ('open', 1)),
    (["I can't share that, it is under NDA"], 1, ('unknown', 0)), (["I don't know", 'It is confidential'], 2, ('unknown', 1)),
    (["I don't know", 'We cut the average handling time from nine to four days.'], 2, ('answered_unverified', 1)),
    (['Maybe.', 'Depends.'], 2, ('deferred', 0)), (["I don't know"], 3, ('open', 1)), (["I don't know"], 4, ('deferred', 1)),
])
def test_refusals_are_re_angled_before_an_ask_is_unknown(turns, attempts, expected):
    s = status(turns, attempts)
    assert (s['status'], s['refusals']) == expected


@pytest.mark.parametrize('lang,words', [('fr', ['je ne sais pas', 'je passe', 'question suivante']), ('es', ['no lo sé', 'paso', 'siguiente pregunta']), ('pt', ['não sei', 'passo', 'próxima pergunta']),
                                         ('de', ['weiß ich nicht', 'pass', 'nächste Frage']), ('it', ['non lo so', 'passo', 'prossima domanda']), ('nl', ['weet ik niet', 'ik pas', 'volgende vraag'])])
def test_the_seven_languages_are_challenged_too(lang, words):
    assert [status(words[:n], n, lang)['status'] for n in (1, 2, 3)] == ['open', 'open', 'unknown']


def test_guidance_asks_the_next_easier_angle_by_the_asks_field():
    for ask, kind in ((ASKS[0], 'numeric'), (ASKS[1], 'default'), (ASKS[2], 'proof')):
        plan = lambda turns, n: gap_guidance([ask], [status(turns, n, ask=ask)])
        assert 'reangle' not in plan([], 1) and plan([], 1)['why'] == gaps.GAP_WHY
        assert plan(["I don't know"], 1)['reangle'] == GAP_REANGLE[kind][0] and plan(["I don't know", 'pass'], 2)['reangle'] == GAP_REANGLE[kind][1]
        assert plan(["I don't know"], 1)['why'] == gaps.GAP_REANGLE_WHY and plan(["I don't know"], 1)['askId'] == ask['id'] and plan(["I don't know"], 1)['question'] == ask['ask']
        done = plan(["I don't know", 'pass', 'no idea'], 3)
        assert done['action'] == 'reflect_and_confirm' and 'reangle' not in done   # recorded unknown: the interview goes on to the next item


def test_a_hand_made_status_without_refusals_still_works():
    assert gap_guidance(ASKS[:1], [{'id': 'G1', 'status': 'open'}])['why'] == gaps.GAP_WHY
