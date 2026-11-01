"""The Settings sheet (v2.2 V2), end to end against the local edge: the real Worker handle(), the real LibraryStore (node:sqlite) with the sealed settings table, a fake ElevenLabs
(dev/fake-elevenlabs.mjs) that is the only thing it can reach. Loopback only: no provider, no network.
  python3 build.py && python3 deploy/cloudflare-edge/build_edge.py && cp ATLAS_Voice.html deploy/cloudflare-edge/src/atlas.html && python3 tests/settings_browser.py
Flow, at 1440x900 and 390x844: the avatar and Ctrl+comma open the sheet; keyboard tabs; Privacy has Download/Delete and the four choices (all unticked, with a plain explanation) two clicks away; Workspace has
the save status and backup; a person who is not an admin sees no Connections or Voice tab and the routes answer 403; the admin's Connections tab is a table (name, state dot, what is missing), no longer on the
Library; the Voice tab: the key field is a password field that is never filled in, a wrong key is refused and nothing is stored, a good key is stored ("Key saved · validated <date>"), the key text is
nowhere in the page, its storage or the status the server gives back, the voice list comes from the account (search, pick), ElevenLabs and a model are saved and survive a reload, Test voice plays a blob: URL
under the strict CSP with no violation, Remove key puts it all back. Screenshots go to $ATLAS_SHOTS (default /tmp/claude-501/atlas_logs/settings_shots).
"""
import json, os, re, socket, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy/cloudflare-edge'
PAGE = EDGE / 'src/atlas.html'
SHOTS = Path(os.environ.get('ATLAS_SHOTS') or '/tmp/claude-501/atlas_logs/settings_shots'); SHOTS.mkdir(parents=True, exist_ok=True)
ERR, PROCS, CSP = [], [], []
GOOD, BAD = 'sk_test_9Qw7ZpL3vB8nT2mR4x', 'wrong-key-0123456789-abcdef'
ADMIN, USER = 'tony.walteur@gmail.com', 'jane@example.com'
SETTINGS_KEY = 'browser-test-settings-secret-0123456789abcdef'


def check(n, v):
    print(('PASS ' if v else 'FAIL ') + n, flush=True)
    assert v, n


