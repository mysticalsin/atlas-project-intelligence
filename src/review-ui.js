/* ATLAS reviewer queue, one-screen review, owner journey strip and calm loading states (v2.2 W2). The pure parts are in review-core.js (tests/review-core.test.js).
   Nothing here decides anything: the queue only lists what GET /api/library/evidence/queue returns, the review screen only calls the existing evidence review route
   (approve = Validate, clarify = Request changes, amend) and the server still refuses self-approval, resolves the N+1 and binds an approval to one revision and hash.
   A decision is written eight seconds after the click so it can be taken back (U); nothing is destructive, so no confirmation is needed except Amend (a new revision).
   Strict CSP: every sink is textContent or the html`` tag; no inline handlers. The hosts (#reviewQueue, #journeyLibrary, #journeyHome) are created here, not in the shell. */
(()=>{'use strict';
const C=window.AtlasReviewCore,Safe=window.AtlasSafe,$=id=>document.getElementById(id),app=()=>window.ATLAS_APP||{};
if(!C||!Safe)return;
const {html,setHTML}=Safe;
const reduced=()=>!!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);
const expired=e=>!!(window.AtlasAuth&&window.AtlasAuth.Expired&&e instanceof window.AtlasAuth.Expired);

/* ---------- calm loading: shimmer rows, and a failure that says the work is safe ---------- */
const Load={
 skeleton(host,{rows=3,label='Loading'}={}){if(!host)return;host.setAttribute('aria-busy','true');host.dataset.loading='1';
  setHTML(host,html`<div class="sk" role="status"><span class="sr">${label}…</span>${Array.from({length:rows},()=>html`<div class="sk-row" aria-hidden="true"><i></i><i></i></div>`)}</div>`);},
 done(host){if(!host)return;host.removeAttribute('aria-busy');delete host.dataset.loading;},
 // Never the browser's own words and never the server's: one fixed sentence and a way to try again.
 failure(host,retry,{text=C.LOAD_FAIL}={}){if(!host)return;Load.done(host);
  setHTML(host,html`<div class="load-fail" role="alert"><p>${text}</p><button class="btn" data-load-retry="" type="button">Try again</button></div>`);
  host.querySelector('[data-load-retry]').addEventListener('click',()=>{if(typeof retry==='function')retry();});}};
window.AtlasLoad=Load;

/* ---------- state ---------- */
const Q={items:[],loadedAt:0,busy:null,err:false,hidden:new Set(),role:null};
const U={cur:null,tick:0,hideT:0};     // the decision waiting to be written, and its bar
const R={idx:0,rec:null,seq:0,mode:'read',cache:new Map(),opener:null};
const deferred=C.createDeferred();
async function canReview(){try{await window.AtlasAuth?.probe?.();const b=await app().bootInfo();
 return window.AtlasAuth?.mode==='live'&&!!b.library&&!!b.features?.evidence_workflow&&['admin','reviewer'].includes(b.libraryRole);}catch{return false;}}
const rows=()=>C.queueRows(Q.items.filter(x=>!Q.hidden.has(x.id)),Date.now());
const lib=()=>$('library');

/* ---------- hosts ---------- */
function queueHost(){let h=$('reviewQueue');if(h)return h;const intro=lib()&&lib().querySelector('.page-intro');if(!intro)return null;
 h=document.createElement('section');h.id='reviewQueue';h.className='rq';h.hidden=true;h.setAttribute('aria-labelledby','rqTitle');intro.after(h);return h;}
function stripHost(id,place){let h=$(id);if(h)return h;const at=place();if(!at)return null;h=document.createElement('div');h.id=id;h.className='journey-host';h.hidden=true;at(h);return h;}
const libStrip=()=>stripHost('journeyLibrary',()=>{const q=queueHost()||(lib()&&lib().querySelector('.page-intro'));return q?h=>q.after(h):null;});
// a sibling of the heading (the heading clips its own content), after it and before the orb; CSS hides it while an interview is running
const homeStrip=()=>stripHost('journeyHome',()=>{const s=document.querySelector('#voicePanel .studio-heading');return s?h=>s.after(h):null;});

/* ---------- the queue ---------- */
function setBadge(n){const b=document.querySelector('header nav [data-view="library"]');if(!b)return;let s=b.querySelector('.nav-count');
 if(!n){if(s)s.remove();b.removeAttribute('data-waiting');return;}
 if(!s){s=document.createElement('span');s.className='nav-count';b.append(s);}s.textContent=String(n);b.dataset.waiting=String(n);s.setAttribute('role','img');s.setAttribute('aria-label',n+' waiting for you');}
function drawQueue(){const h=queueHost();if(!h)return;const rs=rows();setBadge(Q.err?0:rs.length);h.hidden=false;
 if(Q.err){setHTML(h,html`<div class="rq-head"><div><p class="eyebrow">Review</p><h2 class="rq-title" id="rqTitle" tabindex="-1">Waiting for you</h2></div></div><div class="rq-body" id="rqBody"></div>`);Load.failure($('rqBody'),()=>loadQueue({force:true}));return;}
 setHTML(h,html`<div class="rq-head"><div><p class="eyebrow">Review</p><h2 class="rq-title" id="rqTitle" tabindex="-1">${C.queueTitle(rs.length)}</h2></div><button class="quiet" data-rq-refresh="" type="button">Refresh</button></div>
<div class="rq-undo" data-undo-host="" role="status"></div>
${rs.length?html`<p class="rq-sub small">Oldest first. Open one to read each claim beside the words it came from. <kbd>J</kbd> and <kbd>K</kbd> move between them, <kbd>A</kbd> validates, <kbd>R</kbd> asks for changes, <kbd>U</kbd> takes it back.</p>
<ul class="rq-list">${rs.map(r=>html`<li><button class="rq-row" data-rq-open="${r.id}" type="button"><span class="rq-main"><b class="rq-name">${r.name}</b><span class="rq-who">${r.consultant||'Consultant not named'}${r.claims?' · '+r.claims+(r.claims===1?' claim':' claims'):''}</span></span><span class="rq-age" data-tone="${r.tone}"><span class="sr">Waiting </span>${r.age}</span><span class="rq-chip" data-tone="${r.quality.tone}">${r.quality.text}</span><span class="rq-go" aria-hidden="true">Open</span></button></li>`)}</ul>`
 :html`<div class="rq-empty"><p><b>Nothing is waiting for you.</b></p><p class="small muted">When someone submits a story for review it appears here, oldest first.</p></div>`}`);
 drawUndo();}
async function loadQueue({force=false}={}){
 if(Q.busy)return Q.busy;if(!force&&Q.loadedAt&&Date.now()-Q.loadedAt<4000)return null;
 Q.busy=(async()=>{try{
  const h=queueHost();if(!h)return;
  if(!await canReview()){h.hidden=true;h.replaceChildren();setBadge(0);return;}
  if(!Q.loadedAt||Q.err){h.hidden=false;setHTML(h,html`<div class="rq-head"><div><p class="eyebrow">Review</p><h2 class="rq-title" id="rqTitle" tabindex="-1">Waiting for you</h2></div></div><div id="rqBody"></div>`);Load.skeleton($('rqBody'),{rows:3,label:'Loading the review queue'});}
  try{const d=await app().libraryApi('/evidence/queue');Q.items=Array.isArray(d&&d.items)?d.items:[];Q.loadedAt=Date.now();Q.err=false;}
  catch(e){if(expired(e))return;Q.err=true;}
  drawQueue();
 }finally{Q.busy=null;}})();
 return Q.busy;}

/* ---------- the eight-second take-back bar ---------- */
const WORD={approve:'Validated',changes:'Changes requested'};
function drawUndo(){const hosts=document.querySelectorAll('[data-undo-host]');if(!hosts.length)return;const u=U.cur;
 for(const host of hosts){host.hidden=!u;if(!u){host.replaceChildren();continue;}
  const secs=Math.ceil(deferred.remaining()/1000);
  if(u.status==='pending')setHTML(host,html`<span class="undo-text"><b>${WORD[u.kind]}:</b> ${u.name}. It is saved in <span data-undo-secs="">${secs}</span> s.</span><button class="btn" data-rv-undo="" type="button">Undo <kbd>U</kbd></button>`);
  else if(u.status==='failed')setHTML(host,html`<span class="undo-text" data-tone="bad"><b>Not saved.</b> ${u.msg}</span><button class="btn" data-rv-dismiss="" type="button">Close</button>`);
  else setHTML(host,html`<span class="undo-text" data-tone="${u.status==='saved'?'ok':'idle'}">${u.msg}</span>`);}}
function startTick(){clearInterval(U.tick);U.tick=setInterval(()=>{if(!U.cur||U.cur.status!=='pending'){clearInterval(U.tick);return;}
 for(const e of document.querySelectorAll('[data-undo-secs]'))e.textContent=String(Math.ceil(deferred.remaining()/1000));},250);}
function endUndo(ms){clearTimeout(U.hideT);U.hideT=setTimeout(()=>{if(U.cur&&U.cur.status!=='pending'&&U.cur.status!=='failed'){U.cur=null;drawUndo();}},ms);}
function undo(){const e=deferred.undo();return !!e;}
window.addEventListener('beforeunload',e=>{if(deferred.pending()){e.preventDefault();e.returnValue='';}});

/* ---------- the one-screen review ---------- */
function dialog(){let d=$('reviewScreen');if(d)return d;d=document.createElement('dialog');d.id='reviewScreen';d.className='rv-screen';d.setAttribute('aria-labelledby','rvTitle');
 setHTML(d,html`<header class="rv-head"><button class="quiet rv-back" data-rv-close="" type="button">← Queue</button>
<div class="rv-who"><h2 id="rvTitle" tabindex="-1">Review</h2><p class="rv-meta" id="rvMeta"></p></div>
<div class="rv-nav"><span id="rvPos" role="status"></span><button aria-label="Previous (K)" class="rv-step" data-rv-go="-1" type="button">↑</button><button aria-label="Next (J)" class="rv-step" data-rv-go="1" type="button">↓</button></div></header>
<div class="rv-body"><section aria-label="Claims and the words they came from" class="rv-claims" id="rvClaims" tabindex="0"></section>
<aside aria-label="Your decision" class="rv-decide"><div class="rv-undo" data-undo-host="" hidden="" role="status"></div><p class="rv-state" id="rvState"></p>
<button class="btn primary rv-act" data-rv-do="approve" id="rvApprove" type="button">Validate <kbd>A</kbd></button>
<button class="btn rv-act" data-rv-do="changes" id="rvChanges" type="button">Request changes <kbd>R</kbd></button>
<div class="rv-reason" hidden="" id="rvReasonBox"><label class="field-label" for="rvReason">What should change?</label><textarea id="rvReason" maxlength="500" rows="4"></textarea><p class="tiny rv-err" id="rvReasonErr" role="alert"></p><button class="btn primary" data-rv-send="" type="button">Send the request</button><p class="tiny muted">The consultant reads what you write here. Press Ctrl or ⌘ + Enter to send.</p></div>
<button class="btn rv-act" data-rv-do="amend" id="rvAmend" type="button">Amend claims <kbd>E</kbd></button>
<div class="rv-amend" hidden="" id="rvAmendBox"><p class="small">Edit the wording of a claim. It becomes a new revision; the consultant’s own words stay in the history.</p><button class="btn primary" data-rv-save="" type="button">Save the amendment</button><button class="quiet" data-rv-cancel="" type="button">Cancel</button><p class="tiny rv-err" id="rvAmendErr" role="alert"></p></div>
<p class="rv-bind tiny muted" id="rvBind"></p><p class="rv-keys tiny muted"><kbd>J</kbd> next · <kbd>K</kbd> previous · <kbd>A</kbd> validate · <kbd>R</kbd> request changes · <kbd>E</kbd> amend · <kbd>U</kbd> undo</p></aside></div>`);
 document.body.append(d);
 d.addEventListener('click',onDialogClick);
 d.addEventListener('close',()=>{R.seq++;R.mode='read';const o=R.opener;R.opener=null;drawQueue();/* the list is drawn again, so the row that opened it may be gone: the first row, else the title */const t=(o&&o.isConnected&&o)||document.querySelector('#reviewQueue .rq-row')||$('rqTitle');if(t)t.focus({preventScroll:true});});
 d.addEventListener('cancel',e=>{if(!$('rvReasonBox').hidden){e.preventDefault();hideReason();}else if(R.mode==='amend'){e.preventDefault();setMode('read');}});
 $('rvReason').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();decide('changes');}});
 return d;}
