"""Slice 1: the Python gateway script policy is hash-only. It does not claim GDPR compliance."""
import asyncio
import importlib.util
from dataclasses import replace
from pathlib import Path

import aiohttp
from aiohttp import web

from atlas_voice.config import Config
from atlas_voice.server import create_app, csp

UUID = '11111111-1111-4111-8111-111111111111'


def test_gateway_script_policy_has_no_unsafe_inline():
    policy = csp(Config(origin='https://atlas.example'))
    script = policy.split('script-src ', 1)[1].split(';', 1)[0]
    assert 'unsafe-inline' not in script
    assert "script-src-attr 'none'" in policy
    assert "style-src 'unsafe-inline'" in policy
    assert 'wss://atlas.example' in policy


def _csp_helpers():
    path = Path(__file__).with_name('test_csp.py')
    spec = importlib.util.spec_from_file_location('csp_helpers', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_json_responses_carry_no_blob_or_websocket(monkeypatch):
    helpers = _csp_helpers()

    async def go():
        origin, _app, runner, client = await helpers.served(monkeypatch)
        try:
            async with client.get(origin + '/') as home:
                assert home.status == 200
            async with client.get(origin + '/api/bootstrap') as response:
                policy = response.headers['Content-Security-Policy']
                assert 'blob:' not in policy
                assert 'wss:' not in policy and 'ws:' not in policy
                assert "default-src 'none'" in policy
        finally:
            await client.close()
            await runner.cleanup()

    asyncio.run(go())


def test_sign_in_page_script_src_is_none():
    helpers = _csp_helpers()

    async def go():
        import sys
        import types
        stub = types.ModuleType('msal')

        class ConfidentialClientApplication:
            def __init__(self, *args, **kwargs):
                pass

        stub.ConfidentialClientApplication = ConfidentialClientApplication
        sys.modules['msal'] = stub
        origin = helpers.free_origin()
        config = replace(Config(), origin=origin, port=int(origin.rsplit(':', 1)[1]), auth_mode='entra',
                         tenant=UUID, client_id=UUID, client_secret='synthetic-secret', required_role='ATLAS.User')
        app = create_app(config)
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        await web.TCPSite(runner, '127.0.0.1', config.port).start()
        client = aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True))
        try:
            async with client.get(origin + '/') as response:
                assert response.status == 200
                assert 'Sign in with Microsoft Entra ID' in await response.text()
                policy = response.headers['Content-Security-Policy']
                script = policy.split('script-src ', 1)[1].split(';', 1)[0].strip()
                assert script == "'none'"
                assert 'blob:' not in policy
        finally:
            await client.close()
            await runner.cleanup()

    asyncio.run(go())
