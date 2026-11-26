"""Private Hindsight preferences. Actual SDK calls, never browser-chosen banks.

No automatic transcript ingestion. Only explicit preference writes are retained.
"""
import asyncio
import hashlib
import hmac


def _text_or_blank(value):
    """A memory field is text. Null is blank, not the word None."""
    return value if isinstance(value, str) else ''


def _recalled_line(item):
    if hasattr(item, 'text'):
        value = item.text
    elif isinstance(item, dict):
        value = item.get('text', '')
    else:
        value = ''
    return _text_or_blank(value)


class PrivateMemory:
    def __init__(self, config, client_factory=None):
        self.config = config
        self.factory = client_factory

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
        c = self.client()
        try:
            response = await asyncio.wait_for(c.arecall(bank_id=self.bank(subject),
                query='Interview preferences, previous contribution context, unresolved questions, and user-confirmed resume pointers. Never infer permissions or project results.',
                budget='low', max_tokens=300), timeout=8)
            results = (response.results if hasattr(response, 'results') else response.get('results', [])) or []
            text = '\n'.join(line for line in (_recalled_line(item) for item in results[:5]) if line)
            return text[:1200]
        finally:
            await c.aclose()

    async def retain(self, subject, preference):
        if not self.enabled:
            raise ValueError('Hindsight is not configured.')
        if not isinstance(preference, str) or not 1 <= len(preference.strip()) <= 300:
            raise ValueError('A preference must contain 1–300 characters.')
        c = self.client()
        try:
            await asyncio.wait_for(c.aretain(bank_id=self.bank(subject),
                content='The user explicitly stated this interview preference: ' + preference.strip(),
                context='ATLAS interview preference; not project evidence'), timeout=20)
        finally:
            await c.aclose()

    async def replace_continuity(self, subject, content):
        """Explicitly edited summary replaces one fixed document; no full transcript ingestion."""
        if not self.enabled:raise ValueError('Hindsight is not configured')
        if not isinstance(content,str) or not 1<=len(content.strip())<=4000:raise ValueError('Continuity must be 1–4,000 characters')
        c=self.client()
        try:
            await asyncio.wait_for(c.aretain(bank_id=self.bank(subject),content=content.strip(),
                document_id='atlas-continuity',context='User-confirmed interview preferences and resume pointers; not verified project evidence'),timeout=25)
        finally:await c.aclose()

    async def _document(self,subject,delete=False):
        if not self.enabled:raise ValueError('Hindsight is not configured')
        # Generated API methods documented by Hindsight; same server identity bank selection.
        from hindsight_client_api import ApiClient, Configuration
        from hindsight_client_api.api import DocumentsApi
        config=Configuration(host=self.config.hindsight_url)
        async with ApiClient(config) as c:
            if self.config.hindsight_key:c.set_default_header('Authorization','Bearer '+self.config.hindsight_key)
            api=DocumentsApi(c)
            method=api.delete_document if delete else api.get_document
            result=await asyncio.wait_for(method(bank_id=self.bank(subject),document_id='atlas-continuity'),timeout=20)
            return result

    async def get_continuity(self,subject):
        result=await self._document(subject)
        return _text_or_blank(result.original_text)[:4000]

    async def delete_continuity(self,subject):
        result=await self._document(subject,True)
        return {'memory_units_deleted':getattr(result,'memory_units_deleted',None)}
