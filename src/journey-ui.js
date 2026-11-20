/* Journey and admin dashboard. Talks only to this deployment's library API. */
(function(){'use strict';
const {html,setHTML,insertHTML,trusted}=window.AtlasSafe;
const $=id=>document.getElementById(id);
const PEOPLE=[
 {email:'consultant@example.test',label:'Consultant',roles:['ATLAS.Interview']},
 {email:'manager@example.test',label:'Trusted manager',roles:['ATLAS.Interview']},
 {email:'presales@example.test',label:'Bid / pre-sales',roles:['ATLAS.Interview','ATLAS.Presales']},
 {email:'admin@example.test',label:'Verified admin',roles:['ATLAS.Interview','ATLAS.Admin']}
];
const localDemo=()=>/^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const STATUS_LABEL={in_review:'In review',needs_work:'Needs work',changes_requested:'Changes requested',awaiting_validation:'Awaiting N+1',published:'Published',withdrawn:'Withdrawn'};
function h(tag,attrs,children){const n=document.createElement(tag);if(attrs)for(const [k,v] of Object.entries(attrs)){if(k==='text')n.textContent=v;else if(v!=null)n.setAttribute(k,v);}(children||[]).forEach(c=>n.append(c));return n;}
function app(){return window.ATLAS_APP;}
async function api(path,opts){const A=app();if(!A?.libraryApi)throw Error('The library API is not on this page.');return A.libraryApi(path,opts);}
function personaBar(){if(!localDemo())return h('p',{class:'tiny muted',text:'Sign in with your work account. This page does not offer a persona you can type.'});
 const nav=h('nav',{'aria-label':'Synthetic local personas',class:'persona-switch'});
 for(const p of PEOPLE){const a=h('a',{class:'btn',href:'/?as='+encodeURIComponent(p.email)+'&idp='+encodeURIComponent(JSON.stringify({roles:p.roles}))+'#journey',text:p.label});nav.append(a);}
 return h('div',{},[h('p',{class:'tiny muted',text:'Local demo only. These are synthetic example.test people, not a directory.'}),nav]);}
function stageList(stages,onPick){const list=h('ol',{class:'stage-grid'});
 for(const s of stages||[]){const b=h('button',{type:'button',class:'stage-card'},[h('strong',{text:s.title}),h('small',{text:s.blocked?'Blocked integration':s.current?'Current':'Open'})]);if(s.current)b.setAttribute('aria-current','step');b.addEventListener('click',()=>onPick(s));list.append(h('li',{},[b]));}
 return list;}
function banner(kind,text){return h('p',{class:'pill'+(kind==='warn'?' warn':''),role:'status',text});}
let erasure=initialErasure();
function noteErasure(result){if(result&&result.rejection){try{console.warn(JSON.stringify(result.rejection));}catch(e){}}return result;}
function erasureReceipt(r){const box=h('div',{id:'privacyReceipt',role:'status'});box.append(h('p',{text:r&&typeof r.note==='string'?r.note:''}));for(const o of (r&&Array.isArray(r.outcomes)?r.outcomes:[]))box.append(h('p',{text:o&&o.error?String(o.store)+' '+String(o.error):String(o&&o.store)+' '+String(o&&o.removed)}));return box;}
function liveErasureButton(fallback){const box=$('privacyActions');const kids=box&&box.children||[];for(const n of kids)if(n&&n.textContent==='Delete my journey data')return n;return fallback||null;}
function crossed(boot){const r=window.ATLAS_RUNTIME;if(!r||!boot)return false;const id=boot.identity||{};if(r.subjectKey&&id.subjectKey&&r.subjectKey!==id.subjectKey)return true;const mail=id.name||boot.email||'';if(r.name&&mail&&String(r.name)!==String(mail))return true;if(/^[0-9a-f]{32}$/.test(r.boundSubject||'')&&/^[0-9a-f]{32}$/.test(id.boundSubject||'')&&r.boundSubject!==id.boundSubject)return true;if(/^[0-9a-f]{32}$/.test(r.boundEmail||'')&&/^[0-9a-f]{32}$/.test(id.boundEmail||'')&&r.boundEmail!==id.boundEmail)return true;return false;}
async function renderJourney(){const root=$('journey');if(!root)return;root.replaceChildren(h('p',{text:'Loading your journey…'}));
 let boot={};try{boot=await app().bootInfo();}catch{boot={};}
 if(crossed(boot)){root.replaceChildren();const actions=h('p',{id:'privacyActions'});const del=h('button',{class:'btn',type:'button',text:'Delete my journey data'});del.addEventListener('click',()=>{app().confirm('Delete my journey data','Continue sends the deletion request. Cancel sends nothing.',()=>{});});actions.append(del);root.append(actions);return;}
 const adminNav=$('adminNav');if(adminNav)adminNav.hidden=boot.libraryRole!=='admin';
 let data;try{data=await api('/journey');}catch(e){root.replaceChildren(h('h1',{id:'journeyTitle',text:'Journey'}),banner('warn',e.message||'The journey could not be loaded.'),personaBar());return;}
 let picked=data.stages.find(s=>s.current)||data.stages[0];
 const detail=h('div',{class:'panel'});
 const layout=h('div',{class:'journey-layout'});
 function paint(){detail.replaceChildren();
  detail.append(h('h2',{text:picked.title}));
  if(picked.blocked){detail.append(banner('warn',picked.blocked.status+' · '+picked.blocked.system),h('p',{text:picked.blocked.reason}),h('ul',{},picked.blocked.needs.map(n=>h('li',{text:n}))));
   if(picked.id==='map'){const d=h('div');api('/journey/map-draft').then(draft=>{d.append(h('h3',{text:'Local draft, not submitted'}),h('p',{text:draft.draft.project}),h('p',{text:draft.draft.contribution}),h('p',{class:'tiny muted',text:'Submitted: no'}));}).catch(err=>d.append(h('p',{text:err.message})));detail.append(d);}}
  if(picked.id==='project'||picked.id==='prefill'||picked.id==='review'){const title=h('input',{id:'jTitle',value:data.fields.title?.value||'','aria-label':'Project alias'});const work=h('textarea',{id:'jWork',rows:'4','aria-label':'What you personally did'});work.value=data.fields.personalWork?.value||'';const evidence=h('textarea',{id:'jEvidence',rows:'3','aria-label':'Evidence you can point to'});evidence.value=data.fields.evidence?.value||'';
   const save=h('button',{class:'btn primary',type:'button',text:'Save confirmed notes'});save.addEventListener('click',async()=>{save.disabled=true;try{data=await api('/journey',{method:'POST',body:{stage:picked.id,fields:{title:{value:title.value,source:'you',confirmed:true},personalWork:{value:work.value,source:'you',confirmed:true},evidence:{value:evidence.value,source:'document',confirmed:true}}}});paintQueue();}catch(e){detail.append(banner('warn',e.message));}save.disabled=false;});
   detail.append(h('p',{class:'tiny muted',text:'Only what you confirm is stored. Nothing here is fetched from DNA.'}),h('label',{class:'field',text:'Project alias'}),title,h('label',{class:'field',text:'What you personally did'}),work,h('label',{class:'field',text:'Evidence'}),evidence,save);}
  if(picked.id==='resume'){const skill=h('input',{id:'jSkill','aria-label':'A skill you confirm',placeholder:'e.g. python'});const add=h('button',{class:'btn',type:'button',text:'Add this confirmed skill'});add.addEventListener('click',async()=>{try{data=await api('/journey',{method:'POST',body:{stage:'resume',confirmSkill:skill.value,skillConfirmed:true,skillSource:'you'}});paint();}catch(e){detail.append(banner('warn',e.message));}});
   const have=Object.values(data.confirmed||{}).filter(v=>v.kind==='skill').map(v=>v.value);
   detail.append(h('p',{text:'The résumé lists skills you confirmed. ATLAS does not invent certifications.'}),h('p',{text:have.length?have.join(', '):'No confirmed skills yet.'}),skill,add);}
  if(picked.id==='roles'){detail.append(h('p',{text:data.roles.explanation}),h('p',{class:'tiny muted',text:data.roles.decision}));
   if(!data.roles.matches.length)detail.append(h('p',{text:'Nothing to show until you confirm a skill.'}));
   for(const m of data.roles.matches)detail.append(h('p',{},[h('strong',{text:m.title}),document.createTextNode(' — because you confirmed: '+m.because.join(', '))]));}
  if(picked.id==='spotlight'){detail.append(h('p',{text:data.publication}),h('p',{class:'tiny muted',text:data.integrations.spotlight.reason}));}
  detail.append(h('h3',{text:'Voice, if you want it'}),h('p',{class:'tiny muted',text:'Text above is enough. Voice starts only after the purpose consent. This button opens that dialog and does not turn the microphone on.'}),h('button',{class:'btn',type:'button',id:'openConsent',text:'Review voice consent'}));
  detail.querySelector('#openConsent').addEventListener('click',()=>{$('voiceConsentDialog')?.showModal();});
 }
 const queue=h('aside',{class:'panel','aria-live':'polite'});
 async function paintQueue(){queue.replaceChildren(h('h2',{text:'Stories you can open'}));
  let list={items:[]};try{list=await api('');}catch(e){queue.append(banner('warn',e.message||'Could not load stories.'));return;}
  const items=list.items||[];if(!items.length){queue.append(h('p',{text:'Nothing here yet. A consultant story appears after it is saved to the library.'}));return;}
  for(const item of items){const box=h('article');const progress=item.status==='published'?'Published':item.status==='admin_test'?'Admin test, not public':item.status==='awaiting_validation'&&item.managerDecision==='approved'&&item.presalesDecision!=='approved'?'Manager approved · awaiting pre-sales':(STATUS_LABEL[item.status]||item.status||'');box.append(h('strong',{text:item.title||'Untitled'}),h('p',{class:'tiny',text:progress}));
   if(boot.libraryRole==='user'&&item.access==='full'&&item.mine!==true&&item.managerDecision!=='approved'&&item.status!=='published'&&item.status!=='admin_test'){const ok=h('button',{class:'btn',type:'button',text:'Approve as trusted manager'});ok.addEventListener('click',()=>act(item.id,'manager','validate',ok));const no=h('button',{class:'btn',type:'button',text:'Ask for changes'});no.addEventListener('click',()=>act(item.id,'manager','request_changes',no,'Please add the evidence source.'));box.append(ok,no);}
   if(boot.libraryRole==='presales'&&item.presalesDecision!=='approved'&&item.status!=='published'&&item.status!=='admin_test'){const ok=h('button',{class:'btn primary',type:'button',text:'Approve for bid / pre-sales'});ok.addEventListener('click',()=>act(item.id,'presales','validate',ok));box.append(ok);}
   if(boot.libraryRole==='admin'){const test=h('button',{class:'btn',type:'button',text:'Admin test bypass'});test.addEventListener('click',()=>bypass(item.id,true,test));const pub=h('button',{class:'btn',type:'button',text:'Admin publish bypass'});pub.addEventListener('click',()=>bypass(item.id,false,pub));box.append(test,pub);}
   queue.append(box);}
 }
 async function act(id,lane,decision,btn,note){btn.disabled=true;try{await api('/'+id+'/validate',{method:'POST',body:{lane,decision,note:note||''}});await paintQueue();}catch(e){queue.append(banner('warn',e.message));btn.disabled=false;btn.focus();}}
 async function bypass(id,test,btn){btn.disabled=true;try{await api('/admin/publish',{method:'POST',body:{id,test}});await paintQueue();}catch(e){queue.append(banner('warn',e.message));btn.disabled=false;}}
 paint();paintQueue();
 const head=h('div',{class:'journey-head'},[h('div',{},[h('p',{class:'eyebrow',text:'CONSULTANT JOURNEY'}),h('h1',{id:'journeyTitle',text:'From the work to a reference.'}),h('p',{text:'Confirm what is true. Blocked systems stay blocked. Publication for everyone else needs both approvals.'})]),personaBar()]);
 layout.append(detail,queue);
 root.replaceChildren(head,stageList(data.stages,s=>{picked=s;paint();}),layout,h('section',{class:'panel'},[h('h2',{text:'Privacy'}),h('p',{id:'privacyNote',text:'Loading disclosure…'})]),h('p',{id:'privacyActions'}));
 api('/privacy/disclosure').then(d=>{const n=$('privacyNote');if(!n)return;n.textContent=`Consent ${d.consent.interview}. ${d.recording} ${d.textOnly} Telemetry retention ${d.retention.appTelemetryDays} days in this app. Vendor deletion: ${d.retention.vendorDeletion}. ${d.lawfulBasis} ${d.biometrics}`;}).catch(()=>{});
 const actions=$('privacyActions');if(actions){const exp=h('button',{class:'btn',type:'button',text:'Download my data'});const del=h('button',{class:'btn',type:'button',text:'Delete my journey data'});exp.addEventListener('click',async()=>{try{const pack=await api('/privacy/export');app().download('atlas-my-data.json',JSON.stringify(pack,null,2),'application/json');}catch(e){actions.append(banner('warn',e.message));}});del.disabled=erasure.status==='confirming'||erasure.status==='in_flight';del.addEventListener('click',()=>{const step=noteErasure(erasureTransition(erasure,{type:'ask'}));if(!step.ok)return;erasure=step.state;del.disabled=true;let decided=false;const dialog=$('confirmDialog');const onClose=()=>{if(dialog)dialog.removeEventListener('close',onClose);queueMicrotask(()=>{if(decided)return;const back=noteErasure(erasureTransition(erasure,{type:'cancel'}));if(back.ok)erasure=back.state;if(erasure.status!=='in_flight')del.disabled=false;});};if(dialog)dialog.addEventListener('close',onClose);app().confirm('Delete my journey data','Continue sends the deletion request. Cancel sends nothing.',async()=>{decided=true;const go=noteErasure(erasureTransition(erasure,{type:'confirm'}));if(!go.ok){if(erasure.status!=='in_flight')del.disabled=false;return;}erasure=go.state;try{const r=await api('/privacy/delete',{method:'POST',body:{}});const failedStore=r&&Array.isArray(r.outcomes)&&r.outcomes.some(o=>o&&o.error);if(failedStore){const failed=noteErasure(erasureTransition(erasure,{type:'fail'}));if(failed.ok)erasure=failed.state;($('privacyActions')||actions).append(banner('warn','The deletion did not finish. Nothing was removed.'));}else{const done=noteErasure(erasureTransition(erasure,{type:'succeed'}));if(done.ok)erasure=done.state;const live=$('privacyActions')||actions;live.querySelector('#privacyReceipt')?.remove();live.append(erasureReceipt(r));}}catch(e){const failed=noteErasure(erasureTransition(erasure,{type:'fail'}));if(failed.ok)erasure=failed.state;($('privacyActions')||actions).append(banner('warn',e.message));}const liveDel=liveErasureButton(del);if(liveDel&&erasure.status!=='in_flight')liveDel.disabled=false;});});actions.append(exp,del);}
}
function bars(series){const max=Math.max(1,...series.map(p=>p.events||0));const fig=h('div',{class:'chart',role:'img','aria-label':'Events by day'});
 for(const p of series){const i=h('i');i.style.height=Math.round((p.events/max)*100)+'%';fig.append(h('div',{},[i,h('span',{text:String(p.bucket).slice(5)})]));}
 return fig;}
function noteAdmin(result){if(result&&result.rejection){try{console.warn(JSON.stringify(result.rejection));}catch(e){}}return result;}
async function renderAdmin(){const root=$('admin');if(!root)return;
 let metricsView=initialAdminMetrics();
 root.replaceChildren(h('p',{text:'Loading admin metrics…'}));
 let boot=null;try{boot=await app().bootInfo();}catch{boot=null;}
 const bootFailed=!boot||boot.protocol!=='atlas-personaplex-pcm-v1';
 const booted=noteAdmin(adminMetricsTransition(metricsView,{type:'boot',failed:bootFailed,role:boot&&boot.libraryRole}));
 if(!booted.ok)return;
 metricsView=booted.state;
 if(metricsView.status==='boot_error'){root.replaceChildren(h('h1',{id:'adminTitle',text:'Admin'}),banner('warn','Metrics failed.'));return;}
 if(metricsView.status==='denied'){root.replaceChildren(h('h1',{id:'adminTitle',text:'Admin'}),banner('warn','This dashboard is only for a verified admin. The API refuses everyone else.'));return;}
 const range=h('select',{'aria-label':'Time range'});for(const [v,t] of [['7','7 days'],['30','30 days'],['90','90 days']])range.append(h('option',{value:v,text:t}));
 const bucket=h('select',{'aria-label':'Aggregation'});bucket.append(h('option',{value:'day',text:'By day'}),h('option',{value:'week',text:'By week'}));
 const go=h('button',{class:'btn',type:'button',text:'Update'});const exp=h('button',{class:'btn',type:'button',text:'Export CSV'});
 const out=h('div');
 async function load(){
  const step=noteAdmin(adminMetricsTransition(metricsView,{type:'refresh'}));
  if(!step.ok)return;
  metricsView=step.state;
  out.replaceChildren(h('p',{text:'Loading…'}));
  const to=new Date(),from=new Date(to.getTime()-Number(range.value)*864e5);
  try{const m=await api('/admin/metrics?from='+encodeURIComponent(from.toISOString())+'&to='+encodeURIComponent(to.toISOString())+'&bucket='+bucket.value);
   const done=noteAdmin(adminMetricsTransition(metricsView,{type:'loaded',count:m.series.length}));
   if(!done.ok)return;
   metricsView=done.state;
   const grid=h('div',{class:'metric-grid'});
   const cards=[['Events',m.events],['Errors',m.errors],['Actual tokens in',m.tokens.actualIn],['Missing token events',m.tokens.missing],['Unknown token events',m.tokens.unknown],['Latency avg ms',m.latencyMs.average??'missing'],['Published',m.workflow.published],['Awaiting manager',m.workflow.awaiting_manager],['Awaiting pre-sales',m.workflow.awaiting_presales],['Admin tests',m.workflow.admin_test]];
   for(const [k,v] of cards)grid.append(h('div',{class:'metric'},[h('span',{class:'tiny',text:k}),h('b',{text:String(v)})]));
   const cost=m.estimatedCost?`Estimated ${m.estimatedCost.amount} ${m.estimatedCost.currency} from configured unit rates${m.estimatedCost.includesEstimatedTokens?' (includes estimated tokens)':''}.`:'No cost figure. Unit rates are not configured, so this is not shown as zero.';
   out.replaceChildren(grid,m.series.length?bars(m.series):h('p',{text:'No events in this range.'}),h('p',{text:cost}),h('p',{class:'tiny muted',text:m.note}));
  }catch(e){const failed=noteAdmin(adminMetricsTransition(metricsView,{type:'load_failed'}));if(failed.ok)metricsView=failed.state;out.replaceChildren(banner('warn',e.message||'Metrics failed.'));}}
 go.addEventListener('click',load);exp.addEventListener('click',async()=>{
  const step=noteAdmin(adminMetricsTransition(metricsView,{type:'export'}));
  if(!step.ok)return;
  metricsView=step.state;
  try{const pack=await api('/admin/export');app().download(pack.filename||'atlas-admin-metrics.csv',pack.csv||'','text/csv');}catch(e){const failed=noteAdmin(adminMetricsTransition(metricsView,{type:'export_failed'}));if(failed.ok)metricsView=failed.state;out.append(banner('warn',e.message));}});
 root.replaceChildren(h('div',{class:'journey-head'},[h('div',{},[h('p',{class:'eyebrow',text:'ADMIN ONLY'}),h('h1',{id:'adminTitle',text:'Operations.'}),h('p',{text:'Pseudonymous counts. Tokens are actual only when a provider returned them.'})]),personaBar()]),h('div',{class:'filters'},[range,bucket,go,exp]),out);
 load();}
function render(view){if(view==='admin')renderAdmin();else renderJourney();}
async function revealAdmin(){try{const b=await window.AtlasAuth?.boot?.();const n=$('adminNav');if(n)n.hidden=b?.libraryRole!=='admin';}catch{}}
window.AtlasJourney={render};
revealAdmin();
window.addEventListener('atlas-auth',()=>{revealAdmin();if(!$('journey')?.hidden)renderJourney();if(!$('admin')?.hidden)renderAdmin();});
})();
