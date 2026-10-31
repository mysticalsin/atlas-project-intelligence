"""Shared reference library end to end in a real browser against the local edge (real Worker + library code,
node:sqlite, stand-in model, loopback only). Owner -> automatic sync and review -> N+1 validates -> colleague sees
the published, anonymised reference -> an edit creates revision 2 and reopens the review.
  python3 tests/library_browser.py
"""
import json,os,socket,subprocess,sys,time,urllib.request
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
REP={'headline':'Claims triage rebuilt with ML routing','summary':'The consultant rebuilt claims triage for the client.','topics':{},'highlights':[],'gaps':[],'follow_ups':[],'status':'model_draft',
 'facts':{'project_id':'PRJ-2291','country':'France','industry':'Insurance','start':'2024-03','end':'2024-11','duration':'','team_size':6,'team_roles':['Data engineer'],'technologies':['Python','Azure ML'],'deliverables':['Routing model'],'service_lines':['Data & AI']}}
NOTES=['Zebracorp had claims bouncing between three teams, slowing payouts for customers across the region.','I designed and built the routing model and ran the pilot with two teams myself.',
 'We compared rules against a model, chose the model, and kept a manual fallback for edge cases.','Triage fell from 40 to 12 minutes per claim according to the operations dashboard.',
 'Operations dashboard export v3, before and after quarters.','Any insurer or service desk with manual routing and a measurable queue would benefit.']
try:
 with sync_playwright() as pw:
  b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
  def page(email):
   c=b.new_context(viewport={'width':1400,'height':1000});p=c.new_page();p.on('pageerror',lambda e:ERR.append(str(e)))
   p.goto(BASE+'/?as='+email);p.wait_for_timeout(700);return p
  # --- owner
  o=page('alex@mantu.com')
  o.locator('[data-action=new-project]:visible').first.click();o.wait_for_timeout(200)
  for k,v in {'projectTitle':'Claims triage alias','consultantName':'Alex','consultantRole':'Data engineer','clientName':'Zebracorp','clientLocation':'Lyon','n1Name':'Sam','n1Email':'sam@mantu.com'}.items():o.locator('#'+k).fill(v)
  o.locator('#projectForm button[type=submit]').click();o.wait_for_timeout(300)
  r=o.evaluate("([n,rep])=>window.ATLAS_VOICE_BRIDGE.autoSave(window.ATLAS_VOICE_BRIDGE.context(),n,'Consultant words.',rep)",[NOTES,REP])
  o.wait_for_timeout(1200);settle()
  o.locator('header [data-view=library]').click();o.wait_for_timeout(900)
  card=o.locator('#libraryList .project-card').first
  check('interview saved as a PRIVATE DRAFT, not shared (G2)',card.count()==1 and 'Claims triage rebuilt' in card.inner_text() and 'PRIVATE DRAFT' in card.inner_text().upper())
  check('a draft is not rated and shows a Submit for review button',card.locator('[data-submit-ref]').count()==1 and 'AWAITING N+1' not in card.inner_text().upper())
  card.locator('[data-submit-ref]').click();o.wait_for_timeout(1500);settle()
  o.locator('header [data-view=library]').click();o.wait_for_timeout(900)
  card=o.locator('#libraryList .project-card').first
  check('after Submit for review the automatic quality review ran; awaiting the N+1','AWAITING N+1' in card.inner_text().upper())
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
  # --- N+1 via the direct link (v2.2, red-team H1: the staffing record names the N+1 who may validate; the one typed on the reference is only a name)
  rv=page('reviewer@mantu.com');st=rv.evaluate("""async ([csv])=>{const b=await (await fetch('/api/bootstrap')).json();const r=await fetch('/api/library/staffing/import',{method:'POST',headers:{'Content-Type':'application/json','X-Atlas-CSRF':b.csrf},body:JSON.stringify({csv})});return {status:r.status,body:await r.json()};}""",['project_id,consultant_email,manager_email,manager_name,project_title,end_date\nPRJ-2291,alex@mantu.com,sam@mantu.com,Sam,,\n'])
  check('the staffing record names sam as the N+1 (reviewer import)',st['status']==200 and st['body']['staffed']==1)
  n=page('sam@mantu.com');n.goto(BASE+'/#library/'+rid);n.wait_for_timeout(1200)
  check('N+1 deep link opens the record with a Validate button',n.locator('#recordDialog').is_visible() and n.locator('[data-rec-validate]').count()==1)
  n.locator('[data-rec-validate]').click();n.wait_for_timeout(900)
  check('validated and published',n.locator('#recordEyebrow').inner_text().find('SHARED IN INTERNAL LIBRARY')>=0 and 'Validated by sam@mantu.com' in n.locator('#recordBody').inner_text())
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
  check('audit trail shows who did what',all(w in o.locator('#recordBody').inner_text() for w in ['created','reviewed','validated','revised','sam@mantu.com']))
  check('no page errors',not ERR);print(ERR)
finally:
 srv.terminate()
