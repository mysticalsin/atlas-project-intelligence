"""Privacy delete confirmation in a real browser against the local edge (dev/local-edge.mjs): the real Worker handle(),
the real library and node:sqlite. Loopback only, no provider, synthetic people.
  python3 build.py && python3 deploy/cloudflare-edge/build_edge.py && python3 tests/privacy_delete_browser.py
The browser holds the disclosure and the delete responses so the races are reproduced, not assumed:
- while the disclosure is pending, failed, or without a deletion scope, deletion cannot be opened or sent;
- a disclosure from an earlier render does not enable the current button;
- the confirmation states the verified-tenant scope, that a story another person merged into is kept with its revisions,
  and does not promise that every story or all data is erased;
- the confirmation says the receipt reports each store, that a store which fails keeps its data, and that only a direct
  merge target is kept; it does not say everything will be permanently deleted;
- Cancel sends nothing; while a delete is pending, unticking and reticking (synthetic change events), JS clicks, synthetic
  keydown events and native Enter/Space presses send nothing more; the pending delete also survives a re-render and
  navigating away and back, and its result is shown in the current page;
- an older journey render that completes after a newer one does not replace it;
- an empty deletion scope does not enable deletion;
- at 390px the confirmation is ticked and submitted with native keyboard presses on focused controls;
- the local edge identity has no tenant UUID, so the real POST is refused and the page shows the refusal, not a receipt;
- after a mocked successful receipt, a later attempt refused by the real local edge handler leaves the earlier receipt
  labelled as an earlier request and the latest-failure warning stays (also after a re-render); a mocked bootstrap with a
  different identity, fetched fresh in the same tab, shows neither the receipt nor the warning, and the original identity
  sees both again; while a later attempt is pending and after it succeeds, no stale failure warning is shown, and the later
  success is shown as the current receipt again.
Receipts here are mocked responses in the delete receipt shape of deploy/cloudflare-edge/src/operate.js (outcomes with
store/removed/error, blocked, complete, vendorDeletion), used for mixed success/failure rendering, focus and a single
receipt across reopen. A receipt from the real handler is only exercised by a separate local workerd harness that is not
part of this repository.
"""
import json,os,re,socket,subprocess,sys,time,urllib.parse,urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];EDGE=ROOT/'deploy/cloudflare-edge';ERR=[];FAILED=[]
def check(n,v):
 print(('PASS ' if v else 'FAIL ')+n)
 if not v:FAILED.append(n)
