"""The interview, the read-back as a case study and the Submit moment (v2.2 W1) on the real local edge, in a real browser.

  python3 build.py && cp ATLAS_Voice.html deploy/cloudflare-edge/src/atlas.html && python3 tests/w1_browser.py

Measured with getBoundingClientRect and computed styles, never pixels. Covers:
  picker       with a staffing row: Start, then one click on the row reaches the consent step (two clicks, no typed field); the Opp ID is filled from the row and the opening
               does not ask for it; "Something else" is a three-field form with the rest folded away and inline messages (no browser bubble)
  live         the project drawer is closed (the chip is the project), the first ATLAS reply is two bubbles, no message is cut at the top of the conversation, a sent turn shows at once,
               thinking dots, an empty Enter is a shake and a hint; Stop and consent are dark sheets with ONE yellow primary
  read-back    Challenge / Approach / Your contribution / Outcome (+ a before/after strip) built only from the quotes, a provenance line per block, Correct and Keep private on each quote,
               a kept-private line stays visible as "Kept private. Not used.", "n of N reviewed", the sticky bar, at least three quotes on the first screen
  submit       a dark sheet within 300 ms, announced as a status, focus on View status, five steps with the first filled, Esc closes, the page does not reset, no footer toast
  first run    the three-step checklist and the privacy line; the fictional example opens as a labelled overlay and closing leaves the workspace untouched
  phone        390x844: the live interview does not scroll the page; the answer box and Stop are on screen; all five nav places fit
  reduced motion  none of the new motion runs
"""
import json, os, socket, subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy/cloudflare-edge'
ERR, PROCS = [], []
ADMIN = 'tony.walteur@gmail.com'
CSV = 'project_id,consultant_email,manager_email,manager_name,project_title,end_date\nPRJ-2291,%s,sam@mantu.com,Sam Lead,Claims triage rebuild,2026-11-20\nPRJ-1810,%s,sam@mantu.com,Sam Lead,Grid analytics rollout,2026-03-01\nPRJ-1744,%s,,,Fraud rules refresh,2025-12-12\n' % (ADMIN, ADMIN, ADMIN)
ANSWERS = [
    'We rebuilt the claims intake process for an insurance client during the pilot. Claims were bouncing between three teams and payouts were slow. I designed and built the routing model.',
    'Before, the median triage time was forty minutes per claim, measured on the team dashboard over six weeks.',
    'After the pilot the median triage time dropped to twelve minutes, according to the same dashboard over the next six weeks.',
    'The claims team of eight people used it daily and the operations lead owned it after my handover. We chose rules instead of a learned model because auditors needed to read every decision.',
    "I don't know of any other evidence. The limit is that the pilot covered only one region.",
    'It would suit insurers with a fragmented claims queue. It would not fit a company without a central triage team.']


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (' ' + str(detail) if detail and not ok else ''), flush=True)
    assert ok, name + ' ' + str(detail)


