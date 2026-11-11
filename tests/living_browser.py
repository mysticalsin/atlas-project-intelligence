"""CV and review in a real browser against the local edge. Synthetic story only. No SMART or MiChat call.
  python3 tests/living_browser.py
"""
import json, os, socket, subprocess, sys, time, urllib.request, urllib.parse, urllib.error, zipfile
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy/cloudflare-edge'
SHOTS = Path(os.environ.get('SHOTS', '/opt/cursor/artifacts'))
ERR = []
def check(name, value):
    print(('PASS ' if value else 'FAIL ') + name)
    assert value, name
s = socket.socket(); s.bind(('127.0.0.1', 0)); PORT = s.getsockname()[1]; s.close()
BASE = f'http://127.0.0.1:{PORT}'
srv = subprocess.Popen(['node', '--no-warnings', 'dev/local-edge.mjs', str(PORT)], cwd=EDGE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
for _ in range(100):
    try: urllib.request.urlopen(BASE + '/__settle', timeout=1); break
    except Exception: time.sleep(.1)
def settle():
    urllib.request.urlopen(BASE + '/__settle', timeout=30).read()
def edge_api(email, method, path, body=None, roles=None):
    q = 'as=' + urllib.parse.quote(email) + (('&idp=' + urllib.parse.quote(json.dumps({'roles': roles}))) if roles else '')
    boot = json.loads(urllib.request.urlopen(BASE + '/api/bootstrap?' + q, timeout=30).read())
    url = BASE + path + ('&' if '?' in path else '?') + q
    data = json.dumps(body).encode() if body is not None else None
    headers = {'Origin': BASE}
    if data is not None: headers.update({'Content-Type': 'application/json', 'X-Atlas-CSRF': boot['csrf']})
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
REF = {'title': 'Alarm routing alias', 'stage': 'Production', 'sector': 'Buildings',
  'consultant': {'name': 'Ada Example', 'role': 'Software engineer'},
  'client': {'name': 'Northwind Synthetic', 'location': 'Lyon', 'contact': 'Plant lead'},
  'details': {'projectId': 'PRJ-SYN', 'country': 'France', 'start': '2024-03', 'end': '2024-11', 'teamSize': 4,
    'teamRoles': ['Software engineer'], 'technologies': ['Windows', 'C#', 'C++'], 'deliverables': ['Alarm service'],
    'serviceLines': ['Software'], 'consultants': [], 'links': []},
  'answers': [
    'Northwind Synthetic needed a quieter alarm queue for the night shift across two sites.',
    'I designed the Windows service that routes alarms for the plant.',
    'The service was written in C# and covered the alarm queue.',
    'I have 8 years of Windows work on that same service and the queue got shorter.',
    'The operations log for the quarter is the source for that queue time.',
    'A building team with a manual alarm queue would recognise the same constraint.',
  ],
  'validation': {'manager': {'name': 'Sam', 'email': 'sam@example.test'}, 'managerStaff': False}}
try:
    made = edge_api('ada@example.test', 'POST', '/api/library', {'localId': 'living-1', 'reference': REF})
    check('story saved', made[0] == 201)
    rid = made[1]['id']
    settle()
    urllib.request.urlopen(urllib.request.Request(BASE + '/__trust', data=json.dumps({'owner': 'ada@example.test', 'email': 'sam@example.test', 'source': 'directory'}).encode(), headers={'Content-Type': 'application/json'}, method='POST')).read()
    check('manager approved', edge_api('sam@example.test', 'POST', f'/api/library/{rid}/validate', {'decision': 'validate', 'lane': 'manager'})[0] == 200)
    check('published', edge_api('pre@example.test', 'POST', f'/api/library/{rid}/validate', {'decision': 'validate', 'lane': 'presales'}, ['ATLAS.Presales'])[1].get('status') == 'published')
    SHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
        page = browser.new_context(viewport={'width': 1400, 'height': 1000}).new_page()
        page.on('pageerror', lambda e: ERR.append(str(e)))
        page.goto(BASE + '/?as=' + urllib.parse.quote('ada@example.test'))
        page.wait_for_timeout(700)
        page.locator('header [data-view=living]').click()
        page.wait_for_timeout(800)
        check('published sentence is on the CV screen', 'Windows service' in page.locator('#living').inner_text())
        page.locator('#livingLink').fill('https://need.arp.mantu.com/needs/192497')
        page.get_by_role('button', name='Generate').click()
        page.wait_for_timeout(800)
        check('an unread need link stays on the page', "can't be read yet" in page.locator('#living').inner_text())
        page.locator('#livingText').fill('Must have\nWindows\nC++\nC#\n\nLanguages\nEnglish - Fluent')
        page.get_by_role('button', name='Generate').click()
        page.wait_for_timeout(1200)
        body = page.locator('#living').inner_text()
        check('tailored line stays the evidence sentence', 'I designed the Windows service' in body)
        check('unsupported keyword is a gap', 'C++' in body and 'Gaps' in body)
        check('status is in review', 'In review' in body)
        check('export waits for approval', page.get_by_role('button', name='Export').is_disabled())
        check('owner has no approve button', page.get_by_role('button', name='Approve').count() == 0)
        page.screenshot(path=str(SHOTS / 'living-cv.png'), full_page=True)
        mobile = browser.new_context(viewport={'width': 390, 'height': 844}).new_page()
        mobile.goto(BASE + '/?as=' + urllib.parse.quote('ada@example.test'))
        mobile.wait_for_timeout(700)
        mobile.locator('header [data-view=living]').click()
        mobile.wait_for_timeout(800)
        mobile.screenshot(path=str(SHOTS / 'living-cv-mobile.png'), full_page=True)
        check('mobile CV still shows the sentence', 'Windows service' in mobile.locator('#living').inner_text())
        approver = browser.new_context(viewport={'width': 1400, 'height': 900}).new_page()
        approver.goto(BASE + '/?as=' + urllib.parse.quote('pre@example.test') + '&idp=' + urllib.parse.quote(json.dumps({'roles': ['ATLAS.Presales']})))
        approver.wait_for_timeout(700)
        approver.locator('header [data-view=living]').click()
        approver.wait_for_timeout(800)
        check('approver sees the draft', approver.get_by_role('button', name='Approve').count() == 1)
        approver.screenshot(path=str(SHOTS / 'living-approve.png'), full_page=True)
        approver.get_by_role('button', name='Approve').click()
        approver.wait_for_timeout(800)
        page.locator('header [data-view=living]').click()
        page.wait_for_timeout(800)
        check('export is available after approval', page.get_by_role('button', name='Export').is_enabled())
        with page.expect_download() as download:
            page.get_by_role('button', name='Export').click()
        doc = zipfile.ZipFile(download.value.path()).read('word/document.xml').decode()
        check('export is a docx of the evidence line', 'I designed the Windows service' in doc and 'C++' not in doc)
        page.locator('header [data-view=fiche]').click()
        page.wait_for_timeout(600)
        page.locator('#fiche').get_by_role('button', name='Generate').click()
        page.wait_for_timeout(1000)
        review = page.locator('#fiche').inner_text()
        check('review uses the same sentence', 'Windows service' in review and '99123' not in review)
        page.screenshot(path=str(SHOTS / 'living-review.png'), full_page=True)
        browser.close()
    check('no page errors', ERR == [])
finally:
    srv.terminate()
    try: srv.wait(timeout=5)
    except Exception: srv.kill()
    if srv.returncode not in (0, -15, None):
        sys.stderr.write((srv.stdout.read() or b'').decode()[-4000:])
