"""A non-numeric aiScore must not be printed. A finite number, including 0, still shows.
  python3 tests/aiscore_nonnumeric_browser.py
"""
import json, os, socket, subprocess, time, urllib.parse, urllib.request, urllib.error
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy/cloudflare-edge'
def check(n, v):
    print(('PASS ' if v else 'FAIL ') + n)
    assert v, n
s = socket.socket(); s.bind(('127.0.0.1', 0)); PORT = s.getsockname()[1]; s.close()
BASE = f'http://127.0.0.1:{PORT}'
srv = subprocess.Popen(['node', '--no-warnings', 'dev/local-edge.mjs', str(PORT)], cwd=EDGE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
for _ in range(100):
    try:
        urllib.request.urlopen(BASE + '/__settle', timeout=1); break
    except Exception:
        time.sleep(.1)
else:
    raise SystemExit('local edge did not start')
def edge_api(email, method, path, roles=None):
    q = 'as=' + urllib.parse.quote(email) + (('&idp=' + urllib.parse.quote(json.dumps({'roles': roles}))) if roles else '')
    url = BASE + path + ('&' if '?' in path else '?') + q
    req = urllib.request.Request(url, method=method, headers={'Origin': BASE})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')
held = {'ai': 'not-a-score'}
try:
    status, listing = edge_api('reviewer@example.test', 'GET', '/api/library', ['ATLAS.Reviewer'])
    item = next((i for i in listing.get('items', []) if i.get('title') == 'Northwind queue pilot'), None)
    check('seeded Northwind record is listed', status == 200 and bool(item))
    rid = item['id']
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
        page = browser.new_page(viewport={'width': 1280, 'height': 800})
        def with_score(route):
            url = route.request.url.split('?', 1)[0]
            if route.request.method != 'GET' or not url.endswith('/api/library/' + rid):
                route.fallback()
                return
            response = route.fetch()
            payload = json.loads(response.body().decode() or '{}')
            quality = (payload.get('state') or {}).get('quality')
            if isinstance(quality, dict):
                quality['score'] = 80
                quality['completeness'] = 40
                quality['aiScore'] = held['ai']
            route.fulfill(status=response.status, json=payload)
        page.route('**/api/library/**', with_score)
        email, roles = 'reviewer@example.test', ['ATLAS.Reviewer']
        page.goto(BASE + '/?as=' + urllib.parse.quote(email) + '&idp=' + urllib.parse.quote(json.dumps({'roles': roles})))
        page.wait_for_timeout(400)
        def line_for(ai, first=False):
            held['ai'] = ai
            if first:
                page.goto(BASE + '/#library/' + rid)
            else:
                page.reload()
            page.wait_for_timeout(1200)
            opened = page.evaluate("() => !!document.getElementById('recordDialog')?.open")
            text = page.locator('#recordBody .quality .impact-head').inner_text()
            return opened, text
        opened, text = line_for('not-a-score', True)
        check('string aiScore is not printed', opened and 'Quality 80 / 100' in text and 'completeness 40' in text and 'not-a-score' not in text)
        opened, text = line_for({'ignored': True})
        check('object aiScore is not printed', opened and 'Quality 80 / 100' in text and '[object Object]' not in text)
        opened, text = line_for(0)
        check('numeric aiScore 0 still shows', opened and 'review agent 0' in text and 'not-a-score' not in text)
        opened, text = line_for(74)
        check('numeric aiScore 74 still shows', opened and 'review agent 74' in text and '[object Object]' not in text)
        browser.close()
finally:
    srv.terminate()
