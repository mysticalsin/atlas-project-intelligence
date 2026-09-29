"""Bids view (WOW_SPEC F1.7-F1.9, F2.6 bid side, F7.3) in a real browser against the built page with mocked routes
(harness (a): /api/bootstrap and /api/library/bids*, gaps and wins answered in memory per the section 3 contracts).
No network, no model, no Worker: the server side is covered by deploy/cloudflare-edge/test/bids.test.js.
  python3 tests/bids_browser.py
"""
import io,json,os,re,sys,zipfile
from datetime import date
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];H=(ROOT/'ATLAS_Voice.html').read_text();ERR=[];CALLS=[]
def check(n,v):print(('PASS ' if v else 'FAIL ')+n);assert v,n
FEATURES={'bids':True,'ask':False,'spokenAsk':False,'wins':True,'customerJev':False,'pdfBriefs':False,'gaps':True,'gapInterview':True,'claims':False,'clientConfirm':False,'outreach':False,'staffing':False,'teams':'BLOCKED_EXTERNAL','phone':'BLOCKED_EXTERNAL'}
USERS={'owner':('alex@mantu.com','user'),'reviewer':('reviewer@mantu.com','reviewer'),'plain':('kim@mantu.com','user')}
TITLE='Zebra internal title for Acme Prospect';PROSPECT='Acme Prospect'
R1,R2='a'*32,'b'*32
REQS=[{'id':'R1','text':'Proven claims triage automation at an insurer','kind':'capability','must':True},{'id':'R2','text':'Measured reduction in handling time','kind':'outcome','must':False},{'id':'R3','text':'ISO 27001 credential','kind':'credential','must':True}]
S={'bids':{},'verdict':'strong','gaps':{},'n':0,'features':dict(FEATURES)}
LABEL='Relevance and reasons are interpretation; open each reference for the facts. Similarity is not relevance.'
def result(i,rid,title,rel,ws):return {'id':rid,'title':title,'status':'published','revision':3,'access':'public','mine':False,'owner':'','client':'','practice':'Data & AI','industry':'Insurance','country':'France','serviceLines':[],'technologies':[],'headline':'','impact':None,'qualityScore':80,'qualityStatus':'ready','updatedAt':'2026-09-01',
 'relevance':rel,'similarity':0.61-i*0.1,'retrieval':'semantic' if i==0 else 'lexical','why':f'Why {title} fits <b>here</b>','transferable':['Routing rules','Pilot design'],'caveat':'Different country','covers':['R1'] if i==0 else ['R2'],'winSignal':ws,'claims':{'confirmed':1,'total':3}}
def match_run(v):
 res=[] if v in ('none','empty_library') else [result(0,R1,'Claims routing',72 if v!='unranked' else None,{'decided':6,'won':4,'lost':2,'winRate':0.67,'boost':0.02}),result(1,R2,'Queue operations',41 if v!='unranked' else None,None)]
 cov={'strong':['covered','partial','unmet'],'partial':['partial','partial','unmet'],'none':['unmet']*3,'unranked':['unknown']*3,'empty_library':['unmet']*3}[v]
 sugg=[{'refId':R1,'person':0,'name':'Alex Martin','role':'Data engineer'},{'refId':R1,'person':1,'name':'Sam Lee','role':'Analyst'}]
 return {'runAt':'2026-09-29T10:00:00Z','verdict':v,'method':'semantic + model ranking','results':res,'coverage':[{'requirementId':r['id'],'status':c,'refIds':[R1] if c!='unmet' else [],'suggested':sugg if c in ('partial','unmet') else []} for r,c in zip(REQS,cov)],
  'note':{'empty_library':'No published references are available to you yet.','none':'No strong match in the library for this brief. Ask the right consultants for proof (gap request).'}.get(v,''),'label':LABEL}
def view(b,who):
 author=who=='owner' and not b['purged']
 d={k:b[k] for k in ('id','status','outcome','requirements','reqMethod','customer','match','used','gaps','purged','createdAt','updatedAt')}
 d['view']='author' if who=='owner' else 'other';d['alias']=b['alias'] if who=='owner' else b['alias'].replace(PROSPECT,'[company]')
 if author:d.update(title=b['title'],prospectNames=b['prospects'],briefChars=len(b['brief']),maskedPreview=b['brief'].replace(PROSPECT,'[prospect]').replace('jane@acme.example','[contact]'))
 d['permissions']={'edit':who=='owner','decide':who in('owner','reviewer'),'delete':who=='owner'};return d
