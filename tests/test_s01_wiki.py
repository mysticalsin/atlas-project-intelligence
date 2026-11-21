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
from atlas_voice.wiki import WikiVault
from tests.test_quality import person, story

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
                assert body['truncated'] is (pages == 1)
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


def test_atlas09_page_cursor_limit_and_exact_summary(tmp_path):
    vault = WikiVault(tmp_path / 'wiki')
    author = person('author')
    try:
        first = vault.save(author, story('internal'))
        alone = vault.page(author, 'internal', limit=1)
        assert alone['next'] is None and len(alone['stories']) == 1 and set(alone['stories'][0]) == ALLOWED
        second_raw = story('internal')
        second_raw['title'] = 'Second synthetic catalogue story'
        second = vault.save(author, second_raw)
        seen = []
        after = None
        for _ in range(3):
            page = vault.page(author, 'internal', after=after, limit=1)
            assert page['limit'] == 1 and len(page['stories']) == 1
            assert set(page['stories'][0]) == ALLOWED
            seen.append(page['stories'][0]['id'])
            after = page['next']
            if not after:
                break
        assert after is None and seen == [second['id'], first['id']]
        third = story('internal')
        third['title'] = 'Third synthetic catalogue story'
        vault.save(author, third)
        calls = {'n': 0}
        real_get = vault.get
        def counting(subject, ident):
            calls['n'] += 1
            return real_get(subject, ident)
        vault.get = counting
        limited = vault.page(author, 'internal', limit=1)
        assert limited['truncated'] is True and limited['next']
        assert calls['n'] <= 2
        for bad in (0, 201, True, -1):
            with pytest.raises(ValueError):
                vault.page(author, 'internal', limit=bad)
        with pytest.raises(ValueError):
            vault.page(author, 'internal', after='not-a-real-story')
    finally:
        vault.close()


@pytest.mark.asyncio
async def test_atlas09_http_limit_above_the_cap_is_rejected(tmp_path):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    app = create_app(replace(Config(), origin=origin, port=port, wiki_root=str(tmp_path / 'vault')))
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, '127.0.0.1', port).start()
    try:
        async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True)) as client:
            await client.get(origin)
            response = await client.get(origin + '/api/wiki?audience=internal&limit=201')
            assert response.status == 400
    finally:
        await runner.cleanup()


def test_atlas09_catalogue_keeps_the_gap_count(tmp_path):
    vault = WikiVault(tmp_path / 'wiki')
    author = person('author')
    try:
        raw = story('internal')
        raw['sections']['limitations'] = 'Unknown until the owner confirms the limit.'
        saved = vault.save(author, raw)
        full = vault.get(author, saved['id'])
        item = vault.page(author, 'internal')['stories'][0]
        assert item['quality_gap_count'] == len(full['quality_gaps'])
        assert item['quality_gap_count'] >= 1
        assert 'quality_gaps' not in item
        assert 'markdown' not in item
    finally:
        vault.close()
