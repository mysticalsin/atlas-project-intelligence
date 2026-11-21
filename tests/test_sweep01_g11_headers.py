"""Sweep 01 group 11: ATLAS-10 isolation headers, prompt budget, and Sentinel L1–L3.

No provider is called. Microsoft and NVIDIA clients are not started. The voice
fixtures are in-process. Assertion text names markers and does not print the prompt.
"""
import asyncio
import json
import logging
import socket
import sys
import types
from dataclasses import replace
from urllib.parse import parse_qs, urlsplit

import aiohttp
import pytest
from aiohttp import web

from atlas_voice.config import Config
from atlas_voice.interview import ROLE, clean, make_prompt
from atlas_voice.server import create_app

NOTE = 'SYNTHETIC-PROJECT-NOTE'
PREF = 'SYNTHETIC-PREFERENCE-PHRASE'
PROJECT = {
    'id': 'test-project', 'title': 'Operations improvement', 'consultant': 'Alex',
    'role': 'Engineer', 'sector': 'Industry', 'stage': 'Pilot',
    'answers': [NOTE, '', '', '', '', ''],
}
# Values copied from deploy/cloudflare-edge/src/security-headers.js. Not imported.
HSTS = 'max-age=63072000; includeSubDomains'
ISOLATION = ('Strict-Transport-Security', 'Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy')
EXISTING = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
}


class PrefMemory:
    def __init__(self, config):
        self.config = config

    @property
    def enabled(self):
        return True

    async def recall(self, subject):
        return PREF


class _Msal:
    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs


def stub_msal(monkeypatch):
    monkeypatch.setitem(sys.modules, 'msal', types.SimpleNamespace(ConfidentialClientApplication=_Msal))


def entra(origin):
    return replace(
        Config(), origin=origin, auth_mode='entra',
        tenant='11111111-1111-1111-1111-111111111111',
        client_id='22222222-2222-2222-2222-222222222222',
        client_secret='synthetic-client-secret', required_role='ATLAS.Interview')


def assembled(project, preferences):
    context = dict(project)
    context.pop('id', None)
    context['prior_notes'] = dict(context.get('prior_notes', {}))
    prefs = clean(preferences, 500)
    data = json.dumps(context, ensure_ascii=False, separators=(',', ':'))
    return ROLE + '\nPROJECT DATA: ' + data + '\nINTERVIEW PREFERENCES: ' + prefs


def leaked(markers, *blobs):
    found = []
    for blob in blobs:
        text = blob if isinstance(blob, str) else str(blob)
        for marker in markers:
            if marker in text and marker not in found:
                found.append(marker)
    return found


async def serve(app, host='127.0.0.1'):
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, host, 0)
    await site.start()
    return runner, site._server.sockets[0].getsockname()[1]


async def get_origin(origin, monkeypatch, path='/'):
    stub_msal(monkeypatch)
    app = create_app(entra(origin))
    runner, port = await serve(app)
    client = aiohttp.ClientSession()
    host = urlsplit(origin).netloc
    try:
        async with client.get(f'http://127.0.0.1:{port}{path}', headers={'Host': host}) as response:
            status = response.status
            headers = dict(response.headers)
            await response.read()
            return status, headers
    finally:
        await client.close()
        await runner.cleanup()


@pytest.mark.asyncio
@pytest.mark.parametrize('origin', ['https://atlas.example', 'https://atlas.example:8443'])
async def test_https_origin_sends_isolation_headers(origin, monkeypatch):
    status, headers = await get_origin(origin, monkeypatch)
    assert status == 200
    assert headers['Strict-Transport-Security'] == HSTS
    assert headers['Cross-Origin-Opener-Policy'] == 'same-origin'
    assert headers['Cross-Origin-Resource-Policy'] == 'same-origin'
    for name, value in EXISTING.items():
        assert headers[name] == value


