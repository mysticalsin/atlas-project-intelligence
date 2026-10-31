"""Next-move selector (atlas_voice/selector.py): bank lint, priority rules, ladder, redundancy, repetition, phases, reactions, edge export."""
import copy
import json
import re
import time
from pathlib import Path

import pytest

from atlas_voice import persona, selector
from atlas_voice.persona import ACKS, BANNED_PRAISE_SRC
from atlas_voice.quality import FIELDS, InterviewLedger
from atlas_voice.selector import CONFIG, LINES, QUESTION_BANK, select
from atlas_voice.turns import analyze_turn

KEYS = ['kind', 'intent', 'field', 'rung', 'say', 'why', 'reaction', 'ack_category', 'bridge', 'hook']   # H1: bridge (topic change) and hook (their own words)
KINDS = {'ask', 'confirm_asr', 'reflect', 'summary', 'close', 'offer_move_on', 'accept_and_move'}
YES_NO_START = re.compile(r'^(?:did|do|does|is|are|was|were|have|has|had|can|could|will|would|should|shall|may)\b', re.I)
OPEN_INVITATION = re.compile(r'^could you (?:walk me through|tell me|give me)\b', re.I)


def turn(text, asked_field=None, lang='en'):
    return analyze_turn(text, lang, {'asked_field': asked_field} if asked_field else None)


def mv(plan=None, t=None, asked=None, prefill=None, phase='breadth', left=800, **kw):
    return select(plan or {}, t if t is not None else turn(''), asked or [], prefill or {}, phase, left, **kw)


def ledger_plan(*pairs):
    """A real ledger inspect() after recording (field, quote) pairs."""
    led = InterviewLedger()
    for i, (f, q) in enumerate(pairs):
        led.add_transcript(f't{i}', q)
        led.record({'details': [{'field': f, 'item_id': f't{i}', 'quote': q}]})
    return led.inspect()


def converse(utterances, prefill=None, rushed=False, phase='breadth', left=800, plan=None):
    """Drive select() turn by turn the way session.js will: analyse the answer (with the last asked field), select, log the move."""
    asked, out = [], []
    for text in utterances:
        last = asked[-1] if asked else None
        m = select(plan or {}, turn(text, last['field'] if last else None), asked, prefill or {}, phase, left, rushed=rushed)
        asked.append(m); out.append(m)
    return out


def walk(d):
    if isinstance(d, dict):
        for k, v in d.items():
            yield k
            yield from walk(v)
    elif isinstance(d, (list, tuple)):
        for v in d:
            yield from walk(v)


def question_sentence(say):
    return next(s for s in re.split(r'(?<=[.!?])\s+', say) if '?' in s)


# ---------- the bank ----------

def test_every_bank_entry_has_exactly_one_question_mark():
    assert QUESTION_BANK
    for intent, langs in QUESTION_BANK.items():
        assert 2 <= len(langs['en']) <= 4, intent   # H1: four where the pack toolkit adds a question (open_exploration, example, ownership, setback_response)
        for v in langs['en']:
            assert v.count('?') == 1 and v.rstrip().endswith('?'), (intent, v)


def test_bank_entries_are_open_short_and_praise_free():
    praise = re.compile(BANNED_PRAISE_SRC + r"|\b(?:great|wow|excellent|wonderful|perfect|impressive|fantastic)\b", re.I)
    for intent, langs in QUESTION_BANK.items():
        for v in langs['en']:
            assert not praise.search(v), (intent, v)
            assert len(v.split()) <= 25, (intent, v)
            if intent == 'confirm_asr':
                continue   # a fact check, closed by design
            q = question_sentence(v)
            # an either-or ("measured or estimated?") is not a yes/no question; an invitation to walk through is the pack's own wording
            assert not YES_NO_START.match(q) or OPEN_INVITATION.match(q) or ' or ' in q, (intent, v)


def test_confirm_asr_is_the_only_closed_bank_intent():
    assert all('{span}' in v for v in QUESTION_BANK['confirm_asr']['en'])
    assert not any('{span}' in v for k, e in QUESTION_BANK.items() if k != 'confirm_asr' for v in e['en'])


def test_closing_lines_are_statements_without_praise():
    for kind, langs in LINES.items():
        for v in langs['en']:
            assert '?' not in v and not re.search(BANNED_PRAISE_SRC, v, re.I), v


def test_every_candidate_intent_has_a_bank_entry():
    for f, fc in CONFIG['fields'].items():
        assert fc['intent'] in QUESTION_BANK and f in FIELDS
    for i in ('role', 'impact_assessment', 'anonymise', 'offer_move_on', 'asr_repair', 'reflect') + tuple(selector.METRIC_PARTS):
        assert i in QUESTION_BANK


def test_config_limits_match_the_pace_the_session_already_uses():
    from atlas_voice.cascade import WRAP_S
    from atlas_voice.gaps import TIME_PLAN
    assert CONFIG['wrap_s'] == WRAP_S and CONFIG['closing_left_s'] == TIME_PLAN['closing_left_s']
    assert selector.PHASES == ['breadth', 'depth', 'closing', 'wrap']
    assert all(isinstance(v, int) for fc in CONFIG['fields'].values() for k, v in fc.items() if k != 'intent')


def test_ack_categories_used_exist_in_persona():
    seen = set()
    for text in ['we cut costs by 30%', 'sorry it was 35 not 38', "I don't know", "I can't share the client", 'the pilot failed', 'okay thanks for asking that, we did a lot']:
        m = mv(t=turn(text), asked=[{'intent': 'impact', 'field': 'outcome', 'rung': 6, 'say': 'x'}])
        if m['ack_category']:
            seen.add(m['ack_category'])
    assert seen and seen <= set(ACKS)


# ---------- shape ----------

def test_move_has_exactly_the_documented_keys_and_no_score_anywhere():
    for m in [mv(), mv(t=turn('I helped improve the platform')), mv(t=turn("I don't know")), mv(asr=[{'text': '45', 'kind': 'number'}]), mv(phase='wrap'), mv(t=turn("that's all for now"))]:
        assert list(m) == KEYS and m['kind'] in KINDS
        assert not any('score' in str(k).lower() or 'rank' in str(k).lower() for k in walk(m))
    assert not any('score' in k.lower() for k in walk({k: v for k, v in selector.EDGE_CONSTANTS.items()}))


def test_select_is_pure_and_deterministic():
    plan = ledger_plan(('problem', 'Reports took two days every month'))
    t = turn('about 80% faster', 'outcome')
    asked = [{'intent': 'impact', 'field': 'outcome', 'rung': 6, 'say': 'What changed?', 'why': 'ladder:outcome', 'kind': 'ask'}]
    snapshot = copy.deepcopy((plan, t, asked))
    first = select(plan, t, asked, {'role': 'x'}, 'breadth', 700)
    assert all(select(plan, t, asked, {'role': 'x'}, 'breadth', 700) == first for _ in range(5))
    assert (plan, t, asked) == snapshot


