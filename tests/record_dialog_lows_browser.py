"""The Northwind seed must not print blank threshold or completeness labels, and a
corrupt stored list must open the dialog instead of rejecting.
  CHROMIUM_PATH=/usr/bin/google-chrome python3 tests/record_dialog_lows_browser.py
"""
import json, os, socket, subprocess, time, urllib.parse, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy/cloudflare-edge'
PASSED, FAILED, ERR = [], [], []
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
        return r.status, json.loads(r.read() or b'{}')
def snap(page):
    return page.evaluate("""() => {
      const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
      const line = document.querySelector('#recordBody .quality .impact-head span');
      const center = document.querySelector('#recordBody .ag-center small');
      const tracks = [...document.querySelectorAll('#recordBody .ag-legend.is-tracks li')].map(li => norm(li.innerText));
      return {
        open: !!document.getElementById('recordDialog')?.open,
        title: document.getElementById('recordTitle')?.textContent || '',
        line: norm(line && line.textContent),
        center: norm(center && center.textContent),
        tracks,
        body: norm(document.getElementById('recordBody')?.innerText),
        rejects: window.__atlasRejects || []
      };
    }""")
def detail_of(view):
    return 'open=%s title=%s line=%r center=%r tracks=%r rejects=%r errors=%r' % (
        view['open'], view['title'], view['line'], view['center'], view['tracks'], view['rejects'], ERR)
def seed_ok(view):
    return (view['open'] and view['title'] == 'Northwind queue pilot' and 'Quality 80' in view['body']
        and view['line'] == 'Ready for use' and view['center'] == 'of 100'
        and 'threshold' not in view['line'] and 'completeness' not in view['line']
        and 'Completeness' not in view['tracks'] and 'threshold 75' not in view['center']
        and not view['rejects'] and not ERR)
VARIANTS = [
    ('non-array list opens with a safe empty list',
     lambda q, d: q.__setitem__('blockers', 'not-an-array'),
     lambda view: view['open'] and view['title'] == 'Northwind queue pilot' and 'Blocking publication' not in view['body'] and 'not-an-array' not in view['body'] and not view['rejects'] and not ERR),
    ('null list opens with a safe fallback list',
     lambda q, d: (q.__setitem__('blockers', None), d.__setitem__('answers', None)),
     lambda view: view['open'] and view['title'] == 'Northwind queue pilot' and 'Not covered yet' in view['body'] and 'Blocking publication' not in view['body'] and not view['rejects'] and not ERR),
    ('malformed JSON list opens with a safe empty list',
     lambda q, d: d['details'].__setitem__('technologies', '[not-json'),
     lambda view: view['open'] and view['title'] == 'Northwind queue pilot' and '[not-json' not in view['body'] and 'Missing - to confirm' in view['body'] and not view['rejects'] and not ERR),
    ('wrong item types open with a safe empty list',
     lambda q, d: (q.__setitem__('issues', [{'field': 'outcome', 'kind': 1, 'detail': 'n'}, 'vague']), d['details'].__setitem__('consultants', [None])),
     lambda view: view['open'] and view['title'] == 'Northwind queue pilot' and 'Issues found' not in view['body'] and 'undefined' not in view['body'] and not view['rejects'] and not ERR),
]
try:
    status, listing = edge_api('GET', '/api/library')
    item = next((i for i in listing.get('items', []) if i.get('title') == 'Northwind queue pilot'), None)
    check('seeded Northwind record is listed', status == 200 and bool(item))
    status, rec = edge_api('GET', '/api/library/' + item['id'])
    quality = rec.get('state', {}).get('quality')
    check('seeded quality is status, score and engine only', status == 200 and quality == {'status': 'ready', 'score': 80, 'engine': 'rules'})
    rid = item['id']
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
        def open_record(width, mutate=None):
            ERR.clear()
            ctx = browser.new_context(viewport={'width': width, 'height': 800})
            page = ctx.new_page()
            page.add_init_script("window.__atlasRejects=[];window.addEventListener('unhandledrejection',e=>{window.__atlasRejects.push(String(e.reason&&e.reason.stack||e.reason));});")
            page.on('pageerror', lambda e: ERR.append('pageerror: ' + str(e)))
            if mutate:
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
                page.wait_for_function("() => document.getElementById('recordDialog')?.open || (window.__atlasRejects && window.__atlasRejects.length)", timeout=4000)
            except Exception:
                pass
            page.wait_for_timeout(200)
            view = snap(page)
            if os.environ.get('SHOTS'):
                target = Path(os.environ['SHOTS']) / f'record-dialog-{width}.png'
                (page.locator('#recordDialog') if view['open'] else page).screenshot(path=str(target))
            ctx.close()
            return view
        for width in (1280, 375):
            view = open_record(width)
            check(f'seed record at {width} renders with no blank labels', seed_ok(view), detail_of(view))
        os.environ.pop('SHOTS', None)
        for name, mutate, ok in VARIANTS:
            view = open_record(1280, mutate)
            check(name, ok(view), detail_of(view))
        browser.close()
finally:
    srv.terminate()
print(f'{len(PASSED)} pass, {len(FAILED)} fail')
if FAILED or ERR:
    raise SystemExit(1)
