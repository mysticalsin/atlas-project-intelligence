"""Zero-setup start and the profile (docs/WOW_ZERO_CONFIG.md §9 "Playwright", cases 1-9, plus the admin directory's column
minimisation) in a real browser. Harness (a): the built HTML on a routed https origin, with /api/bootstrap, /api/library/*,
/api/memory/* and the voice WebSocket answered in memory per the §6 contracts; ATLAS_RUNTIME is injected where a case says
"live origin". Chromium's fake microphone stands in for a person. No network (anything not on atlas.test is aborted), no
model, no provider. The edge routes themselves are tested in deploy/cloudflare-edge/test.
  python3 build.py && python3 tests/zero_config_browser.py
"""
import json, os, re, sys, time
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
H = (ROOT / 'ATLAS_Voice.html').read_text()
HOME = json.loads(re.search(r'<script>window\.ATLAS_HOME=("[^"<]*");</script>', H).group(1))
LIVE = H.replace('<script id="atlas-runtime" type="application/json">{}</script>', '<script id="atlas-runtime" type="application/json">{"subjectKey":"k-tony","authMode":"access","name":"tony.walteur@example.com"}</script>', 1)
SIGNED_IN = '<!doctype html><meta charset="utf-8"><title>Signed in</title><p>You’re signed in. This window closes by itself.</p><script>new BroadcastChannel("atlas-auth").postMessage("ok");close();</script>'
FORBIDDEN = re.compile(r'gateway|localhost|GPU|\.env|NVIDIA|address', re.I)
REP = {'headline': 'Claims triage rebuilt', 'summary': 'The consultant rebuilt claims triage for the client.', 'topics': {'context': 'Tickets bounced between teams.'},
       'highlights': [], 'gaps': ['No named source'], 'follow_ups': [], 'status': 'model_draft'}
ERR = []
# The people lookup's stored directory rows (§5.8): name and title only, never the N+1
PEOPLE = {'jane@example.com': {'name': 'Jane Doe', 'title': 'Principal Data Lead', 'from': 'dna_export'}, 'bob@example.com': {'name': 'Bob Stone', 'title': 'Director', 'from': 'dna'}}
ANALYTICS ={'totals': {'visible': 0, 'published': 0, 'byStatus': []}, 'byCountry': [], 'byServiceLine': [], 'byPractice': [], 'byIndustry': [], 'byTechnology': [], 'byConsultant': [],
             'byClient': [], 'coverage': [], 'coverageGaps': [], 'strongest': [], 'needsEnrichment': [], 'activityWithoutReference': []}


def check(n, v):
    print(('PASS ' if v else 'FAIL ') + n, flush=True)
    assert v, n


def field(value, src, at='2026-09-01T10:00:00Z', newer=None):
    f = {'value': value, 'from': src, 'at': at}
    if newer: f['newer'] = newer
    return f


def profile(name=('Tony Walteur', 'dna'), title=('Principal Consultant', 'dna'), manager=(('Sam Lead', 'dna'), ('sam@example.com', 'dna')), first='Tony', guessed=False):
    return {'email': 'tony.walteur@example.com', 'firstName': first, 'guessed': guessed, 'consents': {}, 'sources': [{'id': 'dna', 'state': 'ok'}], 'updatedAt': '2026-09-29T10:00:00Z',
            'fields': {'name': field(*name) if name else None, 'preferredName': None, 'title': field(*title) if title else None,
                       'managerName': field(*manager[0]) if manager else None, 'managerEmail': field(*manager[1]) if manager else None}}


