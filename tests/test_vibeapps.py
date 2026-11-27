"""VibeApps packaging: header identity, base path, and adapters that refuse to connect.

No Postgres, Blob, Key Vault, or provider call is made.
"""
import ast
import hashlib
import socket
from dataclasses import replace
from pathlib import Path

import aiohttp
from aiohttp import web
from multidict import MultiDict
import pytest

from atlas_voice.config import BASE_PATHS, MANIFEST_PORT, Config
from atlas_voice.identity import FORWARDED_ONLY, Identity, _forwarded_id, _forwarded_name
from atlas_voice.multiinstance import AdapterRefused, BlobAdapter, PostgresAdapter
from atlas_voice.server import create_app

ROOT = Path(__file__).resolve().parents[1]
HEADERS = {
    'X-Forwarded-User-Email': 'packaging-ada@example.test',
    'X-Forwarded-User-Name': 'Packaging Ada',
    'X-Forwarded-User-Id': 'user-ada-1',
}
SECRET_NAMES = (
    'openai-api-key', 'kyutai-api-key', 'conversation-api-key', 'analyst-api-key',
    'typesafe-api-key', 'entra-client-secret', 'hindsight-api-key', 'hindsight-bank-secret',
    'riva-api-key', 'notes-api-key', 'workers-ai-api-key',
)


def subject_key(user_id):
    return hashlib.sha256(('vibeapps:' + user_id).encode()).hexdigest()[:32]


class Gateway:
    async def start(self, base='/run/atlas/', auth='vibeapps'):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        self.origin = f'http://127.0.0.1:{port}'
        self.base = base
        self.cfg = replace(Config(), origin=self.origin, port=port, auth_mode=auth, base_path=base).validate()
        self.app = create_app(self.cfg)
        self.runner = web.AppRunner(self.app, access_log=None)
        await self.runner.setup()
        await web.TCPSite(self.runner, '127.0.0.1', port).start()
        self.client = aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True))
        return self

    def url(self, path):
        return self.origin + self.base.rstrip('/') + path

    async def close(self):
        await self.client.close()
        await self.runner.cleanup()


def test_manifest_port_is_the_unset_listen_port():
    assert MANIFEST_PORT == 8080
    assert Config().port == MANIFEST_PORT
    assert Config.env().port == MANIFEST_PORT


def test_vibeapps_requires_a_platform_prefix_and_not_entra_secrets():
    with pytest.raises(ValueError):
        replace(Config(), auth_mode='vibeapps').validate()
    with pytest.raises(ValueError):
        replace(Config(), auth_mode='vibeapps', base_path='/run/other/').validate()
    with pytest.raises(ValueError):
        replace(Config(), origin='http://atlas.example', bind='0.0.0.0',
                auth_mode='vibeapps', base_path='/run/atlas/').validate()
    for base in BASE_PATHS:
        cfg = replace(Config(), origin='https://atlas.example', bind='0.0.0.0',
                      auth_mode='vibeapps', base_path=base.rstrip('/')).validate()
        assert cfg.base_path == base
        assert cfg.client_secret == ''
        assert Identity(cfg).client is None


def test_local_and_unknown_auth_stay_closed():
    with pytest.raises(ValueError):
        replace(Config(), auth_mode='unknown').validate()
    assert replace(Config(), auth_mode='local').validate().auth_mode == 'local'


