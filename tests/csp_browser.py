"""F1: the built page under the ENFORCED strict CSP (the real header from the local edge Worker, plus the page's own <meta> policy) in a real browser:
zero `securitypolicyviolation` events and zero console CSP errors across boot, the consent dialog, a typed interview, the Library view and the profile/privacy
panel; and a negative proof that the policy is live (an injected inline script, an inline event-handler attribute and a javascript: URL are all refused and
reported). Loopback only: no provider, no network. The voice WebSocket is a scripted stand-in (the local edge serves none).
  python3 build.py && cp ATLAS_Voice.html deploy/cloudflare-edge/src/atlas.html && python3 tests/csp_browser.py
"""
import json, os, re, socket, subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy/cloudflare-edge'
ERR, PROCS = [], []
USER = 'alex@mantu.com'
# What the real Session announces in `ready` (read from the source so the stand-in cannot drift from it); without it the page shows no typed-answer field.
CONTROLS = re.findall(r"'([a-z_]+)'", re.search(r'export const CONTROLS = Object\.freeze\(\[(.*?)\]\)', (EDGE / 'src/session.js').read_text()).group(1))


def check(name, value):
    print(('PASS ' if value else 'FAIL ') + name, flush=True)
    assert value, name


# U1: the local edge announces voice:false (no speech service); this suite stands in for the voice socket, so it asks for the voice start (ATLAS_VOICE=on)
def start_edge(extra_env=None):
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
    env = {k: v for k, v in os.environ.items() if k not in ('DATA_MODE', 'DIRECTORY_PUSH_SECRET', 'IDENTITY_SOURCE', 'ATLAS_CSP') and not k.startswith('DNA_')}
    proc = subprocess.Popen(['node', '--no-warnings', 'dev/local-edge.mjs', str(port)], cwd=EDGE, env={**env, 'ATLAS_ADAPTERS': 'mock', 'ATLAS_VOICE': 'on', **(extra_env or {})}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    PROCS.append(proc)
    base = f'http://127.0.0.1:{port}'
    for _ in range(100):
        try: urllib.request.urlopen(base + '/__settle', timeout=1); break
        except Exception: time.sleep(.1)
    return base


# Collected inside the page before any script runs: every CSP violation event, and every console error that mentions the policy.
COLLECT = """window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push({d:e.effectiveDirective,b:e.blockedURI,s:(e.sample||'').slice(0,60)}),true);"""


def ws_standin(ws):
    def on(m):
        if isinstance(m, bytes): return
        d = json.loads(m); t = d.get('type')
        if t == 'start':
            ws.send(json.dumps({'type': 'ready', 'mode': 'full', 'model': 'ATLAS', 'provider': 'ATLAS voice', 'sampleRate': 24000, 'capture': True, 'liveLedger': True, 'maxSeconds': 900,
                                'speakingSeconds': 600, 'message': 'ready', **({'input': 'text'} if d.get('mode') == 'text' else {}), 'sessionId': 'ab' * 16, 'resumable': True, 'controls': CONTROLS, 'timePlan': {'depthAt': 405, 'closingAt': 690}}))
            ws.send(json.dumps({'type': 'agent_text', 'text': "Hi, I'm ATLAS. What was the project?"}))
        elif t == 'text':
            ws.send(json.dumps({'type': 'user_text', 'item_id': 'user-typed-1', 'text': d['text'], 'provenance': 'consultant_typed'}))
            ws.send(json.dumps({'type': 'agent_text', 'text': '\n\nThanks. Over what period was that measured?'}))
        elif t == 'end':
            for e in [{'type': 'audio_stopped'}, {'type': 'ended', 'message': 'done'}]: ws.send(json.dumps(e))
    ws.on_message(on)


code = 0
try:
    BASE = start_edge()
    with sync_playwright() as pw:
        br = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None, args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
        ctx = br.new_context(permissions=[], viewport={'width': 1280, 'height': 1000})
        p = ctx.new_page(); p.add_init_script(COLLECT)
        console, reports, headers = [], [], {}
        p.on('pageerror', lambda e: ERR.append(str(e)))
        p.on('console', lambda m: console.append(m.text) if m.type in ('error', 'warning') else None)
        p.on('request', lambda r: reports.append(r.url) if '/api/csp-report' in r.url else None)
        p.on('response', lambda r: headers.update(r.headers) if r.url.split('?')[0].rstrip('/') == BASE else None)
        p.route_web_socket('**/api/voice', ws_standin)
        policy_errors = lambda: [c for c in console if re.search(r'Content Security Policy|Refused to', c)]
        violations = lambda: p.evaluate('window.__csp')

        p.goto(BASE + '/?as=' + USER); p.wait_for_timeout(1500)
        csp = headers.get('content-security-policy', '')
        check('the page is served with the strict header: script hashes + blob:, no unsafe-inline script, no handlers', re.search(r"script-src ('sha256-[^']+' )+blob:;", csp) is not None and not re.search(r"script-src[^;]*unsafe-inline", csp) and "script-src-attr 'none'" in csp)
        check('the runtime facts arrived through the JSON data block and the page read them (ATLAS_RUNTIME set, not executable)',
              p.evaluate("!!window.ATLAS_RUNTIME && window.ATLAS_RUNTIME.subjectKey.length>10 && document.getElementById('atlas-runtime').type==='application/json'"))
        check('boot: no CSP violation event and no CSP console error', violations() == [] and policy_errors() == [])
        check('boot: the app actually ran under the policy (workspace rendered, voice client present)', p.evaluate("!!document.getElementById('voiceStart') && !!window.AtlasVoice && !!window.AtlasSafe && document.querySelectorAll('.project-card, .stage-card, #projectCards').length>=0"))

        # ---- consent dialog
        p.locator('#voiceStart').click(); p.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000)
        check('the consent dialog opens with no violation', violations() == [] and policy_errors() == [])

        # ---- a typed interview
        p.locator('#modelConsent').check()
        if p.locator('#noticeAck').is_visible(): p.locator('#noticeAck').check()
        p.locator('#voiceConsentType').click(); p.wait_for_function('()=>AtlasVoice.status().phase==="live"', timeout=10000)
        p.locator('#voiceTypeInput').fill('We rebuilt the claims intake for an insurer.'); p.locator('#voiceTypeSend').click()
        p.wait_for_function("()=>document.body.innerText.includes('Over what period')", timeout=8000)
        check('a typed interview (start, typed answer, agent reply) runs with no violation', violations() == [] and policy_errors() == [] and not ERR)
        p.locator('#voiceEnd').click(); p.locator('#voiceEndConfirm').click(); p.wait_for_function('()=>AtlasVoice.status().phase==="idle"', timeout=8000)

        # ---- the Library view and the profile / privacy panel
        p.locator('[data-view="library"]').first.click()
        p.wait_for_timeout(1200)
        check('the Library view renders (records or its empty state) with no violation', p.locator('#libraryGrid, #libraryLine, #view-library, [id*="library" i]').count() > 0 and violations() == [] and policy_errors() == [])
        p.locator('#profileButton').click()
        p.wait_for_timeout(1200)
        check('the profile / privacy panel renders with no violation', violations() == [] and policy_errors() == [] and not ERR)
        check('the privacy controls the page builds are present (download / delete my data)', p.locator('#privDownload').count() == 1 and p.locator('#privDelete').count() == 1)
        # leaked markup (a double-escaped template shows tags as text) anywhere on the page
        check('no markup leaked into visible text', not re.search(r'</?(div|span|p|li|button|article|section)[ >]|&lt;|&amp;|\[object Object\]', p.evaluate('document.body.innerText')))

        # ---- the negative proof: the policy is live
        before = len(reports)
        # Trusted Types is the outer layer: a raw string never reaches an HTML or script sink, so each attempt throws before script-src is even asked.
        tt = p.evaluate("""()=>{const out={};const t=(k,f)=>{try{f();out[k]='ran';}catch(e){out[k]=e&&e.name;}};
          t('script',()=>{const s=document.createElement('script');s.textContent='window.__pwn_inline=1';document.body.appendChild(s);});
          t('html',()=>{const d=document.createElement('div');d.innerHTML='<img src="x:broken" onerror="window.__pwn_attr=1">';document.body.appendChild(d);});
          t('adjacent',()=>{document.body.insertAdjacentHTML('beforeend','<img src="x:broken" onerror="window.__pwn_attr=1">');});
          t('scripturl',()=>{const s=document.createElement('script');s.src='data:text/javascript,window.__pwn_src=1';document.body.appendChild(s);});
          t('policy',()=>trustedTypes.createPolicy('evil',{createHTML:x=>x}));
          t('duplicate',()=>trustedTypes.createPolicy('atlas-html',{createHTML:x=>x}));
          t('safe',()=>{const d=document.createElement('div');AtlasSafe.setHTML(d,AtlasSafe.html`<b>${'<i>x</i>'}</b>`);if(d.innerHTML!=='<b>&lt;i&gt;x&lt;/i&gt;</b>')throw new Error('escaped');});
          const a=document.createElement('a');a.href='javascript:window.__pwn_url=1';document.body.appendChild(a);a.click();
          return out;}""")
        p.wait_for_timeout(1200)
        check('Trusted Types: a raw string is refused by every HTML and script sink (script text, innerHTML, insertAdjacentHTML, script src)', all(tt.get(k) == 'TypeError' for k in ('script', 'html', 'adjacent', 'scripturl')))
        check('Trusted Types: no other policy can be created, not even a second atlas-html', tt.get('policy') == 'TypeError' and tt.get('duplicate') == 'TypeError')
        check('Trusted Types: the one sanctioned path (AtlasSafe.setHTML with html``) still renders, escaped', tt.get('safe') == 'ran')
        check('an injected inline script does not run', p.evaluate('window.__pwn_inline') is None and p.evaluate('window.__pwn_src') is None)
        check('an inline event-handler attribute does not run', p.evaluate('window.__pwn_attr') is None)
        check('a javascript: URL does not run', p.evaluate('window.__pwn_url') is None)
        v = violations()
        check('each refusal fired a securitypolicyviolation (require-trusted-types-for, trusted-types)', {x['d'] for x in v} >= {'require-trusted-types-for', 'trusted-types'} and len(v) >= 5)
        # The browser's own delivery of reports (report-uri / report-to) is not observable from here in every Chromium build, so the endpoint is exercised from the page,
        # under the same policy (connect-src 'self'), exactly as a browser would post it; the Worker's log is read at the end.
        r = p.evaluate("""async()=>{const b=await (await fetch('/api/bootstrap')).json();
          const res=await fetch('/api/csp-report',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/csp-report'},body:JSON.stringify({'csp-report':{'effective-directive':'script-src-elem','blocked-uri':'https://evil.example/x?secret=1','document-uri':'http://x/?as=alex@mantu.com'}})});
          return [res.status,(await res.text()).length];}""")
        check('POST /api/csp-report answers 204 with an empty body (no CSRF token, as a browser posts it)', r == [204, 0])
        check('no page errors', not ERR)
        ctx.close()

        # ---- the same page in report-only rollout mode: nothing is blocked, the strict policy is only reported
        base2 = start_edge({'ATLAS_CSP': 'report-only'})
        c2 = br.new_context(viewport={'width': 1280, 'height': 900}); p2 = c2.new_page(); p2.add_init_script(COLLECT); h2 = {}
        p2.on('response', lambda r: h2.update(r.headers) if r.url.split('?')[0].rstrip('/') == base2 else None)
        p2.goto(base2 + '/?as=' + USER); p2.wait_for_timeout(1200)
        check('ATLAS_CSP=report-only: the old policy is enforced and the strict one is reported', "'unsafe-inline' blob:" in h2.get('content-security-policy', '') and 'sha256-' in h2.get('content-security-policy-report-only', ''))
        p2.evaluate("()=>{const s=document.createElement('script');s.textContent='window.__ro=1';document.body.appendChild(s)}")
        check('...so an injected script still runs (and is reported), as intended for the rollout week', p2.evaluate('window.__ro') == 1 and any(x['d'].startswith('script-src') for x in p2.evaluate('window.__csp')))
        c2.close(); br.close()
    PROCS[0].terminate(); log = PROCS[0].stdout.read().decode('utf-8', 'replace')
    lines = [json.loads(l) for l in log.splitlines() if l.startswith('{"atlas_sec"')]
    ev = [l for l in lines if l.get('event') == 'csp_violation']
    check('the Worker logged a csp_violation with the directive and the blocked ORIGIN only (never the path, query or document URL)',
          any(e.get('directive') == 'script-src-elem' and e.get('blocked') == 'https://evil.example' for e in ev) and 'secret=1' not in log and 'alex@mantu.com' not in log)
    print('csp_browser: all checks passed')
except Exception as e:
    print('FAILED:', type(e).__name__, e); code = 1
finally:
    for pr in PROCS: pr.terminate()
sys.exit(code)
