/* Workflow status cards (T15, plan §4, D12, D17; pack: Canonical Workflow "UI progress"). Pure and deterministic: no network, no storage,
   no DOM. It turns the server's status view (GET /api/library/evidence/:id/status) into what a person reads: one card per branch, in
   the pack's order, with plain words, a "Mock — not connected" badge on every destination that is not really connected, and an overall
   line that can NEVER say "complete" while any card is pending, failed, held, mock-acknowledged or unknown. Nothing the server sends is
   trusted for display: labels come from here, reason codes are mapped or shown as a bounded code, never as markup. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AtlasWorkflowCore=api;})(typeof window!=='undefined'?window:globalThis,function(){'use strict';
const ORDER=['evidence','maap','project_review','dna','michat','imp','spotlight'];
const LABELS={evidence:'Evidence',maap:'MAAP Review',project_review:'Project Review',dna:'DNA',michat:'MiChat CV',imp:'IMP',spotlight:'Spotlight'};
const DESTINATIONS=['dna','michat','imp','spotlight'];
const MOCK_BADGE='Mock — not connected';
// display_status -> words and tone. Tones: ok, work, wait, mock, bad, hold, idle.
const STATUS={approved:['Approved','ok'],in_review:['In review','work'],draft:['Draft','idle'],needs_clarification:['Needs clarification','wait'],rejected:['Rejected','bad'],disputed:['Disputed','bad'],
  pending:['Pending','wait'],waiting_permission:['Waiting for permission','wait'],in_progress:['In progress','work'],mock_acknowledged:['Mock acknowledged — not synced','mock'],
  sync_complete:['Synced','ok'],failed:['Failed — needs a person','bad'],needs_reconciliation:['Needs reconciliation','bad'],blocked_external:['Blocked — not connected','bad'],
  awaiting_approval:['Awaiting approval','wait'],held:['Held — not published','hold'],published:['Published','ok'],impact_review:['Impact review needed','bad'],
  withdrawn:['Withdrawn','idle'],superseded:['Superseded','idle'],not_started:['Not started','idle']};
const BRANCH_STATUS={spotlight:{draft:['Story draft','idle'],held:['Held by the test CMS — not published','hold']}};
// What "finished" is, per card. MAAP and Project Review never close in this build (no rubric), so an overall "complete" cannot appear yet.
const COMPLETE={evidence:['approved'],maap:['closed'],project_review:['closed'],dna:['sync_complete'],michat:['sync_complete'],imp:['sync_complete'],spotlight:['published']};
const ATTENTION=['failed','needs_reconciliation','impact_review','blocked_external','rejected','disputed','withdrawn'];
const GATES={claim_level_evidence:'claim-level evidence',project_owner_approval:'project owner approval',customer_permission_if_required:'customer permission',confidentiality_review:'confidentiality review',
  privacy_legal_review_if_required:'privacy and legal review',brand_approval:'brand approval',exact_revision_publication_authorization:'publication authorization'};
const PURPOSES={internal_knowledge:'internal knowledge',cv:'CV use',bid_client_facing:'bids',public_spotlight:'public Spotlight',skills_profile:'skills profile',matching:'matching'};
const REASONS={MAAP_NOT_CONFIGURED:'The MAAP rubric has not been configured by its process owner.',PROJECT_REVIEW_NOT_CONFIGURED:'The Project Review rubric has not been configured by its process owner.',
  MOCK_NOT_SYNCED:'A test acknowledgement only. Nothing reached a real system.',MOCK_CMS_NOT_PUBLISHED:'The test CMS holds it. Nothing is published.',ADAPTERS_OFF:'Connections are switched off.',
  BLOCKED_EXTERNAL:'Needs the system owner’s endpoint and credentials.',AWAITING_EVIDENCE_APPROVAL:'Starts when the evidence is approved.',DESTINATION_NEWER_REVISION:'The destination holds a newer revision. It was not overwritten.',
  SOURCE_SUPERSEDED:'The evidence changed. This delivery was stopped.',EVIDENCE_REVISION_CHANGED:'The evidence changed after this was derived.',WITHDRAWN_AFTER_APPROVAL:'The evidence was withdrawn after approval.',
  IMPACT_REVIEW_COMPLETED:'The impact review is complete.',BRANCH_ERROR:'This branch hit an error. The others were not affected.',ADAPTER_EXCEPTION:'The destination did not answer.',NO_ACK:'The destination did not acknowledge.',
  DESTINATION_ACK_NOT_BOUND_TO_REVISION:'The acknowledgement does not match this revision.',DESTINATION_ACK_NOT_LIVE:'Only a test acknowledgement.',NO_STORY_FOR_REVISION:'There is no story for this revision yet.'};
const CODE=/^[A-Za-z0-9_.:-]{1,80}$/;
const word=(map,id)=>Object.hasOwn(map,id)?map[id]:null;
// A stable reason code (CODE or CODE:detail) in words. Unknown codes are shown as the bounded code itself, never as markup.
function reasonText(code){
 if(typeof code!=='string'||!CODE.test(code))return '';
 const [head,...rest]=code.split(':'),detail=rest.join(':');
 if(code.startsWith('SPOTLIGHT_GATE_OPEN:'))return 'Waiting for '+(word(GATES,detail)||'a gate')+'.';
 if(head==='PERMISSION_REVOKED'||head==='PURPOSE_REVOKED')return 'Permission for '+(word(PURPOSES,detail)||'this use')+' was withdrawn.';
 if(head==='PURPOSE_NOT_GRANTED')return 'No permission for '+(word(PURPOSES,detail)||'this use')+' yet.';
 if(head==='PURPOSE_GRANT_NOT_BOUND_TO_REVISION')return 'The permission for '+(word(PURPOSES,detail)||'this use')+' was given for an earlier revision.';
 if(head==='PURPOSE_EXPIRED')return 'Permission for '+(word(PURPOSES,detail)||'this use')+' has expired.';
 if(head==='REQUIREMENT_UNMET')return 'Not met yet: '+detail.replace(/_/g,' ')+'.';
 if(code.startsWith('PROJECTION_'))return 'The public version could not be built yet.';
 return word(REASONS,code)||('Reported: '+code);
}
const known=id=>Object.hasOwn(STATUS,id);
// One card, ready to render. `card` is untrusted.
function cardModel(card){
 const c=card&&typeof card==='object'?card:{},branch=ORDER.includes(c.branch)?c.branch:'',ds=typeof c.display_status==='string'?c.display_status:'';
 const pair=(branch&&word(word(BRANCH_STATUS,branch)||{},ds))||word(STATUS,ds)||['Unknown status','bad'];
 const mock=DESTINATIONS.includes(branch)&&c.mock!==false;
 return {branch,label:LABELS[branch]||'Unknown',displayStatus:known(ds)?ds:'unknown',statusText:pair[0],tone:pair[1],mock,badge:mock?MOCK_BADGE:'',
  reasonText:reasonText(c.reason),updatedAt:typeof c.updated_at==='string'?c.updated_at.slice(0,40):''};
}
const isComplete=m=>(COMPLETE[m.branch]||[]).includes(m.displayStatus);
// The whole view: seven cards in the pack's order (a missing or repeated card is a gap, never filled with a guess) and an overall line.
function model(view){
 const v=view&&typeof view==='object'?view:{},list=Array.isArray(v.cards)?v.cards:[];
 const cards=ORDER.map(b=>cardModel(list.find(c=>c&&c.branch===b)||{branch:b,display_status:'unknown'}));
 const complete=cards.every(isComplete),attention=cards.some(m=>ATTENTION.includes(m.displayStatus)||m.displayStatus==='unknown');
 // Never "complete" unless every card is, whatever the server said.
 const status=complete&&v.overall?.complete===true?'complete':attention?'attention':'in_progress';
 const text=status==='complete'?'Everything is finished.':status==='attention'?'Needs attention: at least one step has not worked or was flagged.':'In progress: not every step is finished.';
 const mocks=cards.filter(m=>m.mock).length;
 return {cards,overall:{status,text,complete:status==='complete'},note:mocks?'“'+MOCK_BADGE+'” means the step used a test destination. Nothing was sent to a real system.':'',
  adapters:['off','mock','blocked'].includes(v.adapters)?v.adapters:'off'};
}
// D17: a reference that is "published" in the library is shared with colleagues inside ATLAS. It is not a Spotlight story and is never shown as one.
const LIBRARY={in_review:'In review',needs_work:'Needs work',changes_requested:'Changes requested',awaiting_validation:'Awaiting N+1',published:'Shared in internal library',withdrawn:'Withdrawn'};
const libraryStatusLabel=s=>word(LIBRARY,s)||'';
// The evidence picker's one-line label for a record from GET /evidence.
const itemLabel=x=>{const i=x&&typeof x==='object'?x:{};return [typeof i.project_ref==='string'&&i.project_ref?i.project_ref.slice(0,40):'Interview evidence',word(STATUS,{evidence_draft:'draft',reviewer_queue:'in_review',submitted_for_review:'in_review',approved:'approved'}[i.state]||'')?.[0]||String(i.state||'').replace(/_/g,' ').slice(0,30),'revision '+(Number.isInteger(i.revision)?i.revision:'?')].join(' · ');};
return {ORDER,LABELS,DESTINATIONS,MOCK_BADGE,STATUS,COMPLETE,reasonText,cardModel,model,libraryStatusLabel,itemLabel};
});
