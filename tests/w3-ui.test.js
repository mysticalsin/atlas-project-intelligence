'use strict';
// v2.2 W3 (no browser): the global polish keeps its structure. The behaviour is measured in a real browser by tests/w3_browser.py; this file pins what source text can prove:
// one toast, one save chip, the consent hierarchy, the plain-words rail, How it works for people, the palette's fixed command list, the settings copy.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ROOT=path.join(__dirname,'..'),src=n=>fs.readFileSync(path.join(ROOT,'src',n),'utf8');
const shell=src('shell.html'),app=src('app.js'),panel=src('voice-panel.html'),polish=src('polish.css'),palette=src('palette.js'),settings=src('settings-ui.js'),wf=src('workflow-ui.js');
const text=h=>h.replace(/<script[\s\S]*?<\/script>/g,' ').replace(/<style[\s\S]*?<\/style>/g,' ').replace(/<svg[\s\S]*?<\/svg>/g,' ').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ');
const dialog=id=>{const a=shell.indexOf('id="'+id+'"'),s=shell.lastIndexOf('<dialog',a),e=shell.indexOf('</dialog>',a);return shell.slice(s,e+9);};

test('one toast: a polite live region in the top layer, one function writes it, 4 s, an optional Undo, and nothing else is a toast',()=>{
 assert.equal([...shell.matchAll(/class="toast"/g)].length,1,'one toast element');
 const el=/<div[^>]*class="toast"[^>]*>/.exec(shell)[0];for(const a of ['aria-live="polite"','role="status"','popover="manual"','id="toast"'])assert.ok(el.includes(a),a);
 assert.match(shell,/id="toastUndo"/);
 assert.match(app,/function toast\(message,opts\)/);assert.match(app,/toastArm\(4000\)/,'4 seconds');assert.match(app,/opts\?\.undo/,'the optional Undo');
 assert.doesNotMatch(app,/\$\('toast'\)\.focus|toastUndo'\)\.focus/,'a toast never takes the focus');
 for(const f of ['bids-ui.js','trust-ui.js','profile-ui.js','session-keeper.js','workflow-ui.js','journey-ui.js','storyboard-ui.js','voice-client.js','settings-ui.js'])assert.doesNotMatch(src(f),/\$\('toast'\)|getElementById\('toast'\)|class(?:Name)?[=:]'?"?toast\b/,f+' only calls toast(), it builds no toast of its own');
 assert.match(polish,/\.toast\{[^}]*bottom:calc\(24px/,'bottom-centre, 24px from the edge');
 assert.match(polish,/has-toast main#workspace\{padding-bottom/,'on a phone the page makes room for it');
});

test('one save status: a single chip in the header with three labels, no second strip, no footer copy, Backup lives in Settings, Workspace',()=>{
 assert.equal([...shell.matchAll(/id="storageStatus"/g)].length,1);
 const head=shell.slice(shell.indexOf('<header'),shell.indexOf('</header>'));assert.match(head,/id="storageStatus"/,'the chip is in the header');
 for(const id of ['studioSave','studioBackup','backupQuick','enableSave'])assert.doesNotMatch(shell,new RegExp('id="'+id+'"'),id+' is gone');
 assert.doesNotMatch(shell,/class="environment"/,'the old strip is gone');
 assert.match(app,/const SAVED='Saved',SAVING='Saving…',UNSAVED='Not saved: kept in this tab'/);
 assert.match(app,/function saveStatus\(\)/);assert.match(app,/function renderStorage\(\)\{const el=\$\('storageStatus'\),s=saveStatus\(\)/,'one function writes the chip, from one source of state');
 assert.equal([...app.matchAll(/\$\('storageStatus'\)\.textContent/g)].length,0,'nothing else writes its text');
 for(const old of ['Not saved to ATLAS yet','Session only','Enable autosave'])assert.doesNotMatch(app+shell,new RegExp(old),old+' is not a status any more');
 const ws=shell.slice(shell.indexOf('id="spane-workspace"'),shell.indexOf('id="spane-connections"'));assert.match(ws,/id="backupProfile"/,'Backup is under Settings, Workspace');assert.match(ws,/id="importProfile"/);
 assert.match(app,/\$\('storageStatus'\)\.onclick=\(\)=>\{if\(window\.AtlasSettings\?\.open\)window\.AtlasSettings\.open\('workspace'\)/,'the chip opens Settings on Workspace');
});

test('the consent sheet: Required is its own block, Optional is lighter, every optional box is unticked, Start is sticky with a one-line summary, the G2 rows are all still there',()=>{
 const d=dialog('voiceConsentDialog');
 const req=/<section[^>]*consent-required[\s\S]*?<\/section>/.exec(d)[0],opt=/<section[^>]*consent-optional[\s\S]*?<\/section>/.exec(d)[0];
 assert.match(req,/id="modelConsent"/);assert.doesNotMatch(req,/id="(?:checkpointConsent|memoryConsent|noticeAck|captureConsent)"/,'only the required tick is in the required block');
 for(const id of ['checkpointConsent','memoryConsent','noticeAck','captureConsent'])assert.match(opt,new RegExp('<input id="'+id+'" type="checkbox"/>'),id+' is optional and unticked');
 assert.match(req,/Required/);assert.match(opt,/Optional/);assert.match(opt,/Each one is off until you tick it/);
 assert.match(d,/class="consent-bar"[\s\S]*id="consentSummary"[\s\S]*id="consentReason"[\s\S]*id="voiceConsentStart"/,'the summary, the reason and Start share the sticky bar');
 assert.match(d,/Tick the first box to continue\. It is the only one that is required\./);assert.match(d,/Read the privacy notice/);assert.match(d,/id="consentSpecial"/);
 assert.match(polish,/consent-bar\{position:sticky;bottom:0/);
 assert.match(app,/function paintConsentSummary\(\)/);assert.doesNotMatch(app,/\$\('(?:checkpointConsent|memoryConsent|noticeAck|captureConsent)'\)\.checked=true/,'nothing ticks an optional box for the person');
});

test('the live rail speaks plain words: what a reader will want to know, not yet checked; where it happened; numbers you gave; one Details disclosure',()=>{
 for(const s of ['Where it happened','Numbers you gave'])assert.ok(panel.includes('<span>'+s+'</span>'),s);
 for(const s of ['Places mentioned','Figures, exactly as said','Twelve dimensions','Inspect the quality ledger'])assert.ok(!panel.includes(s),s+' is gone');
 const ui=src('storyboard-ui.js'),core=src('storyboard-core.js');
 assert.match(ui,/'Covered so far: '\+m\.coverage\.present\+' of '\+m\.coverage\.total\+' things a reader will want to know · '\+m\.coverage\.meaning/);assert.match(core,/MEANING='not yet checked against sources'/);
 assert.doesNotMatch(ui,/topics saved · /,'the contradictory "0 of 6 topics saved · 10 of 12 dimensions heard" caption is gone');assert.match(ui,/n>0\?' · Your notes: '/,'the notes count is named as such and shown only when there is something in the notes');
 assert.equal([...panel.matchAll(/<summary class="board-head"><span>Details<\/span>/g)].length,1,'one Details disclosure in the board');
 assert.match(panel,/id="boardDims"[\s\S]*data-intelligence="quality"[\s\S]*<\/details>/,'the 12 points and the quality log are inside it');
 const visible=text(panel.replace(/<details[\s\S]*?<\/details>/g,' ').replace(/class="sr"[^>]*>[^<]*/g,' '));
 assert.doesNotMatch(visible,/candidate|ledger|dimension/i,'no jargon in the rail by default: '+(visible.match(/.{30}(?:candidate|ledger|dimension).{20}/i)||[''])[0]);
});

test('How it works is for people: four steps and three lines of who sees what; no build words; the architecture is under Settings, For IT',()=>{
 const how=text(dialog('howDialog'));
 for(const s of ['Talk','Review your words','Submit','Reused only with your permission','Who sees what, when'])assert.ok(how.includes(s),s);
 assert.equal([...dialog('howDialog').matchAll(/<li><span class="how-num"/g)].length,4);assert.equal([...dialog('howDialog').matchAll(/<dt>/g)].length,3,'three lines of who sees what');
 assert.doesNotMatch(how,/PersonaPlex|GPU|Hindsight|Entra|gateway|Realtime|architecture|GDPR compliant|compliant|production-ready/i);
 assert.match(how,/private draft/);assert.match(how,/until you press Submit for review/);
 assert.doesNotMatch(dialog('howDialog'),/id="architecture"/);
 const it=shell.slice(shell.indexOf('id="spane-forit"'),shell.indexOf('</dialog>',shell.indexOf('id="spane-forit"')));assert.match(it,/id="architecture"/);assert.match(it,/id="downloadDiagram"/);assert.match(it,/id="downloadBrief"/);
 assert.match(shell,/id="stab-forit"[^>]*data-admin-tab|data-admin-tab[^>]*id="stab-forit"/,'For IT is an admin tab');assert.match(settings,/ADMIN_TABS=\['connections','voice','forit'\]/);
 assert.match(shell,/class="quiet how-btn" data-dialog="howDialog"/);assert.match(polish,/max-width:1100px\)\{html body\.ui2 \.topbar \.how-btn\{display:inline-flex/,'reachable on a phone');
});

test('the command palette has a fixed list of safe commands, is a native modal dialog, and writes only text',()=>{
 const ids=[...palette.matchAll(/\{id:'([\w-]+)',label:'([^']+)'/g)].map(m=>m[1]);
 assert.deepEqual(ids,['go-interview','go-projects','go-stories','go-library','go-bids','new-project','start-interview','open-settings','download-data','backup','how','shortcuts']);
 assert.ok(!ids.some(i=>/delete|erase|remove|forget|withdraw|discard|sign|submit|publish|approve/.test(i)),'no destructive or irreversible command');
 assert.match(palette,/id:'download-data',label:'Download my data'[^}]*run:settings\('privacy'\)/,'Download my data only opens the Privacy tab');
 assert.match(palette,/showModal\(\)/);assert.match(palette,/role:'combobox'/);assert.match(palette,/role:'listbox'/);assert.match(palette,/aria-activedescendant/);assert.match(palette,/e\.key==='\?'/);
 assert.doesNotMatch(palette,/innerHTML|insertAdjacentHTML|setHTML|eval\(|new Function|document\.write/);assert.match(palette,/lastOpenMs/);
 assert.match(shell,/<script>__PALETTE__<\/script>/);assert.match(fs.readFileSync(path.join(ROOT,'build.py'),'utf8'),/'__PALETTE__':\(ROOT\/'src\/palette\.js'\)\.read_text\(\)/);
});

test('settings speak plainly: no setting names or deploy commands in the main view, the technical text sits under "For IT"',()=>{
 assert.doesNotMatch(wf,/'Credential '\+r\.slice/,'the connections table does not print the name of a missing secret as the reason');
 assert.match(wf,/Access details have not been added yet/);assert.match(wf,/h\('summary',\{text:'For IT'\}\)/);assert.match(wf,/Settings to add on the server \(names only\)/);
 assert.match(settings,/A voice key cannot be stored from here yet\. The person who runs ATLAS needs to finish one setup step first\./);
 const at=settings.split('\n').findIndex(l=>l.includes("id:'voiceNoStore'")),line=settings.split('\n')[at],next=settings.split('\n')[at+1];assert.ok(line);
 for(const m of line.matchAll(/'([A-Z][^']{20,})'/g))assert.doesNotMatch(m[1],/SETTINGS_KEY|deploy\.sh|wrangler/,'the visible sentence names no secret and no command: '+m[1]);
 assert.match(next,/h\('details',\{class:'forit-more'\},h\('summary',\{text:'For IT'\}\)/);assert.match(next,/SETTINGS_KEY/,'the technical text is under For IT');
 const connPane=shell.slice(shell.indexOf('id="spane-connections"'),shell.indexOf('id="spane-voice"'));assert.doesNotMatch(connPane,/_KEY|_TOKEN|deploy\.sh|\.env/);
});

test('the polish keeps the floors: 12px type, 44px targets, safe-area padding, reduced motion, a visible focus ring',()=>{
 assert.doesNotMatch(polish,/font-size:\s*(?:[0-9]|10|11)(?:\.\d+)?px/,'no type under 12px');
 assert.match(polish,/env\(safe-area-inset-bottom/);assert.match(polish,/prefers-reduced-motion:no-preference/);assert.match(polish,/outline:2px solid var\(--accent\)/);assert.match(polish,/min-height:44px/);
 assert.match(app,/visualViewport/);assert.match(polish,/--vvh/);
 for(const f of ['ui.css','journey.css','fit.css'])assert.doesNotMatch(src(f),/dialog\.w1-dark/,f+': one dark rule for every sheet, no per-sheet class');
});
