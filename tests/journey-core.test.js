// v2.2 W1: the case-study model, the opening split, the picker and the staffing prefill (src/journey-core.js). Pure functions.
const test=require('node:test'),assert=require('node:assert/strict');
const J=require('../src/journey-core.js'),B=require('../src/storyboard-core.js');
const NUMERIC=/(?<!\w)(?:\d+(?:[.,]\d+)?\s*(?:%|percent|hours?|minutes?|days?|million|[kmb]\b)|[$€£]\s*\d+)/.source;
const spans=q=>B.metricSpans(q,NUMERIC);
const at=(h,m)=>new Date(2026,9,31,h,m).getTime();
const item=(id,field,label,quote,more={})=>({id,field,label,quote,tags:[],editable:true,...more});
const ITEMS=[
 item('D-001','problem','Customer problem','Claims were bouncing between three teams.'),
 item('D-002','stakes','Business stakes','Payouts were late and customers called twice.'),
 item('D-003','intervention','What changed','I built a routing model for the intake queue.'),
 item('D-004','decision','Decision and trade-off','We chose rules over a learned model so auditors could read each decision.'),
 item('D-005','contribution','Personal contribution','I owned the routing model and the rules; Sam owned the dashboard.'),
 item('D-006','outcome','Observed outcome','Triage went from 40 minutes to 12 minutes per claim.'),
 item('D-007','evidence','Supporting artifact','The team dashboard shows it.')];
const HEARD=[{text:'We rebuilt intake. Claims were bouncing between three teams.',at:at(10,42)},{text:'I built a routing model for the intake queue.',at:at(10,47)},{text:'Triage went from 40 minutes to 12 minutes per claim. The team dashboard shows it.',at:at(10,51)}];

