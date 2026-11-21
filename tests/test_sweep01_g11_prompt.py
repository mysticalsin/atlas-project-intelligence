"""Sweep 01: a PersonaPlex handshake must not put project text on the upstream URL.

The prompt is the first upstream websocket message. The gateway talks to an
in-process fixture. No provider is called. HAM-03 is this same case.

Copied from tests/test_sweep01_b_prompt.py at 96712474 (PR #31) into this
g11-named file. The fixture reads one message, then sends 0x00.
"""
import asyncio
from dataclasses import replace
from urllib.parse import urlsplit

import aiohttp
import pytest
from aiohttp import web

from atlas_voice.config import Config
from atlas_voice.server import create_app
from tests.mock_personaplex import MockPersonaPlex

NOTE = 'SYNTHETIC-PROJECT-NOTE'
PREF = 'SYNTHETIC-PREFERENCE-PHRASE'
PROJECT = {
    'id': 'test-project', 'title': 'Operations improvement', 'consultant': 'Alex',
    'role': 'Engineer', 'sector': 'Industry', 'stage': 'Pilot',
    'answers': [NOTE, '', '', '', '', ''],
}


class PrefMemory:
    def __init__(self, config):
        self.config = config

    @property
    def enabled(self):
        return True

    async def recall(self, subject):
        return PREF


async def serve(app):
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    return runner, site._server.sockets[0].getsockname()[1]


@pytest.mark.asyncio
async def test_b4_upstream_url_does_not_carry_project_or_preference_text():
    mock = MockPersonaPlex(b'', handshake=b'\x00')
    seen = []
    first = []

    async def chat(request):
        seen.append(str(request.url))
        mock.prompts.append(dict(request.query))
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        try:
            msg = await asyncio.wait_for(ws.receive(), 2)
            data = msg.data
            first.append(data.decode('utf-8', 'replace') if isinstance(data, (bytes, bytearray)) else str(data or ''))
        except asyncio.TimeoutError:
            first.append('')
        await ws.send_bytes(b'\x00')
        await ws.close()
        return ws

    mock.chat = chat
    app = web.Application()
    app.router.add_get('/api/chat', mock.chat)
    upstream, up_port = await serve(app)
    import socket
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    cfg = replace(Config(), origin=origin, port=port, personaplex_url=f'ws://127.0.0.1:{up_port}/api/chat')
    gateway = create_app(cfg, memory_factory=PrefMemory)
    runner = web.AppRunner(gateway, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, '127.0.0.1', port).start()
    client = aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True))
    try:
        async with client.get(origin) as page:
            assert page.status == 200
        async with client.get(origin + '/api/bootstrap') as response:
            assert response.status == 200, await response.text()
            boot = await response.json()
        socket_client = await client.ws_connect(origin + '/api/voice', headers={'Origin': origin})
        await socket_client.send_json({
            'type': 'start', 'consent': True, 'csrf': boot['csrf'], 'project': PROJECT,
            'voice': 'NATF2.pt', 'capture': False, 'memory': True,
        })
        deadline = asyncio.get_event_loop().time() + 10
        while asyncio.get_event_loop().time() < deadline and not first:
            await asyncio.sleep(0.05)
        assert first, 'the gateway reached the fixture'
        query = urlsplit(seen[0]).query if seen else ''
        body = first[0]
        problems = []
        for marker in (NOTE, PREF):
            if marker in query:
                problems.append(marker + ' is in the upstream query')
            if marker not in body:
                problems.append(marker + ' is not in the first upstream websocket message')
        assert not problems, '; '.join(problems)
        await socket_client.close()
    finally:
        await client.close()
        await runner.cleanup()
        await upstream.cleanup()
