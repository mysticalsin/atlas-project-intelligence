"""Privacy delete confirmation in a real browser against the local edge (dev/local-edge.mjs): the real Worker handle(),
the real library and node:sqlite. Loopback only, no provider, synthetic people.
  python3 build.py && python3 deploy/cloudflare-edge/build_edge.py && python3 tests/privacy_delete_browser.py
Checks: the delete button waits for the server disclosure; the confirmation names the journey, the profile, owned stories
and all their revisions before anything is sent; Cancel sends no request and keeps the journey; Delete permanently needs
the tick and sends exactly one POST. The local edge identity has no tenant UUID, so that POST is refused by the Worker and
the page must show the refusal, not a receipt.
"""
import json,os,socket,subprocess,sys,time,urllib.parse,urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];EDGE=ROOT/'deploy/cloudflare-edge';ERR=[]
def check(n,v):print(('PASS ' if v else 'FAIL ')+n);assert v,n
if not (EDGE/'src/atlas.html').exists():print('NOT RUNNABLE: deploy/cloudflare-edge/src/atlas.html is missing. Run: python3 build.py && python3 deploy/cloudflare-edge/build_edge.py');sys.exit(2)
s=socket.socket();s.bind(('127.0.0.1',0));PORT=s.getsockname()[1];s.close();BASE=f'http://127.0.0.1:{PORT}'
srv=subprocess.Popen(['node','--no-warnings','dev/local-edge.mjs',str(PORT)],cwd=EDGE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
for _ in range(100):
 try:urllib.request.urlopen(BASE+'/__settle',timeout=1);break
 except Exception:time.sleep(.1)
API="([p,o])=>window.ATLAS_APP.libraryApi(p,o||{})"
def api(pg,path,method='GET',body=None):return pg.evaluate(API,[path,{'method':method,**({'body':body} if body is not None else {})}])
code=0
try:
 with sync_playwright() as pw:
  b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
  for width in (1400,390):
   c=b.new_context(viewport={'width':width,'height':900});p=c.new_page();p.on('pageerror',lambda e:ERR.append(str(e)))
   posts=[];p.on('request',lambda r:posts.append(r.url) if r.method=='POST' and '/privacy/delete' in r.url else None)
   p.goto(BASE+'/?as='+urllib.parse.quote(f'ada{width}@mantu.com'));p.wait_for_timeout(800)
   api(p,'/journey','POST',{'stage':'project','fields':{'title':{'value':'Privacy alias','source':'you','confirmed':True}}})
   p.locator('header nav [data-view=journey]').click()
   p.wait_for_function("()=>{const b=document.getElementById('privacyDeleteOpen');return b&&!b.disabled}",timeout=10000)
   tag=f'[{width}px] '
   check(tag+'delete waits for the disclosure, then is offered',p.locator('#privacyDeleteOpen').is_enabled())
   p.locator('#privacyDeleteOpen').click()
   box=p.locator('#privacyConfirm');box.wait_for()
   scope=p.locator('#privacyConfirmScope').inner_text();deleted=p.locator('#privacyConfirmDeleted').inner_text();kept=p.locator('#privacyConfirmKept').inner_text()
   check(tag+'confirmation names journey, profile, owned stories and all revisions before any POST',all(w in scope for w in ('journey','profile','every story you own','all of its revisions')) and 'stories and revisions owned by this subject' in deleted and not posts)
   check(tag+'confirmation lists what is not deleted',all(w in kept for w in ('claims, bids','audit','blank tenant','vendor-logs')))
   check(tag+'Delete permanently is disabled until the tick',not p.locator('#privacyConfirmDelete').is_enabled())
   check(tag+'the confirmation fits the viewport',p.evaluate('document.scrollingElement.scrollWidth<=document.scrollingElement.clientWidth+1'))
   p.locator('#privacyConfirmCancel').click();p.wait_for_timeout(300)
   check(tag+'Cancel closes the confirmation and sends no delete',p.locator('#privacyConfirm').count()==0 and posts==[])
   check(tag+'Cancel says nothing was deleted and the journey is still there','Nothing was deleted' in p.locator('#privacyActions').inner_text() and api(p,'/journey')['fields']['title']['value']=='Privacy alias')
   p.locator('#privacyDeleteOpen').click();box.wait_for()
   p.locator('#privacyConfirmTick').check()
   check(tag+'the tick enables Delete permanently',p.locator('#privacyConfirmDelete').is_enabled())
   p.locator('#privacyConfirmDelete').click();p.wait_for_timeout(800)
   check(tag+'Delete permanently sends exactly one POST',len(posts)==1)
   text=p.locator('#privacyActions').inner_text()
   check(tag+'a refused delete shows the refusal and no receipt','verified tenant' in text and p.locator('#privacyReceipt').count()==0)
   check(tag+'the refused delete kept the journey',api(p,'/journey')['fields']['title']['value']=='Privacy alias')
   c.close()
  check('no page errors',not ERR)
  b.close()
except AssertionError:code=1
finally:
 srv.terminate()
 try:srv.wait(5)
 except Exception:srv.kill()
if ERR:print('PAGE ERRORS',ERR)
sys.exit(code)
