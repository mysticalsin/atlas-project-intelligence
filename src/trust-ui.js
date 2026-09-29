/* ATLAS trust and capture UI (WOW_SPEC F3.4, F2.6, F4.7): claims confirmed by someone else in the record dialog, proof requests in
   the Library, and the reviewer's outreach approval queue and staffing CSV import in Insights. Contributes to window.AtlasWowUI.
   Every panel stays hidden unless its feature flag is on. ATLAS sends nothing: drafts are mailto links or copied text, and Teams
   rows wait for an approval (BLOCKED_EXTERNAL while Teams is not connected). Every dynamic string goes through esc(). */
(()=>{'use strict';
const W=window.AtlasWowUI=window.AtlasWowUI||{},B=window.AtlasBids,esc=B.esc,$=id=>document.getElementById(id),app=()=>window.ATLAS_APP;
const HEX=/^[a-f0-9]{32}$/,arr=v=>Array.isArray(v)?v:[],int=v=>Number.isInteger(v)&&v>=0?v:0;
const TOPICS=['Context','Contribution','Approach','Outcome','Evidence','Customer relevance'];
const KIND={interview_invite:'Interview invitation',gap_request:'Proof request',confirmation_request:'Confirmation request'};
const CHANNEL={teams:'Teams',email_draft:'Email draft',phone:'Phone'};
const S={boot:{},claims:{seq:0,ref:null,data:null,draft:null},gaps:{assigned:[],created:[]},gapSeq:0,gapLoad:null,outreach:{items:[],channels:{},drafts:new Map()}};
const boot=async()=>(S.boot=(await app().bootInfo())||{});
const say=(id,t)=>{const el=$(id);if(el)el.textContent=t||'';};
const day=iso=>{const d=new Date(iso);return isNaN(d)?'':d.toLocaleDateString([],{dateStyle:'medium'});};
const mailto=d=>'mailto:'+encodeURIComponent(d?.to||'')+'?subject='+encodeURIComponent(d?.subject||'')+'&body='+encodeURIComponent(d?.body||'');
async function copy(text,node){try{await navigator.clipboard.writeText(text);app().toast('Copied.');}
 catch{if(node){const r=document.createRange();r.selectNodeContents(node);const s=getSelection();s.removeAllRanges();s.addRange(r);}app().toast('Selected. Press Ctrl+C or ⌘C to copy.');}}
// ---------------------------------------------------------------- F3: claims in the record dialog
W.renderClaims=async record=>{const el=$('claimsBlock'),seq=++S.claims.seq;if(!el||!record)return;const b=await boot();
 // app.js has already hidden and emptied the block for this record. Claims need full access to the reference (F3.2).
 if(seq!==S.claims.seq||!b.library||!b.features?.claims||record.access!=='full')return;
 let d;try{d=await app().libraryApi('/claims/'+encodeURIComponent(record.id));}
 catch(err){if(seq!==S.claims.seq)return;el.hidden=false;el.innerHTML=`<h3>Confirmed by someone else</h3><p class="tiny muted">${esc(err.message)}</p>`;return;}
 if(seq!==S.claims.seq||window.__record?.id!==record.id)return;S.claims.ref=record;S.claims.data=d;S.claims.draft=null;drawClaims();};
function requestFor(c,reqs){return reqs.find(q=>q.status==='done'&&arr(q.claimIds).includes(c.id))||reqs.find(q=>q.status!=='cancelled'&&arr(q.claimIds).includes(c.id))||null;}
function badge(c,rev,reqs){const tag=(cls,text)=>`<span class="badge claim-badge claim-${cls}">${esc(text)}</span>`,at=Number.isInteger(c.confirmedRevision)?c.confirmedRevision:c.revision;
 if(c.current===false)return tag('stale',`Stale: ${{unverified:'proposed',corrected:'corrected',cant_say:'answered'}[c.status]||'confirmed'} on r${int(at)}; the sentence changed`);
 const moved=Number.isInteger(c.confirmedRevision)&&Number.isInteger(rev)&&c.confirmedRevision<rev?` on r${c.confirmedRevision}; sentence unchanged`:'',src=requestFor(c,reqs)?.managerSource;
 if(c.status==='manager_confirmed')return tag('confirmed','Confirmed by N+1'+(src==='staffing'?' (staffing record)':src==='directory'?' (N+1 from DNA)':src==='self_declared'?' (named by the consultant)':'')+moved);
 if(c.status==='client_confirmed')return tag('confirmed','Confirmed by the client contact'+moved);
 if(c.status==='corrected')return tag('corrected','Corrected: '+(c.note||'no note given'));
 if(c.status==='cant_say')return tag('cantsay','N+1 couldn’t say');
 return tag('unverified','Unverified');}
const checkRow=(value,topic,text)=>`<label class="check"><input data-claim-check="${esc(value)}" type="checkbox"/><span><b>${esc(TOPICS[topic]||'')}</b> ${esc(text)}</span></label>`;
function drawClaims(){const el=$('claimsBlock'),d=S.claims.data,r=S.claims.ref,F=S.boot.features||{},canEdit=!!r.permissions?.edit;
 const claims=arr(d.claims),reqs=arr(d.requests),rev=d.revision,claimed=new Set(claims.map(c=>c.topic+'\n'+c.text));
 const openReq=c=>reqs.some(q=>q.status==='open'&&arr(q.claimIds).includes(c.id));
 const reusable=claims.filter(c=>c.current!==false&&c.status==='unverified'&&!openReq(c)),cands=arr(d.candidates).filter(c=>!claimed.has(c.topic+'\n'+c.text));
 const again=q=>arr(q.claimIds).filter(id=>claims.some(c=>c.id===id&&c.current!==false&&c.status==='unverified'));
 const reqLine=q=>`<li><span class="tag">${esc(q.status==='open'?'Waiting':q.status==='stale'?'Stale':q.status==='expired'?'Expired':q.status==='done'?'Done':q.status)}</span> ${esc(q.kind==='client'?'Client contact':'N+1')} ${esc(q.toEmail||'')} · ${int(arr(q.claimIds).length)} sentence${arr(q.claimIds).length===1?'':'s'} · r${int(q.revision)}${q.status==='open'&&q.expiresAt?' · expires '+esc(day(q.expiresAt)):''}${canEdit&&q.status==='open'?` <button class="quiet" data-claims-cancel="${esc(q.id)}" type="button">Cancel</button>`:''}${canEdit&&['stale','expired'].includes(q.status)&&again(q).length?` <button class="quiet" data-claims-again="${esc(q.id)}" type="button">Ask again</button>`:''}</li>`;
 el.innerHTML=`<h3>Confirmed by someone else</h3><p class="tiny muted">An N+1 confirms exact sentences of this reference (current revision r${int(rev)}). A confirmation never changes its validation or publication.</p>
<ul class="claims-list">${claims.map(c=>`<li class="claim-row" data-claim="${esc(c.id)}"><span class="tag">${esc(TOPICS[c.topic]||'')}</span> <span class="claim-text">${esc(c.text)}</span> ${badge(c,rev,reqs)}${openReq(c)?' <span class="tiny muted">awaiting an answer</span>':''}</li>`).join('')||'<li class="tiny muted">No sentence has been sent for confirmation yet.</li>'}</ul>
${reqs.length?`<h4>Requests</h4><ul class="claims-requests">${reqs.map(reqLine).join('')}</ul>`:''}
${canEdit&&(cands.length||reusable.length)?`<details class="claims-ask"${claims.length?'':' open'}><summary>Ask for confirmation of sentences</summary><p class="tiny muted">Tick up to 8 sentences. The email carries only a link, never the sentences or the client name.</p><div class="claims-candidates">${reusable.map(c=>checkRow('claim:'+c.id,c.topic,c.text)).join('')}${cands.map(c=>checkRow(c.topic+':'+c.idx,c.topic,c.text)).join('')}</div>
${F.clientConfirm?`<div class="validation-actions"><label class="check inline"><input checked="" name="claimsKind" type="radio" value="manager"/><span>The N+1</span></label><label class="check inline"><input name="claimsKind" type="radio" value="client"/><span>A client contact</span></label><input aria-label="Client contact email" id="claimsToEmail" maxlength="200" placeholder="contact@client.example" type="email"/></div>`:''}
<button class="btn" id="claimsRequest" type="button">Ask for confirmation</button><p class="tiny bid-status" id="claimsStatus" role="status"></p></details>`:''}<div id="claimsDraft"${S.claims.draft?'':' hidden'}>${S.claims.draft?draftBlock(S.claims.draft):''}</div>`;
 el.hidden=false;}
function draftBlock(res){const d=res?.draft||{};
 return `<h4>Confirmation request created</h4><p class="tiny muted">Nothing was sent. Send the email yourself; a Teams message waits for an admin or reviewer to approve it.</p><div class="validation-actions"><a class="btn primary" href="${esc(mailto(d))}" id="claimsMailto">Open the email draft</a><button class="btn" id="claimsCopyLink" type="button">Copy the link</button></div><p class="tiny">Link for the confirmer: <code id="claimsLink">${esc(d.link||'')}</code></p><div class="tags">${B.outreachChips(res?.outreach,S.boot.features?.teams)}</div>`;}
async function requestClaims(ids0){const r=S.claims.ref,d=S.claims.data,btn=$('claimsRequest');if(!r||!d)return;
 const checks=ids0?[]:[...document.querySelectorAll('#claimsBlock [data-claim-check]:checked')];if(!ids0&&!checks.length){say('claimsStatus','Tick at least one sentence.');return;}
 if(checks.length>8){say('claimsStatus','Up to 8 sentences per request.');return;}
 const existing=ids0?ids0.slice():[],items=[];for(const c of checks){const v=c.dataset.claimCheck;if(v.startsWith('claim:'))existing.push(v.slice(6));else{const [t,i]=v.split(':').map(Number),x=arr(d.candidates).find(k=>k.topic===t&&k.idx===i);if(x)items.push({topic:t,idx:i,text:x.text});}}
 const kind=document.querySelector('#claimsBlock input[name=claimsKind]:checked')?.value==='client'?'client':'manager',toEmail=$('claimsToEmail')?.value.trim()||'';
 if(kind==='client'&&!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(toEmail)){say('claimsStatus','Type the client contact’s email.');return;}
 if(btn)btn.disabled=true;say('claimsStatus','Creating the request…');let res=null,error='';
 try{let ids=existing;if(items.length){const c=await app().libraryApi('/claims',{method:'POST',body:{refId:r.id,items}});ids=ids.concat(arr(c.claims).map(x=>x.id));}
  res=await app().libraryApi('/confirmations',{method:'POST',body:{refId:r.id,claimIds:[...new Set(ids)].slice(0,8),kind,...(kind==='client'?{toEmail}:{})}});}
 catch(err){error=err.message;}
 try{const fresh=await app().libraryApi('/claims/'+encodeURIComponent(r.id));if(S.claims.ref!==r)return;S.claims.data=fresh;}catch{/* keep the last view */}
 if(res)S.claims.draft=res;drawClaims();if(error){say('claimsStatus',error);const ask=$('claimsBlock').querySelector('details.claims-ask');if(ask)ask.open=true;}else app().toast('Request created. Nothing was sent: use the draft.');}
async function cancelRequest(id){const r=S.claims.ref;try{await app().libraryApi('/confirmations/'+encodeURIComponent(id)+'/cancel',{method:'POST',body:{}});S.claims.data=await app().libraryApi('/claims/'+encodeURIComponent(r.id));drawClaims();app().toast('Request cancelled.');}catch(err){app().toast(err.message);}}
$('claimsBlock')?.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled)return;
 if(b.id==='claimsRequest')requestClaims();else if(b.id==='claimsCopyLink')copy($('claimsLink')?.textContent||'',$('claimsLink'));
 else if(b.dataset.claimsCancel)cancelRequest(b.dataset.claimsCancel);
 else if(b.dataset.claimsAgain){const q=arr(S.claims.data?.requests).find(x=>x.id===b.dataset.claimsAgain),claims=arr(S.claims.data?.claims);
  requestClaims(arr(q?.claimIds).filter(id=>claims.some(c=>c.id===id&&c.current!==false&&c.status==='unverified')));}});
