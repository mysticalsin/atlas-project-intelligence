/* ATLAS Ask panel in the Library (WOW_SPEC F6.3): a typed question, the map of result countries, people listed by record membership
   (never ranked) and proof snippets. Spoken questions only behind features.spokenAsk: a consent tick, up to 30 s through a
   DEFAULT-rate AudioContext and the page's own worklet (it resamples to 24 kHz), and an editable transcript. The microphone
   stays disabled while a voice interview is preparing, connecting, live or ending. Contributes to window.AtlasWowUI. */
(()=>{'use strict';
const W=window.AtlasWowUI=window.AtlasWowUI||{},B=window.AtlasBids,esc=B.esc,$=id=>document.getElementById(id),app=()=>window.ATLAS_APP;
const BUSY=['preparing','connecting','live','ending'],MAX_BYTES=30*24000*2,MIN_BYTES=4800,TOPIC_KEYS=['context','contribution','approach','outcome','evidence','customer_relevance'];
const STATUS={in_review:'In review',needs_work:'Needs work',changes_requested:'Changes requested',awaiting_validation:'Awaiting N+1',published:'Published',withdrawn:'Withdrawn'};
const S={built:false,boot:{},rec:null,poll:null,last:null};
const say=t=>{const el=$('askStatus');if(el)el.textContent=t||'';};
const voiceBusy=()=>{try{return BUSY.includes(window.AtlasVoice?.status?.().phase);}catch{return false;}};
const micAvailable=()=>!!(S.boot.features?.spokenAsk&&navigator.mediaDevices?.getUserMedia);
W.renderAsk=async()=>{const el=$('askAtlas');if(!el)return;S.boot=(await app().bootInfo())||{};
 if(!S.boot.library||!S.boot.features?.ask){stopRecording(true,true);el.hidden=true;return;}
 if(!S.built)build(el);el.hidden=false;syncMic();};
function build(el){S.built=true;el.classList.add('ask-atlas');
 el.innerHTML=`<div class="impact-head"><label class="field-label" for="askQuestion">Ask ATLAS</label><span class="tiny muted">Answers come only from the references you can see.</span></div>
<div class="recommend-row"><textarea id="askQuestion" maxlength="600" rows="2" placeholder="e.g. What have we done on claims backlogs in insurance, and who can I call?"></textarea><div class="ask-actions"><button class="btn primary" id="askGo" type="button">Ask</button><button class="btn" hidden="" id="askMic" type="button">Speak</button></div></div>
<label class="check" hidden="" id="askMicConsentRow"><input id="askMicConsent" type="checkbox"/><span>Don't say client names. Up to 30 seconds of audio is transcribed and not stored; you can edit the text before asking.</span></label>
<p class="tiny muted" hidden="" id="askMicBusy">The microphone is off while a voice interview is running.</p>
<p class="tiny bid-status" id="askStatus" role="status"></p><div hidden="" id="askVerdict"></div>
<div class="ask-grid"><div class="bid-results" id="askResults"></div><aside class="ask-side"><div id="askMap"></div><section aria-labelledby="askPeopleTitle" hidden="" id="askPeople"></section></aside></div>`;
 $('askGo').addEventListener('click',ask);$('askMic').addEventListener('click',toggleMic);
 $('askQuestion').addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();ask();}});
 window.addEventListener('atlas-session',syncMic);window.addEventListener('atlas-quality',syncMic);}
// Mic gating: re-checked every second while spoken Ask is available (no animation, a plain status poll).
function syncMic(){const mic=$('askMic');if(!mic)return;const on=micAvailable(),busy=on&&voiceBusy();
 mic.hidden=!on;$('askMicConsentRow').hidden=!on;$('askMicBusy').hidden=!busy;
 if(busy&&S.rec)stopRecording(true);
 mic.disabled=busy||S.rec==='transcribing';mic.textContent=S.rec&&S.rec!=='transcribing'?'Stop':'Speak';mic.setAttribute('aria-pressed',S.rec&&S.rec!=='transcribing'?'true':'false');
 if(on&&!S.poll)S.poll=setInterval(syncMic,1000);else if(!on&&S.poll){clearInterval(S.poll);S.poll=null;}}
