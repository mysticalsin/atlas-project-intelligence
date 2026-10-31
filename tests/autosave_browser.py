"""Seamless end of interview, in a real browser against a mocked voice socket (fake microphone, no network).
ATLAS sends wrap_up -> the page ends by itself -> reporting/notes -> the project is created and the report opens. No clicks after Start.
Does not claim live speech or model behaviour; the server side is covered by deploy/cloudflare-edge/test/session.test.js.
  python3 tests/autosave_browser.py
"""
import json,os,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];H=(ROOT/'ATLAS_Voice.html').read_text();ERR=[];GOT=[]
BOOT={'provider':'workers','providerLabel':'ATLAS voice','protocol':'atlas-personaplex-pcm-v1','csrf':'tok','identity':{'name':'tony@example.com','mode':'access','subjectKey':'k'},'model':'ATLAS conversational voice','admin':True,
 'voices':['atlas'],'defaultVoice':'atlas','captureRequired':True,'codecAvailable':True,'busy':False,'capacity':1,'maxSeconds':2700,'speakingSeconds':600,'memory':False,'wiki':False,'jev':False,'jevClassify':False,'transcription':True,'structuredNotes':True,'liveLedger':True,'playbackAck':True}
REP={'headline':'Claims triage rebuilt with ML routing','summary':'The consultant led a redesign of claims triage for the client.','topics':{'context':'Tickets bounced between teams.'},'highlights':['Ownership'],'gaps':['No named source'],'follow_ups':[],'status':'model_draft'}
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
   ws.send(json.dumps({'type':'ready','model':'ATLAS','provider':'ATLAS voice','sampleRate':24000,'capture':True,'liveLedger':True,'maxSeconds':2700,'speakingSeconds':600,'message':'ready'}))
   ws.send(json.dumps({'type':'agent_text','text':"Hi, I'm ATLAS."}))
   ws.send(json.dumps({'type':'agent_text','text':'\n\nMm-hm. What was the '}))  # the consultant had not finished: taken back
   ws.send(json.dumps({'type':'agent_retract','item_id':'agent-2','chars':len('\n\nMm-hm. What was the ')}))
   ws.send(json.dumps({'type':'agent_text','text':'\n\nThanks so much for sharing. I will prepare your report now.'}))
   ws.send(json.dumps({'type':'user_text','item_id':'user-1','text':'That is everything.','provenance':'unverified_speech_recognition'}))
   ws.send(json.dumps({'type':'wrap_up','message':'ATLAS closed the interview.'}))
  if d.get('type')=='end':
   for e in [{'type':'audio_stopped'},{'type':'reporting','message':'Writing your interview report.'},
             {'type':'notes','transcript':'I owned the routing design. That is everything.','sections':['I owned the routing design.','','','','',''],'status':'candidate','report':REP,'message':'m'},
             {'type':'ended','message':'closed'}]:ws.send(json.dumps(e))
 ws.on_message(on_msg)
