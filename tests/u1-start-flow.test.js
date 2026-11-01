'use strict';
// U1: the start flow in voice-client.js, run for real against a fake DOM (no browser): a microphone that cannot be opened is a calm inline state (not "The voice
// connection stopped"), "Continue by typing" starts the typed interview with the consent already given (no second dialog), "Try the microphone again" asks again;
// a server without voice (bootstrap voice:false) leads with the typed interview and the orb starts it; the start row is quiet until the server has answered.
// Layout and fit are measured in a real browser: tests/ux_fit_browser.py.
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
function boot({announce=true,provider='workers',text=true,extra={},micError=null,mode='live',home=''}={}){
 let mic=0;
 const els={},listeners={};const $=id=>els[id]||(els[id]=new El(id));
 const doc={getElementById:$,createElement:t=>new El(t),querySelector:()=>new El('q'),addEventListener(){},body:new El('body'),readyState:'complete'};
 const sent=[],posted=[],sockets=[],tracks=[],newTrack=()=>{const t={enabled:true,readyState:'live',stop(){this.readyState='ended';},addEventListener(){},label:'fake mic',muted:false};tracks.splice(0,tracks.length,t);return t;};
 class Socket{constructor(){this.readyState=0;this.bufferedAmount=0;sockets.push(this);setTimeout(()=>{this.readyState=1;this.onopen?.();},0);}send(d){sent.push(typeof d==='string'?JSON.parse(d):d.byteLength);}close(){this.readyState=3;}}
 class Worklet{constructor(){this.port={onmessage:null,postMessage:m=>posted.push(m)};}connect(){}disconnect(){}}
 class Ctx{constructor(){this.state='running';this.audioWorklet={addModule:async()=>{}};this.destination={};this.sampleRate=24000;}async resume(){}async close(){}createMediaStreamSource(){return{connect(){},disconnect(){}};}}
 const bootJson={protocol:'atlas-personaplex-pcm-v1',csrf:'c',identity:{name:'T',mode:'local'},model:'M',voices:['v'],defaultVoice:'v',busy:false,codecAvailable:true,maxSeconds:900,memory:false,transcription:true,structuredNotes:false,provider,playbackAck:true,...(text?{textMode:true}:{}),...extra};
 const win={document:doc,navigator:{mediaDevices:{getUserMedia:async()=>{mic++;if(micError)throw Object.assign(new Error(micError),{name:micError});const t=[newTrack()];return{getTracks:()=>t,getAudioTracks:()=>t};},enumerateDevices:async()=>[]},languages:['en']},location:{protocol:'https:',href:'https://x/',hash:'',pathname:'/',search:''},
  isSecureContext:true,AudioContext:Ctx,AudioWorkletNode:Worklet,WebSocket:Socket,URL,Blob,performance,CustomEvent:class{constructor(t,o){this.type=t;this.detail=o?.detail;}},
  setTimeout:(f,ms)=>setTimeout(f,ms).unref(),clearTimeout,setInterval:(f,ms)=>setInterval(f,ms).unref(),clearInterval,queueMicrotask,AbortSignal,matchMedia:()=>({matches:false}),history:{replaceState(){}},Date,Promise,JSON,Math,Array,Object,String,Number,Error,Set,Map,
  dispatchEvent(e){for(const f of listeners[e.type]||[])f(e);},addEventListener:(t,f)=>(listeners[t]||=[]).push(f),AtlasSafe:require('../src/safe-html.js'),AtlasVoiceControls:require('../src/voice-controls.js'),
  ATLAS_HOME:home,AtlasAuth:{mode,probe:async()=>{},onSignedIn(){},expired(){},Expired:class extends Error{},fetch:async()=>({ok:true,json:async()=>bootJson})},
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

const flush=(ms=5)=>new Promise(r=>setTimeout(r,ms));
const tick=async h=>{await h.win.AtlasVoice.checkConnection();await flush();};
const consentAndStart=async(h,which)=>{h.$('modelConsent').checked=true;h.$('modelConsent').onchange({target:h.$('modelConsent')});await h.$(which).onclick();await flush(40);};

test('a blocked microphone: idle, one sentence, "Continue by typing" and a retry, no "connection stopped" and no error phase',async()=>{
 for(const [name,word] of [['NotAllowedError',/blocking the microphone/],['NotFoundError',/No microphone was found/],['NotReadableError',/Another app/]]){
  const h=boot({micError:name});await tick(h);await h.$('voiceStart').onclick();await flush();await consentAndStart(h,'voiceConsentStart');
  const s=h.win.AtlasVoice.status();assert.equal(s.phase,'idle',name+': not an error');assert.equal(s.hasMicrophone,false);
  assert.match(h.$('voiceMessage').textContent,word);assert.equal(h.$('voiceMessage').textContent.split('.').length,2,'one sentence');
  assert.ok(!/stopped|connection/i.test(h.$('voiceHeading').textContent+h.$('voiceMessage').textContent),name+': no scary wording');
  assert.equal(h.$('voiceMicHelp').hidden,false);assert.equal(h.$('voiceMicType').hidden,false);assert.equal(h.$('voiceControls').dataset.mic,'blocked');
  assert.equal(h.$('voiceConsentDialog').open,false);assert.equal(h.$('voiceState').textContent,'Ready');
 }
});
test('Continue by typing: text mode starts at once, with the consent already given and no second dialog; the inline state goes away',async()=>{
 const h=boot({micError:'NotAllowedError',extra:{captureRequired:true}});await tick(h);await h.$('voiceStart').onclick();await flush();h.$('checkpointConsent').checked=true;await consentAndStart(h,'voiceConsentStart');
 let opened=0;const show=h.$('voiceConsentDialog').showModal;h.$('voiceConsentDialog').showModal=function(){opened++;return show.call(this);};
 await h.$('voiceMicType').onclick();await flush(40);h.server({type:'ready',model:'ATLAS',capture:true,input:'text',controls:['pause','resume','repeat','skip','text']});await flush();
 const start=h.sent.filter(m=>m&&m.type==='start').at(-1);assert.equal(start.mode,'text');assert.equal(start.consent.draft,true,'the consent already given is carried');assert.equal(start.consent.checkpoint,true,'so is the saved-interview choice');assert.equal(start.consent.transcription,false,'typed: no transcription of audio');
 assert.equal(opened,0,'no second consent dialog');assert.equal(h.$('voiceConsentDialog').open,false);
 const s=h.win.AtlasVoice.status();assert.equal(s.phase,'live');assert.equal(s.textMode,true);assert.equal(h.mic(),1,'the microphone was asked for once (the first attempt), never again');
 assert.equal(h.$('voiceMicHelp').hidden,true);assert.equal(h.$('voiceControls').dataset.mic,'');
});
test('Try the microphone again asks the browser again (still blocked: the same calm state; no second dialog)',async()=>{
 const h=boot({micError:'NotAllowedError'});await tick(h);await h.$('voiceStart').onclick();await flush();await consentAndStart(h,'voiceConsentStart');assert.equal(h.mic(),1);
 let opened=0;const show=h.$('voiceConsentDialog').showModal;h.$('voiceConsentDialog').showModal=function(){opened++;return show.call(this);};
 await h.$('voiceMicRetry').onclick();await flush(40);assert.equal(h.mic(),2);assert.equal(opened,0);assert.equal(h.win.AtlasVoice.status().phase,'idle');assert.equal(h.$('voiceMicHelp').hidden,false);
});
test('a server that offers no typed interview gets no "Continue by typing" (the retry stays)',async()=>{
 const h=boot({text:false,micError:'NotAllowedError'});await tick(h);await h.$('voiceStart').onclick();await flush();await consentAndStart(h,'voiceConsentStart');
 assert.equal(h.$('voiceMicHelp').hidden,false);assert.equal(h.$('voiceMicType').hidden,true);assert.equal(h.$('voiceMicRetry').hidden,false);
});
test('a real failure after the microphone opened is still an error, worded for the kind of interview',async()=>{
 const h=boot();await h.live();h.server({type:'error',message:'The service is unavailable.'});await flush();
 assert.equal(h.win.AtlasVoice.status().phase,'error');assert.match(h.$('voiceHeading').textContent,/The conversation stopped/);assert.ok(!/fallback voice/.test(h.$('voiceMessage').textContent));
});
test('bootstrap voice:false (no speech service): the typed interview is primary, the voice button is gone with a short reason, and the orb starts it',async()=>{
 const h=boot({extra:{voice:false}});await tick(h);
 assert.equal(h.$('voiceStart').hidden,true);assert.equal(h.$('voiceStartText').hidden,false);assert.equal(h.$('voiceStartText').textContent,'Start interview');assert.ok(h.$('voiceStartText').classList.contains('primary'));
 assert.equal(h.$('voiceReason').hidden,false);assert.match(h.$('voiceReason').textContent,/Voice isn’t set up on this server/);assert.equal(h.$('voiceControls').dataset.boot,'ready');
 await h.$('voiceStart').onclick();await flush(40); // what the orb's click does
 assert.equal(h.$('voiceConsentDialog').open,true);assert.equal(h.$('voiceConsentDialog').dataset.input,'text');assert.equal(h.$('voiceConsentStart').hidden,true);assert.equal(h.$('voiceConsentType').hidden,false);assert.equal(h.$('voiceConsentType').textContent,'Start interview');
 await consentAndStart(h,'voiceConsentType');assert.equal(h.mic(),0,'no microphone');assert.equal(h.sent.find(m=>m&&m.type==='start').mode,'text');
});
test('voice:false with no typed interview is the old "Voice isn’t available" message; and a server that does not say keeps the voice start primary',async()=>{
 const none=boot({text:false,extra:{voice:false}});await tick(none);await none.$('voiceStart').onclick();await flush(40);
 assert.match(none.$('voiceHeading').textContent,/Voice isn’t available/);assert.equal(none.$('voiceConsentDialog').open,false);
 const normal=boot();await tick(normal);assert.equal(normal.$('voiceStart').hidden,false);assert.equal(normal.$('voiceReason').hidden,true);assert.equal(normal.$('voiceStartText').textContent,'Type instead');assert.ok(!normal.$('voiceStartText').classList.contains('primary'));
});
test('the start row is reserved but quiet until the server has answered (no jump), and every focus call keeps the window where it is',async()=>{
 const h=boot();assert.equal(h.$('voiceControls').dataset.boot===undefined||h.$('voiceControls').dataset.boot==='ready',true);
 const src=read('voice-client.js');assert.ok(!/\.focus\(\)/.test(src),'every focus call uses preventScroll');assert.ok(/preventScroll:true/.test(src));
 const html=read('voice-panel.html');assert.match(html,/id="voiceControls"/);assert.match(html,/data-boot="pending"/);
});
test('dialog sheets keep their actions in view (sticky footer) and the page ships the fit stylesheet last',()=>{
 const css=read('fit.css'),b=fs.readFileSync(path.join(ROOT,'build.py'),'utf8');
 assert.match(b,/ui\.css'\)\.read_text\(\)\+'\\n'\+\(ROOT\/'src\/fit\.css'\)/);
 assert.match(css,/#voiceConsentDialog,#voiceResumeDialog,#voiceEndDialog,#voiceRestartDialog,#eraseDialog\) \.actions\{position:sticky;bottom:0/);
 for(const f of ['orb.css','orb-renderer.js','orb-ui.js','sculpture.css'])assert.ok(!/fit-orb|U1/.test(read(f)),f+' was not touched');
 assert.match(css,/@media\(min-width:1024px\) and \(min-height:560px\)/);assert.match(css,/prefers-reduced-motion:no-preference/);
});

test('an offline copy still shows the one "Open ATLAS" link (the start row is not swallowed by anything above it)',async()=>{
 const h=boot({mode:'offline',home:'https://atlas.example.workers.dev'});await flush(20);
 assert.equal(h.$('voiceOpenHome').hidden,false);assert.equal(h.$('voiceOpenHome').href,'https://atlas.example.workers.dev/go/start');assert.equal(h.$('voiceStart').hidden,true);assert.equal(h.$('voiceStartText').hidden,true);assert.equal(h.$('voiceControls').dataset.boot,'ready');
});

test('a sheet\'s confirm shields the panel for a moment, so a double click cannot land on the control underneath',async()=>{
 const h=boot();await h.live();
 await h.$('voiceEndConfirm').onclick();assert.ok(h.$('voicePanel').classList.contains('fit-settling'));
 assert.match(read('fit.css'),/#voicePanel\.fit-settling\{pointer-events:none\}/);
});

test('round 6 structure: one next-question card (the challenge lives in the cue card, not in the board), the read-back list scrolls on its own, the sound check sits with the bottom links, the project chip exists',()=>{
 const html=read('voice-panel.html'),at=s=>html.indexOf(s);
 assert.ok(at('id="boardChallenge"')>at('quality-live-card')&&at('id="boardChallenge"')<at('id="qualityNext"'),'ATLAS may ask next is the top of the cue card');
 assert.ok(at('id="boardChallenge"')<at('id="storyBoard"')||at('id="boardChallenge"')>html.indexOf('</section>',at('id="storyBoard"')),'not inside the story board');
 assert.ok(at('id="summaryScroll"')<at('id="summaryItems"')&&at('id="summaryNext"')<at('id="summarySaved"')&&at('id="summarySaved"')<at('id="summaryConfirm"'),'items, still-open and the next line scroll; the saved note and the actions stay outside');
 assert.ok(at('class="orb-bottom-actions"')<at('id="soundHelp"')&&at('id="soundHelp"')<at('id="voiceSetup"'),'the sound check is one of the bottom links');
 assert.match(html,/id="fitProject"/);
 const h=boot();
 assert.equal(h.$('fitProject').textContent,'P','the project title (the fake workspace calls it P) is in the strip');assert.equal(h.$('fitProject').hidden,false);
});