$('claimsBlock')?.addEventListener('change',e=>{if(e.target.matches('[data-claim-check]')&&document.querySelectorAll('#claimsBlock [data-claim-check]:checked').length>8){e.target.checked=false;say('claimsStatus','Up to 8 sentences per request.');}});
// ---------------------------------------------------------------- F2: proof requests in the Library ("Your interviews")
// Loads are numbered so only the latest one draws; openGap waits for it (a Library render starts one too).
W.renderProofRequests=()=>(S.gapLoad=loadProofRequests(++S.gapSeq));
async function loadProofRequests(seq){const el=$('proofRequests');if(!el)return;const b=await boot();
 if(!b.library||!b.features?.gaps){el.hidden=true;el.replaceChildren();return;}
 try{const d=await app().libraryApi('/gaps');if(seq!==S.gapSeq)return;S.gaps={assigned:arr(d.assigned),created:arr(d.created)};
  app().dropGapResults?.(S.gaps.assigned.filter(g=>g.status==='open').map(g=>g.id));}
 catch(err){if(seq!==S.gapSeq)return;el.hidden=false;el.innerHTML=`<h3>Proof requests</h3><p class="tiny muted">${esc(err.message)}</p>`;return;}
 drawProofRequests();}
function localAnswers(){const out=[];try{for(const p of app().profile().projects){const g=p.gapNotes;if(g?.requestId)out.push({projectId:p.id,title:p.title,requestId:g.requestId,apply:arr(g.sections).some(Boolean),send:arr(g.results).length>0});}}catch{/* no workspace */}return out;}
function drawProofRequests(){const el=$('proofRequests'),open=S.gaps.assigned.filter(g=>g.status==='open'),canStart=!!S.boot.features?.gapInterview,local=localAnswers();
 const localFor=id=>local.find(x=>x.requestId===id),orphans=local.filter(x=>x.apply&&!open.some(g=>g.id===x.requestId));
 // Answers kept with the notes (review #22): sendable while the request is open, even after a reload or a new conversation.
 const apply=x=>x&&(x.apply||x.send)?`<p class="tiny">Answers from your proof interview are on this device only.${x.send?` <button class="quiet" data-gap-send="${esc(x.projectId)}" type="button">Send these answers to the bid team</button>`:''}${x.apply?` <button class="quiet" data-gap-apply="${esc(x.projectId)}" type="button">Add these answers to my reference</button>`:''}</p>`:'';
 if(!open.length&&!orphans.length){el.hidden=true;el.replaceChildren();return;}
 el.innerHTML=`<h3>Proof requests</h3><p class="tiny muted">A bid team asked you for specific proof: about five minutes. Your answers stay on this device until you choose to send them or add them to your reference.</p>
${open.map(g=>`<article class="invite proof-request" data-gap-item="${esc(g.id)}"><div><b>${esc(g.bidAlias)}</b> <span class="tag">Proof request</span><ul class="gap-asks">${arr(g.asks).map(a=>`<li><span class="tiny muted">${esc(a.label)}:</span> ${esc(a.ask)}</li>`).join('')}</ul><p class="tiny muted">Asked ${esc(day(g.createdAt))}${g.referenceId?' · about one of your references':''}</p>${apply(localFor(g.id))}</div>
<div class="validation-actions">${canStart?`<button class="btn primary" data-gap-start="${esc(g.id)}" type="button">Start 5-minute interview</button>`:''}<button class="quiet" data-gap-dismiss="${esc(g.id)}" type="button">Dismiss</button></div></article>`).join('')}
${orphans.map(x=>`<article class="invite proof-request"><div><b>${esc(x.title)}</b> <span class="tag">Proof-interview answers</span>${apply(x)}</div></article>`).join('')}`;el.hidden=false;}
$('proofRequests')?.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled)return;const d=b.dataset;
 if(d.gapStart){const g=S.gaps.assigned.find(x=>x.id===d.gapStart);if(g)app().startFromGap({id:g.id,bidAlias:g.bidAlias,referenceId:g.referenceId||null});}
 else if(d.gapDismiss)app().confirm('Dismiss this proof request?','The bid team sees that you dismissed it. Nothing else is shared.',async()=>{try{await app().libraryApi('/gaps/'+encodeURIComponent(d.gapDismiss)+'/dismiss',{method:'POST',body:{}});W.renderProofRequests();app().toast('Dismissed.');}catch(err){app().toast(err.message);}});
 else if(d.gapSend)app().confirm('Send these answers to the bid team?','The bid team sees your answers labelled unverified speech recognition, with known client names and contact details masked. Nothing else is shared.',async()=>{try{await app().sendGapAnswers(d.gapSend);W.renderProofRequests();app().toast('Sent to the bid team.');}catch(err){app().toast(err.message);}});
 else if(d.gapApply)app().confirm('Add these answers to your reference?','They are appended to your answers (up to 6,000 characters per topic) and saved to the shared library as a new revision, so review and N+1 validation start again. They are self-reported and unverified.',async()=>{try{await app().applyGapNotes(d.gapApply);drawProofRequests();app().toast('Added to your reference and saved to the library.');}catch(err){app().toast(err.message);}});});
