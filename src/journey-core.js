/* ATLAS journey helpers (v2.2 W1): pure functions, no DOM, no network, no clock (the caller passes times). UMD so node tests cover them.
   The read-back as a finished case study: the consultant's own confirmed quotes grouped into Challenge / Approach / Your contribution / Outcome (and the evidence
   and fit lines), a before/after strip only from figures in their words, and where each quote came from. NOTHING here writes a word of its own: every sentence
   on screen is a quote or one of the fixed labels below (a test asserts it). Also: the opening split into two staged bubbles, the project picker's list and the
   values a staffing row fills in, the submit sheet's five steps and the first-run checklist. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AtlasStory=api;})(typeof globalThis!=='undefined'?globalThis:this,()=>{
'use strict';
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{},arr=v=>Array.isArray(v)?v:[],str=(v,n)=>typeof v==='string'?v.slice(0,n):'';

/* ---------- the case study ---------- */
// The twelve ledger fields, grouped the way a reader of a finished case study expects them. Order on screen is this order.
const SECTIONS=[
 {id:'challenge',title:'Challenge',fields:['problem','stakes']},
 {id:'approach',title:'Approach',fields:['intervention','decision']},
 {id:'contribution',title:'Your contribution',fields:['contribution','adoption']},
 {id:'outcome',title:'Outcome',fields:['outcome','measurement']},
 {id:'evidence',title:'Evidence and fit',fields:['evidence','limitations','customer_fit','poor_fit']}];
const SECTION_OF=Object.fromEntries(SECTIONS.flatMap(s=>s.fields.map(f=>[f,s.id])));
const FIXED_LABELS=['Challenge','Approach','Your contribution','Outcome','Evidence and fit','Before','After','Your numbers','From your words','Kept private. Not used.','Correct','Keep private'];

