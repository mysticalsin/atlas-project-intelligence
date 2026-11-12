"""Gaps from the review of 13d99fe: realtime increments, observe record, Riva, and UTF-8 estimates."""
import asyncio
import json

import pytest

from atlas_voice.limits import LIMITS, realtime_increment
from atlas_voice.memory import memory_estimate
from atlas_voice.realtime import RealtimeMeter
from atlas_voice.spend import BUDGET_MESSAGE, BudgetRefused, HttpLedger, refusal_event, reserve, use


class Ledger:
    def __init__(self, fail_reserve_at=None, fail_settle=False, fail_reason='exhausted:usd'):
        self.n = 0
        self.reserves = []
        self.settles = []
        self.records = []
        self.fail_reserve_at = fail_reserve_at
        self.fail_settle = fail_settle
        self.fail_reason = fail_reason

    async def reserve(self, estimate):
        self.n += 1
        if self.fail_reserve_at and self.n >= self.fail_reserve_at:
            raise BudgetRefused(self.fail_reason)
        self.reserves.append(estimate)
        return 'P' + str(self.n)

    async def settle(self, ident, estimate, usage, error):
        if self.fail_settle:
            raise BudgetRefused('ledger_error')
        self.settles.append({'id': ident, 'usage': usage, 'error': error})

    async def record(self, estimate):
        self.records.append(estimate)


def test_estimates_count_utf8_bytes():
    text = '水' * 4
    estimate = memory_estimate('recall', text, 10)
    assert estimate['inputTokens'] == len(text.encode('utf-8'))
    assert estimate['inputTokens'] != len(text)


@pytest.mark.asyncio
async def test_a_long_realtime_session_settles_each_increment(monkeypatch):
    monkeypatch.setenv('LEDGER_MODE', 'enforce')
    ledger = Ledger()
    use(ledger)
    clock = {'t': 1000.0}
    meter = RealtimeMeter(object(), 'gpt-realtime-2.1', 'gpt-transcribe', now=lambda: clock['t'])
    await meter.open_increment()
    step = realtime_increment()
    for _ in range(4):
        clock['t'] += step['seconds']
        await meter.note_response({'inputTokens': step['inputTokens'], 'outputTokens': step['outputTokens']})
        await meter.tick()
    await meter.settle_all()
    speech = [row for row in ledger.reserves if row['kind'] == 'realtime']
    heard = [row for row in ledger.reserves if row['kind'] == 'transcribe']
    assert len(speech) >= 4
    assert len(heard) == len(speech)
    assert len(ledger.settles) == len(ledger.reserves)
    assert all(row['audioMs'] == step['audioMs'] for row in heard)
    use(None)


def test_only_exhaustion_uses_the_month_sentence():
    assert refusal_event(BudgetRefused('exhausted:usd')) == (BUDGET_MESSAGE, 'budget_exhausted')
    message, code = refusal_event(BudgetRefused('no_ledger'))
    assert code == 'no_ledger' and message != BUDGET_MESSAGE
    message, code = refusal_event(BudgetRefused('ledger_error'))
    assert code == 'ledger_error' and message != BUDGET_MESSAGE


@pytest.mark.asyncio
async def test_a_refusal_keeps_its_reason_and_settles_leftover_usage(monkeypatch):
    monkeypatch.setenv('LEDGER_MODE', 'enforce')
    step = realtime_increment()
    cap_out = step['outputTokens'] + int(LIMITS['realtime']['maxResponseTokens'])
    for reason in ('no_ledger', 'ledger_error', 'exhausted:usd'):
        ledger = Ledger(fail_reserve_at=1, fail_reason=reason)
        use(ledger)
        meter = RealtimeMeter(object(), 'gpt-realtime-2.1', None, now=lambda: 10.0)
        with pytest.raises(BudgetRefused) as caught:
            await meter.open_increment()
        assert caught.value.reason == reason
        use(None)

        ledger = Ledger(fail_reserve_at=3, fail_reason=reason)
        use(ledger)
        meter = RealtimeMeter(object(), 'gpt-realtime-2.1', 'gpt-transcribe', now=lambda: 10.0)
        await meter.open_increment()
        meter.seen = True
        meter.unsettled_in = step['inputTokens'] + 50
        meter.unsettled_out = cap_out + 25
        with pytest.raises(BudgetRefused) as caught:
            await meter.ensure()
        assert caught.value.reason == reason
        speech = [row for row in ledger.settles if row['usage'] and 'inputTokens' in row['usage']]
        assert speech[-1]['usage']['inputTokens'] == step['inputTokens'] + 50
        assert speech[-1]['usage']['outputTokens'] == cap_out + 25
        use(None)


