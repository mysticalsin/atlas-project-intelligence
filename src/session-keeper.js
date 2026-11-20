/* AtlasAuth (WOW_ZERO_CONFIG §3.2, §3.7): the one helper every same-origin API call goes through, the page mode, and
   re-sign-in without losing the page. The tab holding unsaved work never navigates: a small window signs in and reports
   back over BroadcastChannel('atlas-auth'). The only thing written to browser storage here is a timestamp
   (sessionStorage 'atlas.reauthAt'); project content never reaches sessionStorage or localStorage through this file. */
(()=>{'use strict';
const $=id=>document.getElementById(id);
class Expired extends Error{constructor(){super('Your sign-in expired. Your work is kept on this page.');this.name='AtlasAuthExpired';}}
const pending=new Set(),checks=new Set(),signedInFns=[],REAUTH='atlas.reauthAt',WINDOW=5*60*1000,HEX=/^[0-9a-f]{32}$/;
const NOTICE='The signed-in account changed. Close this tab and open ATLAS again. Anything not already saved on this device is discarded.';
let mode='checking',resume=null,deciding=0,waitingVoice=false,voiceWatch=0,bannerOn=false,failures=[],backedUp=false,bootP=null,probeP=null;
const timeout=ms=>typeof AbortSignal!=='undefined'&&AbortSignal.timeout?AbortSignal.timeout(ms):undefined;
function setMode(m){if(mode===m)return;mode=m;try{window.dispatchEvent(new CustomEvent('atlas-auth',{detail:{mode:m}}));}catch{}}
// Same-origin requests with X-Requested-With need no CORS preflight; with it, Access answers an expired session with 401
// instead of a redirect, and redirect:'manual' catches the redirect anyway if Access is configured without that behaviour.
function boundPair(){const r=window.ATLAS_RUNTIME||{},headers={};const subject=HEX.test(r.boundSubject||'')?r.boundSubject:(r.subjectKey||'');const email=HEX.test(r.boundEmail||'')?r.boundEmail:(r.name||'');if(subject)headers['X-Atlas-Bound-Subject']=subject;if(email)headers['X-Atlas-Bound-Email']=email;return headers;}
function identityChanged(b){const r=window.ATLAS_RUNTIME;if(!r||!b||typeof b!=='object')return false;const id=b.identity||{};if(r.subjectKey&&id.subjectKey&&r.subjectKey!==id.subjectKey)return true;const mail=id.name||b.email||'';if(r.name&&mail&&String(r.name)!==String(mail))return true;if(HEX.test(r.boundSubject||'')&&HEX.test(id.boundSubject||'')&&r.boundSubject!==id.boundSubject)return true;if(HEX.test(r.boundEmail||'')&&HEX.test(id.boundEmail||'')&&r.boundEmail!==id.boundEmail)return true;return false;}
const pageObservers=new Set();
function watchObserver(obs){if(obs&&typeof obs.disconnect==='function')pageObservers.add(obs);}
function disconnectObservers(){for(const obs of pageObservers){try{obs.disconnect();}catch{}}pageObservers.clear();}
function markNotice(note){if(!note||!note.setAttribute)return;note.setAttribute('role','alert');note.setAttribute('aria-live','assertive');note.setAttribute('class','blocking-notice');}
function blankApp(){disconnectObservers();for(const id of ['workspace','libraryList','agentText','journey']){const el=$(id);if(el)el.textContent='';}const root=document.body;if(root){root.hidden=true;root.textContent='';}for(const id of ['enableSave','backupQuick','importQuick']){const el=$(id);if(el)el.disabled=true;}let note=document.getElementById('atlasIdentityNotice');if(!note&&typeof document.createElement==='function'){note=document.createElement('p');if(note.setAttribute)note.setAttribute('id','atlasIdentityNotice');else note.id='atlasIdentityNotice';markNotice(note);try{(document.documentElement||document.body).append(note);}catch{}}markNotice(note);if(note)note.textContent=NOTICE;}
function lockIdentity(){bootP=Promise.resolve({b:{},state:'identity-changed'});probeP=Promise.resolve('identity-changed');setMode('identity-changed');try{window.AtlasVoice?.cancel();}catch{}blankApp();if(!recent()){stamp();reloadHome();}}
function raw(path,opts={}){return fetch(path,{credentials:'same-origin',cache:'no-store',redirect:'manual',...opts,headers:{...boundPair(),...(opts.headers||{}),'X-Requested-With':'XMLHttpRequest'}});}
const lapsed=r=>r.status===401||r.type==='opaqueredirect';
async function authFetch(path,opts={}){const r=await raw(path,opts);if(lapsed(r)){expired();throw new Expired();}if(r.status===409&&typeof r.clone==='function'){let d=null;try{d=await r.clone().json();}catch{}if(d&&d.code==='IDENTITY_CHANGED'){lockIdentity();throw new Expired();}}return r;}
// One bootstrap fetch per load, shared by the start control (voice-client.js) and ATLAS_APP.bootInfo (app.js).
function load(){return (async()=>{
 if(!['http:','https:'].includes(location.protocol))return {b:{},state:'offline'}; // keep this exact expression: tests/studio_browser.py rewrites it
 try{const r=await raw('/api/bootstrap',{signal:timeout(8000)});
  if(lapsed(r))return {b:{},state:'expired'};
  if(r.status===409){let d=null;try{d=await r.json();}catch{}if(d&&d.code==='IDENTITY_CHANGED')return {b:{},state:'identity-changed'};return {b:d&&typeof d==='object'?d:{},state:'error'};}
  if(!r.ok){let b={};if(r.status===503){let error='';try{const d=await r.json();if(d&&typeof d==='object'&&!Array.isArray(d))error=d.error;}catch{}b={ok:false,error:String(error??'').slice(0,500)};}return {b,state:'error'};}
  const b=await r.json(); // a Cloudflare 52x HTML page throws here
  if(identityChanged(b))return {b:{},state:'identity-changed'};
  return b&&typeof b==='object'?{b,state:b.protocol==='atlas-personaplex-pcm-v1'?'ok':'foreign'}:{b:{},state:'error'};
 }catch{return {b:{},state:'error'};}})();}
function bootState({fresh=false}={}){if(!bootP||fresh)bootP=load();return bootP;}
const boot=o=>bootState(o).then(x=>x.b);
// The page mode (§3.3). The live runtime is injected by both servers, so with it a failure is 'network', never 'offline'.
function probe({fresh=false}={}){if(probeP&&!fresh)return probeP;
 probeP=bootState({fresh}).then(({state})=>{const runtime=!!window.ATLAS_RUNTIME;
  if(state==='identity-changed'){lockIdentity();return mode;}
  if(state==='ok')setMode('live');
  else if(!runtime)setMode('offline');
  else if(state==='expired')expired({resume:location.hash==='#start'?'start':null});
  else setMode('network');
  return mode;});
 return probeP;}
// ---- expiry (§3.7). One handling per episode; callers may add a resume ('start') until it is decided.
function expired({resume:r=null}={}){if(r)resume=r;setMode('expired');if(bannerOn||waitingVoice||deciding)return;deciding=setTimeout(decide,0);}
function voiceActive(){try{return !!window.AtlasVoice?.active?.();}catch{return false;}}
function decide(){deciding=0;if(mode!=='expired'||bannerOn)return;
 // Microphone held or socket open: the conversation continues and nothing shows until it has ended.
 if(voiceActive()){waitingVoice=true;clearInterval(voiceWatch);voiceWatch=setInterval(()=>{if(waitingVoice&&!voiceActive())voiceDone();},1500);return;}
 settle();}
function voiceDone(){if(!waitingVoice)return;waitingVoice=false;clearInterval(voiceWatch);voiceWatch=0;if(mode==='expired'&&!bannerOn)settle();}
window.addEventListener('atlas-session',e=>{if(e.detail?.type==='ended')setTimeout(voiceDone,0);});
function clean(){if(pending.size)return false;if(document.querySelector('dialog[open]'))return false;for(const f of checks){try{if(f())return false;}catch{return false;}}return true;}
function recent(){try{const t=Number(sessionStorage.getItem(REAUTH));return !!t&&Date.now()-t<WINDOW;}catch{return true;}} // unknown: never risk a reload loop
function stamp(){try{sessionStorage.setItem(REAUTH,String(Date.now()));}catch{}}
// A real reload of '/' (or '/#start'): location.replace('/#start') from '/' would only change the fragment and reload nothing.
function reloadHome(hash=''){try{history.replaceState(null,'','/'+hash);}catch{}location.reload();}
function settle(){if(clean()&&!recent()){stamp();reloadHome(resume==='start'?'#start':'');return;}showBanner();}
function showBanner(){bannerOn=true;const el=$('authBanner');if(el)el.hidden=false;paint();}
function paint(){failures=failures.filter(t=>Date.now()-t<WINDOW);const f=$('authFallback');if(f)f.hidden=failures.length<2;const r=$('authReload');if(r)r.disabled=!(backedUp||clean());}
// Reconnect (a click, so no popup blocker applies): the small window's top-level navigation goes through Access.
function reconnect(){const at=Date.now();let w=null;try{w=window.open('/go/signed-in','atlas-signin','popup,width=480,height=640');}catch{w=null;}
 if(!w){failed(at);return;}
 const watch=setInterval(()=>{if(!bannerOn){clearInterval(watch);return;}let closed=false;try{closed=w.closed;}catch{closed=true;}
  if(closed){clearInterval(watch);setTimeout(()=>{if(bannerOn)failed(at);},1500);}},700);}
function failed(at){failures.push(at);paint();}
async function signedIn(){if(mode!=='expired')return;
 clearTimeout(deciding);deciding=0;waitingVoice=false;clearInterval(voiceWatch);voiceWatch=0;bannerOn=false;failures=[];backedUp=false;
 const el=$('authBanner');if(el)el.hidden=true;const f=$('authFallback');if(f)f.hidden=true;
 const was=resume;resume=null;
 await probe({fresh:true}); // a fresh bootstrap: a new CSRF token
 if(mode!=='live')return;
 for(const fn of signedInFns.slice()){try{await fn({resume:was});}catch{}}
 window.ATLAS_APP?.toast?.('You’re signed in again. Nothing was lost.');}
let lastWatch=0;
function watch(){if(mode==='identity-changed'||mode==='offline')return;const now=Date.now();if(now-lastWatch<1000)return;lastWatch=now;probe({fresh:true});}
if(typeof window.addEventListener==='function')window.addEventListener('focus',()=>watch());
if(typeof document.addEventListener==='function')document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')watch();});
try{const ch=new BroadcastChannel('atlas-auth');ch.onmessage=e=>{if(e.data!=='ok'||mode==='identity-changed')return;if(mode==='expired'){signedIn();return;}watch();};}catch{}
$('authReconnect')?.addEventListener('click',reconnect);
$('authBackup')?.addEventListener('click',()=>{$('backupQuick')?.click();backedUp=true;paint();});
$('authReload')?.addEventListener('click',()=>{if(!(backedUp||clean()))return;stamp();reloadHome();});
window.AtlasAuth={fetch:authFetch,expired,reconnect,Expired,pending,boot,probe,changed:identityChanged,lock:lockIdentity,watchObserver,
 onSignedIn:fn=>{if(typeof fn==='function')signedInFns.push(fn);},
 dirty:fn=>{if(typeof fn!=='function')return ()=>{};checks.add(fn);return ()=>checks.delete(fn);},
 get mode(){return mode;}};
probe();
})();
