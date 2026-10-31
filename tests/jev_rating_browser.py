"""Story rating by JEV (docs/JEV_RATING.md §13.4) in a real browser against the local edge (real Worker + library code,
node:sqlite, stand-in review agent, loopback only). Nothing reaches TypeSafe or any paid provider.
Two backends, the same steps:
 - EDGE's fake: FAKE_TYPESAFE=1 on dev/local-edge.mjs and its /__typesafe_mode?m=ok|down|unsure hook, used when present;
 - otherwise a contract mock: Playwright routes that answer the §8 and §9 contract (bootstrap jev, the jevRating consent,
   rating.running / rating.jevAllowed and the §9.2 quality shape) on top of the real local library.
A second server without FAKE_TYPESAFE (and without the mock) checks that, with no key, nothing about JEV appears.
  python3 tests/jev_rating_browser.py          JEV_BROWSER_MOCK=1 forces the contract mock
"""
import copy,json,os,re,socket,subprocess,time,urllib.request
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];EDGE=ROOT/'deploy/cloudflare-edge';ERR=[];ALERTS=[];SERVERS=[]
def check(n,v):print(('PASS ' if v else 'FAIL ')+n);assert v,n
HOSTILE='<img src=x onerror=alert(1)>'
COPY=('Rate your stories with JEV in about a second? ATLAS sends TypeSafe an anonymised copy of each story. ATLAS removes the client names, contacts, '
      "colleagues' names, emails and links it recognises before sending; abbreviations or product names may remain. JEV judges how the story is written, not you.")
REP={'headline':'Claims triage rebuilt with ML routing','summary':'The consultant rebuilt claims triage for the client.','topics':{},'highlights':[],'gaps':[],'follow_ups':[],'status':'model_draft',
 'facts':{'project_id':'PRJ-2291','country':'France','industry':'Insurance','start':'2024-03','end':'2024-11','duration':'','team_size':6,'team_roles':['Data engineer'],'technologies':['Python','Azure ML'],'deliverables':['Routing model'],'service_lines':['Data & AI']}}
NOTES=['Zebracorp had claims bouncing between three teams, slowing payouts for customers across the region.','I designed and built the routing model and ran the pilot with two teams myself.',
 'We compared rules against a model, chose the model, and kept a manual fallback for edge cases.','Triage fell from 40 to 12 minutes per claim according to the operations dashboard.',
 'Operations dashboard export v3, before and after quarters.','Any insurer or service desk with manual routing and a measurable queue would benefit.']

def serve(fake):
 s=socket.socket();s.bind(('127.0.0.1',0));port=s.getsockname()[1];s.close();base=f'http://127.0.0.1:{port}'
 env={k:v for k,v in os.environ.items() if k not in ('FAKE_TYPESAFE','TYPESAFE_API_KEY')}
 if fake:env['FAKE_TYPESAFE']='1'
 SERVERS.append(subprocess.Popen(['node','--no-warnings','dev/local-edge.mjs',str(port)],cwd=EDGE,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.STDOUT))
 for _ in range(100):
  try:urllib.request.urlopen(base+'/__settle',timeout=1);break
  except Exception:time.sleep(.1)
 return base
def get(url):
 try:
  r=urllib.request.urlopen(url,timeout=30);return r.status,r.read(4000)
 except Exception:return 0,b''

# ---- the contract mock (only when EDGE's fake is not there): the "server" state is shared by every browser context ----
DIMS=[('challenge','Business problem','context',.15),('contribution','Own contribution','contribution',.15),('approach','Approach','approach',.10),('outcome','Outcome','outcome',.15),
 ('evidence','Evidence','evidence',.15),('reusability','Reusability','customer_relevance',.10),('clarity','Plain language','general',.10)]
