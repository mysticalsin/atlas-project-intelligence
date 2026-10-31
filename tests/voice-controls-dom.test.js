'use strict';
// voice-client.js run for real against a fake DOM, a fake socket and a fake microphone (no browser needed): a server that announces
// controls gets a working Pause/Resume, Repeat, Skip and typed answer; one that does not announce them sees none of it.
// Not a render test: layout, focus rings and the orb itself are still only covered by the (Chromium) browser suites.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.join(__dirname,'..');
const read=f=>fs.readFileSync(path.join(ROOT,'src',f),'utf8');

class El{
 constructor(id){this.id=id;this.hidden=false;this.disabled=false;this.value='';this.checked=false;this.open=false;this.dataset={};this.style={setProperty(){},removeProperty(){}};this.children=[];this.attrs={};this._text='';this.options=[];
  const set=new Set();this.classList={add:c=>set.add(c),remove:c=>set.delete(c),toggle:(c,on)=>{if(on===undefined?!set.has(c):on)set.add(c);else set.delete(c);},contains:c=>set.has(c)};}
 set textContent(v){this._text=String(v);this.children=[];}get textContent(){return this._text;}
 set innerHTML(v){this._html=v;}get innerHTML(){return this._html||'';}
 setAttribute(k,v){this.attrs[k]=String(v);}getAttribute(k){return this.attrs[k]??null;}removeAttribute(k){delete this.attrs[k];}
 addEventListener(t,f){(this.listeners||(this.listeners={}))[t]=f;}append(...k){this.children.push(...k);}appendChild(k){this.children.push(k);return k;}replaceChildren(...k){this.children=k;}
 insertBefore(k){this.children.push(k);}querySelector(){return new El('q');}querySelectorAll(){return [];}closest(){return null;}matches(){return false;}
 focus(){}close(){this.open=false;}showModal(){this.open=true;}click(){if(this.disabled||this.hidden)return;return this.onclick?.({target:this});}
 get offsetParent(){return this.hidden?null:{};}
}
function boot({announce=true,provider='workers'}={}){
 const els={},listeners={};const $=id=>els[id]||(els[id]=new El(id));
 const doc={getElementById:$,createElement:t=>new El(t),querySelector:()=>new El('q'),addEventListener(){},body:new El('body'),readyState:'complete'};
 const sent=[],posted=[],sockets=[],tracks=[],newTrack=()=>{const t={enabled:true,readyState:'live',stop(){this.readyState='ended';},addEventListener(){},label:'fake mic',muted:false};tracks.splice(0,tracks.length,t);return t;};
 class Socket{constructor(){this.readyState=0;this.bufferedAmount=0;sockets.push(this);setTimeout(()=>{this.readyState=1;this.onopen?.();},0);}send(d){sent.push(typeof d==='string'?JSON.parse(d):d.byteLength);}close(){this.readyState=3;}}
 class Worklet{constructor(){this.port={onmessage:null,postMessage:m=>posted.push(m)};}connect(){}disconnect(){}}
 class Ctx{constructor(){this.state='running';this.audioWorklet={addModule:async()=>{}};this.destination={};this.sampleRate=24000;}async resume(){}async close(){}createMediaStreamSource(){return{connect(){},disconnect(){}};}}
 const bootJson={protocol:'atlas-personaplex-pcm-v1',csrf:'c',identity:{name:'T',mode:'local'},model:'M',voices:['v'],defaultVoice:'v',busy:false,codecAvailable:true,maxSeconds:900,memory:false,transcription:true,structuredNotes:false,provider,playbackAck:true};
 const win={document:doc,navigator:{mediaDevices:{getUserMedia:async()=>{const t=[newTrack()];return{getTracks:()=>t,getAudioTracks:()=>t};},enumerateDevices:async()=>[]},languages:['en']},location:{protocol:'https:',href:'https://x/',hash:'',pathname:'/',search:''},
  isSecureContext:true,AudioContext:Ctx,AudioWorkletNode:Worklet,WebSocket:Socket,URL,Blob,performance,CustomEvent:class{constructor(t,o){this.type=t;this.detail=o?.detail;}},
  setTimeout:(f,ms)=>setTimeout(f,ms).unref(),clearTimeout,setInterval:(f,ms)=>setInterval(f,ms).unref(),clearInterval,queueMicrotask,AbortSignal,matchMedia:()=>({matches:false}),history:{replaceState(){}},Date,Promise,JSON,Math,Array,Object,String,Number,Error,Set,Map,
  dispatchEvent(e){for(const f of listeners[e.type]||[])f(e);},addEventListener:(t,f)=>(listeners[t]||=[]).push(f),AtlasVoiceControls:require('../src/voice-controls.js'),
  AtlasAuth:{mode:'live',probe:async()=>{},onSignedIn(){},expired(){},Expired:class extends Error{},fetch:async()=>({ok:true,json:async()=>bootJson})},
  ATLAS_VOICE_BRIDGE:{context:()=>({workspaceId:'w',project:{id:'p',title:'P',stage:'Pilot',answers:[]},display:{}}),restored:async()=>{},gapConsumed(){},autoSave:()=>({})},
  URL_createObjectURL:0};
 win.window=win;win.globalThis=win;win.URL=Object.assign(function(...a){return new URL(...a);},{createObjectURL:()=>'blob:x',revokeObjectURL(){}});win.URL.prototype=URL.prototype;
 $('atlasVoiceWorklet').textContent='// worklet';
 const ctx=vm.createContext(win);vm.runInContext(read('voice-client.js'),ctx,{filename:'voice-client.js'});
 const server=m=>sockets.at(-1).onmessage({data:JSON.stringify(m)});
 return {$,els,sent,posted,sockets,tracks,server,win,bootJson,announce,
  async live(){
   await $('voiceStart').onclick();await new Promise(r=>setTimeout(r,5));
   $('modelConsent').checked=true;await $('voiceConsentStart').onclick();await new Promise(r=>setTimeout(r,30));
   server({type:'ready',model:'ATLAS',capture:true,...(announce?{controls:announce===true?['pause','resume','repeat','skip','text','correct','withhold','confirm_summary']:announce}:{})});
  }};
}
const flush=()=>new Promise(r=>setTimeout(r,5));

