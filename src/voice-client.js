/* Real PersonaPlex transport. No browser speech recognition or synthetic read-aloud fallback. */
'use strict';
(()=>{
const $=id=>document.getElementById(id), bridge=window.ATLAS_VOICE_BRIDGE; // every bridge.context({interview:true}) below is the project THIS interview belongs to (app.js voiceSnapshot): a project that already holds an interview is not the next one's unless it was picked
const {html,setHTML}=window.AtlasSafe, P0={clean:t=>window.AtlasProfileCore?.clean?window.AtlasProfileCore.clean(t):String(t??'')}; // P0.clean: bidi and zero-width characters removed from a name
const labels=['Context','Contribution','Approach','Outcome','Evidence','Customer relevance'];
let boot=null, generation=0, socket=null, stream=null, audio=null, node=null, source=null;
let phase='idle', muted=false, paused=false, pausedAt=null, pausedMs=0, controlsOn=null, current=null, startedAt=0, timer=null, heardOutput=false, accumulated='', lastNotes=null;let micLabel='',micPeak=0,micWatch=0;
let outputItem=null, lastPlaybackAck=0, audioStats=null; // audioStats: the worklet's last meter (ms queued, times the buffer ran dry), for tests and diagnostics
// Typed interview (X1): textMode: this interview has no microphone and ATLAS answers in text. wantInput: how the consent dialog was opened ('voice' | 'text'). typedPending: a typed turn
// sent and not yet taken or refused by the server ({text, at}); the box keeps its text until the server echoes the turn. log: the conversation shown in a typed interview.
let textMode=false, wantInput='voice', typedPending=null, typedTimer=0, lastHeardItem=null, focusTimer=0, log=[], heardTurns=new Set();
const TYPED_WAIT_MS=6000;
// Checkpoint and reconnect (T10). sessionId: the interview's id, announced in `ready` when the server keeps it for 24 hours (only with transcript consent).
// sessionStart: what a resume needs again. reconnecting: the retry loop is running (the microphone stays open; ATLAS says the question again when it is back).
const RECONNECT_MS=[1000,2000,4000];
let sessionId=null, sessionStart=null, reconnecting=false, resumeDlg=null;
// U1: voice can be off on a server (no speech service): then the typed interview is the way in. micBlocked: the microphone could not be opened, so the start area offers "Continue by typing" and a retry (the consent already given is kept).
const voiceOff=b=>!!b&&(b.voice===false||b.codecAvailable===false);
let micBlocked=false;
const MIC_WORDS={NotAllowedError:'Your browser or system is blocking the microphone, so ATLAS can’t hear you yet.',SecurityError:'Your browser or system is blocking the microphone, so ATLAS can’t hear you yet.',NotFoundError:'No microphone was found on this device.',NotReadableError:'Another app is using the microphone, or the system is blocking it.'};
const micIssue=e=>MIC_WORDS[e?.name]||(e?.micUnavailable?'This browser can’t open a microphone on this page.':'');
const providerName=()=>boot?.providerLabel||(boot?.provider==='openai'?'OpenAI Realtime':'NVIDIA PersonaPlex');
let checking=null, readyWatch=null, activeSnapshot=null, permissionPending=false;
// Restart: the consent given on this page (reused only for the same project and the same terms), the teardown of the last
// session (so a new one never overlaps it), and a guard against double clicks.
let lastConsent=null, teardown=Promise.resolve(), restarting=false;
// A proof request (F2) is one-shot: the start that carried it consumes it on 'ready', on an error or close before 'ready',
// and a consent dialog closed without starting consumes it too, so the next start is a full interview. Only the request
// this start used is consumed, and only while the workspace still offers it (a newer request is never cleared).
let gapUsed=null, consentStarting=false;
function consumeGap(){const g=gapUsed;gapUsed=null;try{if(g&&bridge.context({interview:true})?.gap===g)bridge.gapConsumed?.();}catch{}}
// Session event bus for the live story board and the gap results (F5, F2): the server's session events, plus 'reset'
// wherever the 'atlas-quality' reset fires. 'atlas-quality' itself is unchanged.
const SESSION_EVENTS=['ready','time_up','wrap_up','audio_stopped','reporting','notes','ended','summary','summary_closed','summary_confirmed','evidence_draft','evidence_draft_unavailable','time_extended'];
function sessionEvent(detail){window.dispatchEvent(new CustomEvent('atlas-session',{detail}));}
function resetBoards(){window.dispatchEvent(new CustomEvent('atlas-quality',{detail:{type:'reset'}}));sessionEvent({type:'reset'});}
const closed=(s,ms)=>!s||s.readyState===3?Promise.resolve():new Promise(r=>{const t=setTimeout(r,ms);s.onclose=()=>{clearTimeout(t);r();};});
// Separate consent choices (G2): the required one (transcribe and save a private draft), the saved-interview choice (24 hours), private memory (OFF unless ticked) and the privacy notice.
// The server records each as a receipt. `activeConsent` is the object the start message carries; a deployment without transcript capture (the Python gateway) sends the old bare tick.
let activeConsent=null;
const terms=b=>JSON.stringify({provider:b.provider,captureRequired:!!b.captureRequired,transcription:!!b.transcription,memory:!!b.memory,privacy:b.privacy?.version||'',identity:b.identity?.name||''});
const storedChoice=(b,k)=>b.consent?.purposes?.[k]===true&&b.consent?.blocked?.[k]!==true; // the person's own recorded grant, never a default
const consentFor=(b,{resume,typing})=>{if(!b?.captureRequired)return true;const v=b.privacy?.version,st=b.consent?.purposes||{};
 if(resume)return {transcription:!typing,draft:true,checkpoint:true,memory:st.memory===true&&b.consent?.blocked?.memory!==true&&!!b.memory,notice:st.notice===true,...(v?{version:v}:{})}; // Resume is the choice already made: the interview exists only because the saved-interview choice was on
 return {transcription:!typing,draft:true,checkpoint:$('checkpointConsent').checked,memory:!!b.memory&&$('memoryConsent').checked,notice:$('noticeAck').checked,...(v?{version:v}:{})};};
// The idle label and the start control follow the page mode (AtlasAuth.mode, §3.3).
const IDLE={live:'Ready',offline:'Not connected',network:'Not reachable',expired:'Signed out'};
const idleLabel=()=>IDLE[window.AtlasAuth?.mode]||'Not connected';
const homeUrl=()=>typeof window.ATLAS_HOME==='string'&&/^https:\/\/[a-z0-9.-]+$/.test(window.ATLAS_HOME)?window.ATLAS_HOME+'/go/start':'';
let readyFor=0;
const reusable=(b,c)=>!!(lastConsent&&b&&c&&b.codecAvailable&&!b.busy&&c.workspaceId===lastConsent.workspaceId&&c.project?.id===lastConsent.projectId&&terms(b)===lastConsent.terms&&b.voices?.includes(lastConsent.voice));
const canReuse=()=>reusable(boot,bridge.context({interview:true}));
// How the reused choices are described, from what this server actually does with them.
const choices=()=>{const b=boot||{};if(b.captureRequired)return 'transcribed and saved with a report';if(!lastConsent?.capture)return ['kyutai','workers'].includes(b.provider)?'transcribed live, not kept after the session':'not transcribed';return 'transcribed and saved to your project'+(b.liveLedger||b.structuredNotes?' with a report':'');};
function status(state,heading,message){phase=state;if(state!=='live')calmLive();if(state==='idle'||state==='error')$('voiceTimer').textContent='00:00';{const vp=$('voicePanel');if(state==='live'){hadLive=true;vp.dataset.ended='false';}else if(state==='preparing'){hadLive=false;vp.dataset.ended='false';}else if((state==='idle'||state==='error')&&hadLive)vp.dataset.ended='true';}if(state!=='idle')micBlocked=false;if(['idle','error','preparing'].includes(state)){paused=false;pausedAt=null;pausedMs=0;controlsOn=null;sessionId=null;}queueMicrotask(livePill);if($('soundHelp')){$('soundHelp').hidden=!['connecting','live'].includes(state);if($('soundHelp').hidden)$('soundHelpPanel').hidden=true;}$('voiceState').textContent=state==='live'?providerName()+(textMode?' · typed interview':' connected'):state==='idle'?idleLabel():state==='ending'?'Preparing notes':state.charAt(0).toUpperCase()+state.slice(1);$('voiceHeading').textContent=String(heading).replace(/\.$/,'');$('voiceMessage').textContent=message;if($('voiceRestartDialog')?.open&&!['connecting','live','error'].includes(state))$('voiceRestartDialog').close();if(state==='idle'||state==='error')$('voicePrivacy').textContent='Microphone off. No audio is streaming. Live voice starts only after connection and consent.';controls();}
function controls(){const active=['preparing','connecting','live'].includes(phase), ending=phase==='ending';$('voiceStart').disabled=active||ending;$('voiceMute').disabled=phase!=='live';$('voiceMute').hidden=textMode&&['preparing','connecting','live','ending'].includes(phase);$('voiceStartText').disabled=active||ending;$('voiceEnd').disabled=(!active&&!ending)||reconnecting;{const label=ending?'Discard pending notes':phase==='preparing'||phase==='connecting'?(textMode?'Cancel':'Cancel connection'):'Stop interview';$('voiceEndLabel').textContent=label;$('voiceEnd').setAttribute('aria-label',phase==='live'?'Stop the interview':label);}$('voiceEnd').hidden=!active&&!ending;const again=['connecting','live'].includes(phase)||(phase==='error'&&canReuse());$('voiceRestart').disabled=!again||restarting||reconnecting;if($('voiceRestartQuiet')){$('voiceRestartQuiet').hidden=!(phase==='error'&&canReuse());$('voiceRestartQuiet').disabled=restarting||reconnecting;}if(['connecting','live'].includes(phase))$('voiceRestart').setAttribute('aria-haspopup','dialog');else $('voiceRestart').removeAttribute('aria-haspopup');$('voiceMute').textContent=muted?'Unmute microphone':'Mute microphone';$('voiceMute').setAttribute('aria-pressed',String(muted));$('voicePanel').dataset.input=textMode?'text':'voice';
 {const mh=$('voiceMicHelp'),on=micBlocked&&phase==='idle';if(mh){mh.hidden=!on;$('voiceMicType').hidden=boot?.textMode!==true;$('voiceMicType').disabled=$('voiceMicRetry').disabled=!on;$('voiceControls').dataset.mic=on?'blocked':'';}}
 $('voiceOrb').classList.toggle('active',phase==='live');window.AtlasOrbUI?.state(phase,muted||paused,paused);paintControls();}
// Pause / Repeat and the typed answer (T9): shown only when this server announced them in `ready` (the other voice routes never receive them).
const VC=window.AtlasVoiceControls,supported=k=>VC.supports({controls:controlsOn},k);
function send(msg){if(!msg||socket?.readyState!==1)return false;socket.send(JSON.stringify(msg));return true;}
function paintControls(){const v=VC.view({phase,paused,muted,controls:controlsOn,draft:$('voiceTypeInput').value});
 for(const [id,hide,off] of [['voicePause',v.pauseHidden,v.pauseDisabled],['voiceRepeat',v.repeatHidden,v.repeatDisabled]]){$(id).hidden=hide;$(id).disabled=off;}
 $('voicePause').textContent=v.pauseLabel;$('voicePause').setAttribute('aria-label',v.pauseAria);$('voicePause').dataset.paused=String(v.pausePressed);
 $('voiceTypeForm').hidden=v.textHidden;$('voiceTypeInput').disabled=v.textDisabled;$('voiceTypeSend').disabled=v.sendDisabled||!!typedPending;if(phase==='live')$('voiceMute').disabled=v.muteDisabled;}
// The microphone is closed while muted or paused; the server also ignores audio while paused. Paused time is not interview time (the clock below).
function applyMic(){const off=muted||paused;stream?.getAudioTracks().forEach(t=>t.enabled=!off);node?.port.postMessage({type:'state',enabled:true,muted:off});}
function setPaused(p){if(p===paused||phase!=='live')return;const now=Date.now();if(p)pausedAt=now;else{pausedMs+=now-pausedAt;pausedAt=null;}paused=p;applyMic();if(p){node?.port.postMessage({type:'flush'});window.AtlasOrbUI?.levels(0,0,{low:0,mid:0,high:0});}
 $('voiceState').textContent=p?(textMode?'Paused':'Paused · microphone off'):muted?'Microphone muted · ATLAS may still speak':liveLabel();controls();}
const liveLabel=()=>providerName()+(textMode?' · typed interview':' · listening');
function togglePause(){if(phase!=='live'||!supported('pause'))return;if(send(VC.message(paused?'resume':'pause')))setPaused(!paused);}
// The read-back card's buttons (storyboard-ui.js) ask for a message; only what the server announced is sent, and only while the interview is live.
window.addEventListener('atlas-summary-action',e=>{const d=e.detail||{},m=VC.summaryMessage(d.kind,d.detail_id,d.text);if(!m||phase!=='live'||!supported(m.type))return;send(m);});
// A typed turn stays in the box until the server takes it (its echo as user_text). If the server refuses it (a burst, ATLAS still composing, the protected greeting), the text is
// kept and a gentle note says so under the box; nothing is lost and nothing is sent twice (Send waits for the server's answer, at most TYPED_WAIT_MS).
function typedNote(text){const n=$('voiceTypeNote');if(n)n.textContent=text||'';}
function typedSettle(){clearTimeout(typedTimer);typedTimer=0;const was=typedPending;typedPending=null;$('voiceTypeForm')?.classList.remove('is-sending');if(was)paintLog();paintControls();}
function sendTyped(){const input=$('voiceTypeInput'),m=VC.message('text',input.value);if(phase==='live'&&supported('text')&&!m&&!typedPending&&!input.value.trim()){nudge();return;}if(phase!=='live'||!supported('text')||!m||typedPending)return;
 if(send(m)){typedPending={text:m.text,at:Date.now()};typedNote('');$('voiceTypeForm').classList.add('is-sending');armThinking();paintLog();$('voiceTypeInput').setAttribute('aria-busy','true');clearTimeout(typedTimer);typedTimer=setTimeout(()=>{if(typedPending){typedSettle();typedNote(VC.TYPED_NOTES.timeout);}},TYPED_WAIT_MS);paintControls();}}
function typedAccepted(m){const sent=typedPending;typedSettle();$('voiceTypeInput').removeAttribute('aria-busy');typedNote('');if(!sent)return;const input=$('voiceTypeInput');input.value=VC.afterAccepted(sent.text,input.value,m);input.style.height='auto';if(paused)setPaused(false);
 if(!textMode)$('voiceMessage').textContent='You typed: “'+m.text.slice(0,140)+(m.text.length>140?'…':'')+'”'; /* (a typed interview shows it in the conversation) */if($('orbAccessibleState'))$('orbAccessibleState').textContent='Typed answer sent.';controls();if(textMode)focusSoon();}
function typedRefused(note){if(!typedPending)return;setThinking(false);typedSettle();$('voiceTypeInput').removeAttribute('aria-busy');typedNote(note);const i=$('voiceTypeInput');if(phase==='live'&&!i.disabled)i.focus({preventScroll:true});}
// W1: instant micro-feedback. A sent turn shows in the conversation at once (its text goes pale in the box until the server takes it, so nothing is lost if it refuses); after 300 ms
// without a reply three dots say ATLAS is thinking; an empty Enter is a small shake and a hint. Under prefers-reduced-motion none of it moves (journey.css); the words are the same.
const reduced=()=>!!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);
let hadLive=false,thinking=false,thinkTimer=0,thinkStop=0,openFresh=false,openGate=0,openTimer=0,nudgeTimer=0;
function setThinking(on){clearTimeout(thinkTimer);thinkTimer=0;if(!on){clearTimeout(thinkStop);thinkStop=0;}if(thinking!==on){thinking=on;paintLog();}}
function armThinking(){clearTimeout(thinkTimer);thinkTimer=setTimeout(()=>{thinkTimer=0;if(phase!=='live'||!textMode||paused)return;thinking=true;paintLog();clearTimeout(thinkStop);thinkStop=setTimeout(()=>setThinking(false),30000);},300);}
function calmLive(){clearTimeout(thinkTimer);clearTimeout(thinkStop);clearTimeout(openTimer);thinkTimer=thinkStop=openTimer=0;thinking=false;openFresh=false;openGate=0;}
function nudge(){const f=$('voiceTypeForm');if(!f)return;f.classList.remove('is-nudged');void f.offsetWidth;f.classList.add('is-nudged');typedNote('Type a few words, then press Enter.');clearTimeout(nudgeTimer);nudgeTimer=setTimeout(()=>{if($('voiceTypeNote').textContent==='Type a few words, then press Enter.')typedNote('');f.classList.remove('is-nudged');},3200);}
// The conversation as shown: the log, with ATLAS's first reply split into the greeting and the question (400 ms apart, dots between), the turn being sent, and the thinking dots.
function shown(){const S=window.AtlasStory;const list=log.map(e=>({...e}));
 if(openFresh&&S&&list[0]&&list[0].who==='atlas'){const parts=S.stageOpening(list[0].text);
  if(parts.length>1){if(openGate===0){openGate=reduced()?2:1;if(openGate===1)openTimer=setTimeout(()=>{openTimer=0;openGate=2;paintLog();},400);}
   list.splice(0,1,{...list[0],text:parts[0]},...(openGate===2?[{...list[0],text:parts[1],second:true}]:[{who:'atlas',dots:true,text:''}]));}}
 if(typedPending)list.push({who:'you',text:typedPending.text,pending:true});
 if(thinking&&!list.some(e=>e.dots))list.push({who:'atlas',dots:true,text:''});
 return list;}
// Scroll by whole messages: the newest message is fully in view (or, when it is taller than the box, its top is), and the first message in view starts at the top edge: never a half line.
function alignLog(box){const kids=[...box.children];if(!kids.length)return;if(typeof getComputedStyle!=='function'||!('offsetHeight' in kids[0])){box.scrollTop=box.scrollHeight;return;}
 box.style.paddingBottom='';const cs=getComputedStyle(box),pt=parseFloat(cs.paddingTop)||0,pb=parseFloat(cs.paddingBottom)||0,last=kids[kids.length-1],ch=box.clientHeight,contentH=box.scrollHeight;
 let top=last.offsetTop-pt;
 if(last.offsetHeight<=ch-pt-pb){const need=last.offsetTop+last.offsetHeight-ch+pb;const k=kids.find(e=>e.offsetTop-pt>=need-0.5);if(k)top=k.offsetTop-pt;}
 top=Math.max(0,top);const room=Math.max(0,top+ch-contentH);if(room>0)box.style.paddingBottom=(pb+room)+'px'; /* room below the newest line, so a whole message can sit at the top edge */
 box.scrollTop=top;}
// The conversation of a typed interview (the entries come from VC.logApply). Only what changed is touched, so a screen reader announces the new words and not the whole log again.
function paintLog(){const box=$('textLog');if(!box||!textMode)return;const kids=[...box.children],list=shown();
  list.forEach((e,i)=>{let p=kids[i];if(!p){p=document.createElement('p');p.setAttribute('dir','auto');const who=document.createElement('b'),say=document.createElement('span');who.className='msg-who';say.className='msg-text';p.append(who,say);box.append(p);p.dataset.rise='1';}
   const cls='msg msg-'+(e.who==='you'?'you':'atlas')+(e.private?' is-private':'')+(e.pending?' is-pending':'')+(e.dots?' is-dots':'')+(e.second?' is-question':'');if(p.className!==cls)p.className=cls;if(p.dataset.item!==(e.item||''))p.dataset.item=e.item||'';
   const who=p.firstChild,say=p.lastChild,name=e.who==='you'?'You':'ATLAS',text=e.text.trim();if(who.textContent!==name)who.textContent=name;
   if(e.dots){if(!say.firstElementChild){say.textContent='';for(let k=0;k<3;k++)say.append(document.createElement('i'));}p.setAttribute('aria-hidden','true');}
   else{if(p.getAttribute('aria-hidden'))p.removeAttribute('aria-hidden');if(say.firstElementChild)say.textContent='';if(say.textContent!==text)say.textContent=text;}});
  for(let i=kids.length-1;i>=list.length;i--)kids[i].remove();alignLog(box);}
function logEvent(m){if(!textMode)return;log=VC.logApply(log,m);paintLog();}
// After a reply, a typed interview puts the cursor back in the answer box: only when the person has not gone to another control on purpose.
function focusSoon(){clearTimeout(focusTimer);focusTimer=setTimeout(()=>{const i=$('voiceTypeInput'),a=document.activeElement;if(!textMode||phase!=='live'||i.disabled||$('voiceTypeForm').hidden||document.querySelector('dialog[open]'))return;
 if(!a||a===document.body||a===i||a===$('voiceTypeSend')||a.id==='orbActivate'||a.id==='voiceStartText')i.focus({preventScroll:true});},350);}
function after(message){$('voiceAfter').hidden=false;$('voiceAfter').textContent=message;}
function sync(){livePill();const c=bridge.context({interview:true});$('voicePanel').hidden=false;const real=c&&!c.isNew;$('orbProjectTitle').textContent=real?c.project.title:c?'A new project':'No project selected yet.';$('orbProjectMeta').textContent=real?[c.display?.consultant,c.display?.role,c.project.stage].filter(Boolean).join(' · '):c?'Just start talking. ATLAS creates the project from your story.':'Give the interviewer an authorized project alias. It will ask for the details.';document.body.classList.toggle('has-voice-project',!!real);if($('fitProject')){$('fitProject').textContent=real?c.project.title:'';$('fitProject').hidden=!real;} /* the project's name, shown in the strip above the columns while the left rail is folded away (live) */if(current&&c&&(c.workspaceId!==current.workspaceId||c.project.id!==current.project.id))cancel('Project changed. The microphone was stopped.');if(current&&!c)cancel('Project closed.');controls();}
function request(path,options={}){return window.AtlasAuth.fetch(path,options);}
const NOT_ANSWERING='ATLAS isn’t answering right now. Try again in a minute.';
// Same bootstrap contract as before, through AtlasAuth: an expiry throws AtlasAuth.Expired, other failures give one line.
// It never opens the address form: #connectionDetails is only for the "Connection & privacy" panel the user opens.
async function check(){
 if(checking)return checking;
 checking=(async()=>{boot=null;$('connectionSummary').textContent='Checking ATLAS…';$('connectionDetails').replaceChildren();$('remotePreferenceBox').hidden=true;$('voiceSignout').hidden=true;
 try{if(!['http:','https:'].includes(location.protocol))throw Error('This is an offline copy of ATLAS.');const r=await request('/api/bootstrap',{signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error(NOT_ANSWERING);let b;try{b=await r.json();}catch{throw Error(NOT_ANSWERING);}if(b?.protocol!=='atlas-personaplex-pcm-v1')throw Error(window.ATLAS_RUNTIME?NOT_ANSWERING:'This is not a compatible ATLAS voice gateway.');boot=b;paintLanguages(b);window.AtlasAuth?.paintState?.(b);$('connectionSummary').textContent=b.codecAvailable?'ATLAS is ready. The voice model is checked when you start, not assumed from configuration.':'Voice isn’t available right now. Your projects are safe.';
 const values=[['Identity',b.identity.name+' · '+(b.identity.mode==='entra'?'Microsoft sign-in':b.identity.mode==='access'?'signed in':'local developer only')],['Voice model',b.model+' · not yet inference-tested'],['Capacity',b.busy?'All interview slots are in use':(b.capacity>1?'Up to '+b.capacity+' interviews at once':'One interview at a time')],['Per-user memory',b.memory?(bridge.memoryState?.().on===false?'Off for your conversations':'Hindsight configured; recall checked on start'):'Not configured'],['Consultant notes',b.transcription?(b.liveLedger?'Live input transcription + quote-grounded candidate ledger configured':['kyutai','workers'].includes(b.provider)?'Live transcription configured; evidence analyst not configured':b.structuredNotes?'NVIDIA transcription + extractive topic notes configured':'NVIDIA transcription configured; manually organize notes'):'Transcription not configured'],['Session limit',Math.floor(b.maxSeconds/60)+' minutes']];for(const [k,v]of values){const row=document.createElement('div'),a=document.createElement('strong'),z=document.createElement('span');a.textContent=k;z.textContent=v;row.append(a,z);$('connectionDetails').append(row);} $('remotePreferenceBox').hidden=!b.memory||b.provider==='workers';$('voiceSignout').hidden=!(b.provider==='workers'||b.identity.mode==='entra');queueMicrotask(renderStart);return b;
 }catch(e){if(e instanceof window.AtlasAuth.Expired){$('connectionSummary').textContent=e.message;throw e;}$('connectionSummary').textContent=e.message;return null;}finally{checking=null;}
 })().finally(()=>{checking=null;});return checking;
}
// Live: an information panel. Offline: one link to the live workspace; the address form only under "Use a different ATLAS address".
function paintSetup(){const off=window.AtlasAuth?.mode==='offline',home=homeUrl();$('offlineHome').hidden=!(off&&home);if(home)$('offlineOpenHome').href=home;
 let local=false;try{local=!!window.ATLAS_LOCAL?.snapshot().profiles.some(u=>u.projects.some(p=>!p.sample));}catch{}$('offlineProjects').hidden=!(off&&local);
 $('gatewayAdvanced').hidden=!off;if(off&&!home)$('gatewayAdvanced').open=true;$('voiceCheck').hidden=off;}
async function showSetup(){paintSetup();if(!$('voiceConnectionDialog').open)$('voiceConnectionDialog').showModal();try{await check();}catch{}}
function renderStart(){const mode=window.AtlasAuth?.mode,home=homeUrl(),offline=mode==='offline'&&!!home,link=$('voiceOpenHome');
 const typedLead=mode==='live'&&boot?.textMode===true&&voiceOff(boot); // no voice here: the typed interview is the primary way in, the voice button is gone and a line says why
 $('voiceStart').hidden=offline||mode==='network'||typedLead;$('voiceStartText').hidden=mode!=='live'||boot?.textMode!==true;$('voiceStartText').classList.toggle('primary',typedLead);$('voiceStartText').textContent=typedLead?'Start interview':'Type instead';
 if($('voiceReason')){$('voiceReason').hidden=!typedLead;$('voiceReason').textContent=typedLead?'Voice isn’t set up on this server, so this interview is typed. Your answers are handled the same way.':'';}
 if(boot||mode!=='live')$('voiceControls').dataset.boot='ready'; /* until the server has answered, the start row is reserved but quiet, so it never jumps */
 link.hidden=!offline;if(home)link.href=home;else link.removeAttribute('href');$('voiceNetwork').hidden=mode!=='network';
 if($('emptyVoiceNote'))$('emptyVoiceNote').hidden=!(mode==='offline'&&!home);
 const card=$('cardConnection');if(card){card.hidden=mode!=='offline';card.textContent=offline?'Open ATLAS ↗':'Set up conversational voice';}
 if(phase==='idle')$('voiceState').textContent=idleLabel();controls();}
// The consent sentence names memory only when it is configured and on; widening it clears the tick (§3.4).
function paintConsent(b){if(!b?.captureRequired)return;const P=b.privacy?.toggles,typed=wantInput==='text';
 if(P){$('modelConsentText').textContent=(typed&&P.capture.textModeText)||P.capture.text;$('checkpointConsentText').textContent=P.checkpoint.text;$('memoryConsentText').textContent=P.memory.text;$('noticeAckText').textContent=P.notice.text;$('consentSpecial').textContent=b.privacy.special||'';}
 else $('modelConsentText').textContent='I agree that this conversation is transcribed and saved as a private draft that only I can see until I click Submit for review.';
 $('memoryLine').hidden=true;}
// The consent dialog offers both ways in: Start conversation (voice) and Type instead (no microphone). Opened from the panel's Type instead, the typed start leads.
const consentGate=on=>{$('voiceConsentStart').disabled=!on;$('voiceConsentType').disabled=!on;if($('consentReason'))$('consentReason').hidden=!!on;};
function paintConsentInput(b){const can=b?.textMode===true,typed=can&&wantInput==='text';if(b?.privacy&&b.captureRequired)$('modelConsentText').textContent=(typed&&b.privacy.toggles.capture.textModeText)||b.privacy.toggles.capture.text;$('voiceConsentType').hidden=!can;$('voiceConsentType').textContent=can&&voiceOff(b)?'Start interview':'Type instead';$('voiceConsentStart').hidden=can&&voiceOff(b);$('voiceConsentDialog').dataset.input=typed?'text':'voice';
 $('voiceConsentStart').classList.toggle('primary',!typed);$('voiceConsentType').classList.toggle('primary',typed);
 if(can&&b.captureRequired){$('consentTip').textContent=(typed?'Typing: no microphone is used and no audio is sent. ATLAS answers in text.':'Your browser will then ask to use your microphone. Headphones give the clearest conversation. Prefer not to speak? Choose Type instead: no microphone is used.')+(b.admin?' Admin mode: a faster interview. Say “wrap it up” whenever you want to finish.':'');
  $('providerConsentText').textContent='ATLAS will ask about this project and listen to your answers, out loud or typed, as you choose. It takes about 20 to 30 minutes, and you can pause or stop at any time.'+(b.features?.gapInterview&&bridge.context({interview:true})?.gap?' This is a 5-minute proof request for '+(bridge.context({interview:true}).gapAlias||'a bid')+'.':'');}
 {const d=$('consentTip').closest?.('details');if(d)d.open=typed||!!b?.admin;} // the microphone help stays folded for a voice start (headphones advice); it is open for a typed start (one line) and for an admin (the faster-interview hint)
}
async function begin(input){
 wantInput=input==='text'?'text':'voice';window.AtlasOrbUI?.stopPreview();if(['preparing','connecting','live','ending'].includes(phase))return;
 const attempt=++generation,A=window.AtlasAuth,ready='One thoughtful question at a time. Your contribution, the decisions, and what really changed.';status('preparing','Checking your voice connection.','Microphone off. Checking that ATLAS is ready.');
 await A.probe();if(attempt!==generation)return;
 if(A.mode==='offline'){status('idle','Tell me about the work.',ready);showSetup();return;}
 let b=null;try{b=await check();}catch(e){if(attempt!==generation)return;if(e instanceof A.Expired){status('idle','Your sign-in expired.','Your work is kept on this page. Reconnect, then start again.');A.expired({resume:'start'});return;}}
 if(attempt!==generation)return;
 if(!b){status('idle','ATLAS isn’t answering right now.','Try again in a minute. Your projects are safe.');return;}
 if(wantInput==='voice'&&voiceOff(b)&&b.textMode===true)wantInput='text'; // voice is not offered here: this start becomes the typed interview
 if(voiceOff(b)&&!(wantInput==='text'&&b.textMode===true)){status('idle','Voice isn’t available right now.','Your projects are safe.');return;}
 if(b.busy){status('idle','The interviewer is in another session.','Try again when that interview ends. Your project is unchanged.');return;}
 if(b.resumable){status('idle','You have an interview in progress.','Resume it, or start over.');resumePrompt(b.resumable);return;} // saved for 24 hours on the server; starting a new one would delete it
 await Promise.race([bridge.restored?.(),new Promise(r=>setTimeout(r,3000))]);if(attempt!==generation)return; // a returning user's projects (§3.6)
 if(b.memory&&b.captureRequired){await bridge.loadMemory?.();if(attempt!==generation)return;}
 if(window.AtlasJourney&&await window.AtlasJourney.needsPick()){if(attempt!==generation)return;status('idle','Which project?','Choose the project first. It takes one click.');const chosen=await window.AtlasJourney.pick();if(attempt!==generation)return;if(!chosen){status('idle','Tell me about the work.',ready);return;}} // W1: a person with staffing rows or projects picks one first; Start goes on to the consent step
 status('idle','Tell me about the work.',ready);
 const c=bridge.context({interview:true});if(!c){status('idle','Editing is paused.','Recover this workspace before starting an interview.');return;}
 $('modelVoice').replaceChildren();for(const value of b.voices){const opt=document.createElement('option'),name=value.replace('.pt','');opt.value=value;opt.textContent=name+' · '+providerName();$('modelVoice').append(opt);}
 $('modelVoice').value=b.defaultVoice;document.getElementById('providerConsentText').textContent='Your microphone audio and current project context will be sent through ATLAS to '+providerName()+'. The AI will ask questions aloud. Use only material authorized for this provider.'+(['kyutai','workers'].includes(b.provider)?' Your speech is transcribed live so ATLAS can reply; without transcript capture that text is not kept after the session.':'');document.querySelector('#captureConsentRow span').textContent=b.provider!=='personaplex'?'Transcribe my microphone input during this session and use exact recognized excerpts for candidate notes and quality follow-ups. No raw audio is saved by this gateway.':'Temporarily buffer microphone-only audio in server memory, then use the configured NVIDIA transcription service for notes I will review.';$('modelConsent').checked=false;consentGate(false);
 $('captureConsent').checked=false;$('captureConsentRow').hidden=!b.transcription;$('captureUnavailable').hidden=b.transcription;
 $('voicePickRow').hidden=b.voices.length<=1;
 $('voiceConsentEyebrow').textContent='Before we listen';$('voiceConsentTitle').textContent='Your interview with ATLAS';$('memoryLine').hidden=true;
 $('memoryConsentRow').hidden=!b.memory;$('memoryConsent').checked=false; // an optional box is never pre-ticked: ticking it is the act of consent
 
 setHTML($('consentIdentity'),html`Session identity: <bdi>${P0.clean(b.identity.name)}</bdi>. Per-user memory is selected by the server, never by a local workspace selector.`);
 $('checkpointConsentRow').hidden=$('noticeAckRow').hidden=$('consentSpecial').hidden=!b.captureRequired; // the saved-interview, notice and sensitive-information rows belong to the deployment that keeps transcripts (the Python gateway has none of them)
 if(b.captureRequired){ // ONE required tick (§3.4); the saved-interview, memory and notice rows are separate optional choices (G2).
  const P=window.AtlasProfile,first=P?.firstName?.()||'',name=P?.confirmedName?.()||'',email=P?.email?.()||b.email||b.identity?.name||'';
  $('voiceConsentEyebrow').textContent='Before we start';if(first)$('voiceConsentTitle').textContent='Ready when you are, '+first;
  $('providerConsentText').textContent='ATLAS will ask about this project out loud and listen to your answers. It takes about 20 to 30 minutes, and you can pause or stop at any time.';
  $('consentTip').textContent='Your browser will then ask to use your microphone. Headphones give the clearest conversation.'+(b.admin?' Admin mode: a faster interview. Say “wrap it up” whenever you want to finish.':'');
  paintConsent(b);$('memoryConsentRow').hidden=!b.memory;$('memoryConsent').checked=!!b.memory&&storedChoice(b,'memory');$('checkpointConsent').checked=storedChoice(b,'checkpoint');$('noticeAck').checked=false; // every optional box starts UNticked (a pre-ticked box is not consent); only a choice the person already made and stored shows ticked, so starting does not silently withdraw it
  setHTML($('consentIdentity'),email?html`Signed in as ${name?html`<bdi>${name}</bdi> · `:''}<bdi>${P0.clean(email)}</bdi>`:html``); // <bdi>: a name can never reorder the text around it
  $('captureConsentRow').hidden=true;$('voiceConsentStart').textContent='Start interview';}
 if(b.features?.gapInterview&&c.gap)$('providerConsentText').textContent+=' This is a 5-minute proof request for '+(c.gapAlias||'a bid')+'.';
 paintConsentInput(b);
 if(!$('voiceConsentDialog').open)$('voiceConsentDialog').showModal();
}
async function stopDevices(){clearTimeout(readyWatch);readyWatch=null;clearInterval(timer);timer=null;if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}if(node){try{node.port.postMessage({type:'state',enabled:false,muted:true});node.port.postMessage({type:'flush'});node.disconnect();}catch{}node=null;}if(source){try{source.disconnect();}catch{}source=null;}const old=audio;audio=null;if(old)try{await old.close();}catch{}$('inputMeter').value=0;$('outputMeter').value=0;$('voiceOrb').style.setProperty('--voice-scale','1');window.AtlasOrbUI?.reset();}
function cancel(message='Voice session stopped.'){if(!['preparing','connecting','live','ending'].includes(phase))return;consumeGap();if(reconnecting&&sessionId){reconnecting=false;discardRemote();} /* thrown away while disconnected: the saved copy goes too */generation++;const s=socket;socket=null;try{if(s?.readyState===1)s.send(JSON.stringify({type:'discard'}));s?.close();}catch{}teardown=Promise.all([closed(s,3000),stopDevices()]);current=null;permissionPending=false;status('idle','Your microphone is off.',message);}
function fail(message){consumeGap();generation++;const s=socket;socket=null;try{s?.close();}catch{}teardown=Promise.all([closed(s,3000),stopDevices()]);permissionPending=false;status('error',textMode?'The interview stopped.':'The voice connection stopped.',message+(textMode?'':' No fallback voice was used.'));}
const lang=()=>(navigator.languages&&navigator.languages[0])||navigator.language||'en';
/* Language (v2.2 L1): the selector is "Auto-detect" or one language the consultant fixes; the server announces the language it is using (ready.language, `language` events). */
const langChoice=()=>{const v=$('voiceLanguageSelect')?.value;return typeof v==='string'&&v!=='auto'?v:null;};
function paintLanguages(b){const sel=$('voiceLanguageSelect'),box=$('voiceLanguage');if(!sel||!box)return;const opts=VC.languageOptions(b?.languages);box.hidden=!opts.length;if(!opts.length)return;
 const keep=sel.value;sel.replaceChildren(...opts.map(o=>{const e=document.createElement('option');e.value=o.value;e.textContent=o.label;return e;}));if(opts.some(o=>o.value===keep))sel.value=keep;}
$('voiceLanguageSelect')?.addEventListener('change',()=>{const msg=VC.languageMessage($('voiceLanguageSelect').value);if(msg&&phase==='live'&&socket?.readyState===1&&supported('language'))socket.send(JSON.stringify(msg));}); // before the conversation the choice is read at start; during it the server is told
function paintLanguage(info){const v=VC.languageView(info),st=$('voiceLanguageState'),sel=$('voiceLanguageSelect');if(!st)return;st.textContent=v.text;st.dataset.voice=String(v.voice);if(sel&&!v.hidden&&sel.value!==v.value)sel.value=v.value;
 if(v.notice&&phase==='live')$('voiceMessage').textContent=v.notice;}
// The start message. A resume names the interview and never a proof request (the server refuses both together).
const startMessage=(snapshot,voice,capture,memory,resumeId,input)=>({type:'start',csrf:boot.csrf,consent:boot.captureRequired&&activeConsent?activeConsent:true,project:snapshot.project,voice,capture,memory,language:langChoice()||lang(),...(langChoice()?{languageLock:true}:{}),...(input==='text'?{mode:'text'}:{}),...(resumeId?{resume:resumeId}:boot.features?.gapInterview&&snapshot.gap?{gap:snapshot.gap}:{})});
function start(input){return startWith(null,input==='text'?'text':'voice');}
// resumeId: continue the interview the server kept (the consultant pressed Resume). The consent dialog is not shown again: Resume is the consent, and transcription stays on as agreed.
// input: 'voice' (the microphone) or 'text' (a typed interview: no microphone, no audio, ATLAS answers in text). On a resume, input is how the saved interview was held (or what was asked for).
async function startWith(resumeId,input='voice'){outputItem=null;lastPlaybackAck=0;resetBoards();if((!resumeId&&!$('modelConsent').checked)||!boot)return;const snapshot=bridge.context({interview:true});if(!snapshot)return;
 const typing=input==='text';if(typing&&boot.textMode!==true){status('idle','Typing isn’t available here.','This server only takes voice interviews. Your projects are safe.');return;}
 gapUsed=resumeId?null:snapshot.gap||null;consentStarting=$('voiceConsentDialog').open;$('voiceConsentDialog').close();activeConsent=consentFor(boot,{resume:!!resumeId,typing});const memory=activeConsent===true?$('memoryConsent').checked:activeConsent.memory;const voice=resumeId?boot.defaultVoice:$('modelVoice').value,capture=resumeId||boot.captureRequired?true:$('captureConsent').checked;lastConsent={workspaceId:snapshot.workspaceId,projectId:snapshot.project?.id,terms:terms(boot),voice,capture,memory,checkpoint:activeConsent===true?false:activeConsent.checkpoint,notice:activeConsent===true?false:activeConsent.notice,input:typing?'text':'voice'};sessionStart={snapshot,voice,capture,memory,input:typing?'text':'voice'};const token=++generation;current=snapshot;activeSnapshot=snapshot;lastNotes=null;heardOutput=false;accumulated='';
 textMode=typing;log=[];typedSettle();typedNote('');lastHeardItem=null;heardTurns.clear();$('voicePanel').dataset.input=typing?'text':'voice';$('textLog').replaceChildren();placeTypeForm(typing);
 $('agentText').textContent='';$('voiceTimer').textContent='00:00';$('voiceAfter').hidden=true;muted=false;status('preparing',typing?'Starting your typed interview.':'Let’s connect your microphone.',typing?'No microphone is used. ATLAS is getting ready.':'The model will introduce itself and lead the interview.');permissionPending=!typing;
 try{
 if(!typing&&!await openAudio(token))return;
 socket=new WebSocket(new URL('/api/voice',location.href).href.replace(/^http/,'ws'));socket.binaryType='arraybuffer';const mine=socket;
 readyWatch=setTimeout(()=>{if(token===generation&&phase==='connecting')fail(typing?'ATLAS did not become ready within 60 seconds. Check the service and retry.':'The voice provider did not become ready within 60 seconds. Check the configured service and retry.');},60000);
 status('connecting',typing?'Preparing your interviewer.':'Preparing your voice interviewer.',typing?'No microphone is used. You will type your answers.':'Your microphone is open locally. Audio is not sent until the selected provider confirms it is ready.');
 mine.onopen=()=>{if(token!==generation){mine.close();return;}mine.send(JSON.stringify(startMessage(snapshot,voice,capture,memory,resumeId,typing?'text':'voice')));};
 mine.onmessage=e=>{if(token!==generation)return;incoming(e,token);};
 // Before 'ready', an error or a close runs ONE handler per attempt: devices off, idle, then a bootstrap check that tells an
 // expired sign-in (§3.7) from a voice failure. After 'ready', the handlers are unchanged.
 let settled=false;const early=kind=>{if(token!==generation||readyFor===token)return false;if(!settled){settled=true;preReady(token,kind);}return true;};
 mine.onerror=()=>{if(early('error'))return;if(token===generation)fail('The secure voice gateway could not be reached. Check the selected voice service.');};
 mine.onclose=()=>{if(early('close'))return;if(token!==generation)return;if(dropped(token))return;consumeGap();socket=null;stopDevices();if(['preparing','connecting','live'].includes(phase))status('error',typing?'The interview stopped.':'The microphone is off.','The '+(typing?'connection':'voice connection')+' closed before the interview finished. Nothing was approved.');else if(phase==='ending')status('idle','Your interview has ended.',typing?'The connection is closed.':'The microphone and voice stream are closed.');controls();};
 }catch(e){if(token!==generation)return;const why=micIssue(e);if(why){micUnavailable(why);return;}fail(e.message||'The browser could not start audio.');}}
// The microphone could not be opened (declined, blocked, no device, no secure page): not a failed connection. Everything this attempt opened is closed, the phase is idle, and the start area says what happened in one sentence
// with "Continue by typing" (the consent already given is kept, no second dialog) and a retry.
function micUnavailable(sentence){consumeGap();generation++;const s=socket;socket=null;try{s?.close();}catch{}teardown=Promise.all([closed(s,3000),stopDevices()]);permissionPending=false;
 status('idle','Your microphone isn’t available.',sentence);micBlocked=true;controls();
 setTimeout(()=>{if(phase!=='idle'||!micBlocked)return;const b=$('voiceMicType').hidden?$('voiceMicRetry'):$('voiceMicType');if(!b.hidden&&!document.querySelector('dialog[open]'))b.focus({preventScroll:true});},0);}
// The microphone, the audio context and the worklet (a voice interview only). false: the attempt was replaced while this was waiting (everything it opened is closed again).
async function openAudio(token){
 if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia)throw Object.assign(Error('Microphone access requires HTTPS or localhost in a full browser. You can type instead.'),{micUnavailable:true});
 const acquired=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
 if(token!==generation){acquired.getTracks().forEach(t=>t.stop());return false;}stream=acquired;permissionPending=false;micLabel=stream.getAudioTracks()[0]?.label||'default input';micPeak=0;for(const track of stream.getAudioTracks()){track.addEventListener?.('ended',()=>{if(token===generation&&['preparing','connecting','live'].includes(phase))fail('The microphone was disconnected. Reconnect it, then start a new session.');},{once:true});}
 audio=new AudioContext({latencyHint:'interactive'});await audio.resume().catch(()=>{});if(token!==generation)return false;
 if(audio.state!=='running')soundBlocked();
 const url=URL.createObjectURL(new Blob([$('atlasVoiceWorklet').textContent],{type:'text/javascript'}));try{await audio.audioWorklet.addModule(url);}finally{URL.revokeObjectURL(url);}if(token!==generation)return false;
 node=new AudioWorkletNode(audio,'atlas-duplex',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});source=audio.createMediaStreamSource(stream);
 // Straight into the worklet: its band-limited resampler is the anti-alias filter (flat to 10 kHz, aliases >= 80 dB down).
 source.connect(node);node.connect(audio.destination);
 node.port.onmessage=e=>{if(token!==generation)return;const m=e.data;if(m.type==='pcm'){if(phase!=='live'||socket?.readyState!==1)return;if(socket.bufferedAmount>24000){fail('The connection cannot keep up with real-time audio. Check the network and restart.');return;}socket.send(m.buffer);}else if(m.type==='meter'){audioStats={queuedMs:m.queuedMs,underruns:m.underruns,droppedSamples:m.droppedSamples};if(phase==='live'&&!muted)micPeak=Math.max(micPeak,m.mic||0); $('inputMeter').value=Math.min(1,m.mic*5);$('outputMeter').value=Math.min(1,m.speaker*5);window.AtlasOrbUI?.levels(m.mic,m.speaker,m.bands||null);if(boot?.playbackAck&&m.playedItem&&socket?.readyState===1&&performance.now()-lastPlaybackAck>80){lastPlaybackAck=performance.now();socket.send(JSON.stringify({type:'playback',item_id:m.playedItem,played_ms:m.playedMs}));}if(m.droppedSamples>0&&boot?.provider!=='personaplex'){fail('Playback buffer overflowed. Session stopped rather than misrepresenting what was heard.');return;}if(phase==='live')$('voiceState').textContent=m.speaker>.009?'ATLAS is speaking':paused?'Paused · microphone off':muted?'Microphone muted':providerName()+' · listening';}};
 return true;}
