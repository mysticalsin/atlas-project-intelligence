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
    if(!window.confirm('Reuse your published profile for this CV and review?'))throw Error('Profile reuse was not granted.');
    await api('/profile/consent',{method:'POST',body:{kind:'profileReuse',version:1,granted:true}});
    return await api(path,{method:'POST',body});
  }
}
const TOPIC_LABEL={context:'Context',contribution:'Contribution',approach:'Approach',outcome:'Outcome',evidence:'Evidence',customer_relevance:'Customer relevance'};
function splitNeed(value){
  const text=String(value||'').trim();
  if(/^https:\/\/need\.arp\.mantu\.com\/needs\/\S+$/i.test(text))return {link:text,text:''};
  return {link:'',text};
}
function saveFile(file){const bin=atob(file.base64),bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);const url=URL.createObjectURL(new Blob([bytes],{type:file.mime}));const a=document.createElement('a');a.href=url;a.download=file.filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);}
let marked='';
function highlight(key){
  marked=marked===key?'':key;
  document.querySelectorAll('#living .cv-lines li').forEach(li=>{
    const text=(li.textContent||'').toLowerCase();
    li.classList.toggle('mark',!!marked&&text.includes(String(marked).toLowerCase()));
  });
  document.querySelectorAll('#living .gap-chip').forEach(btn=>btn.classList.toggle('on',btn.textContent===marked));
}
function provenance(source){
  const wrap=h('span',{class:'prov-wrap'});
  const btn=h('button',{type:'button',class:'prov','aria-label':'Show the published sentence'});
  const pop=h('span',{class:'prov-pop',role:'tooltip',text:source||''});
  btn.addEventListener('click',event=>{event.stopPropagation();wrap.classList.toggle('open');});
  wrap.append(btn,pop);
  return wrap;
}
function supportText(artifact,line){
  const own=line.source||line.text||'';
  const extra=(artifact?.provenance||[]).filter(item=>!line.storyId||item.storyId===line.storyId).map(item=>item.source||item.text||'').filter(text=>text&&text!==own);
  return [own,...extra].filter(Boolean).join('\n');
}
function bullet(line,artifact){
  const li=h('li',line.evidenceId?{'data-evidence':line.evidenceId}:null);
  const p=h('p',{text:line.text||''});
  const source=supportText(artifact,line);
  if(line.evidenceId||source)p.append(provenance(source));
  li.append(p);
  return li;
}
function bullets(lines,artifact){const ul=h('ul',{class:'cv-lines'});for(const line of lines||[])if(line&&line.text)ul.append(bullet(line,artifact));return ul;}
function contextLine(line,artifact){
  const p=h('p',{class:'role-context',text:line.text||''});
  const source=supportText(artifact,line);
  if(line.evidenceId||source)p.append(provenance(source));
  return p;
}
function actionBar(artifact,onChange){
  const bar=h('div',{class:'action-bar'});
  if(artifact.canApprove&&artifact.status==='in_review'){
    const ok=h('button',{class:'btn living-go',type:'button',text:'Approve'});
    ok.addEventListener('click',async()=>{ok.disabled=true;try{onChange(await api('/living/artifacts/'+artifact.id+'/approve',{method:'POST',body:{}}));}catch(e){app().toast(e.message);ok.disabled=false;}});
    bar.append(ok);
  }
  const ready=artifact.status==='approved'||artifact.status==='exported';
  const exp=h('button',{class:'btn living-go',type:'button',text:'Export'});
  exp.disabled=!ready;
  exp.addEventListener('click',async()=>{exp.disabled=true;try{const file=await api('/living/artifacts/'+artifact.id+'/export',{method:'POST',body:{format:'docx',adapter:'michat'}});saveFile(file);onChange({...artifact,status:file.status||'exported'});}catch(e){app().toast(e.message);exp.disabled=!(artifact.status==='approved'||artifact.status==='exported');}});
  bar.append(exp);
  return bar;
}
function skillChips(cf){
  const seen=new Set(),out=[];
  for(const group of cf?.technicalSkills||[])for(const item of group.lines||[]){
    if(!item?.text||seen.has(item.text))continue;
    seen.add(item.text);
    out.push({text:item.text,evidenceId:item.evidenceId});
  }
  for(const item of cf?.languages||[]){
    if(!item?.language||seen.has(item.language))continue;
    seen.add(item.language);
    const levels=[item.spoken,item.written].filter(Boolean);
    out.push({text:levels.length?item.language+' · '+levels.join(', '):item.language,evidenceId:item.evidenceId});
  }
  return out;
}
function roleHead(artifact,lines){
  const ids=new Set(lines.map(line=>line.evidenceId));
  const project=(artifact.cf?.projects||[]).find(item=>(item.evidenceIds||[]).some(id=>ids.has(id)));
  const title=project?[project.company&&project.company.text,project.role&&project.role.text].filter(Boolean).join(' · '):(lines[0]?.storyTitle||'Experience');
  const head=h('div',{class:'role-head'},[h('h3',{text:title||'Experience'})]);
  const period=project&&project.period&&project.period.text;
  if(period)head.append(h('p',{class:'role-period',text:period}));
  return head;
}
function cvDocument(artifact,onChange){
  const card=h('article',{class:'cv-doc'});
  if(!artifact)return card;
  const cf=artifact.cf||{};
  const who=artifact.consultant||{};
  const name=[cf.firstName&&cf.firstName.text,cf.lastName&&cf.lastName.text].filter(Boolean).join(' ')||who.name||'CV';
  card.append(actionBar(artifact,onChange));
  card.append(h('h2',{class:'cv-name',text:name}));
  const role=(cf.jobTitle&&cf.jobTitle.text)||who.role;
  if(role)card.append(h('p',{class:'cv-role',text:role}));
  const skills=skillChips(cf);
  if(skills.length){
    card.append(h('h3',{text:'Skills'}));
    const row=h('div',{class:'chips'});
    for(const item of skills){
      const chip=h('button',{type:'button',class:'chip',text:item.text});
      chip.addEventListener('click',()=>highlight(item.text));
      row.append(chip);
    }
    card.append(row);
  }
  const aside=new Set([...(cf.education||[]),...(cf.trainings||[])].map(item=>item.evidenceId).filter(Boolean));
  if((cf.education||[]).length){card.append(h('h3',{text:'Education'}));card.append(bullets(cf.education,artifact));}
  if((cf.trainings||[]).length){card.append(h('h3',{text:'Certifications'}));card.append(bullets(cf.trainings,artifact));}
  const groups=new Map();
  for(const line of artifact.lines||[]){
    if(!line?.text||aside.has(line.evidenceId))continue;
    const id=line.storyId||'story';
    if(!groups.has(id))groups.set(id,[]);
    groups.get(id).push(line);
  }
  for(const lines of groups.values()){
    card.append(roleHead(artifact,lines));
    for(const line of lines)if(line.topic==='context')card.append(contextLine(line,artifact));
    const work=lines.filter(line=>line.topic==='contribution'||line.topic==='approach'||line.topic==='outcome');
    if(work.length)card.append(bullets(work,artifact));
  }
  return card;
}
function rail(artifact){
  const gaps=artifact.gaps||[],flags=artifact.flags||[];
  if(!gaps.length&&!flags.length)return null;
  const aside=h('aside',{class:'cv-rail'});
  if(gaps.length){
    const list=h('ul',{class:'gap-list'});
    for(const gap of gaps){
      const btn=h('button',{type:'button',class:'gap-chip',text:gap.keyword});
      btn.addEventListener('click',()=>highlight(gap.keyword));
      list.append(h('li',null,[btn]));
    }
    aside.append(h('section',{class:'rail-card'},[list]));
  }
  if(flags.length)aside.append(h('section',{class:'rail-card'},[h('ul',{class:'flag-list'},flags.map(flag=>h('li',{text:flag.detail||flag.code})))]));
  return aside;
}
function skeleton(){return h('div',{class:'skeleton','aria-hidden':'true'},[h('span'),h('span'),h('span')]);}
function stage(artifact,onChange){
  const side=rail(artifact);
  return h('div',{class:side?'cv-stage':'cv-stage solo'},side?[cvDocument(artifact,onChange),side]:[cvDocument(artifact,onChange)]);
}
let cache=null;
async function load(){cache=await api('/living');return cache;}
function paintCv(){
  const root=$('living');if(!root)return;
  const data=cache||{cv:null,queue:[]};
  const field=h('textarea',{id:'livingNeed',rows:'2',placeholder:'Need link or job description','aria-label':'Need link or job description'});
  const note=h('p',{id:'livingStatus',class:'living-note',role:'status'});
  const go=h('button',{class:'btn living-go',type:'button',text:data.cv?'Regenerate':'Generate CV'});
  go.disabled=true;
  field.addEventListener('input',()=>{if(!go.classList.contains('busy'))go.disabled=!field.value.trim();});
  const preview=h('div',{class:'cv-preview'});
  const show=artifact=>{
    const onChange=next=>{cache={...cache,cv:next};show(next);go.textContent='Regenerate';};
    preview.replaceChildren(stage(artifact,onChange));
    go.textContent='Regenerate';
  };
  if(data.cv)show(data.cv);
  go.addEventListener('click',async()=>{
    const had=!!preview.querySelector('.cv-doc');
    go.classList.add('busy');go.disabled=true;field.readOnly=true;note.textContent='';
    if(!had)preview.replaceChildren(skeleton());
    try{
      const out=await post('/living/generate',splitNeed(field.value));
      if(out.ok===false){note.textContent="Couldn't read that link. Paste the job description instead.";if(!had)preview.replaceChildren();return;}
      if(!(out.artifact?.lines||[]).length){note.textContent='No published evidence matches this need.';if(!had)preview.replaceChildren();return;}
      cache={...cache,cv:out.artifact,consent:true};show(out.artifact);
    }catch(e){note.textContent=e.message||'The library did not answer.';if(!had)preview.replaceChildren();}
    finally{go.classList.remove('busy');field.readOnly=false;go.disabled=!field.value.trim();}
  });
  const queue=h('div',{class:'cv-queue'});
  for(const item of (data.queue||[]).filter(entry=>entry.type==='cv'))queue.append(stage(item,async()=>{await load();paintCv();}));
  root.replaceChildren(h('div',{class:'living-page'},[h('div',{class:'need-row'},[field,go]),note,queue,preview]));
}
function ficheCard(artifact,onChange){
  const card=h('article',{class:'cv-doc'});
  if(!artifact?.fiche)return card;
  card.append(actionBar(artifact,onChange));
  for(const [topic,items] of Object.entries(artifact.fiche.sections||{})){
    if(!items.length)continue;
    card.append(h('h3',{text:TOPIC_LABEL[topic]||topic}),bullets(items));
  }
  return card;
}
function paintReview(){
  const root=$('fiche');if(!root)return;
  const data=cache||{stories:[],fiche:null};
  const pick=h('select',{'aria-label':'Story'});
  for(const story of data.stories||[])pick.append(h('option',{value:story.id,text:story.title||'Story'}));
  if(!(data.stories||[]).length)pick.append(h('option',{value:'',text:'No validated experience'}));
  const note=h('p',{class:'living-note',role:'status'});
  const go=h('button',{class:'btn living-go',type:'button',text:'Generate'});
  go.disabled=!(data.stories||[]).length;
  const preview=h('div');
  const show=artifact=>{preview.replaceChildren(ficheCard(artifact,next=>{cache={...cache,fiche:next};show(next);}));};
  if(data.fiche)show(data.fiche);
  go.addEventListener('click',async()=>{
    go.classList.add('busy');go.disabled=true;note.textContent='';
    try{const out=await post('/living/review',{storyId:pick.value});cache={...cache,fiche:out.artifact,consent:true};show(out.artifact);}
    catch(e){note.textContent=e.message||'The library did not answer.';}
    finally{go.classList.remove('busy');go.disabled=!(data.stories||[]).length;}
  });
  const queue=h('div',{class:'cv-queue'});
  for(const item of (data.queue||[]).filter(entry=>entry.type==='fiche'))queue.append(ficheCard(item,async()=>{await load();paintReview();}));
  root.replaceChildren(h('div',{class:'living-page'},[h('div',{class:'review-row'},[pick,go]),note,queue,preview]));
}
async function render(view){
  if(view!=='living'&&view!=='fiche')return;
  try{await load();}catch(e){const root=$(view==='living'?'living':'fiche');if(root)root.replaceChildren(h('p',{class:'living-note',role:'status',text:e.message||'The library did not answer.'}));return;}
  if(view==='living')paintCv();else paintReview();
}
window.AtlasLivingUI={render};
})();
