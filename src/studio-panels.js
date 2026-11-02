/* Small UI projections. No remote retrieval, invented project facts or inferred progress. */
(()=>{'use strict';const $=id=>document.getElementById(id);
 function syncProject(){
  const c=window.ATLAS_VOICE_BRIDGE?.context(),p=c&&!c.isNew?c.project:null; // the new-project placeholder is not a project
  $('contextProjectTitle').textContent=p?.title||'Your next great story.';
  $('contextProjectMeta').textContent=p?[c.display?.consultant,c.display?.role].filter(Boolean).join(' · '):'Choose a project. ATLAS will help you explain what you actually did.';
  $('contextProjectStage').textContent=p?.stage||'No project selected';$('contextProjectSector').textContent=p?.sector||'Private workspace';
  let raw=null;const s=window.ATLAS_LOCAL?.snapshot();if(s&&c&&p)raw=s.profiles?.find(u=>u.id===c.workspaceId)?.projects?.find(q=>q.id===p.id); // projects may exist with none selected (restored from the library)
  $('studioSample').hidden=!!p;if(raw?.sample)$('contextProjectSector').textContent='FICTIONAL / '+(p.sector||'Example');
  const present=Array.from({length:6},(_,i)=>!!p?.answers?.[i]?.trim()&&!raw?.deferred?.[i]);
  const count=present.filter(Boolean).length;$('captureCount').replaceChildren(document.createTextNode(String(count)),Object.assign(document.createElement('span'),{textContent:'/ 6'}));$('captureRing').style.setProperty('--capture',String(count/6*100));
  const wrap=$('captureSteps');wrap.replaceChildren();['Context & contribution','Approach & outcome','Evidence & relevance'].forEach((t,i)=>{const n=Number(present[i*2])+Number(present[i*2+1]),el=document.createElement('span');el.textContent=t;el.dataset.n=String(n);el.classList.toggle('captured',n===2);wrap.append(el);});
 }
 function syncState(e){const s=e.detail;if(!s)return;const label=$('connectionStateLabel'),info=$('connectionStateDetail');
  const titles={idle:'Ready when you are',listening:'Listening to you',speaking:'ATLAS is speaking',muted:'Microphone muted',connecting:'Connecting to voice',processing:'Finishing your session',error:'Connection stopped'};
  const typed=!s.preview&&$('voicePanel').dataset.input==='text'&&['preparing','connecting','live'].includes(s.phase); // a typed interview (X1): no microphone anywhere
  label.textContent=typed?(s.phase==='live'?'Typed interview':'Getting ready'):s.preview?'Motion preview':titles[s.state]||'Ready when you are';
  info.textContent=typed?(s.phase==='live'?'Typed interview. No microphone is used; ATLAS answers in text.':'Connecting to ATLAS. No microphone is used.'):s.preview?'Silent demonstration. No microphone or model connection.':s.phase==='live'?(s.muted?'Microphone muted. Model playback remains enabled.':'Voice session connected. You can interrupt naturally.'):(s.phase==='preparing'?'Checking the connection; microphone off.':s.phase==='connecting'?'Microphone may be open locally; waiting for the ready signal.':s.phase==='ending'?'Microphone off. Completing any enabled notes.':'Microphone off. No model connected.');
  $('connectionStateLabel').dataset.live=String(!s.preview&&s.phase==='live');
 }
 // Offline copy: the card opens the live workspace (the same real link as the start control); otherwise the connection panel.
 $('cardConnection').onclick=()=>{const home=$('voiceOpenHome');if(home&&!home.hidden&&home.href)home.click();else $('studioConnection').click();};
 window.addEventListener('atlas-context',syncProject);window.addEventListener('atlas-studio-project',syncProject);window.addEventListener('atlas-orb-state',syncState);syncProject();
  // Avoid historical product-title leakage when the previous source shell is reused.
 document.title='ATLAS Project Intelligence · Mantu';
})();
