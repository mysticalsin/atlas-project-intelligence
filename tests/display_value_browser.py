"""Object roles and object issue details must not render as [object Object].
Synthetic Northwind record only.
  CHROMIUM_PATH=/usr/bin/google-chrome python3 tests/display_value_browser.py
"""
import json, os, socket, subprocess, time, urllib.parse, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy/cloudflare-edge'
PASSED, FAILED, ERR = [], [], []
PLACEHOLDER = '\u2014'

def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ((' :: ' + detail) if detail and not ok else ''))
    (PASSED if ok else FAILED).append(name)

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

def edge_api(method, path):
    q = 'as=' + urllib.parse.quote('admin@example.test') + '&idp=' + urllib.parse.quote(json.dumps({'roles': ['ATLAS.Admin']}))
    url = BASE + path + ('&' if '?' in path else '?') + q
    req = urllib.request.Request(url, method=method, headers={'Origin': BASE})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b'{}')

def mutate(quality, data):
    quality['issues'] = [
        {'field': 'outcome', 'kind': 'vague_metric', 'detail': {'label': 'Queue delay was not measured'}},
        {'field': 'evidence', 'kind': 'missing_source', 'detail': {'note': 'dashboard'}},
        {'field': 'scope', 'kind': 'thin_scope', 'detail': 'The pilot covered one queue.'},
        {'field': 'team', 'kind': 'headcount', 'detail': 4},
        {'field': 'note', 'kind': 'blank_detail', 'detail': None},
        {'field': 'fit', 'kind': 'nested_detail', 'detail': {'label': {'label': 'Nested'}}},
    ]
    data['consultant'] = {'name': 'Ada', 'role': {'label': 'Delivery lead'}}
    data['details']['consultants'] = [
        {'name': 'Sam', 'role': {'hours': 12}},
        {'name': 'Noor', 'role': 'Analyst'},
        {'name': 'Kai', 'role': 2},
        {'name': 'Ren', 'role': None},
        {'name': 'Ivo', 'role': ['Lead']},
    ]

def snap(page):
    return page.evaluate("""() => {
      const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
      return {
        open: !!document.getElementById('recordDialog')?.open,
        title: document.getElementById('recordTitle')?.textContent || '',
        body: norm(document.getElementById('recordBody')?.innerText),
        images: document.querySelectorAll('#recordBody img').length,
        rejects: window.__atlasRejects || []
      };
    }""")

try:
    listing = edge_api('GET', '/api/library')
    item = next((i for i in listing.get('items', []) if i.get('title') == 'Northwind queue pilot'), None)
    check('seeded Northwind record is listed', bool(item))
    rid = item['id']
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
        shots = Path(os.environ['SHOTS']) if os.environ.get('SHOTS') else None
        if shots:
            shots.mkdir(parents=True, exist_ok=True)
        for width in (1280, 390):
            ERR.clear()
            ctx = browser.new_context(viewport={'width': width, 'height': 800})
            page = ctx.new_page()
            page.add_init_script("window.__atlasRejects=[];window.addEventListener('unhandledrejection',e=>{window.__atlasRejects.push(String(e.reason&&e.reason.stack||e.reason));});")
            page.on('pageerror', lambda e: ERR.append('pageerror: ' + str(e)))
            def handle(route):
                url = route.request.url.split('?', 1)[0]
                if route.request.method != 'GET' or not url.endswith('/api/library/' + rid):
                    route.fallback(); return
                response = route.fetch()
                payload = json.loads(response.body().decode() or '{}')
                mutate(payload['state']['quality'], payload['data'])
                route.fulfill(status=response.status, json=payload)
            page.route('**/api/library/**', handle)
            email = urllib.parse.quote('admin@example.test')
            idp = urllib.parse.quote(json.dumps({'roles': ['ATLAS.Admin']}))
            page.goto(BASE + '/?as=' + email + '&idp=' + idp)
            page.wait_for_timeout(400)
            page.goto(BASE + '/#library/' + rid)
            try:
                page.wait_for_function("() => document.getElementById('recordDialog')?.open", timeout=4000)
            except Exception:
                pass
            page.wait_for_timeout(200)
            if shots:
                issues = page.locator('#recordBody h4', has_text='Issues found')
                if issues.count():
                    issues.scroll_into_view_if_needed()
                page.screenshot(path=str(shots / f'issues-{width}.png'))
                row = page.locator('#recordBody tr', has_text='Consultants')
                if row.count():
                    row.scroll_into_view_if_needed()
                page.screenshot(path=str(shots / f'consultants-{width}.png'))
            view = snap(page)
            body = view['body']
            detail = 'open=%s title=%s images=%s rejects=%s errors=%s body=%r' % (
                view['open'], view['title'], view['images'], view['rejects'], ERR, body[:1200])
            label = f'{width}x800'
            check(label + ' dialog is open on the synthetic record', view['open'] and view['title'] == 'Northwind queue pilot' and not view['rejects'] and not ERR, detail)
            check(label + ' object role uses its label', 'Ada (Delivery lead)' in body and '[object Object]' not in body, detail)
            check(label + ' shapeless role is the placeholder', f'Sam ({PLACEHOLDER})' in body, detail)
            check(label + ' string and number roles stay text', 'Noor (Analyst)' in body and 'Kai (2)' in body, detail)
            check(label + ' null role adds no parentheses', 'Ren (' not in body and 'Ren' in body, detail)
            check(label + ' array role is the placeholder', f'Ivo ({PLACEHOLDER})' in body, detail)
            check(label + ' object detail uses its label', 'vague metric: Queue delay was not measured' in body, detail)
            check(label + ' shapeless and nested details are the placeholder',
                  f'missing source: {PLACEHOLDER}' in body and f'nested detail: {PLACEHOLDER}' in body and f'blank detail: {PLACEHOLDER}' in body, detail)
            check(label + ' string and number details stay text', 'thin scope: The pilot covered one queue.' in body and 'headcount: 4' in body, detail)
            check(label + ' a label is text, not markup', view['images'] == 0, detail)
            ctx.close()
        browser.close()
finally:
    srv.terminate()
print(f'{len(PASSED)} pass, {len(FAILED)} fail')
if FAILED or ERR:
    raise SystemExit(1)
