"""Ask ATLAS in the Library (WOW_SPEC F6.3, F6.4 #4, F6.1 spoken gating) in a real browser against the built page with mocked
routes (harness (a): /api/bootstrap, /api/library/ask and /api/transcribe answered in memory per the section 3 contracts).
Chromium's fake microphone stands in for a person; no network, no model, no speech-to-text provider.
  python3 tests/ask_browser.py
"""
import json,os,re
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];ERR=[];CALLS=[]
def built_page():return (ROOT/'ATLAS_Voice.html').read_text()
def check(n,v):print(('PASS ' if v else 'FAIL ')+n);assert v,n
S={'features':{'bids':False,'ask':False,'spokenAsk':False,'wins':False,'gaps':False,'claims':False,'outreach':False,'staffing':False,'teams':'BLOCKED_EXTERNAL','phone':'BLOCKED_EXTERNAL'},'empty':False}
R1,R2='a'*32,'b'*32
LABEL='Answers are interpretation over the library; open each reference for the facts. People are listed by the projects they worked on, never ranked.'
def summary(rid,title,country):return {'id':rid,'title':title,'status':'published','revision':2,'access':'public','mine':False,'owner':'','client':'','practice':'Data & AI','industry':'Insurance','country':country,'serviceLines':[],'technologies':[],'headline':'','impact':None,'qualityScore':80,'qualityStatus':'ready','updatedAt':'2026-09-01'}
def answer():
 if S['empty']:return {'verdict':'none','method':'semantic + model ranking','results':[],'people':[],'countries':[],'totals':{'visible':0},'note':'','label':LABEL}
 return {'verdict':'partial','method':'semantic + model ranking','results':[
  {**summary(R1,'Claims routing','France'),'relevance':58,'similarity':0.62,'retrieval':'semantic','why':'Same claims backlog problem','caveat':'Smaller team',
   'snippets':[{'kind':'consultant_words','topic':'outcome','text':'Triage fell from 40 to 12 minutes per claim.'},{'kind':'evidence','sourceName':'Ops dashboard','text':'<img src=x onerror=window.__pwned=1>Before and after quarters.'}],'people':[{'name':'Alex Martin','role':'Data engineer','email':'alex@mantu.com'}]},
  {**summary(R2,'Queue operations','Spain'),'relevance':None,'similarity':0.12,'retrieval':'lexical','why':'','caveat':'Not ranked: the ranking model did not answer.','snippets':[{'kind':'consultant_words','topic':1,'text':'I ran the pilot with two teams.'}],'people':[{'name':'Sam Lee','role':'Analyst'}]}],
  'people':[{'name':'Alex Martin','role':'Data engineer','email':'alex@mantu.com','refIds':[R1]},{'name':'Sam Lee','role':'Analyst','refIds':[R2]}],
  'countries':[{'name':'France','n':1},{'name':'Spain','n':1}],'totals':{'visible':2},'note':'','label':LABEL}
def boot():return {'provider':'workers','csrf':'tok','identity':{'name':'kim@mantu.com','mode':'access','subjectKey':'k'},'email':'kim@mantu.com','library':True,'libraryRole':'user','memory':False,'features':S['features']}
def route(r):
 req=r.request;u=urlparse(req.url);path=u.path;m=req.method
 if req.url.rstrip('/')=='https://atlas.test':return r.fulfill(body=built_page(),content_type='text/html')
 if path=='/api/bootstrap':return r.fulfill(json=boot())
 if not path.startswith('/api/'):return r.fulfill(status=404,body='')
 CALLS.append({'m':m,'path':path,'csrf':req.headers.get('x-atlas-csrf'),'type':req.headers.get('content-type'),'consent':req.headers.get('x-atlas-consent'),'body':req.post_data_buffer if m=='POST' else None})
 if m=='POST' and req.headers.get('x-atlas-csrf')!='tok':return r.fulfill(status=403,json={'error':'CSRF'})
 if path=='/api/library/invitations':return r.fulfill(json={'items':[]})
 if path=='/api/library':return r.fulfill(json={'items':[],'total':0,'facets':{'country':{},'industry':{}}})
 if path=='/api/library/ask':return r.fulfill(json=answer())
 if path=='/api/transcribe':return r.fulfill(json={'text':'What have we done on claims backlogs in insurance?','language':'en'})
 return r.fulfill(status=404,json={'error':'not mocked: '+path})
