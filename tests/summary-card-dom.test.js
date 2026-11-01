'use strict';
// The read-back card (T11): the pure view model (storyboard-core.js summaryView), the card itself (storyboard-ui.js run for real against a fake DOM), and the
// message shapes the card asks voice-client.js to send (voice-controls.js summaryMessage). Not a render test: layout, focus rings and colour are covered by the
// Chromium suites; here are the behaviours: what each button emits, that confirming is NOT submitting, and that Submit for review is a separate click that posts
// the revision the person saw to the library's submit route.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.join(__dirname,'..'),read=f=>fs.readFileSync(path.join(ROOT,'src',f),'utf8');
const B=require('../src/storyboard-core.js'),VC=require('../src/voice-controls.js'),WF=require('../src/workflow-core.js');

const item=(id,field,label,quote,extra={})=>({detail_id:id,field,label,quote,status:'reported',asr_unconfirmed:false,provenance:'unverified_speech_recognition',...extra});
const ITEMS=[item('D-001','problem','Customer problem','Tickets bounced between three teams'),
 item('D-002','outcome','Observed outcome','Triage fell from 14 minutes to 9 minutes',{status:'uncertain',asr_unconfirmed:true,provenance:'consultant_typed'}),
 item('D-003','measurement','Measurement basis',"I don't know the baseline",{status:'unknown'})];
const UNKNOWNS=[{kind:'unconfirmed_speech',field:'outcome',label:'Observed outcome',detail_id:'D-002'},{kind:'skipped',field:'stakes',label:'Business stakes'}];

