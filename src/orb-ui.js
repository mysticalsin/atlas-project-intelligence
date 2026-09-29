/* Visual state is driven by actual audio meters. Preview is isolated and labelled. */
(()=>{'use strict';
 const $=id=>document.getElementById(id),signals=new AtlasOrb.SignalState();let paused=false,last='',previewAt=null,previewTimer=null,previewKind='sequence',spectrum=null;
 const orb=AtlasOrb.create($('orbCanvas'),{onError:m=>{$('orbDisplayNotice').textContent=m;$('orbDisplayNotice').hidden=!m;},onMotion:(reduced,manual)=>{$('orbMotion').textContent=reduced?'Reduced motion enabled':manual?'Resume motion':'Pause motion';$('orbMotion').disabled=reduced;$('orbMotion').setAttribute('aria-pressed',String(reduced||manual));$('orbQuickPause').disabled=reduced;$('orbQuickPause').setAttribute('aria-pressed',String(reduced||manual));$('orbQuickPause').setAttribute('aria-label',reduced?'Reduced motion enabled':manual?'Resume orb animation':'Pause orb animation');}});
 // The idle label follows the page mode (WOW_ZERO_CONFIG §3.3); a page opened from a file stays "Not connected".
 const IDLE={live:'Ready',offline:'Not connected',network:'Not reachable',expired:'Signed out'},idleName=()=>IDLE[window.AtlasAuth?.mode]||'Not connected';
 const names={idle:'Not connected',connecting:'Connecting to voice',listening:'Listening',speaking:'ATLAS is speaking',muted:'Microphone muted',processing:'Preparing notes',error:'Connection stopped'};
 const motifCopy={
 idle:['Poised.','A quiet turning body. No fake talking when there is no audio.','Ambient only'],
 listening:['Attentive.','A slight lean toward you; a restrained response to microphone input.','Input-reactive posture'],
 speaking:['Articulate.','The body deforms and turns with played speech. No outward waves.','Playback-driven shape and light'],
 muted:['Quiet.','Input motion is off. ATLAS audio can still move the sculpture.','Microphone muted'],
 connecting:['Connecting.','Preparing a voice session. The model is not yet ready.','Pending connection'],
 processing:['Preparing notes.','The microphone is off while the gateway finishes any enabled notes.','Not an understanding indicator'],
 error:['Connection stopped.','Microphone off. Check the connection before starting again.','Awaiting your action']
 };
 function describe(kind,preview=false){
  const v=motifCopy[kind]||motifCopy.idle;
  $('motifTitle').textContent=v[0];$('motifDescription').textContent=v[1];$('motifPeriod').textContent=v[2];$('motifGlyph').dataset.motif=kind;
  $('motifSource').textContent=preview?'VISUAL PREVIEW / NO AUDIO':signals.phase==='live'?'CONNECTED AUDIO STATE':kind==='idle'?'AMBIENT / MICROPHONE OFF':'INTERFACE STATE';
 }
 function update(){
  const s=signals.snapshot(performance.now());if(previewAt!==null)return;
  orb.setState(s.state);orb.setLevels(s.input,s.output,spectrum);$('voicePanel').dataset.orbState=s.state;$('voicePanel').dataset.phase=s.phase;
  window.dispatchEvent(new CustomEvent('atlas-orb-state',{detail:{state:s.state,phase:s.phase,muted:s.muted,preview:false}}));
  const label=(s.state==='idle'?idleName():names[s.state])+(s.state==='speaking'&&s.muted?' · microphone muted':'');
  if(label!==last){describe(s.state);last=label;$('orbStateCaption').textContent=label;$('orbAccessibleState').textContent=label;}
  $('orbInputWord').textContent=s.phase==='live'?(s.muted?'Muted':s.inputActive?'Hearing you':'Microphone on'):s.phase==='connecting'?'Local only':'Microphone off';
  $('orbOutputWord').textContent=s.state==='speaking'?'Playing model audio':'No playback';
  $('orbActivate').setAttribute('aria-label',s.phase==='live'?(s.muted?'Unmute microphone':'Mute microphone'):'Start voice interview');
  $('orbActivate').disabled=['preparing','connecting','ending'].includes(s.phase);
  $('studioPreview').disabled=!['idle','error'].includes(s.phase);document.querySelectorAll('[data-orb-preview]').forEach(b=>b.disabled=!['idle','error'].includes(s.phase));
  document.querySelector('.orb-meters').hidden=s.phase!=='live';
  $('orbInteractionHint').textContent=s.phase==='live'?'Click the orb to mute or unmute. End closes the microphone.':s.phase==='connecting'?'Preparing the connection. You can cancel at any time.':'Microphone off. You choose when the conversation starts.';
 }
 function stopPreview(){if(previewAt===null)return;previewAt=null;clearInterval(previewTimer);previewTimer=null;$('previewNotice').hidden=true;$('voicePanel').dataset.preview='false';$('studioPreview').textContent='Preview the orb';$('studioPreview').setAttribute('aria-pressed','false');document.querySelectorAll('[data-orb-preview]').forEach(b=>b.setAttribute('aria-pressed','false'));last='';update();}
 function startPreview(kind='sequence'){
  if(typeof kind!=='string')kind='sequence';
  if(!['sequence','idle','listening','speaking','muted','processing','connecting'].includes(kind))kind='sequence';
  if(previewAt!==null){const same=previewKind===kind;stopPreview();if(same)return;}
  if(!['idle','error'].includes(signals.phase))return;
  previewKind=kind;orb.restart(kind==='sequence'?'listening':kind);previewAt=performance.now();$('previewNotice').hidden=false;$('voicePanel').dataset.preview='true';$('studioPreview').textContent='Stop preview';$('studioPreview').setAttribute('aria-pressed','true');
  document.querySelectorAll('[data-orb-preview]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.orbPreview===kind)));
  const frame=()=>{
   const elapsed=performance.now()-previewAt,p=kind==='sequence'?AtlasStudioCore.previewFrame(elapsed):AtlasStudioCore.patternFrame(kind,elapsed);
   if(p.complete){stopPreview();return;}
   orb.setState(p.phase);orb.setLevels(p.input,p.output);$('voicePanel').dataset.orbState=p.phase;
   $('orbStateCaption').textContent='Visual preview · '+p.name;$('previewPhase').textContent=p.name;
   const announcement='Visual preview only: '+p.name;if($('orbAccessibleState').textContent!==announcement)$('orbAccessibleState').textContent=announcement;
   describe(p.phase,true);window.dispatchEvent(new CustomEvent('atlas-orb-state',{detail:{state:p.phase,phase:'idle',muted:false,preview:true}}));
  };
  frame();previewTimer=setInterval(frame,90);
 }
 const clock=setInterval(()=>{if(!document.hidden&&signals.phase==='live')update();},100);
 // The orb does the start control's job: Start on the live site, the "Open ATLAS" link in an offline copy, Try again when unreachable.
 $('orbActivate').onclick=()=>{stopPreview();if(signals.phase==='live'){$('voiceMute').click();return;}if(['preparing','connecting','ending'].includes(signals.phase))return;
  const home=$('voiceOpenHome'),retry=$('voiceNetwork');if(home&&!home.hidden&&home.href)home.click();else if(retry&&!retry.hidden)$('voiceRetry').click();else $('voiceStart').click();};
 window.addEventListener('atlas-auth',()=>{last='';update();});
 $('orbMotion').onclick=()=>{paused=!paused;orb.pause(paused);};
 $('orbTranscriptToggle').onclick=()=>{const el=$('orbTranscript');el.hidden=!el.hidden;$('orbTranscriptToggle').setAttribute('aria-expanded',String(!el.hidden));$('orbTranscriptToggle').textContent=el.hidden?'Show spoken text':'Hide spoken text';};
 $('replayPattern').onclick=()=>{if(previewAt===null)return;const kind=previewKind;stopPreview();startPreview(kind);};
 $('studioPreview').onclick=()=>{if(previewAt!==null)stopPreview();else startPreview();};document.querySelectorAll('[data-orb-preview]').forEach(b=>b.onclick=()=>startPreview(b.dataset.orbPreview));$('orbQuickPause').onclick=()=>$('orbMotion').click();$('orbQuickFocus').onclick=()=>$('studioFocus').click();$('orbIntensity').oninput=e=>{const v=Number(e.target.value)/100;orb.setIntensity(v);$('orbIntensityValue').textContent=v<.4?'Subtle':v>.8?'Expressive':'Balanced';};
 $('studioAppearance').onclick=()=>{const el=$('appearancePanel');el.hidden=!el.hidden;$('studioAppearance').setAttribute('aria-expanded',String(!el.hidden));};
 document.querySelectorAll('[data-palette]').forEach(b=>b.onclick=()=>{const p=b.dataset.palette;orb.setPalette(p);$('voicePanel').dataset.palette=p;document.querySelectorAll('[data-palette]').forEach(t=>t.setAttribute('aria-pressed',String(t===b)));});
 function contextToggle(open){const el=$('studioProjectDrawer');el.hidden=!(open??el.hidden);$('studioProject').setAttribute('aria-expanded',String(!el.hidden));$('studioContextMobile').setAttribute('aria-expanded',String(!el.hidden));if(!el.hidden)el.scrollIntoView({block:'nearest',behavior:'instant'});}
 $('studioProject').onclick=()=>contextToggle();$('studioContextMobile').onclick=()=>contextToggle();$('studioCloseContext').onclick=()=>contextToggle(false);
 $('studioChooseProject').onclick=()=>document.querySelector('header [data-view=projects]').click();
 $('studioConnection').onclick=()=>{stopPreview();$('voiceSetup').click();};
 $('studioFocus').onclick=()=>{const active=document.body.classList.toggle('studio-focus');
  // Focus also asks the browser for true full screen of the voice panel (user gesture); Esc exits both.
  try{const panel=$('voicePanel');if(active&&panel?.requestFullscreen&&!document.fullscreenElement)panel.requestFullscreen().catch(()=>{});else if(!active&&document.fullscreenElement)document.exitFullscreen().catch(()=>{});}catch{}$('studioFocus').setAttribute('aria-pressed',String(active));$('studioFocus').textContent=active?'Exit focus':'Focus mode';$('orbQuickFocus').setAttribute('aria-label',active?'Exit focus mode':'Enter focus mode');orb.renderOnce();};
 document.addEventListener('fullscreenchange',()=>{const full=!!document.fullscreenElement;
  // Full screen is granted asynchronously: if focus mode was left before it arrived, leave full screen too.
  if(full&&!document.body.classList.contains('studio-focus')){document.exitFullscreen().catch(()=>{});return;}document.body.classList.toggle('orb-fullscreen',full);if(!full&&document.body.classList.contains('studio-focus'))$('studioFocus').click();orb.renderOnce();});
 $('studioSave').onclick=()=>$('profileButton').click();$('studioBackup').onclick=()=>$('backupQuick').click();
 const storageObserver=new MutationObserver(()=>{$('studioSave').textContent=$('storageStatus').textContent;});storageObserver.observe($('storageStatus'),{childList:true,subtree:true});$('studioSave').textContent=$('storageStatus').textContent;
 function onView(){window.dispatchEvent(new Event('atlas-studio-project'));const active=!$('interview').hidden;document.body.classList.toggle('studio-view',active);if(!active)stopPreview();}
 window.addEventListener('atlas-context',onView);onView();
 document.addEventListener('keydown',e=>{const typing=e.target.closest('input,textarea,select,[contenteditable=true]');if(typing||document.querySelector('dialog[open]')||e.ctrlKey||e.metaKey||e.altKey)return;if(e.key.toLowerCase()==='f'&&!$('interview').hidden){e.preventDefault();$('studioFocus').click();}else if(e.key==='Escape'){stopPreview();if(document.body.classList.contains('studio-focus'))$('studioFocus').click();}});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stopPreview();});
 window.AtlasOrbUI={state(phase,muted=false){if(!['idle','error'].includes(phase))stopPreview();signals.setPhase(phase,muted);update();},levels(mic,speaker,bands=null){spectrum=bands;signals.levels(mic,speaker,performance.now());update();},reset(){signals.levels(0,0,performance.now());signals.lastInput=-1e9;signals.lastOutput=-1e9;update();},stopPreview,startPreview,inspect:()=>({...orb.inspect(),preview:previewAt!==null,signals:signals.snapshot(performance.now())}),renderer:orb};
 $('orbMotion').disabled=orb.inspect().reducedMotion;if(orb.inspect().reducedMotion){$('orbMotion').textContent='Reduced motion enabled';$('orbMotion').setAttribute('aria-pressed','true');}
 window.addEventListener('pagehide',event=>{stopPreview();if(!event.persisted){clearInterval(clock);storageObserver.disconnect();orb.destroy();}});update();
})();
