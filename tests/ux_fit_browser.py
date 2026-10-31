"""Start flow and viewport-fit layout (v2.2 U1) on the real local edge (typed interview, offline fake models), in a real browser.

  python3 build.py && cp ATLAS_Voice.html deploy/cloudflare-edge/src/atlas.html && python3 tests/ux_fit_browser.py

Measured with getBoundingClientRect, never pixels. For every desktop window (1280x720, 1366x768, 1440x900, 1512x982) and for every phase:
  start     the orb, the heading and the start buttons are fully inside the window; the typed interview is the primary button (this server has no voice)
  consent   the dialog's buttons are inside the dialog and inside the window
  live      the orb, ATLAS's latest line, the answer box, the next question and the progress caption (right rail) are fully visible and not clipped by
            any scrolling ancestor; the page itself does not scroll (scrollHeight <= innerHeight + 1, scrollY 0, also after answers)
  read-back its title, its first item and Confirm are visible; no page scroll
Also: a narrow window (502x414) and a phone (390x844); a blocked microphone leads to "Continue by typing" (typed, live, NO second consent dialog) and
"Try the microphone again"; no console errors. UX_SHOTS=<dir> saves one screenshot per phase and window (default: a temporary folder).
"""
import json, os, socket, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy/cloudflare-edge'
SHOTS = Path(os.environ.get('UX_SHOTS') or tempfile.mkdtemp(prefix='ux_fit_'))
SHOTS.mkdir(parents=True, exist_ok=True)
ERR, PROCS, TABLE = [], [], []
DESKTOP = [(1280, 720), (1366, 768), (1440, 900), (1512, 982)]
ANSWERS = [
    'We rebuilt the claims intake process for an insurance client during the pilot. Claims were bouncing between three teams and payouts were slow. I designed and built the routing model.',
    'Before, the median triage time was forty minutes per claim, measured on the team dashboard over six weeks.',
    'After the pilot the median triage time dropped to twelve minutes, according to the same dashboard over the next six weeks.',
    'The claims team of eight people used it daily and the operations lead owned it after my handover. We chose rules instead of a learned model because auditors needed to read every decision.',
    "I don't know of any other evidence. The limit is that the pilot covered only one region.",
    'It would suit insurers with a fragmented claims queue. It would not fit a company without a central triage team.']

# 1 = the element is inside the window and inside every ancestor that clips (overflow other than visible); returns the numbers for the table
VIS = """(sel)=>{const e=document.querySelector(sel);if(!e)return {ok:false,why:'missing'};const r=e.getBoundingClientRect();
 let ok=r.width>0&&r.height>0&&r.top>=-0.5&&r.bottom<=innerHeight+0.5&&r.left>=-0.5&&r.right<=innerWidth+0.5,why=ok?'':'outside the window';
 for(let p=e.parentElement;ok&&p&&p!==document.documentElement;p=p.parentElement){const s=getComputedStyle(p);
  if(s.overflowY!=='visible'||s.overflowX!=='visible'){const q=p.getBoundingClientRect();if(r.top<q.top-0.5||r.bottom>q.bottom+0.5||r.left<q.left-0.5||r.right>q.right+0.5){ok=false;why='clipped by '+(p.id||p.className)}}}
 return {ok,why,top:Math.round(r.top),bottom:Math.round(r.bottom),h:innerHeight}}"""
NOSCROLL = "()=>({sh:document.scrollingElement.scrollHeight,ih:innerHeight,y:scrollY,ok:document.scrollingElement.scrollHeight<=innerHeight+1&&scrollY===0})"


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (' ' + str(detail) if detail and not ok else ''), flush=True)
    assert ok, name + ' ' + str(detail)


def row(vp, phase, ok, note=''):
    TABLE.append((vp, phase, 'pass' if ok else 'FAIL', note))


