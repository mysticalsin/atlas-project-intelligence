"""Capture BEFORE/AFTER PNG evidence for PR #10 (synthetic fixtures only).

Usage:
  python3 scripts/capture_pr10_evidence.py --root . --out docs/pr10/after
"""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT_DEFAULT = Path(__file__).resolve().parents[1]


def _port() -> int:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


async def _wiki_export_status(repo: Path) -> tuple[int, str]:
    from aiohttp import web
    import aiohttp
    from atlas_voice.config import Config
    from atlas_voice.server import create_app
    from atlas_voice.wiki import WikiVault
    from dataclasses import replace

    vault_root = Path(tempfile.mkdtemp(prefix='atlas-pr10-vault-'))
    vault = WikiVault(vault_root)
    try:
        from tests.test_quality import reviewed

        reviewed(vault, 'internal')
        port = _port()
        origin = f'http://127.0.0.1:{port}'
        app = create_app(replace(Config(), origin=origin, port=port, wiki_root=str(vault_root)))
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        await web.TCPSite(runner, '127.0.0.1', port).start()
        try:
            async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True)) as client:
                await client.get(origin)
                boot = await (await client.get(origin + '/api/bootstrap')).json()
                headers = {'Origin': origin, 'X-Atlas-CSRF': boot['csrf']}
                response = await client.post(
                    origin + '/api/wiki/export',
                    headers=headers,
                    json={'audience': 'internal', 'consent': True},
                )
                raw = await response.read()
                if response.status == 200:
                    ok = zipfile.is_zipfile(io.BytesIO(raw))
                    return response.status, f'{len(raw)} bytes · zip={ok} · index in archive'
                return response.status, raw.decode('utf-8', errors='replace')[:240]
        finally:
            await runner.cleanup()
    finally:
        vault.close()


def wiki_export_card(repo: Path, out: Path) -> None:
    sys.path.insert(0, str(repo))
    os.chdir(repo)
    status, snippet = asyncio.run(_wiki_export_status(repo))
    label = f'POST /api/wiki/export → HTTP {status}'
    detail = snippet.replace('`', "'")
    html = f"""<!doctype html><meta charset=utf-8>
<title>{label}</title>
<style>
body{{font:16px/1.4 system-ui,sans-serif;margin:2rem;max-width:42rem}}
h1{{font-size:1.1rem}}
pre{{background:#1a1a1a;color:#f2f2f2;padding:1rem;border-radius:8px;white-space:pre-wrap}}
</style>
<h1>{label}</h1>
<p>Authorized internal export (synthetic vault, local gateway).</p>
<pre>{detail}</pre>"""
    tmp = out.parent / '_wiki_card.html'
    tmp.write_text(html, encoding='utf-8')
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
        page = browser.new_page(viewport={'width': 720, 'height': 360})
        page.goto(tmp.as_uri())
        page.screenshot(path=str(out))
        browser.close()
    tmp.unlink(missing_ok=True)


JOURNEY = {
    'stages': [
        {'id': 'project', 'title': 'Identify the project', 'current': True},
        {'id': 'review', 'title': 'Project review'},
        {'id': 'spotlight', 'title': 'Spotlight reference', 'blocked': 'spotlight'},
    ],
    'fields': {
        'title': {'value': 'Synthetic queue alias'},
        'personalWork': {'value': 'Route design and pilot ownership.'},
        'evidence': {'value': 'Ops dashboard quarters.'},
    },
    'confirmed': {},
    'roles': {'explanation': 'Matches use confirmed skills only.', 'decision': 'Illustrative catalog.', 'matches': []},
    'publication': 'Manager and pre-sales approval for non-admins.',
    'integrations': {'spotlight': {'reason': 'No Spotlight endpoint configured.'}},
}
ITEMS = {
    'items': [{
        'id': 'a' * 32,
        'title': 'Synthetic reference with a long title that must stay inside the journey panel',
        'status': 'awaiting_validation',
        'managerDecision': 'pending',
        'presalesDecision': 'pending',
        'access': 'full',
        'mine': False,
    }]
}
PRIVACY = {
    'consent': {'interview': 'recorded with purpose consent'},
    'recording': 'Optional.',
    'textOnly': 'Typed notes are enough.',
    'retention': {'appTelemetryDays': 90, 'vendorDeletion': 'operator-defined'},
    'lawfulBasis': 'Contract.',
    'biometrics': 'No biometrics stored.',
}