// #gap/<32hex>: the assignee's link from the draft email (focus the request), or the bid owner's (open the bid).
W.openGap=async id=>{if(!HEX.test(String(id||'')))return false;const b=await boot();if(!b.library||!b.features?.gaps){app().toast('Proof requests are not available here.');return false;}
 app().switchView('library');if(!S.gapLoad)W.renderProofRequests();
 try{await S.gapLoad;
  const clear=()=>history.replaceState(null,'',location.pathname+location.search),mine=S.gaps.assigned.find(g=>g.id===id&&g.status==='open');
  if(mine){clear();const item=document.querySelector(`#proofRequests [data-gap-item="${CSS.escape(id)}"]`);item?.scrollIntoView({block:'center'});item?.querySelector('button')?.focus({preventScroll:true});return true;}
  const made=S.gaps.created.find(g=>g.id===id);if(made&&HEX.test(String(made.bidId||''))){clear();return W.openBid?.(made.bidId)||false;}
  app().toast('This gap request is not available to you.');return false;}
 catch(err){app().toast(err.message);return false;}};
// ---------------------------------------------------------------- F4: outreach queue and staffing import (Insights, reviewers and admins)
W.renderOutreach=async()=>{const q=$('outreachQueue'),s=$('staffingImport'),b=await boot(),rev=['admin','reviewer'].includes(b.libraryRole)&&!!b.library;
 if(q){if(rev&&b.features?.outreach){q.hidden=false;q.innerHTML='<h3>Outreach waiting for approval</h3><p class="tiny muted">Loading…</p>';loadQueue();}else{q.hidden=true;q.replaceChildren();}}
 if(s){if(rev&&b.features?.staffing){s.hidden=false;drawStaffing();}else{s.hidden=true;s.replaceChildren();}}};
