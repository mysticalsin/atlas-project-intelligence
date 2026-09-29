"""Trust and capture UI (WOW_SPEC F3.4, F4.7, F2.6 workspace, F4.7 #invitation deep link) in a real browser against the built page
with mocked routes (harness (a): /api/bootstrap and the claims, confirmations, gaps, outreach and staffing routes answered in memory
per the section 3 contracts). Nothing is sent anywhere; the server side is covered by the edge unit tests.
  python3 tests/trust_browser.py
"""
import json,os,re
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];H=(ROOT/'ATLAS_Voice.html').read_text();ERR=[];CALLS=[]
def check(n,v):print(('PASS ' if v else 'FAIL ')+n);assert v,n
FEATURES={'bids':False,'ask':False,'spokenAsk':False,'wins':False,'gaps':True,'gapInterview':True,'claims':True,'clientConfirm':False,'outreach':True,'staffing':True,'teams':'BLOCKED_EXTERNAL','phone':'BLOCKED_EXTERNAL'}
USERS={'owner':('alex@mantu.com','user'),'reviewer':('reviewer@mantu.com','reviewer')}
R1,R2,GAP,GAP2,INV,REQ='a'*32,'b'*32,'c'*32,'e'*32,'f'*32,'d'*32
S={'features':dict(FEATURES),'outreach':None,'gaps':None}
ANSWERS=['Zebracorp had claims bouncing between three teams.','I designed and built the routing model.','We compared rules against a model.','Triage fell from 40 to 12 minutes per claim.','Operations dashboard export v3.','Any insurer with manual routing.']
def record(rid,access):
 full=access=='full'
 return {'id':rid,'title':'Claims routing','status':'published','revision':4,'access':access,'mine':full,'practice':'Data & AI','industry':'Insurance','country':'France','serviceLines':['Data & AI'],'technologies':['Python'],'headline':'Claims triage rebuilt','impact':None,'qualityScore':82,'qualityStatus':'ready','updatedAt':'2026-09-01','nextReview':None,'owner':'alex@mantu.com' if full else '','client':'Zebracorp' if full else '',
  'data':{'title':'Claims routing','stage':'Production','sector':'Insurance','consultant':{'name':'Alex Martin','role':'Data engineer'},'client':{'name':'Zebracorp','location':'Lyon','contact':''} if full else {},
   'details':{'projectId':'PRJ-2291','country':'France','start':'2024-03','end':'2024-11','duration':'','teamSize':6,'teamRoles':['Data engineer'],'technologies':['Python'],'deliverables':['Routing model'],'serviceLines':['Data & AI'],'consultants':[{'name':'Sam Lee','email':'sam@mantu.com' if full else '','role':'Analyst'}],'links':[]},
   'answers':ANSWERS,'report':{'headline':'Claims triage rebuilt','summary':'The consultant rebuilt claims triage for the client.','topics':{},'highlights':[],'gaps':[],'follow_ups':[]},'jev':None,'validation':{'manager':{'name':'Sam Lee','email':'sam@mantu.com'},'managerStaff':False},'sheet':None,
   'sources':[{'name':'Ops dashboard','version':'v3','url':'','excerpt':'Before and after quarters.'}]},
  'state':{'quality':None,'validation':{'status':'validated','by':'sam@mantu.com','at':'2026-09-02'} if full else {'status':'validated'},'withdrawn':False,'duplicates':[]},'revisions':[],'audit':[],
  'permissions':{'edit':full,'validate':False,'withdraw':full,'review':full,'reinstate':False,'merge':False}}
