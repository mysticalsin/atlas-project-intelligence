"""Global polish (v2.2 W3) on the real local edge, in a real browser.

  python3 build.py && python3 deploy/cloudflare-edge/build_edge.py && cp ATLAS_Voice.html deploy/cloudflare-edge/src/atlas.html && python3 tests/w3_browser.py

Measured with getBoundingClientRect, computed styles and a contrast walk (never pixels). Covers:
  toast        one component: bottom-centre 24px, polite live region, gone after 4 s, an Undo that runs once, no focus move, in the top layer above a sheet, no overlap with the read-back at 390x844, none of the motion under reduced motion
  save chip    one status, three labels, from one source: Saved -> (server unreachable) Not saved: kept in this tab + Retry -> Saved; Settings, Workspace says the same; no footer copy, no Backup in the header or footer
  dark sheets  every dialog (static and with real content) is dark, text >= 4.5:1, nothing under 12px, at most one yellow primary, a visible focus ring
  consent      Required block distinct and larger, Optional block lighter, every optional box unticked, Start sticky with a one-line summary that follows the ticks, nothing ticked for the person
  rail         plain words, one progress caption, Details closed and holding the 12 points, no candidate / ledger / dimensions in the default rail
  how it works four steps, who sees what, no build words; opens at 390 and 1440; the architecture is under Settings, For IT (admin only)
  phone        bottom tab bar with every place reachable and 44px tall, How it works reachable, the live screen shrinks to the visible area when the keyboard opens (answer box, Send and Stop stay above it), the tab bar steps aside
  palette      Ctrl/Cmd+K in < 100 ms, keyboard-only, focus trap and return, Esc, the fixed safe list (Download my data only opens Privacy; nothing is downloaded or deleted), "?" and "G then L"
  settings     no secret name or deploy command in the admin's main view, the names under "For IT"
Screenshots go to $ATLAS_SHOTS (default /tmp/claude-501/atlas_logs/w3_shots).
"""
import json, os, re, socket, subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy/cloudflare-edge'
SHOTS = Path(os.environ.get('ATLAS_SHOTS') or '/tmp/claude-501/atlas_logs/w3_shots'); SHOTS.mkdir(parents=True, exist_ok=True)
ERR, PROCS = [], []
ADMIN = 'tony.walteur@gmail.com'
ANSWERS = [
    'We rebuilt the claims intake process for an insurance client during the pilot. Claims were bouncing between three teams and payouts were slow. I designed and built the routing model.',
    'Before, the median triage time was forty minutes per claim, measured on the team dashboard over six weeks.',
    'After the pilot the median triage time dropped to twelve minutes, according to the same dashboard over the next six weeks.']
REP = {'headline': 'Claims triage rebuilt with ML routing', 'summary': 'The consultant rebuilt claims triage for the client.', 'topics': {}, 'highlights': ['Ownership of the routing model'], 'gaps': ['No named source for the 12-minute figure'], 'follow_ups': ['Ask who owns it now'], 'status': 'model_draft',
       'facts': {'project_id': 'PRJ-2291', 'country': 'France', 'industry': 'Insurance', 'start': '2024-03', 'end': '2024-11', 'duration': '', 'team_size': 6, 'team_roles': ['Data engineer'], 'technologies': ['Python', 'Azure ML'], 'deliverables': ['Routing model'], 'service_lines': ['Data & AI']}}
NOTES = ['Zebracorp had claims bouncing between three teams, slowing payouts for customers across the region.', 'I designed and built the routing model and ran the pilot with two teams myself.',
         'We compared rules against a model, chose the model, and kept a manual fallback for edge cases.', 'Triage fell from 40 to 12 minutes per claim according to the operations dashboard.',
         'Operations dashboard export v3, before and after quarters.', 'Any insurer or service desk with manual routing and a measurable queue would benefit.']
ITEMS = [('D-001', 'problem', 'Customer problem', 'Claims were bouncing between three teams.'), ('D-002', 'stakes', 'Business stakes', 'Payouts were late and customers called twice.'),
         ('D-003', 'role', 'Your contribution', 'I designed and built the routing model.'), ('D-004', 'outcome', 'Observed outcome', 'Triage went from 40 minutes to 12 minutes per claim.')]
CONTRAST = r"""(root)=>{
 const parse=s=>{const m=s.match(/rgba?\(([^)]+)\)/);if(!m)return null;const a=m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);return {r:a[0],g:a[1],b:a[2],a:a.length>3?a[3]:1};};
 const over=(f,b)=>({r:f.r*f.a+b.r*(1-f.a),g:f.g*f.a+b.g*(1-f.a),b:f.b*f.a+b.b*(1-f.a),a:1});
 const lum=c=>{const f=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4);};return .2126*f(c.r)+.7152*f(c.g)+.0722*f(c.b);};
 const ratio=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
 const bgOf=el=>{const chain=[];for(let e=el;e;e=e.parentElement){const c=parse(getComputedStyle(e).backgroundColor);if(c&&c.a>0)chain.push(c);if(c&&c.a>=1)break;}let acc={r:16,g:16,b:17,a:1};for(let i=chain.length-1;i>=0;i--)acc=over(chain[i],acc);return acc;};
 const out=[];const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
 while(w.nextNode()){const n=w.currentNode;if(!n.textContent.trim())continue;const el=n.parentElement;if(!el||el.closest('[hidden],svg,script,style,.sr,.visually-hidden,details:not([open]) > :not(summary)'))continue;
  const s=getComputedStyle(el);if(s.visibility==='hidden'||s.display==='none'||+s.opacity===0)continue;const r=el.getBoundingClientRect();if(r.width<2||r.height<2)continue;
  if(el.closest(':disabled,[aria-disabled=true]'))continue;const fg=parse(s.color);if(!fg)continue;const acc=bgOf(el),f=fg.a<1?over(fg,acc):fg,cr=ratio(f,acc);
  const size=parseFloat(s.fontSize),bold=+s.fontWeight>=700,large=size>=24||(size>=18.66&&bold);
  if(cr<(large?3:4.5))out.push(['contrast',n.textContent.trim().slice(0,40),Math.round(cr*100)/100]);
  if(size<12)out.push(['size',n.textContent.trim().slice(0,40),size]);}
 return out;}"""


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (' ' + str(detail) if detail and not ok else ''), flush=True)
    assert ok, name + ' ' + str(detail)


