"""A limitation stays when a rewrite only contains it inside a longer word or number.

Synthetic accounts only. No provider call.
"""
from atlas_voice.editor import parse_edit
from atlas_voice.wiki import SECTIONS

MARKER = 'Original scope and limitations (retained verbatim):\n'


def story(limitations):
    sections = {key: 'Fictional ' + key + ' account, limited to one queue. Not a claimed company result.' for key in SECTIONS}
    sections['limitations'] = limitations
    return {
        'title': 'FICTIONAL triage pilot',
        'stage': 'Pilot',
        'kind': 'qualitative',
        'audience': 'internal',
        'tags': ['service-operations'],
        'sections': sections,
        'sources': [{
            'id': 'E1',
            'version': 'fictional-v1',
            'excerpt': 'Synthetic acceptance record, not a real customer source.',
            'supports': ['challenge', 'contribution', 'approach', 'outcome'],
        }],
        'customer_brief': 'Operations teams seeking predictable intake, with process ownership.',
    }


def edit(record, limitations_text):
    paragraphs = []
    for key, value in record['sections'].items():
        text = limitations_text if key == 'limitations' else value
        paragraphs.append({'section': key, 'text': text, 'refs': ['account:' + key]})
    return {
        'title': 'A controlled service pilot',
        'paragraphs': paragraphs,
        'open_questions': ['Who can independently verify the handover?'],
    }


def limitations_of(record, rewrite):
    result = parse_edit(edit(record, rewrite), record)
    assert result['human_review_required'] is True
    assert result['status'] == 'restricted-candidate'
    return result['candidate']['sections']['limitations']


def test_limitation_inside_a_longer_word_is_retained():
    text = limitations_of(story('pilot'), 'The pilotage stayed with the local team after the handover.')
    assert MARKER + 'pilot' in text
    assert 'pilotage' in text


def test_limitation_inside_account_is_retained():
    text = limitations_of(story('count'), 'The account stayed with the local team after the handover.')
    assert MARKER + 'count' in text
    assert 'account' in text


def test_limitation_inside_a_longer_token_is_retained():
    text = limitations_of(story('10'), 'The label x10y stayed on the queue after the handover.')
    assert MARKER + '10' in text
    assert 'x10y' in text


def test_limitation_that_is_its_own_span_is_not_repeated():
    text = limitations_of(story('pilot'), 'This stayed a pilot after the handover.')
    assert MARKER not in text
    assert ' a pilot ' in text


def test_omitted_limitation_is_still_retained():
    text = limitations_of(story('pilot'), 'The local team kept the queue after the handover.')
    assert MARKER + 'pilot' in text
