"""F1: the strict script CSP. Python half: hash freshness against the built page and the edge's generated list, byte parity of the policy
with the edge Worker's builder (run through node), and the gateway serving the page with its own hashes and the runtime as a JSON block."""
import asyncio
import json
import re
import shutil
import socket
import subprocess
from dataclasses import replace
from pathlib import Path

import aiohttp
import pytest
from aiohttp import web

from atlas_voice.config import Config
from atlas_voice.csp import RUNTIME_BLOCK, html_csp, legacy_csp, script_hashes
from atlas_voice.server import create_app, csp, csp_headers

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy/cloudflare-edge/src'
PAGE = (ROOT / 'ATLAS_Voice.html').read_text()


def test_script_hashes_cover_executable_inline_scripts_only():
    page = ('<script>alert(1)</script><script type="text/javascript">b()</script><script type="module">c()</script>'
            '<script type="application/json" id="x">{}</script><script type="text/plain">notcode</script><script src="x.js"></script>'
            '<SCRIPT>alert(1)</SCRIPT>')
    got = script_hashes(page)
    assert len(got) == 3  # the two identical bodies collapse; json, text/plain and src are not executable
    assert all(re.fullmatch(r'sha256-[A-Za-z0-9+/]{43}=', h) for h in got) and got == sorted(got)
    assert script_hashes('<script>a()</script>') == ['sha256-' + __import__('base64').b64encode(__import__('hashlib').sha256(b'a()').digest()).decode()]


def test_built_page_hashes_match_the_edge_generated_module_and_the_meta_policy():
    generated = json.loads(re.search(r'PAGE_SCRIPT_HASHES = (\[.*?\]);', (EDGE / 'csp.generated.js').read_text(), re.S).group(1))
    assert script_hashes(PAGE) == generated, 'run python3 build.py: the generated hash list is stale'
    meta = re.search(r'<meta content="([^"]*)" http-equiv="Content-Security-Policy"/>', PAGE).group(1)
    assert sorted(re.findall(r"'(sha256-[^']+)'", meta)) == generated
    assert 'unsafe-inline' not in re.search(r'script-src ([^;]*)', meta).group(1) and "script-src-attr 'none'" in meta
    assert PAGE.count(RUNTIME_BLOCK) == 1 and '__CSP_SCRIPT_SRC__' not in PAGE


def test_every_built_page_alias_is_identical():
    for name in ('ATLAS_Intelligence.html', 'ATLAS_Project_Intelligence.html', 'ATLAS_Voice_Studio.html'):
        assert (ROOT / name).read_text() == PAGE, name


@pytest.mark.skipif(shutil.which('node') is None, reason='node is needed to compare with the edge builder')
def test_policy_is_byte_identical_to_the_edge_builder():
    cases = [
        ({'hashes': ['sha256-aaa', 'sha256-bbb'], 'connect': 'wss://a.example', 'scriptBlob': True, 'workerBlob': True, 'mediaBlob': True},
         dict(hashes=['sha256-aaa', 'sha256-bbb'], connect='wss://a.example', script_blob=True, worker_blob=True, media_blob=True)),
        ({}, {}),
        ({'hashes': ['sha256-aaa'], 'report': False, 'connect': 'ws://127.0.0.1:8080', 'scriptBlob': True, 'workerBlob': True, 'mediaBlob': True},
         dict(hashes=['sha256-aaa'], report=False, connect='ws://127.0.0.1:8080', script_blob=True, worker_blob=True, media_blob=True)),
        ({'hashes': ['sha256-a', 'sha256-b'], 'connectSelf': False, 'scriptBlob': False, 'imgSrc': 'data:', 'fontSelf': False, 'workerBlob': False, 'mediaBlob': False, 'trustedTypes': 'none', 'report': False, 'formAction': "'none'", 'frameAncestors': 'https://t.example https://*.t.example'},
         dict(hashes=['sha256-a', 'sha256-b'], connect_self=False, script_blob=False, img_src='data:', font_self=False, worker_blob=False, media_blob=False, trusted_types='none', report=False, form_action="'none'", frame_ancestors='https://t.example https://*.t.example')),
        ({'scriptBlob': False, 'workerBlob': False, 'mediaBlob': False}, dict(script_blob=False, worker_blob=False, media_blob=False)),
    ]
    script = ("import('./csp.js').then(m=>{const cases=JSON.parse(process.argv[1]);console.log(JSON.stringify(cases.map(c=>m.htmlCsp(c)).concat(m.legacyCsp('wss://a.example'))))})")
    out = subprocess.run(['node', '-e', script, json.dumps([c[0] for c in cases])], cwd=EDGE, capture_output=True, text=True, check=True).stdout
    theirs = json.loads(out)
    assert theirs[:-1] == [html_csp(**kw) for _, kw in cases]
    assert theirs[-1] == legacy_csp(connect='wss://a.example')


