"""Rebuild the self-contained browser client. No frontend dependencies or external assets."""
from pathlib import Path
import base64, json, hashlib, os, re, sys
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
from atlas_voice.quality import NUMERIC, FIELDS, TO_TOPIC  # stdlib only: the ledger's field labels and number rule, one source
from atlas_voice.csp import RUNTIME_BLOCK, script_hashes, script_src  # the strict script CSP: one hash per inline script (v2.2 F1)
logo_bytes=(ROOT/'assets/Mantu.svg').read_bytes()
# The live ATLAS address baked into every copy (WOW_ZERO_CONFIG §3.10): an offline copy opens it with one link. It is public and
# grants nothing (the target is behind Access). ATLAS_HOME_URL overrides the wrangler.jsonc ORIGIN; anything invalid gives ''.
def atlas_home(environ=os.environ):
    if 'ATLAS_HOME_URL' in environ:
        value = environ['ATLAS_HOME_URL'].strip()
    else:
        try:
            text = (ROOT/'deploy/cloudflare-edge/wrangler.jsonc').read_text()
            value = json.loads('\n'.join(l for l in text.splitlines() if not l.strip().startswith('//')))['vars']['ORIGIN']
        except Exception:
            value = ''
    return value if isinstance(value, str) and re.fullmatch(r'https://[a-z0-9.-]+', value) else ''
ATLAS_HOME=atlas_home()
logo='data:image/svg+xml;base64,'+base64.b64encode(logo_bytes).decode()
slots={'__CSS__':(ROOT/'src/styles.css').read_text()+'\n'+(ROOT/'src/voice.css').read_text()+'\n'+(ROOT/'src/orb.css').read_text()+'\n'+(ROOT/'src/sculpture.css').read_text()+'\n'+(ROOT/'src/intelligence.css').read_text()+'\n'+(ROOT/'src/charts.css').read_text()+'\n'+(ROOT/'src/wow.css').read_text()+'\n'+(ROOT/'src/storyboard.css').read_text()+'\n'+(ROOT/'src/workflow.css').read_text()+'\n'+(ROOT/'src/ui.css').read_text(),
 '__SAFE_HTML__':(ROOT/'src/safe-html.js').read_text(),'__RUNTIME__':(ROOT/'src/runtime.js').read_text(),
 '__LOGO__':logo,'__LOGOJSON__':json.dumps(logo),'__ARCH__':(ROOT/'docs/architecture.svg').read_text(),
 '__INTELLIGENCE_PANEL__':(ROOT/'src/intelligence-panel.html').read_text(),
 '__INTELLIGENCE_CORE__':(ROOT/'src/intelligence-core.js').read_text(),
 '__INTELLIGENCE_UI__':(ROOT/'src/intelligence-ui.js').read_text(),
 '__ENGINE__':(ROOT/'src/engine.js').read_text(),
'__PPTX__':(ROOT/'src/pptx.js').read_text(),
'__DOCX__':(ROOT/'src/docx.js').read_text(),
'__OFFICE__':(ROOT/'src/office.js').read_text(),
 '__APP__':'window.ATLAS_BRIEF='+json.dumps((ROOT/'docs/BUILD_NOTES.md').read_text()).replace('</','<\\/')+';\n'+(ROOT/'src/app.js').read_text(),
 '__VOICE_PANEL__':(ROOT/'src/voice-panel.html').read_text(),
 '__STUDIO_CONNECTION__':(ROOT/'src/studio-connection.js').read_text(),
 '__STUDIO_CORE__':(ROOT/'src/studio-core.js').read_text(),
 '__ORB_RENDERER__':(ROOT/'src/orb-renderer.js').read_text(),
 '__ORB_UI__':(ROOT/'src/orb-ui.js').read_text()+'\n'+(ROOT/'src/studio-panels.js').read_text(),
 '__WORKLET__':(ROOT/'src/voice-worklet.js').read_text(),
 '__VOICE_CONTROLS__':(ROOT/'src/voice-controls.js').read_text(),
 '__VOICE_CLIENT__':(ROOT/'src/voice-client.js').read_text(),
 # Project-at-a-glance charts: the world map is pre-projected at build time (scripts/build_world_map.py), no runtime geo library.
 '__WORLD__':json.dumps(json.loads((ROOT/'assets/geo/world-110m.json').read_text()),separators=(',',':'),ensure_ascii=False).replace('</','<\\/'),
 '__GEO__':(ROOT/'src/geo.js').read_text(),
 '__CHARTS__':(ROOT/'src/charts.js').read_text(),
 # Bid proof, Ask ATLAS, trust and capture (T4) and the live story board (T5). Replaced last, so nothing inside them is re-expanded.
 '__POLICY__':'window.ATLAS_POLICY='+json.dumps({'NUMERIC_SRC':NUMERIC.pattern,'FIELDS':FIELDS,'TO_TOPIC':TO_TOPIC}).replace('</','<\\/'),
 '__BIDS_CORE__':(ROOT/'src/bids-core.js').read_text(),
 '__WOW_UI__':'\n'.join((ROOT/'src'/n).read_text() for n in ('bids-ui.js','ask-ui.js','trust-ui.js')),
 '__BOARD_CORE__':(ROOT/'src/storyboard-core.js').read_text(),
 '__BOARD_UI__':(ROOT/'src/storyboard-ui.js').read_text(),
 # Zero-setup start and the profile (WOW_ZERO_CONFIG): the live address, the auth helper and the profile. Replaced last.
 '__ATLAS_HOME__':'<script>window.ATLAS_HOME='+json.dumps(ATLAS_HOME)+';</script>',
 '__SESSION_KEEPER__':(ROOT/'src/session-keeper.js').read_text(),
 '__PROFILE_CORE__':(ROOT/'src/profile-core.js').read_text(),
 '__PROFILE_UI__':(ROOT/'src/profile-ui.js').read_text(),
 # Evidence workflow status cards (T15): the pure card model and the Reference-library panel. Replaced last.
 '__WORKFLOW_CORE__':(ROOT/'src/workflow-core.js').read_text(),
 '__WORKFLOW_UI__':(ROOT/'src/workflow-ui.js').read_text()}