L3=['Problem and stakes','Own actions described','Method and why','Change with a figure','Source and what it shows','Type and conditions','Plain business language']
L2=['Problem named','Team and own actions mixed','Steps described','Change in words','Source named','Client type named','Mostly plain']
OKP=[[0,0,0,1],[0,0,.2,.8],[0,0,.8,.2],[0,0,0,1],[0,0,.1,.9],[0,0,.8,.2],[0,0,.2,.8]];OKC=[1,.73,.73,1,.87,.73,.73]
def band(c):return 'sure' if c>=.9 else 'likely' if c>=.6 else 'unsure'
def jev_quality(completeness,revision,unsure=False,cached=False,gen=1):
 dims=[]
 for i,(id_,label,field,w) in enumerate(DIMS):
  p=[.25,.05,.10,.60] if unsure else OKP[i];c=.4 if unsure else OKC[i];lv=max(range(4),key=lambda k:(p[k],-k))
  dims.append({'id':id_,'label':label,'field':field,'weight':w,'score':round(sum(k*x for k,x in enumerate(p)),2),'level':lv,'levelLabel':L3[i] if lv==3 else L2[i],
   'confidence':c,'band':band(c),'split':unsure,'method':'jev','p':p})
 comp=70.5 if unsure else 91.5;score=round(.45*completeness+.55*comp);ready=not unsure and score>=75
 checks=[{'id':'client_value_clear','label':'Client value stated','probability':.93,'outcome':'yes'},{'id':'results_supported','label':'Every result backed by named evidence','probability':.91,'outcome':'yes'},
  {'id':'figure_source_named','label':'Figure and source stated (as written)','probability':.9,'outcome':'yes'}]
 holds=['JEV is unsure about '+d[1]+'.' for d in DIMS] if unsure else []
 return {'score':score,'completeness':completeness,'aiScore':round(comp),'status':'ready' if ready else 'needs_work','clientValueClear':True,'missing':[],'issues':[],
  'recommendations':[] if unsure else ['Explain how the problem was tackled and why that method fitted (alternatives considered, trade-offs).','Say which other clients could use this and what they would need in place.'],
  'summary':'JEV rated this ready but was unsure; a second opinion from the review agent is running.' if unsure else 'Rated by JEV on 7 parts of the story. Strongest: Business problem and Outcome. Weakest: Approach.'+(' (saved rating)' if cached else ''),
  'blockers':[],'holds':holds,'reviewedAt':'2026-09-29T10:00:00.000Z','model':'fake-jev-local','readyScore':75,'revision':revision,'engine':'jev','ms':3 if cached else 412,'cached':cached,
  'rubric':'story-quality-v2','fallbackReason':None,'gen':gen,'jev':{'composite':comp,'pessimisticScore':score,'strict':False,'dimensions':dims,'checks':checks,'language':{'code':'en','confidence':.99},
  'fixFirst':None if unsure else {'field':'approach','label':'Approach'}}}
