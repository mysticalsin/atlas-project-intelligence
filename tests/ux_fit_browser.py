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
# U2 (Tony: "I need you to add a stop interview button"): a clearly visible secondary button in the live controls row, a stop icon before its words, the Pause family (never the yellow primary)
STOP = """()=>{const e=document.querySelector('#voiceEnd'),b=document.querySelector('#voicePause');if(!e||!b)return {ok:false,why:'missing'};const c=getComputedStyle(e),q=getComputedStyle(b),r=e.getBoundingClientRect(),s=b.getBoundingClientRect();
 return {ok:true,label:e.innerText.trim(),aria:e.getAttribute('aria-label'),svg:!!e.querySelector('svg'),sameRow:e.parentElement===b.parentElement&&Math.abs(r.top-s.top)<8,bg:c.backgroundColor,pauseBg:q.backgroundColor,border:c.borderTopColor,pauseBorder:q.borderTopColor,
  yellow:/rgb\\(24[0-9], 2[0-9]{2}, [0-9]{1,2}\\)/.test(c.backgroundColor),h:Math.round(r.height),disabled:e.disabled,hidden:e.hidden}}"""
NOSCROLL = "()=>({sh:document.scrollingElement.scrollHeight,ih:innerHeight,y:scrollY,ok:document.scrollingElement.scrollHeight<=innerHeight+1&&scrollY===0})"


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (' ' + str(detail) if detail and not ok else ''), flush=True)
    assert ok, name + ' ' + str(detail)


