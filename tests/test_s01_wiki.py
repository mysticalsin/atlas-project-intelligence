"""ATLAS-09: GET /api/wiki is a capped summary, not every story in full.

Red on main 8b0972ec. Not skipped and not an expected failure. Synthetic stories only.
"""
import json
import socket
from dataclasses import replace

import aiohttp
import pytest
from aiohttp import web

from atlas_voice.config import Config
from atlas_voice.identity import Session
from atlas_voice.server import create_app
from tests.test_quality import story

BODY = ('markdown', 'sections', 'sources', 'customer_brief')
ALLOWED = {'id', 'title', 'revision', 'audience', 'eligible', 'stage', 'kind', 'content_hash'}
MARKER = 'SYNTHETIC-EXCERPT-ATLAS09'
CAP = 200


def author_session():
    return Session('local', 'single-developer', 'Local developer', 'csrf', 10**12)


@pytest.mark.asyncio
async def test_atlas09_wiki_list_is_a_capped_summary_without_body_fields(tmp_path):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    app = create_app(replace(Config(), origin=origin, port=port, wiki_root=str(tmp_path / 'vault')))
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, '127.0.0.1', port).start()
    author = author_session()
    ids = []
    try:
        for n in range(CAP + 1):
            raw = story('internal')
            raw['title'] = f'Synthetic catalogue story {n}'
            raw['sources'][0]['excerpt'] = f'{MARKER} {n}'
            ids.append(app['wiki'].save(author, raw)['id'])
        async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True)) as client:
            await client.get(origin)
            seen = []
            after = None
            pages = 0
            while True:
                pages += 1
                assert pages <= 3
                url = origin + '/api/wiki?audience=internal' + (f'&after={after}' if after else '')
                response = await client.get(url)
                assert response.status == 200
                body = await response.json()
                assert body['limit'] == CAP
                assert len(body['stories']) <= CAP
                for item in body['stories']:
                    assert set(item) <= ALLOWED
                    assert {'id', 'title', 'revision', 'audience', 'eligible'} <= set(item)
                    assert not any(key in item for key in BODY)
                    assert MARKER not in json.dumps(item)
                seen.extend(item['id'] for item in body['stories'])
                after = body['next']
                if not after:
                    break
            assert pages == 2
            assert len(seen) == CAP + 1 and len(set(seen)) == CAP + 1
            full = await (await client.get(origin + '/api/wiki/' + ids[0])).json()
            assert MARKER in full['markdown'] and 'sections' in full and MARKER in json.dumps(full['sources'])
    finally:
        await runner.cleanup()