// The answer box sits right under the conversation in a typed interview (so the reading and the typing are in one place), and back with the other controls otherwise.
let formInLog=false;
function placeTypeForm(typing){if(typing===formInLog)return;formInLog=typing;const wrap=$('voiceTypeWrap'),box=$('textLog');if(typing)box.after(wrap);else $('voiceControls').after(wrap);}
async function preReady(token,kind){consumeGap();clearTimeout(readyWatch);const s=socket;socket=null;try{s?.close();}catch{}permissionPending=false;await stopDevices();if(token!==generation)return;
 status('idle','Checking the connection.','Microphone off. No audio is streaming.');
 try{await check();}catch(e){if(token!==generation)return;if(e instanceof window.AtlasAuth.Expired){status('idle','Your sign-in expired.','Your work is kept on this page. Reconnect, then start again.');window.AtlasAuth.expired({resume:'start'});return;}}
 if(token!==generation)return;
 if(kind==='error')fail('The secure voice gateway could not be reached. Check the selected voice service.');else{current=null;status('error','The microphone is off.','The voice connection closed before the interview finished. Nothing was approved.');}}
// What arrives on the voice socket: audio for the worklet, or one JSON event. Used by the first socket and by every reconnect.
function incoming(e,token){if(e.data instanceof ArrayBuffer){if(textMode)return; /* a typed interview plays nothing */if(e.data.byteLength%2){fail('Invalid audio frame from the gateway.');return;}heardOutput=true;node?.port.postMessage({type:'audio',buffer:e.data,item_id:outputItem},[e.data]);return;}let m;try{m=JSON.parse(e.data);}catch{fail('Invalid gateway message.');return;}receive(m,token);}
// Checkpoint and reconnect (T10). A socket that closes while the interview is live, and the server announced an interview id (so it keeps the interview for
// 24 hours), is not the end: Reconnecting… then up to three tries (after 1, 2 and 4 s) with `resume`. The microphone stays open; the server says the
// question again. A refusal (expired, gone, another project) stops the tries; three misses leave the saved interview for the next page load to offer.
function dropped(token){if(token!==generation||phase!=='live'||!sessionId||reconnecting||!sessionStart||!boot)return false;socket=null;reconnect(token);return true;}
async function reconnect(token){
 reconnecting=true;controls();
 $('voiceState').textContent='Reconnecting…';$('voiceHeading').textContent='Reconnecting…';$('voiceMessage').textContent='The connection dropped. Your interview is saved on the server; ATLAS is reconnecting.';
 if($('orbAccessibleState'))$('orbAccessibleState').textContent='Connection lost. Reconnecting.';
 node?.port.postMessage({type:'flush'});window.AtlasOrbUI?.levels(0,0,{low:0,mid:0,high:0});
 let last=null;
 for(const ms of RECONNECT_MS){
  await new Promise(r=>setTimeout(r,ms));if(token!==generation||phase!=='live'){reconnecting=false;return;}
  $('voiceMessage').textContent='The connection dropped. Your interview is saved on the server; reconnecting (try '+(RECONNECT_MS.indexOf(ms)+1)+' of '+RECONNECT_MS.length+').';
  last=await resumeOnce(token);
  if(token!==generation){reconnecting=false;return;}
  if(last.result==='ready'){reconnecting=false;controls();return;}
  if(last.result==='refused')break;
 }
 reconnecting=false;
 if(last?.result==='refused'){refused(last.message);return;}
 fail('The connection could not be restored. Your interview is saved for 24 hours: reload this page to resume it.');
}
// One try: a socket that starts with `resume` and settles as 'ready' (the server restored the interview), 'refused' (it cannot be resumed: stop) or 'closed'.
function resumeOnce(token){return new Promise(done=>{
 const {snapshot,voice,capture,memory,input}=sessionStart;let up=false,over=false;const finish=(result,message)=>{if(!over){over=true;done({result,message});}};
 let s;try{s=new WebSocket(new URL('/api/voice',location.href).href.replace(/^http/,'ws'));}catch{finish('closed');return;}
 s.binaryType='arraybuffer';socket=s;
 s.onopen=()=>{if(token!==generation||socket!==s){try{s.close();}catch{}finish('closed');return;}s.send(JSON.stringify(startMessage(snapshot,voice,capture,memory,sessionId,input)));};
 s.onmessage=e=>{if(token!==generation||socket!==s)return;
  if(!up&&typeof e.data==='string'){let m=null;try{m=JSON.parse(e.data);}catch{}
   if(m?.type==='error'){finish(m.code==='resume-unavailable'||m.code==='resume-project'?'refused':'closed',m.message);return;}
   if(m?.type==='ready'&&m.resumed){up=true;finish('ready');}}
  incoming(e,token);};
 s.onerror=()=>{};
 s.onclose=()=>{if(socket===s)socket=null;if(!up){finish('closed');return;}if(token===generation&&socket===null)dropped(token);};
});}
// The server will not resume this interview (or the page asked for something it cannot): say so, forget the offer, and leave the way open to start a new one.
function refused(message){consumeGap();generation++;const s=socket;socket=null;try{s?.close();}catch{}teardown=Promise.all([closed(s,3000),stopDevices()]);current=null;permissionPending=false;reconnecting=false;if(boot)boot.resumable=null;
 status('idle','This interview can’t be resumed.',(message||'It has expired or was already closed.')+' Start a new one when you are ready.');}
