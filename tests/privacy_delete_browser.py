"""Privacy delete confirmation in a real browser against the local edge (dev/local-edge.mjs): the real Worker handle(),
the real library and node:sqlite. Loopback only, no provider, synthetic people.
  python3 build.py && python3 deploy/cloudflare-edge/build_edge.py && python3 tests/privacy_delete_browser.py
The browser holds the disclosure and the delete responses so the races are reproduced, not assumed:
- while the disclosure is pending, failed, or without a deletion scope, deletion cannot be opened or sent;
- a disclosure from an earlier render does not enable the current button;
- the confirmation states the verified-tenant scope, that a story another person merged into is kept with its revisions,
  and does not promise that every story or all data is erased;
- Cancel sends nothing; while a delete is pending, unticking and reticking, clicks and Enter send nothing more;
- the local edge identity has no tenant UUID, so the one POST is refused and the page shows the refusal, not a receipt.
Success and the partial (blocked) receipt need a tenant identity and are exercised against the bundled Worker in workerd.
"""
import json,os,socket,subprocess,sys,time,urllib.parse,urllib.request
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
   check(tag+'server lists: deleted scope and what is not deleted','except a story another owner merged into' in deleted and all(w in kept for w in ('claims, bids','audit','blank tenant','vendor-logs')))
   check(tag+'nothing sent before confirmation; Delete permanently disabled before the tick',sent==[] and disabled(p,'#privacyConfirmDelete') is True)
   check(tag+'the confirmation fits the viewport',p.evaluate('document.scrollingElement.scrollWidth<=document.scrollingElement.clientWidth+1'))
   p.locator('#privacyConfirmCancel').click();p.wait_for_timeout(300)
   check(tag+'Cancel closes, sends nothing and keeps the journey',p.locator('#privacyConfirm').count()==0 and sent==[] and 'Nothing was deleted' in p.locator('#privacyActions').inner_text() and api(p,'/journey')['fields']['title']['value']=='Privacy alias')
   pending=[];p.route('**/api/library/privacy/delete',lambda route:pending.append(route))
   p.locator('#privacyDeleteOpen').click();p.locator('#privacyConfirm').wait_for()
   p.locator('#privacyConfirmTick').check()
   check(tag+'the tick enables Delete permanently',disabled(p,'#privacyConfirmDelete') is False)
   p.locator('#privacyConfirmDelete').click();p.wait_for_timeout(300)
   check(tag+'one delete is in flight',len(pending)==1)
   p.evaluate("()=>{const t=document.getElementById('privacyConfirmTick');for(const v of [false,true,false,true]){t.checked=v;t.dispatchEvent(new Event('change',{bubbles:true}));}}")
   check(tag+'untick and retick while pending keep Delete permanently disabled',disabled(p,'#privacyConfirmDelete') is True)
   p.evaluate(JS_CLICK,'privacyConfirmDelete');p.evaluate(JS_CLICK,'privacyConfirmDelete')
   p.evaluate("()=>{const g=document.getElementById('privacyConfirmDelete');g.focus();for(const k of ['Enter',' '])g.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true}));}")
   p.keyboard.press('Enter');p.keyboard.press('Space');p.wait_for_timeout(500)
   check(tag+'clicks and keys while pending send no second delete',len(pending)==1 and len(sent)==1)
   check(tag+'Cancel and the tick are disabled while pending',disabled(p,'#privacyConfirmCancel') is True and disabled(p,'#privacyConfirmTick') is True)
   for r in pending:r.continue_()
   p.wait_for_timeout(1200)
   text=p.locator('#privacyActions').inner_text()
   check(tag+'the refused delete shows the refusal, no receipt, and kept the journey','verified tenant' in text and p.locator('#privacyReceipt').count()==0 and api(p,'/journey')['fields']['title']['value']=='Privacy alias')
   check(tag+'exactly one delete request reached the network',len(sent)==1)
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
