"""The built page runs under its script hashes. Synthetic page only.
Listens for securitypolicyviolation. No provider, no microphone.
  python3 tests/csp_browser.py
"""
import os, re
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
H = (ROOT / 'ATLAS_Voice.html').read_text()
META = re.search(r'<meta content="([^"]+)" http-equiv="Content-Security-Policy"', H).group(1)
SCRIPT = re.search(r"(?:^|; )script-src ([^;]+)", META).group(1)
def check(n, v):
    print(('PASS ' if v else 'FAIL ') + n, flush=True)
    assert v, n
check('script-src has hashes and blob, and no unsafe-inline',
      "'unsafe-inline'" not in SCRIPT and 'blob:' in SCRIPT and "sha256-" in SCRIPT and 'worklet-src' not in META)
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None, args=['--no-sandbox'])
    p = b.new_page(viewport={'width': 1280, 'height': 800})
    ERR = []
    p.on('pageerror', lambda e: ERR.append(str(e)))
    p.add_init_script("""
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', function (e) {
        window.__cspViolations.push(e.violatedDirective + ' ' + e.blockedURI + ' ' + (e.sample || ''));
      });
    """)
    def route(r):
        if r.request.url.split('?', 1)[0].rstrip('/') == 'https://atlas.test':
            return r.fulfill(status=200, body=H, content_type='text/html', headers={'Content-Security-Policy': META})
        return r.abort()
    p.route('**/*', route)
    p.goto('https://atlas.test/', wait_until='load')
    p.wait_for_timeout(400)
    violations = p.evaluate('window.__cspViolations') or []
    booted = p.evaluate("() => typeof AtlasEngine === 'object'")
    heading = p.locator('h1').first.inner_text()
    check('the page booted under the hash policy', booted and 'Great work' in heading)
    worklet = p.evaluate("""async () => {
      const src = document.getElementById('atlasVoiceWorklet').textContent;
      const ctx = new AudioContext();
      const url = URL.createObjectURL(new Blob([src], {type:'text/javascript'}));
      try { await ctx.audioWorklet.addModule(url); }
      finally { URL.revokeObjectURL(url); }
      return 'loaded';
    }""")
    violations = p.evaluate('window.__cspViolations') or []
    check('the page worklet loads from its blob', worklet == 'loaded')
    check('no securitypolicyviolation events', violations == [])
    check('no page errors', not ERR)
    if violations or ERR: print(violations, ERR)
    b.close()
