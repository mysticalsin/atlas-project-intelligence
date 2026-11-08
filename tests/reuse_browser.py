"""Reuse and operations in a real browser against the local edge (real Worker + library, stand-in model):
meeting recommendation with reasons, client-context .pptx slides (validated zip, invented numbers removed),
duplicate detection and merge, analytics/coverage/insights, interview invitations (reviewer, PM trigger,
six-month) with .ics and start-from-invitation, Spotlight export.
  python3 tests/reuse_browser.py
"""
import json,os,socket,subprocess,time,urllib.parse,urllib.request,zipfile,io
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
def ref(title,industry,challenge,pid='',country='France',tech=None):
 return {'title':title,'stage':'Production','sector':industry,'consultant':{'name':'Alex','role':'Engineer'},'client':{'name':'Zebracorp','location':'Lyon','contact':''},
  'details':{'projectId':pid,'country':country,'start':'2024-01','duration':'6 months','teamSize':4,'teamRoles':['Engineer'],'technologies':tech or ['Python'],'deliverables':['Model'],'serviceLines':['Data & AI'],'consultants':[],'links':[]},
  'answers':[challenge,'I led the design and delivery of the solution with the client team myself.','We compared options, chose a model-based approach and kept a manual fallback.','Processing time fell from 40 to 12 minutes according to the operations dashboard.','Operations dashboard export v3.','Any organisation with manual, slow operational routing would benefit from this approach.'],
  'validation':{'manager':{'name':'Sam','email':'sam@mantu.com'},'managerStaff':False},'jev':{'primary':{'key':'data_ai','label':'Data & AI'},'also':[],'impact':70}}
