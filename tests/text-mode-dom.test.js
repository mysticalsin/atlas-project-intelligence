'use strict';
// X1: the typed interview in voice-client.js, run for real against a fake DOM, a fake socket and a fake microphone (no browser needed): no microphone is asked for,
// the conversation log, the typed text kept until the server takes it, a kept-private line replaced on screen, a resumed typed interview.
// Not a render test: layout, focus rings and the orb itself are covered by tests/humane_browser.py (real Chromium).
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.join(__dirname,'..');
const read=f=>fs.readFileSync(path.join(ROOT,'src',f),'utf8');

class El{
 constructor(id){this.id=id;this.hidden=false;this.disabled=false;this.value='';this.checked=false;this.open=false;this.dataset={};this.style={setProperty(){},removeProperty(){}};this.children=[];this.attrs={};this._text='';this.options=[];this.className='';this.parent=null;
  const set=new Set();this.classList={add:c=>set.add(c),remove:c=>set.delete(c),toggle:(c,on)=>{if(on===undefined?!set.has(c):on)set.add(c);else set.delete(c);},contains:c=>set.has(c)};}
 set textContent(v){this._text=String(v);this.children=[];}get textContent(){return this._text;}
 set innerHTML(v){this._html=v;}get innerHTML(){return this._html||'';}
 setAttribute(k,v){this.attrs[k]=String(v);}getAttribute(k){return this.attrs[k]??null;}removeAttribute(k){delete this.attrs[k];}
 addEventListener(t,f){(this.listeners||(this.listeners={}))[t]=f;}append(...k){this.children.push(...k);}appendChild(k){this.children.push(k);return k;}replaceChildren(...k){this.children=k;}
 insertBefore(k){this.children.push(k);}querySelector(){return new El('q');}querySelectorAll(){return [];}closest(){return null;}matches(){return false;}
 get firstChild(){return this.children[0]||null;}get lastChild(){return this.children[this.children.length-1]||null;}remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);}after(n){n.parent=this.parent;} focus(){global.__focus=this.id;}close(){this.open=false;}showModal(){this.open=true;}click(){if(this.disabled||this.hidden)return;return this.onclick?.({target:this});}
 get offsetParent(){return this.hidden?null:{};}
}
function boot({announce=true,provider='workers',text=true}={}){
 let mic=0;
 const els={},listeners={};const $=id=>els[id]||(els[id]=new El(id));
 const doc={getElementById:$,createElement:t=>new El(t),querySelector:()=>new El('q'),addEventListener(){},body:new El('body'),readyState:'complete'};
 const sent=[],posted=[],sockets=[],tracks=[],newTrack=()=>{const t={enabled:true,readyState:'live',stop(){this.readyState='ended';},addEventListener(){},label:'fake mic',muted:false};tracks.splice(0,tracks.length,t);return t;};
 class Socket{constructor(){this.readyState=0;this.bufferedAmount=0;sockets.push(this);setTimeout(()=>{this.readyState=1;this.onopen?.();},0);}send(d){sent.push(typeof d==='string'?JSON.parse(d):d.byteLength);}close(){this.readyState=3;}}
 class Worklet{constructor(){this.port={onmessage:null,postMessage:m=>posted.push(m)};}connect(){}disconnect(){}}
 class Ctx{constructor(){this.state='running';this.audioWorklet={addModule:async()=>{}};this.destination={};this.sampleRate=24000;}async resume(){}async close(){}createMediaStreamSource(){return{connect(){},disconnect(){}};}}
 const bootJson={protocol:'atlas-personaplex-pcm-v1',csrf:'c',identity:{name:'T',mode:'local'},model:'M',voices:['v'],defaultVoice:'v',busy:false,codecAvailable:true,maxSeconds:900,memory:false,transcription:true,structuredNotes:false,provider,playbackAck:true,...(text?{textMode:true}:{})};
 const win={document:doc,navigator:{mediaDevices:{getUserMedia:async()=>{mic++;const t=[newTrack()];return{getTracks:()=>t,getAudioTracks:()=>t};},enumerateDevices:async()=>[]},languages:['en']},location:{protocol:'https:',href:'https://x/',hash:'',pathname:'/',search:''},
  isSecureContext:true,AudioContext:Ctx,AudioWorkletNode:Worklet,WebSocket:Socket,URL,Blob,performance,CustomEvent:class{constructor(t,o){this.type=t;this.detail=o?.detail;}},
  setTimeout:(f,ms)=>setTimeout(f,ms).unref(),clearTimeout,setInterval:(f,ms)=>setInterval(f,ms).unref(),clearInterval,queueMicrotask,AbortSignal,matchMedia:()=>({matches:false}),history:{replaceState(){}},Date,Promise,JSON,Math,Array,Object,String,Number,Error,Set,Map,
  dispatchEvent(e){for(const f of listeners[e.type]||[])f(e);},addEventListener:(t,f)=>(listeners[t]||=[]).push(f),AtlasSafe:require('../src/safe-html.js'),AtlasVoiceControls:require('../src/voice-controls.js'),
  AtlasAuth:{mode:'live',probe:async()=>{},onSignedIn(){},expired(){},Expired:class extends Error{},fetch:async()=>({ok:true,json:async()=>bootJson})},
  ATLAS_VOICE_BRIDGE:{context:()=>({workspaceId:'w',project:{id:'p',title:'P',stage:'Pilot',answers:[]},display:{}}),restored:async()=>{},gapConsumed(){},autoSave:()=>({})},
  URL_createObjectURL:0};
 win.window=win;win.globalThis=win;win.URL=Object.assign(function(...a){return new URL(...a);},{createObjectURL:()=>'blob:x',revokeObjectURL(){}});win.URL.prototype=URL.prototype;
 $('atlasVoiceWorklet').textContent='// worklet';
 const ctx=vm.createContext(win);vm.runInContext(read('voice-client.js'),ctx,{filename:'voice-client.js'});
 const server=m=>sockets.at(-1).onmessage({data:JSON.stringify(m)});
 return {ctx,$,els,sent,posted,sockets,tracks,server,win,bootJson,announce,mic:()=>mic,
  async live(){
   await $('voiceStartText').onclick();await new Promise(r=>setTimeout(r,5));
   $('modelConsent').checked=true;await $('voiceConsentType').onclick();await new Promise(r=>setTimeout(r,30));
   server({type:'ready',model:'ATLAS',capture:true,input:'text',...(announce?{controls:announce===true?['pause','resume','repeat','skip','text','correct','withhold','confirm_summary']:announce}:{})});
  }};
}
const flush=()=>new Promise(r=>setTimeout(r,5));
const logTexts=h=>h.$('textLog').children.map(p=>p.children.map(c=>c.textContent).join(' | '));
const sentTyped=h=>h.sent.filter(m=>m&&m.type==='text');