test('summaryView: the card as a person reads it: items with plain tags, open points, the next reviewer and the permitted use',()=>{
 const v=B.summaryView({phase:'open',items:ITEMS,unknowns:UNKNOWNS});
 assert.equal(v.visible,true);assert.equal(v.title,'Read-back: what ATLAS understood');
 assert.deepEqual(v.items.map(i=>[i.id,i.label,i.editable]),[['D-001','Customer problem',true],['D-002','Observed outcome',true],['D-003','Measurement basis',true]]);
 assert.deepEqual(v.items[0].tags,[]);
 assert.deepEqual(v.items[1].tags,['you called this an estimate','speech not confirmed','typed by you']);
 assert.deepEqual(v.items[2].tags,['still open, in your own words']);
 assert.deepEqual(v.openPoints,['Not confirmed, the speech recognition was unsure: Observed outcome','Still open: Business stakes']);
 assert.match(v.next,/private draft that only you can see/);assert.match(v.next,/your N\+1 or reviewer/);assert.match(v.next,/internal knowledge only until you grant more/);assert.match(v.next,/Submit for review/);
 assert.deepEqual(v.confirm,{label:'Confirm summary',hidden:false,disabled:false});assert.equal(v.submit.hidden,true);
 assert.equal(v.saved,'');assert.equal(v.notSaved,'');assert.match(v.live,/^Read-back: 3 items, 2 open points\.$/);
 assert.ok(!/\b(?:shared|published|submitted|approved|verified)\b/i.test(JSON.stringify(v)),'a draft is not shared, published, approved or verified');
});
test('summaryView: confirming, then the private draft and the separate Submit; or why nothing was saved; or an interview that ended unconfirmed',()=>{
 const c=B.summaryView({phase:'confirming',items:ITEMS});assert.deepEqual(c.confirm,{label:'Saving…',hidden:false,disabled:true});assert.equal(c.items[0].editable,false);
 const d=B.summaryView({phase:'confirmed',items:ITEMS,draft:{id:'e1',revision:1},submit:{status:'idle'}});
 assert.match(d.saved,/^Saved as a private draft — only you can see it\. Revision 1\.$/);assert.equal(d.confirm.hidden,true);
 assert.deepEqual([d.submit.hidden,d.submit.disabled,d.submit.label],[false,false,'Submit for review']);assert.match(d.submit.message,/Not submitted yet\. Only you can see this draft\./);
 assert.equal(d.items.every(i=>i.editable===false),true);
 assert.match(B.summaryView({phase:'confirmed',items:ITEMS,draft:{id:'e1',revision:2,unchanged:true}}).saved,/already saved/);
 const s=B.summaryView({phase:'confirmed',items:ITEMS,draft:{id:'e1',revision:1},submit:{status:'sending'}});assert.deepEqual([s.submit.disabled,s.submit.label],[true,'Submitting…']);
 const done=B.summaryView({phase:'confirmed',items:ITEMS,draft:{id:'e1',revision:1},submit:{status:'sent'}});assert.deepEqual([done.submit.disabled,done.submit.label],[true,'Submitted for review']);assert.match(done.submit.message,/your N\+1 or reviewer can now see it/i);
 assert.match(B.summaryView({phase:'confirmed',items:ITEMS,submit:{status:'idle'},unavailable:{reason:'workflow_off',message:'The evidence workflow is switched off here, so the summary was not saved to the library.'}}).notSaved,/not saved to the library/);
 const err=B.summaryView({phase:'confirmed',items:ITEMS,draft:{id:'e1',revision:1},submit:{status:'error',message:'Not allowed: REVISION_MISMATCH'}});assert.equal(err.submit.message,'Not allowed: REVISION_MISMATCH');assert.equal(err.submit.disabled,false);
 const e=B.summaryView({phase:'ended',items:ITEMS});assert.match(e.notSaved,/ended before you confirmed.*nothing was saved/);assert.equal(e.confirm.hidden,true);assert.equal(e.submit.hidden,true);
 assert.equal(B.summaryView({phase:'closed',items:ITEMS}).visible,false);assert.equal(B.summaryView(null).visible,false);assert.equal(B.summaryView({phase:'open',items:[]}).confirm.disabled,true);
});
test('summaryView never trusts what it is given: bad ids, odd statuses, too many items, markup stay inert text',()=>{
 const v=B.summaryView({phase:'open',items:[...ITEMS,{detail_id:'../x',quote:'x'},null,5,{detail_id:'D-9',quote:'x'},item('D-004','problem','<b>Label</b>','<img src=x onerror=alert(1)>',{status:'weird',provenance:'weird'})],
  unknowns:[{kind:'nope',label:'x'},null,{kind:'deferred',label:'Customer relevance'}]});
 assert.equal(v.items.length,4);assert.deepEqual(v.items[3].tags,[]);assert.equal(v.items[3].quote,'<img src=x onerror=alert(1)>');assert.deepEqual(v.openPoints,['Still open: Customer relevance']);
 assert.equal(B.summaryView({phase:'open',items:Array.from({length:90},(_,i)=>item('D-'+String(i+1).padStart(3,'0'),'problem','L','q'))}).items.length,60);
 assert.equal(B.summaryView({phase:'confirmed',draft:{id:5,revision:1},items:ITEMS}).submit.hidden,true,'a draft needs a text id');
});
test('summaryMessage: exactly the keys the session accepts, the consultant\'s words bounded like the server, anything else is null',()=>{
 assert.deepEqual(VC.summaryMessage('confirm_summary'),{type:'confirm_summary'});
 assert.deepEqual(VC.summaryMessage('withhold','D-002'),{type:'withhold',detail_id:'D-002'});
 assert.deepEqual(VC.summaryMessage('correct','D-002','  It was 35 percent.  '),{type:'correct',detail_id:'D-002',text:'It was 35 percent.'});
 assert.deepEqual(Object.keys(VC.summaryMessage('correct','D-002','It was 35 percent.')).sort(),['detail_id','text','type']);
 assert.equal([...VC.summaryMessage('correct','D-002','😀'.repeat(2500)).text].length,1800);
 for(const [k,id,t] of [['correct','D-002','abcd'],['correct','D-002','   '],['correct','D-002',5],['correct','D-002',undefined],['correct','x','long enough text'],['correct',undefined,'long enough text'],['withhold','D-1'],['withhold','../D-001'],['withhold',5],['skip','D-001'],['end'],[undefined]])
  assert.equal(VC.summaryMessage(k,id,t),null,JSON.stringify([k,id,t]));
});