class Server:
    """In-memory stand-in for the Worker routes this page calls (§6 contracts). Records every /api request."""
    def __init__(s, live=True, memory=False, prof=None, features=None, role='user'):
        s.page = LIVE if live else H
        s.boot = {'provider': 'workers', 'providerLabel': 'ATLAS voice', 'protocol': 'atlas-personaplex-pcm-v1', 'csrf': 'tok', 'model': 'ATLAS conversational voice',
                  'identity': {'name': 'tony.walteur@example.com', 'mode': 'access', 'subjectKey': 'k-tony'}, 'email': 'tony.walteur@example.com', 'admin': False,
                  'voices': ['atlas'], 'defaultVoice': 'atlas', 'captureRequired': True, 'codecAvailable': True, 'busy': False, 'capacity': 1, 'maxSeconds': 900, 'speakingSeconds': 600,
                  'memory': memory, 'wiki': False, 'jev': False, 'jevClassify': False, 'library': True, 'libraryRole': role, 'sheet': False, 'transcription': True,
                  'structuredNotes': True, 'liveLedger': False, 'playbackAck': True, 'readiness': 'edge-deployment-test-data-only',
                  'features': {'profile': True, 'bids': False, 'ask': False, 'spokenAsk': False, 'gaps': False, 'gapInterview': False, **(features or {})}}
        s.profile = prof; s.mem_off = False; s.records = {}; s.log = []; s.frames = []; s.once = {}; s.expire = set()
        s.lib_status = 201; s.boot_status = 200; s.ws_mode = 'full'; s.gap_id = None; s.auto_wrap = True; s.close_before_ready = False; s.sock = None; s.dir_rows = 0

    def api(s, m, path=None):
        return [x for x in s.log if x['m'] == m and (path is None or x['path'] == path)]

    def route(s, r):
        req = r.request; u = urlparse(req.url); path = u.path; m = req.method
        if u.hostname != 'atlas.test': return r.abort()  # never the network
        if path == '/' and m == 'GET': return r.fulfill(body=s.page, content_type='text/html')
        if path == '/go/signed-in': return r.fulfill(body=SIGNED_IN, content_type='text/html')
        if not path.startswith('/api/'): return r.fulfill(status=404, body='')
        body = None
        if m == 'POST' and 'json' in (req.headers.get('content-type') or ''): body = json.loads(req.post_data or 'null')
        s.log.append({'m': m, 'path': path, 'q': parse_qs(u.query), 'body': body, 'xrw': req.headers.get('x-requested-with'), 'csrf': req.headers.get('x-atlas-csrf')})
        if s.once.get(path, 0) > 0:
            s.once[path] -= 1; return r.fulfill(status=401, json={'error': 'Sign in to use ATLAS.'})
        if path in s.expire: return r.fulfill(status=401, json={'error': 'Sign in to use ATLAS.'})
        if m == 'POST' and req.headers.get('x-atlas-csrf') != 'tok': return r.fulfill(status=403, json={'error': 'CSRF'})
        if path == '/api/bootstrap':
            if s.boot_status != 200: return r.fulfill(status=s.boot_status, body='<!doctype html><title>522: Connection timed out</title>', content_type='text/html')
            return r.fulfill(json=s.boot)
        if path == '/api/library/profile':
            if s.profile is None: return r.fulfill(status=404, json={'error': 'This feature is not available in this deployment.'})
            if m == 'POST': s.apply_profile(body or {})
            return r.fulfill(json=s.profile)
        if path == '/api/library/profile/consent' and m == 'POST':
            s.profile['consents'] = {'spokenAsk': {'version': 1, 'at': '2026-09-29T10:00:00Z'}} if body.get('granted') else {}
            return r.fulfill(json=s.profile)
        if path == '/api/library' and m == 'GET':
            items = [{'id': k, 'title': v['data']['title'], 'status': 'in_review', 'revision': v['revision'], 'access': 'full', 'mine': True, 'owner': 'tony.walteur@example.com',
                      'updatedAt': v['at'], 'practice': '', 'industry': '', 'country': '', 'serviceLines': [], 'technologies': [], 'headline': '', 'impact': None,
                      'qualityScore': None, 'qualityStatus': '', 'client': ''} for k, v in s.records.items()]
            return r.fulfill(json={'items': items, 'total': len(items), 'facets': {'country': {}, 'industry': {}}})
        if path == '/api/library' and m == 'POST':
            if s.lib_status == 401: return r.fulfill(status=401, json={'error': 'Sign in to use ATLAS.'})
            rid = body.get('id') or ('%032x' % (len(s.records) + 0xabc0))
            rec = s.records.get(rid, {'revision': 0})
            s.records[rid] = {'revision': rec['revision'] + 1, 'data': body['reference'], 'at': '2026-09-29T10:%02d:00Z' % len(s.log)}
            return r.fulfill(status=201, json={'id': rid, 'revision': s.records[rid]['revision'], 'status': 'in_review', 'unchanged': False})
        mm = re.match(r'^/api/library/([a-f0-9]{32})$', path)
        if mm and m == 'GET' and mm.group(1) in s.records:
            rec = s.records[mm.group(1)]
            return r.fulfill(json={'id': mm.group(1), 'revision': rec['revision'], 'status': 'in_review', 'access': 'full', 'data': rec['data'],
                                   'state': {'validation': {'status': 'awaiting'}, 'quality': None, 'duplicates': []}, 'permissions': {}, 'revisions': [], 'audit': []})
        if path == '/api/library/invitations': return r.fulfill(json={'items': []})
        if path == '/api/library/people' and m == 'GET':  # §6: one exact email -> {email, name, title, from} from stored directory rows, or 404
            e = (parse_qs(u.query).get('email') or [''])[0].lower(); who = PEOPLE.get(e)
            return r.fulfill(json={'email': e, **who}) if who else r.fulfill(status=404, json={'error': 'Nobody with that email in the directory.'})
        if path == '/api/library/analytics': return r.fulfill(json=ANALYTICS)
        if path == '/api/library/directory':
            return r.fulfill(json={'dataMode': 'test', 'rows': {'dna': 0, 'dna_export': s.dir_rows}, 'lastImport': None,
                                   'sources': {'pull': {'status': 'BLOCKED_EXTERNAL', 'needs': ['a production deployment (`DATA_MODE=production`)']},
                                               'push': {'status': 'BLOCKED_EXTERNAL'}, 'dna_export': {'status': 'on'}, 'signin': {'status': 'BLOCKED_EXTERNAL'}}})
        if path == '/api/library/directory/import' and m == 'POST':
            return r.fulfill(json={'accepted': len(body['rows']), 'rejected': [], **({'replaced': {'from': s.dir_rows, 'to': len(body['rows'])}} if body.get('final') else {})})
        if path == '/api/memory/settings':
            if m == 'POST': s.mem_off = (body or {}).get('off') is True
            return r.fulfill(json={'off': s.mem_off})
        if path == '/api/memory/remember' and m == 'POST': return r.fulfill(json={'stored': not s.mem_off})
        if path == '/api/memory' and m == 'GET': return r.fulfill(json={'enabled': True, 'off': s.mem_off, 'documents': []})
        return r.fulfill(status=404, json={'error': 'not mocked: ' + path})

    def apply_profile(s, body):
        f = s.profile['fields']
        if body.get('confirmGuess') and f['name'] and f['name']['from'] == 'guess':
            f['name'] = field(f['name']['value'], 'you'); s.profile['guessed'] = False; s.profile['firstName'] = f['name']['value'].split()[0]
        for k, v in (body.get('set') or {}).items(): f[k] = field(v, 'you')
        for k in body.get('clear') or []:
            nw = (f.get(k) or {}).get('newer'); f[k] = field(nw['value'], nw['from']) if nw else None

    def ws(s, ws):
        s.sock = ws
        def on(m):
            if isinstance(m, bytes): return
            d = json.loads(m); s.frames.append(d)
            if d.get('type') == 'start':
                if s.close_before_ready: ws.close(); return
                ws.send(json.dumps({'type': 'ready', 'mode': s.ws_mode, 'model': 'ATLAS', 'provider': 'ATLAS voice', 'sampleRate': 24000, 'capture': True, 'liveLedger': False,
                                    'maxSeconds': 900, 'speakingSeconds': 600, 'message': 'ready'}))
                ws.send(json.dumps({'type': 'agent_text', 'text': "Hi, I'm ATLAS."}))
                if s.auto_wrap: ws.send(json.dumps({'type': 'wrap_up', 'message': 'done'}))
            if d.get('type') == 'end':
                notes = {'type': 'notes', 'transcript': 'I owned the routing design at Zebracorp.', 'sections': ['I owned the routing design.', '', '', '', '', ''],
                         'status': 'candidate', 'report': REP, 'message': 'm'}
                if s.ws_mode == 'gap': notes.update(mode='gap', report=None, gap={'requestId': s.gap_id, 'results': []})
                for e in [{'type': 'audio_stopped'}, {'type': 'reporting'}, notes, {'type': 'ended', 'message': 'closed'}]: ws.send(json.dumps(e))
        ws.on_message(on)


