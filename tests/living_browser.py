"""CV and review in a real browser against the local edge. Synthetic story only. No SMART or MiChat call.
  python3 tests/living_browser.py
"""
import json, os, re, socket, subprocess, sys, time, urllib.request, urllib.parse, urllib.error, zipfile
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
        def shot(target, name):
            target.screenshot(path=str(SHOTS / name), full_page=True)
        def toast_clear(target, label):
            info = target.evaluate("""() => {
              const toast = document.getElementById('toast');
              toast.textContent = 'Your projects are back from ATLAS.';
              toast.classList.add('show');
              const style = getComputedStyle(toast);
              const clip = (el) => {
                const r = el.getBoundingClientRect();
                let top = r.top, left = r.left, bottom = r.bottom, right = r.right;
                for (let n = el.parentElement; n; n = n.parentElement) {
                  const s = getComputedStyle(n);
                  if (/(auto|scroll|hidden|clip)/.test(s.overflowY + s.overflowX + s.overflow)) {
                    const p = n.getBoundingClientRect();
                    top = Math.max(top, p.top); bottom = Math.min(bottom, p.bottom);
                    left = Math.max(left, p.left); right = Math.min(right, p.right);
                  }
                }
                top = Math.max(0, top); left = Math.max(0, left);
                bottom = Math.min(innerHeight, bottom); right = Math.min(innerWidth, right);
                return {top, left, bottom, right};
              };
              const hit = (a, b) => a.bottom > a.top && a.right > a.left && b.bottom > b.top && b.right > b.left && a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right;
              const tb = clip(toast);
              const bad = ['.cv-doc', '.cv-rail'].filter(sel => [...document.querySelectorAll(sel)].some(node => hit(clip(node), tb)));
              return {fixed: style.position === 'fixed', bad};
            }""")
            check(label, info['fixed'] and info['bad'] == [])
        mobile = browser.new_context(viewport={'width': 390, 'height': 844}).new_page()
        mobile.goto(BASE + '/?as=' + urllib.parse.quote('ada@example.test'))
        mobile.wait_for_timeout(700)
        mobile.locator('header [data-view=living]').click()
        mobile.wait_for_timeout(500)
        opening = page.locator('#living').inner_text()
        check('the screen starts with one need field', page.locator('#livingNeed').count() == 1 and page.locator('#living textarea').count() == 1 and page.locator('#livingNeed').get_attribute('placeholder') == 'Need link or job description')
        check('the brand tagline is not on the CV screen', 'EXPERIENCE INTO STORIES' not in page.locator('body').inner_text() and 'Experience into stories' not in page.locator('body').inner_text())
        check('generate waits for text', page.get_by_role('button', name='Generate CV').is_disabled())
        check('snippet ids and the audience menu stay off the screen', page.locator('#living select').count() == 0 and 'Internal' not in opening and 'A2.1' not in opening)
        shot(page, 'living-empty.png')
        shot(mobile, 'living-empty-mobile.png')
        toast_clear(page, 'empty desktop toast stays fixed and off the CV')
        toast_clear(mobile, 'empty mobile toast stays fixed and off the CV')
        mobile.locator('#livingNeed').fill('https://need.arp.mantu.com/needs/192497')
        mobile.get_by_role('button', name='Generate CV').click()
        mobile.wait_for_timeout(800)
        shot(mobile, 'living-error-mobile.png')
        held_mobile = []
        mobile.route(re.compile(r'living/generate'), lambda route: held_mobile.append(route))
        mobile.locator('#livingNeed').fill('Skill (Must)\nWindows')
        mobile.get_by_role('button', name='Generate CV').click()
        mobile.wait_for_timeout(300)
        shot(mobile, 'living-generating-mobile.png')
        held_mobile.pop().fulfill(status=400, content_type='application/json', body='{"error":"The library did not answer."}')
        mobile.unroute(re.compile(r'living/generate'))
        mobile.wait_for_timeout(1000)
        page.locator('#livingNeed').fill('https://need.arp.mantu.com/needs/192497')
        page.get_by_role('button', name='Generate CV').click()
        page.wait_for_timeout(800)
        check('an unread need link asks for a paste', "Couldn't read that link" in page.locator('#livingStatus').inner_text())
        shot(page, 'living-error.png')
        held = []
        def hold(route):
            held.append(route)
        page.route(re.compile(r'living/generate'), hold)
        page.locator('#livingNeed').fill('Skill (Must)\nWindows\nC++\nC#\nSkill (Nice to have)\nWPF\nLanguage (Must)\nEnglish - Fluent\nLevel of Experience\nMiddle - From 4 to 6 years\nProfile Requirement\nRelevant experience of 2+ years\nKnowledge of C++ an asset')
        page.get_by_role('button', name='Generate CV').click()
        page.wait_for_timeout(300)
        check('generating shows a skeleton', page.locator('.skeleton').count() == 1)
        shot(page, 'living-generating.png')
        held.pop().continue_()
        page.unroute(re.compile(r'living/generate'))
        page.wait_for_timeout(1200)
        body = page.locator('#living').inner_text()
        doc = page.locator('.cv-doc').inner_text()
        rail = page.locator('.cv-stage > .cv-rail').inner_text()
        check('CV bullet is in CV voice', 'Designed the Windows service' in doc and 'I designed' not in doc)
        check('project context is a plain line under the dates', page.locator('.cv-doc .role-context').count() == 1 and 'quieter alarm queue' in page.locator('.cv-doc .role-context').inner_text() and 'quieter alarm queue' not in page.locator('.cv-doc .cv-lines').inner_text() and page.locator('.cv-doc h3', has_text='Context').count() == 0)
        check('evidence and customer value are not CV bullets', 'operations log' not in page.locator('.cv-doc .cv-lines').inner_text() and 'recognise the same constraint' not in page.locator('.cv-doc .cv-lines').inner_text())
        page.locator('.cv-doc .prov').first.click()
        check('evidence and customer value open from the source control', 'operations log' in page.locator('.prov-wrap.open .prov-pop').inner_text() and 'recognise the same constraint' in page.locator('.prov-wrap.open .prov-pop').inner_text())
        page.locator('.cv-doc .prov').first.click()
        page.mouse.move(0, 0)
        page.evaluate("() => { const el = document.activeElement; if (el && el.blur) el.blur(); }")
        check('the CV card hides snippet ids', 'A2.1' not in doc and page.locator('#living select').count() == 0)
        check('a years claim that contradicts the role is a flag, not a CV line', '8 years of Windows work' not in doc and 'role dates cover' in rail and 'I have 8 years' not in body)
        check('unsupported must keyword is a gap beside the CV', 'English' in rail and 'Gaps' not in doc and 'C++' not in doc)
        check('a conflicted skill is only a flag', page.locator('.cv-stage > .cv-rail .gap-chip', has_text='C++').count() == 0 and 'C++' in rail and 'Gaps' not in rail and 'Flags' not in rail)
        check('level and nice-to-have are not gaps', 'Middle - From 4 to 6 years' not in body and 'WPF' not in body)
        check('in-section conflicts are flags', 'Confirm with requester' in rail and 'an asset' in rail)
        check('skills are chips once', page.locator('.cv-doc .chip', has_text='Windows').count() == 1 and page.locator('.cv-doc ol').count() == 0)
        check('provenance has no status label', 'Validated' not in body and page.locator('.cv-doc .prov').count() > 0)
        check('the action bar has no status label', 'In review' not in doc and 'Draft' not in doc and 'Approve to export' not in doc)
        check('export waits for approval', page.get_by_role('button', name='Export').is_disabled())
        check('owner has no approve button', page.get_by_role('button', name='Approve').count() == 0)
        shot(page, 'living-cv.png')
        toast_clear(page, 'generated desktop toast stays fixed and off the CV')
        mobile.goto(BASE + '/?as=' + urllib.parse.quote('ada@example.test'))
        mobile.wait_for_timeout(700)
        mobile.locator('header [data-view=living]').click()
        mobile.wait_for_timeout(800)
        shot(mobile, 'living-cv-mobile.png')
        toast_clear(mobile, 'generated mobile toast stays fixed and off the CV')
        check('mobile CV still shows the sentence', 'Windows service' in mobile.locator('.cv-doc').inner_text())
        def period_clear(target, label):
            period = target.locator('.role-period')
            check(label + ' date is on its own line', period.count() == 1 and '2024' in period.first.inner_text() and '2024' not in target.locator('.role-head h3').first.inner_text())
            target.locator('.role-period').first.evaluate("el => el.scrollIntoView({block:'end'})")
            hit = target.evaluate("""() => {
              const period = document.querySelector('.role-period').getBoundingClientRect();
              const badge = [...document.querySelectorAll('div')].find(el => (el.textContent || '').trim() === 'TEST DEPLOYMENT · SYNTHETIC DATA ONLY');
              const b = badge.getBoundingClientRect();
              return period.bottom > b.top && period.top < b.bottom && period.right > b.left && period.left < b.right;
            }""")
            check(label + ' date clears the synthetic badge', hit is False)
        period_clear(mobile, 'mobile')
        check('mobile shows gaps without a count', mobile.locator('.summary-row').count() == 0 and mobile.locator('.cv-rail .gap-chip', has_text='English').count() == 1 and 'Gaps' not in mobile.locator('#living').inner_text())
        approver = browser.new_context(viewport={'width': 1400, 'height': 900}).new_page()
        approver.goto(BASE + '/?as=' + urllib.parse.quote('pre@example.test') + '&idp=' + urllib.parse.quote(json.dumps({'roles': ['ATLAS.Presales']})))
        approver.wait_for_timeout(700)
        approver.locator('header [data-view=living]').click()
        approver.wait_for_timeout(800)
        check('approver sees the draft', approver.get_by_role('button', name='Approve').count() >= 1)
        approver.screenshot(path=str(SHOTS / 'living-approve.png'), full_page=True)
        approver.get_by_role('button', name='Approve').first.click()
        approver.wait_for_timeout(800)
        page.locator('header [data-view=living]').click()
        page.wait_for_timeout(800)
        check('export is available after approval', page.get_by_role('button', name='Export').is_enabled())
        shot(page, 'living-ready.png')
        toast_clear(page, 'ready desktop toast stays fixed and off the CV')
        mobile.goto(BASE + '/?as=' + urllib.parse.quote('ada@example.test'))
        mobile.wait_for_timeout(700)
        mobile.locator('header [data-view=living]').click()
        mobile.wait_for_timeout(800)
        shot(mobile, 'living-ready-mobile.png')
        toast_clear(mobile, 'ready mobile toast stays fixed and off the CV')
        with page.expect_download() as download:
            page.get_by_role('button', name='Export').click()
        doc = zipfile.ZipFile(download.value.path()).read('word/document.xml').decode()
        check('export is a docx of the CV bullet', 'Designed the Windows service' in doc and 'quieter alarm queue' in doc and 'I designed' not in doc and 'C++' not in doc and '8 years' not in doc and 'Gaps' not in doc and 'operations log' not in doc and 'recognise the same constraint' not in doc)
        page.locator('header [data-view=fiche]').click()
        page.wait_for_timeout(600)
        page.locator('#fiche').get_by_role('button', name='Generate').click()
        page.wait_for_timeout(1000)
        review = page.locator('#fiche').inner_text()
        check('review uses the same sentence', 'Windows service' in review and '99123' not in review)
        shot(page, 'living-review.png')
        mobile.locator('header [data-view=fiche]').click()
        mobile.wait_for_timeout(600)
        shot(mobile, 'living-review-mobile.png')
        none_ref = json.loads(json.dumps(REF))
        none_ref['details']['start'] = '2016-01'
        none_ref['details']['end'] = '2024-11'
        made2 = edge_api('bea@example.test', 'POST', '/api/library', {'localId': 'living-none', 'reference': none_ref})
        check('second story saved', made2[0] == 201)
        settle()
        urllib.request.urlopen(urllib.request.Request(BASE + '/__trust', data=json.dumps({'owner': 'bea@example.test', 'email': 'sam@example.test', 'source': 'directory'}).encode(), headers={'Content-Type': 'application/json'}, method='POST')).read()
        check('second manager approved', edge_api('sam@example.test', 'POST', f"/api/library/{made2[1]['id']}/validate", {'decision': 'validate', 'lane': 'manager'})[0] == 200)
        check('second story published', edge_api('pre@example.test', 'POST', f"/api/library/{made2[1]['id']}/validate", {'decision': 'validate', 'lane': 'presales'}, ['ATLAS.Presales'])[1].get('status') == 'published')
        quiet = browser.new_context(viewport={'width': 1400, 'height': 900}).new_page()
        quiet.goto(BASE + '/?as=' + urllib.parse.quote('bea@example.test'))
        quiet.wait_for_timeout(700)
        quiet.locator('header [data-view=living]').click()
        quiet.locator('#livingNeed').fill('Skill (Must)\nWindows\nC#')
        quiet.get_by_role('button', name='Generate CV').click()
        quiet.wait_for_timeout(1200)
        check('a covered need has no gaps', quiet.locator('.cv-rail').count() == 0 and quiet.locator('.gap-chip').count() == 0 and quiet.locator('.flag-list').count() == 0)
        shot(quiet, 'living-none.png')
        quiet.set_viewport_size({'width': 390, 'height': 844})
        quiet.wait_for_timeout(400)
        shot(quiet, 'living-none-mobile.png')
        page.locator('header [data-view=living]').click()
        page.wait_for_timeout(400)
        page.get_by_role('button', name='Store captured requirement').click()
        page.wait_for_timeout(800)
        check('the captured requirement is stored', '192497' in page.locator('#living').inner_text() and 'Software Developer' in page.locator('#living').inner_text())
        page.get_by_role('button', name='Tailor CV').click()
        page.wait_for_timeout(1200)
        tailored = page.locator('.cv-preview')
        check('a stored requirement tailors the CV', 'Designed the Windows service' in tailored.inner_text() and tailored.locator('.cv-rail .gap-chip', has_text='English').count() == 1)
        browser.close()
    check('no page errors', ERR == [])
finally:
    srv.terminate()
    try: srv.wait(timeout=5)
    except Exception: srv.kill()
    if srv.returncode not in (0, -15, None):
        sys.stderr.write((srv.stdout.read() or b'').decode()[-4000:])