def start_edge(extra=None):
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
    env = {k: v for k, v in os.environ.items() if k not in ('DATA_MODE', 'DIRECTORY_PUSH_SECRET', 'IDENTITY_SOURCE', 'ATLAS_VOICE', 'SETTINGS_KEY') and not k.startswith('DNA_')}
    proc = subprocess.Popen(['node', '--no-warnings', 'dev/local-edge.mjs', str(port)], cwd=EDGE, env={**env, 'ATLAS_ADAPTERS': 'mock', **(extra or {})}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    PROCS.append(proc); base = f'http://127.0.0.1:{port}'
    for _ in range(100):
        try: urllib.request.urlopen(base + '/__settle', timeout=1); break
        except Exception: time.sleep(.1)
    return base


def page(br, base, who, w=1440, h=900, touch=False, reduced=False, dsf=1):
    ctx = br.new_context(viewport={'width': w, 'height': h}, has_touch=touch, is_mobile=touch, device_scale_factor=dsf, reduced_motion='reduce' if reduced else 'no-preference', accept_downloads=True)
    p = ctx.new_page()
    p.on('pageerror', lambda e: ERR.append(str(e)))
    p.on('console', lambda m: ERR.append('console: ' + m.text) if m.type == 'error' and 'favicon' not in m.text else None)
    p.goto(f'{base}/?as={who}'); p.wait_for_timeout(1200)
    return ctx, p


def vis(p, sel):
    return p.evaluate("""(sel)=>{const e=document.querySelector(sel);if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&r.top>=-0.5&&r.bottom<=innerHeight+0.5&&r.left>=-0.5&&r.right<=innerWidth+0.5}""", sel)


def lum(p, sel, prop='backgroundColor'):
    return p.evaluate("""([sel,prop])=>{const c=getComputedStyle(document.querySelector(sel))[prop].match(/[\\d.]+/g).map(Number);return (0.2126*c[0]+0.7152*c[1]+0.0722*c[2])/255}""", [sel, prop])


def rect(p, sel):
    return p.evaluate("(s)=>{const r=document.querySelector(s).getBoundingClientRect();return {t:r.top,b:r.bottom,l:r.left,r:r.right,w:r.width,h:r.height}}", sel)


def shot(p, name):
    p.screenshot(path=str(SHOTS / (name + '.png')))


def go_live(p):
    p.locator('#voiceStartText').click(); p.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000); p.wait_for_timeout(300)
    p.locator('#modelConsent').check(); p.locator('#voiceConsentType').click()
    p.wait_for_function('()=>AtlasVoice.status().phase==="live"', timeout=15000)
    p.wait_for_function("()=>document.querySelectorAll('#textLog .msg').length>=1", timeout=15000); p.wait_for_timeout(1300)


def make_project(p):
    p.locator('[data-action=new-project]:visible').first.click(); p.wait_for_timeout(300)
    p.evaluate("document.getElementById('projectMore').open=true")
    for k, v in {'projectTitle': 'Claims triage alias', 'consultantName': 'Alex', 'consultantRole': 'Data engineer', 'clientName': 'Zebracorp', 'clientLocation': 'Lyon', 'n1Name': 'Sam', 'n1Email': 'sam@mantu.com'}.items():
        p.locator('#' + k).fill(v)
    p.locator('#projectForm button[type=submit]').click(); p.wait_for_timeout(400)
    p.evaluate("([n,rep])=>window.ATLAS_VOICE_BRIDGE.autoSave(window.ATLAS_VOICE_BRIDGE.context(),n,'Consultant words.',rep)", [NOTES, REP]); p.wait_for_timeout(1500)
    p.evaluate("document.querySelectorAll('dialog[open]').forEach(d=>d.close())")


def summary_event(items):
    return json.dumps({'type': 'summary', 'items': [{'detail_id': i, 'field': f, 'label': l, 'quote': q, 'status': 'reported', 'asr_unconfirmed': False, 'provenance': 'consultant_typed'} for i, f, l, q in items], 'unknowns': []})


