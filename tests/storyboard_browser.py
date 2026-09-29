"""Live story board and proof answers (WOW_SPEC F5.3 items 1-9, F2.7 #6 browser side) in a real browser.
Harness (b): the built HTML through set_content on a routed https origin, driven only by synthetic 'atlas-session' and
'atlas-quality' events. No microphone, no model, no network: /api/bootstrap and /api/library/gaps/*/answer are mocked here.
  python3 build.py && python3 tests/storyboard_browser.py
"""
import json,os,re,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];HTML=(ROOT/'ATLAS_Voice.html').read_text();ERR=[];POSTS=[];OTHER=[]
RID='a'*32
BOOT={'provider':'workers','providerLabel':'ATLAS voice','csrf':'tok','identity':{'name':'alex@example.com','mode':'access','subjectKey':'k'},'library':True,'libraryRole':'user',
 'liveLedger':True,'captureRequired':True,'features':{'gapInterview':True},'memory':False,'jev':False,'jevClassify':False,'busy':False,'capacity':1,'maxSeconds':900}
WORDS=re.compile(r'\b(?:verified|confirmed|approved)\b',re.I)  # 'unverified' never matches
def route(r):
 u=r.request.url
 if u.rstrip('/')=='https://atlas.test':return r.fulfill(body='<!doctype html><title>t</title>',content_type='text/html')
 if u.endswith('/api/bootstrap'):return r.fulfill(json=BOOT)
 if re.search(r'/api/library/gaps/[^/]+/answer$',u):
  POSTS.append({'method':r.request.method,'url':u,'body':json.loads(r.request.post_data or 'null'),'csrf':r.request.headers.get('x-atlas-csrf')})
  return r.fulfill(json={'id':RID,'status':'answered'})
 OTHER.append(u);r.fulfill(status=404,json={'error':'Not found.'})
def check(n,v):print(('PASS ' if v else 'FAIL ')+n,flush=True);assert v,n
def D(i,field,quote,**k):return {'id':i,'field':field,'item_id':'user-1','quote':quote,'status':k.get('status','reported'),'active':True,'supersedes':k.get('supersedes',''),'provenance':'unverified_speech_recognition'}
DETAILS=[D('D-001','problem','Our claims queue in Portugal and Spain was slow, and the Lisbon queue was worse.'),
 D('D-002','outcome','Errors fell 40% and lead time went from 12 to 4 days.'),
 D('D-003','stakes','We cut costs by $3.5 million, and we saved €2 million later.'),
 D('D-004','intervention','We laid 1.5 m of cable. Chad said it was fine.'),
 D('D-005','measurement',"No baseline, I don't know.",status='unknown')]
QUALITY={'type':'quality','candidate_details':DETAILS,'deferred_fields':{'evidence':'Two clarification plans did not resolve this point'},
 'measurement_gaps':['before/after'],'flags':['Uncertainty must remain in the story','No verified measurement: preserve a qualitative account; do not repeat a demand for ROI'],
 'next_field':'measurement','next_question':'What were the before and after values for that measure?','planned_question':'What were the before and after values for that measure?',
 'story_route':'qualitative candidate','coverage':{'present':5,'total':12},'probe_history':[{'field':'problem','question':'Earlier plan','turn':'user-1','status':'planned_not_confirmed_spoken'}]}
