/* ATLAS disputes on the review screen and the owner's status panel (D-DSR, v2.2): pure helpers, no DOM, no network. UMD so node tests cover them.
   Nothing here decides anything: which buttons are enabled comes from the record's `actions`, which the server builds from the policy gate, the
   review machine and the adjudication rule (the rejecter adjudicates only when they are the project's only eligible reviewer). This file only says,
   in plain words, what the state is, what each side said, and why a button is not available. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AtlasDisputeCore=api;})(typeof window!=='undefined'?window:globalThis,function(){'use strict';
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{},arr=v=>Array.isArray(v)?v:[],str=(v,n=500)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,n):'';

/* ---------- the state badge ---------- */
const BADGES={rejected:{text:'Rejected',tone:'bad'},disputed:{text:'Disputed',tone:'work'},upheld:{text:'Rejection upheld',tone:'bad'},accepted:{text:'Rejection accepted',tone:'bad'},reopened:{text:'Reopened after a dispute',tone:'ok'}};
// The record's dispute state, or null when it has never been rejected or disputed (nothing to show).
function stateKey(rec){const r=obj(rec),s=str(r.state,40),a=obj(r.adjudication);
 if(s==='closed_rejected')return a.outcome==='accepted_by_owner'?'accepted':'upheld';
 if(s==='disputed')return 'disputed';
 if(s==='rejected')return 'rejected';
 if(a.outcome==='reopened'&&s==='reviewer_queue')return 'reopened'; // only while it waits for the new review
 return null;}
function badge(rec){const k=stateKey(rec);return k?{key:k,...BADGES[k]}:null;}

/* ---------- what each side said ---------- */
const OUTCOME={upheld:'upheld the rejection',reopened:'overturned the rejection and reopened the review',accepted_by_owner:'accepted the rejection'};
function story(rec){const r=obj(rec),rej=obj(r.rejection&&Object.keys(obj(r.rejection)).length?r.rejection:obj(r.dispute).rejection),dis=obj(r.dispute),adj=obj(r.adjudication),out=[];
 if(rej.by)out.push({key:'rejection',who:str(rej.by,100),label:'Rejected by',text:str(rej.reason)||'No reason was given.',at:str(rej.at,40)});
 if(dis.by)out.push({key:'dispute',who:str(dis.by,100),label:'Disputed by',text:str(dis.rationale)||'No reason was given.',at:str(dis.at,40)});
 if(dis.by&&dis.adjudicator)out.push({key:'adjudicator',who:str(dis.adjudicator,100),label:'Asked to settle it',text:'',at:''});
 if(adj.by&&OUTCOME[adj.outcome])out.push({key:'adjudication',who:str(adj.by,100),label:'Settled by',text:'Outcome: '+OUTCOME[adj.outcome]+'.'+(str(adj.reason)?' '+str(adj.reason):'')+(adj.single_reviewer?' Recorded as a single-reviewer adjudication.':''),at:str(adj.at,40),single:!!adj.single_reviewer});
 return out;}

/* ---------- the controls, and why one is not available ---------- */
const REVIEWER=[['uphold_rejection','Uphold the rejection'],['reopen_review','Overturn and review again']];
const OWNER=[['dispute','Raise a dispute'],['accept_rejection','Accept the rejection']];
function why(r,action,owner){const s=str(r.state,40),p=obj(r.adjudication_policy);
 if(owner){if(s==='disputed')return 'Your dispute is open. A reviewer settles it.';if(s==='closed_rejected')return 'This dispute is settled.';if(s!=='rejected')return 'There is no rejection to dispute.';return 'This is not available to you right now.';}
 if(s!=='disputed')return s==='closed_rejected'?'This dispute is settled.':'There is no open dispute to settle.';
 if(p.you_rejected&&!p.may_adjudicate)return p.reviewers===null||p.reviewers===undefined?'You rejected this, so another reviewer settles the dispute.':'You rejected this and another reviewer is available, so that reviewer settles the dispute.';
 return 'Your role cannot settle this dispute.';}
function model(rec){const r=obj(rec),b=badge(r);if(!b)return null;
 const acts=new Set(arr(r.actions)),owner=r.access==='owner'||r.mine===true,p=r.adjudication_policy?obj(r.adjudication_policy):null;
 const controls=(owner?OWNER:REVIEWER).map(([action,label])=>{const enabled=acts.has(action);return {action,label,enabled,why:enabled?'':why(r,action,owner)};});
 const open=controls.some(c=>c.enabled);
 let note='';
 if(!owner&&open&&p&&p.rule==='single_reviewer')note='You are the only reviewer for this project, so you settle this dispute yourself, even though you rejected it. It is recorded as a single-reviewer adjudication.';
 else if(!owner&&open)note='Read both views, then decide. The consultant reads your reason.';
 else if(owner&&acts.has('dispute'))note='If you think the rejection is wrong, say why. A reviewer reads both views and decides.';
 return {badge:b,owner,story:story(r),controls,open,note,
  reasonLabel:owner?'Your reason':'Your reason (the consultant reads it)',adjudicatorField:owner&&acts.has('dispute'),revision:Number.isInteger(r.revision)?r.revision:null,id:str(r.id,80)};}

/* ---------- the request, checked before it is sent ---------- */
const NEED={dispute:'Say why you dispute the rejection.',accept_rejection:'Say why you accept the rejection.',uphold_rejection:'Say why the rejection stands.',reopen_review:'Say why the rejection is overturned.'};
const EMAIL=/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
function request(m,action,reason,adjudicator=''){const t=str(reason,500),a=str(adjudicator,100);
 if(!m||!m.controls.some(c=>c.action===action&&c.enabled))return {error:'This is not available to you right now.'};
 if(!t)return {error:NEED[action]||'Say why.'};
 if(a&&!EMAIL.test(a))return {error:'Enter the email address of the person who should settle it, or leave it empty.'};
 const body={action,expected_revision:m.revision,reason:t};if(action==='dispute'){body.rationale=t;if(a)body.adjudicator=a;}
 return {body};}
const ERRORS={ADJUDICATOR_IS_REJECTER:'You rejected this and another reviewer is available, so that reviewer settles the dispute.',SELF_APPROVAL:'You cannot settle a dispute about your own work.',
 REVISION_MISMATCH:'This changed while you were reading. Open it again.',TRANSITION_NOT_ALLOWED:'Someone already decided this. Open it again.',EVENT_ACTOR_NOT_ALLOWED:'ATLAS did not allow that for your role.'};
function errorText(e){const m=str(e&&e.message,300),code=str(e&&e.reason,80).split(':')[0]||(/Not allowed: ([A-Z_]+)/.exec(m)||[])[1]||'';
 if(ERRORS[code])return ERRORS[code];if(e&&e.human&&m)return m;return 'That was not saved. Your text is still here; try again.';}
const DONE={dispute:'Your dispute is raised. A reviewer reads both views and decides.',accept_rejection:'You accepted the rejection.',uphold_rejection:'The rejection is upheld. The consultant is told why.',reopen_review:'The rejection is overturned. The record is back in review.'};

return {badge,stateKey,story,model,request,errorText,DONE,BADGES};
});