def dialog_audit(p, did, label, primaries_max=1):
    p.evaluate("(id)=>{document.querySelectorAll('dialog[open]').forEach(d=>d.close());document.querySelectorAll('#'+id+' details').forEach(d=>d.open=true);document.getElementById(id).showModal();}", did); p.wait_for_timeout(350)
    bg, fg = p.evaluate("(id)=>{const s=getComputedStyle(document.getElementById(id)),f=c=>{const m=c.match(/[\\d.]+/g).map(Number);return (0.2126*m[0]+0.7152*m[1]+0.0722*m[2])/255};return [f(s.backgroundColor),f(s.color)]}", did)
    check(f'{label}: a dark sheet with light text', bg < .2 and fg > .7, (bg, fg))
    bad = p.evaluate(f"(id)=>({CONTRAST})(document.getElementById(id))", did)
    check(f'{label}: every visible text is at least 4.5:1 and 12px', not bad, bad[:4])
    prim = p.evaluate("(id)=>[...document.querySelectorAll('#'+id+' .btn.primary')].filter(e=>e.offsetParent&&!e.closest('[hidden]')).length", did)
    check(f'{label}: at most one yellow primary', prim <= primaries_max, prim)
    for _ in range(3):
        p.keyboard.press('Tab'); p.wait_for_timeout(60)
        if p.evaluate("!!(document.activeElement&&document.activeElement.closest('dialog'))"): break
    ring = p.evaluate("()=>{const e=document.activeElement;if(!e||e===document.body)return null;const s=getComputedStyle(e);return {w:parseFloat(s.outlineWidth),st:s.outlineStyle,c:s.outlineColor,inside:!!e.closest('dialog')}}")
    check(f'{label}: a focused control shows a ring (>= 2px, yellow)', ring and ring['inside'] and ring['st'] != 'none' and ring['w'] >= 2 and ring['c'] == 'rgb(246, 235, 75)', ring)


def toast_checks(br, base):
    ctx, p = page(br, base, 'w3toast@mantu.com')
    p.evaluate("window.__undone=0;window.ATLAS_APP.toast('Moved to Library.',{undo:()=>{window.__undone++}})"); p.wait_for_timeout(300)
    t = rect(p, '#toast'); ih = p.evaluate('innerHeight'); iw = p.evaluate('innerWidth')
    check('toast: visible, bottom-centre, 24px from the bottom edge', vis(p, '#toast') and abs((ih - t['b']) - 24) <= 1 and abs((t['l'] + t['r']) / 2 - iw / 2) <= 1, (t, ih))
    check('toast: a polite status region in the top layer, with Undo', p.evaluate("(()=>{const e=document.getElementById('toast');return e.getAttribute('aria-live')==='polite'&&e.getAttribute('role')==='status'&&e.matches(':popover-open')})()") and vis(p, '#toastUndo'))
    focus0 = p.evaluate("document.activeElement.tagName+'#'+document.activeElement.id")
    p.evaluate("window.ATLAS_APP.toast('Second message replaces the first.')"); p.wait_for_timeout(120)
    check('toast: one box (a new message replaces the old one), no Undo for a plain message, focus is not moved', p.locator('#toast').inner_text().strip() == 'Second message replaces the first.' and not vis(p, '#toastUndo') and p.evaluate("document.activeElement.tagName+'#'+document.activeElement.id") == focus0)
    p.evaluate("window.ATLAS_APP.toast('Moved to Library.',{undo:()=>{window.__undone++}})"); p.wait_for_timeout(200)
    p.locator('#toastUndo').click(); p.wait_for_timeout(200)
    check('toast: Undo runs once and the toast closes', p.evaluate('window.__undone') == 1 and not p.locator('#toast').is_visible())
    p.mouse.move(5, 5)
    p.evaluate("window.ATLAS_APP.toast('Disappears by itself.')"); p.wait_for_timeout(3300)
    still = p.locator('#toast').is_visible(); p.wait_for_timeout(1100)
    check('toast: stays about 4 seconds, then goes', still and not p.locator('#toast').is_visible())
    p.evaluate("window.ATLAS_APP.toast('Held while the pointer is on it.')"); box = rect(p, '#toast'); p.mouse.move(box['l'] + 10, box['t'] + 10); p.wait_for_timeout(4600)
    check('toast: waits while the pointer is on it', p.locator('#toast').is_visible())
    p.mouse.move(5, 5); p.wait_for_timeout(4300)
    check('toast: and goes (after the time it had left) once the pointer leaves', not p.locator('#toast').is_visible())
    # above a sheet (top layer)
    p.locator('#profileButton').click(); p.wait_for_timeout(500)
    p.evaluate("window.ATLAS_APP.toast('Visible above the Settings sheet.')"); p.wait_for_timeout(250)
    top = p.evaluate("(()=>{const e=document.getElementById('toast'),r=e.getBoundingClientRect(),x=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);return !!x&&e.contains(x)})()")
    check('toast: it is above an open sheet, not behind it', top)
    p.keyboard.press('Escape'); p.wait_for_timeout(300)
    ctx.close()
    # reduced motion: nothing animates
    ctx, p = page(br, base, 'w3toast2@mantu.com', reduced=True)
    p.evaluate("window.ATLAS_APP.toast('Quiet.')"); p.wait_for_timeout(100)
    check('toast: reduced motion removes its animation', p.evaluate("getComputedStyle(document.getElementById('toast')).animationName") == 'none')
    ctx.close()


