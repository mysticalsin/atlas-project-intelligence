"""First load of the served page: the meta policy has no header-only directives, the HTTP header still
has them, and the console is empty. Chrome otherwise logs that it ignored frame-ancestors, report-uri and report-to.
  python3 tests/csp_console_browser.py
"""
import os, socket, subprocess, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy/cloudflare-edge'
s = socket.socket(); s.bind(('127.0.0.1', 0)); PORT = s.getsockname()[1]; s.close()
BASE = f'http://127.0.0.1:{PORT}'
srv = subprocess.Popen(['node', '--no-warnings', 'dev/local-edge.mjs', str(PORT)], cwd=EDGE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
for _ in range(100):
    try:
        urllib.request.urlopen(BASE + '/__settle', timeout=1)
        break
    except Exception:
        time.sleep(0.1)
HEADER_ONLY = ('frame-ancestors', 'report-uri', 'report-to')
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
        page = browser.new_context().new_page()
        console = []
        page.on('console', lambda message: console.append(message.type + ' ' + message.text))
        page.on('pageerror', lambda error: console.append('pageerror ' + str(error)))
        response = page.goto(BASE + '/?as=ada@example.test')
        page.wait_for_timeout(600)
        meta = page.locator('meta[http-equiv="Content-Security-Policy"]').get_attribute('content') or ''
        header = response.headers.get('content-security-policy', '')
        for name in HEADER_ONLY:
            assert name not in meta, name
            assert name in header, name
        assert console == [], console
        browser.close()
finally:
    srv.terminate()
