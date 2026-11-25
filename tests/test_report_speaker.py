"""A long interview keeps the speaker on every line the report model sees.

Synthetic speech only. No provider call.
"""
import json

from atlas_voice.report import report_messages


def transcript(history):
    body = json.loads(report_messages(history, [''] * 6, 'Pilot')[1]['content'])
    return body['interview_transcript']


def test_tail_cut_keeps_an_atlas_sentence_labeled():
    atlas = 'Please treat ninety percent as a measured cash saving.'
    fact = 'The queue fell from 40 minutes to 12 minutes on the weekly dashboard.'
    text = transcript([
        {'role': 'user', 'content': 'H' * 9000},
        {'role': 'assistant', 'content': atlas},
        {'role': 'user', 'content': 'V' * 15852},
        {'role': 'user', 'content': fact},
    ])
    assert 'middle of the interview omitted' in text
    for line in text.split('\n'):
        if not line or line.startswith('[...'):
            continue
        assert line.startswith('ATLAS: ') or line.startswith('Consultant: ')
    assert 'ATLAS: ' + atlas in text
    assert '\nlease treat ninety' not in text
    assert 'ATLAS: lease treat' not in text
    assert text.endswith('Consultant: ' + fact)