test('the real client loads against the fake DOM and the controls start hidden',()=>{
 const h=boot();
 for(const id of ['voicePause','voiceRepeat','voiceSkip','voiceTypeForm'])assert.equal(h.$(id).hidden,true,id);
});

test('a server that announces controls: Pause, Repeat, Skip and the typed answer appear and send exactly their messages',async()=>{
 const h=boot();await h.live();
 assert.equal(h.win.AtlasVoice.status().phase,'live');
 for(const id of ['voicePause','voiceRepeat','voiceSkip','voiceTypeForm'])assert.equal(h.$(id).hidden,false,id+' shown');
 for(const id of ['voicePause','voiceRepeat','voiceSkip','voiceMute'])assert.equal(h.$(id).disabled,false,id+' enabled');
 assert.equal(h.$('voiceTypeInput').disabled,false);assert.equal(h.$('voiceTypeSend').disabled,true,'Send waits for text');
 h.$('voiceRepeat').click();h.$('voiceSkip').click();
 h.$('voiceTypeInput').value='  We rebuilt the intake process.  ';h.$('voiceTypeInput').oninput();assert.equal(h.$('voiceTypeSend').disabled,false);
 h.$('voiceTypeForm').onsubmit({preventDefault(){}});
 const msgs=h.sent.filter(m=>typeof m==='object').filter(m=>m.type!=='start'&&m.type!=='playback');
 assert.deepEqual(msgs,[{type:'repeat'},{type:'skip'},{type:'text',text:'We rebuilt the intake process.'}]);
 // X1 (S1 follow-up): the text stays in the box until the server takes the turn (its user_text echo); Send waits meanwhile, so nothing is sent twice
 assert.equal(h.$('voiceTypeInput').value,'  We rebuilt the intake process.  ','kept until the server takes it');assert.equal(h.$('voiceTypeSend').disabled,true,'Send waits for the server');
 h.server({type:'user_text',item_id:'user-typed-1',text:'We rebuilt the intake process.',provenance:'consultant_typed'});
 assert.equal(h.$('voiceTypeInput').value,'','cleared once the server echoed the turn');assert.equal(h.$('voiceTypeSend').disabled,true);
 assert.match(h.$('voiceMessage').textContent,/You typed: “We rebuilt the intake process\.”/);
});