// ---- the card, run for real against a fake DOM ----
class El{
 constructor(id,tag='div'){this.id=id;this.tag=tag;this.hidden=false;this.disabled=false;this.value='';this.dataset={};this.attrs={};this.kids=[];this.cls='';this._text='';this.listeners={};this.style={};
  const set=new Set();this.classList={add:c=>set.add(c),remove:c=>set.delete(c),toggle:(c,on)=>{if(on===undefined?!set.has(c):on)set.add(c);else set.delete(c);},contains:c=>set.has(c)};}
 set className(v){this.cls=String(v);}get className(){return this.cls;}
 set textContent(v){this._text=String(v);this.kids=[];}
 get textContent(){return this._text+this.kids.map(k=>typeof k==='string'?k:k.textContent).join('');}
 setAttribute(k,v){this.attrs[k]=String(v);}getAttribute(k){return this.attrs[k]??null;}removeAttribute(k){delete this.attrs[k];}
 addEventListener(t,f){(this.listeners[t]||=[]).push(f);}
 append(...k){this.kids.push(...k);}appendChild(k){this.kids.push(k);return k;}replaceChildren(...k){this._text='';this.kids=k;}
 walk(){return this.kids.flatMap(k=>typeof k==='string'?[]:[k,...k.walk()]);}
 findAll(pred){return this.walk().filter(pred);}
 querySelector(sel){const m=sel.match(/^\.([\w-]+)(?: (\w+))?$/);if(!m)return new El('stub');
  const hit=this.walk().find(e=>e.cls.split(/\s+/).includes(m[1])&&true);if(!hit)return new El('stub');return m[2]?hit.walk().find(e=>e.tag===m[2])||new El('stub'):hit;}
 querySelectorAll(){return [];}focus(){this.focused=true;}
 fire(t,ev={}){for(const f of this.listeners[t]||[])f({key:'',preventDefault(){},...ev});}
 click(){if(this.disabled||this.hidden)return;this.fire('click');}
}
function boot({libraryApi,policy=true,timeout=setTimeout}={}){
 const els={},$=id=>els[id]||(els[id]=new El(id)),listeners={},actions=[],calls=[];
 const document={getElementById:$,createElement:t=>new El('',t),createElementNS:(ns,t)=>new El('',t),querySelector:()=>null,addEventListener(){},readyState:'complete'};
 const win={document,AtlasBoard:B,AtlasSafe:require('../src/safe-html.js'),AtlasVoiceControls:VC,AtlasWorkflowCore:WF,ATLAS_POLICY:policy?{FIELDS:{}}:undefined,
  ATLAS_APP:{libraryApi:libraryApi?async(p,o)=>{calls.push([p,o||{}]);return libraryApi(p,o);}:undefined},
  addEventListener:(t,f)=>(listeners[t]||=[]).push(f),
  dispatchEvent:e=>{if(e.type==='atlas-summary-action')actions.push(e.detail);for(const f of listeners[e.type]||[])f(e);},
  CustomEvent:class{constructor(type,o){this.type=type;this.detail=o?.detail;}},matchMedia:()=>({matches:false}),setTimeout:timeout,clearTimeout,setInterval:(f,ms)=>setInterval(f,ms).unref(),clearInterval,Date,Math,Object,Array,JSON,String,Number,Set,Map,Promise,Error,isFinite,RegExp};
 win.window=win;
 vm.runInContext(read('storyboard-ui.js'),vm.createContext(win),{filename:'storyboard-ui.js'});
 const session=d=>win.dispatchEvent(new win.CustomEvent('atlas-session',{detail:d}));
 return {$,els,actions,calls,session,win,listeners};
}
const flush=()=>new Promise(r=>setTimeout(r,5)),plain=v=>JSON.parse(JSON.stringify(v)); // (values made inside the page's vm context have another realm's prototypes)
const buttons=(h,act)=>h.$('summaryItems').findAll(e=>e.tag==='button'&&e.dataset.action===act);
const items=h=>h.$('summaryItems').kids;
const SUMMARY={type:'summary',items:ITEMS,unknowns:UNKNOWNS,state:'summary',round:1};
const OK_STATUS={cards:[{branch:'evidence',display_status:'draft'},{branch:'maap',display_status:'not_started',reason:'MAAP_NOT_CONFIGURED'},{branch:'dna',display_status:'pending',mock:true}]};

