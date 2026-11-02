// v2.2 W2 pure helpers (src/review-core.js): names never ids, the queue's order and chips, the seven-step journey from workflow state, the eight-second deferred
// commit (fake timers), the keys, and the human words for failures.
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../src/review-core.js');
const NOW=Date.parse('2026-11-04T12:00:00Z');

test('a project is named by its title, then a readable Project ID, never by a random id',()=>{
 assert.equal(C.projectName({project:'Claims triage rebuild',project_ref:'PRJ-1'}),'Claims triage rebuild');
 assert.equal(C.projectName({project_ref:'PRJ-1'}),'PRJ-1');
 for(const ref of ['914b6732-7bf8-4906-a1b2-0123456789ab','0123456789abcdef0123456789abcdef','local-mh2k3-9x8y7z',null,''])assert.equal(C.projectName({project_ref:ref}),'Interview evidence',String(ref));
 assert.equal(C.projectName({project:'914b6732-7bf8-4906-a1b2-0123456789ab'}),'Interview evidence');
 assert.equal(C.noIds('Open 914b6732-7bf8-4906-a1b2-0123456789ab now'),'Open this project now');
});

test('age is plain words and the tone only reflects how long it has waited',()=>{
 const at=m=>new Date(NOW-m*60000).toISOString();
 assert.deepEqual([C.ageText(at(0.2),NOW),C.ageText(at(5),NOW),C.ageText(at(60),NOW),C.ageText(at(150),NOW),C.ageText(at(24*60),NOW),C.ageText(at(3*24*60+5),NOW),C.ageText('nope',NOW)],['just now','5 min','1 hour','2 hours','1 day','3 days','unknown']);
 assert.deepEqual([C.ageTone(at(30),NOW),C.ageTone(at(25*60),NOW),C.ageTone(at(80*60),NOW),C.ageTone('x',NOW)],['fresh','wait','late','idle']);
});

test('the queue is oldest first, ties keep their order, own records are dropped, every row has a name, an age and a chip',()=>{
 const at=h=>new Date(NOW-h*3600000).toISOString();
 const rows=C.queueRows([{id:'b',queued_at:at(2),project:'Bravo',consultant:'Kim',quality:{score:72,status:'needs_work'},claims:4,revision:1},{id:'a',queued_at:at(50),project_ref:'914b6732-7bf8-4906-a1b2-0123456789ab',quality:null},
  {id:'c',queued_at:at(2),project:'Charlie'},{id:'own',queued_at:at(90),mine:true},null,{queued_at:at(1)}],NOW);
 assert.deepEqual(rows.map(r=>r.id),['a','b','c']);
 assert.deepEqual([rows[0].name,rows[0].age,rows[0].tone,rows[0].quality.text],['Interview evidence','2 days','wait','Not scored']);
 assert.deepEqual([rows[1].name,rows[1].consultant,rows[1].quality.text,rows[1].quality.tone,rows[1].claims],['Bravo','Kim','72 · Needs work','work',4]);
 assert.equal(C.qualityChip({score:90,status:'ready'}).tone,'ok');assert.equal(C.qualityChip({score:10,status:'insufficient'}).tone,'bad');
 assert.equal(C.queueTitle(3),'Waiting for you (3)');assert.equal(C.queueTitle(0),'Waiting for you (0)');assert.equal(C.queueTitle(undefined),'Waiting for you (0)');
});

test('a claim shows the consultant\'s words, the quote only when it differs, the sentence around it, and what is and is not established',()=>{
 const m=C.claimModel({claim_id:'c1',claim_type:'metric',statement:'It fell from 40 to 12.',origin:'consultant_reported',attribution:'unknown',
  source_refs:[{kind:'interview',quote:'It fell from 40 to 12.',ledger_status:'uncertain',asr_min_conf:0.52,context:'If it had fallen, we would have said so.',lang:'en'}]});
 assert.deepEqual([m.type,m.statement,m.quote,m.lang],['Metric','It fell from 40 to 12.','','en']);
 assert.equal(m.context,'If it had fallen, we would have said so.');
 assert.ok(m.tags.includes('estimate')&&m.tags.includes('attribution not established')&&m.tags.includes('speech recognition 52% sure')&&m.tags.includes('said by the consultant'),m.tags.join('|'));
 assert.equal(C.claimModel({statement:'S',source_refs:[{kind:'interview',quote:'Heard: S'}]}).quote,'Heard: S');
 assert.equal(C.claimModel(null).type,'Claim');
});

