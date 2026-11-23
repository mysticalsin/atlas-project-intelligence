"""Single-worker pilot identity: local loopback, confidential Entra, or VibeApps headers.

MSAL validates the Entra flow. This module then enforces the configured tenant,
application audience and required app role. No browser-supplied oid/tid is trusted.

ATLAS_AUTH=vibeapps reads only X-Forwarded-User-Email, X-Forwarded-User-Name, and
X-Forwarded-User-Id. It does not read Authorization, an Entra token, or a role header.
"""
from dataclasses import dataclass
import hashlib
import re
import secrets
import time
import uuid
from aiohttp import web

COOKIE = 'atlas_voice_session'
FORWARDED_ONLY = ('VibeApps identity accepts only X-Forwarded-User-Email, '
                  'X-Forwarded-User-Name, and X-Forwarded-User-Id.')
_FORWARDED = ('x-forwarded-user-email', 'x-forwarded-user-name', 'x-forwarded-user-id')
_USER_ID = re.compile(r'[A-Za-z0-9._:@-]{1,128}')

@dataclass
class Session:
    tid: str
    oid: str
    name: str
    csrf: str
    expires: float
    roles: tuple = ()
    email: str = ''

    @property
    def subject_key(self):
        return hashlib.sha256((self.tid + ':' + self.oid).encode()).hexdigest()[:32]