def start_edge(voice):
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
    env = {k: v for k, v in os.environ.items() if k not in ('DATA_MODE', 'DIRECTORY_PUSH_SECRET', 'IDENTITY_SOURCE', 'ATLAS_VOICE') and not k.startswith('DNA_')}
    if voice: env['ATLAS_VOICE'] = 'on'
    proc = subprocess.Popen(['node', '--no-warnings', 'dev/local-edge.mjs', str(port)], cwd=EDGE, env={**env, 'ATLAS_ADAPTERS': 'mock'}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    PROCS.append(proc)
    base = f'http://127.0.0.1:{port}'
    for _ in range(100):
        try: urllib.request.urlopen(base + '/__settle', timeout=1); break
        except Exception: time.sleep(.1)
    return base


def page(br, base, w, h, who, init=None, touch=False):
    ctx = br.new_context(viewport={'width': w, 'height': h}, has_touch=touch, is_mobile=touch)
    if init: ctx.add_init_script(init)
    p = ctx.new_page()
    p.on('pageerror', lambda e: ERR.append(str(e)))
    p.on('console', lambda m: ERR.append('console: ' + m.text) if m.type == 'error' else None)
    p.goto(f'{base}/?as={who}@mantu.com'); p.wait_for_timeout(1200)
    p.locator('#voiceStartText').wait_for(state='visible', timeout=8000)
    return ctx, p


def shot(p, phase, w, h):
    p.screenshot(path=str(SHOTS / f'{phase}_{w}x{h}.png'))


def all_visible(p, vp, phase, sels, extra=''):
    bad = []
    for name, sel in sels.items():
        v = p.evaluate(VIS, sel)
        if not v['ok']: bad.append(f"{name} {v.get('why')} top={v.get('top')} bottom={v.get('bottom')}/{v.get('h')}")
    row(vp, phase, not bad, '; '.join(bad) or extra)
    check(f'{vp} {phase}: {", ".join(sels)} fully visible', not bad, bad)


def desktop(br, base, w, h):
    vp = f'{w}x{h}'
    ctx, p = page(br, base, w, h, f'fit{w}')
    # ---- start
    all_visible(p, vp, 'start', {'orb': '.orb-screen', 'heading': '.studio-heading h1', 'primary start': '#voiceStartText'})
    state = p.evaluate("()=>({voiceHidden:document.getElementById('voiceStart').hidden,label:document.getElementById('voiceStartText').textContent,primary:document.getElementById('voiceStartText').classList.contains('primary'),reason:document.getElementById('voiceReason').textContent,reasonShown:!document.getElementById('voiceReason').hidden})")
    check(f'{vp} start: voice is off here, so the typed interview is primary, the voice button is gone and a short reason is shown', state['voiceHidden'] and state['primary'] and state['label'] == 'Start interview' and state['reasonShown'] and len(state['reason']) < 120, state)
    reason = p.evaluate(VIS, '#voiceReason'); check(f'{vp} start: the reason is visible', reason['ok'], reason)
    shot(p, 'start', w, h)
    # ---- consent
    p.locator('#voiceStartText').click(); p.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000); p.wait_for_timeout(400)
    p.locator('#modelConsent').check(); p.wait_for_timeout(100)
    dlg = p.evaluate("()=>{const d=document.getElementById('voiceConsentDialog').getBoundingClientRect(),b=document.getElementById('voiceConsentType').getBoundingClientRect();return {dTop:d.top,dBottom:d.bottom,bTop:b.top,bBottom:b.bottom,ih:innerHeight,startHidden:document.getElementById('voiceConsentStart').hidden,y:scrollY}}")
    ok = dlg['dTop'] >= 0 and dlg['dBottom'] <= dlg['ih'] + 1 and dlg['bTop'] >= dlg['dTop'] and dlg['bBottom'] <= dlg['dBottom'] + 1 and dlg['startHidden'] and dlg['y'] == 0
    row(vp, 'consent', ok, str(dlg) if not ok else ''); check(f'{vp} consent: the action is inside the dialog and the window, the page did not jump', ok, dlg)
    shot(p, 'consent', w, h)
    p.locator('#voiceConsentType').click(); p.wait_for_function('()=>AtlasVoice.status().phase==="live"', timeout=15000)
    p.wait_for_function("()=>document.querySelectorAll('#textLog .msg-atlas').length>=1", timeout=15000); p.wait_for_timeout(700)
    # ---- live
    sels = {'orb': '.orb-screen', 'ATLAS line': '#textLog .msg-atlas:last-child, #textLog .msg:last-child', 'answer box': '#voiceTypeInput', 'next question': '#qualityNext', 'progress caption': '#boardTopics'}
    all_visible(p, vp, 'live', sels)
    ns = p.evaluate(NOSCROLL); row(vp, 'live no page scroll', ns['ok'], str(ns)); check(f'{vp} live: the page does not scroll', ns['ok'], ns)
    check(f'{vp} live: focus is in the answer box', p.evaluate("document.activeElement&&document.activeElement.id")=='voiceTypeInput')
    shot(p, 'live', w, h)
    # answer until the read-back, checking the window never moves
    for i, a in enumerate(ANSWERS):
        n = p.locator('#textLog .msg').count(); t0 = time.time()
        p.locator('#voiceTypeInput').fill(a); p.keyboard.press('Enter')
        p.wait_for_function('n=>document.querySelectorAll("#textLog .msg").length>=n+2 || !document.getElementById("summaryCard").hidden', arg=n, timeout=20000)
        if i == 2:
            ns = p.evaluate(NOSCROLL); check(f'{vp} live after answers: the page still does not scroll', ns['ok'], ns)
            all_visible(p, vp, 'live after 3 answers', {'orb': '.orb-screen', 'answer box': '#voiceTypeInput', 'next question': '#qualityNext', 'progress caption': '#boardTopics', 'ATLAS line': '#textLog .msg-atlas:last-child, #textLog .msg:last-child'})
            shot(p, 'live-after-answers', w, h)
        if not p.locator('#summaryCard').is_hidden(): break
        p.wait_for_timeout(max(900, 1700 - int((time.time() - t0) * 1000)))
    p.locator('#summaryCard').wait_for(state='visible', timeout=25000); p.wait_for_timeout(900)
    # ---- read-back
    all_visible(p, vp, 'read-back', {'title': '#summaryTitle', 'first item': '#summaryItems li:first-child', 'Confirm': '#summaryConfirm'})
    cov = p.evaluate("()=>{const i=document.querySelector('#summaryItems li:first-child').getBoundingClientRect(),c=document.getElementById('summaryConfirm').getBoundingClientRect();return {itemBottom:i.bottom,confirmTop:c.top}}")
    check(f'{vp} read-back: the first item is not hidden behind the Confirm bar', cov['itemBottom'] <= cov['confirmTop'] + 1, cov)
    ns = p.evaluate(NOSCROLL); row(vp, 'read-back no page scroll', ns['ok'], str(ns)); check(f'{vp} read-back: the page does not scroll', ns['ok'], ns)
    shot(p, 'readback', w, h)
    ctx.close()