test('keys: J K A R U E, never while typing and never with a modifier',()=>{
 const k=(key,extra={})=>C.keyAction({key,target:{tagName:'DIV'},...extra});
 assert.deepEqual(['j','k','a','r','u','e','J','A'].map(x=>k(x)),['next','prev','approve','changes','undo','amend','next','approve']);
 assert.equal(k('x'),null);assert.equal(k('a',{ctrlKey:true}),null);assert.equal(k('r',{metaKey:true}),null);assert.equal(k('a',{altKey:true}),null);
 for(const tagName of ['INPUT','TEXTAREA','SELECT'])assert.equal(C.keyAction({key:'a',target:{tagName}}),null);
 assert.equal(C.keyAction({key:'a',target:{tagName:'DIV',isContentEditable:true}}),null);assert.equal(C.keyAction(null),null);
});

function fakeClock(){let t=0,id=0;const q=new Map();return {setT:(f,ms)=>{q.set(++id,{f,at:t+ms});return id;},clearT:i=>q.delete(i),now:()=>t,
 tick(ms){t+=ms;for(const [i,e] of [...q])if(e.at<=t){q.delete(i);e.f();}},size:()=>q.size};}
const settle=()=>new Promise(r=>setImmediate(r));

test('deferred: nothing is written until eight seconds pass; undo inside that time means it was never written',async()=>{
 const clk=fakeClock(),d=C.createDeferred({...clk}),log=[];
 d.start({id:'x',commit:async()=>{log.push('commit');return 1;},onDone:r=>log.push('done'+r),onUndo:()=>log.push('undo')});
 assert.equal(d.delay,8000);assert.equal(d.remaining(),8000);clk.tick(7900);await settle();assert.deepEqual(log,[]);assert.ok(d.pending());
 assert.equal(d.undo().id,'x');assert.deepEqual(log,['undo']);clk.tick(5000);await settle();assert.deepEqual(log,['undo'],'an undone decision is never committed');assert.equal(d.pending(),null);assert.equal(d.undo(),null);
 d.start({id:'y',commit:async()=>{log.push('commit-y');return 2;},onDone:r=>log.push('done'+r)});clk.tick(8000);await settle();assert.deepEqual(log,['undo','commit-y','done2']);assert.equal(d.pending(),null);
});

test('deferred: a second decision writes the first at once, there is never more than one waiting, a failure is reported not swallowed',async()=>{
 const clk=fakeClock(),d=C.createDeferred({...clk}),log=[];
 d.start({id:'1',commit:async()=>{log.push('c1');},onDone:()=>log.push('d1')});
 d.start({id:'2',commit:async()=>{throw new Error('nope');},onDone:(r,e)=>log.push('d2:'+(e&&e.message))});
 await settle();assert.deepEqual(log,['c1','d1']);assert.equal(d.pending().id,'2');
 clk.tick(8000);await settle();assert.deepEqual(log,['c1','d1','d2:nope']);
 d.start({id:'3',commit:async()=>{log.push('c3');}});await d.flush();assert.deepEqual(log.slice(-1),['c3']);assert.equal(clk.size(),0,'the timer is cleared when flushed');
});

test('browser wording becomes a calm sentence; the server\'s plain sentences pass through; the gate\'s codes are said in words',()=>{
 for(const m of ['Failed to fetch','TypeError: Failed to fetch','NetworkError when attempting to fetch resource.','Load failed','The operation was aborted.'])assert.equal(C.humanError(new Error(m)),C.LOAD_FAIL,m);
 assert.equal(C.humanError(new TypeError('x')),C.LOAD_FAIL);assert.equal(C.humanError(new Error('Failed to fetch'),{write:true}),C.SEND_FAIL);
 assert.equal(C.humanError(new Error('The library did not answer.')),'The library did not answer.');assert.equal(C.humanError(''),C.LOAD_FAIL);
 assert.equal(C.humanError(new Error('Open 914b6732-7bf8-4906-a1b2-0123456789ab')),'Open this project');
 assert.match(C.LOAD_FAIL,/^We couldn’t load this\. Your work is safe\.$/);assert.ok(C.isRaw('Failed to fetch')&&!C.isRaw('Sign in first.'));
 assert.match(C.decisionError(Object.assign(new Error('Not allowed: SELF_APPROVAL'),{reason:'SELF_APPROVAL'})),/cannot approve your own/);
 assert.match(C.decisionError(Object.assign(new Error('Not allowed: REVISION_MISMATCH'),{})),/changed/);
 assert.match(C.decisionError(new Error('Not allowed: SOMETHING_NEW')),/did not allow/);assert.equal(C.decisionError(new Error('Failed to fetch')),C.SEND_FAIL);
 assert.ok(!/[A-Z]{4,}_[A-Z]{3,}/.test(Object.values(C.DECISION_WORDS).join(' ')),'no raw codes in the words');
});