async function loadQueue(){try{const d=await app().libraryApi('/outreach');S.outreach.items=arr(d.items);S.outreach.channels=d.channels||{};drawQueue();}
 catch(err){$('outreachQueue').innerHTML=`<h3>Outreach waiting for approval</h3><p class="tiny muted">${esc(err.message)}</p>`;}}
function draftHTML(id,d){return `<div class="outreach-draft"><div class="validation-actions"><a class="btn primary" data-outreach-mailto="${esc(id)}" href="${esc(mailto(d))}">Open the email draft</a><button class="btn" data-outreach-copy="${esc(id)}" type="button">Copy</button>${d.ics?`<button class="btn" data-outreach-ics="${esc(id)}" type="button">Calendar (.ics)</button>`:''}</div><pre class="draft-text" data-outreach-text="${esc(id)}">${esc([d.subject,d.body].filter(Boolean).join('\n\n'))}</pre></div>`;}
// An approved email draft lives only in this page: after a reload the row offers it again (the server re-issues the same
// draft while the invitation or request is open; nothing is sent).
function row(o){const pending=o.status==='pending_approval',draft=S.outreach.drafts.get(o.id),again=o.status==='drafted'&&o.channel==='email_draft'&&!draft,st=o.status==='blocked_external'?'BLOCKED_EXTERNAL':B.outreachLabel(o.status);
 return `<article class="outreach-row" data-outreach="${esc(o.id)}"><div class="impact-head"><strong>${esc(KIND[o.kind]||o.kind)}</strong><span class="tags"><span class="tag">${esc(CHANNEL[o.channel]||o.channel)}</span><span class="tag outreach-status status-${esc(o.status)}">${esc(st)}</span></span></div>
${o.preview?.title?`<p class="small"><b>${esc(o.preview.title)}</b></p>`:''}${o.preview?.text?`<p class="tiny muted">${esc(o.preview.text)}</p>`:''}<p class="tiny muted">To ${esc(o.toEmail||'')}${o.createdAt?' · queued '+esc(day(o.createdAt)):''}${o.approvedBy?' · approved by '+esc(o.approvedBy):''}</p>${o.reason?`<p class="tiny outreach-reason">${esc(o.reason)}</p>`:''}
${pending?`<div class="validation-actions"><button class="btn primary" data-outreach-approve="${esc(o.id)}" type="button">Approve</button><button class="btn" data-outreach-dismiss="${esc(o.id)}" type="button">Dismiss</button></div>`:''}${again?`<div class="validation-actions"><button class="btn" data-outreach-approve="${esc(o.id)}" type="button">Show the draft again</button></div>`:''}${draft?draftHTML(o.id,draft):''}</article>`;}
function drawQueue(){const ch=S.outreach.channels||{},items=S.outreach.items,teams=ch.teams==='connected';
 $('outreachQueue').innerHTML=`<h3>Outreach waiting for approval</h3><p class="tiny muted">ATLAS never sends on its own. Approving an email gives you a draft to send yourself; a Teams message is sent only once Teams is connected.</p>
<div class="tags" id="outreachChannels"><span class="tag ${teams?'chip-teams':'chip-blocked'}">Teams: ${esc(teams?'connected':'BLOCKED_EXTERNAL')}</span><span class="tag chip-email">Email: drafts you send</span><span class="tag chip-blocked">Phone: ${esc(ch.phone==='available'?'available':'BLOCKED_EXTERNAL')}</span></div>
<div class="outreach-list">${items.map(row).join('')||'<p class="tiny muted">Nothing is waiting.</p>'}</div>`;}
async function act(id,action){try{const again=S.outreach.items.find(x=>x.id===id)?.status==='drafted',r=await app().libraryApi('/outreach/'+encodeURIComponent(id),{method:'POST',body:{action}}),i=S.outreach.items.findIndex(x=>x.id===id);
  if(i>=0&&r.item)S.outreach.items[i]=r.item;if(r.draft)S.outreach.drafts.set(id,r.draft);drawQueue();
  app().toast(action==='dismiss'?'Dismissed.':r.item?.status==='blocked_external'?'Not sent: '+(r.item.reason||'BLOCKED_EXTERNAL'):r.draft?(again?'The draft again. Nothing was sent: send it yourself.':'Approved. Nothing was sent: send the draft yourself.'):'Approved.');}
 catch(err){app().toast(err.message);}}
