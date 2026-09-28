"""Single-worker pilot identity: local loopback or a real confidential Entra auth-code flow.

MSAL validates the returned flow. This module then enforces the configured tenant,
application audience and required app role. No browser-supplied oid/tid is trusted.
"""
from dataclasses import dataclass
import hashlib
import secrets
import time
import uuid
from aiohttp import web

COOKIE = 'atlas_voice_session'

@dataclass
class Session:
    tid: str
    oid: str
    name: str
    csrf: str
    expires: float
    roles: tuple = ()

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

    def get(self, request):
        self.sweep()
        return self.sessions.get(request.cookies.get(COOKIE, ''))

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
                            samesite='Lax', max_age=3600, path='/')

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
            raise web.HTTPFound('/')
        import asyncio
        self.sweep()
        if len(self.flows) >= 100:
            raise web.HTTPTooManyRequests(text='Too many pending sign-ins.')
        flow = await asyncio.to_thread(self.client.initiate_auth_code_flow, scopes=[],
                redirect_uri=self.config.origin + '/auth/callback')
        key = secrets.token_urlsafe(32)
        self.flows[key] = (flow, time.monotonic() + 600)
        response = web.HTTPFound(flow['auth_uri'])
        response.set_cookie('atlas_login_flow', key, httponly=True,
             secure=self.config.origin.startswith('https:'), samesite='Lax', max_age=600, path='/auth')
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
        response = web.HTTPFound('/')
        self.set_cookie(response, key)
        response.del_cookie('atlas_login_flow', path='/auth')
        return response