def test_adapters_refuse_without_opening_a_socket(monkeypatch):
    calls = []
    original = socket.socket

    def wrapped(*args, **kwargs):
        calls.append('socket')
        return original(*args, **kwargs)

    def refused(*args, **kwargs):
        calls.append('create_connection')
        raise AssertionError('create_connection')

    monkeypatch.setattr(socket, 'socket', wrapped)
    monkeypatch.setattr(socket, 'create_connection', refused)
    source = (ROOT / 'atlas_voice' / 'multiinstance.py').read_text(encoding='utf-8')
    tree = ast.parse(source)
    imported = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.append(node.module or '')
    assert imported == []
    dsn = 'postgresql://user:s3cret@db.example:5432/atlas'
    postgres = PostgresAdapter(dsn)
    blob = BlobAdapter('https://account.blob.core.windows.net/stories?sig=s3cret')
    assert postgres.configured and blob.configured
    for adapter, call in ((postgres, postgres.connect), (postgres, lambda: postgres.session('k')),
                          (postgres, lambda: postgres.lock('interview')), (postgres, lambda: postgres.throttle('ada')),
                          (postgres, postgres.registry), (blob, blob.connect),
                          (blob, lambda: blob.put('r1', b'md')), (blob, lambda: blob.get('r1'))):
        with pytest.raises(AdapterRefused) as error:
            call()
        text = str(error.value)
        assert 's3cret' not in text and 'db.example' not in text and 'blob.core' not in text
    assert calls == []


def test_packaging_doc_names_secrets_without_values():
    text = (ROOT / 'docs' / 'VIBEAPPS_PACKAGING.md').read_text(encoding='utf-8')
    for name in SECRET_NAMES:
        assert '`' + name + '`' in text
    assert '8080' in text and '/run/atlas/' in text and '/run/atlas-dev/' in text
    assert 'X-Forwarded-User-Email' in text and 'X-Forwarded-User-Name' in text and 'X-Forwarded-User-Id' in text
    assert 'refuse to connect' in text
    lowered = text.lower()
    for banned in ('sk-', 'accountkey=', 'begin private', 'sig=', 'password='):
        assert banned not in lowered
    example = (ROOT / '.env.example').read_text(encoding='utf-8')
    assert 'replace-with' not in example
    for line in example.splitlines():
        body = line.split('#', 1)[0]
        if '=' not in body:
            continue
        key, _, value = body.partition('=')
        if any(part in key.upper() for part in ('KEY', 'SECRET', 'TOKEN', 'PASSWORD')):
            assert value.strip() == '', key


def test_voice_socket_rewrite_string_stays():
    """studio_browser.py rewrites this exact call. The base-path branch must not remove it."""
    source = (ROOT / 'src' / 'voice-client.js').read_text(encoding='utf-8')
    assert "new URL('/api/voice',location.href)" in source
    keeper = (ROOT / 'src' / 'session-keeper.js').read_text(encoding='utf-8')
    assert "if(!['http:','https:'].includes(location.protocol))" in keeper


@pytest.mark.asyncio
@pytest.mark.parametrize('base', ['/run/atlas/', '/run/atlas-dev/'])
async def test_vibeapps_accepts_only_the_three_headers_under_the_prefix(base):
    gate = await Gateway().start(base=base)
    try:
        async with gate.client.get(gate.url('/api/bootstrap'), headers=HEADERS) as response:
            assert response.status == 200
            body = await response.json()
            cookie = response.headers.getall('Set-Cookie')
        assert body['identity']['name'] == 'Packaging Ada'
        assert body['identity']['mode'] == 'vibeapps'
        assert body['identity']['subjectKey'] == subject_key('user-ada-1')
        assert body['basePath'] == base
        assert body['csrf']
        expected_path = 'Path=' + base.rstrip('/')
        assert any(part.strip() == expected_path for item in cookie for part in item.split(';'))
        async with gate.client.get(gate.url('/api/bootstrap'), headers=HEADERS) as response:
            again = await response.json()
        assert again['csrf'] == body['csrf']
        async with gate.client.get(gate.origin + '/api/bootstrap', headers=HEADERS) as response:
            assert response.status == 404
        async with gate.client.get(gate.origin + '/', headers=HEADERS) as response:
            assert response.status == 404
        async with gate.client.get(gate.origin + base.rstrip('/'), headers=HEADERS) as response:
            page = await response.text()
            assert response.status == 200
        assert 'Packaging Ada' in page and 'packaging-ada@example.test' not in page
        assert '"basePath": "' + base + '"' in page or '"basePath":"' + base + '"' in page
        async with gate.client.get(gate.url('/api/intelligence'), headers=HEADERS) as response:
            status = await response.json()
        assert status['roles'] == []
        async with gate.client.post(gate.url('/api/preference'), headers=HEADERS, json={'preference': 'short'}) as response:
            assert response.status == 403
        async with gate.client.post(gate.url('/api/preference'), headers={**HEADERS, 'Origin': gate.origin, 'X-Atlas-CSRF': body['csrf']},
                                     json={'preference': 'short'}) as response:
            assert response.status == 400
            assert 'Hindsight' in await response.text()
    finally:
        await gate.close()


