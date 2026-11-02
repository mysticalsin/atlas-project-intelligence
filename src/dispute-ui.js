/* AtlasDisputeUI (D-DSR, v2.2): the dispute panel on the reviewer's one-screen review and on the owner's status panel. It shows the state badge, the
   rejection and the dispute side by side, and the adjudication when there is one; the owner can raise a dispute or accept the rejection, a reviewer can
   uphold or overturn it, always with a reason. A button is enabled only when the record's `actions` (built by the server) include it; otherwise it is
   disabled and the reason is said next to it. The server still decides (policy gate, review machine, the single-reviewer rule).
   Strict CSP: built with createElement and textContent only; nothing from the server is written as markup. */
(()=>{'use strict';
const C=window.AtlasDisputeCore,app=()=>window.ATLAS_APP||{};
if(!C)return;
function h(tag,attrs={},...kids){const el=document.createElement(tag);for(const [k,v] of Object.entries(attrs||{})){if(v===null||v===undefined||v===false)continue;if(k==='text')el.textContent=v;else if(k.startsWith('on'))el.addEventListener(k.slice(2),v);else el.setAttribute(k,v===true?'':String(v));}
 for(const k of kids.flat())if(k!==null&&k!==undefined&&k!==false)el.append(k);return el;}
const expired=e=>!!(window.AtlasAuth&&window.AtlasAuth.Expired&&e instanceof window.AtlasAuth.Expired);
let seq=0;
// panel(rec, {onChanged(rec, action)}): an element, or null when the record has nothing to do with a dispute.
function panel(rec,{onChanged}={}){const m=C.model(rec);if(!m)return null;const n=++seq,rid='dpReason'+n,aid='dpAdj'+n;
 const err=h('p',{class:'tiny rv-err dp-err',role:'alert'}),done=h('p',{class:'small dp-done',role:'status'});
 const reason=m.open?h('textarea',{id:rid,class:'dp-reason',maxlength:'500',rows:'3'}):null;
 const adj=m.adjudicatorField?h('input',{id:aid,class:'dp-adj',type:'email',maxlength:'100',autocomplete:'off'}):null;
 const buttons=m.controls.map((c,i)=>{const whyId='dpWhy'+n+'-'+i;
  const b=h('button',{class:'btn dp-act'+(i===0?' primary':''),type:'button','data-dp-do':c.action,'aria-describedby':c.enabled?null:whyId,text:c.label});b.disabled=!c.enabled;
  b.addEventListener('click',()=>send(c.action,b));
  return [b,c.enabled?null:h('p',{class:'tiny muted dp-why',id:whyId,'data-dp-why':c.action,text:c.why})];});
 async function send(action,btn){if(btn.disabled)return;err.textContent='';done.textContent='';
  const r=C.request(m,action,reason?reason.value:'',adj?adj.value:'');if(r.error){err.textContent=r.error;if(reason&&!reason.value.trim())reason.focus();return;}
  for(const [b] of buttons)b.disabled=true;btn.setAttribute('aria-busy','true');
  try{const out=await app().libraryApi('/evidence/'+encodeURIComponent(m.id)+'/review',{method:'POST',body:r.body});done.textContent=C.DONE[action]||'Saved.';
   if(typeof onChanged==='function')onChanged(out,action);}
  catch(e){if(expired(e))return;err.textContent=C.errorText(e);for(const [b] of buttons)b.disabled=!m.controls.find(c=>c.action===b.dataset.dpDo).enabled;}
  finally{btn.removeAttribute('aria-busy');}}
 return h('section',{class:'dp','data-dispute-state':m.badge.key,'aria-label':'Dispute'},
  h('div',{class:'dp-head'},h('h3',{class:'dp-title',text:'Dispute'}),h('span',{class:'rq-chip dp-badge','data-tone':m.badge.tone,'data-dp-badge':m.badge.key,text:m.badge.text})),
  h('ul',{class:'dp-story'},...m.story.map(s=>h('li',{class:'dp-line','data-dp-line':s.key},h('b',{text:s.label+' '}),h('span',{class:'dp-who',text:s.who}),s.text?h('p',{class:'small dp-text',dir:'auto',text:s.text}):null))),
  m.note?h('p',{class:'small dp-note',text:m.note}):null,
  reason?h('label',{class:'field-label',for:rid,text:m.reasonLabel}):null,reason,
  adj?h('label',{class:'field-label',for:aid,text:'Who should settle it (optional email)'}):null,adj,
  h('div',{class:'dp-acts'},...buttons.flat()),err,done);}
window.AtlasDisputeUI={panel,model:C.model};
})();