class Identity:
    def __init__(self, config):
        self.config = config
        self.sessions = {}
        self.flows = {}
        self.client = None
        if config.auth_mode == 'entra':
            import msal
            self.client = msal.ConfidentialClientApplication(config.client_id,
                authority=f'https://login.microsoftonline.com/{config.tenant}',
                client_credential=config.client_secret)

    def sweep(self):
        now = time.monotonic()
        self.sessions = {k: v for k, v in self.sessions.items() if v.expires > now}
        self.flows = {k: v for k, v in self.flows.items() if v[1] > now}

    def cookie_path(self):
        # No trailing slash, so /run/atlas and /run/atlas/ share the cookie and /run/atlas-dev does not.
        if self.config.base_path:
            return self.config.base_path.rstrip('/')
        return '/'

    def auth_prefix(self):
        return self.config.base_path.rstrip('/') if self.config.base_path else ''

    def session_key(self, request):
        pinned = request.get('atlas_session_key')
        if isinstance(pinned, str) and pinned:
            return pinned
        return request.cookies.get(COOKIE, '')

    def get(self, request):
        self.sweep()
        pinned = request.get('atlas_session')
        if pinned is not None:
            return pinned if pinned.expires > time.monotonic() else None
        if self.config.auth_mode == 'vibeapps':
            return None
        return self.sessions.get(request.cookies.get(COOKIE, ''))

    def read_forwarded(self, request):
        """The only identity inputs in vibeapps mode. Raises ValueError otherwise."""
        for key in request.headers.keys():
            lowered = key.lower()
            if lowered.startswith('x-forwarded-user-') and lowered not in _FORWARDED:
                raise ValueError(FORWARDED_ONLY)
        found = {}
        for name in _FORWARDED:
            values = request.headers.getall(name, [])
            if len(values) != 1:
                raise ValueError(FORWARDED_ONLY)
            found[name] = values[0]
        email = _forwarded_email(found['x-forwarded-user-email'])
        name = _forwarded_name(found['x-forwarded-user-name'])
        user_id = _forwarded_id(found['x-forwarded-user-id'])
        return email, name, user_id

    def bind_forwarded(self, request):
        """Attach the session for this request. Returns nothing. Sets a new cookie key when needed."""
        email, name, user_id = self.read_forwarded(request)
        self.sweep()
        key = request.cookies.get(COOKIE, '')
        current = self.sessions.get(key)
        if (current is not None and current.expires > time.monotonic()
                and current.tid == 'vibeapps' and current.oid == user_id):
            current.name = name
            current.email = email
            request['atlas_session'] = current
            request['atlas_session_key'] = key
            return
        new_key, session = self.issue('vibeapps', user_id, name)
        session.email = email
        request['atlas_session'] = session
        request['atlas_session_key'] = new_key
        request['atlas_new_session'] = new_key

    def issue(self, tid, oid, name):
        self.sweep()
        if len(self.sessions) >= self.config.max_sessions:
            raise web.HTTPServiceUnavailable(text='Too many sessions. Try again later.')
        key = secrets.token_urlsafe(32)
        session = Session(tid, oid, str(name)[:100], secrets.token_urlsafe(32), time.monotonic() + 3600)
        self.sessions[key] = session
        return key, session

    def require(self, request):
        session = self.get(request)
        if session is None:
            raise web.HTTPUnauthorized(text='Sign in before starting a voice session.')
        return session

    def set_cookie(self, response, key):
        response.set_cookie(COOKIE, key, httponly=True, secure=self.config.origin.startswith('https:'),
                            samesite='Lax', max_age=3600, path=self.cookie_path())

    def verify_claims(self, claims):
        if not isinstance(claims, dict):
            raise ValueError('Missing identity claims.')
        tid = str(uuid.UUID(claims.get('tid', '')))
        oid = str(uuid.UUID(claims.get('oid', '')))
        if tid.lower() != self.config.tenant.lower() or claims.get('aud') != self.config.client_id:
            raise ValueError('Wrong tenant or audience.')
        if not isinstance(claims.get('roles'), list) or claims.get('exp', 0) <= time.time() or self.config.required_role not in claims.get('roles', []):
            raise ValueError('Expired identity or missing application role.')
        return tid, oid, claims.get('name', 'Mantu colleague')

    async def login(self, request):
        if self.client is None:
            raise web.HTTPFound(self.cookie_path())
        import asyncio
        self.sweep()
        if len(self.flows) >= 100:
            raise web.HTTPTooManyRequests(text='Too many pending sign-ins.')
        flow = await asyncio.to_thread(self.client.initiate_auth_code_flow, scopes=[],
                redirect_uri=self.config.origin + self.auth_prefix() + '/auth/callback')
        key = secrets.token_urlsafe(32)
        self.flows[key] = (flow, time.monotonic() + 600)
        response = web.HTTPFound(flow['auth_uri'])
        response.set_cookie('atlas_login_flow', key, httponly=True,
             secure=self.config.origin.startswith('https:'), samesite='Lax', max_age=600,
             path=self.auth_prefix() + '/auth')
        return response

    async def callback(self, request):
        import asyncio
        self.sweep()
        record = self.flows.pop(request.cookies.get('atlas_login_flow', ''), None)
        if self.client is None or record is None:
            raise web.HTTPUnauthorized(text='Sign-in expired. Start again.')
        try:
            result = await asyncio.to_thread(self.client.acquire_token_by_auth_code_flow,
                                             record[0], dict(request.query))
            if 'error' in result:
                raise ValueError('Sign-in rejected.')
            tid, oid, name = self.verify_claims(result.get('id_token_claims'))
        except Exception:
            raise web.HTTPUnauthorized(text='Sign-in failed or ATLAS.Interview role is missing.') from None
        key, session = self.issue(tid, oid, name)
        session.roles = tuple(result.get("id_token_claims", {}).get("roles", []))
        response = web.HTTPFound(self.cookie_path())
        self.set_cookie(response, key)
        response.del_cookie('atlas_login_flow', path=self.auth_prefix() + '/auth')
        return response


def _no_controls(value: str) -> bool:
    return bool(value) and all(ord(ch) >= 32 and ord(ch) != 127 for ch in value)


def _forwarded_email(value: str) -> str:
    email = value.strip()
    if not _no_controls(email) or len(email) > 254:
        raise ValueError(FORWARDED_ONLY)
    local, sep, domain = email.partition('@')
    if sep != '@' or not local or not domain or '@' in domain or domain.startswith('.') or domain.endswith('.'):
        raise ValueError(FORWARDED_ONLY)
    return email


def _forwarded_name(value: str) -> str:
    name = value.strip()
    if not _no_controls(name) or len(name) > 100:
        raise ValueError(FORWARDED_ONLY)
    return name


def _forwarded_id(value: str) -> str:
    user_id = value.strip()
    if _USER_ID.fullmatch(user_id) is None:
        raise ValueError(FORWARDED_ONLY)
    return user_id
