"""Private Hindsight preferences. Actual SDK calls, never browser-chosen banks.

No automatic transcript ingestion. Only explicit preference writes are retained.
Every paid call reserves on the same ledger as the edge memory path, then settles.
A missing ledger refuses before the client is built.
"""
import asyncio
import hashlib
import hmac
import json

from .limits import LIMITS, input_tokens, output_tokens
from .spend import reserve, usage_from


def memory_estimate(operation, payload=None, max_tokens=0):
    """kind memory, provider hindsight. Input is one token per byte. Recall output is the max_tokens sent."""
    if payload is None:
        raw = b''
    elif isinstance(payload, (bytes, bytearray)):
        raw = bytes(payload)
    elif isinstance(payload, str):
        raw = payload.encode('utf-8')
    else:
        raw = json.dumps(payload, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    if len(raw) > int(LIMITS['memoryBody']['maxBytes']):
        raise ValueError('Memory request exceeds the byte cap.')
    outgoing = 0
    if operation == 'recall':
        cap = output_tokens('gatewayRecall')
        try:
            number = int(max_tokens)
        except (TypeError, ValueError):
            number = 0
        outgoing = min(cap, number) if number > 0 else cap
    return {'kind': 'memory', 'provider': 'hindsight', 'operation': operation,
            'inputTokens': input_tokens(raw), 'outputTokens': outgoing}


def _usage(result):
    if isinstance(result, dict):
        return usage_from(result)
    usage = getattr(result, 'usage', None)
    if isinstance(usage, dict):
        return usage_from({'usage': usage})
    return None


class PrivateMemory:
    RECALL_QUERY = ('Interview preferences, previous contribution context, unresolved questions, and user-confirmed '
                    'resume pointers. Never infer permissions or project results.')
    RETAIN_CONTEXT = 'ATLAS interview preference; not project evidence'
    CONTINUITY_CONTEXT = 'User-confirmed interview preferences and resume pointers; not verified project evidence'

    def __init__(self, config, client_factory=None, session=None, documents_factory=None):
        self.config = config
        self.factory = client_factory
        self.session = session
        self.documents_factory = documents_factory

    @property
    def enabled(self):
        return bool(self.config.hindsight_url)

    def bank(self, subject):
        raw = (subject.tid + ':' + subject.oid).encode()
        return 'atlas-user-' + hmac.new(self.config.bank_secret.encode(), raw, hashlib.sha256).hexdigest()

    def client(self):
        if self.factory:
            return self.factory()
        from hindsight_client import Hindsight
        return Hindsight(base_url=self.config.hindsight_url, api_key=self.config.hindsight_key or None, timeout=15, max_attempts=1)

    async def recall(self, subject):
        if not self.enabled:
            return ''
        cap = output_tokens('gatewayRecall')
        payload = {'query': self.RECALL_QUERY, 'budget': 'low', 'max_tokens': cap}
        hold = await reserve(memory_estimate('recall', payload, cap), self.session)
        c = self.client()
        try:
            response = await asyncio.wait_for(c.arecall(bank_id=self.bank(subject),
                query=self.RECALL_QUERY, budget='low', max_tokens=cap), timeout=8)
            await hold.settle(_usage(response))
            results = (response.results if hasattr(response, 'results') else response.get('results', [])) or []
            text = '\n'.join((r.text if hasattr(r, 'text') else r.get('text', '')) for r in results[:5])
            return text[:1200]
        except Exception as error:
            await hold.settle(error=type(error).__name__)
            raise
        finally:
            await c.aclose()

    async def retain(self, subject, preference):
        if not self.enabled:
            raise ValueError('Hindsight is not configured.')
        if not isinstance(preference, str) or not 1 <= len(preference.strip()) <= 300:
            raise ValueError('A preference must contain 1–300 characters.')
        content = 'The user explicitly stated this interview preference: ' + preference.strip()
        payload = {'content': content, 'context': self.RETAIN_CONTEXT}
        hold = await reserve(memory_estimate('retain', payload), self.session)
        c = self.client()
        try:
            await asyncio.wait_for(c.aretain(bank_id=self.bank(subject), content=content,
                context=self.RETAIN_CONTEXT), timeout=20)
            await hold.settle()
        except Exception as error:
            await hold.settle(error=type(error).__name__)
            raise
        finally:
            await c.aclose()

    async def replace_continuity(self, subject, content):
        """Explicitly edited summary replaces one fixed document; no full transcript ingestion."""
        if not self.enabled:
            raise ValueError('Hindsight is not configured')
        if not isinstance(content, str) or not 1 <= len(content.strip()) <= 4000:
            raise ValueError('Continuity must be 1–4,000 characters')
        text = content.strip()
        payload = {'content': text, 'context': self.CONTINUITY_CONTEXT, 'document_id': 'atlas-continuity'}
        hold = await reserve(memory_estimate('retain', payload), self.session)
        c = self.client()
        try:
            await asyncio.wait_for(c.aretain(bank_id=self.bank(subject), content=text,
                document_id='atlas-continuity', context=self.CONTINUITY_CONTEXT), timeout=25)
            await hold.settle()
        except Exception as error:
            await hold.settle(error=type(error).__name__)
            raise
        finally:
            await c.aclose()

    async def _documents_call(self, subject, delete):
        bank = self.bank(subject)
        if self.documents_factory:
            api = self.documents_factory()
            method = api.delete_document if delete else api.get_document
            return await asyncio.wait_for(method(bank_id=bank, document_id='atlas-continuity'), timeout=20)
        # Generated API methods documented by Hindsight; same server identity bank selection.
        from hindsight_client_api import ApiClient, Configuration
        from hindsight_client_api.api import DocumentsApi
        config = Configuration(host=self.config.hindsight_url)
        async with ApiClient(config) as c:
            if self.config.hindsight_key:
                c.set_default_header('Authorization', 'Bearer ' + self.config.hindsight_key)
            api = DocumentsApi(c)
            method = api.delete_document if delete else api.get_document
            return await asyncio.wait_for(method(bank_id=bank, document_id='atlas-continuity'), timeout=20)

    async def _document(self, subject, delete=False):
        if not self.enabled:
            raise ValueError('Hindsight is not configured')
        hold = await reserve(memory_estimate('forget' if delete else 'list'), self.session)
        try:
            result = await self._documents_call(subject, delete)
            await hold.settle(_usage(result))
            return result
        except Exception as error:
            await hold.settle(error=type(error).__name__)
            raise

    async def get_continuity(self, subject):
        result = await self._document(subject)
        return str(result.original_text)[:4000]

    async def delete_continuity(self, subject):
        result = await self._document(subject, True)
        return {'memory_units_deleted': getattr(result, 'memory_units_deleted', None)}
