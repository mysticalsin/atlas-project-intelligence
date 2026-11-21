"""Sweep 01: a PersonaPlex handshake must not put project text on the upstream URL.

The gateway talks to an in-process fixture. No provider is called.
"""
import asyncio
import json
from dataclasses import replace
from urllib.parse import urlsplit

import aiohttp
import pytest
from aiohttp import web

from atlas_voice.config import Config
from atlas_voice.server import create_app
from tests.mock_personaplex import MockPersonaPlex, opus_tone

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
    tone = await opus_tone(0.2)
    mock = MockPersonaPlex(tone, handshake=b'\x00')
    seen = []

    async def chat(request):
        seen.append(str(request.url))
        return await MockPersonaPlex.chat(mock, request)

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
        deadline = asyncio.get_event_loop().time() + 8
        while asyncio.get_event_loop().time() < deadline and not mock.prompts:
            message = await asyncio.wait_for(socket_client.receive(), 8)
            if message.type == aiohttp.WSMsgType.TEXT and json.loads(message.data).get('type') == 'ready':
                break
        assert mock.prompts, 'the gateway reached the fixture'
        carried = json.dumps(mock.prompts) + '\n' + '\n'.join(seen)
        for marker in (NOTE, PREF):
            assert marker not in carried
            for url in seen:
                assert marker not in urlsplit(url).query
        await socket_client.close()
    finally:
        await client.close()
        await runner.cleanup()
        await upstream.cleanup()