def narrow(br, base):
    # 502x414: below the desktop shell (too short); dialogs must still show their action
    ctx, p = page(br, base, 502, 414, 'fitnarrow')
    p.locator('#voiceStartText').click(); p.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000); p.wait_for_timeout(400); p.locator('#modelConsent').check()
    d = p.evaluate("()=>{const d=document.getElementById('voiceConsentDialog').getBoundingClientRect(),b=document.getElementById('voiceConsentType').getBoundingClientRect();return {ok:b.top>=d.top&&b.bottom<=d.bottom+1&&b.bottom<=innerHeight+1&&d.top>=0,b:[b.top,b.bottom],d:[d.top,d.bottom],ih:innerHeight}}")
    row('502x414', 'consent', d['ok'], str(d) if not d['ok'] else ''); check('502x414 consent: the action is visible (sticky footer) with the body scrolling inside', d['ok'], d)
    shot(p, 'consent', 502, 414); ctx.close()


def phone(br, base):
    ctx, p = page(br, base, 390, 844, 'fitphone', touch=True)
    v = p.evaluate(VIS, '#voiceStartText'); row('390x844', 'start', v['ok'], str(v) if not v['ok'] else ''); check('390x844 start: the start button is inside the first screen', v['ok'], v)
    o = p.evaluate(VIS, '.orb-screen'); check('390x844 start: the orb is inside the first screen', o['ok'], o)
    h = p.evaluate("()=>[...document.querySelectorAll('#voiceStartText,.voice-controls .btn:not([hidden])')].filter(e=>e.offsetParent).map(e=>e.getBoundingClientRect().height)")
    check('390x844 start: touch targets are 44px', all(x >= 43.5 for x in h), h)
    shot(p, 'start', 390, 844)
    p.locator('#voiceStartText').click(); p.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000); p.wait_for_timeout(400); p.locator('#modelConsent').check()
    d = p.evaluate("()=>{const d=document.getElementById('voiceConsentDialog').getBoundingClientRect(),b=document.getElementById('voiceConsentType').getBoundingClientRect();return {ok:b.top>=d.top&&b.bottom<=d.bottom+1&&b.bottom<=innerHeight+1,b:[b.top,b.bottom],ih:innerHeight}}")
    row('390x844', 'consent', d['ok'], str(d) if not d['ok'] else ''); check('390x844 consent: the action is visible', d['ok'], d)
    check('390x844 consent: opening the dialog did not scroll the page', p.evaluate('scrollY') == 0, p.evaluate('scrollY'))
    shot(p, 'consent', 390, 844)
    p.locator('#voiceConsentType').click(); p.wait_for_function('()=>AtlasVoice.status().phase==="live"', timeout=15000)
    p.wait_for_function("()=>document.querySelectorAll('#textLog .msg-atlas').length>=1", timeout=15000); p.wait_for_timeout(900)
    v = p.evaluate(VIS, '#voiceTypeInput'); row('390x844', 'live', v['ok'], str(v) if not v['ok'] else ''); check('390x844 live: the answer box is inside the first screen', v['ok'], v)
    sw = p.evaluate("()=>document.documentElement.scrollWidth<=innerWidth"); check('390x844 live: no horizontal scroll', sw)
    check('390x844 live: starting did not scroll the page away from the orb', p.evaluate('scrollY') < 60, p.evaluate('scrollY'))
    shot(p, 'live', 390, 844); ctx.close()