def test_malformed_inputs_never_raise():
    for args in [(None, None, None, None, None, None), ('x', 5, 'y', [], 'nope', 'soon'), ({}, {'intents': 'pause', 'field_hints': [1], 'words': 'x'}, [None, 3, {}], {'prior_notes': 7}, 'depth', True),
                 ({'candidate_details': [None, {'field': 'zzz'}]}, {}, [{'field': 'problem', 'why': 3}], [], 'closing', -5)]:
        m = select(*args, asr=[None, {'text': 3}, 'x'])
        assert list(m) == KEYS


# ---------- priority rules ----------

def test_vague_verb_asks_for_an_example_then_ownership():
    first = mv(t=turn('I helped improve the platform'))
    assert (first['kind'], first['intent'], first['rung']) == ('ask', 'vague_example', 2) and first['why'].startswith('vague:example')
    second = mv(t=turn('We rebuilt the nightly batch job so it ran in parallel'), asked=[first])
    assert (second['intent'], second['field'], second['rung']) == ('ownership', 'contribution', 3) and second['why'].startswith('vague:ownership')


def test_metric_asks_measured_vs_estimate_then_period_one_part_per_move():
    plan = {}
    first = mv(t=turn('it was 80% faster'))
    assert first['intent'] == 'metric_kind' and first['say'].count('?') == 1
    second = mv(t=turn('We measured it'), asked=[first])
    assert second['intent'] == 'metric_period' and second['say'].count('?') == 1
    third = mv(t=turn('Over three months'), asked=[first, second])
    assert third['intent'] == 'metric_baseline'
    fourth = mv(t=turn('It used to take two days'), asked=[first, second, third])
    assert fourth['intent'] == 'metric_source'
    for m in (first, second, third, fourth):
        assert m['field'] == 'measurement' and m['rung'] == 7


def test_metric_already_labelled_an_estimate_skips_the_kind_question():
    m = mv(t=turn('about 80% faster'))
    assert m['intent'] == 'metric_period' and m['ack_category'] in (None, 'promising_unverified')


def test_metric_basis_from_the_ledger_is_not_asked_again():
    plan = ledger_plan(('outcome', 'It dropped from 2 days to 25 minutes'),
                       ('measurement', 'Median duration measured before and after over three months in 2024 for the finance team report queue, 2 days then 25 minutes'))
    assert not plan['measurement_gaps']
    m = mv(plan, turn('we cut the run time by 80%'))
    assert m['intent'] not in selector.METRIC_PARTS or m['intent'] == 'metric_source'


def test_dont_know_is_accepted_the_field_stays_open_and_is_never_re_asked():
    asked = [{'kind': 'ask', 'intent': 'impact', 'field': 'outcome', 'rung': 6, 'say': 'What changed?', 'why': 'ladder:outcome', 'reaction': 'none', 'ack_category': None}]
    m = mv(t=turn("I don't know", 'outcome'), asked=asked)
    assert m['kind'] == 'accept_and_move' and m['why'].startswith('dont_know:outcome') and m['field'] != 'outcome'
    assert m['reaction'] == 'ack' and m['ack_category'] in ('no_number_fine', 'neutral') and m['say'].count('?') == 1
    # every later move, whatever the turn says, leaves outcome alone (even when the ledger has not recorded the "I don't know" yet)
    asked.append(m)
    for text in ['we used the old process', 'it was a legacy batch system with a backlog of complaints and manual steps', 'I led the design of the pipeline', 'about 40% faster', 'okay']:
        n = mv(t=turn(text, m['field']), asked=asked)
        assert n['field'] != 'outcome' and n['intent'] not in ('impact', 'impact_assessment'), (text, n)
        asked.append(n)


def test_dont_know_from_the_ledger_marks_the_field_open_too():
    plan = ledger_plan(('problem', 'Reports took two days'), ('measurement', "We don't know the baseline, it was never measured"))
    assert 'measurement' in plan['unresolved_fields']
    for text in ['about 80% faster', 'it dropped from 2 days to 25 minutes']:
        m = mv(plan, turn(text))
        assert m['field'] != 'measurement' and m['intent'] not in selector.METRIC_PARTS


def test_cannot_disclose_is_accepted_and_offers_a_general_description_once():
    asked = [{'kind': 'ask', 'intent': 'open_exploration', 'field': 'problem', 'rung': 1, 'say': 'Could you tell me about the project?', 'why': 'ladder:problem'}]
    m = mv(t=turn("I can't share the client name", 'problem'), asked=asked)
    assert (m['kind'], m['intent'], m['field']) == ('accept_and_move', 'anonymise', 'problem') and m['ack_category'] == 'confidential_ok'
    assert m['why'].startswith('cannot_disclose:problem')
    again = mv(t=turn("I really can't say", 'problem'), asked=asked + [m])
    assert again['intent'] != 'anonymise' and again['field'] != 'problem'


def test_correction_thanks_and_narrows_with_their_version():
    asked = [{'kind': 'ask', 'intent': 'ownership', 'field': 'contribution', 'rung': 3, 'say': 'x?'}]
    m = mv(t=turn("I didn't lead the whole project, I meant only the data migration", 'contribution'), asked=asked)
    assert m['kind'] == 'accept_and_move' and m['intent'] == 'correction' and m['field'] == 'contribution'
    assert m['reaction'] == 'ack' and m['ack_category'] == 'correction_thanks' and 'your version' in m['say'] or 'narrow' in m['say']
    n = mv(t=turn('sorry, it was 35 not 38', 'measurement'), asked=[{'intent': 'metric_period', 'field': 'measurement', 'rung': 7, 'say': 'x?'}])
    assert n['intent'] == 'correction_number' and n['ack_category'] == 'correction_thanks'
    assert '35' not in n['say'] and '38' not in n['say']   # it never repeats or picks a number for them


def test_contradiction_shows_both_versions_neutrally_and_never_picks():
    plan = ledger_plan(('outcome', 'It takes 25 minutes now'), ('outcome', 'The report now takes 40 minutes'))
    m = mv(plan, turn('okay'))
    assert (m['intent'], m['field'], m['kind']) == ('contradiction', 'outcome', 'ask') and m['why'] == 'contradiction:outcome'
    assert '25 minutes' in m['say'] and '40 minutes' in m['say'] and m['say'].count('?') == 1
    assert not re.search(r'\b(?:correct|actually|really|right one|wrong|mistake|sure)\b', m['say'], re.I)
    assert m['reaction'] == 'none'
    # reversed order of the two accounts: both still present, neither favoured
    plan2 = ledger_plan(('outcome', 'The report now takes 40 minutes'), ('outcome', 'It takes 25 minutes now'))
    m2 = mv(plan2, turn('okay'))
    assert '25 minutes' in m2['say'] and '40 minutes' in m2['say']


def test_contradiction_needs_numbers_that_really_differ():
    same = ledger_plan(('outcome', 'It takes 25 minutes now'), ('outcome', 'About 25 minutes per run'))
    assert selector.contradiction(same) is None
    superset = ledger_plan(('outcome', 'It dropped from 2 days to 25 minutes'), ('outcome', 'It takes 25 minutes'))
    assert selector.contradiction(superset) is None
    different_fields = ledger_plan(('outcome', 'It takes 25 minutes'), ('problem', 'It took 2 days'))
    assert selector.contradiction(different_fields) is None
    assert selector.contradiction(ledger_plan(('outcome', 'a 30% saving'), ('outcome', 'a 12% saving')))[0] == 'outcome'


