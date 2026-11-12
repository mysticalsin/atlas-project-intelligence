"""Every paid Hindsight call reserves on the same ledger before the client is built."""
import json
from dataclasses import replace

import pytest

from atlas_voice.config import Config
from atlas_voice.identity import Session
from atlas_voice.memory import PrivateMemory
from atlas_voice.spend import BudgetRefused, use


def subject():
    return Session('tenant', 'alice', 'Alice', 'c', 0)


def config():
    return replace(Config(), hindsight_url='https://memory.example', bank_secret='z' * 32)


class Ledger:
    def __init__(self, order):
        self.order = order
        self.reserved = []
        self.settled = []

    async def reserve(self, estimate):
        self.order.append('reserve')
        self.reserved.append(estimate)
        return 'P1'

    async def settle(self, ident, estimate, usage, error):
        self.order.append('settle')
        self.settled.append({'id': ident, 'usage': usage, 'error': error})


@pytest.mark.asyncio
async def test_recall_reserves_before_hindsight_and_a_missing_ledger_does_not_call(monkeypatch):
    monkeypatch.setenv('LEDGER_MODE', 'enforce')
    order = []
    ledger = Ledger(order)
    use(ledger)

    class Client:
        def __init__(self):
            order.append('client')

        async def arecall(self, **kw):
            order.append('call')
            return {'results': [{'text': 'short'}], 'usage': {'prompt_tokens': 8, 'completion_tokens': 3}}

        async def aretain(self, **kw):
            order.append('call')
            return {'ok': True}

        async def aclose(self):
            order.append('close')

    memory = PrivateMemory(config(), client_factory=Client)
    try:
        text = await memory.recall(subject())
        assert text == 'short'
        assert order == ['reserve', 'client', 'call', 'settle', 'close']
        estimate = ledger.reserved[0]
        assert estimate['kind'] == 'memory' and estimate['provider'] == 'hindsight' and estimate['operation'] == 'recall'
        assert estimate['outputTokens'] == 300 and estimate['inputTokens'] >= 1
        body = json.dumps({'query': memory.RECALL_QUERY, 'budget': 'low', 'max_tokens': 300}, separators=(',', ':'), ensure_ascii=False)
        assert estimate['inputTokens'] == max(1, (len(body.encode()) + 3) // 4)
        assert ledger.settled[0]['usage'] == {'inputTokens': 8, 'outputTokens': 3}
        order.clear()
        ledger.reserved.clear()
        await memory.retain(subject(), 'One question at a time.')
        assert order[0] == 'reserve' and order[1] == 'client'
        assert ledger.reserved[0]['operation'] == 'retain' and ledger.reserved[0]['outputTokens'] == 0
        order.clear()
        await memory.replace_continuity(subject(), 'Resume at the open evidence question.')
        assert ledger.reserved[-1]['operation'] == 'retain'
    finally:
        use(None)

    use(None)
    built = []

    class Guard:
        def __init__(self):
            built.append('client')

        async def arecall(self, **kw):
            built.append('call')

        async def aclose(self):
            built.append('close')

    with pytest.raises(BudgetRefused) as caught:
        await PrivateMemory(config(), client_factory=Guard).recall(subject())
    assert caught.value.reason == 'no_ledger'
    assert built == []


@pytest.mark.asyncio
async def test_document_get_and_delete_reserve_before_the_api(monkeypatch):
    monkeypatch.setenv('LEDGER_MODE', 'enforce')
    order = []
    ledger = Ledger(order)
    use(ledger)

    class Docs:
        def __init__(self):
            order.append('client')

        async def get_document(self, **kw):
            order.append('call')
            return type('Doc', (), {'original_text': 'kept'})()

        async def delete_document(self, **kw):
            order.append('call')
            return type('Gone', (), {'memory_units_deleted': 2})()

    memory = PrivateMemory(config(), documents_factory=lambda: Docs())
    try:
        assert await memory.get_continuity(subject()) == 'kept'
        assert order == ['reserve', 'client', 'call', 'settle']
        assert ledger.reserved[0]['operation'] == 'list' and ledger.reserved[0]['inputTokens'] == 1
        order.clear()
        gone = await memory.delete_continuity(subject())
        assert gone['memory_units_deleted'] == 2
        assert order[0] == 'reserve' and ledger.reserved[-1]['operation'] == 'forget'
    finally:
        use(None)
