"""Rebuild the self-contained browser client. No frontend dependencies or external assets."""
from pathlib import Path
import base64, json, hashlib, os, re, subprocess, sys
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
from atlas_voice.quality import NUMERIC, FIELDS, TO_TOPIC  # stdlib only: the ledger's field labels and number rule, one source
def read_text(path):
    return path.read_text(encoding='utf-8')
def write_text(path, text):
    path.write_bytes(text.encode('utf-8'))
logo_bytes=(ROOT/'assets/Mantu.svg').read_bytes()
# The live ATLAS address baked into every copy (WOW_ZERO_CONFIG §3.10): an offline copy opens it with one link. It is public and
# grants nothing (the target is behind Access). ATLAS_HOME_URL overrides the wrangler.jsonc ORIGIN; anything invalid gives ''.
def atlas_home(environ=os.environ):
    if 'ATLAS_HOME_URL' in environ:
        value = environ['ATLAS_HOME_URL'].strip()
    else:
        try:
            text = read_text(ROOT/'deploy/cloudflare-edge/wrangler.jsonc')
            value = json.loads('\n'.join(l for l in text.splitlines() if not l.strip().startswith('//')))['vars']['ORIGIN']
        except Exception:
            value = ''
    return value if isinstance(value, str) and re.fullmatch(r'https://[a-z0-9.-]+', value) else ''
ATLAS_HOME=atlas_home()
logo='data:image/svg+xml;base64,'+base64.b64encode(logo_bytes).decode()
slots={'__CSS__':read_text(ROOT/'src/styles.css')+'\n'+read_text(ROOT/'src/voice.css')+'\n'+read_text(ROOT/'src/orb.css')+'\n'+read_text(ROOT/'src/sculpture.css')+'\n'+read_text(ROOT/'src/intelligence.css')+'\n'+read_text(ROOT/'src/charts.css')+'\n'+read_text(ROOT/'src/wow.css')+'\n'+read_text(ROOT/'src/storyboard.css')+'\n'+read_text(ROOT/'src/journey.css'),
 '__LOGO__':logo,'__LOGOJSON__':json.dumps(logo), '__ARCH__':read_text(ROOT/'docs/architecture.svg'),
 '__INTELLIGENCE_PANEL__':read_text(ROOT/'src/intelligence-panel.html'),
 '__INTELLIGENCE_CORE__':read_text(ROOT/'src/intelligence-core.js'),
 '__INTELLIGENCE_UI__':read_text(ROOT/'src/intelligence-ui.js'),
 '__ENGINE__':read_text(ROOT/'src/engine.js'),
'__PPTX__':read_text(ROOT/'src/pptx.js'),
'__DOCX__':read_text(ROOT/'src/docx.js'),
'__OFFICE__':read_text(ROOT/'src/office.js'),
 '__APP__':'window.ATLAS_BRIEF='+json.dumps(read_text(ROOT/'docs/BUILD_NOTES.md')).replace('</','<\\/')+';\n'+read_text(ROOT/'src/app.js'),
 '__VOICE_PANEL__':read_text(ROOT/'src/voice-panel.html'),
 '__STUDIO_CONNECTION__':read_text(ROOT/'src/studio-connection.js'),
 '__STUDIO_CORE__':read_text(ROOT/'src/studio-core.js'),
 '__ORB_RENDERER__':read_text(ROOT/'src/orb-renderer.js'),
 '__ORB_UI__':read_text(ROOT/'src/orb-ui.js')+'\n'+read_text(ROOT/'src/studio-panels.js'),
 '__WORKLET__':read_text(ROOT/'src/voice-worklet.js'),
 '__VOICE_CLIENT__':read_text(ROOT/'src/voice-client.js'),
 # Project-at-a-glance charts: the world map is pre-projected at build time (scripts/build_world_map.py), no runtime geo library.
 '__WORLD__':json.dumps(json.loads(read_text(ROOT/'assets/geo/world-110m.json')),separators=(',',':'),ensure_ascii=False).replace('</','<\\/'),
 '__GEO__':read_text(ROOT/'src/geo.js'),
 '__CHARTS__':read_text(ROOT/'src/charts.js'),
 # Bid proof, Ask ATLAS, trust and capture (T4) and the live story board (T5). Replaced last, so nothing inside them is re-expanded.
 '__POLICY__':'window.ATLAS_POLICY='+json.dumps({'NUMERIC_SRC':NUMERIC.pattern,'FIELDS':FIELDS,'TO_TOPIC':TO_TOPIC}).replace('</','<\\/'),
 '__BIDS_CORE__':read_text(ROOT/'src/bids-core.js'),
 '__WOW_UI__':'\n'.join(read_text(ROOT/'src'/n) for n in ('bids-ui.js','ask-ui.js','trust-ui.js')),
 '__BOARD_CORE__':read_text(ROOT/'src/storyboard-core.js'),
 '__BOARD_UI__':read_text(ROOT/'src/storyboard-ui.js'),
 # Zero-setup start and the profile (WOW_ZERO_CONFIG): the live address, the auth helper and the profile. Replaced last.
 '__ATLAS_HOME__':'<script>window.ATLAS_HOME='+json.dumps(ATLAS_HOME)+';</script>',
 '__SESSION_KEEPER__':read_text(ROOT/'src/session-keeper.js'),
 '__PROFILE_CORE__':read_text(ROOT/'src/profile-core.js'),
 '__PROFILE_UI__':read_text(ROOT/'src/profile-ui.js'),
 # The admin view machine is plain functions. Export keywords are for the node tests; the page is a classic script.
 '__JOURNEY__':read_text(ROOT/'src/admin-metrics-machine.js').replace('export ','')+'\n'+read_text(ROOT/'src/journey-ui.js')}