@pytest.mark.asyncio
async def test_the_next_increment_closes_when_it_cannot_be_reserved(monkeypatch):
    monkeypatch.setenv('LEDGER_MODE', 'enforce')
    ledger = Ledger(fail_reserve_at=3)
    use(ledger)
    meter = RealtimeMeter(object(), 'gpt-realtime-2.1', 'gpt-transcribe', now=lambda: 50.0)
    await meter.open_increment()
    step = realtime_increment()
    with pytest.raises(BudgetRefused) as caught:
        await meter.note_response({'inputTokens': step['inputTokens'] + 1, 'outputTokens': step['outputTokens'] + LIMITS['realtime']['maxResponseTokens'] + 1})
    assert caught.value.code == 'budget_exhausted'
    assert ledger.settles
    use(None)


@pytest.mark.asyncio
async def test_a_settle_409_is_logged_and_raised(monkeypatch, capsys):
    monkeypatch.setenv('LEDGER_MODE', 'enforce')
    ledger = Ledger(fail_settle=True)
    use(ledger)
    meter = RealtimeMeter(object(), 'gpt-realtime-2.1', None, now=lambda: 10.0)
    await meter.open_increment()
    with pytest.raises(BudgetRefused) as caught:
        await meter.settle_all()
    assert caught.value.reason == 'ledger_error'
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith('{')]
    assert {'atlas_metric': 'ledger', 'error': 'settle', 'reason': 'ledger_error'} in lines
    use(None)


@pytest.mark.asyncio
async def test_observe_records_on_the_ledger(monkeypatch):
    monkeypatch.setenv('LEDGER_MODE', 'observe')
    ledger = Ledger()
    use(ledger)
    hold = await reserve({'kind': 'memory', 'provider': 'hindsight', 'operation': 'list', 'inputTokens': 4, 'outputTokens': 0})
    await hold.settle()
    assert ledger.records and ledger.records[0]['operation'] == 'list'
    assert ledger.reserves == []
    use(None)


def test_the_python_client_forwards_the_existing_access_service_headers(monkeypatch):
    monkeypatch.setenv('CF_ACCESS_CLIENT_ID', 'access-id')
    monkeypatch.setenv('CF_ACCESS_CLIENT_SECRET', 'access-secret')
    seen = {}

    class Session:
        def post(self, url, json, headers, timeout, allow_redirects):
            seen['url'] = url
            seen['headers'] = headers
            class Response:
                status = 200
                async def json(self, content_type=None):
                    return {'ok': True, 'id': 'P1'}
                async def __aenter__(self):
                    return self
                async def __aexit__(self, *args):
                    return False
            return Response()

    client = HttpLedger(Session(), 'https://atlas.example', 'ledger-token')
    asyncio.run(client.reserve({'kind': 'memory'}))
    assert seen['headers']['Authorization'] == 'Bearer ledger-token'
    assert seen['headers']['CF-Access-Client-Id'] == 'access-id'
    assert seen['headers']['CF-Access-Client-Secret'] == 'access-secret'
    assert 'access-secret' not in seen['url']


def test_riva_is_refused_under_enforce_until_it_is_priced(monkeypatch):
    monkeypatch.setenv('LEDGER_MODE', 'enforce')
    from atlas_voice.notes import make_notes

    class Config:
        riva_uri = 'riva.example:443'
        riva_model = 'parakeet'
        ffmpeg = 'ffmpeg'

    async def run():
        with pytest.raises(BudgetRefused) as caught:
            await make_notes(Config(), None, b'\0\0' * 480)
        assert caught.value.code == 'unpriced'

    asyncio.run(run())


@pytest.mark.asyncio
async def test_stream_chat_settles_when_cancelled(monkeypatch):
    monkeypatch.setenv('LEDGER_MODE', 'enforce')
    ledger = Ledger()
    use(ledger)
    from atlas_voice.kyutai import stream_chat

    class Content:
        async def iter_any(self):
            yield b'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'
            await asyncio.sleep(5)
            yield b'data: [DONE]\n'

    class SSE:
        content = Content()
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            return False
        def raise_for_status(self):
            return None

    class Http:
        def post(self, *args, **kwargs):
            return SSE()

    gen = stream_chat(Http(), 'https://example.test/v1', 'm', '', [{'role': 'user', 'content': 'hi'}])
    assert await gen.__anext__() == 'Hi'
    await gen.aclose()
    assert ledger.settles
    use(None)