// "Keep private" (the read-back card): the server names the utterances it withheld, and a line of them still on this screen becomes the marker too: the typed-interview
// conversation, the last-words receipt, and the "You typed" line. The boards drop it from what they remember (storyboard-ui.js).
function keepPrivate(m){const items=new Set(Array.isArray(m.items)?m.items.filter(x=>typeof x==='string'):[]);if(!items.size)return;
 if(textMode)logEvent(m);
 if(lastHeardItem&&items.has(lastHeardItem)&&$('lastHeard')&&!$('lastHeard').hidden)$('lastHeard').textContent='“'+VC.PRIVATE_MARK+'”';
 if(/^You typed: /.test($('voiceMessage').textContent)&&items.has(lastHeardItem))$('voiceMessage').textContent='That answer is kept private.';}
// After a resume the server sends the consultant's turns, ATLAS's words, the story-board state and the interview clock: the screens carry on where they were.
function restoreScreens(m){
 for(const u of (Array.isArray(m.user)?m.user:[]).slice(-40))if(u&&typeof u.text==='string'){if(typeof u.item_id==='string')heardTurns.add(u.item_id);window.dispatchEvent(new CustomEvent('atlas-quality',{detail:{type:'user_text',item_id:u.item_id,text:u.text,provenance:u.provenance,restored:true}}));}
 if(m.quality&&typeof m.quality==='object')window.dispatchEvent(new CustomEvent('atlas-quality',{detail:{...m.quality,type:'quality'}}));
 if(m.summary&&typeof m.summary==='object')sessionEvent({...m.summary,type:'summary'}); // the open read-back comes back with the screens
 accumulated=(Array.isArray(m.agent)?m.agent.filter(t=>typeof t==='string').join('\n\n'):'').slice(-60000);$('agentText').textContent=accumulated;$('agentText').scrollTop=$('agentText').scrollHeight;if(textMode){log=VC.logRestore(m);paintLog();}
 if(Number.isFinite(m.activeSeconds)){startedAt=Date.now()-m.activeSeconds*1000;pausedMs=0;$('voiceTimer').textContent=VC.clock(VC.elapsed(startedAt,pausedMs,pausedAt,Date.now()));}
 if(typeof m.lastQuestion==='string'&&m.lastQuestion&&$('orbAccessibleState'))$('orbAccessibleState').textContent='Interview resumed. The question was: '+m.lastQuestion;}