def claim(i,st,cur=True,conf=None,note=None,topic=3,text=None):return {'id':f'c{i}','refId':R1,'revision':3,'topic':topic,'idx':i,'text':text or f'Sentence number {i} of the outcome.','status':st,'current':cur,**({'confirmedRevision':conf} if conf else {}),**({'note':note} if note else {})}
CLAIMS={'refId':R1,'revision':4,'currency':'sentence','claims':[claim(1,'unverified',topic=1,text='<img src=x onerror=window.__pwned=1>I designed and built the routing model.'),claim(2,'manager_confirmed',conf=4),claim(3,'manager_confirmed',conf=3),claim(4,'corrected',conf=4,note='It was 14 minutes, not 12'),claim(5,'cant_say',conf=4),claim(6,'manager_confirmed',cur=False,conf=3)],
 'candidates':[{'topic':1,'idx':0,'text':'<img src=x onerror=window.__pwned=1>I designed and built the routing model.'},{'topic':2,'idx':0,'text':'We compared rules against a model.'}],
 'requests':[{'id':'q1','refId':R1,'revision':4,'kind':'manager','toEmail':'sam@mantu.com','managerSource':'staffing','claimIds':['c2','c4','c5'],'status':'done','createdAt':'2026-09-01','expiresAt':'2026-09-15','decidedAt':'2026-09-02'},
  {'id':'q2','refId':R1,'revision':3,'kind':'manager','toEmail':'sam@mantu.com','managerSource':'self_declared','claimIds':['c3','c6'],'status':'done','createdAt':'2026-08-01','expiresAt':'2026-08-15','decidedAt':'2026-08-02'}]}
def outreach_rows():return [{'id':'o1','kind':'interview_invite','subjectId':INV,'channel':'email_draft','toEmail':'alex@mantu.com','status':'pending_approval','reason':'','createdAt':'2026-09-29','approvedBy':None,'approvedAt':None,'sentAt':None,'preview':{'title':'12 minutes while it\'s fresh?','text':'Project PRJ-2291 ends this week. <b>Start</b> the interview.'}},
 {'id':'o2','kind':'interview_invite','subjectId':INV,'channel':'teams','toEmail':'alex@mantu.com','status':'pending_approval','reason':'','createdAt':'2026-09-29','approvedBy':None,'approvedAt':None,'sentAt':None,'preview':{'title':'12 minutes while it\'s fresh?','text':'Project PRJ-2291 ends this week.'}},
 {'id':'o3','kind':'gap_request','subjectId':GAP,'channel':'email_draft','toEmail':'sam@mantu.com','status':'pending_approval','reason':'','createdAt':'2026-09-29','approvedBy':None,'approvedAt':None,'sentAt':None,'preview':{'title':'Proof request','text':'A bid needs proof: [company] claims triage.'}}]
def gaps():return {'assigned':[{'id':GAP,'bidId':'9'*32,'bidAlias':'Falcon for [company]','requirementIds':['R2'],'asks':[{'id':'G1','field':'outcome','label':'Outcome','ask':'Proof the bid needs: measured reduction in handling time'}],'referenceId':R1,'status':'open','createdAt':'2026-09-29','answeredAt':None,'results':None},
 {'id':GAP2,'bidId':'9'*32,'bidAlias':'Heron','requirementIds':['R1'],'asks':[{'id':'G1','field':'contribution','label':'Contribution','ask':'Proof the bid needs: <b>claims</b> automation'}],'referenceId':R2,'status':'open','createdAt':'2026-09-29','answeredAt':None,'results':None}],'created':[]}
