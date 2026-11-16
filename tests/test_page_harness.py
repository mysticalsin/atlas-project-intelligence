"""The depth harness may rewrite the protocol guard. The meta CSP must still be a hash list."""
import base64
import hashlib
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from page_harness import PROTOCOL_GUARD, standalone_html

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = re.compile(r'<script\b([^>]*)>([\s\S]*?)</script', re.I)
JS_TYPES = {'', 'text/javascript', 'application/javascript', 'module', 'text/ecmascript', 'application/ecmascript'}


def executes(attrs):
    if re.search(r'\bsrc\s*=', attrs, re.I):
        return False
    match = re.search(r'''\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))''', attrs, re.I)
    kind = (match.group(1) or match.group(2) or match.group(3) or '').strip().lower() if match else ''
    return kind in JS_TYPES


def script_hash(body):
    return 'sha256-' + base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()


def test_protocol_rewrite_keeps_a_hash_csp_with_no_unsafe_inline():
    html = standalone_html((ROOT / 'ATLAS_Project_Intelligence.html').read_text())
    assert PROTOCOL_GUARD not in html
    meta = re.search(r'<meta content="([^"]*)" http-equiv="Content-Security-Policy"/>', html).group(1)
    src = re.search(r'script-src ([^;]*)', meta).group(1)
    assert 'unsafe-inline' not in src
    listed = set(re.findall(r"'sha256-[A-Za-z0-9+/=]+'", src))
    for match in SCRIPT.finditer(html):
        if executes(match.group(1)):
            assert "'" + script_hash(match.group(2)) + "'" in listed
