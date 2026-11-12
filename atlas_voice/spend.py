"""Client of the one production spend ledger. The money stays in the Worker Durable Object.

Unset LEDGER_MODE enforces. Explicit off makes the call and writes one log line. A missing ledger refuses
before the upstream request.
"""
import json
import os

import aiohttp

BUDGET_MESSAGE = "This month's AI budget is used up."
_MODES = ('off', 'observe', 'enforce')
_off_logged = False
_installed = None


class BudgetRefused(Exception):
    def __init__(self, reason):
        self.reason = str(reason or 'refused')[:40]
        self.code = 'budget_exhausted' if self.reason == 'exhausted:usd' else self.reason
        super().__init__(BUDGET_MESSAGE if self.reason == 'exhausted:usd' else 'Spend ledger refused: ' + self.reason)


class LedgerConfigError(RuntimeError):
    """The process must not bind a port with the ledger off or unconfigured."""


def ledger_mode(environ=None):
    source = os.environ if environ is None else environ
    value = source.get('LEDGER_MODE')
    if value is None or value == '':
        return 'enforce'
    return value if value in _MODES else 'invalid'


def ledger_dev(environ=None):
    """Off is allowed only for an explicit dev or test marker. 0, false and off do not count."""
    source = os.environ if environ is None else environ
    return str(source.get('ATLAS_LEDGER_DEV') or '').strip().lower() in ('1', 'dev', 'test')


def require_ledger(environ=None):
    """Refuse to start unless enforce or observe has a ledger, or off carries the dev marker."""
    source = os.environ if environ is None else environ
    mode = ledger_mode(source)
    if mode == 'off':
        if not ledger_dev(source):
            raise LedgerConfigError('LEDGER_MODE=off is refused without ATLAS_LEDGER_DEV set to 1, dev or test.')
        _log_off_once()
        return
    if mode not in ('enforce', 'observe'):
        raise LedgerConfigError('LEDGER_MODE must be off, observe or enforce.')
    url = str(source.get('ATLAS_LEDGER_URL') or '').strip()
    token = str(source.get('ATLAS_LEDGER_TOKEN') or '').strip()
    if not url or not token:
        raise LedgerConfigError('ATLAS_LEDGER_URL and ATLAS_LEDGER_TOKEN are required.')


def use(ledger):
    """Tests install a fake. Production leaves this unset and uses ATLAS_LEDGER_URL."""
    global _installed
    _installed = ledger


def _log(line):
    print(line, flush=True)


def _log_off_once():
    global _off_logged
    if _off_logged:
        return
    _off_logged = True
    _log(json.dumps({'atlas_metric': 'ledger', 'mode': 'off'}))


class Hold:
    def __init__(self, ledger, ident, estimate, skipped=False):
        self.ledger = ledger
        self.ident = ident
        self.estimate = estimate
        self.skipped = skipped
        self.done = False

    async def settle(self, usage=None, error=None):
        if self.done or self.skipped:
            self.done = True
            return
        self.done = True
        await self.ledger.settle(self.ident, self.estimate, usage, error)


class HttpLedger:
    def __init__(self, session, url, token):
        self.session = session
        self.url = url.rstrip('/')
        self.token = token

    async def _post(self, path, body):
        try:
            async with self.session.post(self.url + path, json=body, headers={'Authorization': 'Bearer ' + self.token},
                                         timeout=aiohttp.ClientTimeout(total=2), allow_redirects=False) as response:
                data = await response.json(content_type=None)
                return response.status, data if isinstance(data, dict) else {}
        except (aiohttp.ClientError, TimeoutError, json.JSONDecodeError) as error:
            raise BudgetRefused('ledger_error') from error

    async def reserve(self, estimate):
        status, data = await self._post('/api/ledger/reserve', estimate)
        if status != 200 or not data.get('ok') or not isinstance(data.get('id'), str):
            raise BudgetRefused(data.get('reason') or 'ledger_error')
        return data['id']

    async def settle(self, ident, estimate, usage, error):
        body = {'id': ident, 'estimate': estimate}
        if usage:
            body['usage'] = usage
        if error:
            body['error'] = error
        status, data = await self._post('/api/ledger/settle', body)
        if status != 200 or not data.get('ok'):
            raise BudgetRefused(data.get('reason') or 'ledger_error')


def current(session):
    if _installed is not None:
        return _installed
    url = os.environ.get('ATLAS_LEDGER_URL', '').strip()
    token = os.environ.get('ATLAS_LEDGER_TOKEN', '').strip()
    if not url or not token or session is None:
        return None
    return HttpLedger(session, url, token)


async def reserve(estimate, session=None):
    mode = ledger_mode()
    if mode == 'off':
        _log_off_once()
        return Hold(None, None, estimate, skipped=True)
    if mode != 'enforce' and mode != 'observe':
        raise BudgetRefused('invalid_mode')
    if mode == 'observe':
        _log(json.dumps({'atlas_metric': 'ledger', 'mode': 'observe', 'kind': estimate.get('kind')}))
        return Hold(None, None, estimate, skipped=True)
    ledger = current(session)
    if ledger is None:
        raise BudgetRefused('no_ledger')
    return Hold(ledger, await ledger.reserve(estimate), estimate)


def usage_from(payload):
    if not isinstance(payload, dict):
        return None
    usage = payload.get('usage')
    if not isinstance(usage, dict):
        return None
    def number(*keys):
        for key in keys:
            value = usage.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                return value
        return None
    incoming = number('prompt_tokens', 'input_tokens')
    completion = number('completion_tokens', 'output_tokens')
    reasoning = number('reasoning_tokens')
    details = usage.get('completion_tokens_details')
    if reasoning is None and isinstance(details, dict):
        value = details.get('reasoning_tokens')
        if isinstance(value, int) and value >= 0:
            reasoning = value
    if incoming is None and completion is None and reasoning is None:
        return None
    return {'inputTokens': incoming or 0, 'outputTokens': max(completion or 0, reasoning or 0)}
