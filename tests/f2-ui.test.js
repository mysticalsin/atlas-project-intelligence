'use strict';
// v2.2 F2 (no browser): AtlasAuth.fetch re-reads /api/bootstrap once on a CSRF refusal and sends the same request again; the read-only / AI-off banner;
// the structure the interface pass depends on (one header class, the read-back card in the centre column, the End sheet holding Restart, previews behind the disclosure).
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.join(__dirname,'..'),read=f=>fs.readFileSync(path.join(ROOT,'src',f),'utf8');
const REFUSAL='Invalid request origin or session token.';

function keeper(handler){
 const els={},el=id=>els[id]||(els[id]={id,hidden:true,textContent:'',disabled:false,addEventListener(){}});
 const calls=[],resp=(status,body)=>({status,ok:status>=200&&status<300,type:'basic',json:async()=>body,clone(){return resp(status,body);}});
 const win={document:{getElementById:el},location:{protocol:'https:',href:'https://x/',hash:'',pathname:'/'},sessionStorage:{getItem:()=>null,setItem(){}},
  CustomEvent:class{constructor(t,o){this.detail=o&&o.detail;}},dispatchEvent(){},addEventListener(){},history:{replaceState(){}},ATLAS_RUNTIME:{},AbortSignal:{timeout:()=>undefined},
  fetch:async(p,o={})=>{calls.push({p,o});return handler(p,o,resp,calls);}};
 win.window=win;vm.runInNewContext(read('session-keeper.js'),{...win,BroadcastChannel:undefined,setTimeout,clearTimeout,setInterval,clearInterval,Promise,JSON,Date,Error,Uint8Array,ArrayBuffer,URL,console});
 return {A:win.AtlasAuth||vm.runInNewContext('window.AtlasAuth',{window:win}),calls,el};
}
const boot=csrf=>({protocol:'atlas-personaplex-pcm-v1',csrf});