const P=(o={})=>({id:'p1',title:'Claims triage rebuild',interview:{transcript:'x'},details:{projectId:'PRJ-1'},...o});
const states=m=>m.steps.map(s=>s.state).join(' ');
test('the journey has seven steps in the order the workflow was drawn, and the current one is the first not yet done',()=>{
 const m=C.stripModel({project:P({interview:null,answers:['','','','','','']})});
 assert.deepEqual(m.steps.map(s=>s.label),['Project','Interview','Read-back','Submitted','In review','Approved','Published or held']);
 assert.equal(states(m),'done current todo todo todo todo todo');assert.equal(m.current,1);assert.equal(m.name,'Claims triage rebuild');
 assert.equal(states(C.stripModel({project:P()})),'done done current todo todo todo todo','interviewed, no read-back yet');
 assert.equal(states(C.stripModel({project:P(),item:{state:'evidence_draft'}})),'done done done current todo todo todo');
 const q=C.stripModel({project:P(),item:{state:'reviewer_queue'}});assert.equal(states(q),'done done done done current todo todo');assert.equal(q.summary,'In review');assert.match(q.steps[4].note,/Waiting for a reviewer/);
 assert.equal(states(C.stripModel({project:P(),item:{state:'approved'}})),'done done done done done done current','approved, nothing published yet');
 const held=C.stripModel({project:P(),item:{state:'downstream_proposals'},status:{cards:[{branch:'spotlight',display_status:'held'}]}});
 assert.equal(states(held),'done done done done done done held');assert.match(held.steps[6].note,/Not published/);assert.equal(held.summary,'Published or held (held)');
 const pub=C.stripModel({project:P(),item:{state:'downstream_proposals'},status:{cards:[{branch:'spotlight',display_status:'published'}]}});assert.equal(states(pub),'done done done done done done done');assert.equal(pub.current,6);
 assert.equal(states(C.stripModel({})),'todo todo todo todo todo todo todo');
});
test('changes requested, a refusal and a withdrawal are shown as needing attention, in the right step, and never as progress',()=>{
 const c=C.stripModel({project:P(),item:{state:'needs_clarification'}});assert.equal(states(c),'done done done done attention todo todo');assert.match(c.steps[4].note,/Changes requested/);assert.equal(c.state,'attention');
 assert.equal(states(C.stripModel({project:P(),item:{state:'rejected'}})),'done done done done done attention todo');
 assert.equal(states(C.stripModel({project:P(),item:{state:'disputed'}})),'done done done done done attention todo');
 assert.equal(states(C.stripModel({project:P(),item:{state:'withdrawn'}})).split(' ').slice(4,6).join(' '),'done attention','withdrawn after review: the review step is done, the decision step needs attention');
 assert.equal(C.stripModel({project:P(),item:{state:'impact_review'}}).steps[5].state,'attention');
});
test('without an evidence record the library status of the project is read; an unknown status never moves the strip forward',()=>{
 const lib=s=>states(C.stripModel({project:P({library:{status:s}})}));
 assert.equal(lib('draft'),'done done done current todo todo todo');
 for(const s of ['in_review','needs_work','awaiting_validation','changes_requested'])assert.equal(lib(s),'done done done done current todo todo',s);
 assert.equal(lib('published'),'done done done done done done current');
 assert.equal(lib('something_new'),'done done done done current todo todo','a reference that left draft was submitted; a status that is not known is never read as reviewed or approved');
});
test('the evidence record of a project is found by its Project ID or the page id, the newest wins, and a record of someone else is not used',()=>{
 const items=[{id:'1',project_ref:'PRJ-1',updated_at:'2026-11-01T00:00:00Z',mine:true},{id:'2',project_ref:'PRJ-1',updated_at:'2026-11-03T00:00:00Z',mine:true},{id:'3',project_ref:'p2',mine:true},{id:'4',project_ref:'PRJ-1',updated_at:'2026-11-09T00:00:00Z',mine:false}];
 assert.equal(C.itemFor(P(),items).id,'2');assert.equal(C.itemFor({id:'rebuilt',library:{id:'ref9'}},[{id:'7',library_id:'ref9',mine:true},{id:'8',library_id:'other',mine:true}]).id,'7','a project that came back after a reload is found by its library reference');assert.equal(C.itemFor({id:'p2'},items).id,'3');assert.equal(C.itemFor({id:'zz'},items),null);assert.equal(C.itemFor(null,items),null);
});