def summary(b,who):return {'id':b['id'],'alias':b['alias'],**({'title':b['title']} if who=='owner' and not b['purged'] else {}),'status':b['status'],'outcome':b['outcome'],'updatedAt':b['updatedAt'],'requirements':len(b['requirements']),'verdict':(b['match'] or {}).get('verdict')}
ONEPAGER={'view':'author','title':'Claims triage proof','subtitle':'Two published references','summary':[{'text':'Triage fell from 40 to 12 minutes.','kind':'fact','cites':[1],'requirementIds':['R2']},{'text':'This fits an insurer with manual routing.','kind':'interpretation','cites':[2],'requirementIds':['R1']}],
 'sections':[{'heading':'Delivery','claims':[{'text':'Ran the pilot with two teams.','kind':'fact','cites':[2],'requirementIds':['R1']}]}],
 'footnotes':[{'n':1,'refId':R1,'revision':3,'kind':'consultant_words','topic':'outcome','quote':'Triage fell from 40 to 12 minutes per claim.','confirmation':'manager_confirmed'},{'n':2,'refId':R2,'revision':1,'kind':'evidence','sourceName':'Ops dashboard','sourceVersion':'v3','quote':'<img src=x onerror=window.__pwned=1>Pilot ran with two teams.','confirmation':'unverified'}],
 'dropped':['Cut costs by 99% overnight'],'references':[{'id':R1,'title':'Claims routing','revision':3,'status':'published','validation':'validated','client':'Zebracorp'},{'id':R2,'title':'Queue operations','revision':1,'status':'published','validation':'validated'}],
 'warning':'','generatedAt':'2026-09-29T10:00:00Z','label':"Every claim cites the consultant's own words or recorded evidence. Interpretation is labelled."}
def wins(who):
 pts=[{'proofType':'quantified+confirmed','used':9,'won':3,'lost':2,'decided':5,'winRate':0.6,'ci95':[0.2307,0.8824],'caveat':''},{'proofType':'qualitative+unconfirmed','used':4,'won':1,'lost':1,'decided':2,'winRate':None,'ci95':None,'caveat':'Fewer than 5 decided bids: not shown.'}]
 st=[{'refId':R1,'title':'Claims routing','used':6,'won':4,'lost':2,'pending':0,'decided':6,'winRate':0.67,'ci95':[0.3,0.9],'caveat':''}] if who=='reviewer' else []
 return {'minN':5,'proofTypes':pts,'stories':st,'totals':{'bids':12,'decided':7},'label':'Association, not causation. Weights are uncalibrated.'}
