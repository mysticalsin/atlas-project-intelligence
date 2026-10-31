'use strict';
// The pure part of the interview controls (T9): message shapes the browser may send, what the server announces, and how the controls look.
// The wiring in voice-client.js is checked against the compiled page below (every id and handler it needs exists once, nothing is sent unannounced).
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const C=require('../src/voice-controls.js'),ROOT=path.join(__dirname,'..');
const ALL=['pause','resume','repeat','skip','text'];

test('exports are the fixed contract',()=>{assert.deepEqual(Object.keys(C).sort(),['CORRECT_MAX','NAMES','PRIVATE_MARK','TEXT_MAX','TYPED_NOTES','afterAccepted','clock','elapsed','languageInfo','languageMessage','languageOptions','languageView','logApply','logRestore','message','pausedFrom','summaryMessage','supports','typedAccepted','typedRefusal','view']);assert.deepEqual(C.NAMES,ALL);assert.equal(C.TEXT_MAX,2000);});

test('messages: exactly the keys the session accepts',()=>{
 for(const k of ['pause','resume','repeat','skip'])assert.deepEqual(C.message(k),{type:k});
 assert.deepEqual(C.message('text','  We cut onboarding time.  '),{type:'text',text:'We cut onboarding time.'});
 assert.deepEqual(Object.keys(C.message('text','x')).sort(),['text','type']);
});
test('messages: nothing to send is null (empty, blank, not a string, unknown kind)',()=>{
 for(const t of ['','   ','\n\t',undefined,null,42,{}])assert.equal(C.message('text',t),null);
 assert.equal(C.message('text'),null);assert.equal(C.message('end'),null);assert.equal(C.message('discard'),null);assert.equal(C.message('stop'),null);assert.equal(C.message(),null);
});
test('typed text is bounded by whole characters, like the server',()=>{
 assert.equal([...C.message('text','a'.repeat(5000)).text].length,2000);
 assert.equal([...C.message('text','😀'.repeat(2500)).text].length,2000,'never half an emoji');
});

test('a gateway that announced nothing is never sent a control',()=>{
 for(const ready of [{},{controls:null},{controls:'pause'},undefined,null])for(const k of ALL)assert.equal(C.supports(ready,k),false);
 assert.equal(C.supports({controls:ALL},'pause'),true);assert.equal(C.supports({controls:['pause']},'skip'),false);
 const v=C.view({phase:'live',paused:false,muted:false,controls:null,draft:'hello'});
 assert.ok(v.pauseHidden&&v.repeatHidden&&v.skipHidden&&v.textHidden,'old routes keep mute-only controls');
 assert.ok(v.pauseDisabled&&v.repeatDisabled&&v.skipDisabled&&v.textDisabled&&v.sendDisabled);
});

test('the paused flag follows the server\'s state events only',()=>{
 assert.equal(C.pausedFrom(false,{type:'state',state:'paused'}),true);
 assert.equal(C.pausedFrom(true,{type:'state',state:'discovery'}),false);
 assert.equal(C.pausedFrom(true,{type:'state',state:'summary'}),false);
 for(const m of [{type:'quality'},{type:'state'},{type:'state',state:3},null,undefined,'x'])assert.equal(C.pausedFrom(true,m),true,'anything else leaves it as it is');
 assert.equal(C.pausedFrom(false,{type:'ready'}),false);
});

test('the clock leaves out paused time (the one in progress too)',()=>{
 assert.equal(C.elapsed(0,0,null,90000),90);
 assert.equal(C.elapsed(0,30000,null,90000),60,'a finished pause');
 assert.equal(C.elapsed(0,0,60000,90000),60,'paused at 60 s: the clock stands still at 60 s');
 assert.equal(C.elapsed(0,10000,60000,3600000),50,'it stays there for an hour');
 assert.equal(C.elapsed(5000,0,null,1000),0,'never negative');
 assert.equal(C.clock(0),'00:00');assert.equal(C.clock(65),'01:05');assert.equal(C.clock(754),'12:34');
});