def test_team_claim_asks_for_their_part_without_diminishing_the_team():
    m = mv(t=turn('we delivered the migration'))
    assert m['intent'] == 'team_ownership' and m['field'] == 'contribution' and m['rung'] == 3
    assert not re.search(r'\bonly\b|\bjust\b|\bnot the team\b', m['say'], re.I)
    assert mv(t=turn('we delivered the migration'), prefill={'prior_notes': {'contribution': 'I led the data stream'}})['intent'] != 'team_ownership'


def test_a_deferred_field_silences_the_cue_repairs_that_target_it():
    def deferred(field): return [{'kind': 'accept_and_move', 'intent': 'x', 'field': 'other', 'rung': 1, 'say': 'filler about nothing?', 'why': f'dont_know:{field}>ladder:problem'}]
    assert mv(t=turn('I helped improve the platform'))['intent'] == 'vague_example'
    assert mv(t=turn('I helped improve the platform'), asked=deferred('intervention'))['intent'] != 'vague_example'
    assert mv(t=turn('we delivered the migration'), asked=deferred('contribution'))['intent'] != 'team_ownership'
    assert mv(t=turn('about 80% faster'), asked=deferred('measurement'))['intent'] not in selector.METRIC_PARTS


def test_tech_list_certification_and_client_praise_follow_ups():
    assert mv(t=turn('we used Python, Kafka and Terraform'))['intent'] == 'tech_depth'
    cert = mv(t=turn('I am AWS Solutions Architect certified'))
    assert cert['intent'] == 'cert_details' and 'issued' in cert['say']
    praise = mv(t=turn('the client said it was the best team they had'))
    assert praise['intent'] == 'praise_source' and re.search(r'\bwho\b|\bwhere\b', praise['say'], re.I)
    assert 'best team' not in praise['say']   # never repeats or quotes the praise


def test_priority_order_between_cues():
    # metric beats vague verb, vague verb beats team claim, team claim beats a tech list
    assert mv(t=turn('I helped cut costs by 30%'))['intent'] in selector.METRIC_PARTS
    assert mv(t=turn('I helped with the migration'))['intent'] == 'vague_example'
    assert mv(t={'intents': [], 'cues': ['team_claim', 'tech_list', 'certification', 'client_praise'], 'field_hints': [], 'numbers': [], 'words': 9})['intent'] == 'team_ownership'
    assert mv(t={'intents': [], 'cues': ['tech_list', 'certification', 'client_praise'], 'field_hints': [], 'numbers': [], 'words': 9})['intent'] == 'tech_depth'
    assert mv(t={'intents': [], 'cues': ['certification', 'client_praise'], 'field_hints': [], 'numbers': [], 'words': 9})['intent'] == 'cert_details'
    assert mv(t={'intents': [], 'cues': ['client_praise'], 'field_hints': [], 'numbers': [], 'words': 9})['intent'] == 'praise_source'
    # contradiction beats a metric cue; a correction and "I don't know" beat every cue
    plan = ledger_plan(('outcome', 'It takes 25 minutes now'), ('outcome', 'The report now takes 40 minutes'))
    assert mv(plan, turn('about 80% faster'))['intent'] == 'contradiction'
    assert mv(plan, turn("sorry I meant 30% faster"))['kind'] == 'accept_and_move'
    assert mv(plan, turn("I don't know"))['kind'] == 'accept_and_move'


def test_uncertain_asr_span_is_confirmed_first_and_once():
    asr = [{'text': 'forty-five percent', 'kind': 'number'}, {'text': 'Contoso', 'kind': 'name'}]
    plan = ledger_plan(('outcome', 'It takes 25 minutes now'), ('outcome', 'The report now takes 40 minutes'))
    m = mv(plan, turn('we cut it by forty-five percent'), asr=asr)
    assert (m['kind'], m['intent']) == ('confirm_asr', 'confirm_asr') and 'forty-five percent' in m['say'] and m['say'].count('?') == 1
    assert m['say'].startswith('Just to check I heard right: was that')
    assert m['reaction'] == 'none'
    n = mv(plan, turn('yes'), asked=[m], asr=asr)
    assert n['kind'] == 'confirm_asr' and 'Contoso' in n['say'] and 'forty-five' not in n['say']
    done = mv(None, turn('yes'), asked=[m, n], asr=asr)
    assert done['kind'] != 'confirm_asr'
    assert mv(asr=[{'text': 'x?{y}\n', 'kind': 'name'}])['say'].count('?') == 1   # a span cannot add a question mark or break the template


def test_a_denied_asr_check_gets_one_repair_question():
    asked = [mv(asr=[{'text': '45', 'kind': 'number'}])]
    m = mv(t=turn("no, that's wrong"), asked=asked)
    assert m['intent'] == 'asr_repair' and m['say'].count('?') == 1
    assert mv(t=turn("no, that's wrong"), asked=asked + [m])['intent'] != 'asr_repair'


def test_stop_goes_to_summary_then_close():
    s = mv(t=turn("that's all for now"))
    assert s['kind'] == 'summary' and s['say'].count('?') == 0
    c = mv(t=turn("that's all for now"), asked=[s])
    assert c['kind'] == 'close' and '?' not in c['say']
    assert mv(t=turn('yes'), asked=[s])['kind'] == 'close'


# ---------- ladder, thread and redundancy ----------

def test_ladder_starts_with_open_exploration_then_follows_the_thread_not_dict_order():
    first = mv()
    assert (first['intent'], first['field'], first['rung']) == ('open_exploration', 'problem', 1)
    # the consultant jumped ahead to a decision: the next question continues from there, not from the top of FIELDS
    t = turn('We chose Kafka instead of RabbitMQ because we considered the trade-offs and the alternatives carefully', 'problem')
    assert 'decision' in t['field_hints']
    m = mv(None, t, asked=[first])
    assert m['field'] not in ('problem', 'decision')
    assert CONFIG['fields'][m['field']]['rung'] >= 5 or m['field'] == 'contribution'


def test_ladder_climbs_from_example_to_ownership_to_impact():
    out = converse(['hello there', 'We were modernising the reporting platform for the finance department', 'We rebuilt the nightly job so reports ran in parallel across regions',
                    'I designed the pipeline and wrote the validation rules myself'])
    assert [m['field'] for m in out][:4] == ['problem', 'intervention', 'contribution', 'outcome'] or out[2]['field'] == 'contribution'
    assert out[0]['rung'] == 1 and out[1]['rung'] == 2 and out[2]['rung'] == 3
    assert out[1]['intent'] == 'example' and out[3]['intent'] == 'impact'


