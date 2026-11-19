"""Orb touch layer in a real browser: it keeps turning and wandering on its own; a drag turns it with the hand and
never triggers the orb button; a click makes it flinch and still starts the interview flow.
Frames are stepped inside the page at a fixed 1/60 s. A busy machine can only slow the call; it cannot change the
step. The fling check still requires a coast, then a later window of the same length that has slowed down.
  python3 tests/orb_touch_browser.py
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];ERR=[]
CLOCK="""(() => {
  let now = 0; const q = []; let seq = 1;
  performance.now = () => now;
  window.requestAnimationFrame = cb => { const id = seq++; q.push({ id, cb }); return id; };
  window.cancelAnimationFrame = id => { const i = q.findIndex(x => x.id === id); if (i >= 0) q.splice(i, 1); };
  window.__advance = ms => {
    const step = 1000 / 60; let left = ms, guard = 0;
    while (left > 0.01 && guard < 100000) {
      guard++; const dt = Math.min(step, left); now += dt; left -= dt;
      const batch = q.splice(0, q.length);
      for (const item of batch) item.cb(now);
    }
    return now;
  };
})();"""
H=(ROOT/'ATLAS_Voice.html').read_text().replace('<head>','<head><script>'+CLOCK+'</script>',1)
def check(n,v):print(('PASS ' if v else 'FAIL ')+n);assert v,n
with sync_playwright() as pw:
 b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None);p=b.new_page(viewport={'width':1440,'height':1000});p.on('pageerror',lambda e:ERR.append(str(e)))
 p.set_content(H,wait_until='load')
 def advance(ms):p.evaluate('ms => window.__advance(ms)',ms)
 advance(600)
 T=lambda:p.evaluate('AtlasOrbUI.inspect().touch')
 a=T();advance(2000);b2=T()
 check('keeps rotating on its own',b2['spinY']-a['spinY']>.2)
 check('moves around the stage',abs(b2['offX']-a['offX'])+abs(b2['offY']-a['offY'])>0.0005)
 box=p.locator('#orbCanvas').bounding_box();cx=box['x']+box['width']/2;cy=box['y']+box['height']/2
 s0=T()['spinY'];p.mouse.move(cx-120,cy);p.mouse.down();
 for i in range(12):p.mouse.move(cx-120+i*20,cy+i*3);advance(16)
 mid=T();p.mouse.up();advance(300)
 check('drag turns it with the hand',mid['spinY']-s0>1.0 and mid['dragging'] is True)
 check('drag never opens the start dialog',not p.locator('#voiceConsentDialog').is_visible() and not p.locator('#voiceConnectionDialog').is_visible())
 after=T();advance(700);coast=T();spun=coast['spinY']-after['spinY']
 advance(4000);base=T();advance(700);rest=T()['spinY']-base['spinY']
 print('fling spun=%s rest=%s dragging=%s'%(spun,rest,coast['dragging']))
 check('fling keeps spinning then settles',spun>.2 and not coast['dragging'] and rest<spun)
 # WOW_ZERO_CONFIG §3.3: in an offline copy the orb forwards to the "Open ATLAS" link (a new tab). Every request from here on is
 # recorded and aborted, so the new tab never reaches the network.
 SEEN=[];NEW=[];p.context.route('**/*',lambda r:(SEEN.append(r.request.url),r.abort()));p.context.on('page',lambda pg:NEW.append(pg))
 p.mouse.click(cx+60,cy-40);advance(120);t=T()
 check('click makes it flinch and spark',t['flash']>.3 and t['electrons']>=1)
 advance(500);home=p.evaluate("window.ATLAS_HOME+'/go/start'")
 opened=p.locator('#voiceConsentDialog').is_visible() or p.locator('#voiceConnectionDialog').is_visible() or p.evaluate("AtlasVoice.status().phase")!='idle' or (len(NEW)==1 and home in SEEN)
 check('click still does the button job (start flow began)',opened)
 check('no page errors',not ERR);print(ERR)