async function ask(){const q=$('askQuestion').value.trim(),btn=$('askGo');if(q.length<8){say('Ask a question of at least 8 characters.');$('askQuestion').focus();return;}
 btn.disabled=true;say('Searching the references you can see…');
 try{const r=await app().libraryApi('/ask',{method:'POST',body:{question:q.slice(0,600),limit:6}});S.last=r;draw(r);say('');}
 catch(err){say(err.message);}finally{btn.disabled=false;}}
function snippetLabel(s){const topic=typeof s?.topic==='number'?TOPIC_KEYS[s.topic]:s?.topic;return B.sourceLabel({kind:s?.kind,topic,sourceName:s?.sourceName});}
function card(x){const rel=typeof x.relevance==='number'?'relevance '+Math.round(x.relevance):'not ranked',sim='similarity '+(typeof x.similarity==='number'?x.similarity.toFixed(2):'n/a')+' · '+(x.retrieval==='lexical'?'keyword':'semantic');
 const snips=(Array.isArray(x.snippets)?x.snippets:[]).map(s=>`<blockquote class="ask-snippet"><p>${esc(s.text)}</p><cite class="tiny muted">${esc(snippetLabel(s))}</cite></blockquote>`).join('');
 const people=(Array.isArray(x.people)?x.people:[]).map(p=>esc(p.name)+(p.role?' ('+esc(p.role)+')':'')).join(' · ');
 return `<article class="bid-result ask-result"><div class="impact-head"><strong>${esc(x.title)}</strong><span>${esc(rel)} · ${esc(sim)}</span></div>
<div class="tags"><span class="status-badge status-${esc(x.status)}">${esc(STATUS[x.status]||x.status)}</span>${[x.practice,x.industry,x.country].filter(Boolean).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div>
${x.why?`<p class="small">${esc(x.why)}</p>`:''}${x.caveat?`<p class="tiny muted">Caveat: ${esc(x.caveat)}</p>`:''}${snips}${people?`<p class="tiny">Worked on it: ${people}</p>`:''}<button class="quiet" data-open-record="${esc(x.id)}" type="button">Open reference →</button></article>`;}
function draw(r){const results=Array.isArray(r.results)?r.results:[],c=B.askVerdictCopy(r.verdict,results)||{tone:'none',text:B.ASK_EMPTY};
 const v=$('askVerdict');v.hidden=false;v.innerHTML=`<div class="verdict-banner v-${esc(c.tone)}" role="status"><strong>${esc(c.text)}</strong></div><p class="tiny muted">${r.note?esc(r.note)+' ':''}${r.method?'Method: '+esc(r.method)+'. ':''}${esc(r.label||'')}</p>`;
 $('askResults').innerHTML=results.map(card).join('');
 const countries=(Array.isArray(r.countries)?r.countries:[]).filter(x=>x&&typeof x.name==='string'&&Number.isInteger(x.n)&&x.n>0),map=$('askMap');
 if(window.AtlasCharts&&results.length){map.innerHTML=window.AtlasCharts.portfolioMap({byCountry:countries,totals:{visible:results.length}},{interactive:true});window.AtlasCharts.bind(map);}else map.replaceChildren();
 const people=Array.isArray(r.people)?r.people:[],box=$('askPeople');box.hidden=!people.length;
 box.innerHTML=people.length?`<h3 class="panel-sub" id="askPeopleTitle">People to call</h3><p class="tiny muted">Listed by the projects they worked on, in the order found, never ranked.</p><ul class="ask-people">${people.map(p=>{const n=Array.isArray(p.refIds)?p.refIds.length:0;
  return `<li><b>${esc(p.name)}</b>${p.role?' · '+esc(p.role):''}${p.email?` · <a href="mailto:${esc(encodeURIComponent(p.email))}">${esc(p.email)}</a>`:''}${n?`<span class="tiny muted"> · ${n} reference${n===1?'':'s'}</span>`:''}</li>`;}).join('')}</ul>`:'';}
