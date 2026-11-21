"""Sweep 01 group 13, C-3 only. The other checks in the sweep file are group 12.

The local edge is up once it answers, including the 503 refusal page this check looks for.
  CHROMIUM_PATH=/usr/bin/google-chrome python3 tests/sweep01_c_browser.py
"""
import os
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy' / 'cloudflare-edge'
FAILS = []


def check(name, value):
    print(('PASS ' if value else 'FAIL ') + name)
    if not value:
        FAILS.append(name)


def port():
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    number = sock.getsockname()[1]
    sock.close()
    return number


def start(extra=None):
    number = port()
    env = os.environ.copy()
    if extra:
        env.update(extra)
    proc = subprocess.Popen(
        ['node', '--no-warnings', 'dev/local-edge.mjs', str(number)],
        cwd=EDGE, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    base = f'http://127.0.0.1:{number}'
    for _ in range(100):
        try:
            urllib.request.urlopen(base + '/', timeout=1)
            return proc, base
        except urllib.error.HTTPError:
            return proc, base
        except Exception:
            time.sleep(0.1)
    proc.terminate()
    raise SystemExit('local edge did not start')


conflict, conflict_base = start({'DATA_MODE': 'production'})
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
        context = browser.new_context(viewport={'width': 1280, 'height': 800})
        page = context.new_page()
        page.goto(conflict_base + '/?as=' + urllib.parse.quote('consultant@example.test'))
        page.wait_for_timeout(800)
        text = page.locator('body').inner_text()
        check(
            'C-3 a refused production combination is named and does not invite a conversation',
            'DATA_MODE=production cannot be combined' in text and 'Ready when you are' not in text and "isn't answering" not in text,
        )
        browser.close()
finally:
    conflict.terminate()
    conflict.wait(timeout=5)

if FAILS:
    raise SystemExit('failed: ' + ', '.join(FAILS))