def chip_checks(br, base):
    ctx, p = page(br, base, 'w3chip@mantu.com')
    labels = ('Saved', 'Saving…', 'Not saved: kept in this tab')
    check('chip: one save status, in the header, with one of the three labels', p.evaluate("document.querySelectorAll('#storageStatus').length") == 1 and p.locator('header #storageStatus').count() == 1 and p.locator('#storageStatus').inner_text().strip() in labels, p.locator('#storageStatus').inner_text())
    txt = p.evaluate("document.body.innerText")
    check('chip: no second save string anywhere (no strip, no footer copy, no Backup button outside Settings)', not re.search(r'Saved to ATLAS|Session only|Enable autosave|Not saved to ATLAS|Backup ↓', txt) and p.locator('footer').inner_text().find('Backup') < 0 and p.locator('header').inner_text().find('Backup') < 0)
    make_project(p)
    p.wait_for_function("()=>document.getElementById('storageStatus').textContent==='Saved'", timeout=10000)
    check('chip: Saved once the work reached ATLAS', p.locator('#storageStatus').get_attribute('data-state') == 'saved')
    # the server stops answering: the chip says so, Retry appears
    p.route('**/api/library**', lambda r: r.abort())
    p.evaluate("(()=>{const pr=ATLAS_APP.project();pr.title=pr.title+' (edited)';ATLAS_APP.save();})()")
    p.wait_for_function("()=>document.getElementById('storageStatus').textContent==='Not saved: kept in this tab'", timeout=10000)
    check('chip: Not saved: kept in this tab, with a Retry button', p.locator('#storageStatus').get_attribute('data-state') == 'unsaved' and vis(p, '#storageRetry'))
    shot(p, 'chip_unsaved')
    p.locator('#profileButton').click(); p.wait_for_timeout(300); p.locator('#stab-workspace').click(); p.wait_for_timeout(300)
    det = p.locator('#storageDetail').inner_text()
    check('chip: Settings, Workspace says the same thing (one source of state) and holds the backup', 'Not saved: kept in this tab' in det and p.locator('#backupProfile').is_visible(), det)
    p.keyboard.press('Escape'); p.wait_for_timeout(200)
    p.unroute('**/api/library**')
    p.locator('#storageRetry').click(); p.wait_for_function("()=>document.getElementById('storageStatus').textContent==='Saved'", timeout=10000)
    check('chip: after Retry it says Saved again and Retry is gone', not p.locator('#storageRetry').is_visible())
    p.locator('#storageStatus').click(); p.wait_for_timeout(500)
    check('chip: clicking it opens Settings on Workspace', p.evaluate("document.getElementById('profileDialog').open") and p.locator('#stab-workspace').get_attribute('aria-selected') == 'true')
    ctx.close()


def dialogs_checks(br, base):
    ctx, p = page(br, base, 'alex@mantu.com')
    make_project(p)
    pid = p.evaluate('window.ATLAS_APP.project().id')
    all_ids = p.evaluate("[...document.querySelectorAll('dialog')].map(d=>d.id)")
    check('sheets: the page has the sheets we expect', {'howDialog', 'profileDialog', 'projectDialog', 'reportDialog', 'recordDialog', 'insightsDialog', 'sheetDialog', 'confirmDialog', 'eraseDialog', 'nameDialog', 'voiceConsentDialog', 'voiceEndDialog'} <= set(all_ids), all_ids)
    # with real content where it matters
    p.evaluate("(id)=>window.ATLAS_VOICE_BRIDGE.showReport(id)", pid); p.wait_for_timeout(500); dialog_audit(p, 'reportDialog', 'report (with a draft)')
    p.evaluate("document.querySelectorAll('dialog[open]').forEach(d=>d.close())")
    p.locator('header [data-view=library]').click(); p.wait_for_timeout(900)
    p.locator('#openInsights').click(); p.wait_for_timeout(600); dialog_audit(p, 'insightsDialog', 'insights')
    p.evaluate("document.querySelectorAll('dialog[open]').forEach(d=>d.close())")
    p.locator('main .view:not([hidden]) button:has-text("Open reference")').first.click(); p.wait_for_timeout(700); dialog_audit(p, 'recordDialog', 'record (a reference)')
    p.evaluate("document.querySelectorAll('dialog[open]').forEach(d=>d.close())")
    p.locator('header [data-view=projects]').click(); p.wait_for_timeout(500)
    p.locator('.sheet-link').first.click(); p.wait_for_timeout(500); dialog_audit(p, 'sheetDialog', 'reference sheet')
    p.evaluate("document.querySelectorAll('dialog[open]').forEach(d=>d.close())")
    p.locator('header [data-view=stories]').click(); p.wait_for_timeout(900)
    p.locator('#inspectSource').click(); p.wait_for_timeout(400); dialog_audit(p, 'sourceDialog', 'sources')
    p.evaluate("document.querySelectorAll('dialog[open]').forEach(d=>d.close())")
    for did, lab in (('howDialog', 'How it works'), ('profileDialog', 'Settings'), ('projectDialog', 'project form'), ('sourceEditDialog', 'add evidence'), ('sourceInspectDialog', 'inspect a source'), ('metricDialog', 'measurement'),
                     ('editStoryDialog', 'edit story'), ('eraseDialog', 'delete my data'), ('nameDialog', 'name a workspace'), ('voiceConnectionDialog', 'voice connection'), ('voiceNotesDialog', 'voice notes'),
                     ('intelligenceDialog', 'story intelligence'), ('wikiReviewDialog', 'wiki review'), ('voiceConsentDialog', 'consent'), ('voiceEndDialog', 'Stop'), ('voiceRestartDialog', 'Start over')):
        dialog_audit(p, did, lab)
    p.evaluate("document.querySelectorAll('dialog[open]').forEach(d=>d.close());window.ATLAS_APP.confirm('Remove this?','This cannot be undone.',()=>0)"); p.wait_for_timeout(300)
    dialog_audit(p, 'confirmDialog', 'confirm')
    ctx.close()


