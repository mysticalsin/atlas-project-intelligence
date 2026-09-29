"""Orb touch layer in a real browser: it keeps turning and wandering on its own; a drag turns it with the hand and
never triggers the orb button; a click makes it flinch and still starts the interview flow.
  python3 tests/orb_touch_browser.py
"""
import os,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];H=(ROOT/'ATLAS_Voice.html').read_text();ERR=[]
def check(n,v):print(('PASS ' if v else 'FAIL ')+n);assert v,n
with sync_playwright() as pw:
 b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None);p=b.new_page(viewport={'width':1440,'height':1000});p.on('pageerror',lambda e:ERR.append(str(e)))
 p.set_content(H,wait_until='load');p.wait_for_timeout(600)
 T=lambda:p.evaluate('AtlasOrbUI.inspect().touch')
 a=T();p.wait_for_timeout(2000);b2=T()
 check('keeps rotating on its own',b2['spinY']-a['spinY']>.2)
 check('moves around the stage',abs(b2['offX']-a['offX'])+abs(b2['offY']-a['offY'])>0.0005)
 box=p.locator('#orbCanvas').bounding_box();cx=box['x']+box['width']/2;cy=box['y']+box['height']/2
 s0=T()['spinY'];p.mouse.move(cx-120,cy);p.mouse.down();
 for i in range(12):p.mouse.move(cx-120+i*20,cy+i*3);p.wait_for_timeout(16)
 mid=T();p.mouse.up();p.wait_for_timeout(300)
 check('drag turns it with the hand',mid['spinY']-s0>1.0 and mid['dragging'] is True)
 check('drag never opens the start dialog',not p.locator('#voiceConsentDialog').is_visible() and not p.locator('#voiceConnectionDialog').is_visible())
 after=T();p.wait_for_timeout(700);coast=T()
 check('fling keeps spinning then settles',coast['spinY']-after['spinY']>.2 and not coast['dragging'])
 # WOW_ZERO_CONFIG §3.3: in an offline copy the orb forwards to the "Open ATLAS" link (a new tab). Every request from here on is
 # recorded and aborted, so the new tab never reaches the network.
 SEEN=[];NEW=[];p.context.route('**/*',lambda r:(SEEN.append(r.request.url),r.abort()));p.context.on('page',lambda pg:NEW.append(pg))
 p.mouse.click(cx+60,cy-40);p.wait_for_timeout(120);t=T()
 check('click makes it flinch and spark',t['flash']>.3 and t['electrons']>=1)
 p.wait_for_timeout(500);home=p.evaluate("window.ATLAS_HOME+'/go/start'")
 opened=p.locator('#voiceConsentDialog').is_visible() or p.locator('#voiceConnectionDialog').is_visible() or p.evaluate("AtlasVoice.status().phase")!='idle' or (len(NEW)==1 and home in SEEN)
 check('click still does the button job (start flow began)',opened)
 check('no page errors',not ERR);print(ERR)
