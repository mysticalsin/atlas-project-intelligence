"""Cloudflare Tunnel + Access deployment shape: config, doctor profile and proxied boundary."""
import asyncio
from pathlib import Path
import sys
import types

import pytest
from aiohttp import web
from aiohttp.test_utils import make_mocked_request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from doctor import probe  # noqa: E402
from atlas_voice.config import Config  # noqa: E402

HOST = 'atlas.example.com'
TENANT = '11111111-2222-3333-4444-555555555555'
CLIENT = '66666666-7777-8888-9999-000000000000'
TUNNEL_ENV = {'ATLAS_VOICE_PROVIDER': 'openai', 'OPENAI_API_KEY': 'synthetic-not-a-key', 'ATLAS_AUTH': 'entra',
              'ATLAS_BIND': '127.0.0.1', 'ATLAS_ORIGIN': 'https://' + HOST, 'ENTRA_TENANT_ID': TENANT,
              'ENTRA_CLIENT_ID': CLIENT, 'ENTRA_CLIENT_SECRET': 'synthetic', 'HINDSIGHT_URL': 'https://memory.example.com',
              'HINDSIGHT_BANK_SECRET': 'x' * 32, 'ATLAS_WIKI_ROOT': '/var/lib/atlas/wiki'}


def status(report, name):
    return next(c['status'] for c in report['checks'] if c['name'] == name)


def test_tunnel_profile_accepts_loopback_bind_and_public_https_origin():
    report = probe('cloudflare', TUNNEL_ENV)
    for name in ('entra-mode', 'shared-https', 'tunnel-loopback-bind', 'tunnel-public-origin', 'configuration'):
        assert status(report, name) == 'pass', name
    assert report['live_verified'] is False


@pytest.mark.parametrize('override,check', [
    ({'ATLAS_BIND': '0.0.0.0'}, 'tunnel-loopback-bind'),
    ({'ATLAS_ORIGIN': 'https://localhost:8080'}, 'tunnel-public-origin'),
    ({'ATLAS_AUTH': 'local'}, 'entra-mode'),
    ({'ATLAS_ORIGIN': 'http://' + HOST}, 'shared-https'),
])
def test_tunnel_profile_rejects_unsafe_shapes(override, check):
    report = probe('cloudflare', {**TUNNEL_ENV, **override})
    assert status(report, check) == 'fail'
    assert not report['ready_for_local_prerequisites']


def test_local_mode_can_never_be_published_through_a_tunnel():
    with pytest.raises(ValueError):
        Config(origin='https://' + HOST, auth_mode='local').validate()


def test_cloudflared_template_pins_host_and_loopback_only():
    text = (ROOT / 'deploy/cloudflare/config.yml.example').read_text()
    assert f'hostname: {HOST}' in text and f'httpHostHeader: {HOST}' in text
    assert 'service: http://127.0.0.1:8080' in text
    assert text.rstrip().endswith('service: http_status:404')
    env = (ROOT / 'deploy/cloudflare/atlas.env.example').read_text()
    assert f'ATLAS_ORIGIN=https://{HOST}\n' in env and 'ATLAS_AUTH=entra\n' in env and 'ATLAS_BIND=127.0.0.1\n' in env
    assert 'OPENAI_API_KEY=\n' in env and 'ENTRA_CLIENT_SECRET=\n' in env


@pytest.fixture
def tunnel_app(monkeypatch):
    stub = types.ModuleType('msal')
    stub.ConfidentialClientApplication = lambda *a, **k: object()
    monkeypatch.setitem(sys.modules, 'msal', stub)
    from atlas_voice.server import create_app
    config = Config(origin='https://' + HOST, auth_mode='entra', tenant=TENANT, client_id=CLIENT,
                    client_secret='synthetic', voice_provider='openai')
    return create_app(config)


async def through_boundary(app, method, headers, cookies=None):
    request = make_mocked_request(method, '/probe', headers=headers, app=app)
    if cookies:
        request = request.clone(headers={**headers, 'Cookie': '; '.join(f'{k}={v}' for k, v in cookies.items())})
    async def handler(_):
        return web.Response(text='ok')
    try:
        return await app.middlewares[0](request, handler)
    except web.HTTPException as error:
        return error


def test_proxied_request_with_pinned_host_passes_and_direct_loopback_is_refused(tunnel_app):
    ok = asyncio.run(through_boundary(tunnel_app, 'GET', {'Host': HOST}))
    assert ok.status == 200 and ok.headers['Cache-Control'] == 'no-store'
    assert ok.headers['Content-Security-Policy'] == "default-src 'none'; frame-ancestors 'none'"
    direct = asyncio.run(through_boundary(tunnel_app, 'GET', {'Host': '127.0.0.1:8080'}))
    assert direct.status == 403


def test_proxied_writes_still_need_session_origin_and_csrf(tunnel_app):
    identity = tunnel_app['identity']
    key, session = identity.issue(TENANT, CLIENT, 'Synthetic tester')
    from atlas_voice.identity import COOKIE
    cookie = {COOKIE: key}
    good = {'Host': HOST, 'Origin': 'https://' + HOST, 'X-Atlas-CSRF': session.csrf}
    assert asyncio.run(through_boundary(tunnel_app, 'POST', good, cookie)).status == 200
    for bad in ({**good, 'Origin': 'http://' + HOST}, {**good, 'X-Atlas-CSRF': 'wrong'}):
        assert asyncio.run(through_boundary(tunnel_app, 'POST', bad, cookie)).status == 403
    assert asyncio.run(through_boundary(tunnel_app, 'POST', good)).status == 401


def test_session_cookie_is_secure_behind_https_origin(tunnel_app):
    response = web.Response()
    tunnel_app['identity'].set_cookie(response, 'synthetic')
    morsel = next(iter(response.cookies.values()))
    assert morsel['secure'] and morsel['httponly'] and morsel['samesite'] == 'Lax'


def test_kyutai_profile_requires_speech_services_and_flags_missing_analyst():
    env = {'ATLAS_VOICE_PROVIDER': 'kyutai', 'KYUTAI_STT_URL': 'wss://stt.example.com', 'KYUTAI_TTS_URL': 'wss://tts.example.com',
           'KYUTAI_VOICE': 'vctk/p225_023.wav',
           'CONVERSATION_CHAT_URL': 'https://api.example.com/v1/chat/completions', 'CONVERSATION_MODEL': 'talker'}
    report = probe('kyutai', env)
    assert status(report, 'selected-provider') == 'pass' and status(report, 'configuration') == 'pass'
    assert status(report, 'evidence-analyst') == 'warn'
    assert status(probe('kyutai', {**env, 'KYUTAI_TTS_URL': ''}), 'kyutai_tts_url') == 'fail'