def boot(who):return {'provider':'workers','csrf':'tok','identity':{'name':USERS[who][0],'mode':'access','subjectKey':who},'email':USERS[who][0],'library':True,'libraryRole':USERS[who][1],'memory':False,'jevClassify':False,'features':S['features']}
def make_route(who):
 def route(r):
  req=r.request;u=urlparse(req.url);path=u.path;m=req.method;body=json.loads(req.post_data or '{}') if m=='POST' and 'json' in (req.headers.get('content-type') or '') else {}
  if req.url.rstrip('/')=='https://atlas.test':return r.fulfill(body=H,content_type='text/html')
  if path=='/api/bootstrap':return r.fulfill(json=boot(who))
  if not path.startswith('/api/'):return r.fulfill(status=404,body='')
  CALLS.append((who,m,path,body,req.headers.get('x-atlas-csrf')))
  if m=='POST' and req.headers.get('x-atlas-csrf')!='tok':return r.fulfill(status=403,json={'error':'CSRF'})
  if path=='/api/library/invitations':return r.fulfill(json={'items':[]})
  if path=='/api/library/bids' and m=='GET':
   items=[summary(b,who) for b in S['bids'].values() if who=='owner' or (who=='reviewer' and 'all=1' in (u.query or ''))];return r.fulfill(json={'items':items})
  if path=='/api/library/bids' and m=='POST':
   if not (3<=len(body.get('alias',''))<=80):return r.fulfill(status=400,json={'error':'Add an alias.'})
   S['n']+=1;bid_id=f'{S["n"]:032x}'
   S['bids'][bid_id]={'id':bid_id,'title':body['title'],'alias':body['alias'],'prospects':body.get('prospectNames',[]),'brief':body['briefText'],'status':'open','outcome':'pending','requirements':REQS,'reqMethod':'model','customer':{'problem':'','buyer':'','constraints':'','desired_outcome':''},'match':None,'used':[],'gaps':[],'purged':False,'createdAt':'2026-09-29','updatedAt':'2026-09-29'}
   return r.fulfill(status=201,json=view(S['bids'][bid_id],who))
  mm=re.match(r'^/api/library/bids/([a-f0-9]{32})(?:/(\w+))?$',path)
  if mm:
   b=S['bids'].get(mm.group(1));act=mm.group(2)
   if not b or who=='plain':return r.fulfill(status=404,json={'error':'Bid not found.'})
   if act is None:return r.fulfill(json=view(b,who))
   if act=='requirements':b['requirements']=[{'id':x.get('id') or f'R{i+1}','text':x['text'],'kind':x['kind'],'must':x['must']} for i,x in enumerate(body['requirements'])];b['reqMethod']='manual';return r.fulfill(json=view(b,who))
   if act=='match':b['match']=match_run(S['verdict']);return r.fulfill(json=b['match'])
   if act=='onepager':return r.fulfill(json=ONEPAGER)
   if act=='use':
    new=[{'refId':x,'revision':3,'proofType':'quantified+confirmed','usedAt':'2026-09-29','by':USERS[who][0]} for x in body['refIds']];b['used']=[x for x in b['used'] if x['refId'] not in body['refIds']]+new;return r.fulfill(json={'used':new})
   if act=='outcome':b['outcome']=body['outcome'];b['status']='decided' if body['outcome'] in ('won','lost','withdrawn') else 'open';return r.fulfill(json=view(b,who))
   if act=='delete':b.update(title=None,brief='',prospects=[],purged=True);return r.fulfill(json=view(b,who))
  if path=='/api/library/wins':return r.fulfill(json=wins(who))
  if path=='/api/library/gaps' and m=='POST':
   gid='c'*32;S['gaps'][gid]={'id':gid,'requirementIds':body['requirementIds'],'status':'open','assigneeName':'Alex Martin','answeredAt':None}
   b=S['bids'][body['bidId']];b['gaps']=[S['gaps'][gid]]
   return r.fulfill(status=201,json={'id':gid,'bidId':body['bidId'],'bidAlias':b['alias'],'requirementIds':body['requirementIds'],'asks':[{'id':'G1','field':'contribution','label':'Contribution','ask':'Proof the bid needs: '+REQS[1]['text']}],'assigneeName':'Alex Martin','referenceId':body.get('referenceId'),'status':'open','createdAt':'2026-09-29','answeredAt':None,'results':None,
    'draft':{'to':'alex@mantu.com','subject':'Can you give 5 minutes of proof for a bid?','body':'Hello,\nA bid needs a few proof points. Open https://atlas.test/#gap/'+gid},'outreach':[{'id':'o1','channel':'teams','status':'pending_approval'},{'id':'o2','channel':'email_draft','status':'pending_approval'}]})
  mg=re.match(r'^/api/library/gaps/([a-f0-9]{32})$',path)
  if mg and mg.group(1) in S['gaps']:
   g=S['gaps'][mg.group(1)];return r.fulfill(json={'id':g['id'],'bidId':'','bidAlias':'','requirementIds':g['requirementIds'],'asks':[{'id':'G1','field':'outcome','label':'Outcome','ask':'Proof the bid needs: x'}],'status':g['status'],'createdAt':'2026-09-29','answeredAt':g['answeredAt'],
    'results':[{'askId':'G1','field':'outcome','status':'answered_unverified','quotes':['We cut handling time by 30% in <b>six</b> weeks.'],'provenance':'unverified_speech_recognition'}] if g['status']=='answered' else None})
  if path=='/api/sheet/ingest':return r.fulfill(json={'text':'PDF brief text that is long enough to be a brief for this bid.','truncated':False,'name':'brief.pdf'})
  if path=='/api/library':return r.fulfill(json={'items':[],'total':0,'facets':{'country':{},'industry':{}}})
  return r.fulfill(status=404,json={'error':'not mocked: '+path})
 return route
