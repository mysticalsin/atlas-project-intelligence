"""WOW features end to end (WOW_SPEC 6.6 step 3) in a real browser against the local edge: the real Worker handle(), the real
Library with every feature module, node:sqlite and the stand-in model (dev/fake-model.mjs plus dev/fakes). Loopback only, no provider,
no network. Users are switched with ?as=. Runs at integration, once the integration step has flipped READY for the features below;
until then it stops with "NOT RUNNABLE" and a non-zero exit (it never reports a pass it did not observe).
  python3 build.py && cp ATLAS_Voice.html deploy/cloudflare-edge/src/atlas.html && python3 tests/wow_edge_browser.py
Flow: alex publishes a reference (N+1 sam validates) -> bea creates a bid with an alias -> match (verdict) -> one-pager with footnotes
-> gap request to alex -> alex sees it and answers through the API -> bea sees "answered · unverified" (masked), alex his own words
-> claims -> sam confirms on /confirm -> footnote and record-dialog badges flip -> a reviewer approves an email draft (drafted) and a
Teams row (BLOCKED_EXTERNAL) -> Ask ATLAS lights the map -> 5 won bids -> the reviewer's win panel shows the rate; a plain user sees
no story table.
"""
import json,os,re,socket,subprocess,sys,time,urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];EDGE=ROOT/'deploy/cloudflare-edge';ERR=[]
NEEDED=['bids','ask','wins','gaps','gapInterview','claims','outreach','staffing']
def check(n,v):print(('PASS ' if v else 'FAIL ')+n);assert v,n
if not (EDGE/'src/atlas.html').exists():print('NOT RUNNABLE: deploy/cloudflare-edge/src/atlas.html is missing. Run: python3 build.py && cp ATLAS_Voice.html deploy/cloudflare-edge/src/atlas.html');sys.exit(2)
s=socket.socket();s.bind(('127.0.0.1',0));PORT=s.getsockname()[1];s.close();BASE=f'http://127.0.0.1:{PORT}'
srv=subprocess.Popen(['node','--no-warnings','dev/local-edge.mjs',str(PORT)],cwd=EDGE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
for _ in range(100):
 try:urllib.request.urlopen(BASE+'/__settle',timeout=1);break
 except Exception:time.sleep(.1)
settle=lambda:urllib.request.urlopen(BASE+'/__settle',timeout=30).read()
REP={'headline':'Claims triage rebuilt with ML routing','summary':'The consultant rebuilt claims triage for the client.','topics':{},'highlights':[],'gaps':[],'follow_ups':[],'status':'model_draft',
 'facts':{'project_id':'PRJ-2291','country':'France','industry':'Insurance','start':'2024-03','end':'2024-11','duration':'','team_size':6,'team_roles':['Data engineer'],'technologies':['Python','Azure ML'],'deliverables':['Routing model'],'service_lines':['Data & AI']}}
NOTES=['Zebracorp had claims bouncing between three teams, slowing payouts for customers across the region.','I designed and built the routing model and ran the pilot with two teams myself.',
 'We compared rules against a model, chose the model, and kept a manual fallback for edge cases.','Triage fell from 40 to 12 minutes per claim according to the operations dashboard.',
 'Operations dashboard export v3 compares the before and after quarters.','Any insurer or service desk with manual routing and a measurable queue would benefit.']
BRIEF='Acme Prospect, a regional insurer, needs proven claims triage automation. Bidders must demonstrate a measured reduction in handling time and experience with routing models. Contact jane@acme.example.'
API="([p,o])=>window.ATLAS_APP.libraryApi(p,o||{})"
def api(pg,path,method='GET',body=None):return pg.evaluate(API,[path,{'method':method,**({'body':body} if body is not None else {})}])
def no_overflow(p):return p.evaluate('document.scrollingElement.scrollWidth<=document.scrollingElement.clientWidth+1')
code=0
try:
 with sync_playwright() as pw:
  b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
  def page(email,path='/',w=1400):
   c=b.new_context(viewport={'width':w,'height':1000},accept_downloads=True);p=c.new_page();p.on('pageerror',lambda e:ERR.append(email+': '+str(e)))
   sep='&' if '?' in path else '?';h=path.split('#',1);p.goto(BASE+h[0]+sep+'as='+email+('#'+h[1] if len(h)>1 else ''));p.wait_for_timeout(800);return p
  alex=page('alex@mantu.com')
  feats=alex.evaluate('window.ATLAS_APP.bootInfo()').get('features') or {}
  off=[k for k in NEEDED if feats.get(k) is not True]
  if off:print('NOT RUNNABLE: these features are not READY in this build: '+', '.join(off)+'. The integration step flips READY (WOW_SPEC 6.6 step 4), then runs this suite.');sys.exit(2)
  # --- a published reference (alex, N+1 sam)
  alex.locator('[data-action=new-project]:visible').first.click();alex.wait_for_timeout(200)
  alex.evaluate("document.getElementById('projectMore').open=true") # W1: these fields live under "More details"
  for k,v in {'projectTitle':'Claims triage alias','consultantName':'Alex Martin','consultantRole':'Data engineer','clientName':'Zebracorp','clientLocation':'Lyon','n1Name':'Sam','n1Email':'sam@mantu.com'}.items():alex.locator('#'+k).fill(v)
  alex.locator('#projectForm button[type=submit]').click();alex.wait_for_timeout(300)
  alex.evaluate("([n,rep])=>window.ATLAS_VOICE_BRIDGE.autoSave(window.ATLAS_VOICE_BRIDGE.context(),n,'Consultant words.',rep)",[NOTES,REP]);alex.wait_for_timeout(1200);settle()
  rid=alex.evaluate('window.ATLAS_APP.project().library?.id')
  check('reference synced to the shared library as a private draft',bool(rid) and alex.evaluate('window.ATLAS_APP.project().library?.status')=='draft')
  # G2: private until the consultant clicks Submit for review (the Library's own button, delegated handler); only then can the N+1 validate it
  alex.evaluate("id=>{const b=document.createElement('button');b.dataset.submitRef=id;document.body.append(b);b.click();b.remove();}",rid)
  alex.wait_for_function("id=>window.ATLAS_APP.profile().projects.some(x=>x.library&&x.library.id===id&&x.library.status!=='draft')",arg=rid,timeout=8000);settle()
  # v2.2 (red-team H1): the N+1 who may validate is the one the staffing record names, not the one typed on the reference
  api(page('reviewer@mantu.com'),'/staffing/import','POST',{'csv':'project_id,consultant_email,manager_email,manager_name,project_title,end_date\nPRJ-2291,alex@mantu.com,sam@mantu.com,Sam,,\n'})
  sam=page('sam@mantu.com');api(sam,'/'+rid+'/validate','POST',{'decision':'validate'});settle()
  check('N+1 validated: the reference is published',api(sam,'/'+rid)['status']=='published')
  # --- F1: bea creates a bid, matches, builds a one-pager
  bea=page('bea@mantu.com');bea.locator('header nav [data-view=bids]').click();bea.wait_for_timeout(600)
  bea.locator('#bidTitle').fill('Acme Prospect claims RFP 2026');bea.locator('#bidProspects').fill('Acme Prospect');bea.locator('#bidProspects').press('Enter');bea.locator('#bidBrief').fill(BRIEF)
  bea.locator('#bidCreate').click();bea.wait_for_timeout(300)
  check('alias required before anything is sent','Add an alias' in bea.locator('#bidNewStatus').inner_text())
  bea.locator('#bidAlias').fill('Falcon');bea.locator('#bidCreate').click();bea.wait_for_timeout(1500);settle()
  check('bid created with its requirements',bea.locator('#bidHeading').inner_text()=='Falcon' and bea.locator('#bidRequirements .bid-req').count()>=1)
  mp=bea.locator('#bidMaskedPreview .masked-text').text_content()
  check('masked preview masks the declared prospect and the email','[prospect]' in mp and 'Acme Prospect' not in mp and 'jane@acme.example' not in mp)
  bid_id=bea.evaluate("document.querySelector('#bidList [data-bid-open]').dataset.bidOpen")
  bea.locator('#bidMatchGo').click();bea.wait_for_timeout(2000);settle()
  verdict=bea.locator('#bidVerdict .verdict-banner strong').inner_text()
  check('match gives an honest verdict banner',bool(re.match(r'^(Strong proof found for \d+ of \d+ requirements\.|Strong proof found\. Coverage per requirement was not assessed\.|Partial matches only\. Check each caveat\.|No strong match in the library for this brief\.|Not ranked: the AI ranking did not answer\. Similarity only\.|No published references are available to you yet\.)$',verdict)))
  check('the published reference is proposed as proof',bea.locator(f'#bidResults [data-result="{rid}"]').count()==1)
  bea.locator(f'#bidResults [data-bid-pick="{rid}"]').check();bea.locator('#bidOnePagerGo').click();bea.wait_for_timeout(2000)
  fn=bea.locator('#onePager .onepager-sources li')
  check('one-pager with superscript sources and a Sources list',bea.locator('#onePager sup.fn').count()>=1 and fn.count()>=1 and 'Zebracorp' not in bea.locator('#onePager').inner_text())
  with bea.expect_download() as dl:bea.locator('[data-export=md]').click()
  check('Markdown export named after the alias',dl.value.suggested_filename.startswith('ATLAS_proof_Falcon_'))
  bea.locator(f'#bidResults [data-bid-use="{rid}"]').click();bea.wait_for_timeout(600)
  check('marked as used',('Used in this bid' in bea.locator(f'#bidResults [data-result="{rid}"]').inner_text()))
  # --- F2: a gap request to alex
  asks=bea.locator('#bidRequirements [data-gap-ask], #bidVerdict [data-gap-ask]')
  if asks.count():asks.first.click()
  else: # every requirement covered: open the same dialog for the first requirements (the owner may still ask)
   bea.evaluate("()=>{const b=document.createElement('button');b.dataset.gapAsk='';b.id='gapAskAny';b.type='button';document.getElementById('bidResults').append(b);}");bea.locator('#gapAskAny').click()
  bea.wait_for_timeout(300);g=bea.locator('#gapDialog')
  if not g.locator('[data-gap-req]:checked').count():g.locator('[data-gap-req]').first.check()
  g.locator('#gapWhoEmail').check();g.locator('#gapEmail').fill('alex@mantu.com');g.locator('#gapCreate').click();bea.wait_for_timeout(1000);settle()
  check('gap request created: mailto draft, nothing sent, Teams BLOCKED_EXTERNAL',(g.locator('#gapMailto').get_attribute('href') or '').startswith('mailto:alex%40mantu.com') and 'Teams: BLOCKED_EXTERNAL' in g.locator('#gapChips').inner_text())
  g.locator('[data-close]').first.click()
  alex.goto(BASE+'/?as=alex@mantu.com');alex.wait_for_timeout(700);alex.locator('header [data-view=library]').click();alex.wait_for_timeout(900)
  check('alex sees the proof request with its alias',alex.locator('#proofRequests').is_visible() and 'Falcon' in alex.locator('#proofRequests').inner_text() and alex.locator('#proofRequests [data-gap-start]').count()==1)
  gid=alex.locator('#proofRequests [data-gap-start]').first.get_attribute('data-gap-start')
  mine=api(alex,'/gaps/'+gid)
  api(alex,'/gaps/'+gid+'/answer','POST',{'results':[{'askId':a['id'],'status':'answered_unverified','quotes':['At Zebracorp we cut handling time by 30% in six weeks.']} for a in mine['asks']],'referenceId':rid});settle()
  check('alex sees his own words back',any('Zebracorp' in q for r in (api(alex,'/gaps/'+gid).get('results') or []) for q in r['quotes']))
  bea.goto(BASE+'/?as=bea@mantu.com#bid/'+bid_id);bea.wait_for_timeout(1500)
  box=bea.locator('#bidRequirements .req-gaps').first.inner_text()+' '+' '.join(bea.locator('#bidRequirements .req-gaps').all_inner_texts())
  check('the bid owner sees the answer labelled "answered · unverified", with the library client masked',('answered · unverified' in box) and 'handling time by 30%' in box and 'Zebracorp' not in box)
  # --- F3: claims, sam confirms on /confirm, badges flip
  alex.goto(BASE+'/?as=alex@mantu.com#library/'+rid);alex.wait_for_timeout(1500)
  cb=alex.locator('#claimsBlock')
  if not cb.locator('details.claims-ask').evaluate('d=>d.open'):cb.locator('summary').click() # open by default while no claim exists
  for i in range(min(8,cb.locator('[data-claim-check]').count())):cb.locator('[data-claim-check]').nth(i).check()
  alex.locator('#claimsRequest').click();alex.wait_for_timeout(1200);settle()
  link=alex.locator('#claimsLink').inner_text()
  check('confirmation request: a /go/confirm/<id> link (survives sign-in) and a mailto draft',re.search(r'/go/confirm/[a-f0-9]{32}$',link) is not None and (alex.locator('#claimsMailto').get_attribute('href') or '').startswith('mailto:sam%40mantu.com'))
  check('claims start unverified','Unverified' in cb.text_content())
  cp=page('sam@mantu.com','/go/confirm/'+link.rsplit('/',1)[1]);cp.wait_for_timeout(1200) # the Worker answers 302 to /confirm#<id>
  for i in range(cp.locator('[data-decision=confirm]').count()):cp.locator('[data-decision=confirm]').nth(i).click()
  cp.locator('#confirmSubmit').click();cp.wait_for_timeout(1000)
  check('sam confirms on /confirm',cp.locator('#confirmDone').is_visible())
  alex.goto(BASE+'/?as=alex@mantu.com');alex.wait_for_timeout(500);alex.goto(BASE+'/?as=alex@mantu.com#library/'+rid);alex.wait_for_timeout(1500)
  check('record-dialog badge flips to "Confirmed by N+1"','Confirmed by N+1' in alex.locator('#claimsBlock').text_content())
  bea.goto(BASE+'/?as=bea@mantu.com#bid/'+bid_id);bea.wait_for_timeout(1500)
  bea.locator(f'#bidResults [data-bid-pick="{rid}"]').check();bea.locator('#bidOnePagerGo').click();bea.wait_for_timeout(2000)
  claimable=[li for li in bea.locator('#onePager .onepager-sources li').all() if re.search(r'Consultant’s words · (Contribution|Approach|Outcome|Evidence)',li.text_content())]
  check('footnote badge flips: every cited claimable sentence reads "Confirmed by N+1"',bool(claimable) and all('Confirmed by N+1' in li.text_content() for li in claimable))
  # --- F4: outreach approvals (reviewer)
  rv=page('reviewer@mantu.com');rv.locator('header [data-view=library]').click();rv.wait_for_timeout(700);rv.locator('#openInsights').click();rv.wait_for_timeout(1500)
  q=rv.locator('#outreachQueue')
  check('reviewer sees queued outreach rows, Teams BLOCKED_EXTERNAL',q.is_visible() and q.locator('[data-outreach-approve]').count()>=2 and 'Teams: BLOCKED_EXTERNAL' in q.inner_text())
  # The proof and confirmation requests above are answered by now, so approving their rows dismisses them. A staffing import
  # (F4.1 step 2) queues an interview invitation that is still open; its rows are the ones approved below.
  gr=q.locator('.outreach-row',has_text='Proof request').filter(has=rv.locator('[data-outreach-approve]')).first;grid=gr.get_attribute('data-outreach')
  gr.locator('[data-outreach-approve]').click();rv.wait_for_timeout(1000)
  check('approving a row whose request is answered sends nothing: dismissed, no longer open','no longer open' in q.locator(f'[data-outreach="{grid}"]').inner_text())
  rv.locator('#staffingCsv').fill('project_id,consultant_email,manager_email,manager_name,project_title,end_date,client_name\nPRJ-7001,dan@mantu.com,sam@mantu.com,Sam,Claims pilot,'+time.strftime('%Y-%m-%d',time.gmtime())+',Zebracorp\n')
  rv.locator('#staffingGo').click();rv.wait_for_timeout(1500);settle()
  st=rv.locator('#staffingTable').inner_text()
  check('staffing import: an invitation and its outreach rows queued, the client column ignored',re.search(r'Interview invitations\s+1',st) is not None and re.search(r'Outreach waiting for approval\s+2',st) is not None and 'client_name' in st and q.locator('.outreach-row',has_text='Interview invitation').count()==2)
  em=q.locator('.outreach-row',has_text='Interview invitation').filter(has_text='Email draft').filter(has=rv.locator('[data-outreach-approve]')).first;emid=em.get_attribute('data-outreach')
  em.locator('[data-outreach-approve]').click();rv.wait_for_timeout(1000)
  row=q.locator(f'[data-outreach="{emid}"]')
  check('email draft approved: drafted, mailto offered, nothing sent','draft ready' in row.inner_text().lower() and (row.locator('[data-outreach-mailto]').get_attribute('href') or '').startswith('mailto:'))
  tm=q.locator('.outreach-row',has_text='Interview invitation').filter(has=rv.locator('[data-outreach-approve]')).filter(has_text='Teams').first;tmid=tm.get_attribute('data-outreach')
  tm.locator('[data-outreach-approve]').click();rv.wait_for_timeout(1000)
  check('Teams approval ends BLOCKED_EXTERNAL with the reason',('BLOCKED_EXTERNAL' in q.locator(f'[data-outreach="{tmid}"]').inner_text()) and 'Teams is not connected' in q.locator(f'[data-outreach="{tmid}"]').inner_text())
  rv.locator('#insightsDialog [data-close]').first.click()
  # --- F6: Ask ATLAS with the map (a plain user)
  kim=page('kim@mantu.com');kim.locator('header [data-view=library]').click();kim.wait_for_timeout(700)
  # The local fake embedding is lexical: the question shares words with the reference to clear the 0.35 semantic floor.
  kim.locator('#askQuestion').fill('Which references show claims routing that cut triage time for an insurer?');kim.locator('#askGo').click();kim.wait_for_timeout(2500)
  check('Ask ATLAS answers with a verdict and results',kim.locator('#askVerdict .verdict-banner').is_visible() and kim.locator('#askResults .ask-result').count()>=1)
  check('the map lights up the result country',kim.locator('#askMap path.geo-country[data-code="FRA"][data-state^="count-"]').count()==1)
  check('a public reader sees no email anywhere in the answer','@' not in kim.locator('#askAtlas').inner_text())
  # --- F7: five won bids; the reviewer sees the rate, a plain user no story table
  carl=page('carl@mantu.com')  # v2.2 (red-team L1): one bidder counts at most 3 uses of a story, and (X1) a win-rate figure needs decided bids from at least 3 different people, so the five wins come from three bidders
  for i in range(4):
   who=[bea,carl,kim,carl][i]
   x=api(who,'/bids','POST',{'title':f'Won bid {i}','alias':f'Heron {i}','prospectNames':[],'briefText':'An insurer needs proven claims triage automation with measured handling time.'})
   api(who,f"/bids/{x['id']}/use",'POST',{'refIds':[rid]});api(who,f"/bids/{x['id']}/outcome",'POST',{'outcome':'won'})
  api(bea,f'/bids/{bid_id}/outcome','POST',{'outcome':'won'});settle()
  rv.locator('header nav [data-view=bids]').click();rv.wait_for_timeout(1200)
  ws=rv.locator('#winStats')
  check('reviewer win panel shows a rate with its 95% interval at n=5',ws.is_visible() and re.search(r'\d+% \(95% CI \d+-\d+%\)',ws.inner_text()) is not None and 'n=5' in ws.inner_text())
  check('reviewer sees the story table',rv.locator('#winStories').count()==1)
  kim.locator('header nav [data-view=bids]').click();kim.wait_for_timeout(1200)
  check('a plain user sees proof types but no story table',kim.locator('#winProofTypes').count()==1 and kim.locator('#winStories').count()==0)
  bea.set_viewport_size({'width':320,'height':800});bea.locator('header nav [data-view=bids]').click();bea.wait_for_timeout(800)
  check('no horizontal overflow at 320 px (Bids)',no_overflow(bea))
  b.close()
 check('no page errors',not ERR)
except SystemExit as e:code=e.code or 0
except AssertionError:code=1
finally:
 srv.terminate()
 try:srv.wait(timeout=5)
 except Exception:srv.kill()
 if ERR:print('page errors:',ERR)
sys.exit(code)