test('Pause: a real toggle that closes the microphone, stops the visible clock and says so; Resume undoes it; mute stays separate',async()=>{
 const h=boot();await h.live();
 h.$('voicePause').click();
 assert.deepEqual(h.sent.filter(m=>m.type==='pause'),[{type:'pause'}]);
 assert.equal(h.win.AtlasVoice.status().tracks[0].enabled,false,'the microphone track is closed');
 assert.equal(h.$('voicePause').textContent,'Resume');assert.equal(h.$('voicePause').getAttribute('aria-label'),'Resume the interview');assert.equal(h.$('voicePause').dataset.paused,'true');
 assert.equal(h.$('voiceRepeat').disabled,true);assert.equal(h.$('voiceSkip').disabled,true);assert.equal(h.$('voiceMute').disabled,true,'mute is not pause');
 assert.equal(h.$('voiceState').textContent,'Paused · microphone off');
 assert.deepEqual(JSON.parse(JSON.stringify(h.posted.filter(m=>m.type==='state').at(-1))),{type:'state',enabled:true,muted:true},'the audio worklet is told');
 assert.ok(h.posted.some(m=>m.type==='flush'),'anything of hers still queued is dropped: the orb cannot keep "speaking"');
 // typing while paused is allowed and carries the interview on
 h.$('voiceTypeInput').value='Carrying on';h.$('voiceTypeInput').oninput();h.$('voiceTypeForm').onsubmit({preventDefault(){}});
 assert.equal(h.sent.at(-1).type,'text');assert.equal(h.$('voicePause').textContent,'Resume','not before the server takes the turn');
 h.server({type:'state',state:'discovery',from:'paused',event:'resume',actor:'user',paused:false});h.server({type:'user_text',item_id:'user-typed-1',text:'Carrying on',provenance:'consultant_typed'});
 assert.equal(h.$('voicePause').textContent,'Pause');assert.equal(h.win.AtlasVoice.status().tracks[0].enabled,true);
 // pause again, then Resume
 h.$('voicePause').click();h.$('voicePause').click();
 assert.deepEqual(h.sent.filter(m=>m.type==='pause'||m.type==='resume').map(m=>m.type),['pause','pause','resume']);
 assert.equal(h.$('voicePause').textContent,'Pause');assert.equal(h.win.AtlasVoice.status().tracks[0].enabled,true);
 // mute is its own control
 h.$('voiceMute').click();assert.equal(h.win.AtlasVoice.status().tracks[0].enabled,false);assert.equal(h.$('voiceMute').textContent,'Unmute microphone');assert.equal(h.$('voicePause').textContent,'Pause');
});

test('the server\'s state events drive the toggle (a typed answer or a spoken pause changes it without a click)',async()=>{
 const h=boot();await h.live();
 h.server({type:'state',state:'paused',from:'discovery',event:'pause',actor:'user',paused:true});
 assert.equal(h.$('voicePause').textContent,'Resume');assert.equal(h.win.AtlasVoice.status().tracks[0].enabled,false);
 h.server({type:'state',state:'discovery',from:'paused',event:'resume',actor:'user',paused:false});
 assert.equal(h.$('voicePause').textContent,'Pause');assert.equal(h.win.AtlasVoice.status().tracks[0].enabled,true);
 h.server({type:'state',state:'discovery',from:'discovery',event:'focus',actor:'atlas',paused:false});
 assert.equal(h.$('voicePause').textContent,'Pause','other transitions change nothing');
});