def agent(q,reason,ms,**extra):return {**(q or {}),'engine':'review-agent','ms':ms,'cached':False,'rubric':None,'holds':[],'jev':None,'fallbackReason':reason,'gen':1,**extra}
def sig(ref):return json.dumps([ref.get('title'),ref.get('sector'),ref.get('answers')])
class Mock:
 """The server side of the contract, faithful where the steps depend on it: the owner's consent decides the engine (§7.3),
 an unchanged story reuses JEV's last answer whatever the fake's mode (§6.4), each rating has a generation (§6.6), and an
 unsure answer escalates to a second opinion that lands later under the same generation (§5.5). The review agent's own
 result always comes from the real local library."""
 def __init__(s):s.mode='ok';s.consent={};s.owner={};s.rated={};s.last={};s.gen={};s.prof={};s.blank=set();s.busy={};s.gets={};s.posts={}   # the last four: step 14 knobs
 def install(s,ctx,email):ctx.route(re.compile(r'/api/(bootstrap|library)'),lambda route,req:s.handle(route,req,email,ctx))
 def consents(s,j,email):
  c={k:v for k,v in (j.get('consents') or {}).items() if k!='jevRating'}
  if s.consent.get(email):c['jevRating']={'version':1,'at':'2026-09-29T10:00:00.000Z'}
  j['consents']=c;return j
 def rate(s,rid,rev,k,comp,delay):
  g=s.gen[rid]=s.gen.get(rid,0)+1;e={'rev':rev,'gen':g}
  if not s.consent.get(s.owner.get(rid)):e['reason']='no_consent'
  else:
   last=s.last.get(rid);kind=last[1] if last and last[0]==k else None
   if kind is None and s.mode=='down':e['reason']='rate_limited'
   else:
    cached=kind is not None;kind=kind or s.mode;s.last[rid]=(k,kind);e['q']=jev_quality(comp,rev,unsure=kind=='unsure',cached=cached,gen=g)
    if kind=='unsure':e['second']=True;e['at']=time.time()+delay
  s.rated[rid]=e
 def view(s,j):
  rid=j.get('id');e=s.rated.get(rid);full=j.get('access')=='full';running=False;rq=j['state'].get('quality')   # rq: the real agent's rating of this revision
  if s.busy.get(rid,0)>0 or rid in s.blank:   # step 14: a revision not rated yet, with (busy) or without a rating in progress
   running=s.busy.get(rid,0)>0;s.busy[rid]=s.busy.get(rid,1)-1;j['state']['quality']=None
   j['rating']={'running':running,**({'jevAllowed':bool(s.consent.get(s.owner.get(rid)))} if full else {})};return j
  if e and e['rev']==j.get('revision'):
   if e.get('second') and time.time()>=e['at'] and rq:e['q']=agent(rq,'escalated',900,escalatedFrom='jev',jev=e['q']['jev'],gen=e['gen']);e['second']=False
   q=e.get('q') or (agent(rq,e['reason'],900,gen=e['gen']) if rq else None);running=bool(e.get('second')) or q is None
   j['state']['quality']=copy.deepcopy(q)
  q=j['state'].get('quality')
  if q and not full:j['state']['quality']={**q,'jev':None,'holds':[]}                 # §9.2 public reduction
  j['rating']={'running':running,**({'jevAllowed':bool(s.consent.get(s.owner.get(rid)))} if full else {})}
  return j
 def handle(s,route,req,email,ctx):
  path=urlparse(req.url).path;m=req.method;rec=re.fullmatch(r'/api/library/([a-f0-9]{32})(/review)?',path)
  if path=='/api/bootstrap':
   r=route.fetch();j=r.json();j['jev']=True;return route.fulfill(response=r,json=j)
  if path=='/api/library/profile' and m=='GET':
   r=route.fetch();j=r.json()
   if r.ok:s.prof[email]=copy.deepcopy(j);j=s.consents(j,email)
   return route.fulfill(response=r,json=j)
  if path=='/api/library/profile/consent' and m=='POST' and (req.post_data_json or {}).get('kind')=='jevRating':
   s.consent[email]=bool(req.post_data_json.get('granted'))
   base=s.prof.get(email) or ctx.request.get(req.url.rsplit('/',1)[0]).json()
   return route.fulfill(status=200,json=s.consents(copy.deepcopy(base),email))
  if path=='/api/library' and m=='POST':   # a save starts a background rating (§6.5)
   r=route.fetch();j=r.json()
   if r.ok and j.get('id'):
    s.owner.setdefault(j['id'],email)
    if not j.get('unchanged'):s.rate(j['id'],j['revision'],sig((req.post_data_json or {}).get('reference') or {}),100,0)
   return route.fulfill(response=r,json=j)
  if rec and rec.group(2) and m=='POST':   # Rate again: the real agent rates first (fallback and second-opinion source)
   r=route.fetch();j=r.json()
   if not r.ok:return route.fulfill(response=r,json=j)
   rid=rec.group(1);s.posts[rid]=s.posts.get(rid,0)+1;s.blank.discard(rid);s.owner.setdefault(rid,email if j.get('mine') else None)
   s.rate(rid,j['revision'],sig(j.get('data') or {}),(j['state'].get('quality') or {}).get('completeness',100),2.5)
   return route.fulfill(response=r,json=s.view(j))
  if rec and not rec.group(2) and m=='GET':
   s.gets.setdefault(rec.group(1),[]).append(time.time());r=route.fetch();j=r.json();return route.fulfill(response=r,json=s.view(j) if r.ok else j)
  return route.fallback()

