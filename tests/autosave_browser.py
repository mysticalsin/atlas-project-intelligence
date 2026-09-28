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
 check('consent says saved with a report','saved with a report' in p.locator('#modelConsentText').inner_text())
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
 check('no page errors',not ERR);print(ERR,GOT)