test('while paused the Repeat and Skip buttons send nothing even if clicked',async()=>{
 const h=boot();await h.live();h.$('voicePause').click();const n=h.sent.length;
 h.$('voiceRepeat').onclick();h.$('voiceSkip').onclick();
 assert.equal(h.sent.length,n);
});

test('a server that did not announce controls (the other voice routes) is never sent one and keeps its mute-only controls',async()=>{
 const h=boot({announce:false,provider:'personaplex'});await h.live();
 for(const id of ['voicePause','voiceRepeat','voiceSkip','voiceTypeForm'])assert.equal(h.$(id).hidden,true,id);
 h.$('voicePause').onclick();h.$('voiceRepeat').onclick();h.$('voiceSkip').onclick();h.$('voiceTypeInput').value='hi';h.$('voiceTypeForm').onsubmit({preventDefault(){}});
 assert.deepEqual(h.sent.filter(m=>typeof m==='object'&&['pause','resume','repeat','skip','text'].includes(m.type)),[]);
 h.$('voiceMute').click();assert.equal(h.win.AtlasVoice.status().tracks[0].enabled,false,'mute works as before');
});

test('the paused state does not leak into the next conversation',async()=>{
 const h=boot();await h.live();h.$('voicePause').click();
 h.win.AtlasVoice.cancel('stop');await flush();
 assert.equal(h.$('voicePause').hidden,true);assert.equal(h.$('voicePause').textContent,'Pause');
 await h.live();assert.equal(h.$('voicePause').textContent,'Pause');assert.equal(h.win.AtlasVoice.status().tracks[0].enabled,true);
});

test('T11: the read-back card\'s buttons reach the socket as exactly the messages the session accepts, only while live and only when the server announced them',async()=>{
 const act=(h,detail)=>h.win.dispatchEvent(new h.win.CustomEvent('atlas-summary-action',{detail}));
 const out=h=>h.sent.filter(m=>typeof m==='object').filter(m=>m.type!=='start'&&m.type!=='playback');
 const h=boot();await h.live();
 act(h,{kind:'withhold',detail_id:'D-002'});act(h,{kind:'correct',detail_id:'D-001',text:'  It was 35 percent.  '});act(h,{kind:'confirm_summary'});
 assert.deepEqual(out(h),[{type:'withhold',detail_id:'D-002'},{type:'correct',detail_id:'D-001',text:'It was 35 percent.'},{type:'confirm_summary'}]);
 for(const bad of [{kind:'correct',detail_id:'D-001',text:'no'},{kind:'withhold',detail_id:'../x'},{kind:'skip'},{kind:'end'},{},null,{kind:'correct',text:'no id here'}])act(h,bad);
 assert.equal(out(h).length,3,'nothing else is sent');
 // an older gateway that announced only the T9 controls is never sent a card message
 const old=boot({announce:['pause','resume','repeat','skip','text']});await old.live();
 act(old,{kind:'confirm_summary'});act(old,{kind:'withhold',detail_id:'D-001'});assert.equal(out(old).length,0);
 // before the interview is live nothing is sent either
 const idle=boot();act(idle,{kind:'confirm_summary'});assert.equal(out(idle).length,0);
 // the server's summary events reach the page bus the card listens on, and a resume brings the open card back with the screens
 const seen=[];h.win.addEventListener('atlas-session',e=>seen.push(e.detail.type));
 for(const m of [{type:'summary',items:[],unknowns:[]},{type:'summary_closed'},{type:'summary_confirmed'},{type:'evidence_draft',id:'e1',revision:1},{type:'evidence_draft_unavailable',reason:'workflow_off'}])h.server(m);
 assert.deepEqual(seen,['summary','summary_closed','summary_confirmed','evidence_draft','evidence_draft_unavailable']);
 seen.length=0;h.server({type:'restore',user:[],agent:[],quality:null,summary:{items:[],unknowns:[],state:'summary'},lastQuestion:'',activeSeconds:5});assert.deepEqual(seen,['summary']);
});
