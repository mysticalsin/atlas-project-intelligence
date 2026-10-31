'use strict';
// G2 (browser side, no browser needed): the consent object the page sends, the sensitive-line tag on the read-back, the Download/Delete wiring, the email lookup in a POST body.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const src=n=>fs.readFileSync(path.join(__dirname,'..','src',n),'utf8');
const B=require('../src/storyboard-core.js');

test('the read-back card tags a line that may be sensitive ("keep it private?") and leaves other lines exactly as they were',()=>{
 const v=B.summaryView({phase:'open',items:[{detail_id:'D-001',field:'outcome',label:'Outcome',quote:'Triage fell from 40 to 12 minutes.',status:'reported'},{detail_id:'D-002',field:'limitations',label:'Limits',quote:'I was out on sick leave.',status:'reported',sensitive:true}],unknowns:[]});
 assert.deepEqual(v.items[0].tags.filter(t=>/sensitive/.test(t)),[]); assert.deepEqual(v.items[1].tags.filter(t=>/sensitive/.test(t)),['may be sensitive: keep it private?']);
 assert.deepEqual(B.summaryView({phase:'open',items:[{detail_id:'D-003',field:'outcome',label:'Outcome',quote:'q',status:'reported',sensitive:'yes'}],unknowns:[]}).items[0].tags.filter(t=>/sensitive/.test(t)),[],'only a real true counts');
});

test('the consent dialog has separate rows: required capture, saved interview (24 h), memory (off), the notice; a link to /privacy and the sentence about sensitive information',()=>{
 const shell=src('shell.html'),vc=src('voice-client.js');
 for(const id of ['modelConsent','checkpointConsent','memoryConsent','noticeAck','consentSpecial'])assert.match(shell,new RegExp('id="'+id+'"'),id);
 assert.match(shell,/href="\/privacy"/); assert.match(shell,/id="checkpointConsent" type="checkbox" checked/,'the saved-interview choice starts on and can be unticked');
 assert.doesNotMatch(shell,/id="memoryConsent" type="checkbox" checked/,'memory is never pre-ticked');
 assert.match(vc,/\$\('memoryConsent'\)\.checked=false/,'the dialog resets memory to off each time it opens');
 assert.match(vc,/consent:boot\.captureRequired&&activeConsent\?activeConsent:true/,'the start message carries the object; the gateway without transcript capture keeps the bare tick');
 assert.match(vc,/transcription:!typing,draft:true,checkpoint:\$\('checkpointConsent'\)\.checked,memory:!!b\.memory&&\$\('memoryConsent'\)\.checked,notice:\$\('noticeAck'\)\.checked/);
 assert.match(vc,/resume\)return \{transcription:!typing,draft:true,checkpoint:true/,'a resume carries the choice already made');
 assert.doesNotMatch(vc,/memoryLine'\)\.onclick/,'the old "turn on memory" button is gone');
});

test('Download my data, Delete my data and the restriction/objection switches exist and use the Worker routes with the CSRF token; deletion asks for the confirmation token first',()=>{
 const app=src('app.js'),shell=src('shell.html');
 for(const id of ['privDownload','privDelete','privRestricted','privObjectScoring','privObjectMatching','privObjectMemory','privCheckpoint'])assert.match(shell,new RegExp('id="'+id+'"'),id);
 assert.match(app,/'\/api\/me\/export'/); assert.match(app,/\/api\/me\/erase',\{method:'POST',body:\{\}\}/); assert.match(app,/body:\{confirm:d\.confirmToken\}/); assert.match(app,/\/api\/me\/privacy/); assert.match(app,/X-Atlas-CSRF/);
 assert.match(app,/memoryOn!==true\)return/,'memory is retained only when it is on');
 assert.doesNotMatch(app,/conversation:String\(transcript/,'the raw conversation is no longer sent to memory');
});

test('the email lookup is a POST with the address in the body, never in a URL',()=>{
 const ui=src('profile-ui.js'); assert.match(ui,/libraryApi\('\/people\/lookup',\{method:'POST',body:\{email:e\}\}\)/); assert.doesNotMatch(ui,/\/people\?email=/);
});

test('every inline script of the built page parses (a stray comment or brace in a one-line source file breaks the whole page)',()=>{
 const vm=require('node:vm'),html=fs.readFileSync(path.join(__dirname,'..','ATLAS_Voice.html'),'utf8'),scripts=[...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(s=>s.length>200);
 assert.ok(scripts.length>5);
 for(const [i,s] of scripts.entries())assert.doesNotThrow(()=>new vm.Script(s),'script '+i);
 assert.match(html,/id="privDelete"/,'the build carries the privacy panel');
});