test('view: live and running',()=>{
 const v=C.view({phase:'live',paused:false,muted:false,controls:ALL,draft:''});
 assert.equal(v.pauseLabel,'Pause');assert.equal(v.pauseAria,'Pause the interview');assert.equal(v.pausePressed,false);
 assert.ok(!v.pauseHidden&&!v.pauseDisabled&&!v.repeatDisabled&&!v.skipDisabled&&!v.textDisabled&&!v.muteDisabled);
 assert.equal(v.sendDisabled,true,'Send waits for text');
 assert.equal(C.view({phase:'live',paused:false,muted:false,controls:ALL,draft:'  hi '}).sendDisabled,false);
 assert.equal(C.view({phase:'live',paused:false,muted:false,controls:ALL,draft:'   '}).sendDisabled,true,'blank is not an answer');
 assert.equal(v.orbPhase,'live');assert.equal(v.micOpen,true);
});
test('view: paused: Resume only, microphone closed, orb is not speaking',()=>{
 const v=C.view({phase:'live',paused:true,muted:false,controls:ALL,draft:'typed while paused'});
 assert.equal(v.pauseLabel,'Resume');assert.equal(v.pauseAria,'Resume the interview');assert.equal(v.pausePressed,true);
 assert.ok(!v.pauseDisabled,'Resume is the one way back');
 assert.ok(v.repeatDisabled&&v.skipDisabled&&v.muteDisabled);
 assert.equal(v.textDisabled,false,'typing is allowed while paused: it carries on');assert.equal(v.sendDisabled,false);
 assert.equal(v.orbPhase,'paused');assert.equal(v.micOpen,false);assert.match(v.state,/^Paused/);
});
test('view: muted is separate from paused',()=>{
 const m=C.view({phase:'live',paused:false,muted:true,controls:ALL,draft:''});
 assert.equal(m.muteLabel,'Unmute microphone');assert.equal(m.micOpen,false);assert.equal(m.pauseLabel,'Pause');assert.match(m.state,/muted/);
 assert.equal(C.view({phase:'live',paused:false,muted:false,controls:ALL,draft:''}).muteLabel,'Mute microphone');
});
test('view: nothing is usable before the interview is live or after it ends',()=>{
 for(const phase of ['idle','preparing','connecting','ending','error']){
  const v=C.view({phase,paused:false,muted:false,controls:ALL,draft:'hello'});
  assert.ok(v.pauseDisabled&&v.repeatDisabled&&v.skipDisabled&&v.textDisabled&&v.sendDisabled&&v.muteDisabled,phase);
 }
});