def test_field_covered_by_this_turns_hints_is_not_selected_stale_lag_regression():
    # The ledger has not recorded this answer yet (the analyst lags a turn), but the pre-pass already sees it.
    t = turn('I personally led the design and I owned the cutover plan', None)
    assert 'contribution' in t['field_hints']
    plan = {'candidate_details': [], 'missing': list(FIELDS)}
    for phase in ('breadth', 'depth'):
        m = mv(plan, t, phase=phase)
        assert m['field'] != 'contribution' and m['intent'] not in ('ownership', 'role', 'team_ownership')
    # the field the last question was about is covered by an answer-shaped reply (turns.analyze_turn adds it to the hints when given context)
    asked = [{'kind': 'ask', 'intent': 'open_exploration', 'field': 'problem', 'rung': 1, 'say': 'What was the main problem?', 'why': 'ladder:problem'}]
    assert mv(None, turn('Reports took too long and the data kept being inconsistent', 'problem'), asked=asked)['field'] != 'problem'
    # a non-answer does not count as covering it: the same question is put again, and that is not a second attempt
    again = mv(None, turn('what do you mean by problem?'), asked=asked)
    assert (again['field'], again['intent'], again['say'], again['why']) == ('problem', 'open_exploration', asked[0]['say'], 'repeat_last')
    assert mv(None, turn("can we pause for a sec"), asked=asked + [again, again])['why'] == 'repeat_last'
    # putting the question again twice is not two attempts: with only this field left, the next real try is attempt two (a new wording), not the offer
    only_problem_left = {'candidate_details': [], 'covered_fields': [f for f in FIELDS if f != 'problem']}
    second = select(only_problem_left, turn('hmm', 'problem'), asked + [again, again], {}, 'breadth', 800)
    assert (second['kind'], second['field'], second['why']) == ('ask', 'problem', 'ladder:problem') and second['say'] == QUESTION_BANK['open_exploration']['en'][1]


def test_covered_fields_from_earlier_turns_are_not_asked_either():
    plan = {'candidate_details': [], 'covered_fields': ['problem', 'contribution', 'outcome']}
    out = converse(['a', 'b'], plan=plan)
    assert all(m['field'] not in ('problem', 'contribution', 'outcome') for m in out)


def test_prefilled_role_is_never_asked_and_other_prefill_is_not_re_asked():
    prefill = {'role': 'Data engineer', 'sector': 'Retail', 'stage': 'Delivered', 'oppId': 'OPP-1',
               'prior_notes': {'problem': 'legacy batch jobs', 'outcome': 'faster reporting'}}
    out = converse(['', 'x ' * 5, 'it went fine and we were happy', 'we used a pipeline and checks', 'ok that is fine', 'right', 'sure okay'] * 2, prefill=prefill)
    for m in out:
        assert m['intent'] != 'role' and 'your role' not in m['say'] and 'own role' not in m['say']
        assert m['field'] not in ('problem', 'outcome'), m
    assert any(m['intent'] == 'ownership' for m in out)           # the personal part is still asked, as ownership
    no_prefill = converse([''])
    first_contribution = next(m for m in converse(['', 'We were modernising a billing platform for a retailer', 'The batch jobs got moved to Kafka last spring and the nightly job was rebuilt']) if m['field'] == 'contribution')
    assert first_contribution['intent'] == 'role' and no_prefill


def test_assessment_stage_asks_for_the_decision_not_an_implementation_benefit():
    plan = {'candidate_details': [], 'covered_fields': ['problem', 'contribution', 'intervention', 'decision', 'stakes', 'adoption']}
    m = mv(plan, turn('we ran the assessment over two weeks'), prefill={'stage': 'Assessment'})
    assert m['field'] == 'outcome' and m['intent'] == 'impact_assessment'
    assert mv(plan, turn('we ran the assessment over two weeks'), prefill={'stage': 'Delivered'})['intent'] == 'impact'


def test_known_fields_in_the_ledger_are_not_asked_again():
    plan = ledger_plan(('problem', 'Reports took two days'), ('contribution', 'I owned the pipeline'), ('outcome', 'They run in 25 minutes'))
    m = mv(plan, turn('okay'))
    assert m['field'] not in ('problem', 'contribution', 'outcome')


def test_weights_are_integers_in_config_and_change_the_order(monkeypatch):
    base = mv()['field']
    assert base == 'problem'
    monkeypatch.setitem(CONFIG['fields']['problem'], 'value', 0)
    assert mv()['field'] != 'problem'
    monkeypatch.setitem(CONFIG['fields']['problem'], 'value', 5)
    assert mv()['field'] == 'problem'
    monkeypatch.setitem(CONFIG['fields']['problem'], 'effort', 30)   # a heavy effort cost pushes the first question elsewhere
    assert mv()['field'] != 'problem'


# ---------- never a third time ----------

def test_the_third_time_is_blocked_and_the_selector_offers_to_move_on():
    only_problem_left = {'candidate_details': [], 'covered_fields': [f for f in FIELDS if f != 'problem']}
    asked = []
    for i in range(2):
        m = select(only_problem_left, turn('hmm', asked[-1]['field'] if asked else None), asked, {}, 'breadth', 800)
        assert (m['kind'], m['field']) == ('ask', 'problem')
        asked.append(m)
    assert asked[0]['say'] != asked[1]['say'] and asked[0]['intent'] == asked[1]['intent'] == 'open_exploration'
    third = select(only_problem_left, turn('hmm', 'problem'), asked, {}, 'breadth', 800)
    assert third['kind'] == 'offer_move_on' and third['field'] == 'problem' and third['why'] == 'blocked:open_exploration:problem' and third['say'].count('?') == 1
    # once offered, the point is closed: nothing asks about it again, whatever comes next
    asked.append(third)
    for _ in range(4):
        n = select(only_problem_left, turn('hmm'), asked, {}, 'breadth', 800)
        asked.append(n)
        assert n['field'] != 'problem' and n['kind'] in ('summary', 'close')


def test_the_third_time_is_blocked_for_a_cue_repair_without_an_offer():
    # a cue repair (here: vague verb) that was asked twice is dropped quietly; only ladder, metric and contradiction points offer to move on
    base = {'kind': 'ask', 'intent': 'vague_example', 'field': 'intervention', 'rung': 2, 'why': 'vague:example'}
    asked = [{**base, 'say': 'Could you give me one concrete example of what that involved?'}, {**base, 'say': 'What did that look like for one specific piece of work?'}]
    m = mv(t=turn('I helped with the migration'), asked=asked + [{'intent': 'x', 'field': None, 'say': 'filler about nothing', 'why': 'x'}])
    assert m['intent'] != 'vague_example' and m['kind'] != 'offer_move_on'


def test_no_intent_is_ever_asked_three_times_in_a_long_stalled_conversation():
    out = converse(['hmm', 'mm', 'ok', 'hm', 'uh huh'] * 8)
    counts = {}
    for m in out:
        if m['kind'] in ('ask', 'accept_and_move'):
            counts[(m['intent'], m['field'])] = counts.get((m['intent'], m['field']), 0) + 1
    assert counts and max(counts.values()) <= 2, counts
    assert any(m['kind'] == 'offer_move_on' for m in out)


def test_each_metric_part_is_asked_at_most_once():
    out = converse(['we cut costs by 30%', 'hm', 'hm', 'we saved about 20% more', 'ok', 'it was 12% better', 'hm', 'hm', 'hm'])
    parts = [m['intent'] for m in out if m['intent'] in selector.METRIC_PARTS]
    assert parts == ['metric_kind', 'metric_period', 'metric_baseline', 'metric_source']


# ---------- rushed ----------

