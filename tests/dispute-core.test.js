// D-DSR pure helpers (src/dispute-core.js): the state badge, both views side by side, which control is enabled (only from the server's actions) and why one is not,
// the request body with its reason, and plain words for refusals. No em dash in any copy. Synthetic data only.
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../src/dispute-core.js');
const REJ={by:'solo@mantu.com',reason:'The figure has no source.',at:'2026-11-02T16:00:00.000Z'};
const DIS={by:'alex@mantu.com',rationale:'The dashboard export is the source.',adjudicator:'rev2@mantu.com',rejection:REJ};
const rec=(o={})=>({id:'ev1',revision:1,state:'disputed',access:'reviewer',actions:[],rejection:REJ,dispute:DIS,adjudication:null,...o});
const texts=m=>JSON.stringify(m);

test('badges: rejected, disputed, upheld, accepted, reopened; nothing for a record that was never rejected',()=>{
 assert.equal(C.badge(rec({state:'rejected',dispute:undefined})).text,'Rejected');
 assert.deepEqual(C.badge(rec()),{key:'disputed',text:'Disputed',tone:'work'});
 assert.equal(C.badge(rec({state:'closed_rejected',adjudication:{outcome:'upheld'}})).text,'Rejection upheld');
 assert.equal(C.badge(rec({state:'closed_rejected',adjudication:{outcome:'accepted_by_owner'}})).text,'Rejection accepted');
 assert.equal(C.badge(rec({state:'reviewer_queue',adjudication:{outcome:'reopened'}})).text,'Reopened after a dispute');
 assert.equal(C.badge(rec({state:'approved',adjudication:{outcome:'reopened'}})),null,'not once it has moved on');
 assert.equal(C.badge({state:'reviewer_queue',actions:['approve']}),null);assert.equal(C.model({state:'approved'}),null);
});

test('both views are shown side by side, with the named adjudicator and a single-reviewer settlement said in words',()=>{
 const s=C.story(rec({state:'closed_rejected',adjudication:{by:'solo@mantu.com',outcome:'upheld',reason:'Another line.',single_reviewer:true}}));
 assert.deepEqual(s.map(x=>x.key),['rejection','dispute','adjudicator','adjudication']);
 assert.deepEqual([s[0].who,s[0].text,s[1].who,s[1].text,s[2].who],['solo@mantu.com','The figure has no source.','alex@mantu.com','The dashboard export is the source.','rev2@mantu.com']);
 assert.match(s[3].text,/upheld the rejection\. Another line\. Recorded as a single-reviewer adjudication\./);
});

test('reviewer: the buttons follow the server\'s actions; single reviewer gets the note; a refused rejecter is told why',()=>{
 let m=C.model(rec({actions:['uphold_rejection','reopen_review'],adjudication_policy:{reviewers:1,you_rejected:true,may_adjudicate:true,rule:'single_reviewer'}}));
 assert.deepEqual(m.controls.map(c=>[c.action,c.label,c.enabled]),[['uphold_rejection','Uphold the rejection',true],['reopen_review','Overturn and review again',true]]);
 assert.match(m.note,/only reviewer for this project/);assert.equal(m.open,true);
 m=C.model(rec({actions:[],adjudication_policy:{reviewers:2,you_rejected:true,may_adjudicate:false,rule:'refused'}}));
 assert.ok(m.controls.every(c=>!c.enabled&&/another reviewer is available/.test(c.why)));assert.equal(m.open,false);
 m=C.model(rec({state:'closed_rejected',adjudication:{outcome:'upheld',by:'x@mantu.com'}}));
 assert.ok(m.controls.every(c=>!c.enabled&&c.why==='This dispute is settled.'));
});

test('owner: raise a dispute or accept, with an optional adjudicator; disabled with the reason when not possible',()=>{
 let m=C.model(rec({state:'rejected',access:'owner',mine:true,dispute:null,actions:['dispute','accept_rejection','withdraw']}));
 assert.deepEqual(m.controls.map(c=>[c.action,c.enabled]),[['dispute',true],['accept_rejection',true]]);assert.equal(m.adjudicatorField,true);
 m=C.model(rec({access:'owner',mine:true,actions:['accept_rejection','withdraw']}));
 assert.deepEqual(m.controls.map(c=>[c.action,c.enabled,c.why]),[['dispute',false,'Your dispute is open. A reviewer settles it.'],['accept_rejection',true,'']]);
});

test('a request needs an enabled action and a reason; the dispute carries its rationale and adjudicator',()=>{
 const m=C.model(rec({state:'rejected',access:'owner',mine:true,dispute:null,actions:['dispute','accept_rejection']}));
 assert.equal(C.request(m,'dispute','  ').error,'Say why you dispute the rejection.');
 assert.match(C.request(m,'dispute','Because.','not-an-email').error,/email address/);
 assert.deepEqual(C.request(m,'dispute','The export is the source.','rev2@mantu.com').body,{action:'dispute',expected_revision:1,reason:'The export is the source.',rationale:'The export is the source.',adjudicator:'rev2@mantu.com'});
 assert.equal(C.request(m,'uphold_rejection','x').error,'This is not available to you right now.');
 const r=C.model(rec({actions:['reopen_review']}));
 assert.equal(C.request(r,'reopen_review','').error,'Say why the rejection is overturned.');
 assert.deepEqual(C.request(r,'reopen_review','It is supported.').body,{action:'reopen_review',expected_revision:1,reason:'It is supported.'});
});

test('refusals in plain words, never the raw code, and no em dash anywhere in the copy',()=>{
 assert.match(C.errorText({reason:'ADJUDICATOR_IS_REJECTER',message:'Not allowed: ADJUDICATOR_IS_REJECTER'}),/another reviewer is available/);
 assert.match(C.errorText({message:'Not allowed: REVISION_MISMATCH:1'}),/changed while you were reading/);
 assert.doesNotMatch(C.errorText(new TypeError('Failed to fetch')),/fetch/);
 const all=[texts(C.BADGES),texts(C.DONE),...['rejected','disputed','closed_rejected'].flatMap(st=>[texts(C.model(rec({state:st,adjudication:st==='closed_rejected'?{outcome:'upheld',by:'a@mantu.com',single_reviewer:true}:null}))),texts(C.model(rec({state:st,access:'owner',mine:true})))])].join(' ');
 assert.doesNotMatch(all+require('node:fs').readFileSync(require.resolve('../src/dispute-ui.js'),'utf8'),/\u2014/);
});
