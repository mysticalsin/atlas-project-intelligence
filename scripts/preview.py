#!/usr/bin/env python3
"""Serve only the compiled HTML on loopback. Never serve .env or source folders."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / 'ATLAS_Voice_Studio.html'
class PreviewHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # Never log incoming paths, query strings or potentially sensitive data.
    def do_HEAD(self):
        self._page(head=True)
    def do_GET(self):
        self._page(head=False)
    def _page(self, head):
        host = self.headers.get('Host', '').split(':')[0].lower()
        if host not in ('localhost', '127.0.0.1'):
            self.send_error(403, 'Loopback Host required'); return
        request = urlsplit(self.path)
        # Absolute-form carries its own authority. The Host header must not answer for it.
        if request.scheme or request.netloc:
            self.send_error(403, 'Loopback Host required'); return
        if request.path not in ('/', '/ATLAS_Voice_Studio.html') or request.query:
            self.send_error(404); return
        if not HTML.is_file():
            self.send_error(503, 'Run python3 build.py first'); return
        payload = HTML.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Permissions-Policy', 'microphone=(), camera=(), geolocation=()')
        self.end_headers()
        if not head:
            self.wfile.write(payload)
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8000)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535: parser.error('Port must be 1–65535.')
    if not HTML.is_file(): parser.error('Run python3 build.py first.')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), PreviewHandler)
    print(f'ATLAS interface preview: http://localhost:{args.port}', flush=True)
    print('Only HTML is served. No NVIDIA inference or microphone route. Ctrl+C stops.', flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()
if __name__ == '__main__': main()
