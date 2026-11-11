/* CV and project review. Talks only to this deployment's library. */
(function(){'use strict';
const $=id=>document.getElementById(id);
function h(tag,attrs,children){const n=document.createElement(tag);if(attrs)for(const [k,v] of Object.entries(attrs)){if(k==='text')n.textContent=v;else if(v!=null)n.setAttribute(k,v);}(children||[]).forEach(c=>n.append(c));return n;}
function app(){return window.ATLAS_APP;}
async function api(path,opts){const A=app();if(!A?.libraryApi)throw Error('The shared library is not available here.');return A.libraryApi(path,opts);}
async function post(path,body){
  try{return await api(path,{method:'POST',body});}
  catch(e){
    if(e.message!=='Consent required.')throw e;
    await api('/profile/consent',{method:'POST',body:{kind:'profileReuse',version:1,granted:true}});
    return await api(path,{method:'POST',body});
  }
}
const STATUS={draft:'Draft',in_review:'In review',approved:'Approved',exported:'Exported',withdrawn:'Withdrawn'};
const TOPIC_LABEL={context:'Context',contribution:'Contribution',approach:'Approach',outcome:'Outcome',evidence:'Evidence',customer_relevance:'Customer relevance'};
function linesOf(lines){const ol=h('ol');for(const line of lines||[]){const li=h('li');li.append(h('p',{text:line.text||''}));if(line.evidenceId)li.append(h('p',{class:'tiny muted',text:line.evidenceId}));ol.append(li);}return ol;}
function saveFile(file){const bin=atob(file.base64),bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);const url=URL.createObjectURL(new Blob([bytes],{type:file.mime}));const a=document.createElement('a');a.href=url;a.download=file.filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);}
function actions(artifact,onChange){
  if(!artifact)return h('div');
  const row=h('div',{class:'actions'});
  if(artifact?.canApprove&&artifact.status==='in_review'){const ok=h('button',{class:'btn',type:'button',text:'Approve'});ok.addEventListener('click',async()=>{ok.disabled=true;try{onChange(await api('/living/artifacts/'+artifact.id+'/approve',{method:'POST',body:{}}));}catch(e){app().toast(e.message);ok.disabled=false;}});row.append(ok);}
  const exp=h('button',{class:'btn',type:'button',text:'Export'});
  exp.disabled=!(artifact&&(artifact.status==='approved'||artifact.status==='exported'));
  exp.addEventListener('click',async()=>{exp.disabled=true;try{const file=await api('/living/artifacts/'+artifact.id+'/export',{method:'POST',body:{format:'docx',adapter:'michat'}});saveFile(file);onChange({...artifact,status:file.status||'exported'});}catch(e){app().toast(e.message);}exp.disabled=!(artifact&&(artifact.status==='approved'||artifact.status==='exported'));});
  row.append(exp);
  return row;
}
function artifactBody(artifact){
  const box=h('div');
  if(!artifact)return box;
  box.append(h('p',{role:'status',text:STATUS[artifact.status]||artifact.status}));
  if(artifact.fiche){for(const [topic,items] of Object.entries(artifact.fiche.sections||{})){if(!items.length)continue;const title=h('p');title.append(h('strong',{text:TOPIC_LABEL[topic]||topic}));box.append(title,linesOf(items));}}
  else box.append(linesOf(artifact.lines));
  if((artifact.gaps||[]).length)box.append(h('h2',{text:'Gaps'}),h('ul',{},artifact.gaps.map(gap=>h('li',{text:gap.keyword}))));
  if((artifact.flags||[]).length)box.append(h('h2',{text:'Conflicts'}),h('ul',{},artifact.flags.map(flag=>h('li',{text:flag.detail||flag.text||flag.code}))));
  return box;
}
let cache=null;
async function load(){cache=await api('/living');return cache;}
function queueBlock(items,type){const box=h('div');for(const item of (items||[]).filter(x=>x.type===type)){box.append(artifactBody(item),actions(item,async()=>{await load();if(type==='cv')paintCv();else paintReview();}));}return box;}
function paintCv(){
  const root=$('living');if(!root)return;
  const data=cache||{evidence:[],cv:null};
  const link=h('input',{id:'livingLink',placeholder:'Need link','aria-label':'Need link'});
  const text=h('textarea',{id:'livingText',rows:'6',placeholder:'Job description','aria-label':'Job description'});
  const audience=h('select',{'aria-label':'Audience'});
  audience.append(h('option',{value:'internal',text:'Internal'}),h('option',{value:'external',text:'Client'}));
  const status=h('p',{role:'status'});
  const preview=h('div');
  const show=artifact=>{preview.replaceChildren(artifactBody(artifact),actions(artifact,next=>{cache={...cache,cv:next};show(next);}));};
  if(!data.evidence.length&&!data.cv&&!(data.queue||[]).some(item=>item.type==='cv'))status.textContent='No validated experience.';
  if(data.cv)show(data.cv);
  else if(data.evidence.length)preview.replaceChildren(linesOf(data.evidence));
  const go=h('button',{class:'btn primary',type:'button',text:'Generate'});
  go.addEventListener('click',async()=>{go.disabled=true;status.textContent='';try{
    const out=await post('/living/generate',{link:link.value,text:text.value,audience:audience.value});
    if(out.ok===false){status.textContent="This need link can't be read yet.";return;}
    cache={...cache,cv:out.artifact,consent:true};show(out.artifact);
  }catch(e){status.textContent=e.message;}finally{go.disabled=false;}});
  root.replaceChildren(h('div',{class:'living-sheet'},[h('h1',{text:'CV'}),queueBlock(data.queue,'cv'),link,text,audience,h('div',{class:'actions'},[go]),status,preview]));
}
function paintReview(){
  const root=$('fiche');if(!root)return;
  const data=cache||{stories:[],fiche:null};
  const pick=h('select',{'aria-label':'Story'});
  for(const story of data.stories||[])pick.append(h('option',{value:story.id,text:story.title||'Story'}));
  if(!(data.stories||[]).length)pick.append(h('option',{value:'',text:'No validated experience'}));
  const status=h('p',{role:'status'});
  const preview=h('div');
  const show=artifact=>{preview.replaceChildren(artifactBody(artifact),actions(artifact,next=>{cache={...cache,fiche:next};show(next);}));};
  show(data.fiche);
  const go=h('button',{class:'btn primary',type:'button',text:'Generate'});
  go.disabled=!(data.stories||[]).length;
  go.addEventListener('click',async()=>{go.disabled=true;status.textContent='';try{
    const out=await post('/living/review',{storyId:pick.value});
    cache={...cache,fiche:out.artifact,consent:true};show(out.artifact);
  }catch(e){status.textContent=e.message;}finally{go.disabled=!(data.stories||[]).length;}});
  root.replaceChildren(h('div',{class:'living-sheet'},[h('h1',{text:'Review'}),queueBlock(data.queue,'fiche'),pick,h('div',{class:'actions'},[go]),status,preview]));
}
async function render(view){
  if(view!=='living'&&view!=='fiche')return;
  try{await load();}catch(e){const root=$(view==='living'?'living':'fiche');if(root)root.replaceChildren(h('h1',{text:view==='living'?'CV':'Review'}),h('p',{role:'status',text:e.message||'The library did not answer.'}));return;}
  if(view==='living')paintCv();else paintReview();
}
window.AtlasLivingUI={render};
})();
