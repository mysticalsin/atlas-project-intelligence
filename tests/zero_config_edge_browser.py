"""Zero-setup start and the profile, end to end against the local edge (docs/WOW_ZERO_CONFIG.md §9, harness (c)): the real
Worker handle(), the real LibraryStore routes with profile.js on node:sqlite, the stand-in model and Hindsight
(dev/local-edge.mjs). The voice WebSocket is answered in the browser (the local edge serves no WebSocket), so the interview
is a scripted stand-in; everything else is the real server. Users are switched with ?as=. Loopback only: no provider, no
network, no DNA (it stays BLOCKED_EXTERNAL), no real HR data (test mode accepts synthetic addresses only).
  python3 build.py && python3 deploy/cloudflare-edge/build_edge.py && python3 tests/zero_config_edge_browser.py
Flow: /go/ links and page redirects -> an admin imports a DNA export CSV with extra columns (only approved keys leave the
browser; a real-domain row is refused in test mode) -> Jane, a fresh signed-in user, presses Start, ticks one box and talks:
the project is created after the interview, prefilled from her profile, with no setup form anywhere -> Jane edits her title
(it survives a reload; "you edited") -> the next export changes her title ("DNA now says ...") -> another user cannot read
Jane's profile; the people lookup gives name and title only -> the session expires with unsaved work: the banner, no reload,
nothing in browser storage; Reconnect signs in again and the work is saved -> a saved file shows one "Open ATLAS" link ->
DATA_MODE=production without secrets: DNA pull and push stay BLOCKED_EXTERNAL.
"""
import json, os, re, socket, subprocess, sys, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy/cloudflare-edge'
PAGE = EDGE / 'src/atlas.html'
ERR, PROCS = [], []
ID = 'ab' * 16
FORBIDDEN = re.compile(r'gateway|localhost|GPU|\.env|NVIDIA|address', re.I)
REP = {'headline': 'Claims triage rebuilt', 'summary': 'The consultant rebuilt claims triage for the client.', 'topics': {'context': 'Tickets bounced between teams.'},
       'highlights': [], 'gaps': ['No named source'], 'follow_ups': [], 'status': 'model_draft'}
CSV = ('Email;Nom complet;Prénom;Poste;Responsable;Mail responsable;Salaire;Date de naissance;Site\n'
       'jane@example.com;Jane Doe;Jane;Data lead;Sam Lead;sam@example.com;85000;1980-02-03;Lyon\n'
       'bob@mantu.com;Bob Real;Bob;Engineer;Sam Lead;sam@example.com;90000;1970-01-01;Paris\n'
       'lee@example.org;Lee Test;Lee;Analyst;Sam Lead;sam@example.com;70000;1990-05-06;Nantes\n')


def check(n, v):
    print(('PASS ' if v else 'FAIL ') + n, flush=True)
    assert v, n