ANALYTICS={'totals':{'visible':2,'published':1,'byStatus':[{'name':'published','n':1}]},'byCountry':[{'name':'France','n':1}],'byServiceLine':[],'byPractice':[],'byIndustry':[],'byTechnology':[],'byConsultant':[],'byClient':[],'coverage':[],'coverageGaps':[],'strongest':[],'needsEnrichment':[],'activityWithoutReference':[]}
def boot(who):return {'provider':'workers','csrf':'tok','identity':{'name':USERS[who][0],'mode':'access','subjectKey':who},'email':USERS[who][0],'library':True,'libraryRole':USERS[who][1],'memory':False,'features':S['features']}
def make_route(who):
 def route(r):
  req=r.request;u=urlparse(req.url);path=u.path;m=req.method;body=json.loads(req.post_data or '{}') if m=='POST' and 'json' in (req.headers.get('content-type') or '') else None
  if req.url.split('#')[0].rstrip('/')=='https://atlas.test':return r.fulfill(body=H,content_type='text/html')
  if path=='/api/bootstrap':return r.fulfill(json=boot(who))
  if not path.startswith('/api/'):return r.fulfill(status=404,body='')
  CALLS.append((who,m,path,body,req.headers.get('x-atlas-csrf')))
  if m=='POST' and req.headers.get('x-atlas-csrf')!='tok':return r.fulfill(status=403,json={'error':'CSRF'})
  if path=='/api/library/invitations':return r.fulfill(json={'items':[{'id':INV,'title':'Claims pilot','project_id':'PRJ-2291','reason':'project_end','slot':None,'reference_id':None}]})
  if path=='/api/library':
   if m=='POST':return r.fulfill(json={'id':R1,'revision':5,'status':'in_review','unchanged':False})
   return r.fulfill(json={'items':[],'total':0,'facets':{'country':{},'industry':{}}})
  if path=='/api/library/analytics':return r.fulfill(json=ANALYTICS)
  if path=='/api/library/gaps':return r.fulfill(json=S['gaps'])
  ma=re.match(r'^/api/library/gaps/([a-f0-9]{32})/answer$',path)
  if ma:S['gaps']['assigned']=[g for g in S['gaps']['assigned'] if g['id']!=ma.group(1)];return r.fulfill(json={'id':ma.group(1),'status':'answered'})
  mm=re.match(r'^/api/library/gaps/([a-f0-9]{32})/dismiss$',path)
  if mm:S['gaps']['assigned']=[g for g in S['gaps']['assigned'] if g['id']!=mm.group(1)];return r.fulfill(json={'id':mm.group(1),'status':'dismissed'})
  if path==f'/api/library/claims/{R1}':return r.fulfill(json=CLAIMS)
  if path=='/api/library/claims' and m=='POST':return r.fulfill(status=201,json={'claims':[{**claim(9,'unverified',topic=it['topic'],text=it['text']),'id':f'n{i}'} for i,it in enumerate(body['items'])]})
  if path=='/api/library/confirmations' and m=='POST':
   return r.fulfill(status=201,json={'request':{'id':REQ,'refId':R1,'revision':4,'kind':'manager','toEmail':'sam@mantu.com','managerSource':'staffing','claimIds':body['claimIds'],'status':'open','createdAt':'2026-09-29','expiresAt':'2026-10-13','decidedAt':None},
    'draft':{'to':'sam@mantu.com','subject':"Can you confirm 2 points from Alex Martin's project? (about 60 seconds)",'body':'Please confirm: https://atlas.test/confirm#'+REQ,'link':'https://atlas.test/confirm#'+REQ},
    'outreach':[{'id':'o8','channel':'teams','status':'pending_approval'},{'id':'o9','channel':'email_draft','status':'pending_approval'}]})
  mr=re.match(r'^/api/library/([a-f0-9]{32})$',path)
  if mr:return r.fulfill(json=record(mr.group(1),'full' if mr.group(1)==R1 and who=='owner' else 'public'))
  if path=='/api/library/outreach':return r.fulfill(json={'items':S['outreach'],'channels':{'teams':'BLOCKED_EXTERNAL','email_draft':'available','phone':'BLOCKED_EXTERNAL'}})
  mo=re.match(r'^/api/library/outreach/(o\d)$',path)
  if mo:
   row=next(x for x in S['outreach'] if x['id']==mo.group(1));out={}
   if body['action']=='dismiss':row['status']='dismissed'
   elif row['channel']=='teams':row.update(status='blocked_external',reason='Teams is not connected: tenant app, bot credentials and TEAMS_* settings are missing.')
   else:row.update(status='drafted',approvedBy=USERS[who][0]);out['draft']={'to':row['toEmail'],'subject':"12 minutes while it's fresh?",'body':'Start: https://atlas.test/#invitation/'+INV,'ics':'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR'}
   return r.fulfill(json={'item':row,**out})
  if path=='/api/library/staffing/import':
   return r.fulfill(json={'rows':3,'staffed':2,'invited':1,'outreachQueued':2,'ignoredColumns':['client_name','notes'],'rejected':[{'line':4,'error':'end_date must be YYYY-MM-DD'}]})
  return r.fulfill(status=404,json={'error':'not mocked: '+path})
 return route
