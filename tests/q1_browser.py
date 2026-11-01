"""v2.2 Q1 item 1 (S1): an interview binds to its own project, in a real browser against a mocked voice socket (fake microphone, no network).
The live QA ran interview B and, straight after it, interview C: C's header chip already showed B's title, C's report opened under B's title with B's transcript
underneath, and B's own report was overwritten. Here three interviews run back to back on one page:
  A and B  no project picked: each is a NEW project, with its own report and its own transcript; A is untouched by B.
  C        the person picks A again on purpose: C is added to A (the later-interview transcript), as before.
  D        straight after C: a new project again (C's pick is spent), A and B are untouched by it.
  python3 tests/q1_browser.py
"""
import json,os,time
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];H=(ROOT/'ATLAS_Voice.html').read_text();ERR=[];GOT=[]
BOOT={'provider':'workers','providerLabel':'ATLAS voice','protocol':'atlas-personaplex-pcm-v1','csrf':'tok','identity':{'name':'tony@example.com','mode':'access','subjectKey':'k'},'model':'ATLAS conversational voice','admin':True,
 'voices':['atlas'],'defaultVoice':'atlas','captureRequired':True,'codecAvailable':True,'busy':False,'capacity':1,'maxSeconds':2700,'speakingSeconds':600,'memory':False,'wiki':False,'jev':False,'jevClassify':False,'transcription':True,'structuredNotes':True,'liveLedger':True,'playbackAck':True}
def rep(headline,summary):return {'headline':headline,'summary':summary,'topics':{'context':summary},'highlights':['Ownership'],'gaps':['No named source'],'follow_ups':[],'status':'model_draft'}
RUNS=[
 ('Billing migration moved to a new provider','The consultant moved the billing platform to a new provider.','The billing migration to the new provider ran over six months.'),
 ('Warehouse routing rewrite shortened the picking walk','The consultant rewrote the warehouse routing.','The warehouse routing rewrite cut the picking walk for the pickers.'),
 ('Billing migration moved to a new provider, second pass','The consultant came back to the billing migration.','Second time round the billing cutover was rehearsed twice.'),
 ('Claims intake redesigned for an insurer','The consultant redesigned claims intake.','The claims intake redesign removed the manual queue for handlers.')]
STARTS=[]
def route(r):
 u=r.request.url
 if u.endswith('/api/bootstrap'):return r.fulfill(json=BOOT)
 if u.rstrip('/')=='https://atlas.test':return r.fulfill(body=H,content_type='text/html')
 r.fulfill(status=404,body='')
def ws_handler(ws):
 def on_msg(m):
  if isinstance(m,bytes):return
  d=json.loads(m);GOT.append(d.get('type'))
  if d.get('type')=='start':
   STARTS.append(d);n=len(STARTS)-1;headline,summary,said=RUNS[n]
   ws.send(json.dumps({'type':'ready','model':'ATLAS','provider':'ATLAS voice','sampleRate':24000,'capture':True,'liveLedger':True,'maxSeconds':2700,'speakingSeconds':600,'message':'ready'}))
   ws.send(json.dumps({'type':'agent_text','text':"Hi, I'm ATLAS."}))
   ws.send(json.dumps({'type':'user_text','item_id':'user-1','text':said,'provenance':'unverified_speech_recognition'}))
   ws.send(json.dumps({'type':'wrap_up','message':'ATLAS closed the interview.'}))
  if d.get('type')=='end':
   n=len(STARTS)-1;headline,summary,said=RUNS[n]
   for e in [{'type':'audio_stopped'},{'type':'reporting','message':'Writing your interview report.'},
             {'type':'notes','sessionId':'s%d'%n,'transcript':said,'sections':[said,'','','','',''],'status':'candidate','report':rep(headline,summary),'message':'m'},
             {'type':'ended','message':'closed'}]:ws.send(json.dumps(e))
 ws.on_message(on_msg)
