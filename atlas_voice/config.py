"""Explicit, server-side configuration. No provider endpoint comes from a browser."""
from dataclasses import dataclass, replace
from urllib.parse import urlsplit
import os
import re

LOOPBACK = {'localhost', '127.0.0.1', '::1'}
# Port the VibeApps application manifest publishes when ATLAS_PORT is unset.
MANIFEST_PORT = 8080
BASE_PATHS = ('/run/atlas/', '/run/atlas-dev/')


def canonical_base_path(value) -> str:
    """Empty, /run/atlas/, or /run/atlas-dev/. A missing trailing slash is added."""
    if not isinstance(value, str):
        raise ValueError('APP_BASE_PATH must be empty, /run/atlas/, or /run/atlas-dev/.')
    text = value.strip()
    if text == '':
        return ''
    if not text.startswith('/'):
        raise ValueError('APP_BASE_PATH must be empty, /run/atlas/, or /run/atlas-dev/.')
    if not text.endswith('/'):
        text += '/'
    if text not in BASE_PATHS:
        raise ValueError('APP_BASE_PATH must be empty, /run/atlas/, or /run/atlas-dev/.')
    return text
# kyutai/tts-voices folders published under CC BY-NC 4.0 (checked 2026-09-26).
NONCOMMERCIAL_VOICES = ('expresso/', 'ears/')
# Curated calm @cf/deepgram/aura-2-en speakers (Workers AI schema + Deepgram descriptions, 2026-09-27).
WORKERS_VOICES = ('harmonia', 'athena', 'pandora', 'vesta', 'odysseus', 'arcas', 'orpheus')
VOICES = ('NATF0.pt', 'NATF1.pt', 'NATF2.pt', 'NATF3.pt',
          'NATM0.pt', 'NATM1.pt', 'NATM2.pt', 'NATM3.pt')

def endpoint(value: str, *, websocket: bool = False) -> str:
    """TLS outside loopback, no URL credentials/query/fragment; fixed operator configuration."""
    if not value:
        return ''
    # urlsplit hides a newline, a trailing space, an empty userinfo and a bare '?' or '#'.
    # The gateway later uses this string as the request URL, so the raw text has to be plain.
    if any(ord(ch) < 33 or ord(ch) == 127 for ch in value) or any(ch in value for ch in '?#@'):
        raise ValueError('Use a plain configured endpoint URL without credentials, query or fragment.')
    u = urlsplit(value)
    allowed = ('ws', 'wss') if websocket else ('http', 'https')
    if u.scheme not in allowed or not u.hostname or u.username is not None or u.password is not None or u.query or u.fragment:
        raise ValueError('Use a plain configured endpoint URL without credentials, query or fragment.')
    try:
        port = u.port
    except ValueError:
        raise ValueError('Use a plain configured endpoint URL without credentials, query or fragment.') from None
    if port == 0:
        raise ValueError('Use a plain configured endpoint URL without credentials, query or fragment.')
    if u.scheme in ('http', 'ws') and u.hostname not in LOOPBACK:
        raise ValueError('Remote providers require verified TLS; use an SSH tunnel for a private local port.')
    return value.rstrip('/')