def test_rushed_asks_only_the_essentials_and_accepts_gaps():
    out = converse(['I only have five minutes', 'The project was a billing migration for a retailer', 'I designed the cutover plan and wrote the scripts, I did',
                    'Latency fell and nobody complained afterwards', 'we used Python, Kafka and Terraform', 'we cut costs by 30%'], rushed=True,
                   plan={'candidate_details': [], 'covered_fields': ['problem', 'contribution', 'outcome']})
    assert out[0]['kind'] == 'summary' and out[0]['why'].startswith('summary:essentials')
    out = converse(['I only have five minutes', 'a billing migration for a retailer', 'I wrote the scripts, I did', 'Latency fell and nobody complained afterwards', 'we used Python, Kafka and Terraform'], rushed=True)
    asks = [m for m in out if m['kind'] == 'ask']
    assert asks and all(m['field'] in ('problem', 'contribution', 'outcome') for m in asks)
    assert not any(m['intent'] in selector.METRIC_PARTS + ['tech_depth', 'reflect', 'cert_details'] for m in out)
    assert asks[0]['say'].startswith("No problem, let's keep it to three things") and sum(m['say'].startswith("No problem") for m in out) == 1
    assert all(m['why'].startswith('rushed:') for m in asks)


def test_rushed_intent_in_the_turn_switches_it_on_without_the_flag():
    m = mv(t=turn("I'm in a hurry, can we keep this short"))
    assert m['field'] == 'problem' and m['say'].startswith("No problem, let's keep")
    assert mv(t=turn('we cut costs by 30%'), rushed=True)['field'] in ESS


ESS = ('problem', 'contribution', 'outcome')


# ---------- phase and time ----------

def test_phase_and_time_map_to_the_existing_pace():
    assert selector.effective_phase('breadth', 800) == 'breadth' and selector.effective_phase('depth', 800) == 'depth'
    assert selector.effective_phase('breadth', 210) == 'closing' and selector.effective_phase('breadth', 211) == 'breadth'
    assert selector.effective_phase('breadth', 75) == 'wrap' and selector.effective_phase('closing', 500) == 'closing'
    assert selector.effective_phase('depth', 10) == 'wrap' and selector.effective_phase(None, None) == 'breadth' and selector.effective_phase('junk', True) == 'breadth'


def test_wrap_closes_with_no_question_even_with_an_uncertain_span():
    m = mv(t=turn('we cut costs by 30%'), phase='wrap', asr=[{'text': '30', 'kind': 'number'}])
    assert (m['kind'], m['reaction']) == ('close', 'none') and '?' not in m['say'] and m['why'] == 'close:wrap'
    assert mv(left=60)['kind'] == 'close'


def test_closing_phase_asks_only_the_essentials_then_summary_then_close():
    m = mv(t=turn('we used Python, Kafka and Terraform and it was about 80% faster'), left=200)
    assert m['kind'] == 'ask' and m['field'] in ESS and m['intent'] not in selector.METRIC_PARTS + ['tech_depth']
    plan = {'candidate_details': [], 'covered_fields': list(ESS)}
    s = mv(plan, turn('we used Python'), left=200)
    assert s['kind'] == 'summary' and s['why'] == 'summary:closing'
    assert mv(plan, turn('and also the team was great at testing and review'), asked=[s], left=190)['kind'] == 'close'


def test_depth_phase_reflects_once_when_enough_is_known():
    plan = ledger_plan(('problem', 'Reports took two days'), ('contribution', 'I owned the pipeline'), ('outcome', 'They run in 25 minutes'))
    m = mv(plan, turn('okay'), phase='depth')
    assert m['kind'] == 'reflect' and m['say'].count('?') == 1 and 'customer problem' in m['say'] and 'Reports took' not in m['say']
    n = mv(plan, turn('we also added alerts to the job and trained the support team'), asked=[m], phase='depth')
    assert n['kind'] != 'reflect'
    assert mv(plan, turn('okay'), phase='breadth')['kind'] != 'reflect'


def test_nothing_left_goes_to_summary_then_close():
    plan = {'candidate_details': [], 'covered_fields': list(FIELDS)}
    s = mv(plan, turn('okay'))
    assert s['kind'] == 'summary' and s['why'] == 'summary:no_candidates'
    assert mv(plan, turn('okay'), asked=[s])['kind'] == 'close'


# ---------- reactions ----------

def test_setback_turn_gets_setback_neutral_never_earned_result():
    plan = ledger_plan(('measurement', 'Median duration measured before and after over three months in 2024 for the finance team queue, 30 then 12 minutes'))
    for text in ['the pilot failed and we had to roll back', 'we delivered the new platform but the first launch failed and we rolled back', 'we cut costs by 30% after the outage and rollback']:
        for p in ({}, plan):
            m = mv(p, turn(text))
            assert m['reaction'] == 'ack' and m['ack_category'] == 'setback_neutral', (text, m)


def test_earned_result_needs_an_achievement_cue_and_a_known_basis():
    plan = ledger_plan(('outcome', 'It dropped from 2 days to 25 minutes'),
                       ('measurement', 'Median duration measured before and after over three months in 2024 for the finance team report queue, 2 days then 25 minutes'))
    assert not plan['measurement_gaps']
    t = turn('we delivered the migration and reduced the ticket backlog')
    assert 'describes_achievement' in t['cues']
    assert mv(plan, t)['ack_category'] == 'earned_result' and mv(plan, t)['reaction'] == 'earned'
    assert mv({}, t)['ack_category'] != 'earned_result'                              # basis not known
    unverified = mv({}, turn('it was 80% faster after we delivered it'))
    assert unverified['ack_category'] == 'promising_unverified'
    recent = [{'intent': 'impact', 'field': 'outcome', 'rung': 6, 'say': 'a?', 'reaction': 'earned'}]
    assert mv(plan, t, asked=recent)['ack_category'] != 'earned_result'               # at most one in three


def test_reactions_are_none_for_checks_closings_and_offers():
    asr = mv(asr=[{'text': '45', 'kind': 'number'}], t=turn('we cut costs by 45% over about six months this year'))
    assert asr['reaction'] == 'none' and asr['ack_category'] is None
    assert mv(phase='wrap')['reaction'] == 'none'
    for m in converse(['we did a lot of things on that project over the years in many ways'] * 6):
        assert (m['reaction'] == 'none') == (m['ack_category'] is None)
        assert m['ack_category'] in (None, *ACKS)


def test_detail_answers_get_thanks_detail_and_short_ones_none():
    long = turn('We moved the batch jobs from the old scheduler to Kafka last spring, then rebuilt the nightly reconciliation so that regional reports no longer waited for each other')
    assert mv(t=long)['ack_category'] == 'thanks_detail'
    assert mv(t=turn('yes it did'))['reaction'] == 'none'


# ---------- repetition ----------

def test_a_question_too_close_to_a_recent_one_uses_the_next_variant():
    v = QUESTION_BANK['open_exploration']['en']
    asked = [{'kind': 'ask', 'intent': 'something_else', 'field': None, 'rung': None, 'say': v[0]}]
    m = mv(asked=asked)
    assert m['intent'] == 'open_exploration' and m['say'] == v[1] and m['why'] == 'ladder:problem+rv'
    assert selector.similar(v[0], v[0]) and not selector.similar(v[0], v[1])


