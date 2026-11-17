"""Who did what shows a quiet marker only for a non-verified audit line.
Verified lines stay unmarked. The marker is text, named, keyboard reachable, and inside a 390px viewport.
  python3 tests/audit_marker_browser.py
"""
import json, os, re, socket, subprocess, time, urllib.parse, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy/cloudflare-edge'
s = socket.socket(); s.bind(('127.0.0.1', 0)); PORT = s.getsockname()[1]; s.close()
BASE = f'http://127.0.0.1:{PORT}'
srv = subprocess.Popen(['node', '--no-warnings', 'dev/local-edge.mjs', str(PORT)], cwd=EDGE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
for _ in range(100):
    try:
        urllib.request.urlopen(BASE + '/__settle', timeout=1)
        break
    except Exception:
        time.sleep(0.1)
LINE = {'at': '2026-11-17T04:00:00.000Z', 'actor': 'ada@example.test', 'action': 'created', 'detail': ''}
NOTES = ['Zebracorp had claims bouncing between three teams, slowing payouts for customers across the region.',
         'I designed and built the routing model and ran the pilot with two teams myself.',
         'We compared rules against a model, chose the model, and kept a manual fallback for edge cases.',
         'Triage fell from 40 to 12 minutes per claim according to the operations dashboard.',
         'Operations dashboard export v3, before and after quarters.',
         'Any insurer or service desk with manual routing and a measurable queue would benefit.']
REP = {'headline': 'Claims triage rebuilt with ML routing', 'summary': 'The consultant rebuilt claims triage for the client.',
       'topics': {}, 'highlights': [], 'gaps': [], 'follow_ups': [], 'status': 'model_draft',
       'facts': {'project_id': 'PRJ-2291', 'country': 'France', 'industry': 'Insurance', 'start': '2024-03', 'end': '2024-11',
                 'duration': '', 'team_size': 6, 'team_roles': ['Data engineer'], 'technologies': ['Python'],
                 'deliverables': ['Routing model'], 'service_lines': ['Data & AI']}}
RID = re.compile(r'/api/library/[0-9a-f-]{16,}(?:\?|$)')


def check(name, value):
    print(('PASS ' if value else 'FAIL ') + name)
    assert value, name


def rewrite(audit):
    def handle(route):
        if route.request.method != 'GET' or not RID.search(route.request.url):
            return route.fallback()
        response = route.fetch()
        data = response.json()
        data['audit'] = audit
        route.fulfill(status=response.status, json=data)
    return handle


try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
        page = browser.new_context(viewport={'width': 390, 'height': 800}).new_page()
        page.goto(BASE + '/?as=' + urllib.parse.quote('ada@example.test'))
        page.wait_for_timeout(500)
        page.locator('[data-action=new-project]:visible').first.click()
        for key, value in {'projectTitle': 'Claims triage alias', 'consultantName': 'Ada', 'consultantRole': 'Data engineer',
                           'clientName': 'Zebracorp', 'clientLocation': 'Lyon', 'n1Name': 'Sam', 'n1Email': 'sam@example.test'}.items():
            page.locator('#' + key).fill(value)
        page.locator('#projectForm button[type=submit]').click()
        page.wait_for_timeout(300)
        page.evaluate("([n,rep])=>window.ATLAS_VOICE_BRIDGE.autoSave(window.ATLAS_VOICE_BRIDGE.context(),n,'Consultant words.',rep)", [NOTES, REP])
        page.wait_for_timeout(1200)
        urllib.request.urlopen(BASE + '/__settle', timeout=30).read()
        rid = page.evaluate("JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('mantu.atlas')))||'null')?.profiles?.[0]?.projects?.[0]?.library?.id")
        check('library id known', bool(rid))
        page.goto(BASE + '/?as=' + urllib.parse.quote('ada@example.test') + '#library/' + rid)
        page.wait_for_timeout(800)
        page.locator('#recordBody summary').click()
        check('a verified history has no marker', page.locator('#recordBody .audit-note').count() == 0)
        check('verified history has no helper line', 'not a verified' not in page.locator('#recordBody').inner_text().lower())

        def show(audit):
            page.unroute('**/api/library/**')
            page.route('**/api/library/**', rewrite(audit))
            page.goto(BASE + '/?as=' + urllib.parse.quote('ada@example.test') + '#library/' + rid)
            page.wait_for_timeout(800)
            page.locator('#recordBody summary').click()

        def marker(name):
            button = page.get_by_role('button', name=name)
            check(name + ' is one reachable marker', button.count() == 1)
            button.focus()
            check(name + ' takes keyboard focus', page.evaluate("document.activeElement && document.activeElement.classList.contains('audit-note')"))
            box = button.bounding_box()
            check(name + ' fits at 390px', box and box['x'] >= 0 and box['x'] + box['width'] <= 390)
            check(name + ' is text without a second label', page.locator('#recordBody .audit-note').count() == 1)

        show([{**LINE, 'unverified': True}])
        marker('Unverified')
        check('an unverified line is not also marked legacy', page.get_by_role('button', name='Legacy').count() == 0)
        show([{**LINE, 'legacy': True, 'unverified': True}])
        marker('Legacy')
        check('a legacy line is not also marked unverified', page.get_by_role('button', name='Unverified').count() == 0)
        show([{**LINE, 'action': 'created'}, {**LINE, 'action': 'revised', 'unverified': True}])
        marker('Unverified')
        items = page.locator('#recordBody h4:text("Who did what") + ul li')
        check('a verified line beside a tampered one has no marker', items.nth(0).locator('.audit-note').count() == 0 and items.nth(1).locator('.audit-note').count() == 1)
        browser.close()
finally:
    srv.terminate()