def consent_checks(br, base):
    for (w, h, touch) in ((1440, 900, False), (1440, 520, False), (390, 844, True)):
        ctx, p = page(br, base, f'w3consent{w}{h}@mantu.com', w, h, touch=touch)
        p.locator('#voiceStartText').click(); p.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000); p.wait_for_timeout(400)
        tag = f'[{w}x{h}] '
        ticks = p.evaluate("['modelConsent','checkpointConsent','memoryConsent','noticeAck','captureConsent'].map(i=>[i,document.getElementById(i).checked])")
        check(tag + 'consent: nothing is ticked for the person, the optional boxes included', all(not c for _, c in ticks), ticks)
        req = p.evaluate("[...document.querySelectorAll('#voiceConsentDialog .consent-required input[type=checkbox]')].map(i=>i.id)")
        opt = p.evaluate("[...document.querySelectorAll('#voiceConsentDialog .consent-optional input[type=checkbox]')].filter(i=>i.closest('label').offsetParent).map(i=>i.id)")
        check(tag + 'consent: the required block holds only the first tick; the optional ones are in their own block', req == ['modelConsent'] and 'checkpointConsent' in opt and 'modelConsent' not in opt, (req, opt))
        s = p.evaluate("""()=>{const q=s=>getComputedStyle(document.querySelector(s));const rq=q('#voiceConsentDialog .consent-required .check'),op=q('#voiceConsentDialog .consent-optional .check');
          return {rf:parseFloat(rq.fontSize),of:parseFloat(op.fontSize),rw:+rq.fontWeight,ow:+op.fontWeight,rb:q('#voiceConsentDialog .consent-required').backgroundColor,ob:q('#voiceConsentDialog .consent-optional').backgroundColor,
          tags:[...document.querySelectorAll('#voiceConsentDialog .consent-tag')].map(e=>e.innerText.replace(/\\s+/g,' ').trim())}}""")
        check(tag + 'consent: Required reads heavier than Optional (bigger, bolder, on a card) and both are labelled', s['rf'] > s['of'] and s['rw'] > s['ow'] and s['rb'] != s['ob'] and s['tags'][0].lower().startswith('required') and any(t.lower().startswith('optional') for t in s['tags']), s)
        check(tag + 'consent: every G2 sentence is still there (private draft until Submit, 24 hours, the privacy notice, the sensitive-information line, the only-required line)',
              all(x in p.locator('#voiceConsentDialog').inner_text() for x in ('private draft', 'Submit for review', 'up to 24 hours', 'Read the privacy notice', 'Tick the first box to continue. It is the only one that is required.', 'health, religion')))
        check(tag + 'consent: Start is disabled until the first tick', p.locator('#voiceConsentStart, #voiceConsentType').evaluate_all("els=>els.filter(e=>e.offsetParent).every(e=>e.disabled)"))
        sm0 = p.locator('#consentSummary').inner_text()
        p.locator('#modelConsent').check(); p.locator('#checkpointConsent').check(); p.wait_for_timeout(150)
        sm1 = p.locator('#consentSummary').inner_text()
        check(tag + 'consent: the one-line summary follows the ticks and adds no consent of its own', 'required box means' in sm0 and 'Optional choices: none' in sm0 and sm1.startswith('You are agreeing to:') and 'private draft' in sm1 and 'Also: keeping an unfinished interview for up to 24 hours' in sm1 and 'memory' not in sm1.lower(), (sm0, sm1))
        sticky = p.evaluate("""()=>{const d=document.getElementById('voiceConsentDialog'),b=d.querySelector('.consent-bar'),r=b.getBoundingClientRect(),dr=d.getBoundingClientRect(),start=[...d.querySelectorAll('#voiceConsentStart,#voiceConsentType')].find(e=>e.offsetParent);const sr=start.getBoundingClientRect();
          d.scrollTop=0;const top=b.getBoundingClientRect().bottom;return {pos:getComputedStyle(b).position,barBottomGap:dr.bottom-r.bottom,startIn:sr.top>=dr.top&&sr.bottom<=dr.bottom&&sr.bottom<=innerHeight,overflow:d.scrollHeight>d.clientHeight+1}}""")
        check(tag + 'consent: the bar with Start is sticky and Start is on screen without scrolling', sticky['pos'] == 'sticky' and sticky['barBottomGap'] <= 2 and sticky['startIn'], sticky)
        check(tag + 'consent: one yellow primary', p.evaluate("[...document.querySelectorAll('#voiceConsentDialog .btn.primary')].filter(e=>e.offsetParent).length") == 1)
        if w == 1440 and h == 900: shot(p, 'consent_1440')
        if w == 390: shot(p, 'consent_390')
        ctx.close()


def rail_checks(br, base):
    ctx, p = page(br, base, 'w3rail@mantu.com')
    go_live(p)
    for a in ANSWERS:
        n = p.locator('#textLog .msg').count(); p.locator('#voiceTypeInput').fill(a); p.keyboard.press('Enter')
        p.wait_for_function('n=>document.querySelectorAll("#textLog .msg").length>=n+2', arg=n, timeout=20000); p.wait_for_timeout(1700)
    cap = p.locator('#boardTopics').inner_text().strip()
    check('rail: one progress caption in plain words', re.fullmatch(r'Covered so far: \d+ of 12 things a reader will want to know · not yet checked against sources', cap) is not None, cap)
    rail = p.locator('.studio-right').inner_text()
    check('rail: no "candidate", "ledger" or "dimensions" in the default rail', not re.search(r'candidate|ledger|dimension', rail, re.I), re.findall(r'.{20}(?:candidate|ledger|dimension).{20}', rail, re.I))
    heads = p.locator('#storyBoard .board-head span').all_inner_texts()
    check('rail: "Where it happened" and "Numbers you gave"', 'Where it happened' in heads and 'Numbers you gave' in heads and 'Places mentioned' not in heads and 'Figures, exactly as said' not in heads, heads)
    check('rail: no "0 of 6 topics saved" beside the heard count', not re.search(r'of 6 topics saved · ', rail))
    det = p.evaluate("(()=>{const d=document.getElementById('boardDims');return {open:d.open,summary:d.querySelector('summary span').textContent,n:d.querySelectorAll('.board-dim').length,btn:!!d.querySelector('[data-intelligence=quality]'),count:document.querySelectorAll('#storyBoard details').length}})()")
    check('rail: one "Details" disclosure, closed, holding the 12 points and the quality button', det['summary'] == 'Details' and not det['open'] and det['n'] == 12 and det['btn'], det)
    p.locator('#boardDims summary').click(); p.wait_for_timeout(300)
    check('rail: opening Details shows the 12 points and a way to the full quality details', p.locator('#boardDims .board-dim').first.is_visible() and p.locator('#boardDims [data-intelligence=quality]').is_visible())
    shot(p, 'rail_1440')
    ctx.close()