def test_all_variants_recent_moves_to_the_next_intent():
    v = QUESTION_BANK['open_exploration']['en']
    asked = [{'kind': 'ask', 'intent': 'something_else', 'field': None, 'rung': None, 'say': s} for s in v]
    m = mv(asked=asked)
    assert m['field'] != 'problem' and m['why'].endswith('+ri')


def test_jaccard_threshold_is_about_eighty_percent_on_word_trigrams():
    a = 'could you walk me through what was happening before the project started'
    assert selector.similar(a, a.upper() + '!')
    assert selector.similar(a, a + ' today')                                   # 8 of 9 trigrams shared
    assert not selector.similar(a, 'what was the main problem the team needed to solve')
    assert not selector.similar('', a) and not selector.similar('hi', 'ho')
    assert selector.similar('hello there', 'Hello, there.')                   # fewer than three words compare as a whole


def test_jaccard_boundary_exactly_eighty_percent_counts_as_a_repeat():
    only_contribution = {'candidate_details': [], 'covered_fields': [f for f in FIELDS if f != 'contribution']}
    full = QUESTION_BANK['role']['en'][0]
    assert full == 'What was your role on the project?'
    # "What was your role on the" holds 4 of the 5 word 3-grams: exactly 0.8
    m = mv(only_contribution, turn(''), asked=[{'intent': 'q', 'field': None, 'rung': None, 'say': 'What was your role on the'}])
    assert m['say'] == QUESTION_BANK['role']['en'][1] and m['why'].endswith('+rv')
    assert mv(only_contribution, turn(''), asked=[{'intent': 'q', 'field': None, 'rung': None, 'say': 'What was your role'}])['say'] == full   # 3 of 5: not a repeat


def test_vague_verb_stays_quiet_after_two_examples_and_an_ownership_question():
    vq = {'kind': 'ask', 'intent': 'vague_example', 'field': 'intervention', 'rung': 2, 'why': 'vague:example'}
    asked = [{**vq, 'say': 'a one'}, {**vq, 'say': 'another two'}, {'kind': 'ask', 'intent': 'ownership', 'field': 'contribution', 'rung': 3, 'say': 'what part three'}]
    m = mv(t=turn('I helped with the migration'), asked=asked)
    assert m['intent'] not in ('vague_example', 'ownership', 'team_ownership')


def test_only_the_last_six_says_count():
    v = QUESTION_BANK['open_exploration']['en'][0]
    filler = [{'kind': 'ask', 'intent': 'x', 'field': None, 'rung': None, 'say': f'filler number {i} that says something quite different here'} for i in range(6)]
    old = [{'kind': 'ask', 'intent': 'x', 'field': None, 'rung': None, 'say': v}]
    assert mv(asked=old + filler)['say'] == v
    assert mv(asked=old)['say'] != v


# ---------- whole conversations, invariants ----------

CORPUS = ['hello', "I don't know", "I can't share the client name", 'sorry, it was 35 not 38', 'we delivered the migration', 'I helped improve the platform',
          'about 80% faster', 'it dropped from 2 days to 25 minutes over three months', 'we used Python, Kafka and Terraform', 'AWS Solutions Architect certified',
          'the client said it was the best team they had', 'the pilot failed and we had to roll back', 'I led the design and I owned the cutover plan', 'yes', 'no, that is wrong',
          'we chose Kafka instead of RabbitMQ after comparing the options', 'the ops team took over after handover', 'there is a runbook and a dashboard', 'can we skip this one',
          "I'm in a hurry", 'what do you mean?', 'Reports took too long and the data was inconsistent', '', 'ok', 'it would not work without a sponsor', 'another customer with a data platform would benefit']


@pytest.mark.parametrize('seed', range(12))
def test_random_conversations_keep_every_invariant(seed):
    import random
    rng = random.Random(seed)
    asked, led = [], InterviewLedger()
    for i in range(14):
        text = rng.choice(CORPUS)
        last = asked[-1] if asked else None
        t = turn(text, last['field'] if last and last['field'] else None)
        phase = rng.choice(['breadth', 'depth', 'closing']) if i > 8 else 'breadth'
        asr = [{'text': rng.choice(['45', 'Contoso', 'forty percent']), 'kind': 'number'}] if rng.random() < 0.15 else None
        m = select(led.inspect(), t, asked, {'role': 'x'} if seed % 3 == 0 else {}, phase, rng.choice([800, 400, 200, 60]), asr=asr, rushed=seed % 5 == 0)
        assert list(m) == KEYS and m['kind'] in KINDS and not any('score' in k.lower() for k in walk(m))
        if m['kind'] in ('ask', 'confirm_asr', 'reflect', 'offer_move_on', 'accept_and_move'):
            assert m['say'].count('?') == 1, m
        else:
            assert m['say'].count('?') == 0, m
        assert (m['reaction'] == 'none') == (m['ack_category'] is None) and m['ack_category'] in (None, *ACKS)
        assert m['reaction'] != 'earned' or m['ack_category'] == 'earned_result'
        assert not re.search(BANNED_PRAISE_SRC, m['say'], re.I)
        if seed % 3 == 0:
            assert m['intent'] != 'role'
        asked.append(m)
        if m['kind'] == 'close':
            break
    counts = {}
    for m in asked:
        if m['kind'] == 'ask' and m['intent'] not in ('confirm_asr', 'asr_repair') and m['field']:
            counts[(m['intent'], m['field'])] = counts.get((m['intent'], m['field']), 0) + 1
    assert all(n <= 2 for n in counts.values()), counts


def test_selector_is_fast():
    plan = ledger_plan(('problem', 'Reports took two days'), ('outcome', 'It takes 25 minutes now'), ('outcome', 'The report now takes 40 minutes'))
    t = turn('we used Python, Kafka and Terraform and it was about 80% faster, the client said it was the best team')
    asked = [{'kind': 'ask', 'intent': 'impact', 'field': 'outcome', 'rung': 6, 'say': f'What changed {i}?', 'why': 'ladder:outcome'} for i in range(8)]
    mv(plan, t, asked)
    t0 = time.perf_counter()
    for _ in range(300):
        mv(plan, t, asked)
    assert (time.perf_counter() - t0) / 300 < 0.005


# ---------- the edge export ----------

def test_edge_constants_are_json_and_registered():
    consts = selector.EDGE_CONSTANTS
    assert {'SELECTOR_CONFIG', 'QUESTION_BANK', 'SELECTOR_LINES'} <= set(consts)
    assert json.loads(json.dumps(consts)) == consts
    edge = Path(__file__).resolve().parents[1] / 'deploy' / 'cloudflare-edge'
    assert "'atlas_voice.selector'" in (edge / 'build_edge.py').read_text()
    out = (edge / 'src' / 'policy.generated.js').read_text()
    assert 'export const QUESTION_BANK = ' in out and 'export const SELECTOR_CONFIG = ' in out


def test_selector_never_describes_the_person():
    # D18: no mood, sentiment or personality vocabulary anywhere in the bank, the lines or the codes the selector emits
    banned = re.compile(r'mood|emotion|sentiment|feel|stress|personality|nervous|anxious|frustrat|angry|upset', re.I)
    for e in list(QUESTION_BANK.values()) + list(LINES.values()):
        assert not any(banned.search(v) for v in e['en'])
    for m in converse(CORPUS):
        assert not banned.search(json.dumps(m))