def posts(path_re):return [c for c in CALLS if c[1]=='POST' and re.search(path_re,c[2])]
def gets(path_re):return [c for c in CALLS if c[1]=='GET' and re.search(path_re,c[2])]
def no_overflow(p):return p.evaluate('document.scrollingElement.scrollWidth<=document.scrollingElement.clientWidth+1')
with sync_playwright() as pw:
 br=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
 def page(who,w=1440,hash=''):
  c=br.new_context(viewport={'width':w,'height':1000},accept_downloads=True);p=c.new_page();p.on('pageerror',lambda e:ERR.append(str(e)))
  p.route('**/*',make_route(who));p.goto('https://atlas.test/'+hash);p.wait_for_timeout(700);return p
 # ---- F3.4 claims block in the record dialog
 S['gaps']=gaps();o=page('owner');o.evaluate(f"window.ATLAS_APP.switchView('library')");o.wait_for_timeout(400)
 o.evaluate(f"document.body.insertAdjacentHTML('beforeend','<button data-open-record=\"{R1}\" id=\"openR1\">o</button>')");o.locator('#openR1').click();o.wait_for_timeout(800)
 cb=o.locator('#claimsBlock')
 check('claims block shown in the record dialog for a full-access reader',o.locator('#recordDialog').is_visible() and cb.is_visible() and len(gets(rf'/claims/{R1}$'))==1)
 txt=cb.text_content()
 for badge in ['Unverified','Confirmed by N+1 (staffing record)','Confirmed by N+1 (named by the consultant) on r3; sentence unchanged','Corrected: It was 14 minutes, not 12','N+1 couldn’t say','Stale: confirmed on r3; the sentence changed']:
  check(f'badge "{badge}"',badge in txt)
 check('no confirmed badge on a stale claim',cb.locator('[data-claim="c6"] .claim-confirmed').count()==0 and cb.locator('[data-claim="c6"] .claim-stale').count()==1)
 check('hostile claim text rendered inert',cb.locator('img').count()==0 and not o.evaluate('window.__pwned'))
 cb.locator('summary').click()
 chk=cb.locator('[data-claim-check]')
 check('candidate checkboxes: the unclaimed candidate plus the re-askable unverified claim',chk.count()==2)
 chk.nth(0).check();chk.nth(1).check();o.locator('#claimsRequest').click();o.wait_for_timeout(700)
 pc,pf=posts(r'/api/library/claims$'),posts(r'/api/library/confirmations$')
 check('claims proposed with the exact candidate text, then one manager confirmation request',len(pc)==1 and pc[0][3]=={'refId':R1,'items':[{'topic':2,'idx':0,'text':'We compared rules against a model.'}]} and len(pf)==1 and pf[0][3]=={'refId':R1,'claimIds':['c1','n0'],'kind':'manager'})
 href=o.locator('#claimsMailto').get_attribute('href') or ''
 check('draft as a mailto link, the copyable /confirm#id link, nothing sent',href.startswith('mailto:sam%40mantu.com?subject=') and o.locator('#claimsLink').inner_text()=='https://atlas.test/confirm#'+REQ and 'Nothing was sent' in cb.inner_text())
 check('outreach chips: Teams BLOCKED_EXTERNAL, email draft','Teams: BLOCKED_EXTERNAL' in cb.inner_text() and 'Email: awaiting approval' in cb.inner_text())
 o.locator('#claimsCopyLink').click();o.wait_for_timeout(150)
 o.set_viewport_size({'width':320,'height':800});o.wait_for_timeout(200)
 check('record dialog with claims fits at 320 px',o.evaluate("(()=>{const d=document.getElementById('recordDialog');return d.scrollWidth<=d.clientWidth+1})()"))
 o.set_viewport_size({'width':1440,'height':1000});o.locator('#recordDialog [data-close]').first.click()
 n=len(gets(r'/claims/'))
 o.evaluate(f"document.body.insertAdjacentHTML('beforeend','<button data-open-record=\"{R2}\" id=\"openR2\">o</button>')");o.locator('#openR2').click();o.wait_for_timeout(700)
 check('public-access record: no claims block and no claims request',o.locator('#claimsBlock').is_hidden() and len(gets(r'/claims/'))==n and o.locator('#claimsBlock').inner_html()=='')
 o.locator('#recordDialog [data-close]').first.click()
 # ---- F2.6 proof requests in the Library; startFromGap seeds from the library record (full access)
 o.locator('header [data-view=library]').click();o.wait_for_timeout(700)
 pr=o.locator('#proofRequests')
 check('proof requests listed next to your interviews with the asks',pr.is_visible() and 'Falcon for [company]' in pr.inner_text() and 'measured reduction in handling time' in pr.inner_text() and pr.locator('[data-gap-start]').count()==2 and pr.locator('b',has_text='claims').count()==0)
 pr.locator(f'[data-gap-start="{GAP}"]').click();o.wait_for_timeout(900)
 ctx=o.evaluate('window.ATLAS_VOICE_BRIDGE.context()')
 local=o.evaluate('window.ATLAS_APP.project()')
 check('start: seeded from the full-access library record and linked to it',local['library']['id']==R1 and local['library']['revision']==4 and local['title']=='Claims routing' and local['answers']==ANSWERS and local['client']['name']=='Zebracorp' and local['sources'][0]['text']=='Before and after quarters.')
 check('start: pending gap rides on that project only, and the Conversation view opens',ctx['gap']==GAP and ctx['gapAlias']=='Falcon for [company]' and ctx['project']['id']==local['id'] and o.locator('#interview').is_visible())
 check('no library write when starting',not posts(r'^/api/library$'))
 o.evaluate('window.ATLAS_VOICE_BRIDGE.gapConsumed()')
 o.locator('header [data-view=library]').click();o.wait_for_timeout(600);o.locator(f'[data-gap-start="{GAP}"]').click();o.wait_for_timeout(700)
 check('a second start reuses the linked project (no second copy)',o.evaluate(f"window.ATLAS_LOCAL.snapshot().profiles[0].projects.filter(p=>p.library&&p.library.id==='{R1}').length")==1)
 o.locator('header [data-view=library]').click();o.wait_for_timeout(600);o.locator(f'[data-gap-start="{GAP2}"]').click();o.wait_for_timeout(700)
 check('no full access to the reference: a new "Proof for <alias>" project',o.evaluate('window.ATLAS_APP.project().title')=='Proof for Heron' and o.evaluate('window.ATLAS_APP.project().library') is None and o.evaluate('window.ATLAS_VOICE_BRIDGE.context().gap')==GAP2)
 # gap-mode notes, then the explicit "Add these answers to my reference" from the Library
 pid=o.evaluate(f"window.ATLAS_LOCAL.snapshot().profiles[0].projects.find(p=>p.library&&p.library.id==='{R1}').id")
 o.evaluate(f"(()=>{{const s=window.ATLAS_LOCAL.snapshot();window.ATLAS_APP.profile().lastProject='{pid}';}})()")
 o.evaluate(f"window.ATLAS_APP.startFromGap({{id:'{GAP}',bidAlias:'Falcon for [company]',referenceId:'{R1}'}})");o.wait_for_timeout(500)
 o.evaluate(f"window.ATLAS_VOICE_BRIDGE.autoSave(window.ATLAS_VOICE_BRIDGE.context(),[null,null,null,'Handling time fell by 30% over six weeks.',null,null],'transcript words',null,{{mode:'gap',requestId:'{GAP}'}})")
 o.locator('header [data-view=library]').click();o.wait_for_timeout(700)
 check('answers kept on this device are offered for the reference, not synced',pr.locator('[data-gap-apply]').count()==1 and not posts(r'^/api/library$'))
 pr.locator('[data-gap-apply]').click();o.wait_for_timeout(200)
 check('adding the answers asks for confirmation first',o.locator('#confirmDialog').is_visible() and 'new revision' in o.locator('#confirmText').inner_text() and not posts(r'^/api/library$'))
 o.locator('#confirmYes').click();o.wait_for_timeout(900)
 sync=posts(r'^/api/library$')
 check('confirmed: exactly one sync of that same reference with the appended answer',len(sync)==1 and sync[0][3]['id']==R1 and sync[0][3]['reference']['answers'][3].endswith('Handling time fell by 30% over six weeks.') and pr.locator('[data-gap-apply]').count()==0)
 # Review #22: the per-ask results are kept with the notes, so after a reset (a new conversation) or a reload the Library
 # card still sends them to the bid team, on an explicit click only; adding them to the reference first keeps them sendable.
 RES=[{'askId':'G1','field':'outcome','status':'answered_unverified','quotes':['Handling time fell by 30%.']},{'askId':'G2','field':'evidence','status':'unknown','quotes':[]}]
 o.evaluate(f"window.ATLAS_APP.startFromGap({{id:'{GAP}',bidAlias:'Falcon for [company]',referenceId:'{R1}'}})");o.wait_for_timeout(500)
 o.evaluate(f"window.ATLAS_VOICE_BRIDGE.autoSave(window.ATLAS_VOICE_BRIDGE.context(),[null,null,null,'Second proof answer.',null,null],'transcript words',null,{{mode:'gap',requestId:'{GAP}',results:{json.dumps(RES)}}})")
 o.evaluate("window.dispatchEvent(new CustomEvent('atlas-session',{detail:{type:'reset'}}))")
 kept=o.evaluate(f"JSON.parse(JSON.stringify(window.ATLAS_LOCAL.snapshot())).profiles[0].projects.find(p=>p.library&&p.library.id==='{R1}').gapNotes")
 check('gap mode keeps the per-ask results with the notes',bool(kept) and kept.get('results')==[{k:v for k,v in x.items() if k!='field'} for x in RES])
 o.locator('header [data-view=library]').click();o.wait_for_timeout(700)
 card=pr.locator(f'[data-gap-item="{GAP}"]')
 check('after a new conversation the open request offers send and add; nothing sent yet',o.locator('#gapPanel').is_hidden() and card.locator('[data-gap-send]').count()==1 and card.locator('[data-gap-apply]').count()==1 and not posts(rf'/gaps/{GAP}/answer$'))
 card.locator('[data-gap-apply]').click();o.locator('#confirmYes').click();o.wait_for_timeout(900)
 check('adding them first keeps the answers sendable',len(posts(r'^/api/library$'))==2 and card.locator('[data-gap-apply]').count()==0 and card.locator('[data-gap-send]').count()==1)
 card.locator('[data-gap-send]').click();o.wait_for_timeout(200)
 check('sending asks for confirmation first',o.locator('#confirmDialog').is_visible() and 'unverified' in o.locator('#confirmText').inner_text() and not posts(rf'/gaps/{GAP}/answer$'))
 o.locator('#confirmYes').click();o.wait_for_timeout(900)
 sent=posts(rf'/gaps/{GAP}/answer$')
 check('confirmed: one POST with the stored results and the linked reference, with the CSRF header',len(sent)==1 and sent[0][3]=={'results':[{k:v for k,v in x.items() if k!='field'} for x in RES],'referenceId':R1} and sent[0][4]=='tok')
 check('once sent, the request leaves the list and nothing is left to send',pr.locator(f'[data-gap-item="{GAP}"]').count()==0 and o.evaluate(f"window.ATLAS_LOCAL.snapshot().profiles[0].projects.find(p=>p.library&&p.library.id==='{R1}').gapNotes")is None)
 # dismiss, and the #gap/<id> deep link
 pr.locator(f'[data-gap-dismiss="{GAP2}"]').click();o.locator('#confirmYes').click();o.wait_for_timeout(700)
 check('dismiss posts once and the request leaves the list',len(posts(rf'/gaps/{GAP2}/dismiss$'))==1 and pr.locator(f'[data-gap-item="{GAP2}"]').count()==0)
 S['gaps']=gaps();d=page('owner',hash=f'#gap/{GAP}');d.wait_for_timeout(800)
 check('#gap/<id> opens the Library with that request in focus',d.locator('#library').is_visible() and d.evaluate(f"document.activeElement&&document.activeElement.closest('[data-gap-item]')?.dataset.gapItem")==GAP and d.evaluate('location.hash')=='')
 # ---- F4.7 #invitation/<32hex> deep link (the Teams card's "Start now")
 iv=page('owner',hash=f'#invitation/{INV}');iv.wait_for_timeout(700)
 check('#invitation/<id> starts that interview once and clears the hash',iv.evaluate('window.ATLAS_APP.project()?.invitationId')==INV and iv.locator('#interview').is_visible() and iv.evaluate('location.hash')=='')
 # ---- F4.7 outreach queue and staffing import (Insights, reviewer)
 S['outreach']=outreach_rows();rv=page('reviewer');rv.locator('header [data-view=library]').click();rv.wait_for_timeout(600);rv.locator('#openInsights').click();rv.wait_for_timeout(900)
 q=rv.locator('#outreachQueue')
 check('outreach queue in Insights for a reviewer, with channel chips',q.is_visible() and q.locator('.outreach-row').count()==3 and 'Teams: BLOCKED_EXTERNAL' in q.locator('#outreachChannels').inner_text() and 'Phone: BLOCKED_EXTERNAL' in q.locator('#outreachChannels').inner_text())
 check('rows show kind, channel, preview and status; preview inert',all(x in q.inner_text() for x in ['Interview invitation','Email draft','Teams','Proof request','A bid needs proof: [company] claims triage.']) and q.locator('b',has_text='Start').count()==0 and q.locator('[data-outreach-approve]').count()==3)
 q.locator('[data-outreach-approve="o1"]').click();rv.wait_for_timeout(500)
 r1=q.locator('[data-outreach="o1"]');mh=r1.locator('[data-outreach-mailto]').get_attribute('href') or ''
 check('approving an email draft gives a mailto link, Copy and a .ics download; nothing sent',posts(r'/outreach/o1$')[-1][3]=={'action':'approve'} and mh.startswith('mailto:alex%40mantu.com?subject=') and r1.locator('[data-outreach-copy]').count()==1 and 'draft ready' in r1.inner_text().lower())
 with rv.expect_download() as dl:r1.locator('[data-outreach-ics]').click()
 check('.ics download from draft.ics',dl.value.suggested_filename=='ATLAS_interview.ics' and 'BEGIN:VCALENDAR' in Path(dl.value.path()).read_text())
 r1.locator('[data-outreach-copy]').click();rv.wait_for_timeout(150)
 q.locator('[data-outreach-approve="o2"]').click();rv.wait_for_timeout(500)
 r2=q.locator('[data-outreach="o2"]')
 check('approving Teams ends BLOCKED_EXTERNAL with the exact reason',('BLOCKED_EXTERNAL' in r2.inner_text()) and 'Teams is not connected' in r2.inner_text() and r2.locator('[data-outreach-approve]').count()==0)
 # Review #25: after a reload the approved email draft is gone from the page; the row offers it again (nothing is sent).
 rv2=page('reviewer');rv2.locator('header [data-view=library]').click();rv2.wait_for_timeout(600);rv2.locator('#openInsights').click();rv2.wait_for_timeout(900)
 q2=rv2.locator('#outreachQueue');d1=q2.locator('[data-outreach="o1"]')
 check('after a reload a drafted email row offers its draft again',d1.locator('[data-outreach-approve="o1"]').count()==1 and 'Show the draft again' in d1.inner_text() and d1.locator('[data-outreach-mailto]').count()==0)
 n1=len(posts(r'/outreach/o1$'));d1.locator('[data-outreach-approve="o1"]').click();rv2.wait_for_timeout(500)
 check('showing it again posts approve once and gives the mailto draft back; the row stays drafted',len(posts(r'/outreach/o1$'))==n1+1 and posts(r'/outreach/o1$')[-1][3]=={'action':'approve'} and (d1.locator('[data-outreach-mailto]').get_attribute('href') or '').startswith('mailto:alex%40mantu.com?subject=') and d1.locator('[data-outreach-approve]').count()==0 and 'draft ready' in d1.inner_text().lower())
 rv2.close()
 q.locator('[data-outreach-dismiss="o3"]').click();rv.wait_for_timeout(500)
 check('dismiss',posts(r'/outreach/o3$')[-1][3]=={'action':'dismiss'} and 'dismissed' in q.locator('[data-outreach="o3"]').inner_text().lower())
 st=rv.locator('#staffingImport')
 check('staffing import shown for a reviewer',st.is_visible() and st.locator('#staffingCsv').count()==1 and st.locator('#staffingGo').count()==1)
 CSV='project_id,consultant_email,manager_email,manager_name,project_title,end_date,client_name,notes\nPRJ-1,alex@mantu.com,sam@mantu.com,Sam,Claims,2026-10-01,Zebracorp,x\n'
 st.locator('#staffingFile').set_input_files(files=[{'name':'staffing.csv','mimeType':'text/csv','buffer':CSV.encode()}]);rv.wait_for_timeout(300)
 check('CSV file read into #staffingCsv',st.locator('#staffingCsv').input_value()==CSV)
 st.locator('#staffingGo').click();rv.wait_for_timeout(700)
 tb=st.locator('#staffingTable').inner_text()
 check('import posts the CSV and shows the result table',posts(r'/staffing/import$')[-1][3]=={'csv':CSV} and all(x in tb for x in ['Rows read\t3','Staffing rows saved\t2','Interview invitations\t1','Outreach waiting for approval\t2']))
 check('ignored columns shown with the explanation that client columns are never read','client_name, notes' in tb and 'Client, customer and account columns are never read or stored' in tb)
 check('rejected rows listed with line numbers','end_date must be YYYY-MM-DD' in st.locator('#staffingRejected').inner_text())
 rv.set_viewport_size({'width':320,'height':800});rv.wait_for_timeout(200)
 check('Insights with the queue and the import fits at 320 px',rv.evaluate("(()=>{const d=document.getElementById('insightsDialog');return d.scrollWidth<=d.clientWidth+1})()"))
 # plain user: never the queue or the import; flags off: nothing
 o.locator('#openInsights').click();o.wait_for_timeout(700)
 check('plain user: no outreach queue or staffing import',o.locator('#outreachQueue').is_hidden() and o.locator('#staffingImport').is_hidden())
 o.locator('#insightsDialog [data-close]').first.click()
 S['features']=dict(FEATURES,gaps=False,claims=False,outreach=False,staffing=False);off=page('reviewer');off.locator('header [data-view=library]').click();off.wait_for_timeout(600)
 off.locator('#openInsights').click();off.wait_for_timeout(700)
 check('flags off: queue, import and proof requests stay hidden',off.locator('#outreachQueue').is_hidden() and off.locator('#staffingImport').is_hidden() and off.locator('#proofRequests').is_hidden())
 # ---- F3.4: the local self-recorded N+1 is never shown as a confirmation
 n1=page('owner');key=n1.evaluate("'mantu.atlas.workspace.v4.'+(window.ATLAS_RUNTIME?.subjectKey||'voice-local-v5')")
 n1.evaluate("""k=>{const E=window.AtlasEngine,s=E.blankState(),u=s.profiles[0];const mk=(t,st)=>{const p=E.project({title:t,consultant:'Alex',validation:{manager:{name:'Sam Lee',email:'sam@mantu.com'}}});p.report=E.cleanReport({headline:'H '+t,summary:'S'});p.validation.status=st;if(st==='validated'){p.validation.by='Sam Lee';p.validation.validatedAt=E.now();}return p;};
  u.projects=[mk('Validated locally','validated'),mk('Awaiting','awaiting')];u.lastProject=u.projects[0].id;localStorage.setItem(k,JSON.stringify(s));}""",key)
 n1.reload();n1.wait_for_timeout(700);n1.locator('header [data-view=projects]').click();n1.wait_for_timeout(500)
 cards=n1.locator('#projectCards').inner_text()
 check('local N+1 note relabelled "Self-recorded (not a confirmation)", never "Validated by"',('Self-recorded (not a confirmation)' in cards) and 'Validated by' not in cards and 'Note N+1 approval (self-recorded)' in cards)
 br.close()
check('no page errors',not ERR);print('errors:',ERR) if ERR else None