def docx_bytes(text):
 buf=io.BytesIO();z=zipfile.ZipFile(buf,'w')
 z.writestr('[Content_Types].xml','<Types/>');z.writestr('word/document.xml','<w:document><w:body>'+''.join(f'<w:p><w:r><w:t>{t}</w:t></w:r></w:p>' for t in text.split('\n'))+'</w:body></w:document>');z.close();return buf.getvalue()
def shot(p,name):
 if os.environ.get('SHOTS'):p.screenshot(path=str(Path(os.environ['SHOTS'])/name),full_page=True)
def no_overflow(p):return p.evaluate('document.scrollingElement.scrollWidth<=document.scrollingElement.clientWidth+1')
def posts(path_re):return [c for c in CALLS if c[1]=='POST' and re.search(path_re,c[2])]
with sync_playwright() as pw:
 br=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
 def page(who,w=1440,h=1000,hash=''):
  c=br.new_context(viewport={'width':w,'height':h},accept_downloads=True);p=c.new_page();p.on('pageerror',lambda e:ERR.append(str(e)))
  p.route('**/*',make_route(who));p.goto('https://atlas.test/'+hash);p.wait_for_timeout(700);return p
 o=page('owner')
 check('Bids nav shown when features.bids',o.locator('header nav [data-view=bids]').is_visible())
 o.locator('header nav [data-view=bids]').click();o.wait_for_timeout(500)
 check('Bids view renders the form, list and empty detail',o.locator('#bidNew').is_visible() and o.locator('#bidList').count()==1 and o.locator('#bidDetail').is_visible())
 check('#bidFile accepts .txt,.md,.docx,.pptx and not .pdf without pdfBriefs',o.locator('#bidFile').get_attribute('accept')=='.txt,.md,.docx,.pptx')
 check('hints: title private, alias for colleagues and AI, names kept away',all(t in o.locator('#bidNew').inner_text() for t in ['only you see it','code name colleagues and AI see; no company names','company names and aliases to keep away from AI','every client name known to ATLAS are masked']))
 # uploads: pdf refused (flag off), image refused, docx and txt read in the browser
 n0=len(CALLS);o.locator('#bidFile').set_input_files(files=[{'name':'brief.pdf','mimeType':'application/pdf','buffer':b'%PDF-1.4 x'}]);o.wait_for_timeout(300)
 check('.pdf refused without pdfBriefs and never sent',('PDF briefs are off' in o.locator('#bidNewStatus').inner_text()) and not any(c[2]=='/api/sheet/ingest' for c in CALLS[n0:]))
 o.locator('#bidFile').set_input_files(files=[{'name':'shot.png','mimeType':'image/png','buffer':b'\x89PNG\r\n'}]);o.wait_for_timeout(200)
 check('images refused',('Images are refused' in o.locator('#bidNewStatus').inner_text()) and o.locator('#bidBrief').input_value()=='')
 o.locator('#bidFile').set_input_files(files=[{'name':'brief.docx','mimeType':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','buffer':docx_bytes('The insurer needs proven claims triage.\nContact jane@acme.example')}]);o.wait_for_timeout(400)
 check('.docx brief read in the browser',o.locator('#bidBrief').input_value()=='The insurer needs proven claims triage.\nContact jane@acme.example')
 BRIEF=f'{PROSPECT} needs proven claims triage automation. Must show measured handling time reduction. Contact jane@acme.example or +33 6 12 34 56 78.'
 o.locator('#bidFile').set_input_files(files=[{'name':'brief.txt','mimeType':'text/plain','buffer':BRIEF.encode()}]);o.wait_for_timeout(300)
 check('.txt brief read',o.locator('#bidBrief').input_value()==BRIEF)
 # alias required, never naming the prospect
 o.locator('#bidTitle').fill(TITLE);o.locator('#bidProspects').fill(PROSPECT);o.locator('#bidProspects').press('Enter')
 check('prospect becomes a chip',PROSPECT in o.locator('#bidProspectChips').inner_text())
 n0=len(CALLS);o.locator('#bidCreate').click();o.wait_for_timeout(300)
 check('alias required: no request without it',('Add an alias' in o.locator('#bidNewStatus').inner_text()) and not posts(r'^/api/library/bids$'))
 o.locator('#bidAlias').fill('Falcon for acme prospect');o.locator('#bidCreate').click();o.wait_for_timeout(300)
 check('alias naming a declared prospect refused',('must not name the prospect' in o.locator('#bidNewStatus').inner_text()) and not posts(r'^/api/library/bids$'))
 o.locator('#bidAlias').fill('Falcon');o.locator('#bidCreate').click();o.wait_for_timeout(700)
 c=posts(r'^/api/library/bids$')
 check('create posts title, alias, prospects, brief and file name with the CSRF header',len(c)==1 and c[0][3]['alias']=='Falcon' and c[0][3]['title']==TITLE and c[0][3]['prospectNames']==[PROSPECT] and c[0][3]['briefText']==BRIEF and c[0][3]['fileName']=='brief.txt' and c[0][4]=='tok')
 check('detail shows the alias and the private title to the author',o.locator('#bidHeading').inner_text()=='Falcon' and 'only you see it' in o.locator('#bidDetail').inner_text())
 mp=o.locator('#bidMaskedPreview')
 check('masked preview collapsed with the section 2.3 sentence',mp.count()==1 and mp.get_attribute('open') is None and 'Other client names known to ATLAS are masked too, without being shown here.' in mp.text_content())
 mp.locator('summary').click()
 check('masked preview shows only what the server masked',('[prospect]' in mp.inner_text()) and '[contact]' in mp.inner_text())
 check('requirements listed with kind and must, not matched yet',o.locator('#bidRequirements .bid-req').count()==3 and 'not matched yet' in o.locator('#bidRequirements').inner_text().lower())
 check('JEV consent hidden without customerJev',o.locator('#bidJevConsent').count()==0)
 o.locator('#bidReqEdit').click();o.wait_for_timeout(100)
 o.locator('#bidRequirements .req-edit-text').first.fill('Proven claims triage automation at a large insurer')
 o.locator('#bidReqAdd').click();o.locator('#bidRequirements .req-edit-text').last.fill('Delivery in French')
 o.locator('#bidReqSave').click();o.wait_for_timeout(400)
 rq=posts(r'/requirements$')[-1][3]['requirements']
 check('inline edit (owner): posts the edited list; a new row has no id',len(rq)==4 and rq[0]=={'id':'R1','text':'Proven claims triage automation at a large insurer','kind':'capability','must':True} and 'id' not in rq[3] and rq[3]['text']=='Delivery in French')
 check('edited requirements shown and labelled as edited by the owner',o.locator('#bidRequirements .bid-req').count()==4 and 'Edited by the bid owner' in o.locator('#bidDetail').inner_text())
 # every verdict banner
 COPY={'empty_library':'No published references are available to you yet.','none':'No strong match in the library for this brief.','unranked':'Not ranked: the AI ranking did not answer. Similarity only.','partial':'Partial matches only. Check each caveat.','strong':'Strong proof found for 1 of 3 requirements.'}
 for v,t in COPY.items():
  S['verdict']=v;o.locator('#bidMatchGo').click();o.wait_for_timeout(450)
  check(f'verdict banner {v}: "{t}"',o.locator('#bidVerdict .verdict-banner strong').inner_text()==t)
  if v=='none':check('none: "Ask consultants for proof" call to action',o.locator('#bidVerdict [data-gap-ask]').inner_text()=='Ask consultants for proof' and o.locator('#bidResults .bid-result').count()==0)
  if v=='unranked':check('unranked cards say not ranked, coverage unknown',('not ranked' in o.locator('#bidResults').inner_text()) and o.locator('#bidRequirements .cov-unknown').count()==3)
 check('uncalibrated thresholds labelled',('pilot values, not calibrated' in o.locator('#bidDetail').inner_text()))
 card=o.locator('#bidResults .bid-result').first;t=card.inner_text()
 check('result card: relevance, similarity, semantic retrieval, why, transfers, caveat, covers, status, claims x/y',all(x.lower() in t.lower() for x in ['relevance 72','similarity 0.61','semantic','Why Claims routing fits','Transfers: Routing rules','Caveat: Different country','Covers R1','Published','Claims confirmed 1/3']))
 check('hostile model text rendered inert',card.locator('b',has_text='here').count()==0 and '<b>here</b>' in t)
 check('win signal shown when non-null, with n and "association not causation"','n=6 decided, association not causation' in t)
 t2=o.locator('#bidResults .bid-result').nth(1).inner_text()
 check('null win signal: the bounded-adjustment note instead','Ordering may include a bounded win-history adjustment.' in t2 and 'keyword' in t2)
 check('coverage chips per requirement',o.locator('#bidRequirements .cov-covered').count()==1 and o.locator('#bidRequirements .cov-partial').count()==1 and o.locator('#bidRequirements .cov-unmet').count()==1)
 # one-pager: select up to 3, footnotes, exports
 check('one-pager disabled until a reference is picked',o.locator('#bidOnePagerGo').is_disabled())
 o.locator('[data-bid-pick]').nth(0).check();o.locator('[data-bid-pick]').nth(1).check()
 o.locator('#bidOnePagerGo').click();o.wait_for_timeout(500)
 op=o.locator('#onePager')
 check('one-pager: title, claims with superscript sources, interpretation marked',op.is_visible() and 'Claims triage proof' in op.inner_text() and op.locator('sup.fn').count()==3 and op.locator('li.claim.interpretation').count()==1)
 check('Sources: quote, label, reference title, r{revision}, confirmation badge, client where present',op.locator('.onepager-sources li').count()==2 and all(x in op.locator('.onepager-sources').text_content() for x in ['Triage fell from 40 to 12 minutes per claim.','Outcome','Claims routing · r3','Confirmed by N+1','Client: Zebracorp','Evidence · Ops dashboard v3','Unverified']) and op.locator('.fn-client').count()==1)
 check('hostile quote inert; dropped claims listed',op.locator('img').count()==0 and not o.evaluate('window.__pwned') and 'Cut costs by 99% overnight' in op.inner_text())
 req=[c for c in posts(r'/onepager$')][-1][3]
 check('one-pager request carries the picked ids and includeClient false by default',sorted(req['refIds'])==sorted([R1,R2]) and req['includeClient'] is False)
 shot(o,'bids_desktop.png')
 stem=f'ATLAS_proof_Falcon_{date.today().isoformat()}'
 with o.expect_download() as dl:o.locator('[data-export=docx]').click()
 d=dl.value;doc=zipfile.ZipFile(d.path()).read('word/document.xml').decode()
 check('.docx download: alias file name, superscript runs and a Sources section',d.suggested_filename==stem+'.docx' and 'w:vertAlign w:val="superscript"' in doc and '>Sources<' in doc and 'Zebracorp' in doc and TITLE not in doc)
 with o.expect_download() as dl:o.locator('[data-export=md]').click()
 md=Path(dl.value.path()).read_text()
 check('.md download with [^n] footnotes',dl.value.suggested_filename==stem+'.md' and '[^1]' in md and '\n[^2]: ' in md and TITLE not in md)
 o.evaluate("window.__printed=null;window.print=()=>{window.__printed=document.body.classList.contains('print-onepager')}")
 o.locator('[data-export=print]').click();o.wait_for_timeout(100)
 check('print: one-pager print mode during window.print, removed after',o.evaluate('window.__printed') is True and not o.evaluate("document.body.classList.contains('print-onepager')"))
 o.evaluate("document.body.classList.add('print-onepager')");o.emulate_media(media='print')
 check('print layout: only the one-pager is displayed',o.locator('#onePager .onepager-paper').is_visible() and o.locator('#bidNew').is_hidden() and o.locator('#bidMatchGo').is_hidden() and o.locator('#bidRequirements').is_hidden() and o.locator('header.topbar').is_hidden() and o.locator('#onePagerExports').is_hidden())
 o.emulate_media(media='screen');o.evaluate("document.body.classList.remove('print-onepager')")
 # mark used, outcome
 o.locator('[data-bid-use]').first.click();o.wait_for_timeout(400)
 check('mark as used posts once and the card says so',len(posts(r'/use$'))==1 and posts(r'/use$')[0][3]=={'refIds':[R1]} and 'Used in this bid' in o.locator('#bidResults .bid-result').first.inner_text())
 o.locator('#bidOutcome').select_option('won');o.locator('#bidOutcomeNote').fill('Shortlisted then won');o.locator('#bidOutcomeSave').click();o.wait_for_timeout(500)
 check('outcome saved',posts(r'/outcome$')[-1][3]=={'outcome':'won','note':'Shortlisted then won'} and 'Won' in o.locator('.bid-head').inner_text())
 # ask for proof (F2.6)
 ask=o.locator('#bidRequirements [data-gap-ask]')
 check('"Ask for proof" only on partial or unmet requirements',ask.count()==2)
 ask.last.click();o.wait_for_timeout(300)
 g=o.locator('#gapDialog')
 check('gap dialog: requirement checkboxes and suggested people (never ranked)',g.is_visible() and g.locator('[data-gap-req]').count()==2 and g.locator('[data-gap-req]:checked').count()==1 and 'never ranked' in g.inner_text() and g.locator('input[name=gapWho]').count()==3)
 g.locator('[data-gap-req]').first.check();o.wait_for_timeout(100)
 g.locator('#gapCreate').click();o.wait_for_timeout(500)
 gp=posts(r'^/api/library/gaps$')
 check('gap request sends {refId, person} for a suggested person and the reference id',len(gp)==1 and gp[0][3]['assignee']=={'refId':R1,'person':0} and gp[0][3]['referenceId']==R1 and sorted(gp[0][3]['requirementIds'])==['R2','R3'])
 href=g.locator('#gapMailto').get_attribute('href') or ''
 check('draft shown as a mailto link plus Copy; nothing sent',href.startswith('mailto:alex%40mantu.com?subject=') and g.locator('#gapCopy').is_visible() and 'Nothing was sent' in g.inner_text())
 check('outreach chip reads "Teams: BLOCKED_EXTERNAL"','Teams: BLOCKED_EXTERNAL' in g.locator('#gapChips').inner_text())
 g.locator('#gapCopy').click();o.wait_for_timeout(200)
 g.locator('[data-close]').first.click()
 # an answered request renders under its requirement, labelled unverified
 S['gaps']['c'*32]['status']='answered';S['gaps']['c'*32]['answeredAt']='2026-09-30'
 bid_id=list(S['bids'])[0];o.goto(f'https://atlas.test/#bid/{bid_id}');o.wait_for_timeout(900)
 rg=o.locator('#bidRequirements [data-req-gaps="R2"]')
 check('#bid/<id> deep link opens the bid',o.locator('#bids').is_visible() and o.locator('#bidHeading').inner_text()=='Falcon')
 check('gap answers render under the requirement as "answered · unverified", inert',('answered · unverified' in rg.inner_text()) and 'We cut handling time by 30%' in rg.inner_text() and rg.locator('b').count()==0)
 # win panel (plain owner): proof types always, low-n caveat, CI label; no stories table
 ws=o.locator('#winStats')
 check('win panel: proof-type rows carry n, rate with a Wilson interval, low-n caveat',ws.is_visible() and '60% (95% CI 23-88%)' in ws.inner_text() and 'n=5' in ws.inner_text() and 'Fewer than 5 decided bids: not shown.' in ws.inner_text() and 'Association, not causation' in ws.inner_text())
 check('no story table for a plain user',o.locator('#winStories').count()==0)
 # 320 px, then delete
 o.set_viewport_size({'width':320,'height':800});o.wait_for_timeout(300)
 check('no horizontal overflow at 320 px (form, detail, one-pager hidden after reload)',no_overflow(o))
 o.locator('[data-bid-pick]').first.check();o.locator('#bidOnePagerGo').click();o.wait_for_timeout(400)
 shot(o,'bids_320.png')
 check('no horizontal overflow at 320 px with the one-pager open',o.locator('#onePager').is_visible() and no_overflow(o))
 o.locator('#bidRequirements [data-gap-ask]').first.click();o.wait_for_timeout(300)
 check('gap dialog fits at 320 px',o.evaluate("(()=>{const d=document.getElementById('gapDialog');return d.open&&d.scrollWidth<=d.clientWidth+1})()"))
 o.locator('#gapDialog [data-close]').first.click();o.set_viewport_size({'width':1440,'height':1000})
 o.locator('#bidDelete').click();o.wait_for_timeout(200)
 check('delete asks for confirmation and explains what is kept',o.locator('#confirmDialog').is_visible() and 'keeps the alias, the masked requirements, the outcome' in o.locator('#confirmText').inner_text() and not posts(r'/delete$'))
 o.locator('#confirmYes').click();o.wait_for_timeout(500)
 check('delete posts once; the purged bid shows no title or preview',len(posts(r'/delete$'))==1 and 'BRIEF DELETED' in o.locator('.bid-head').inner_text() and o.locator('#bidMaskedPreview').count()==0 and o.locator('#bidDelete').count()==0 and TITLE not in o.locator('#bids').inner_text())
 # the other view: a reviewer never sees the raw title or prospects
 S['bids'][bid_id].update(title=TITLE,prospects=[PROSPECT],brief=BRIEF,purged=False)
 rv=page('reviewer',hash=f'#bid/{bid_id}');rv.wait_for_timeout(600)
 html=rv.content()
 check('reviewer sees the other view: masked alias, no title, no prospects, no preview, no delete',rv.locator('#bidHeading').is_visible() and 'SHARED VIEW' in rv.locator('.bid-head').inner_text() and TITLE not in html and PROSPECT not in html and rv.locator('#bidMaskedPreview').count()==0 and rv.locator('#bidDelete').count()==0 and rv.locator('#bidReqEdit').count()==0)
 check('reviewer win panel shows the story table',rv.locator('#winStories').count()==1 and 'Claims routing' in rv.locator('#winStories').inner_text())
 rv.locator('#bidAll').check();rv.wait_for_timeout(400)
 check('reviewer "All bids" lists aliases without titles',rv.locator('#bidList [data-bid-open]').count()==1 and TITLE not in rv.locator('#bidList').inner_text())
 pl=page('plain',hash=f'#bid/{bid_id}');pl.wait_for_timeout(600)
 check('a non-owner non-reviewer gets "not available" and no bid',pl.locator('#bidHeading').count()==0)
 # PDF only with the flag, through the existing ingest route
 S['features']=dict(FEATURES,pdfBriefs=True,customerJev=True)
 f=page('owner');f.locator('header nav [data-view=bids]').click();f.wait_for_timeout(500)
 check('#bidFile accepts .pdf when pdfBriefs',f.locator('#bidFile').get_attribute('accept')=='.txt,.md,.docx,.pptx,.pdf')
 f.locator('#bidFile').set_input_files(files=[{'name':'brief.pdf','mimeType':'application/pdf','buffer':b'%PDF-1.4 x'}]);f.wait_for_timeout(400)
 check('.pdf goes through POST /api/sheet/ingest when flagged',any(c[2]=='/api/sheet/ingest' and c[4]=='tok' for c in CALLS) and 'PDF brief text' in f.locator('#bidBrief').input_value())
 f.locator('[data-bid-open]').first.click();f.wait_for_timeout(500)
 check('JEV consent shown with customerJev, unchecked by default',f.locator('#bidJevConsent').count()==1 and not f.locator('#bidJevConsent').is_checked())
 S['verdict']='strong';f.locator('#bidMatchGo').click();f.wait_for_timeout(400)
 check('match without consent never asks for JEV',posts(r'/match$')[-1][3].get('jevConsent') is False and posts(r'/match$')[-1][3].get('useJev') is False)
 br.close()
check('no page errors',not ERR);print('errors:',ERR) if ERR else None