const dlgOpen=()=>{const d=$('reviewScreen');return !!(d&&d.open);};
function meta(r){return html`${r.consultant||'Consultant not named'} · waiting ${r.age} · <span class="rq-chip" data-tone="${r.quality.tone}">${r.quality.text}</span>`;}
function say(id,t){const e=$(id);if(e)e.textContent=t||'';}
async function fetchRecord(id){const c=R.cache.get(id);if(c&&Date.now()-c.at<30000)return c.rec;
 const rec=await app().libraryApi('/evidence/'+encodeURIComponent(id));R.cache.set(id,{rec,at:Date.now()});return rec;}
async function openReview(id,from){const d=dialog();R.opener=from||document.activeElement;R.mode='read';if(!d.open)d.showModal();await showAt(Math.max(0,rows().findIndex(r=>r.id===id)));
 if(d.open)$('rvTitle').focus({preventScroll:true});}
async function showAt(i){const rs=rows();if(!rs.length){closeReview();return;}
 R.idx=Math.max(0,Math.min(rs.length-1,i));const row=rs[R.idx],seq=++R.seq;R.mode='read';R.rec=null;hideReason();
 $('rvTitle').textContent=row.name;setHTML($('rvMeta'),meta(row));$('rvPos').textContent=(R.idx+1)+' of '+rs.length;
 for(const b of document.querySelectorAll('#reviewScreen [data-rv-go]'))b.disabled=(+b.dataset.rvGo<0&&R.idx===0)||(+b.dataset.rvGo>0&&R.idx===rs.length-1);
 setMode(R.mode,{redraw:false});drawDecide();Load.skeleton($('rvClaims'),{rows:4,label:'Loading the claims'});
 let rec;try{rec=await fetchRecord(row.id);}catch(e){if(expired(e)||seq!==R.seq)return;Load.failure($('rvClaims'),()=>showAt(R.idx));return;}
 if(seq!==R.seq)return;R.rec=rec;Load.done($('rvClaims'));drawClaims();drawDecide();
 const nx=rs[R.idx+1];if(nx)fetchRecord(nx.id).catch(()=>{});}
