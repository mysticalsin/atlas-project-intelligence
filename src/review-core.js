/* ATLAS reviewer queue, owner journey strip and human errors (v2.2 W2): pure helpers, no DOM, no network, no clock (the caller passes times). UMD so node tests cover them.
   Nothing here decides anything about a person's work: the queue only orders what the server already lists, the strip only reads the workflow state the server
   already holds (a state that is not known is shown as not reached, never guessed), and the deferred commit only delays the reviewer's own click by eight seconds so
   it can be taken back before it is written. The server still decides every action (no self-approval, N+1 resolution, an approval binds one revision and hash). */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AtlasReviewCore=api;})(typeof window!=='undefined'?window:globalThis,function(){'use strict';
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{},arr=v=>Array.isArray(v)?v:[],str=(v,n=200)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,n):'';

/* ---------- names, never ids ---------- */
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// A random id (UUID, a long hex string, a local project id): fine for a machine, never for a person to read.
const isOpaqueId=s=>typeof s==='string'&&(UUID.test(s)||/^[0-9a-f]{24,64}$/i.test(s.trim())||/^local-[a-z0-9]+-[a-z0-9]+$/i.test(s.trim()));
const FALLBACK='Interview evidence';
// A queue row's project: the library reference's title, else a readable business Project ID, else a plain word.
function projectName(item,fallback=FALLBACK){const i=obj(item),p=str(i.project,160);if(p&&!isOpaqueId(p))return p;const r=str(i.project_ref,40);return r&&!isOpaqueId(r)?r:fallback;}
// Any text that is about to be shown: a raw id inside it is replaced (a project's title that someone typed as an id stays readable as "a project").
const noIds=(s,word='this project')=>String(s==null?'':s).replace(new RegExp(UUID.source,'gi'),word);

/* ---------- time ---------- */
const MIN=60000,HOUR=3600000,DAY=86400000;
function ageMs(iso,now){const t=Date.parse(iso);return Number.isFinite(t)&&Number.isFinite(now)?Math.max(0,now-t):null;}
function ageText(iso,now){const a=ageMs(iso,now);if(a===null)return 'unknown';if(a<MIN)return 'just now';if(a<HOUR)return Math.floor(a/MIN)+' min';if(a<DAY){const h=Math.floor(a/HOUR);return h+(h===1?' hour':' hours');}const d=Math.floor(a/DAY);return d+(d===1?' day':' days');}
// How long it has waited: fresh (under a day), waiting (a day or more), late (three days or more). A word and a colour, never a verdict on the work.
const ageTone=(iso,now)=>{const a=ageMs(iso,now);return a===null?'idle':a>=3*DAY?'late':a>=DAY?'wait':'fresh';};

/* ---------- the queue ---------- */
function qualityChip(q){const x=obj(q);if(!Number.isFinite(x.score))return {text:'Not scored',tone:'idle'};
 const label={ready:'Ready',needs_work:'Needs work',insufficient:'Insufficient'}[x.status]||'';
 return {text:x.score+(label?' · '+label:''),tone:x.status==='ready'?'ok':x.status==='insufficient'?'bad':'work'};}
// Oldest first (a stable order for the ties), never the reviewer's own records, one plain row each.
function queueRows(items,now){
 return arr(items).filter(x=>x&&typeof x==='object'&&typeof x.id==='string'&&x.mine!==true).map((x,i)=>({x,i}))
  .sort((a,b)=>(Date.parse(a.x.queued_at||a.x.updated_at)||0)-(Date.parse(b.x.queued_at||b.x.updated_at)||0)||a.i-b.i)
  .map(({x})=>{const at=x.queued_at||x.updated_at;return {id:x.id,revision:Number.isInteger(x.revision)?x.revision:null,name:projectName(x),consultant:str(x.consultant,100),
   age:ageText(at,now),tone:ageTone(at,now),quality:qualityChip(x.quality),claims:Number.isInteger(x.claims)?x.claims:0,at:str(at,40),
   ...(x.state==='disputed'?{disputed:true,canSettle:x.can_adjudicate===true}:{})};});}
// What waits for this reviewer: a dispute they cannot settle (they rejected it and another reviewer exists) is listed, but not counted (D-DSR).
const waiting=rows=>arr(rows).filter(r=>!(r&&r.disputed&&!r.canSettle)).length;
const queueTitle=n=>'Waiting for you ('+(Number.isInteger(n)&&n>0?n:0)+')';

/* ---------- one claim, as the reviewer reads it ---------- */
const TYPE_WORDS={responsibility:'Responsibility',deliverable:'Deliverable',technology:'Technology',outcome:'Outcome',metric:'Metric',credential:'Credential',context:'Context',learning:'Learning'};
const ORIGIN_WORDS={consultant_reported:'said by the consultant',unknown:'origin not established'};
function claimModel(c){
 const x=obj(c),refs=arr(x.source_refs).filter(r=>r&&typeof r==='object'),ref=refs.find(r=>r.kind==='interview')||refs[0]||{};
 const statement=str(x.statement,1800),quote=str(ref.quote,1800),context=str(ref.context,1800);
 const tags=[ORIGIN_WORDS[x.origin]||str(x.origin,40).replace(/_/g,' '),ref.ledger_status==='uncertain'?'estimate':'',
  x.attribution&&x.attribution!=='unknown'?'attribution: '+str(x.attribution,20).replace(/_/g,' '):(context?'attribution not established':''),
  Number.isFinite(ref.asr_min_conf)?'speech recognition '+Math.round(Math.max(0,Math.min(1,ref.asr_min_conf))*100)+'% sure':'',
  ref.kind&&ref.kind!=='interview'?(ref.kind==='amendment'?'amended by '+str(ref.by,20):ref.kind==='typed'?'typed in review':''):''].filter(Boolean);
 return {id:str(x.claim_id,100),type:TYPE_WORDS[x.claim_type]||'Claim',statement,quote:quote&&quote!==statement?quote:'',lang:/^[a-z]{2,3}$/.test(ref.lang||'')?ref.lang:'',context,tags};}

/* ---------- keys ---------- */
// J next, K previous, A validate, R request changes, U undo, E amend. Never while typing, never with a modifier (so the browser's own shortcuts stay).
function keyAction(e){if(!e||e.ctrlKey||e.metaKey||e.altKey)return null;const t=e.target;if(t&&(/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName||'')||t.isContentEditable))return null;
 return {j:'next',k:'prev',a:'approve',r:'changes',u:'undo',e:'amend'}[String(e.key||'').toLowerCase()]||null;}

