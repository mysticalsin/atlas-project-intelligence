"""A streamed reply with no usage stops at the reserved output."""
import json

import pytest

from atlas_voice.limits import LIMITS, output_tokens, realtime_increment
from atlas_voice.spend import BudgetRefused, use


class Ledger:
    def __init__(self, fail_reserve_at=None):
        self.n = 0
        self.reserves = []
        self.settles = []
        self.fail_reserve_at = fail_reserve_at

    async def reserve(self, estimate):
        self.n += 1
        if self.fail_reserve_at and self.n >= self.fail_reserve_at:
            raise BudgetRefused('exhausted:usd')
        self.reserves.append(estimate)
        return 'P' + str(self.n)

    async def settle(self, ident, estimate, usage, error):
        self.settles.append({'id': ident, 'usage': usage, 'error': error})


class _Content:
    def __init__(self, parts):
        self.parts = parts

    async def iter_any(self):
        for part in self.parts:
            yield part


class _Response:
    def __init__(self, parts):
        self.content = _Content(parts)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def raise_for_status(self):
        return None


class _Http:
    def __init__(self, parts):
        self.parts = parts

    def post(self, url, headers, json, timeout):
        return _Response(self.parts)


@pytest.mark.asyncio
async def test_stream_chat_with_no_usage_stops_at_the_reserved_output(monkeypatch):
    monkeypatch.setenv('LEDGER_MODE', 'enforce')
    from atlas_voice.kyutai import stream_chat
    cap = output_tokens('talker')
    ledger = Ledger()
    use(ledger)
    overflow = 'x' * (cap + 40)
    payload = json.dumps({'choices': [{'delta': {'content': overflow}}]}).encode()
    said = []
    async for delta in stream_chat(_Http([b'data: ' + payload + b'\n\n', b'data: [DONE]\n\n']),
                                    'https://example.test/v1', 'm', '', [{'role': 'user', 'content': 'hi'}]):
        said.append(delta)
    text = ''.join(said)
    assert text == 'x' * cap
    assert ledger.settles[-1]['usage'] is None
    use(None)


@pytest.mark.asyncio
async def test_realtime_output_without_usage_stops_when_the_next_increment_is_refused(monkeypatch):
    monkeypatch.setenv('LEDGER_MODE', 'enforce')
    from atlas_voice.realtime import RealtimeMeter
    ledger = Ledger(fail_reserve_at=2)
    use(ledger)
    meter = RealtimeMeter(object(), 'gpt-realtime-2.1', None, now=lambda: 10.0)
    await meter.open_increment()
    step = realtime_increment()
    output = step['outputTokens'] + int(LIMITS['realtime']['maxResponseTokens'])
    per_second = int(LIMITS['realtime']['outputTokensPerSecond'])
    nbytes = ((output + 1) * int(LIMITS['pcmBytesPerMs']) * 1000 + per_second - 1) // per_second
    with pytest.raises(BudgetRefused) as caught:
        await meter.note_output_audio(nbytes)
    assert caught.value.reason == 'exhausted:usd'
    assert ledger.n == 2
    use(None)


@pytest.mark.asyncio
async def test_an_unmetered_realtime_response_stops_when_the_next_increment_is_refused(monkeypatch):
    monkeypatch.setenv('LEDGER_MODE', 'enforce')
    from atlas_voice.realtime import RealtimeMeter
    ledger = Ledger(fail_reserve_at=2)
    use(ledger)
    meter = RealtimeMeter(object(), 'gpt-realtime-2.1', None, now=lambda: 10.0)
    await meter.open_increment()
    await meter.note_unmetered_response()
    with pytest.raises(BudgetRefused) as caught:
        await meter.note_unmetered_response()
    assert caught.value.reason == 'exhausted:usd'
    use(None)