test('"Type instead" is offered only when the server announced typed interviews',async()=>{
 const yes=boot({text:true});await yes.win.AtlasVoice.checkConnection();await flush();
 assert.equal(yes.$('voiceStartText').hidden,false,'announced: shown next to Start conversation');
 const no=boot({text:false});await no.win.AtlasVoice.checkConnection();await flush();
 assert.equal(no.$('voiceStartText').hidden,true,'a gateway that never announced it (the other voice routes) gets no typed start');
});

test('a typed interview asks for no microphone and no audio: mode text in the start message, nothing opened, Mute gone, the orb told it is typed',async()=>{
 const h=boot();await h.live();
 assert.equal(h.mic(),0,'getUserMedia was never called');assert.deepEqual(h.posted,[],'no audio worklet');
 const start=h.sent.find(m=>m&&m.type==='start');assert.equal(start.mode,'text');assert.equal(start.consent,true);
 const s=h.win.AtlasVoice.status();assert.equal(s.phase,'live');assert.equal(s.textMode,true);assert.equal(s.hasMicrophone,false);assert.equal(s.hasAudioContext,false);
 assert.equal(h.$('voiceMute').hidden,true);assert.equal(h.$('voicePanel').dataset.input,'text');assert.match(h.$('voiceState').textContent,/typed conversation/);
 assert.match(h.$('voicePrivacy').textContent,/no microphone is used and no audio is sent/);
 assert.equal(h.$('voiceTypeForm').hidden,false);assert.equal(h.$('voiceTypeInput').disabled,false);
 // a binary frame from a gateway is ignored (a typed interview plays nothing)
 h.sockets.at(-1).onmessage({data:vm.runInContext('new ArrayBuffer(960)',h.ctx)});assert.equal(h.win.AtlasVoice.status().modelAudioReceived,false);assert.equal(h.win.AtlasVoice.status().phase,'live');
});