/* ---------- the eight-second take-back ---------- */
// A decision is not written until `delay` ms after the click; undo() inside that time means it was never written. Starting another decision (or flush()) writes the
// waiting one at once, so there is never more than one waiting. The timer functions are injected so tests need no clock.
function createDeferred({delay=8000,setT=(f,ms)=>setTimeout(f,ms),clearT=t=>clearTimeout(t),now=()=>Date.now()}={}){
 let cur=null;
 async function run(e){if(cur!==e)return;cur=null;clearT(e.timer);try{const r=await e.commit();if(e.onDone)e.onDone(r,null);return r;}catch(err){if(e.onDone)e.onDone(null,err);return null;}}
 return {
  start(e){if(cur)run(cur);const entry={...e,startedAt:now(),until:now()+delay,timer:null};entry.timer=setT(()=>run(entry),delay);cur=entry;return entry;},
  undo(){const e=cur;if(!e)return null;clearT(e.timer);cur=null;if(e.onUndo)e.onUndo();return e;},
  flush(){return cur?run(cur):Promise.resolve(null);},
  pending(){return cur;},
  remaining(){return cur?Math.max(0,cur.until-now()):0;},
  delay};
}

/* ---------- words for refusals and failures ---------- */
const LOAD_FAIL='We couldn’t load this. Your work is safe.',SEND_FAIL='That didn’t go through. Your work is safe. Try again in a moment.';
const RAW=/failed to fetch|networkerror|load failed|network request failed|typeerror|aborterror|the operation was aborted|timeouterror|timed out|err_[a-z_]+|fetch failed|cannot read prop/i;
const isRaw=m=>RAW.test(String(m||''));
// Any error that is about to be shown: a browser's own wording becomes a calm sentence; the server's plain sentences pass through.
function humanError(e,{write=false}={}){const m=typeof e==='string'?e:str(e&&e.message,300),n=e&&e.name||'';
 if(e&&e.human&&m)return m;if(!m||isRaw(m)||/^(TypeError|AbortError|TimeoutError|NetworkError)$/.test(n))return write?SEND_FAIL:LOAD_FAIL;return noIds(m);}
// The policy gate's stable codes, said the way a reviewer would say them.
const DECISION_WORDS={SELF_APPROVAL:'You cannot approve your own submission. Another reviewer does.',REVISION_MISMATCH:'The consultant changed this while you were reading. Open it again to review the new version.',
 CONTENT_HASH_MISMATCH:'This changed while you were reading. Open it again to review the new version.',TRANSITION_NOT_ALLOWED:'Someone already decided this. Reload the queue.',EVENT_ACTOR_NOT_ALLOWED:'ATLAS did not allow that for your role.',
 AMEND_NOT_ALLOWED_IN_STATE:'This can no longer be amended.',ADJUDICATOR_IS_REJECTER:'You rejected this and another reviewer is available, so that reviewer settles the dispute.'};
function decisionError(e){const m=str(e&&e.message,300),code=str(e&&e.reason,80).split(':')[0]||(/Not allowed: ([A-Z_]+)/.exec(m)||[])[1]||'';
 if(DECISION_WORDS[code])return DECISION_WORDS[code];if(/^Not allowed/i.test(m))return 'ATLAS did not allow that. '+DECISION_WORDS.TRANSITION_NOT_ALLOWED;return humanError(e,{write:true});}

