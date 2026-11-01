/* AtlasWorkflowUI (T15, v2.2 F2: calm times, the reviewer's claims with their context, the admin Connections table, now in Settings): the evidence workflow status in the Reference library view. One card per branch (Evidence, MAAP Review, Project
   Review, DNA, MiChat, IMP, Spotlight), read from GET /api/library/evidence/:id/status and rendered by AtlasWorkflowCore. Read-only: nothing
   here approves, grants, publishes or syncs. Every dynamic string is set with textContent. Shown only on the live site when the
   deployment has the library and the evidence workflow (bootstrap features.evidence_workflow) and the person has evidence records. */
(()=>{'use strict';
const C=window.AtlasWorkflowCore,$=id=>document.getElementById(id),app=()=>window.ATLAS_APP;
let items=[],selected='',busy=null,loadedAt=0;
function h(tag,attrs={},...kids){const el=document.createElement(tag);for(const [k,v] of Object.entries(attrs||{})){if(v===null||v===undefined||v===false)continue;if(k==='text')el.textContent=v;else if(k.startsWith('on'))el.addEventListener(k.slice(2),v);else el.setAttribute(k,v===true?'':String(v));}
 for(const k of kids.flat())if(k!==null&&k!==undefined&&k!==false)el.append(k instanceof Node?k:document.createTextNode(String(k)));return el;}
const slot=()=>$('workflowStatus');
function hide(){const s=slot();if(s){s.hidden=true;s.replaceChildren();}}
// The name of the project an evidence record belongs to, from this person's own projects (never a raw id in the picker).
const nameFor=x=>{try{const ps=typeof app().ownProjects==='function'?app().ownProjects():[],ref=x&&x.project_ref;const p=ps.find(q=>ref&&(q.details&&q.details.projectId===ref||q.id===ref));return p&&p.title||'';}catch{return '';}};
function cardEl(m){
 return h('article',{class:'wf-card','data-branch':m.branch,'data-tone':m.tone,'data-status':m.displayStatus},
  h('h3',{class:'wf-card-title',text:m.label}),
  h('p',{class:'wf-card-status',text:m.statusText}),
  m.badge?h('span',{class:'tag wf-mock',text:m.badge}):null,
  m.reasonText?h('p',{class:'tiny muted wf-card-reason',text:m.reasonText}):null,
  m.updatedAt?h('p',{class:'tiny muted wf-card-time',text:'Updated '+when(m.updatedAt)}):null);
}
// The server's ISO time, as the person's own local date and time ("31 Oct 2026, 12:25"); a value that is not a date is shown as it came.
const when=iso=>{const d=new Date(iso);if(!iso||Number.isNaN(d.getTime()))return String(iso||'');try{return d.toLocaleString([],{dateStyle:'medium',timeStyle:'short'});}catch{return String(iso);}};
function render(view){
 const s=slot();if(!s)return;const m=C.model(view);s.hidden=false;s.replaceChildren();
 const pick=h('select',{id:'workflowPick','aria-label':'Evidence record',onchange:e=>{selected=e.target.value;refresh({force:true});}},
  ...items.map(x=>h('option',{value:x.id,selected:x.id===selected},C.itemLabel(x,nameFor(x)))));
 s.append(h('div',{class:'wf-head'},h('div',{},h('p',{class:'eyebrow',text:'Evidence workflow'}),h('h2',{class:'panel-title',text:'Where each step stands'})),
   h('div',{class:'wf-tools'},pick,h('button',{class:'quiet',type:'button',id:'workflowRefresh',onclick:()=>refresh({force:true}),text:'Refresh'}))),
  h('p',{class:'wf-overall small','data-overall':m.overall.status,role:'status',text:m.overall.text}),
  h('div',{class:'wf-grid'},...m.cards.map(cardEl)),
  m.note?h('p',{class:'tiny muted wf-note',text:m.note}):null,
  h('div',{id:'wfClaims',class:'wf-claims',hidden:true}));
}
// ---- the claims behind the record, for the person reviewing it (not the author): each statement, who said what and how, and the sentence around it when ATLAS kept the claim uncertain ----
const TYPE_WORDS={deliverable:'Deliverable',technology:'Technology',outcome:'Outcome',metric:'Metric',credential:'Credential',context:'Context',learning:'Learning'};
const ORIGIN_WORDS={consultant_reported:'said by the consultant',unknown:'origin not established'};
function claimEl(c){const ref=Array.isArray(c.source_refs)?c.source_refs.find(r=>r&&r.kind==='interview')||c.source_refs[0]||{}:{};
 const quote=typeof ref.quote==='string'&&ref.quote?h('q',{class:'wf-quote',dir:'auto',lang:/^[a-z]{2,3}$/.test(ref.lang||'')?ref.lang:null,text:ref.quote}):null;
 const context=typeof ref.context==='string'&&ref.context?h('p',{class:'wf-context'},h('span',{class:'wf-context-label',text:'Read the sentence around it. It was negated, hypothetical or reported speech, so ATLAS did not treat it as the consultant’s own claim.'}),h('q',{class:'wf-quote',dir:'auto',lang:/^[a-z]{2,3}$/.test(ref.lang||'')?ref.lang:null,text:ref.context})):null;
 const tags=[ORIGIN_WORDS[c.origin]||String(c.origin||'').replace(/_/g,' '),ref.ledger_status==='uncertain'?'estimate':null,c.attribution&&c.attribution!=='unknown'?'attribution: '+String(c.attribution).replace(/_/g,' '):context?'attribution not established':null,'unverified'].filter(Boolean);
 return h('li',{class:'wf-claim','data-claim':c.claim_id||null},h('p',{class:'wf-claim-head'},h('b',{text:TYPE_WORDS[c.claim_type]||String(c.claim_type||'Claim')}),h('span',{class:'prov',text:tags.join(' · ')})),h('p',{class:'wf-claim-text',dir:'auto',text:String(c.statement||'')}),quote,context);}
async function renderClaims(id){const box=$('wfClaims');if(!box)return;box.hidden=true;box.replaceChildren();
 try{const rec=await app().libraryApi('/evidence/'+encodeURIComponent(id));if(selected!==id||!rec||rec.access!=='reviewer')return; // only the person reviewing someone else's record sees this
  const claims=Array.isArray(rec.claims)?rec.claims.slice(0,60):[];if(!claims.length)return;
  const open=claims.some(c=>Array.isArray(c.source_refs)&&c.source_refs.some(r=>r&&r.context));
  const d=h('details',{open},h('summary',{text:'Claims and their sources ('+claims.length+')'}),h('ul',{class:'wf-claim-list'},...claims.map(claimEl)));
  box.append(d);box.hidden=false;}catch(e){}}
// ---- the admin Connections panel: every connection of the framework and where it stands (GET /api/connections/status; names and booleans only) ----
const STATE_WORDS={ready:'Ready',mock:'Mock',not_configured:'Not configured'};
const REASON_WORDS={NOT_WIRED:'Not built yet',ADAPTERS_NOT_LIVE:'ATLAS is in mock mode',BASE_URL_MISSING:'Address not set',BASE_URL_INVALID:'Address is not valid',ENDPOINT_NOT_CONFIGURED:'Endpoint not set',FIELD_MAPPING_EMPTY:'Field mapping empty',ACK_RULE_MISSING:'Acknowledgement rule missing',TOKEN_URL_MISSING:'Token address not set',STATUS_NOT_CONFIGURED:'Not set up by its owner yet',NOT_HTTP_CONNECTOR:'Built into ATLAS'};
const reasonText=r=>/^SECRET_MISSING:/.test(r)?'Credential '+r.slice(15)+' not set':REASON_WORDS[r]||String(r).replace(/_/g,' ').toLowerCase();
const EVIDENCE_WORDS={not_configured:'not configured',configured_untested:'configured, not yet tried',contract_verified:'contract checked, not used live',live_verified:'used live'};
// One table row per connection: name (with a details disclosure), a state dot and word, and what is missing in one line. It renders into the Connections tab of the Settings sheet (settings-ui.js loads it
// when the tab opens); text only, nothing from the server is ever written as markup.
function connRow(c){const why=c.state==='ready'?[]:(c.reasons||[]).filter(r=>!(c.state==='mock'&&r==='ADAPTERS_NOT_LIVE')).slice(0,3).map(reasonText);
 const missing=[c.state==='mock'?'Reaches a test destination only: “Mock — not connected”.':'',...why,c.note||''].filter(Boolean).join(' · ')||'Nothing missing.';
 const detail=[(c.direction==='inbound'?'Reads from it':'Sends to it')+' · step '+c.workflow_step+(c.built_in?' · built into ATLAS':''),c.status==='not_configured'?'':EVIDENCE_WORDS[c.status]||String(c.status||'').replace(/_/g,' ')].filter(Boolean).join(' · ');
 return h('tr',{class:'conn-row','data-conn':c.id,'data-state':c.state},
  h('th',{scope:'row',class:'conn-name'},h('b',{text:c.label}),h('details',{class:'conn-more'},h('summary',{text:'Details'}),h('p',{class:'tiny muted',text:detail}))),
  h('td',{class:'conn-state'},h('span',{class:'conn-chip','data-state':c.state,text:STATE_WORDS[c.state]||c.state})),
  h('td',{class:'conn-why',text:missing}));}
async function refreshConnections(){const box=$('connectionsPanel');if(!box)return;
 try{await window.AtlasAuth?.probe?.();const b=await app().bootInfo();if(window.AtlasAuth?.mode!=='live'||b.libraryRole!=='admin'){box.replaceChildren();return;}
  const r=await window.AtlasAuth.fetch('/api/connections/status');if(!r.ok){box.replaceChildren(h('p',{class:'small muted',text:'The connections could not be loaded right now.'}));return;}
  const v=await r.json(),list=Array.isArray(v.connections)?v.connections:[];if(!list.length){box.replaceChildren(h('p',{class:'small muted',text:'No connections are defined.'}));return;}
  const n=s=>list.filter(c=>c.state===s).length;
  box.replaceChildren(h('h4',{id:'connectionsTitle',text:n('ready')+' ready · '+n('mock')+' mock · '+n('not_configured')+' not configured'}),
   h('p',{class:'small muted',text:'ATLAS is in '+(v.adapters==='live'?'live':'mock')+' mode: nothing reaches an outside system unless its connection is Ready and live.'}),
   h('div',{class:'conn-scroll'},h('table',{class:'conn-table'},h('thead',{},h('tr',{},h('th',{scope:'col',text:'Connection'}),h('th',{scope:'col',text:'State'}),h('th',{scope:'col',text:'What is missing'}))),h('tbody',{},...list.map(connRow)))),
   h('p',{class:'tiny muted',text:'Names and yes/no only. No credential, address or token is shown here.'}));
 }catch(e){if(window.AtlasAuth&&e instanceof window.AtlasAuth.Expired)return;box.replaceChildren(h('p',{class:'small muted',text:'The connections could not be loaded right now.'}));}}
async function refresh({force=false}={}){
 if(busy)return busy;if(!force&&Date.now()-loadedAt<5000)return null;
 busy=(async()=>{try{
  await window.AtlasAuth?.probe?.();const b=await app().bootInfo();
  if(window.AtlasAuth?.mode!=='live'||!b.library||!b.features?.evidence_workflow){hide();return;}
  const list=await app().libraryApi('/evidence');items=Array.isArray(list?.items)?list.items.filter(x=>x&&typeof x.id==='string').slice(0,50):[];
  if(!items.length){hide();return;}
  if(!items.some(x=>x.id===selected))selected=(items.find(x=>x.mine)||items[0]).id;
  render(await app().libraryApi('/evidence/'+encodeURIComponent(selected)+'/status'));loadedAt=Date.now();renderClaims(selected);
 }catch(e){if(window.AtlasAuth&&e instanceof window.AtlasAuth.Expired)return;hide();}finally{busy=null;}})();
 return busy;
}
// Refresh whenever the Reference library view is shown (the section's `hidden` flag flips); and once after sign-in.
function start(){const lib=$('library');if(!lib||!app())return;
 new MutationObserver(()=>{if(!lib.hidden)refresh();}).observe(lib,{attributes:true,attributeFilter:['hidden']});
 window.AtlasAuth?.onSignedIn?.(()=>{refresh({force:true});if(!$('spane-connections')?.hidden)refreshConnections();});
 if(!lib.hidden)refresh();}
window.AtlasWorkflowUI={refresh:()=>refresh({force:true}),refreshConnections,model:C.model};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