def start_edge():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
    env = {k: v for k, v in os.environ.items() if k not in ('DATA_MODE', 'DIRECTORY_PUSH_SECRET', 'IDENTITY_SOURCE', 'ATLAS_VOICE') and not k.startswith('DNA_')}
    proc = subprocess.Popen(['node', '--no-warnings', 'dev/local-edge.mjs', str(port)], cwd=EDGE, env={**env, 'ATLAS_ADAPTERS': 'mock'}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    PROCS.append(proc); base = f'http://127.0.0.1:{port}'
    for _ in range(100):
        try: urllib.request.urlopen(base + '/__settle', timeout=1); break
        except Exception: time.sleep(.1)
    return base


def page(br, base, who, w=1440, h=900, touch=False, reduced=False, dsf=1):
    ctx = br.new_context(viewport={'width': w, 'height': h}, has_touch=touch, is_mobile=touch, device_scale_factor=dsf, reduced_motion='reduce' if reduced else 'no-preference')
    p = ctx.new_page()
    p.on('pageerror', lambda e: ERR.append(str(e)))
    p.on('console', lambda m: ERR.append('console: ' + m.text) if m.type == 'error' else None)
    p.goto(f'{base}/?as={who}'); p.wait_for_timeout(1200)
    return ctx, p


def vis(p, sel):
    return p.evaluate("""(sel)=>{const e=document.querySelector(sel);if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&r.top>=-0.5&&r.bottom<=innerHeight+0.5&&r.left>=-0.5&&r.right<=innerWidth+0.5}""", sel)


def lum(p, sel, prop='backgroundColor'):
    return p.evaluate("""([sel,prop])=>{const c=getComputedStyle(document.querySelector(sel))[prop].match(/[\\d.]+/g).map(Number);return (0.2126*c[0]+0.7152*c[1]+0.0722*c[2])/255}""", [sel, prop])


def go_live(p, answer_first=False):
    p.locator('#modelConsent').check(); p.locator('#voiceConsentType').click()
    p.wait_for_function('()=>AtlasVoice.status().phase==="live"', timeout=15000)
    p.wait_for_function("()=>document.querySelectorAll('#textLog .msg').length>=1", timeout=15000); p.wait_for_timeout(1300)


def cut_messages(p):
    return p.evaluate("""()=>{const b=document.getElementById('textLog'),t=b.getBoundingClientRect().top;return [...b.querySelectorAll('.msg')].filter(m=>{const r=m.getBoundingClientRect();return r.top<t-0.5&&r.bottom>t+8}).length}""")


ITEMS = [
    ('D-001', 'problem', 'Customer problem', 'Claims were bouncing between three teams.'),
    ('D-002', 'stakes', 'Business stakes', 'Payouts were late and customers called twice.'),
    ('D-003', 'intervention', 'What changed', 'I built a routing model for the intake queue.'),
    ('D-004', 'decision', 'Decision and trade-off', 'We chose rules over a learned model so auditors could read each decision.'),
    ('D-005', 'contribution', 'Personal contribution', 'I owned the routing model and the rules; Sam owned the dashboard.'),
    ('D-006', 'adoption', 'Use and ownership', 'The claims team of eight used it daily.'),
    ('D-007', 'outcome', 'Observed outcome', 'Triage went from 40 minutes to 12 minutes per claim.'),
    ('D-008', 'evidence', 'Supporting artifact', 'The team dashboard shows it.')]


def summary_event(items):
    return json.dumps({'type': 'summary', 'items': [{'detail_id': i, 'field': f, 'label': l, 'quote': q, 'status': 'reported', 'asr_unconfirmed': False, 'provenance': 'consultant_typed'} for i, f, l, q in items], 'unknowns': []})


def phone_checks(br, base):
    ctx, p = page(br, base, 'w1phone@mantu.com', 390, 844, touch=True)
    nav = p.evaluate("()=>[...document.querySelectorAll('.topbar nav button')].filter(b=>b.offsetParent).map(b=>{const r=b.getBoundingClientRect();return [b.textContent.trim(),Math.round(r.left),Math.round(r.right)]})")
    check('390: all five places are on screen in the nav (Bids is not clipped)', len(nav) == 5 and all(r <= 390 and l >= 0 for _, l, r in nav) and nav[-1][0] == 'Bids', nav)
    p.locator('#voiceStartText').click(); p.locator('#voiceConsentDialog').wait_for(state='visible'); p.wait_for_timeout(300)
    go_live(p)
    ns = p.evaluate("()=>({sh:document.scrollingElement.scrollHeight,ih:innerHeight,y:scrollY})")
    check('390x844 live: the page does not scroll (the interview fits the phone)', ns['sh'] <= ns['ih'] + 1 and ns['y'] == 0, ns)
    check('390x844 live: the answer box and Stop interview are on the screen', vis(p, '#voiceTypeInput') and vis(p, '#voiceEnd'))
    h = p.evaluate("()=>['#voiceEnd','#voicePause','#voiceRepeat','#voiceTypeSend'].map(s=>{const e=document.querySelector(s);return e&&e.offsetParent?Math.round(e.getBoundingClientRect().height):44})")
    check('390x844 live: touch targets are 44px', all(x >= 43 for x in h), h)
    check('390x844 live: the conversation shows whole messages', cut_messages(p) == 0)
    for a in ANSWERS[:3]:
        n = p.locator('#textLog .msg').count(); p.locator('#voiceTypeInput').fill(a); p.keyboard.press('Enter')
        p.wait_for_function('n=>document.querySelectorAll("#textLog .msg").length>=n+2', arg=n, timeout=20000); p.wait_for_timeout(1900)
    ns = p.evaluate("()=>({sh:document.scrollingElement.scrollHeight,ih:innerHeight})"); check('390x844 live after answers: still no page scroll', ns['sh'] <= ns['ih'] + 1, ns)
    check('390x844 live: Stop and the answer box are still on screen', vis(p, '#voiceEnd') and vis(p, '#voiceTypeInput'))
    ctx.close()
    # the read-back on a phone: Confirm is always on screen
    ctx, p = page(br, base, 'w1phone2@mantu.com', 390, 844, touch=True)
    p.evaluate("(s)=>window.dispatchEvent(new CustomEvent('atlas-session',{detail:JSON.parse(s)}))", summary_event(ITEMS)); p.wait_for_timeout(500)
    check('390 read-back: Confirm summary is on screen without scrolling the page', vis(p, '#summaryConfirm'))
    h = p.evaluate("()=>Math.round(document.getElementById('summaryConfirm').getBoundingClientRect().height)"); check('390 read-back: Confirm is a 44px target', h >= 44, h)
    ctx.close()


def main(br, base):
    # ------------------------------------------------------------------ picker, first run, project form
    ctx, p = page(br, base, ADMIN)
    r = p.evaluate("(CSV)=>ATLAS_APP.libraryApi('/staffing/import',{method:'POST',body:{csv:CSV}}).then(r=>r.staffed,e=>'ERR '+e.message)", CSV)
    check('the staffing rows were imported for this person', r == 3, r)
    p.reload(); p.wait_for_timeout(1500)
    txt = p.evaluate("document.body.innerText")
    check('the hero says "a story worth telling", never "a real conversation"', 'a story worth telling' in txt and 'real conversation' not in txt and 'Guided by ATLAS' in txt)
    fr = p.locator('#firstRun').inner_text()
    check('first run: three steps and the privacy line, shown before the first Submit', all(s in fr for s in ('Pick your project', 'Have the interview', 'Check it and submit', 'Only you see it until you press Submit.')) and '20–30 minutes' in fr, fr)
    check('first run: one yellow start button on the first screen', vis(p, '#voiceStartText') and lum(p, '#voiceStartText') > .7)
    p.locator('#voiceStartText').click()
    p.locator('#projectPickDialog').wait_for(state='visible', timeout=8000)
    rows = p.locator('.pick-row').all_inner_texts()
    check('the picker is titled "Which project?" and lists the staffing rows with their ID and end date', p.locator('#projectPickTitle').inner_text() == 'Which project?' and len(rows) == 3 and 'Claims triage rebuild' in rows[0] and 'PRJ-2291' in rows[0] and '2026-11-20' in rows[0], rows)
    p.locator('#projectPickSearch').fill('grid'); p.wait_for_timeout(150)
    check('search narrows the list', p.locator('.pick-row').count() == 1 and 'Grid analytics' in p.locator('.pick-row').inner_text())
    p.locator('#projectPickSearch').fill('prj-1744'); check('search finds an ID', p.locator('.pick-row').count() == 1)
    p.locator('#projectPickSearch').fill('')
    sheet_bg = lum(p, '#projectPickDialog'); check('the picker is a dark sheet', sheet_bg < .2, sheet_bg)
    # "Something else": three fields, the rest folded away, inline messages
    p.locator('#projectPickOther').click(); p.locator('#projectDialog').wait_for(state='visible'); p.wait_for_timeout(300)
    fields = p.evaluate("""()=>[...document.querySelectorAll('#projectForm input,#projectForm select,#projectForm textarea')].filter(e=>e.checkVisibility()&&e.type!=='hidden').map(e=>e.id)""")
    check('"Something else": exactly three fields are shown (name, role, stage); the rest is under "More details (optional, ATLAS fills these from the interview)"', fields == ['projectTitle', 'consultantRole', 'projectStage'] and p.locator('#projectMore summary').inner_text().startswith('More details (optional, ATLAS fills these from the interview)') and not p.evaluate("document.getElementById('projectMore').open"), fields)
    d = p.evaluate("()=>{const r=document.getElementById('projectDialog').getBoundingClientRect(),s=document.getElementById('projectDialog');return {top:r.top,bottom:r.bottom,ih:innerHeight,scroll:s.scrollHeight>s.clientHeight+1}}")
    check('the form fits the window without scrolling on first open', d['top'] >= 0 and d['bottom'] <= d['ih'] and not d['scroll'], d)
    p.locator('#projectForm button[type=submit]').click(); p.wait_for_timeout(200)
    err = p.locator('#projectTitleError')
    check('empty Save: an inline message under the field, focus on it, no browser bubble', err.is_visible() and 'name' in err.inner_text().lower() and p.evaluate("document.activeElement.id") == 'projectTitle' and p.evaluate("document.getElementById('projectForm').noValidate") and p.evaluate("document.getElementById('projectTitle').getAttribute('aria-invalid')") == 'true')
    check('the dialog is dark with one yellow primary', lum(p, '#projectDialog') < .2 and lum(p, '#projectForm button[type=submit]') > .7)
    p.locator('#projectDialog .close').click(); p.wait_for_timeout(400)
    p.locator('#voiceStartText').click()          # click 1: Start
    p.locator('#projectPickDialog').wait_for(state='visible'); p.locator('.pick-row').first.click()   # click 2: the staffing row
    p.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000); p.wait_for_timeout(300)
    check('with a staffing row, Start then the row reaches the consent step: two clicks and nothing typed', p.locator('#voiceConsentDialog').is_visible() and p.evaluate("ATLAS_VOICE_BRIDGE.context().project.title") == 'Claims triage rebuild')
    opp = p.evaluate("ATLAS_VOICE_BRIDGE.context().project.oppId"); title = p.evaluate("ATLAS_VOICE_BRIDGE.context().project.title")
    check('the row filled the project: title and Opp ID', title == 'Claims triage rebuild' and opp == 'PRJ-2291', (title, opp))
    check('consent: a dark sheet, ONE yellow primary', lum(p, '#voiceConsentDialog') < .2 and p.evaluate("[...document.querySelectorAll('#voiceConsentDialog .btn.primary')].filter(e=>e.offsetParent).length") == 1)
    go_live(p)
    check('live: the project drawer is closed and the chip names the project', not vis(p, '#studioProjectDrawer') and 'Claims triage rebuild' in p.locator('#fitProject').inner_text() and vis(p, '#fitProject'))
    bubbles = p.locator('#textLog .msg-atlas').all_inner_texts()
    check('the opening is two bubbles, greeting then question, and it does not ask for the Opp ID', len(bubbles) == 2 and 'ATLAS' in bubbles[0] and 'opportunity' not in ' '.join(bubbles).lower() and 'Opp ID' not in ' '.join(bubbles) and p.locator('#textLog .msg').nth(1).get_attribute('class').find('is-question') >= 0, bubbles)
    check('the conversation shows whole messages (nothing cut at its top edge)', cut_messages(p) == 0)
    check('the status line under the orb is one line, and the private-draft line is the only other status', p.locator('.orb-caption').is_visible())
    # micro-feedback
    p.locator('#voiceTypeInput').fill(''); p.keyboard.press('Enter'); p.wait_for_timeout(150)
    check('an empty Enter is a shake and a hint; nothing is sent', 'Type a few words' in p.locator('#voiceTypeNote').inner_text() and p.evaluate("document.getElementById('voiceTypeForm').classList.contains('is-nudged')") and p.locator('#textLog .msg').count() == 2)
    p.locator('#voiceTypeInput').fill(ANSWERS[0]); p.keyboard.press('Enter'); p.wait_for_timeout(60)
    check('a sent turn is in the conversation at once', p.locator('#textLog .msg-you').count() == 1 and ANSWERS[0][:30] in p.locator('#textLog .msg-you').inner_text())
    p.wait_for_function('()=>document.querySelectorAll("#textLog .msg-atlas").length>=3', timeout=20000); p.wait_for_timeout(500)
    check('after a reply the conversation shows whole messages and the newest line is on screen', cut_messages(p) == 0 and vis(p, '#textLog .msg:last-child'))
    # Stop sheet
    p.locator('#voiceEnd').click(); p.locator('#voiceEndDialog').wait_for(state='visible'); p.wait_for_timeout(250)
    st = p.evaluate("()=>({title:document.getElementById('voiceEndTitle').innerText,primary:document.getElementById('voiceEndConfirm').innerText,secondary:document.getElementById('voiceEndDiscard').innerText,buttons:[...document.querySelectorAll('#voiceEndDialog .btn, #voiceEndDialog .quiet')].filter(e=>e.offsetParent).map(e=>e.innerText.trim()),primaries:[...document.querySelectorAll('#voiceEndDialog .btn.primary')].filter(e=>e.offsetParent).length})")
    check('the Stop sheet: title "Stop the interview?", one primary, one discard, Cancel', st['title'] == 'Stop the interview?' and st['primary'] == 'Stop and review what you said' and st['secondary'] == 'Discard everything' and st['primaries'] == 1 and 'Discard and start over' not in st['buttons'] and 'Cancel' in st['buttons'], st)
    check('the Stop sheet is dark with a yellow primary', lum(p, '#voiceEndDialog') < .2 and lum(p, '#voiceEndConfirm') > .7)
    p.locator('#voiceEndDiscard').click(); p.wait_for_timeout(900)
    check('after the interview a clean start screen: no frozen conversation, the clock is back at 00:00', not p.locator('#textLog').is_visible() and p.locator('#voiceTimer').inner_text() == '00:00' and not p.locator('#storyBoard').is_visible())
    ctx.close()

    # ------------------------------------------------------------------ the fictional example (a person with no project yet: the link is in the left rail)
    ctx, p = page(br, base, 'w1example@mantu.com')
    before = p.evaluate("ATLAS_APP.profile().projects.map(x=>x.id).join()")
    p.locator('#studioSample').click(); p.locator('#exampleDialog').wait_for(state='visible', timeout=3000)
    ex = p.evaluate("()=>({banner:document.querySelector('.example-banner').textContent,titles:[...document.querySelectorAll('#exampleBody .story-block-title')].map(e=>e.textContent),strip:(document.querySelector('#exampleBody .story-numbers')||{textContent:''}).textContent})")
    check('the example opens as a labelled "Fictional example" overlay with the finished case study (four blocks and a before/after strip)', 'Fictional example' in ex['banner'] and ex['strip'].find('42 minutes')>=0 and ex['titles'][:4] == ['Challenge', 'Approach', 'Your contribution', 'Outcome'] and '26 minutes' in ex['strip'], ex)
    check('the example overlay is dark and its close button is on screen', lum(p, '#exampleDialog') < .2 and vis(p, '#exampleClose'))
    p.keyboard.press('Escape'); p.wait_for_timeout(300)
    after = p.evaluate("ATLAS_APP.profile().projects.map(x=>x.id).join()")
    check('closing the example returns to the workspace untouched (no project was added)', not p.locator('#exampleDialog').is_visible() and before == after)
    ctx.close()

    # ------------------------------------------------------------------ the read-back as a case study (events into the page, no interview needed)
    ctx, p = page(br, base, 'w1readback@mantu.com')
    now = p.evaluate("Date.now()")
    p.evaluate("(t)=>window.dispatchEvent(new CustomEvent('atlas-quality',{detail:{type:'user_text',item_id:'user-typed-1',text:'We rebuilt intake. Claims were bouncing between three teams.',provenance:'consultant_typed'}}))", now)
    p.evaluate("(s)=>window.dispatchEvent(new CustomEvent('atlas-session',{detail:JSON.parse(s)}))", summary_event(ITEMS)); p.wait_for_timeout(700)
    cs = p.evaluate("""()=>({titles:[...document.querySelectorAll('#summaryItems .story-block-title')].map(e=>e.textContent),strip:(document.querySelector('#summaryItems .story-numbers')||{innerText:''}).innerText,
      prov:[...document.querySelectorAll('#summaryItems .story-block .story-prov')].map(e=>e.innerText),items:document.querySelectorAll('#summaryItems .summary-item').length,
      correct:document.querySelectorAll('#summaryItems [data-action=correct]').length,keep:document.querySelectorAll('#summaryItems [data-action=withhold]').length,progress:document.getElementById('summaryProgress').innerText})""")
    check('read-back: Challenge, Approach, Your contribution, Outcome, Evidence and fit, in order', cs['titles'] == ['Challenge', 'Approach', 'Your contribution', 'Outcome', 'Evidence and fit'], cs['titles'])
    check('read-back: a before/after strip from "from 40 minutes to 12 minutes"', 'BEFORE' in cs['strip'].upper() and '40 minutes' in cs['strip'] and '12 minutes' in cs['strip'] and 'AFTER' in cs['strip'].upper(), cs['strip'])
    check('read-back: every block says where its words came from, and the one said at a known time names it', all(x.startswith('From your words') for x in cs['prov']) and any(', ' in x for x in cs['prov'][:1]), cs['prov'])
    check('read-back: every quote keeps Correct and Keep private', cs['items'] == 8 and cs['correct'] == 8 and cs['keep'] == 8)
    # nothing but quotes and fixed labels
    allowed = {q for _, _, _, q in ITEMS} | {l for _, _, l, _ in ITEMS} | {'Challenge', 'Approach', 'Your contribution', 'Outcome', 'Evidence and fit', 'Before', 'After', 'From your words', 'Correct', 'Keep private', 'typed by you', '→'}
    texts = p.evaluate("""()=>{const out=[];const w=document.createTreeWalker(document.getElementById('summaryItems'),NodeFilter.SHOW_TEXT);for(let n;n=w.nextNode();){const t=n.textContent.replace(/\\s+/g,' ').trim();if(t)out.push(t)}return out}""")
    stray = [t for t in texts if t.strip('“” ·') not in allowed and not t.startswith('From your words') and not t.strip('“” ·').upper() in ('BEFORE', 'AFTER') and not t.startswith('· ') and not any(t in q for _, _, _, q in ITEMS)]  # a figure is an exact span of a quote
    check('read-back: nothing on screen is paraphrased or invented (every text is a quote or a fixed label)', not stray, stray)
    # layout
    lay = p.evaluate("""()=>{const sc=document.getElementById('summaryScroll').getBoundingClientRect(),inview=[...document.querySelectorAll('#summaryItems .summary-item')].filter(e=>{const r=e.getBoundingClientRect();return r.top>=sc.top-1&&r.bottom<=sc.bottom+1}).length,
      c=document.getElementById('summaryConfirm').getBoundingClientRect(),card=document.getElementById('summaryCard').getBoundingClientRect(),
      ns=document.scrollingElement.scrollHeight<=innerHeight+1;return {scrollH:Math.round(sc.height),inview,confirmTop:Math.round(c.top),confirmBottom:Math.round(c.bottom),ih:innerHeight,cardH:Math.round(card.height),ns}}""")
    check('read-back: full height (no ~230px inner box), at least three quotes on the first screen, Confirm always on screen, the page does not scroll', lay['scrollH'] >= 300 and lay['inview'] >= 3 and lay['confirmBottom'] <= lay['ih'] and lay['ns'], lay)
    check('read-back: the sticky bar is a yellow primary', lum(p, '#summaryConfirm') > .7)
    # n of N reviewed follows what has been read
    p.wait_for_timeout(1000); first = p.locator('#summaryProgress').inner_text()
    check('"n of N reviewed": what stayed on the first screen counts, the rest does not yet', first.endswith('of 8 reviewed') and 2 <= int(first.split()[0]) <= 5, first)
    p.evaluate("()=>{const s=document.getElementById('summaryScroll');s.scrollTop=s.scrollHeight}"); p.wait_for_function("n=>parseInt(document.getElementById('summaryProgress').innerText)>=n+3", arg=int(first.split()[0]), timeout=8000)
    prog = p.locator('#summaryProgress').inner_text(); check('"n of N reviewed" grows as the rest is read', int(prog.split()[0]) >= int(first.split()[0]) + 3 and prog.endswith('of 8 reviewed'), prog)
    # Keep private: stays as an excluded line
    p.locator('#summaryItems [data-detail=D-002] [data-action=withhold]').click(); p.wait_for_timeout(200)
    check('Keep private: the line waits for the server ("Keeping that private…") and its buttons go', 'Keeping that private' in p.locator('#summaryItems [data-detail=D-002]').inner_text() and p.locator('#summaryItems [data-detail=D-002] button').count() == 0)
    p.evaluate("(s)=>window.dispatchEvent(new CustomEvent('atlas-session',{detail:JSON.parse(s)}))", summary_event([i for i in ITEMS if i[0] != 'D-002'])); p.wait_for_timeout(300)
    kept = p.locator('#summaryItems .is-kept')
    check('Keep private: the line stays in its block as "Kept private. Not used." with its words gone', kept.count() == 1 and 'Kept private. Not used.' in kept.inner_text() and 'customers called twice' not in p.evaluate("document.getElementById('summaryItems').innerText") and 'Business stakes' in kept.inner_text())
    ctx.close()

    # ------------------------------------------------------------------ the whole way to Submit
    ctx, p = page(br, base, 'w1submit@mantu.com')
    p.locator('#voiceStartText').click(); p.locator('#voiceConsentDialog').wait_for(state='visible'); p.wait_for_timeout(300)
    check('without staffing rows or projects Start goes straight to consent (no picker to wade through)', p.locator('#projectPickDialog[open]').count() == 0)
    go_live(p)
    for i, a in enumerate(ANSWERS):
        n = p.locator('#textLog .msg').count(); p.locator('#voiceTypeInput').fill(a); p.keyboard.press('Enter')
        p.wait_for_function('n=>document.querySelectorAll("#textLog .msg").length>=n+2 || !document.getElementById("summaryCard").hidden', arg=n, timeout=20000)
        if not p.locator('#summaryCard').is_hidden(): break
        p.wait_for_timeout(1900)
    p.locator('#summaryCard').wait_for(state='visible', timeout=25000); p.wait_for_timeout(900)
    check('the read-back replaces the conversation: full column, Confirm on screen, no inner scroll box under 300px', p.evaluate("document.getElementById('summaryScroll').getBoundingClientRect().height") >= 300 and vis(p, '#summaryConfirm'))
    p.locator('#summaryConfirm').click(); p.wait_for_function("()=>/Saved as a private draft/.test(document.getElementById('summarySaved').innerText)", timeout=15000); p.wait_for_timeout(500)
    check('after Confirm the saved story keeps the column and Submit is the one primary', vis(p, '#summarySubmit') and p.evaluate("document.getElementById('summaryScroll').getBoundingClientRect().height") >= 250)
    t0 = time.time(); p.locator('#summarySubmit').click()
    p.wait_for_function("()=>{const d=document.getElementById('submitSheet');return d&&d.open}", timeout=3000); took = time.time() - t0
    check('Submit: the sheet is on screen within 300 ms of the click (timing includes the browser round trip)', took < 1.0, took)
    sh = p.evaluate("""()=>({title:document.getElementById('submitTitle').innerText,line:document.getElementById('submitLine').innerText,status:!!document.querySelector('#submitSheet [role=status]'),focus:document.activeElement.id,
      steps:[...document.querySelectorAll('#submitSheet .submit-steps li')].map(l=>[l.innerText.trim(),l.dataset.state]),buttons:[...document.querySelectorAll('#submitSheet .actions .btn')].map(b=>b.innerText),
      box:(()=>{const r=document.getElementById('submitSheet').getBoundingClientRect();return [r.left,r.top,r.right,r.bottom,innerWidth,innerHeight]})()})""")
    check('the sheet says "Sent for review" and who can see it', sh['title'] == 'Sent for review' and sh['line'] == 'Your N+1 and reviewers can now see this. Nothing else has left your private draft.', sh)
    check('five steps, the first one filled', [s[0] for s in sh['steps']] == ['Submitted', 'Quality review', 'N+1 review', 'Approved', 'Published or held'] and sh['steps'][0][1] == 'done' and all(s[1] != 'done' for s in sh['steps'][1:]), sh['steps'])
    check('announced as a status, focus on View status, View status and Start another', sh['status'] and sh['focus'] == 'submitView' and sh['buttons'] == ['View status', 'Start another'], sh)
    b = sh['box']; check('the sheet is centred and inside the window', b[0] >= 0 and b[2] <= b[4] and b[1] >= 0 and b[3] <= b[5] and abs((b[0] + b[2]) / 2 - b[4] / 2) < 2, b)
    check('the sheet is dark, the check is drawn (an SVG stroke), the primary is yellow', lum(p, '#submitSheet') < .2 and p.evaluate("getComputedStyle(document.querySelector('#submitSheet .submit-tick')).strokeDasharray") != 'none' and lum(p, '#submitView') > .7)
    check('no footer toast competes with it, and the page did not reset to the home screen', not p.evaluate("document.getElementById('toast').classList.contains('show')") and p.evaluate("!document.getElementById('summaryCard').hidden"))
    p.keyboard.press('Escape'); p.wait_for_timeout(300)
    check('Esc closes the sheet', not p.evaluate("document.getElementById('submitSheet').open"))
    check('the first-run checklist is gone once something was submitted', not vis(p, '#firstRun') and p.evaluate("document.getElementById('voicePanel').dataset.firstrun") == 'false')
    ctx.close()

    # ------------------------------------------------------------------ reduced motion: none of the new motion runs
    ctx, p = page(br, base, 'w1reduced@mantu.com', reduced=True)
    p.locator('#voiceStartText').click(); p.locator('#voiceConsentDialog').wait_for(state='visible'); p.wait_for_timeout(300); go_live(p)
    check('reduced motion: both opening bubbles are there at once, no rise animation', p.locator('#textLog .msg-atlas').count() == 2 and p.evaluate("getComputedStyle(document.querySelector('#textLog .msg')).animationName") == 'none')
    p.locator('#voiceTypeInput').fill(''); p.keyboard.press('Enter'); p.wait_for_timeout(100)
    check('reduced motion: the empty-Enter hint is shown without a shake', 'Type a few words' in p.locator('#voiceTypeNote').inner_text() and p.evaluate("getComputedStyle(document.getElementById('voiceTypeForm')).animationName") == 'none')
    p.evaluate("(s)=>window.dispatchEvent(new CustomEvent('atlas-session',{detail:{type:'evidence_draft',id:'e1',revision:1}}))")
    p.evaluate("()=>{window.AtlasJourneyUI.showSheet()}"); p.wait_for_timeout(100)
    check('reduced motion: the submit check is simply there (no drawing animation)', p.evaluate("getComputedStyle(document.querySelector('#submitSheet .submit-ring')).animationName") == 'none' and p.evaluate("getComputedStyle(document.querySelector('#submitSheet .submit-ring')).strokeDashoffset") in ('0px', '0'))
    ctx.close()

    phone_checks(br, base)


if __name__ == '__main__':
    with sync_playwright() as pw:
        br = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
        base = start_edge()
        try:
            main(br, base)
        finally:
            for pr in PROCS: pr.terminate()
            br.close()
    bad = [e for e in ERR if 'Failed to load resource' not in e]
    check('no console errors', not bad, bad[:3])
    print('W1 browser suite passed')