test('a voice start is unchanged: no mode key, the microphone is asked for',async()=>{
 const h=boot();await h.$('voiceStart').onclick();await flush();h.$('modelConsent').checked=true;await h.$('voiceConsentStart').onclick();await new Promise(r=>setTimeout(r,30));
 assert.equal(h.mic(),1);assert.equal('mode' in h.sent.find(m=>m&&m.type==='start'),false);assert.equal(h.$('voiceMute').hidden,false);assert.equal(h.$('voicePanel').dataset.input,'voice');
});

test('the conversation log: ATLAS\'s text and the consultant\'s turns in order; a retracted reply leaves it; the screen reader log changes only where something changed',async()=>{
 const h=boot();await h.live();
 h.server({type:'agent_text',text:'Hi, I’m ATLAS. '});h.server({type:'agent_text',text:'What was the project?'});
 h.server({type:'user_text',item_id:'user-typed-1',text:'We rebuilt the intake.',provenance:'consultant_typed'});
 h.server({type:'agent_text',text:'\n\nThanks. Over what period?'});
 assert.deepEqual(logTexts(h),['ATLAS | Hi, I’m ATLAS. What was the project?','You | We rebuilt the intake.','ATLAS | Thanks. Over what period?']);
 const first=h.$('textLog').children[0];h.server({type:'agent_text',text:' Anything else?'});
 assert.equal(h.$('textLog').children[0],first,'existing lines are updated in place, not rebuilt');
 h.server({type:'agent_retract',item_id:'agent-3',chars:' Anything else?'.length});assert.equal(logTexts(h)[2],'ATLAS | Thanks. Over what period?');
 assert.equal(h.$('textLog').children[1].className,'msg msg-you');
});

test('S1 follow-up: the typed text stays in the box until the server takes the turn; a refusal keeps it and says so gently; Send waits for the answer',async()=>{
 const h=boot();await h.live();const box=h.$('voiceTypeInput');
 box.value='  We rebuilt the intake process.  ';box.oninput();h.$('voiceTypeForm').onsubmit({preventDefault(){}});
 assert.equal(sentTyped(h).length,1);assert.equal(box.value,'  We rebuilt the intake process.  ','not cleared on send');assert.equal(h.$('voiceTypeSend').disabled,true,'one in flight at a time');
 h.$('voiceTypeForm').onsubmit({preventDefault(){}});assert.equal(sentTyped(h).length,1,'a second press while waiting sends nothing');
 h.server({type:'quality_warning',message:'ATLAS is still replying. Wait a moment, then send that again.',refused:'text',reason:'composing'});
 assert.match(h.$('voiceTypeNote').textContent,/One moment/);assert.match(h.$('voiceTypeNote').textContent,/Your text is kept/);
 assert.equal(box.value,'  We rebuilt the intake process.  ','a refusal keeps the text');assert.equal(h.$('voiceTypeSend').disabled,false,'Send is usable again');
 h.$('voiceTypeForm').onsubmit({preventDefault(){}});assert.equal(sentTyped(h).length,2);assert.equal(h.$('voiceTypeNote').textContent,'','sending again clears the note');
 h.server({type:'quality_warning',message:'x',refused:'text',reason:'speaking'});assert.match(h.$('voiceTypeNote').textContent,/I’ll take that as soon as I finish speaking/);
 h.$('voiceTypeForm').onsubmit({preventDefault(){}});assert.equal(sentTyped(h).length,3);
 h.server({type:'user_text',item_id:'user-typed-1',text:'We rebuilt the intake process.',provenance:'consultant_typed'});
 assert.equal(box.value,'','cleared only when the turn was echoed');assert.equal(h.$('voiceTypeNote').textContent,'');
 // words typed after sending are never wiped by the echo
 box.value='Second answer';box.oninput();h.$('voiceTypeForm').onsubmit({preventDefault(){}});box.value='Second answer, and more';
 h.server({type:'user_text',item_id:'user-typed-2',text:'Second answer',provenance:'consultant_typed'});assert.equal(box.value,'Second answer, and more');
 // another message (a warning that is not a typed refusal, a correction echo) never settles a pending turn
 h.$('voiceTypeForm').onsubmit({preventDefault(){}});const n=sentTyped(h).length;h.server({type:'quality_warning',message:'A speech segment could not be transcribed.'});h.server({type:'user_text',item_id:'user-typed-1002',text:'x',provenance:'consultant_typed'});
 assert.equal(box.value,'Second answer, and more');assert.equal(h.$('voiceTypeSend').disabled,true,'still waiting for its own answer');assert.equal(sentTyped(h).length,n);
});

