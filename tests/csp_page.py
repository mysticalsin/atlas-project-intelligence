"""Recompute a mutated page's meta script-src. Same script rules as build.py."""
import base64, hashlib, re

_SCRIPT = re.compile(r'<script\b([^>]*)>([\s\S]*?)</script>', re.I)
_TYPE = re.compile(r'''\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))''', re.I)
_EXECUTABLE = {'', 'text/javascript', 'application/javascript', 'module'}


def executable_scripts(html):
    out = []
    for attrs, body in _SCRIPT.findall(html):
        found = _TYPE.search(attrs)
        kind = ((found.group(1) or found.group(2) or found.group(3) or '') if found else '').lower()
        if kind not in _EXECUTABLE:
            continue
        out.append(body)
    return out


def script_src(htmls):
    seen, hashes = set(), []
    for html in htmls:
        for body in executable_scripts(html):
            token = "'sha256-" + base64.b64encode(hashlib.sha256(body.encode('utf-8')).digest()).decode('ascii') + "'"
            if token not in seen:
                seen.add(token)
                hashes.append(token)
    return ' '.join(hashes)


def rehash_csp(html):
    src = script_src([html])
    if 'sha256-' not in src:
        raise RuntimeError('mutated page has no executable script to hash')
    return re.sub(r'script-src [^;]+;', 'script-src ' + src + ';', html, count=1)
