/* AtlasSettings (v2.2 V2): the Settings sheet. It is the former profile dialog (#profileDialog, opened from the avatar or with Ctrl/Cmd + comma) split into tabs: Profile, Privacy, Workspace and, for admins only, Connections and
   Voice. The tabs only show and hide parts that already exist in the page, so every id and handler of the profile, privacy and backup controls keeps working.
   The Voice tab is the one admin control with a secret: the ElevenLabs key is a password field that is always empty, sent once to PUT /api/admin/voice/key, and never shown back (not even its last characters): after a save the
   page says "Key saved · validated <date>" and nothing else. The voice list, the provider, the model and "Test voice" go through /api/admin/voice*; the test audio arrives as a blob and plays from a blob: URL (the page's
   policy allows media from blob: only). Text from the server is only ever set as text, never as markup. */
(()=>{'use strict';
const $=id=>document.getElementById(id),app=()=>window.ATLAS_APP,dlg=$('profileDialog');
function h(tag,attrs={},...kids){const el=document.createElement(tag);for(const [k,v] of Object.entries(attrs||{})){if(v===null||v===undefined||v===false)continue;if(k==='text')el.textContent=v;else if(k.startsWith('on'))el.addEventListener(k.slice(2),v);else el.setAttribute(k,v===true?'':String(v));}
 for(const k of kids.flat())if(k!==null&&k!==undefined&&k!==false)el.append(k instanceof Node?k:document.createTextNode(String(k)));return el;}
if(!dlg||!$('stab-profile'))return;
const TABS=['profile','privacy','workspace','connections','voice'];
let pendingTab=null,adminP=null,current='profile';
const isAdmin=()=>adminP||(adminP=(async()=>{try{await window.AtlasAuth?.probe?.();const b=await app().bootInfo();return window.AtlasAuth?.mode==='live'&&b.libraryRole==='admin';}catch{return false;}})());
window.AtlasAuth?.onSignedIn?.(()=>{adminP=null;});
const visibleTabs=()=>TABS.filter(k=>!$('stab-'+k).hidden);
function select(tab,{focus=false}={}){if(!visibleTabs().includes(tab))tab='profile';current=tab;
 for(const k of TABS){const on=k===tab,b=$('stab-'+k),p=$('spane-'+k);b.setAttribute('aria-selected',on?'true':'false');b.tabIndex=on?0:-1;p.hidden=!on;}
 if(focus)$('stab-'+tab).focus();
 const pane=$('spane-'+tab);pane.scrollTop=0;
 if(tab==='connections')window.AtlasWorkflowUI?.refreshConnections?.();
 if(tab==='voice')voice.show();}
function open(tab){pendingTab=TABS.includes(tab)?tab:null;if(dlg.open){select(pendingTab||current);pendingTab=null;return;}app()?.open('profileDialog');}
// Tabs: click, and the arrow keys, Home and End (automatic activation).
for(const k of TABS)$('stab-'+k).addEventListener('click',()=>select(k));
$('stab-profile').parentElement.addEventListener('keydown',e=>{const list=visibleTabs(),i=list.indexOf(current);let to=null;
 if(e.key==='ArrowRight'||e.key==='ArrowDown')to=list[(i+1)%list.length];else if(e.key==='ArrowLeft'||e.key==='ArrowUp')to=list[(i-1+list.length)%list.length];else if(e.key==='Home')to=list[0];else if(e.key==='End')to=list[list.length-1];
 if(to){e.preventDefault();select(to,{focus:true});}});
// Opening the sheet always starts on Profile (or the tab asked for); the admin tabs appear only once the person is known to be an admin.
const ADMIN_TABS=['connections','voice'];
function opened(){const want=pendingTab;pendingTab=null;for(const el of document.querySelectorAll('[data-admin-tab]'))el.hidden=true;select(want&&!ADMIN_TABS.includes(want)?want:'profile');
 isAdmin().then(a=>{for(const el of document.querySelectorAll('[data-admin-tab]'))el.hidden=!a;if(a&&ADMIN_TABS.includes(want)&&dlg.open)select(want);});}
function closed(){voice.leave();}
let wasOpen=false;new MutationObserver(()=>{if(dlg.open&&!wasOpen){wasOpen=true;opened();}else if(!dlg.open&&wasOpen){wasOpen=false;closed();}}).observe(dlg,{attributes:true,attributeFilter:['open']});
// Ctrl/Cmd + comma opens it from anywhere; the footer's save status opens it on the Workspace tab.
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key===','){e.preventDefault();if(!dlg.open)open('profile');}},true);
$('enableSave')?.addEventListener('click',()=>{pendingTab='workspace';},true);