def calls(path):return [c for c in CALLS if c['path']==path]
def no_overflow(p):return p.evaluate('document.scrollingElement.scrollWidth<=document.scrollingElement.clientWidth+1')
ASK_REC_PROBE="""(() => {
 if (window.__askBrowserProbeInstalled) return;
 window.__askBrowserProbeInstalled = true;
 window.__atlasAskRecordedBytes = 0;
 window.__atlasAskBytesHooked = false;
 window.__atlasAskSlowMicUntil = 0;
 const Orig = AudioWorkletNode;
 window.AudioWorkletNode = function(ctx, name, options) {
  const node = new Orig(ctx, name, options);
  if (name === 'atlas-duplex') {
   node.port.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.type !== 'pcm' || !d.buffer) return;
    if (window.__atlasAskSlowMicUntil && performance.now() < window.__atlasAskSlowMicUntil) return;
    const len = d.buffer.byteLength || 0;
    window.__atlasAskRecordedBytes = (window.__atlasAskRecordedBytes || 0) + len;
    window.__atlasAskBytesHooked = true;
   });
  }
  return node;
 };
 window.AudioWorkletNode.prototype = Orig.prototype;
})();"""
def ask_min_bytes():
 m=re.search(r'MIN_BYTES=(\d+)',(ROOT/'src'/'ask-ui.js').read_text())
 assert m,'MIN_BYTES not found in src/ask-ui.js'
 return int(m.group(1))
def ask_recording_byte_target():
 return max(ask_min_bytes(),int(48000*0.6))
def wait_for_ask_minimum_recording(p,target,timeout=25000):
 p.wait_for_function("""(minB) => {
  if (!window.__atlasAskBytesHooked) return false;
  return (window.__atlasAskRecordedBytes || 0) >= minB;
 }""",arg=target,timeout=timeout)
