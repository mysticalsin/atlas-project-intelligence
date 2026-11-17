"""An autoSave whose library write is refused because the audit chain does not verify
shows one line in the existing status strip. No toast. The draft stays in the tab.
The line clears on the next successful save.
  python3 tests/autosave_chain_browser.py
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
LINE = "Not saved: audit history can't be verified"
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
POST = re.compile(r'/api/library/?$')


def check(name, value):
    print(('PASS ' if value else 'FAIL ') + name)
    assert value, name


try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
        page = browser.new_context(viewport={'width': 1400, 'height': 1000}).new_page()

        def refuse(route):
            if route.request.method == 'POST' and POST.search(route.request.url.split('?')[0]):
                route.fulfill(status=409, content_type='application/json',
                              body=json.dumps({'error': 'The audit chain is tampered.', 'code': 'TRUNCATED'}))
                return
            route.fallback()

        page.route('**/api/library**', refuse)
        page.goto(BASE + '/?as=' + urllib.parse.quote('ada@example.test'))
        page.wait_for_timeout(400)
        page.evaluate("([n,rep])=>window.ATLAS_VOICE_BRIDGE.autoSave(window.ATLAS_VOICE_BRIDGE.context(),n,'Consultant words.',rep)", [NOTES, REP])
        page.wait_for_function("t => document.getElementById('storageStatus').textContent === t", arg=LINE, timeout=8000)
        strip = page.locator('#storageStatus').text_content()
        check('one line', strip == LINE)
        check('no toast', page.locator('#toast.show').count() == 0 and LINE not in (page.locator('#toast').text_content() or ''))
        check('draft kept', page.evaluate("window.ATLAS_LOCAL.snapshot().profiles.some(p=>p.projects.length===1)"))
        page.evaluate("([n,rep])=>window.ATLAS_VOICE_BRIDGE.autoSave(window.ATLAS_VOICE_BRIDGE.context(),n,'Consultant words again.',rep)", [NOTES, REP])
        page.wait_for_timeout(600)
        check('shown once', page.locator('#storageStatus').text_content() == LINE and page.locator('#toast.show').count() == 0)
        page.unroute('**/api/library**')
        page.evaluate("()=>window.ATLAS_APP.libraryApi('',{method:'POST',body:{localId:'retry',reference:{title:'Claims triage alias',stage:'Pilot',sector:'Insurance',consultant:{name:'Ada',role:'Data engineer'},client:{name:'Zebracorp',location:'Lyon',contact:'Head of Claims'},details:{projectId:'PRJ-2291',country:'France',consultants:[]},answers:['One answer that is long enough to store.','','','','',''],validation:{manager:{name:'Sam',email:'sam@example.test'},managerStaff:false}}}})")
        page.wait_for_timeout(400)
        # The successful save is the same tab's own sync, not a second helper.
        page.evaluate("""() => {
          const p = window.ATLAS_LOCAL.snapshot().profiles.flatMap(u => u.projects)[0];
          const bridge = window.ATLAS_VOICE_BRIDGE;
          return bridge.autoSave(bridge.context(), [null, null, null, 'A later note that changes the draft.', null, null], 'Later words.', null);
        }""")
        urllib.request.urlopen(BASE + '/__settle', timeout=30).read()
        page.wait_for_function("() => document.getElementById('storageStatus').textContent === 'Saved to ATLAS'", timeout=8000)
        check('cleared after a successful save', page.locator('#storageStatus').text_content() == 'Saved to ATLAS')
        check('draft still in the tab', page.evaluate("window.ATLAS_LOCAL.snapshot().profiles.some(p=>p.projects.length===1)"))
        browser.close()
finally:
    srv.terminate()
    try:
        srv.wait(timeout=5)
    except Exception:
        srv.kill()