def stop_checks(p, vp, mode, min_h=36, phone=False):
    p.mouse.move(1, 1)   # (a pointer left over the button would show its hover colour)
    if phone: p.evaluate("()=>document.querySelector('#voiceEnd').scrollIntoView({block:'center'})"); p.wait_for_timeout(200)   # a phone scrolls: reachable, not necessarily on the first screen
    v = p.evaluate(VIS, '#voiceEnd'); check(f'{vp} {mode} live: the Stop interview button is inside the window', v['ok'], v)
    st = p.evaluate(STOP)
    check(f'{vp} {mode} live: Stop interview is a visible button with a stop icon, beside Pause in the controls row', st['ok'] and st['label'] == 'Stop interview' and st['svg'] and (st['sameRow'] or phone) and not st['disabled'] and not st['hidden'] and st['aria'] == 'Stop the interview', st)
    check(f'{vp} {mode} live: it is a secondary button of the Pause family (same fill and border), never the yellow primary', st['bg'] == st['pauseBg'] and st['border'] == st['pauseBorder'] and not st['yellow'], st)
    check(f'{vp} {mode} live: it is at least {min_h}px high', st['h'] >= min_h, st)
    check(f'{vp} {mode} live: "End interview" is gone from the page text', 'End interview' not in p.evaluate("document.body.innerText"))


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
    ring = p.evaluate("()=>{const r=document.querySelector('.capture-ring').getBoundingClientRect(),c={x:r.left+r.width/2,y:r.top+r.height/2},R=r.width/2;const bad=[...document.querySelectorAll('.capture-ring b,.capture-ring small')].filter(e=>{const q=e.getBoundingClientRect();return [[q.left,q.top],[q.right,q.top],[q.left,q.bottom],[q.right,q.bottom]].some(([x,y])=>Math.hypot(x-c.x,y-c.y)>R-3)}).map(e=>e.tagName+':'+e.textContent.slice(0,14));return {bad,R}}")
    row(vp, 'start capture ring', not ring['bad'], str(ring) if ring['bad'] else ''); check(f'{vp} start: the words of the Story capture ring sit inside the circle', not ring['bad'], ring)
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
    sels = {'orb': '.orb-screen', 'ATLAS line': '#textLog .msg-atlas:last-child, #textLog .msg:last-child', 'answer box': '#voiceTypeInput', 'next question': '#boardChallenge .board-question, #qualityNext', 'progress caption': '#boardTopics'}
    sels['Stop interview'] = '#voiceEnd'
    all_visible(p, vp, 'live', sels)
    stop_checks(p, vp, 'typed')
    ns = p.evaluate(NOSCROLL); row(vp, 'live no page scroll', ns['ok'], str(ns)); check(f'{vp} live: the page does not scroll', ns['ok'], ns)
    left = p.evaluate("()=>getComputedStyle(document.querySelector('.studio-left')).visibility"); check(f'{vp} live: the left rail is folded away (no awkward narrow card)', left == 'hidden', left)
    check(f'{vp} live: focus is in the answer box', p.evaluate("document.activeElement&&document.activeElement.id")=='voiceTypeInput')
    shot(p, 'live', w, h)
    # answer until the read-back, checking the window never moves
    for i, a in enumerate(ANSWERS):
        n = p.locator('#textLog .msg').count(); t0 = time.time()
        p.locator('#voiceTypeInput').fill(a); p.keyboard.press('Enter')
        p.wait_for_function('n=>document.querySelectorAll("#textLog .msg").length>=n+2 || !document.getElementById("summaryCard").hidden', arg=n, timeout=20000)
        if i == 2:
            ns = p.evaluate(NOSCROLL); check(f'{vp} live after answers: the page still does not scroll', ns['ok'], ns)
            all_visible(p, vp, 'live after 3 answers', {'orb': '.orb-screen', 'answer box': '#voiceTypeInput', 'next question': '#boardChallenge .board-question, #qualityNext', 'progress caption': '#boardTopics', 'ATLAS line': '#textLog .msg-atlas:last-child, #textLog .msg:last-child', 'Stop interview': '#voiceEnd'})
            p.wait_for_timeout(500)
            cl = p.evaluate("()=>{const m=[...document.querySelectorAll('#textLog .msg')],a=m.filter(x=>x.classList.contains('msg-atlas')).at(-1),s=getComputedStyle(a),lum=c=>{const v=c.match(/[\\d.]+/g).map(Number);return (0.2126*v[0]+0.7152*v[1]+0.0722*v[2])/255};let o=1;for(let e=a;e&&e.id!=='textLog';e=e.parentElement)o*=+getComputedStyle(e).opacity;return {opacity:o,lum:lum(s.color),size:parseFloat(s.fontSize),tag:m.at(-1)===a||m.at(-2)===a}}")
            check(f'{vp} live: ATLAS\'s current line is full contrast (opacity 1, light text) and 15px or more', cl['opacity'] == 1 and cl['lum'] > 0.85 and cl['size'] >= 15 and cl['tag'], cl)
            newest = p.evaluate(VIS, '#textLog .msg:last-child'), p.evaluate(VIS, '#textLog .msg:nth-last-child(2)')
            check(f'{vp} live: the newest two lines are whole inside the conversation box (no clipped half line)', all(x['ok'] for x in newest), newest)
            one = p.evaluate("()=>[...document.querySelectorAll('#qualityNext,#boardChallenge .board-question')].filter(e=>e.getBoundingClientRect().width>8&&getComputedStyle(e).clip==='auto').length")
            check(f'{vp} live: ONE next question in the rail (not the same question twice), and the board no longer holds a second one', one == 1 and p.evaluate("!document.querySelector('#storyBoard #boardChallenge')"), one)
            shot(p, 'live-after-answers', w, h)
        if not p.locator('#summaryCard').is_hidden(): break
        p.wait_for_timeout(max(900, 1700 - int((time.time() - t0) * 1000)))
    p.locator('#summaryCard').wait_for(state='visible', timeout=25000); p.wait_for_timeout(900)
    # ---- read-back
    all_visible(p, vp, 'read-back', {'title': '#summaryTitle', 'first item': '#summaryItems li:first-child', 'Confirm': '#summaryConfirm'})
    rb = p.evaluate("()=>{const s=document.getElementById('summaryScroll').getBoundingClientRect(),c=document.getElementById('summaryConfirm').getBoundingClientRect(),el=document.getElementById('summaryScroll');return {scrollBottom:s.bottom,confirmTop:c.top,over:el.scrollHeight>el.clientHeight,hint:getComputedStyle(el,'::after').content}}")
    check(f'{vp} read-back: Confirm sits below the scrolling list, never over an item', rb['confirmTop'] >= rb['scrollBottom'] - 1, rb)
    check(f'{vp} read-back: a "More below" hint exists for the items below the edge (browsers with scroll-driven animations)', 'More below' in rb['hint'] or not p.evaluate("CSS.supports('animation-timeline','scroll()')"), rb)
    cov = p.evaluate("()=>{const i=document.querySelector('#summaryItems li:first-child').getBoundingClientRect(),c=document.getElementById('summaryConfirm').getBoundingClientRect();return {itemBottom:i.bottom,confirmTop:c.top}}")
    check(f'{vp} read-back: the first item is not hidden behind the Confirm bar', cov['itemBottom'] <= cov['confirmTop'] + 1, cov)
    ns = p.evaluate(NOSCROLL); row(vp, 'read-back no page scroll', ns['ok'], str(ns)); check(f'{vp} read-back: the page does not scroll', ns['ok'], ns)
    inview = p.evaluate("()=>{const s=document.getElementById('summaryScroll').getBoundingClientRect();return [...document.querySelectorAll('#summaryItems .summary-item')].filter(e=>{const r=e.getBoundingClientRect();return r.top>=s.top-1&&r.bottom<=s.bottom+1}).length}")
    need = 1 if h < 760 else 2 if h < 880 else 3
    check(f'{vp} read-back (W1 case study): at least {need} quotes are whole on the first screen, inside the scrolling case study (no ~230px inner box)', inview >= need, inview)
    blocks = p.evaluate("()=>[...document.querySelectorAll('#summaryItems .story-block-title')].map(e=>e.textContent)")
    check(f'{vp} read-back: the quotes are grouped under Challenge / Approach / Your contribution / Outcome headings', blocks[:1] == ['Challenge'] and set(blocks) <= {'Challenge', 'Approach', 'Your contribution', 'Outcome', 'Evidence and fit'}, blocks)
    cut = p.evaluate("()=>{const b=document.getElementById('textLog'),t=b.getBoundingClientRect().top;return [...b.querySelectorAll('.msg')].filter(m=>{const r=m.getBoundingClientRect();return b.offsetParent&&r.top<t-0.5&&r.bottom>t+8}).length}")
    check(f'{vp} read-back: no conversation message is cut at the top of its box', cut == 0, cut)
    shot(p, 'readback', w, h)
    # after Confirm the card shows "Saved as a private draft" next to the conversation: nothing may overlap (the humane suite clicks Pause here)
    p.locator('#summaryConfirm').click(); p.wait_for_function("()=>/Saved as a private draft/.test(document.getElementById('summarySaved').innerText)", timeout=15000); p.wait_for_timeout(500)
    ov = p.evaluate("()=>{const r=i=>document.getElementById(i).getBoundingClientRect(),a=r('textLog'),b=r('voiceTypeWrap'),c=r('voiceControls'),d=r('summaryCard');const vis=['textLog','voiceTypeWrap','voiceControls'].every(i=>document.getElementById(i).offsetParent);return {vis,cardBottom:d.bottom,logTop:a.top,logBottom:a.bottom,wrapTop:b.top,wrapBottom:b.bottom,ctlTop:c.top}}")
    check(f'{vp} after Confirm: the conversation, the answer box and the controls do not overlap the card or each other', (not ov['vis']) or (ov['cardBottom'] <= ov['logTop'] + 1 and ov['logBottom'] <= ov['wrapTop'] + 1 and ov['wrapBottom'] <= ov['ctlTop'] + 1), ov)
    sub = p.evaluate(VIS, '#summarySubmit'); check(f'{vp} after Confirm: Submit for review is visible and not clipped by the card', sub['ok'], sub)
    shot(p, 'confirmed', w, h)
    # W1: Submit is a moment, not a footer line
    p.locator('#summarySubmit').click(); p.wait_for_function("()=>{const d=document.getElementById('submitSheet');return d&&d.open}", timeout=5000); p.wait_for_timeout(500)
    sh = p.evaluate("()=>{const d=document.getElementById('submitSheet').getBoundingClientRect(),bs=[...document.querySelectorAll('#submitSheet .actions .btn')].map(b=>b.getBoundingClientRect());return {d:[d.left,d.top,d.right,d.bottom],iw:innerWidth,ih:innerHeight,btns:bs.map(b=>[b.left,b.top,b.right,b.bottom]),focus:document.activeElement.id,title:document.getElementById('submitTitle').innerText}}")
    d = sh['d']; inside = d[0] >= 0 and d[1] >= 0 and d[2] <= sh['iw'] and d[3] <= sh['ih'] and all(b[0] >= d[0] and b[2] <= d[2] and b[1] >= d[1] and b[3] <= d[3] for b in sh['btns'])
    check(f'{vp} submit: the "Sent for review" sheet is inside the window, its buttons inside it, focus on View status', inside and sh['title'] == 'Sent for review' and sh['focus'] == 'submitView', sh)
    shot(p, 'submitted', w, h)
    p.keyboard.press('Escape'); p.wait_for_timeout(250)
    ns = p.evaluate(NOSCROLL); check(f'{vp} after the sheet closes: the page does not scroll and the card stays (no reset to the home screen)', ns['ok'] and p.evaluate("!document.getElementById('summaryCard').hidden"), ns)
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
    ns = p.evaluate(NOSCROLL); row('390x844', 'live no page scroll', ns['ok'], str(ns)); check('390x844 live (W1): the interview fits the phone, the page does not scroll', ns['ok'], ns)
    check('390x844 live (W1): the answer box and Stop interview are on the screen without scrolling', p.evaluate(VIS, '#voiceTypeInput')['ok'] and p.evaluate(VIS, '#voiceEnd')['ok'])
    stop_checks(p, '390x844', 'typed', min_h=43.5, phone=True); p.evaluate('scrollTo(0,0)')
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
    all_visible(p, vp, 'voice live', {'orb': '.orb-screen', 'ATLAS line (transcript)': '#agentText', 'voice controls': '#voiceMute', 'Stop interview': '#voiceEnd', 'next question': '#boardChallenge .board-question, #qualityNext', 'progress caption': '#boardTopics'})
    stop_checks(p, vp, 'voice')
    ns = p.evaluate(NOSCROLL); row(vp, 'voice live no page scroll', ns['ok'], str(ns)); check(f'{vp} voice live: the page does not scroll', ns['ok'], ns)
    al = p.evaluate("()=>{const c=e=>{const r=document.querySelector(e).getBoundingClientRect();return r.left+r.width/2},o=c('.orb-screen');return {meters:Math.abs(c('.orb-meters')-o),inStrip:!!document.querySelector('.orb-bottom-actions #soundHelpToggle')}}")
    check(f'{vp} voice live: the level meters are centred on the column and the sound-check link sits with the other links in the bottom strip', al['meters'] < 3 and al['inStrip'], al)
    v = p.evaluate(VIS, '#soundHelpToggle'); check(f'{vp} voice live: the sound-check link is inside the window', v['ok'], v)
    shot(p, 'voice-live', w, h)
    p.locator('#soundHelpToggle').click(); p.wait_for_timeout(200)
    v = p.evaluate(VIS, '#soundHelpPanel'); check(f'{vp} voice live: the sound-check panel opens inside the window', v['ok'], v)
    shot(p, 'voice-live-soundcheck', w, h); ctx.close()


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