function drawClaims(){const rec=R.rec,box=$('rvClaims');if(!rec||!box)return;const cl=(Array.isArray(rec.claims)?rec.claims.slice(0,100):[]).map(C.claimModel),edit=R.mode==='amend';
 setHTML(box,html`<p class="rv-count small muted">${cl.length} ${cl.length===1?'claim':'claims'}, in the consultant’s own words. Each one sits beside where it came from.</p>
<ol class="rv-list">${cl.map(c=>html`<li class="rv-claim" data-claim="${c.id}"><p class="rv-claim-head"><b class="rv-type">${c.type}</b><span class="rv-tags">${c.tags.join(' · ')}</span></p>
${edit?html`<label class="sr" for="rvEdit-${c.id}">Wording of this ${c.type} claim</label><textarea class="rv-edit" data-claim-edit="${c.id}" id="rvEdit-${c.id}" maxlength="1800" rows="3">${c.statement}</textarea>`:html`<p class="rv-stmt" dir="auto">${c.statement}</p>`}
${c.quote?html`<p class="rv-quote small"><span class="rv-label">As heard</span> <q dir="auto"${c.lang?html` lang="${c.lang}"`:''}>${c.quote}</q></p>`:''}
${c.context?html`<p class="rv-context small"><span class="rv-label">Read the sentence around it.</span> It was negated, hypothetical or reported speech, so ATLAS did not treat it as the consultant’s own claim. <q dir="auto">${c.context}</q></p>`:''}</li>`)}</ol>`);}
function drawDecide(){const rec=R.rec,acts=new Set(Array.isArray(rec&&rec.actions)?rec.actions:[]),can=k=>!!rec&&acts.has(k);
 $('rvApprove').disabled=!can('approve');$('rvChanges').disabled=!can('clarify');$('rvAmend').disabled=!can('amend');
 say('rvState',rec&&!acts.size?'This is no longer waiting for a decision from you ('+String(rec.state||'').replace(/_/g,' ')+').':'');
 say('rvBind',rec?'Validating binds revision '+rec.revision+' and its content fingerprint '+String(rec.content_hash||'').slice(0,8)+'. If the consultant changes it first, you will be asked to read it again.':'');}
