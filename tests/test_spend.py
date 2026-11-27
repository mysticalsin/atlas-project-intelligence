"""The Python gateway reserves on the same ledger before a paid call, and fails closed."""
import json
import os

import pytest

import aiohttp

from atlas_voice.spend import BudgetRefused, HttpLedger, ledger_mode, reserve, usage_from, use


class Fake:
    def __init__(self):
        self.reserved = []
        self.settled = []

    async def reserve(self, estimate):
        self.reserved.append(estimate)
        return 'P1'

    async def settle(self, ident, estimate, usage, error):
        self.settled.append({'id': ident, 'estimate': estimate, 'usage': usage, 'error': error})


def test_unset_mode_enforces(monkeypatch):
    monkeypatch.delenv('LEDGER_MODE', raising=False)
    assert ledger_mode() == 'enforce'


@pytest.mark.asyncio
async def test_missing_ledger_refuses_before_the_call(monkeypatch):
    monkeypatch.setenv('LEDGER_MODE', 'enforce')
    monkeypatch.delenv('ATLAS_LEDGER_URL', raising=False)
    monkeypatch.delenv('ATLAS_LEDGER_TOKEN', raising=False)
    use(None)
    called = []
    with pytest.raises(BudgetRefused) as caught:
        hold = await reserve({'kind': 'editor', 'provider': 'openai', 'inputTokens': 10, 'outputTokens': 10})
        called.append(hold)
    assert caught.value.reason == 'no_ledger'
    assert called == []
    use(None)


@pytest.mark.asyncio
async def test_explicit_off_logs_once_and_skips_the_ledger(monkeypatch, capsys):
    monkeypatch.setenv('LEDGER_MODE', 'off')
    use(None)
    import atlas_voice.spend as spend
    spend._off_logged = False
    hold = await reserve({'kind': 'stt', 'model': 'm'})
    await hold.settle()
    again = await reserve({'kind': 'tts', 'model': 'm'})
    await again.settle()
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith('{')]
    assert lines == [{'atlas_metric': 'ledger', 'mode': 'off'}]


@pytest.mark.asyncio
async def test_a_reservation_settles_the_usage_the_response_returns(monkeypatch):
    monkeypatch.setenv('LEDGER_MODE', 'enforce')
    fake = Fake()
    use(fake)
    hold = await reserve({'kind': 'analyst', 'model': 'm', 'inputTokens': 100, 'outputTokens': 100})
    await hold.settle(usage_from({'usage': {'prompt_tokens': 12, 'completion_tokens': 4, 'completion_tokens_details': {'reasoning_tokens': 3}}}))
    assert fake.reserved[0]['kind'] == 'analyst'
    assert fake.settled[0]['usage'] == {'inputTokens': 12, 'outputTokens': 4}
    use(None)


def test_paid_launchers_do_not_set_off():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for name in ('scripts/run_local_voice.sh', 'scripts/pod_setup.sh'):
        text = open(os.path.join(root, name), encoding='utf-8').read()
        assert 'LEDGER_MODE=off' not in text, name
        assert 'ATLAS_LEDGER_DEV=1' not in text, name


def test_production_startup_refuses_off_and_a_missing_ledger(monkeypatch, capsys):
    from atlas_voice.spend import LedgerConfigError, require_ledger
    import atlas_voice.spend as spend
    spend._off_logged = False
    with pytest.raises(LedgerConfigError):
        require_ledger({})
    with pytest.raises(LedgerConfigError):
        require_ledger({'LEDGER_MODE': 'off', 'ATLAS_AUTH': 'local', 'ATLAS_BIND': '127.0.0.1', 'OPENAI_API_KEY': 'sk'})
    with pytest.raises(LedgerConfigError):
        require_ledger({'LEDGER_MODE': 'off', 'ATLAS_AUTH': 'entra', 'ATLAS_BIND': '127.0.0.1'})
    with pytest.raises(LedgerConfigError):
        require_ledger({'LEDGER_MODE': 'enforce', 'ATLAS_LEDGER_URL': 'https://ledger.example'})
    with pytest.raises(LedgerConfigError):
        require_ledger({'LEDGER_MODE': 'observe'})
    with pytest.raises(LedgerConfigError):
        require_ledger({'LEDGER_MODE': 'enfroce', 'ATLAS_LEDGER_URL': 'https://ledger.example', 'ATLAS_LEDGER_TOKEN': 'tok'})
    require_ledger({'LEDGER_MODE': 'off', 'ATLAS_AUTH': 'local', 'ATLAS_BIND': '127.0.0.1'})
    with pytest.raises(LedgerConfigError):
        require_ledger({'LEDGER_MODE': 'off'})
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith('{')]
    assert lines == [{'atlas_metric': 'ledger', 'mode': 'off'}]
    require_ledger({'LEDGER_MODE': 'enforce', 'ATLAS_LEDGER_URL': 'https://ledger.example', 'ATLAS_LEDGER_TOKEN': 'tok'})
    text = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts/start_gateway.sh'), encoding='utf-8').read()
    assert 'require_ledger' in text
    monkeypatch.setenv('LEDGER_MODE', 'off')
    monkeypatch.delenv('ATLAS_LEDGER_DEV', raising=False)


class _Response:
    def __init__(self, status, payload):
        self.status = status
        self.payload = payload

    async def json(self, content_type=None):
        if isinstance(self.payload, Exception):
            raise self.payload
        return self.payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False


class _Session:
    def __init__(self, outcome):
        self.outcome = outcome

    def post(self, *args, **kwargs):
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return _Response(self.outcome[0], self.outcome[1])


@pytest.mark.asyncio
async def test_http_and_storage_failures_refuse_before_the_call(monkeypatch):
    monkeypatch.setenv('LEDGER_MODE', 'enforce')
    for outcome in (aiohttp.ClientConnectionError('down'), (500, {'ok': False, 'reason': 'ledger_error'}), (200, {'ok': False, 'reason': 'ledger_error'})):
        use(HttpLedger(_Session(outcome), 'https://ledger.example', 'tok'))
        called = []
        with pytest.raises(BudgetRefused) as caught:
            hold = await reserve({'kind': 'editor', 'provider': 'openai', 'inputTokens': 10, 'outputTokens': 10})
            called.append(hold)
        assert called == []
        assert caught.value.reason == 'ledger_error'
    use(None)
