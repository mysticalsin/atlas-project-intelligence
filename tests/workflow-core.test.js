const test=require('node:test'),assert=require('node:assert/strict'),W=require('../src/workflow-core.js');
const ORDER=['evidence','maap','project_review','dna','michat','imp','spotlight'];
const card=(branch,display_status,extra={})=>({branch,label:branch,status:display_status,display_status,mock:['dna','michat','imp','spotlight'].includes(branch),updated_at:'2026-11-01T00:00:00.000Z',reason:null,...extra});
const view=(statuses,extra={})=>({cards:ORDER.map((b,i)=>card(b,statuses[i])),overall:{status:'in_progress',complete:false},adapters:'mock',...extra});
const APPROVED_MOCK=['approved','pending','pending','mock_acknowledged','mock_acknowledged','mock_acknowledged','draft'];
test('seven cards in the pack order, labelled by the client, whatever order or labels the server sends',()=>{
 const v=view(APPROVED_MOCK);v.cards.reverse();v.cards.forEach(c=>{c.label='<img src=x onerror=alert(1)>';});
 const m=W.model(v);assert.deepEqual(m.cards.map(c=>c.branch),ORDER);
 assert.deepEqual(m.cards.map(c=>c.label),['Evidence','MAAP Review','Project Review','DNA','MiChat CV','IMP','Spotlight']);
});
test('every destination that is not really connected carries the "Mock — not connected" badge; evidence, MAAP and Project Review never do',()=>{
 const m=W.model(view(APPROVED_MOCK));
 assert.deepEqual(m.cards.map(c=>c.badge),['','','','Mock — not connected','Mock — not connected','Mock — not connected','Mock — not connected']);
 assert.deepEqual(m.cards.map(c=>c.mock),[false,false,false,true,true,true,true]);
 assert.match(m.note,/Nothing was sent to a real system/);
 assert.equal(W.model(view(APPROVED_MOCK.map(()=>'pending'))).cards[0].badge,'');
 const live=W.model({cards:[card('dna','sync_complete',{mock:false})]}).cards[3];assert.deepEqual([live.mock,live.badge],[false,'']); // only an explicit mock:false (a live ack) drops the badge
 assert.equal(W.cardModel({branch:'dna',display_status:'pending'}).mock,true); // a missing flag is not "live"
});
test('a mock acknowledgement reads "not synced", never "Synced"',()=>{
 const c=W.model(view(APPROVED_MOCK)).cards[3];assert.equal(c.statusText,'Mock acknowledged — not synced');assert.equal(c.tone,'mock');
 assert.ok(!/^Synced/.test(c.statusText));assert.equal(W.cardModel({branch:'dna',display_status:'sync_complete',mock:false}).statusText,'Synced');
});
test('the overall line is never "complete" while any card is pending, failed, held, mock-acknowledged or unknown',()=>{
 assert.deepEqual(W.model(view(APPROVED_MOCK)).overall,{status:'in_progress',text:'In progress: not every step is finished.',complete:false});
 for(let i=0;i<7;i++)for(const s of ['pending','failed','held','mock_acknowledged','in_progress','waiting_permission','not_started','impact_review','weird_new_status']){
  const ds=['approved','closed','closed','sync_complete','sync_complete','sync_complete','published'];ds[i]=s;
  const m=W.model({cards:ORDER.map((b,j)=>card(b,ds[j],{mock:false})),overall:{complete:true}});
  assert.equal(m.overall.complete,false,`${ORDER[i]}=${s}`);assert.notEqual(m.overall.status,'complete');
 }
 const bad=W.model(view(['approved','pending','pending','mock_acknowledged','failed','mock_acknowledged','draft']));assert.equal(bad.overall.status,'attention');assert.match(bad.overall.text,/Needs attention/);
 assert.equal(W.model(null).overall.complete,false);assert.equal(W.model({cards:'x'}).cards.length,7);assert.equal(W.model({}).overall.status,'attention'); // unknown cards are attention, not silence
});
test('"complete" needs every card finished AND the server to agree; MAAP and Project Review cannot close here',()=>{
 const all=['approved','closed','closed','sync_complete','sync_complete','sync_complete','published'];
 const v={cards:ORDER.map((b,i)=>card(b,all[i],{mock:false})),overall:{complete:true}};
 // "closed" is not a display status the server can produce today, so even all-green is shown as attention (unknown), never complete:
 assert.equal(W.model(v).overall.complete,false);
 const w=W.model({cards:ORDER.map((b,i)=>card(b,all[i],{mock:false})),overall:{complete:false}});assert.equal(w.overall.complete,false);
 assert.ok(!W.STATUS.closed,'no card can show a closed MAAP or Project Review');
});
test('reasons are words; gates, purposes and unknown codes are bounded and never markup',()=>{
 assert.equal(W.reasonText('MAAP_NOT_CONFIGURED'),'The MAAP rubric has not been configured by its process owner.');
 assert.equal(W.reasonText('SPOTLIGHT_GATE_OPEN:brand_approval'),'Waiting for brand approval.');
 assert.equal(W.reasonText('SPOTLIGHT_GATE_OPEN:zzz'),'Waiting for a gate.');
 assert.equal(W.reasonText('PURPOSE_NOT_GRANTED:skills_profile'),'No permission for skills profile yet.');
 assert.equal(W.reasonText('PERMISSION_REVOKED:cv'),'Permission for CV use was withdrawn.');
 assert.equal(W.reasonText('PURPOSE_GRANT_NOT_BOUND_TO_REVISION:matching'),'The permission for matching was given for an earlier revision.');
 assert.equal(W.reasonText('MOCK_MICHAT_DOWN'),'Reported: MOCK_MICHAT_DOWN');
 for(const bad of ['<script>alert(1)</script>','a b','',null,undefined,5,'X'.repeat(200)])assert.equal(W.reasonText(bad),'');
 assert.equal(W.reasonText('MOCK_NOT_SYNCED'),'A test acknowledgement only. Nothing reached a real system.');
});
test('Spotlight: a held story is not published; the library "published" label is "Shared in internal library" (D17)',()=>{
 const s=W.cardModel({branch:'spotlight',display_status:'held',reason:'MOCK_CMS_NOT_PUBLISHED',mock:true});
 assert.equal(s.statusText,'Held by the test CMS — not published');assert.equal(s.reasonText,'The test CMS holds it. Nothing is published.');assert.ok(!/^Published/.test(s.statusText));
 assert.equal(W.cardModel({branch:'spotlight',display_status:'draft'}).statusText,'Story draft');
 assert.equal(W.libraryStatusLabel('published'),'Shared in internal library');assert.notEqual(W.libraryStatusLabel('published'),'Published');
 assert.deepEqual(['in_review','needs_work','changes_requested','awaiting_validation','withdrawn'].map(W.libraryStatusLabel),['In review','Needs work','Changes requested','Awaiting N+1','Withdrawn']);
 assert.equal(W.libraryStatusLabel('constructor'),'');assert.equal(W.libraryStatusLabel(undefined),'');
});
test('untrusted cards are tamed: unknown branches, odd statuses, prototype keys and long timestamps',()=>{
 for(const c of [null,undefined,'x',5,[],{},{branch:'constructor',display_status:'__proto__'},{branch:'dna',display_status:'toString'}]){const m=W.cardModel(c);assert.ok(typeof m.statusText==='string'&&m.statusText.length);assert.ok(['ok','work','wait','mock','bad','hold','idle'].includes(m.tone));}
 assert.equal(W.cardModel({branch:'dna',display_status:'toString'}).displayStatus,'unknown');assert.equal(W.cardModel({branch:'dna',display_status:'x',updated_at:'9'.repeat(100)}).updatedAt.length,40);
 assert.equal(W.cardModel({branch:'nope',display_status:'approved'}).label,'Unknown');
});
test('evidence picker labels',()=>{
 assert.equal(W.itemLabel({project_ref:'PRJ-1',state:'approved',revision:2}),'PRJ-1 · Approved · revision 2');
 assert.equal(W.itemLabel({state:'evidence_draft',revision:1}),'Interview evidence · Draft · revision 1');
 assert.equal(W.itemLabel({project_ref:'PRJ-1',state:'downstream_proposals',revision:2}),'PRJ-1 · Approved · revision 2'); // proposed downstream is still approved to the person
 assert.match(W.itemLabel(null),/^Interview evidence · .* · revision \?$/);
});