function setMode(m,{redraw=true}={}){R.mode=m;const am=m==='amend';$('rvAmendBox').hidden=!am;$('rvAmend').hidden=am;$('rvApprove').hidden=am;$('rvChanges').hidden=am;if(am)hideReason();say('rvAmendErr','');if(redraw){drawClaims();drawDecide();if(am){const f=document.querySelector('#rvClaims [data-claim-edit]');if(f)f.focus();}}}
function hideReason(){const b=$('rvReasonBox');if(b){b.hidden=true;say('rvReasonErr','');}}
function closeReview(){const d=$('reviewScreen');if(d&&d.open)d.close();}
function go(step){const rs=rows(),i=R.idx+step;if(i<0||i>=rs.length)return;showAt(i);}

/* ---------- decisions: written eight seconds after the click, unless taken back ---------- */
function decide(kind){const rs=rows(),row=rs[R.idx],rec=R.rec;if(!row||!rec||R.mode==='amend')return;
 const acts=new Set(rec.actions||[]);
 let body;
 if(kind==='approve'){if(!acts.has('approve'))return;body={action:'approve',expected_revision:rec.revision,content_hash:rec.content_hash};}
 else{if(!acts.has('clarify'))return;const reason=($('rvReason').value||'').trim();
  if($('rvReasonBox').hidden){$('rvReasonBox').hidden=false;$('rvReason').focus();return;}
  if(!reason){say('rvReasonErr','Say what should change, so the consultant can fix it.');$('rvReason').focus();return;}
  body={action:'clarify',expected_revision:rec.revision,reason:reason.slice(0,500)};}
 const id=row.id,name=row.name,at=R.idx,mine=()=>!!U.cur&&U.cur.id===id,reason=body.reason||'';
 Q.hidden.add(id);R.cache.delete(id);$('rvReason').value='';hideReason();
 U.cur={kind,name,id,status:'pending'};clearTimeout(U.hideT);
 deferred.start({id,commit:()=>app().libraryApi('/evidence/'+encodeURIComponent(id)+'/review',{method:'POST',body}),
  onUndo:()=>{Q.hidden.delete(id);if(mine())U.cur={...U.cur,status:'undone',msg:'Undone. Nothing was saved.'};drawQueue();
   if(dlgOpen()){const k=rows().findIndex(r=>r.id===id);showAt(k<0?at:k).then(()=>{if(kind==='changes'&&reason){$('rvReason').value=reason;$('rvReasonBox').hidden=false;}});}endUndo(3500);},
  onDone:(r,err)=>{Q.hidden.delete(id);
   if(err){R.cache.delete(id);if(mine())U.cur={kind,name,id,status:'failed',msg:C.decisionError(err)};drawQueue();if(dlgOpen()){const k=rows().findIndex(x=>x.id===id);if(k>=0)showAt(k);}return;}
   Q.items=Q.items.filter(x=>x.id!==id);Q.loadedAt=0;
   if(mine()){U.cur={kind,name,id,status:'saved',msg:(kind==='approve'?'Validated “'+name+'”. Saved.':'Changes requested for “'+name+'”. Saved.')};endUndo(4000);}
   drawQueue();try{window.AtlasWorkflowUI?.refresh?.();}catch{}loadQueue({force:true});}});
 startTick();drawQueue();
 if(dlgOpen()){if(rows().length)showAt(Math.min(at,rows().length-1));else closeReview();}}
