"""Private memory end to end in a real browser against the local edge with a stand-in Hindsight (same HTTP API):
an interview is remembered after the automatic save, the profile lists it by project, forget one / forget all,
switch memory off, admin connection test. Recall into the live conversation is covered by memory.test.js.
  python3 tests/memory_browser.py
"""
import json,os,socket,subprocess,time,urllib.parse,urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];EDGE=ROOT/'deploy/cloudflare-edge';ERR=[]
def check(n,v):print(('PASS ' if v else 'FAIL ')+n);assert v,n
s=socket.socket();s.bind(('127.0.0.1',0));PORT=s.getsockname()[1];s.close();BASE=f'http://127.0.0.1:{PORT}'
srv=subprocess.Popen(['node','--no-warnings','dev/local-edge.mjs',str(PORT)],cwd=EDGE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
for _ in range(100):
 try:urllib.request.urlopen(BASE+'/__settle',timeout=1);break
 except Exception:time.sleep(.1)
REP={'headline':'Claims triage rebuilt','summary':'The consultant rebuilt claims triage for the client.','topics':{},'highlights':[],'gaps':['No named source for the 12 minutes'],'follow_ups':['Who owns the dashboard?'],'status':'model_draft'}
try:
 with sync_playwright() as pw:
  b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
  def page(email, roles=None):
   c=b.new_context(viewport={'width':1300,'height':1000});p=c.new_page();p.on('pageerror',lambda e:ERR.append(str(e)))
   q='/?as='+urllib.parse.quote(email)+(('&idp='+urllib.parse.quote(json.dumps({'roles':roles}))) if roles else '')
   p.goto(BASE+q);p.wait_for_timeout(600);return p
  o=page('alex@mantu.com')
  o.locator('[data-action=new-project]:visible').first.click();o.wait_for_timeout(200)
  for k,v in {'projectTitle':'Claims triage alias','consultantName':'Alex','clientName':'Zebracorp','n1Name':'Sam','n1Email':'sam@mantu.com'}.items():o.locator('#'+k).fill(v)
  o.locator('#projectForm button[type=submit]').click();o.wait_for_timeout(300)
  o.evaluate("(rep)=>window.ATLAS_VOICE_BRIDGE.autoSave(window.ATLAS_VOICE_BRIDGE.context(),['Zebracorp had claims bouncing between three teams, slowing payouts.',null,null,'Triage fell from 40 to 12 minutes.',null,null],'I worked with Zebracorp on claims.',rep)",REP)
  o.wait_for_timeout(1500)
  o.locator('#profileButton').click();o.wait_for_timeout(900)
  panel=o.locator('#hindsightPanel')
  check('profile shows what ATLAS remembers, by project',panel.is_visible() and 'Claims triage alias' in o.locator('#memoryList').inner_text() and 'Conversation on' in o.locator('#memoryList').inner_text())
  stored=o.evaluate("fetch('/api/memory').then(r=>r.json())")
  check('two memory documents for one interview (project state + conversation)',len(stored['documents'])==2)
  o.evaluate("(rep)=>window.ATLAS_VOICE_BRIDGE.autoSave(window.ATLAS_VOICE_BRIDGE.context(),[null,'I designed the routing model.',null,null,null,null],'More words.',rep)",REP);o.wait_for_timeout(1500)
  docs=[d['id'] for d in o.evaluate("fetch('/api/memory').then(r=>r.json())")['documents']]
  check('the project memory is updated in place, not duplicated',sum(1 for d in docs if d.startswith('project-'))==1)
  o.locator('#memoryList li').filter(has_text='Claims triage alias').locator('[data-forget]').click();o.wait_for_timeout(700)
  check('forget one project',not any(d['id'].startswith('project-') for d in o.evaluate("fetch('/api/memory').then(r=>r.json())")['documents']))
  o.locator('#memoryForgetAll').click();o.wait_for_timeout(200);o.locator('#confirmYes').click();o.wait_for_timeout(800)
  check('forget everything',o.evaluate("fetch('/api/memory').then(r=>r.json())")['documents']==[])
  o.locator('#memoryOn').uncheck();o.wait_for_timeout(500)
  o.locator('#profileDialog [data-close]').first.click()
  o.evaluate("(rep)=>window.ATLAS_VOICE_BRIDGE.autoSave(window.ATLAS_VOICE_BRIDGE.context(),[null,null,'We kept a fallback.',null,null,null],'x',rep)",REP);o.wait_for_timeout(1200)
  check('switched off: nothing new is remembered',o.evaluate("fetch('/api/memory').then(r=>r.json())")['documents']==[] and o.evaluate("fetch('/api/memory').then(r=>r.json())")['off'] is True)
  check('connection test hidden for non-admins',not o.locator('#connectionTest').is_visible())
  mailbox=page('person@example.test');mailbox.locator('#profileButton').click();mailbox.wait_for_timeout(900)
  check('a mailbox without ATLAS.Admin does not show the connection test',not mailbox.locator('#connectionTest').is_visible())
  a=page('admin@example.test',['ATLAS.Admin']);a.locator('#profileButton').click();a.wait_for_timeout(900);a.locator('#connectionTest').click();a.wait_for_timeout(900)
  st=a.locator('#memoryStatus').inner_text()
  check('admin connection test: Hindsight working, JEV reports missing key','Hindsight: working' in st and 'JEV: not configured' in st)
  check('no page errors',not ERR);print(ERR)
finally:
 srv.terminate()