test('the quotes land in Challenge, Approach, Your contribution, Outcome, in that order, and every quote keeps its own id',()=>{
 const cs=J.caseStudy({items:ITEMS},{heard:HEARD,spans});
 assert.deepEqual(cs.sections.map(s=>s.title),['Challenge','Approach','Your contribution','Outcome','Evidence and fit']);
 assert.deepEqual(cs.sections[0].quotes.map(q=>q.id),['D-001','D-002']);assert.deepEqual(cs.sections[1].quotes.map(q=>q.id),['D-003','D-004']);
 assert.equal(cs.total,7);assert.equal(cs.sections.flatMap(s=>s.quotes).length,7,'nothing is dropped');
});
test('NOTHING IS INVENTED: every quote on screen is a server item verbatim; every other word is a fixed label',()=>{
 const cs=J.caseStudy({items:ITEMS},{heard:HEARD,spans});const said=new Set(ITEMS.map(x=>x.quote)),labels=new Set(J.fixedText());
 for(const s of cs.sections){assert.ok(labels.has(s.title),s.title+' is a fixed label');assert.match(s.provenance,/^From your words/);
  for(const q of s.quotes)assert.ok(said.has(q.quote),'a quote is the consultant\'s words exactly');}
 for(const t of cs.sections.flatMap(s=>s.quotes.map(q=>q.tags.join(' '))))assert.equal(t,'');
 const n=cs.numbers;assert.ok(n);for(const f of n.kind==='beforeAfter'?[n.before,n.after]:n.figures)assert.ok(ITEMS.some(x=>x.quote.includes(f.text)),'a figure is an exact span of a quote');
});
test('provenance names the time the words were said; a quote nobody said at a known time has no time',()=>{
 const cs=J.caseStudy({items:ITEMS},{heard:HEARD,spans});
 assert.equal(cs.sections[0].provenance,'From your words, 10:42');assert.equal(cs.sections[1].quotes[0].at,'10:47');assert.equal(cs.sections[1].quotes[0].at.length,5);
 assert.equal(cs.sections[3].provenance,'From your words, 10:51');
 const none=J.caseStudy({items:ITEMS},{heard:[],spans});assert.equal(none.sections[0].provenance,'From your words');assert.equal(none.sections[0].quotes[0].at,'');
 assert.equal(J.clockOf(at(9,5)),'09:05');assert.equal(J.clockOf(0),'');assert.equal(J.clockOf('x'),'');
});
test('"from A to B" gives a before/after strip with the two figures exactly as said; two loose figures give a plain numbers strip; one figure gives none',()=>{
 const ba=J.caseStudy({items:ITEMS},{spans}).numbers;assert.equal(ba.kind,'beforeAfter');assert.equal(ba.before.text,'40 minutes');assert.equal(ba.after.text,'12 minutes');
 const loose=[item('D-1','outcome','Observed outcome','Triage dropped to 12 minutes.'),item('D-2','measurement','Measurement basis','We measured 40 minutes over six weeks before the pilot.')];
 const l=J.caseStudy({items:loose},{spans}).numbers;assert.equal(l.kind,'figures');assert.deepEqual(l.figures.map(f=>f.text),['12 minutes','40 minutes']);
 assert.equal(J.caseStudy({items:[loose[0]]},{spans}).numbers,null);assert.equal(J.caseStudy({items:ITEMS.slice(0,3)},{spans}).numbers,null);
 const wrong=[item('D-1','outcome','Observed outcome','We went to 12 minutes.')];assert.equal(J.caseStudy({items:wrong},{spans}).numbers,null,'one figure: no strip');
});
test('a kept-private item stays in its block, struck out and not editable, and is not counted as reviewed content',()=>{
 const kept=new Map([['D-009',item('D-009','problem','Customer problem','The client is called Acme.')]]);
 const cs=J.caseStudy({items:ITEMS},{kept,spans});const q=cs.sections[0].quotes;
 const k=q.find(x=>x.id==='D-009');assert.equal(k.private,true);assert.equal(k.editable,false);assert.equal(k.at,'');assert.equal(cs.keptCount,1);assert.equal(cs.total,7,'kept-private items are not part of the story');
 assert.equal(J.caseStudy({items:[...ITEMS,item('D-009','problem','Customer problem','x')]},{kept,spans}).keptCount,0,'an item the server still lists is not marked private');
 assert.equal(cs.sections[0].provenance,'From your words');
});
test('n of N reviewed follows the set of ids the person has read or acted on',()=>{
 const seen=new Set(['D-001','D-003','D-777']);const cs=J.caseStudy({items:ITEMS},{seen,spans});assert.equal(cs.reviewed,2);assert.equal(cs.total,7);
});
test('the opening splits into the greeting and the question; no question, one bubble; no lead-in lost',()=>{
 const g='Hi, I’m ATLAS, and I’ll help you tell the story of your project. I’ll capture what you say, you review it first, and nothing is reused without your permission. If something is client-confidential, say so and I’ll note it without the details. At the end, I’ll read back a summary for you to correct before anything goes to review.';
 for(const q of ['To start, could you tell me about the project and what you were brought in to do? Take your time.','First, what is the opportunity ID (Opp ID) for this project?']){
  const [a,b,...more]=J.stageOpening(g+' '+q);assert.equal(more.length,0);assert.equal(a,g);assert.equal(b,q);}
 assert.deepEqual(J.stageOpening(g),[g]);assert.deepEqual(J.stageOpening('Which part?'),['Which part?']);assert.deepEqual(J.stageOpening(''),[]);
 assert.equal(J.stageOpening('Hello there. What was the project?').join('|'),'Hello there.|What was the project?');
 assert.ok(J.wordCount(J.stageOpening(g+' Q?')[0])>35,'the pinned greeting is longer than 35 words: it is staged, not shortened');
});
test('the picker lists staffing rows and the person\'s own projects, searches them, and lists a staffed project once',()=>{
 const rows=[{projectId:'PRJ-2291',projectTitle:'Claims triage rebuild',endDate:'2026-11-20',managerName:'Sam Lead'},{projectId:'PRJ-1000',projectTitle:'',endDate:''}];
 const projects=[{id:'a',title:'Grid analytics',stage:'Pilot',role:'Data engineer'},{id:'b',title:'Claims triage rebuild',stage:'Pilot',role:'x',sheet:{oppId:'PRJ-2291'}},{id:'s',title:'Example',sample:true}];
 const m=J.pickerModel(rows,projects,'');assert.deepEqual(m.items.map(x=>x.kind+':'+x.title),['staffing:PRJ-1000','project:Grid analytics','project:Claims triage rebuild']);assert.equal(m.empty,false);
 assert.deepEqual(J.pickerModel(rows,projects,'grid').items.map(x=>x.title),['Grid analytics']);assert.deepEqual(J.pickerModel(rows,projects,'prj-1000').items.map(x=>x.ref),['PRJ-1000']);
 assert.equal(J.pickerModel([],[],'').empty,true);assert.deepEqual(J.pickerModel(null,null,'x').items,[]);
});
test('a staffing row fills the title, the Opp/project id, the end month and the N+1; the person\'s own role comes from their profile; nothing else is guessed',()=>{
 const v=J.staffingValues({projectId:'PRJ-2291',projectTitle:'Claims triage rebuild',endDate:'2026-11-20',managerName:'Sam Lead',managerEmail:'sam@mantu.com'},{consultant:'Alex Doe',role:'Data engineer'});
 assert.deepEqual(v,{title:'Claims triage rebuild',consultant:'Alex Doe',role:'Data engineer',oppId:'PRJ-2291',details:{projectId:'PRJ-2291',end:'2026-11'},manager:{name:'Sam Lead',email:'sam@mantu.com'}});
 assert.equal(J.staffingValues({projectId:'P'},{}).title,'P');assert.ok(!('end' in J.staffingValues({projectId:'P',endDate:'soon'},{}).details));
});
test('the submit sheet has the five steps and the one line about who can see it',()=>{
 assert.deepEqual(J.SUBMIT_STEPS,['Submitted','Quality review','N+1 review','Approved','Published or held']);
 assert.equal(J.SUBMIT_LINE,'Your N+1 and reviewers can now see this. Nothing else has left your private draft.');
 assert.equal(J.FIRST_RUN_STEPS.length,3);assert.equal(J.FIRST_RUN_PRIVACY,'Only you see it until you press Submit.');
});
