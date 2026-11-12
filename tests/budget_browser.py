"""The month-stop sentence in the browser. One message, no helper text, on the surfaces that would have shown model output.
Quality warning, reference-sheet draft, meeting recommendations and Ask. Routes are answered in memory. No provider.
  python3 tests/budget_browser.py
"""
import json, os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
H = (ROOT / 'ATLAS_Voice.html').read_text().replace('/* SERVER_RUNTIME */', "window.ATLAS_RUNTIME={subjectKey:'k',authMode:'access',name:'kim@mantu.com'};", 1)
ERR = []
MSG = "This month's AI budget is used up."
SHOTS = Path('/opt/cursor/artifacts')
def source_keys_on_the_code():
    text = (ROOT / 'src/app.js').read_text()
    voice = (ROOT / 'src/voice-client.js').read_text()
    check('the page keys on code budget_exhausted', text.count("e.code==='budget_exhausted'") >= 3 and "code==='budget_exhausted'" in voice)
    check('the page does not compare the sentence', MSG not in text and MSG not in voice)
def check(n, v):
    print(('PASS ' if v else 'FAIL ') + n)
    assert v, n
def boot():
    return {'provider': 'workers', 'providerLabel': 'ATLAS voice', 'csrf': 'tok', 'identity': {'name': 'kim@mantu.com', 'mode': 'access', 'subjectKey': 'k'},
            'email': 'kim@mantu.com', 'library': True, 'libraryRole': 'user', 'memory': False, 'sheet': True,
            'protocol': 'atlas-personaplex-pcm-v1', 'codecAvailable': True, 'busy': False, 'voices': ['atlas'], 'defaultVoice': 'atlas', 'transcription': True, 'captureRequired': True,
            'features': {'bids': False, 'ask': True, 'spokenAsk': False}}
def route(r):
    req = r.request
    u = urlparse(req.url)
    path = u.path
    if req.url.rstrip('/') == 'https://atlas.test':
        return r.fulfill(body=H, content_type='text/html')
    if path == '/api/bootstrap':
        return r.fulfill(json=boot())
    if path == '/api/library/invitations':
        return r.fulfill(json={'items': []})
    if path == '/api/library' and req.method == 'GET':
        return r.fulfill(json={'items': [], 'total': 0, 'facets': {'country': {}, 'industry': {}}})
    if path == '/api/sheet/draft':
        return r.fulfill(status=429, json={'error': MSG, 'code': 'budget_exhausted'})
    if path == '/api/library/recommend':
        return r.fulfill(json={'target': {'industry': 'Energy', 'audience': '', 'country': '', 'likelyChallenges': ['queue'], 'capabilities': ['routing']},
            'results': [{'id': 'r1', 'title': 'Claims routing', 'relevance': None, 'status': 'published', 'why': '', 'transferable': [], 'caveat': ''}],
            'method': 'lexical', 'label': 'Method line that must not appear.',
            'budget': {'code': 'budget_exhausted', 'message': MSG}})
    if path == '/api/library/ask':
        return r.fulfill(json={'verdict': 'unranked', 'method': 'lexical (not ranked)', 'results': [
            {'id': 'r1', 'title': 'Claims routing', 'status': 'published', 'relevance': None, 'similarity': 0.2, 'retrieval': 'lexical', 'why': '', 'caveat': '', 'snippets': [], 'people': []}],
            'people': [], 'countries': [], 'totals': {'visible': 1}, 'note': 'Helper that must not appear.', 'label': 'Label that must not appear.',
            'budget': {'code': 'budget_exhausted', 'message': MSG}})
    if path.startswith('/api/'):
        return r.fulfill(status=404, json={'error': 'not mocked: ' + path})
    return r.fulfill(status=404, body='')
def voice(ws):
    def on(m):
        if isinstance(m, bytes): return
        d = json.loads(m)
        if d.get('type') == 'start':
            ws.send(json.dumps({'type': 'ready', 'mode': 'full', 'model': 'ATLAS', 'provider': 'ATLAS voice', 'sampleRate': 24000, 'capture': True,
                                'liveLedger': False, 'maxSeconds': 900, 'speakingSeconds': 600, 'message': 'ready'}))
            ws.send(json.dumps({'type': 'error', 'message': MSG, 'code': 'budget_exhausted'}))
    ws.on_message(on)