// Resume your interview? (a saved interview, offered on page load and when Start is pressed). Resume continues it; Start over deletes it on the server first.
const when=ms=>{try{return new Date(ms).toLocaleString([],{dateStyle:'medium',timeStyle:'short'});}catch{return '';}};
function discardRemote(){return request('/api/checkpoint/discard',{method:'POST',headers:{'X-Atlas-CSRF':boot?.csrf||''},signal:AbortSignal.timeout(8000)}).then(r=>!!r.ok,()=>false);}
function resumePrompt(r){
 if(!resumeDlg){const d=document.createElement('dialog'),head=document.createElement('div'),box=document.createElement('div'),eyebrow=document.createElement('p'),h=document.createElement('h2'),text=document.createElement('p'),note=document.createElement('p'),row=document.createElement('div'),yes=document.createElement('button'),no=document.createElement('button');
  d.id='voiceResumeDialog';d.className='w1-dark';d.setAttribute('aria-labelledby','voiceResumeTitle');d.setAttribute('aria-describedby','voiceResumeText');head.className='dialog-head';eyebrow.className='eyebrow';eyebrow.textContent='Saved interview';h.id='voiceResumeTitle';h.textContent='Resume your interview?';
  text.id='voiceResumeText';text.className='small';note.className='small';note.id='voiceResumeNote';row.className='actions stack';yes.className='btn primary';yes.type='button';yes.textContent='Resume';no.className='btn';no.type='button';no.textContent='Start over';
  box.append(eyebrow,h);head.append(box);row.append(yes,no);d.append(head,text,note,row);document.body.append(d);
  resumeDlg={d,text,note,yes,no};
  yes.onclick=()=>{const id=resumeDlg.id,input=resumeDlg.input;resumeDlg.d.close();if(id)startWith(id,input);};
  no.onclick=async()=>{no.disabled=yes.disabled=true;const ok=await discardRemote();no.disabled=yes.disabled=false;
   if(!ok){resumeDlg.note.textContent='The saved interview could not be deleted right now. Check the connection and try again.';return;}
   if(boot)boot.resumable=null;resumeDlg.id=null;resumeDlg.d.close();if($('orbAccessibleState'))$('orbAccessibleState').textContent='The saved interview was deleted.';begin();};}
 resumeDlg.id=r.sessionId;resumeDlg.input=r.input==='text'?'text':'voice';resumeDlg.text.textContent='You stopped in the middle of '+(resumeDlg.input==='text'?'a typed interview':'an interview')+(r.savedAt?' (saved '+when(r.savedAt)+')':'')+'. Resume it and ATLAS asks the question you were on again. '+(resumeDlg.input==='text'?'Your typed answers are kept the same way, as you agreed before.':'ATLAS keeps transcribing your answers, as you agreed before.');
 resumeDlg.note.textContent='Start over deletes the saved interview now'+(r.expiresAt?'; otherwise it is deleted automatically after '+when(r.expiresAt):'')+'.';
 if(!resumeDlg.d.open)resumeDlg.d.showModal();}