with sync_playwright() as pw:
 br=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None,args=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required'])
 def page(w=1440,ask_rec_probe=False):
  c=br.new_context(viewport={'width':w,'height':1000},permissions=['microphone'])
  if ask_rec_probe:c.add_init_script(ASK_REC_PROBE)
  p=c.new_page();p.on('pageerror',lambda e:ERR.append(str(e)))
  p.route('**/*',route);p.goto('https://atlas.test/');p.locator('header [data-view=library]').click();p.locator('#recommendQuery').wait_for(state='visible');return p
 p=page()
 check('Ask ATLAS hidden while features.ask is false',p.locator('#askAtlas').is_hidden() and p.locator('#askQuestion').count()==0)
 check('"Find references for a meeting" unchanged',p.locator('#recommendQuery').is_visible())
 S['features']=dict(S['features'],ask=True);p=page()
 check('Ask ATLAS at the top of the Library when features.ask',p.locator('#askAtlas').is_visible() and p.evaluate("document.getElementById('askAtlas').compareDocumentPosition(document.querySelector('.recommend'))&Node.DOCUMENT_POSITION_FOLLOWING")>0)
 check('mic hidden when spokenAsk is false',p.locator('#askMic').is_hidden() and p.locator('#askMicConsentRow').is_hidden())
 p.locator('#askQuestion').fill('claims');p.locator('#askGo').click();p.locator('#askStatus', has_text='at least 8 characters').wait_for()
 check('a question under 8 characters is not sent',not calls('/api/library/ask') and 'at least 8 characters' in p.locator('#askStatus').inner_text())
 Q='What have we done for claims backlogs in insurance?'
 p.locator('#askQuestion').fill(Q)
 with p.expect_response(lambda r: '/api/library/ask' in r.url and r.request.method=='POST'):
  p.locator('#askGo').click()
 p.locator('#askResults .ask-result').first.wait_for()
 c=calls('/api/library/ask')
 check('typed question posted once with CSRF',len(c)==1 and json.loads(c[0]['body'])=={'question':Q,'limit':6} and c[0]['csrf']=='tok')
 check('verdict copy mirrors F1',p.locator('#askVerdict .verdict-banner strong').inner_text()=='Partial matches only. Check each caveat.' and 'never ranked' in p.locator('#askVerdict').inner_text())
 res=p.locator('#askResults .ask-result')
 t=res.first.inner_text().lower()
 check('result cards with status, relevance, similarity, why, caveat and snippets with source labels',res.count()==2 and all(x in t for x in ['published','relevance 58','similarity 0.62','semantic','same claims backlog problem','caveat: smaller team','triage fell from 40 to 12 minutes per claim.','outcome','evidence · ops dashboard']))
 check('unranked result says so, keyword retrieval, numeric topic labelled','not ranked' in res.nth(1).inner_text() and 'keyword' in res.nth(1).inner_text() and 'Contribution' in res.nth(1).inner_text())
 check('hostile snippet text inert',res.first.locator('img').count()==0 and not p.evaluate('window.__pwned'))
 lit=p.locator('#askMap path.geo-country[data-state^="count-"]')
 check('the map lights up the result countries (F6.4 #4)',lit.count()==2 and sorted(lit.evaluate_all('e=>e.map(x=>x.dataset.code)'))==['ESP','FRA'])
 ppl=p.locator('#askPeople')
 check('people to call: record membership, never ranked, email only when present',ppl.is_visible() and 'never ranked' in ppl.inner_text() and ppl.locator('li').count()==2 and ppl.locator('li').nth(0).locator('a[href^="mailto:"]').count()==1 and '@' not in ppl.locator('li').nth(1).inner_text())
 p.set_viewport_size({'width':320,'height':800});p.locator('#askMap').wait_for()
 check('no horizontal overflow at 320 px with results and the map',no_overflow(p))
 p.set_viewport_size({'width':1440,'height':1000})
 S['empty']=True
 with p.expect_response(lambda r: '/api/library/ask' in r.url and r.request.method=='POST'):
  p.locator('#askGo').click()
 p.locator('#askVerdict .verdict-banner strong', has_text='Nothing in the library answers this yet.').wait_for()
 check('empty result stated plainly, nothing shown as a match',p.locator('#askVerdict .verdict-banner strong').inner_text()=='Nothing in the library answers this yet.' and p.locator('#askResults .ask-result').count()==0 and p.locator('#askMap path[data-state]').count()==0 and p.locator('#askPeople').is_hidden())
 S['empty']=False
 # spoken Ask: only with the flag and getUserMedia; consent asked at the moment of use (WOW_ZERO_CONFIG D1: the tick became a
 # prompt, "Allow this time" or "Always allow for me"); locked during a voice interview
 slow_mic_ms=int(os.environ.get('ASK_BROWSER_SLOW_MIC_MS','0') or '0')
 S['features']=dict(S['features'],spokenAsk=True);p=page(ask_rec_probe=True)
 mic=p.locator('#askMic');cp=p.locator('#askConsent')
 check('mic shown with spokenAsk and getUserMedia; nothing asked before it is used',mic.is_visible() and cp.is_hidden())
 mic.click();p.locator('#askConsent', has_text='Ask by voice').wait_for()
 check('consent asked at the moment of use: "Ask by voice", no client names; nothing recorded yet',cp.is_visible() and 'Ask by voice' in cp.inner_text() and 'don’t say client names' in cp.inner_text().lower() and p.locator('#askAllowOnce').is_visible() and mic.inner_text()=='Speak')
 check('"Always allow" is offered only where the profile can store it',p.locator('#askAllowAlways').is_hidden())
 p.locator('#askConsentCancel').click();p.locator('#askConsent').wait_for(state='hidden')
 check('Cancel: no recording and nothing sent',cp.is_hidden() and mic.inner_text()=='Speak' and not calls('/api/transcribe'))
 p.evaluate("window.__realStatus=window.AtlasVoice.status;window.AtlasVoice.status=()=>({...window.__realStatus(),phase:'live'})")
 p.wait_for_function("() => document.getElementById('askMic').disabled")
 check('mic disabled while AtlasVoice.status().phase is live',mic.is_disabled() and p.locator('#askMicBusy').is_visible())
 for ph in ['preparing','connecting','ending']:
  p.evaluate(f"window.AtlasVoice.status=()=>({{...window.__realStatus(),phase:'{ph}'}})")
  p.wait_for_function("() => document.getElementById('askMic').disabled")
  check(f'mic disabled while the interview is {ph}',mic.is_disabled())
 p.evaluate("window.AtlasVoice.status=window.__realStatus")
 p.wait_for_function("() => !document.getElementById('askMic').disabled")
 check('mic enabled again once the interview is idle',mic.is_enabled() and p.locator('#askMicBusy').is_hidden())
 asked=len(calls('/api/library/ask'));mic.click();p.locator('#askAllowOnce').click();p.locator('#askRecLine').wait_for()
 check('recording: the button becomes Stop, with the reminder and a recording indicator',mic.inner_text()=='Stop' and 'Listening' in p.locator('#askStatus').inner_text() and p.locator('#askRecLine').is_visible() and 'Don’t say client names' in p.locator('#askRecLine').inner_text())
 if slow_mic_ms:p.evaluate(f'window.__atlasAskSlowMicUntil=performance.now()+{slow_mic_ms}')
 p.evaluate('window.__recStart=performance.now()')
 red_demo=os.environ.get('ASK_BROWSER_RED_DEMO')=='1'
 wait_ms=120 if red_demo else 700
 p.wait_for_function(f'() => performance.now()-window.__recStart>={wait_ms}')
 with p.expect_response(lambda r: '/api/transcribe' in r.url and r.request.method=='POST'):
  mic.click()
 t=calls('/api/transcribe')
 n=len(t[0]['body']) if t else 0
 check('stop posts raw PCM16 24 kHz once, with CSRF, even length within 4,800..1,536,000 bytes',len(t)==1 and t[0]['type']=='audio/L16;rate=24000' and t[0]['csrf']=='tok' and n%2==0 and 4800<=n<=1536000)
 check('the request carries the consent the page showed (a UI gate): spoken-ask-v1; once',t[0]['consent']=='spoken-ask-v1; once' and p.locator('#askRecLine').is_hidden())
 check('about 1.5 s of audio at 24 kHz (default-rate context resampled by the worklet)',48000*0.6<=n<=48000*3)
 check('transcript shown, editable, and not asked automatically',p.locator('#askQuestion').input_value()=='What have we done on claims backlogs in insurance?' and p.locator('#askQuestion').is_editable() and len(calls('/api/library/ask'))==asked and 'edit the text' in p.locator('#askStatus').inner_text())
 st=p.evaluate('AtlasVoice.status()')
 check('the voice interview state is untouched by the question recording',st['phase']=='idle' and not st['hasMicrophone'])
 mic.click();p.locator('#askAllowOnce').click();p.locator('#askRecLine').wait_for()  # each recording without a stored consent is asked again
 p.evaluate("window.AtlasVoice.status=()=>({...window.__realStatus(),phase:'connecting'})")
 p.locator('#askStatus', has_text='discarded').wait_for()
 check('a voice interview starting mid-recording discards the recording: nothing sent',len(calls('/api/transcribe'))==1 and 'discarded' in p.locator('#askStatus').inner_text() and mic.is_disabled())
 p.evaluate("window.AtlasVoice.status=window.__realStatus")
 br.close()
check('no page errors',not ERR);print('errors:',ERR) if ERR else None