async function saveAmend(){const rec=R.rec;if(!rec||!rec.actions||!rec.actions.includes('amend'))return;
 const was=new Map((rec.claims||[]).map(c=>[c.claim_id,String(c.statement||'')])),edits=[];
 for(const t of document.querySelectorAll('#rvClaims [data-claim-edit]')){const v=t.value.trim();if(!v){say('rvAmendErr','A claim needs wording.');t.focus();return;}if(v!==was.get(t.dataset.claimEdit))edits.push({claim_id:t.dataset.claimEdit,statement:v});}
 if(!edits.length){say('rvAmendErr','Nothing changed yet.');return;}
 const id=(rows()[R.idx]||{}).id;
 app().confirm('Save this amendment?','It creates revision '+(rec.revision+1)+' with your wording for '+edits.length+(edits.length===1?' claim':' claims')+'. The consultant’s original words stay in the revision history, and any earlier validation of this record no longer applies. You can validate the new version afterwards.',async()=>{
  try{await app().libraryApi('/evidence/'+encodeURIComponent(id)+'/review',{method:'POST',body:{action:'amend',expected_revision:rec.revision,claims:edits}});R.cache.delete(id);Q.loadedAt=0;
   R.mode='read';await showAt(rows().findIndex(r=>r.id===id));say('rvState','Amended. This is now revision '+((R.rec&&R.rec.revision)||rec.revision+1)+'; read it, then validate or ask for changes.');loadQueue({force:true});}
  catch(e){if(expired(e))return;R.mode='amend';setMode('amend');say('rvAmendErr',C.decisionError(e));}});}
