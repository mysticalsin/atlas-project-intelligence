/* AtlasWorkflowUI (T15): the evidence workflow status in the Reference library view. One card per branch (Evidence, MAAP Review, Project
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
function cardEl(m){
 return h('article',{class:'wf-card','data-branch':m.branch,'data-tone':m.tone,'data-status':m.displayStatus},
  h('h3',{class:'wf-card-title',text:m.label}),
  h('p',{class:'wf-card-status',text:m.statusText}),
  m.badge?h('span',{class:'tag wf-mock',text:m.badge}):null,
  m.reasonText?h('p',{class:'tiny muted wf-card-reason',text:m.reasonText}):null,
  m.updatedAt?h('p',{class:'tiny muted wf-card-time',text:'Updated '+m.updatedAt.replace('T',' ').replace(/\.\d+Z$/,'Z')}):null);
}
function render(view){
 const s=slot();if(!s)return;const m=C.model(view);s.hidden=false;s.replaceChildren();
 const pick=h('select',{id:'workflowPick','aria-label':'Evidence record',onchange:e=>{selected=e.target.value;refresh({force:true});}},
  ...items.map(x=>h('option',{value:x.id,selected:x.id===selected},C.itemLabel(x))));
 s.append(h('div',{class:'wf-head'},h('div',{},h('p',{class:'eyebrow',text:'EVIDENCE WORKFLOW'}),h('h2',{class:'panel-title',text:'Where each step stands'})),
   h('div',{class:'wf-tools'},pick,h('button',{class:'quiet',type:'button',id:'workflowRefresh',onclick:()=>refresh({force:true}),text:'Refresh'}))),
  h('p',{class:'wf-overall small','data-overall':m.overall.status,role:'status',text:m.overall.text}),
  h('div',{class:'wf-grid'},...m.cards.map(cardEl)),
  m.note?h('p',{class:'tiny muted wf-note',text:m.note}):null);
}
async function refresh({force=false}={}){
 if(busy)return busy;if(!force&&Date.now()-loadedAt<5000)return null;
 busy=(async()=>{try{
  await window.AtlasAuth?.probe?.();const b=await app().bootInfo();
  if(window.AtlasAuth?.mode!=='live'||!b.library||!b.features?.evidence_workflow){hide();return;}
  const list=await app().libraryApi('/evidence');items=Array.isArray(list?.items)?list.items.filter(x=>x&&typeof x.id==='string').slice(0,50):[];
  if(!items.length){hide();return;}
  if(!items.some(x=>x.id===selected))selected=(items.find(x=>x.mine)||items[0]).id;
  render(await app().libraryApi('/evidence/'+encodeURIComponent(selected)+'/status'));loadedAt=Date.now();
 }catch(e){if(window.AtlasAuth&&e instanceof window.AtlasAuth.Expired)return;hide();}finally{busy=null;}})();
 return busy;
}
// Refresh whenever the Reference library view is shown (the section's `hidden` flag flips); and once after sign-in.
function start(){const lib=$('library');if(!lib||!app())return;
 new MutationObserver(()=>{if(!lib.hidden)refresh();}).observe(lib,{attributes:true,attributeFilter:['hidden']});
 window.AtlasAuth?.onSignedIn?.(()=>refresh({force:true}));
 if(!lib.hidden)refresh();}
window.AtlasWorkflowUI={refresh:()=>refresh({force:true}),model:C.model};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