@dataclass(frozen=True)
class Config:
    origin: str = 'http://localhost:8080'
    bind: str = '127.0.0.1'
    port: int = MANIFEST_PORT
    personaplex_url: str = 'ws://127.0.0.1:8998/api/chat'
    voice: str = 'NATM1.pt'
    duration: int = 900
    speaking_limit: int = 600
    admin_role: str = 'ATLAS.Admin'
    handshake_timeout: int = 90
    auth_mode: str = 'local'
    tenant: str = ''
    client_id: str = ''
    client_secret: str = ''
    required_role: str = 'ATLAS.Interview'
    hindsight_url: str = ''
    hindsight_key: str = ''
    bank_secret: str = ''
    riva_uri: str = ''
    riva_ssl: bool = True
    riva_key: str = ''
    riva_function_id: str = ''
    riva_model: str = ''
    notes_url: str = ''
    notes_model: str = ''
    notes_key: str = ''
    ffmpeg: str = 'ffmpeg'
    voice_provider: str = 'personaplex'
    openai_key: str = ''
    openai_model: str = 'gpt-realtime-2.1'
    openai_voice: str = 'cedar'
    openai_transcribe: str = 'gpt-transcribe'
    wiki_root: str = ''
    max_interviews: int = 1
    max_sessions: int = 500
    analyst_url: str = ''
    analyst_model: str = ''
    analyst_key: str = ''
    kyutai_stt_url: str = ''
    kyutai_tts_url: str = ''
    kyutai_key: str = ''
    kyutai_voice: str = ''
    conversation_url: str = ''
    conversation_model: str = ''
    conversation_key: str = ''
    workers_account: str = ''
    workers_key: str = ''
    workers_stt_model: str = '@cf/deepgram/nova-3'
    workers_tts_model: str = '@cf/deepgram/aura-2-en'
    workers_voice: str = 'harmonia'
    base_path: str = ''

    @classmethod
    def env(cls):
        e = os.environ
        return cls(origin=e.get('ATLAS_ORIGIN', 'http://localhost:8080').rstrip('/'),
            bind=e.get('ATLAS_BIND', '127.0.0.1'), port=int(e.get('ATLAS_PORT', str(MANIFEST_PORT))),
            personaplex_url=e.get('PERSONAPLEX_WS_URL', 'ws://127.0.0.1:8998/api/chat'),
            voice=e.get('PERSONAPLEX_VOICE', 'NATM1.pt'),
            duration=int(e.get('ATLAS_MAX_SECONDS', '900')), speaking_limit=int(e.get('ATLAS_SPEAKING_SECONDS', '600')),
            admin_role=e.get('ENTRA_ADMIN_ROLE', 'ATLAS.Admin'),
            handshake_timeout=int(e.get('ATLAS_HANDSHAKE_TIMEOUT', '90')),
            auth_mode=e.get('ATLAS_AUTH', 'local'), tenant=e.get('ENTRA_TENANT_ID', ''),
            client_id=e.get('ENTRA_CLIENT_ID', ''), client_secret=e.get('ENTRA_CLIENT_SECRET', ''),
            required_role=e.get('ENTRA_REQUIRED_ROLE', 'ATLAS.Interview'),
            hindsight_url=e.get('HINDSIGHT_URL', ''), hindsight_key=e.get('HINDSIGHT_API_KEY', ''),
            bank_secret=e.get('HINDSIGHT_BANK_SECRET', ''), riva_uri=e.get('RIVA_URI', ''),
            riva_ssl=e.get('RIVA_SSL', 'true').lower() == 'true', riva_key=e.get('RIVA_API_KEY', ''),
            riva_function_id=e.get('RIVA_FUNCTION_ID', ''), riva_model=e.get('RIVA_MODEL', ''),
            notes_url=e.get('NOTES_CHAT_URL', ''), notes_model=e.get('NOTES_MODEL', ''),
            notes_key=e.get('NOTES_API_KEY', ''), ffmpeg=e.get('FFMPEG', 'ffmpeg'),
            voice_provider=e.get('ATLAS_VOICE_PROVIDER','personaplex'),openai_key=e.get('OPENAI_API_KEY',''),
            openai_model=e.get('OPENAI_REALTIME_MODEL','gpt-realtime-2.1'),openai_voice=e.get('OPENAI_REALTIME_VOICE','cedar'),
            openai_transcribe=e.get('OPENAI_TRANSCRIBE_MODEL','gpt-transcribe'),wiki_root=e.get('ATLAS_WIKI_ROOT',''),
            max_interviews=int(e.get('ATLAS_MAX_INTERVIEWS', '1')),
            max_sessions=int(e.get('ATLAS_MAX_SESSIONS', '500')),
            analyst_url=e.get('ANALYST_CHAT_URL', ''), analyst_model=e.get('ANALYST_MODEL', ''),
            analyst_key=e.get('ANALYST_API_KEY', ''),
            kyutai_stt_url=e.get('KYUTAI_STT_URL', ''), kyutai_tts_url=e.get('KYUTAI_TTS_URL', ''),
            kyutai_key=e.get('KYUTAI_API_KEY', ''), kyutai_voice=e.get('KYUTAI_VOICE', ''),
            conversation_url=e.get('CONVERSATION_CHAT_URL', ''), conversation_model=e.get('CONVERSATION_MODEL', ''),
            conversation_key=e.get('CONVERSATION_API_KEY', ''),
            workers_account=e.get('WORKERS_AI_ACCOUNT', ''), workers_key=e.get('WORKERS_AI_API_KEY', ''),
            workers_stt_model=e.get('WORKERS_STT_MODEL', '@cf/deepgram/nova-3'),
            workers_tts_model=e.get('WORKERS_TTS_MODEL', '@cf/deepgram/aura-2-en'),
            workers_voice=e.get('WORKERS_TTS_VOICE', 'harmonia'),
            base_path=e.get('APP_BASE_PATH', '')).validate()

    def validate(self):
        base = canonical_base_path(self.base_path)
        if base != self.base_path:
            return replace(self, base_path=base).validate()
        if self.voice_provider not in ('personaplex','openai','kyutai','workers'):raise ValueError('Explicit supported voice provider required')
        if self.openai_voice not in ('cedar','marin','ash','sage','verse'):raise ValueError('Unsupported hosted voice')
        if not re.fullmatch(r'[a-zA-Z0-9._-]{1,100}',self.openai_model):raise ValueError('Invalid voice model ID')
        if not re.fullmatch(r'[a-zA-Z0-9._-]{1,100}',self.openai_transcribe):raise ValueError('Invalid transcription model ID')
        endpoint(self.origin)
        if urlsplit(self.origin).path not in ('', '/'):
            raise ValueError('ATLAS_ORIGIN must be scheme://host:port, without a path.')
        endpoint(self.personaplex_url, websocket=True)
        endpoint(self.hindsight_url)
        endpoint(self.notes_url)
        endpoint(self.analyst_url)
        endpoint(self.kyutai_stt_url, websocket=True)
        endpoint(self.kyutai_tts_url, websocket=True)
        endpoint(self.conversation_url)
        if self.voice_provider == 'workers':
            if not re.fullmatch(r'[0-9a-f]{32}', self.workers_account) or not self.workers_key:
                raise ValueError('Cloudflare voice needs WORKERS_AI_ACCOUNT (32 hex) and WORKERS_AI_API_KEY.')
            for model in (self.workers_stt_model, self.workers_tts_model):
                if not re.fullmatch(r'@cf/[\w./-]{1,100}', model):
                    raise ValueError('Workers AI speech models must be @cf/... model IDs.')
            if self.workers_voice not in WORKERS_VOICES:
                raise ValueError('WORKERS_TTS_VOICE must be one of the aura-1 speakers.')
            if not (self.conversation_url and re.fullmatch(r'[\w.:/@-]{1,120}', self.conversation_model)):
                raise ValueError('Cloudflare voice needs CONVERSATION_CHAT_URL and CONVERSATION_MODEL.')
        if self.voice_provider == 'kyutai':
            if not (self.kyutai_stt_url and self.kyutai_tts_url and self.conversation_url):
                raise ValueError('Kyutai voice needs KYUTAI_STT_URL, KYUTAI_TTS_URL and CONVERSATION_CHAT_URL.')
            if not re.fullmatch(r'[\w.:/@-]{1,120}', self.conversation_model):
                raise ValueError('CONVERSATION_MODEL is required for Kyutai voice.')
            if not re.fullmatch(r'[\w./-]{1,200}', self.kyutai_voice) or '..' in self.kyutai_voice or self.kyutai_voice.startswith('/'):
                raise ValueError('KYUTAI_VOICE must be a voice name from the TTS server voice repository.')
            if self.kyutai_voice.startswith(NONCOMMERCIAL_VOICES):
                raise ValueError('That Kyutai voice set is licensed for non-commercial use only; choose a CC0/CC-BY voice.')
        if self.voice not in VOICES:
            raise ValueError('Select one of the bundled natural PersonaPlex voice filenames.')
        if not 30 <= self.duration <= 900 or not 5 <= self.handshake_timeout <= 180 or not 60 <= self.speaking_limit <= 1800:
            raise ValueError('Invalid duration or handshake timeout.')
        if not 10 <= self.max_sessions <= 20000:
            raise ValueError('ATLAS_MAX_SESSIONS must be between 10 and 20000.')
        if not 1 <= self.max_interviews <= 100:
            raise ValueError('ATLAS_MAX_INTERVIEWS must be between 1 and 100.')
        if self.voice_provider == 'personaplex' and self.max_interviews != 1:
            raise ValueError('The stock PersonaPlex worker serves one interview; keep ATLAS_MAX_INTERVIEWS=1.')
        if self.auth_mode not in ('local', 'entra', 'vibeapps'):
            raise ValueError('ATLAS_AUTH must be local, entra, or vibeapps.')
        if self.auth_mode == 'local':
            if self.bind not in LOOPBACK or urlsplit(self.origin).hostname not in LOOPBACK:
                raise ValueError('Unauthenticated local mode may bind and serve loopback only.')
        elif self.auth_mode == 'vibeapps':
            if self.base_path not in BASE_PATHS:
                raise ValueError('VibeApps serves under APP_BASE_PATH /run/atlas/ or /run/atlas-dev/.')
            if urlsplit(self.origin).hostname not in LOOPBACK and not self.origin.startswith('https://'):
                raise ValueError('A shared deployment requires HTTPS.')
        else:
            uuid = r'[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}'
            if not re.fullmatch(uuid, self.tenant) or not re.fullmatch(uuid, self.client_id):
                raise ValueError('Entra mode requires explicit tenant and client UUIDs.')
            if not self.client_secret or not self.required_role:
                raise ValueError('Entra mode requires a confidential client secret and an assigned app role.')
            if urlsplit(self.origin).hostname not in LOOPBACK and not self.origin.startswith('https://'):
                raise ValueError('A shared deployment requires HTTPS.')
        if self.hindsight_url and len(self.bank_secret) < 32:
            raise ValueError('Set a stable HINDSIGHT_BANK_SECRET of at least 32 characters.')
        if self.analyst_url and not re.fullmatch(r'[\w.:/@-]{1,120}', self.analyst_model):
            raise ValueError('ANALYST_MODEL is required with ANALYST_CHAT_URL.')
        if self.notes_url and not self.notes_model:
            raise ValueError('NOTES_MODEL is required with NOTES_CHAT_URL.')
        if self.riva_uri:
            host = self.riva_uri.rsplit(':', 1)[0].strip('[]')
            if '://' in self.riva_uri or not re.fullmatch(r'[\w.\-\[\]:]+:\d+', self.riva_uri):
                raise ValueError('RIVA_URI is a host:port, not a URL.')
            if not self.riva_ssl and host not in LOOPBACK:
                raise ValueError('Remote Riva requires TLS.')
        return self