test('keep private: the line on the screen (conversation, last-words receipt, "You typed") becomes the marker; other lines stay',async()=>{
 const h=boot();await h.live();const events=[];h.win.addEventListener('atlas-quality',e=>events.push(e.detail));
 h.server({type:'user_text',item_id:'user-typed-1',text:'Our secret margin is nineteen percent.',provenance:'consultant_typed'});
 h.server({type:'user_text',item_id:'user-typed-2',text:'It took six months.',provenance:'consultant_typed'});
 h.$('lastHeard').hidden=false;h.$('lastHeard').textContent='“It took six months.”';h.$('voiceMessage').textContent='You typed: “It took six months.”';
 h.server({type:'user_text_private',items:['user-typed-2']});
 assert.deepEqual(logTexts(h),['You | Our secret margin is nineteen percent.','You | [kept private]']);assert.equal(h.$('textLog').children[1].className,'msg msg-you is-private');
 assert.equal(h.$('lastHeard').textContent,'“[kept private]”');assert.equal(h.$('voiceMessage').textContent,'That answer is kept private.');
 assert.ok(events.some(e=>e.type==='user_text_private'),'the boards are told too (they forget the words)');
 h.server({type:'user_text',item_id:'user-typed-2',text:'It took six months.',provenance:'consultant_typed'});assert.equal(logTexts(h)[1],'You | [kept private]','a late echo of the same item cannot bring the words back');
});

test('a resumed typed interview: the prompt names it, Resume sends mode text with the id and no microphone, and the log is rebuilt from the restore',async()=>{
 const h=boot();await h.win.AtlasVoice.checkConnection();
 h.win.AtlasVoice.reconnect.prompt({sessionId:'ab'.repeat(16),savedAt:Date.now()-60000,expiresAt:Date.now()+3600000,input:'text'});
 const d=h.win.AtlasVoice.reconnect.dialog();assert.match(d.text.textContent,/typed interview/);
 await d.yes.onclick();await new Promise(r=>setTimeout(r,30));
 const start=h.sent.find(m=>m&&m.type==='start');assert.equal(start.resume,'ab'.repeat(16));assert.equal(start.mode,'text');assert.equal(h.mic(),0);
 h.server({type:'ready',model:'ATLAS',capture:true,input:'text',resumed:true,sessionId:'ab'.repeat(16),activeSeconds:95,controls:['text','pause']});
 h.server({type:'restore',user:[{item_id:'user-typed-1',text:'We rebuilt the intake.',provenance:'consultant_typed'},{item_id:'user-typed-2',text:'[kept private]',provenance:'consultant_typed'}],agent:['Hi, I am ATLAS.','What was the baseline?','And the period?'],lastQuestion:'And the period?',activeSeconds:95});
 assert.deepEqual(logTexts(h),['ATLAS | Hi, I am ATLAS.','You | We rebuilt the intake.','ATLAS | What was the baseline?','You | [kept private]','ATLAS | And the period?']);
 assert.equal(h.win.AtlasVoice.status().textMode,true);
});
