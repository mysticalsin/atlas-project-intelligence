"""Studio and journey tap targets are at least 44 px. Disclosure summaries included.
The three short summaries are Orb motion details, the build-brief disclosure, and the live ledger.
  python3 tests/tap_targets_browser.py
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
H = (ROOT / 'ATLAS_Voice.html').read_text()
BOOT = {'provider':'workers','providerLabel':'ATLAS voice','protocol':'atlas-personaplex-pcm-v1','csrf':'tok','identity':{'name':'admin@example.test','mode':'access','subjectKey':'k'},'library':True,'libraryRole':'admin','admin':True,'voices':['atlas'],'defaultVoice':'atlas','captureRequired':False,'codecAvailable':True,'busy':False,'capacity':1,'maxSeconds':900,'speakingSeconds':600,'memory':False}
def check(n, v):
    print(('PASS ' if v else 'FAIL ') + n)
    assert v, n
def route(r):
    u = r.request.url.split('?', 1)[0].rstrip('/')
    if u.endswith('atlas.test'):
        return r.fulfill(body=H, content_type='text/html')
    if u.endswith('/api/bootstrap'):
        return r.fulfill(json=BOOT)
    if u.endswith('/api/library/journey'):
        return r.fulfill(json={'stages':[{'id':'project','title':'Identify the project','current':True}],'fields':{},'confirmed':{},'roles':{'explanation':'x','decision':'y','matches':[]},'publication':'z','integrations':{}})
    if u.endswith('/api/library'):
        return r.fulfill(json={'items':[]})
    r.fulfill(status=404, body='{}')
MEASURE = """() => {
  const skip = el => el.classList.contains('skip') || el.closest('.steps');
  const box = el => { const b = el.getBoundingClientRect(); return {h: b.height, w: b.width}; };
  const label = el => (el.innerText || el.getAttribute('aria-label') || el.id || el.tagName).replace(/\\s+/g, ' ').trim().slice(0, 70);
  const vis = el => { const b = box(el); const s = getComputedStyle(el); return b.h > 1 && b.w > 1 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const buttons = [...document.querySelectorAll('button, a.btn')].filter(el => vis(el) && !skip(el)).map(el => ({t: label(el), ...box(el)})).filter(x => x.h < 44);
  const summaries = [...document.querySelectorAll('summary')].filter(vis).map(el => ({t: label(el), ...box(el)})).filter(x => x.h < 44);
  const under24 = summaries.filter(x => x.h < 24);
  return {buttons, summaries, under24};
}"""
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
    page = browser.new_page(viewport={'width': 390, 'height': 900})
    page.route('**/*', route)
    page.goto('https://atlas.test/')
    page.wait_for_timeout(400)
    surfaces = []
    surfaces.append(('studio', page.evaluate(MEASURE)))
    page.locator('header [data-view=journey]').click()
    page.wait_for_timeout(400)
    surfaces.append(('journey', page.evaluate(MEASURE)))
    page.evaluate("() => document.getElementById('howDialog').showModal()")
    page.wait_for_timeout(200)
    surfaces.append(('how', page.evaluate(MEASURE)))
    page.evaluate("() => { document.getElementById('howDialog').close(); document.getElementById('intelligenceDialog').showModal(); }")
    page.wait_for_timeout(200)
    surfaces.append(('intelligence', page.evaluate(MEASURE)))
    under24 = [item for name, data in surfaces for item in data['under24']]
    short_buttons = [(name, item) for name, data in surfaces for item in data['buttons']]
    short_summaries = [(name, item) for name, data in surfaces for item in data['summaries']]
    print('summaries under 24', under24)
    print('controls under 44', len(short_buttons), 'buttons;', len(short_summaries), 'summaries')
    for name, item in (short_buttons + short_summaries)[:12]:
        print(f"  {name} {item['h']:.0f}px {item['t']}")
    check('three short summaries are at least 44 px', len(under24) == 0)
    check('visible studio and journey controls are at least 44 px', not short_buttons and not short_summaries)
    browser.close()
