/* ATLAS live story board: pure model of the interview state (WOW_SPEC F5.1). No DOM, no network and no clock: the caller
   passes `now`. UMD so node tests cover it. Everything here is candidate data from speech recognition, never verified:
   figures are exact substrings of the consultant's quotes (never computed, normalised or summed), a country is pinned only
   when it is named after a place cue, and the next question is only what ATLAS may ask, never what it asked. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AtlasBoard=api;})(typeof globalThis!=='undefined'?globalThis:this,()=>{
'use strict';
const LABEL='From the interview · unverified',MEANING='candidate coverage, not verification',MAX_QUOTE=2000;
const own=(o,k)=>!!o&&Object.prototype.hasOwnProperty.call(o,k);
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{};
const arr=v=>Array.isArray(v)?v:[];
const str=(v,n)=>typeof v==='string'?v.slice(0,n):'';
const num=v=>typeof v==='number'&&isFinite(v)?v:null;
const ID_RE=/^[A-Za-z0-9_-]{1,40}$/,okId=v=>typeof v==='string'&&ID_RE.test(v);
const NEEDS=['measure','before/after','unit','period','population'];
const GAP_STATUS=new Set(['answered_unverified','unknown','deferred','open']);

/* ---------- Figures: exact numeric spans (F5.1 "Metric chips") ---------- */
// The span grammar of F5.1. A word unit must end where the word ends, so "3 percentage points" or "5 daily" never read as
// "3 percent" or "5 day": the unit is not taken, and a hit that relied on it is not shown (see metricSpans).
const SPAN=/(?:[$€£]\s*)?\d+(?:[.,]\d+)*(?:\s*(?:%|(?:percent|million|billion|thousand|bn|[kmb]|hours?|minutes?|days?|weeks?|months?|years?)(?![\p{L}])))?/giu;
// A range or a before/after pair is ONE figure as said: "from 40 to 12 minutes", "de 40 à 12 minutes", "de 40 a 12", "de 40 até 12", "von 40 auf 12", "da 40 a 12", "van 40 naar 12". The leading from/de/von/da/van is not part of it.
const BARE=/^(?:[$€£]\s*)?\d+(?:[.,]\d+)*$/,RANGE=/^(?:\s+(?:to|à|a|al|para|até|ate|auf|bis|naar|tot)\s+|\s*[-–]\s*)$/i,SPACE=/^\s*$/;
// Words that say a figure is an estimate (en, fr, es, pt, de, it, nl), read on accent-free lower case in the sentence the figure sits in: only the consultant's own words make a chip an estimate.
const HEDGE=/(?:^|[^\p{L}])(?:about|around|roughly|approx(?:imately|imate)?|estimate[sd]?|guess(?:ed)?|circa|environ|a peu pres|autour de|presque|aproximadamente|mas o menos|alrededor de|cerca de|ungefahr|etwa|rund|ongeveer|zo'?n|geschat|geschatzt|estime|estimado|stimato|stima|ca\.?(?=\s*\d))(?![\p{L}])|[~≈]/iu;
const plain=t=>t.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
function hedged(q,s,e){let a=0,b=q.length;for(const m of q.matchAll(/[.!?;]\s+|\n/g)){const end=m.index+m[0].length;if(end<=s)a=end;else if(m.index>=e){b=m.index;break;}}return HEDGE.test(plain(q.slice(a,b)));}
const cache=new Map();
function remember(key,make){if(cache.has(key))return cache.get(key);if(cache.size>600)cache.clear();const v=make();cache.set(key,v);return v;}
const geoIds=new WeakMap();let geoN=0;const geoId=g=>{if(!geoIds.has(g))geoIds.set(g,++geoN);return geoIds.get(g);};
let detectSrc=null,detectRe=null;
function detector(src){if(src!==detectSrc){detectSrc=src;try{detectRe=new RegExp(src,'gi');}catch(e){detectRe=null;}}return detectRe;}
// quote -> [{text, unit, unitUnclear, start, end}], where text === quote.slice(start, end) always.
function metricSpans(quote,numericSrc){
 const q=str(quote,MAX_QUOTE);if(!q||typeof numericSrc!=='string'||!numericSrc)return [];
 return remember('m\u0000'+numericSrc+'\u0000'+q,()=>{
  const detect=detector(numericSrc);if(!detect)return [];
  const spans=[...q.matchAll(SPAN)].filter(m=>m[0]).map(m=>({s:m.index,e:m.index+m[0].length,t:m[0]}));
  const grown=[];
  for(const h of q.matchAll(detect)){if(!h[0])continue;const hs=h.index,he=hs+h[0].length;  // NUMERIC_SRC finds the hit (ledger parity)
   const over=spans.filter(p=>p.s<he&&p.e>hs);if(!over.length)continue;
   let s=Math.min(...over.map(p=>p.s));const e=Math.max(...over.map(p=>p.e));
   if(e<he)continue;  // the hit's unit runs into a longer word: not a figure
   const before=spans.filter(p=>p.e<=s).pop();  // a bare number joined by ' to ', '-' or '–' starts a range
   let pair=false;if(before&&BARE.test(before.t)&&RANGE.test(q.slice(before.e,s))){s=before.s;pair=true;}
   else if(before&&!BARE.test(before.t)&&RANGE.test(q.slice(before.e,s)))pair=true;  // two measured values joined by "to": two chips, but the answer holds a before/after
   grown.push({s,e,pair});}
  grown.sort((a,b)=>a.s-b.s||a.e-b.e);
  const merged=[];for(const g of grown){const last=merged[merged.length-1];  // overlapping or adjacent spans merge
   if(last&&(g.s<=last.e||SPACE.test(q.slice(last.e,g.s)))){last.e=Math.max(last.e,g.e);last.pair=last.pair||g.pair;}else merged.push({...g});}
  return merged.map(({s,e,pair})=>{const text=q.slice(s,e),unit=text.replace(/^[\s\S]*\d/,'').trim();
   return {text,unit,unitUnclear:/^[kmb]$/i.test(unit)&&!/[$€£]/.test(text),start:s,end:e,pair:!!pair,estimate:hedged(q,s,e)};});}).map(x=>({...x}));}  // copies: the cache stays intact

/* ---------- Places: cued country names only (F5.1 "Pins") ---------- */
const CUE=/(?:^|[^\p{L}\p{N}])(?:in|to|from|across|throughout|within|into|at)\s+(?:the\s+)?$/iu;
const LIST=/^\s*(?:,|,?\s*(?:and|&))\s*(?:the\s+)?$/iu;  // 'and' or ',' continuing a cued list
const reEsc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const fold=s=>s.replace(/\s+/g,' ').trim().toLowerCase();
function chunks(q,n){const out=[];let i=0;while(i<q.length){let j=Math.min(q.length,i+n);if(j<q.length){const k=q.lastIndexOf(' ',j);if(k>i+n/2)j=k;}out.push(q.slice(i,j));i=j;}return out;}
// quote -> {pins: [{code, name, text}], notMapped: [{text, code|null}]}. A country is pinned only when the resolver returns it,
// the words are its own name (not a city, alias or abbreviation) and a place cue precedes them.
function pinsOf(quote,geo){
 const q=str(quote,MAX_QUOTE);
 if(!q||!geo||typeof geo.resolveLocations!=='function'||typeof geo.countryName!=='function')return {pins:[],notMapped:[]};
 const r=remember('p\u0000'+geoId(geo)+'\u0000'+q,()=>{
  const found=new Map();
  for(const part of chunks(q,480)){let r;try{r=obj(geo.resolveLocations(part));}catch(e){continue;}  // the resolver reads at most 500 characters
   for(const c of arr(r.countries))if(c&&typeof c.code==='string'&&typeof c.from==='string'&&c.from.trim())  // the resolver keeps only the first words per
    for(const frag of [c.from.trim(),String(geo.countryName(c.code)||'').trim()])if(frag)found.set(fold(frag)+'\u0000'+c.code,{code:c.code,frag});  // country ('UK'): its own name is searched too
   for(const a of arr(r.ambiguous))if(typeof a==='string'&&a.trim())found.set(fold(a)+'\u0000',{code:null,frag:a.trim()});}  // 'Georgia', 'Congo': never pinned
  const occ=[];
  for(const f of found.values()){const re=new RegExp('(?<![\\p{L}\\p{N}])'+reEsc(f.frag).replace(/\s+/g,'\\s+')+'(?![\\p{L}\\p{N}])','giu');
   for(const m of q.matchAll(re))occ.push({code:f.code,s:m.index,e:m.index+m[0].length,text:m[0]});}
  occ.sort((a,b)=>a.s-b.s||(b.e-b.s)-(a.e-a.s));
  const pins=[],seen=new Set(),loose=new Map();let end=-1,chain=-1;
  for(const o of occ){if(o.s<end)continue;end=o.e;  // longest first, no overlaps: 'South Sudan' is not also 'Sudan'
   const cued=CUE.test(q.slice(0,o.s))||(chain>=0&&LIST.test(q.slice(chain,o.s)));chain=cued?o.e:-1;
   const name=o.code?String(geo.countryName(o.code)||''):'';
   if(o.code&&cued&&name&&fold(o.text.replace(/^the\s+/i,''))===fold(name)){if(!seen.has(o.code)){seen.add(o.code);pins.push({code:o.code,name,text:o.text});}}
   else{const k=fold(o.text);if(!loose.has(k))loose.set(k,{text:o.text,code:o.code});}}
  return {pins,notMapped:[...loose.values()].filter(x=>!x.code||!seen.has(x.code))};});  // 'Chad said ... in Chad': the pin wins
 return {pins:r.pins.map(x=>({...x})),notMapped:r.notMapped.map(x=>({...x}))};}

/* ---------- The board model ---------- */
function details(q,fields){
 const all=arr(q.candidate_details).filter(d=>d&&typeof d==='object'&&d.active!==false).slice(0,120).map((d,i)=>({
  id:okId(d.id)?d.id:'?'+i,field:typeof d.field==='string'&&own(fields,d.field)?d.field:'',quote:str(d.quote,MAX_QUOTE),
  status:['reported','uncertain','unknown'].includes(d.status)?d.status:'uncertain',supersedes:okId(d.supersedes)?d.supersedes:''}));
 const replaced=new Set(all.map(d=>d.supersedes).filter(Boolean));
 return all.filter(d=>!replaced.has(d.id));}  // a superseded account never shows, even if a stale event still lists it
function timeOf(session,now){
 const max=num(session.maxSeconds)!==null&&session.maxSeconds>0?Math.min(session.maxSeconds,86400):null,ready=num(session.readyAt);
 const stop=num(session.stoppedAt),until=now===null?null:stop===null?now:Math.min(now,stop);
 let elapsed=ready!==null&&until!==null?Math.max(0,Math.floor((until-ready)/1000)):0;if(max!==null)elapsed=Math.min(elapsed,max);
 const plan=obj(session.timePlan),closingAt=num(plan.closingAt),depthAt=num(plan.depthAt),gap=session.mode==='gap';
 const phase=closingAt!==null&&elapsed>=closingAt?'closing':gap?'focused':depthAt!==null&&elapsed>=depthAt?'depth':closingAt!==null||depthAt!==null?'breadth':null;
 const soft=num(session.softSeconds);  // the planned end of a full interview (it may run on, with the consultant's agreement, to max): shown as an elapsed clock, not a countdown
 return {elapsed,max,left:max===null?null:max-elapsed,phase,...(soft!==null&&soft>0&&max!==null&&!gap?{soft}:{})};}  // no timePlan (an older server): no phase is invented
// state = {quality, heard: [{item_id, text, seq}], qualitySeq, session: {readyAt, stoppedAt, maxSeconds, mode, gaps, timePlan},
//          now (ms), policy: window.ATLAS_POLICY, geo: AtlasGeo}. `seq` orders the events: analysing = a turn newer than the last quality.
function model(state){
 const s=obj(state),q=obj(s.quality),session=obj(s.session),policy=obj(s.policy),fields=obj(policy.FIELDS);
 const keys=Object.keys(fields).filter(k=>Array.isArray(fields[k])),label=k=>str(fields[k]&&fields[k][0],80)||k;
 const ds=details(q,fields),deferredFields=obj(q.deferred_fields);
 const dims=keys.map(field=>{const mine=ds.filter(d=>d.field===field),has=st=>mine.some(d=>d.status===st);
  return {field,label:label(field),state:has('reported')?'reported':has('uncertain')?'uncertain':has('unknown')?'unknown':own(deferredFields,field)?'deferred':'empty',count:mine.length};});
 const pins=new Map(),loose=new Map(),metrics=[],seen=new Map();let pairSaid=false;
 for(const d of ds){const p=pinsOf(d.quote,s.geo);
  for(const x of p.pins){if(!pins.has(x.code))pins.set(x.code,{code:x.code,name:x.name,detailIds:[]});const ids=pins.get(x.code).detailIds;if(!ids.includes(d.id))ids.push(d.id);}
  for(const x of p.notMapped){const k=x.text.toLowerCase();if(!loose.has(k))loose.set(k,x);}
  for(const m of metricSpans(d.quote,policy.NUMERIC_SRC)){  // one chip per figure as said, whichever details quote it; an estimate only on the consultant's own hedge words (an 'unknown' stays so)
   if(m.pair)pairSaid=true;const k=m.text.toLowerCase();
   if(seen.has(k)){if(m.estimate&&seen.get(k).status==='reported')seen.get(k).status='uncertain';continue;}
   if(metrics.length>=40)continue;
   const chip={detailId:d.id,field:d.field,text:m.text,unit:m.unit,unitUnclear:m.unitUnclear,status:d.status==='unknown'?'unknown':m.estimate?'uncertain':'reported'};seen.set(k,chip);metrics.push(chip);}}
 const heard=arr(s.heard),last=heard.length?num(obj(heard[heard.length-1]).seq):null,settled=num(s.qualitySeq);
 const next=typeof q.next_field==='string'&&keys.includes(q.next_field)?{field:q.next_field,label:label(q.next_field)}:null;
 const status=new Map(arr(q.gap_status).filter(g=>g&&typeof g.id==='string').map(g=>[g.id,GAP_STATUS.has(g.status)?g.status:'open']));
 const asks=arr(session.gaps).length?arr(session.gaps):arr(q.gap_status);
 return {label:LABEL,dims,
  coverage:{present:dims.filter(d=>d.count>0).length,total:keys.length,meaning:MEANING},
  pins:[...pins.values()],
  placesNotMapped:[...loose.values()].filter(x=>!x.code||!pins.has(x.code)).map(x=>x.text.slice(0,60)).slice(0,12),
  metrics,
  measurementSlots:[...new Set(arr(q.measurement_gaps))].filter(n=>NEEDS.includes(n)&&!(n==='before/after'&&pairSaid)).map(need=>({need})),  // the answer itself holds a from-to pair: no "before/after values" left to recover
  corrected:ds.filter(d=>d.supersedes).map(d=>({detailId:d.supersedes,supersededBy:d.id})),
  challenge:{next,planned:str(q.planned_question,400)||str(q.next_question,400),  // what ATLAS may ask next; probe_history is never read
   flags:arr(q.flags).filter(f=>typeof f==='string'&&f).map(f=>f.slice(0,200)).slice(0,4),
   deferred:Object.keys(deferredFields).filter(k=>keys.includes(k)),route:str(q.story_route,60),
   analysing:last!==null&&last>(settled===null?-Infinity:settled)},
  time:timeOf(session,num(s.now)),
  gaps:session.mode==='gap'?asks.filter(g=>g&&typeof g.id==='string').slice(0,5).map(g=>({id:g.id.slice(0,20),label:str(g.label,80)||g.id.slice(0,20),status:status.get(g.id)||'open'})):[]};}

// Keys of the items that are new in `next` (by D-id, country code, field state or ask status): only these may animate.
function keysOf(m){if(!m||typeof m!=='object')return [];return [...arr(m.pins).map(p=>'pin:'+p.code),...arr(m.metrics).map(x=>'metric:'+x.detailId+'|'+x.text),
 ...arr(m.dims).filter(d=>d.state!=='empty').map(d=>'dim:'+d.field+':'+d.state),...arr(m.gaps).map(g=>'gap:'+g.id+':'+g.status)];}
function diff(prev,next){const before=new Set(keysOf(prev));return keysOf(next).filter(k=>!before.has(k));}

// Short plain sentences for the polite live region. Never says what was asked, never claims a check.
function summaryText(m){if(!m||typeof m!=='object')return '';const c=obj(m.coverage),parts=['From the interview, unverified.'];
 parts.push((c.present||0)+' of '+(c.total||0)+' dimensions have candidate details.');
 if(arr(m.pins).length)parts.push('Countries mentioned: '+m.pins.map(p=>p.name).join(', ')+'.');
 const figs=arr(m.metrics);if(figs.length)parts.push('Figures heard: '+figs.slice(0,4).map(x=>x.text+(x.unitUnclear?' (unit unclear)':'')+(x.status==='uncertain'?' (estimate)':'')).join(', ')+(figs.length>4?' and '+(figs.length-4)+' more':'')+'.');
 const n=arr(m.corrected).length;if(n)parts.push(n===1?'One earlier account was corrected.':n+' earlier accounts were corrected.');
 const g=arr(m.gaps);if(g.length)parts.push('Proof items with an answer: '+g.filter(x=>x.status==='answered_unverified').length+' of '+g.length+'.');
 const ch=obj(m.challenge);if(ch.next)parts.push('ATLAS may ask next about '+ch.next.label+'.');
 return parts.join(' ');}

/* ---------- The read-back card (T11, plan 3h, D19, Tony Q2) ----------
   sum = {items, unknowns, phase, draft, unavailable, submit} comes from the server's `summary`, `evidence_draft` and related events; this turns it into what a
   person reads. phase: open (the card is live), confirming (the confirmation is on its way), confirmed (an owner-only draft was saved, or the server says why not),
   ended (the interview ended before they confirmed: nothing was saved), closed (more was said, the card went away). The words never say verified, approved or
   shared: a draft is private to its owner until they press Submit for review themselves. Items are exactly the server's, bounded here. */
const DETAIL_RE=/^D-\d{3,6}$/;
const STATUS_TAG={uncertain:'you called this an estimate',unknown:'still open, in your own words'};
const PROVENANCE_TAG={consultant_typed:'typed by you',consultant_corrected:'corrected by you'};
const POINT_WORDS={unconfirmed_speech:'Not confirmed, the speech recognition was unsure',unknown:'Still open, in your own words',skipped:'Still open',deferred:'Still open'};
const SUMMARY_INTRO='This is what ATLAS understood, in your own words. Correct anything that is wrong, keep private anything you do not want used, or confirm it.';
const SUMMARY_NEXT='Confirming saves a private draft that only you can see. Nothing goes to your N+1 or reviewer until you press Submit for review, and they may use it for internal knowledge only until you grant more.';
function summaryView(sum){
 const s=obj(sum),phase=['open','confirming','confirmed','ended','closed'].includes(s.phase)?s.phase:'closed',draft=obj(s.draft),unavailable=obj(s.unavailable),submit=obj(s.submit);
 const hasDraft=typeof draft.id==='string'&&draft.id!==''&&Number.isInteger(draft.revision);
 const items=arr(s.items).filter(x=>x&&typeof x==='object'&&typeof x.detail_id==='string'&&DETAIL_RE.test(x.detail_id)).slice(0,100).map(x=>{
  const tags=[];if(own(STATUS_TAG,x.status))tags.push(STATUS_TAG[x.status]);if(x.asr_unconfirmed===true)tags.push('speech not confirmed');if(own(PROVENANCE_TAG,x.provenance))tags.push(PROVENANCE_TAG[x.provenance]);
  if(x.sensitive===true)tags.push('may be sensitive: keep it private?'); // a flag on this line, never on you (G2)
  return {id:x.detail_id,field:str(x.field,40),label:str(x.label,80),quote:str(x.quote,1800),tags,editable:phase==='open',...(typeof x.lang==='string'&&/^[a-z]{2,3}$/.test(x.lang)?{lang:x.lang}:{})};}); /* lang: the language the quote was said in (v2.2 L1), never translated */
 const openPoints=arr(s.unknowns).filter(u=>u&&typeof u==='object'&&own(POINT_WORDS,u.kind)).slice(0,12).map(u=>POINT_WORDS[u.kind]+': '+(str(u.label,80)||str(u.field,40)));
 const sending=submit.status==='sending',sent=submit.status==='sent';
 const visible=phase!=='closed'&&(items.length>0||hasDraft||!!unavailable.message||phase==='ended');
 const saved=phase==='confirmed'&&hasDraft?'Saved as a private draft — only you can see it.'+(draft.unchanged===true?' (It was already saved.)':'')+' Revision '+draft.revision+'.':'';
 const notSaved=phase==='confirmed'&&!hasDraft?(str(unavailable.message,300)||'The summary was confirmed but not saved to the library.')
  :phase==='ended'?'The interview ended before you confirmed this summary, so nothing was saved to the library.':'';
 return {visible,phase,title:'Read-back: what ATLAS understood',intro:SUMMARY_INTRO,items,openPoints,next:SUMMARY_NEXT,
  empty:!items.length&&phase==='open'?'Nothing is firm enough to read back yet.':'',
  confirm:{label:phase==='confirming'?'Saving…':'Confirm summary',hidden:phase!=='open'&&phase!=='confirming',disabled:phase!=='open'||!items.length},
  saved,notSaved,
  submit:{hidden:!hasDraft||phase!=='confirmed',disabled:sending||sent,label:sent?'Submitted for review':sending?'Submitting…':'Submit for review',
   message:sent?'Submitted for review. Your N+1 or reviewer can now see it.':submit.status==='error'?str(submit.message,300)||'It was not submitted.':hasDraft&&phase==='confirmed'?'Not submitted yet. Only you can see this draft.':''},
  live:phase==='open'?'Read-back: '+items.length+(items.length===1?' item':' items')+(openPoints.length?', '+openPoints.length+(openPoints.length===1?' open point':' open points'):'')+'.':saved||notSaved};}

return {model,diff,summaryText,metricSpans,pinsOf,summaryView};
});
