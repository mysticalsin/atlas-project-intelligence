/* ATLAS live story board in the Conversation view (WOW_SPEC F5.2) and the proof answers after a gap interview (F2.6, T5).
   Driven only by window events: 'atlas-quality' (quality, user_text, user_text_private, reset) and 'atlas-session' (ready, time_up, wrap_up,
   audio_stopped, reporting, notes, ended, reset). Never by agent_text, and no requestAnimationFrame: the countdown is a
   one-second interval that only runs between ready and the end of the audio. All text goes through textContent; the only
   markup inserted is AtlasGeo's own escaped map SVG. Nothing leaves the browser except on an explicit click of #gapSend. */
(()=>{'use strict';
const {setHTML,trusted}=window.AtlasSafe;
const $=id=>document.getElementById(id),B=window.AtlasBoard,board=$('storyBoard'),panel=$('gapPanel');
if(!B||!board||!panel)return;
// Resuming an interview (T11): the server says how many interview seconds had been used, so the clock goes on from there and does not restart at zero.
const used=d=>d.resumed===true&&num(d.activeSeconds)!==null&&d.activeSeconds>0?d.activeSeconds*1000:0;
const LABEL='From the interview · unverified',SVG='http://www.w3.org/2000/svg',REQUEST=/^[a-f0-9]{32}$/;
const PHASES={breadth:'Breadth: the whole story first',depth:'Depth: the details that matter',closing:'Closing',focused:'Focused: the proof requested'};
const STATES={reported:'reported',uncertain:'uncertain',unknown:'still open',deferred:'still open',empty:'not yet'};
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

let s=blank(),prev=null,seq=0,ticker=null,mapKey=null,said='',pending='',saidAt=0,sayTimer=null,gap=null;
function blank(){return {quality:null,qualitySeq:null,heard:[],session:{},live:false,off:false};}
function state(){return {quality:s.quality,heard:s.heard,qualitySeq:s.qualitySeq,session:s.session,now:Date.now(),policy:window.ATLAS_POLICY,geo:window.AtlasGeo};}

/* ---------- Rendering ---------- */
function render(){
 board.hidden=s.off||!s.live;if(board.hidden)return;
 const m=B.model(state()),fresh=new Set(motionOK()?B.diff(prev,m):[]);prev=m;
 $('boardCoverage').textContent=m.coverage.present+'/'+m.coverage.total+' · '+m.coverage.meaning;try{const c=$('captureCount');if(c)$('boardTopics').textContent=(parseInt(c.textContent,10)||0)+' of 6 topics saved · '+m.coverage.present+' of '+m.coverage.total+' dimensions heard';}catch(e){}
 renderTime(m.time);renderGaps(m,fresh);renderMap(m,fresh);renderMetrics(m,fresh);renderDims(m,fresh);renderChallenge(m);
 announce(B.summaryText(m));}
function renderTime(t){const sec=$('boardTime');sec.hidden=t.max===null;if(t.max===null)return;
 $('boardTimeLeft').textContent=t.soft?clock(t.elapsed)+' · about '+Math.round(t.soft/60)+'–'+Math.round(t.max/60)+' min':clock(t.left)+' left';$('boardPhase').textContent=t.phase?PHASES[t.phase]:'';sec.dataset.phase=t.phase||'';
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
  const fig=el('div','board-map');setHTML(fig,trusted(G.worldSVG({states,titles,idPrefix:'board',aspect:16/10})));  // AtlasGeo escapes every title
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
 if(c.deferred.length)box.append(el('p','board-note','Still open: '+c.deferred.map(f=>fieldLabel(f)||f).join(', ')));
 if(c.route)box.append(el('p','board-note','Story route: '+c.route));}
// The polite live region changes at most once every 10 seconds, always to the latest summary.
function announce(text){pending=text;if(text===said&&!sayTimer)return;const wait=saidAt+10000-Date.now();if(wait<=0)flush();else if(!sayTimer)sayTimer=setTimeout(flush,wait);}
function flush(){sayTimer=null;if(pending===said)return;said=pending;saidAt=Date.now();$('boardSummary').textContent=said;}

/* ---------- Session lifecycle ---------- */
function tick(){if(board.hidden)return;renderTime(B.model({session:s.session,now:Date.now()}).time);}
function startTicker(){stopTicker();ticker=setInterval(tick,1000);}
function stopTicker(){if(ticker!==null)clearInterval(ticker);ticker=null;}
function clear(){stopTicker();clearTimeout(sayTimer);sayTimer=null;s=blank();prev=null;mapKey=null;said=pending='';saidAt=0;gap=null;
 board.hidden=true;$('boardSummary').textContent='';$('boardCoverage').textContent='';$('boardTime').hidden=true;$('boardGaps').hidden=true;
 for(const id of ['boardGaps','boardMap','boardMetrics','boardDims','boardChallenge'])body(id).replaceChildren();
 renderGap();$('gapMessage').textContent='';}
function stopClock(){if(s.session.readyAt&&!s.session.stoppedAt)s.session.stoppedAt=Date.now();stopTicker();}
window.addEventListener('atlas-quality',e=>{const d=e.detail;if(!d||typeof d!=='object')return;
 if(d.type==='reset')clear();
 else if(d.type==='quality'){s.quality=d;s.qualitySeq=++seq;s.live=true;render();}  // accepted after audio_stopped too: the analyst finishes late
 else if(d.type==='user_text'&&typeof d.text==='string'){s.heard.push({item_id:str(d.item_id,160),text:d.text.slice(0,2000),seq:++seq});
  if(s.heard.length>40)s.heard.splice(0,s.heard.length-40);s.live=true;render();}
 else if(d.type==='user_text_private'&&Array.isArray(d.items)){const set=new Set(d.items.filter(x=>typeof x==='string'));  // kept private: the board forgets the words of those utterances too
  for(const h of s.heard)if(set.has(h.item_id))h.text='[kept private]';render();}});
window.addEventListener('atlas-session',e=>{const d=e.detail;if(!d||typeof d!=='object')return;
 if(d.type==='reset')clear();
 else if(d.type==='ready'){clear();const max=num(d.maxSeconds);
  s.session={readyAt:Date.now()-used(d),maxSeconds:max!==null&&max>0?max:null,softSeconds:num(d.softSeconds),mode:d.mode==='gap'?'gap':'full',gaps:arr(d.gaps).filter(g=>g&&typeof g==='object').slice(0,5),timePlan:obj(d.timePlan)};
  s.off=d.liveLedger===false;s.live=true;if(!s.off&&s.session.maxSeconds)startTicker();render();}
 else if(d.type==='time_extended'){const max=num(d.maxSeconds);if(max!==null&&max>0)s.session.maxSeconds=max;if(d.timePlan&&typeof d.timePlan==='object')s.session.timePlan=obj(d.timePlan);render();}  // the consultant agreed to a few more minutes
 else if(d.type==='audio_stopped'){stopClock();render();}
 else if(d.type==='ended'){stopClock();s.qualitySeq=++seq;render();}  // nothing is being analysed once the session has ended
 else if(d.type==='notes'){if(d.mode==='gap')showGap(d);}
 else if(d.type==='time_up'||d.type==='wrap_up')render();});

/* ---------- The read-back card (T11, plan 3h, D19, Tony Q2) ----------
   Driven by the server's `summary`, `summary_closed`, `summary_confirmed`, `evidence_draft` and `evidence_draft_unavailable` session events. Each button only asks
   voice-client.js to send one message ('atlas-summary-action'); nothing is saved by the card itself. Confirming makes a PRIVATE draft (the server does that); sending
   it to the reviewer is the separate Submit for review click below, a library POST with the revision the person saw. All text goes through textContent. */
const card=$('summaryCard'),CONFIRM_WAIT_MS=15000;
let sum=null,confirmTimer=null;
function sumAct(kind,id,text){window.dispatchEvent(new CustomEvent('atlas-summary-action',{detail:{kind,detail_id:id,text}}));}
function sumNote(text){const m=$('summaryMessage');if(m)m.textContent=text||'';}
function sumClear(){clearTimeout(confirmTimer);confirmTimer=null;sum=null;sumNote('');renderSummary();}
// The read-back is the one step that must not be missed: the first time it shows, the page brings it to the top and puts focus on its title (reduced motion: no smooth scroll).
function reveal(){try{const reduced=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
 if(typeof card.scrollIntoView==='function')card.scrollIntoView({block:'start',behavior:reduced?'auto':'smooth'});
 const t=$('summaryTitle');if(t&&typeof t.focus==='function')t.focus({preventScroll:true});}catch(e){}}
function renderSummary(){if(!card)return;
 const v=B.summaryView(sum),panel=$('voicePanel');card.hidden=!v.visible;if(panel&&panel.dataset){panel.dataset.summary=String(v.visible);panel.dataset.readback=String(v.visible&&(v.phase==='open'||v.phase==='confirming'));} // readback: the card is asking for a decision, so it replaces the answer box and the controls until it is confirmed
 if(!v.visible){if(card.dataset)card.dataset.shown='';return;}
 if(card.dataset&&card.dataset.shown!=='1'){card.dataset.shown='1';setTimeout(reveal,0);}
 $('summaryTitle').textContent=v.title;$('summaryIntro').textContent=sum.phase==='open'||sum.phase==='confirming'?v.intro:'';
 const list=$('summaryItems');list.replaceChildren();
 for(const it of v.items){const li=el('li','summary-item');li.dataset.detail=it.id;
  const head=el('p','summary-item-head');head.append(el('b','',it.label));for(const t of it.tags)head.append(el('span','board-flag',' · '+t));
  const quote=el('q','summary-quote',it.quote);quote.setAttribute('dir','auto');if(it.lang){quote.setAttribute('lang',it.lang);if(it.lang!=='en')head.append(el('span','board-flag',' · '+it.lang.toUpperCase()));} /* the words stay in the language they were said in; the tag and lang attribute say which */
  li.append(head,quote);
  if(it.editable){const row=el('div','summary-item-actions'),fix=el('button','board-btn','Correct'),keep=el('button','board-btn','Keep private');
   fix.type='button';fix.dataset.action='correct';fix.setAttribute('aria-label','Correct: '+it.label);fix.setAttribute('aria-expanded',sum.editing===it.id?'true':'false');
   keep.type='button';keep.dataset.action='withhold';keep.setAttribute('aria-label','Keep private: '+it.label);
   fix.addEventListener('click',()=>{sum.editing=sum.editing===it.id?null:it.id;sumNote('');renderSummary();const f=card.querySelector&&card.querySelector('.summary-edit input');if(f&&f.focus)f.focus();});
   keep.addEventListener('click',()=>{if(!sum||sum.phase!=='open')return;sumNote('Keeping that private…');sumAct('withhold',it.id);});
   row.append(fix,keep);li.append(row);
   if(sum.editing===it.id){const form=el('div','summary-edit'),input=document.createElement('input'),lab=el('label','','Your correction, in your own words'),save=el('button','board-btn','Save correction'),cancel=el('button','board-btn','Cancel');
    input.type='text';input.id='summaryEdit-'+it.id;input.maxLength=1800;input.setAttribute('autocomplete','off');lab.setAttribute('for',input.id);save.type='button';cancel.type='button';save.dataset.action='save';cancel.dataset.action='cancel';
    const go=()=>{const VC=window.AtlasVoiceControls;if(!sum||sum.phase!=='open')return;
     if(VC&&typeof VC.summaryMessage==='function'&&!VC.summaryMessage('correct',it.id,input.value)){sumNote('Please type at least five characters, so your correction can be kept in your own words.');return;}
     sum.editing=null;sumNote('Sent. The summary updates when ATLAS has your correction.');sumAct('correct',it.id,input.value);renderSummary();};
    save.addEventListener('click',go);cancel.addEventListener('click',()=>{sum.editing=null;sumNote('');renderSummary();});
    input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault&&e.preventDefault();go();}else if(e.key==='Escape'){sum.editing=null;renderSummary();}});
    form.append(lab,input,save,cancel);li.append(form);}}
  list.append(li);}
 const empty=$('summaryEmpty');empty.hidden=!v.empty;empty.textContent=v.empty;
 const open=$('summaryOpen');open.hidden=!v.openPoints.length;const ol=$('summaryOpenList');ol.replaceChildren();for(const t of v.openPoints)ol.append(el('li','',t));
 $('summaryNext').textContent=v.next;$('summaryNext').hidden=v.phase!=='open'&&v.phase!=='confirming'; // the promise before confirming goes stale once it is done
 const c=$('summaryConfirm');c.hidden=v.confirm.hidden;c.disabled=v.confirm.disabled;c.textContent=v.confirm.label;
 const spent=sum.submit&&sum.submit.status==='sent';$('summarySaved').textContent=spent?'':v.saved||v.notSaved; // after Submit one line says where it stands (summaryMessage), not two
 const b=$('summarySubmit');b.hidden=v.submit.hidden||spent;b.disabled=v.submit.disabled;b.textContent=v.submit.label; // spent: the button is not shown a second time
 if(!v.submit.hidden)sumNote(v.submit.message);
 $('summaryLive').textContent=v.live;}
