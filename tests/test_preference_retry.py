"""A preference that was not saved must not start the ten-second wait."""
import socket
from dataclasses import replace

import aiohttp
import pytest
from aiohttp import web

from atlas_voice.config import Config
from atlas_voice.server import create_app


class Memory:
    def __init__(self, config, fail_first=False):
        self.calls = 0
        self.fail_first = fail_first

    @property
    def enabled(self):
        return True

    async def retain(self, subject, preference):
        self.calls += 1
        if self.fail_first and self.calls == 1:
            raise RuntimeError('store down')


async def serve(memory_factory):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    origin = 'http://127.0.0.1:' + str(port)
    app = create_app(replace(Config(), origin=origin, port=port), memory_factory=memory_factory)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, '127.0.0.1', port).start()
    client = aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True))
    async with client.get(origin + '/') as page:
        assert page.status == 200
    async with client.get(origin + '/api/bootstrap') as boot:
        token = (await boot.json())['csrf']
    return runner, client, origin, token


def post(client, origin, token, payload):
    return client.post(origin + '/api/preference', json=payload, headers={
        'Origin': origin, 'X-Atlas-CSRF': token})


@pytest.mark.asyncio
async def test_a_failed_preference_write_can_be_retried_at_once():
    runner, client, origin, token = await serve(lambda config: Memory(config, fail_first=True))
    try:
        async with post(client, origin, token, {'preference': 'Keep questions short'}) as first:
            assert first.status == 502
            assert 'No success is assumed' in await first.text()
        async with post(client, origin, token, {'preference': 'Keep questions short'}) as second:
            assert second.status == 200
            assert (await second.json())['saved'] is True
    finally:
        await client.close()
        await runner.cleanup()


@pytest.mark.asyncio
async def test_a_rejected_preference_body_does_not_start_the_wait():
    runner, client, origin, token = await serve(Memory)
    try:
        async with post(client, origin, token, {'preference': 'Keep questions short', 'bank': 'other'}) as bad:
            assert bad.status == 400
        async with post(client, origin, token, {'preference': 'Keep questions short'}) as good:
            assert good.status == 200
    finally:
        await client.close()
        await runner.cleanup()


@pytest.mark.asyncio
async def test_a_saved_preference_still_waits_before_another():
    runner, client, origin, token = await serve(Memory)
    try:
        async with post(client, origin, token, {'preference': 'Keep questions short'}) as first:
            assert first.status == 200
        async with post(client, origin, token, {'preference': 'One question at a time'}) as second:
            assert second.status == 429
    finally:
        await client.close()
        await runner.cleanup()