@pytest.mark.asyncio
async def test_missing_extra_and_bearer_headers_are_not_identity():
    gate = await Gateway().start()
    try:
        partial = {key: value for key, value in HEADERS.items() if key != 'X-Forwarded-User-Id'}
        async with gate.client.get(gate.url('/api/bootstrap'), headers=partial) as response:
            assert response.status == 401
            assert FORWARDED_ONLY in await response.text()
        extra = {**HEADERS, 'X-Forwarded-User-Roles': 'ATLAS.Admin'}
        async with gate.client.get(gate.url('/api/bootstrap'), headers=extra) as response:
            assert response.status == 401
            text = await response.text()
        assert 'ATLAS.Admin' not in text
        async with gate.client.get(gate.url('/api/bootstrap'), headers={'Authorization': 'Bearer not-a-user'}) as response:
            assert response.status == 401
        both = {**HEADERS, 'Authorization': 'Bearer not-a-user'}
        async with gate.client.get(gate.url('/api/bootstrap'), headers=both) as response:
            body = await response.json()
        assert body['identity']['subjectKey'] == subject_key('user-ada-1')
        bad = {**HEADERS, 'X-Forwarded-User-Id': '../etc/passwd'}
        async with gate.client.get(gate.url('/api/bootstrap'), headers=bad) as response:
            assert response.status == 401
        with pytest.raises(ValueError):
            _forwarded_name('Ada\nLovelace')
        with pytest.raises(ValueError):
            _forwarded_id('../etc/passwd')
        duplicated = MultiDict(list(HEADERS.items()) + [('X-Forwarded-User-Email', 'other@example.com')])
        async with gate.client.get(gate.url('/api/bootstrap'), headers=duplicated) as response:
            assert response.status == 401
            assert 'other@example.com' not in await response.text()
    finally:
        await gate.close()


@pytest.mark.asyncio
async def test_same_id_keeps_the_subject_when_the_email_changes():
    gate = await Gateway().start()
    try:
        async with gate.client.get(gate.url('/api/bootstrap'), headers=HEADERS) as response:
            first = await response.json()
        changed = {**HEADERS, 'X-Forwarded-User-Email': 'packaging-ada.moved@example.test'}
        async with gate.client.get(gate.url('/api/bootstrap'), headers=changed) as response:
            second = await response.json()
        other = {**HEADERS, 'X-Forwarded-User-Id': 'user-grace-2', 'X-Forwarded-User-Name': 'Grace Hopper',
                 'X-Forwarded-User-Email': 'grace@example.com'}
        async with gate.client.get(gate.url('/api/bootstrap'), headers=other) as response:
            third = await response.json()
        assert first['identity']['subjectKey'] == second['identity']['subjectKey'] == subject_key('user-ada-1')
        assert third['identity']['subjectKey'] == subject_key('user-grace-2')
        assert third['csrf'] != first['csrf']
    finally:
        await gate.close()


@pytest.mark.asyncio
async def test_local_mode_ignores_forwarded_headers():
    gate = await Gateway().start(base='', auth='local')
    try:
        spoof = {**HEADERS, 'X-Forwarded-User-Name': 'Spoofed Name', 'X-Forwarded-User-Id': 'not-the-developer'}
        async with gate.client.get(gate.origin + '/', headers=spoof) as response:
            page = await response.text()
            assert response.status == 200
        assert 'Spoofed Name' not in page and 'Local developer' in page
        async with gate.client.get(gate.origin + '/api/bootstrap') as response:
            body = await response.json()
        assert body['identity']['mode'] == 'local'
        assert body['identity']['name'] == 'Local developer'
        assert 'basePath' not in body
    finally:
        await gate.close()
