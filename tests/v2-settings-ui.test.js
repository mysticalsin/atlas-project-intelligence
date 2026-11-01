'use strict';
// v2.2 V2 (browser side, no browser needed): the Settings sheet's markup and script. The behaviour in a real browser (tabs, the admin tabs, Test voice from a blob, the key never shown) is
// tests/settings_browser.py; these pin the structure and the rules that must never regress: every id is unique (a clash once repainted the orb's own voice panel), the controls the earlier work
// built (profile, privacy, backup, memory) are all still in the sheet, the admin tabs start hidden, the key field is an empty password field that nothing fills in, and audio plays from a blob.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const src=n=>fs.readFileSync(path.join(__dirname,'..','src',n),'utf8');
const built=fs.readFileSync(path.join(__dirname,'..','ATLAS_Voice.html'),'utf8');
const markup=built.replace(/<script[\s\S]*?<\/script>/g,'').replace(/<style[\s\S]*?<\/style>/g,'');
const sheet=(()=>{const s=markup.indexOf('id="profileDialog"'),e=markup.indexOf('</dialog>',s);return markup.slice(markup.lastIndexOf('<dialog',s),e);})();

test('every id of the built page is unique (the Voice tab once shared #voicePanel with the orb page)',()=>{
 const ids=[...markup.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]),dup=ids.filter((x,i)=>ids.indexOf(x)!==i);
 assert.deepEqual([...new Set(dup)],[],'duplicate ids');
 assert.ok(ids.includes('adminVoicePanel')&&ids.includes('voicePanel'));
});

