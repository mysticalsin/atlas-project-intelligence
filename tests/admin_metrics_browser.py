"""Admin metrics view on the built page: loading, ready, denied, and export allowed or blocked.
Synthetic counts only. The page behavior is unchanged.
  python3 tests/admin_metrics_browser.py
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
H = (ROOT / 'ATLAS_Project_Intelligence.html').read_text()
ERR = []
HELD = []
GATE = {'export': 'allow'}
METRICS = {
    'events': 4, 'errors': 1,
    'tokens': {'actualIn': 120, 'missing': 2, 'unknown': 1},
    'latencyMs': {'average': 80},
    'workflow': {'published': 3, 'awaiting_manager': 2, 'awaiting_presales': 1, 'admin_test': 0},
    'series': [{'bucket': '2026-11-01', 'events': 4}],
    'estimatedCost': {'amount': 0.02, 'currency': 'USD', 'basis': 'synthetic-unit-rates', 'includesEstimatedTokens': False},
    'note': 'Synthetic counts for this browser check. Not a vendor invoice.',
}
CSV = 'day,events\n2026-11-01,4\n'
def boot(role):
    return {'protocol': 'atlas-personaplex-pcm-v1', 'provider': 'workers', 'providerLabel': 'ATLAS voice', 'csrf': 'synthetic-csrf',
            'identity': {'name': 'synthetic@example.com', 'mode': 'access', 'subjectKey': 'synthetic'},
            'library': True, 'libraryRole': role, 'voices': ['atlas'], 'defaultVoice': 'atlas', 'captureRequired': True,
            'codecAvailable': True, 'busy': False, 'capacity': 1, 'maxSeconds': 900, 'speakingSeconds': 600,
            'memory': False, 'transcription': True, 'playbackAck': True}
def route_for(role):
    def route(r):
        u = r.request.url.split('?', 1)[0].rstrip('/')
        if u == 'https://atlas.test': return r.fulfill(body=H, content_type='text/html')
        if u == 'https://atlas.test/api/bootstrap': return r.fulfill(json=boot(role))
        if u == 'https://atlas.test/api/library/admin/metrics':
            HELD.append(r); return
        if u == 'https://atlas.test/api/library/admin/export':
            if GATE['export'] == 'allow': return r.fulfill(json={'filename': 'atlas-admin-metrics.csv', 'csv': CSV})
            return r.fulfill(status=403, json={'error': 'Only a verified admin can export these counts.'})
        r.fulfill(status=404, body='')
    return route
def check(n, v): print(('PASS ' if v else 'FAIL ') + n); assert v, n
def cards(page):
    return dict(page.evaluate("() => [...document.querySelectorAll('#admin .metric')].map(n => [n.querySelector('span').textContent, n.querySelector('b').textContent])"))
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
    admin = b.new_context(viewport={'width': 1366, 'height': 1000}, accept_downloads=True)
    p = admin.new_page(); p.on('pageerror', lambda e: ERR.append(str(e)))
    p.route('**/*', route_for('admin')); p.goto('https://atlas.test/')
    p.locator('#adminNav').wait_for(state='visible')
    check('an admin sees the Admin control', p.locator('#adminNav').is_visible())
    p.locator('#adminNav').click()
    p.locator('#admin p', has_text='Loading…').wait_for()
    check('loading shows the loading line and no metrics yet',
          not p.locator('#admin').is_hidden() and p.locator('#admin h1').inner_text() == 'Operations.'
          and p.locator('#admin p', has_text='Loading…').count() == 1 and p.locator('#admin .metric-grid').count() == 0
          and p.locator('#admin button', has_text='Export CSV').count() == 1 and len(HELD) == 1)
    HELD.pop().fulfill(json=METRICS)
    p.locator('#admin .metric-grid').wait_for()
    ready = cards(p); text = p.locator('#admin').inner_text()
    check('ready shows each metric card',
          ready == {'Events': '4', 'Errors': '1', 'Actual tokens in': '120', 'Missing token events': '2', 'Unknown token events': '1',
                    'Latency avg ms': '80', 'Published': '3', 'Awaiting manager': '2', 'Awaiting pre-sales': '1', 'Admin tests': '0'})
    check('ready shows the day chart, the cost sentence and the note',
          p.locator('#admin .chart').get_attribute('aria-label') == 'Events by day' and '11-01' in p.locator('#admin .chart').inner_text()
          and 'Estimated 0.02 USD from configured unit rates.' in text and 'Synthetic counts for this browser check.' in text
          and p.locator('#admin p', has_text='Loading…').count() == 0)
    denied = b.new_context(viewport={'width': 1366, 'height': 1000})
    d = denied.new_page(); d.on('pageerror', lambda e: ERR.append('denied: ' + str(e)))
    before = len(HELD)
    d.route('**/*', route_for('user')); d.goto('https://atlas.test/')
    d.locator('#adminNav').wait_for(state='attached')
    check('denied keeps the Admin control hidden', d.locator('#adminNav').is_hidden())
    d.evaluate("document.getElementById('adminNav').click()")
    d.locator('#admin h1').wait_for()
    check('denied shows the admin-only banner and no metrics or export',
          not d.locator('#admin').is_hidden() and d.locator('#admin h1').inner_text() == 'Admin'
          and 'This dashboard is only for a verified admin. The API refuses everyone else.' in d.locator('#admin').inner_text()
          and d.locator('#admin .metric-grid').count() == 0 and d.locator('#admin .chart').count() == 0
          and d.locator('#admin button', has_text='Export CSV').count() == 0 and len(HELD) == before)
    with p.expect_download() as dl:
        p.locator('#admin button', has_text='Export CSV').click()
    got = Path(dl.value.path()).read_text()
    check('export allowed downloads the synthetic csv and leaves the metrics',
          dl.value.suggested_filename == 'atlas-admin-metrics.csv' and got == CSV
          and p.locator('#admin .metric-grid').count() == 1 and p.locator('#admin .pill.warn').count() == 0)
    GATE['export'] = 'block'
    p.locator('#admin button', has_text='Export CSV').click()
    p.locator('#admin .pill.warn').wait_for()
    check('export blocked keeps the metrics and shows the refusal',
          p.locator('#admin .pill.warn').inner_text() == 'Only a verified admin can export these counts.'
          and cards(p)['Events'] == '4' and p.locator('#admin .metric-grid').count() == 1
          and p.locator('#admin button', has_text='Export CSV').count() == 1)
    check('no page errors', not ERR)
    if ERR: print(ERR)
    b.close()