// ---- spoken question (F6.1): never sent anywhere until the consultant stops the recording
async function toggleMic(){if(S.rec==='transcribing')return;if(S.rec){stopRecording(false);return;}
 if(!micAvailable())return;if(voiceBusy()){say('The microphone is in use by the voice interview.');return;}
 if(!$('askMicConsent').checked){say('Tick “Don’t say client names” first.');$('askMicConsent').focus();return;}
 try{await startRecording();}catch(err){stopRecording(true,true);say(err?.message||'The microphone could not start.');}}
async function startRecording(){const rec={stream:null,ctx:null,node:null,chunks:[],bytes:0,timer:null};S.rec=rec;syncMic();
 rec.stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
 if(S.rec!==rec){rec.stream.getTracks().forEach(t=>t.stop());return;}
 rec.ctx=new AudioContext();await rec.ctx.resume().catch(()=>{}); // default rate, like voice-client.js: the worklet resamples to 24 kHz
 const src=$('atlasVoiceWorklet')?.textContent;if(!src)throw Error('Audio capture is not available in this build.');
 const url=URL.createObjectURL(new Blob([src],{type:'text/javascript'}));try{await rec.ctx.audioWorklet.addModule(url);}finally{URL.revokeObjectURL(url);}
 if(S.rec!==rec)return;
 const node=rec.node=new AudioWorkletNode(rec.ctx,'atlas-duplex',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]}),source=rec.ctx.createMediaStreamSource(rec.stream);
 if(rec.ctx.sampleRate>24000){const f=rec.ctx.createBiquadFilter();f.type='lowpass';f.frequency.value=11000;f.Q.value=.707;source.connect(f);f.connect(node);}else source.connect(node);
 const silent=rec.ctx.createGain();silent.gain.value=0;node.connect(silent);silent.connect(rec.ctx.destination);
 node.port.onmessage=e=>{if(S.rec!==rec||e.data?.type!=='pcm')return;const b=new Uint8Array(e.data.buffer);if(rec.bytes+b.length>MAX_BYTES){stopRecording(false);return;}rec.chunks.push(b);rec.bytes+=b.length;};
 node.port.postMessage({type:'state',enabled:true,muted:false});rec.timer=setTimeout(()=>{if(S.rec===rec)stopRecording(false);},30000);
 say('Listening, up to 30 seconds. Press Stop when you are done.');syncMic();}
function release(rec){clearTimeout(rec.timer);try{rec.node?.port.postMessage({type:'state',enabled:false,muted:false});}catch{}try{rec.stream?.getTracks().forEach(t=>t.stop());}catch{}try{rec.ctx?.close();}catch{}}
function stopRecording(discard,quiet=false){const rec=S.rec;if(!rec||rec==='transcribing')return;S.rec=null;release(rec);syncMic();
 if(discard){if(!quiet)say('Recording discarded: the microphone is needed for the voice interview.');return;}
 if(rec.bytes<MIN_BYTES){say('That was too short to transcribe. Try again, or type the question.');return;}transcribe(rec);}
async function transcribe(rec){const body=new Uint8Array(rec.bytes);let o=0;for(const c of rec.chunks){body.set(c,o);o+=c.length;}rec.chunks=[];
 S.rec='transcribing';syncMic();say('Transcribing…');
 try{const r=await fetch('/api/transcribe',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'audio/L16;rate=24000','X-Atlas-CSRF':S.boot.csrf||''},body});
  const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'The recording could not be transcribed.');
  const t=String(d.text||'').trim().slice(0,600);if(!t)throw Error('No words were recognised. Try again, or type the question.');
  const q=$('askQuestion');q.value=t;q.focus();say('Transcribed. Check and edit the text, then press Ask.');}
 catch(err){say(err.message);}finally{S.rec=null;syncMic();}}
})();