@pytest.mark.asyncio
@pytest.mark.parametrize('origin', ['http://127.0.0.1:9', 'http://localhost:9'])
async def test_http_loopback_omits_isolation_headers(origin, monkeypatch):
    status, headers = await get_origin(origin, monkeypatch)
    assert status == 200
    missing = [name for name in ISOLATION if name in headers]
    assert not missing, 'http loopback sent ' + ', '.join(missing)
    for name, value in EXISTING.items():
        assert headers[name] == value


@pytest.mark.asyncio
async def test_https_does_not_overwrite_a_handler_header(monkeypatch):
    stub_msal(monkeypatch)
    app = create_app(entra('https://atlas.example'))

    async def preset(request):
        response = web.Response(text='preset')
        response.headers['Strict-Transport-Security'] = 'max-age=1'
        return response

    app.router.add_get('/preset', preset)
    runner, port = await serve(app)
    client = aiohttp.ClientSession()
    try:
        async with client.get(f'http://127.0.0.1:{port}/preset', headers={'Host': 'atlas.example'}) as response:
            assert response.status == 200
            assert response.headers['Strict-Transport-Security'] == 'max-age=1'
            assert response.headers['Cross-Origin-Opener-Policy'] == 'same-origin'
            assert response.headers['Cross-Origin-Resource-Policy'] == 'same-origin'
    finally:
        await client.close()
        await runner.cleanup()


def test_short_project_prompt_keeps_the_b4_markers():
    project = {
        'title': 'Operations improvement', 'role': 'Engineer', 'sector': 'Industry',
        'stage': 'Pilot', 'prior_notes': {'Context': NOTE},
    }
    prompt = make_prompt(project, PREF)
    whole = assembled(project, PREF)
    problems = []
    if prompt != whole:
        problems.append('a short project was shrunk')
    if NOTE not in prompt or PREF not in prompt:
        problems.append('fixture markers did not survive make_prompt')
    if not prompt.startswith(ROLE):
        problems.append('prompt does not start with the role')
    assert not problems, '; '.join(problems)


def test_project_within_the_frame_budget_is_unchanged():
    """A prompt whose UTF-8 size is within 7400 bytes comes back unchanged."""
    skeleton = assembled({
        'title': 'Operations improvement', 'role': 'Engineer', 'sector': 'Industry',
        'stage': 'Pilot', 'prior_notes': {'Context': ''},
    }, '')
    room = 7400 - len(skeleton.encode())
    assert room > 100
    note = 'N' * (room - 1)
    project = {
        'title': 'Operations improvement', 'role': 'Engineer', 'sector': 'Industry',
        'stage': 'Pilot', 'prior_notes': {'Context': note},
    }
    whole = assembled(project, '')
    assert len(whole.encode()) <= 7400
    prompt = make_prompt(project, '')
    problems = []
    if prompt != whole:
        problems.append('a prompt within 7400 bytes was shrunk')
    if len(prompt.encode()) > 7400:
        problems.append('prompt exceeds 7400 bytes')
    assert not problems, '; '.join(problems)


def test_prior_note_over_the_frame_budget_shrinks():
    note = 'PRIOR-UNCUT-' + ('Z' * 8000)
    project = {
        'title': 'Operations improvement', 'role': 'Engineer', 'sector': 'Industry',
        'stage': 'Pilot', 'prior_notes': {'Context': note},
    }
    assert len(assembled(project, '').encode()) > 7400
    prompt = make_prompt(project, '')
    problems = []
    if not prompt.startswith(ROLE):
        problems.append('shrunk prompt does not start with the role')
    if len(prompt.encode()) > 7400:
        problems.append('shrunk prompt exceeds 7400 bytes')
    if note in prompt:
        problems.append('shrunk prompt still contains the uncut note')
    if not prompt.strip():
        problems.append('shrink returned an empty prompt')
    assert not problems, '; '.join(problems)


def test_shrink_never_returns_an_empty_prompt_for_a_titled_project():
    prompt = make_prompt({'title': 'Only a title', 'prior_notes': {}}, '')
    assert prompt.startswith(ROLE)
    assert 'Only a title' in prompt
    assert prompt.strip()


def _reserve():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


