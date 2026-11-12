"""The Python gateway reserves on the same ledger before a paid call, and fails closed."""
import json
import os

import pytest

from atlas_voice.spend import BudgetRefused, ledger_mode, reserve, usage_from, use


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


def test_dev_launchers_set_off_explicitly():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for name in ('scripts/run_local_voice.sh', 'scripts/pod_setup.sh'):
        text = open(os.path.join(root, name), encoding='utf-8').read()
        assert 'LEDGER_MODE=off' in text, name