def check(n,v):print(('PASS ' if v else 'FAIL ')+n);assert v,n
with sync_playwright() as pw:
 b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None,args=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required'])
 ctx=b.new_context(permissions=['microphone'],viewport={'width':1440,'height':1000});p=ctx.new_page();p.on('pageerror',lambda e:ERR.append(str(e)))
 p.route('**/*',route);p.route_web_socket('**/api/voice',ws_handler)
 p.goto('https://atlas.test/');p.wait_for_timeout(600)
 p.locator('#voiceStart').click();p.locator('#voiceConsentDialog').wait_for(state='visible',timeout=8000)
 check('no voice preset visible',not p.locator('#voicePickRow').is_visible())
 check('consent says a private draft until Submit for review','private draft' in p.locator('#modelConsentText').inner_text() and 'Submit for review' in p.locator('#modelConsentText').inner_text())
 check('admin hint shown for a server-flagged admin','Admin mode' in p.locator('#consentTip').inner_text())
 p.locator('#modelConsent').check();p.locator('#voiceConsentStart').click()
 t0=time.time()
 while time.time()-t0<15 and 'end' not in GOT:p.wait_for_timeout(200)
 check('client ended by itself after wrap_up (no click)','end' in GOT)
 said=p.evaluate("document.getElementById('agentText').textContent")
 check('a withdrawn reply is removed from the on-screen transcript','What was the' not in said and said.startswith("Hi, I'm ATLAS.") and 'Thanks so much for sharing' in said)
 p.wait_for_timeout(1500)
 st=p.evaluate('AtlasVoice.status()')
 check('microphone released',not st['hasMicrophone'])
 check('report opened automatically',p.locator('#reportDialog').is_visible() and 'Claims triage rebuilt' in p.locator('#reportTitle').inner_text()+p.locator('#reportBody').inner_text())
 check('review dialog not shown (seamless)',not p.locator('#voiceNotesDialog').is_visible())
 check('project created',p.evaluate("window.ATLAS_VOICE_BRIDGE.context().project.title")=='Claims triage rebuilt with ML routing')
 check('no stray discard after a clean end','discard' not in GOT)
 check('final status says saved','Saved to' in p.locator('#voiceMessage').inner_text())

 # ---- guarantees behind the seamless save (bridge level, same page)
 check('device-save opt-in offered when storage is off',p.locator('#confirmDialog').is_visible() and 'Save on this device' in p.locator('#confirmTitle').inner_text())
 p.locator('#confirmYes').click();p.wait_for_timeout(500)
 K=p.evaluate("Object.keys(localStorage).find(k=>k.startsWith('mantu.atlas.workspace'))")
 check('workspace now stored on the device',bool(K))
 d=json.loads(p.evaluate(f"localStorage.getItem('{K}')"));x=d['profiles'][0]['projects'][0]
 x['story']['edited']=True;x['story']['parts'][0]='MY OWN WORDING';x['client']={'name':'Zebracorp','location':'Lyon','contact':''}
 p.evaluate("([k,v])=>localStorage.setItem(k,v)",[K,json.dumps(d)]);p.reload();p.wait_for_timeout(700)
 snap=p.evaluate('window.ATLAS_VOICE_BRIDGE.context()')
 rep2=dict(REP,headline='Second pass for Zebracorp',summary='Zebracorp in Lyon extended the rollout.')
 r=p.evaluate("([s,rep])=>window.ATLAS_VOICE_BRIDGE.autoSave(s,['More detail.',null,null,null,null,null],'Second interview words.',rep)",[snap,rep2])
 p.wait_for_timeout(400);d=json.loads(p.evaluate(f"localStorage.getItem('{K}')"));x=d['profiles'][0]['projects'][0]
 check('existing project reused, persisted reported',r['projectId']==x['id'] and r['persisted'] is True)
 check('edited story kept',x['story']['parts'][0]=='MY OWN WORDING' and x['story']['edited'] is True)
 check('client details scrubbed from the report',('Zebracorp' not in json.dumps(x['report'])) and ('Lyon' not in json.dumps(x['report'])) and 'the client' in x['report']['summary'])
 check('earlier transcript kept, new one appended','I owned the routing design' in x['interview']['transcript'] and 'Second interview words.' in x['interview']['transcript'])
 n=len(d['profiles'][0]['projects'])
 fail=p.evaluate("""(ws)=>{const E=window.AtlasEngine,g=E.generate;E.generate=()=>{throw Error('boom')};try{window.ATLAS_VOICE_BRIDGE.autoSave({workspaceId:ws,isNew:true,revision:'new',project:{consultant:'C'}},['x',null,null,null,null,null],'t',null);return 'no error';}catch(e){return e.message;}finally{E.generate=g;}}""",snap['workspaceId'])
 check('a failure mid-save removes the half-created project',fail=='boom' and p.evaluate("window.ATLAS_VOICE_BRIDGE.context().project.id")==x['id'])
 ok=p.evaluate("(ws)=>window.ATLAS_VOICE_BRIDGE.apply({workspaceId:ws,isNew:true,revision:'new',project:{consultant:'C'}},['Manual note.',null,null,null,null,null],'t',null)",snap['workspaceId'])
 p.wait_for_timeout(400);d=json.loads(p.evaluate(f"localStorage.getItem('{K}')"))
 check('manual fallback creates the project when there was none',ok is True and len(d['profiles'][0]['projects'])==n+1 and d['profiles'][0]['projects'][-1]['answers'][0]=='Manual note.')
 # ---- Restart: a live conversation is discarded (never ended) and a new one starts; nothing is saved or sent anywhere
 GOT2=[];CALLS=[]
 def ws_live(ws):
  def on_msg(m):
   if isinstance(m,bytes):return
   d=json.loads(m);GOT2.append(d.get('type'))
   if d.get('type')=='start':
    ws.send(json.dumps({'type':'ready','model':'ATLAS','provider':'ATLAS voice','sampleRate':24000,'capture':True,'liveLedger':True,'maxSeconds':900,'speakingSeconds':600,'message':'ready'}))
    ws.send(json.dumps({'type':'agent_text','text':'Hi, I am ATLAS. What was going on?'}))
    if GOT2.count('start')==1:ws.send(json.dumps({'type':'user_text','item_id':'user-1','text':'Discard me please.','provenance':'unverified_speech_recognition'}))
   if d.get('type')=='discard':ws.close()
  ws.on_message(on_msg)
 ctx2=b.new_context(permissions=['microphone'],viewport={'width':1440,'height':1000});q=ctx2.new_page();q.on('pageerror',lambda e:ERR.append(str(e)))
 q.route('**/*',route);q.route_web_socket('**/api/voice',ws_live)
 q.on('request',lambda r:CALLS.append(r.url) if ('/api/memory/remember' in r.url or '/api/library' in r.url) else None)
 q.goto('https://atlas.test/');q.wait_for_timeout(600)
 q.locator('#voiceStart').click();q.locator('#voiceConsentDialog').wait_for(state='visible',timeout=8000);q.locator('#modelConsent').check();q.locator('#voiceConsentStart').click()
 q.wait_for_function('()=>AtlasVoice.status().phase==="live"',timeout=8000);q.wait_for_timeout(300)
 q.locator('#voiceEnd').click();q.locator('#voiceRestart').click();q.locator('#voiceRestartDialog').wait_for(state='visible');q.locator('#voiceRestartConfirm').click()
 q.wait_for_function('()=>AtlasVoice.status().phase==="live"',timeout=8000);q.wait_for_timeout(500)
 check('restart: the server sees start, discard, start (never end)',[t for t in GOT2 if t!='playback']==['start','discard','start'])
 check('restart: nothing saved, nothing sent to the library or memory',q.evaluate('window.ATLAS_VOICE_BRIDGE.context().isNew===true') and not CALLS and not q.locator('#reportDialog').is_visible())
 check('restart: the discarded conversation left the screen','Discard me please' not in q.locator('body').inner_text())
 ctx2.close()
 # ---- Proof interview (WOW_SPEC F2.1 step 6, F2.8): gap-mode notes stay on the device; only the explicit apply reaches the library.
 # Bridge level: T2's voice client passes {mode, requestId} from the session's notes; the full-mode path above is unchanged.
 LIB=[];MEM=[];REF='a'*32;GAPID='b'*32
 def route3(r):
  u=r.request.url
  if u.endswith('/api/bootstrap'):return r.fulfill(json=dict(BOOT,library=True,memory=True))
  if u.rstrip('/')=='https://atlas.test':return r.fulfill(body=H,content_type='text/html')
  if u.endswith('/api/memory/settings'):return r.fulfill(json={'off':False}) # memory is OFF by default: this person turned it on
  if u.endswith('/api/memory/remember'):MEM.append(r.request.post_data_json);return r.fulfill(json={'stored':True})
  if u.endswith('/api/library') and r.request.method=='POST':LIB.append(r.request.post_data_json);return r.fulfill(json={'id':REF,'revision':len(LIB),'status':'in_review'})
  if u.endswith('/api/library/invitations'):return r.fulfill(json={'items':[]})
  r.fulfill(status=404,body='')
 ctx3=b.new_context(viewport={'width':1440,'height':1000});g=ctx3.new_page();g.on('pageerror',lambda e:ERR.append(str(e)))
 g.route('**/*',route3);g.goto('https://atlas.test/');g.wait_for_timeout(600)
 proj=lambda:g.evaluate('window.ATLAS_LOCAL.snapshot().profiles[0].projects')
 g.evaluate("(s)=>window.ATLAS_VOICE_BRIDGE.autoSave(s,['I owned the routing design.',null,null,null,null,null],'Full interview words.',null)",g.evaluate('window.ATLAS_VOICE_BRIDGE.context()'))
 g.wait_for_function('()=>window.ATLAS_LOCAL.snapshot().profiles[0].projects[0]?.library?.id',timeout=5000);g.wait_for_timeout(400)
 check('full mode: still one automatic library save and one memory call',len(LIB)==1 and len(MEM)==1 and proj()[0]['library']['id']==REF)
 check('the library save is a private draft (G2)',LIB[0].get('draft') is True)
 check('memory gets short facts only: no conversation text (G2)','conversation' not in MEM[0])
 pid=g.evaluate(f"window.ATLAS_APP.startFromGap({{id:'{GAPID}',referenceId:'{REF}',bidAlias:'[company] data platform bid'}})")
 c=g.evaluate('window.ATLAS_VOICE_BRIDGE.context()')
 check('proof request: the local project linked to the reference is used, and the gap rides on its context',pid==proj()[0]['id'] and len(proj())==1 and c.get('gap')==GAPID and c.get('gapAlias')=='[company] data platform bid')
 other=g.evaluate("(()=>{const A=window.ATLAS_APP,p=AtlasEngine.project({title:'Another project'});A.profile().projects.push(p);A.profile().lastProject=p.id;const c=window.ATLAS_VOICE_BRIDGE.context();A.profile().projects.pop();A.profile().lastProject=A.profile().projects[0].id;return c;})()")
 check('proof request: never offered on another project','gap' not in other and 'gapAlias' not in other)
 g.evaluate('window.ATLAS_VOICE_BRIDGE.gapConsumed()')
 check('gapConsumed: the next start on the same project is a full interview','gap' not in g.evaluate('window.ATLAS_VOICE_BRIDGE.context()'))
 before=proj()[0];n0,m0=len(LIB),len(MEM)
 bad=g.evaluate("(s)=>{try{window.ATLAS_VOICE_BRIDGE.autoSave(s,['x',null,null,null,null,null],'t',null,{mode:'gap',requestId:'not-a-request'});return 'saved';}catch(e){return e.message;}}",c)
 check('gap mode: a malformed request id is refused',bad=='This gap request is not available to you.' and proj()[0].get('gapNotes') is None)
 r=g.evaluate(f"(s)=>window.ATLAS_VOICE_BRIDGE.autoSave(s,['Tickets bounced 40% less after the change.',null,null,'Measured on the ticket log.',null,null],'Gap interview words.',null,{{mode:'gap',requestId:'{GAPID}'}})",c)
 g.wait_for_timeout(800);x=proj()[0]
 check('gap mode: no POST /api/library and no /api/memory/remember',len(LIB)==n0 and len(MEM)==m0)
 check('gap mode: p.gapNotes set; answers and revision unchanged',r.get('mode')=='gap' and x['gapNotes']['requestId']==GAPID and x['gapNotes']['sections'][0]=='Tickets bounced 40% less after the change.' and x['gapNotes']['transcript']=='Gap interview words.' and x['answers']==before['answers'] and x['recordRevision']==before['recordRevision'] and x['interview']==before['interview'])
 res=g.evaluate('window.ATLAS_APP.applyGapNotes().then(r=>({projectId:r.projectId,synced:!!r.library}))');g.wait_for_timeout(600);x=proj()[0]
 check('apply: exactly one library save, to the same reference',res['synced'] and len(LIB)==n0+1 and LIB[-1]['id']==REF and 'Tickets bounced 40% less' in LIB[-1]['reference']['answers'][0])
 check('apply: answers appended, notes cleared, revision bumped, no memory call',x['answers'][0]=='I owned the routing design.\n\nTickets bounced 40% less after the change.' and x['answers'][3]=='Measured on the ticket log.' and x['gapNotes'] is None and x['recordRevision']>before['recordRevision'] and len(MEM)==m0)
 again=g.evaluate('window.ATLAS_APP.applyGapNotes().then(()=>"applied twice",e=>e.message)');g.wait_for_timeout(300)
 check('apply: a second click adds nothing and posts nothing',again=='There are no proof-interview answers to add.' and len(LIB)==n0+1)
 ctx3.close()
 check('no page errors',not ERR);print(ERR,GOT)