def blocked_mic(br, base):
    """A blocked microphone: calm inline state, one primary button that starts text mode with the consent already given."""
    init = """(()=>{window.__gum=0;window.__modals=0;
      Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:()=>{window.__gum++;return Promise.reject(new DOMException('Permission denied','NotAllowedError'))},enumerateDevices:async()=>[]},configurable:true});
      const o=HTMLDialogElement.prototype.showModal;HTMLDialogElement.prototype.showModal=function(){if(this.id==='voiceConsentDialog')window.__modals++;return o.apply(this,arguments)};})()"""
    ctx, p = page(br, base, 1440, 900, 'fitmic', init=init)
    p.locator('#voiceStart').wait_for(state='visible', timeout=8000)
    check('mic: this server offers voice, so Start interview is the primary button', p.locator('#voiceStart').is_visible() and 'primary' in p.locator('#voiceStart').get_attribute('class'))
    p.locator('#voiceStart').click(); p.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000)
    p.locator('#modelConsent').check(); p.locator('#voiceConsentStart').click()
    p.locator('#voiceMicHelp').wait_for(state='visible', timeout=8000); p.wait_for_timeout(300)
    t = p.evaluate("()=>({head:document.getElementById('voiceHeading').textContent,msg:document.getElementById('voiceMessage').textContent,phase:AtlasVoice.status().phase,modal:document.getElementById('voiceConsentDialog').open,primary:document.getElementById('voiceMicType').className,retry:document.getElementById('voiceMicRetry').textContent,go:document.getElementById('voiceMicType').textContent,startShown:!!document.getElementById('voiceStart').offsetParent,focus:document.activeElement.id,gum:window.__gum})")
    check('mic: a calm state, not "connection stopped" (idle, no error heading)', 'stopped' not in (t['head'] + t['msg']).lower() and t['phase'] == 'idle', t)
    check('mic: one sentence on what happened', t['msg'].count('.') == 1 and 'microphone' in t['msg'].lower(), t['msg'])
    check('mic: "Continue by typing" is the primary button and "Try the microphone again" the secondary one', t['go'] == 'Continue by typing' and 'primary' in t['primary'] and t['retry'] == 'Try the microphone again', t)
    check('mic: the two start buttons are gone, focus is on the primary button, the consent dialog is closed', not t['startShown'] and t['focus'] == 'voiceMicType' and not t['modal'], t)
    v = p.evaluate(VIS, '#voiceMicType'); check('mic: the buttons are in the window', v['ok'], v)
    shot(p, 'mic-blocked', 1440, 900)
    modals = p.evaluate('window.__modals')
    p.locator('#voiceMicRetry').click(); p.wait_for_function('()=>window.__gum>=2', timeout=8000); p.locator('#voiceMicHelp').wait_for(state='visible', timeout=8000)
    check('mic: Try the microphone again asks again, with no second consent dialog', p.evaluate('window.__gum') == 2 and p.evaluate('window.__modals') == modals and not p.evaluate("document.getElementById('voiceConsentDialog').open"))
    p.locator('#voiceMicType').click(); p.wait_for_function('()=>AtlasVoice.status().phase==="live"', timeout=15000)
    p.wait_for_function("()=>document.querySelectorAll('#textLog .msg-atlas').length>=1", timeout=15000)
    st = p.evaluate("()=>({text:AtlasVoice.status().textMode,mic:AtlasVoice.status().hasMicrophone,modal:document.getElementById('voiceConsentDialog').open,modals:window.__modals,input:document.getElementById('voicePanel').dataset.input,help:document.getElementById('voiceMicHelp').hidden})")
    check('mic: Continue by typing goes live in text mode, without a microphone and without a second consent dialog', st['text'] and not st['mic'] and not st['modal'] and st['modals'] == modals and st['input'] == 'text' and st['help'], st)
    row('1440x900', 'blocked microphone', True, 'inline state, typed, no second dialog')
    ctx.close()