$('outreachQueue')?.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled)return;const d=b.dataset;
 if(d.outreachApprove){b.disabled=true;act(d.outreachApprove,'approve');}else if(d.outreachDismiss){b.disabled=true;act(d.outreachDismiss,'dismiss');}
 else if(d.outreachCopy){const x=S.outreach.drafts.get(d.outreachCopy);if(x)copy([x.subject,x.body].filter(Boolean).join('\n\n'),document.querySelector(`[data-outreach-text="${CSS.escape(d.outreachCopy)}"]`));}
 else if(d.outreachIcs){const x=S.outreach.drafts.get(d.outreachIcs);if(x?.ics)app().download('ATLAS_interview.ics',x.ics,'text/calendar');}});
function drawStaffing(){const el=$('staffingImport');
 el.innerHTML=`<h3>Import staffing (CSV)</h3><p class="tiny muted">Header row: <code>project_id,consultant_email,manager_email,manager_name,project_title,end_date</code>. Client, customer and account columns are never read or stored. A project ending within 7 days gets an interview invitation and outreach waiting for approval.</p>
<label class="field-label" for="staffingFile">CSV file</label><input accept=".csv,text/csv" id="staffingFile" type="file"/>
<label class="field-label" for="staffingCsv">Or paste the CSV</label><textarea id="staffingCsv" maxlength="200000" rows="5" spellcheck="false"></textarea>
<button class="btn" id="staffingGo" type="button">Import</button><p class="tiny bid-status" id="staffingStatus" role="status"></p><div id="staffingResult"></div>`;
 $('staffingFile').addEventListener('change',async e=>{const f=e.target.files?.[0];if(!f)return;if(f.size>200000){say('staffingStatus','The file is over 200,000 characters. Split it.');e.target.value='';return;}
  try{$('staffingCsv').value=await f.text();say('staffingStatus','Read '+f.name+'. Check it, then import.');}catch{say('staffingStatus','The file could not be read.');}});
 $('staffingGo').addEventListener('click',importCsv);}