function onDialogClick(e){const b=e.target.closest('button');if(!b||b.disabled)return;
 if(b.dataset.rvClose!==undefined)closeReview();else if(b.dataset.rvGo)go(+b.dataset.rvGo);else if(b.dataset.rvDo==='approve')decide('approve');
 else if(b.dataset.rvDo==='changes')decide('changes');else if(b.dataset.rvDo==='amend')setMode('amend');else if(b.dataset.rvSend!==undefined)decide('changes');
 else if(b.dataset.rvSave!==undefined)saveAmend();else if(b.dataset.rvCancel!==undefined)setMode('read');else if(b.dataset.rvUndo!==undefined)undo();
 else if(b.dataset.rvDismiss!==undefined){U.cur=null;drawUndo();}}
document.addEventListener('keydown',e=>{if(e.repeat||!dlgOpen()||[...document.querySelectorAll('dialog[open]')].some(d=>d.id!=='reviewScreen'))return; // a held key is never a second decision
 const a=C.keyAction(e);if(!a)return;e.preventDefault();
 if(a==='next')go(1);else if(a==='prev')go(-1);else if(a==='approve')decide('approve');else if(a==='changes')decide('changes');else if(a==='undo')undo();else if(a==='amend'&&R.rec&&(R.rec.actions||[]).includes('amend'))setMode(R.mode==='amend'?'read':'amend');});
document.addEventListener('keydown',e=>{if(e.repeat||dlgOpen()||!deferred.pending()||document.querySelector('dialog[open]'))return;if(C.keyAction(e)==='undo'){e.preventDefault();undo();}});
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;const q=$('reviewQueue');if(!q||!q.contains(b))return;
 if(b.dataset.rqOpen)openReview(b.dataset.rqOpen,b);else if(b.dataset.rqRefresh!==undefined)loadQueue({force:true});else if(b.dataset.rvUndo!==undefined)undo();else if(b.dataset.rvDismiss!==undefined){U.cur=null;drawUndo();}});

/* ---------- the owner's journey strip ---------- */
const J={items:[],loadedAt:0,busy:null,status:new Map(),timer:0,justSubmitted:false};
const STATE_WORD={done:'done',current:'where you are',attention:'needs you',held:'held',todo:'not yet'};
async function liveWorkflow(){try{await window.AtlasAuth?.probe?.();const b=await app().bootInfo();return window.AtlasAuth?.mode==='live'&&!!b.library&&!!b.features?.evidence_workflow;}catch{return false;}}
async function loadJourney({force=false}={}){if(J.busy)return J.busy;if(!force&&J.loadedAt&&Date.now()-J.loadedAt<5000)return null;
 J.busy=(async()=>{try{if(!await liveWorkflow()){J.items=[];J.loadedAt=Date.now();return;}
  const d=await app().libraryApi('/evidence');J.items=Array.isArray(d&&d.items)?d.items.filter(x=>x&&typeof x.id==='string'&&x.mine!==false).slice(0,200):[];J.loadedAt=Date.now();
  const p=current(),it=p&&C.itemFor(p,J.items);
  if(it&&['approved','downstream_proposals'].includes(it.state)&&!J.status.has(it.id+':'+it.revision)){try{J.status.set(it.id+':'+it.revision,await app().libraryApi('/evidence/'+encodeURIComponent(it.id)+'/status'));}catch{}}
 }catch(e){/* the strip then shows what the local project knows; it never guesses */}finally{J.busy=null;}})();return J.busy;}