# ---------- H1: humane conversation review (transcripts a-d) ----------

def said(m):
    return m['say']


def test_h1_stop_closes_the_interview_instead_of_asking_again():
    for t in ['I think we covered it, I have nothing more to say.', 'No, I think that is all, thank you.']:
        m = mv(t=turn(t))
        assert m['kind'] == 'summary' and m['why'] == 'summary:stop', t
    m = mv(t=turn('No, I think that is all, thank you.'), asked=[{'kind': 'summary', 'intent': 'summary', 'field': None, 'rung': None, 'say': 'x', 'why': 'summary:stop'}])
    assert m['kind'] == 'close'


def test_h1_a_setback_is_met_with_what_did_you_do_once():
    t = turn('It was really frustrating, the team was exhausted and the new sponsor did not care about the project at all.')
    m = mv(t=t)
    assert (m['intent'], m['field'], m['rung'], m['why']) == ('setback_response', 'decision', 4, 'setback')
    assert m['ack_category'] == 'setback_neutral' and 'What did you do when that happened?' == m['say']
    again = mv(t=t, asked=[m])
    assert again['intent'] != 'setback_response'                      # the answer to it may also sound hard: no loop
    assert 'setback_response' in selector.NOT_ATTEMPTS                # and it is not an attempt at the decision question
    assert mv(t=turn('It went live on time with zero data loss, around two million records.'))['intent'] != 'setback_response'
    assert mv(t=t, rushed=True)['intent'] != 'setback_response'       # a rushed consultant gets the essentials only


def test_h1_first_person_work_is_not_asked_who_did_it():
    out = converse(['I helped improve the platform for the client.', 'Mostly I worked on the release pipeline and the monitoring, making things more efficient for everyone.'])
    assert out[0]['intent'] == 'vague_example'
    assert out[1]['intent'] not in ('ownership', 'team_ownership', 'role')
    assert mv(t=turn('It was a data migration for a bank'))['intent'] != 'open_exploration'


def test_h1_rushed_lead_is_the_acknowledgement_and_says_the_three_things():
    out = converse(["Sorry I only have five minutes, can we be quick? It was a data migration for a bank.", 'I led the migration design and wrote the scripts myself.'], rushed=True)
    assert out[0]['say'].startswith("No problem, let's keep it to three things: the project, your part, and what changed.")
    assert (out[0]['reaction'], out[0]['ack_category']) == ('none', None)      # no "Okay, noted." in front of it
    assert not out[1]['say'].startswith('No problem')


def test_h1_the_question_follows_the_thread_and_a_change_of_topic_says_so():
    plan = ledger_plan(('contribution', 'I worked on the release pipeline and the monitoring'))
    m = mv(plan=plan, t=turn('Deployments went down by 80 percent', 'contribution'))
    assert m['intent'] == 'metric_kind' and m['say'] == 'Was the 80 percent measured, or more of an estimate?'   # {figure}
    assert 'Was that figure measured' in said(mv(t=turn('it was 80% faster and 40% cheaper')))                  # two figures: no figure named
    # {hook}: their own words, subject and verb dropped; the ownership question starts from it
    plan = ledger_plan(('intervention', 'We rebuilt the nightly batch job so it ran in parallel'))
    m = mv(plan=plan, t=turn('We rebuilt the nightly batch job so it ran in parallel', 'intervention'), asked=[{'intent': 'example', 'field': 'intervention', 'rung': 2, 'say': 'x?', 'why': 'ladder:intervention', 'kind': 'ask'}])
    assert m['hook'] == 'the nightly batch job', m
    assert not m['bridge']
    # far from the thread: bridge, and no "that" or "it" in the wording
    m = mv(plan=ledger_plan(('adoption', 'The squads used it every day')), t=turn('The release manager and the two squads used it every day after we left, they owned it.', 'adoption'))
    assert m['bridge'] is True and m['hook'] == '' and not re.search(r'\b(?:that|it|this|those)\b', m['say'], re.I), m
    assert selector._hook({'candidate_details': [{'field': 'problem', 'quote': 'I think it was measured, the ops team had a dashboard'}]}, 'problem') == ''   # no verb to drop: no hook
    assert selector._hook({}, None) == '' and selector._hook({'candidate_details': [{'field': 'problem', 'quote': 'x'}]}, 'problem') == ''


def test_h1_variants_with_nothing_to_fill_are_not_used():
    for intent, e in QUESTION_BANK.items():
        assert any(not re.search(r'\{(?:hook|figure)\}', v) for v in e['en']), intent      # every intent keeps a variant that needs no thread words
    m = mv(t=turn('We chose GitLab over Jenkins'))
    assert '{' not in m['say'] and '}' not in m['say']


def test_h1_the_bank_is_rewritten_open_spoken_and_complete():
    b = lambda i: QUESTION_BANK[i]['en']
    assert b('stakes')[0] == 'What was at stake for the client if nothing had changed?' and b('stakes')[2] == 'Who felt that problem most?'
    assert b('ownership')[0] == 'You mentioned {hook}. Which part of that was yours?' and 'How was the work split between you and the team?' in b('ownership')
    assert b('decision')[1:] == ['What else did you consider before settling on that?', 'What was the hardest call you had to make?']
    assert b('evidence')[0] == 'What could a reviewer look at later, like a report or a dashboard?' and b('adoption')[0] == 'Who used it day to day once it was live?'
    assert b('measurement')[:2] == ['How did you know it was working?', 'What showed you things had changed?']
    assert b('attribution')[0] == 'Which part of that result came from your piece of the work?' and b('attribution')[2] == 'Where would you be careful not to overclaim this?'
    assert b('customer_fit')[0] == 'Which other clients could use what you learned here?' and b('poor_fit')[0] == 'Where would this approach not work as well?'
    assert b('metric_baseline')[0] == 'What was the starting point before the change?' and b('metric_source')[0].startswith('Where would that number show up')
    assert b('cert_details')[0] == 'Which body issued that certification?' and b('praise_source')[0] == 'Who gave you that feedback?'
    assert b('offer_move_on')[0] == "Let's leave that open. What happened next on the project?"
    assert not any('What would you like to cover instead' in v or 'What shall we turn to next' in v for v in b('offer_move_on'))   # not "you choose": that sounds lost
    for v in ['What made that difficult?', 'What did you try next?'] + ['How did you approach it?'] + ['What were you trying to change?']:      # the pack toolkit questions
        assert any(v in e['en'] for e in QUESTION_BANK.values()), v
    for intent, e in QUESTION_BANK.items():
        assert not any(re.search(r'\bactually\b|\bhow, if at all\b|\bverify\b', v, re.I) for v in e['en']), intent


