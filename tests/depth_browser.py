"""v12 browser/editor tests with an explicit fake API. No real provider calls."""
import json,os,shutil
from pathlib import Path
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[1];HTML=(R/'ATLAS_Project_Intelligence.html').read_text();checks=[];errors=[]
def check(n,v):
 checks.append({'name':n,'passed':bool(v)});print(('PASS ' if v else 'FAIL ')+n,flush=True)
 if not v:raise AssertionError(n)
with sync_playwright() as pw:
 b=pw.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH') or shutil.which('chromium'),args=['--no-sandbox']);p=b.new_page(viewport={'width':1440,'height':1000},accept_downloads=True);p.set_default_timeout(5000);p.on('pageerror',lambda e:errors.append(str(e)))
 try:
  # API adapters are visible in test source, not bundled in the application.
  html=HTML.replace("if(!['http:','https:'].includes(location.protocol))","if(false)")
  p.set_content(html,wait_until='load');p.wait_for_timeout(250)
  p.locator('[data-intelligence=quality]').click();p.locator('#qualityAssessment').click()
  check('Assessment question does not assume production benefit','decision did the assessment enable' in p.locator('#qualityLabResult').inner_text())
  p.locator('#qualityUnknown').click();check('No measurement remains legitimate','unknown explicit' in p.locator('#qualityLabResult').inner_text())
  p.locator('#qualityInput').fill('I cannot share the confidential report under NDA.');p.locator('#qualityAnalyze').click()
  check('Confidentiality elicits authorized non-identifying context','non-identifying mechanism' in p.locator('#qualityLabResult').inner_text())
  p.locator('[data-intel-tab=wiki]').click();p.locator('.editor-fold>summary').click();p.locator('#editorRefine').click()
  check('Editor refuses unsaved candidate','Save a restricted' in p.locator('#editorMessage').inner_text())
  p.locator('#intelligenceDialog [data-close]').click();p.locator('.studio-left [data-action=new-project]').click()
  for k,v in {'projectTitle':'SYNTHETIC editor test','consultantName':'Test Author','consultantRole':'Engineer','sectorInput':'Operations'}.items():p.locator('#'+k).fill(v)
  p.locator('#projectForm button[type=submit]').click();p.locator('[data-intelligence=wiki]').click();p.locator('#wikiCurrent').click()
  p.evaluate("""window.__fake={calls:[],story:null};
  AtlasVoice.bootstrap=()=>({csrf:'FIXTURE'});
  window.fetch=async(url,opt={})=>{const d=opt.body?JSON.parse(opt.body):{};__fake.calls.push({url,body:d});
    let out;
    if(url==='/api/wiki'){__fake.story=structuredClone(d.story);out={...d.story,id:'fixture',revision:1,content_hash:'same-hash'};}
    else if(url==='/api/wiki/fixture/refine'){out={candidate:{...structuredClone(__fake.story),title:'Controlled handover pilot'},citations:[{section:'challenge',refs:['account:challenge']}],open_questions:['Which reviewer owns the evidence?']};}
    else if(url==='/api/wiki/rank'){out={rankings:[],no_strong_match:true,notice:'No authorized reviewed customer stories.'};}
    else throw Error('Unexpected test API path');
    return {ok:true,json:async()=>out,text:async()=>JSON.stringify(out)};
  };void 0;""")
  p.locator('#wikiConsent').check();p.locator('#wikiSave').click();check('Explicit save reaches API adapter',p.evaluate("__fake.calls.length===1 && __fake.calls[0].url==='/api/wiki'"))
  p.locator('#editorObjective').fill('Explain the handover decision and its transfer conditions.');p.locator('#editorRefine').click()
  check('External editing requires separate consent','authorize the exact' in p.locator('#editorMessage').inner_text())
  p.locator('#wikiTitle').fill('Unsaved variation');p.locator('#editorConsent').check();p.locator('#editorRefine').click()
  check('Editor cannot refine a stale saved version','Unsaved changes exist' in p.locator('#editorMessage').inner_text())
  p.locator('#wikiTitle').fill('SYNTHETIC editor test');p.locator('#editorRefine').click();p.wait_for_timeout(50)
  check('Structured suggestion is shown for review',p.locator('#editorResult').is_visible() and 'Controlled handover' in p.locator('#editorPreview').inner_text())
  check('Suggestion does not overwrite current title',p.locator('#wikiTitle').input_value()=='SYNTHETIC editor test')
  p.locator('#editorApply').click();check('Applying requires human acknowledgment','Inspect and confirm' in p.locator('#editorMessage').inner_text())
  p.locator('#editorAccept').check();p.locator('#editorApply').click()
  check('Accepted suggestion becomes editable draft',p.locator('#wikiTitle').input_value()=='Controlled handover pilot')
  check('Applying neither saves nor approves remotely',p.evaluate('__fake.calls.length===2') and 'not saved or approved' in p.locator('#editorMessage').inner_text())
  p.locator('[data-intel-tab=memory]').click();p.locator('#continuityPrepare').click()
  text=p.locator('#continuityText').input_value();check('Resume note excludes client name and full transcript','Resume pointer: local project' in text and 'SYNTHETIC editor test' not in text)
  check('Resume preparation makes no API call',p.evaluate('__fake.calls.length===2') and not p.locator('#continuityConsent').is_checked())
  p.locator('#intelligenceDialog [data-close]').click()
  p.evaluate("""window.dispatchEvent(new CustomEvent('atlas-quality',{detail:{type:'quality',candidate_details:[],missing:['measurement','poor_fit'],flags:['Numerical basis unresolved'],deferred_fields:{measurement:'Clarification budget reached'},next_question:'Where would this approach not work?'}}));""")
  check('Deferred gap visible without quality inflation','Deferred: measurement' in p.locator('#qualityOpen').inner_text())
  for w in (320,390,768,1366):
   p.set_viewport_size({'width':w,'height':900});p.locator('[data-intelligence=wiki]').click();p.wait_for_timeout(90)
   check(f'Editor responsive at {w}',p.evaluate("document.getElementById('intelligenceDialog').scrollWidth<=document.getElementById('intelligenceDialog').clientWidth+1"))
   p.locator('#intelligenceDialog [data-close]').click()
  check('No JavaScript errors',not errors)
 finally:
  (R/'tests/depth-browser-results.json').write_text(json.dumps({'scope':'Actual Chromium DOM and rendering; hosted API explicitly replaced with fixtures; no model or real identity.', 'checks':checks,'errors':errors},indent=2));b.close()
print(len(checks),'checks passed')
