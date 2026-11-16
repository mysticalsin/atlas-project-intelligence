"""Production plus the local switches answers /api/bootstrap and /api/library with 503 and a specific reason.
The journey and the library must show that reason.
  python3 tests/refusal_browser.py
"""
import json, os, socket, subprocess, time, urllib.error, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy' / 'cloudflare-edge'
GENERIC = 'The shared library is not available here.'

def check(name, value):
    print(('PASS ' if value else 'FAIL ') + name)
    assert value, name

def port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    n = s.getsockname()[1]
    s.close()
    return n

def start(extra=None):
    n = port()
    env = os.environ.copy()
    if extra:
        env.update(extra)
    proc = subprocess.Popen(['node', '--no-warnings', 'dev/local-edge.mjs', str(n)], cwd=EDGE, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    base = f'http://127.0.0.1:{n}'
    for _ in range(100):
        try:
            urllib.request.urlopen(base + '/', timeout=1)
            return proc, base
        except Exception:
            time.sleep(0.1)
    proc.terminate()
    raise SystemExit('local edge did not start')

def http_error(base, path):
    try:
        urllib.request.urlopen(base + path, timeout=5)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')
    raise AssertionError(path + ' did not fail')

def show(page, view, needle):
    page.locator(f'header [data-view={view}]').click()
    box = '#journey' if view == 'journey' else '#libraryStatusLine'
    page.wait_for_function(
        "([sel, needle]) => { const t = document.querySelector(sel).innerText || ''; return t.includes(needle) || t.includes('not available here'); }",
        arg=[box, needle], timeout=8000)
    return page.locator(box).inner_text()

proc = plain = None
try:
    proc, base = start({'DATA_MODE': 'production'})
    status, body = http_error(base, '/api/bootstrap')
    lib_status, lib_body = http_error(base, '/api/library')
    check('bootstrap and library both refuse', status == 503 and lib_status == 503 and body.get('error') and body['error'] == lib_body.get('error'))
    reason = body['error']
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
        page = browser.new_context(viewport={'width': 1400, 'height': 1000}).new_page()
        page.goto(base + '/?as=ada@example.test')
        page.wait_for_timeout(700)
        journey = show(page, 'journey', reason)
        check('journey shows the bootstrap 503 reason', reason in journey)
        check('journey does not replace that reason', GENERIC not in journey)
        library = show(page, 'library', reason)
        check('library shows the bootstrap 503 reason', reason in library)
        check('library does not replace that reason', GENERIC not in library)
        proc.terminate(); proc = None

        plain, base = start()
        library_reason = 'Refused before any story, trust, or metric read. This library fetch was refused.'
        fresh = browser.new_context(viewport={'width': 1400, 'height': 1000}).new_page()
        fresh.route('**/api/library**', lambda route: route.fulfill(status=503, content_type='application/json', body=json.dumps({'ok': False, 'error': library_reason})))
        fresh.goto(base + '/?as=ada@example.test')
        fresh.wait_for_timeout(700)
        journey = show(fresh, 'journey', library_reason)
        check('journey shows a library-fetch 503 reason', library_reason in journey)
        check('journey does not replace a library-fetch refusal', GENERIC not in journey)
        library = show(fresh, 'library', library_reason)
        check('library shows a library-fetch 503 reason', library_reason in library)
        check('library does not replace a library-fetch refusal', GENERIC not in library)
        browser.close()
finally:
    if proc: proc.terminate()
    if plain: plain.terminate()
