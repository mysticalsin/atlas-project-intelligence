"""Live registry wiring for story links. Synthetic records only.

No provider, Entra, Hindsight, or Teams calls.
"""

import json
import socket
import time
from dataclasses import replace

import aiohttp
import pytest
from aiohttp import web

from atlas_voice.config import Config
from atlas_voice.identity import COOKIE, Session
from atlas_voice.jev import DIMENSIONS, JevRanker
from atlas_voice.memory import PrivateMemory
from atlas_voice.server import create_app
from atlas_voice.story_attachment import StoryAttachmentStore
from atlas_voice.wiki import SECTIONS, WikiVault


def person(name, roles=()):
    return Session('tenant', name, name, 'csrf', time.monotonic() + 60, roles)


def story(title='FICTIONAL triage pilot', audience='customer-anonymized'):
    return {
        'title': title,
        'stage': 'Pilot',
        'kind': 'qualitative',
        'audience': audience,
        'tags': ['service-operations'],
        'sections': {key: 'Fictional ' + key + ' account, limited to one queue. Not a claimed company result.' for key in SECTIONS},
        'sources': [{
            'id': 'E1',
            'version': 'fictional-v1',
            'excerpt': 'Synthetic acceptance record, not a real customer source.',
            'supports': ['challenge', 'contribution', 'approach', 'outcome'],
        }],
        'customer_brief': 'Operations teams seeking predictable intake, with process ownership.',
    }


def registry_counts(vault):
    return {
        name: vault.db.execute('SELECT COUNT(*) AS n FROM ' + name).fetchone()['n']
        for name in ('stories', 'access', 'approvals', 'audit')
    }


def markdown_bytes(vault):
    return sorted((path.relative_to(vault.root).as_posix(), path.read_bytes()) for path in vault.root.rglob('*.md'))


def jev_result(score=3, confidence=0.8):
    return {
        'model': 'jev-test-fixture',
        'answers': {
            key: {
                'type': 'score',
                'score': score,
                'confidence': confidence,
                'probabilities': {str(i): 1 if i == score else 0 for i in range(5)},
            }
            for key in DIMENSIONS
        },
    }


class JevResponse:
    status = 200

    def __init__(self, payload):
        self.payload = payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def json(self):
        return self.payload


class JevHTTP:
    def __init__(self):
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return JevResponse(jev_result())


@pytest.fixture
def vault(tmp_path):
    opened = WikiVault(tmp_path / 'wiki')
    yield opened
    opened.close()


def test_registry_links_consultant_group_and_project(vault):
    author = person('author')
    colleague = person('colleague')
    third = person('third')
    saved = vault.save(author, story())
    before = markdown_bytes(vault)
    counts = registry_counts(vault)
    keys = [author.subject_key, colleague.subject_key, third.subject_key]
    consultant = vault.create_story_target(author, {'kind': 'consultant', 'participants': [author.subject_key]})
    group = vault.create_story_target(author, {'kind': 'group', 'participants': [keys[2], keys[0], keys[0]]})
    project = vault.create_story_target(author, {'kind': 'project', 'participants': [keys[1], keys[0], keys[2], keys[1]]})
    assert isinstance(vault.story_links(), StoryAttachmentStore)
    assert [consultant['kind'], group['kind'], project['kind']] == ['consultant', 'group', 'project']
    assert consultant['participants'] == [author.subject_key]
    assert group['participants'] == sorted([author.subject_key, third.subject_key])
    assert project['participants'] == sorted(keys)
    for target in (consultant, group, project):
        assert target['participant_order'] == 'set'
        assert target['ranking'] is None and target['score'] is None and target['customer_claim'] is False
        attached = vault.attach_story(author, target['id'], {'story_id': saved['id'], 'consent': True})
        assert attached['revision'] == saved['revision'] and attached['content_hash'] == saved['content_hash']
        assert attached['reference_only'] is True and attached['customer_claim'] is False
        assert attached['customer_eligible'] is False
        brief = vault.eligible_story_links(author, target['id'])
        assert brief['stories'] == [] and brief['ranks'] == 'stories' and brief['consultant_ranking'] is None
    assert markdown_bytes(vault) == before
    assert registry_counts(vault) == counts
    blob = (vault.root / 'story-attachments' / 'story-attachments.sqlite3').read_bytes()
    assert b'FICTIONAL triage pilot' not in blob
    assert b'Synthetic acceptance record' not in blob
    with pytest.raises(ValueError, match='multiple consultants'):
        vault.create_story_target(author, {'kind': 'project', 'participants': [author.subject_key]})
    with pytest.raises(PermissionError, match='only that consultant'):
        vault.create_story_target(author, {'kind': 'consultant', 'participants': [author.subject_key, colleague.subject_key]})