const pad=n=>String(n).padStart(2,'0');
// 10:42, in the viewer's own time zone; '' when there is no usable time.
function clockOf(ts){const n=Number(ts);if(!Number.isFinite(n)||n<=0)return '';const d=new Date(n);return isNaN(d)?'':pad(d.getHours())+':'+pad(d.getMinutes());}
const squash=s=>String(s||'').replace(/[“”"'’]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
// The time a quote was said: the first heard turn (heard: [{text, at}]) that contains the quote; '' when none does (a corrected line, a restored interview).
function timeOf(quote,heard){const q=squash(quote);if(!q)return '';for(const h of arr(heard)){const o=obj(h);if(typeof o.text==='string'&&squash(o.text).includes(q))return clockOf(o.at);}return '';}

// "from 14 days to 6 days": the two figures the consultant put before and after, in their own order. The labels are theirs ("from … to"), never a guess.
const BEFORE_RE=/\bfrom\s*(?:about|around|roughly|nearly|almost|over|under|some|approximately)?\s*$/i,TO_RE=/^\s*(?:down |up |back )?(?:to|→|->)\s*(?:about |around |roughly |approximately )?$/i;
function fromTo(quote,spans){const q=String(quote||''),s=arr(spans);for(let i=0;i+1<s.length;i++){const a=s[i],b=s[i+1];if(BEFORE_RE.test(q.slice(0,a.start))&&TO_RE.test(q.slice(a.end,b.start)))return {before:a,after:b};}return null;}

// view: the summary card's own view (B.summaryView): items with id, field, label, quote, tags, lang. opts.heard: [{text, at}]; opts.kept: Map(id -> item) of what the person
// kept private (shown struck out, never used); opts.spans: quote -> [{text, start, end}] (AtlasBoard.metricSpans); opts.seen: Set of item ids already read.
function caseStudy(view,opts={}){
 const items=arr(obj(view).items),kept=opts.kept instanceof Map?opts.kept:new Map(),heard=arr(opts.heard),spans=typeof opts.spans==='function'?opts.spans:()=>[];
 const live=new Set(items.map(x=>x.id)),pend=opts.keeping instanceof Set?opts.keeping:new Set(),all=[...items.map(x=>({...x,private:false,pending:pend.has(x.id)})),...[...kept.values()].filter(x=>!live.has(x.id)).map(x=>({...x,private:true}))];
 const sections=SECTIONS.map(sec=>{
  const mine=all.filter(x=>SECTION_OF[x.field]===sec.id).sort((a,b)=>sec.fields.indexOf(a.field)-sec.fields.indexOf(b.field));
  const quotes=mine.map(x=>({id:x.id,field:x.field,label:x.label,quote:x.private?'':x.quote,tags:arr(x.tags),lang:x.lang||'',editable:x.editable===true&&!x.private&&x.pending!==true,pending:x.pending===true,private:x.private,at:x.private?'':timeOf(x.quote,heard)}));
  const times=quotes.filter(q=>!q.private&&q.at).map(q=>q.at).sort();
  const used=quotes.filter(q=>!q.private);
  return {id:sec.id,title:sec.title,quotes,provenance:used.length?'From your words'+(times.length?', '+(times[0]===times[times.length-1]?times[0]:times[0]+'–'+times[times.length-1]):''):''};
 }).filter(s=>s.quotes.length);
 // Items whose field is not one of the twelve (never from this server) are not dropped: they join the last block rather than vanish from the count.
 const strays=all.filter(x=>!SECTION_OF[x.field]);if(strays.length){const last=sections[sections.length-1]||{id:'evidence',title:'Evidence and fit',quotes:[],provenance:''};if(!sections.includes(last))sections.push(last);
  for(const x of strays)last.quotes.push({id:x.id,field:x.field,label:x.label,quote:x.private?'':x.quote,tags:arr(x.tags),lang:x.lang||'',editable:x.editable===true&&!x.private&&x.pending!==true,pending:x.pending===true,private:x.private,at:''});}
 // The number strip: only figures that are exact spans of the consultant's quotes, from the outcome and measurement lines (never computed, summed or rounded).
 let numbers=null;const figures=[];
 for(const x of items.filter(x=>x.field==='outcome'||x.field==='measurement')){const sp=spans(x.quote);const ft=fromTo(x.quote,sp);
  if(ft&&!numbers)numbers={kind:'beforeAfter',before:{text:ft.before.text,id:x.id,label:x.label},after:{text:ft.after.text,id:x.id,label:x.label}};
  for(const p of sp)if(!figures.some(f=>f.text===p.text&&f.id===x.id))figures.push({text:p.text,id:x.id,label:x.label});}
 if(!numbers&&figures.length>=2)numbers={kind:'figures',figures:figures.slice(0,4)};
 const total=items.length,seen=opts.seen instanceof Set?opts.seen:new Set();
 return {sections,numbers,total,reviewed:items.filter(x=>seen.has(x.id)).length,
  keptCount:all.filter(x=>x.private).length};}

// Every string the case study may show that is neither a quote nor one of the consultant's own tags or the server's labels (for the "nothing invented" test).
function fixedText(){return FIXED_LABELS.slice();}

/* ---------- the opening, as two staged bubbles ---------- */
// ATLAS's first reply is the greeting (cached, fixed) and then the first question, sent as one run of text. The question is the first sentence that asks (ends in "?"),
// with a lead-in clause of its own kept in front of it. No question yet: one bubble.
function stageOpening(text){const t=String(text||'').trim();if(!t)return [];
 const parts=t.match(/[^.!?]*[.!?]+(?:\s+|$)|[^.!?]+$/g)||[t],at=parts.findIndex(p=>/\?\s*$/.test(p.trim()));
 if(at<=0)return [t];
 const first=parts.slice(0,at).join('').trim(),rest=parts.slice(at).join('').trim();
 return first&&rest?[first,rest]:[t];}
const wordCount=s=>(String(s||'').trim().match(/\S+/g)||[]).length;

/* ---------- the project picker ---------- */
// rows: the person's own staffing rows [{projectId, projectTitle, endDate, managerName}]; projects: their own projects on this device [{id, title, stage, role, sheet}].
function pickerModel(rows,projects,query){
 const q=squash(query),staffing=arr(rows).filter(r=>r&&typeof r.projectId==='string'&&r.projectId).map(r=>({kind:'staffing',key:'s:'+r.projectId,title:str(r.projectTitle,140)||r.projectId,ref:r.projectId,when:str(r.endDate,10),detail:str(r.managerName,100),row:r}));
 const own=arr(projects).filter(p=>p&&typeof p.id==='string'&&!p.sample).slice(0,12).map(p=>({kind:'project',key:'p:'+p.id,title:str(p.title,140)||'Untitled project',ref:str(obj(p.sheet).oppId,40),when:'',detail:[p.role,p.stage].filter(Boolean).join(' · '),project:p}));
 // a staffing row the person already has a project for (same Opp ID) is listed once, as the project
 const known=new Set(own.map(o=>o.ref).filter(Boolean)),list=[...staffing.filter(s=>!known.has(s.ref)),...own];
 const hit=x=>!q||squash([x.title,x.ref,x.detail].join(' ')).includes(q);
 return {items:list.filter(hit),total:list.length,empty:list.length===0};}

// What picking a staffing row fills in (the form's own fields; nothing is guessed): the title and the project/Opp ID from the row, the end month from its end date, the N+1 from the
// row, and the person's own name and role from their profile. Stage stays the form's default until they say otherwise.
/* W2 (decided 2 Nov 2026): role, sector and stage come from the person's own projects, derived server-side (staffing/mine). Only those are filled
   from the row; with nothing derived the role falls back to the person's profile (self-declared, ATLAS still asks: never verified) and the rest stay empty. */
const STAGES=['Assessment','Proof of concept','Pilot','Production','Ongoing operation','Lessons learned'];
function staffingValues(row,profile){const r=obj(row),p=obj(profile),end=/^(\d{4}-\d{2})-\d{2}$/.exec(String(r.endDate||''));
 const dRole=str(r.role,100),dSector=str(r.sector,100),dStage=STAGES.includes(r.stage)?r.stage:'';
 return {title:str(r.projectTitle,140)||str(r.projectId,60),consultant:str(p.consultant,100),role:dRole||str(p.role,100),oppId:str(r.projectId,40),
  derived:{role:!!dRole,sector:!!dSector,stage:!!dStage},sector:dSector,stage:dStage,
  details:{projectId:str(r.projectId,60),...(end?{end:end[1]}:{})},manager:{name:str(r.managerName,100),email:str(r.managerEmail,200)}};}

/* ---------- the submit sheet ---------- */
const SUBMIT_STEPS=['Submitted','Quality review','N+1 review','Approved','Published or held'];
const SUBMIT_LINE='Your N+1 and reviewers can now see this. Nothing else has left your private draft.';

/* ---------- the first-run checklist ---------- */
const FIRST_RUN_STEPS=[
 {id:'pick',title:'Pick your project',note:'Choose it from your staffing list, or add it in three fields.'},
 {id:'talk',title:'Have the interview',note:'20–30 minutes with ATLAS, typed or spoken.'},
 {id:'submit',title:'Check it and submit',note:'Read your story, correct anything, then send it for review.'}];
const FIRST_RUN_PRIVACY='Only you see it until you press Submit.';

return {SECTIONS,SECTION_OF,FIXED_LABELS,clockOf,timeOf,fromTo,caseStudy,fixedText,stageOpening,wordCount,pickerModel,staffingValues,SUBMIT_STEPS,SUBMIT_LINE,FIRST_RUN_STEPS,FIRST_RUN_PRIVACY};
});
