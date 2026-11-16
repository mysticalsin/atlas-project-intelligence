"""Browser check that /confirm's CSP lets its own fetches through and blocks a foreign origin.
Synthetic responses only. No provider, no microphone, no real tenant."""
import json
import os
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EDGE = os.path.join(ROOT, 'deploy', 'cloudflare-edge')
ITEM = {
    'request': {'id': 'req-synthetic'},
    'reference': {'title': 'Northwind pilot alias', 'consultant': {'name': 'Ada'}},
    'claims': [{'id': 'c1', 'topic': 1, 'text': 'Ada owned the pilot plan.'}],
}


def page_and_policy():
    script = (
        "import { CONFIRM_HTML } from './src/confirm-page.js';"
        "import { htmlCsp, inlineScriptHashes } from './src/csp.js';"
        "const hashes = await inlineScriptHashes(CONFIRM_HTML);"
        "const policy = htmlCsp({ hashes, connectSelf: true, scriptBlob: false, imgSrc: false, fontSelf: false,"
        " workerBlob: false, mediaBlob: false, trustedTypes: 'none', formAction: \"'none'\" });"
        "process.stdout.write(JSON.stringify({ html: CONFIRM_HTML, policy }));"
    )
    out = subprocess.run(['node', '--input-type=module', '-e', script], cwd=EDGE, check=True, capture_output=True, text=True)
    return json.loads(out.stdout)


class Handler(BaseHTTPRequestHandler):
    html = ''
    policy = ''
    posted = []

    def log_message(self, fmt, *args):
        return

    def _send(self, status, body, content_type, csp=True):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Cache-Control', 'no-store')
        if csp:
            self.send_header('Content-Security-Policy', self.policy)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/confirm':
            self._send(200, self.html, 'text/html; charset=utf-8')
        elif self.path == '/api/bootstrap':
            self._send(200, json.dumps({'csrf': 'synthetic', 'features': {'claims': True}}), 'application/json')
        elif self.path == '/api/library/confirmations/inbox':
            self._send(200, json.dumps({'items': [ITEM]}), 'application/json')
        else:
            self._send(404, '{}', 'application/json')

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        Handler.posted.append(self.rfile.read(length))
        self._send(200, json.dumps({'ok': True}), 'application/json')


def main():
    dumped = page_and_policy()
    assert "connect-src 'self'" in dumped['policy'] and 'blob:' not in dumped['policy'] and "trusted-types 'none'" in dumped['policy']
    Handler.html, Handler.policy = dumped['html'], dumped['policy']
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_address[1]}'
    chrome = os.environ.get('CHROMIUM_PATH') or shutil.which('google-chrome') or shutil.which('chromium')
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=chrome, args=['--no-sandbox'])
        page = browser.new_context().new_page()
        page.goto(origin + '/confirm', wait_until='networkidle')
        page.get_by_role('heading', name='Confirm 1 point for Ada, about 60 seconds').wait_for()
        page.get_by_role('button', name='Confirm').click()
        page.get_by_role('button', name='Send my answers').click()
        page.get_by_role('heading', name='Recorded. Thank you. Nothing else is shared.').wait_for()
        blocked = page.evaluate("""async () => {
          try { await fetch('https://evil.example/nope'); return 'allowed'; }
          catch (e) { return 'blocked'; }
        }""")
        browser.close()
    server.shutdown()
    assert blocked == 'blocked', blocked
    assert Handler.posted and b'c1' in Handler.posted[0]
    print('confirm CSP browser: inbox loaded, answer posted, foreign fetch blocked')


if __name__ == '__main__':
    main()