def test_registry_link_keeps_the_immutable_revision(vault):
    author = person('author')
    colleague = person('colleague')
    saved = vault.save(author, story(title='FICTIONAL hidden pin'))
    project = vault.create_story_target(author, {'kind': 'project', 'participants': [author.subject_key, colleague.subject_key]})
    attached = vault.attach_story(author, project['id'], {'story_id': saved['id'], 'consent': True})
    revised = vault.save(author, story(title='FICTIONAL revised pin'), saved['id'], saved['content_hash'])
    assert revised['revision'] == saved['revision'] + 1
    assert len(markdown_bytes(vault)) == 2
    listed = vault.list_story_links(author, project['id'])
    assert listed[0]['attachment_id'] == attached['attachment_id']
    assert listed[0]['revision'] == saved['revision'] and listed[0]['pinned_current'] is False
    hidden = vault.list_story_links(colleague, project['id'])
    assert hidden[0]['accessible'] is False and 'title' not in hidden[0]
    with pytest.raises(PermissionError):
        vault.get(colleague, saved['id'])
    with pytest.raises(PermissionError):
        vault.attach_story(colleague, project['id'], {'story_id': saved['id'], 'consent': True})
    assert vault.eligible_story_links(author, project['id'])['stories'] == []
    assert registry_counts(vault)['access'] == 0 and registry_counts(vault)['approvals'] == 0


def test_registry_refuses_private_memory_rank_and_rewrite(vault):
    author = person('author')
    colleague = person('colleague')
    saved = vault.save(author, story())
    before = markdown_bytes(vault)
    with pytest.raises(ValueError, match='private memory'):
        vault.create_story_target(author, {
            'kind': 'group',
            'participants': [author.subject_key, colleague.subject_key],
            'private_memory': 'synthetic continuity',
        })
    project = vault.create_story_target(author, {'kind': 'group', 'participants': [author.subject_key, colleague.subject_key]})
    with pytest.raises(ValueError, match='private memory'):
        vault.attach_story(author, project['id'], {'story_id': saved['id'], 'consent': True, 'memory': 'synthetic'})
    with pytest.raises(PermissionError, match='Explicit consent'):
        vault.attach_story(author, project['id'], {'story_id': saved['id'], 'consent': False})
    assert vault.list_story_links(author, project['id']) == []
    assert markdown_bytes(vault) == before


@pytest.mark.asyncio
async def test_jev_refuses_consultants_and_private_memory():
    class HTTP:
        def post(self, *args, **kwargs):
            raise AssertionError('JEV was called')

    ranker = JevRanker(HTTP(), key='')
    brief = {key: 'Synthetic ' + key for key in ('problem', 'buyer', 'constraints', 'desired_outcome')}
    with pytest.raises(ValueError, match='never consultants'):
        await ranker.rank([{'participants': [person('author').subject_key], 'eligible': True}], brief)
    with pytest.raises(ValueError, match='Private memory'):
        await ranker.rank([{'memory': 'synthetic continuity', 'eligible': True}], brief)
    with pytest.raises(ValueError, match='never consultants'):
        await ranker.rank({'kind': 'project', 'participants': [person('author').subject_key]}, brief)