async function importCsv(){const csv=$('staffingCsv').value,btn=$('staffingGo');if(!csv.trim()){say('staffingStatus','Choose a file or paste the CSV first.');return;}
 if(csv.length>200000){say('staffingStatus','Up to 200,000 characters per import.');return;}
 btn.disabled=true;say('staffingStatus','Importing…');
 try{const r=await app().libraryApi('/staffing/import',{method:'POST',body:{csv}});say('staffingStatus','');$('staffingResult').innerHTML=resultTable(r);if(int(r.outreachQueued))loadQueue();}
 catch(err){say('staffingStatus',err.message);}finally{btn.disabled=false;}}
function resultTable(r){const ign=arr(r.ignoredColumns).map(String),rej=arr(r.rejected),client=ign.filter(c=>/client|customer|account/i.test(c));
 return `<div class="table-scroll"><table class="record-table" id="staffingTable"><tbody><tr><th scope="row">Rows read</th><td>${int(r.rows)}</td></tr><tr><th scope="row">Staffing rows saved</th><td>${int(r.staffed)}</td></tr><tr><th scope="row">Interview invitations</th><td>${int(r.invited)}</td></tr><tr><th scope="row">Outreach waiting for approval</th><td>${int(r.outreachQueued)}</td></tr>
<tr><th scope="row">Ignored columns</th><td>${ign.length?ign.map(esc).join(', '):'None'}<br/><span class="tiny muted">Client, customer and account columns are never read or stored${client.length?' ('+client.map(esc).join(', ')+')':''}. Other extra columns are ignored.</span></td></tr></tbody></table></div>
${rej.length?`<h4>Rejected rows</h4><div class="table-scroll"><table class="record-table" id="staffingRejected"><thead><tr><th scope="col">Line</th><th scope="col">Why</th></tr></thead><tbody>${rej.map(x=>`<tr><td>${int(x.line)}</td><td>${esc(x.error)}</td></tr>`).join('')}</tbody></table></div>`:''}`;}
})();