text=(ROOT/'src/shell.html').read_text()
for k,v in slots.items():text=text.replace(k,v)
text=text.replace('<title>ATLAS Presence / Mantu — A rhythm you recognize</title>','<title>ATLAS Voice Studio / Mantu</title>')
text=text.replace('<title>ATLAS Voice Studio / Mantu</title>','<title>ATLAS Intelligence / Mantu — Quality before storytelling</title>')
text=text.replace('<title>ATLAS Intelligence / Mantu — Quality before storytelling</title>','<title>ATLAS Project Intelligence / Mantu</title>')
# Strict CSP (v2.2 F1): every executable inline script is static, so the page's own <meta> policy and the servers' headers allow exactly
# its SHA-256 hashes. The hash list also goes to the edge Worker as a generated module (never edit it; the freshness test recomputes it).
assert text.count(RUNTIME_BLOCK)==1,'the runtime data block must appear exactly once'
HASHES=script_hashes(text)
text=text.replace('__CSP_SCRIPT_SRC__',script_src(HASHES))
CSP_JS=ROOT/'deploy/cloudflare-edge/src/csp.generated.js';CSP_JS.parent.mkdir(parents=True,exist_ok=True)
CSP_JS.write_text('// GENERATED by build.py from the built page. Do not edit; run python3 build.py instead.\n'
 '// Every executable inline <script> of the page, as CSP hash tokens (no quotes). The runtime data block is JSON, not code, so it has none.\n'
 'export const PAGE_SCRIPT_HASHES = '+json.dumps(HASHES,indent=2)+';\n'
 'export const RUNTIME_BLOCK = '+json.dumps(RUNTIME_BLOCK)+';\n')
(ROOT/'ATLAS_Project_Intelligence.html').write_text(text)
(ROOT/'ATLAS_Intelligence.html').write_text(text)
(ROOT/'ATLAS_Voice_Studio.html').write_text(text)
(ROOT/'ATLAS_Voice.html').write_text(text)
print('Built',len(text.encode()),'bytes; ATLAS_HOME:',ATLAS_HOME or '(none)','; original logo SHA256:',hashlib.sha256(logo_bytes).hexdigest())