API="""async ([method,path,body])=>{const b=await (await fetch('/api/bootstrap')).json();const r=await fetch('/api/library'+path,{method,headers:method==='GET'?{}:{'Content-Type':'application/json','X-Atlas-CSRF':b.csrf},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};}"""
try:
 with sync_playwright() as pw:
  b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
  def page(email, roles=None):
   c=b.new_context(viewport={'width':1400,'height':1000},accept_downloads=True);p=c.new_page();p.on('pageerror',lambda e:ERR.append(str(e)))
   q='/?as='+urllib.parse.quote(email)+(('&idp='+urllib.parse.quote(json.dumps({'roles':roles}))) if roles else '')
   p.goto(BASE+q);p.wait_for_timeout(600);return p
  alex=page('alex@mantu.com');sam=page('sam@mantu.com');jo=page('jo@mantu.com')
  ids=[]
  for i,(t,ind,ch,pid,who) in enumerate([('Grid data platform','Energy','A power utility had fragmented grid data and slow decisions across control rooms and field teams.','PRJ-1',alex),
                                          ('Retail loyalty app','Retail','The retailer needed a mobile loyalty app for its stores and online shop customers.','PRJ-2',alex),
                                          ('Bank reconciliation','Banking','A bank had manual payment reconciliation and long month-end closing cycles.','PRJ-3',alex),
                                          ('Grid data lake','Energy','The utility had fragmented grid data spread over control rooms and slow operational decisions.','PRJ-1',jo)]):
   r=who.evaluate(API,['POST','',{'localId':'seed'+str(i),'reference':ref(t,ind,ch,pid,'Belgium' if i==2 else 'France')}]);ids.append(r['body']['id'])
  settle()
  bare=sam.evaluate(API,['POST','/'+ids[0]+'/validate',{'decision':'validate','lane':'manager'}])
  check('typed manager without a trust row is not an approval',bare['status']==404)
  req=urllib.request.Request(BASE+'/__trust',data=json.dumps({'owner':'alex@mantu.com','email':'sam@mantu.com','source':'directory'}).encode(),headers={'Content-Type':'application/json'},method='POST')
  urllib.request.urlopen(req).read()
  urllib.request.urlopen(urllib.request.Request(BASE+'/__trust',data=json.dumps({'owner':'jo@mantu.com','email':'sam@mantu.com','source':'directory'}).encode(),headers={'Content-Type':'application/json'},method='POST')).read()
  for rid in ids[:3]:
   one=sam.evaluate(API,['POST','/'+rid+'/validate',{'decision':'validate','lane':'manager'}])
   check('manager lane alone does not publish '+rid,one['status']!=200 or one['body'].get('status')!='published')
  pre=page('presales@example.test',['ATLAS.Presales'])
  for rid in ids[:3]:pre.evaluate(API,['POST','/'+rid+'/validate',{'decision':'validate','lane':'presales'}])
  kim=page('kim@mantu.com');kim.locator('header [data-view=library]').click();kim.wait_for_timeout(700)
  kim.locator('#recommendQuery').fill('I am meeting the data director of a major energy company. Which relevant references can I present?');kim.locator('#recommendGo').click();kim.wait_for_timeout(1200)
  out=kim.locator('#recommendResults').inner_text()
  check('recommendation: context understood (industry, likely challenges)','Energy' in out and 'Likely challenges' in out and 'interpretation' in out)
  first=kim.locator('#recommendResults .rec').first.inner_text()
  check('recommendation: most relevant first, with why and what transfers','Grid data platform' in first and 'Similar challenge' in first and 'Transfers' in first)
  check('recommendation: no client names and no unpublished drafts','Zebracorp' not in out and 'Grid data lake' not in out)
  with kim.expect_download() as d:kim.locator('#recommendResults [data-slides-for]').first.click()
  path=d.value.path();z=zipfile.ZipFile(path);s2=z.read('ppt/slides/slide2.xml').decode()
  check('slides: a valid .pptx with the reference and interpretation marked',z.testzip() is None and 'ppt/presentation.xml' in z.namelist() and '◇' in s2 and 'Grid data platform' in s2)
  check('slides: invented numbers never reach the deck','99%' not in s2 and 'Zebracorp' not in s2)
  kim.locator('#recommendResults [data-open-record]').first.click();kim.wait_for_timeout(700)
  check('colleague cannot include the client name on slides',kim.locator('#slideClient').count()==0)
  with kim.expect_download():kim.locator('[data-make-slides]').click()
  kim.wait_for_timeout(500);prev=kim.locator('#slidePreview').inner_text()
  check('slide preview separates facts from interpretation and reports removed claims','◇' in prev and 'Removed because the numbers are not in the reference' in prev)
  kim.locator('#recordDialog [data-close]').click()
  # reviewer: duplicates, analytics, insights, invitations, export
  rev=page('reviewer@mantu.com',['ATLAS.Reviewer']);rev.goto(BASE+'/#library/'+ids[0]);rev.wait_for_timeout(1200)
  body=rev.locator('#recordBody').inner_text()
  check('duplicate detected (same project ID, other consultant), strongest first','POSSIBLE DUPLICATES' in body.upper() and rev.locator('#recordBody li').filter(has_text='same project ID').first.inner_text().startswith('Grid data lake'))
  rev.locator('#recordBody li').filter(has_text='Grid data lake').locator('[data-merge-keep]').click();rev.wait_for_timeout(200);rev.locator('#confirmYes').click();rev.wait_for_timeout(1000);settle()
  merged=rev.evaluate(API,['GET','/'+ids[0],None])['body']
  check('merge: one reference, both consultants, their contributions preserved',merged['revision']==2 and any(c.get('email')=='jo@mantu.com' for c in merged['data']['details']['consultants']) and rev.evaluate(API,['GET','/'+ids[3],None])['status']==404)
  settle();sam.evaluate(API,['POST','/'+ids[0]+'/validate',{'decision':'validate','lane':'manager'}])
  pre.evaluate(API,['POST','/'+ids[0]+'/validate',{'decision':'validate','lane':'presales'}])
  rev.locator('#recordDialog [data-close]').click();rev.locator('header [data-view=library]').click();rev.wait_for_timeout(600)
  rev.locator('#openInsights').click();rev.wait_for_timeout(900);ins=rev.locator('#insightsBody').inner_text()
  check('analytics: counts by country, service line, practice; coverage matrix and gaps','By country' in ins and 'Belgium' in ins and 'Coverage' in ins and 'SAP & ERP in France' in ins)
  check('analytics: confidential client counts for reviewers only','Most represented clients' in ins and 'Zebracorp' in ins)
  rev.locator('#runInsights').click();rev.wait_for_timeout(900);io_=rev.locator('#insightsOut').inner_text()
  check('commercial insights labelled as interpretation, citing references','Offering ideas' in io_ and 'Interpretation based on' in io_ and 'not-a-real-id' not in io_)
  rev.locator('#invEmail').fill('alex@mantu.com');rev.locator('#invProject').fill('PRJ-9');rev.locator('#invTitle').fill('Grid analytics rollout');rev.locator('#invReason').select_option('project_end');rev.locator('#invSlot').fill('2026-10-02T10:00')
  rev.locator('#invCreate').click();rev.wait_for_timeout(500)
  check('a reviewer role does not get the whole-library export',rev.locator('#exportLibrary').count()==0)
  adm=page('admin@example.test',['ATLAS.Admin']);adm.locator('header [data-view=library]').click();adm.wait_for_timeout(600)
  adm.locator('#openInsights').click();adm.wait_for_timeout(900)
  with adm.expect_download() as d2:adm.locator('#exportLibrary').click()
  ex=json.loads(Path(d2.value.path()).read_text());titles={r['reference']['title'] for r in ex['references']}
  check('Spotlight export: versioned JSON includes the published references',ex['schema']=='atlas.reference.v1' and {'Grid data platform','Retail loyalty app','Bank reconciliation'}<=titles)
  harbor=alex.evaluate(API,['POST','',{'localId':'harbor-new','reference':ref('Harbor sensor rollout','Telecom','A port authority had manual sensor checks and slow decisions across harbor terminals.','PRJ-H','France',['Sensors'])}])
  quarry=alex.evaluate(API,['POST','',{'localId':'quarry-draft','reference':ref('Unpublished quarry notes','Mining','A quarry kept an unpublished draft that must not be recommended.','PRJ-Q')}])
  settle()
  hid,qid=harbor['body']['id'],quarry['body']['id']
  check('a newly created story is not published before both trusted lanes approve',alex.evaluate(API,['GET','/'+hid,None])['body']['status']!='published')
  check('manager lane on the new story still does not publish',sam.evaluate(API,['POST','/'+hid+'/validate',{'decision':'validate','lane':'manager'}])['body'].get('status')!='published')
  check('presales completes publication of the new story',pre.evaluate(API,['POST','/'+hid+'/validate',{'decision':'validate','lane':'presales'}])['body']['status']=='published')
  found=kim.evaluate(API,['POST','/recommend',{'query':'I am meeting a port authority about harbor sensor operations and slow terminal decisions.'}])
  names=[r.get('title') for r in found['body'].get('results',[])]
  check('recommendation finds the newly approved story from its own content','Harbor sensor rollout' in names and 'Unpublished quarry notes' not in names)
  check('recommendation does not surface the unpublished draft','Unpublished quarry notes' not in names)
  with adm.expect_download() as d4:adm.locator('#exportLibrary').click()
  ex2=json.loads(Path(d4.value.path()).read_text());by={r['reference']['title']:r['status'] for r in ex2['references']}
  check('export contains the newly approved story and keeps the unapproved story unpublished',by.get('Harbor sensor rollout')=='published' and by.get('Unpublished quarry notes') not in (None,'published'))
  # PM trigger
  req=urllib.request.Request(BASE+'/api/triggers',data=json.dumps({'email':'alex@mantu.com','reason':'milestone','projectId':'PRJ-10','title':'Billing migration phase 2'}).encode(),headers={'Authorization':'Bearer local-trigger-secret','Content-Type':'application/json'},method='POST')
  check('PM trigger accepted with its secret',urllib.request.urlopen(req).status==201)
  try:urllib.request.urlopen(urllib.request.Request(BASE+'/api/triggers',data=b'{}',headers={'Authorization':'Bearer nope'},method='POST'));bad=False
  except urllib.error.HTTPError as e:bad=e.code==401
  check('PM trigger rejected without the secret',bad)
  alex.locator('header [data-view=library]').click();alex.wait_for_timeout(900);inv=alex.locator('#invitations').inner_text()
  check('consultant sees scheduled and triggered interviews','Grid analytics rollout' in inv and 'Billing migration phase 2' in inv and 'End of project' in inv and 'Project milestone' in inv)
  with alex.expect_download() as d3:alex.locator('[data-inv-ics]').first.click()
  cal=Path(d3.value.path()).read_text();check('calendar invite (.ics) for the slot','BEGIN:VEVENT' in cal and 'ATLAS project interview' in cal)
  alex.locator('#invitations article').filter(has_text='Grid analytics rollout').locator('[data-inv-start]').click();alex.wait_for_timeout(500)
  check('start from an invitation opens the conversation on that project',alex.evaluate("window.ATLAS_VOICE_BRIDGE.context().project.title")=='Grid analytics rollout' and not alex.locator('#interview').is_hidden())
  check('no page errors',not ERR);print(ERR)
finally:
 srv.terminate()