# U2: nothing near-white may sit in or on the orb box. A disabled <button> got a light-grey fill from ui.css (`button:disabled`), so for the seconds ATLAS
# was connecting the whole round orb button showed as a pale disc behind the particles. Every element that overlaps the orb box (and its ::before/::after)
# is checked for a near-white background, gradient, border, outline or shadow, in the connecting phase and while live; the canvas itself must keep its idle band.
ORB_WINDOWS = [(1440, 900, 1), (2250, 1260, 1.6)]   # a plain laptop, and a 2250x1260 CSS-px window at devicePixelRatio 1.6 (80 % page zoom on a retina screen)
ORB_WHITE = """()=>{const box=document.querySelector('.orb-screen').getBoundingClientRect(),out=[];
 const v=s=>(s||'').match(/[\\d.]+/g)||[],lit=s=>{const a=v(s).map(Number);return a.length>=3&&a[0]>=225&&a[1]>=225&&a[2]>=225&&(a.length<4||a[3]>=.25)};
 for(const e of document.body.querySelectorAll('*')){const r=e.getBoundingClientRect();if(r.width<2||r.height<2||r.right<=box.left||r.left>=box.right||r.bottom<=box.top||r.top>=box.bottom)continue;
  if(e.closest('dialog')||e.closest('[hidden]'))continue; /* a dialog is a light surface on purpose */
  for(const ps of [null,'::before','::after']){const c=getComputedStyle(e,ps);if(ps&&(c.content==='none'||c.content==='normal'))continue;if(c.display==='none'||c.visibility==='hidden')continue;
   const bad=[lit(c.backgroundColor)&&'background',/rgba?\\(2[2-5]\\d, 2[2-5]\\d, 2[2-5]\\d/.test(c.backgroundImage)&&'gradient',c.borderTopStyle!=='none'&&parseFloat(c.borderTopWidth)>0&&lit(c.borderTopColor)&&'border',
    c.outlineStyle!=='none'&&parseFloat(c.outlineWidth)>0&&lit(c.outlineColor)&&'outline',/rgba?\\(2[2-5]\\d, 2[2-5]\\d, 2[2-5]\\d/.test(c.boxShadow)&&'shadow'].filter(Boolean);
   if(bad.length)out.push((e.id?'#'+e.id:e.tagName.toLowerCase()+'.'+String(e.className&&e.className.baseVal!==undefined?e.className.baseVal:e.className).trim().split(/\\s+/).join('.'))+(ps||'')+' '+bad.join('+'))}}
 return out}"""
