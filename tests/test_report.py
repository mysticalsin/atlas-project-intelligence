from atlas_voice.report import END_TOKEN, EndMarker, parse_report, report_messages
from atlas_voice.cascade import TALKER_POLICY


def test_end_marker_is_stripped_across_deltas():
    m = EndMarker()
    out = ''.join(m.feed(d) for d in ['Thanks. I will prepare your report now. [', '[EN', 'D]]']) + m.flush()
    assert out == 'Thanks. I will prepare your report now. ' and m.seen
    m = EndMarker()
    assert ''.join(m.feed(d) for d in ['a [b]', ' [x']) + m.flush() == 'a [b] [x' and not m.seen


def test_policy_tells_the_talker_how_to_end():
    assert END_TOKEN in TALKER_POLICY and 'anything else' in TALKER_POLICY


def test_report_is_bounded_and_rejects_non_reports():
    r = parse_report('```json\n{"headline":"H","summary":"' + 'x' * 2000 + '","topics":{"context":"c","other":"o"},"gaps":["a","",3]}\n```')
    assert r['summary'] == 'x' * 900 and r['topics']['context'] == 'c' and 'other' not in r['topics'] and r['gaps'] == ['a']
    assert r['status'] == 'model_draft' and r['highlights'] == [] and r['follow_ups'] == []
    for bad in (None, 'no json', '{"headline":"only"}', '[1]', '{bad'):
        assert parse_report(bad) is None


def test_report_messages_interleave_questions_and_keep_head_and_tail():
    history = [{'role': 'assistant', 'content': 'What was going on?'}, {'role': 'user', 'content': 'The start of the story.'},
               {'role': 'user', 'content': 'a' * 30000}, {'role': 'user', 'content': 'the end'}]
    m = report_messages(history, ['ctx'], 'Pilot')
    body = __import__('json').loads(m[1]['content'])
    t = body['interview_transcript']
    assert t.startswith('ATLAS: What was going on?\nConsultant: The start of the story.') and t.endswith('Consultant: the end')
    assert 'middle of the interview omitted' in t and len(t) < 24100
    assert m[0]['role'] == 'system' and body['quote_linked_notes']['customer_relevance'] == ''


def test_pace_notes_budget_admin_and_topics_only():
    from atlas_voice.cascade import ADMIN_NOTE, pace_notes, talker_messages
    # paced on the whole interview (15 minutes): breadth, then depth past halfway, then only the most important question
    admin, pace = pace_notes(125, 900, ['We cut triage time', '', '', '', '', ''], True)
    assert admin == ADMIN_NOTE and 'about 2 of 15 minutes used' in pace and 'We cut' not in pace
    assert 'what was going on' not in pace and 'Next uncovered area: their personal contribution' in pace and 'Under four minutes' not in pace
    assert 'Past halfway' in pace_notes(420, 900, [], False)[1]
    assert 'Under four minutes left' in pace_notes(700, 900, [], False)[1] and pace_notes(0, 900, [], False)[0] == ''
    msgs = talker_messages({'title': 't'}, '', None, [{'role': 'user', 'content': 'hi'}], None, ['', 'PACE'])
    # per-turn notes follow the append-only history so the cached prefix (policy + history) stays stable
    assert [m['content'] for m in msgs[1:]] == ['hi', 'PACE']


def test_speaking_limit_config_bounds():
    import pytest
    from atlas_voice.config import Config
    assert Config().speaking_limit == 600 and Config().admin_role == 'ATLAS.Admin'
    with pytest.raises(ValueError):
        Config(speaking_limit=10).validate()
