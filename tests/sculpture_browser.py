"""v10 actual Canvas/DOM checks. Silent fixtures are explicitly distinguished from voice."""
from pathlib import Path
import json,hashlib,os,shutil
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
HTML=(ROOT/'ATLAS_Voice_Studio.html').read_text()
checks=[];errors=[];requests=[]
def check(n,v):
 checks.append({'name':n,'passed':bool(v)});print(('PASS ' if v else 'FAIL ')+n,flush=True)
 if not v:raise AssertionError(n)
with sync_playwright() as pw:
 b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),args=['--no-sandbox']);c=b.new_context(viewport={'width':1440,'height':900},accept_downloads=True)
 def load(html=HTML,reduced=False,init=None):
  p=c.new_page();p.set_default_timeout(5000);p.on('pageerror',lambda e:errors.append(str(e)));p.on('request',lambda r:requests.append(r.url))
  if reduced:p.emulate_media(reduced_motion='reduce')
  if init:p.add_init_script(init);p.goto('about:blank')  # (a fresh document, so the script runs before the page's) test code goes in as an init script: the page's own scripts are hash-pinned by its <meta> CSP
  p.set_content(html,wait_until='load');p.wait_for_timeout(250);return p
 def pixels(p):return p.locator('#orbCanvas').evaluate('(c)=>c.toDataURL()')
 try:
  p=load();check('New three-column dashboard is rendered',p.locator('.context-card').count()==5)
  check('Canvas draws without backend',p.evaluate('AtlasOrbUI.inspect().frames>2'))
  check('Initial progress is 0 of 6, not a fictional percentage',p.locator('#captureCount').inner_text().replace(' ','')=='0/6')
  check('Initial transcript contains no invented speech',p.locator('#agentText').text_content()=='')
  check('Initial state is disconnected',p.locator('#voiceState').inner_text()=='Not connected')
  check('No script/image/font fetch on load',not requests)
  x=pixels(p);p.wait_for_timeout(300);check('Idle Canvas pixels actually change',pixels(p)!=x)
  p.locator('#orbQuickPause').click();p.wait_for_timeout(150);x=pixels(p);p.wait_for_timeout(220);check('Pause freezes rendered pixels',pixels(p)==x)
  p.locator('#orbQuickPause').click();p.wait_for_timeout(220);check('Resume changes rendered pixels',pixels(p)!=x)
  p.evaluate("document.querySelector('.motion-language').open=true");p.locator('[data-orb-preview=speaking]').click();p.wait_for_timeout(1200)
  check('Speech preview causes actual body deformation',p.evaluate('AtlasOrbUI.inspect().behavior.articulation>.1'))
  check('Speech preview does not claim connection',p.locator('#voiceState').inner_text()=='Not connected')
  check('Side panel identifies the preview',p.locator('#connectionStateLabel').inner_text()=='Motion preview')
  check('Preview leaves the microphone off',p.evaluate('!AtlasVoice.status().hasMicrophone'))
  check('Preview produces no transcript',p.locator('#agentText').text_content()=='')
  check('No expanding-wave property in pose',p.evaluate('AtlasOrbUI.inspect().behavior.wave===undefined'))
  p.evaluate("document.querySelector('.motion-language').open=true");p.locator('#studioPreview').click();p.wait_for_timeout(120);check('Stop restores real disconnected state',p.locator('#connectionStateLabel').inner_text()=='Ready when you are')
  p.locator('#orbQuickFocus').click();check('Focus removes the two side columns',not p.locator('.studio-left').is_visible() and not p.locator('.studio-right').is_visible())
  p.keyboard.press('Escape');p.wait_for_timeout(250)  # leaving full screen is asynchronous
  check('Escape restores context panels',p.locator('.studio-left').is_visible())
  # Project facts and progress come from actual local records, not the mockup.
  p.locator('.studio-left [data-action=new-project]').click()
  for k,v in {'projectTitle':'Pilot knowledge capture','consultantName':'Alex Example','consultantRole':'Delivery engineer','sectorInput':'Manufacturing'}.items():p.locator('#'+k).fill(v)
  p.locator('#projectForm button[type=submit]').click()
  check('Project panel uses entered alias',p.locator('#contextProjectTitle').inner_text()=='Pilot knowledge capture')
  check('Project panel uses entered consultant and role','Delivery engineer' in p.locator('#contextProjectMeta').inner_text())
  p.locator('#voiceTextToggle').click();p.locator('#answerInput').fill('I built a production tracking dashboard for one manufacturing line. It was an eight-week pilot, not a factory-wide rollout.');p.locator('#nextButton').click();p.locator('#voiceTextToggle').click()
  check('Progress increases only for a saved topic',p.locator('#captureCount').inner_text().replace(' ','')=='1/6')
  p.locator('header [data-view=projects]').click();check('Project library remains functional','Pilot knowledge capture' in p.locator('#projectCards').inner_text());p.locator('header [data-view=interview]').click()
  for width in (320,390,768,1024,1366,1512):
   p.set_viewport_size({'width':width,'height':900});p.wait_for_timeout(110)
   check(f'No document overflow at {width}',p.evaluate('document.documentElement.scrollWidth<=innerWidth'))
   check(f'Canvas fits device at {width}',p.locator('#orbCanvas').bounding_box()['width']<=width)
  p.set_viewport_size({'width':1366,'height':768});p.evaluate('window.scrollTo(0,0)');p.wait_for_timeout(150)
  box=p.locator('#voiceOpenHome').bounding_box();check('Main call to action fits a 1366 × 768 screen',box['y']+box['height']<=768)  # offline copy: "Open ATLAS" (WOW_ZERO_CONFIG §3.3)
  p.locator('#studioAppearance').click();p.locator('[data-palette=blue]').click();check('Optional blue appearance works',p.evaluate('AtlasOrbUI.inspect().palette==="blue"'))
  reduced=load(reduced=True);f=reduced.evaluate('AtlasOrbUI.inspect().frames');reduced.wait_for_timeout(300);check('Reduced motion does not animate continuously',reduced.evaluate('AtlasOrbUI.inspect().frames')==f)
  fail=load(init="HTMLCanvasElement.prototype.getContext=function(){return null};");check('Missing Canvas retains visible inline SVG',fail.locator('.orb-inline-fallback').is_visible())
  check('Canvas failure leaves connection controls available',fail.locator('#voiceOpenHome').is_visible())  # offline copy: "Open ATLAS" (WOW_ZERO_CONFIG §3.3)
  check('No JavaScript exceptions across checks',not errors)
 finally:
  (ROOT/'tests/sculpture-browser-results.json').write_text(json.dumps({'scope':'Real browser rendering via unchanged HTML set_content; no native NVIDIA or microphone. One explicit Canvas-failure injection.','checks':checks,'errors':errors},indent=2));b.close()
print(len(checks),'checks passed')