/* ---------- the owner's journey: seven steps from the workflow state the server holds ---------- */
const STEPS=[['project','Project','projects'],['interview','Interview','interview'],['readback','Read-back','interview'],['submitted','Submitted','library'],['review','In review','library'],['approved','Approved','library'],['published','Published or held','status']];
const IN_REVIEW=['submitted_for_review','reviewer_queue','needs_clarification'],APPROVED=['approved','downstream_proposals'],REJECTED=['rejected','closed_rejected','disputed'],WITHDRAWN=['withdrawn','impact_review'];
const LIB_REVIEW=['in_review','needs_work','awaiting_validation','changes_requested'];
// The evidence record of a project: its Project ID (or the page's own id) is what the interview filed it under (evidence.project_ref). The newest wins.
// The library's own link (library_id: the person's reference, matched on the server by local id or Project ID) also counts, so a project that came back after a reload is still found.
function itemFor(project,items){const p=obj(project),d=obj(p.details),keys=[str(d.projectId,100),str(p.id,100)].filter(Boolean),lib=str(obj(p.library).id,100);
 return arr(items).filter(x=>x&&typeof x==='object'&&x.mine!==false&&(keys.includes(str(x.project_ref,100))||(!!lib&&str(x.library_id,100)===lib))).sort((a,b)=>String(b.updated_at||'').localeCompare(String(a.updated_at||'')))[0]||null;}
function stripModel({project,item,status,libraryStatus}={}){
 const p=project?obj(project):null,it=item?obj(item):null,st=it?str(it.state,40):'',ls=str(libraryStatus||(p&&obj(p.library).status),40);
 const spot=arr(obj(status).cards).find(c=>c&&c.branch==='spotlight'),spotStatus=str(obj(spot).display_status,30);
 const interviewed=!!p&&(!!p.interview||!!it||arr(p.answers).some(a=>typeof a==='string'&&a.trim())),readback=interviewed&&(!!it||!!ls);
 const submitted=readback&&(it?st!=='evidence_draft':!!ls&&ls!=='draft');
 const reviewed=submitted&&(it?[...APPROVED,...REJECTED,...WITHDRAWN].includes(st):ls==='published'||ls==='withdrawn');
 const approved=reviewed&&(it?APPROVED.includes(st):ls==='published');
 const published=approved&&spotStatus==='published';
 const done=[!!p,interviewed,readback,submitted,reviewed,approved,published];
 let pos=done.indexOf(false);if(pos<0)pos=6;
 const steps=STEPS.map(([key,label,target],k)=>({key,label,target,state:done[k]?'done':k===pos?'current':'todo',note:''}));
 const set=(k,state,note)=>{steps[k].state=state;steps[k].note=note;};
 if(p&&!interviewed)steps[1].note='Not started yet.';else if(interviewed&&!readback)steps[2].note='Not confirmed yet.';else if(readback&&!submitted)steps[3].note='Not sent yet. Only you can see it until you submit.';
 if(st==='needs_clarification'&&!reviewed)set(4,'attention','Changes requested. Open the Library to read them.');
 else if(submitted&&!reviewed&&(IN_REVIEW.includes(st)||LIB_REVIEW.includes(ls)))set(4,'current','Waiting for a reviewer.');
 if(submitted&&!reviewed&&(st==='withdrawn'||ls==='withdrawn'))set(4,'attention','Withdrawn.');
 if(reviewed&&REJECTED.includes(st))set(5,'attention',st==='disputed'?'Disputed. An adjudicator decides.':'Not approved. Open the Library to read why.');
 if(reviewed&&st==='withdrawn')set(5,'attention','Withdrawn.');
 if(reviewed&&st==='impact_review')set(5,'attention','Withdrawn after approval. An impact review follows.');
 if(approved&&!published)set(6,spotStatus==='held'?'held':'current',spotStatus==='held'?'Held by the test CMS. Not published.':'Not published yet.');
 if(!p)for(const s of steps)s.state='todo';
 const cur=steps.findIndex(s=>['current','attention','held'].includes(s.state)),idx=cur<0?6:cur;
 return {name:p?str(p.title,140)||FALLBACK:'',steps,current:idx,state:steps[idx].state,summary:steps[idx].label+(steps[idx].state==='attention'?' (needs you)':steps[idx].state==='held'?' (held)':steps[idx].state==='done'?' (done)':'')};}

return {waiting,isOpaqueId,projectName,noIds,ageMs,ageText,ageTone,qualityChip,queueRows,queueTitle,claimModel,keyAction,createDeferred,LOAD_FAIL,SEND_FAIL,isRaw,humanError,decisionError,DECISION_WORDS,STEPS,itemFor,stripModel,FALLBACK};
});
