"""Prepare a standalone page whose protocol guard the browser tests rewrite.

tests/depth_browser.py and tests/studio_browser.py replace PROTOCOL_GUARD with
if(false) so a set_content document can call the page. That edit changes three
inline scripts. The meta script-src is a hash list, so the edited scripts would
be refused and the quality dialog would never open.

This recomputes those hashes and writes them back into the meta policy. The
policy stays a hash list: no 'unsafe-inline'. The expression itself stays in the
source, which is what studio_browser.py rewrites before it strips the meta tag.
"""
import base64
import hashlib
import re

PROTOCOL_GUARD = "if(!['http:','https:'].includes(location.protocol))"
SCRIPT = re.compile(r'<script\b([^>]*)>([\s\S]*?)</script', re.I)
JS_TYPES = {'', 'text/javascript', 'application/javascript', 'module', 'text/ecmascript', 'application/ecmascript'}


def _executes(attrs):
    if re.search(r'\bsrc\s*=', attrs, re.I):
        return False
    match = re.search(r'''\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))''', attrs, re.I)
    kind = (match.group(1) or match.group(2) or match.group(3) or '').strip().lower() if match else ''
    return kind in JS_TYPES


def _hash(body):
    return 'sha256-' + base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()


def _script_src(policy, hashes):
    match = re.search(r'script-src ([^;]*)', policy)
    if not match:
        return policy
    extra = [token for token in match.group(1).split() if not token.startswith("'sha256-") and token not in {"'unsafe-inline'", "'none'"}]
    src = 'script-src ' + ' '.join([f"'{item}'" for item in hashes] + extra)
    return policy[:match.start()] + src + policy[match.end():]


def standalone_html(html):
    html = html.replace(PROTOCOL_GUARD, 'if(false)')
    hashes = sorted({_hash(match.group(2)) for match in SCRIPT.finditer(html) if _executes(match.group(1))})
    return re.sub(
        r'(<meta content=")([^"]*)(" http-equiv="Content-Security-Policy"/>)',
        lambda match: match.group(1) + _script_src(match.group(2), hashes) + match.group(3),
        html, count=1)