async def _boot(personaplex_url, *, monkeypatch=None):
    port = _reserve()
    origin = f'http://127.0.0.1:{port}'
    cfg = replace(Config(), origin=origin, port=port, personaplex_url=personaplex_url)
    if monkeypatch is not None:
        monkeypatch.setattr(Config, 'validate', lambda self: self)
    gateway = create_app(cfg, memory_factory=PrefMemory)
    runner = web.AppRunner(gateway, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, '127.0.0.1', port).start()
    client = aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True))
    async with client.get(origin) as page:
        assert page.status == 200
    async with client.get(origin + '/api/bootstrap') as response:
        assert response.status == 200
        boot = await response.json()
    return origin, boot, gateway, runner, client


async def _start(client, origin, boot, project=None):
    socket_client = await client.ws_connect(origin + '/api/voice', headers={'Origin': origin})
    await socket_client.send_json({
        'type': 'start', 'consent': True, 'csrf': boot['csrf'], 'project': project or PROJECT,
        'voice': 'NATF2.pt', 'capture': False, 'memory': True,
    })
    return socket_client


async def _events(socket_client, timeout=5):
    events = []
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        try:
            msg = await asyncio.wait_for(socket_client.receive(), 0.4)
        except asyncio.TimeoutError:
            continue
        if msg.type == aiohttp.WSMsgType.TEXT:
            data = json.loads(msg.data)
            events.append(data)
            if data.get('type') in ('error', 'ready'):
                return events
        elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
            return events
    return events


class _Grab(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())
        if record.args:
            self.lines.append(repr(record.args))
        if record.exc_info and record.exc_info[1] is not None:
            self.lines.append(str(record.exc_info[1]))


@pytest.mark.asyncio
async def test_l1_non_loopback_upstream_is_wss(monkeypatch):
    """A non-loopback host is connected with wss. ws:// to that host opens no socket."""

    async def attempt(url, *, bypass=False):
        attempted = []

        async def spy(upstream, **kwargs):
            attempted.append(str(upstream).split('?', 1)[0])
            raise aiohttp.ClientConnectionError('synthetic refusal')

        origin, boot, gateway, runner, client = await _boot(url, monkeypatch=monkeypatch if bypass else None)
        gateway['http'].ws_connect = spy
        socket_client = await _start(client, origin, boot)
        try:
            events = await _events(socket_client)
            kinds = [item.get('type') for item in events]
            assert 'error' in kinds, 'the session did not report the upstream result'
            return attempted
        finally:
            await socket_client.close()
            await client.close()
            await runner.cleanup()

    loopback = await attempt('ws://127.0.0.1:9/api/chat')
    assert loopback and loopback[0].startswith('ws://127.0.0.1'), 'loopback ws was not allowed'
    local_name = await attempt('ws://localhost:9/api/chat')
    assert local_name and local_name[0].startswith('ws://localhost'), 'localhost ws was not allowed'
    ipv6 = await attempt('ws://[::1]:9/api/chat')
    assert ipv6 and ipv6[0].startswith('ws://[::1]'), '::1 ws was not allowed'
    secure = await attempt('wss://atlas.example/api/chat')
    assert secure and secure[0].startswith('wss://atlas.example'), 'non-loopback connect did not use wss'
    refused = await attempt('ws://atlas.example/api/chat', bypass=True)
    assert refused == [], 'ws:// to a non-loopback host opened a socket'


@pytest.mark.asyncio
async def test_l2_prompt_markers_are_absent_from_logs_and_errors():
    async def chat(request):
        return web.Response(status=404, text='no')

    upstream_app = web.Application()
    upstream_app.router.add_get('/api/chat', chat)
    upstream, up_port = await serve(upstream_app)
    origin, boot, gateway, runner, client = await _boot(f'ws://127.0.0.1:{up_port}/api/chat')
    captured = []
    real = gateway['http'].ws_connect

    async def wrapped(url, **kwargs):
        try:
            return await real(url, **kwargs)
        except Exception as exc:
            captured.append(type(exc).__name__)
            captured.append(str(exc))
            raise

    gateway['http'].ws_connect = wrapped
    handler = _Grab()
    root = logging.getLogger()
    previous = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    socket_client = await _start(client, origin, boot)
    try:
        events = await _events(socket_client)
        messages = [str(item.get('message', '')) for item in events]
        found = leaked((NOTE, PREF), *handler.lines, *captured, *messages)
        assert captured, 'the upstream connect did not raise'
        assert not found, 'prompt marker leaked: ' + ', '.join(found)
    finally:
        root.removeHandler(handler)
        root.setLevel(previous)
        await socket_client.close()
        await client.close()
        await runner.cleanup()
        await upstream.cleanup()


