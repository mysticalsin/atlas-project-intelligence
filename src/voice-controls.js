/* ATLAS interview controls (Agent Brain v2.1 T9): the pure part of Pause / Resume, Repeat, Skip and the typed answer. No DOM, no socket, no
   clock of its own (the caller passes `now`). UMD so node tests cover the message shapes. The edge session announces what it understands in
   its `ready` event (`controls`); a gateway that does not announce them (the other voice routes) is never sent a control message. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AtlasVoiceControls=api;})(typeof globalThis!=='undefined'?globalThis:this,()=>{
'use strict';
const TEXT_MAX=2000; // the same bound as the server (TYPED_MAX_CHARS)
const NAMES=['pause','resume','repeat','skip','text'];

// What the browser may send: exactly the keys the session accepts, nothing else.
function message(kind,text){
 if(kind==='text'){const t=typeof text==='string'?[...text.trim()].slice(0,TEXT_MAX).join(''):'';return t?{type:'text',text:t}:null;}
 return NAMES.includes(kind)&&kind!=='text'?{type:kind}:null;
}
// The summary card's three messages (T11), exactly the keys the session accepts: {type:'correct',detail_id,text}, {type:'withhold',detail_id}, {type:'confirm_summary'}.
// A correction is the consultant's own typed words (at least five characters, like the ledger's quote rule, at most CORRECT_MAX). Anything else is null.
const CORRECT_MAX=1800,CORRECT_MIN=5,DETAIL=/^D-\d{3,6}$/;
function summaryMessage(kind,detailId,text){
 if(kind==='confirm_summary')return {type:'confirm_summary'};
 if(typeof detailId!=='string'||!DETAIL.test(detailId))return null;
 if(kind==='withhold')return {type:'withhold',detail_id:detailId};
 if(kind==='correct'){const t=typeof text==='string'?[...text.trim()].slice(0,CORRECT_MAX).join(''):'';return [...t].length>=CORRECT_MIN?{type:'correct',detail_id:detailId,text:t}:null;}
 return null;
}
// ---- Language (v2.2 L1): the selector and the indicator ----
// The server follows the language the consultant speaks or types and announces it (`ready.language`, the `language` event); the consultant can also fix one. A language
// ATLAS has no voice for is answered in text, and the page says so.
const LANG_CODE=/^[a-z]{2,3}$/;
function languageMessage(value){return value==='auto'||(typeof value==='string'&&LANG_CODE.test(value))?{type:'language',language:value}:null;}
// The selector's options from the bootstrap's `languages`: Auto first, then every language by its own name, a language with no voice marked.
function languageOptions(languages){
 const list=Array.isArray(languages&&languages.list)?languages.list:[],voice=new Set(Array.isArray(languages&&languages.voice)?languages.voice:[]);
 if(!list.length)return [];
 return [{value:'auto',label:'Auto-detect'},...list.filter(x=>x&&typeof x.code==='string'&&LANG_CODE.test(x.code)).map(x=>({value:x.code,label:(x.native&&x.native!==x.name?x.native+' · '+x.name:x.name||x.code)+(voice.has(x.code)?'':' (text replies)')}))];
}
const languageInfo=m=>m&&m.type==='language'?m:m&&m.type==='ready'&&m.language&&typeof m.language==='object'?m.language:null;
// What the indicator says and what the selector shows. info: the server's language object ({code,name,native,voice,locked,rtl,notice?}).
function languageView(info){
 if(!info||typeof info.code!=='string'||!LANG_CODE.test(info.code))return {hidden:true,text:'',value:'auto',dir:'auto',voice:true,notice:''};
 const name=typeof info.native==='string'&&info.native?info.native:typeof info.name==='string'&&info.name?info.name:info.code;
 return {hidden:false,text:name+' · '+(info.locked?'fixed by you':'detected')+' · '+(info.voice?'ATLAS answers aloud':'ATLAS answers in text'),value:info.locked?info.code:'auto',dir:info.rtl?'rtl':'ltr',voice:!!info.voice,notice:typeof info.notice==='string'?info.notice:''};
}
const supports=(ready,kind)=>Array.isArray(ready?.controls)&&ready.controls.includes(kind);

// The paused flag from a server `state` event (the interview machine). Anything else leaves it as it is.
const pausedFrom=(was,m)=>m&&m.type==='state'&&typeof m.state==='string'?m.state==='paused':was;

// Seconds on the interview clock: wall time since the start, less the paused stretches (paused: the stretch in progress too).
function elapsed(startedAt,pausedMs,pausedAt,now){return Math.max(0,Math.floor((now-startedAt-pausedMs-(pausedAt===null?0:now-pausedAt))/1000));}
const clock=s=>String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');

// What each control looks like. live: a conversation is running (not connecting or ending); ready: the server has announced its controls.
function view({phase,paused,muted,controls,draft}){
 const live=phase==='live',has=k=>Array.isArray(controls)&&controls.includes(k),text=typeof draft==='string'?draft.trim():'';
 return {
  pauseHidden:!has('pause'),pauseDisabled:!live||!has('pause'),pauseLabel:paused?'Resume':'Pause',pausePressed:!!paused,
  pauseAria:paused?'Resume the interview':'Pause the interview',
  repeatHidden:!has('repeat'),repeatDisabled:!live||paused||!has('repeat'),
  skipHidden:!has('skip'),skipDisabled:!live||paused||!has('skip'),
  textHidden:!has('text'),textDisabled:!live||!has('text'),sendDisabled:!live||!has('text')||!text,
  muteDisabled:!live||paused,muteLabel:muted?'Unmute microphone':'Mute microphone',
  // The orb never shows speech while paused: the browser's microphone is closed and nothing of hers is playing.
  orbPhase:paused?'paused':phase,micOpen:live&&!muted&&!paused,
  state:paused?'Paused · microphone off':muted?'Microphone muted · ATLAS may still speak':''
 };
}
// ---- Typed interview and typed turns (X1) ----
const PRIVATE_MARK='[kept private]'; // the same marker the server uses for an utterance the consultant kept private
// A typed turn the server took is echoed as user_text (provenance consultant_typed) with a TURN item id user-typed-N; typed corrections of the read-back are 1001 and up and
// are not turns. Only that echo clears the typed text: until then the text stays in the box.
const TYPED_ITEM=/^user-typed-(\d+)$/;
function typedAccepted(m){if(!m||m.type!=='user_text'||m.provenance!=='consultant_typed'||typeof m.item_id!=='string')return false;const x=TYPED_ITEM.exec(m.item_id);return !!x&&Number(x[1])<1000;}
// The gentle line under the box when the server did not take the typed turn (quality_warning with refused:'text'); '' for any other message.
const TYPED_NOTES={speaking:'I’ll take that as soon as I finish speaking. Your text is kept here: press Send again in a moment.',
 composing:'One moment, ATLAS is still replying. Your text is kept here: press Send again in a moment.',rate:'One moment, that was quick. Your text is kept here: press Send again in a moment.',
 timeout:'That did not go through. Your text is kept here: press Send to try again.'};
function typedRefusal(m){return m&&m.type==='quality_warning'&&m.refused==='text'?(TYPED_NOTES[m.reason]||TYPED_NOTES.composing):'';}
// What the box does once the server answered a typed turn: cleared only when the text in it is still the one that was sent (words typed meanwhile are never wiped).
function afterAccepted(sent,box,echo){const b=typeof box==='string'?box.trim():'',s=typeof sent==='string'?sent.trim():'',e=echo&&typeof echo.text==='string'?echo.text.trim():'';return b===''||b===s||b===e?'':box;}

// The conversation shown in a typed interview: ATLAS's replies and the consultant's turns, in order. A pure reducer over the server's events, so node tests cover it.
// entry: {who:'atlas'|'you', text, item?, private?}. agent_text starts a new ATLAS entry after a consultant turn, or when the server begins a new reply (\n\n).
const LOG_MAX=200;
function logApply(entries,m){
 const list=Array.isArray(entries)?entries.map(e=>({...e})):[];if(!m||typeof m!=='object')return list;
 if(m.type==='agent_text'&&typeof m.text==='string'){const last=list[list.length-1],fresh=/^\n\n/.test(m.text),text=m.text.replace(/^\n\n/,'');
  if(!last||last.who!=='atlas'||fresh){if(text.trim())list.push({who:'atlas',text});}else last.text+=text;}
 else if(m.type==='agent_retract'&&Number.isInteger(m.chars)&&m.chars>0){const last=list[list.length-1];if(last&&last.who==='atlas'){last.text=last.text.slice(0,Math.max(0,last.text.length-m.chars));if(!last.text.trim())list.pop();}}
 else if(m.type==='user_text'&&typeof m.text==='string'){const at=typeof m.item_id==='string'?list.findIndex(e=>e.who==='you'&&e.item===m.item_id):-1;
  if(at>=0)list[at].text=list[at].private?PRIVATE_MARK:m.text;else list.push({who:'you',item:typeof m.item_id==='string'?m.item_id:'',text:m.text.slice(0,2000)});}
 else if(m.type==='user_text_private'&&Array.isArray(m.items)){const set=new Set(m.items.filter(x=>typeof x==='string'));for(const e of list)if(e.who==='you'&&set.has(e.item)){e.text=PRIVATE_MARK;e.private=true;}}
 return list.slice(-LOG_MAX);
}
// A resumed interview: the server sends the consultant's turns and ATLAS's replies as two lists; ATLAS speaks first, so they alternate.
function logRestore(m){
 const agent=Array.isArray(m&&m.agent)?m.agent.filter(x=>typeof x==='string'):[],user=Array.isArray(m&&m.user)?m.user.filter(u=>u&&typeof u.text==='string'):[];
 let list=[];for(let i=0;i<Math.max(agent.length,user.length);i++){if(i<agent.length)list=logApply(list,{type:'agent_text',text:'\n\n'+agent[i]});if(i<user.length)list=logApply(list,{type:'user_text',item_id:user[i].item_id,text:user[i].text});}
 return list;
}
return {TEXT_MAX,CORRECT_MAX,NAMES,PRIVATE_MARK,TYPED_NOTES,message,summaryMessage,languageMessage,languageOptions,languageInfo,languageView,supports,pausedFrom,elapsed,clock,view,typedAccepted,typedRefusal,afterAccepted,logApply,logRestore};
});