def start_edge(extra=None):
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
    env = {k: v for k, v in os.environ.items() if k not in ('DATA_MODE', 'DIRECTORY_PUSH_SECRET') and not k.startswith('DNA_')}
    proc = subprocess.Popen(['node', '--no-warnings', 'dev/local-edge.mjs', str(port)], cwd=EDGE, env={**env, **(extra or {})}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    PROCS.append(proc)
    base = f'http://127.0.0.1:{port}'
    for _ in range(100):
        try: urllib.request.urlopen(base + '/__settle', timeout=1); break
        except Exception: time.sleep(.1)
    return base


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None


RAW = urllib.request.build_opener(NoRedirect)


def get(base, path, who='jane@example.com', headers=None):
    sep = '&' if '?' in path else '?'
    req = urllib.request.Request(base + path + sep + 'as=' + who, headers=headers or {})
    try: r = RAW.open(req, timeout=10); return r.status, r.headers, r.read().decode()  # headers: case-insensitive
    except urllib.error.HTTPError as e: return e.code, e.headers, e.read().decode()


def wait(p, cond, timeout=8):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if cond(): return True
        p.wait_for_timeout(100)
    return cond()


class Voice:
    """The scripted stand-in for the voice WebSocket (the local edge answers every other request)."""
    def __init__(s): s.frames = []; s.auto_wrap = True; s.sock = None

    def __call__(s, ws):
        s.sock = ws
        def on(m):
            if isinstance(m, bytes): return
            d = json.loads(m); s.frames.append(d)
            if d.get('type') == 'start':
                ws.send(json.dumps({'type': 'ready', 'mode': 'full', 'model': 'ATLAS', 'provider': 'ATLAS voice', 'sampleRate': 24000, 'capture': True, 'liveLedger': False,
                                    'maxSeconds': 900, 'speakingSeconds': 600, 'message': 'ready'}))
                ws.send(json.dumps({'type': 'agent_text', 'text': "Hi, I'm ATLAS."}))
                if s.auto_wrap: ws.send(json.dumps({'type': 'wrap_up', 'message': 'done'}))
            if d.get('type') == 'end':
                notes = {'type': 'notes', 'transcript': 'I owned the routing design at Zebracorp.', 'sections': ['I owned the routing design.', '', '', '', '', ''],
                         'status': 'candidate', 'report': REP, 'message': 'm'}
                for e in [{'type': 'audio_stopped'}, {'type': 'reporting'}, notes, {'type': 'ended', 'message': 'closed'}]: ws.send(json.dumps(e))
        ws.on_message(on)


if not PAGE.exists() or 'AtlasAuth' not in PAGE.read_text():
    print('NOT RUNNABLE: deploy/cloudflare-edge/src/atlas.html is missing or older than the zero-config page. Run: python3 build.py && python3 deploy/cloudflare-edge/build_edge.py')
    sys.exit(2)
HOME = json.loads(re.search(r'<script>window\.ATLAS_HOME=("[^"<]*");</script>', (ROOT / 'ATLAS_Voice.html').read_text()).group(1))
code = 0
try:
    BASE = start_edge({'EXTERNAL_EMAILS': 'ann@client.example'})
    boot = json.loads(get(BASE, '/api/bootstrap')[2])
    if boot.get('features', {}).get('profile') is not True:
        print('NOT RUNNABLE: features.profile is false (profile.READY). This suite is the acceptance test that flips it.'); sys.exit(2)

    # ---- /go/ links and page redirects (§3.9), through the real Worker
    loc = lambda path, who='jane@example.com', h=None: (lambda r: (r[0], r[1].get('Location')))(get(BASE, path, who, h))
    check('/go/start -> /#start', loc('/go/start') == (302, '/#start'))
    check('/go/{gap,invitation,bid,library}/<id> -> /#<kind>/<id>', all(loc(f'/go/{k}/{ID}') == (302, f'/#{k}/{ID}') for k in ('gap', 'invitation', 'bid', 'library')))
    check('/go/confirm/<id> -> /confirm#<id>, for a user and for an external confirmer',
          loc(f'/go/confirm/{ID}') == (302, f'/confirm#{ID}') and loc(f'/go/confirm/{ID}', 'ann@client.example') == (302, f'/confirm#{ID}'))
    check('an external confirmer gets 403 on any other /go/ link', loc(f'/go/gap/{ID}', 'ann@client.example')[0] == 403)
    check('a bad /go/ path or a non-hex id goes home', loc('/go/x') == (302, '/') and loc('/go/gap/NOT-HEX') == (302, '/') and loc('/go/gap/' + 'a' * 31) == (302, '/'))
    st, _, body = get(BASE, '/go/signed-in')
    check('/go/signed-in: a tiny page that tells the other tab, with no token and no email', st == 200 and "BroadcastChannel('atlas-auth')" in body and '@' not in body and 'jwt' not in body.lower())
    check('a page navigation to an old path goes home; a non-navigation stays a JSON 404; /api/wiki stays 404',
          loc('/ATLAS_Voice.html', h={'Accept': 'text/html'}) == (302, '/') and loc('/index.html', h={'Sec-Fetch-Mode': 'navigate'}) == (302, '/')
          and get(BASE, '/ATLAS_Voice.html')[0] == 404 and get(BASE, '/api/wiki', headers={'Accept': 'text/html'})[0] == 404)
    check('test mode: the banner stays and readiness says so', boot['readiness'] == 'edge-deployment-test-data-only' and 'TEST DEPLOYMENT · SYNTHETIC DATA ONLY' in get(BASE, '/')[2])
    # D1 is the SPOKEN_ASK_APPROVED code constant (features.test.js pins its value); this check holds either way.
    approved = 'export const SPOKEN_ASK_APPROVED = true;' in (EDGE / 'src/features.js').read_text()
    def transcribe(headers):
        req = urllib.request.Request(BASE + '/api/transcribe?as=jane@example.com', data=b'\0' * 9600, method='POST',
                                     headers={'Content-Type': 'audio/L16;rate=24000', 'Origin': BASE, 'X-Atlas-CSRF': boot['csrf'], **headers})
        try: r = RAW.open(req, timeout=10); return r.status, r.read().decode()
        except urllib.error.HTTPError as e: return e.code, e.read().decode()
    no_consent = transcribe({})
    if approved:
        check('spoken Ask follows Ask once D1 is approved, and every recording needs the consent header (403 without it)',
              boot['features'].get('spokenAsk') is boot['features'].get('ask') is True and no_consent[0] == 403 and 'consent' in no_consent[1])
    else:
        check('spoken Ask stays off until D1 is approved: absent from features, /api/transcribe 404', boot['features'].get('spokenAsk') is False and no_consent[0] == 404)

    with sync_playwright() as pw:
        br = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None,
                                args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])

        def open_page(who, path='/', base=None, voice=None, w=1440):
            ctx = br.new_context(permissions=['microphone'], viewport={'width': w, 'height': 1000}, accept_downloads=True)
            p = ctx.new_page(); p.on('pageerror', lambda e: ERR.append(who + ': ' + str(e)))
            p.loads = []; p.on('load', lambda _: p.loads.append(1))
            p.bodies = []; p.on('request', lambda r: p.bodies.append((r.method, urlparse(r.url).path, r.post_data or '', r.headers.get('x-requested-with'))) if '/api/' in r.url else None)
            p.voice = voice or Voice(); p.route_web_socket('**/api/voice', p.voice)
            h = path.split('#', 1); sep = '&' if '?' in h[0] else '?'
            p.goto((base or BASE) + h[0] + sep + 'as=' + who + ('#' + h[1] if len(h) > 1 else '')); p.wait_for_timeout(900)
            return p

        def api(p, path, method='GET', body=None):
            return p.evaluate("([p,o])=>window.ATLAS_APP.libraryApi(p,o||{})", [path, {'method': method, **({'body': body} if body is not None else {})}])

        def talk(p):
            n = len(p.voice.frames)
            p.locator('#modelConsent').check(); p.locator('#voiceConsentStart').click()
            wait(p, lambda: any(f.get('type') == 'end' for f in p.voice.frames[n:]), 15)
            p.wait_for_function('()=>AtlasVoice.status().phase==="idle"', timeout=8000)

        def close_dialogs(p):
            p.evaluate("for(const d of document.querySelectorAll('dialog[open]'))d.close()")

        def import_csv(p, text, name='dna.csv'):
            p.evaluate("document.getElementById('openInsights').click()"); p.locator('#peopleDirectory').wait_for(state='visible', timeout=8000)
            p.locator('#dirFile').wait_for(state='visible', timeout=8000)
            p.locator('#dirFile').set_input_files(files=[{'name': name, 'mimeType': 'text/csv', 'buffer': text.encode()}]); p.wait_for_timeout(300)
            n = len(p.bodies); p.locator('#dirMap button.btn.primary').click()
            wait(p, lambda: 'people imported' in p.locator('#dirStatus').inner_text(), 8)
            return [json.loads(b) for m, path, b, _ in p.bodies[n:] if m == 'POST' and path == '/api/library/directory/import']

        # ---- the admin imports a DNA export (test mode: synthetic addresses only; only approved columns leave the browser)
        adm = open_page('tony.walteur@gmail.com')
        pd = adm.locator('#peopleDirectory')
        sent = import_csv(adm, CSV)
        txt = pd.inner_text()
        check('directory (test mode): the admin view says synthetic addresses only; DNA push and pull are not connected',
              'only synthetic addresses' in txt and 'DNA push: not connected' in txt and 'DNA pull: not connected' in txt)
        rows = [r for b in sent for r in b['rows']]
        blob = json.dumps(sent)
        check('directory: the upload carries only the approved keys, never salary, birth date or site',
              sent and all(set(r) <= {'email', 'name', 'givenName', 'title', 'managerName', 'managerEmail'} for r in rows)
              and not any(v in blob for v in ('85000', '1980-02-03', 'Lyon', 'Salaire', 'Nantes', 'Paris')))
        check('directory: test mode imports jane@example.com and lee@example.org and refuses bob@mantu.com, by row number only',
              adm.locator('#dirStatus').inner_text() == '2 people imported · 1 rows skipped (rows 3: this test deployment accepts synthetic addresses only)')
        dstat = api(adm, '/directory')
        check('directory API: test mode, 2 DNA-export rows, DNA pull and push BLOCKED_EXTERNAL',
              dstat['dataMode'] == 'test' and dstat['rows'] == {'dna': 0, 'dna_export': 2}
              and dstat['sources']['pull']['status'] == 'BLOCKED_EXTERNAL' and dstat['sources']['push']['status'] == 'BLOCKED_EXTERNAL')
        close_dialogs(adm)

        # ---- a fresh signed-in user: Start -> one tick -> interview; the project is created and prefilled; no setup anywhere
        jane = open_page('jane@example.com')
        check('fresh user: the pill reads "Ready"; no setup text in the conversation view; no address form, setup card or setup note',
              jane.locator('#voiceState').inner_text() == 'Ready' and not FORBIDDEN.search(jane.locator('#interview').inner_text())
              and jane.locator('#gatewayOpenBox').is_hidden() and jane.locator('#cardConnection').is_hidden() and jane.locator('#emptyVoiceNote').is_hidden()
              and jane.locator('#voiceOpenHome').is_hidden() and jane.evaluate('AtlasAuth.mode') == 'live')
        check('fresh user: no project yet', jane.evaluate('window.ATLAS_LOCAL.snapshot().profiles[0].projects.length') == 0)
        jane.locator('#voiceStart').click(); jane.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000)
        dlg = jane.locator('#voiceConsentDialog')
        check('Start opens the consent step at once: exactly one checkbox, the first name from the DNA export in the heading, the sign-in in the footer',
              dlg.locator('input[type=checkbox]:visible').count() == 1 and jane.locator('#voiceConsentTitle').inner_text() == 'Ready when you are, Jane.'
              and jane.locator('#consentIdentity').inner_text() == 'Signed in as Jane Doe · jane@example.com' and not FORBIDDEN.search(dlg.inner_text()))
        check('memory is configured here, so the one sentence names it', 'private memory' in jane.locator('#modelConsentText').inner_text())
        check('the microphone is not requested before the Start click', not jane.evaluate('AtlasVoice.status().hasMicrophone'))
        talk(jane)
        start = [f for f in jane.voice.frames if f.get('type') == 'start'][-1]
        check('the start frame carries no name and no email: consultant "", the profile title not sent', start['project']['consultant'] == '' and start['project'].get('role', '') == ''
              and '@' not in json.dumps(start) and 'Jane' not in json.dumps(start))
        wait(jane, lambda: jane.locator('#storageStatus').text_content() == 'Saved to ATLAS', 10)
        x = jane.evaluate('window.ATLAS_LOCAL.snapshot().profiles[0].projects')
        check('the project is created after the interview, prefilled from the profile: name, title (roleFrom profile), N+1; managerStaff unticked',
              len(x) == 1 and x[0]['consultant'] == 'Jane Doe' and x[0]['role'] == 'Data lead' and x[0]['roleFrom'] == 'profile'
              and x[0]['validation']['manager'] == {'name': 'Sam Lead', 'email': 'sam@example.com'} and x[0]['validation']['managerStaff'] is False)
        rid = x[0]['library']['id']
        rec = api(jane, '/' + rid)
        check('saved to the real library: "Saved to ATLAS", the record holds the profile values, no device prompt',
              jane.locator('#storageStatus').text_content() == 'Saved to ATLAS' and rec['data']['consultant']['name'] == 'Jane Doe'
              and rec['data']['validation']['manager']['email'] == 'sam@example.com'
              and not (jane.locator('#confirmDialog').is_visible() and 'Save on this device' in jane.locator('#confirmTitle').inner_text()))
        check('no setup form was shown at any point', jane.locator('#voiceConnectionDialog').is_hidden() and jane.locator('#gatewayAddress').is_hidden())
        mem = jane.evaluate("fetch('/api/memory').then(r=>r.json())")
        check('the private memory holds the conversation (Hindsight stand-in), without the name or the title', len(mem.get('documents') or []) >= 1
              and 'Jane Doe' not in json.dumps(mem) and 'Data lead' not in json.dumps(mem))
        check('every API call from the page carried X-Requested-With', all(x == 'XMLHttpRequest' for m, path, b, x in jane.bodies if path.startswith('/api/') and path != '/api/memory'))
        jane.locator('#reportDialog').wait_for(state='visible', timeout=8000)  # the report opens by itself after an interview
        close_dialogs(jane)

        # ---- profile: provenance chips, an edit that survives a reload
        jane.locator('#profileButton').click(); jane.locator('#profileSection').wait_for(state='visible', timeout=8000)
        chip = lambda p, k: p.locator(f'[data-pf-chip="{k}"]').inner_text()
        exp = re.compile(r'^from the DNA export \(\d{4}-\d{2}-\d{2}\)$')
        check('profile: each value names its source ("from the DNA export (date)"); the email is read-only',
              all(exp.match(chip(jane, k)) for k in ('name', 'preferredName', 'title', 'managerName', 'managerEmail')) and jane.locator('#pf_email').get_attribute('readonly') is not None
              and jane.locator('#profileButton').inner_text() == 'JD')
        jane.locator('#pf_title').fill('Head of Data')
        check('editing relabels the value "you edited" before saving', chip(jane, 'title') == 'you edited')
        n = len(jane.bodies); jane.locator('#pfSave').click(); jane.wait_for_timeout(700)
        saved = [json.loads(b) for m, path, b, _ in jane.bodies[n:] if m == 'POST' and path == '/api/library/profile']
        check('Save posts only the change', saved == [{'set': {'title': 'Head of Data'}}] and chip(jane, 'title') == 'you edited')
        jane.context.close()
        jane = open_page('jane@example.com')
        jane.locator('#profileButton').click(); jane.locator('#profileSection').wait_for(state='visible', timeout=8000)
        check('the edit survives a reload (stored on the server, not in the browser)', jane.locator('#pf_title').input_value() == 'Head of Data' and chip(jane, 'title') == 'you edited'
              and 'Head of Data' not in jane.evaluate("JSON.stringify({...localStorage,...sessionStorage})"))
        close_dialogs(jane)
        jane.locator('header [data-view=projects]').click(); jane.wait_for_timeout(300)
        jane.locator('[data-action=new-project]:visible').first.click(); jane.locator('#projectDialog').wait_for(state='visible')
        fchip = lambda i: jane.locator(f'[data-chip="{i}"]').inner_text()
        check('the new-project form is prefilled from the profile with chips; the edited title reads "you edited"',
              jane.locator('#consultantName').input_value() == 'Jane Doe' and exp.match(fchip('consultantName')) and jane.locator('#consultantRole').input_value() == 'Head of Data'
              and fchip('consultantRole') == 'you edited' and jane.locator('#n1Email').input_value() == 'sam@example.com' and not jane.locator('#managerStaff').is_checked())
        close_dialogs(jane)

        # ---- the next export changes Jane's title: "DNA now says ..." (her edit wins until she chooses)
        sent = import_csv(adm, CSV.replace(';Data lead;', ';Principal Data Lead;'))
        check('a second export replaces the rows (same count, no shrink confirmation)', adm.locator('#dirStatus').inner_text().startswith('2 people imported') and not any(b.get('confirmShrink') for b in sent))
        jane.reload(); jane.wait_for_timeout(900)
        jane.locator('#profileButton').click(); jane.locator('#profileSection').wait_for(state='visible', timeout=8000)
        check('the edit still wins, and the newer DNA value is offered', jane.locator('#pf_title').input_value() == 'Head of Data'
              and 'DNA now says Principal Data Lead.' in jane.locator('#profileSection').inner_text())
        close_dialogs(jane)

        # ---- another user cannot read Jane's profile; the people lookup gives name and title only
        lee = open_page('lee@example.org')
        mine = api(lee, '/profile')
        check('another user reads only their own profile', mine['email'] == 'lee@example.org' and 'Jane' not in json.dumps(mine) and 'Head of Data' not in json.dumps(mine)
              and api(lee, '/profile?email=jane@example.com')['email'] == 'lee@example.org')
        who = api(lee, '/people?email=jane@example.com')
        check('the people lookup: exactly {email, name, title, from} from the directory row, never the N+1 and never her own edits',
              who == {'email': 'jane@example.com', 'name': 'Jane Doe', 'title': 'Principal Data Lead', 'from': 'dna_export'})
        miss = lee.evaluate("fetch('/api/library/people?email=bob@mantu.com',{headers:{'X-Requested-With':'XMLHttpRequest'}}).then(r=>r.status)")
        check('the refused real-domain row was never stored: the lookup answers 404', miss == 404)
        lee.context.close()

        # ---- the session expires with unsaved work: the banner, no reload, nothing in browser storage; Reconnect saves it
        close_dialogs(jane); jane.locator('header [data-view=interview]').click(); jane.wait_for_timeout(200)
        jane.evaluate("(()=>{const A=window.ATLAS_APP;A.profile().lastProject=null;A.render();})()")
        jane.voice.auto_wrap = False
        jane.locator('#voiceStart').click(); jane.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000)
        jane.locator('#modelConsent').check(); jane.locator('#voiceConsentStart').click()
        jane.wait_for_function('()=>AtlasVoice.status().phase==="live"', timeout=8000)
        loads = len(jane.loads); urllib.request.urlopen(BASE + '/__expire', timeout=5).read()
        jane.voice.sock.send(json.dumps({'type': 'wrap_up', 'message': 'done'}))
        jane.wait_for_function('()=>AtlasVoice.status().phase==="idle"', timeout=10000)
        wait(jane, lambda: jane.locator('#authBanner').is_visible(), 8)
        store = jane.evaluate("JSON.stringify({s:{...sessionStorage},l:{...localStorage}})")
        projects = jane.evaluate('window.ATLAS_LOCAL.snapshot().profiles[0].projects')
        check('expired after the interview: the banner, the page is not reloaded, the new project is kept in the tab',
              'Your sign-in expired. Your work is kept on this page.' in jane.locator('#authBanner').inner_text() and len(jane.loads) == loads and len(projects) == 2
              and 'Not saved to ATLAS yet · kept in this tab' in jane.locator('#storageStatus').text_content())
        check('no project content reached sessionStorage or localStorage', 'Claims triage' not in store and 'routing design' not in store and 'Zebracorp' not in store)
        wait(jane, lambda: jane.locator('#confirmDialog').is_visible(), 5)
        check('the sync failed, so "Save on this device?" is offered (§3.8); the note says the work is only in this tab',
              'Save on this device' in jane.locator('#confirmTitle').inner_text() and 'Not saved to ATLAS yet' in jane.locator('#voiceAfter').inner_text())
        close_dialogs(jane)  # declined: the work stays in this tab only
        with jane.expect_popup() as pop: jane.locator('#authReconnect').click()
        check('Reconnect opens /go/signed-in in a small window; the navigation signs in again (as Access does)', urlparse(pop.value.url).path == '/go/signed-in')
        wait(jane, lambda: jane.locator('#storageStatus').text_content() == 'Saved to ATLAS', 10)
        listed = [i for i in api(jane, '?mine=1')['items'] if i['mine']]
        check('signed in again: the pending sync is retried, the second project is in the library, nothing was reloaded',
              jane.locator('#authBanner').is_hidden() and len(listed) == 2 and len(jane.loads) == loads and 'signed in again' in jane.locator('#toast').inner_text())
        # unsaved typing in the profile is a draft too: no reload, and it is still there after signing in again
        close_dialogs(jane); jane.locator('#profileButton').click(); jane.locator('#profileSection').wait_for(state='visible', timeout=8000)
        jane.locator('#pf_title').fill('Draft title'); close_dialogs(jane)
        urllib.request.urlopen(BASE + '/__expire', timeout=5).read()
        jane.evaluate("window.ATLAS_APP.libraryApi('/invitations').catch(()=>0)"); wait(jane, lambda: jane.locator('#authBanner').is_visible(), 8)
        check('an unsaved profile edit blocks the automatic reload: the banner instead', jane.locator('#authBanner').is_visible() and len(jane.loads) == loads)
        jane.locator('#authReconnect').click()  # the sign-in window may be reused (same name) or opened again
        wait(jane, lambda: jane.locator('#authBanner').is_hidden(), 8); jane.wait_for_timeout(600)
        jane.locator('#profileButton').click(); jane.locator('#profileSection').wait_for(state='visible', timeout=8000)
        check('signed in again (the profile reloads in the background): the typed title is kept, still unsaved',
              jane.locator('#pf_title').input_value() == 'Draft title' and chip(jane, 'title') == 'you edited' and api(jane, '/profile')['fields']['title']['value'] == 'Head of Data')
        close_dialogs(jane)
        jane.context.close()

        # ---- a clean page reloads quietly on expiry; a returning user gets the workspace back from the library
        back = open_page('jane@example.com')
        check('returning user: the workspace is rebuilt from the library (both records, linked)', len(back.evaluate('window.ATLAS_LOCAL.snapshot().profiles[0].projects')) == 2)
        back.context.close()

        # ---- the product owner's path today (PIN sign-in, no DNA): a brand-new user presses Start, ticks one box and presses
        # Start conversation: three actions, nothing to fill in. The name is only guessed from the email, so the report that
        # opens by itself (Projects view) asks "Is your name …?", and "Yes, that's me" names the project and its record (§3.5).
        new = open_page('noor.haddad@example.net')
        new.evaluate("window.__acts=[];document.addEventListener('click',e=>{if(e.isTrusted)__acts.push(e.target.id||e.target.tagName)},true);"
                     "document.addEventListener('input',e=>{if(e.isTrusted&&e.target.type!=='checkbox')__acts.push('input '+(e.target.id||e.target.tagName))},true)")
        new.locator('#voiceStart').click(); new.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000)
        check('new user, no DNA: the consent step holds one field (the tick); a guessed name is not used in the heading',
              new.locator('#voiceConsentDialog').locator('input:visible, select:visible, textarea:visible').count() == 1
              and new.locator('#voiceConsentTitle').inner_text() == 'A conversation with ATLAS.' and new.locator('#consentIdentity').inner_text() == 'Signed in as noor.haddad@example.net')
        talk(new)
        check('new user: exactly three actions reach the interview (Start, the tick, Start conversation)', new.evaluate('__acts') == ['voiceStart', 'modelConsent', 'voiceConsentStart'])
        wait(new, lambda: new.locator('#storageStatus').text_content() == 'Saved to ATLAS', 10); new.locator('#reportDialog').wait_for(state='visible', timeout=8000)
        nx = new.evaluate('window.ATLAS_LOCAL.snapshot().profiles[0].projects'); nrid = nx[0]['library']['id']
        q = new.locator('#reportStatus .guess-prompt')
        check('only a guess: the project says "Consultant", and the report that opens by itself asks "Is your name Noor Haddad?"',
              len(nx) == 1 and nx[0]['consultant'] == 'Consultant' and q.is_visible() and 'Is your name Noor Haddad?' in q.inner_text())
        q.get_by_role('button', name='Yes, that’s me').click()
        wait(new, lambda: api(new, '/' + nrid)['data']['consultant']['name'] == 'Noor Haddad', 8)
        check('"Yes, that\'s me" in the report: the name is confirmed, the project and its library record carry it, every copy of the question says thanks',
              api(new, '/profile')['fields']['name']['from'] == 'you' and new.evaluate('window.ATLAS_LOCAL.snapshot().profiles[0].projects[0].consultant') == 'Noor Haddad'
              and api(new, '/' + nrid)['data']['consultant']['name'] == 'Noor Haddad'
              and new.evaluate("[...document.querySelectorAll('.guess-prompt')].map(e=>e.textContent.trim())") == ['Thanks, Noor.', 'Thanks, Noor.'])
        new.context.close()

        # ---- sign-in name claims (Entra-style custom claims in the verified token; dev-only &idp= on the local edge)
        kai = open_page('kai@example.net', '/?idp=' + urllib.parse.quote(json.dumps({'name': 'Kai Test', 'given_name': 'Kai', 'family_name': 'Test'})))
        kprof = api(kai, '/profile')
        kai.locator('#voiceStart').click(); kai.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000)
        check('sign-in claims fill the name and the first name ("from your sign-in"); only the verified token counts',
              kprof['fields']['name'] == {'value': 'Kai Test', 'from': 'signin', 'at': kprof['fields']['name']['at']} and kprof['firstName'] == 'Kai'
              and kai.locator('#voiceConsentTitle').inner_text() == 'Ready when you are, Kai.'
              and kai.evaluate("fetch('/api/library/profile',{headers:{'X-Requested-With':'XMLHttpRequest','x-atlas-idp':'eyJuYW1lIjoiRXZlIn0'}}).then(r=>r.json())")['fields']['name']['value'] == 'Kai Test')
        kai.context.close()

        # ---- /go/start through the Worker: the consent step opens on load, the microphone waits for the click
        gs = open_page('jane@example.com', '/go/start')
        gs.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000)
        check('/go/start lands on the consent step; the microphone stays off', not gs.evaluate('AtlasVoice.status().hasMicrophone') and urlparse(gs.url).path == '/')
        gs.context.close()

        # ---- spoken Ask consent storage (D1): what "Always allow for me" stores is what the Worker reads before transcribing
        sp = open_page('jane@example.com')
        api(sp, '/profile/consent', 'POST', {'kind': 'spokenAsk', 'version': 1, 'granted': True})
        c1 = api(sp, '/profile/consents')
        api(sp, '/profile/consent', 'POST', {'kind': 'spokenAsk', 'version': 1, 'granted': False})
        c2 = api(sp, '/profile/consents')
        check('spoken Ask consent: stored in the profile, read back by the route the Worker checks, revocable',
              c1['spokenAsk']['version'] == 1 and c2 == {'spokenAsk': None})
        sp.context.close()

        # ---- a saved copy of the page: one "Open ATLAS" link to the live workspace, no network
        ctx = br.new_context(viewport={'width': 1440, 'height': 1000}); NET = []
        ctx.on('request', lambda r: NET.append(r.url) if not r.url.startswith(('file:', 'data:', 'blob:')) else None)
        ctx.route('**/*', lambda r: r.abort() if not r.request.url.startswith('file:') else r.continue_())
        f = ctx.new_page(); f.on('pageerror', lambda e: ERR.append('file: ' + str(e))); f.goto((ROOT / 'ATLAS_Voice.html').as_uri()); f.wait_for_timeout(800)
        link = f.locator('#voiceOpenHome')
        check('saved file: one "Open ATLAS" link to ATLAS_HOME/go/start (new tab, noopener); no Start button; no network',
              HOME.startswith('https://') and link.is_visible() and link.get_attribute('href') == HOME + '/go/start' and link.get_attribute('target') == '_blank'
              and 'noopener' in (link.get_attribute('rel') or '') and f.locator('#voiceStart').is_hidden() and f.locator('#gatewayAddress').is_hidden() and not NET)
        ctx.close()

        # ---- production mode without secrets: DNA pull and push BLOCKED_EXTERNAL, no test banner
        PROD = start_edge({'DATA_MODE': 'production'})
        pb = json.loads(get(PROD, '/api/bootstrap', 'tony.walteur@gmail.com')[2])
        check('production mode: readiness "production", no test banner', pb['readiness'] == 'production' and 'TEST DEPLOYMENT' not in get(PROD, '/', 'tony.walteur@gmail.com')[2])
        pa = open_page('tony.walteur@gmail.com', base=PROD)
        pa.evaluate("document.getElementById('openInsights').click()"); pa.locator('#peopleDirectory').wait_for(state='visible', timeout=8000)
        pa.locator('#dirFile').wait_for(state='visible', timeout=8000)
        ps = api(pa, '/directory'); ptxt = pa.locator('#peopleDirectory').inner_text()
        check('production mode, no secrets: DNA pull and push stay BLOCKED_EXTERNAL and say what they need',
              ps['dataMode'] == 'production' and ps['sources']['pull']['status'] == 'BLOCKED_EXTERNAL' and ps['sources']['push']['status'] == 'BLOCKED_EXTERNAL'
              and 'DIRECTORY_PUSH_SECRET' in ps['sources']['push']['reason'] and 'DNA push: not connected' in ptxt and 'DNA pull: not connected' in ptxt
              and 'Upload the DNA export as CSV' in ptxt)
        push = urllib.request.Request(PROD + '/api/directory/push', data=b'{}', method='POST', headers={'Content-Type': 'application/json', 'Authorization': 'Bearer guess'})
        try: pcode = RAW.open(push, timeout=5).status
        except urllib.error.HTTPError as e: pcode = e.code
        check('production mode, no push secret: /api/directory/push answers 401', pcode == 401)
        pa.context.close(); adm.context.close()
        br.close()
    if ERR: print('\n'.join(ERR))
    check('no page errors', not ERR)
except AssertionError:
    code = 1
finally:
    for proc in PROCS: proc.terminate()
sys.exit(code)
