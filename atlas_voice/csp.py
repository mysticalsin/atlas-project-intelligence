"""Content-Security-Policy for the HTML the app serves (v2.2 F1). Stdlib only; build.py, the gateway and the tests share it.

Every executable inline <script> in a page is static: the server's per-person facts travel in a <script type="application/json"
id="atlas-runtime"> data block, never as code. The policy therefore allows exactly the SHA-256 of each inline script body
(no 'unsafe-inline', no 'strict-dynamic') plus blob: for the AudioWorklet module the page builds from its own text/plain script.
The edge Worker builds the same policy in deploy/cloudflare-edge/src/csp.js; tests/test_csp.py holds the two together.
"""
import base64
import hashlib
import re

# The data block the server fills (edge app.js, gateway server.py). An offline copy keeps the empty object.
RUNTIME_BLOCK = '<script id="atlas-runtime" type="application/json">{}</script>'
REPORT_PATH = '/api/csp-report'
REPORT_GROUP = 'atlas-csp'

# An inline <script> as the HTML parser reads it: from the start tag to the first "</script". Only classic (typeless) and
# JavaScript-typed bodies execute, so only those need a hash; application/json and text/plain blocks are data.
_SCRIPT = re.compile(r'<script\b([^>]*)>(.*?)</script', re.S | re.I)
_TYPE = re.compile(r'''\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))''', re.I)
_JS_TYPES = {'', 'text/javascript', 'application/javascript', 'module', 'text/ecmascript', 'application/ecmascript'}


def _executes(attrs):
    if re.search(r'\bsrc\s*=', attrs, re.I):
        return False  # an external script would need its own source allowance; the pages have none
    m = _TYPE.search(attrs)
    return (next(g for g in m.groups() if g is not None).strip().lower() if m else '') in _JS_TYPES


def script_hashes(page):
    """The CSP source tokens ('sha256-...') of every executable inline script body in the page, sorted, unique."""
    out = {'sha256-' + base64.b64encode(hashlib.sha256(body.encode('utf-8')).digest()).decode()
           for attrs, body in _SCRIPT.findall(page) if _executes(attrs)}
    return sorted(out)


def script_src(hashes):
    return ' '.join(f"'{h}'" for h in hashes)


TT_POLICY = 'atlas-html'


def html_csp(*, hashes=(), connect='', connect_self=True, frame_ancestors="'none'", form_action="'self'", report=True,
             script_blob=False, worker_blob=False, media_blob=False, font_self=True, img_src=None, trusted_types=TT_POLICY):
    """One policy builder. Defaults are a quiet page (no blob). The voice page opts into script_blob, worker_blob and media_blob.
    `connect` is an extra connect-src origin. img_src False omits img-src. trusted_types 'none' is a page that only uses textContent."""
    sources = ' '.join(filter(None, [script_src(hashes) if hashes else '', 'blob:' if script_blob else ''])) or "'none'"
    d = ["default-src 'none'", 'script-src ' + sources, "script-src-attr 'none'", "style-src 'unsafe-inline'"]
    connect_src = ' '.join(filter(None, ["'self'" if connect_self else '', connect]))
    if connect_src:
        d.append('connect-src ' + connect_src)
    if img_src is None:
        img = 'data: blob:' if script_blob else ('data:' if font_self or connect_self else '')
    else:
        img = img_src or ''
    if img:
        d.append('img-src ' + img)
    if font_self:
        d.append("font-src 'self'")
    if worker_blob:
        d.append('worker-src blob:')
    if media_blob:
        d.append('media-src blob:')
    d += ["object-src 'none'", "base-uri 'none'", f'form-action {form_action}', f'frame-ancestors {frame_ancestors}']
    d += ["require-trusted-types-for 'script'", 'trusted-types ' + ("'none'" if trusted_types == 'none' else trusted_types)]
    if report:
        d += [f'report-uri {REPORT_PATH}', f'report-to {REPORT_GROUP}']
    return '; '.join(d)


_META_ONLY = ('frame-ancestors', 'report-uri', 'report-to')


def meta_csp(**kw):
    """The page <meta> policy. Header-only directives stay on the HTTP header, where the browser enforces them."""
    return '; '.join(part for part in (p.strip() for p in html_csp(**kw).split(';')) if part and not part.startswith(_META_ONLY))


# The policy the page had before F1, kept only for ATLAS_CSP=report-only: it is ENFORCED while the strict one is reported.
def legacy_csp(*, connect=''):
    return ("default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; connect-src 'self'" + (' ' + connect if connect else '') +
            "; img-src data: blob:; font-src 'self'; worker-src blob:; media-src blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")


REPORTING_ENDPOINTS = f'{REPORT_GROUP}="{REPORT_PATH}"'
