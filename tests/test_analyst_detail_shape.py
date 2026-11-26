"""A record_details payload whose details value is not a list is one rejection.

Synthetic quotes only. No provider, network, or microphone.
"""
import asyncio
import json

from atlas_voice.analyst import Analyst


def run(coro):
    return asyncio.run(coro)


def test_string_details_are_rejected_once():
    async def llm(messages):
        return [{'id': 'c1', 'name': 'record_details',
                 'arguments': json.dumps({'details': 'the queue was slow before the change'})}]

    out = run(Analyst(llm).hear('u1', 'The queue was slow before the change.'))
    assert out['analyst_status'] == 'analysed'
    assert out['rejected_proposals'] == 1
    assert out['ignored_tool_calls'] == 0
    assert out['candidate_details'] == []


def test_a_detail_list_is_still_recorded():
    async def llm(messages):
        return [{'id': 'c1', 'name': 'record_details', 'arguments': json.dumps(
            {'details': [{'field': 'problem', 'item_id': 'u1', 'quote': 'The queue was slow'}]})}]

    out = run(Analyst(llm).hear('u1', 'The queue was slow before the change.'))
    assert out['rejected_proposals'] == 0
    assert [d['quote'] for d in out['candidate_details']] == ['The queue was slow']
