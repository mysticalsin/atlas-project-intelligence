'use strict';
// Agent Brain v2.1 T10: the reconnect and resume logic of voice-client.js, run for real against a fake DOM, scripted sockets and a fake microphone (no
// browser): an unexpected close mid-interview reconnects 3 times (after 1, 2 and 4 s) with `resume` and "Reconnecting…", keeps the microphone, and repopulates
// the screens from the server's `restore` event; a page load with a saved interview asks "Resume your interview?" with Resume and Start over (which deletes it).
// Not a render test: layout and focus rings are only covered by the (Chromium) browser suites.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.join(__dirname,'..');
const read=f=>fs.readFileSync(path.join(ROOT,'src',f),'utf8');
const ID='ab'.repeat(16);

class El{
 constructor(id){this.id=id;this.hidden=false;this.disabled=false;this.value='';this.checked=false;this.open=false;this.dataset={};this.style={setProperty(){},removeProperty(){}};this.children=[];this.attrs={};this._text='';this.options=[];
  const set=new Set();this.classList={add:c=>set.add(c),remove:c=>set.delete(c),toggle:(c,on)=>{if(on===undefined?!set.has(c):on)set.add(c);else set.delete(c);},contains:c=>set.has(c)};}
 set textContent(v){this._text=String(v);this.children=[];}get textContent(){return this._text;}
 set innerHTML(v){this._html=v;}get innerHTML(){return this._html||'';}
 setAttribute(k,v){this.attrs[k]=String(v);}getAttribute(k){return this.attrs[k]??null;}removeAttribute(k){delete this.attrs[k];}
 addEventListener(t,f){(this.listeners||(this.listeners={}))[t]=f;}append(...k){this.children.push(...k);}appendChild(k){this.children.push(k);return k;}replaceChildren(...k){this.children=k;}
 insertBefore(k){this.children.push(k);}querySelector(){return new El('q');}querySelectorAll(){return [];}closest(){return null;}matches(){return false;}
 focus(){}close(){this.open=false;}showModal(){this.open=true;}scrollIntoView(){}click(){if(this.disabled||this.hidden)return;return this.onclick?.({target:this});}
 get offsetParent(){return this.hidden?null:{};}
}
// plan: how each new socket behaves ('open' by default, 'fail' closes before ready). reply(start, socket): what the server answers to a `start` (default: nothing).
function boot({resumable=null,plan=[],discardOk=true}={}){
 const els={};const $=id=>els[id]||(els[id]=new El(id));
 const doc={getElementById:$,createElement:t=>new El(t),querySelector:()=>new El('q'),addEventListener(){},body:new El('body'),readyState:'complete'};
 const sockets=[],tracks=[],delays=[],requests=[],events=[],posted=[],h={};
 const newTrack=()=>{const t={enabled:true,readyState:'live',stop(){this.readyState='ended';},addEventListener(){},label:'fake mic',muted:false};tracks.splice(0,tracks.length,t);return t;};
 class Socket{constructor(){this.readyState=0;this.bufferedAmount=0;this.sent=[];const mode=plan[sockets.length]||'open';sockets.push(this);
   setTimeout(()=>{if(mode==='fail'){this.readyState=3;this.onclose?.();return;}this.readyState=1;this.onopen?.();},0);}
  send(d){const m=typeof d==='string'?JSON.parse(d):d.byteLength;this.sent.push(m);if(m&&m.type==='start')setTimeout(()=>h.reply?.(m,this),0);}
  close(){const was=this.readyState;this.readyState=3;if(was!==3)setTimeout(()=>this.onclose?.(),0);}}
 class Worklet{constructor(){this.port={onmessage:null,postMessage:m=>posted.push(m)};}connect(){}disconnect(){}}
 class Ctx{constructor(){this.state='running';this.audioWorklet={addModule:async()=>{}};this.destination={};this.sampleRate=24000;}async resume(){}async close(){}createMediaStreamSource(){return{connect(){},disconnect(){}};}}
 const bootJson={protocol:'atlas-personaplex-pcm-v1',csrf:'csrf-1',identity:{name:'T',mode:'local'},model:'M',voices:['v'],defaultVoice:'v',busy:false,codecAvailable:true,maxSeconds:900,memory:false,transcription:true,captureRequired:true,structuredNotes:false,provider:'workers',playbackAck:true,resumable};
 // The reconnect pauses (1, 2, 4 s) are recorded and shortened; every other timer is real.
 const fast=(f,ms)=>{if([1000,2000,4000].includes(ms)){delays.push(ms);return setTimeout(f,1).unref();}return setTimeout(f,ms).unref();};
 const win={document:doc,navigator:{mediaDevices:{getUserMedia:async()=>{const t=[newTrack()];return{getTracks:()=>t,getAudioTracks:()=>t};},enumerateDevices:async()=>[]},languages:['en']},
  location:{protocol:'https:',href:'https://x/',hash:'',pathname:'/',search:''},isSecureContext:true,AudioContext:Ctx,AudioWorkletNode:Worklet,WebSocket:Socket,URL,Blob,performance,
  CustomEvent:class{constructor(t,o){this.type=t;this.detail=o?.detail;}},setTimeout:fast,clearTimeout,setInterval:(f,ms)=>setInterval(f,ms).unref(),clearInterval,queueMicrotask,AbortSignal,
  matchMedia:()=>({matches:false}),history:{replaceState(){}},Date,Promise,JSON,Math,Array,Object,String,Number,Error,Set,Map,
  dispatchEvent(e){events.push(e);},addEventListener(t,f){(win.listeners||(win.listeners={}))[t]=f;},AtlasVoiceControls:require('../src/voice-controls.js'),
  AtlasAuth:{mode:'live',probe:async()=>{},onSignedIn(){},expired(){},Expired:class extends Error{},
   fetch:async(p,o={})=>{requests.push({path:p,method:o.method||'GET',headers:o.headers||{}});
    if(p==='/api/bootstrap')return{ok:true,json:async()=>JSON.parse(JSON.stringify(bootJson))};
    if(p==='/api/checkpoint/discard')return{ok:discardOk,json:async()=>({discarded:discardOk})};
    return{ok:false,json:async()=>({})};}},
  ATLAS_VOICE_BRIDGE:{context:()=>({workspaceId:'w',project:{id:'p',title:'P',stage:'Pilot',answers:[]},display:{}}),restored:async()=>{},gapConsumed(){},autoSave:()=>({})}};
 win.window=win;win.globalThis=win;win.URL=Object.assign(function(...a){return new URL(...a);},{createObjectURL:()=>'blob:x',revokeObjectURL(){}});win.URL.prototype=URL.prototype;
 $('atlasVoiceWorklet').textContent='// worklet';
 const ctx=vm.createContext(win);vm.runInContext(read('voice-client.js'),ctx,{filename:'voice-client.js'});
 const server=(m,i=sockets.length-1)=>sockets[i].onmessage({data:JSON.stringify(m)});
 const ready=(extra={})=>({type:'ready',model:'ATLAS',capture:true,controls:['pause','resume','repeat','skip','text'],sessionId:ID,resumable:true,...extra});
 Object.assign(h,{$,els,sockets,tracks,delays,requests,events,posted,server,win,ready,bootJson,
  async live(){await $('voiceStart').onclick();await wait(5);$('modelConsent').checked=true;await $('voiceConsentStart').onclick();await wait(30);server(ready());},
  starts:()=>sockets.map(s=>s.sent.find(m=>m&&m.type==='start')).filter(Boolean),
  quality:()=>events.filter(e=>e.type==='atlas-quality').map(e=>e.detail)});
 return h;
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const RESTORE={type:'restore',user:[{item_id:'user-1',text:'We rebuilt the intake process.',provenance:'unverified_speech_recognition'}],agent:['Right. What was the project?','Thanks. What was the baseline?'],
  quality:{next_field:'measurement',candidate_details:[{id:'D-001',field:'outcome',quote:'We rebuilt the intake'}],analyst_status:'restored'},lastQuestion:'What was the baseline?',state:'discovery',paused:false,activeSeconds:372,turns:1};
const resumeOk=(h,extra={})=>{h.reply=(m,s)=>{if(!m.resume)return;h.server(h.ready({resumed:true}),h.sockets.indexOf(s));h.server(RESTORE,h.sockets.indexOf(s));};};
const drop=(h,i=h.sockets.length-1)=>{const s=h.sockets[i];s.readyState=3;s.onclose?.();};
const text=(h,id)=>h.$(id).textContent;

test('the delays are 1, 2 and 4 seconds, and the client exposes them',()=>{
 const h=boot();assert.deepEqual([...h.win.AtlasVoice.reconnect.delays],[1000,2000,4000]);
});

test('an unexpected close mid-interview: Reconnecting…, then a resume start on a new socket; the microphone stays open and the screens are repopulated',async()=>{
 const h=boot();resumeOk(h);await h.live();
 assert.equal(h.win.AtlasVoice.reconnect.state().sessionId,ID,'ready announced the interview id');
 const track=h.tracks[0];
 drop(h);
 assert.equal(text(h,'voiceState'),'Reconnecting…');assert.equal(text(h,'voiceHeading'),'Reconnecting…');assert.match(text(h,'voiceMessage'),/saved on the server/);
 assert.equal(h.win.AtlasVoice.reconnect.state().reconnecting,true);assert.equal(h.$('voiceEnd').disabled,true,'End waits for the connection');
 await wait(60);
 assert.deepEqual(h.delays,[1000],'one try, after 1 s');assert.equal(h.sockets.length,2);
 const start=h.starts()[1];
 assert.equal(start.resume,ID);assert.equal(start.csrf,'csrf-1');assert.deepEqual(start.consent,{transcription:true,draft:true,checkpoint:true,memory:false,notice:false});assert.equal(start.capture,true);assert.ok(!('gap' in start));assert.equal(start.project.id,'p');assert.equal(start.language,'en');
 assert.equal(h.win.AtlasVoice.status().phase,'live');assert.equal(h.win.AtlasVoice.reconnect.state().reconnecting,false);
 assert.equal(text(h,'voiceHeading'),'You’re back. Picking up where we stopped.');
 assert.equal(track.readyState,'live','the microphone was never closed');assert.equal(h.win.AtlasVoice.status().hasMicrophone,true);
 assert.equal(text(h,'agentText'),'Right. What was the project?\n\nThanks. What was the baseline?');
 const q=h.quality();assert.equal(q.filter(d=>d.type==='user_text').length,1);assert.equal(q.find(d=>d.type==='user_text').text,'We rebuilt the intake process.');
 const quality=q.find(d=>d.type==='quality');assert.equal(quality.next_field,'measurement');assert.equal(quality.candidate_details.length,1);
 assert.match(text(h,'voiceTimer'),/^06:1\d$|^06:2\d$/,'the clock carries on from the interview time (372 s): '+text(h,'voiceTimer'));
 assert.ok(h.posted.some(m=>m.type==='flush'),'whatever of hers was still queued is dropped');
 assert.equal(h.sockets[0].sent.filter(m=>m&&m.type==='discard').length,0,'a drop is not a discard');
 assert.ok(!h.requests.some(r=>r.path==='/api/checkpoint/discard'));
 assert.equal(h.$('voiceEnd').disabled,false);
 // and a second drop reconnects again, with the same id
 drop(h);await wait(60);assert.equal(h.starts().length,3);assert.equal(h.starts()[2].resume,ID);
});

test('three tries at 1, 2 and 4 seconds; success on the third',async()=>{
 const h=boot({plan:['open','fail','fail']});resumeOk(h);await h.live();
 drop(h);await wait(100);
 assert.deepEqual(h.delays,[1000,2000,4000]);assert.equal(h.sockets.length,4);
 assert.equal(h.win.AtlasVoice.status().phase,'live');assert.equal(h.starts().filter(m=>m.resume===ID).length,1,'only the socket that opened got a start');
});

test('three misses: the interview stays saved on the server, the page says so, the microphone is off, nothing is discarded',async()=>{
 const h=boot({plan:['open','fail','fail','fail']});await h.live();
 drop(h);await wait(100);
 assert.deepEqual(h.delays,[1000,2000,4000]);
 const s=h.win.AtlasVoice.status();assert.equal(s.phase,'error');assert.equal(s.hasMicrophone,false);
 assert.match(text(h,'voiceMessage'),/saved for 24 hours/);assert.match(text(h,'voiceMessage'),/reload this page to resume it/);
 assert.ok(!h.requests.some(r=>r.path==='/api/checkpoint/discard'),'the saved interview is not deleted');
 assert.equal(h.win.AtlasVoice.reconnect.state().reconnecting,false);
});

test('a refusal stops the tries: expired or gone is said plainly, and the offer is forgotten',async()=>{
 const h=boot({resumable:{sessionId:ID,savedAt:1,expiresAt:2}});
 h.reply=(m,s)=>{if(m.resume)h.server({type:'error',code:'resume-unavailable',message:'This interview can no longer be resumed. Start a new one.'},h.sockets.indexOf(s));};
 await h.live();h.server({type:'ready',...{model:'ATLAS',capture:true,sessionId:ID}});
 drop(h);await wait(80);
 assert.deepEqual(h.delays,[1000],'one try, no more');
 const s=h.win.AtlasVoice.status();assert.equal(s.phase,'idle');assert.equal(s.hasMicrophone,false);
 assert.equal(text(h,'voiceHeading'),'This interview can’t be resumed.');assert.match(text(h,'voiceMessage'),/can no longer be resumed/);assert.match(text(h,'voiceMessage'),/Start a new one/);
 assert.equal(h.win.AtlasVoice.bootstrap().resumable,null);
});

test('a server that does not keep the interview (no id in ready) gets no reconnect: the old behaviour',async()=>{
 const h=boot();await h.live();h.server({type:'ready',model:'ATLAS',capture:false}); // a second ready without an id, as when capture is off
 assert.equal(h.win.AtlasVoice.reconnect.state().sessionId,null);
 drop(h);await wait(30);
 assert.deepEqual(h.delays,[]);assert.equal(h.sockets.length,1);assert.equal(h.win.AtlasVoice.status().phase,'error');assert.match(text(h,'voiceMessage'),/closed before the interview finished/);
});

test('End is ignored while reconnecting; Cancel discards the saved interview as well',async()=>{
 const h=boot({plan:['open','fail','fail','fail']});await h.live();
 drop(h);
 h.$('voiceEnd').onclick();assert.match(text(h,'voiceMessage'),/end the interview as soon as the connection is back/);assert.equal(h.win.AtlasVoice.status().phase,'live');
 h.win.AtlasVoice.cancel('Stop.');await wait(10);
 assert.deepEqual(h.requests.filter(r=>r.path==='/api/checkpoint/discard').map(r=>[r.method,r.headers['X-Atlas-CSRF']]),[['POST','csrf-1']]);
 assert.equal(h.win.AtlasVoice.status().phase,'idle');
 await wait(60);assert.equal(h.sockets.length,1,'no more tries after a cancel');
});

test('closing or reloading the page mid-interview keeps it: the socket closes with no discard, so the server suspends it',async()=>{
 const h=boot();await h.live();
 h.win.listeners.pagehide();await wait(10);
 assert.equal(h.sockets[0].sent.filter(m=>m&&m.type==='discard').length,0);assert.equal(h.sockets[0].readyState,3);
 assert.equal(h.win.AtlasVoice.status().hasMicrophone,false);assert.deepEqual(h.delays,[],'and the page does not try to reconnect itself');
 // an interview the server does not keep is thrown away as before
 const g=boot();await g.live();g.server({type:'ready',model:'ATLAS',capture:false});
 g.win.listeners.pagehide();assert.equal(g.sockets[0].sent.filter(m=>m&&m.type==='discard').length,1);
});

test('page load with a saved interview: an accessible "Resume your interview?" prompt before anything else',async()=>{
 const savedAt=Date.UTC(2026,9,30,12,0),h=boot({resumable:{sessionId:ID,savedAt,expiresAt:savedAt+864e5}});
 await wait(20);
 const d=h.win.AtlasVoice.reconnect.dialog();assert.ok(d&&d.d.open,'the prompt is open');
 assert.equal(d.d.getAttribute('aria-labelledby'),'voiceResumeTitle');assert.equal(d.d.getAttribute('aria-describedby'),'voiceResumeText');
 assert.equal(d.yes.textContent,'Resume');assert.equal(d.no.textContent,'Start over');
 assert.match(d.text.textContent,/stopped in the middle of an interview/);assert.match(d.text.textContent,/keeps transcribing/);assert.match(d.note.textContent,/Start over deletes the saved interview now/);
 assert.ok(!h.sockets.length,'nothing is started, no microphone is asked for');assert.equal(h.$('voiceConsentDialog').open,false);
});

test('Resume: starts with the interview id, with no consent dialog and transcription on',async()=>{
 const h=boot({resumable:{sessionId:ID,savedAt:1,expiresAt:2}});resumeOk(h);await wait(20);
 h.win.AtlasVoice.reconnect.dialog().yes.click();await wait(60);
 assert.equal(h.sockets.length,1);const start=h.starts()[0];
 assert.equal(start.resume,ID);assert.equal(start.capture,true);assert.deepEqual(start.consent,{transcription:true,draft:true,checkpoint:true,memory:false,notice:false});assert.equal(start.voice,'v');assert.ok(!('gap' in start));
 assert.equal(h.$('voiceConsentDialog').open,false,'Resume is the consent: no second dialog');
 assert.equal(h.win.AtlasVoice.status().phase,'live');assert.equal(text(h,'agentText').includes('baseline'),true);
 assert.equal(h.win.AtlasVoice.reconnect.dialog().d.open,false);
});

test('Start over: deletes the saved interview (POST with the CSRF token), forgets it, then goes on to the normal consent step',async()=>{
 const h=boot({resumable:{sessionId:ID,savedAt:1,expiresAt:2}});await wait(20);
 const d=h.win.AtlasVoice.reconnect.dialog();
 h.bootJson.resumable=null; // the server has deleted it by the time the page asks again
 d.no.click();await wait(40);
 assert.deepEqual(h.requests.filter(r=>r.path==='/api/checkpoint/discard').map(r=>[r.method,r.headers['X-Atlas-CSRF']]),[['POST','csrf-1']]);
 assert.equal(d.d.open,false);assert.equal(h.win.AtlasVoice.bootstrap().resumable,null);assert.equal(h.sockets.length,0);
 assert.equal(h.$('voiceConsentDialog').open,true,'a new conversation begins with the usual consent step');
});

test('Start over that could not delete keeps the prompt open and says so',async()=>{
 const h=boot({resumable:{sessionId:ID,savedAt:1,expiresAt:2},discardOk:false});await wait(20);
 const d=h.win.AtlasVoice.reconnect.dialog();d.no.click();await wait(40);
 assert.equal(d.d.open,true);assert.match(d.note.textContent,/could not be deleted/);assert.equal(d.no.disabled,false);assert.equal(h.$('voiceConsentDialog').open,false);
});

test('pressing Start with a saved interview asks first; without one it goes straight to consent',async()=>{
 const h=boot({resumable:{sessionId:ID,savedAt:1,expiresAt:2}});await wait(20);
 h.win.AtlasVoice.reconnect.dialog().d.close();
 await h.$('voiceStart').onclick();await wait(20);
 assert.equal(h.win.AtlasVoice.reconnect.dialog().d.open,true);assert.equal(h.$('voiceConsentDialog').open,false);
 const g=boot();await wait(20);assert.equal(g.win.AtlasVoice.reconnect.dialog(),null,'no prompt without a saved interview');
 await g.$('voiceStart').onclick();await wait(20);assert.equal(g.$('voiceConsentDialog').open,true);
});

test('a refused resume from the prompt says why and offers a new interview',async()=>{
 const h=boot({resumable:{sessionId:ID,savedAt:1,expiresAt:2}});
 h.reply=(m,s)=>h.server({type:'error',code:'resume-project',message:'That interview was about a different project.'},h.sockets.indexOf(s));
 await wait(20);h.win.AtlasVoice.reconnect.dialog().yes.click();await wait(60);
 assert.equal(h.win.AtlasVoice.status().phase,'idle');assert.equal(text(h,'voiceHeading'),'This interview can’t be resumed.');assert.match(text(h,'voiceMessage'),/different project/);
 assert.equal(h.win.AtlasVoice.status().hasMicrophone,false);
});

test('a normal start never carries a resume field, and the first ready announces the interview id',async()=>{
 const h=boot();await h.live();
 assert.ok(!('resume' in h.starts()[0]));assert.equal(h.starts()[0].csrf,'csrf-1');assert.equal(h.win.AtlasVoice.reconnect.state().sessionId,ID);
 h.server({type:'ended'});await wait(5);assert.equal(h.win.AtlasVoice.reconnect.state().sessionId,null,'forgotten once the interview has ended');
});
