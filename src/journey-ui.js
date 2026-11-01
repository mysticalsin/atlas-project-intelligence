/* ATLAS journey surfaces (v2.2 W1): the project picker ("Which project?"), the first-run checklist, the Submit moment and the fictional example opened as a finished case study.
   Strict CSP: every sink is textContent or the safe `html` tag; no inline handlers. Nothing here changes what is stored, shared or when: the picker only chooses (or creates, on this device)
   a project, the sheet only reports a Submit that the read-back already made, the example is fixed fictional text and touches no workspace. */
(()=>{'use strict';
const S=window.AtlasStory,$=id=>document.getElementById(id),{html,setHTML}=window.AtlasSafe;
if(!S||!$('voicePanel'))return;
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const app=()=>window.ATLAS_APP||{};
const reduced=()=>!!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);
const KEY='atlas.w1.submitted';
let flag=false;const submittedBefore=()=>{if(flag)return true;try{flag=localStorage.getItem(KEY)==='1';}catch{}return flag;};
const markSubmitted=()=>{flag=true;try{localStorage.setItem(KEY,'1');}catch{}};

/* ---------- the project picker ---------- */
let rows=null,rowsAt=0,pickDone=null,lastFocus=null;
async function staffingRows(){if(rows&&Date.now()-rowsAt<30000)return rows;rows=[];rowsAt=Date.now();
 try{const A=app(),b=A.bootInfo?await A.bootInfo():null;if(b&&b.library&&b.features&&b.features.staffing&&typeof A.libraryApi==='function'){const r=await A.libraryApi('/staffing/mine');rows=Array.isArray(r&&r.items)?r.items.slice(0,50):[];}}catch{rows=[];}
 return rows;}
const own=()=>{try{return typeof app().ownProjects==='function'?app().ownProjects():[];}catch{return [];}};
// Start asks the picker only when the person has staffing rows and no project is selected yet (the picker then also lists the projects on this device); everyone else goes straight on (ATLAS creates the project from the story).
async function needsPick(){let c=null;try{c=window.ATLAS_VOICE_BRIDGE&&window.ATLAS_VOICE_BRIDGE.context();}catch{}if(!c||!c.isNew)return false;return (await staffingRows()).length>0;}
let dlg=null;
function build(){const d=document.createElement('dialog');d.id='projectPickDialog';d.className='pick-dialog w1-dark';d.setAttribute('aria-labelledby','projectPickTitle');
 setHTML(d,html`<div class="dialog-head"><div><p class="eyebrow">Step 1 of 3</p><h2 id="projectPickTitle">Which project?</h2></div><button aria-label="Close" class="close" data-pick-close="" type="button">×</button></div>
<label class="fit-sr" for="projectPickSearch">Search your projects</label><input autocomplete="off" class="pick-search" id="projectPickSearch" placeholder="Search by name or ID" type="search"/>
<ul class="pick-list" id="projectPickList"></ul><p class="pick-empty" hidden="" id="projectPickEmpty" role="status"></p>
<div class="actions"><button class="btn" id="projectPickOther" type="button">Something else</button></div>`);
 document.body.append(d);
 d.addEventListener('click',e=>{if(e.target.closest('[data-pick-close]'))d.close();});
 d.addEventListener('close',()=>{const done=pickDone;pickDone=null;if(done)done(false);try{lastFocus&&lastFocus.focus&&lastFocus.focus({preventScroll:true});}catch{}});
 $('projectPickSearch').addEventListener('input',paintList);
 $('projectPickOther').addEventListener('click',()=>{const done=pickDone;pickDone=null;d.close();pickDone=null;openForm(done);});
 return d;}
function finish(ok){const done=pickDone;pickDone=null;if(dlg&&dlg.open)dlg.close();if(done)done(ok);}
function paintList(){const list=$('projectPickList'),m=S.pickerModel(rows||[],own(),$('projectPickSearch').value);list.replaceChildren();
 for(const x of m.items){const li=el('li'),b=el('button','pick-row');b.type='button';b.dataset.key=x.key;
  const t=el('span','pick-title',x.title),s=el('span','pick-sub',[x.kind==='staffing'?'From your staffing list':'On this device',x.ref?'Ref '+x.ref:'',x.when?'ends '+x.when:'',x.detail].filter(Boolean).join(' · '));
  b.append(t,s);b.addEventListener('click',()=>choose(x));li.append(b);list.append(li);}
 const empty=$('projectPickEmpty');empty.hidden=!!m.items.length;empty.textContent=m.items.length?'':m.empty?'No staffing rows or projects yet. Choose “Something else” and name your project.':'Nothing matches. Choose “Something else” to add it.';}
function choose(x){const A=app();
 if(x.kind==='staffing'){const v=S.staffingValues(x.row,{});const id=A.projectFromStaffing&&A.projectFromStaffing(v);if(!id)return;finish(true);return;}
 if(typeof A.selectProject==='function')A.selectProject(x.project.id);finish(true);}
// "Something else": the three-field form. Saving it (the form dispatches atlas-project-saved) is a chosen project; closing it is not.
function openForm(done){const A=app();if(typeof A.newProject!=='function'){if(done)done(false);return;}
 const f=$('projectDialog');let saved=false;const onSaved=()=>{saved=true;};window.addEventListener('atlas-project-saved',onSaved,{once:true});
 f.addEventListener('close',()=>{window.removeEventListener('atlas-project-saved',onSaved);if(done)done(saved);},{once:true});A.newProject();}
async function pick(){if(pickDone)return false;await staffingRows();dlg=dlg||build();lastFocus=document.activeElement;$('projectPickSearch').value='';paintList();
 return new Promise(res=>{pickDone=res;if(!dlg.open)dlg.showModal();$('projectPickSearch').focus({preventScroll:true});});}
window.AtlasJourney={needsPick,pick,staffingRows:()=>staffingRows()};

/* ---------- the first-run checklist ---------- */
function firstRun(){const card=$('firstRun'),panel=$('voicePanel');if(!card)return;
 const show=!submittedBefore();card.hidden=!show;panel.dataset.firstrun=String(show);if(!show){card.replaceChildren();return;}
 const phase=panel.dataset.phase||'idle',hasProject=document.body.classList.contains('has-voice-project'),sum=panel.dataset.summary==='true';
 const live=phase==='live'||phase==='ending',p1=hasProject||live||sum,state=[p1?'done':'current',sum?'done':(p1?'current':'todo'),sum?'current':'todo'];
 const key=state.join();if(card.dataset.key===key)return;card.dataset.key=key;
 setHTML(card,html`<div class="card-heading firstrun-title">Your first interview in three steps</div><ol class="firstrun-steps">${S.FIRST_RUN_STEPS.map((s,i)=>html`<li data-state="${state[i]}"><span class="firstrun-n" aria-hidden="true">${state[i]==='done'?'✓':String(i+1)}</span><span class="firstrun-text"><b>${s.title}</b><small>${s.note}</small></span></li>`)}</ol><button class="btn firstrun-pick" hidden="" id="firstRunPick" type="button">Pick your project</button><p class="firstrun-private">${S.FIRST_RUN_PRIVACY}</p>`);
 const b=$('firstRunPick');b.hidden=state[0]==='done';b.addEventListener('click',()=>{pick();});}
new MutationObserver(firstRun).observe($('voicePanel'),{attributes:true,attributeFilter:['data-phase','data-summary']});
new MutationObserver(firstRun).observe(document.body,{attributes:true,attributeFilter:['class']});
window.addEventListener('atlas-context',firstRun);firstRun();

/* ---------- the Submit moment ---------- */
let sheet=null,sheetOpen=false;
function buildSheet(){const d=document.createElement('dialog');d.id='submitSheet';d.className='submit-sheet';d.setAttribute('aria-labelledby','submitTitle');d.setAttribute('aria-describedby','submitLine');
 setHTML(d,html`<div class="submit-body" role="status"><svg aria-hidden="true" class="submit-check" focusable="false" viewBox="0 0 64 64"><circle class="submit-ring" cx="32" cy="32" r="29"></circle><path class="submit-tick" d="M19 33.5l9.5 9.5L46 23"></path></svg><h2 id="submitTitle">Sent for review</h2><p id="submitLine">${S.SUBMIT_LINE}</p></div>
<ol aria-label="What happens next" class="submit-steps">${S.SUBMIT_STEPS.map((s,i)=>html`<li data-state="${i===0?'done':i===1?'next':'todo'}"><span class="submit-dot" aria-hidden="true"></span><span>${s}</span></li>`)}</ol>
<div class="actions"><button class="btn primary" id="submitView" type="button">View status</button><button class="btn" id="submitAnother" type="button">Start another</button></div>`);
 document.body.append(d);
 d.addEventListener('close',()=>{sheetOpen=false;});
 $('submitView').addEventListener('click',()=>{d.close();const A=app();if(typeof A.switchView==='function')A.switchView('library');});
 $('submitAnother').addEventListener('click',()=>{d.close();startAnother();});
 return d;}
function startAnother(){try{const st=window.AtlasVoice&&window.AtlasVoice.status().phase;if(['connecting','live','ending'].includes(st))window.AtlasVoice.cancel('Submitted. Ready for another project.');}catch{}
 window.dispatchEvent(new CustomEvent('atlas-session',{detail:{type:'reset'}}));window.dispatchEvent(new CustomEvent('atlas-quality',{detail:{type:'reset'}}));
 const A=app();if(typeof A.switchView==='function')A.switchView('interview');setTimeout(()=>{pick();},60);}
function showSheet(){sheet=sheet||buildSheet();sheetOpen=true;if(!sheet.open)sheet.showModal();$('submitView').focus({preventScroll:true});}
window.addEventListener('atlas-submitted',()=>{markSubmitted();firstRun();showSheet();});

/* ---------- a fictional example, as the finished case study ---------- */
const FICTION=[
 ['problem','A fictional operations team routed service tickets using inconsistent intake categories.'],
 ['stakes','Manual interpretation made triage difficult to standardize.'],
 ['intervention','I built the Python ingestion pipeline and normalization rules.'],
 ['decision','We chose explicit categories and routing rules rather than an autonomous agent.'],
 ['contribution','Theo tested routing behavior and exception cases. The lead architect owned target architecture; I did not own the wider solution design.'],
 ['adoption','Operations staff tested the exceptions, agreed escalation owners and adopted the pilot workflow. The service owner took responsibility after handover.'],
 ['outcome','Median triage time went from 42 minutes to 26 minutes in the pilot, with 180 tickets in each cohort.'],
 ['measurement','This is a before-and-after observation, not proof of causality or financial savings.'],
 ['evidence','The synthetic pilot acceptance record lists the roles, scope, routing approach and a measurement worksheet.'],
 ['customer_fit','This example is relevant to operations leaders with inconsistent service queues and a comparable baseline.'],
 ['poor_fit','It is a poor fit where intake cannot be standardized or local ownership is missing.']];
let exDlg=null,exFocus=null;
function example(){const policy=window.ATLAS_POLICY||{},B=window.AtlasBoard;exFocus=document.activeElement;
 const label=f=>{const x=policy.FIELDS&&policy.FIELDS[f];return Array.isArray(x)?String(x[0]):f;};
 const items=FICTION.map(([f,q],i)=>({id:'D-9'+String(i).padStart(2,'0'),field:f,label:label(f),quote:q,tags:[],editable:false}));
 const spans=q=>policy.NUMERIC_SRC&&B?B.metricSpans(q,policy.NUMERIC_SRC):[];
 const cs=S.caseStudy({items},{spans});
 if(!exDlg){exDlg=document.createElement('dialog');exDlg.id='exampleDialog';exDlg.className='example-sheet';exDlg.setAttribute('aria-labelledby','exampleTitle');
  setHTML(exDlg,html`<div class="example-banner" role="note"><b>Fictional example</b><span>Not a real project. Nothing here comes from anyone’s interview.</span><button aria-label="Close the example" class="btn" id="exampleClose" type="button">Close</button></div>
<div class="example-scroll"><p class="eyebrow">What your read-back looks like</p><h2 id="exampleTitle">Making service-ticket triage more consistent</h2><div class="story-blocks" id="exampleBody"></div></div>
<div class="example-foot"><span>This is built only from the person’s own words, grouped for reading.</span><button class="btn primary" id="exampleStart" type="button">Start my own</button></div>`);
  document.body.append(exDlg);
  exDlg.addEventListener('close',()=>{try{exFocus&&exFocus.focus&&exFocus.focus({preventScroll:true});}catch{}});
  $('exampleClose').addEventListener('click',()=>exDlg.close());
  $('exampleStart').addEventListener('click',()=>{exDlg.close();setTimeout(()=>{pick().then(ok=>{if(ok)document.getElementById('voiceStart')?.hidden===false?document.getElementById('voiceStart').focus():document.getElementById('voiceStartText')?.focus();});},0);});}
 const root=$('exampleBody');root.replaceChildren();
 if(cs.numbers){const n=cs.numbers,box=el('section','story-numbers');box.dataset.kind=n.kind;
  if(n.kind==='beforeAfter'){const a=el('div','story-num'),b=el('div','story-num');a.append(el('small','','Before'),el('b','',n.before.text));b.append(el('small','','After'),el('b','',n.after.text));box.append(a,el('span','story-arrow','→'),b);}
  else for(const f of n.figures){const d=el('div','story-num');d.append(el('small','',f.label),el('b','',f.text));box.append(d);}
  root.append(box);}
 for(const sec of cs.sections){const block=el('section','story-block'),ul=el('ul','story-quotes');block.dataset.block=sec.id;
  for(const q of sec.quotes){const li=el('li','summary-item'),head=el('p','summary-item-head');head.append(el('b','',q.label));const quote=el('q','summary-quote',q.quote);li.append(head,quote);ul.append(li);}
  block.append(el('h3','story-block-title',sec.title),ul);root.append(block);}
 if(!exDlg.open)exDlg.showModal();$('exampleClose').focus({preventScroll:true});}
window.AtlasJourneyUI={example,sheetShowing:()=>sheetOpen,showSheet,markSubmitted,firstRunDone:submittedBefore};
})();