A=serve(True);B=None
REAL=os.environ.get('JEV_BROWSER_MOCK')!='1' and (lambda st,b:st==200 and b'<' not in b)(*get(A+'/__typesafe_mode?m=ok'))
MOCK=None if REAL else Mock()
print('BACKEND:',"EDGE's fake TypeSafe (FAKE_TYPESAFE=1, /__typesafe_mode)" if REAL else 'contract mock ('+('JEV_BROWSER_MOCK=1' if os.environ.get('JEV_BROWSER_MOCK')=='1' else "EDGE's FAKE_TYPESAFE hook not present on dev/local-edge.mjs")+')')
def mode(m):
 if REAL:check('fake mode '+m,get(A+'/__typesafe_mode?m='+m)[0]==200)
 else:MOCK.mode=m
settle=lambda base=None:urllib.request.urlopen((base or A)+'/__settle',timeout=30).read()
try:
 with sync_playwright() as pw:
  b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
  def page(email,base=None,mock=True):
   c=b.new_context(viewport={'width':1400,'height':1000})
   if mock and MOCK and not base:MOCK.install(c,email)
   p=c.new_page();p.on('pageerror',lambda e:ERR.append(str(e)));p.on('dialog',lambda d:(ALERTS.append(d.message),d.dismiss()))
   p.goto((base or A)+'/?as='+email);p.wait_for_timeout(800);return p
  def create(p,title,consultant,notes):
   p.locator('[data-action=new-project]:visible').first.click();p.wait_for_timeout(200)
   for k,v in {'projectTitle':title,'consultantName':consultant,'consultantRole':'Data engineer','clientName':'Zebracorp','clientLocation':'Lyon','n1Name':'Sam','n1Email':'sam@mantu.com'}.items():p.locator('#'+k).fill(v)
   p.locator('#projectForm button[type=submit]').click();p.wait_for_timeout(300)
   p.evaluate("([n,rep])=>{window.ATLAS_VOICE_BRIDGE.autoSave(window.ATLAS_VOICE_BRIDGE.context(),n,'Consultant words.',rep);}",[notes,REP])
   p.wait_for_function("()=>window.ATLAS_APP.profile().projects.some(x=>x.library&&x.library.id)",timeout=8000)
   rid=p.evaluate("()=>window.ATLAS_APP.profile().projects.find(x=>x.library&&x.library.id).library.id")
   # G2: an interview is a private draft until the person clicks Submit for review (the Library's own button, delegated handler)
   p.evaluate("id=>{const b=document.createElement('button');b.dataset.submitRef=id;document.body.append(b);b.click();b.remove();}",rid)
   p.wait_for_function("id=>window.ATLAS_APP.profile().projects.some(x=>x.library&&x.library.id===id&&x.library.status!=='draft')",arg=rid,timeout=8000)
   return rid
  def rec(p,rid):return p.evaluate("id=>fetch('/api/library/'+id).then(r=>r.json())",rid)
  def open_record(p,rid):   # the app's own delegated [data-open-record] handler, as a library card or project pill would do
   p.evaluate("id=>{const b=document.createElement('button');b.dataset.openRecord=id;document.body.append(b);b.click();b.remove();}",rid)
   p.wait_for_function("id=>document.getElementById('recordDialog').open&&window.__record&&window.__record.id===id",arg=rid,timeout=8000);p.wait_for_timeout(200)
  def shows(p,sel,text,ms=8000,prop='innerText'):   # textContent where CSS changes the case (.quality h4 is uppercase)
   try:p.wait_for_function("([s,t,k])=>{const e=document.querySelector(s);return !!e&&e[k].includes(t);}",arg=[sel,text,prop],timeout=ms);return True
   except Exception:return False
  body=lambda p:p.locator('#recordBody').inner_text()
  close=lambda p,d='recordDialog':p.locator(f'#{d} [data-close]').click()

  # 1. owner: a complete record is saved automatically; the storage strip asks at once (no /__settle wait)
  o=page('alex@mantu.com');rid=create(o,'Claims triage alias','Alex',NOTES)
  strip=o.locator('[data-jev-where="strip"]')
  check('1 the storage strip asks for consent right after the first library save',shows(o,'[data-jev-where="strip"]','Rate your stories with JEV',6000) and strip.count()==1)
  check('1 consent copy is the spec text, word for word',' '.join(strip.locator('p').inner_text().split())==COPY)
  check('1 the row sits right under the storage strip',o.evaluate("()=>document.querySelector('.environment').nextElementSibling===document.querySelector('[data-jev-where=\"strip\"]')"))
  # 2. Allow -> the record is rated by JEV within 3 s, and a late background agent rating does not overwrite it
  t0=time.time();strip.get_by_role('button',name='Allow for my stories').click()
  eng=None
  while time.time()-t0<3 and eng!='jev':
   eng=((rec(o,rid).get('state') or {}).get('quality') or {}).get('engine');o.wait_for_timeout(150)
  check(f'2 Allow gives a JEV rating within 3 s ({time.time()-t0:.1f} s)',eng=='jev')
  check('2 the consent row is gone after Allow',o.locator('.jev-consent').count()==0)
  settle();check('2 after the background work settles the rating is still JEV',rec(o,rid)['state']['quality']['engine']=='jev')
  # 3. the record dialog: engine, 7 dimensions at their level, 3 checks, no raw confidence text
  open_record(o,rid);t=body(o)
  check('3 dialog says Rated by JEV','Rated by JEV' in t)
  check('3 seven dimension rows and three checks',o.locator('#recordBody .ag-dim').count()==7 and all(c in t for c in ['Client value stated:','Every result backed by named evidence:','Figure and source stated (as written):']))
  check('3 no raw "conf 0." text',not re.search(r'conf 0\.',t))
  check('3 quality line names the engine and the button reads Rate again',' · JEV ' in t and o.locator('#recordBody [data-rec-review]').first.inner_text()=='Rate again')
  close(o)
  # 4. the profile panel shows the stored consent
  o.evaluate("()=>window.ATLAS_APP.open('profileDialog')")
  check('4 profile: Story rating by JEV: allowed',shows(o,'#pfJev','Story rating by JEV: allowed',5000))
  close(o,'profileDialog')

  # 5. a second owner says Not now in the strip; the record dialog asks again (fallback), and Allow there rates with JEV.
  # 11. her story carries markup: it is shown as text, never as an element.
  e=page('bea@mantu.com');rid_b=create(e,'Grid claims',"Bea",NOTES[:5]+['Utilities with a claims queue could reuse it. '+HOSTILE])
  check('5 the strip asks the second owner too',shows(e,'[data-jev-where="strip"]','Rate your stories with JEV',6000))
  e.locator('[data-jev-where="strip"]').get_by_role('button',name='Not now').click()
  check('5 Not now removes the strip row',e.locator('.jev-consent').count()==0)
  settle();open_record(e,rid_b);t=body(e)
  check('5 the record dialog asks the owner (fallback)',e.locator('#recordBody .jev-consent').count()==1 and 'Rate your stories with JEV' in t)
  check('5 before consent the review agent rated it','Rated by the review agent' in t)
  check('11 story markup is shown as text: no injected element',e.locator('#recordBody img').count()==0 and HOSTILE in t)
  e.locator('#recordBody .jev-consent').get_by_role('button',name='Allow for my stories').click()
  check('5 Allow in the dialog gives Rated by JEV',shows(e,'#recordBody','Rated by JEV',6000) and e.locator('#recordBody .jev-consent').count()==0)
  close(e)

  # 6. only the project id changes: a new revision, and JEV's saved answer is reused instantly
  o.evaluate("()=>{const p=window.ATLAS_APP.profile().projects.find(x=>x.library);p.details.projectId='PRJ-7777';window.ATLAS_APP.save();const b=document.createElement('button');b.dataset.sync=p.id;document.body.append(b);b.click();b.remove();}")
  check('6 the save toast says JEV is rating it',shows(o,'#toast','Saved to the shared library. JEV is rating it now.',6000))
  settle();open_record(o,rid)
  check('6 new revision, instant (saved rating)','REVISION 2' in o.locator('#recordEyebrow').inner_text() and 'Rated by JEV · instant (saved rating)' in body(o))
  close(o)

  # 7. the N+1 sees the JEV gauge and is never asked (it is not their story)
  n=page('sam@mantu.com');r7=rec(n,rid);open_record(n,rid);t=body(n)
  check('7 N+1: no consent row, JEV gauge visible',n.locator('.jev-consent').count()==0 and 'Rated by JEV' in t and (r7.get('access')!='full' or n.locator('#recordBody .ag-dim').count()==7))

  # 9, then 8: "Rate again" on an unchanged story reuses JEV's saved answer (§6.4, R12) whatever the fake's mode, so each step
  # first edits the story text; "down" runs last because its failed attempts open the 60 s breaker (§6.3). See JEV_UI.md.
  def edit(p,more):
   p.evaluate("t=>{const x=window.ATLAS_APP.profile().projects.find(y=>y.library);x.answers[3]+=t;window.ATLAS_APP.save();const b=document.createElement('button');b.dataset.sync=x.id;document.body.append(b);b.click();b.remove();}",more)
   shows(p,'#toast','Saved to the shared library',6000);settle()
  # 9. unsure: JEV's needs_work with holds first, then the second opinion of that same rating appears without a reload
  mode('unsure');edit(o,' Payouts were faster.');open_record(o,rid);o.evaluate("()=>{window.__noReload=1;}")
  with o.expect_response(lambda r:r.url.endswith('/review') and r.request.method=='POST',timeout=15000) as ri:o.locator('#recordBody [data-rec-review]').first.click()
  q9=ri.value.json()['state']['quality']
  check('9 Rate again first answers with JEV needs_work and holds',q9.get('engine')=='jev' and q9.get('status')=='needs_work' and len(q9.get('holds') or [])>0)
  hold=shows(o,'#recordBody','To check',4000,'textContent')
  if MOCK:check('9 the dialog lists the holds under To check',hold)
  else:print('INFO 9 "To check" '+('was shown' if hold else 'was not caught: the second opinion landed before the dialog redrew'))
  try:o.wait_for_function("g=>{const q=window.__record&&window.__record.state.quality;return !!q&&q.gen===g&&q.fallbackReason==='escalated';}",arg=q9.get('gen'),timeout=20000);landed=True
  except Exception:landed=False
  check('9 the dialog polls in the second opinion of that rating: Second opinion by the review agent · JEV was unsure',landed and shows(o,'#recordBody','Second opinion by the review agent · JEV was unsure',3000))
  check('9 without a reload',o.evaluate("()=>window.__noReload===1"))
  close(o);settle()
  # 8. TypeSafe down: the save's rating and Rate again both fall back to the review agent and say so
  mode('down');edit(o,' Claims were paid sooner.');open_record(o,rid)
  check('8 down: the save was rated by the review agent · JEV did not answer',shows(o,'#recordBody','JEV did not answer',15000) and 'Rated by the review agent' in body(o))
  with o.expect_response(lambda r:r.url.endswith('/review') and r.request.method=='POST',timeout=15000) as r8:o.locator('#recordBody [data-rec-review]').first.click()
  q8=r8.value.json()['state']['quality'];o.wait_for_timeout(500)
  check(f"8 down: Rate again falls back too ({q8.get('fallbackReason')})",q8.get('engine')=='review-agent' and q8.get('fallbackReason') not in (None,'no_key','no_consent','no_story','escalated')
   and shows(o,'#recordBody','JEV did not answer',15000) and 'Rated by the review agent' in body(o))
  close(o)
  # 10. turning JEV off in the profile: Rate again uses the review agent
  mode('ok');o.evaluate("()=>window.ATLAS_APP.open('profileDialog')");shows(o,'#pfJev','allowed',5000);o.locator('#pfJev button').click()
  check('10 profile: turned off',shows(o,'#pfStatus','Story rating by JEV is off. ATLAS asks again next time.',5000) and o.locator('#pfJev').count()==0)
  close(o,'profileDialog');open_record(o,rid)
  with o.expect_response(lambda r:r.url.endswith('/review') and r.request.method=='POST',timeout=15000) as r10:o.locator('#recordBody [data-rec-review]').first.click()
  q10=r10.value.json()['state']['quality']
  try:o.wait_for_function("()=>{const t=document.getElementById('recordBody').innerText;return t.includes('Rated by the review agent')&&!t.includes('JEV did not answer');}",timeout=15000);redrawn=True
  except Exception:redrawn=False
  check(f"10 after turning off, Rated by the review agent ({q10.get('fallbackReason')})",q10.get('engine')=='review-agent' and q10.get('fallbackReason')=='no_consent' and redrawn)
  check('10 ATLAS asks again next time (dialog fallback)',o.locator('#recordBody .jev-consent').count()==1)

  if MOCK:
   # 14 (contract mock only: the timing is ours) §9.4 when quality is null: an automatic rating only with rating.jevAllowed and once
   # per revision, "Rating this revision…" with polling at 0.8, 1.6, 3.2 s, polling stops when the dialog closes, and the 45 s cap.
   MOCK.blank.add(rid);MOCK.posts[rid]=0;open_record(o,rid);o.wait_for_timeout(1200)
   check('14 without consent, opening an unrated revision starts no rating',MOCK.posts[rid]==0 and 'The review agent has not scored this revision yet.' in body(o) and 'Rate again' in body(o))
   close(o);o.evaluate("()=>window.AtlasProfile.grantJevRating()");open_record(o,rid)
   check('14 with consent, opening it rates it once, with JEV',shows(o,'#recordBody','Rated by JEV',6000) and MOCK.posts[rid]==1)
   close(o);MOCK.blank.add(rid);open_record(o,rid);o.wait_for_timeout(1200)
   check('14 the automatic rating runs once per revision',MOCK.posts[rid]==1 and 'The review agent has not scored this revision yet.' in body(o))
   close(o);MOCK.blank.discard(rid);MOCK.busy[rid]=3;MOCK.gets[rid]=[];open_record(o,rid)
   check('14 a rating in progress shows Rating this revision…',shows(o,'#recordBody','Rating this revision…',3000))
   check('14 polling brings the rating in without a reload',shows(o,'#recordBody','Rated by JEV',12000))
   g=MOCK.gets[rid];gaps=[round(y-x,2) for x,y in zip(g,g[1:])]
   check(f'14 the dialog polls with backoff 0.8, 1.6, 3.2 s (measured {gaps})',len(gaps)==3 and .7<=gaps[0]<1.5 and 1.5<=gaps[1]<2.5 and 3.0<=gaps[2]<4.5)
   close(o);MOCK.busy[rid]=10**6;MOCK.gets[rid]=[];open_record(o,rid);o.wait_for_timeout(1200);close(o);n0=len(MOCK.gets[rid]);o.wait_for_timeout(3500)
   check(f'14 closing the dialog stops the polling ({n0} GETs, none after closing)',n0==2 and len(MOCK.gets[rid])==n0)
   o.clock.install();MOCK.gets[rid]=[];open_record(o,rid);o.clock.run_for(46000)
   check('14 after 45 s: "The rating is taking longer than usual." with Rate now',shows(o,'#recordBody','The rating is taking longer than usual.',10000) and o.locator('#recordBody p.quality [data-rec-review]').count()==1)
   n0=len(MOCK.gets[rid]);o.clock.run_for(30000);o.wait_for_timeout(800)
   check(f'14 polling stops at 45 s ({n0} GETs in 45 s, none after)',3<=n0<=13 and len(MOCK.gets[rid])==n0)
   del MOCK.busy[rid];close(o)
  else:print('INFO 14 skipped: the null-quality timing checks need the contract mock (JEV_BROWSER_MOCK=1)')

  # 13. a second server without FAKE_TYPESAFE (no key): no consent row, no engine line, no JEV text in the gauge
  B=serve(False);k=page('kim@mantu.com',base=B);rid_k=create(k,'Metering pilot','Kim',NOTES);k.wait_for_timeout(1500)
  check('13 no key: no consent row in the storage strip',k.locator('.jev-consent').count()==0)
  settle(B);open_record(k,rid_k);g=k.locator('#recordBody .atlas-dash.ag-mini')
  check('13 no key: no consent row in the record dialog',k.locator('.jev-consent').count()==0)
  check('13 no key: today\'s gauge (no engine line, no JEV text)',g.count()>=1 and k.locator('#recordBody .ag-eng').count()==0 and 'JEV' not in g.first.inner_text() and 'Run quality review' in body(k))
  check('12 no page errors and no alert',not ERR and not ALERTS);print(ERR,ALERTS)
finally:
 for s in SERVERS:s.terminate()