def check(n,v):print(('PASS ' if v else 'FAIL ')+n);assert v,n
def projects(p):return p.evaluate('window.ATLAS_LOCAL.snapshot().profiles[0].projects')
def run_interview(p,k):
 """Start the k-th interview from the start screen and wait until its report is on the screen and the microphone is released."""
 before=len(projects(p)) if k else 0
 p.evaluate("document.getElementById('reportDialog')?.open&&document.getElementById('reportDialog').close()")
 if p.locator('#confirmDialog').is_visible():p.locator('#confirmYes').click();p.wait_for_timeout(400) # "Save on this device?" (the library is off in this mock)
 p.locator("header nav button[data-view='interview']").click();p.wait_for_timeout(300)
 p.locator('#voiceStart').click();p.locator('#voiceConsentDialog').wait_for(state='visible',timeout=8000)
 p.locator('#modelConsent').check();p.locator('#voiceConsentStart').click()
 t0=time.time()
 while time.time()-t0<20 and len(STARTS)<=k:p.wait_for_timeout(100)
 t0=time.time()
 while time.time()-t0<20 and RUNS[k][0] not in p.locator('#reportTitle').inner_text()+p.locator('#reportBody').inner_text():p.wait_for_timeout(200)
 p.wait_for_timeout(600)
 return before
with sync_playwright() as pw:
 b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None,args=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required'])
 ctx=b.new_context(permissions=['microphone'],viewport={'width':1440,'height':1000});p=ctx.new_page();p.on('pageerror',lambda e:ERR.append(str(e)))
 p.route('**/*',route);p.route_web_socket('**/api/voice',ws_handler)
 p.goto('https://atlas.test/');p.wait_for_timeout(600)
 # ---- A: no project yet
 run_interview(p,0)
 pj=projects(p)
 check('A created its own project, titled by its own report',len(pj)==1 and pj[0]['title']==RUNS[0][0] and pj[0]['report']['headline']==RUNS[0][0])
 check("A's transcript is A's own",pj[0]['interview']['transcript']==RUNS[0][2])
 # ---- B: straight after A, nothing picked
 chip=p.evaluate("document.getElementById('orbProjectTitle').textContent")
 check("before B starts, the header chip does not show A's title (it is a new project)",RUNS[0][0] not in chip and 'new project' in chip.lower())
 run_interview(p,1)
 pj=projects(p);by={x['title']:x for x in pj}
 check('B is a second project, not a rewrite of A',len(pj)==2 and RUNS[0][0] in by and RUNS[1][0] in by)
 check("A's report and transcript are untouched by B",by[RUNS[0][0]]['report']['headline']==RUNS[0][0] and by[RUNS[0][0]]['interview']['transcript']==RUNS[0][2] and RUNS[1][2] not in by[RUNS[0][0]]['interview']['transcript'])
 check("B's report is B's and its transcript holds only B's words",by[RUNS[1][0]]['report']['headline']==RUNS[1][0] and by[RUNS[1][0]]['interview']['transcript']==RUNS[1][2])
 check("each start told the server the project it was for (A: a new one; B: a new one)",[s['project']['id'] for s in STARTS]==['new','new'])
 # ---- C: the person picks A on purpose
 aid=by[RUNS[0][0]]['id']
 p.evaluate("(id)=>{const s=document.getElementById('interviewProject');s.value=id;s.dispatchEvent(new Event('change',{bubbles:true}));}",aid);p.wait_for_timeout(300)
 chip=p.evaluate("document.getElementById('orbProjectTitle').textContent")
 check('a project the person picked is the one the next interview is for',RUNS[0][0] in chip)
 run_interview(p,2)
 pj=projects(p);by={x['id']:x for x in pj}
 check('C was added to A (a later interview), no third project',len(pj)==2 and 'Later interview' in by[aid]['interview']['transcript'] and RUNS[2][2] in by[aid]['interview']['transcript'] and STARTS[2]['project']['id']==aid)
 check("B is untouched by C",[x for x in pj if x['id']!=aid][0]['interview']['transcript']==RUNS[1][2])
 # ---- D: straight after C, nothing picked: a new project again
 chip=p.evaluate("document.getElementById('orbProjectTitle').textContent")
 check("before D starts, the chip is a new project again (C's pick is spent)",'new project' in chip.lower())
 run_interview(p,3)
 pj=projects(p);titles=sorted(x['title'] for x in pj)
 check('D is a third project and A, B, C are untouched',len(pj)==3 and RUNS[3][0] in titles and STARTS[3]['project']['id']=='new' and RUNS[3][2] not in by[aid]['interview']['transcript'] and RUNS[3][2] not in json.dumps([x for x in pj if x['title']!=RUNS[3][0]]))
 check('no script error',not ERR)
 b.close()
print('q1_browser: all checks passed')