source_keys_on_the_code()
SHOTS.mkdir(parents=True, exist_ok=True)
with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None,
                            args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
    p = br.new_context(permissions=['microphone']).new_page()
    p.route_web_socket('**/api/voice', voice)
    p.on('pageerror', lambda e: ERR.append(str(e)))
    p.route('**/*', route)
    p.goto('https://atlas.test/')
    p.wait_for_timeout(400)
    p.evaluate('m => window.dispatchEvent(new CustomEvent("atlas-quality", {detail:{type:"quality_warning", message:m}}))', MSG)
    check('quality warning is the one sentence', p.locator('#qualityOpen').inner_text() == MSG)
    p.locator('[data-action=new-project]:visible').first.click()
    p.wait_for_timeout(200)
    for k, v in {'projectTitle': 'Claims triage', 'consultantName': 'Alex Martin', 'sectorInput': 'Insurance'}.items():
        p.locator('#' + k).fill(v)
    p.locator('#projectForm button[type=submit]').click()
    p.wait_for_timeout(200)
    p.locator('header [data-view=projects]').click()
    p.wait_for_timeout(200)
    p.locator('[data-sheet]').first.click()
    p.wait_for_timeout(200)
    p.locator('#sheetOppPending').check()
    p.locator('#sheetStep1Next').click()
    p.wait_for_timeout(200)
    p.locator('#sheetPaste').fill('Claims triage rollout for an insurer. Routing was rebuilt over six months.')
    p.locator('#sheetUseInterview').uncheck()
    p.locator('#sheetDraft').click()
    p.wait_for_timeout(400)
    check('sheet draft shows the one sentence', p.locator('#sheetDraftStatus').inner_text() == MSG)
    p.screenshot(path=str(SHOTS / 'budget-sheet.png'))
    check('sheet draft has no helper text', 'by hand' not in p.locator('#sheetDraftStatus').inner_text() and 'To be completed' not in p.locator('#sheetDraftStatus').inner_text())
    p.locator('#sheetDialog [data-close]').click()
    p.wait_for_timeout(200)
    p.locator('header [data-view=library]').click()
    p.wait_for_selector('#askQuestion')
    p.locator('#recommendQuery').fill('I am meeting the data director of a major energy company.')
    p.locator('#recommendGo').click()
    p.wait_for_timeout(400)
    rec = p.locator('#recommendResults').inner_text()
    check('recommend shows the sentence and the lexical card', MSG in rec and 'Claims routing' in rec)
    check('recommend hides the reading and the method line', "ATLAS's reading" not in rec and 'Method:' not in rec and 'Method line' not in rec)
    p.locator('#askQuestion').fill('What have we done on claims backlogs in insurance?')
    p.locator('#askGo').click()
    p.wait_for_timeout(400)
    check('ask status is the one sentence', p.locator('#askStatus').inner_text() == MSG)
    p.screenshot(path=str(SHOTS / 'budget-ask.png'))
    check('ask hides the verdict helper', p.locator('#askVerdict').is_hidden() and 'Claims routing' in p.locator('#askResults').inner_text())
    p.locator('header [data-view=interview]').click()
    p.wait_for_timeout(200)
    p.locator('#voiceStart').click()
    p.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000)
    p.locator('#modelConsent').check()
    p.locator('#voiceConsentStart').click()
    p.wait_for_function('()=>AtlasVoice.status().phase==="error"', timeout=8000)
    check('voice month stop is the one sentence', p.locator('#voiceHeading').inner_text() == MSG and p.locator('#voiceMessage').inner_text() == '')
    p.screenshot(path=str(SHOTS / 'budget-voice.png'))
    check('voice month stop has no helper sentence', 'No fallback voice' not in p.locator('#interview').inner_text() and 'unmetered' not in p.locator('#interview').inner_text() and 'paused for this month' not in p.locator('#interview').inner_text())
    check('no page errors', not ERR)
    print('BUDGET_BROWSER_OK')
    br.close()