def voice_layout(br, base, w, h):
    """A voice interview (the socket is stood in by the test; no real microphone): the same fit. ATLAS's line is in the right-rail transcript, Mute/Pause are in the dock."""
    vp = f'{w}x{h}'
    init = """(()=>{navigator.mediaDevices.getUserMedia=async()=>{const c=new AudioContext(),d=c.createMediaStreamDestination(),o=c.createOscillator();o.connect(d);o.start();return d.stream};})()"""
    ctx = br.new_context(viewport={'width': w, 'height': h}); ctx.add_init_script(init); p = ctx.new_page()
    p.on('pageerror', lambda e: ERR.append(str(e))); p.on('console', lambda m: ERR.append('console: ' + m.text) if m.type == 'error' else None)
    def on_ws(ws):
        def on(m):
            if isinstance(m, bytes): return
            d = json.loads(m)
            if d.get('type') == 'start':
                ws.send(json.dumps({'type': 'ready', 'mode': 'full', 'model': 'ATLAS', 'provider': 'ATLAS voice', 'sampleRate': 24000, 'capture': True, 'liveLedger': True, 'maxSeconds': 900, 'speakingSeconds': 600, 'message': 'ready', 'sessionId': 'ab' * 16, 'resumable': True, 'controls': ['pause', 'resume', 'repeat', 'skip', 'text']}))
                ws.send(json.dumps({'type': 'agent_text', 'text': "Hi, I'm ATLAS. What was the project, and what was your part in it?"}))
        ws.on_message(on)
    p.route_web_socket('**/api/voice', on_ws)
    p.goto(f'{base}/?as=fitvoice{w}@mantu.com'); p.wait_for_timeout(1200)
    p.locator('#voiceStart').wait_for(state='visible', timeout=8000); p.locator('#voiceStart').click()
    p.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000); p.locator('#modelConsent').check(); p.locator('#voiceConsentStart').click()
    p.wait_for_function('()=>AtlasVoice.status().phase==="live"', timeout=15000)
    p.wait_for_function("()=>/ATLAS/.test(document.getElementById('agentText').textContent)", timeout=8000); p.wait_for_timeout(700)
    all_visible(p, vp, 'voice live', {'orb': '.orb-screen', 'ATLAS line (transcript)': '#agentText', 'voice controls': '#voiceMute', 'next question': '#qualityNext', 'progress caption': '#boardTopics'})
    ns = p.evaluate(NOSCROLL); row(vp, 'voice live no page scroll', ns['ok'], str(ns)); check(f'{vp} voice live: the page does not scroll', ns['ok'], ns)
    shot(p, 'voice-live', w, h); ctx.close()