test('the card appears with the read-back: each item has Correct and Keep private, the open points are listed, Confirm is on, Submit is not there',()=>{
 const h=boot();
 h.session({type:'ready',maxSeconds:900});assert.equal(h.$('summaryCard').hidden,true);
 h.session(SUMMARY);
 assert.equal(h.$('summaryCard').hidden,false);assert.equal(items(h).length,3);
 assert.match(items(h)[0].textContent,/Customer problem.*Tickets bounced between three teams/);assert.match(items(h)[1].textContent,/you called this an estimate.*speech not confirmed.*typed by you/);
 assert.equal(buttons(h,'correct').length,3);assert.equal(buttons(h,'withhold').length,3);
 assert.deepEqual(buttons(h,'correct').map(b=>b.getAttribute('aria-label')),['Correct: Customer problem','Correct: Observed outcome','Correct: Measurement basis']);
 assert.deepEqual(buttons(h,'withhold').map(b=>b.getAttribute('aria-label')),['Keep private: Customer problem','Keep private: Observed outcome','Keep private: Measurement basis']);
 assert.equal(h.$('summaryOpen').hidden,false);assert.equal(h.$('summaryOpenList').kids.length,2);
 assert.equal(h.$('summaryConfirm').hidden,false);assert.equal(h.$('summaryConfirm').disabled,false);assert.equal(h.$('summarySubmit').hidden,true);
 assert.match(h.$('summaryNext').textContent,/your N\+1 or reviewer/);assert.match(h.$('summaryLive').textContent,/3 items/);
 assert.match(h.$('summaryIntro').textContent,/Correct anything that is wrong/);
});
test('Keep private asks for exactly one withhold message for that item; Correct opens a labelled input and sends the typed words, nothing shorter than five characters',()=>{
 const h=boot();h.session(SUMMARY);
 buttons(h,'withhold')[1].click();assert.deepEqual(plain(h.actions),[{kind:'withhold',detail_id:'D-002'}]);
 buttons(h,'correct')[0].click();
 const input=h.$('summaryItems').findAll(e=>e.tag==='input')[0];assert.ok(input,'an inline input');assert.equal(input.getAttribute('autocomplete'),'off');
 const label=h.$('summaryItems').findAll(e=>e.tag==='label')[0];assert.equal(label.getAttribute('for'),input.id);assert.match(label.textContent,/in your own words/);
 assert.equal(buttons(h,'correct')[0].getAttribute('aria-expanded'),'true');
 const save=h.$('summaryItems').findAll(e=>e.dataset.action==='save')[0];
 input.value='no';save.click();assert.equal(h.actions.length,1,'too short: nothing sent');assert.match(h.$('summaryMessage').textContent,/at least five characters/);
 input.value='It was 35 percent, measured in March.';save.click();
 assert.deepEqual(plain(h.actions.at(-1)),{kind:'correct',detail_id:'D-001',text:'It was 35 percent, measured in March.'});
 assert.equal(h.$('summaryItems').findAll(e=>e.tag==='input').length,0,'the input closes after sending');assert.match(h.$('summaryMessage').textContent,/Sent\./);
 // Enter sends, Escape cancels, Cancel closes
 buttons(h,'correct')[2].click();let i2=h.$('summaryItems').findAll(e=>e.tag==='input')[0];i2.value='Typed with the keyboard.';i2.fire('keydown',{key:'Enter'});
 assert.deepEqual(plain(h.actions.at(-1)),{kind:'correct',detail_id:'D-003',text:'Typed with the keyboard.'});
 buttons(h,'correct')[0].click();i2=h.$('summaryItems').findAll(e=>e.tag==='input')[0];i2.fire('keydown',{key:'Escape'});assert.equal(h.$('summaryItems').findAll(e=>e.tag==='input').length,0);
 buttons(h,'correct')[0].click();h.$('summaryItems').findAll(e=>e.dataset.action==='cancel')[0].click();assert.equal(h.$('summaryItems').findAll(e=>e.tag==='input').length,0);
 for(const a of h.actions)assert.ok(VC.summaryMessage(a.kind,a.detail_id,a.text),'every action maps to a message the server accepts: '+JSON.stringify(a));
});
test('an updated read-back replaces the items and keeps an open correction box for an item that is still there',()=>{
 const h=boot();h.session(SUMMARY);buttons(h,'correct')[0].click();
 h.session({...SUMMARY,items:[ITEMS[0],item('D-004','outcome','Observed outcome','It was a modest change.',{provenance:'consultant_typed'})]});
 assert.equal(items(h).length,2);assert.equal(h.$('summaryItems').findAll(e=>e.tag==='input').length,1,'the box for D-001 is still open');
 h.session({...SUMMARY,items:[ITEMS[1]]});assert.equal(h.$('summaryItems').findAll(e=>e.tag==='input').length,0,'its item is gone, so is the box');
 h.session({type:'summary_closed',reason:'continue'});assert.equal(h.$('summaryCard').hidden,true);
 h.session(SUMMARY);assert.equal(h.$('summaryCard').hidden,false,'a later read-back opens it again');
});
test('Confirm summary asks for confirm_summary once and shows Saving…; the private draft appears with a SEPARATE Submit button that nothing has pressed',async()=>{
 const h=boot({libraryApi:async p=>p.endsWith('/status')?OK_STATUS:{}});h.session(SUMMARY);
 h.$('summaryConfirm').click();h.$('summaryConfirm').click();
 assert.deepEqual(plain(h.actions),[{kind:'confirm_summary'}],'one message');assert.equal(h.$('summaryConfirm').textContent,'Saving…');assert.equal(h.$('summaryConfirm').disabled,true);
 assert.equal(buttons(h,'correct').length,0,'no edits while it saves');
 h.session({type:'summary_confirmed'});assert.equal(h.$('summarySubmit').hidden,true,'confirmed is not submitted, and not yet saved');
 h.session({type:'evidence_draft',id:'e1',revision:1,state:'evidence_draft',visibility:'owner_only'});await flush();
 assert.match(h.$('summarySaved').textContent,/Saved as a private draft — only you can see it\./);
 assert.equal(h.$('summaryConfirm').hidden,true);assert.equal(h.$('summarySubmit').hidden,false);assert.equal(h.$('summarySubmit').textContent,'Submit for review');
 assert.match(h.$('summaryMessage').textContent,/Not submitted yet\. Only you can see this draft\./);
 assert.ok(!h.calls.some(c=>/submit/.test(c[0])),'nothing was submitted by confirming');
 assert.deepEqual(plain(h.calls.map(c=>c[0])),['/evidence/e1/status'],'only the status was read, so the workflow cards show');
 assert.deepEqual(h.$('summaryStatus').kids.map(k=>k.textContent).slice(0,2),['Evidence: Draft','MAAP Review: Not started'],'the T15 cards for that draft');
});
test('Submit for review is its own click: POST /evidence/:id/submit with the expected_revision the person saw, once; the cards refresh; a failure can be retried',async()=>{
 let fail=false;const h=boot({libraryApi:async(p,o)=>{if(p.endsWith('/status'))return OK_STATUS;if(fail)throw Error('Not allowed: REVISION_MISMATCH');return {id:'e1',revision:1,state:'reviewer_queue'};}});
 h.session(SUMMARY);h.session({type:'evidence_draft',id:'e1',revision:3});await flush();h.calls.length=0;
 fail=true;h.$('summarySubmit').click();await flush();
 assert.deepEqual(plain(h.calls[0]),['/evidence/e1/submit',{method:'POST',body:{expected_revision:3}}]);
 assert.match(h.$('summaryMessage').textContent,/REVISION_MISMATCH/);assert.equal(h.$('summarySubmit').disabled,false,'retry is possible');
 fail=false;h.calls.length=0;h.$('summarySubmit').click();h.$('summarySubmit').click();await flush();
 assert.deepEqual(plain(h.calls.filter(c=>/submit/.test(c[0]))),[['/evidence/e1/submit',{method:'POST',body:{expected_revision:3}}]],'a double click posts once');
 assert.equal(h.$('summarySubmit').textContent,'Submitted for review');assert.equal(h.$('summarySubmit').disabled,true);assert.match(h.$('summaryMessage').textContent,/your N\+1 or reviewer can now see it/i);
 assert.ok(h.calls.some(c=>c[0]==='/evidence/e1/status'),'the status cards are read again after the submit');
 h.$('summarySubmit').click();await flush();assert.equal(h.calls.filter(c=>/submit/.test(c[0])).length,1,'and it cannot be sent again');
});
test('Submit without the library says so and posts nothing',async()=>{
 const h=boot();h.session(SUMMARY);h.session({type:'evidence_draft',id:'e1',revision:1});h.$('summarySubmit').click();await flush();
 assert.match(h.$('summaryMessage').textContent,/shared library is not available/);
});
test('nothing saved: the server\'s reason is shown and there is no Submit; an interview that ends unconfirmed says nothing was saved; a confirm that gets no answer can be retried',async()=>{
 let h=boot();h.session(SUMMARY);h.$('summaryConfirm').click();h.session({type:'summary_confirmed'});
 h.session({type:'evidence_draft_unavailable',reason:'workflow_off',message:'The evidence workflow is switched off here, so the summary was not saved to the library.'});
 assert.match(h.$('summarySaved').textContent,/switched off here/);assert.equal(h.$('summarySubmit').hidden,true);
 h=boot();h.session(SUMMARY);h.session({type:'ended'});assert.match(h.$('summarySaved').textContent,/ended before you confirmed this summary, so nothing was saved/);assert.equal(h.$('summaryConfirm').hidden,true);
 assert.equal(buttons(h,'correct').length,0);
 h=boot();h.session(SUMMARY);h.$('summaryConfirm').click();h.session({type:'summary_confirmed'});h.session({type:'ended'});
 assert.match(h.$('summarySaved').textContent,/confirmed, but the interview ended before the library answered\. Nothing was saved/);assert.equal(h.$('summarySubmit').hidden,true);
 h=boot();h.session({type:'reset'});assert.equal(h.$('summaryCard').hidden,true);
 h=boot();h.session(SUMMARY);h.session({type:'ready'});assert.equal(h.$('summaryCard').hidden,true,'a new interview starts with no card');
});
test('a confirmation that never gets an answer goes back to Confirm summary after a while',()=>{
 let fire=null;const h=boot({timeout:(f,ms)=>{if(ms===15000){fire=f;return 7;}return setTimeout(f,ms);}});
 h.session(SUMMARY);h.$('summaryConfirm').click();assert.equal(h.$('summaryConfirm').textContent,'Saving…');
 fire();assert.equal(h.$('summaryConfirm').textContent,'Confirm summary');assert.equal(h.$('summaryConfirm').disabled,false);assert.match(h.$('summaryMessage').textContent,/did not go through/);
 h.session({type:'evidence_draft',id:'e1',revision:1});fire=null;
 const g=boot({timeout:(f,ms)=>{if(ms===15000){fire=f;return 7;}return setTimeout(f,ms);}});g.session(SUMMARY);g.$('summaryConfirm').click();g.session({type:'evidence_draft',id:'e2',revision:1});fire();
 assert.match(g.$('summarySaved').textContent,/Saved as a private draft/,'a late timer never undoes a saved draft');
});
test('the interview clock goes on from where it was when the interview is resumed (it does not restart at zero)',()=>{
 const left=resumed=>{const h=boot();h.session({type:'ready',maxSeconds:900,mode:'full',liveLedger:true,timePlan:{depthAt:405,closingAt:690},...resumed});return h.$('boardTimeLeft').textContent;};
 assert.equal(left({}),'15:00 left');assert.equal(left({resumed:true,activeSeconds:300}),'10:00 left');assert.equal(left({resumed:true}),'15:00 left');assert.equal(left({activeSeconds:300}),'15:00 left','only a resumed one');
 assert.equal(left({resumed:true,activeSeconds:-5}),'15:00 left');assert.equal(left({resumed:true,activeSeconds:'300'}),'15:00 left');
});
test('wiring: the compiled page has the card, its buttons and the three message builders, and voice-client sends only announced, valid card messages',()=>{
 const page=fs.readFileSync(path.join(ROOT,'ATLAS_Voice.html'),'utf8');
 for(const id of ['summaryCard','summaryItems','summaryConfirm','summarySubmit','summarySaved','summaryMessage','summaryStatus','summaryOpenList','summaryLive'])assert.equal((page.match(new RegExp('id="'+id+'"','g'))||[]).length,1,id);
 assert.match(page,/function summaryView\(/);assert.match(page,/function summaryMessage\(/);
 const vc=read('voice-client.js');const hook=vc.slice(vc.indexOf("addEventListener('atlas-summary-action'"),vc.indexOf('function sendTyped'));
 assert.ok(hook.includes('VC.summaryMessage(d.kind,d.detail_id,d.text)')&&hook.includes("phase!=='live'")&&hook.includes('supported(m.type)')&&hook.includes('send(m)'),'built by the pure module, only while live, only if announced');
 for(const t of ['summary','summary_closed','summary_confirmed','evidence_draft','evidence_draft_unavailable'])assert.ok(vc.includes("'"+t+"'"),t+' reaches the page bus');
 const ui=read('storyboard-ui.js');assert.match(ui,/'\/evidence\/'\+encodeURIComponent\(s\.draft\.id\)\+'\/submit',\{method:'POST',body:\{expected_revision:s\.draft\.revision\}\}/);
 assert.equal((ui.match(/\/submit/g)||[]).length,1,'one place submits, and only its own button calls it');
});

// ---- v2.2 L1: the language each quote was said in ----
test('the card keeps a quote in its own language: lang attribute on the quote, a language tag outside English, never translated',()=>{
 const B=require('../src/storyboard-core.js');
 const v=B.summaryView({phase:'open',items:[{detail_id:'D-001',field:'problem',label:'Problem',quote:"Les sinistres rebondissaient entre trois équipes.",status:'reported',lang:'fr'},{detail_id:'D-002',field:'outcome',label:'Outcome',quote:'Triage fell to 12 minutes.',status:'reported',lang:'en'},{detail_id:'D-003',field:'outcome',label:'Outcome',quote:'No tag here.',status:'reported'},{detail_id:'D-004',field:'outcome',label:'Outcome',quote:'Hostile tag.',status:'reported',lang:'<b>'}]});
 assert.deepEqual(v.items.map(i=>i.lang),['fr','en',undefined,undefined]);assert.equal(v.items[0].quote,"Les sinistres rebondissaient entre trois équipes.");
});
