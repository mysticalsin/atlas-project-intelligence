/* AtlasProfile (WOW_ZERO_CONFIG §3.5, §5, §8): the signed-in person's profile, read from and saved to the server only
   (GET/POST /api/library/profile). It fills in forms, with a chip naming each value's source, and every value can be
   edited. Nothing here is ever sent to an AI model or written to browser storage. Also the admin "People directory" import,
   which reads only the six approved columns of a DNA export and drops every other column in this browser. */
(()=>{'use strict';
const C=window.AtlasProfileCore,$=id=>document.getElementById(id),app=()=>window.ATLAS_APP;
let profile=null,loadP=null,section=null,jevOn=false; // jevOn: bootstrap jev (story rating by JEV is configured)
function h(tag,attrs={},...kids){const el=document.createElement(tag);for(const [k,v] of Object.entries(attrs||{})){if(v===null||v===undefined||v===false)continue;if(k==='text')el.textContent=v;else if(k.startsWith('on'))el.addEventListener(k.slice(2),v);else el.setAttribute(k,v===true?'':String(v));}
 for(const k of kids.flat())if(k!==null&&k!==undefined&&k!==false)el.append(k instanceof Node?k:document.createTextNode(String(k)));return el;}
function clean(d){if(!d||typeof d!=='object'||!d.fields||typeof d.fields!=='object')return null;const fields={};
 for(const k of C.FIELDS){const f=d.fields[k],n=C.LIMITS[k];
  fields[k]=f&&typeof f==='object'&&typeof f.value==='string'&&C.SOURCES.includes(f.from)?{value:f.value.slice(0,n),from:f.from,at:typeof f.at==='string'?f.at.slice(0,40):'',
   ...(f.newer&&typeof f.newer==='object'&&typeof f.newer.value==='string'&&C.SOURCES.includes(f.newer.from)?{newer:{value:f.newer.value.slice(0,n),from:f.newer.from}}:{})}:null;}
 const consent=c=>c&&typeof c==='object'?{version:Number(c.version)||1,at:String(c.at||'').slice(0,40)}:null;
 return {email:typeof d.email==='string'?d.email.slice(0,200):'',fields,firstName:C.validFirstName(d.firstName),guessed:d.guessed===true||fields.name?.from==='guess',
  consents:{spokenAsk:consent(d.consents?.spokenAsk),jevRating:consent(d.consents?.jevRating)},
  sources:Array.isArray(d.sources)?d.sources.slice(0,8).filter(s=>s&&typeof s.id==='string').map(s=>({id:s.id,state:String(s.state||'')})):[],updatedAt:String(d.updatedAt||'').slice(0,40)};}
// A profile that arrives while the section holds unsaved typing (a fresh load after signing in again, say) never
// re-renders it: the typing is kept, and Save compares it with the new values. The answer to a POST from the section
// itself (Save, Use it, Keep mine) does re-render it.
function set(p,{force=false}={}){const keep=!force&&sectionDirty();profile=p;window.dispatchEvent(new CustomEvent('atlas-profile'));if(section&&!section.hidden&&!keep)renderSection();paintProjectForm();}
// Only on the live site, with the library and the profile feature (bootstrap features.profile, gated by profile.READY).
function load({fresh=false}={}){if(loadP&&!fresh)return loadP;
 loadP=(async()=>{try{await window.AtlasAuth?.probe();const b=await window.AtlasAuth.boot();
  jevOn=!!b.jev;if(window.AtlasAuth.mode!=='live'||!b.library||!b.features?.profile||!app()){set(null);return null;}
  set(clean(await app().libraryApi('/profile')));}catch(e){if(!(e instanceof window.AtlasAuth.Expired))set(null);}return profile;})();
 return loadP;}
async function post(path,body){const p=clean(await app().libraryApi(path,{method:'POST',body}));if(p)set(p,{force:true});return p;}
const confirmGuess=()=>post('/profile',{confirmGuess:true});
const api={load,ready:()=>loadP||Promise.resolve(null),get:()=>profile,
 displayName:()=>C.value(profile,'name'),confirmedName:()=>C.confirmedName(profile),title:()=>C.value(profile,'title'),
 manager:()=>({name:C.value(profile,'managerName'),email:C.value(profile,'managerEmail')}),
 firstName:()=>C.validFirstName(profile?.firstName),email:()=>profile?.email||'',guessed:()=>!!profile?.guessed,
 spokenAsk:()=>!!profile?.consents?.spokenAsk,confirmGuess,
 grantSpokenAsk:()=>post('/profile/consent',{kind:'spokenAsk',version:1,granted:true}),
 revokeSpokenAsk:()=>post('/profile/consent',{kind:'spokenAsk',version:1,granted:false}),
 // Story rating by JEV (docs/JEV_RATING.md §8): the owner's consent, asked by app.js, stored and revocable like spoken Ask.
 jevRating:()=>!!profile?.consents?.jevRating,
 grantJevRating:()=>post('/profile/consent',{kind:'jevRating',version:1,granted:true}),
 revokeJevRating:()=>post('/profile/consent',{kind:'jevRating',version:1,granted:false})};
// ---- profile section, at the top of the profile dialog (§8)
const ROWS=[['name','Name'],['preferredName','First name shown on screen'],['email','Email (your sign-in)'],['title','Job title'],['managerName','N+1 (line manager)'],['managerEmail','N+1 email']];
const shown=k=>k==='email'?profile?.email||'':profile?.fields?.[k]?.value||'';
function chip(k,v){const f=profile?.fields?.[k];const t=k==='email'?'':C.chipFor(f,v);return h('span',{class:'tag field-chip','data-pf-chip':k,hidden:!t},t);}
function say(t){const s=$('pfStatus');if(s)s.textContent=t||'';}
function renderSection(){if(!section)return;section.replaceChildren();if(!profile){section.hidden=true;return;}section.hidden=false;
 section.append(h('h3',{text:'You'}),h('p',{class:'tiny muted',text:'ATLAS fills in forms with this, so you don’t have to. Change anything that’s wrong.'}));
 if(profile.guessed&&C.value(profile,'name'))section.append(h('p',{class:'profile-guess small'},'Is this right? ',
  h('button',{class:'btn',type:'button',onclick:async e=>{e.currentTarget.disabled=true;try{await confirmGuess();say('Thanks. Your name is confirmed.');}catch(err){say(err.message);}}},'Yes, that’s me'),' ',
  h('button',{class:'quiet',type:'button',onclick:()=>$('pf_name')?.focus()},'Edit')));
 const grid=h('div',{class:'form-grid profile-grid'});
 for(const [k,label] of ROWS){const v=shown(k),id='pf_'+k,input=h('input',{id,maxlength:k==='email'?200:C.LIMITS[k],autocomplete:'off',type:k.endsWith('mail')?'email':'text',readonly:k==='email'});input.value=v;input.dataset.pfField=k;
  const box=h('div',{},h('label',{class:'field-label',for:id},label+' ',chip(k,v)),input);
  const nw=profile.fields?.[k]?.newer;if(nw&&nw.value!==v)box.append(h('p',{class:'tiny profile-newer'},(nw.from==='signin'?'Your sign-in now says ':'DNA now says ')+nw.value+'. ',
   h('button',{class:'quiet',type:'button',onclick:()=>act(()=>post('/profile',{clear:[k]}),'Updated.')},'Use it'),' ',
   h('button',{class:'quiet',type:'button',onclick:()=>act(()=>post('/profile',{set:{[k]:v}}),'Kept.')},'Keep mine')));
  if(k!=='email')input.addEventListener('input',()=>{const c=section.querySelector(`[data-pf-chip="${k}"]`),t=C.chipFor(profile?.fields?.[k],input.value);c.textContent=t;c.hidden=!t;});
  grid.append(box);}
 section.append(grid,h('div',{class:'actions'},h('button',{class:'btn primary',id:'pfSave',type:'button',onclick:saveSection},'Save'),h('button',{class:'quiet',id:'pfDelete',type:'button',onclick:deleteProfile},'Delete my profile')),
  h('p',{class:'tiny',id:'pfStatus',role:'status'}),
  h('p',{class:'tiny muted',text:'Only you can open this profile. ATLAS’s AI never reads it. DNA values refresh daily and your edits win until DNA changes. Colleagues who type your exact email see only your name and job title. Unused profiles are deleted after 13 months.'}));
 if(profile.consents?.spokenAsk)section.append(h('p',{class:'tiny',id:'pfVoice'},'Voice questions: allowed · ',h('button',{class:'quiet',type:'button',onclick:()=>act(api.revokeSpokenAsk,'Voice questions are off. ATLAS asks again next time.')},'Revoke')));
 if(jevOn&&profile.consents?.jevRating)section.append(h('p',{class:'tiny',id:'pfJev'},'Story rating by JEV: allowed · ',h('button',{class:'quiet',type:'button',onclick:()=>act(api.revokeJevRating,'Story rating by JEV is off. ATLAS asks again next time.')},'Turn off')));
 section.append(h('hr'));}
async function act(fn,ok){try{await fn();say(ok);}catch(e){say(e.message);}}
function edits(){const set={},clear=[];if(!section)return {set,clear};
 for(const el of section.querySelectorAll('input[data-pf-field]')){const k=el.dataset.pfField;if(k==='email')continue;const v=el.value.trim(),f=profile?.fields?.[k];
  if(v&&v!==(f?.value||''))set[k]=v.slice(0,C.LIMITS[k]);else if(!v&&f?.from==='you')clear.push(k);}
 return {set,clear};}
function sectionDirty(){if(!section||section.hidden||!profile)return false;const e=edits();return Object.keys(e.set).length>0||e.clear.length>0;}
async function saveSection(){const {set,clear}=edits();if(!Object.keys(set).length&&!clear.length){say('Nothing to save.');return;}
 if(set.managerEmail!==undefined){const m=C.validEmail(set.managerEmail);if(!m){say('Check the N+1 email address.');return;}if(m===String(profile?.email||'').toLowerCase()){say('Your N+1 can’t be you.');return;}set.managerEmail=m;}
 await act(()=>post('/profile',{...(Object.keys(set).length?{set}:{}),...(clear.length?{clear}:{})}),'Saved.');}
function deleteProfile(){app()?.confirm('Delete my profile?','This deletes your edits and consents. Values from DNA come back from DNA; ask your admin if they are wrong.',async()=>{
 try{await app().libraryApi('/profile/delete',{method:'POST',body:{}});await load({fresh:true});app().toast('Your profile edits and consents were deleted.');if($('profileDialog')?.open)renderSection();}catch(e){app().toast(e.message);}});}
// ---- the end-of-interview question when the name is only a guess (§3.5). It never blocks.
function guessPrompt(el,projectId){const g=C.value(profile,'name');if(!el||!profile?.guessed||!g)return;
 const wrap=h('span',{class:'guess-prompt'},' Is your name '+g+'? ');
 const yes=h('button',{class:'quiet',type:'button',onclick:async()=>{yes.disabled=true;edit.disabled=true;
  try{await confirmGuess();await app()?.adoptProfileName?.(projectId);const t=' Thanks, '+(api.firstName()||api.confirmedName())+'.';document.querySelectorAll('.guess-prompt').forEach(w=>{w.textContent=t;});}catch(e){wrap.textContent=' '+e.message;}}},'Yes, that’s me');
 const edit=h('button',{class:'quiet',type:'button',onclick:()=>{app()?.open('profileDialog');setTimeout(()=>$('pf_name')?.focus(),60);}},'Edit');
 wrap.append(yes,' ',edit);el.append(wrap);}
// ---- project form: prefill chips computed at render time (§3.5)
const FORM=[['consultantName','name'],['consultantRole','title'],['n1Name','managerName'],['n1Email','managerEmail']];
// The N+1 name ATLAS put in #n1Name (§5.8), and the email it belongs to: the new-project prefill (from '') or a people
// lookup (from 'dna' | 'dna_export', named by its chip). Only such a name follows the email; a name typed here, or the stored
// name of a project being edited, is never replaced. Never stored (the only stored provenance is roleFrom).
// fresh: the form was just opened; edit: for an existing project.
let n1Auto=null,n1Seq=0;const n1Found=new Map(),n1Ours=()=>!!n1Auto&&$('n1Name')?.value.trim()===n1Auto.name;
function paintProjectForm({fresh=false,edit=false}={}){let fromProfile=false;
 if(fresh){n1Seq++;const n=$('n1Name')?.value.trim();n1Auto=!edit&&n?{email:C.validEmail($('n1Email')?.value),name:n,from:''}:null;}
 for(const [id,k] of FORM){const input=$(id),c=document.querySelector(`[data-chip="${id}"]`);if(!input||!c)continue;const f=profile?.fields?.[k];let t=profile?C.chipFor(f,input.value):'';
  if(t&&t!=='you edited')fromProfile=true;else if(t&&id==='n1Name'&&n1Ours()&&n1Auto.from)t=C.sourceLabel(n1Auto.from);
  c.textContent=t;c.hidden=!t;}
 const note=$('projectPrefillNote');if(note)note.hidden=!fromProfile;
 const hint=$('roleHint'),role=$('consultantRole')?.value.trim();if(hint)hint.hidden=!(profile&&role&&role===C.value(profile,'title'));}
for(const [id] of FORM)$(id)?.addEventListener('input',()=>paintProjectForm());
// §5.8: a typed N+1 email fills the N+1 name: your profile's N+1 when it is that email, else GET /people, which reads stored
// directory rows only (never DNA, never anyone's profile). Only on a committed change, each found email once per page
// (30 lookups an hour). Not found, refused or offline: nothing is filled and nothing is guessed.
async function findPerson(e){if(n1Found.has(e))return n1Found.get(e);
 try{const p=await app().libraryApi('/people?email='+encodeURIComponent(e));
  if(typeof p?.name!=='string'||!p.name.trim()||!['dna','dna_export'].includes(p.from))return null;
  const hit={name:p.name.trim().slice(0,C.LIMITS.managerName),from:p.from};n1Found.set(e,hit);return hit;}catch{return null;}}
$('n1Email')?.addEventListener('change',async()=>{const name=$('n1Name'),seq=++n1Seq,e=C.validEmail($('n1Email').value);if(!profile||!name)return;
 if(n1Ours()&&n1Auto.email!==e){name.value='';n1Auto=null;paintProjectForm();}  // ATLAS's name belonged to the old email
 if(!e||name.value.trim()||e===String(profile.email||'').toLowerCase())return;  // a typed name stays; your N+1 can't be you
 const mine=e===C.value(profile,'managerEmail').toLowerCase()&&C.value(profile,'managerName');
 const hit=mine?{name:mine,from:''}:await findPerson(e);  // the profile's own pair needs no lookup (its chip is the profile's)
 if(!hit||seq!==n1Seq||name.value.trim()||C.validEmail($('n1Email').value)!==e)return;  // a newer change, a reopened form or typing wins
 n1Auto={email:e,...hit};name.value=hit.name;paintProjectForm();});
// ---- admin: People directory (§5.6). Rows are built from the mapped approved columns only; nothing else is uploaded.
const DIR={table:null,file:''};
async function renderDirectory(){const el=$('peopleDirectory');if(!el)return;const b=await window.AtlasAuth.boot();
 if(b.libraryRole!=='admin'||!b.features?.profile||window.AtlasAuth.mode!=='live'){el.hidden=true;return;}
 let st;
 try{st=await app().libraryApi('/directory');}catch(e){el.replaceChildren(h('h3',{text:'People directory'}),h('p',{class:'tiny muted',text:e.message}));el.hidden=false;return;}
 const prod=st.dataMode==='production',n=Number(st.rows?.dna_export)||0; // an import replaces the DNA-export rows (the shrink guard compares with those)
 el.replaceChildren(h('h3',{text:'People directory'}));
 el.append(h('p',{class:'tiny muted',text:prod?'Upload the DNA export as CSV. Only email, name, first name, job title and N+1 are read; every other column stays on your computer. Nobody can browse this directory.':'Test deployment: only synthetic addresses (example.com, .test) are accepted. Real DNA data needs the production deployment.'}),
  h('p',{class:'tiny',text:(st.rows?.dna||0)+' from DNA · '+(st.rows?.dna_export||0)+' from the DNA export'}));
 const line=(label,s,need)=>h('p',{class:'tiny muted',text:label+': '+(s?.status==='on'?'connected':'not connected ('+need+')')});
 el.append(line('DNA push',st.sources?.push,'needs the push secret from Mantu IT and the production deployment'),
  line('DNA pull',st.sources?.pull,'needs '+((st.sources?.pull?.needs||[]).join('; ')||'configuration from Mantu IT')));
 const file=h('input',{type:'file',accept:'.csv,text/csv',id:'dirFile','aria-label':'DNA export (CSV)'}),box=h('div',{id:'dirMap'}),out=h('p',{class:'tiny',id:'dirStatus',role:'status'});
 file.addEventListener('change',async()=>{const f=file.files?.[0];box.replaceChildren();out.textContent='';if(!f)return;
  if(f.size>5000000){out.textContent='This file is over 5 MB.';return;}
  try{DIR.table=C.parseCsv(await f.text());DIR.file=f.name;mapping(box,out,n);}catch(e){out.textContent=e.message;}});
 el.append(h('label',{class:'field-label',for:'dirFile'},'DNA export (CSV)'),file,box,out,
  h('div',{class:'actions'},h('button',{class:'quiet',type:'button',onclick:()=>app().confirm('Clear the people directory?','This removes every imported DNA row. Profiles and your colleagues’ own edits are not affected.',async()=>{try{const r=await app().libraryApi('/directory/clear',{method:'POST',body:{}});app().toast((r.cleared||0)+' rows removed.');renderDirectory();}catch(e){app().toast(e.message);}})},'Clear directory')));
 el.hidden=false;}
function mapping(box,out,before){const t=DIR.table,sug=C.suggestColumns(t.header),labels={email:'Email',name:'Name',givenName:'First name',title:'Job title',managerName:'N+1 name',managerEmail:'N+1 email'},sel={};
 box.append(h('p',{class:'tiny muted',text:'Check the columns ATLAS suggests. Other columns are never read or sent.'}));
 for(const k of C.APPROVED){const s=h('select',{id:'dirCol_'+k,'aria-label':labels[k]},h('option',{value:'-1'},'Not in this file'),...t.header.map((c,i)=>h('option',{value:String(i)},c||'Column '+(i+1))));s.value=String(sug[k]);sel[k]=s;box.append(h('label',{class:'field-label',for:'dirCol_'+k},labels[k]),s);}
 const ask=h('p',{class:'tiny'}),shrink=h('label',{class:'check',hidden:true},h('input',{type:'checkbox',id:'dirShrink'}),h('span',{text:'That is far fewer people than before. Replace anyway?'})),go=h('button',{class:'btn primary',type:'button'},'Import');
 const plan=()=>{const m=Object.fromEntries(C.APPROVED.map(k=>[k,Number(sel[k].value)]));try{const r=C.directoryRows(t,m);ask.textContent='This replaces '+before+' rows with '+r.rows.length+'.';shrink.hidden=!(r.rows.length<0.8*before);go.disabled=!r.rows.length;return {...r,m};}catch(e){ask.textContent=e.message;go.disabled=true;return null;}};
 for(const s of Object.values(sel))s.addEventListener('change',plan);plan();
 go.addEventListener('click',async()=>{const r=plan();if(!r)return;const big=r.rows.length<0.8*before;if(big&&!$('dirShrink').checked){out.textContent='Tick “Replace anyway” to replace the directory with far fewer people.';return;}
  if(r.rows.length>20000){out.textContent='This file has more than 20,000 people.';return;}
  go.disabled=true;out.textContent='Importing…';const batch=C.randomBatchId(),parts=C.batches(r.rows);let accepted=0;const skipped=r.rejected.slice();
  try{for(let i=0;i<parts.length;i++){const final=i===parts.length-1;
    const res=await app().libraryApi('/directory/import',{method:'POST',body:{batch,part:i+1,final,rows:parts[i],...(final&&big?{confirmShrink:true}:{})}});
    // The server numbers rejected rows 1-based across the whole batch (profile.js importRows): mapped back to spreadsheet rows.
    accepted+=Number(res.accepted)||0;for(const x of res.rejected||[]){const line=r.lines[Number(x.row)-1];skipped.push({row:line||x.row,reason:String(x.reason||'rejected').slice(0,80)});}}
   const by={};for(const x of skipped)(by[x.reason]=by[x.reason]||[]).push(x.row);
   out.textContent=accepted+' people imported · '+skipped.length+' rows skipped'+(skipped.length?' ('+Object.entries(by).map(([why,rows])=>'rows '+rows.slice(0,12).join(', ')+(rows.length>12?'…':'')+': '+why).join('; ')+')':'');
   DIR.table=null;}
  catch(e){out.textContent=e.message;}finally{go.disabled=false;}});
 box.append(ask,shrink,go);}
window.AtlasAuth?.dirty(sectionDirty);
// Opening the dialog again keeps unsaved typing too (it is unsaved work for the re-sign-in rules, §3.7).
window.AtlasProfile={...api,renderSection:()=>{section=$('profileSection');if(!sectionDirty())renderSection();},guessPrompt,paintProjectForm,renderDirectory};
section=$('profileSection');
})();