def reduced_motion(br, base):
    """prefers-reduced-motion: the orb box, the hero and the columns change size without animating."""
    ctx = br.new_context(viewport={'width': 1440, 'height': 900}, reduced_motion='reduce'); p = ctx.new_page()
    p.goto(f'{base}/?as=fitrm@mantu.com'); p.wait_for_timeout(1200)
    d = p.evaluate("()=>[['.orb-screen'],['.studio-heading'],['.orb-layout'],['#voiceStartText']].map(([s])=>getComputedStyle(document.querySelector(s)).transitionDuration)")
    check('reduced motion: no size transitions on the orb box, the hero, the columns or the start button', all(all(x in ('0s', '') for x in v.split(', ')) for v in d), d)
    ctx2 = br.new_context(viewport={'width': 1440, 'height': 900}); q = ctx2.new_page(); q.goto(f'{base}/?as=fitrm2@mantu.com'); q.wait_for_timeout(1200)
    d2 = q.evaluate("()=>getComputedStyle(document.querySelector('.orb-screen')).transitionDuration")
    check('with motion allowed the orb box eases (200-300 ms)', d2.split(',')[0].strip() in ('0.28s',), d2)
    ctx.close(); ctx2.close()


def orb_click_typed(br, base):
    ctx, p = page(br, base, 1440, 900, 'fitorb')
    p.locator('#orbActivate').click(); p.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000)
    ok = p.locator('#voiceConsentType').is_visible() and not p.locator('#voiceConsentStart').is_visible() and p.locator('#voiceConsentDialog').get_attribute('data-input') == 'text'
    check('the orb starts the typed interview when this server has no voice', ok); ctx.close()


def main():
    base_off, base_on = start_edge(False), start_edge(True)
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
            for w, h in DESKTOP: desktop(br, base_off, w, h)
            narrow(br, base_off); phone(br, base_off); orb_click_typed(br, base_off); reduced_motion(br, base_off)
            blocked_mic(br, base_on)
            for w, h in [(1280, 720), (1440, 900)]: voice_layout(br, base_on, w, h)
            br.close()
    finally:
        for p in PROCS: p.terminate()
        print('\nviewport  phase  result')
        for r in TABLE: print('%-10s %-26s %-5s %s' % r)
        print('screenshots:', SHOTS)
    check('no console errors or page errors', not ERR, ERR[:5])
    print('OK ux_fit_browser')


main()
