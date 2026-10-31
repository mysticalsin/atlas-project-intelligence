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
return {TEXT_MAX,CORRECT_MAX,NAMES,message,summaryMessage,supports,pausedFrom,elapsed,clock,view};
});
