/* ATLAS live story board in the Conversation view (WOW_SPEC F5.2) and the proof answers after a gap interview (F2.6, T5).
   Driven only by window events: 'atlas-quality' (quality, user_text, reset) and 'atlas-session' (ready, time_up, wrap_up,
   audio_stopped, reporting, notes, ended, summary, reset). Never by agent_text, and no requestAnimationFrame: the countdown is a
   one-second interval that only runs between ready and the end of the audio. All text goes through textContent; the only
   markup inserted is AtlasGeo's own escaped map SVG. Nothing leaves the browser except on an explicit click of #gapSend. */
(()=>{'use strict';
const {html,setHTML,insertHTML,trusted}=window.AtlasSafe;
const $=id=>document.getElementById(id),B=window.AtlasBoard,board=$('storyBoard'),panel=$('gapPanel');
if(!B||!board||!panel)return;
const LABEL='From the interview · unverified',SVG='http://www.w3.org/2000/svg',REQUEST=/^[a-f0-9]{32}$/;
const PHASES={breadth:'Breadth: the whole story first',depth:'Depth: the details that matter',closing:'Closing',focused:'Focused: the proof requested'};
const STATES={reported:'reported',uncertain:'uncertain',unknown:'unknown',deferred:'left open',empty:'not yet'};
const GAP_WORDS={answered_unverified:'answered · unverified',unknown:'unknown',deferred:'deferred',open:'open'};
const NEEDS={measure:'what is measured','before/after':'before and after values',unit:'the unit',period:'the periods',population:'who was measured'};
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{},arr=v=>Array.isArray(v)?v:[],str=(v,n)=>typeof v==='string'?v.slice(0,n):'';
const num=v=>typeof v==='number'&&isFinite(v)?v:null;
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const body=id=>$(id).querySelector('.board-body');
const clock=v=>{v=Math.max(0,Math.round(v||0));return Math.floor(v/60)+':'+String(v%60).padStart(2,'0');};
// A new item may animate only when motion is allowed: the reduced-motion preference and the orb's pause both stop it.
const motionOK=()=>!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)&&!document.querySelector('.motion-paused');
// The board shows the ledger's own flags, but never the words verified/confirmed/approved, not even negated.
const flagText=f=>f.replace(/^No verified measurement\b/i,'No measurement recorded');
const fieldLabel=f=>{const x=obj(window.ATLAS_POLICY&&window.ATLAS_POLICY.FIELDS)[f];return Array.isArray(x)?str(x[0],80):'';};

let s=blank(),prev=null,seq=0,ticker=null,mapKey=null,said='',pending='',saidAt=0,sayTimer=null,gap=null,editors=new Map();
function blank(){return {quality:null,qualitySeq:null,heard:[],session:{},live:false,off:false};}
function state(){return {quality:s.quality,heard:s.heard,qualitySeq:s.qualitySeq,session:s.session,now:Date.now(),policy:window.ATLAS_POLICY,geo:window.AtlasGeo};}

/* ---------- Rendering ---------- */
function render(){
 board.hidden=s.off||!s.live;if(board.hidden)return;
 const m=B.model(state()),fresh=new Set(motionOK()?B.diff(prev,m):[]);prev=m;
 $('boardCoverage').textContent=m.coverage.present+'/'+m.coverage.total+' · '+m.coverage.meaning;
 renderTime(m.time);renderGaps(m,fresh);renderMap(m,fresh);renderMetrics(m,fresh);renderDims(m,fresh);renderChallenge(m);
 announce(B.summaryText(m));}
function renderTime(t){const sec=$('boardTime');sec.hidden=t.max===null;if(t.max===null)return;
 $('boardTimeLeft').textContent=clock(t.left)+' left';$('boardPhase').textContent=t.phase?PHASES[t.phase]:'';sec.dataset.phase=t.phase||'';
 $('boardTimeBar').style.width=(t.max?Math.min(100,100*t.elapsed/t.max):0).toFixed(1)+'%';}
function renderGaps(m,fresh){const sec=$('boardGaps'),list=body('boardGaps');sec.hidden=!m.gaps.length;list.replaceChildren();
 const asks=new Map(arr(s.session.gaps).map(a=>[obj(a).id,obj(a)]));
 for(const g of m.gaps){const li=el('li','board-gap'+(fresh.has('gap:'+g.id+':'+g.status)?' is-new':''));li.dataset.status=g.status;
  li.append(el('b','',g.label),el('span','board-gap-status',GAP_WORDS[g.status]||'open'));
  const ask=str(asks.get(g.id)&&asks.get(g.id).ask,200);if(ask)li.append(el('p','board-note',ask));list.append(li);}}
function renderMap(m,fresh){const G=window.AtlasGeo,key=m.pins.map(p=>p.code).join(',')+'|'+m.placesNotMapped.join('|');
 if(key===mapKey)return;mapKey=key;const box=body('boardMap');box.replaceChildren();  // the SVG is rebuilt only when the places change
 if(m.pins.length&&G&&typeof G.worldSVG==='function'){
  const states={},titles={};for(const p of m.pins){states[p.code]='interview';titles[p.code]=p.name+': mentioned in the interview (not necessarily the project location)';}
  const fig=el('div','board-map');setHTML(fig,(trusted(G.worldSVG({states,titles,idPrefix:'board',aspect:16/10}))||html``));  // AtlasGeo escapes every title
  const svg=fig.querySelector('svg'),vb=svg?(svg.getAttribute('viewBox')||'').split(/\s+/).map(Number):[];
  if(svg&&vb.length===4&&typeof G.labelPoint==='function')for(const p of m.pins){const pt=G.labelPoint(p.code);if(!pt)continue;
   const pin=document.createElementNS(SVG,'circle'),t=document.createElementNS(SVG,'title');
   pin.setAttribute('class','board-pin'+(fresh.has('pin:'+p.code)?' is-new':''));pin.setAttribute('data-code',p.code);
   pin.setAttribute('cx',String(pt[0]));pin.setAttribute('cy',String(pt[1]));pin.setAttribute('r',(vb[2]*.014).toFixed(2));
   t.textContent=titles[p.code];pin.append(t);svg.append(pin);}
  box.append(fig,el('p','board-note','Mentioned in the interview (not necessarily the project location): '+m.pins.map(p=>p.name).join(', ')));}
 else box.append(el('p','board-empty','No country named after a place word such as “in”, “to” or “across” yet.'));
 if(m.placesNotMapped.length)box.append(el('p','board-note','Not mapped: '+m.placesNotMapped.join(', ')));}
function renderMetrics(m,fresh){const box=body('boardMetrics');box.replaceChildren();
 if(m.metrics.length){const list=el('ul','board-chips');
  for(const x of m.metrics){const chip=el('li','board-chip'+(fresh.has('metric:'+x.detailId+'|'+x.text)?' is-new':''));chip.dataset.detail=x.detailId;
   chip.append(el('b','',x.text));if(x.unitUnclear)chip.append(el('span','board-flag',' (unit unclear)'));if(x.status==='uncertain')chip.append(el('span','board-flag',' · estimate'));
   const f=fieldLabel(x.field);if(f)chip.title=f;list.append(chip);}
  box.append(list);}
 else box.append(el('p','board-empty','No figures yet. A number appears here exactly as you said it.'));
 if(m.measurementSlots.length){const list=el('ul','board-chips');for(const n of m.measurementSlots)list.append(el('li','board-chip board-slot','to recover: '+NEEDS[n.need]));box.append(list);}
 if(m.corrected.length)box.append(el('p','board-corrected',m.corrected.length===1?'corrected: your correction replaced one earlier account':'corrected: your corrections replaced '+m.corrected.length+' earlier accounts'));}
function renderDims(m,fresh){const list=body('boardDims');list.replaceChildren();
 for(const d of m.dims){const li=el('li','board-dim'+(fresh.has('dim:'+d.field+':'+d.state)?' is-new':''));li.dataset.state=d.state;li.dataset.field=d.field;
  li.append(el('b','',d.label),el('span','',STATES[d.state]+(d.count>1?' · '+d.count:'')));list.append(li);}}
function renderChallenge(m){const c=m.challenge,box=body('boardChallenge');box.replaceChildren();
 if(c.analysing)box.append(el('p','board-analysing','analysing…'));
 if(c.planned)box.append(el('p','board-question',c.planned));else box.append(el('p','board-empty','Nothing planned yet.'));
 if(c.next)box.append(el('p','board-note','About: '+c.next.label));
 for(const f of c.flags)box.append(el('p','board-note board-warn',flagText(f)));
 if(c.deferred.length)box.append(el('p','board-note','Left open for later: '+c.deferred.map(f=>fieldLabel(f)||f).join(', ')));
 if(c.route)box.append(el('p','board-note','Story route: '+c.route));}
// The polite live region changes at most once every 10 seconds, always to the latest summary.
function announce(text){pending=text;if(text===said&&!sayTimer)return;const wait=saidAt+10000-Date.now();if(wait<=0)flush();else if(!sayTimer)sayTimer=setTimeout(flush,wait);}
function flush(){sayTimer=null;if(pending===said)return;said=pending;saidAt=Date.now();$('boardSummary').textContent=said;}

/* ---------- Session lifecycle ---------- */
function tick(){if(board.hidden)return;renderTime(B.model({session:s.session,now:Date.now()}).time);}
function startTicker(){stopTicker();ticker=setInterval(tick,1000);}
function stopTicker(){if(ticker!==null)clearInterval(ticker);ticker=null;}
function clear(){stopTicker();clearTimeout(sayTimer);sayTimer=null;s=blank();prev=null;mapKey=null;said=pending='';saidAt=0;gap=null;editors.clear();
 try{if(window.sessionStorage&&typeof window.sessionStorage.removeItem==='function')window.sessionStorage.removeItem('atlas-readback-draft');}catch{}
 const read=$('boardReadback');if(read)read.replaceChildren();
 board.hidden=true;$('boardSummary').textContent='';$('boardCoverage').textContent='';$('boardTime').hidden=true;$('boardGaps').hidden=true;
 for(const id of ['boardGaps','boardMap','boardMetrics','boardDims','boardChallenge'])body(id).replaceChildren();
 renderGap();$('gapMessage').textContent='';}
function stopClock(){if(s.session.readyAt&&!s.session.stoppedAt)s.session.stoppedAt=Date.now();stopTicker();}
window.addEventListener('atlas-quality',e=>{const d=e.detail;if(!d||typeof d!=='object')return;
 if(d.type==='reset')clear();
 else if(d.type==='quality'){s.quality=d;s.qualitySeq=++seq;s.live=true;render();}  // accepted after audio_stopped too: the analyst finishes late
 else if(d.type==='user_text'&&typeof d.text==='string'){s.heard.push({item_id:str(d.item_id,160),text:d.text.slice(0,2000),seq:++seq});
  if(s.heard.length>40)s.heard.splice(0,s.heard.length-40);s.live=true;render();}});
window.addEventListener('atlas-session',e=>{const d=e.detail;if(!d||typeof d!=='object')return;
 if(d.type==='reset')clear();
 else if(d.type==='ready'){clear();const max=num(d.maxSeconds);
  s.session={readyAt:Date.now(),maxSeconds:max!==null&&max>0?max:null,mode:d.mode==='gap'?'gap':'full',gaps:arr(d.gaps).filter(g=>g&&typeof g==='object').slice(0,5),timePlan:obj(d.timePlan)};
  s.off=d.liveLedger===false;s.live=true;if(!s.off&&s.session.maxSeconds)startTicker();render();}
 else if(d.type==='audio_stopped'){stopClock();render();}
 else if(d.type==='ended'){stopClock();s.qualitySeq=++seq;render();}  // nothing is being analysed once the session has ended
 else if(d.type==='notes'){if(d.mode==='gap')showGap(d);}
 else if(d.type==='time_up'||d.type==='wrap_up')render();
 else if(d.type==='summary')renderSummary(d.items);});
// A typed correction lives in this page, and in sessionStorage once Save draft is used.
// Without storage the live region says a reload drops the draft.
const DRAFT_KEY='atlas-readback-draft';
function draftStore(){try{const store=window.sessionStorage;if(!store||typeof store.getItem!=='function'||typeof store.setItem!=='function')return null;return store;}catch{return null;}}
function readDrafts(){const store=draftStore();if(!store)return null;try{const raw=store.getItem(DRAFT_KEY);const o=raw?JSON.parse(raw):{};return o&&typeof o==='object'&&!Array.isArray(o)?o:{};}catch{return null;}}
function writeDrafts(map){const store=draftStore();if(!store)return false;try{store.setItem(DRAFT_KEY,JSON.stringify(map));return true;}catch{return false;}}
function readbackLive(){let live=$('boardReadbackLive');if(!live){live=el('p','board-live','');live.id='boardReadbackLive';live.ariaLive='polite';board.append(live);}return live;}
// A late summary rebuilds the editor. Text already typed, including on a row that is not focused, is copied onto the new input.
function renderSummary(items){
 const list=arr(items).filter(x=>x&&typeof x.detail_id==='string').slice(0,100);
 let box=$('boardReadback');
 if(!box){box=el('section','board-readback');box.id='boardReadback';board.append(box);}
 const focused=document.activeElement&&document.activeElement.dataset?document.activeElement.dataset.detail:'';
 for(const input of box.querySelectorAll('input'))if(input.dataset&&input.dataset.detail)editors.set(input.dataset.detail,input.value);
 box.replaceChildren();
 const stored=readDrafts(),live=readbackLive();
 live.textContent=stored===null?'A reload drops this draft.':'Summary ready to correct.';
 const ul=el('ul','board-readback-list');
 for(const item of list){
  const li=el('li'),input=document.createElement('input'),name=str(item.label,80)||'Detail';
  const fieldId='readback-'+str(item.detail_id,80).replace(/[^A-Za-z0-9_-]/g,'');
  li.append(el('p','board-quote',name+': '+str(item.quote,1800)));
  const label=el('label','board-field',name);label.htmlFor=fieldId;
  const keep=el('button','board-keep','Keep private');keep.type='button';keep.dataset.action='withhold';keep.dataset.detail=item.detail_id;
  keep.addEventListener('click',()=>{if(typeof window.dispatchEvent==='function')window.dispatchEvent(new CustomEvent('atlas-withhold',{detail:{detail_id:item.detail_id}}));});
  input.id=fieldId;input.ariaLabel=name+' correction';input.dataset.detail=item.detail_id;
  input.value=editors.has(item.detail_id)?editors.get(item.detail_id):(stored&&typeof stored[item.detail_id]==='string'?stored[item.detail_id]:'');
  input.addEventListener('input',()=>editors.set(item.detail_id,input.value));
  li.append(label,input,keep);ul.append(li);}
 const save=el('button','board-save','Save draft');save.type='button';
 save.addEventListener('click',()=>{
  const drafts=readDrafts()||{};
  for(const input of ul.querySelectorAll('input'))if(input.dataset&&input.dataset.detail){drafts[input.dataset.detail]=input.value;editors.set(input.dataset.detail,input.value);}
  live.textContent=writeDrafts(drafts)?'Draft saved on this device.':'A reload drops this draft.';
 });
 box.append(ul,save);
 if(focused)for(const input of ul.querySelectorAll('input'))if(input.dataset.detail===focused){input.focus();break;}}

/* ---------- Proof answers after a gap interview (F2.1 step 6): two separate explicit clicks ---------- */
function showGap(m){const g=obj(m.gap),app=window.ATLAS_APP;
 gap={requestId:typeof g.requestId==='string'&&REQUEST.test(g.requestId)?g.requestId:null,
  results:arr(g.results).filter(r=>r&&typeof r.askId==='string'&&r.askId).slice(0,5).map(r=>({askId:r.askId.slice(0,20),field:str(r.field,40),
   status:Object.prototype.hasOwnProperty.call(GAP_WORDS,r.status)?r.status:'open',
   quotes:arr(r.quotes).filter(q=>typeof q==='string'&&q.trim()).slice(0,5).map(q=>q.trim().slice(0,400))})),
  asks:arr(s.session.gaps),projectId:app&&typeof app.project==='function'?(app.project()||{}).id||null:null,sending:false,sent:false,applying:false,applied:false};
 $('gapMessage').textContent=gap.requestId?'':'This proof request cannot be answered from here.';renderGap();}
function renderGap(){panel.hidden=!gap;if(!gap)return;const box=$('gapResults');box.replaceChildren();const asks=new Map(gap.asks.map(a=>[obj(a).id,obj(a)]));
 for(const r of gap.results){const a=asks.get(r.askId)||{},item=el('div','gap-result'),head=el('p','gap-result-head');item.dataset.status=r.status;
  head.append(el('b','',str(a.label,80)||fieldLabel(r.field)||r.askId),el('span','board-gap-status',GAP_WORDS[r.status]));item.append(head);
  if(str(a.ask,200))item.append(el('p','board-note',str(a.ask,200)));
  if(r.quotes.length){const list=el('ul','gap-quotes');for(const q of r.quotes){const li=el('li');li.append(el('q','',q));list.append(li);}item.append(list);}
  else item.append(el('p','board-empty','No answer was captured for this item.'));
  item.append(el('p','board-note',LABEL+' · speech recognition'));box.append(item);}
 if(!gap.results.length)box.append(el('p','board-empty','The interview captured no answers for these items.'));
 const send=$('gapSend'),apply=$('gapApply');
 send.disabled=gap.sending||gap.sent||!gap.requestId||!gap.results.length;send.textContent=gap.sent?'Sent to the bid team':gap.sending?'Sending…':'Send these answers to the bid team';
 apply.disabled=gap.applying||gap.applied;apply.textContent=gap.applied?'Added to your reference':gap.applying?'Adding…':'Add these answers to my reference';}
// The interviewed project: the one holding these proof answers, else the one current when the answers arrived.
function interviewed(g){const app=window.ATLAS_APP;let ps=[];try{ps=arr(app.profile().projects);}catch(e){ps=[];}
 return ps.find(p=>p&&p.gapNotes&&p.gapNotes.requestId===g.requestId)||ps.find(p=>p&&p.id===g.projectId)||(typeof app.project==='function'?app.project():null);}
$('gapSend').addEventListener('click',async()=>{const g=gap,app=window.ATLAS_APP;if(!g||g.sending||g.sent||!g.requestId||!g.results.length)return;
 if(!app||typeof app.libraryApi!=='function'){$('gapMessage').textContent='The shared library is not available here.';return;}
 g.sending=true;renderGap();$('gapMessage').textContent='Sending your answers…';
 try{const p=interviewed(g);
  await app.libraryApi('/gaps/'+g.requestId+'/answer',{method:'POST',body:{results:g.results.map(r=>({askId:r.askId,status:r.status,quotes:r.quotes})),referenceId:p&&p.library?p.library.id:undefined}});
  g.sent=true;if(p&&typeof app.gapAnswersSent==='function')app.gapAnswersSent(p.id,g.requestId);
  if(gap===g)$('gapMessage').textContent='Sent. The bid team sees these answers labelled unverified, with known client names masked.';}
 catch(e){if(gap===g)$('gapMessage').textContent=(e&&e.message)||'Your answers were not sent.';}
 finally{g.sending=false;if(gap===g)renderGap();}});
$('gapApply').addEventListener('click',async()=>{const g=gap,app=window.ATLAS_APP;if(!g||g.applying||g.applied)return;
 if(!app||typeof app.applyGapNotes!=='function'){$('gapMessage').textContent='This workspace cannot add the answers here.';return;}
 g.applying=true;renderGap();$('gapMessage').textContent='Adding the answers to your reference…';
 try{const p=interviewed(g),r=obj(await app.applyGapNotes(p?p.id:undefined));g.applied=true;
  if(gap===g)$('gapMessage').textContent=r.library?'Added to your reference (revision '+r.library.revision+'). It needs review and N+1 validation again.':'Added to this project’s notes on this device. The shared library was not updated.';}
 catch(e){if(gap===g)$('gapMessage').textContent=(e&&e.message)||'The answers were not added.';}
 finally{g.applying=false;if(gap===g)renderGap();}});
})();