def free_origin():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return f'http://127.0.0.1:{s.getsockname()[1]}'


async def served(monkeypatch, report_only=False):
    if report_only:
        monkeypatch.setenv('ATLAS_CSP', 'report-only')
    else:
        monkeypatch.delenv('ATLAS_CSP', raising=False)
    origin = free_origin()
    app = create_app(replace(Config(), origin=origin, port=int(origin.rsplit(':', 1)[1])))
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, '127.0.0.1', int(origin.rsplit(':', 1)[1])).start()
    client = aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True))
    return origin, app, runner, client


def run(coro):
    return asyncio.run(coro)


def test_gateway_serves_the_page_with_its_own_hashes_and_the_runtime_as_json(monkeypatch):
    async def go():
        origin, app, runner, client = await served(monkeypatch)
        try:
            async with client.get(origin + '/') as r:
                body, header = await r.text(), r.headers['Content-Security-Policy']
                assert r.status == 200 and 'Content-Security-Policy-Report-Only' not in r.headers
            assert script_hashes(body) == script_hashes(PAGE), 'filling the data block changes no executable script'
            assert header == csp(app['config'], script_hashes(body), blob=True)
            assert re.search(r'script-src ((?:\'sha256-[^\']+\' )+)blob:;', header) and 'unsafe-inline' not in re.search(r'script-src ([^;]*)', header).group(1)
            assert "script-src-attr 'none'" in header and "frame-ancestors 'none'" in header and f"connect-src 'self' ws://{origin.split('//')[1]}" in header
            block = re.search(r'<script id="atlas-runtime" type="application/json">(.*?)</script>', body, re.S).group(1)
            assert '<' not in block and set(json.loads(block)) == {'subjectKey', 'authMode', 'name'}
            assert 'window.ATLAS_RUNTIME={' not in body and 'SERVER_RUNTIME' not in body
            async with client.get(origin + '/api/bootstrap') as r:  # JSON carries the data policy only
                assert r.headers['Content-Security-Policy'] == "default-src 'none'; frame-ancestors 'none'"
                assert 'blob:' not in r.headers['Content-Security-Policy'] and 'ws:' not in r.headers['Content-Security-Policy']
        finally:
            await client.close()
            await runner.cleanup()
    run(go())


def test_gateway_report_only_enforces_the_old_policy_and_reports_the_strict_one(monkeypatch):
    async def go():
        origin, app, runner, client = await served(monkeypatch, report_only=True)
        try:
            async with client.get(origin + '/') as r:
                body = await r.text()
                assert "script-src 'unsafe-inline' blob:" in r.headers['Content-Security-Policy']
                assert 'sha256-' in r.headers['Content-Security-Policy-Report-Only'] and 'unsafe-inline' not in re.search(r'script-src ([^;]*)', r.headers['Content-Security-Policy-Report-Only']).group(1)
            assert 'http-equiv="Content-Security-Policy"' not in body[:4000], 'the page <meta> would enforce what the header only reports'
        finally:
            await client.close()
            await runner.cleanup()
    run(go())
    monkeypatch.delenv('ATLAS_CSP')
    assert csp_headers(replace(Config(), origin='http://127.0.0.1:1')) == {'Content-Security-Policy': csp(replace(Config(), origin='http://127.0.0.1:1'))}