READY={'type':'ready','mode':'full','maxSeconds':900,'liveLedger':True,'capture':True,'timePlan':{'depthAt':405,'closingAt':690}}
GAPS=[{'id':'G1','label':'Observed outcome','ask':'Proof the bid needs: a measured result for [company]'},{'id':'G2','label':'Supporting artifact','ask':'Proof the bid needs: a named source'}]
def q(p,d):p.evaluate("d=>dispatchEvent(new CustomEvent('atlas-quality',{detail:d}))",d)
def s(p,d):p.evaluate("d=>dispatchEvent(new CustomEvent('atlas-session',{detail:d}))",d)
def text(p,sel):return p.evaluate("s=>document.querySelector(s).innerText",sel)
chips=lambda p:p.evaluate("[...document.querySelectorAll('#boardMetrics .board-chip:not(.board-slot)')].map(e=>e.innerText.trim())")
anims="document.querySelector('#storyBoard').getAnimations({subtree:true}).length"
fits="(()=>{const w=innerWidth;return document.documentElement.scrollWidth<=w&&[...document.querySelectorAll('#storyBoard *,#gapPanel *')].filter(e=>e.getClientRects().length&&!e.closest('svg')).every(e=>e.getBoundingClientRect().right<=w+1)})()"
with sync_playwright() as pw:
 b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
 ctx=b.new_context(viewport={'width':1440,'height':1000});p=ctx.new_page();p.on('pageerror',lambda e:ERR.append(str(e)));p.route('**/*',route)
 p.goto('https://atlas.test/');p.set_content(HTML,wait_until='load');p.wait_for_timeout(400)
 check('Board is hidden before any interview',p.locator('#storyBoard').is_hidden() and p.locator('#gapPanel').is_hidden())
 check('Board model and policy are loaded',p.evaluate("typeof AtlasBoard.model==='function' && typeof ATLAS_POLICY.NUMERIC_SRC==='string'"))
 # ---- F5.3 #1: ready, then user_text, then quality
 s(p,READY);check('ready shows the board',p.locator('#storyBoard').is_visible())
 check('Full mode starts in breadth with the 15:00 countdown',text(p,'#boardTimeLeft')=='15:00 left' and text(p,'#boardPhase').startswith('Breadth'))
 q(p,{'type':'user_text','item_id':'user-1','text':'We worked in Portugal and Spain.','provenance':'unverified_speech_recognition'})
 check('analysing… shows between user_text and quality','analysing…' in text(p,'#boardChallenge'))
 q(p,QUALITY)
 check('analysing… clears when the quality event arrives','analysing…' not in text(p,'#boardChallenge'))
 check('Pins for Portugal and Spain only',p.evaluate("[...document.querySelectorAll('#boardMap .board-pin')].map(e=>e.dataset.code).join()")=='PRT,ESP')
 check('Pinned countries use the hatched interview state',p.evaluate("[...document.querySelectorAll('#boardMap .geo-country[data-state=interview]')].map(e=>e.dataset.code).sort().join()")=='ESP,PRT')
 check('No pin from "Lisbon queue" or "Chad said"; Chad listed as not mapped',p.locator('#boardMap .board-pin[data-code=TCD]').count()==0 and 'Not mapped: Chad' in text(p,'#boardMap') and 'Lisbon' not in text(p,'#boardMap'))
 check('Pins say mentioned, not project location','not necessarily the project location' in text(p,'#boardMap'))
 check('Metric chips are exact spans',chips(p)==['40%','12 to 4 days','$3.5 million','€2 million','1.5 m (unit unclear)'])
 check('Measurement slot is dashed "to recover"','to recover: before and after values' in text(p,'#boardMetrics'))
 st=p.evaluate("Object.fromEntries([...document.querySelectorAll('#boardDims .board-dim')].map(e=>[e.dataset.field,e.dataset.state]))")
 check('Twelve dimension cells in the right states',len(st)==12 and st['problem']=='reported' and st['measurement']=='unknown' and st['evidence']=='deferred' and st['decision']=='empty')
 check('Coverage reads as candidate coverage','5/12 · candidate coverage, not verification'==text(p,'#boardCoverage'))
 check('"ATLAS may ask next", never "asked"','ATLAS may ask next' in text(p,'#boardChallenge') and 'before and after values' in text(p,'#boardChallenge') and not re.search(r'\basked\b',p.evaluate("document.querySelector('#storyBoard').textContent")))
 check('Lagging probe_history is not shown','Earlier plan' not in p.evaluate("document.querySelector('#storyBoard').textContent"))
 # ---- F5.3 #4: nothing claims a check; every section carries the label
 check('No element says verified, confirmed or approved',not WORDS.search(p.evaluate("document.querySelector('#storyBoard').textContent")))
 check('Every visible board section says unverified',p.evaluate("[...document.querySelectorAll('#storyBoard .board-part')].filter(e=>!e.hidden).every(e=>e.textContent.includes('From the interview · unverified'))"))
 check('Summary live region is polite and unverified',p.get_attribute('#boardSummary','aria-live')=='polite' and 'unverified' in p.evaluate("document.getElementById('boardSummary').textContent"))
 # ---- F5.3 #2: supersede, only new items animate, orb pause, late quality
 said=p.evaluate("document.getElementById('boardSummary').textContent")
 fixed=dict(QUALITY,candidate_details=DETAILS+[D('D-006','outcome','Sorry: errors fell 30% and lead time went from 12 to 4 days.',supersedes='D-002')])
 fixed['candidate_details']=[d for d in fixed['candidate_details'] if d['id']!='D-002']
 q(p,fixed)
 check('Superseded chip disappears and the board says corrected','40%' not in chips(p) and '30%' in chips(p) and 'corrected' in text(p,'#boardMetrics'))
 check('Only the correction chips carry is-new (diff by D-id)',p.evaluate("[...document.querySelectorAll('#boardMetrics .is-new')].map(e=>e.innerText.trim()).join()")=='30%,12 to 4 days')
 check('A new chip really animates when motion is allowed',p.evaluate(anims)>0)
 check('Summary is throttled (no second update within 10 s)',p.evaluate("document.getElementById('boardSummary').textContent")==said)
 p.evaluate("document.getElementById('voiceOrb').classList.add('motion-paused')")
 q(p,dict(fixed,candidate_details=fixed['candidate_details']+[D('D-007','adoption','About 20 hours a week were saved by the team.',status='uncertain')]))
 check('Orb pause: a new chip does not animate',p.locator('#boardMetrics .is-new').count()==0 and '20 hours · estimate' in chips(p))
 p.evaluate("document.getElementById('voiceOrb').classList.remove('motion-paused')")
 s(p,{'type':'audio_stopped'})
 late=dict(fixed,candidate_details=fixed['candidate_details']+[D('D-008','customer_fit','A similar insurer across France could use it.')])
 q(p,late);check('Quality after audio_stopped is still accepted',p.locator('#boardMap .board-pin[data-code=FRA]').count()==1)
 # ---- F5.3 #7: hostile quote text renders inert
 q(p,{**QUALITY,'candidate_details':[D('D-009','outcome','<img src=x onerror="window.__xss=1"> in Spain we saved 40%')],'next_question':'<img src=y onerror="window.__xss=2">','planned_question':'<img src=y onerror="window.__xss=2">','flags':['<b>bold</b>']})
 p.wait_for_timeout(100)
 check('Hostile text renders inert',p.evaluate("!document.querySelector('#storyBoard img,#storyBoard b b') && window.__xss===undefined") and '<img src=y' in text(p,'#boardChallenge'))
 # ---- F5.3 #3: reset clears everything
 s(p,{'type':'reset'})
 check('reset clears everything',p.locator('#storyBoard').is_hidden() and p.evaluate("['boardMap','boardMetrics','boardDims','boardChallenge'].every(id=>!document.querySelector('#'+id+' .board-body').children.length) && !document.getElementById('boardSummary').textContent && !document.getElementById('boardCoverage').textContent"))
 s(p,READY);q(p,QUALITY);q(p,{'type':'reset'})
 check('atlas-quality reset clears too',p.locator('#storyBoard').is_hidden() and p.locator('#boardMetrics .board-chip').count()==0)
 # ---- F5.3 #8: full-mode phases at the timePlan boundaries (page clock moved forward; the countdown ticks once a second)
 s(p,READY);p.evaluate("window.__now=Date.now;window.__t0=Date.now();Date.now=()=>__t0+405000")
 p.wait_for_timeout(1300);check('Depth at timePlan.depthAt',text(p,'#boardPhase').startswith('Depth') and text(p,'#boardTimeLeft')=='8:15 left')
 p.evaluate("Date.now=()=>__t0+690000");p.wait_for_timeout(1300);check('Closing at timePlan.closingAt',text(p,'#boardPhase')=='Closing' and text(p,'#boardTimeLeft')=='3:30 left')
 p.evaluate("Date.now=__now");s(p,{'type':'reset'})
 # ---- hidden when the live ledger is off
 s(p,{**READY,'liveLedger':False});q(p,QUALITY);check('Hidden when liveLedger is false',p.locator('#storyBoard').is_hidden())
 s(p,{'type':'reset'})
 # ---- F5.3 #8 gap mode and F5.3 #9 / F2.7 #6: answers leave only on an explicit click
 p.evaluate("""rid=>{window.__apply=[];const A=window.ATLAS_APP;
   A.applyGapNotes=async id=>{__apply.push(id===undefined?null:id);return {projectId:id,library:{id:'ref-123',revision:4}};};
   A.profile=()=>({projects:[{id:'p-gap',title:'Proof for Bid X',library:{id:'ref-123',revision:3},gapNotes:{requestId:rid}}]});
   A.project=()=>({id:'p-other',library:{id:'ref-other'}});}""",RID)
 s(p,{'type':'ready','mode':'gap','maxSeconds':300,'liveLedger':True,'capture':True,'timePlan':{'depthAt':None,'closingAt':210},'gaps':GAPS})
 check('Gap mode: checklist, 5:00 countdown, focused phase',p.locator('#boardGaps').is_visible() and p.locator('#boardGaps li').count()==2 and text(p,'#boardTimeLeft')=='5:00 left' and text(p,'#boardPhase').startswith('Focused'))
 q(p,{**QUALITY,'candidate_details':[D('D-001','outcome','Errors fell 40% after the pilot in Spain.')],'gap_status':[{'id':'G1','field':'outcome','label':'Observed outcome','status':'answered_unverified','details':['D-001']},{'id':'G2','field':'evidence','label':'Supporting artifact','status':'open','details':[]}],
  'next_field':'evidence','next_question':'Proof the bid needs: a named source','planned_question':'Proof the bid needs: a named source'})
 check('Checklist merges gap_status','answered · unverified' in text(p,'#boardGaps') and p.evaluate("document.querySelector('#boardGaps li:nth-child(2)').dataset.status")=='open')
 check('Gap mode shows the current ask as what ATLAS may ask next','a named source' in text(p,'#boardChallenge'))
 NOTES={'type':'notes','mode':'gap','transcript':'Errors fell 40% after the pilot.','sections':['','','','Errors fell 40% after the pilot.','',''],'status':'candidate','report':None,'message':'m',
  'gap':{'requestId':RID,'results':[{'askId':'G1','field':'outcome','status':'answered_unverified','quotes':['Errors fell 40% after the pilot.','<img src=x onerror="window.__xss=3">']},{'askId':'G2','field':'evidence','status':'unknown','quotes':[]}]}}
 s(p,{'type':'audio_stopped'});s(p,NOTES);s(p,{'type':'ended'});p.wait_for_timeout(600)
 check('Gap results show the quotes per ask, labelled unverified',p.locator('#gapPanel').is_visible() and 'Errors fell 40% after the pilot.' in text(p,'#gapResults') and 'From the interview · unverified' in text(p,'#gapResults') and 'answered · unverified' in text(p,'#gapResults'))
 check('Gap quotes render inert',p.evaluate("!document.querySelector('#gapResults img') && window.__xss===undefined"))
 check('Nothing is sent before a click',POSTS==[] and p.evaluate('__apply.length')==0)
 check('Both actions are separate buttons with the agreed words',text(p,'#gapSend')=='Send these answers to the bid team' and text(p,'#gapApply')=='Add these answers to my reference')
 p.locator('#gapSend').click();p.wait_for_function("document.getElementById('gapSend').textContent==='Sent to the bid team'")
 p.evaluate("document.getElementById('gapSend').click()");p.wait_for_timeout(300)
 check('#gapSend posts exactly once, only on its click',len(POSTS)==1 and POSTS[0]['method']=='POST' and POSTS[0]['url'].endswith('/api/library/gaps/'+RID+'/answer') and POSTS[0]['csrf']=='tok')
 check('The answer body carries askId, status and quotes, and the interviewed reference',POSTS[0]['body']=={'results':[{'askId':'G1','status':'answered_unverified','quotes':['Errors fell 40% after the pilot.','<img src=x onerror="window.__xss=3">']},{'askId':'G2','status':'unknown','quotes':[]}],'referenceId':'ref-123'})
 check('Sending did not add to the reference',p.evaluate('__apply.length')==0)
 p.locator('#gapApply').click();p.wait_for_function("document.getElementById('gapApply').textContent==='Added to your reference'")
 p.evaluate("document.getElementById('gapApply').click()");p.wait_for_timeout(300)
 check('#gapApply calls ATLAS_APP.applyGapNotes once, for the interviewed project',p.evaluate('JSON.stringify(__apply)')=='["p-gap"]' and len(POSTS)==1)
 check('No other library call was made',not [u for u in OTHER if '/api/library' in u])
 # ---- F5.3 #5 and #6: reduced motion, 320 px
 s(p,{'type':'reset'});check('reset hides the proof answers',p.locator('#gapPanel').is_hidden())
 p.emulate_media(reduced_motion='reduce');s(p,READY);q(p,QUALITY);q(p,dict(QUALITY,candidate_details=DETAILS+[D('D-010','adoption','The team in Italy used it for 6 months, 3 days a week.')]))
 check('Reduced motion: no running animation inside #storyBoard',p.evaluate(anims)==0 and p.locator('#storyBoard .is-new').count()==0)
 for w in (320,390,768,1366):
  p.set_viewport_size({'width':w,'height':900});p.wait_for_timeout(150)
  check(f'No overflow at {w} px',p.locator('#storyBoard').is_visible() and p.evaluate(fits))
 s(p,{'type':'notes','mode':'gap','gap':NOTES['gap']});p.set_viewport_size({'width':320,'height':900});p.wait_for_timeout(150)
 check('Proof answers fit 320 px',p.locator('#gapPanel').is_visible() and p.evaluate(fits))
 check('No page errors',not ERR)
 b.close()
if ERR:print('\n'.join(ERR));sys.exit(1)