def test_h1_a_refusal_with_content_is_kept_private_and_the_interview_goes_on():
    said_it = 'I can not name the client, it is a big pharma company under NDA, but we rebuilt their clinical trial reporting.'
    m = mv(t=turn(said_it))
    assert m['why'].startswith('kept_private:intervention>') and m['ack_category'] == 'confidential_ok' and m['intent'] != 'anonymise'
    assert 'intervention' not in selector._context({}, turn(said_it), [], {}, 'breadth', 800, False)['deferred']
    # a short refusal about a document: deferred, one acknowledgement, no "without naming anyone"
    m = mv(t=turn('I can not share the documents, they are confidential.'), asked=[{'intent': 'evidence', 'field': 'evidence', 'rung': 5, 'say': 'x?', 'why': 'ladder:evidence', 'kind': 'ask'}])
    assert m['why'].startswith('cannot_disclose:evidence>') and m['intent'] != 'anonymise'
    # a name or a client being refused: anonymised, once
    m = mv(t=turn("I can't name the client"), asked=[{'intent': 'open_exploration', 'field': 'problem', 'rung': 1, 'say': 'x?', 'why': 'ladder:problem', 'kind': 'ask'}])
    assert m['intent'] == 'anonymise'
    assert ACKS['confidential_ok']['en'] == ["That's fine, we'll keep that private.", 'No problem, that stays out.', 'Of course, we can leave that out.', "That's fine, we'll keep it general.", 'Understood, nothing specific then.']
    assert not any('name out' in t or 'anonymise' in t for t in ACKS['confidential_ok']['en'])


def test_h1_no_contradiction_loop_after_a_self_correction():
    plan = ledger_plan(('outcome', 'Report preparation went from 10 days to 2 days per study'), ('outcome', 'From 10 days to 3 days'))
    assert selector.contradiction(plan)[0] == 'outcome'
    assert selector.contradiction(plan, skip=['outcome']) is None
    corrected = [{'intent': 'correction_number', 'field': 'measurement', 'rung': 7, 'say': 'How was that number arrived at?', 'why': 'correction', 'kind': 'accept_and_move'}]
    t = turn('It was measured in a tracking sheet over six months')
    assert mv(plan=plan, t=t)['intent'] == 'contradiction'
    assert mv(plan=plan, t=t, asked=corrected)['intent'] != 'contradiction'    # the correction settled the outcome and the measurement together
    assert selector.number_conflict('10 days to 2 days', '10 days to 3 days') == ('2 days', '3 days') and selector.number_conflict('2 days and 25 minutes', '25 minutes') is None


def test_h1_acknowledgement_banks_are_rewritten_and_correction_thanks_needs_a_stated_fact():
    assert ACKS['neutral']['en'] == ['Okay.', 'I see.', 'Right.', 'Got it.', 'Okay, I follow.']
    assert 'Thanks, that helps.' in ACKS['thanks_detail']['en'] and not any('Right, that makes sense' in t for e in ACKS.values() for t in e['en'])
    assert ACKS['promising_unverified']['en'][3] == 'That sounds significant.' and 'That sounds like a good start.' not in ACKS['promising_unverified']['en']
    assert 'Good catch, thank you.' not in ACKS['correction_thanks']['en'] and 'Thanks for correcting me.' in ACKS['correction_thanks_fact']['en']
    assert 'That sounds like a tough stretch.' in ACKS['setback_neutral']['en']
    t = turn('Sorry, I meant 3 days, not 2.')
    plain = mv(t=t, asked=[{'intent': 'impact', 'field': 'outcome', 'rung': 6, 'say': 'What changed?', 'why': 'ladder:outcome', 'kind': 'ask'}])
    assert plain['ack_category'] == 'correction_thanks'
    after_fact = mv(t=t, asked=[{'intent': 'summary', 'kind': 'summary', 'field': None, 'rung': None, 'say': 'Let me read back', 'why': 'summary:x'}])
    assert after_fact['ack_category'] == 'correction_thanks_fact'
    heard = mv(t=t, asked=[{'intent': 'confirm_asr', 'kind': 'confirm_asr', 'field': None, 'rung': None, 'say': 'was that 2?', 'why': 'asr_span'}])
    assert heard['ack_category'] == 'correction_thanks_fact'


def test_h1_an_unverified_big_number_sounds_significant_not_neutral():
    for text, asked_field in [('Deployments went down by 80 percent, it was a huge success and the client loved it.', None), ('Report preparation went from 10 days to 2 days per study.', 'outcome')]:
        m = mv(t=turn(text, asked_field), asked=[{'intent': 'impact', 'field': 'outcome', 'rung': 6, 'say': 'What changed?', 'why': 'ladder:outcome', 'kind': 'ask'}])
        assert (m['reaction'], m['ack_category']) == ('ack', 'promising_unverified'), text
    assert mv(t=turn('It went well and the client loved it'))['ack_category'] != 'earned_result'
    assert 'client_praise' in turn('Deployments went down by 80 percent, it was a huge success and the client loved it.')['cues']


def test_h1_a_pilot_is_asked_for_the_finding_and_a_setback_for_the_lesson():
    assert 'pilot' in CONFIG['assessment_stages']
    early = ledger_plan(('problem', 'Reports took two days'), ('contribution', 'I owned the pipeline'), ('intervention', 'rebuilt the job'), ('stakes', 'lost time'), ('decision', 'chose parallel jobs'),
                        ('adoption', 'ops team took over'), ('evidence', 'a dashboard'))
    m = mv(t=turn(''), plan=early, prefill={'stage': 'Pilot', 'role': 'Architect'})
    assert (m['intent'], m['field']) == ('impact_assessment', 'outcome') and m['say'] == 'What decision or tested finding came out of this work?'
    assert mv(t=turn(''), plan=early, prefill={'stage': 'Production', 'role': 'Architect'})['intent'] == 'impact'
    # a cancelled piece of work has no result to measure: no measurement question, the lesson instead
    plan = ledger_plan(('problem', 'The client kept changing scope'), ('contribution', 'I was the delivery lead'), ('outcome', 'they cancelled it after three months'), ('stakes', 'a lost sponsor'),
                       ('intervention', 'weekly steering meetings'), ('decision', 'we held the scope'), ('adoption', 'the client reused the data model'), ('evidence', 'a lessons learned document'))
    m = mv(plan=plan, t=turn(''), prefill={'role': 'Lead'})
    assert m['intent'] == 'lessons' and m['field'] == 'limitations' and m['say'] == 'What would you do differently next time?'
    ok = ledger_plan(*[(f, q) for f, q in [('problem', 'Reports took two days'), ('contribution', 'I owned the pipeline'), ('outcome', 'They run in 25 minutes now'), ('intervention', 'rebuilt the job'),
                                           ('stakes', 'lost time'), ('decision', 'chose parallel jobs'), ('adoption', 'ops team took over'), ('evidence', 'a dashboard')]])
    assert mv(plan=ok, t=turn(''), prefill={'role': 'Lead'})['intent'] in ('measurement', 'attribution', 'metric_period', 'metric_kind', 'metric_baseline', 'metric_source')


def test_h1_the_move_carries_bridge_and_hook_and_never_a_score():
    m = mv(t=turn('The main problem was releases took a whole weekend'))
    assert isinstance(m['bridge'], bool) and isinstance(m['hook'], str) and list(m) == KEYS
    for line in (mv(phase='wrap'), mv(t=turn('can we pause'), asked=[{'intent': 'impact', 'field': 'outcome', 'rung': 6, 'say': 'What changed?', 'why': 'ladder:outcome', 'kind': 'ask'}])):
        assert line['bridge'] is False and line['hook'] == ''