// On page load (live, nothing running): a saved interview is offered before anything else.
async function offerResume(){if(window.AtlasAuth?.mode!=='live'||phase!=='idle'||resumeDlg?.d.open||$('voiceConsentDialog').open)return;let b=null;try{b=await check();}catch{return;}if(b?.resumable&&phase==='idle'&&bridge.context({interview:true}))resumePrompt(b.resumable);}
function receive(m,token){
 if(m.type==='ready'){paintLanguage(VC.languageInfo(m));readyFor=token;consumeGap();clearTimeout(readyWatch);if(!m.resumed)chime();sessionId=typeof m.sessionId==='string'?m.sessionId:null;clearTimeout(micWatch);micPeak=0;controlsOn=Array.isArray(m.controls)?m.controls:null;paused=false;pausedAt=null;pausedMs=0;
  // Permission can be granted while the OS still delivers silence; say so instead of waiting forever.
  if(!textMode)micWatch=setTimeout(()=>{if(token===generation&&phase==='live'&&!muted&&!paused&&micPeak<.0015){const t=stream?.getAudioTracks()[0];$('voiceMessage').textContent='ATLAS is not receiving sound from “'+micLabel+'”'+(t?.muted?' (the system is muting it)':'')+'. Check the input device and your system privacy settings for this browser, then speak again.';}},6000);textMode=m.input==='text'||(textMode&&m.input===undefined);openFresh=textMode&&!m.resumed;openGate=0;startedAt=Date.now();phase='live';node?.port.postMessage({type:'state',enabled:true,muted:false});status('live',m.resumed?'You’re back. Picking up where we stopped.':'I’m here. Let’s talk about the work.',m.resumed?(textMode?'Your interview was kept. ATLAS shows the question you were on again.':'Your interview was kept. ATLAS says the question you were on again.'):textMode?'Type your answers below. ATLAS will reply in text, one follow-up at a time.':providerName()+' is connected. Answer naturally; ATLAS will ask one follow-up at a time.');$('voicePrivacy').textContent=textMode?(m.capture?'Typed interview: no microphone is used and no audio is sent. Your typed words are processed for quote-grounded candidate notes; no automatic wiki publication.':'Typed interview: no microphone is used and no audio is sent. Your transcript is not captured for this session.'):boot?.provider!=='personaplex'?(m.capture?'Audio is streaming to '+providerName()+'. Consultant ASR text is processed for quote-grounded candidate notes; no automatic wiki publication.':'Audio is streaming to '+providerName()+'. Consultant transcript capture is off.'):(m.capture?'Audio is streaming to NVIDIA. Microphone-only audio is buffered in server memory for post-session transcription.':'Audio is streaming to NVIDIA. Consultant transcription is off for this session.');clearInterval(timer);timer=setInterval(()=>{$('voiceTimer').textContent=VC.clock(VC.elapsed(startedAt,pausedMs,pausedAt,Date.now()));},500);if(textMode){placeTypeForm(true);$('voiceTypeInput').focus({preventScroll:true});$('voiceTypeInput').placeholder='Type your answer here. Enter sends.';}else $('voiceTypeInput').placeholder='Type your answer';readyWatch=setTimeout(()=>{if(token===generation&&phase==='live'&&!heardOutput&&!textMode)after('The provider completed its handshake but no generated audio has arrived. Check the voice service. A handshake alone does not prove the model is speaking.');},20000);}
 else if(m.type==='agent_text'){setThinking(false);if(textMode)heardOutput=true;accumulated=(accumulated+(typeof m.text==='string'?m.text:'')).slice(-60000);$('agentText').textContent=accumulated;$('agentText').scrollTop=$('agentText').scrollHeight;logEvent(m);if(textMode)focusSoon();}
 else if(m.type==='agent_retract'){const n=Number.isInteger(m.chars)&&m.chars>0?Math.min(m.chars,accumulated.length):0;accumulated=accumulated.slice(0,accumulated.length-n);$('agentText').textContent=accumulated;logEvent(m);} // a reply taken back: the consultant had not finished
 else if(m.type==='audio_turn'){outputItem=m.item_id;}
 else if(m.type==='duck'){node?.port.postMessage({type:'duck',on:m.on===true});} // a sound over her voice is being checked: her volume dips (the worklet lets go by itself)
 else if(m.type==='clear_audio'){node?.port.postMessage({type:'flush'});window.AtlasOrbUI?.levels(0,0,{low:0,mid:0,high:0});}
 else if(['quality','user_text','quality_warning','user_speaking','user_text_private'].includes(m.type)){
  if(m.type==='user_text'){lastHeardItem=typeof m.item_id==='string'?m.item_id:null;if(lastHeardItem)heardTurns.add(lastHeardItem);logEvent(m);if(VC.typedAccepted(m))typedAccepted(m);}
  else if(m.type==='user_text_private')keepPrivate(m);
  else if(m.type==='quality_warning'){const note=VC.typedRefusal(m);if(note)typedRefused(note);}
  window.dispatchEvent(new CustomEvent('atlas-quality',{detail:m}));}
 else if(m.type==='state'){setPaused(VC.pausedFrom(paused,m));} // the interview machine: pause and resume are confirmed (or made) by the server
 else if(m.type==='restore'){restoreScreens(m);}
 else if(m.type==='error'){if(m.code==='resume-unavailable'||m.code==='resume-project')refused(m.message);else fail(m.message||'The selected voice service is unavailable.');}
 else if(m.type==='memory'){$('voiceTranscriptLabel').textContent=m.message+' · agent text is not consultant evidence';}
 else if(m.type==='consent_revoked'){if(typeof m.message==='string')$('voiceTranscriptLabel').textContent=m.message.slice(0,200);} // X2: a withdrawal or erase applied to the live interview; when it ends the interview, `ended` follows
 else if(m.type==='status'){if(m.state==='transcribing'){status('ending','Let’s check what you said.',m.message);}else if(m.state==='connecting')$('voiceMessage').textContent=m.message;}
 else if(m.type==='audio_stopped'){stopDevices();if(phase==='live'||phase==='connecting')status('ending',textMode?'Finishing up.':'Your microphone is off.',textMode?'The interview has closed. Finishing the session.':'The voice stream has closed. Finishing the session.');}
 else if(m.type==='time_up'){if(phase==='live'){$('voiceHeading').textContent='Time is up.';$('voiceMessage').textContent=m.message||'Time is up.';}}
 else if(m.type==='wrap_up'){if(phase==='live'){status('live','ATLAS is wrapping up.','Closing the interview and preparing your report.');setTimeout(()=>{if(phase==='live')end();},300);}}
  else if(m.type==='reporting'){if(phase==='ending')status('ending','Writing your report…','ATLAS is drafting a report from your conversation. This takes a few seconds.');}
  else if(m.type==='language'){paintLanguage(VC.languageInfo(m));if(phase==='live'&&!m.notice&&m.via!=='selector')$('voiceMessage').textContent=m.voice?`ATLAS is now speaking ${m.native||m.name}.`:`ATLAS is now answering in ${m.native||m.name}, as text: it has no voice for it yet.`;}
  else if(m.type==='notes'){lastNotes=m;if(m.transcript){autoSave(m);}else after(m.message||'No consultant transcript was captured.');}
 else if(m.type==='ended'){stopDevices();const s=socket;socket=null;try{s?.close();}catch{} /* the session is over: nothing is left to receive, and an open socket would read as "voice active" */status('idle','Great work. Worth capturing.',lastNotes?.savedTo?'Saved to “'+lastNotes.savedTo+'”.'+(lastNotes.savedReport?' Your report is open for review.':'')+(lastNotes.persisted||lastNotes.library?'':' Not yet stored on this device.'):lastNotes?.transcript?'Review the consultant transcript before adding it to your project.':'The microphone and model stream are closed. '+(lastNotes?.message||'No project facts were approved.'));}
 if(SESSION_EVENTS.includes(m.type))sessionEvent(m);
}
// A sheet's confirm button sits over other controls of the page (the sheet is centred over the interview): a double click must not land its second click on whatever is underneath once the sheet has closed.
function shield(ms=450){const p=$('voicePanel');if(!p?.classList)return;p.classList.add('fit-settling');setTimeout(()=>p.classList.remove('fit-settling'),ms);}
function end(){if(reconnecting){$('voiceMessage').textContent='Reconnecting… You can stop the interview as soon as the connection is back.';return;}if(phase==='ending'){cancel('Pending notes discarded. No project changes were applied.');return;}if(phase==='preparing'||phase==='connecting'){cancel('Connection cancelled. Your microphone is off.');return;}if(phase!=='live')return;stopDevices();status('ending',textMode?'Finishing up.':'Your microphone is off.',textMode?'Closing the interview and preparing any enabled consultant transcript.':'Closing the voice session and preparing any enabled consultant transcript.');if(socket?.readyState===1)socket.send(JSON.stringify({type:'end'}));else cancel('The voice stream was already closed.');}
// Stop: while the interview is live it asks first (one slip must not close it): stop and review what was said (when something was), stop and discard, or cancel; the sheet also holds the quiet "Discard and start over" (Restart). Anything earlier just cancels.
function askEnd(){if(phase!=='live'||reconnecting){end();return;}const enough=heardTurns.size>0,review=$('voiceEndConfirm');$('voiceEndText').textContent=(enough?'ATLAS stops '+(textMode?'the interview':'listening')+'. You can review what you said, with your notes and report to read back (nothing is shared until you click Submit for review), or discard this interview and nothing from it is saved.':'Nothing has been said yet, so there is nothing to review. You can stop here, or discard this interview and nothing is saved.');review.textContent=enough?'Stop and review what you said':'Stop here';if(!$('voiceEndDialog').open)$('voiceEndDialog').showModal();}
// Restart: throw this conversation away (never saved: discard, not end) and start a new one about the same project.
function askRestart(){if(restarting)return;if(phase==='error'){restart();return;}if(!['connecting','live'].includes(phase))return;const c=bridge.context({interview:true});$('voiceRestartText').textContent='ATLAS stops listening now and throws this interview away. Nothing from it is saved: no transcript, no report, no change to your project, and ATLAS will not remember it. A new interview about “'+(c?.isNew?'a new project':(c?.project?.title||'this project'))+'” starts straight away, with the same choices you agreed to: '+choices()+(lastConsent?.memory?', private memory on':'')+'.';$('voiceRestartConfirm').disabled=false;if(!$('voiceRestartDialog').open)$('voiceRestartDialog').showModal();}
async function restart(){if(restarting)return;restarting=true;if($('voiceRestartDialog').open)$('voiceRestartDialog').close();
 try{cancel('This conversation was discarded. Nothing from it was saved.');const token=++generation;
  // Nothing of the discarded conversation stays on screen, whichever way the new one starts.
  resetBoards();accumulated='';$('agentText').textContent='';$('voiceTimer').textContent='00:00';
  if($('orbAccessibleState'))$('orbAccessibleState').textContent='Interview discarded. Starting a new interview.';
  status('preparing','Starting a new conversation.','Nothing from the previous conversation was saved.');
  await teardown;if(token!==generation)return; // the server lets go of the old conversation first
  const lapsed=e=>{if(!(e instanceof window.AtlasAuth.Expired))return null;if(token===generation){status('idle','Your sign-in expired.','Your work is kept on this page. Reconnect, then start again.');window.AtlasAuth.expired({resume:'start'});}return 'expired';};
  let b=await check().catch(lapsed);if(token!==generation||b==='expired')return;
  for(let i=0;i<5&&b?.busy;i++){await new Promise(r=>setTimeout(r,1000));if(token!==generation)return;b=await check().catch(lapsed);if(token!==generation||b==='expired')return;} // the server may still be letting go of the old one
  const c=bridge.context({interview:true});
  if(reusable(b,c)){$('modelVoice').value=lastConsent.voice;$('modelConsent').checked=true;$('captureConsent').checked=lastConsent.capture;$('memoryConsent').checked=lastConsent.memory&&!!b.memory;$('checkpointConsent').checked=lastConsent.checkpoint===true;$('noticeAck').checked=lastConsent.notice===true;restarting=false;await start(lastConsent.input);}
  else{status('idle','Tell me about the work.','Please confirm how this interview may be used.');restarting=false;begin();}
 }finally{restarting=false;controls();const a=document.activeElement;if(!a?.matches?.('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]')||a.closest('dialog:not([open])')){const t=['voiceRestart','voiceEnd','voiceStart'].map($).find(x=>x&&!x.disabled&&x.offsetParent);t?.focus({preventScroll:true});}}}
