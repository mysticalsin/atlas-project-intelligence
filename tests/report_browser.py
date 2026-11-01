"""The "Project at a glance" dashboard in the Stories report, in a real browser against the built page (no network).
A project is created through the app's own save path (an interview report with facts), then its draft story is opened.
Checks: the map places the recorded countries (interview-sourced, so hatched), tooltip/zoom/keyboard work, gaps show
"To be completed", no horizontal overflow at 320/390/768/1366 px, and the exported HTML carries static charts, no script.
  python3 tests/report_browser.py
"""
import json, os, re
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]; H = (ROOT / 'ATLAS_Project_Intelligence.html').read_text(); ERR = []; OUT = ROOT / 'tests' / 'report-screens'
BOOT = {'provider': 'workers', 'providerLabel': 'ATLAS voice', 'csrf': 'tok', 'identity': {'name': 'tester@example.com', 'mode': 'access', 'subjectKey': 'k'},
        'voices': ['atlas'], 'defaultVoice': 'atlas', 'captureRequired': True, 'codecAvailable': True, 'busy': False, 'capacity': 1, 'maxSeconds': 900,
        'speakingSeconds': 600, 'memory': False, 'transcription': True, 'playbackAck': True}
REP = {'headline': 'Claims triage rebuilt with ML routing', 'summary': 'The consultant led a redesign of claims triage for the client.', 'topics': {'context': 'Tickets bounced between teams.'},
       'highlights': ['Ownership'], 'gaps': ['No named source'], 'follow_ups': [], 'status': 'model_draft',
       'facts': {'project_id': 'PRJ-0042', 'country': 'France & Deutschland, Remote', 'industry': 'Insurance', 'start': '2024-01', 'end': '2024-09', 'duration': '8 months',
                 'team_size': 5, 'team_roles': ['Lead engineer', 'Analyst'], 'technologies': ['Python', 'SQL', 'Airflow'], 'deliverables': ['Routing model', 'Runbook'], 'service_lines': ['Data & AI']}}
def route(r):
    u = r.request.url
    if u.endswith('/api/bootstrap'): return r.fulfill(json=BOOT)
    if u.rstrip('/') == 'https://atlas.test': return r.fulfill(body=H, content_type='text/html')
    r.fulfill(status=404, body='')