def how_checks(br, base):
    for (w, h, touch) in ((1440, 900, False), (390, 844, True)):
        ctx, p = page(br, base, f'w3how{w}@mantu.com', w, h, touch=touch)
        btn = p.locator('.how-btn'); check(f'[{w}] how it works: reachable from the header', btn.is_visible() and rect(p, '.how-btn')['h'] >= (43 if w < 1100 else 35) and rect(p, '.how-btn')['w'] >= (43 if w < 1100 else 35))
        btn.click(); p.locator('#howDialog').wait_for(state='visible', timeout=3000); p.wait_for_timeout(300)
        txt = p.locator('#howDialog').inner_text()
        check(f'[{w}] how it works: four steps and who sees what, when', all(x in txt for x in ('Talk', 'Review your words', 'Submit', 'Reused only with your permission', 'Who sees what, when')) and p.locator('#howDialog .how-steps li').count() == 4 and p.locator('#howDialog .how-who dt').count() == 3)
        check(f'[{w}] how it works: no build words, no compliance claim', not re.search(r'PersonaPlex|GPU|Hindsight|Entra|gateway|Realtime|compliant|production-ready', txt, re.I))
        r = rect(p, '#howDialog'); check(f'[{w}] how it works: the sheet fits the window and scrolls inside', r['l'] >= 0 and r['r'] <= p.evaluate('innerWidth') and r['b'] <= p.evaluate('innerHeight') + 1, r)
        shot(p, f'how_{w}')
        p.keyboard.press('Escape'); p.wait_for_timeout(200)
        p.locator('#profileButton').click(); p.wait_for_timeout(500)
        check(f'[{w}] a person who is not an admin sees no For IT tab', p.locator('#stab-forit').count() == 1 and not p.locator('#stab-forit').is_visible())
        ctx.close()
    ctx, p = page(br, base, ADMIN)
    p.locator('#profileButton').click(); p.wait_for_function("()=>!document.getElementById('stab-forit').hidden", timeout=8000)
    p.locator('#stab-forit').click(); p.wait_for_timeout(400)
    check('For IT (admin): the architecture, the downloads and the deployment notes live here', p.locator('#spane-forit #architecture svg').count() == 1 and p.locator('#downloadDiagram').is_visible() and p.locator('#downloadBrief').is_visible() and 'PersonaPlex' in p.locator('#spane-forit').inner_text())
    shot(p, 'for_it_admin')
    ctx.close()


