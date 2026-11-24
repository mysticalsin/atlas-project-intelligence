"""A second save of the same interview notes must not append the paragraph again.
  python3 tests/story_append_browser.py
"""
import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
H = (ROOT / 'ATLAS_Voice.html').read_text()
BOOT = {'provider':'workers','providerLabel':'ATLAS voice','protocol':'atlas-personaplex-pcm-v1','csrf':'tok','identity':{'name':'tony@example.com','mode':'access','subjectKey':'k'},'model':'ATLAS conversational voice','admin':False,
 'voices':['atlas'],'defaultVoice':'atlas','captureRequired':False,'codecAvailable':True,'busy':False,'capacity':1,'maxSeconds':2700,'speakingSeconds':600,'memory':False,'wiki':False,'jev':False,'jevClassify':False,'transcription':True,'structuredNotes':True,'liveLedger':True,'playbackAck':True}
NOTE = 'I owned the routing design.'
def check(n, v):
    print(('PASS ' if v else 'FAIL ') + n)
    assert v, n
def route(r):
    u = r.request.url
    if u.endswith('/api/bootstrap'):
        return r.fulfill(json=BOOT)
    if u.rstrip('/') == 'https://atlas.test':
        return r.fulfill(body=H, content_type='text/html')
    r.fulfill(status=404, body='')
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
    page = browser.new_page()
    page.route('**/*', route)
    page.goto('https://atlas.test/')
    page.wait_for_timeout(600)
    result = page.evaluate("""(note) => {
      const b = window.ATLAS_VOICE_BRIDGE;
      const notes = [note, null, null, null, null, null];
      const first = b.autoSave(b.context(), notes, 'First words.', null);
      const second = b.autoSave(b.context(), notes, 'First words.', null);
      const added = b.autoSave(b.context(), ['A later addition.', null, null, null, null, null], 'Later words.', null);
      const answers = b.context().project.answers;
      return {first: first.projectId, second: second.projectId, added: added.projectId, answer: answers[0]};
    }""", NOTE)
    print('answers', json.dumps(result['answer']))
    check('second save keeps one copy of the same note', result['answer'] == NOTE + '\n\n' + 'A later addition.')
    check('both saves stay on the same project', result['first'] == result['second'] == result['added'])
    browser.close()
