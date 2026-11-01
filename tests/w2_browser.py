"""Reviewer queue, one-screen review, owner journey strip, readable story headings and calm loading (v2.2 W2) on the real local edge, in a real browser.

  python3 build.py && cp ATLAS_Voice.html deploy/cloudflare-edge/src/atlas.html && python3 tests/w2_browser.py

Three people really finish a typed interview and press Submit (so the queue holds real evidence records); then:
  journey     no strip before there is a project; with one, seven steps in the drawn order with the current one marked from data; after Submit "View status" lands on the
              Library strip with In review current and focus on it; a step opens its surface; no raw id anywhere on the page; 44px targets, 12px text, no sideways scroll at 390
  queue       the reviewer sees the count on the Library tab before opening it, "Waiting for you (3)" first in the Library, oldest first, the project's name and the consultant's name,
              age and a quality chip; an owner never sees a queue
  review      one screen: each claim with its words on the left, Validate / Request changes / Amend on the right; J and K move; A then U writes nothing; A alone writes exactly one
              approve bound to revision and hash; R needs a reason, can be undone, then writes one clarify; typing never triggers a key; Amend asks for confirmation and makes a new revision
  headings    the story paper's Challenge / Approach / Outcome labels are at least 4.5:1 on the paper and at least 12px
  loading     shimmer rows while the Library and the queue load; a failure says "We couldn't load this. Your work is safe." with a Try again that works; no raw browser wording
"""
import json, os, re, socket, subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy/cloudflare-edge'
ERR, PROCS = [], []
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-', re.I)
ANSWERS = [
    'We rebuilt the claims intake process for an insurance client during the pilot. Claims were bouncing between three teams and payouts were slow. I designed and built the routing model.',
    'Before, the median triage time was 40 minutes per claim, measured on the team dashboard over six weeks.',
    'After the pilot the median triage time dropped from 40 minutes to 12 minutes, according to the same dashboard over the next six weeks.',
    'The claims team of eight people used it daily and the operations lead owned it after my handover. We chose rules instead of a learned model because auditors needed to read every decision.',
    "I don't know of any other evidence. The limit is that the pilot covered only one region.",
    'It would suit insurers with a fragmented claims queue. It would not fit a company without a central triage team.']
LOAD_FAIL = 'We couldn’t load this. Your work is safe.'


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


def page(br, base, who, w=1440, h=900, touch=False, reduced=False, pre=None):
    ctx = br.new_context(viewport={'width': w, 'height': h}, has_touch=touch, is_mobile=touch, reduced_motion='reduce' if reduced else 'no-preference')
    p = ctx.new_page()
    p.on('pageerror', lambda e: ERR.append(str(e)))
    p.on('console', lambda m: ERR.append('console: ' + m.text) if m.type == 'error' and 'net::ERR_FAILED' not in m.text else None)  # ERR_FAILED is the request this suite aborts on purpose
    if pre: pre(p)
    p.goto(f'{base}/?as={who}'); p.wait_for_timeout(1200)
    return ctx, p


def vis(p, sel):
    return p.evaluate("""(sel)=>{const e=document.querySelector(sel);if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&r.top>=-0.5&&r.bottom<=innerHeight+0.5&&r.left>=-0.5&&r.right<=innerWidth+0.5}""", sel)


def make_project(p, title, who):
    p.evaluate("window.ATLAS_APP.newProject()"); p.wait_for_timeout(300)
    p.evaluate("document.getElementById('projectMore').open=true"); p.locator('#projectTitle').fill(title); p.locator('#consultantName').fill(who)
    p.locator('#projectForm button[type=submit]').click(); p.wait_for_timeout(700)