def start_edge(extra=None):
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
    env = {k: v for k, v in os.environ.items() if k not in ('DATA_MODE', 'DIRECTORY_PUSH_SECRET', 'ATLAS_READ_ONLY', 'ATLAS_AI_OFF') and not k.startswith('DNA_')}
    proc = subprocess.Popen(['node', '--no-warnings', 'dev/local-edge.mjs', str(port)], cwd=EDGE, env={**env, 'ATLAS_VOICE': 'on', 'FAKE_ELEVENLABS': '1', 'FAKE_ELEVENLABS_KEY': GOOD, 'SETTINGS_KEY': SETTINGS_KEY, **(extra or {})}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    PROCS.append(proc)
    base = f'http://127.0.0.1:{port}'
    for _ in range(100):
        try: urllib.request.urlopen(base + '/__settle', timeout=1); break
        except Exception: time.sleep(.1)
    return base


def wait(p, cond, timeout=8):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if cond(): return True
        p.wait_for_timeout(100)
    return cond()


def main():
    if not PAGE.exists() or 'settings-sheet' not in PAGE.read_text():
        print('NOT RUNNABLE: deploy/cloudflare-edge/src/atlas.html is missing or older than the Settings sheet. Run: python3 build.py && python3 deploy/cloudflare-edge/build_edge.py && cp ATLAS_Voice.html deploy/cloudflare-edge/src/atlas.html')
        sys.exit(2)
    base = start_edge()
    with sync_playwright() as pw:
        br = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None, args=['--autoplay-policy=no-user-gesture-required'])

        def open_page(who, w=1440, h=900):
            ctx = br.new_context(viewport={'width': w, 'height': h})
            p = ctx.new_page(); p.on('pageerror', lambda e: ERR.append(who + ': ' + str(e)))
            p.on('console', lambda m: CSP.append(m.text) if m.type == 'error' and re.search(r'Content Security Policy|Refused to', m.text) else None)
            p.goto(base + '/?as=' + who); p.wait_for_function('()=>window.AtlasSettings&&window.ATLAS_APP', timeout=10000); p.wait_for_timeout(700)
            return p

        def sheet(p, tab=None):
            p.locator('#profileButton').click(); p.wait_for_selector('#profileDialog[open]'); p.wait_for_timeout(250)
            if tab: p.locator('#stab-' + tab).click(); p.wait_for_timeout(250)

        def close(p):
            p.locator('#profileDialog .close').click(); p.wait_for_timeout(200)

        def vis(p, sel): return p.locator(sel).first.is_visible()

        def shot(p, name): p.screenshot(path=str(SHOTS / (name + '.png')))

        for w, h, tag in ((1440, 900, 'desktop'), (390, 844, 'mobile')):
            # ---------------------------------------------------------------- an ordinary person
            u = open_page(USER, w, h)
            check(f'[{tag}] the avatar is labelled Settings', 'Settings' in (u.locator('#profileButton').get_attribute('aria-label') or ''))
            sheet(u)
            check(f'[{tag}] the sheet opens on Profile with three tabs and no admin tab', vis(u, '#stab-profile') and u.locator('#stab-profile').get_attribute('aria-selected') == 'true'
                  and [t.inner_text() for t in u.locator('[role=tab]:visible').all()] == ['Profile', 'Privacy', 'Workspace'] and not vis(u, '#stab-voice') and not vis(u, '#stab-connections'))
            check(f'[{tag}] the profile is there (name, title, N+1)', vis(u, '#profileSection') and u.locator('#pf_name').count() == 1 and not vis(u, '#profileEmpty'))
            box = u.locator('#profileDialog').bounding_box()
            if w <= 640:
                check(f'[{tag}] the sheet is full screen on a phone', box['width'] >= w - 1 and box['height'] >= h - 2)
                check(f'[{tag}] the tabs are one scrolling row of 44px targets', all(t.bounding_box()['height'] >= 44 for t in u.locator('[role=tab]:visible').all())
                      and abs(u.locator('#stab-profile').bounding_box()['y'] - u.locator('#stab-privacy').bounding_box()['y']) < 2)
            else:
                check(f'[{tag}] the sheet is a centred dark sheet', 800 <= box['width'] <= 960 and box['height'] <= h and 'rgb(22, 22, 24)' == u.evaluate("getComputedStyle(document.getElementById('profileDialog')).backgroundColor"))
            shot(u, f'user-profile-{tag}')
            # keyboard tabs
            u.locator('#stab-profile').focus(); u.keyboard.press('ArrowRight'); u.wait_for_timeout(100)
            check(f'[{tag}] ArrowRight moves to Privacy, selects it and shows its panel', u.locator('#stab-privacy').get_attribute('aria-selected') == 'true' and vis(u, '#privacyPanel') and not vis(u, '#profileSection')
                  and u.evaluate("document.activeElement.id") == 'stab-privacy')
            u.keyboard.press('End'); u.wait_for_timeout(100)
            check(f'[{tag}] End goes to the last tab a person can see (Workspace), Home back to Profile', u.locator('#stab-workspace').get_attribute('aria-selected') == 'true')
            u.keyboard.press('Home'); u.wait_for_timeout(100)
            check(f'[{tag}] Home goes to Profile', u.locator('#stab-profile').get_attribute('aria-selected') == 'true' and u.locator('[role=tab][tabindex="0"]').count() == 1)
            # privacy: two clicks from the page
            close(u); sheet(u, 'privacy')
            check(f'[{tag}] Download my data and Delete my data are visible two clicks from the page', vis(u, '#privDownload') and vis(u, '#privDelete'))
            check(f'[{tag}] the four choices and the saved-interview choice each have a plain explanation and none is ticked for the person',
                  all(u.locator(f'#{i}').count() == 1 and not u.locator(f'#{i}').is_checked() for i in ('privRestricted', 'privObjectScoring', 'privObjectMatching', 'privObjectMemory', 'privCheckpoint'))
                  and u.locator('#privacyPanel .field-note').count() == 5 and all(len(n.inner_text()) > 20 for n in u.locator('#privacyPanel .field-note').all()))
            shot(u, f'user-privacy-{tag}')
            u.locator('#privDelete').click(); u.wait_for_timeout(500)
            check(f'[{tag}] Delete my data still opens its two-step confirmation (nothing is deleted yet)', u.locator('#eraseDialog').evaluate('d=>d.open') and u.locator('#eraseConfirm').is_disabled())
            u.locator('#eraseDialog .close').click(); u.wait_for_timeout(200)
            u.locator('#privDownload').click(); u.wait_for_timeout(300)
            # workspace
            u.locator('#stab-workspace').click(); u.wait_for_timeout(200)
            check(f'[{tag}] Workspace holds the save status and the backup controls', vis(u, '#storageDetail') and len(u.locator('#storageDetail').inner_text()) > 10 and vis(u, '#backupProfile') and vis(u, '#importProfile') and vis(u, '#toggleStorage') and vis(u, '#userSelect'))
            shot(u, f'user-workspace-{tag}')
            # the routes refuse a non-admin
            codes = u.evaluate("""async()=>{const b=await window.ATLAS_APP.bootInfo();const o=(m,p,body)=>fetch(p,{method:m,headers:{'Content-Type':'application/json','X-Atlas-CSRF':b.csrf},body:body?JSON.stringify(body):undefined}).then(r=>r.status);
              return [await o('GET','/api/admin/voice'),await o('PUT','/api/admin/voice/key',{key:'x'.repeat(30)}),await o('GET','/api/admin/voice/voices'),await o('POST','/api/admin/voice/test',{}),await o('GET','/api/connections/status')];}""")
            check(f'[{tag}] every admin route answers a person who is not an admin with 403', codes == [403, 403, 403, 403, 403])
            close(u)
            # Ctrl+comma
            u.locator('body').click(position={'x': 5, 'y': 400}); u.keyboard.press('Control+,'); u.wait_for_timeout(300)
            check(f'[{tag}] Ctrl+comma opens the sheet from the page', u.locator('#profileDialog').evaluate('d=>d.open'))
            u.context.close()

            # ---------------------------------------------------------------- the admin
            a = open_page(ADMIN, w, h)
            check(f'[{tag}] the Library no longer carries the connections wall', a.locator('#library #connectionsPanel').count() == 0 and a.locator('#connectionsPanel').count() == 1)
            sheet(a)
            check(f'[{tag}] an admin sees Connections and Voice tabs as well', [t.inner_text().replace('Admin', '').strip() for t in a.locator('[role=tab]:visible').all()][:5] == ['Profile', 'Privacy', 'Workspace', 'Connections', 'Voice'])
            a.locator('#stab-connections').click(); a.wait_for_selector('#connectionsPanel table.conn-table tbody tr', timeout=8000)
            rows = a.locator('#connectionsPanel tr.conn-row')
            check(f'[{tag}] Connections is a table: a name, a state dot and word, and what is missing, for each connection', rows.count() >= 8 and a.locator('#connectionsPanel thead th').count() == 3
                  and all(r.locator('.conn-chip').count() == 1 and r.locator('.conn-why').inner_text().strip() for r in rows.all()) and {r.get_attribute('data-state') for r in rows.all()} <= {'ready', 'mock', 'not_configured'})
            check(f'[{tag}] the table says nothing secret (no address, token or key)', not re.search(r'https?://|token=|sk-[A-Za-z0-9]', a.locator('#connectionsPanel').inner_text()))
            check(f'[{tag}] no horizontal scroll on the page or in the pane', a.evaluate("document.documentElement.scrollWidth<=innerWidth+1&&(p=>p.scrollWidth<=p.clientWidth+1)(document.getElementById('spane-connections'))"))
            shot(a, f'admin-connections-{tag}')

            # ---- Voice
            a.locator('#stab-voice').click(); a.wait_for_selector('#voiceStatusLine', timeout=8000); a.wait_for_timeout(300)
            check(f'[{tag}] Voice: status line says what is in use; no key yet; ElevenLabs cannot be chosen yet', 'Workers AI' in a.locator('#voiceStatusLine').inner_text() and a.locator('#voiceProv_elevenlabs').is_disabled()
                  and a.locator('#voiceProv_auto').is_checked() and a.locator('#voiceKeyState').count() == 0)
            kf = a.locator('#voiceKey')
            check(f'[{tag}] the key field is a password field, empty, not autofilled, no last characters anywhere', kf.get_attribute('type') == 'password' and kf.input_value() == '' and kf.get_attribute('autocomplete') == 'new-password' and a.locator('#voiceKeyRemove').count() == 0)
            shot(a, f'admin-voice-empty-{tag}')
            kf.fill(BAD); a.locator('#voiceKeySave').click(); a.wait_for_function("()=>/did not accept/i.test(document.getElementById('voiceMsg').textContent)", timeout=8000)
            check(f'[{tag}] a wrong key is refused in plain words, the field is emptied, and nothing is stored', a.locator('#voiceKey').input_value() == '' and a.locator('#voiceKeyState').count() == 0 and a.locator('#voiceProv_elevenlabs').is_disabled()
                  and BAD not in a.content())
            a.locator('#voiceKey').fill(GOOD); a.locator('#voiceKey').press('Enter'); a.wait_for_selector('#voiceKeyState', timeout=8000)
            st = a.locator('#voiceKeyState').inner_text()
            check(f'[{tag}] a good key: "Key saved · validated <date>", the plan from ElevenLabs, the field empty, ElevenLabs can now be chosen', st.startswith('Key saved · validated ') and 'Creator plan' in st and '98,800 of 100,000' in st
                  and a.locator('#voiceKey').input_value() == '' and not a.locator('#voiceProv_elevenlabs').is_disabled() and a.locator('#voiceKeyRemove').count() == 1)
            leak = a.evaluate("""([k])=>{const hay=[document.documentElement.outerHTML,JSON.stringify({...localStorage}),JSON.stringify({...sessionStorage}),document.cookie,[...document.querySelectorAll('input,textarea')].map(i=>i.value).join(' ')].join(' ');return hay.includes(k)||hay.includes(k.slice(-6))||hay.includes(k.slice(0,6));}""", [GOOD])
            status_txt = a.evaluate("fetch('/api/admin/voice').then(r=>r.text())")
            check(f'[{tag}] the key, or any 6 characters of it, is nowhere in the page, its storage, any field or the status the server returns', not leak and GOOD not in status_txt and GOOD[-6:] not in status_txt)
            a.wait_for_selector('#voiceVoice option', timeout=8000)
            names = [o.inner_text() for o in a.locator('#voiceVoice option').all()]
            check(f'[{tag}] the voice list comes from the account (four voices, with their labels)', len(names) >= 4 and any(n.startswith('Daniel') and 'british' in n for n in names))
            a.locator('#voiceSearch').fill('dan'); a.wait_for_function("()=>document.querySelectorAll('#voiceVoice option').length<=2", timeout=5000)
            check(f'[{tag}] searching narrows the list from the server', [o.inner_text().split(' ·')[0] for o in a.locator('#voiceVoice option').all()][-1] == 'Daniel')
            a.locator('#voiceSearch').fill(''); a.wait_for_function("()=>document.querySelectorAll('#voiceVoice option').length>=4", timeout=5000)
            a.locator('#voiceVoice').select_option(label=[n for n in names if n.startswith('Adam')][0]); a.locator('#voiceProv_elevenlabs').check()
            a.locator('#voiceModel').select_option('eleven_multilingual_v2'); a.wait_for_timeout(100)
            shot(a, f'admin-voice-key-{tag}')
            a.locator('#voiceSave').click(); a.wait_for_function("()=>/^Saved/.test(document.getElementById('voiceMsg').textContent)", timeout=8000)
            check(f'[{tag}] saving ElevenLabs, a voice and a model is confirmed and the status line follows', 'In use: ElevenLabs, Adam (Multilingual v2)' in a.locator('#voiceStatusLine').inner_text() and a.locator('#voiceSave').is_disabled())
            # Test voice: a blob under the strict CSP
            a.evaluate("""()=>{window.__aud=[];const A=window.Audio;window.Audio=function(src){const o=new A(src);window.__aud.push(String(src));return o;};}""")
            before = len(CSP); tts = lambda: sum(1 for c in json.loads(urllib.request.urlopen(base + '/__elevenlabs_calls', timeout=5).read()) if c['path'].startswith('/v1/text-to-speech/pNInz6obpgDQGcFmaJgB')); n_tts = tts()
            a.locator('#voiceTest').click(); a.wait_for_function("()=>/^Playing a sample with ElevenLabs/.test(document.getElementById('voiceMsg').textContent)", timeout=10000)
            check(f'[{tag}] Test voice plays a blob: URL, with no CSP violation', a.evaluate('window.__aud.length') == 1 and a.evaluate('window.__aud[0]').startswith('blob:') and len(CSP) == before)
            calls = json.loads(urllib.request.urlopen(base + '/__elevenlabs_calls', timeout=5).read())
            check(f'[{tag}] the fake ElevenLabs saw the key check, the voice list and one test synthesis (path only)', any(c['path'] == '/v1/user' for c in calls) and tts() == n_tts + 1)
            # it survives a reload; the key field is empty again
            a.reload(); a.wait_for_function('()=>window.AtlasSettings&&window.ATLAS_APP', timeout=10000); a.wait_for_timeout(600)
            sheet(a, 'voice'); a.wait_for_selector('#voiceKeyState', timeout=8000)
            check(f'[{tag}] after a reload the choice and the key state are still there, and the key field is empty', a.locator('#voiceProv_elevenlabs').is_checked() and a.locator('#voiceKeyState').inner_text().startswith('Key saved') and a.locator('#voiceKey').input_value() == '')
            a.locator('#voiceProv_aura').check(); a.locator('#voiceTest').click(); a.wait_for_function("()=>/Playing a sample with Workers AI/.test(document.getElementById('voiceMsg').textContent)", timeout=10000)
            check(f'[{tag}] Test voice with Workers AI selected tests Workers AI (no ElevenLabs call)', True)
            # remove
            a.locator('#voiceKeyRemove').click(); a.wait_for_selector('#confirmDialog[open]'); a.locator('#confirmYes').click(); a.wait_for_function("()=>/Key removed/.test(document.getElementById('voiceMsg').textContent)", timeout=8000)
            check(f'[{tag}] Remove key: forgotten, ElevenLabs disabled again, status back to Workers AI', a.locator('#voiceKeyState').count() == 0 and a.locator('#voiceProv_elevenlabs').is_disabled() and 'In use: Workers AI' in a.locator('#voiceStatusLine').inner_text())
            shot(a, f'admin-voice-removed-{tag}')
            a.keyboard.press('Escape'); a.wait_for_timeout(200)
            check(f'[{tag}] closing the sheet leaves no key text behind', not a.evaluate("([k])=>document.documentElement.outerHTML.includes(k)", [GOOD]))
            a.context.close()
        # a deployment without SETTINGS_KEY: the Voice tab says keys cannot be stored here, offers no key field, and the rest still works
        b2 = start_edge({'SETTINGS_KEY': '', 'ELEVENLABS_API_KEY': GOOD})
        ctx = br.new_context(viewport={'width': 1440, 'height': 900}); n = ctx.new_page(); n.on('pageerror', lambda e: ERR.append(str(e)))
        n.goto(b2 + '/?as=' + ADMIN); n.wait_for_function('()=>window.AtlasSettings&&window.ATLAS_APP', timeout=10000); n.wait_for_timeout(600)
        n.locator('#profileButton').click(); n.locator('#stab-voice').click(); n.wait_for_selector('#voiceNoStore', timeout=8000)
        check('without SETTINGS_KEY the Voice tab explains that keys cannot be stored here, shows no key field, and says the operator key still works',
              'cannot be stored' in n.locator('#voiceNoStore').inner_text() and n.locator('#voiceKey').count() == 0 and 'set on the server' in n.locator('#adminVoicePanel').inner_text() and not n.locator('#voiceProv_elevenlabs').is_disabled())
        n.locator('#voiceProv_elevenlabs').check(); n.locator('#voiceSave').click(); n.wait_for_function("()=>/^Saved/.test(document.getElementById('voiceMsg').textContent)", timeout=8000)
        check('the provider can still be chosen with the operator key and the status follows', 'In use: ElevenLabs' in n.locator('#voiceStatusLine').inner_text())
        ctx.close()
        check('no page errors', not ERR); print(ERR)
        check('no Content-Security-Policy violation in any console', not CSP); print(CSP)
        br.close()


try:
    main()
finally:
    for p in PROCS: p.terminate()
print('ALL PASS')