$('summaryConfirm')&&$('summaryConfirm').addEventListener('click',()=>{if(!sum||sum.phase!=='open'||!sum.items.length)return;
 sum.phase='confirming';sum.editing=null;sumNote('');renderSummary();sumAct('confirm_summary');
 clearTimeout(confirmTimer);confirmTimer=setTimeout(()=>{if(sum&&sum.phase==='confirming'){sum.phase='open';sumNote('The confirmation did not go through. Try again, or press End to finish.');renderSummary();}},CONFIRM_WAIT_MS);});
// Submit for review: the person's own click, a library POST with the revision they were shown (the server refuses a stale one). The Worker checks Origin and CSRF as for every library POST.
async function sumStatus(s){const app=window.ATLAS_APP,Core=window.AtlasWorkflowCore,list=$('summaryStatus');
 if(!app||typeof app.libraryApi!=='function'||!Core||!list||!s.draft)return;
 try{const m=Core.model(await app.libraryApi('/evidence/'+encodeURIComponent(s.draft.id)+'/status'));if(sum!==s)return;
  list.replaceChildren();for(const c of m.cards)list.append(el('li','',c.label+': '+c.statusText+(c.badge?' ('+c.badge+')':'')));list.hidden=false;}
 catch(e){list.hidden=true;}
 try{window.AtlasWorkflowUI&&window.AtlasWorkflowUI.refresh();}catch(e){}}
