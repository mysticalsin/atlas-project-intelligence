"""A seeded record whose quality object has no blockers or missing arrays must open.
The local edge seeds {status, score, engine}. The dialog has to render for a reviewer,
a pre-sales role and an admin, at 320 px and at 1280 px, with no console error.
  python3 tests/record_dialog_quality_browser.py
"""
import json, os, socket, subprocess, time, urllib.parse, urllib.request, urllib.error
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy/cloudflare-edge'
ERR = []
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
    headers = {'Origin': BASE}
    req = urllib.request.Request(url, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')
ROLES = [
    ('reviewer', 'reviewer@example.test', ['ATLAS.Reviewer']),
    ('presales', 'presales@example.test', ['ATLAS.Presales']),
    ('admin', 'admin@example.test', ['ATLAS.Admin']),
]
WIDTHS = (320, 1280)
try:
    status, listing = edge_api('admin@example.test', 'GET', '/api/library', ['ATLAS.Admin'])
    item = next((i for i in listing.get('items', []) if i.get('title') == 'Northwind queue pilot'), None)
    check('seeded Northwind record is listed', status == 200 and bool(item))
    status, rec = edge_api('admin@example.test', 'GET', '/api/library/' + item['id'], ['ATLAS.Admin'])
    quality = rec.get('state', {}).get('quality')
    check('seeded quality is status, score and engine only', status == 200 and quality == {'status': 'ready', 'score': 80, 'engine': 'rules'})
    rid = item['id']
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
        for role, email, roles in ROLES:
            for width in WIDTHS:
                ERR.clear()
                ctx = browser.new_context(viewport={'width': width, 'height': 800})
                page = ctx.new_page()
                page.on('pageerror', lambda e: ERR.append('pageerror: ' + str(e)))
                page.on('console', lambda m: ERR.append('console: ' + m.text) if m.type == 'error' else None)
                page.goto(BASE + '/?as=' + urllib.parse.quote(email) + '&idp=' + urllib.parse.quote(json.dumps({'roles': roles})))
                page.wait_for_timeout(400)
                page.goto(BASE + '/#library/' + rid)
                page.wait_for_timeout(1200)
                opened = page.evaluate("() => !!document.getElementById('recordDialog')?.open")
                title = page.locator('#recordTitle').inner_text()
                body = page.locator('#recordBody').inner_text()
                label = f'{role} {width}'
                if os.environ.get('SHOTS'):
                    target = Path(os.environ['SHOTS']) / f'record-dialog-{role}-{width}.png'
                    (page.locator('#recordDialog') if opened else page).screenshot(path=str(target))
                check(label + ' dialog renders the sparse quality record', opened and title == 'Northwind queue pilot' and 'Quality 80' in body and 'Reference details' in body)
                line = page.locator('#recordBody .quality .impact-head span').inner_text()
                check(label + ' missing aiScore renders the quality line', line == 'Ready for use · threshold · completeness')
                def with_zero(route):
                    url = route.request.url.split('?', 1)[0]
                    if route.request.method != 'GET' or not url.endswith('/api/library/' + rid):
                        route.fallback()
                        return
                    response = route.fetch()
                    payload = json.loads(response.body().decode() or '{}')
                    quality = (payload.get('state') or {}).get('quality')
                    if isinstance(quality, dict):
                        quality['aiScore'] = 0
                    route.fulfill(status=response.status, json=payload)
                page.route('**/api/library/**', with_zero)
                page.reload()
                page.wait_for_timeout(1200)
                zero_open = page.evaluate("() => !!document.getElementById('recordDialog')?.open")
                zero = page.locator('#recordBody .quality .impact-head span').inner_text()
                check(label + ' aiScore 0 renders the quality line', zero_open and zero == 'Ready for use · threshold · completeness · review agent 0')
                check(label + ' no console error', not ERR)
                ctx.close()
        browser.close()
finally:
    srv.terminate()
    if ERR:
        print('\n'.join(ERR))