def wait(p, cond, timeout=8):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if cond(): return True
        p.wait_for_timeout(100)
    return cond()


with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None,
                            args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])

    def open_page(s, url='https://atlas.test/', w=1440):
        ctx = br.new_context(permissions=['microphone'], viewport={'width': w, 'height': 1000})
        ctx.route('**/*', s.route)
        p = ctx.new_page(); p.on('pageerror', lambda e: ERR.append(str(e)))
        p.loads = []; p.on('load', lambda _: p.loads.append(1))
        p.route_web_socket('**/api/voice', s.ws)
        p.goto(url); p.wait_for_timeout(700)
        return p

    def consent(p):
        p.locator('#voiceStart').click(); p.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000)

    def talk(p, s):
        n = len(s.frames)
        p.locator('#modelConsent').check(); p.locator('#voiceConsentStart').click()
        wait(p, lambda: any(f.get('type') == 'end' for f in s.frames[n:]), 15)
        p.wait_for_function('()=>AtlasVoice.status().phase==="idle"', timeout=8000)

    def close_dialogs(p, back=True):
        # the report opens by itself after an interview (Projects view); back to the Conversation view with nothing modal open
        p.evaluate("for(const d of document.querySelectorAll('dialog[open]'))d.close()")
        if back: p.locator('header [data-view=interview]').click(); p.wait_for_timeout(150)

    def projects(p):
        return p.evaluate('window.ATLAS_LOCAL.snapshot().profiles[0].projects')

    # ---- 1. Fresh user -> consent -> interview, zero setup
    s = Server(prof=profile())
    p = open_page(s)
    check('1 no setup text in the conversation view, the address form hidden, the pill reads "Ready"',
          not FORBIDDEN.search(p.locator('#interview').inner_text()) and p.locator('#gatewayOpenBox').is_hidden() and p.locator('#voiceState').inner_text() == 'Ready'
          and p.locator('#cardConnection').is_hidden() and p.locator('#emptyVoiceNote').is_hidden())
    check('1 the connection pill is labelled "Connection and privacy"', p.locator('#studioConnection').get_attribute('aria-label') == 'Connection and privacy')
    consent(p)
    dlg = p.locator('#voiceConsentDialog')
    check('1 Start opens the consent step at once: exactly one visible checkbox, heading with the first name',
          dlg.locator('input[type=checkbox]:visible').count() == 1 and 'Tony' in p.locator('#voiceConsentTitle').inner_text() and p.locator('#voiceConsentEyebrow').inner_text() == 'BEFORE WE START')
    check('1 the consent step has no setup words and names who is signed in', not FORBIDDEN.search(dlg.inner_text()) and p.locator('#consentIdentity').inner_text() == 'Signed in as Tony Walteur · tony.walteur@example.com')
    check('1 microphone not requested before the click', not p.evaluate('AtlasVoice.status().hasMicrophone'))
    talk(p, s)
    start = [f for f in s.frames if f.get('type') == 'start'][-1]
    check('1 the start frame: consultant "" and no email anywhere in it', start['project']['consultant'] == '' and '@' not in json.dumps(start))
    wait(p, lambda: s.api('POST', '/api/library'), 5); p.wait_for_timeout(2500)
    x = projects(p)[0]
    check('1 the project is created with the profile name, title and N+1', x['consultant'] == 'Tony Walteur' and x['role'] == 'Principal Consultant' and x['roleFrom'] == 'profile'
          and x['validation']['manager'] == {'name': 'Sam Lead', 'email': 'sam@example.com'} and x['validation']['managerStaff'] is False)
    check('1 the library accepted it: no "Save on this device?" prompt, the strip says "Saved to ATLAS"',
          not (p.locator('#confirmDialog').is_visible() and 'Save on this device' in p.locator('#confirmTitle').inner_text()) and p.locator('#storageStatus').text_content() == 'Saved to ATLAS')
    check('1 the end message names no device step', 'Save on this device' not in p.locator('#voiceAfter').inner_text())
    check('1 every API call carried X-Requested-With', s.log and all(e['xrw'] == 'XMLHttpRequest' for e in s.log))
    p.context.close()

    # ---- 2. Memory consent
    s = Server(memory=True, prof=profile())
    p = open_page(s); consent(p)
    txt = lambda: p.locator('#modelConsentText').inner_text()
    check('2 memory on: the one sentence names private memory; the switch offers to turn it off',
          'private memory' in txt() and 'Hindsight' in txt() and p.locator('#memoryLine').inner_text() == 'Turn off memory for my conversations' and p.locator('#memoryConsentRow').is_hidden())
    talk(p, s); wait(p, lambda: s.api('POST', '/api/memory/remember'), 5); p.wait_for_timeout(600)
    rem = s.api('POST', '/api/memory/remember')
    check('2 after the interview exactly one /api/memory/remember', len(rem) == 1)
    check('2 Hindsight gets no consultant name or profile title; the client is still sent for scrubbing',
          'Tony Walteur' not in json.dumps(rem[0]['body']) and 'Principal Consultant' not in json.dumps(rem[0]['body']) and 'client' in rem[0]['body'])
    close_dialogs(p); p.evaluate("window.ATLAS_APP.profile().lastProject=null;window.ATLAS_APP.render()")
    consent(p); p.locator('#modelConsent').check(); p.locator('#memoryLine').click(); p.wait_for_timeout(400)
    posts = s.api('POST', '/api/memory/settings')
    check('2 Turn off posts {off:true}; the sentence loses memory; the tick stays', posts and posts[-1]['body'] == {'off': True} and 'private memory' not in txt()
          and p.locator('#modelConsent').is_checked() and p.locator('#memoryLine').inner_text() == 'Turn on memory')
    p.locator('#memoryLine').click(); p.wait_for_timeout(400)
    check('2 Turn on widens the sentence, so the tick is cleared', s.api('POST', '/api/memory/settings')[-1]['body'] == {'off': False} and 'private memory' in txt()
          and not p.locator('#modelConsent').is_checked() and p.locator('#voiceConsentStart').is_disabled())
    p.locator('#memoryLine').click(); p.wait_for_timeout(400)
    n = len(s.api('POST', '/api/memory/remember')); talk(p, s); p.wait_for_timeout(1500)
    check('2 memory off for this interview: no /api/memory/remember, and the start frame says memory false',
          len(s.api('POST', '/api/memory/remember')) == n and [f for f in s.frames if f.get('type') == 'start'][-1]['memory'] is False)
    p.context.close()
    s = Server(memory=False, prof=profile())
    p = open_page(s); consent(p)
    check('2 memory not configured: no "memory" anywhere in the consent step', 'memory' not in p.locator('#voiceConsentDialog').inner_text().lower() and p.locator('#memoryLine').is_hidden())
    talk(p, s); p.wait_for_timeout(1200)
    check('2 memory not configured: no remember request', not s.api('POST', '/api/memory/remember') and not s.api('GET', '/api/memory/settings'))
    p.context.close()

    # ---- 3. Expired session
    def store(p):
        return p.evaluate("JSON.stringify({s:Object.fromEntries(Object.entries(sessionStorage)),l:Object.fromEntries(Object.entries(localStorage))})")
    s = Server(prof=profile()); s.lib_status = 401
    p = open_page(s); consent(p); talk(p, s); wait(p, lambda: s.api('POST', '/api/library'), 5); p.wait_for_timeout(1200)
    check('3 a library 401 after the interview: the banner shows and the page is not reloaded',
          p.locator('#authBanner').is_visible() and 'Your sign-in expired. Your work is kept on this page.' in p.locator('#authBanner').inner_text() and len(p.loads) == 1)
    st = store(p)
    check('3 no project content reaches sessionStorage or localStorage', 'Claims triage' not in st and 'routing design' not in st and 'Zebracorp' not in st)
    check('3 the strip says the work is only in this tab', 'Not saved to ATLAS yet · kept in this tab' in p.locator('#storageStatus').text_content())
    close_dialogs(p); s.lib_status = 201; before = len(s.api('POST', '/api/library'))
    with p.expect_popup() as pop: p.locator('#authReconnect').click()
    check('3 Reconnect opens /go/signed-in in a small window', urlparse(pop.value.url).path == '/go/signed-in')
    wait(p, lambda: len(s.api('POST', '/api/library')) > before, 8); p.wait_for_timeout(800)
    check('3 signed in again: the sync is retried, the project is saved, and the toast says so',
          len(s.api('POST', '/api/library')) == before + 1 and p.locator('#storageStatus').text_content() == 'Saved to ATLAS' and 'signed in again' in p.locator('#toast').inner_text()
          and p.locator('#authBanner').is_hidden() and len(p.loads) == 1)
    p.context.close()
    # clean page + 401 -> exactly one reload; a second 401 within 5 minutes -> the banner
    s = Server(prof=profile()); s.expire = {'/api/library/invitations'}
    p = open_page(s)
    p.evaluate("window.ATLAS_APP.libraryApi('/invitations').catch(()=>0)"); p.wait_for_timeout(1500)
    check('3 a clean page with an expired session reloads exactly once', len(p.loads) == 2 and p.locator('#authBanner').is_hidden())
    p.evaluate("window.ATLAS_APP.libraryApi('/invitations').catch(()=>0)"); p.wait_for_timeout(1200)
    check('3 a second expiry within 5 minutes shows the banner instead of reloading', len(p.loads) == 2 and p.locator('#authBanner').is_visible())
    p.context.close()
    # open-overnight tab: Start with the bootstrap answering 401 while 'preparing'
    s = Server(prof=profile()); p = open_page(s)
    s.once['/api/bootstrap'] = 1; p.locator('#voiceStart').click(); p.wait_for_timeout(1800)
    check('3 overnight tab, clean: never stuck in preparing; exactly one reload, to #start, which opens the consent step',
          len(p.loads) == 2 and p.locator('#voiceConsentDialog').is_visible() and p.evaluate('location.hash') == '' and p.evaluate('AtlasVoice.status().phase') == 'idle')
    p.context.close()
    s = Server(prof=profile()); p = open_page(s)
    p.locator('[data-action=new-project]:visible').first.click(); p.locator('#projectTitle').fill('Unsaved local project'); p.locator('#projectForm button[type=submit]').click(); p.wait_for_timeout(300)
    s.once['/api/bootstrap'] = 1; p.locator('#voiceStart').click(); p.wait_for_timeout(1500)
    check('3 overnight tab with unsaved work: phase idle, the banner, no reload', p.evaluate('AtlasVoice.status().phase') == 'idle' and p.locator('#authBanner').is_visible()
          and len(p.loads) == 1 and p.evaluate('AtlasAuth.mode') == 'expired' and not p.evaluate('AtlasVoice.status().hasMicrophone'))
    with p.expect_popup(): p.locator('#authReconnect').click()
    p.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000)
    check('3 after signing in again the interrupted Start resumes: the consent step opens', p.locator('#authBanner').is_hidden() and p.evaluate('AtlasAuth.mode') == 'live')
    # socket error before 'ready' -> check() -> 401 -> expired({resume:'start'})
    s.close_before_ready = True; s.once['/api/bootstrap'] = 1
    p.locator('#modelConsent').check(); p.locator('#voiceConsentStart').click(); p.wait_for_timeout(2000)
    check('3 socket closed before ready with an expired sign-in: idle (not error), microphone released, the banner',
          p.evaluate('AtlasVoice.status().phase') == 'idle' and not p.evaluate('AtlasVoice.status().hasMicrophone') and p.locator('#authBanner').is_visible()
          and p.evaluate('AtlasAuth.mode') == 'expired' and len(p.loads) == 1)
    s.close_before_ready = False
    with p.expect_popup(): p.locator('#authReconnect').click()
    p.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000)
    check('3 ... and the resume is "start": signing in again reopens the consent step', True)
    close_dialogs(p); p.context.close()
    # 401 while voice is active -> nothing until 'ended'
    s = Server(prof=profile()); s.auto_wrap = False; s.expire = {'/api/library/invitations'}
    p = open_page(s); consent(p); p.locator('#modelConsent').check(); p.locator('#voiceConsentStart').click()
    p.wait_for_function('()=>AtlasVoice.status().phase==="live"', timeout=8000)
    p.evaluate("window.ATLAS_APP.libraryApi('/invitations').catch(()=>0)"); p.wait_for_timeout(2000)
    check('3 expiry during a live interview: nothing shows and the conversation continues', p.locator('#authBanner').is_hidden() and p.evaluate('AtlasVoice.status().phase') == 'live'
          and p.evaluate('AtlasVoice.active()') and len(p.loads) == 1)
    s.lib_status = 401; s.sock.send(json.dumps({'type': 'wrap_up', 'message': 'done'}))
    p.wait_for_function('()=>AtlasVoice.status().phase==="idle"', timeout=10000); p.wait_for_timeout(1500)
    check('3 ... after "ended" the banner shows (the new project is not saved), with no reload', p.locator('#authBanner').is_visible() and len(p.loads) == 1)
    # popup blocked (or closed without 'ok'): the banner stays; a second failure within 5 minutes offers Backup, then Reload
    close_dialogs(p, back=False); p.evaluate('window.open=()=>null'); p.locator('#authReconnect').click(); p.wait_for_timeout(200)
    check('3 popup blocked once: the banner stays, no fallback yet', p.locator('#authBanner').is_visible() and p.locator('#authFallback').is_hidden())
    p.locator('#authReconnect').click(); p.wait_for_timeout(200)
    check('3 a second failed attempt adds "Backup, then Reload and sign in"; Reload waits for the backup',
          p.locator('#authFallback').is_visible() and 'Signing you in didn’t work.' in p.locator('#authFallback').inner_text() and p.locator('#authReload').is_disabled())
    with p.expect_download(): p.locator('#authBackup').click()
    check('3 after the backup, "Reload and sign in" is offered; nothing reloaded by itself', p.locator('#authReload').is_enabled() and len(p.loads) == 1)
    p.context.close()
    # unsaved text in the Ask box blocks the automatic reload
    s = Server(prof=profile(), features={'ask': True}); p = open_page(s)
    p.locator('header [data-view=library]').click(); p.wait_for_timeout(800)
    p.locator('#askQuestion').fill('Which claims projects did we run in Spain?')
    s.expire = {'/api/library/invitations'}; p.evaluate("window.ATLAS_APP.libraryApi('/invitations').catch(()=>0)"); p.wait_for_timeout(1500)
    check('3 unsent text in the Ask box: the banner, no reload', p.locator('#authBanner').is_visible() and len(p.loads) == 1 and p.locator('#askQuestion').input_value().startswith('Which claims'))
    p.context.close()

    # ---- 4. Local file and network
    ctx = br.new_context(viewport={'width': 1440, 'height': 1000}); NET = []
    ctx.on('request', lambda r: NET.append(r.url) if not r.url.startswith(('file:', 'data:', 'blob:')) else None); ctx.route('**/*', lambda r: r.abort() if not r.request.url.startswith('file:') else r.continue_())
    p = ctx.new_page(); p.on('pageerror', lambda e: ERR.append(str(e))); p.goto((ROOT / 'ATLAS_Voice.html').as_uri()); p.wait_for_timeout(700)
    link = p.locator('#voiceOpenHome')
    check('4 file copy: one "Open ATLAS" link to ATLAS_HOME/go/start, new tab, noopener', HOME.startswith('https://') and link.is_visible() and link.get_attribute('href') == HOME + '/go/start'
          and link.get_attribute('target') == '_blank' and 'noopener' in link.get_attribute('rel') and p.locator('#voiceStart').is_hidden() and p.locator('#voiceState').inner_text() == 'Not connected')
    p.locator('#voiceSetup').click(); p.locator('#voiceConnectionDialog').wait_for(state='visible')
    check('4 file copy: the address field stays hidden until "Use a different ATLAS address" opens', p.locator('#gatewayAddress').is_hidden() and p.locator('#offlineOpenHome').is_visible()
          and 'offline copy of ATLAS' in p.locator('#connectionSummary').inner_text())
    p.locator('#gatewayAdvanced > summary').click()
    check('4 file copy: the disclosure reveals the address form', p.locator('#gatewayAddress').is_visible())
    check('4 file copy: no network request', not NET)
    ctx.close()
    s = Server(prof=profile()); s.boot_status = 522; p = open_page(s)
    check('4 live origin, bootstrap 522: "ATLAS isn\'t answering", Try again, never "Open ATLAS"', p.evaluate('AtlasAuth.mode') == 'network' and p.locator('#voiceNetwork').is_visible()
          and p.locator('#voiceRetry').is_visible() and p.locator('#voiceOpenHome').is_hidden() and p.locator('#voiceStart').is_hidden() and p.locator('#voiceState').inner_text() == 'Not reachable')
    s.boot_status = 200; p.locator('#voiceRetry').click(); p.wait_for_timeout(700)
    check('4 Try again once ATLAS answers: Start and "Ready"', p.locator('#voiceStart').is_visible() and p.locator('#voiceState').inner_text() == 'Ready' and p.locator('#voiceNetwork').is_hidden())
    p.context.close()

    # ---- 5. #start
    s = Server(prof=profile()); p = open_page(s, 'https://atlas.test/#start')
    p.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000)
    check('5 #start opens the consent step on load; the microphone stays off; the hash is cleared', not p.evaluate('AtlasVoice.status().hasMicrophone') and p.evaluate('location.hash') == '')
    p.locator('#modelConsent').check(); p.locator('#voiceConsentStart').click(); p.wait_for_function('()=>AtlasVoice.status().hasMicrophone', timeout=8000)
    check('5 the microphone opens only after the Start click', True)
    p.context.close()

    # ---- 6. Returning user
    s = Server(prof=profile()); p = open_page(s); consent(p); talk(p, s); wait(p, lambda: s.records, 5); p.wait_for_timeout(800)
    R = list(s.records)[0]; p.context.close()
    p = open_page(s); p.wait_for_timeout(800)
    x = projects(p)
    check('6 a reload with an empty workspace rebuilds it from the library, linked to the record',
          len(x) == 1 and x[0]['library']['id'] == R and x[0]['title'] == 'Claims triage rebuilt' and x[0]['roleFrom'] == 'profile' and 'back from ATLAS' in p.locator('#toast').inner_text()
          and s.api('GET', '/api/library') and s.api('GET', '/api/library')[0]['q'].get('mine') == ['1'])
    p.locator('header [data-view=projects]').click(); p.wait_for_timeout(300)
    check('6 the restored project is listed in Projects', 'Claims triage rebuilt' in p.locator('#projectCards').inner_text())
    p.locator('#projectCards [data-project]').first.click(); p.locator('header [data-view=interview]').click(); p.wait_for_timeout(300)
    n = len(s.api('POST', '/api/library')); consent(p); talk(p, s); wait(p, lambda: len(s.api('POST', '/api/library')) > n, 5)
    start = [f for f in s.frames if f.get('type') == 'start'][-1]
    check('6 the follow-up interview: model-safe context (no name; the profile title is not sent)', start['project']['id'] == x[0]['id'] and start['project']['consultant'] == '' and start['project']['role'] == '')
    check('6 the follow-up updates the same record: the POST carries id R, and no second record exists', s.api('POST', '/api/library')[-1]['body']['id'] == R and len(s.records) == 1)
    close_dialogs(p); p.context.close()

    # ---- 7. Gap mode
    GAP = 'b' * 32
    s = Server(prof=profile(), features={'gapInterview': True}); s.ws_mode = 'gap'; s.gap_id = GAP
    p = open_page(s)
    p.evaluate(f"window.ATLAS_APP.startFromGap({{id:'{GAP}',bidAlias:'Heron bid'}})")
    p.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000)
    check('7 a proof request opens the consent step itself (live), naming the request', '5-minute proof request for Heron bid' in p.locator('#providerConsentText').inner_text())
    talk(p, s); p.wait_for_timeout(2500)
    check('7 gap mode: the start frame carries the request', [f for f in s.frames if f.get('type') == 'start'][-1].get('gap') == GAP)
    check('7 gap answers stay here: strip "Not saved to ATLAS yet · kept in this tab", the device prompt, no library POST',
          'Not saved to ATLAS yet · kept in this tab' in p.locator('#storageStatus').text_content() and p.locator('#confirmDialog').is_visible()
          and 'Save on this device' in p.locator('#confirmTitle').inner_text() and not s.api('POST', '/api/library'))
    close_dialogs(p); p.context.close()

    # ---- 8. Guessed name
    s = Server(prof=profile(name=('Tony Walteur', 'guess'), title=None, manager=None, first='', guessed=True))
    p = open_page(s); consent(p)
    check('8 a guess is not reliable: no first name in the heading, only the email in the footer',
          p.locator('#voiceConsentTitle').inner_text() == 'A conversation with ATLAS.' and p.locator('#consentIdentity').inner_text() == 'Signed in as tony.walteur@example.com')
    talk(p, s); wait(p, lambda: s.api('POST', '/api/library'), 5); p.wait_for_timeout(600)
    check('8 with only a guess the new project\'s consultant is "Consultant"', projects(p)[0]['consultant'] == 'Consultant' and s.api('POST', '/api/library')[-1]['body']['reference']['consultant']['name'] == 'Consultant')
    close_dialogs(p)
    check('8 the end message asks "Is your name …?"', 'Is your name Tony Walteur?' in p.locator('#voiceAfter').inner_text())
    n = len(s.api('POST', '/api/library')); p.locator('#voiceAfter .guess-prompt button').first.click()
    wait(p, lambda: len(s.api('POST', '/api/library')) > n, 5); p.wait_for_timeout(300)
    check('8 "Yes, that\'s me" posts {confirmGuess:true}, then the project is updated and synced again',
          s.api('POST', '/api/library/profile')[-1]['body'] == {'confirmGuess': True} and projects(p)[0]['consultant'] == 'Tony Walteur'
          and s.api('POST', '/api/library')[-1]['body']['reference']['consultant']['name'] == 'Tony Walteur' and 'Thanks, Tony.' in p.locator('#voiceAfter').inner_text())
    p.evaluate("(()=>{const A=window.ATLAS_APP,x=AtlasEngine.project({title:'Legacy project',consultant:'tony.walteur@example.com'});A.profile().projects.push(x);A.save();})()")
    p.locator('header [data-view=projects]').click(); p.wait_for_timeout(600); n = len(s.api('POST', '/api/library')); p.locator('#storageRetry').click(); wait(p, lambda: len(s.api('POST', '/api/library')) > n, 5); p.wait_for_timeout(300)
    leg = [b for b in s.api('POST', '/api/library') if b['body']['reference']['title'] == 'Legacy project']
    check('8 a legacy project whose consultant is an email: the next sync sends the profile name, logged',
          leg and leg[-1]['body']['reference']['consultant']['name'] == 'Tony Walteur' and any('Consultant name replaced: it was an email address' in a['message'] for a in projects(p)[-1]['audit']))
    p.context.close()

    # ---- 9. Profile prefill, edit and provenance
    for w in (1440, 320):
        s = Server(prof=profile(title=('Principal Consultant', 'dna_export', '2026-08-15T09:00:00Z', {'value': 'Director', 'from': 'dna'}), manager=(('Sam Lead', 'you'), ('sam@example.com', 'you'))))
        p = open_page(s, w=w); role, role_chip = ('Head of Data', 'you edited') if w == 1440 else ('Principal Consultant', 'from the DNA export (2026-08-15)')
        check(f'9 [{w}px] the avatar shows the profile initials', p.locator('#profileButton').inner_text() == 'TW')
        p.locator('#profileButton').click(); p.locator('#profileSection').wait_for(state='visible', timeout=5000)
        chip = lambda k: p.locator(f'[data-pf-chip="{k}"]').inner_text()
        check(f'9 [{w}px] the profile shows each value with its source', chip('name') == 'from DNA' and chip('title') == 'from the DNA export (2026-08-15)' and chip('managerName') == 'you edited'
              and p.locator('#pf_email').get_attribute('readonly') is not None and 'DNA now says Director.' in p.locator('#profileSection').inner_text())
        check(f'9 [{w}px] no horizontal overflow with the profile open', p.evaluate('document.documentElement.scrollWidth<=innerWidth'))
        if w == 1440:
            p.locator('#pf_title').fill('Head of Data')
            check('9 editing a value relabels it "you edited" before saving', chip('title') == 'you edited')
            p.locator('#pfSave').click(); p.wait_for_timeout(500)
            check('9 Save posts only the change {set:{title}}, and the chip stays "you edited"', s.api('POST', '/api/library/profile')[-1]['body'] == {'set': {'title': 'Head of Data'}} and chip('title') == 'you edited')
        close_dialogs(p)
        p.locator('[data-action=new-project]:visible').first.click(); p.locator('#projectDialog').wait_for(state='visible')
        fchip = lambda i: p.locator(f'[data-chip="{i}"]').inner_text()
        check(f'9 [{w}px] the new-project form is prefilled from the profile, with chips; managerStaff unticked',
              p.locator('#consultantName').input_value() == 'Tony Walteur' and fchip('consultantName') == 'from DNA' and p.locator('#consultantRole').input_value() == role
              and fchip('consultantRole') == role_chip and p.locator('#n1Name').input_value() == 'Sam Lead' and p.locator('#n1Email').input_value() == 'sam@example.com'
              and p.locator('#projectPrefillNote').is_visible() and p.locator('#roleHint').is_visible() and not p.locator('#managerStaff').is_checked())
        check(f'9 [{w}px] no horizontal overflow with the project form open', p.evaluate('document.documentElement.scrollWidth<=innerWidth'))
        if w == 1440:
            p.locator('#consultantRole').fill('Data engineer')
            check('9 a different role reads "you edited" and the hint goes', fchip('consultantRole') == 'you edited' and p.locator('#roleHint').is_hidden())
            p.locator('#projectTitle').fill('Prefilled project'); p.locator('#projectForm button[type=submit]').click(); p.wait_for_timeout(300)
            x = projects(p)[0]
            check('9 the saved project keeps roleFrom "you" for a typed role', x['roleFrom'] == 'you' and x['consultant'] == 'Tony Walteur' and x['validation']['managerStaff'] is False)
        p.context.close()

    # ---- §5.8: the N+1 name from a typed N+1 email (GET /people: stored directory rows only), shown with its source.
    # ATLAS's own name (prefill or lookup) follows the email; a name you typed, or an edited project's stored name, never changes
    def n1_form(s):
        p = open_page(s); p.locator('[data-action=new-project]:visible').first.click(); p.locator('#projectDialog').wait_for(state='visible'); return p
    def n1_email(p, v, settle=400):
        p.locator('#n1Email').fill(v); p.locator('#n1Email').press('Tab'); p.wait_for_timeout(settle)
    s = Server(prof=profile(manager=None)); p = n1_form(s)
    looks = lambda: [x['q'].get('email', [''])[0] for x in s.api('GET', '/api/library/people')]
    fchip = lambda i: p.locator(f'[data-chip="{i}"]').inner_text() if p.locator(f'[data-chip="{i}"]').is_visible() else ''
    check('5.8 no profile N+1: the N+1 fields start empty', p.locator('#n1Name').input_value() == '' and p.locator('#n1Email').input_value() == '')
    n1_email(p, 'jane@exam')
    check('5.8 an incomplete email is never looked up', looks() == [] and p.locator('#n1Name').input_value() == '')
    n1_email(p, 'Jane@Example.com', 0); wait(p, lambda: p.locator('#n1Name').input_value() != '', 5)
    check('5.8 a typed N+1 email fills the empty N+1 name from the directory, with its source chip',
          p.locator('#n1Name').input_value() == 'Jane Doe' and fchip('n1Name') == 'from the DNA export' and looks() == ['jane@example.com'])
    n1_email(p, 'bob@example.com', 0); wait(p, lambda: p.locator('#n1Name').input_value() == 'Bob Stone', 5)
    check('5.8 a name the lookup filled follows the email', p.locator('#n1Name').input_value() == 'Bob Stone' and fchip('n1Name') == 'from DNA')
    n1_email(p, 'nobody@example.com')
    check('5.8 not in the directory: the looked-up name of the old email goes, nothing is guessed', p.locator('#n1Name').input_value() == '' and fchip('n1Name') == '')
    p.locator('#n1Name').fill('Janet D.'); n1_email(p, 'jane@example.com')
    check('5.8 a name you typed is never overwritten', p.locator('#n1Name').input_value() == 'Janet D.' and fchip('n1Name') == 'you edited')
    p.locator('#n1Name').fill(''); n1_email(p, 'bob@example.com', 0); wait(p, lambda: p.locator('#n1Name').input_value() == 'Bob Stone', 5)
    check('5.8 a found email is not looked up again (30 lookups an hour)', looks() == ['jane@example.com', 'bob@example.com', 'nobody@example.com'])
    p.locator('#projectTitle').fill('N+1 from the directory'); p.locator('#projectForm button[type=submit]').click(); p.wait_for_timeout(300)
    check('5.8 the project keeps the looked-up N+1; no provenance is stored', projects(p)[0]['validation']['manager'] == {'name': 'Bob Stone', 'email': 'bob@example.com'})
    p.locator('header [data-view=projects]').click(); p.locator('#projectDetail [data-action=edit-project]').click(); p.locator('#projectDialog').wait_for(state='visible')
    n1_email(p, 'jane@example.com')
    check("5.8 editing a project: its stored N+1 name is never replaced", p.locator('#n1Name').input_value() == 'Bob Stone' and len(looks()) == 3)
    p.context.close()
    s = Server(prof=profile()); p = n1_form(s)  # the profile's N+1: Sam Lead, sam@example.com, from DNA
    n1_email(p, 'jane@example.com', 0); wait(p, lambda: p.locator('#n1Name').input_value() == 'Jane Doe', 5)
    check('5.8 a prefilled N+1 name follows a new N+1 email', p.locator('#n1Name').input_value() == 'Jane Doe' and fchip('n1Name') == 'from the DNA export')
    n1_email(p, 'sam@example.com')
    check("5.8 back to the profile's N+1 email: its name and chip return, with no lookup", p.locator('#n1Name').input_value() == 'Sam Lead' and fchip('n1Name') == 'from DNA'
          and looks() == ['jane@example.com'])
    p.context.close()
    s = Server(prof=None); p = n1_form(s)
    n1_email(p, 'jane@example.com')
    check('5.8 without the profile feature there is no lookup', not s.api('GET', '/api/library/people') and p.locator('#n1Name').input_value() == '')
    p.context.close()

    # ---- admin people directory: only the approved columns leave the browser (§5.6)
    s = Server(prof=profile(), role='admin'); s.dir_rows = 2
    p = open_page(s)
    p.evaluate("document.getElementById('openInsights').click()"); p.locator('#peopleDirectory').get_by_text('only synthetic addresses').wait_for(state='visible', timeout=5000)
    check('directory: test mode says synthetic addresses only, and names what DNA pull and push need',
          'only synthetic addresses' in p.locator('#peopleDirectory').inner_text() and 'DNA push: not connected' in p.locator('#peopleDirectory').inner_text())
    csv = 'Email;Nom complet;Poste;Responsable;Mail responsable;Salaire;Date de naissance;Site\njane@example.com;Jane Doe;Data lead;Sam Lead;sam@example.com;85000;1980-02-03;Lyon\nbad-row;Nobody;;;;90000;1970-01-01;Paris\n'
    p.locator('#dirFile').set_input_files(files=[{'name': 'dna.csv', 'mimeType': 'text/csv', 'buffer': csv.encode()}]); p.wait_for_timeout(300)
    check('directory: columns suggested for the approved fields; the replace count shown first', p.locator('#dirCol_email').input_value() == '0' and 'This replaces 2 rows with 1.' in p.locator('#dirMap').inner_text())
    p.locator('#dirShrink').check(); p.locator('#dirMap button.btn.primary').click(); p.wait_for_timeout(600)
    imp = s.api('POST', '/api/library/directory/import')
    body = json.dumps(imp[0]['body']) if imp else ''
    check('directory: the upload carries only approved keys, never salary, birth date or site', imp and imp[0]['body']['rows'] == [{'email': 'jane@example.com', 'name': 'Jane Doe', 'title': 'Data lead', 'managerName': 'Sam Lead', 'managerEmail': 'sam@example.com'}]
          and all(v not in body for v in ('85000', '1980-02-03', 'Lyon', 'Salaire', 'Paris')) and imp[0]['body']['final'] is True and imp[0]['body'].get('confirmShrink') is True
          and re.fullmatch(r'[a-f0-9]{32}', imp[0]['body']['batch']))
    check('directory: the result counts rows and names skipped rows by number only', p.locator('#dirStatus').inner_text() == '1 people imported · 1 rows skipped (rows 3: no valid email)')
    p.context.close()
    br.close()
if ERR: print('\n'.join(ERR))
check('no page errors', not ERR)