test('a POST refused for its CSRF token re-reads /api/bootstrap once and is sent again with the new token',async()=>{
 let n=0;const k=keeper((p,o,resp)=>{if(p==='/api/bootstrap')return resp(200,boot(++n===1?'old':'new'));
  return resp(o.headers['X-Atlas-CSRF']==='new'?200:403,o.headers['X-Atlas-CSRF']==='new'?{ok:true}:{error:REFUSAL});});
 await new Promise(r=>setTimeout(r,20));
 const r=await k.A.fetch('/api/library/x',{method:'POST',headers:{'X-Atlas-CSRF':'old'},body:'{"a":1}'});
 assert.equal(r.status,200);const posts=k.calls.filter(c=>c.p==='/api/library/x');assert.equal(posts.length,2,'sent once more, not in a loop');
 assert.equal(posts[1].o.headers['X-Atlas-CSRF'],'new');assert.equal(posts[1].o.body,'{"a":1}','the same body');
 assert.equal(k.calls.filter(c=>c.p==='/api/bootstrap').length,2,'one fresh bootstrap');
});
test('any other 403, a body that cannot be sent twice, and a token that did not change are not retried',async()=>{
 const k=keeper((p,o,resp)=>p==='/api/bootstrap'?resp(200,boot('same')):resp(403,{error:p==='/other'?'Not yours.':REFUSAL}));
 await new Promise(r=>setTimeout(r,20));
 assert.equal((await k.A.fetch('/other',{method:'POST',headers:{'X-Atlas-CSRF':'same'},body:'{}'})).status,403);assert.equal(k.calls.filter(c=>c.p==='/other').length,1,'a different refusal is final');
 assert.equal((await k.A.fetch('/csrf',{method:'POST',headers:{'X-Atlas-CSRF':'same'},body:'{}'})).status,403);assert.equal(k.calls.filter(c=>c.p==='/csrf').length,1,'the token did not change: nothing to retry with');
 const stream={};await k.A.fetch('/s',{method:'POST',headers:{'X-Atlas-CSRF':'old'},body:stream});assert.equal(k.calls.filter(c=>c.p==='/s').length,1,'a stream is never replayed');
});
test('the calm banner says read-only and AI-paused, and is gone when neither flag is on',async()=>{
 const k=keeper((p,o,resp)=>resp(200,{...boot('t')}));await new Promise(r=>setTimeout(r,20));
 assert.equal(k.el('stateBanner').hidden,true,'no flags: no banner');
 k.A.paintState({...boot('t'),readOnly:true});assert.equal(k.el('stateBanner').hidden,false);assert.match(k.el('stateBannerText').textContent,/read-only/);assert.doesNotMatch(k.el('stateBannerText').textContent,/AI features/);
 k.A.paintState({...boot('t'),aiOff:true});assert.match(k.el('stateBannerText').textContent,/AI features are paused/);assert.doesNotMatch(k.el('stateBannerText').textContent,/read-only/);
 k.A.paintState({...boot('t'),readOnly:true,aiOff:true});assert.match(k.el('stateBannerText').textContent,/read-only.*AI features/s);
 k.A.paintState(boot('t'));assert.equal(k.el('stateBanner').hidden,true);
});
test('structure: one header for every view, the read-back in the centre column, previews behind the disclosure, Restart in the End sheet, no pseudo-icon glyphs',()=>{
 const shell=read('shell.html'),panel=read('voice-panel.html');
 assert.match(shell,/<body class="studio-view ui2">/);assert.equal((shell.match(/<header class="topbar">/g)||[]).length,1);
 assert.ok(panel.indexOf('id="summaryCard"')>panel.indexOf('id="voiceMessage"')&&panel.indexOf('id="summaryCard"')<panel.indexOf('id="textLog"'),'the read-back sits under the heading, in the centre column');
 const right=panel.slice(panel.indexOf('<aside class="studio-aside studio-right">'));assert.ok(!right.includes('id="summaryCard"'),'no longer in the right column');
 assert.match(panel,/<summary>How the orb responds to speech<\/summary><div class="orb-preview">.*id="studioPreview".*data-orb-preview="idle"/s);
 assert.ok(!/id="voiceControls".*data-orb-preview/s.test(panel.slice(panel.indexOf('id="voiceControls"'),panel.indexOf('id="voiceEndRow"'))),'no preview chips among the live controls');
 assert.match(shell,/<dialog[^>]*id="voiceEndDialog"[\s\S]*id="voiceEndConfirm"[\s\S]*id="voiceRestart"[\s\S]*<\/dialog>/);assert.ok(!panel.includes('id="voiceRestart"'),'Restart left the control row');
 assert.match(panel,/id="voiceEnd"/);assert.match(panel,/summaryTitle" tabindex="-1"/);
 for(const g of ['◇','◎','◉','◈','✎','🔒']){assert.ok(!panel.includes(g),'glyph '+g);}
 assert.deepEqual([...panel.matchAll(/>([^<]*↗)</g)].map(m=>m[1]),['Open ATLAS ↗'],'↗ only where a new tab opens');
 assert.match(read('voice-client.js'),/askEnd/);assert.match(read('storyboard-ui.js'),/scrollIntoView\(\{block:'start'/);assert.match(read('storyboard-ui.js'),/\$\('summaryTitle'\)/);
});
test('the build carries ui.css last, with the credit for the method',()=>{
 const b=fs.readFileSync(path.join(ROOT,'build.py'),'utf8');assert.match(b,/workflow\.css'\)\.read_text\(\)\+'\\n'\+\(ROOT\/'src\/ui\.css'\)/);
 assert.match(read('ui.css'),/Damir Sokolovsky/);assert.match(read('styles.css'),/Damir Sokolovsky/);
 for(const f of ['orb.css','orb-renderer.js','orb-ui.js','sculpture.css'])assert.ok(!/ui2/.test(read(f)),f+' was not touched');
});