def interview(p):
    p.locator('#voiceStartText').click(); p.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000)
    p.locator('#modelConsent').check(); p.locator('#voiceConsentType').click()
    p.wait_for_function('()=>AtlasVoice.status().phase==="live"', timeout=15000)
    p.wait_for_function("()=>document.querySelectorAll('#textLog .msg').length>=1", timeout=15000); p.wait_for_timeout(800)
    for a in ANSWERS:
        n = p.locator('#textLog .msg').count()
        p.locator('#voiceTypeInput').fill(a); p.keyboard.press('Enter')
        p.wait_for_function('n=>document.querySelectorAll("#textLog .msg").length>=n+2 || !document.getElementById("summaryCard").hidden', arg=n, timeout=20000)
        if not p.locator('#summaryCard').is_hidden(): break
        p.wait_for_timeout(1800)
    p.locator('#summaryCard').wait_for(state='visible', timeout=25000); p.wait_for_timeout(600)
    p.locator('#summaryConfirm').click(); p.wait_for_function("()=>/Saved as a private draft/.test(document.getElementById('summarySaved').innerText)", timeout=15000); p.wait_for_timeout(400)


def submit(p):
    p.locator('#summarySubmit').click(); p.wait_for_function("()=>{const d=document.getElementById('submitSheet');return d&&d.open}", timeout=8000)
    # the library story of this interview follows the same click: wait until it has left its private draft
    p.wait_for_function("()=>{const q=ATLAS_APP.project();return q&&q.library&&q.library.status&&q.library.status!=='draft'}", timeout=15000)


def person(br, base, who, title, name):
    ctx, p = page(br, base, who)
    make_project(p, title, name); interview(p); submit(p)
    return ctx, p


def contrast(p, sel):
    return p.evaluate("""(sel)=>{const lin=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)},L=c=>0.2126*lin(c[0])+0.7152*lin(c[1])+0.0722*lin(c[2]),rgb=s=>s.match(/[\\d.]+/g).map(Number);
      const bg=e=>{for(let x=e;x;x=x.parentElement){const c=rgb(getComputedStyle(x).backgroundColor);if(c.length<4||c[3]>0.95)return c;}return [255,255,255];};
      return [...document.querySelectorAll(sel)].map(e=>{const f=rgb(getComputedStyle(e).color),b=bg(e),a=L(f),c=L(b),r=(Math.max(a,c)+.05)/(Math.min(a,c)+.05);return {t:e.textContent.trim().slice(0,40),ratio:Math.round(r*100)/100,px:parseFloat(getComputedStyle(e).fontSize)};});}""", sel)