def phone_checks(br, base):
    ctx, p = page(br, base, 'w3phone@mantu.com', 390, 844, touch=True)
    nav = p.evaluate("()=>[...document.querySelectorAll('.topbar nav button')].filter(b=>b.offsetParent).map(b=>{const r=b.getBoundingClientRect();return [b.dataset.view,Math.round(r.left),Math.round(r.right),Math.round(r.top),Math.round(r.bottom),Math.round(r.height)]})")
    check('phone: a bottom tab bar with every place reachable and each 44px tall', len(nav) == 5 and all(l >= 0 and r <= 390 and b - t >= 44 for _, l, r, t, b, _h in nav) and all(abs(b - 844) <= 12 for _, _l, _r, _t, b, _h in nav), nav)
    check('phone: the bar is fixed to the bottom edge and the page does not scroll sideways', p.evaluate("getComputedStyle(document.querySelector('.topbar nav')).position") == 'fixed' and p.evaluate('document.documentElement.scrollWidth<=innerWidth'))
    check('phone: How it works and the save chip are in the header', vis(p, '.how-btn') and vis(p, '#storageStatus') and rect(p, '.how-btn')['h'] >= 43)
    for v in ('projects', 'stories', 'library', 'bids', 'interview'):
        p.locator(f'.topbar nav [data-view={v}]').click(); p.wait_for_timeout(300)
        check(f'phone: the tab bar reaches {v}', p.evaluate("document.querySelector('nav .active').dataset.view") == v and p.evaluate("!document.getElementById('" + v + "').hidden"))
    shot(p, 'phone_tabbar')
    go_live(p)
    check('phone live: the tab bar steps aside and the screen does not scroll', p.evaluate("getComputedStyle(document.querySelector('.topbar nav')).display") == 'none' and p.evaluate("document.scrollingElement.scrollHeight<=innerHeight+1"))
    check('phone live: the answer box and Stop are on screen', vis(p, '#voiceTypeInput') and vis(p, '#voiceEnd'))
    p.locator('#voiceTypeInput').fill('Typing while the keyboard is up'); p.wait_for_timeout(200)
    # the keyboard opens: the visible area is 480px high (the real keyboard shrinks the visual viewport; the test pins it)
    p.evaluate("(()=>{const vv=window.visualViewport;Object.defineProperty(vv,'height',{configurable:true,get:()=>480});vv.dispatchEvent(new Event('resize'));})()"); p.wait_for_timeout(300)
    inp, snd, end = rect(p, '#voiceTypeInput'), rect(p, '#voiceTypeSend'), rect(p, '#voiceEnd')
    check('phone live: with the keyboard up, the answer box, Send and Stop sit inside the visible 480px', max(inp['b'], snd['b'], end['b']) <= 480 and min(inp['t'], snd['t'], end['t']) >= 0, (inp, snd, end))
    check('phone live: the latest ATLAS line is still on screen above the answer box', p.evaluate("(()=>{const m=[...document.querySelectorAll('#textLog .msg')].pop();const r=m.getBoundingClientRect();return r.height>0&&r.bottom<=480&&r.top>=0})()"))
    shot(p, 'phone_keyboard')
    p.evaluate("(()=>{const vv=window.visualViewport;delete vv.height;vv.dispatchEvent(new Event('resize'));})()"); p.wait_for_timeout(250)
    check('phone live: closing the keyboard gives the screen back', not p.evaluate("document.documentElement.classList.contains('kb-open')"))
    p.locator('#voiceEnd').click(); p.locator('#voiceEndDialog').wait_for(state='visible'); p.keyboard.press('Escape'); p.wait_for_timeout(300)
    ctx.close()
    # the toast never covers the read-back on a phone
    ctx, p = page(br, base, 'w3phone2@mantu.com', 390, 844, touch=True)
    p.evaluate("(s)=>window.dispatchEvent(new CustomEvent('atlas-session',{detail:JSON.parse(s)}))", summary_event(ITEMS)); p.wait_for_timeout(600)
    check('phone read-back: the card is on screen', vis(p, '#summaryCard') or p.locator('#summaryCard').is_visible())
    p.evaluate("window.ATLAS_APP.toast('Kept private.',{undo:()=>0})"); p.wait_for_timeout(500)
    t, s = rect(p, '#toast'), rect(p, '#summaryCard')
    check('phone read-back: the toast does not overlap the read-back card (the page makes room)', t['t'] >= s['b'] - 1 or t['b'] <= s['t'] + 1, (t, s))
    check('phone read-back: the toast is on screen and 44px Undo', t['b'] <= 844 and t['l'] >= 0 and t['r'] <= 390 and rect(p, '#toastUndo')['h'] >= 43)
    shot(p, 'phone_toast_readback')
    ctx.close()


def palette_checks(br, base):
    ctx, p = page(br, base, 'w3pal@mantu.com')
    downloads = []; p.on('download', lambda d: downloads.append(d.suggested_filename))
    p.locator('header [data-view=stories]').focus()
    for combo in ('Control+k', 'Meta+k'):
        p.keyboard.press(combo); p.wait_for_function("()=>document.getElementById('paletteDialog')&&document.getElementById('paletteDialog').open", timeout=2000); p.wait_for_timeout(120)
        ms = p.evaluate('AtlasPalette.lastOpenMs')
        check(f'palette: {combo} opens it in under 100 ms ({ms} ms) with the input focused', ms is not None and ms < 100 and p.evaluate("document.activeElement.id") == 'paletteInput', ms)
        if combo == 'Control+k':
            names = p.locator('#paletteList li[role=option]').all_inner_texts()
            for want in ('Go to Conversation', 'Go to Projects', 'Go to Stories', 'Go to Library', 'New project', 'Start interview', 'Open settings', 'Download my data'):
                check(f'palette: offers "{want}"', any(want in n for n in names), names)
            check('palette: no destructive command is offered', not re.search(r'delete|erase|remove|forget|withdraw|discard|sign out|submit|publish', ' '.join(names), re.I), names)
            check('palette: a combobox over a listbox with an active option', p.evaluate("(()=>{const i=document.getElementById('paletteInput');return i.getAttribute('role')==='combobox'&&document.getElementById('paletteList').getAttribute('role')==='listbox'&&!!document.getElementById(i.getAttribute('aria-activedescendant'))})()"))
            shot(p, 'palette_open')
            for _ in range(12): p.keyboard.press('Tab')
            check('palette: Tab stays inside the sheet (focus trap)', p.evaluate("!!document.activeElement.closest('#paletteDialog')"))
            p.keyboard.press('Escape'); p.wait_for_timeout(200)
            check('palette: Esc closes it and focus returns to where it was', not p.evaluate("document.getElementById('paletteDialog').open") and p.evaluate("document.activeElement.dataset.view") == 'stories')
        else:
            p.keyboard.press('Escape'); p.wait_for_timeout(150)
    p.keyboard.press('Control+k'); p.wait_for_timeout(150); p.keyboard.type('lib'); p.wait_for_timeout(150)
    check('palette: typing filters the list', p.locator('#paletteList li[role=option]').all_inner_texts()[0].startswith('Go to Library'))
    p.keyboard.press('Enter'); p.wait_for_timeout(500)
    check('palette: Enter runs the command (Go to Library)', p.evaluate("document.querySelector('nav .active').dataset.view") == 'library' and not p.evaluate("document.getElementById('paletteDialog').open"))
    p.keyboard.press('Control+k'); p.keyboard.type('download'); p.keyboard.press('ArrowDown'); p.keyboard.press('ArrowUp'); p.keyboard.press('Enter'); p.wait_for_timeout(900)
    check('palette: "Download my data" only opens Privacy in Settings: nothing is downloaded, nothing deleted', p.evaluate("document.getElementById('profileDialog').open") and p.locator('#stab-privacy').get_attribute('aria-selected') == 'true' and not downloads and not p.evaluate("document.getElementById('eraseDialog').open"), downloads)
    p.keyboard.press('Escape'); p.wait_for_timeout(300)
    p.keyboard.press('Control+k'); p.keyboard.type('zzzz'); p.wait_for_timeout(150)
    check('palette: a search with no match says so and Enter does nothing harmful', 'Nothing matches' in p.locator('#paletteDialog').inner_text()); p.keyboard.press('Enter'); p.wait_for_timeout(150); p.keyboard.press('Escape'); p.wait_for_timeout(200)
    p.keyboard.press('?'); p.wait_for_timeout(300)
    check('palette: "?" shows the shortcut list', p.evaluate("document.getElementById('shortcutsDialog')&&document.getElementById('shortcutsDialog').open") and 'Open this command palette' in p.locator('#shortcutsDialog').inner_text())
    p.keyboard.press('Escape'); p.wait_for_timeout(200)
    p.keyboard.press('g'); p.keyboard.press('s'); p.wait_for_timeout(300)
    check('palette: "G then S" goes to Stories', p.evaluate("document.querySelector('nav .active').dataset.view") == 'stories')
    # typing is never hijacked, but Ctrl+K still works from a text box
    p.locator('header [data-view=interview]').click(); p.wait_for_timeout(300)
    go_live(p)
    p.locator('#voiceTypeInput').focus(); p.keyboard.type('what? gg ?'); p.wait_for_timeout(150)
    check('palette: "?" and "g" typed into the answer box are text, not shortcuts', p.locator('#voiceTypeInput').input_value() == 'what? gg ?' and not p.evaluate("!!(document.getElementById('shortcutsDialog')&&document.getElementById('shortcutsDialog').open)"))
    p.keyboard.press('Control+k'); p.wait_for_timeout(200)
    check('palette: Ctrl+K opens from inside a text box, and Start interview is not offered while one is running', p.evaluate("document.getElementById('paletteDialog').open") and not any('Start interview' in t for t in p.locator('#paletteList li[role=option]').all_inner_texts()))
    p.keyboard.press('Escape'); p.wait_for_timeout(200)
    check('palette: focus returns to the answer box', p.evaluate("document.activeElement.id") == 'voiceTypeInput')
    ctx.close()