def executable_scripts(html):
    out=[]
    for attrs,body in re.findall(r'<script\b([^>]*)>([\s\S]*?)</script>', html, re.I):
        found=re.search(r'''\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))''', attrs, re.I)
        kind=((found.group(1) or found.group(2) or found.group(3) or '') if found else '').lower()
        if kind not in ('', 'text/javascript', 'application/javascript', 'module'): continue
        out.append(body)
    return out
def script_src(htmls):
    seen,hashes=set(),[]
    for html in htmls:
        for body in executable_scripts(html):
            token="'sha256-"+base64.b64encode(hashlib.sha256(body.encode('utf-8')).digest()).decode('ascii')+"'"
            if token not in seen:
                seen.add(token); hashes.append(token)
    return ' '.join(hashes)
def edge_documents():
    src=ROOT/'deploy/cloudflare-edge/src'
    if not (src/'confirm-page.js').is_file() or not (src/'signed-in-page.js').is_file(): return []
    r=subprocess.run(['node','--input-type=module','-e',
        "import { CONFIRM_HTML } from './deploy/cloudflare-edge/src/confirm-page.js';"
        "import { SIGNED_IN_HTML } from './deploy/cloudflare-edge/src/signed-in-page.js';"
        "process.stdout.write(JSON.stringify([CONFIRM_HTML, SIGNED_IN_HTML]));"],
        cwd=ROOT, check=True, capture_output=True, text=True)
    docs=json.loads(r.stdout)
    if len(docs)!=2: raise SystemExit('expected the confirm page and the signed-in page')
    return docs
text=read_text(ROOT/'src/shell.html')
for k,v in slots.items():text=text.replace(k,v)
if '__CSP_SCRIPT_SRC__' not in text: raise SystemExit('shell is missing __CSP_SCRIPT_SRC__')
page_src=script_src([text])
if 'sha256-' not in page_src: raise SystemExit('page script hashes are empty')
text=text.replace('__CSP_SCRIPT_SRC__', page_src, 1)
edge_src=ROOT/'deploy/cloudflare-edge/src'
if (edge_src/'confirm-page.js').is_file():
    header=script_src([text, *edge_documents()])
    if 'sha256-' not in header: raise SystemExit('edge script hashes are empty')
    write_text(edge_src/'page-script-hashes.js',
        '// Generated by build.py from the built page, the confirm page and the signed-in page. Do not edit.\n'
        'export const PAGE_SCRIPT_SRC = '+json.dumps(header)+';\n')
text=text.replace('<title>ATLAS Presence / Mantu — A rhythm you recognize</title>','<title>ATLAS Voice Studio / Mantu</title>')
text=text.replace('<title>ATLAS Voice Studio / Mantu</title>','<title>ATLAS Intelligence / Mantu — Quality before storytelling</title>')
text=text.replace('<title>ATLAS Intelligence / Mantu — Quality before storytelling</title>','<title>ATLAS Project Intelligence / Mantu</title>')
write_text(ROOT/'ATLAS_Project_Intelligence.html', text)
write_text(ROOT/'ATLAS_Intelligence.html', text)
write_text(ROOT/'ATLAS_Voice_Studio.html', text)
write_text(ROOT/'ATLAS_Voice.html', text)
print('Built',len(text.encode()),'bytes; ATLAS_HOME:',ATLAS_HOME or '(none)','; original logo SHA256:',hashlib.sha256(logo_bytes).hexdigest())