// The compiled page: the controls exist once, are named for assistive technology, and the client talks only through the pure messages.
const page=fs.readFileSync(path.join(ROOT,'ATLAS_Voice.html'),'utf8');
test('page: buttons and the typed answer have ids, labels and a form (Enter sends)',()=>{
 for(const id of ['voicePause','voiceRepeat','voiceSkip','voiceTypeForm','voiceTypeInput','voiceTypeSend','voiceMute'])assert.equal(page.split('id="'+id+'"').length-1,1,id);
 for(const id of ['voicePause','voiceRepeat','voiceSkip','voiceTypeSend'])assert.match(page,new RegExp('aria-label="[^"]+"[^>]*id="'+id+'"'),id+' has an aria-label');
 assert.match(page,/<label class="visually-hidden" for="voiceTypeInput">/);assert.match(page,/<form[^>]*id="voiceTypeForm"/);
 assert.match(page,/id="voiceTypeInput"[^>]*maxlength="2000"/);assert.match(page,/id="voiceTypeSend"[^>]*type="submit"/);
 for(const id of ['voicePause','voiceRepeat','voiceSkip','voiceTypeForm'])assert.match(page,new RegExp('hidden=""[^>]*id="'+id+'"|id="'+id+'"[^>]*hidden=""'),id+' starts hidden until announced');
});
test('page: the pure module is built in before the client, once',()=>{
 assert.equal(page.split('AtlasVoiceControls=api').length-1,1);
 assert.ok(page.indexOf('root.AtlasVoiceControls=api')<page.indexOf("window.AtlasVoiceControls"),'defined before the client reads it');
});
test('client: sends only through the pure messages, only when announced, and only when live',()=>{
 const src=fs.readFileSync(path.join(ROOT,'src/voice-client.js'),'utf8');
 assert.ok(!/socket\.send\(JSON\.stringify\(\{type:'(pause|resume|repeat|skip|text)'/.test(src),'no hand-built control message');
 for(const k of ['pause','resume','repeat','skip','text'])assert.match(src,new RegExp("VC\\.message\\('"+k+"'|VC\\.message\\(paused\\?'resume':'pause'"),k);
 for(const k of ['pause','repeat','skip','text'])assert.match(src,new RegExp("supported\\('"+k+"'\\)"),k+' is gated on the announcement');
 assert.match(src,/controlsOn=Array\.isArray\(m\.controls\)\?m\.controls:null/);
 assert.match(src,/m\.type==='state'\)\{setPaused\(VC\.pausedFrom\(paused,m\)\)/);
 assert.match(src,/!muted&&!paused&&micPeak/,'the microphone-silence warning is not shown while paused');
 assert.match(src,/VC\.elapsed\(startedAt,pausedMs,pausedAt,Date\.now\(\)\)/,'paused time is not on the visible clock');
});
test('compiled page and sources agree (build.py was run)',()=>{
 const client=fs.readFileSync(path.join(ROOT,'src/voice-client.js'),'utf8'),ctl=fs.readFileSync(path.join(ROOT,'src/voice-controls.js'),'utf8');
 for(const f of ['ATLAS_Voice.html','ATLAS_Intelligence.html','ATLAS_Project_Intelligence.html','ATLAS_Voice_Studio.html']){
  const t=fs.readFileSync(path.join(ROOT,f),'utf8');assert.ok(t.includes(client)&&t.includes(ctl),f);
 }
});

// ---- X1: the typed interview (pure parts) ----
test('X1 typed turns: only the echo of a TURN clears the box; typed corrections (1001 and up) and other provenance do not',()=>{
 const ok={type:'user_text',provenance:'consultant_typed',item_id:'user-typed-3',text:'x'};
 assert.equal(C.typedAccepted(ok),true);
 for(const bad of [{...ok,item_id:'user-typed-1001'},{...ok,item_id:'user-3'},{...ok,provenance:'unverified_speech_recognition'},{...ok,type:'agent_text'},{...ok,item_id:7},null,undefined])assert.equal(C.typedAccepted(bad),false);
});
test('X1 typed refusal: a gentle line for a typed refusal only, one per reason, always saying the text is kept',()=>{
 for(const reason of ['speaking','composing','rate']){const n=C.typedRefusal({type:'quality_warning',refused:'text',reason});assert.ok(n&&/kept/.test(n),reason);}
 assert.match(C.typedRefusal({type:'quality_warning',refused:'text',reason:'speaking'}),/I.ll take that as soon as I finish speaking/);
 assert.match(C.typedRefusal({type:'quality_warning',refused:'text',reason:'composing'}),/^One moment/);
 assert.match(C.typedRefusal({type:'quality_warning',refused:'text',reason:'something new'}),/^One moment/,'an unknown reason still gets the safe line');
 assert.equal(C.typedRefusal({type:'quality_warning',message:'A speech segment could not be transcribed.'}),'');assert.equal(C.typedRefusal(null),'');assert.equal(C.typedRefusal({type:'user_text',refused:'text'}),'');
});
test('X1 afterAccepted: the box is cleared only when it still holds what was sent',()=>{
 assert.equal(C.afterAccepted('  hello ','  hello  ',{text:'hello'}),'');assert.equal(C.afterAccepted('hello','hello there',{text:'hello'}),'hello there');
 assert.equal(C.afterAccepted('hello','',{text:'hello'}),'');assert.equal(C.afterAccepted('a <system> b','a <system> b',{text:'a [quoted tag] b'}),'');assert.equal(C.afterAccepted('a','a b',{text:'a'}),'a b');
});
test('X1 conversation log reducer: order, new reply on \\n\\n, retract, kept private (and a late echo cannot undo it), restore interleaves',()=>{
 let l=[];const ev=(...a)=>{for(const m of a)l=C.logApply(l,m);return l;};
 ev({type:'agent_text',text:'Hi. '},{type:'agent_text',text:'Question?'},{type:'user_text',item_id:'user-typed-1',text:'Answer.'},{type:'agent_text',text:'\n\nNext?'},{type:'agent_text',text:'\n\nAgain.'});
 assert.deepEqual(l.map(e=>[e.who,e.text]),[['atlas','Hi. Question?'],['you','Answer.'],['atlas','Next?'],['atlas','Again.']]);
 ev({type:'agent_retract',chars:6});assert.equal(l.length,3,'a reply taken back completely leaves the log');assert.equal(l.at(-1).text,'Next?');
 ev({type:'user_text_private',items:['user-typed-1']});assert.deepEqual(l[1],{who:'you',item:'user-typed-1',text:C.PRIVATE_MARK,private:true});
 ev({type:'user_text',item_id:'user-typed-1',text:'Answer.'});assert.equal(l[1].text,C.PRIVATE_MARK);
 assert.deepEqual(C.logApply(null,null),[]);assert.deepEqual(C.logApply([{who:'you',text:'a',item:'i'}],{type:'user_text_private',items:'nope'}).length,1);
 const r=C.logRestore({agent:['A1','A2'],user:[{item_id:'u1',text:'U1'},{item_id:'u2',text:'U2'}]});assert.deepEqual(r.map(e=>e.text),['A1','U1','A2','U2']);
 assert.deepEqual(C.logRestore(null),[]);
 let many=[];for(let i=0;i<260;i++)many=C.logApply(many,{type:'user_text',item_id:'u'+i,text:'t'+i});assert.equal(many.length,200,'the log is bounded');
});
test('X1 page: the typed start, the log, the note and the dialog button exist once, named for assistive technology',()=>{
 for(const id of ['voiceStartText','textLog','voiceTypeWrap','voiceTypeNote','voiceControls','voiceConsentType'])assert.equal(page.split('id="'+id+'"').length-1,1,id);
 assert.match(page,/<div[^>]*aria-live="polite"[^>]*id="textLog"[^>]*role="log"|<div[^>]*id="textLog"[^>]*role="log"/);assert.match(page,/aria-label="Conversation"[^>]*id="textLog"/);
 assert.match(page,/id="voiceTypeNote"[^>]*role="status"|role="status"[^>]*id="voiceTypeNote"/);assert.match(page,/aria-describedby="voiceTypeNote"/);
 assert.match(page,/id="voiceStartText"[^>]*type="button">Type instead</);
});

// ---- v2.2 L1: the language selector and indicator ----
test('language: the selector sends exactly {type:"language",language}: "auto" or a language code, nothing else',()=>{
 assert.deepEqual(C.languageMessage('auto'),{type:'language',language:'auto'});assert.deepEqual(C.languageMessage('pl'),{type:'language',language:'pl'});assert.deepEqual(C.languageMessage('fil'),{type:'language',language:'fil'});
 for(const bad of ['','AUTO','pl-PL','x; drop','p','polish',null,undefined,42,{}])assert.equal(C.languageMessage(bad),null,String(bad));
});
test('language: the options are Auto first, then every language by its own name, a language with no voice says so',()=>{
 assert.deepEqual(C.languageOptions(undefined),[]);assert.deepEqual(C.languageOptions({list:[]}),[]);
 const o=C.languageOptions({auto:true,voice:['en'],list:[{code:'en',name:'English',native:'English'},{code:'fr',name:'French',native:'Français'},{code:'ar',name:'Arabic',native:'العربية'},{code:'<b>',name:'x'}]});
 assert.deepEqual(o,[{value:'auto',label:'Auto-detect'},{value:'en',label:'English'},{value:'fr',label:'Français · French (text replies)'},{value:'ar',label:'العربية · Arabic (text replies)'}]);
});
test('language: the indicator names the language, how it was chosen and whether ATLAS answers aloud; the selector follows a lock',()=>{
 assert.equal(C.languageView(null).hidden,true);assert.equal(C.languageView({code:'<x>'}).hidden,true);
 const a=C.languageView({code:'fr',name:'French',native:'Français',voice:true,locked:false,rtl:false});
 assert.deepEqual([a.hidden,a.text,a.value,a.dir,a.voice],[false,'Français · detected · ATLAS answers aloud','auto','ltr',true]);
 const b=C.languageView({code:'ar',name:'Arabic',native:'العربية',voice:false,locked:true,rtl:true,notice:'No voice.'});
 assert.deepEqual([b.text,b.value,b.dir,b.voice,b.notice],['العربية · fixed by you · ATLAS answers in text','ar','rtl',false,'No voice.']);
 assert.equal(C.languageInfo({type:'ready',language:{code:'en'}}).code,'en');assert.equal(C.languageInfo({type:'language',code:'de'}).code,'de');assert.equal(C.languageInfo({type:'ready'}),null);assert.equal(C.languageInfo(null),null);
});
test('language: the compiled page has the selector, the indicator, dir=auto on the typed answer and sends the lock with the start message',()=>{
 const html=fs.readFileSync(path.join(ROOT,'ATLAS_Voice.html'),'utf8');
 for(const id of ['voiceLanguage','voiceLanguageSelect','voiceLanguageState'])assert.equal(html.split('id="'+id+'"').length-1,1,id);
 assert.match(html,/<textarea[^>]*dir="auto"[^>]*id="voiceTypeInput"/);assert.match(html,/language:langChoice\(\)\|\|lang\(\),\.\.\.\(langChoice\(\)\?\{languageLock:true\}:\{\}\)/);
 assert.match(html,/role="status"[^>]*id="voiceLanguageState"|id="voiceLanguageState"[^>]*role="status"/);
});