@pytest.mark.asyncio
async def test_l3_prompt_frame_is_sent_before_any_audio():
    frames = []

    async def chat(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        try:
            msg = await asyncio.wait_for(ws.receive(), 2)
            frames.append((msg.type, msg.data if isinstance(msg.data, str) else ''))
        except asyncio.TimeoutError:
            frames.append((None, ''))
        await ws.send_bytes(b'\x00')
        await ws.close()
        return ws

    app = web.Application()
    app.router.add_get('/api/chat', chat)
    upstream, up_port = await serve(app)
    origin, boot, gateway, runner, client = await _boot(f'ws://127.0.0.1:{up_port}/api/chat')
    socket_client = await _start(client, origin, boot)
    try:
        deadline = asyncio.get_event_loop().time() + 8
        while asyncio.get_event_loop().time() < deadline and not frames:
            await asyncio.sleep(0.05)
        problems = []
        if not frames:
            problems.append('no upstream frame arrived')
        else:
            kind, text = frames[0]
            if kind != aiohttp.WSMsgType.TEXT:
                problems.append('the first upstream frame is not text')
            if NOTE not in text or PREF not in text:
                problems.append('the first text frame does not carry both markers')
            if any(item[0] == aiohttp.WSMsgType.BINARY for item in frames):
                problems.append('a binary frame was sent before the prompt text')
        assert not problems, '; '.join(problems)
    finally:
        await socket_client.close()
        await client.close()
        await runner.cleanup()
        await upstream.cleanup()


@pytest.mark.asyncio
async def test_prompt_punctuation_stays_off_the_upstream_query():
    title = 'Amp&Quest?'
    note = 'LINE-A\nLINE-B'
    project = {
        'id': 'test-project', 'title': title, 'consultant': 'Alex', 'role': 'Engineer',
        'sector': 'Industry', 'stage': 'Pilot', 'answers': [note, '', '', '', '', ''],
    }
    seen = []

    async def chat(request):
        seen.append(request.query_string)
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        try:
            await asyncio.wait_for(ws.receive(), 2)
        except asyncio.TimeoutError:
            pass
        try:
            await ws.send_bytes(b'\x00')
            await ws.close()
        except (ConnectionError, RuntimeError, aiohttp.ClientConnectionError):
            pass
        return ws

    app = web.Application()
    app.router.add_get('/api/chat', chat)
    upstream, up_port = await serve(app)
    origin, boot, gateway, runner, client = await _boot(f'ws://127.0.0.1:{up_port}/api/chat')
    socket_client = await _start(client, origin, boot, project)
    try:
        deadline = asyncio.get_event_loop().time() + 8
        while asyncio.get_event_loop().time() < deadline and not seen:
            await asyncio.sleep(0.05)
        assert seen, 'the gateway did not reach the fixture'
        query = seen[0]
        params = parse_qs(query, keep_blank_values=True)
        problems = []
        if set(params) != {'voice_prompt'}:
            problems.append('query keys are not voice_prompt only')
        if params.get('voice_prompt') != ['NATF2.pt']:
            problems.append('voice_prompt is not the voice file name')
        for needle in (title, 'Amp%26Quest', note, 'LINE-A', 'LINE-B', NOTE, PREF, 'text_prompt'):
            if needle in query:
                problems.append('query contains ' + needle.split('\n', 1)[0])
        assert not problems, '; '.join(problems)
    finally:
        await socket_client.close()
        await client.close()
        await runner.cleanup()
        await upstream.cleanup()
