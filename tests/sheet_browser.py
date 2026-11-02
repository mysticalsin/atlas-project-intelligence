"""Project reference sheet (Amaris/Mantu template) end to end in a real browser against the local edge with stand-in
models: Opp ID asked first, PowerPoint source with a suggested visual, draft + grouped challenges, improve with answers,
Part 1 consultant-name rule, entity file naming, mandatory confirmation, and the generated .docx checked with
python-docx (Calibri on every run, title, 5 labelled summary fields, one 8x2 table with a 3 cm label column, visual).
  python3 tests/sheet_browser.py
"""
import os,socket,subprocess,time,urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];EDGE=ROOT/'deploy/cloudflare-edge';ERR=[]
def check(n,v):print(('PASS ' if v else 'FAIL ')+n);assert v,n
s=socket.socket();s.bind(('127.0.0.1',0));PORT=s.getsockname()[1];s.close();BASE=f'http://127.0.0.1:{PORT}'
srv=subprocess.Popen(['node','--no-warnings','dev/local-edge.mjs',str(PORT)],cwd=EDGE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
for _ in range(100):
 try:urllib.request.urlopen(BASE+'/__settle',timeout=1);break
 except Exception:time.sleep(.1)
try:
 with sync_playwright() as pw:
  b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
  c=b.new_context(viewport={'width':1300,'height':1000},accept_downloads=True);p=c.new_page();p.on('pageerror',lambda e:ERR.append(str(e)));p.goto(BASE+'/?as=alex@mantu.com');p.wait_for_timeout(700)
  p.locator('[data-action=new-project]:visible').first.click();p.wait_for_timeout(200)
  p.evaluate("document.getElementById('projectMore').open=true") # W1: these fields live under "More details"
  for k,v in {'projectTitle':'Claims triage','consultantName':'Alex Martin','sectorInput':'Insurance','clientName':'Zebracorp'}.items():p.locator('#'+k).fill(v)
  p.locator('#projectForm button[type=submit]').click();p.wait_for_timeout(300)
  p.locator('header [data-view=projects]').click();p.wait_for_timeout(400)
  p.locator('[data-sheet]').first.click();p.wait_for_timeout(400)
  check('the wizard opens on the Opp ID, before anything else',p.locator('[data-sheet-step="1"]').is_visible() and 'opportunity ID' in p.locator('[data-sheet-step="1"]').inner_text())
  p.locator('#sheetStep1Next').click();p.wait_for_timeout(200)
  check('cannot continue without an Opp ID',p.locator('[data-sheet-step="1"]').is_visible())
  p.locator('#sheetOpp').fill('00123');p.locator('#sheetStep1Next').click();p.wait_for_timeout(200)
  check('sources step after the Opp ID',p.locator('[data-sheet-step="2"]').is_visible())
  p.locator('#sheetFile').set_input_files(str(ROOT/'tests/fixtures/sample.pptx'))
  p.locator('#sheetPaste').fill('Claims triage rollout. The insurer had slow triage across three teams. We rebuilt routing with 5 consultants in Lyon over 6 months.')
  p.locator('#sheetDraft').click();p.wait_for_timeout(2500)
  check('draft done: challenge step with grouped questions',p.locator('[data-sheet-step="3"]').is_visible() and 'Results and ROI' in p.locator('#sheetChallenges').inner_text())
  check('fields filled from the sources, gaps marked "To be completed"',p.locator('#sf_duration').input_value()=='6 months' and p.locator('#sf_methodology').evaluate('e=>e.classList.contains("tbd")') and 'from document' in p.locator('#sheetFields').inner_text())
  p.locator('[data-sheet-answer="0"]').fill('Triage time fell from 40 to 12 minutes against the prior quarter.');p.locator('#sheetImprove').click();p.wait_for_timeout(1500)
  check('improve with answers fills the ROI section',p.locator('#sf_value').input_value().startswith('Triage time fell from 40 to 12 minutes'))
  p.locator('#sf_teamSize').fill('Alex Martin and 4 consultants in Lyon');p.wait_for_timeout(400)
  p.locator('[data-sheet-go="4"]').first.click();p.wait_for_timeout(500)
  check('validation shows the full summary and a suggested approach visual','Detailed Information Sheet' in p.locator('#sheetPreview').inner_text() and p.locator('#sheetVisuals img').count()==1 and 'Project approach' in p.locator('[data-visual-caption="0"]').input_value())
  check('generate disabled before the country/entity and the confirmation',p.locator('#sheetGenerate').is_disabled())
  p.locator('input[name=sheetLoc][value=entity]').check();p.locator('#sheetEntity').select_option('HEMA');p.locator('#sheetEntityCountry').fill('France');p.wait_for_timeout(200)
  check('file name follows the entity rule',p.locator('#sheetFileName').inner_text()=='File: 00123 - HEMA France - Zebracorp - Claims triage.docx')
  check('still disabled until the whole selection is confirmed',p.locator('#sheetGenerate').is_disabled())
  p.locator('#sheetConfirm').check();p.wait_for_timeout(200)
  with p.expect_download() as d:p.locator('#sheetGenerate').click()
  dl=d.value;path=dl.path()
  check('downloaded with the template file name',dl.suggested_filename=='00123 - HEMA France - Zebracorp - Claims triage.docx')
  from docx import Document
  doc=Document(path);runs=[r for q in doc.paragraphs for r in q.runs]+[r for t in doc.tables for row in t.rows for cell in row.cells for q in cell.paragraphs for r in q.runs]
  check('Calibri on every run',all(r.font.name=='Calibri' for r in runs if r.text))
  check('title heading first, then 5 labelled summary paragraphs',doc.paragraphs[0].text=='Claims triage' and [q.text.split(':')[0] for q in doc.paragraphs if q.runs and q.runs[0].bold and ':' in q.text]==['Summary','Team size','Project duration','Project price','Contacts'])
  t=doc.tables[0];check('one table, 8 rows x 2 columns, 3 cm label column',len(doc.tables)==1 and len(t.rows)==8 and len(t.columns)==2 and abs(t.columns[0].width.cm-3.0)<0.05)
  team=[q.text for q in doc.paragraphs if q.text.startswith('Team size')][0]
  check('no consultant name in Part 1 (replaced), price reads "To be completed"','Alex Martin' not in team and 'Project price: To be completed' in [q.text for q in doc.paragraphs])
  check('the approved visual is embedded with its caption',len(doc.inline_shapes)==1 and 'Project approach' in doc.paragraphs[-1].text)
  check('no page errors',not ERR);print(ERR)
finally:
 srv.terminate()