test('the Settings sheet is the profile dialog with an accessible tab list: six tabs (For IT is the sixth, v2.2 W3), one selected, each controlling a labelled panel; Connections, Voice and For IT start hidden',()=>{
 assert.match(sheet,/class="settings-sheet"/); assert.match(sheet,/role="tablist"/);
 const tabs=[...sheet.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map(m=>m[0]);
 assert.deepEqual(tabs.map(t=>/data-stab="(\w+)"/.exec(t)[1]),['profile','privacy','workspace','connections','voice','forit']);
 assert.equal(tabs.filter(t=>/aria-selected="true"/.test(t)).length,1); assert.match(tabs[0],/aria-selected="true"/); assert.match(tabs[0],/tabindex="0"/); for(const t of tabs.slice(1))assert.match(t,/tabindex="-1"/);
 for(const t of tabs){const k=/data-stab="(\w+)"/.exec(t)[1];assert.match(t,new RegExp('aria-controls="spane-'+k+'"')); assert.match(sheet,new RegExp('<section[^>]*aria-labelledby="stab-'+k+'"[^>]*id="spane-'+k+'"[^>]*role="tabpanel"|<section[^>]*id="spane-'+k+'"[^>]*role="tabpanel"'));}
 for(const k of ['connections','voice','forit']){assert.match(tabs[['profile','privacy','workspace','connections','voice','forit'].indexOf(k)],/\bhidden\b[^>]*data-admin-tab|data-admin-tab[^>]*\bhidden\b/,k+' tab starts hidden'); assert.match(sheet,new RegExp('<section[^>]*id="spane-'+k+'"[^>]*\\bhidden\\b'),k+' panel starts hidden');}
 for(const k of ['profile','privacy','workspace'])assert.doesNotMatch(tabs[['profile','privacy','workspace'].indexOf(k)],/\bhidden\b/);
 assert.match(markup,/class="avatar"[^>]*id="profileButton"|id="profileButton"[^>]*class="avatar"/); assert.match(markup,/aria-label="Settings: profile, privacy, workspace"/);
});

test('every control the earlier work put in the profile dialog is still inside the sheet, on the tab that fits it, with its id',()=>{
 const pane=k=>{const s=sheet.indexOf('id="spane-'+k+'"'),n=sheet.indexOf('<section',s+10),next=['profile','privacy','workspace','connections','voice','forit'].map(x=>sheet.indexOf('id="spane-'+x+'"')).filter(i=>i>s).sort((a,b)=>a-b)[0];return sheet.slice(s,next||sheet.length);};
 const has=(k,ids)=>{const p=pane(k);for(const id of ids)assert.match(p,new RegExp('id="'+id+'"'),k+' has '+id);};
 has('profile',['profileSection','profileEmpty']);
 has('privacy',['privacyPanel','privCheckpoint','privRestricted','privObjectScoring','privObjectMatching','privObjectMemory','privDownload','privDelete','privStatus','hindsightPanel','memoryOn','memoryForgetAll','connectionTest','memoryStatus']);
 has('workspace',['userSelect','newProfile','renameProfile','deleteProfile','storageDetail','toggleStorage','backupProfile','importProfile','memoryInput','saveMemory','memorySummary']);
 has('connections',['connectionsPanel']); has('voice',['adminVoicePanel']);
 assert.ok(markup.indexOf('id="privDownload"')<markup.indexOf('id="privRestricted"'),'Download and Delete come before the choices');
 const lib=markup.slice(markup.indexOf('id="library"'),markup.indexOf('</section>',markup.indexOf('id="libraryList"')));assert.doesNotMatch(lib,/connectionsPanel/,'the connections wall is no longer on the Library');
 assert.equal((sheet.match(/class="field-note"/g)||[]).length>=5,true,'each choice carries its plain explanation');
});

test('the optional privacy choices are still never pre-ticked in the markup',()=>{
 for(const id of ['privCheckpoint','privRestricted','privObjectScoring','privObjectMatching','privObjectMemory'])assert.match(sheet,new RegExp('<input id="'+id+'" type="checkbox"/>'),id);
});

test('settings-ui.js: the key field is an empty password field nothing fills in; the key goes to one route and is cleared at once; test audio plays from a blob; text only, no markup from the server',()=>{
 const js=src('settings-ui.js');
 assert.match(js,/type:'password'/); assert.match(js,/autocomplete:'new-password'/); assert.doesNotMatch(js,/\$\('voiceKey'\)\.value=(?!'')/,'the key field is never given a value'); assert.doesNotMatch(js,/input\.value=(?!'')|voiceKey[^;]{0,40}value\s*[:=]\s*(?!''|"")[a-z]/i);
 assert.match(js,/api\('PUT','\/api\/admin\/voice\/key',\{key\}\)/); assert.match(js,/input\.value='';/,'cleared before the request is awaited');
 assert.doesNotMatch(js,/localStorage|sessionStorage|document\.cookie|indexedDB/,'nothing is kept in the browser');
 assert.match(js,/URL\.createObjectURL\(blob\)/); assert.match(js,/URL\.revokeObjectURL/); assert.doesNotMatch(js,/preview_url|previewUrl/,'no preview audio from another origin: the page may play blob: media only');
 assert.doesNotMatch(js,/innerHTML|insertAdjacentHTML|setHTML/); assert.match(js,/'X-Atlas-CSRF':b\.csrf/);
 assert.match(js,/\['connections','voice','forit'\]/); assert.match(js,/dataset|data-admin-tab/);
 for(const route of ['/api/admin/voice','/api/admin/voice/key','/api/admin/voice/voices','/api/admin/voice/test'])assert.ok(js.includes(route),route);
});

test('the page policy still allows media from blob: only (what Test voice needs), and settings.css reaches the built page with its phone layout',()=>{
 const csp=fs.readFileSync(path.join(__dirname,'..','atlas_voice','csp.py'),'utf8'); assert.match(csp,/media-src blob:/);
 assert.match(built,/dialog\.settings-sheet\[open\]/); assert.match(built,/@media\(max-width:640px\)\{\s*body\.ui2 dialog\.settings-sheet\{width:100vw/);
 const css=src('settings.css'); assert.doesNotMatch(css,/font-size:\s*(?:9|10|11)px/,'no type under 12px'); assert.match(css,/min-height:44px/);
});

test('the connections table renders text only and never an address: one row per connection with name, state and what is missing',()=>{
 const ui=src('workflow-ui.js'); assert.match(ui,/h\('table',\{class:'conn-table'\}/); assert.match(ui,/h\('th',\{scope:'col',text:'What is missing'\}\)/); assert.doesNotMatch(ui,/\bconn-list\b/);
});