ORB_CANVAS = """()=>{const cv=document.querySelector('#orbActivate canvas');if(!cv||!cv.width)return -1;const g=cv.getContext('2d',{willReadFrequently:true}),w=cv.width,h=cv.height,d=g.getImageData(0,0,w,h).data;let n=0,t=0;
 for(let y=0;y<h;y+=2)for(let x=0;x<w;x+=2){const i=(y*w+x)*4;t++;if(d[i+3]>200&&d[i]>235&&d[i+1]>235&&d[i+2]>235)n++}return n/t}"""
ORB_BAND = 0.06   # measured: 0.4 % of the canvas for the idle orb, at most 2.7 % while live (electrons, the nucleus and the nearest particles are white); a pale disc would be 30 % or more


def orb_no_white(br, base, w, h, dsf, path):
    """path: 'start' (Start -> consent -> live) or 'resume' (the Resume dialog -> live), a scripted voice socket that holds `ready` so the connecting phase can be inspected."""
    vp = f'{w}x{h}@{dsf} {path}'
    init = """(()=>{navigator.mediaDevices.getUserMedia=async()=>{const c=new AudioContext(),d=c.createMediaStreamDestination(),o=c.createOscillator();o.connect(d);o.start();return d.stream};})()"""
    ctx = br.new_context(viewport={'width': w, 'height': h}, device_scale_factor=dsf, color_scheme='light'); ctx.add_init_script(init); p = ctx.new_page()
    p.on('pageerror', lambda e: ERR.append(str(e))); p.on('console', lambda m: ERR.append('console: ' + m.text) if m.type == 'error' else None)
    held = {}
    def on_ws(ws):
        def on(m):
            if not isinstance(m, bytes) and json.loads(m).get('type') == 'start': held['ws'] = ws; held['resumed'] = json.loads(m).get('resume') is not None
        ws.on_message(on)
    p.route_web_socket('**/api/voice', on_ws)
    if path == 'resume':
        def boot(route):
            resp = route.fetch(); body = resp.json(); body['resumable'] = {'sessionId': 'ab' * 16, 'savedAt': int(time.time() * 1000) - 60000, 'expiresAt': int(time.time() * 1000) + 86400000}
            route.fulfill(response=resp, json=body)
        p.route('**/api/bootstrap', boot)
    p.goto(f'{base}/?as=fitwhite{w}{path}@mantu.com'); p.wait_for_timeout(1500)
    idle = p.evaluate(ORB_CANVAS)
    check(f'{vp} idle: nothing near-white in the orb box, and the canvas keeps its idle band', p.evaluate(ORB_WHITE) == [] and 0 <= idle <= ORB_BAND, (p.evaluate(ORB_WHITE), idle))
    if path == 'resume':
        p.locator('#voiceResumeDialog').wait_for(state='visible', timeout=8000); p.locator('#voiceResumeDialog').get_by_role('button', name='Resume').click()
    else:
        p.locator('#voiceStart').click(); p.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000); p.locator('#modelConsent').check(); p.locator('#voiceConsentStart').click()
    p.wait_for_function("()=>document.getElementById('voicePanel').dataset.orbState==='connecting' && !!window.AtlasVoice", timeout=8000)
    for _ in range(50):
        if held.get('ws'): break
        p.wait_for_timeout(100)
    check(f'{vp} connecting: the start request was sent and the orb is waiting', bool(held.get('ws')))
    p.wait_for_timeout(400)
    dis = p.evaluate("()=>{const e=document.querySelector('#orbActivate'),c=getComputedStyle(e);return {disabled:e.disabled,bg:c.backgroundColor,bgi:c.backgroundImage}}")
    bad = p.evaluate(ORB_WHITE)
    check(f'{vp} connecting: the orb button is disabled and paints nothing (no pale disc behind the particles)', dis['disabled'] and dis['bg'] in ('rgba(0, 0, 0, 0)', 'transparent') and dis['bgi'] == 'none', dis)
    check(f'{vp} connecting: no element in the orb box has a near-white background, border, outline or shadow', bad == [], bad)
    shot(p, f'orb-connecting-{path}-dsf{dsf}', w, h)
    ready = {'type': 'ready', 'mode': 'full', 'model': 'ATLAS', 'provider': 'ATLAS voice', 'sampleRate': 24000, 'capture': True, 'liveLedger': True, 'maxSeconds': 900, 'speakingSeconds': 600, 'message': 'ready', 'sessionId': 'ab' * 16, 'resumable': True,
             'controls': ['pause', 'resume', 'repeat', 'text'], **({'resumed': True} if held['resumed'] else {})}
    held['ws'].send(json.dumps(ready)); held['ws'].send(json.dumps({'type': 'agent_text', 'text': "Hi, I'm ATLAS. What was the project, and what was your part in it?"}))
    p.wait_for_function('()=>AtlasVoice.status().phase==="live"', timeout=15000)
    ratios, bad = [], []
    for _ in range(8):
        p.wait_for_timeout(250); ratios.append(p.evaluate(ORB_CANVAS)); bad += p.evaluate(ORB_WHITE)
    focus = p.evaluate("()=>{const e=document.querySelector('#orbActivate');return {focusVisible:e.matches(':focus-visible'),outline:getComputedStyle(e).outlineStyle}}")
    check(f'{vp} live: no element in the orb box has a near-white background, border, outline or shadow', not bad, bad[:4])
    check(f'{vp} live: the canvas near-white pixel ratio stays inside the normal band (<= {ORB_BAND}); measured {max(ratios):.3f}', all(0 <= r <= ORB_BAND for r in ratios), ratios)
    check(f'{vp} live: the orb button shows no focus ring (it was not focused by the person)', not focus['focusVisible'] or focus['outline'] == 'none', focus)
    row(f'{vp}', 'orb has no pale disc', True, f'canvas near-white <= {max(ratios):.3f}')
    ctx.close()


def main():
    base_off, base_on = start_edge(False), start_edge(True)
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
            for w, h in DESKTOP: desktop(br, base_off, w, h)
            narrow(br, base_off); phone(br, base_off); orb_click_typed(br, base_off); reduced_motion(br, base_off)
            blocked_mic(br, base_on)
            for w, h, dsf in ORB_WINDOWS:
                for path in ('start', 'resume'): orb_no_white(br, base_on, w, h, dsf, path)
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
