/* ATLAS Bids view (WOW_SPEC F1.7, F2.6 bid side, F7.3). Contributes to window.AtlasWowUI; uses window.ATLAS_APP and window.AtlasBids.
   Renders every bid exactly in the view the server returned (author or other): nothing is masked or un-masked here, and every
   dynamic string goes through esc(). Nothing is sent by ATLAS: a proof request gives a mailto draft and queued outreach rows. */
(()=>{'use strict';
const W=window.AtlasWowUI=window.AtlasWowUI||{},B=window.AtlasBids,esc=B.esc,$=id=>document.getElementById(id),app=()=>window.ATLAS_APP;
const HEX=/^[a-f0-9]{32}$/,EMAIL=/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/,DOCX='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const int=v=>Number.isInteger(v)&&v>=0?v:0;
const OUTCOME={pending:'Outcome pending',won:'Won',lost:'Lost',withdrawn:'Withdrawn'};
const KIND={capability:'Capability',sector:'Sector',outcome:'Outcome',constraint:'Constraint',credential:'Credential'};
const COV={covered:'Covered',partial:'Partial',unmet:'Unmet',unknown:'Unknown'};
const STATUS={in_review:'In review',needs_work:'Needs work',changes_requested:'Changes requested',awaiting_validation:'Awaiting N+1',published:'Shared in internal library',withdrawn:'Withdrawn'};
const FIT={'strong-contextual-fit':'JEV: strong contextual fit','partial-fit':'JEV: partial fit','poor-contextual-fit':'JEV: poor contextual fit','review-first':'JEV: review first'};
const VCHIP={strong:'Strong proof',partial:'Partial',none:'No strong match',unranked:'Not ranked',empty_library:'Library empty'};
const GAP_RESULT={answered_unverified:'answered · unverified',unknown:'answered: not known',deferred:'deferred',open:'not answered'};
const S={built:false,boot:{},list:[],all:false,bid:null,picks:new Set(),onePager:null,editing:false,prospects:[],fileName:'',gapDetails:new Map(),seq:0};
const verdictChip=v=>`<span class="verdict-chip v-${esc(VCHIP[v]?v:'pending')}">${esc(VCHIP[v]||'Not matched yet')}</span>`;
const say=(id,text)=>{const el=$(id);if(el)el.textContent=text||'';};
async function ensure(){const b=await app().bootInfo();S.boot=b||{};const sec=$('bids');
 if(!S.boot.library||!S.boot.features?.bids){sec.innerHTML='<div class="empty-state"><h2>Bid proof is not available here.</h2><p>This deployment has not turned it on.</p></div>';S.built=false;return false;}
 if(!S.built)build(sec);return true;}
function build(sec){S.built=true;const F=S.boot.features||{},rev=['admin','reviewer'].includes(S.boot.libraryRole);
 const accept='.txt,.md,.docx,.pptx'+(F.pdfBriefs?',.pdf':'');
 sec.innerHTML=`<div class="page-intro compact"><div><p class="eyebrow">BID PROOF</p><h1>Brief in.<br/><span>Proof out.</span></h1><p class="lead">Paste a customer brief. ATLAS finds published references that prove what the bid needs, and says so plainly when nothing does.</p></div></div>
<div class="bids-layout"><div class="bids-side">
<section class="bid-panel" aria-labelledby="bidListTitle"><div class="impact-head"><h2 class="panel-title" id="bidListTitle">${rev?'Bids':'My bids'}</h2>${rev?'<label class="check inline"><input id="bidAll" type="checkbox"/><span>All bids</span></label>':''}</div><ul class="bid-list" id="bidList"><li class="tiny muted">Loading…</li></ul></section>
<form class="bid-panel" id="bidNew" novalidate="" aria-labelledby="bidNewTitle"><h2 class="panel-title" id="bidNewTitle">New bid</h2>
<label class="field-label" for="bidTitle">Internal title</label><input id="bidTitle" maxlength="140" autocomplete="off" aria-describedby="bidTitleHint"/><p class="hint" id="bidTitleHint">your full internal title; only you see it</p>
<label class="field-label" for="bidAlias">Alias (required)</label><input id="bidAlias" maxlength="80" autocomplete="off" required="" aria-describedby="bidAliasHint"/><p class="hint" id="bidAliasHint">code name colleagues and AI see; no company names</p>
<label class="field-label" for="bidProspects">Names to keep away from AI</label><div class="chip-input"><span class="chips" id="bidProspectChips"></span><input id="bidProspects" maxlength="120" autocomplete="off" placeholder="Type a name, then Enter" aria-describedby="bidProspectsHint"/></div><p class="hint" id="bidProspectsHint">company names and aliases to keep away from AI</p>
<label class="field-label" for="bidBrief">Customer brief</label><textarea id="bidBrief" rows="7" maxlength="60000" placeholder="Paste the brief, or upload it below."></textarea><p class="hint" id="bidBriefCount">0 / 60,000 characters</p>
<label class="field-label" for="bidFile">Or upload the brief</label><input id="bidFile" type="file" accept="${esc(accept)}"/><p class="hint" id="bidFileHint">${F.pdfBriefs?'.txt, .md, .docx, .pptx or .pdf':'.txt, .md, .docx or .pptx'}, read in your browser${F.pdfBriefs?' (PDF text is extracted by ATLAS)':''}. Images are refused.</p>
<button class="btn primary" id="bidCreate" type="submit">Create the bid</button>
<p class="tiny muted">The brief stays on ATLAS. Before any AI step, declared names, contact details and every client name known to ATLAS are masked.</p><p class="tiny bid-status" id="bidNewStatus" role="status"></p></form>
<section class="bid-panel" hidden="" id="winStats" aria-labelledby="winStatsTitle"></section>
</div><div class="bid-detail" id="bidDetail"></div></div>`;
 const dlg=document.createElement('dialog');dlg.id='gapDialog';dlg.className='gap-dialog';dlg.setAttribute('aria-labelledby','gapDialogTitle');
 dlg.innerHTML=`<div class="dialog-head"><div><p class="eyebrow">ASK FOR PROOF</p><h2 id="gapDialogTitle">About five minutes of proof from a consultant.</h2></div><button aria-label="Close" class="close" data-close="" type="button">×</button></div>
<fieldset class="gap-fieldset"><legend class="field-label">Requirements (up to 3)</legend><div id="gapReqs"></div></fieldset>
<fieldset class="gap-fieldset"><legend class="field-label">Who can give the proof?</legend><div id="gapPeople"></div><label class="check"><input id="gapWhoEmail" name="gapWho" type="radio" value="email"/><span>Someone else</span></label><input aria-label="Their email" autocomplete="off" id="gapEmail" maxlength="200" placeholder="name@mantu.com" type="email"/></fieldset>
<p class="tiny muted">ATLAS sends nothing. You get an email draft to send yourself; a Teams message waits for an admin or reviewer to approve it.</p>
<div class="actions"><button class="btn primary" id="gapCreate" type="button">Create the request</button><button class="btn" data-close="" type="button">Cancel</button></div><p class="tiny bid-status" id="gapStatus" role="status"></p><div hidden="" id="gapResult"></div>`;
 document.getElementById('gapDialog')?.remove();document.body.append(dlg);
 sec.addEventListener('click',onClick);sec.addEventListener('change',onChange);dlg.addEventListener('click',onGapClick);dlg.addEventListener('change',onGapChange);
 $('bidNew').addEventListener('submit',create);
 $('bidProspects').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===','){e.preventDefault();addProspect();}else if(e.key==='Backspace'&&!e.target.value&&S.prospects.length){S.prospects.pop();renderProspects();}});
 $('bidProspects').addEventListener('blur',addProspect);
 $('bidBrief').addEventListener('input',()=>say('bidBriefCount',$('bidBrief').value.length.toLocaleString()+' / 60,000 characters'));
 $('bidFile').addEventListener('change',onFile);
 window.AtlasAuth?.dirty(()=>!!$('bidBrief')?.value.trim()); // an unsent brief is never reloaded away by a re-sign-in (WOW_ZERO_CONFIG §3.7)
 renderDetail();}