// ---------------------------------------------------------------- the Voice tab
const voice=(()=>{
 const root=()=>$('adminVoicePanel');
 let st=null,loading=false,voices=[],next=null,query='',msg='',msgBad=false,busy=false,searchTimer=0,audio=null,audioUrl='',draft={choice:'auto',voiceId:'',voiceName:'',modelId:''},voicesErr='',listSeq=0;
 async function api(method,path,body){const b=await app().bootInfo();
  const r=await window.AtlasAuth.fetch(path,{method,headers:method==='GET'?{}:{'Content-Type':'application/json','X-Atlas-CSRF':b.csrf},body:body===undefined?undefined:JSON.stringify(body)});
  if(r.ok&&/^audio\//.test(r.headers.get('content-type')||''))return r.blob();
  const d=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(typeof d.error==='string'?d.error:'That did not work.'),{code:d.code,status:r.status});return d;}
 const say=(t,bad=false)=>{msg=t;msgBad=bad;const el=$('voiceMsg');if(el){el.textContent=t;el.dataset.bad=bad?'1':'';}};
 const when=iso=>{const d=new Date(iso);return Number.isNaN(d.getTime())?'':d.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});};
 const n=x=>Number(x).toLocaleString();
 function stopAudio(){try{audio?.pause();}catch{}if(audioUrl){URL.revokeObjectURL(audioUrl);audioUrl='';}audio=null;}
 function adopt(s){st=s;draft={choice:s.choice,voiceId:s.voiceId,voiceName:s.voiceName,modelId:s.modelId};}
 function statusLine(){if(!st)return 'Loading…';
  const nm=st.voiceName||'the chosen voice',model=(st.models.find(m=>m.id===st.modelId)||{}).label?.split(':')[0]||st.modelId;
  if(st.choice==='elevenlabs'&&!st.keyAvailable)return 'ElevenLabs is selected but no key is available, so Workers AI (Aura) is speaking. Add a key to use ElevenLabs.';
  if(st.provider==='elevenlabs')return 'In use: ElevenLabs, '+nm+' ('+model+'), for every language. If ElevenLabs cannot answer, ATLAS speaks that sentence with Workers AI (English and Spanish only).';
  if(st.keyAvailable&&st.choice!=='aura')return 'In use: Workers AI (Aura) for English and Spanish. ElevenLabs covers the languages Workers AI cannot say.';
  return 'In use: Workers AI (Aura). Languages it cannot say appear as text.';}
 function radio(value,title,text,disabled){const id='voiceProv_'+value,input=h('input',{type:'radio',name:'voiceProvider',id,value,disabled});input.checked=draft.choice===value;
  input.addEventListener('change',()=>{draft.choice=value;paintDirty();});
  return h('label',{class:'check settings-radio',for:id},input,h('span',{},h('b',{text:title}),h('small',{class:'field-note',text:text})));}
 function keyBlock(){const out=[h('h4',{text:'ElevenLabs key'})];
  if(!st.storable){out.push(h('p',{class:'small muted',id:'voiceNoStore',text:{SETTINGS_KEYS_OFF:'Stored keys are switched off on this deployment.',SETTINGS_KEY_WEAK:'Keys cannot be stored yet: the SETTINGS_KEY secret is too short.'}[st.storableReason]||'Keys cannot be stored from here yet: this deployment has no SETTINGS_KEY secret. Whoever deploys ATLAS creates it by running deploy.sh again.'}),
   h('p',{class:'small muted',text:st.keyEnv?'A key set on the server by the operator is in use. It works as before.':'A key set on the server by the operator would still work.'}));return out;}
  if(st.keyStored){const meta=[st.keyReadable?'Key saved · validated '+(when(st.validatedAt)||'earlier'):'A key is saved but this deployment can no longer read it. Save the key again.'];
   if(st.keyReadable&&st.tier)meta.push(st.tier.charAt(0).toUpperCase()+st.tier.slice(1)+' plan'+(st.charactersLimit?', '+n(Math.max(0,st.charactersLimit-(st.charactersUsed||0)))+' of '+n(st.charactersLimit)+' characters left when checked':''));
   out.push(h('p',{class:'small',id:'voiceKeyState',text:meta.join(' · ')}),h('div',{class:'actions'},h('button',{class:'btn danger-quiet',type:'button',id:'voiceKeyRemove',onclick:removeKey},'Remove key')));}
  else if(st.keyEnv)out.push(h('p',{class:'small',id:'voiceKeyState',text:'A key is set on the server by the operator and is in use.'}));
  out.push(h('label',{class:'field-label',for:'voiceKey',text:st.keyStored?'Replace the key':'Paste your ElevenLabs API key'}),
   h('div',{class:'settings-row'},h('input',{type:'password',id:'voiceKey',class:'settings-input',autocomplete:'new-password',spellcheck:'false',autocapitalize:'off',autocorrect:'off',maxlength:'200','aria-describedby':'voiceKeyNote',placeholder:'Never shown again after saving'}),
    h('button',{class:'btn primary',type:'button',id:'voiceKeySave',onclick:saveKey},'Check and save key')),
   h('p',{class:'tiny muted',id:'voiceKeyNote',text:'Write-only. ATLAS checks the key with ElevenLabs (it must be allowed to read voices and create speech), keeps it encrypted, and never shows it, or any part of it, again.'}));
  return out;}
 function voiceBlock(){if(!st.keyAvailable)return [h('p',{class:'small muted',text:'Add a key to choose an ElevenLabs voice and model.'})];
  const model=h('select',{id:'voiceModel',class:'settings-input','aria-label':'ElevenLabs model'},...st.models.map(m=>{const o=h('option',{value:m.id,text:m.label});if(m.id===draft.modelId)o.selected=true;return o;}));
  model.addEventListener('change',()=>{draft.modelId=model.value;paintDirty();});
  const search=h('input',{type:'search',id:'voiceSearch',class:'settings-input',autocomplete:'off',spellcheck:'false',maxlength:'60',placeholder:'Search your voices by name'});search.value=query;
  search.addEventListener('input',()=>{query=search.value;clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadVoices(true),350);});
  return [h('h4',{text:'Voice and model'}),h('label',{class:'field-label',for:'voiceSearch',text:'Voice'}),search,h('div',{id:'voiceListWrap'}),
   h('p',{class:'tiny muted',text:'The voices of your ElevenLabs account. Use Test voice to hear the one you picked.'}),
   h('label',{class:'field-label',for:'voiceModel',text:'Model'}),model];}
 // Only the list is repainted when voices arrive, so typing in the key or search box is never interrupted.
 function paintList(){const wrap=$('voiceListWrap');if(!wrap||!st)return;
  const sel=h('select',{id:'voiceVoice',class:'settings-input voice-list',size:'6','aria-label':'ElevenLabs voice'}),cur=draft.voiceId,list=voices.slice();
  if(cur&&!list.some(v=>v.id===cur))list.unshift({id:cur,name:draft.voiceName||'Current voice',labels:['current']});
  for(const v of list){const o=h('option',{value:v.id,text:v.name+(v.labels?.length?' · '+v.labels.join(', '):'')});if(v.id===cur)o.selected=true;sel.append(o);}
  sel.addEventListener('change',()=>{const v=list.find(x=>x.id===sel.value);draft.voiceId=sel.value;draft.voiceName=v?v.name:'';paintDirty();});
  wrap.replaceChildren(sel,voicesErr?h('p',{class:'tiny',id:'voiceListErr',text:voicesErr}):null,next?h('button',{class:'quiet',type:'button',id:'voiceMore',onclick:()=>loadVoices(false)},'Show more voices'):null);}
 function paintDirty(){const b=$('voiceSave');if(!b||!st)return;const dirty=draft.choice!==st.choice||(st.keyAvailable&&(draft.voiceId!==st.voiceId||draft.modelId!==st.modelId));b.disabled=!dirty||busy;}
 function render(){const el=root();if(!el)return;
  if(!st){el.replaceChildren(h('p',{class:'small muted',text:loading?'Loading the voice settings…':'The voice settings could not be loaded.'}));return;}
  el.replaceChildren(
   h('p',{class:'settings-status',id:'voiceStatusLine',role:'status',text:statusLine()}),
   h('fieldset',{class:'settings-fieldset'},h('legend',{text:'Which voice speaks?'}),
    radio('auto','Automatic','Workers AI (Aura) speaks English and Spanish. ElevenLabs is added only for the other languages, when a key is saved.',false),
    radio('aura','Workers AI (Aura)','Cloudflare’s own voice. No extra provider. English and Spanish; other languages appear as text.',false),
    radio('elevenlabs','ElevenLabs','One ElevenLabs voice for every language, English and Spanish included. The text ATLAS speaks is sent to ElevenLabs, an outside provider (listed for your DPO as “to verify”).',!st.keyAvailable)),
   ...keyBlock(),...voiceBlock(),
   h('div',{class:'actions settings-actions'},h('button',{class:'btn primary',type:'button',id:'voiceSave',onclick:saveSettings,disabled:true},'Save voice settings'),h('button',{class:'btn',type:'button',id:'voiceTest',onclick:testVoice},'Test voice')),
   h('p',{class:'small',id:'voiceMsg',role:'status','data-bad':msgBad?'1':'',text:msg}));
  paintList();paintDirty();}
 async function load(){loading=true;if(!st)render();
  try{adopt((await api('GET','/api/admin/voice')).voice);}catch(e){st=null;say(e.message,true);}loading=false;render();if(st?.keyAvailable&&!voices.length)loadVoices(true);}
 async function loadVoices(reset){const el=root();if(!el||!st?.keyAvailable)return;const seq=++listSeq;voicesErr='';
  try{const q=new URLSearchParams();if(query.trim())q.set('search',query.trim());if(!reset&&next)q.set('page',next);
   const d=await api('GET','/api/admin/voice/voices'+(q.toString()?'?'+q:''));if(seq!==listSeq)return;voices=reset?d.voices:voices.concat(d.voices);next=d.nextToken||null;}
  catch(e){if(seq!==listSeq)return;voicesErr=e.message;}
  if(seq===listSeq)paintList();}
 async function run(button,fn,working){if(busy)return;busy=true;const label=button?.textContent;if(button){button.disabled=true;if(working)button.textContent=working;}
  try{await fn();}catch(e){say(e.message,true);}finally{busy=false;if(button&&button.isConnected){button.textContent=label;button.disabled=false;}paintDirty();}}
 const saveKey=e=>{const input=$('voiceKey'),key=input?.value.trim()||'';if(!key){say('Paste the key first.',true);return;}
  input.value='';// whatever happens next, the page never keeps the key
  return run(e.currentTarget,async()=>{say('Checking the key with ElevenLabs…');adopt((await api('PUT','/api/admin/voice/key',{key})).voice);voices=[];next=null;query='';say('Key saved. Choose ElevenLabs above to use it for every language.');render();loadVoices(true);},'Checking…');};
 $('adminVoicePanel')?.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target?.id==='voiceKey'){e.preventDefault();$('voiceKeySave')?.click();}});
 const removeKey=e=>app().confirm('Remove the ElevenLabs key?','ATLAS forgets the saved key and stops using ElevenLabs until you save one again. A key set by the operator on the server is not affected.',()=>run(null,async()=>{adopt((await api('DELETE','/api/admin/voice/key')).voice);voices=[];next=null;say('Key removed.');render();}));
 const saveSettings=e=>run(e.currentTarget,async()=>{const body={};if(draft.choice!==st.choice)body.choice=draft.choice;
  if(st.keyAvailable){if(draft.voiceId&&draft.voiceId!==st.voiceId){body.voiceId=draft.voiceId;body.voiceName=draft.voiceName;}if(draft.modelId!==st.modelId)body.modelId=draft.modelId;}
  if(!Object.keys(body).length)return;adopt((await api('PUT','/api/admin/voice',body)).voice);say('Saved. New interviews use it; one already running keeps its voice until it ends.');render();},'Saving…');
 const testVoice=e=>run(e.currentTarget,async()=>{stopAudio();say('Making a short sample…');
  const body={provider:draft.choice==='elevenlabs'?'elevenlabs':'aura'};if(body.provider==='elevenlabs'){body.voiceId=draft.voiceId;body.modelId=draft.modelId;}
  const blob=await api('POST','/api/admin/voice/test',body);audioUrl=URL.createObjectURL(blob);audio=new Audio(audioUrl);audio.addEventListener('ended',stopAudio);audio.addEventListener('error',stopAudio);
  await audio.play();say('Playing a sample with '+(body.provider==='elevenlabs'?'ElevenLabs':'Workers AI (Aura)')+'.');},'Making a sample…');
 return {show(){load();},leave(){stopAudio();clearTimeout(searchTimer);const k=$('voiceKey');if(k)k.value='';}};})();

window.AtlasSettings={open,select:t=>select(t),tabs:()=>visibleTabs(),current:()=>current};
})();
