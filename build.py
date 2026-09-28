"""Rebuild the self-contained browser client. No frontend dependencies or external assets."""
from pathlib import Path
import base64, json, hashlib
ROOT=Path(__file__).resolve().parent
logo_bytes=(ROOT/'assets/Mantu.svg').read_bytes()
logo='data:image/svg+xml;base64,'+base64.b64encode(logo_bytes).decode()
slots={'__CSS__':(ROOT/'src/styles.css').read_text()+'\n'+(ROOT/'src/voice.css').read_text()+'\n'+(ROOT/'src/orb.css').read_text()+'\n'+(ROOT/'src/sculpture.css').read_text()+'\n'+(ROOT/'src/intelligence.css').read_text(),
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
 '__VOICE_CLIENT__':(ROOT/'src/voice-client.js').read_text()}
text=(ROOT/'src/shell.html').read_text()
for k,v in slots.items():text=text.replace(k,v)
text=text.replace('<title>ATLAS Presence / Mantu — A rhythm you recognize</title>','<title>ATLAS Voice Studio / Mantu</title>')
text=text.replace('<title>ATLAS Voice Studio / Mantu</title>','<title>ATLAS Intelligence / Mantu — Quality before storytelling</title>')
text=text.replace('<title>ATLAS Intelligence / Mantu — Quality before storytelling</title>','<title>ATLAS Project Intelligence / Mantu</title>')
(ROOT/'ATLAS_Project_Intelligence.html').write_text(text)
(ROOT/'ATLAS_Intelligence.html').write_text(text)
(ROOT/'ATLAS_Voice_Studio.html').write_text(text)
(ROOT/'ATLAS_Voice.html').write_text(text)
print('Built',len(text.encode()),'bytes; original logo SHA256:',hashlib.sha256(logo_bytes).hexdigest())