def main(br, base):
    reqs = []
    # ------------------------------------------------------------------ two seeds and the owner finish a real interview; each submits
    for who, title, name in (('w2seed0@mantu.com', 'Pricing engine migration', 'Sam Rivera'), ('w2seed1@mantu.com', 'Contact-centre analytics', 'Noor Haddad')):
        ctx, p = person(br, base, who, title, name); p.wait_for_timeout(500); ctx.close()
    ctx, p = page(br, base, 'w2owner@mantu.com')
    check('before there is a project there is no journey strip on the home screen', not vis(p, '#journeyHome .journey') and p.locator('#journeyHome .journey').count() == 0)
    make_project(p, 'Claims triage rebuild', 'Alex Martin')
    p.wait_for_function("()=>document.querySelector('#journeyHome .journey')", timeout=8000)
    steps = p.evaluate("()=>[...document.querySelectorAll('#journeyHome .journey-step')].map(s=>[s.querySelector('.journey-label').textContent,s.dataset.state])")
    check('with a project the home screen shows seven steps in the order the workflow was drawn', [s[0] for s in steps] == ['Project', 'Interview', 'Read-back', 'Submitted', 'In review', 'Approved', 'Published or held'], steps)
    check('the project is done and the interview is the current step, from data', steps[0][1] == 'done' and steps[1][1] == 'current' and all(s[1] == 'todo' for s in steps[2:]), steps)
    check('exactly one step is marked current for assistive tech', p.locator('#journeyHome [aria-current=step]').count() == 1)
    interview(p)
    p.locator('#summarySubmit').click(); p.wait_for_function("()=>{const d=document.getElementById('submitSheet');return d&&d.open}", timeout=8000)
    p.wait_for_function("()=>{const q=ATLAS_APP.project();return q&&q.library&&q.library.status&&q.library.status!=='draft'}", timeout=15000)
    p.locator('#submitView').click(); p.wait_for_timeout(300)
    check('"View status" opens the Library', not p.locator('#library').evaluate('e=>e.hidden'))
    p.wait_for_function("()=>{const b=document.querySelector('#journeyLibrary [aria-current=step] .journey-label');return b&&b.textContent==='In review'}", timeout=10000)
    p.wait_for_timeout(500)
    steps = p.evaluate("()=>[...document.querySelectorAll('#journeyLibrary .journey-step')].map(s=>s.dataset.state)")
    check('after Submit the strip in the Library has four steps done and In review current', steps == ['done', 'done', 'done', 'done', 'current', 'todo', 'todo'], steps)
    check('the strip names the project, not an id', p.locator('#journeyLibrary .journey-name').inner_text() == 'Claims triage rebuild')
    check('focus lands on the current step', p.evaluate("()=>{const a=document.activeElement;return !!a&&a.closest('#journeyLibrary')&&a.getAttribute('aria-current')==='step'}"))
    check('the strip is on screen after landing', vis(p, '#journeyLibrary .journey-steps'))
    check('no raw id (UUID) anywhere in the Library or the strip', not UUID.search(p.evaluate("document.getElementById('library').innerText")))
    pick = p.evaluate("()=>[...document.querySelectorAll('#workflowPick option')].map(o=>o.textContent)")
    check('the evidence picker names projects or says "Interview evidence", never an id', all(not UUID.search(o) for o in pick), pick)
    m = p.evaluate("""()=>[...document.querySelectorAll('#journeyLibrary button')].map(b=>{const r=b.getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)]})""")
    check('every step is a 44px target', all(w >= 44 and h >= 44 for w, h in m), m)
    sizes = [x['px'] for x in contrast(p, '#journeyLibrary .journey-label, #journeyLibrary .journey-name, #journeyLibrary .journey-summary, #journeyLibrary .journey-note')]
    check('strip text is at least 12px', min(sizes) >= 12, sizes)
    p.locator('#journeyLibrary [data-step=interview] button').click(); p.wait_for_timeout(400)
    check('a step opens its surface: Interview opens the Conversation', not p.locator('#interview').evaluate('e=>e.hidden') and p.locator('#library').evaluate('e=>e.hidden'))
    # the conversation panel keeps the finished interview on screen until a reload, so the home strip is checked on a fresh load
    p.reload(); p.wait_for_function("()=>document.querySelector('#journeyHome [data-step=review][data-state=current]')", timeout=12000)
    check('on a fresh home screen the strip says In review, from the workflow state', p.locator('#journeyHome .journey-name').inner_text() == 'Claims triage rebuild' and vis(p, '#journeyHome .journey-steps'))
    check('the strip does not push the start button off the first screen at 1440x900', vis(p, '#voiceStartText') and vis(p, '#journeyHome .journey-steps'))
    ctx2, p2 = page(br, base, 'w2owner@mantu.com', 1280, 720); p2.wait_for_function("()=>document.querySelector('#journeyHome [data-step=review]')", timeout=12000); p2.wait_for_timeout(600)
    check('nor at 1280x720 (the orb gives up the height)', vis(p2, '#voiceStartText') and vis(p2, '#journeyHome .journey-steps') and vis(p2, '.orb-screen'))
    ctx2.close()
    p.locator('#journeyHome [data-step=review] button').click(); p.wait_for_timeout(400)
    check('In review on the home strip opens the Library', not p.locator('#library').evaluate('e=>e.hidden'))
    # an owner never sees the queue
    check('an owner has no review queue and no count on the Library tab', not vis(p, '#reviewQueue') and p.locator('header nav [data-view=library] .nav-count').count() == 0)
    q = p.evaluate("ATLAS_APP.libraryApi('/evidence/queue').then(r=>r.items.length)")
    check('the queue endpoint gives an owner an empty list', q == 0, q)
    # ---- the story paper headings
    p.evaluate("ATLAS_APP.selectProject(ATLAS_APP.ownProjects()[0].id);ATLAS_APP.switchView('stories')"); p.wait_for_timeout(600)
    if p.locator('#emptyStories:not([hidden]) [data-action=draft]').count():
        p.locator('#emptyStories [data-action=draft]').click(); p.wait_for_timeout(1000)
    hs = contrast(p, '#storyPaper .paper-body>h3')
    check('the story paper has its section headings', len(hs) >= 4, hs)
    check('every heading label is at least 4.5:1 on the paper and at least 12px', all(h['ratio'] >= 4.5 and h['px'] >= 12 for h in hs), hs)
    ps = contrast(p, '#storyPaper .paper-body p')
    check('the paper\'s body text keeps its contrast', all(x['ratio'] >= 4.5 for x in ps), [x for x in ps if x['ratio'] < 4.5][:3])
    ctx.close()

    # ------------------------------------------------------------------ the reviewer
    ctx, p = page(br, base, 'reviewer@mantu.com')
    p.on('request', lambda r: reqs.append((r.method, r.url, r.post_data)) if '/review' in r.url else None)
    p.wait_for_function("()=>document.querySelector('header nav [data-view=library] .nav-count')", timeout=10000)
    check('the count is on the Library tab on the home screen, before opening it', p.locator('header nav [data-view=library] .nav-count').inner_text() == '3')
    p.locator('[data-view=library]').first.click(); p.wait_for_selector('.rq-row', timeout=10000)
    check('the Library opens on "Waiting for you (3)", the first block after the heading', p.locator('#rqTitle').inner_text() == 'Waiting for you (3)' and p.evaluate("()=>document.querySelector('#library .page-intro').nextElementSibling.id")=='reviewQueue')
    rows = p.evaluate("""()=>[...document.querySelectorAll('.rq-row')].map(r=>({name:r.querySelector('.rq-name').textContent,who:r.querySelector('.rq-who').textContent,age:r.querySelector('.rq-age').textContent,chip:r.querySelector('.rq-chip').textContent,h:Math.round(r.getBoundingClientRect().height)}))""")
    check('oldest first, each row names the project and the consultant', [r['name'] for r in rows] == ['Pricing engine migration', 'Contact-centre analytics', 'Claims triage rebuild'] and [r['who'].split(' · ')[0] for r in rows] == ['Sam Rivera', 'Noor Haddad', 'Alex Martin'], rows)
    check('each row has an age and a quality chip, and is at least 44px high', all(r['age'] and r['chip'] and r['h'] >= 44 for r in rows), rows)
    check('no raw id in the queue', not UUID.search(p.evaluate("document.getElementById('reviewQueue').innerText")))
    sizes = [x['px'] for x in contrast(p, '#reviewQueue .rq-name,#reviewQueue .rq-who,#reviewQueue .rq-age,#reviewQueue .rq-chip,#reviewQueue .rq-sub,#reviewQueue kbd')]
    check('queue text is at least 12px', min(sizes) >= 12, sizes)
    # ---- one screen
    p.locator('.rq-row').first.click(); p.locator('#reviewScreen[open]').wait_for(timeout=5000); p.wait_for_function("()=>document.querySelectorAll('#rvClaims .rv-claim').length>0", timeout=8000)
    check('the review is one screen: claims on the left, the decision on the right', p.evaluate("""()=>{const c=document.getElementById('rvClaims').getBoundingClientRect(),d=document.querySelector('.rv-decide').getBoundingClientRect();return c.right<=d.left+1&&c.width>d.width}"""))
    check('the title is the project and the position is 1 of 3', p.locator('#rvTitle').inner_text() == 'Pricing engine migration' and p.locator('#rvPos').inner_text() == '1 of 3')
    n = p.locator('#rvClaims .rv-claim').count()
    check('every claim shows the consultant\'s own words', n >= 4 and all(len(t) > 10 for t in p.locator('#rvClaims .rv-stmt').all_inner_texts()), n)
    check('Validate, Request changes and Amend are on the right', p.locator('#rvApprove').inner_text().startswith('Validate') and p.locator('#rvChanges').inner_text().startswith('Request changes') and p.locator('#rvAmend').inner_text().startswith('Amend'))
    bt = p.evaluate("()=>['#rvApprove','#rvChanges','#rvAmend','.rv-step','.rv-back'].map(s=>Math.round(document.querySelector(s).getBoundingClientRect().height))")
    check('the controls are at least 44px', all(h >= 44 for h in bt), bt)
    dark = p.evaluate("()=>{const c=getComputedStyle(document.getElementById('reviewScreen')).backgroundColor.match(/[\\d.]+/g).map(Number);return (c[0]+c[1]+c[2])/3}")
    check('the review screen is dark Mantu', dark < 40, dark)
    sizes = [x['px'] for x in contrast(p, '#reviewScreen .rv-stmt,#reviewScreen .rv-tags,#reviewScreen .rv-type,#reviewScreen .rv-meta,#reviewScreen .rv-bind,#reviewScreen .rv-keys')]
    check('review text is at least 12px', min(sizes) >= 12, sizes)
    cc = contrast(p, '#reviewScreen .rv-tags,#reviewScreen .rv-bind,#reviewScreen .rv-count')
    check('secondary review text keeps 4.5:1 on the dark screen', all(x['ratio'] >= 4.5 for x in cc), cc)
    p.keyboard.press('j'); p.wait_for_function("()=>document.getElementById('rvPos').textContent==='2 of 3'", timeout=5000)
    check('J goes to the next one and shows its project', p.locator('#rvTitle').inner_text() == 'Contact-centre analytics')
    p.keyboard.press('k'); p.wait_for_function("()=>document.getElementById('rvPos').textContent==='1 of 3'", timeout=5000)
    check('K goes back', p.locator('#rvTitle').inner_text() == 'Pricing engine migration')
    # ---- A then U: nothing is written
    reqs.clear()
    p.wait_for_function("()=>document.querySelector('#rvClaims .rv-claim')&&!document.getElementById('rvApprove').disabled", timeout=8000)
    p.keyboard.press('a'); p.wait_for_selector('#reviewScreen [data-rv-undo]', timeout=3000)
    check('A does not write at once: it shows "Validated" with a countdown and Undo', 'Validated' in p.locator('#reviewScreen .rv-undo').inner_text() and p.evaluate("()=>document.querySelector('#reviewScreen [data-undo-secs]').textContent")!='' and not reqs)
    check('A moves on to the next one in the same breath (the first is out of the list)', p.locator('#rvTitle').inner_text() == 'Contact-centre analytics' and p.locator('#rvPos').inner_text() == '1 of 2')
    p.keyboard.press('u'); p.wait_for_function("()=>document.querySelector('#reviewScreen .rv-undo')&&/Undone/.test(document.querySelector('#reviewScreen .rv-undo').textContent)", timeout=4000)
    check('U takes it back: the first one is back in place and nothing was sent', p.locator('#rvTitle').inner_text() == 'Pricing engine migration' and p.locator('#rvPos').inner_text() == '1 of 3' and not reqs)
    p.wait_for_timeout(9000)
    check('nine seconds later still nothing was written (an undone decision is never committed)', not reqs, reqs)
    # ---- A alone: exactly one approve, bound to revision and hash
    p.keyboard.press('a'); p.wait_for_function("()=>/Validated .* Saved\\./.test(document.querySelector('#reviewScreen .rv-undo')?.textContent||'')", timeout=14000)
    posts = [r for r in reqs if r[0] == 'POST']
    body = json.loads(posts[0][2]) if posts else {}
    check('after eight seconds exactly one approve was written, bound to revision 1 and the content hash', len(posts) == 1 and body.get('action') == 'approve' and body.get('expected_revision') == 1 and re.fullmatch(r'[0-9a-f]{64}', body.get('content_hash', '')), posts)
    st = p.evaluate("ATLAS_APP.libraryApi('/evidence/queue').then(r=>r.items.map(x=>x.project))")
    check('the approved one left the queue', st == ['Contact-centre analytics', 'Claims triage rebuild'], st)
    check('the screen moved to the next and says 1 of 2', p.locator('#rvTitle').inner_text() == 'Contact-centre analytics' and p.locator('#rvPos').inner_text() == '1 of 2')
    # ---- typing never triggers a key; R needs a reason; undo restores it; then one clarify
    reqs.clear()
    p.wait_for_function("()=>!document.getElementById('rvChanges').disabled", timeout=8000)
    p.keyboard.press('r'); p.wait_for_function("()=>!document.getElementById('rvReasonBox').hidden", timeout=3000)
    check('R opens the reason box with focus in it', p.evaluate("document.activeElement.id") == 'rvReason')
    p.keyboard.type('a j k u')
    check('typing letters in the box triggers nothing', not reqs and p.locator('#rvReason').input_value() == 'a j k u' and p.locator('#rvPos').inner_text() == '1 of 2')
    p.locator('#rvReason').fill(''); p.keyboard.press('Control+Enter')
    check('an empty reason is refused with a plain sentence and nothing is sent', 'Say what should change' in p.locator('#rvReasonErr').inner_text() and not reqs)
    p.locator('#rvReason').fill('Which quarter does the 40 minute figure cover?'); p.keyboard.press('Control+Enter')
    p.wait_for_selector('#reviewScreen [data-rv-undo]', timeout=3000)
    check('Request changes shows its own countdown and writes nothing yet', 'Changes requested' in p.locator('#reviewScreen .rv-undo').inner_text() and not reqs)
    p.locator('#reviewScreen [data-rv-undo]').click(); p.wait_for_function("()=>/Undone/.test(document.querySelector('#reviewScreen .rv-undo')?.textContent||'')", timeout=4000); p.wait_for_timeout(500)
    check('Undo (by click) brings the same one back with the words you typed', p.locator('#rvTitle').inner_text() == 'Contact-centre analytics' and p.locator('#rvReason').input_value() == 'Which quarter does the 40 minute figure cover?' and not reqs)
    p.locator('#rvReason').focus(); p.keyboard.press('Control+Enter')
    p.wait_for_function("()=>/Changes requested for .* Saved\\./.test(document.querySelector('#reviewScreen .rv-undo')?.textContent||'')", timeout=14000)
    posts = [r for r in reqs if r[0] == 'POST']; body = json.loads(posts[0][2]) if posts else {}
    check('exactly one clarify was written, with the reason and the revision', len(posts) == 1 and body.get('action') == 'clarify' and body.get('reason') == 'Which quarter does the 40 minute figure cover?' and body.get('expected_revision') == 1, posts)
    # ---- Amend (the last one): confirmation, then a new revision
    reqs.clear()
    check('one is left, "Claims triage rebuild", and it is shown', p.locator('#rvPos').inner_text() == '1 of 1' and p.locator('#rvTitle').inner_text() == 'Claims triage rebuild')
    p.wait_for_function("()=>!document.getElementById('rvAmend').disabled", timeout=8000)
    p.keyboard.press('e'); p.wait_for_selector('#rvClaims [data-claim-edit]', timeout=3000)
    ta = p.locator('#rvClaims [data-claim-edit]').first; ta.fill(ta.input_value() + ' (checked with the claims lead)')
    p.locator('#reviewScreen [data-rv-save]').click(); p.locator('#confirmDialog[open]').wait_for(timeout=4000)
    check('Amend asks for confirmation before anything is written, and says it makes a new revision', 'revision 2' in p.locator('#confirmText').inner_text() and not reqs)
    p.locator('#confirmYes').click(); p.wait_for_function("()=>/revision 2/.test(document.getElementById('rvBind').textContent)", timeout=8000)
    posts = [r for r in reqs if r[0] == 'POST']; body = json.loads(posts[0][2]) if posts else {}
    check('one amend was written against revision 1, and the screen now shows revision 2', len(posts) == 1 and body.get('action') == 'amend' and body.get('expected_revision') == 1 and len(body.get('claims', [])) == 1, posts)
    # ---- governance: the server decided, not the screen
    st = p.evaluate("""async()=>{const q=(await ATLAS_APP.libraryApi('/evidence/queue')).items,out=[];for(const x of (await ATLAS_APP.libraryApi('/evidence')).items)out.push(x.project_ref+':'+x.state+':'+x.revision);return {q:q.map(x=>x.project),all:out.sort()}}""")
    check('the library holds: one approved, one needing clarification, one amended and still waiting', len(st['q']) == 1 and st['q'][0] == 'Claims triage rebuild' and any(':needs_clarification:' in s for s in st['all']) and any(s.endswith(':downstream_proposals:1') or s.endswith(':approved:1') for s in st['all']) and any(s.endswith(':reviewer_queue:2') for s in st['all']), st)
    p.keyboard.press('Escape'); p.wait_for_timeout(400)
    check('Esc closes the review and focus returns to the row that opened it', not p.locator('#reviewScreen').evaluate('e=>e.open') and p.evaluate("()=>{const a=document.activeElement;return !!a&&a.hasAttribute('data-rq-open')}"))
    check('the queue now says Waiting for you (1) and the tab count follows', p.locator('#rqTitle').inner_text() == 'Waiting for you (1)' and p.locator('header nav [data-view=library] .nav-count').inner_text() == '1')

    # ------------------------------------------------------------------ calm loading and human failures
    p.evaluate("ATLAS_APP.switchView('interview')"); p.wait_for_timeout(300)
    p.route('**/api/library/search', lambda r: r.abort()); p.route('**/api/library/evidence/queue', lambda r: r.abort())
    p.evaluate("ATLAS_APP.switchView('interview')"); p.wait_for_timeout(200); p.evaluate("ATLAS_APP.switchView('library')"); p.wait_for_selector('#libraryList .load-fail', timeout=8000); p.wait_for_selector('#reviewQueue .load-fail', timeout=8000)
    for box in ('#libraryList', '#reviewQueue'):
        t = p.locator(box + ' .load-fail').inner_text()
        check(f'{box}: a failure says "We couldn\'t load this. Your work is safe." and offers Try again', LOAD_FAIL in t and 'Try again' in t, t)
    body = p.evaluate("document.body.innerText")
    check('no raw browser wording anywhere on the page', not re.search(r'Failed to fetch|TypeError|NetworkError|Load failed|ERR_', body), re.findall(r'.{20}(?:Failed to fetch|TypeError|NetworkError).{20}', body))
    p.unroute('**/api/library/search'); p.unroute('**/api/library/evidence/queue')
    p.locator('#libraryList .load-fail [data-load-retry]').click(); p.wait_for_function("()=>!document.querySelector('#libraryList .load-fail')", timeout=8000)
    p.locator('#reviewQueue .load-fail [data-load-retry]').click(); p.wait_for_function("()=>/^Waiting for you \\(\\d+\\)$/.test(document.getElementById('rqTitle')?.textContent||'')", timeout=8000)
    check('Try again works for the Library list and for the queue', p.locator('#libraryList .load-fail').count() == 0 and p.locator('#reviewQueue .load-fail').count() == 0)
    if p.evaluate("ATLAS_APP.bootInfo().then(b=>!!(b.features&&b.features.bids))"):
        p.route('**/api/library/bids*', lambda r: r.abort()); p.evaluate("ATLAS_APP.switchView('bids')"); p.wait_for_selector('#bidList .load-fail', timeout=8000)
        check('Bids: the list fails with the same calm sentence and Try again', LOAD_FAIL in p.locator('#bidList .load-fail').inner_text())
        p.unroute('**/api/library/bids*'); p.locator('#bidList .load-fail [data-load-retry]').click(); p.wait_for_function("()=>!document.querySelector('#bidList .load-fail')", timeout=8000)
        check('Bids: Try again loads the list', True)
    else:
        print('SKIP Bids loading checks: the bids feature is off on this edge')
    ctx.close()
    # shimmer rows while the first load runs (a fresh page, so nothing is drawn yet), moving, and still under reduced motion
    for reduced in (False, True):
        held = []
        def pre(q): q.route('**/api/library/search', lambda r: held.append(r)); q.route('**/api/library/evidence/queue', lambda r: held.append(r))
        ctx, p = page(br, base, 'reviewer@mantu.com', reduced=reduced, pre=pre)
        p.evaluate("ATLAS_APP.switchView('library')"); p.wait_for_selector('#libraryList .sk-row i', timeout=4000); p.wait_for_selector('#rqBody .sk-row i', timeout=4000)
        an = p.evaluate("()=>[...document.querySelectorAll('#libraryList .sk-row i,#rqBody .sk-row i')].map(e=>getComputedStyle(e).animationName)")
        label = p.evaluate("()=>document.querySelector('#libraryList [role=status] .sr').textContent")
        check('shimmer rows show while the Library list and the queue load, announced as loading' + (' (reduced motion: still)' if reduced else ' (moving)'), 'Loading' in label and (all(a == 'none' for a in an) if reduced else all(a != 'none' for a in an)) and p.locator('#libraryList').get_attribute('aria-busy') == 'true', an)
        for r in held: r.continue_()
        p.wait_for_function("()=>!document.querySelector('#libraryList .sk-row')&&/^Waiting for you/.test(document.getElementById('rqTitle').textContent)", timeout=8000)
        check('and the shimmer is replaced by the content, aria-busy cleared', p.locator('#libraryList').get_attribute('aria-busy') is None)
        ctx.close()

    # ------------------------------------------------------------------ a phone
    ctx, p = page(br, base, 'reviewer@mantu.com', 390, 844, touch=True)
    p.locator('header nav [data-view=library]').first.click(); p.wait_for_selector('.rq-row', timeout=10000); p.wait_for_timeout(300)
    ov = p.evaluate("()=>({sw:document.scrollingElement.scrollWidth,iw:innerWidth})")
    check('390: the queue does not scroll sideways', ov['sw'] <= ov['iw'] + 1, ov)
    p.locator('.rq-row').first.click(); p.wait_for_function("()=>document.querySelectorAll('#rvClaims .rv-claim').length>0", timeout=8000); p.wait_for_timeout(300)
    check('390: the review fits and Validate, Request changes and Amend are on screen', all(vis(p, s) for s in ('#rvApprove', '#rvChanges', '#rvAmend')) and vis(p, '#rvTitle'))
    hh = p.evaluate("()=>['#rvApprove','#rvChanges','#rvAmend','.rv-step','.rv-back'].map(s=>Math.round(document.querySelector(s).getBoundingClientRect().height))")
    check('390: the controls are at least 44px high', all(h >= 44 for h in hh), hh)
    check('390: nothing overflows the review screen: the claims scroll inside it and the decision stays in view', p.evaluate("()=>{const d=document.getElementById('reviewScreen'),c=document.getElementById('rvClaims'),b=document.querySelector('.rv-decide').getBoundingClientRect();return d.scrollHeight<=d.clientHeight+1&&d.scrollWidth<=d.clientWidth+1&&c.clientHeight>120&&b.bottom<=innerHeight+1}"))
    ctx.close()
    ctx, p = page(br, base, 'w2owner@mantu.com', 390, 844, touch=True)
    p.wait_for_timeout(1500); p.evaluate("ATLAS_APP.switchView('library')"); p.wait_for_function("()=>document.querySelector('#journeyLibrary .journey')", timeout=10000); p.wait_for_timeout(500)
    ov = p.evaluate("()=>({sw:document.scrollingElement.scrollWidth,iw:innerWidth,steps:document.querySelectorAll('#journeyLibrary .journey-step').length})")
    check('390: the strip has seven steps and the page does not scroll sideways', ov['steps'] == 7 and ov['sw'] <= ov['iw'] + 1, ov)
    m = p.evaluate("""()=>[...document.querySelectorAll('#journeyLibrary button')].map(b=>{const r=b.getBoundingClientRect();return [Math.round(r.width),Math.round(r.height),Math.round(r.left),Math.round(r.right)]})""")
    check('390: every step is a 44px target inside the window', all(w >= 44 and h >= 44 and l >= 0 and r <= 390 for w, h, l, r in m), m)
    cur = p.evaluate("()=>{const l=document.querySelector('#journeyLibrary [aria-current=step] .journey-label').getBoundingClientRect();return [l.left,l.right,innerWidth]}")
    check('390: the current step\'s name is shown and inside the window', cur[0] >= 0 and cur[1] <= cur[2], cur)
    ctx.close()
    check('no console errors and no page errors (strict CSP held)', not ERR, ERR[:5])


if __name__ == '__main__':
    with sync_playwright() as pw:
        br = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'))
        base = start_edge()
        try:
            main(br, base)
            print('\nALL W2 CHECKS PASSED')
        finally:
            for pr in PROCS: pr.terminate()
            br.close()