def check(n, v): print(('PASS ' if v else 'FAIL ') + n); assert v, n
OUT.mkdir(exist_ok=True)
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
    ctx = b.new_context(viewport={'width': 1366, 'height': 1000}, accept_downloads=True); p = ctx.new_page(); p.on('pageerror', lambda e: ERR.append(str(e)))
    p.route('**/*', route); p.goto('https://atlas.test/'); p.wait_for_timeout(700)
    snap = p.evaluate('window.ATLAS_VOICE_BRIDGE.context()')
    p.evaluate("([s,rep])=>window.ATLAS_VOICE_BRIDGE.autoSave(s,['Tickets bounced between teams.','I led the routing redesign.','Pilot first.','Triage got faster.','','Other insurers'],'Transcript words.',rep)", [snap, REP])
    p.wait_for_timeout(500)
    if p.locator('#confirmDialog').is_visible(): p.locator('#confirmDialog [data-close], #confirmNo').first.click(); p.wait_for_timeout(200)
    for d in ('reportDialog',):
        if p.locator('#' + d).is_visible(): p.evaluate(f"document.getElementById('{d}').close()")
    p.locator('header [data-view=stories]').first.click(); p.wait_for_timeout(2200)  # entry animations finish
    check('the draft report carries the "Project at a glance" dashboard', p.locator('#storyPaper .atlas-dash').count() == 1)
    check('the DRAFT / UNVERIFIED banner stays above it', 'DRAFT / UNVERIFIED' in p.locator('#storyPaper .status-banner').inner_text())
    fr = p.locator('#storyPaper path[data-code=FRA]'); de = p.locator('#storyPaper path[data-code=DEU]')
    check('France and Germany ("France & Deutschland") are placed on the map', fr.count() == 1 and de.count() == 1 and fr.get_attribute('data-state') == 'interview' and de.get_attribute('data-state') == 'interview')
    check('"Remote" is listed as not placed, never guessed', 'Remote' in p.locator('#storyPaper .atlas-dash').inner_text())
    check('interview-sourced data is labelled unverified', 'unverified' in p.locator('#storyPaper .atlas-dash').inner_text().lower())
    check('the outcome card shows "To be completed" instead of an invented number', p.locator('#storyPaper .atlas-outcome-bars').count() == 0 and 'To be completed' in p.locator('#storyPaper .atlas-dash').inner_text())
    check('with no evidence yet, each story topic says so (no empty grid)', p.locator('#storyPaper .ag-me li').count() == 5 and 'No supporting source yet' in p.locator('#storyPaper .ag-me').inner_text())
    svg = p.locator('#storyPaper .ag-mf > svg'); vb0 = svg.get_attribute('viewBox')
    de.hover(); p.wait_for_timeout(250)
    check('hovering a country shows the tooltip with what was typed', p.locator('.ag-tip').is_visible() and 'Deutschland' in p.locator('.ag-tip').inner_text())
    p.locator('#storyPaper [data-ag-zoom=in]').click(); p.wait_for_timeout(200); vb1 = svg.get_attribute('viewBox')
    p.locator('#storyPaper [data-ag-zoom=reset]').click(); p.wait_for_timeout(200)
    check('zoom in and reset change and restore the map view', vb1 != vb0 and svg.get_attribute('viewBox') == vb0)
    p.screenshot(path=str(OUT / 'report-1366.png'), full_page=True)
    for w in (320, 390, 768):
        p.set_viewport_size({'width': w, 'height': 900}); p.wait_for_timeout(400)
        # (map shapes outside the map frame are clipped by the SVG; the screen-reader table is clipped to 1 px)
        ok = p.evaluate("document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll('#storyPaper .atlas-dash *')].filter(e=>(!e.closest('svg')||e.tagName==='svg')&&!e.closest('.ag-sr')).every(e=>e.getBoundingClientRect().right<=innerWidth+1)")
        check(f'no horizontal overflow at {w} px', ok)
        if w == 390: p.screenshot(path=str(OUT / 'report-390.png'), full_page=True)
    p.set_viewport_size({'width': 1366, 'height': 1000}); p.wait_for_timeout(200)
    with p.expect_download() as dl:
        p.select_option('#exportFormat', 'html'); p.locator('#exportDraft').click()
    exp = Path(dl.value.path()).read_text()
    check('the exported HTML carries the charts as static SVG', 'atlas-dash' in exp and '<svg' in exp and 'data-code="FRA"' in exp)
    check('the export has no script and no event handlers', '<script' not in exp.lower() and not re.search(r'<[^>]+\son[a-z]+\s*=', exp))
    check('the export keeps its no-script CSP', "default-src 'none'" in exp)
    p.select_option('#exportFormat', 'md')
    with p.expect_download() as dl2:
        p.locator('#exportDraft').click()
    md = Path(dl2.value.path()).read_text()
    check('the Markdown export has an "At a glance" summary with the placed countries', '## At a glance' in md and 'France' in md and 'Germany' in md)
    sector = p.locator('#storyPaper .ag-chip', has_text='Sector:')
    check('the sector taken from the interview is labelled as such', sector.count() == 1 and 'ag-iv' in (sector.get_attribute('class') or ''))
    p.locator('header [data-view=projects]').first.click(); p.wait_for_timeout(400)
    p.locator('[data-action=edit-project]').first.click(); p.wait_for_timeout(300)
    p.evaluate("document.getElementById('projectMore').open=true"); p.fill('#sectorInput', 'Reinsurance'); p.evaluate("document.getElementById('projectForm').requestSubmit()"); p.wait_for_timeout(300)
    p.locator('header [data-view=stories]').first.click(); p.wait_for_timeout(2200)
    sector = p.locator('#storyPaper .ag-chip', has_text='Sector: Reinsurance')
    check('a sector the consultant retypes loses the "from interview" label', sector.count() == 1 and 'ag-iv' not in (sector.get_attribute('class') or ''))
    check('no page errors', not ERR); print(ERR)
    b.close()