function toggleMute(){if(phase!=='live'||paused||textMode)return;muted=!muted;applyMic();controls();$('voiceState').textContent=muted?'Microphone muted · ATLAS may still speak':liveLabel();}
function autoSave(m){current=null; /* the session already delivered its notes: saving may create/switch the project without cancelling */try{const gap=m.mode==='gap',r=bridge.autoSave(activeSnapshot,m.sections||[],m.transcript,m.report||null,{mode:m.mode||'full',requestId:m.gap?.requestId,results:m.gap?.results});activeSnapshot=null;m.savedTo=r.title;m.savedReport=r.report;m.persisted=r.persisted;const lib=!gap&&!!boot?.library;m.library=lib;after(gap?'Your proof answers are kept on this device only; nothing was sent. Review them, then choose to send them to the bid team or add them to your reference.'+(r.persisted?'':' Turn on “Save on this device” or export a backup before closing this tab.'):(r.report?'Saved to “'+r.title+'” with your report, notes and story draft. Your N+1 can now validate it.':'Saved to “'+r.title+'” with your notes and transcript.')+(r.persisted||lib?'':' It is kept in this browser tab only: turn on “Save on this device” or export a backup before closing.'));
 if(!gap)window.AtlasProfile?.guessPrompt?.($('voiceAfter'),r.projectId);if(r.report)setTimeout(()=>bridge.showReport(r.projectId),200);
 // "Save on this device?" only when the library is off, the sync failed or was still pending at 10 s, or after a proof
 // interview (gap answers stay local, WOW §0 rule 6). A full interview the library accepted needs nothing more (§3.8).
 const t0=Date.now();Promise.race([lib?Promise.resolve(r.synced).catch(()=>null):Promise.resolve(null),new Promise(res=>setTimeout(()=>res(null),10000))]).then(res=>{
  if(lib&&!res){const note=document.createTextNode(' Not saved to ATLAS yet: it is kept in this tab. Turn on “Save on this device” or export a backup before closing.');$('voiceAfter').insertBefore(note,$('voiceAfter').querySelector('.guess-prompt'));}
  if(!r.persisted&&(gap||!lib||!res))setTimeout(()=>{if(!['preparing','connecting','live','ending'].includes(phase))bridge.enableSave?.();},Math.max(0,900-(Date.now()-t0)));});}
 catch(e){showNotes(m);$('voiceApplyStatus').textContent='Not saved automatically: '+e.message;}}