// The selected project; with none selected (a fresh load) the newest of the person's own, so the status they came to see is there.
function current(){const A=app();let p=A.project&&A.project();if(!p&&A.ownProjects){const l=A.ownProjects().filter(x=>!x.sample);p=l[l.length-1]||null;}return p;}
function model(p){const it=C.itemFor(p,J.items);return C.stripModel({project:p,item:it,status:it?J.status.get(it.id+':'+it.revision):null,libraryStatus:p&&p.library&&p.library.status});}
function stripHTML(m,{pick=null,id}={}){const note=m.steps[m.current].note;
 return html`<nav aria-label="Where this project stands" class="journey" data-state="${m.state}"><div class="journey-head"><p class="journey-name">${m.name}</p>
${pick&&pick.length>1?html`<label class="sr" for="${id}Pick">Project</label><select class="journey-pick" data-journey-pick="" id="${id}Pick">${pick.map(p=>html`<option value="${p.id}" ${p.selected?'selected':''}>${p.title}</option>`)}</select>`:''}
<p class="journey-summary" role="status">${m.summary}</p></div>
<ol class="journey-steps">${m.steps.map((s,i)=>html`<li class="journey-step" data-state="${s.state}" data-step="${s.key}"><button ${i===m.current?html`aria-current="step"`:''} aria-label="${i+1} of 7, ${s.label}: ${STATE_WORD[s.state]}${s.note?'. '+s.note:''}" class="journey-btn" data-journey="${s.target}" type="button"><span aria-hidden="true" class="journey-dot">${s.state==='done'?'✓':s.state==='attention'?'!':i+1}</span><span class="journey-label">${s.label}</span></button></li>`)}</ol>
${note?html`<p class="journey-note small">${note}</p>`:''}</nav>`;}
function drawStrips(){const A=app(),p=current();
 const hosts=[['journeyLibrary',libStrip,true],['journeyHome',homeStrip,false]];
 for(const [id,get,pickable] of hosts){const h=get();if(!h)continue;
  if(!p||p.sample){h.hidden=true;h.replaceChildren();delete h.dataset.sig;continue;}
  const list=pickable&&A.ownProjects?A.ownProjects().filter(x=>!x.sample).map(x=>({id:x.id,title:C.noIds(x.title||'Untitled project'),selected:x.id===p.id})):null;
  const m=model(p),sig=JSON.stringify([m,list&&list.map(x=>[x.id,x.title,x.selected])]);h.hidden=false;if(h.dataset.sig===sig)continue;h.dataset.sig=sig;setHTML(h,stripHTML(m,{pick:list,id}));}
 if(J.justSubmitted&&lib()&&!lib().hidden){J.justSubmitted=false;const b=document.querySelector('#journeyLibrary [aria-current="step"]');if(b){b.scrollIntoView({block:'center',behavior:reduced()?'auto':'smooth'});b.focus({preventScroll:true});}}}
function scheduleStrips({force=false,wait=120}={}){clearTimeout(J.timer);J.timer=setTimeout(async()=>{drawStrips();if(!current())return;await loadJourney({force});drawStrips();},wait);}
function openStep(target){const A=app();
 if(target==='projects'||target==='interview'){A.switchView&&A.switchView(target);return;}
 if(A.switchView)A.switchView('library');
 setTimeout(()=>{const t=target==='status'?$('workflowStatus'):$('journeyLibrary');if(t&&!t.hidden)t.scrollIntoView({block:'start',behavior:reduced()?'auto':'smooth'});else window.scrollTo({top:0});},60);}
document.addEventListener('click',e=>{const b=e.target.closest('[data-journey]');if(b)openStep(b.dataset.journey);});
document.addEventListener('change',e=>{const s=e.target.closest&&e.target.closest('[data-journey-pick]');if(s&&app().selectProject)app().selectProject(s.value);});
window.addEventListener('atlas-context',()=>scheduleStrips());
window.addEventListener('atlas-project-saved',()=>scheduleStrips({force:true}));
window.addEventListener('atlas-submitted',()=>{J.justSubmitted=true;J.status.clear();scheduleStrips({force:true,wait:500});});

/* ---------- wiring ---------- */
function onLibraryShown(){loadQueue({force:true});scheduleStrips({force:true,wait:0});}
function start(){const l=lib();if(!l)return;
 new MutationObserver(()=>{if(!l.hidden)onLibraryShown();}).observe(l,{attributes:true,attributeFilter:['hidden']});
 window.AtlasAuth?.onSignedIn?.(()=>{Q.loadedAt=0;loadQueue({force:true});scheduleStrips({force:true,wait:0});});
 // the count on the Library tab is there from the first paint for a reviewer, whichever page they are on
 canReview().then(ok=>{if(ok)loadQueue({force:true});}); scheduleStrips({force:true,wait:300});
 if(!l.hidden)onLibraryShown();}
window.AtlasReviewUI={refresh:()=>loadQueue({force:true}),open:openReview,undo,rows,strips:()=>scheduleStrips({force:true,wait:0}),model,state:()=>({pending:!!deferred.pending(),items:Q.items.length,hidden:[...Q.hidden]})};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