async function sumSubmit(){const s=sum,app=window.ATLAS_APP;if(!s||s.phase!=='confirmed'||!s.draft||s.submit.status==='sending'||s.submit.status==='sent')return;
 if(!app||typeof app.libraryApi!=='function'){s.submit={status:'error',message:'The shared library is not available here.'};renderSummary();return;}
 s.submit={status:'sending'};renderSummary();
 try{const v=await app.libraryApi('/evidence/'+encodeURIComponent(s.draft.id)+'/submit',{method:'POST',body:{expected_revision:s.draft.revision}});
  s.submit={status:'sent'};if(v&&Number.isInteger(v.revision))s.draft={...s.draft,revision:v.revision};
  window.dispatchEvent(new CustomEvent('atlas-submitted'));} // the library story of this interview follows the same explicit click (app.js)
 catch(e){s.submit={status:'error',message:(e&&e.message)||'It was not submitted.'};}
 if(sum===s){renderSummary();sumStatus(s);}}
$('summarySubmit')&&$('summarySubmit').addEventListener('click',sumSubmit);
window.addEventListener('atlas-session',e=>{const d=e.detail;if(!d||typeof d!=='object'||!card)return;
 if(d.type==='ready'||d.type==='reset')sumClear();
 else if(d.type==='summary'){const was=sum&&sum.phase==='open'?sum:null;if(sum&&['confirming','confirmed'].includes(sum.phase))return;
  sum={items:arr(d.items).filter(x=>x&&typeof x==='object').slice(0,60),unknowns:arr(d.unknowns).filter(x=>x&&typeof x==='object').slice(0,12),phase:'open',editing:null,confirmed:false,draft:null,unavailable:null,submit:{status:'idle'}};
  if(was&&was.editing&&sum.items.some(x=>x.detail_id===was.editing))sum.editing=was.editing;sumNote('');renderSummary();}
 else if(d.type==='summary_closed'){if(sum&&sum.phase==='open'){sum.phase='closed';sumNote('');renderSummary();}}
 else if(d.type==='summary_confirmed'){if(sum){sum.confirmed=true;clearTimeout(confirmTimer);confirmTimer=null;if(sum.phase==='open')sum.phase='confirming';renderSummary();}}
 else if(d.type==='evidence_draft'){if(sum){clearTimeout(confirmTimer);confirmTimer=null;sum.phase='confirmed';sum.confirmed=true;
   sum.draft={id:str(d.id,100),revision:Number.isInteger(d.revision)?d.revision:1,unchanged:d.unchanged===true};sum.unavailable=null;sumNote('');renderSummary();sumStatus(sum);}}
 else if(d.type==='evidence_draft_unavailable'){if(sum){clearTimeout(confirmTimer);confirmTimer=null;sum.phase='confirmed';sum.confirmed=true;sum.draft=null;sum.unavailable={reason:str(d.reason,40),message:str(d.message,300)};sumNote('');renderSummary();}}
 else if(d.type==='ended'){if(sum&&['open','confirming'].includes(sum.phase)){clearTimeout(confirmTimer);confirmTimer=null;
   if(sum.confirmed){sum.phase='confirmed';sum.unavailable={reason:'no_answer',message:'The summary was confirmed, but the interview ended before the library answered. Nothing was saved.'};}else sum.phase='ended';renderSummary();}}});

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
