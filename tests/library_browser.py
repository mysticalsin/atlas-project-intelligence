"""Shared reference library end to end in a real browser against the local edge (real Worker + library code,
node:sqlite, stand-in model, loopback only). Owner -> automatic sync and review -> N+1 validates -> colleague sees
the published, anonymised reference -> an edit creates revision 2 and reopens the review.
  python3 tests/library_browser.py
"""
import json,os,socket,subprocess,sys,time,urllib.request,urllib.parse,urllib.error
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];EDGE=ROOT/'deploy/cloudflare-edge';ERR=[]
def check(n,v):print(('PASS ' if v else 'FAIL ')+n);assert v,n
s=socket.socket();s.bind(('127.0.0.1',0));PORT=s.getsockname()[1];s.close();BASE=f'http://127.0.0.1:{PORT}'
srv=subprocess.Popen(['node','--no-warnings','dev/local-edge.mjs',str(PORT)],cwd=EDGE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
for _ in range(100):
 try:urllib.request.urlopen(BASE+'/__settle',timeout=1);break
 except Exception:time.sleep(.1)
settle=lambda:urllib.request.urlopen(BASE+'/__settle',timeout=30).read()
def bind(owner, mgr):
  req=urllib.request.Request(BASE+'/__trust',data=json.dumps({'owner':owner,'email':mgr,'source':'directory'}).encode(),headers={'Content-Type':'application/json'},method='POST')
  urllib.request.urlopen(req).read()
def edge_api(email, method, path, body=None, roles=None):
  q='as='+urllib.parse.quote(email)+(('&idp='+urllib.parse.quote(json.dumps({'roles':roles}))) if roles else '')
  boot=json.loads(urllib.request.urlopen(BASE+'/api/bootstrap?'+q,timeout=30).read())
  url=BASE+path+('&' if '?' in path else '?')+q
  data=json.dumps(body).encode() if body is not None else None
  headers={'Origin':BASE}
  if data is not None: headers.update({'Content-Type':'application/json','X-Atlas-CSRF':boot['csrf']})
  req=urllib.request.Request(url,data=data,method=method,headers=headers)
  try:
    with urllib.request.urlopen(req,timeout=30) as r: return r.status, json.loads(r.read() or b'{}')
  except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
REP={'headline':'Claims triage rebuilt with ML routing','summary':'The consultant rebuilt claims triage for the client.','topics':{},'highlights':[],'gaps':[],'follow_ups':[],'status':'model_draft',
 'facts':{'project_id':'PRJ-2291','country':'France','industry':'Insurance','start':'2024-03','end':'2024-11','duration':'','team_size':6,'team_roles':['Data engineer'],'technologies':['Python','Azure ML'],'deliverables':['Routing model'],'service_lines':['Data & AI']}}
NOTES=['Zebracorp had claims bouncing between three teams, slowing payouts for customers across the region.','I designed and built the routing model and ran the pilot with two teams myself.',
 'We compared rules against a model, chose the model, and kept a manual fallback for edge cases.','Triage fell from 40 to 12 minutes per claim according to the operations dashboard.',
 'Operations dashboard export v3, before and after quarters.','Any insurer or service desk with manual routing and a measurable queue would benefit.']
try:
 with sync_playwright() as pw:
  b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
  def page(email, roles=None):
   c=b.new_context(viewport={'width':1400,'height':1000});p=c.new_page();p.on('pageerror',lambda e:ERR.append(str(e)))
   q='/?as='+urllib.parse.quote(email)+(('&idp='+urllib.parse.quote(json.dumps({'roles':roles}))) if roles else '')
   p.goto(BASE+q);p.wait_for_timeout(700);return p
  # --- owner
  o=page('alex@mantu.com')
  o.locator('[data-action=new-project]:visible').first.click();o.wait_for_timeout(200)
  for k,v in {'projectTitle':'Claims triage alias','consultantName':'Alex','consultantRole':'Data engineer','clientName':'Zebracorp','clientLocation':'Lyon','n1Name':'Sam','n1Email':'sam@mantu.com'}.items():o.locator('#'+k).fill(v)
  o.locator('#projectForm button[type=submit]').click();o.wait_for_timeout(300)
  r=o.evaluate("([n,rep])=>window.ATLAS_VOICE_BRIDGE.autoSave(window.ATLAS_VOICE_BRIDGE.context(),n,'Consultant words.',rep)",[NOTES,REP])
  o.wait_for_timeout(1200);settle()
  o.locator('header [data-view=library]').click();o.wait_for_timeout(900)
  card=o.locator('#libraryList .project-card').first
  check('interview synced to the shared library automatically',card.count()==1 and 'Claims triage rebuilt' in card.inner_text())
  check('automatic quality review ran; awaiting the N+1','AWAITING N+1' in card.inner_text().upper())
  card.locator('[data-open-record]').click();o.wait_for_timeout(700)
  body=o.locator('#recordBody').inner_text()
  check('record shows quality score and the full template',('Quality' in body) and 'PRJ-2291' in body and 'Zebracorp' in body and 'Python' in body)
  check('owner cannot validate their own reference',o.locator('[data-rec-validate]').count()==0)
  rid=o.evaluate("JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('mantu.atlas')))||'null')?.profiles?.[0]?.projects?.[0]?.library?.id||null") or o.locator('[data-rec-review]').first.get_attribute('data-rec-review')
  check('library id known',bool(rid))
  o.locator('#recordDialog').screenshot(path=str(Path(os.environ.get('SHOTS','/tmp'))/'library_record.png')) if os.environ.get('SHOTS') else None
  with o.expect_download() as dw:o.locator('[data-rec-word]').click()
  import zipfile
  doc=zipfile.ZipFile(dw.value.path()).read('word/document.xml').decode()
  check('library Word = the reference-sheet template (.docx): title, summary labels, 8 sections, gaps "To be completed"',dw.value.suggested_filename.endswith('.docx') and all(w in doc for w in ['Claims triage alias','Executive Summary','Detailed Information Sheet','Industry sector, size and type of client','Added value and ROI','Team size','Python','To be completed']))
  o.locator('#recordDialog [data-close]').click()
  # A typed manager address is not a binding. The old single click must not publish.
  denied=edge_api('sam@mantu.com','POST',f'/api/library/{rid}/validate',{'decision':'validate','lane':'manager'})
  check('typed manager without a trust row is refused',denied[0]==404)
  bind('alex@mantu.com','sam@mantu.com')
  n=page('sam@mantu.com');n.goto(BASE+'/#library/'+rid);n.wait_for_timeout(1200)
  check('trusted manager sees one approval button',n.locator('#recordDialog').is_visible() and n.locator('[data-rec-validate]').count()==1)
  n.locator('[data-rec-validate]').click();n.wait_for_timeout(900)
  check('manager approval alone does not publish', 'PUBLISHED' not in n.locator('#recordEyebrow').inner_text().upper() and 'manager approved' in n.locator('#recordBody').text_content())
  check('approval redraw focuses Close reference', n.evaluate("document.activeElement && document.activeElement.getAttribute('aria-label')")=='Close reference')
  def lane_closed(page):
    btn=page.locator('#recordDialog [data-rec-validate]')
    count=btn.count()
    return count==0 or btn.is_disabled()
  check('approve is disabled or absent after the click', lane_closed(n))
  code,saved=edge_api('alex@mantu.com','POST','/api/library',{'localId':'enter-lane','reference':{'title':'Enter lane alias','consultant':{'name':'Alex','role':'Engineer'},'client':{'name':'Northwind','location':'Lyon','contact':'Ops'},'answers':['A queue.','I owned the route.','We kept the manual path.','The queue moved.','The board.','A desk with a queue.']}})
  eid=saved.get('id')
  check('second reference exists for Enter', code in (200,201) and bool(eid))
  n.goto(BASE+'/#library/'+eid);n.wait_for_timeout(1200)
  check('second record offers approval', n.locator('[data-rec-validate]').count()==1)
  def fail_validate(route):
    if route.request.method=='POST' and '/validate' in route.request.url:
      route.fulfill(status=500,content_type='application/json',body=json.dumps({'error':'The approval did not finish.'}))
      return
    route.continue_()
  n.route('**/api/library/**', fail_validate)
  n.locator('[data-rec-validate]').click();n.wait_for_timeout(800)
  failed=n.locator('[data-rec-validate]')
  check('a failed approve enables the button again', failed.count()==1 and failed.is_enabled())
  check('a failed approve returns focus to the button', n.evaluate("document.activeElement && document.activeElement.getAttribute('data-rec-validate')")==eid)
  n.unroute('**/api/library/**', fail_validate)
  n.locator('[data-rec-validate]').focus();n.keyboard.press('Enter');n.wait_for_timeout(900)
  check('approve is disabled or absent after Enter', lane_closed(n))
  n.locator('#recordDialog [data-close]').click()
  n.locator('header [data-view=journey]').click()
  n.wait_for_function("() => { const t=document.querySelector('#journey')?.innerText||''; return t.includes('Enter lane alias') && t.includes('Claims triage alias'); }", timeout=8000)
  queue=n.locator('#journey').inner_text()
  check('journey queue drops an approved lane', n.locator('#journey').get_by_role('button', name='Approve as trusted manager').count()==0)
  status,listing=edge_api('sam@mantu.com','GET','/api/library')
  items={item['id']:item for item in listing.get('items',[])}
  check('journey label follows real list() output', status==200 and items[rid]['managerDecision']=='approved' and items[rid]['presalesDecision']=='pending' and items[eid]['managerDecision']=='approved' and queue.count('Manager approved · awaiting pre-sales')>=2)
  pre=page('presales@example.test',['ATLAS.Presales']);pre.goto(BASE+'/#library/'+rid);pre.wait_for_timeout(1200)
  check('pre-sales role sees its own lane',pre.locator('[data-rec-validate]').count()==1)
  pre.locator('[data-rec-validate]').click();pre.wait_for_timeout(900)
  check('both lanes publish', 'PUBLISHED' in pre.locator('#recordEyebrow').inner_text().upper() and 'presales approved' in pre.locator('#recordBody').text_content())
  # --- colleague
  k=page('kim@mantu.com');k.locator('header [data-view=library]').click();k.wait_for_timeout(900)
  check('colleague sees the published reference',k.locator('#libraryList .project-card').count()==1)
  k.locator('#libraryList [data-open-record]').first.click();k.wait_for_timeout(700)
  txt=k.locator('#recordBody').inner_text()+k.locator('#recordEyebrow').inner_text()
  check('client hidden and scrubbed for colleagues','CLIENT HIDDEN' in txt and 'Zebracorp' not in txt and 'Lyon' not in txt and 'the client had claims' in txt)
  check('no validate / audit trail for colleagues',k.locator('[data-rec-validate]').count()==0 and 'Who did what' not in txt)
  # --- owner edits -> revision 2, review reopened
  o.evaluate("([n])=>{const b=window.ATLAS_VOICE_BRIDGE;const c=b.context();n[3]=n[3]+' Payouts were faster.';return b.autoSave(c,[null,null,null,' Payouts were faster.',null,null],'More words.',null);}",[NOTES]);o.wait_for_timeout(1200);settle()
  o.locator('header [data-view=library]').click();o.wait_for_timeout(600);o.locator('#libraryList [data-open-record]').first.click();o.wait_for_timeout(700)
  ey=o.locator('#recordEyebrow').inner_text();body=o.locator('#recordBody').inner_text()
  check('an edit creates revision 2 and reopens validation','REVISION 2' in ey and 'Awaiting N+1 validation' in body)
  o.locator('#recordBody summary').click();o.wait_for_timeout(200)
  check('audit trail shows who did what',all(w in o.locator('#recordBody').text_content() for w in ['created','reviewed','manager approved','presales approved','revised','sam@mantu.com']))
  check('no page errors',not ERR);print(ERR)
finally:
 srv.terminate()
