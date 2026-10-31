"""B1: the gateway ships HSTS, COOP, CORP and the Permissions-Policy on every response, refusals included."""
import asyncio
import sys
import types

import pytest
from aiohttp import web
from aiohttp.test_utils import make_mocked_request

from atlas_voice.config import Config

HOST = 'atlas.example.com'
TENANT = '11111111-2222-3333-4444-555555555555'
CLIENT = '66666666-7777-8888-9999-000000000000'
REQUIRED = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
}


def make_app(monkeypatch, **overrides):
    stub = types.ModuleType('msal')
    stub.ConfidentialClientApplication = lambda *a, **k: object()
    monkeypatch.setitem(sys.modules, 'msal', stub)
    from atlas_voice.server import create_app
    base = dict(origin='https://' + HOST, auth_mode='entra', tenant=TENANT, client_id=CLIENT, client_secret='synthetic', voice_provider='openai')
    return create_app(Config(**{**base, **overrides}))


async def through(app, method, headers):
    request = make_mocked_request(method, '/probe', headers=headers, app=app)

    async def handler(_):
        return web.Response(text='ok')
    try:
        return await app.middlewares[0](request, handler)
    except web.HTTPException as error:  # a refusal that escaped would also lack the headers: the assertion below would not see it
        return error


def check(response):
    for name, value in REQUIRED.items():
        assert response.headers[name] == value, name
    policy = response.headers['Permissions-Policy']
    assert 'microphone=(self)' in policy and 'camera=()' in policy and 'geolocation=()' in policy and 'payment=()' in policy
    assert "frame-ancestors 'none'" in response.headers['Content-Security-Policy']


def test_https_gateway_sends_hsts_and_the_full_set_on_ok_and_every_refusal(monkeypatch):
    app = make_app(monkeypatch)
    ok = asyncio.run(through(app, 'GET', {'Host': HOST}))
    assert ok.status == 200
    check(ok)
    assert ok.headers['Strict-Transport-Security'] == 'max-age=63072000; includeSubDomains'
    wrong_host = asyncio.run(through(app, 'GET', {'Host': 'evil.example'}))            # raised before the handler ran
    no_session = asyncio.run(through(app, 'POST', {'Host': HOST}))                      # identity.require refuses
    bad_origin = asyncio.run(through(app, 'POST', {'Host': HOST, 'Origin': 'https://evil.example'}))
    for refused in (wrong_host, no_session, bad_origin):
        assert refused.status in (401, 403)
        check(refused)
        assert refused.headers['Strict-Transport-Security'] == 'max-age=63072000; includeSubDomains'


def test_local_http_gateway_has_no_hsts_but_keeps_the_rest(monkeypatch):
    app = make_app(monkeypatch, origin='http://127.0.0.1:8080', auth_mode='local', tenant='', client_id='', client_secret='')
    ok = asyncio.run(through(app, 'GET', {'Host': '127.0.0.1:8080'}))
    check(ok)
    assert 'Strict-Transport-Security' not in ok.headers
    refused = asyncio.run(through(app, 'GET', {'Host': 'evil.example'}))
    assert refused.status == 403
    check(refused)