// ---- new bid form
function addProspect(){const el=$('bidProspects'),v=el.value.replace(/,+$/,'').trim().slice(0,120);el.value='';if(!v)return;
 if(S.prospects.length>=10){say('bidNewStatus','Up to 10 names. Remove one first.');return;}
 if(!S.prospects.some(x=>x.toLowerCase()===v.toLowerCase()))S.prospects.push(v);renderProspects();}
function renderProspects(){$('bidProspectChips').innerHTML=S.prospects.map((n,i)=>`<span class="chip">${esc(n)}<button aria-label="Remove ${esc(n)}" data-prospect-remove="${i}" type="button">×</button></span>`).join('');}
const reEsc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s+');
const namesProspect=alias=>S.prospects.some(n=>new RegExp('(?<![\\p{L}\\p{N}])'+reEsc(n)+'(?![\\p{L}\\p{N}])','iu').test(alias));
const unxml=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
async function docxText(bytes){const z=window.AtlasOffice.entries(bytes),get=z.get('word/document.xml');if(!get)throw Error('This .docx has no document text.');
 const xml=new TextDecoder().decode(await get());return xml.split(/<\/w:p>/).map(p=>[...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(m=>unxml(m[1])).join('')).filter(t=>t.trim()).join('\n');}
async function pdfText(file){const r=await window.AtlasAuth.fetch('/api/sheet/ingest',{method:'POST',headers:{'X-Atlas-CSRF':S.boot.csrf,'Content-Type':file.type||'application/pdf','x-file-name':file.name.slice(0,200)},body:new Uint8Array(await file.arrayBuffer())});
 const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'The PDF could not be read.');return String(d.text||'');}
