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
const BARE=/^(?:[$€£]\s*)?\d+(?:[.,]\d+)*$/,RANGE=/^(?:\s+to\s+|\s*[-–]\s*)$/i,SPACE=/^\s*$/;
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
   if(before&&BARE.test(before.t)&&RANGE.test(q.slice(before.e,s)))s=before.s;
   grown.push({s,e});}
  grown.sort((a,b)=>a.s-b.s||a.e-b.e);
  const merged=[];for(const g of grown){const last=merged[merged.length-1];  // overlapping or adjacent spans merge
   if(last&&(g.s<=last.e||SPACE.test(q.slice(last.e,g.s))))last.e=Math.max(last.e,g.e);else merged.push({...g});}
  return merged.map(({s,e})=>{const text=q.slice(s,e),unit=text.replace(/^[\s\S]*\d/,'').trim();
   return {text,unit,unitUnclear:/^[kmb]$/i.test(unit)&&!/[$€£]/.test(text),start:s,end:e};});}).map(x=>({...x}));}  // copies: the cache stays intact

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
   for(const c of arr(r.countries))if(c&&typeof c.code==='string'&&typeof c.from==='string'&&c.from.trim())found.set(fold(c.from)+'\u0000'+c.code,{code:c.code,frag:c.from.trim()});
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
 return {elapsed,max,left:max===null?null:max-elapsed,phase};}  // no timePlan (an older server): no phase is invented
// state = {quality, heard: [{item_id, text, seq}], qualitySeq, session: {readyAt, stoppedAt, maxSeconds, mode, gaps, timePlan},
//          now (ms), policy: window.ATLAS_POLICY, geo: AtlasGeo}. `seq` orders the events: analysing = a turn newer than the last quality.
function model(state){
 const s=obj(state),q=obj(s.quality),session=obj(s.session),policy=obj(s.policy),fields=obj(policy.FIELDS);
 const keys=Object.keys(fields).filter(k=>Array.isArray(fields[k])),label=k=>str(fields[k]&&fields[k][0],80)||k;
 const ds=details(q,fields),deferredFields=obj(q.deferred_fields);
 const dims=keys.map(field=>{const mine=ds.filter(d=>d.field===field),has=st=>mine.some(d=>d.status===st);
  return {field,label:label(field),state:has('reported')?'reported':has('uncertain')?'uncertain':has('unknown')?'unknown':own(deferredFields,field)?'deferred':'empty',count:mine.length};});
 const pins=new Map(),loose=new Map(),metrics=[],seen=new Set();
 for(const d of ds){const p=pinsOf(d.quote,s.geo);
  for(const x of p.pins){if(!pins.has(x.code))pins.set(x.code,{code:x.code,name:x.name,detailIds:[]});const ids=pins.get(x.code).detailIds;if(!ids.includes(d.id))ids.push(d.id);}
  for(const x of p.notMapped){const k=x.text.toLowerCase();if(!loose.has(k))loose.set(k,x);}
  for(const m of metricSpans(d.quote,policy.NUMERIC_SRC)){const k=d.id+'|'+m.text;if(seen.has(k)||metrics.length>=40)continue;seen.add(k);
   metrics.push({detailId:d.id,field:d.field,text:m.text,unit:m.unit,unitUnclear:m.unitUnclear,status:d.status});}}
 const heard=arr(s.heard),last=heard.length?num(obj(heard[heard.length-1]).seq):null,settled=num(s.qualitySeq);
 const next=typeof q.next_field==='string'&&keys.includes(q.next_field)?{field:q.next_field,label:label(q.next_field)}:null;
 const status=new Map(arr(q.gap_status).filter(g=>g&&typeof g.id==='string').map(g=>[g.id,GAP_STATUS.has(g.status)?g.status:'open']));
 const asks=arr(session.gaps).length?arr(session.gaps):arr(q.gap_status);
 return {label:LABEL,dims,
  coverage:{present:dims.filter(d=>d.count>0).length,total:keys.length,meaning:MEANING},
  pins:[...pins.values()],
  placesNotMapped:[...loose.values()].filter(x=>!x.code||!pins.has(x.code)).map(x=>x.text.slice(0,60)).slice(0,12),
  metrics,
  measurementSlots:[...new Set(arr(q.measurement_gaps))].filter(n=>NEEDS.includes(n)).map(need=>({need})),
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

return {model,diff,summaryText,metricSpans,pinsOf};
});