if not (EDGE/'src/atlas.html').exists():print('NOT RUNNABLE: deploy/cloudflare-edge/src/atlas.html is missing. Run: python3 build.py && python3 deploy/cloudflare-edge/build_edge.py');sys.exit(2)
s=socket.socket();s.bind(('127.0.0.1',0));PORT=s.getsockname()[1];s.close();BASE=f'http://127.0.0.1:{PORT}'
srv=subprocess.Popen(['node','--no-warnings','dev/local-edge.mjs',str(PORT)],cwd=EDGE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
for _ in range(100):
 try:urllib.request.urlopen(BASE+'/__settle',timeout=1);break
 except Exception:time.sleep(.1)
API="([p,o])=>window.ATLAS_APP.libraryApi(p,o||{})"
def api(pg,path,method='GET',body=None):return pg.evaluate(API,[path,{'method':method,**({'body':body} if body is not None else {})}])
JS_CLICK="id=>{const e=document.getElementById(id);if(e)e.click();return !!e}"
def disabled(p,sel):return p.evaluate("s=>{const e=document.querySelector(s);return e?e.disabled:null}",sel)
code=0
try:
 with sync_playwright() as pw:
  b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
  def open_page(email,width=1400):
   c=b.new_context(viewport={'width':width,'height':900});p=c.new_page();p.on('pageerror',lambda e:ERR.append(str(e)))
   sent=[];p.on('request',lambda r:sent.append(r.url) if r.method=='POST' and '/privacy/delete' in r.url else None)
   p.goto(BASE+'/?as='+urllib.parse.quote(email));p.wait_for_timeout(800)
   api(p,'/journey','POST',{'stage':'project','fields':{'title':{'value':'Privacy alias','source':'you','confirmed':True}}})
   return c,p,sent
  def wait_open(p):p.wait_for_function("()=>{const b=document.getElementById('privacyDeleteOpen');return b&&!b.disabled}",timeout=10000)

  # Gating: a pending disclosure, a failed disclosure, a disclosure without a deletion scope, and a stale render.
  c,p,sent=open_page('gate@mantu.com');held=[]
  p.route('**/api/library/privacy/disclosure',lambda route:held.append(route))
  p.locator('header nav [data-view=journey]').click()
  p.wait_for_function("()=>!!document.getElementById('privacyDeleteOpen')",timeout=10000);p.wait_for_timeout(300)
  check('pending disclosure: delete is disabled',disabled(p,'#privacyDeleteOpen') is True and len(held)==1)
  p.evaluate(JS_CLICK,'privacyDeleteOpen');p.wait_for_timeout(200)
  check('pending disclosure: a click opens nothing and sends nothing',p.locator('#privacyConfirm').count()==0 and sent==[])
  p.evaluate("()=>window.dispatchEvent(new Event('atlas-auth'))")
  p.wait_for_timeout(1200)
  check('a re-render asks for its own disclosure',len(held)==2)
  held[0].continue_();p.wait_for_timeout(800)
  check('stale render: the earlier disclosure does not enable the current button',disabled(p,'#privacyDeleteOpen') is True)
  p.evaluate(JS_CLICK,'privacyDeleteOpen');p.wait_for_timeout(200)
  check('stale render: a click opens nothing and sends nothing',p.locator('#privacyConfirm').count()==0 and sent==[])
  held[1].continue_();wait_open(p)
  check('the current disclosure enables delete',disabled(p,'#privacyDeleteOpen') is False)
  c.close()
  c,p,sent=open_page('fail@mantu.com')
  p.route('**/api/library/privacy/disclosure',lambda route:route.fulfill(status=500,content_type='application/json',body='{"error":"synthetic disclosure failure"}'))
  p.locator('header nav [data-view=journey]').click();p.wait_for_timeout(1500)
  note=p.locator('#privacyNote').inner_text()
  check('failed disclosure: delete stays disabled and the page says deletion is not offered',disabled(p,'#privacyDeleteOpen') is True and 'not offered' in note)
  p.evaluate(JS_CLICK,'privacyDeleteOpen');p.wait_for_timeout(200)
  check('failed disclosure: a click opens nothing and sends nothing',p.locator('#privacyConfirm').count()==0 and sent==[])
  c.close()
  c,p,sent=open_page('noscope@mantu.com')
  def without_scope(route):
   r=route.fetch();d=r.json();d.pop('deletion',None);route.fulfill(response=r,body=json.dumps(d))
  p.route('**/api/library/privacy/disclosure',without_scope)
  p.locator('header nav [data-view=journey]').click();p.wait_for_timeout(1500)
  check('a disclosure without a deletion scope keeps delete disabled and says why',disabled(p,'#privacyDeleteOpen') is True and 'not offered' in p.locator('#privacyNote').inner_text())
  p.evaluate(JS_CLICK,'privacyDeleteOpen');p.wait_for_timeout(200)
  check('no deletion scope: a click opens nothing and sends nothing',p.locator('#privacyConfirm').count()==0 and sent==[])
  c.close()

  def disclosure_loaded(p):p.wait_for_function("()=>{const n=document.getElementById('privacyNote');return n&&n.textContent.startsWith('Consent')}",timeout=10000)
  def settle(p,ms=500):p.evaluate("ms=>new Promise(r=>setTimeout(r,ms))",ms)
  # A pending delete survives a re-render and navigating away and back.
  c,p,sent=open_page('rerender@mantu.com');pending=[]
  p.route('**/api/library/privacy/delete',lambda route:pending.append(route))
  p.locator('header nav [data-view=journey]').click();wait_open(p)
  p.locator('#privacyDeleteOpen').click();p.locator('#privacyConfirmTick').check();p.locator('#privacyConfirmDelete').click();settle(p,300)
  check('re-render: one delete is held',len(pending)==1)
  for how in ('a re-render','navigating away and back'):
   if how=='a re-render':p.evaluate("()=>window.dispatchEvent(new Event('atlas-auth'))")
   else:p.locator('header nav [data-view=projects]').click();settle(p,200);p.locator('header nav [data-view=journey]').click()
   settle(p,200);disclosure_loaded(p);settle(p,300)
   check(f'pending delete after {how}: the new opener is disabled',disabled(p,'#privacyDeleteOpen') is True)
   p.evaluate(JS_CLICK,'privacyDeleteOpen');settle(p,200)
   if p.locator('#privacyConfirm').count():p.locator('#privacyConfirmTick').check();p.locator('#privacyConfirmDelete').click();settle(p,300)
   check(f'pending delete after {how}: no second delete is sent',len(sent)==1)
  for r in pending:r.continue_()
  p.wait_for_function("()=>(document.getElementById('privacyActions')?.innerText||'').includes('verified tenant')",timeout=10000);settle(p,300)
  check('the held result appears in the current page and the opener is enabled and focused',p.locator('#privacyActions').is_visible() and disabled(p,'#privacyDeleteOpen') is False and p.evaluate("()=>document.activeElement?.id")=='privacyDeleteOpen')
  check('re-render: exactly one delete reached the network',len(sent)==1)
  c.close()

  # An older journey render that finishes after a newer one does not replace it.
  c,p,sent=open_page('order@mantu.com');jheld=[];disc=[]
  p.on('request',lambda r:disc.append(r.url) if '/privacy/disclosure' in r.url else None)
  def hold_first_journey(route):
   if route.request.method=='GET' and not jheld:jheld.append(route)
   else:route.continue_()
  p.route(re.compile(r'.*/api/library/journey$'),hold_first_journey)
  p.locator('header nav [data-view=journey]').click()
  p.wait_for_function("()=>!!document.getElementById('journey')&&!document.getElementById('journey').hidden",timeout=10000);settle(p,500)
  check('ordering: the first render is waiting for its journey',len(jheld)==1 and p.locator('#privacyActions').count()==0)
  p.evaluate("()=>window.dispatchEvent(new Event('atlas-auth'))");wait_open(p)
  p.evaluate("()=>{document.getElementById('privacyActions').dataset.render='newer'}");before=len(disc)
  with p.expect_response(lambda r:r.request.method=='GET' and r.url.endswith('/api/library/journey')):jheld[0].continue_()
  settle(p,800)
  check('ordering: the older render does not replace the newer page',p.evaluate("()=>document.getElementById('privacyActions')?.dataset.render")=='newer')
  check('ordering: the older render asks for no disclosure and the newer opener stays enabled',len(disc)==before and disabled(p,'#privacyDeleteOpen') is False)
  c.close()

  # An empty deletion scope does not enable deletion.
  c,p,sent=open_page('empty@mantu.com')
  def empty_scope(route):
   r=route.fetch();d=r.json();d['deletion']['coveredLocal']=[];route.fulfill(response=r,body=json.dumps(d))
  p.route('**/api/library/privacy/disclosure',empty_scope)
  p.locator('header nav [data-view=journey]').click();disclosure_loaded(p);settle(p,300)
  check('empty deletion scope: delete stays disabled and the page says why',disabled(p,'#privacyDeleteOpen') is True and 'not offered' in p.locator('#privacyNote').inner_text())
  p.evaluate(JS_CLICK,'privacyDeleteOpen');settle(p,200)
  check('empty deletion scope: a click opens nothing and sends nothing',p.locator('#privacyConfirm').count()==0 and sent==[])
  c.close()

  # Mocked receipts in the operate.js shape: mixed success and failure, focus, and one receipt across reopen.
  RECEIPT={'outcomes':[{'store':'journey','removed':1,'error':None},{'store':'telemetry','removed':2,'error':None},{'store':'profile','removed':0,'error':'delete-failed'},
   {'store':'manager-trust','removed':0,'error':None},{'store':'directory','removed':1,'error':None},{'store':'revisions','removed':0,'error':'delete-failed'},{'store':'stories','removed':0,'error':'delete-failed'}],
   'blocked':[{'store':'stories','id':'synthetic-target','reason':'another-owner-merge-target'}],'complete':False,'vendorDeletion':'not-asserted','note':'Synthetic mocked receipt.'}
  c,p,sent=open_page('receipt@mantu.com')
  p.route('**/api/library/privacy/delete',lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps(RECEIPT)))
  p.locator('header nav [data-view=journey]').click();wait_open(p)
  for n in (1,2):
   p.locator('#privacyDeleteOpen').click();p.locator('#privacyConfirmTick').check();p.locator('#privacyConfirmDelete').click()
   p.locator('#privacyReceipt').first.wait_for(timeout=10000);settle(p,300)
   rec=p.locator('#privacyReceipt').first.inner_text()
   if n==1:
    check('mixed receipt: removed stores, failed stores and the kept story are each shown',all(w in rec for w in ('journey: 1 removed','profile: not removed (delete-failed)','revisions: not removed (delete-failed)','stories: not removed (delete-failed)','Kept story synthetic-target and its revisions','Complete: no','not-asserted')))
    check('after a receipt, focus moves to the receipt',p.evaluate("()=>!!document.activeElement?.closest('#privacyReceipt')"))
  check('after a second confirmation there is one receipt and no duplicate ids',p.locator('#privacyReceipt').count()==1 and p.evaluate("()=>{const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);return ids.length===new Set(ids).size}"))
  check('mocked receipts: two confirmations sent two deletes',len(sent)==2)
  c.close()

  # A failed attempt after an earlier receipt: the earlier receipt is labelled as earlier, not as the latest result.
  OK={'outcomes':[{'store':s,'removed':1,'error':None} for s in ('journey','telemetry','profile','manager-trust','directory','revisions','stories')],
   'blocked':[],'complete':False,'vendorDeletion':'not-asserted','note':'Synthetic mocked receipt.'}
  c,p,sent=open_page('history@mantu.com');mode={'next':'mock'}
  def history_route(route):
   if mode['next']=='mock':route.fulfill(status=200,content_type='application/json',body=json.dumps(OK))
   elif mode['next']=='hold':held.append(route)
   else:route.continue_()
  p.route('**/api/library/privacy/delete',history_route)
  p.locator('header nav [data-view=journey]').click();wait_open(p)
  def confirm():p.locator('#privacyDeleteOpen').click();p.locator('#privacyConfirmTick').check();p.locator('#privacyConfirmDelete').click()
  confirm();p.locator('#privacyReceipt').wait_for(timeout=10000);settle(p,300)
  head=lambda:p.locator('#privacyReceipt h3').inner_text() if p.locator('#privacyReceipt').count() else ''
  rtext=lambda:p.locator('#privacyReceipt').inner_text() if p.locator('#privacyReceipt').count() else ''
  check('history: the first receipt is the current receipt',head()=='Deletion receipt' and 'earlier' not in rtext().lower())
  mode['next']='real';confirm()
  p.wait_for_function("()=>(document.getElementById('privacyActions')?.innerText||'').includes('verified tenant')",timeout=10000);settle(p,300)
  acts=p.locator('#privacyActions').inner_text()
  check('history: after the real refusal the earlier receipt is labelled as an earlier request',p.locator('#privacyReceipt').count()==1 and 'earlier' in head().lower() and 'not from the latest' in rtext())
  check('history: the refusal says the latest request did not complete','latest deletion request' in acts.lower() and 'verified tenant' in acts)
  check('history: one receipt, unique ids, the enabled opener has focus',p.evaluate("()=>{const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);return ids.length===new Set(ids).size}") and disabled(p,'#privacyDeleteOpen') is False and p.evaluate("()=>document.activeElement?.id")=='privacyDeleteOpen')
  p.evaluate("()=>window.dispatchEvent(new Event('atlas-auth'))");settle(p,200);disclosure_loaded(p);settle(p,300)
  check('history: after a re-render the earlier receipt is still labelled as earlier','earlier' in head().lower() and 'not from the latest' in rtext())
  warn=lambda:p.evaluate("()=>[...document.querySelectorAll('#privacyActions .pill.warn')].map(e=>e.innerText)")
  w=warn()
  check('history: after a re-render the latest-failure warning is still shown once',len(w)==1 and 'latest deletion request did not complete' in w[0].lower() and 'verified tenant' in w[0])
  def other_identity(route):
   r=route.fetch();d=r.json()
   for k in ('identity','email'):
    if k in d:d[k]='other-synthetic@mantu.com' if k=='email' else 'other-synthetic-identity'
   route.fulfill(response=r,body=json.dumps(d))
  def reboot():p.evaluate("()=>window.AtlasAuth.boot({fresh:true})");p.evaluate("()=>window.dispatchEvent(new Event('atlas-auth'))");settle(p,200);disclosure_loaded(p);settle(p,300)
  p.route('**/api/bootstrap',other_identity);reboot()
  check('history: a different identity in the same tab sees neither the receipt nor the failure warning',p.locator('#privacyReceipt').count()==0 and warn()==[] and 'did not complete' not in p.locator('#privacyActions').inner_text())
  p.unroute('**/api/bootstrap');reboot()
  w=warn()
  check('history: the original identity sees the earlier receipt and the failure warning again','earlier' in head().lower() and len(w)==1 and 'did not complete' in w[0])
  held=[];mode['next']='hold'
  confirm();settle(p,300)
  check('history: while a later attempt is pending no stale failure warning is shown',len(held)==1 and warn()==[] and 'did not complete' not in p.locator('#privacyActions').inner_text())
  held[0].fulfill(status=200,content_type='application/json',body=json.dumps(OK))
  p.wait_for_function("()=>document.querySelector('#privacyReceipt h3')?.textContent==='Deletion receipt'",timeout=10000);settle(p,300)
  check('history: after the later success no failure warning is shown',warn()==[] and 'did not complete' not in p.locator('#privacyActions').inner_text())
  check('history: a later success is shown as the current receipt with focus',head()=='Deletion receipt' and 'earlier' not in rtext().lower() and p.locator('#privacyReceipt').count()==1 and p.evaluate("()=>!!document.activeElement?.closest('#privacyReceipt')"))
  mode['next']='real';confirm()
  p.wait_for_function("()=>(document.getElementById('privacyActions')?.innerText||'').includes('did not complete')",timeout=10000);settle(p,300)
  held.clear();mode['next']='hold';confirm();settle(p,300)
  check('history: in the same page, a pending attempt right after a refusal shows no stale failure warning',len(held)==1 and warn()==[] and 'did not complete' not in p.locator('#privacyActions').inner_text())
  held[0].fulfill(status=200,content_type='application/json',body=json.dumps(OK))
  p.wait_for_function("()=>document.querySelector('#privacyReceipt h3')?.textContent==='Deletion receipt'",timeout=10000);settle(p,300)
  check('history: in the same page, the success after a refusal shows no stale failure warning, one receipt, unique ids',warn()==[] and p.locator('#privacyReceipt').count()==1 and p.evaluate("()=>{const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);return ids.length===new Set(ids).size}"))
  check('history: five confirmations sent five deletes',len(sent)==5)
  c.close()

  # Scope wording, Cancel, single in-flight request, refusal.
  for width in (1400,390):
   tag=f'[{width}px] '
   c,p,sent=open_page(f'ada{width}@mantu.com',width)
   p.locator('header nav [data-view=journey]').click();wait_open(p)
   p.locator('#privacyDeleteOpen').click();p.locator('#privacyConfirm').wait_for()
   scope=p.locator('#privacyConfirmScope').inner_text();label=p.locator('label[for=privacyConfirmTick], #privacyConfirm label').first.inner_text()
   deleted=p.locator('#privacyConfirmDeleted').inner_text();kept=p.locator('#privacyConfirmKept').inner_text()
   check(tag+'scope names the verified tenant, journey, profile and owned stories with their revisions',all(w in scope for w in ('verified tenant','journey','profile','stories you own','revisions')))
   check(tag+'scope and tick say a story another person merged into is kept with its revisions','merged into' in scope and 'kept' in scope and 'merged into' in label and 'kept' in label)
   check(tag+'no promise that every story or all data is erased',not any(w in (scope+' '+label).lower() for w in ('every story','all of your data','all your data','everything')) and 'does not erase all' in scope)
   check(tag+'scope says the receipt reports each store, a failed store keeps its data, and only a direct merge target is kept',all(w in scope for w in ('receipt','fails','directly')) and 'directly' in label)
   check(tag+'no unconditional promise that the listed data will be permanently deleted','will be permanently deleted' not in (scope+' '+label) and 'permanently deletes' not in scope)
   check(tag+'server lists: deleted scope and what is not deleted','except a story another owner merged into' in deleted and all(w in kept for w in ('claims, bids','audit','blank tenant','vendor-logs')))
   check(tag+'nothing sent before confirmation; Delete permanently disabled before the tick',sent==[] and disabled(p,'#privacyConfirmDelete') is True)
   check(tag+'the confirmation fits the viewport',p.evaluate('document.scrollingElement.scrollWidth<=document.scrollingElement.clientWidth+1'))
   p.locator('#privacyConfirmCancel').click();p.wait_for_timeout(300)
   check(tag+'Cancel closes, sends nothing and keeps the journey',p.locator('#privacyConfirm').count()==0 and sent==[] and 'Nothing was deleted' in p.locator('#privacyActions').inner_text() and api(p,'/journey')['fields']['title']['value']=='Privacy alias')
   pending=[];p.route('**/api/library/privacy/delete',lambda route:pending.append(route))
   p.locator('#privacyDeleteOpen').click();p.locator('#privacyConfirm').wait_for()
   if width==390:
    p.locator('#privacyConfirmTick').focus();p.keyboard.press('Space')
   else:p.locator('#privacyConfirmTick').check()
   check(tag+'the tick enables Delete permanently',disabled(p,'#privacyConfirmDelete') is False)
   if width==390:
    p.locator('#privacyConfirmDelete').focus()
    check(tag+'native keyboard: Delete permanently has focus before Enter',p.evaluate("()=>document.activeElement?.id")=='privacyConfirmDelete')
    p.keyboard.press('Enter');p.wait_for_timeout(300)
   else:p.locator('#privacyConfirmDelete').click();p.wait_for_timeout(300)
   check(tag+'one delete is in flight',len(pending)==1)
   p.evaluate("()=>{const t=document.getElementById('privacyConfirmTick');for(const v of [false,true,false,true]){t.checked=v;t.dispatchEvent(new Event('change',{bubbles:true}));}}")
   check(tag+'untick and retick while pending keep Delete permanently disabled',disabled(p,'#privacyConfirmDelete') is True)
   p.evaluate(JS_CLICK,'privacyConfirmDelete');p.evaluate(JS_CLICK,'privacyConfirmDelete')
   p.evaluate("()=>{const g=document.getElementById('privacyConfirmDelete');g.focus();for(const k of ['Enter',' '])g.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true}));}")
   focused=p.evaluate("()=>{const e=document.activeElement;return e&&e.closest&&e.closest('#privacyConfirm')&&!e.disabled?e.id:''}")
   p.keyboard.press('Enter');p.keyboard.press('Space');p.wait_for_timeout(500)
   check(tag+'JS clicks, synthetic keydowns and native Enter/Space while pending send no second delete',len(pending)==1 and len(sent)==1)
   check(tag+'while pending no enabled confirmation control has focus',focused=='')
   check(tag+'Cancel and the tick are disabled while pending',disabled(p,'#privacyConfirmCancel') is True and disabled(p,'#privacyConfirmTick') is True)
   for r in pending:r.continue_()
   p.wait_for_timeout(1200)
   text=p.locator('#privacyActions').inner_text()
   check(tag+'the refused delete shows the refusal, no receipt, and kept the journey','verified tenant' in text and p.locator('#privacyReceipt').count()==0 and api(p,'/journey')['fields']['title']['value']=='Privacy alias')
   check(tag+'exactly one delete request reached the network',len(sent)==1)
   check(tag+'after the refusal the enabled opener has focus',disabled(p,'#privacyDeleteOpen') is False and p.evaluate("()=>document.activeElement?.id")=='privacyDeleteOpen')
   c.close()
  check('no page errors',not ERR)
  b.close()
finally:
 srv.terminate()
 try:srv.wait(5)
 except Exception:srv.kill()
if ERR:print('PAGE ERRORS',ERR)
print(('PRIVACY_DELETE_BROWSER_FAIL '+str(len(FAILED))+': '+' | '.join(FAILED)) if FAILED else 'PRIVACY_DELETE_BROWSER_OK')
sys.exit(1 if FAILED else 0)