def settings_checks(br, base, base2):
    ctx, p = page(br, base, ADMIN)
    p.locator('#profileButton').click(); p.wait_for_function("()=>!document.getElementById('stab-connections').hidden", timeout=8000)
    p.locator('#stab-connections').click(); p.wait_for_selector('#connectionsPanel tr.conn-row', timeout=8000)
    main = p.locator('#spane-connections').inner_text()
    check('settings: the Connections main view names no setting and no command', not re.search(r'[A-Z]{3,}_[A-Z_]{2,}|deploy\.sh|wrangler|\.env|SETTINGS_KEY', main), re.findall(r'[A-Z]{3,}_[A-Z_]{2,}', main))
    check('settings: it says what is missing in plain words', 'What is missing' in main and ('Access details have not been added yet' in main or 'Its owner has not set it up yet' in main) and 'For IT' in main, main[:400])
    p.evaluate("document.querySelectorAll('#connectionsPanel details').forEach(d=>d.open=true)"); p.wait_for_timeout(200)
    opened = p.locator('#spane-connections').inner_text()
    check('settings: the setting names are under "For IT" (names only, never values)', re.search(r'Settings to add on the server \(names only\): [A-Z_]+', opened) is not None and not re.search(r'https?://|token=|sk-[A-Za-z0-9]', opened), opened[:300])
    shot(p, 'settings_connections')
    ctx.close()
    ctx, p = page(br, base2, ADMIN)
    p.locator('#profileButton').click(); p.wait_for_function("()=>!document.getElementById('stab-voice').hidden", timeout=8000)
    p.locator('#stab-voice').click(); p.wait_for_selector('#voiceNoStore', timeout=8000)
    vis_text = p.locator('#adminVoicePanel').inner_text()
    check('settings: the Voice tab without a stored-key secret explains it in plain words, no secret name or command', 'cannot be stored' in vis_text and 'The person who runs ATLAS needs to finish one setup step' in vis_text and not re.search(r'SETTINGS_KEY|deploy\.sh|wrangler', vis_text), vis_text[:300])
    p.evaluate("document.querySelectorAll('#adminVoicePanel details').forEach(d=>d.open=true)"); p.wait_for_timeout(150)
    check('settings: the technical text is one disclosure away ("For IT")', re.search(r'SETTINGS_KEY', p.locator('#adminVoicePanel').inner_text()) is not None)
    shot(p, 'settings_voice')
    ctx.close()


def main():
    base = start_edge()
    base2 = start_edge({'ATLAS_VOICE': 'on', 'SETTINGS_KEY': ''})
    with sync_playwright() as pw:
        br = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
        for fn in (toast_checks, chip_checks, dialogs_checks, consent_checks, rail_checks, how_checks, phone_checks, palette_checks):
            print('---', fn.__name__, flush=True); fn(br, base)
        print('--- settings_checks', flush=True); settings_checks(br, base, base2)
        check('no page errors', not ERR); print(ERR)
        br.close()


if __name__ == '__main__':
    try: main()
    finally:
        for pr in PROCS: pr.terminate()