function showNotes(result){$('voiceNotesStatus').textContent=result.report?'Here is the report ATLAS drafted from your interview, with your own words below. Check both, then save them to the project.':result.message||'The selected speech service transcribed the microphone. Review all text before use.';$('voiceReport').hidden=!result.report;bridge.renderReport?.($('voiceReport'),result.report||null);$('voiceNotesTitle').textContent=result.report?'Your interview report.':'Check what we captured.';$('voiceApplyNotes').textContent=result.report?'Save report and checked notes to this project →':'Apply checked notes to this project →';$('consultantTranscript').textContent=result.transcript;const wrap=$('voiceNoteFields');wrap.replaceChildren();labels.forEach((label,i)=>{const section=document.createElement('div'),check=document.createElement('input'),l=document.createElement('label'),area=document.createElement('textarea');check.type='checkbox';check.id='acceptVoiceNote'+i;check.checked=!!result.sections?.[i];l.className='check';l.htmlFor=check.id;const t=document.createElement('span');t.textContent=label;l.append(check,t);area.id='voiceNote'+i;area.maxLength=6000;area.value=result.sections?.[i]||'';area.placeholder='Copy the relevant part of your transcript, or leave this topic open.';area.setAttribute('aria-label',label+' candidate notes');section.append(l,area);wrap.append(section);});$('voiceNotesConfirm').checked=false;$('voiceApplyNotes').disabled=true;$('voiceApplyStatus').textContent='';if(!$('voiceNotesDialog').open)$('voiceNotesDialog').showModal();}
$('voiceStart').onclick=()=>begin(voiceOff(boot)&&boot?.textMode===true?'text':'voice'); // (the orb's own click calls this button, also when it is hidden)
$('voiceMicType').onclick=()=>{micBlocked=false;start('text');};$('voiceMicRetry').onclick=()=>{micBlocked=false;start('voice');};$('voiceStartText').onclick=()=>begin('text');$('voiceSetup').onclick=showSetup;$('voiceCheck').onclick=()=>check().catch(()=>{});$('voiceRetry').onclick=()=>window.AtlasAuth.probe({fresh:true});
// (the old "Turn on memory" button is gone: memory is its own tick in the consent dialog, off until ticked)
$('modelConsent').onchange=e=>consentGate(e.target.checked);$('voiceConsentStart').onclick=()=>start('voice');$('voiceConsentType').onclick=()=>start('text');$('voiceMute').onclick=toggleMute;$('voicePause').onclick=togglePause;$('voiceRepeat').onclick=()=>{if(phase==='live'&&!paused&&supported('repeat'))send(VC.message('repeat'));};$('voiceTypeForm').onsubmit=e=>{e.preventDefault();sendTyped();};const grow=()=>{const i=$('voiceTypeInput');i.style.height='auto';i.style.height=Math.min(i.scrollHeight+2,168)+'px';};
try{if(typeof ResizeObserver==='function'&&$('textLog'))new ResizeObserver(()=>{if(textMode&&log.length)alignLog($('textLog'));}).observe($('textLog'),{box:'border-box'});}catch{} // the box changes size while the screen settles (the orb steps back): the newest line stays whole
$('voiceTypeInput').oninput=()=>{if(!typedPending)typedNote('');grow();paintControls();};
// Enter sends, Shift+Enter adds a line (a typed answer can be a paragraph). Not while an input method is composing.
$('voiceTypeInput').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&!e.ctrlKey&&!e.metaKey){e.preventDefault();sendTyped();}};$('voiceEnd').onclick=askEnd;$('voiceRestartQuiet').onclick=askRestart;$('voiceEndConfirm').onclick=()=>{shield();$('voiceEndDialog').close();end();};$('voiceEndDiscard').onclick=()=>{shield();$('voiceEndDialog').close();cancel('Interview stopped and discarded. Nothing from it was saved.');};$('voiceRestart').onclick=()=>{if($('voiceEndDialog').open)$('voiceEndDialog').close();askRestart();};$('voiceRestartConfirm').onclick=()=>{shield();$('voiceRestartConfirm').disabled=true;restart();};$('voiceRestartDialog').addEventListener('close',()=>{$('voiceRestartConfirm').disabled=false;if(!$('voiceEnd').hidden&&!$('voiceEnd').disabled)$('voiceEnd').focus({preventScroll:true});});
$('voiceTextToggle').onclick=()=>{cancel('Voice stopped before editing notes.');document.body.classList.toggle('voice-first');const first=document.body.classList.contains('voice-first');$('voiceTextToggle').textContent=first?'Review or type project notes':'Hide note editor';if(!first)document.querySelector('.interview-layout')?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});};
$('voiceNotesConfirm').onchange=e=>$('voiceApplyNotes').disabled=!e.target.checked;
$('voiceConsentDialog').addEventListener('close',()=>{const started=consentStarting;consentStarting=false;if(!started){try{if(bridge.context({interview:true})?.gap)bridge.gapConsumed?.();}catch{}}});
$('voiceApplyNotes').onclick=()=>{if(!$('voiceNotesConfirm').checked||!lastNotes?.transcript)return;const sections=labels.map((_,i)=>$('acceptVoiceNote'+i).checked?$('voiceNote'+i).value.trim():null);try{bridge.apply(activeSnapshot,sections,lastNotes.transcript,lastNotes.report||null);$('voiceApplyStatus').textContent=lastNotes.report?'Report saved. Open Projects to send it to your N+1 for validation.':'Selected notes appended as self-reported text. Evidence and sharing still need review.';$('voiceApplyNotes').disabled=true;$('voiceNotesConfirm').checked=false;activeSnapshot=null;after(lastNotes.report?'Your report was saved to this project. Open Projects to view it and ask your N+1 to validate it.':'Your checked notes were added to this project. Open Projects to review them, then prepare the story.');}catch(e){$('voiceApplyStatus').textContent=e.message;}};
$('voiceDownloadTranscript').onclick=()=>{if(!lastNotes?.transcript)return;const r=lastNotes.report,report=r?'\n\nATLAS DRAFT REPORT (model-written from your words; not verified)\n'+r.headline+'\n'+r.summary+'\n'+Object.entries(r.topics||{}).filter(([,v])=>v).map(([k,v])=>k+': '+v).join('\n')+(r.gaps?.length?'\nOpen points: '+r.gaps.join('; '):''):'';const content='ATLAS — SELF-REPORTED CONSULTANT TRANSCRIPT\nUnverified speech recognition. Not independent project evidence.\n\n'+lastNotes.transcript+report;const u=URL.createObjectURL(new Blob([content],{type:'text/plain'}));const a=document.createElement('a');a.href=u;a.download='ATLAS_Consultant_Transcript_Unverified.txt';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);};
$('remotePreferenceSave').onclick=async()=>{if(!boot?.memory)return;const value=$('remotePreference').value.trim();if(!value)return;$('remotePreferenceSave').disabled=true;try{const r=await request('/api/preference',{method:'POST',headers:{'Content-Type':'application/json','X-Atlas-CSRF':boot.csrf},body:JSON.stringify({preference:value}),signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error(await r.text());$('connectionActionMessage').textContent='Hindsight confirmed the preference for this signed-in identity.';$('remotePreference').value='';}catch{$('connectionActionMessage').textContent='Hindsight did not confirm the write. No saved state is assumed.';}finally{$('remotePreferenceSave').disabled=false;}};
$('voiceSignout').onclick=async()=>{cancel('Signing out.');if(boot?.provider==='workers'){location.href='/cdn-cgi/access/logout';return;}try{const r=await request('/api/logout',{method:'POST',headers:{'X-Atlas-CSRF':boot.csrf}});if(!r.ok)throw Error();location.reload();}catch{$('connectionActionMessage').textContent='Sign-out was not confirmed. Close this tab and sign out through your identity provider.';}};
document.addEventListener('click',e=>{if(e.target.closest('[data-voice-close]'))e.target.closest('dialog')?.close();});
window.addEventListener('atlas-context',sync);// Audible confirmation and output selection. The chime goes straight to the speakers (not through the
// worklet), so it proves the output path without ever animating the orb or pretending to be ATLAS speaking.
function chime(){try{if(!audio||audio.state!=='running'||!audio.createOscillator)return;const t=audio.currentTime+.03;[[659.25,0],[880,.15]].forEach(([f,d])=>{const o=audio.createOscillator(),g=audio.createGain();o.type='sine';o.frequency.value=f;g.gain.setValueAtTime(0,t+d);g.gain.linearRampToValueAtTime(.06,t+d+.02);g.gain.exponentialRampToValueAtTime(.0001,t+d+.3);o.connect(g);g.connect(audio.destination);o.start(t+d);o.stop(t+d+.32);});}catch{}}
function soundBlocked(){if(!$('soundHelp'))return;$('soundHelp').hidden=false;$('soundHelpPanel').hidden=false;$('soundHelpNote').textContent='Your browser paused sound for this page. Press “Play test sound” to turn it on.';listOutputs();}
async function listOutputs(){const sel=$('soundOutput');if(!sel)return;sel.replaceChildren();let devs=[];try{devs=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audiooutput');}catch{}
 for(const d of devs){const o=document.createElement('option');o.value=d.deviceId;o.textContent=d.label||(d.deviceId==='default'?'System default':'Speaker');sel.append(o);}
 const canSwitch=!!audio?.setSinkId&&devs.length>0;sel.disabled=!canSwitch;$('soundOutputRow').hidden=!canSwitch;
 if(!/paused sound/.test($('soundHelpNote').textContent))$('soundHelpNote').textContent=canSwitch?'Choose where ATLAS plays. You will hear a short chime on the selected output.':'Choose the output in your system sound settings (Mac: System Settings → Sound → Output · Windows: Settings → System → Sound → Output), and check that this tab is not muted.';}
if($('soundHelpToggle')){$('soundHelpToggle').onclick=()=>{const p=$('soundHelpPanel');p.hidden=!p.hidden;$('soundHelpToggle').setAttribute('aria-expanded',String(!p.hidden));if(!p.hidden)listOutputs();};
 $('soundOutput').onchange=async e=>{try{await audio?.setSinkId(e.target.value==='default'?'':e.target.value);chime();$('soundHelpNote').textContent='Switched. Did you hear the chime?';}catch{$('soundHelpNote').textContent='That output could not be selected. Try another, or change it in your system sound settings.';}};
 $('soundTest').onclick=async()=>{try{if(audio&&audio.state!=='running')await audio.resume();}catch{}chime();$('soundHelpNote').textContent=audio?.state==='running'?'Played a chime. If you heard nothing, choose another output or check the system volume.':'Sound is still blocked by the browser. Click anywhere on the page, then try again.';};}
// Live pill: while a conversation runs and you are on another screen, you always see it and can mute, end or go back.
function livePill(){let pill=$('voiceLivePill');if(!pill){pill=document.createElement('div');pill.id='voiceLivePill';pill.className='voice-live-pill';pill.hidden=true;pill.setAttribute('role','status');
 setHTML(pill,html`<span class="voice-live-dot" aria-hidden="true"></span><span data-pill="label">ATLAS is listening</span><button type="button" data-pill="mute">Mute</button><button type="button" data-pill="end" aria-label="Stop the interview">Stop</button><button type="button" data-pill="back">Back to conversation</button>`);
 document.body.append(pill);pill.querySelector('[data-pill=mute]').onclick=toggleMute;pill.querySelector('[data-pill=end]').onclick=askEnd;
 pill.querySelector('[data-pill=back]').onclick=()=>document.querySelector('header [data-view=interview]')?.click();}
 const away=!document.body.classList.contains('studio-view');pill.hidden=!(['connecting','live'].includes(phase)&&away);
 pill.querySelector('[data-pill=label]').textContent=phase==='connecting'?'ATLAS is connecting':textMode?'Typed interview':muted?'Microphone muted':'ATLAS is listening';pill.querySelector('[data-pill=mute]').hidden=textMode;pill.querySelector('[data-pill=mute]').textContent=muted?'Unmute':'Mute';}
// Closing or reloading the page mid-interview keeps it (the socket just closes: the server suspends the interview and the next load offers to resume it);
// only an interview the server does not keep is thrown away, as before.
window.addEventListener('pagehide',()=>{if(phase==='live'&&sessionId){generation++;const s=socket;socket=null;reconnecting=false;try{s?.close();}catch{}teardown=Promise.all([closed(s,3000),stopDevices()]);current=null;status('idle','Your microphone is off.','Your interview was kept. Reload to resume it.');return;}cancel('Page closed.');});
window.addEventListener('pageshow',e=>{if(e.persisted)offerResume();});
// "Voice active" (§3.7) is the microphone held or a socket open or connecting, never the phase label.
const active=()=>!!stream||!!(socket&&socket.readyState<=1);
window.AtlasVoice={cancel,checkConnection:check,bootstrap:()=>boot,begin,active,reconnect:{delays:RECONNECT_MS,state:()=>({sessionId,reconnecting}),prompt:resumePrompt,offer:offerResume,dialog:()=>resumeDlg},status:()=>({phase,textMode,hasMicrophone:!!stream,tracks:stream?.getTracks().map(t=>({state:t.readyState,enabled:t.enabled}))||[],hasAudioContext:!!audio,modelAudioReceived:heardOutput,permissionPending}),audioStats:()=>audioStats};
document.body.classList.add('voice-first');sync();
// One probe per load (shared with ATLAS_APP.bootInfo). Live and '#start' (a /go/start link): the consent step opens at once;
// the microphone still waits for the Start click. A re-sign-in honours a Start that the expiry interrupted.
window.addEventListener('atlas-auth',renderStart);renderStart();
window.AtlasAuth.probe().then(()=>{renderStart();if(window.AtlasAuth.mode==='live'&&location.hash==='#start'){try{history.replaceState(null,'',location.pathname+location.search);}catch{}begin();}else offerResume();});
window.AtlasAuth.onSignedIn(async({resume}={})=>{try{await check();}catch{}if(resume==='start')begin();});
})();