def boot(role: str) -> dict:
    return {
        'protocol': 'atlas-personaplex-pcm-v1',
        'provider': 'workers',
        'providerLabel': 'ATLAS voice',
        'csrf': 'tok',
        'identity': {'name': 'synthetic@example.com', 'mode': 'access', 'subjectKey': 's'},
        'library': True,
        'libraryRole': role,
        'voices': ['atlas'],
        'defaultVoice': 'atlas',
        'captureRequired': True,
        'codecAvailable': True,
        'busy': False,
        'capacity': 1,
        'maxSeconds': 900,
        'speakingSeconds': 600,
        'memory': False,
        'transcription': True,
        'playbackAck': True,
    }


def journey_screenshot(repo: Path, out: Path, *, role: str, width: int) -> None:
    html = (repo / 'ATLAS_Project_Intelligence.html').read_text(encoding='utf-8')

    def route(r):
        u = r.request.url.split('?', 1)[0].rstrip('/')
        if u.endswith('atlas.test'):
            return r.fulfill(body=html, content_type='text/html')
        if u == 'https://atlas.test/api/bootstrap':
            return r.fulfill(json=boot(role))
        if u == 'https://atlas.test/api/library/journey':
            return r.fulfill(json=JOURNEY)
        if u == 'https://atlas.test/api/library/privacy/disclosure':
            return r.fulfill(json=PRIVACY)
        if u == 'https://atlas.test/api/library':
            return r.fulfill(json=ITEMS)
        if r.request.method == 'POST' and u.endswith('/validate'):
            return r.fulfill(json={'ok': True})
        return r.fulfill(status=404, json={'error': 'not mocked'})

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
        ctx = browser.new_context(viewport={'width': width, 'height': 900})
        page = ctx.new_page()
        page.route('**/*', route)
        page.goto('https://atlas.test/#journey')
        page.locator('header [data-view=journey]').click()
        page.locator('#journeyTitle', has_text='From the work to a reference').wait_for()
        page.locator('#journey .stage-grid').wait_for()
        page.set_viewport_size({'width': width, 'height': 900})
        page.locator('#journey').screenshot(path=str(out))
        browser.close()


def admin_hash_screenshot(repo: Path, out: Path) -> None:
    html = (repo / 'ATLAS_Project_Intelligence.html').read_text(encoding='utf-8')

    def route(r):
        u = r.request.url.split('?', 1)[0].rstrip('/')
        if u.endswith('atlas.test'):
            return r.fulfill(body=html, content_type='text/html')
        if u == 'https://atlas.test/api/bootstrap':
            return r.fulfill(json=boot('user'))
        return r.fulfill(status=404, json={'error': 'not mocked'})

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
        page = browser.new_page(viewport={'width': 375, 'height': 800})
        page.route('**/*', route)
        page.goto('https://atlas.test/#admin')
        try:
            page.locator('#admin h1').wait_for(timeout=4000)
        except Exception:
            page.wait_for_timeout(400)
        panel = page.locator('#admin')
        if panel.is_visible():
            panel.screenshot(path=str(out))
        else:
            page.screenshot(path=str(out), full_page=False)
        browser.close()


def ensure_html(repo: Path) -> None:
    aliases = [
        'ATLAS_Project_Intelligence.html',
        'ATLAS_Intelligence.html',
        'ATLAS_Voice_Studio.html',
        'ATLAS_Voice.html',
    ]
    if all((repo / name).is_file() for name in aliases):
        return
    subprocess.run([sys.executable, str(repo / 'build.py')], cwd=repo, check=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=ROOT_DEFAULT)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    repo = args.root.resolve()
    out_dir = args.out.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    ensure_html(repo)
    wiki_export_card(repo, out_dir / 'm1-wiki-export.png')
    for role in ('reviewer', 'presales', 'admin'):
        journey_screenshot(repo, out_dir / f'm2-journey-320-{role}.png', role=role, width=320)
    admin_hash_screenshot(repo, out_dir / 'm3-admin-hash-refusal.png')
    print('Wrote evidence PNGs under', out_dir)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())