async function readBrief(file){const ext=(file.name.split('.').pop()||'').toLowerCase();
 if(/^image\//.test(file.type||'')||['png','jpg','jpeg','gif','webp','heic','heif','bmp','svg','tif','tiff','avif'].includes(ext))throw Error('Images are refused. Upload the brief as .txt, .md, .docx or .pptx, or paste its text.');
 if(ext==='pdf'){if(!S.boot.features?.pdfBriefs)throw Error('PDF briefs are off in this deployment. Upload .txt, .md, .docx or .pptx, or paste the text.');return pdfText(file);}
 if(!['txt','md','docx','pptx'].includes(ext))throw Error('Upload .txt, .md, .docx or .pptx, or paste the text.');
 if(file.size>5000000)throw Error('This file is over 5 MB. Paste the relevant part of the brief instead.');
 const bytes=new Uint8Array(await file.arrayBuffer());if(ext==='pptx')return window.AtlasOffice.pptxText(bytes);if(ext==='docx')return docxText(bytes);
 const t=new TextDecoder().decode(bytes);if(t.includes('\0'))throw Error('This file is not plain text.');return t;}
async function onFile(e){const f=e.target.files?.[0];if(!f)return;say('bidNewStatus','Reading '+f.name+'…');
 try{const text=String(await readBrief(f)).trim();if(!text)throw Error(/\.pdf$/i.test(f.name)?'This PDF has no text ATLAS can read (a scanned document?). Paste the relevant text instead, or upload it as .docx.':'No text was found in this file.');$('bidBrief').value=text.slice(0,60000);S.fileName=f.name.slice(0,240);
  $('bidBrief').dispatchEvent(new Event('input'));say('bidNewStatus',text.length>60000?'Read '+f.name+'. Only the first 60,000 characters are kept.':'Read '+f.name+'. Check the text before creating the bid.');}
 catch(err){e.target.value='';S.fileName='';say('bidNewStatus',err.message);}}
async function create(e){e.preventDefault();addProspect();const title=$('bidTitle').value.trim(),alias=$('bidAlias').value.trim(),brief=$('bidBrief').value.trim();
 const stop=(id,m)=>{say('bidNewStatus',m);$(id).focus();};
 if(title.length<3)return stop('bidTitle','Add your internal title (at least 3 characters).');
 if(alias.length<3)return stop('bidAlias','Add an alias (at least 3 characters): the code name colleagues and AI see.');
 if(namesProspect(alias))return stop('bidAlias','The alias must not name the prospect.');
 if(brief.length<40)return stop('bidBrief','Paste the brief (at least 40 characters) or upload it.');
 const btn=$('bidCreate');btn.disabled=true;say('bidNewStatus','Reading the brief and listing what the bid must prove…');
 try{const bid=await app().libraryApi('/bids',{method:'POST',body:{title,alias,prospectNames:S.prospects.slice(0,10),briefText:brief.slice(0,60000),...(S.fileName?{fileName:S.fileName}:{})}});
  $('bidNew').reset();S.prospects=[];S.fileName='';renderProspects();say('bidBriefCount','0 / 60,000 characters');say('bidNewStatus','');
  show(bid);reveal();loadList();app().toast('Bid created. Check its requirements, then find proof.');}
 catch(err){say('bidNewStatus',err.message);}finally{btn.disabled=false;}}
// ---- list and detail
async function loadList(){const el=$('bidList');if(!el)return;
 try{const d=await app().libraryApi('/bids'+(S.all?'?all=1':''));S.list=Array.isArray(d.items)?d.items:[];
  el.innerHTML=S.list.length?S.list.map(x=>`<li><button class="bid-item${S.bid?.id===x.id?' active':''}" data-bid-open="${esc(x.id)}" type="button"><span class="bid-alias">${esc(x.alias)}</span>${x.title?`<span class="tiny muted bid-own-title">${esc(x.title)}</span>`:''}<span class="bid-chips">${verdictChip(x.verdict)}${x.outcome&&x.outcome!=='pending'?`<span class="tag">${esc(OUTCOME[x.outcome]||x.outcome)}</span>`:''}</span></button></li>`).join(''):'<li class="tiny muted">No bids yet. Create one below.</li>';}
 catch(err){el.innerHTML=`<li class="tiny muted">${esc(err.message)}</li>`;}}
function show(bid){if(!bid||typeof bid!=='object')return;if(S.bid?.id!==bid.id){S.picks.clear();S.onePager=null;S.editing=false;S.gapDetails.clear();}S.bid=bid;renderDetail();
 for(const b of document.querySelectorAll('#bidList [data-bid-open]'))b.classList.toggle('active',b.dataset.bidOpen===bid.id);}
async function openBid(id){if(!HEX.test(String(id||'')))return false;if($('bids').hidden)app().switchView('bids');if(!await ensure())return false;const seq=++S.seq;
 try{const bid=await app().libraryApi('/bids/'+encodeURIComponent(id));if(seq===S.seq)show(bid);return true;}
 catch(err){app().toast(/not found|404/i.test(err.message)?'This bid is not available to you.':err.message);return false;}}
// Stacked layout (under 900 px): bring the opened bid into view instead of leaving it below the form.
const reveal=()=>{if(matchMedia('(max-width:900px)').matches)$('bidDetail')?.scrollIntoView({block:'start'});};
async function refresh(){if(!S.bid)return;try{show(await app().libraryApi('/bids/'+encodeURIComponent(S.bid.id)));}catch{/* keep the current view */}}
function renderDetail(){const el=$('bidDetail');if(!el)return;const bid=S.bid;
 if(!bid){el.innerHTML='<div class="empty-state"><h3>Choose a bid, or create one.</h3><p>Each bid lists what it must prove, the references that prove it and an honest verdict when nothing does.</p></div>';return;}
 const P=bid.permissions||{},author=bid.view==='author',m=bid.match,F=S.boot.features||{},cov=new Map((Array.isArray(m?.coverage)?m.coverage:[]).map(c=>[c.requirementId,c]));
 const reqs=Array.isArray(bid.requirements)?bid.requirements:[];
 el.innerHTML=`<header class="bid-head"><div><p class="eyebrow">${author?'YOUR BID':'SHARED VIEW · NAMES MASKED'}${bid.purged?' · BRIEF DELETED':''}</p><h2 id="bidHeading">${esc(bid.alias)}</h2>
${author&&bid.title?`<p class="tiny muted bid-own-title">Internal title (only you see it): ${esc(bid.title)}</p>`:''}${author?'':'<p class="tiny muted">Names show as [company], [person] and [contact] in this view.</p>'}</div><div class="bid-chips">${verdictChip(m?.verdict)}<span class="tag">${esc(OUTCOME[bid.outcome]||bid.outcome||'')}</span></div></header>
${bid.purged?'<p class="gap-note">The internal title, the brief and the declared names were deleted. The alias, the masked requirements, the outcome and the references used are kept for the win statistics.</p>':''}
${author&&typeof bid.maskedPreview==='string'?`<details class="masked-preview" id="bidMaskedPreview"><summary>Declared names and contact details the AI never sees</summary><p class="tiny muted">Declared names and contact details are masked before any AI step. Other client names known to ATLAS are masked too, without being shown here.</p>${Array.isArray(bid.prospectNames)&&bid.prospectNames.length?`<p class="tiny">Declared: ${bid.prospectNames.map(esc).join(' · ')}</p>`:''}<pre class="masked-text">${esc(bid.maskedPreview)}</pre>${int(bid.briefChars)?`<p class="tiny muted">Brief: ${int(bid.briefChars).toLocaleString()} characters.</p>`:''}</details>`:''}
<section class="bid-section" aria-labelledby="bidReqTitle"><div class="impact-head"><h3 id="bidReqTitle">What the bid must prove</h3>${P.edit&&!bid.purged?`<button class="quiet" id="bidReqEdit" type="button">${S.editing?'Cancel editing':'Edit requirements'}</button>`:''}</div>
<p class="tiny muted">${esc({model:'Extracted by AI from the masked brief; check them.',keyword:'Found by keywords because the AI did not answer; check them.',manual:'Edited by the bid owner.'}[bid.reqMethod]||'')}</p>
<ol class="bid-reqs${S.editing?' editing':''}" id="bidRequirements">${reqs.map(q=>S.editing?editRow(q):reqRow(q,bid,cov,P,F)).join('')||'<li class="tiny muted">No requirements yet.</li>'}</ol>
${S.editing?`<div class="validation-actions"><button class="quiet" id="bidReqAdd" type="button">+ Add a requirement</button><button class="btn primary" id="bidReqSave" type="button">Save requirements</button></div>`:''}</section>
<section class="bid-section" aria-labelledby="bidProofTitle"><h3 id="bidProofTitle">Proof from the library</h3><div class="validation-actions"><button class="btn primary" id="bidMatchGo" type="button"${bid.purged&&!reqs.length?' disabled':''}>${m?'Search again':'Find proof'}</button>${F.customerJev?'<label class="check"><input id="bidJevConsent" type="checkbox"/><span>Send the anonymised requirements and candidate summaries to JEV (TypeSafe)</span></label>':''}</div>
<p class="tiny bid-status" id="bidMatchStatus" role="status"></p><div id="bidVerdict"${m?'':' hidden'}>${m?verdictHTML(m,bid,P,F):''}</div><div class="bid-results" id="bidResults">${m?resultsHTML(m,bid):''}</div>
<div class="onepager-controls"${m?.results?.length?'':' hidden'}><button class="btn" id="bidOnePagerGo" type="button" disabled="">Build the one-pager</button><span class="tiny muted" id="bidPickCount">Select 1 to 3 references.</span><label class="check"><input id="bidIncludeClient" type="checkbox"/><span>Include client names where you have full access (internal use only)</span></label></div>
<div class="onepager" id="onePager"${S.onePager?'':' hidden'}>${S.onePager?B.footnoteHTML(S.onePager):''}</div><div class="validation-actions" id="onePagerExports"${S.onePager?'':' hidden'}><button class="btn" data-export="docx" type="button">Word (.docx)</button><button class="btn" data-export="md" type="button">Markdown (.md)</button><button class="btn" data-export="print" type="button">Print</button></div></section>
<section class="bid-section" aria-labelledby="bidOutcomeTitle"><h3 id="bidOutcomeTitle">Outcome</h3>${P.decide?`<div class="bid-outcome"><label class="sr" for="bidOutcome">Outcome</label><select id="bidOutcome">${Object.entries(OUTCOME).map(([k,v])=>`<option value="${k}"${bid.outcome===k?' selected':''}>${esc(k==='pending'?'Pending':v)}</option>`).join('')}</select><label class="sr" for="bidOutcomeNote">Note</label><input id="bidOutcomeNote" maxlength="300" placeholder="Note (optional)"/><button class="btn" id="bidOutcomeSave" type="button">Save outcome</button></div><p class="tiny muted">The outcome feeds the win statistics: association, not causation.</p>`:`<p>${esc(OUTCOME[bid.outcome]||'')}</p>`}</section>
${P.delete&&!bid.purged?'<section class="bid-section bid-danger"><button class="btn" id="bidDelete" type="button">Delete the brief and names</button><p class="tiny muted">Erases the internal title, the brief and the declared names. The alias, masked requirements, outcome and uses stay for the statistics.</p></section>':''}`;
 syncPicks();fillGaps();}
function reqRow(q,bid,cov,P,F){const c=cov.get(q.id),st=c?.status;const canAsk=P.edit&&F.gaps&&!bid.purged&&(st==='partial'||st==='unmet');
 return `<li class="bid-req" data-req="${esc(q.id)}"><div class="req-line"><span class="req-id">${esc(q.id)}</span><span class="req-text">${esc(q.text)}</span></div><div class="tags">${st?`<span class="cov-chip cov-${esc(COV[st]?st:'unknown')}">${esc(COV[st]||st)}</span>`:'<span class="cov-chip cov-none">Not matched yet</span>'}<span class="tag">${esc(KIND[q.kind]||q.kind)}</span>${q.must?'<span class="tag yellow">Must</span>':''}${canAsk?`<button class="quiet" data-gap-ask="${esc(q.id)}" type="button">Ask for proof</button>`:''}</div><div class="req-gaps" data-req-gaps="${esc(q.id)}"></div></li>`;}
function editRow(q={id:'',text:'',kind:'capability',must:false}){return `<li class="bid-req editing" data-req="${esc(q.id)}"><input aria-label="Requirement ${esc(q.id||'new')}" class="req-edit-text" maxlength="240" value="${esc(q.text)}"/><select aria-label="Kind" class="req-edit-kind">${Object.entries(KIND).map(([k,v])=>`<option value="${k}"${q.kind===k?' selected':''}>${v}</option>`).join('')}</select><label class="check inline"><input class="req-edit-must" type="checkbox"${q.must?' checked':''}/><span>Must</span></label><button class="quiet" data-req-remove="" type="button">Remove</button></li>`;}
function verdictHTML(m,bid,P,F){const c=B.verdictCopy(m.verdict,m);if(!c)return '';const canAsk=P.edit&&F.gaps&&!bid.purged;
 return `<div class="verdict-banner v-${esc(c.tone)}" role="status"><strong>${esc(c.text)}</strong>${c.cta?(canAsk?`<button class="btn" data-gap-ask="" type="button">${esc(c.cta)}</button>`:`<span class="tiny">${F.gaps?'The bid owner can ask consultants for proof.':''}</span>`):''}</div>
<p class="tiny muted">${m.note?esc(m.note)+' ':''}Method: ${esc(m.method||'')}. ${esc(m.label||'')} The match thresholds are pilot values, not calibrated.</p>`;}
function resultsHTML(m,bid){const rs=Array.isArray(m.results)?m.results:[];if(!rs.length)return '';return rs.map(r=>resultCard(r,bid)).join('');}
function winLine(ws){if(!ws)return '<p class="tiny muted">Ordering may include a bounded win-history adjustment.</p>';
 const d=int(ws.decided);if(typeof ws.winRate!=='number')return `<p class="tiny muted">Win history: fewer than 5 decided bids (n=${d} decided).</p>`;
 return `<p class="tiny win-signal">Win history: won ${int(ws.won)} of ${d} decided bids (n=${d} decided, association not causation).</p>`;}
function resultCard(r,bid){const used=(Array.isArray(bid.used)?bid.used:[]).find(u=>u.refId===r.id);
 const rel=typeof r.relevance==='number'?'relevance '+Math.round(r.relevance):'not ranked',sim='similarity '+(typeof r.similarity==='number'?r.similarity.toFixed(2):'n/a')+' · '+(r.retrieval==='lexical'?'keyword':'semantic');
 const covers=(Array.isArray(r.covers)?r.covers:[]).map(esc).join(' '),tr=Array.isArray(r.transferable)?r.transferable:[];
 return `<article class="bid-result" data-result="${esc(r.id)}"><div class="impact-head"><strong>${esc(r.title)}</strong><span>${esc(rel)} · ${esc(sim)}</span></div>
<div class="tags"><span class="status-badge status-${esc(r.status)}">${esc(STATUS[r.status]||r.status)}</span>${covers?`<span class="tag">Covers ${covers}</span>`:''}<span class="tag">Claims confirmed ${int(r.claims?.confirmed)}/${int(r.claims?.total)}</span>${FIT[r.fitClass]?`<span class="tag">${esc(FIT[r.fitClass])}</span>`:''}</div>
${r.why?`<p class="small">${esc(r.why)}</p>`:''}${tr.length?`<p class="tiny"><b>Transfers:</b> ${tr.map(esc).join(' · ')}</p>`:''}${r.caveat?`<p class="tiny muted">Caveat: ${esc(r.caveat)}</p>`:''}${winLine(r.winSignal)}
<div class="validation-actions"><label class="check inline"><input data-bid-pick="${esc(r.id)}" type="checkbox"${S.picks.has(r.id)?' checked':''}/><span>Use in the one-pager</span></label>${used?`<span class="tag used">Used in this bid · r${esc(used.revision)}</span>`:`<button class="quiet" data-bid-use="${esc(r.id)}" type="button">Mark as used in this bid</button>`}<button class="quiet" data-open-record="${esc(r.id)}" type="button">Open reference →</button></div></article>`;}
function syncPicks(){const n=S.picks.size,go=$('bidOnePagerGo');if(!go)return;go.disabled=n<1||n>3;say('bidPickCount',n?n+' selected (up to 3).':'Select 1 to 3 references.');}
// Gap answers under each requirement: summaries come with the bid; answered requests are fetched once (creator view).
function fillGaps(){const bid=S.bid,gaps=Array.isArray(bid?.gaps)?bid.gaps:[];
 for(const box of document.querySelectorAll('#bidRequirements [data-req-gaps]')){const rid=box.dataset.reqGaps,mine=gaps.filter(g=>Array.isArray(g.requirementIds)&&g.requirementIds.includes(rid));
  box.innerHTML=mine.map(g=>{const d=S.gapDetails.get(g.id),idx=(g.requirementIds||[]).indexOf(rid),ask=d?.asks?.[idx],res=ask&&Array.isArray(d.results)?d.results.find(x=>x.askId===ask.id):null;
   const quotes=res&&Array.isArray(res.quotes)?res.quotes:[];
   return `<div class="gap-answer"><p class="tiny">Proof requested from ${esc(g.assigneeName||'a consultant')} · ${esc(g.status==='answered'?'answered':g.status)}${g.answeredAt?' · '+esc(String(g.answeredAt).slice(0,10)):''}</p>${res?`<p class="tiny gap-label">${esc(GAP_RESULT[res.status]||res.status)}</p>${quotes.map(q=>`<blockquote class="gap-quote">${esc(q)}</blockquote>`).join('')}${quotes.length?'<p class="tiny muted">From the interview · unverified speech recognition</p>':''}`:''}</div>`;}).join('');}  // quotes come with any status: always labelled (rule 10)
 for(const g of gaps)if(g.status==='answered'&&!S.gapDetails.has(g.id)&&HEX.test(String(g.id))){S.gapDetails.set(g.id,null);
  app().libraryApi('/gaps/'+encodeURIComponent(g.id)).then(d=>{S.gapDetails.set(g.id,d);if(S.bid===bid)fillGaps();}).catch(()=>S.gapDetails.delete(g.id));}}
// ---- actions
async function match(){const bid=S.bid,btn=$('bidMatchGo');if(!bid)return;const body={limit:6};
 if(S.boot.features?.customerJev){const c=!!$('bidJevConsent')?.checked;body.useJev=c;body.jevConsent=c;}
 btn.disabled=true;say('bidMatchStatus','Searching the published references…');
 try{const run=await app().libraryApi('/bids/'+encodeURIComponent(bid.id)+'/match',{method:'POST',body});if(S.bid!==bid)return;S.bid={...bid,match:run};S.picks.clear();S.onePager=null;renderDetail();loadList();}
 catch(err){say('bidMatchStatus',err.message);btn.disabled=false;}}
async function saveRequirements(){const bid=S.bid,rows=[...document.querySelectorAll('#bidRequirements li.editing')];
 const requirements=rows.map(li=>({...(li.dataset.req?{id:li.dataset.req}:{}),text:li.querySelector('.req-edit-text').value.trim().slice(0,240),kind:li.querySelector('.req-edit-kind').value,must:li.querySelector('.req-edit-must').checked})).filter(r=>r.text);
 if(requirements.length>12){app().toast('Up to 12 requirements.');return;}
 try{const next=await app().libraryApi('/bids/'+encodeURIComponent(bid.id)+'/requirements',{method:'POST',body:{requirements}});S.editing=false;show(next);app().toast('Requirements saved. Search again to update the coverage.');}
 catch(err){app().toast(err.message);}}
async function onePager(){const bid=S.bid,ids=[...S.picks],btn=$('bidOnePagerGo');if(!bid||ids.length<1||ids.length>3)return;btn.disabled=true;say('bidPickCount','Writing the one-pager from the cited words…');
 try{const op=await app().libraryApi('/bids/'+encodeURIComponent(bid.id)+'/onepager',{method:'POST',body:{refIds:ids,includeClient:!!$('bidIncludeClient')?.checked}});if(S.bid!==bid)return;S.onePager=op;
  const el=$('onePager');el.innerHTML=B.footnoteHTML(op);el.hidden=false;$('onePagerExports').hidden=false;syncPicks();el.scrollIntoView({block:'nearest'});}
 catch(err){syncPicks();say('bidPickCount',err.message);}}
function exportOnePager(kind){const op=S.onePager,bid=S.bid;if(!op||!bid)return;const name=B.fileName(bid.alias);
 if(kind==='docx'){app().download(name+'.docx',window.AtlasDocx.buildOnePager(B.onePagerDocxModel(op)),DOCX);app().toast('One-pager downloaded (.docx).');}
 else if(kind==='md'){app().download(name+'.md',B.onePagerMarkdown(op),'text/markdown');app().toast('One-pager downloaded (.md).');}
 else if(kind==='print'){const done=()=>document.body.classList.remove('print-onepager');document.body.classList.add('print-onepager');window.addEventListener('afterprint',done,{once:true});try{window.print();}finally{done();}}}
async function markUsed(refId,btn){const bid=S.bid;if(!bid)return;btn.disabled=true;
 try{const r=await app().libraryApi('/bids/'+encodeURIComponent(bid.id)+'/use',{method:'POST',body:{refIds:[refId]}});const used=(Array.isArray(bid.used)?bid.used:[]).filter(u=>!(r.used||[]).some(x=>x.refId===u.refId)).concat(r.used||[]);
  if(S.bid!==bid)return;S.bid={...bid,used};const card=document.querySelector(`#bidResults [data-result="${CSS.escape(refId)}"]`),res=(bid.match?.results||[]).find(x=>x.id===refId);if(card&&res)card.outerHTML=resultCard(res,S.bid);app().toast('Marked as used in this bid.');}
 catch(err){btn.disabled=false;app().toast(err.message);}}
async function saveOutcome(){const bid=S.bid;try{const next=await app().libraryApi('/bids/'+encodeURIComponent(bid.id)+'/outcome',{method:'POST',body:{outcome:$('bidOutcome').value,note:$('bidOutcomeNote').value.trim().slice(0,300)}});show(next);loadList();renderWins();app().toast('Outcome saved.');}
 catch(err){app().toast(err.message);}}
function purge(){const bid=S.bid;if(!bid)return;
 app().confirm('Delete the brief and names?','ATLAS erases the internal title, the brief text, the declared names and the masking map, for everyone and for good. It keeps the alias, the masked requirements, the outcome and which references were used, so the win statistics stay correct.',async()=>{
  try{const next=await app().libraryApi('/bids/'+encodeURIComponent(bid.id)+'/delete',{method:'POST',body:{}});S.onePager=null;show(next);loadList();app().toast('The brief and names were deleted. The alias, requirements, outcome and uses are kept.');}
  catch(err){app().toast(err.message);}});}
// ---- win statistics (F7.3): proof types for everyone; stories only when the server returns rows for this viewer
async function renderWins(){const el=$('winStats');if(!el)return;if(!S.boot.features?.wins){el.hidden=true;el.replaceChildren();return;}
 try{const w=await app().libraryApi('/wins'),cell=r=>{const c=B.winCell(r);return `<td>n=${c.n}</td><td class="${c.low?'muted low-n':'win-rate'}">${esc(c.text)}</td>`;};
  const pts=Array.isArray(w.proofTypes)?w.proofTypes:[],stories=Array.isArray(w.stories)?w.stories:[];el.hidden=false;
  el.innerHTML=`<h2 class="panel-title" id="winStatsTitle">What wins</h2><p class="tiny muted">${esc(w.label||'Association, not causation. Weights are uncalibrated.')}</p>
<div class="table-scroll"><table class="win-table" id="winProofTypes"><caption class="sr">Wins by proof type</caption><thead><tr><th scope="col">Proof type</th><th scope="col">Used</th><th scope="col">Decided</th><th scope="col">Win rate</th></tr></thead><tbody>${pts.map(r=>`<tr><th scope="row">${esc(B.proofTypeLabel(r.proofType))}</th><td>${int(r.used)}</td>${cell(r)}</tr>`).join('')||'<tr><td colspan="4" class="muted">No bids decided yet.</td></tr>'}</tbody></table></div>
${stories.length?`<h3 class="panel-sub">Stories</h3><div class="table-scroll"><table class="win-table" id="winStories"><caption class="sr">Wins by story</caption><thead><tr><th scope="col">Story</th><th scope="col">Used</th><th scope="col">Decided</th><th scope="col">Win rate</th></tr></thead><tbody>${stories.map(r=>`<tr><th scope="row"><button class="quiet" data-open-record="${esc(r.refId)}" type="button">${esc(r.title||r.refId)}</button></th><td>${int(r.used)}</td>${cell(r)}</tr>`).join('')}</tbody></table></div>`:''}
<p class="tiny muted">${int(w.totals?.bids)} bids · ${int(w.totals?.decided)} decided. A rate appears from ${int(w.minN)||B.MIN_N} decided bids, with its 95% interval.</p>`;}
 catch(err){el.hidden=false;el.innerHTML=`<h2 class="panel-title" id="winStatsTitle">What wins</h2><p class="tiny muted">${esc(err.message)}</p>`;}}
// ---- ask for proof (F2.6)
function openGapDialog(reqId){const bid=S.bid,m=bid?.match,cov=new Map((Array.isArray(m?.coverage)?m.coverage:[]).map(c=>[c.requirementId,c]));
 const reqs=(bid?.requirements||[]),open=reqs.filter(q=>['partial','unmet'].includes(cov.get(q.id)?.status)),list=open.length?open:reqs;
 const pre=reqId?[reqId]:list.slice(0,3).map(q=>q.id);
 $('gapReqs').innerHTML=list.map(q=>`<label class="check"><input data-gap-req="${esc(q.id)}" type="checkbox"${pre.includes(q.id)?' checked':''}/><span><b>${esc(q.id)}</b> ${esc(q.text)}${cov.get(q.id)?` <span class="cov-chip cov-${esc(cov.get(q.id).status)}">${esc(COV[cov.get(q.id).status]||'')}</span>`:''}</span></label>`).join('')||'<p class="tiny muted">No requirements to ask about.</p>';
 $('gapEmail').value='';$('gapWhoEmail').checked=false;$('gapPeople').replaceChildren();$('gapResult').hidden=true;$('gapResult').replaceChildren();say('gapStatus','');$('gapCreate').disabled=false;renderPeople();app().open('gapDialog');}
function checkedReqs(){return [...document.querySelectorAll('#gapReqs [data-gap-req]:checked')].map(x=>x.dataset.gapReq);}
function renderPeople(){const m=S.bid?.match,ids=checkedReqs(),seen=new Set(),people=[];
 for(const c of (Array.isArray(m?.coverage)?m.coverage:[]))if(ids.includes(c.requirementId))for(const s of (Array.isArray(c.suggested)?c.suggested:[])){const k=s.refId+'|'+s.person;if(seen.has(k)||!Number.isInteger(s.person))continue;seen.add(k);people.push(s);}
 const title=id=>(m?.results||[]).find(r=>r.id===id)?.title,prev=document.querySelector('#gapDialog input[name=gapWho]:checked')?.value,keep=people.some(s=>s.refId+'|'+s.person===prev)?prev:null;
 $('gapPeople').innerHTML=people.length?`<p class="tiny muted">Suggested from the people on matching references, in reference order (never ranked).</p>`+people.map((s,i)=>`<label class="check"><input name="gapWho" type="radio" value="${esc(s.refId+'|'+s.person)}"${(keep?s.refId+'|'+s.person===keep:!i&&prev!=='email')?' checked':''}/><span>${esc(s.name||'Unnamed')}${s.role?' · '+esc(s.role):''}${title(s.refId)?` <span class="tiny muted">on ${esc(title(s.refId))}</span>`:''}</span></label>`).join(''):'<p class="tiny muted">No suggested people for these requirements. Type the email of someone who knows.</p>';
 if(!people.length)$('gapWhoEmail').checked=true;}
function onGapChange(e){const t=e.target;if(t.matches('[data-gap-req]')){if(checkedReqs().length>3){t.checked=false;say('gapStatus','Choose up to 3 requirements per request.');}renderPeople();}}
function onGapClick(e){if(e.target.closest('#gapCreate'))createGap();else if(e.target.closest('#gapCopy'))copyDraft();}
async function createGap(){const bid=S.bid,ids=checkedReqs(),who=document.querySelector('#gapDialog input[name=gapWho]:checked');if(!bid)return;
 if(!ids.length||ids.length>3){say('gapStatus','Choose 1 to 3 requirements.');return;}if(!who){say('gapStatus','Choose who can give the proof.');return;}
 let assignee,referenceId;if(who.value==='email'){const em=$('gapEmail').value.trim();if(!EMAIL.test(em)){say('gapStatus','Type a valid email address.');$('gapEmail').focus();return;}assignee={email:em};}
 else{const i=who.value.lastIndexOf('|');referenceId=who.value.slice(0,i);assignee={refId:referenceId,person:Number(who.value.slice(i+1))};}
 const btn=$('gapCreate');btn.disabled=true;say('gapStatus','Creating the request…');
 try{const g=await app().libraryApi('/gaps',{method:'POST',body:{bidId:bid.id,requirementIds:ids,assignee,...(referenceId?{referenceId}:{})}});say('gapStatus','');showGapResult(g);refresh();}
 catch(err){btn.disabled=false;say('gapStatus',err.message);}}
let draftText='';
function showGapResult(g){const d=g?.draft||{},el=$('gapResult');draftText=[d.subject,d.body].filter(Boolean).join('\n\n');
 const href='mailto:'+encodeURIComponent(d.to||'')+'?subject='+encodeURIComponent(d.subject||'')+'&body='+encodeURIComponent(d.body||'');
 el.innerHTML=`<h3>Request created</h3><p class="tiny muted">Nothing was sent. ${esc(g?.assigneeName||'The consultant')} sees it under Proof requests in the Library. Send the email yourself, or let an admin approve the Teams message.</p>
<div class="validation-actions"><a class="btn primary" href="${esc(href)}" id="gapMailto">Open the email draft</a><button class="btn" id="gapCopy" type="button">Copy</button></div><pre class="draft-text" id="gapDraftText">${esc(draftText)}</pre><div class="tags" id="gapChips">${B.outreachChips(g?.outreach,S.boot.features?.teams)}</div>`;el.hidden=false;}
async function copyDraft(){try{await navigator.clipboard.writeText(draftText);app().toast('Copied. Paste it into your own message.');}
 catch{const r=document.createRange();r.selectNodeContents($('gapDraftText'));const s=getSelection();s.removeAllRanges();s.addRange(r);app().toast('Selected. Press Ctrl+C or ⌘C to copy.');}}
// ---- events (delegated; the section is rendered once)
function onClick(e){const t=e.target.closest('button,[data-bid-open]');if(!t||t.disabled)return;const d=t.dataset;
 if(d.bidOpen)openBid(d.bidOpen).then(ok=>{if(ok)reveal();});else if(d.prospectRemove!==undefined){S.prospects.splice(Number(d.prospectRemove),1);renderProspects();}
 else if(t.id==='bidMatchGo')match();else if(t.id==='bidReqEdit'){S.editing=!S.editing;renderDetail();}
 else if(t.id==='bidReqAdd'){const ol=$('bidRequirements');if(ol.querySelectorAll('li.editing').length>=12){app().toast('Up to 12 requirements.');return;}ol.insertAdjacentHTML('beforeend',editRow());ol.lastElementChild.querySelector('.req-edit-text')?.focus();}
 else if(d.reqRemove!==undefined)t.closest('li')?.remove();else if(t.id==='bidReqSave')saveRequirements();
 else if(d.gapAsk!==undefined)openGapDialog(d.gapAsk||null);else if(t.id==='bidOnePagerGo')onePager();else if(d.export)exportOnePager(d.export);
 else if(d.bidUse)markUsed(d.bidUse,t);else if(t.id==='bidOutcomeSave')saveOutcome();else if(t.id==='bidDelete')purge();}
function onChange(e){const t=e.target;if(t.id==='bidAll'){S.all=t.checked;loadList();}
 else if(t.matches('[data-bid-pick]')){const id=t.dataset.bidPick;if(t.checked){if(S.picks.size>=3){t.checked=false;app().toast('Choose at most 3 references for the one-pager.');return;}S.picks.add(id);}else S.picks.delete(id);syncPicks();}}
W.renderBids=async()=>{if(!await ensure())return;loadList();renderWins();};
W.openBid=openBid;
// Deep links from app.js openFromHash: #bid/<32hex> (this file) and #gap/<32hex> (trust-ui.js, the assignee's proof request).
W.openHash=hash=>{const m=/^#(bid|gap)\/([a-f0-9]{32})$/.exec(String(hash||''));if(!m)return false;return m[1]==='bid'?W.openBid(m[2]):!!W.openGap?.(m[2]);};
})();