@pytest.mark.asyncio
async def test_http_registry_links_rank_stories_only(monkeypatch, tmp_path):
    async def refused_memory(self, *args, **kwargs):
        raise AssertionError('private memory was called')

    monkeypatch.setattr(PrivateMemory, 'replace_continuity', refused_memory)
    monkeypatch.setattr(PrivateMemory, 'get_continuity', refused_memory)
    monkeypatch.setattr(PrivateMemory, 'delete_continuity', refused_memory)
    monkeypatch.setenv('TYPESAFE_API_KEY', 'FIXTURE')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    origin = 'http://127.0.0.1:' + str(port)
    app = create_app(replace(Config(), origin=origin, port=port, wiki_root=str(tmp_path / 'vault')))
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, '127.0.0.1', port).start()
    transport = JevHTTP()
    original_http = app['http']
    app['http'] = transport
    try:
        async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True)) as client:
            await client.get(origin)
            boot = await (await client.get(origin + '/api/bootstrap')).json()
            headers = {'Origin': origin, 'X-Atlas-CSRF': boot['csrf']}
            me = boot['identity']['subjectKey']
            colleague = person('colleague')
            assert colleague.subject_key != me
            author = next(session for session in app['identity'].sessions.values() if session.oid == 'single-developer')

            async def post(path, payload, extra=None):
                return await client.post(origin + path, headers=extra or headers, json=payload)

            memory = await post('/api/wiki/targets', {
                'kind': 'project',
                'participants': [me, colleague.subject_key],
                'private_memory': 'synthetic continuity',
            })
            assert memory.status == 400 and 'Private memory' in await memory.text()
            assert app['wiki'].story_links().db.execute('SELECT COUNT(*) AS n FROM targets').fetchone()['n'] == 0

            lone = await post('/api/wiki/targets', {'kind': 'project', 'participants': [me]})
            assert lone.status == 400
            other = await post('/api/wiki/targets', {'kind': 'consultant', 'participants': [me, colleague.subject_key]})
            assert other.status == 403
            consultant = await (await post('/api/wiki/targets', {'kind': 'consultant', 'participants': [me]})).json()
            group = await (await post('/api/wiki/targets', {'kind': 'group', 'participants': [colleague.subject_key, me, me]})).json()
            project = await (await post('/api/wiki/targets', {'kind': 'project', 'participants': [colleague.subject_key, me]})).json()
            assert consultant['participants'] == [me]
            assert group['participants'] == sorted([me, colleague.subject_key])
            assert project['participants'] == sorted([me, colleague.subject_key])
            assert project['ranking'] is None and project['customer_claim'] is False and project['participant_order'] == 'set'

            first = await (await post('/api/wiki', {'story': story('FICTIONAL alpha queue')})).json()
            second = await (await post('/api/wiki', {'story': story('FICTIONAL beta queue')})).json()
            assert first['revision'] == 1 and second['revision'] == 1 and first['eligible'] is False
            missing = await post('/api/wiki/targets/' + project['id'] + '/attach', {'story_id': first['id']})
            assert missing.status == 400
            denied = await post('/api/wiki/targets/' + project['id'] + '/attach', {'story_id': first['id'], 'consent': False})
            assert denied.status == 403
            counts = registry_counts(app['wiki'])
            files = markdown_bytes(app['wiki'])
            attached = await (await post('/api/wiki/targets/' + project['id'] + '/attach', {'story_id': first['id'], 'consent': True})).json()
            again = await (await post('/api/wiki/targets/' + project['id'] + '/attach', {'story_id': second['id'], 'consent': True})).json()
            assert attached['content_hash'] == first['content_hash'] and again['revision'] == 1
            assert registry_counts(app['wiki']) == counts
            assert markdown_bytes(app['wiki']) == files
            current = await (await client.get(origin + '/api/wiki/' + first['id'])).json()
            assert current['revision'] == 1 and current['eligible'] is False and current['withdrawn'] is False

            customer = {
                'problem': 'zzzxylophone',
                'buyer': 'qqqmarble',
                'constraints': 'vvvkiln',
                'desired_outcome': 'wwwobsidian',
            }
            early = await post('/api/wiki/rank', {'audience': 'customer-anonymized', 'customer_brief': customer, 'consent': True, 'target_id': project['id']})
            early_body = await early.json()
            assert early.status == 200 and early_body['ranked'] == [] and early_body['consultant_ranking'] is None
            assert early_body['ranks'] == 'stories' and transport.calls == []

            reviewer = person('reviewer', ('ATLAS.Review', 'ATLAS.Publish'))
            for record in (first, second):
                app['wiki'].grant(author, record['id'], reviewer.subject_key)
                saved = record
                for kind in ('facts', 'permission'):
                    saved = app['wiki'].approve(reviewer, record['id'], record['content_hash'], kind, 'Reviewed synthetic fixture', time.time() + 3600)
                record['eligible'] = saved['eligible']
            reviewed = app['wiki'].get(author, first['id'])
            assert reviewed['eligible'] is True
            from atlas_voice.jev import shortlist
            assert shortlist([reviewed, app['wiki'].get(author, second['id'])], customer) == []
            plain = await post('/api/wiki/rank', {'audience': 'customer-anonymized', 'customer_brief': customer, 'consent': True})
            assert plain.status == 200 and (await plain.json())['ranked'] == [] and transport.calls == []

            ranked = await post('/api/wiki/rank', {'audience': 'customer-anonymized', 'customer_brief': customer, 'consent': True, 'target_id': project['id']})
            body = await ranked.json()
            assert ranked.status == 200
            assert body['ranks'] == 'stories' and body['consultant_ranking'] is None
            assert body['private_memory_is_not_evidence'] is True
            assert [item['id'] for item in body['rankings']] == sorted([first['id'], second['id']])
            assert 'participants' not in body and me not in body['candidate_selection']
            assert colleague.subject_key not in body['candidate_selection']
            sent_ids = []
            for url, kwargs in transport.calls:
                assert url == 'https://api.typesafe.ai/v1/systemone'
                payload = kwargs['json']
                encoded = json.dumps(payload)
                assert me not in encoded and colleague.subject_key not in encoded
                assert 'participant' not in payload['state']['eligible_story']
                assert 'owner' not in payload['state']['eligible_story']
                assert 'memory' not in payload['state']['eligible_story']
                sent_ids.append(payload['state']['eligible_story']['id'])
            assert sent_ids == sorted([first['id'], second['id']])

            key, colleague_session = app['identity'].issue('tenant', 'colleague', 'Colleague')
            assert colleague_session.subject_key == colleague.subject_key
            other_headers = {'Origin': origin, 'X-Atlas-CSRF': colleague_session.csrf, 'Cookie': COOKIE + '=' + key}
            async with aiohttp.ClientSession() as other:
                hidden = await other.get(origin + '/api/wiki/' + first['id'], headers=other_headers)
                assert hidden.status == 403
                blocked = await other.post(
                    origin + '/api/wiki/targets/' + project['id'] + '/attach',
                    headers=other_headers,
                    json={'story_id': first['id'], 'consent': True},
                )
                assert blocked.status == 403
                visible = await (await other.get(origin + '/api/wiki/targets/' + project['id'] + '/attachments', headers=other_headers)).json()
            assert visible['ranks'] == 'stories' and visible['consultant_ranking'] is None
            assert all(item['accessible'] is False and 'title' not in item for item in visible['attachments'])

            dropped = await (await post('/api/wiki/attachments/' + attached['attachment_id'] + '/detach', {})).json()
            assert dropped['detached'] is True
            assert (await (await client.get(origin + '/api/wiki/' + first['id'])).json())['withdrawn'] is False
            assert len(markdown_bytes(app['wiki'])) == 2
            blob = (app['wiki'].root / 'story-attachments' / 'story-attachments.sqlite3').read_bytes()
            assert b'FICTIONAL alpha queue' not in blob and b'FICTIONAL beta queue' not in blob
    finally:
        app['http'] = original_http
        await runner.cleanup()
