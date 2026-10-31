'use strict';
// Live story board model (WOW_SPEC F5.1, F5.4): pure functions only, real AtlasGeo, the real ledger policy from Python.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{spawnSync}=require('node:child_process');
const B=require('../src/storyboard-core.js'),G=require('../src/geo.js'),ROOT=path.join(__dirname,'..');
// The same policy build.py injects as window.ATLAS_POLICY: never a copy of the regex.
const py=spawnSync('python3',['-c','import json,sys;sys.path.insert(0,sys.argv[1]);from atlas_voice.quality import NUMERIC,FIELDS,TO_TOPIC;print(json.dumps({"NUMERIC_SRC":NUMERIC.pattern,"FIELDS":FIELDS,"TO_TOPIC":TO_TOPIC}))',ROOT],{encoding:'utf8'});
const POLICY=py.status===0?JSON.parse(py.stdout):null,needPolicy={skip:POLICY?false:'python3 with atlas_voice.quality is required'};
const d=(id,field,quote,extra={})=>({id,field,item_id:'user-1',quote,status:'reported',active:true,supersedes:'',provenance:'unverified_speech_recognition',...extra});
const state=(quality,extra={})=>({quality,heard:[],qualitySeq:1,session:{},now:0,policy:POLICY,geo:G,...extra});
const codes=r=>r.pins.map(p=>p.code);
const WORDS=/\b(?:verified|confirmed|approved)\b/i;  // 'unverified' never matches: no word boundary inside it

test('exports are the fixed contract',()=>{assert.deepEqual(Object.keys(B).sort(),['diff','metricSpans','model','pinsOf','summaryText','summaryView']);});

test('pins: only cued country names',()=>{
 assert.deepEqual(codes(B.pinsOf('We worked in Portugal and Spain for two years.',G)),['PRT','ESP']);
 assert.deepEqual(codes(B.pinsOf('The rollout went across France, Germany and Italy.',G)),['FRA','DEU','ITA']);
 assert.deepEqual(codes(B.pinsOf('We moved the team to the Netherlands.',G)),['NLD']);
 assert.deepEqual(codes(B.pinsOf('A pilot within the United Kingdom',G)),['GBR']);
 assert.deepEqual(codes(B.pinsOf('We delivered into Spain, and Portugal later',G)),['ESP','PRT']);
 for(const q of ['Chad said the queue was fine.','Jordan agreed with the plan.','Lisbon queue times dropped.','Portugal and Spain were both slow.'])
  assert.deepEqual(B.pinsOf(q,G).pins,[],q);
 assert.deepEqual(B.pinsOf('Chad said it was fine',G).notMapped.map(x=>x.text),['Chad']);
 assert.deepEqual(B.pinsOf('Jordan agreed',G).notMapped.map(x=>x.text),['Jordan']);
 assert.deepEqual(B.pinsOf('Lisbon queue times dropped.',G),{pins:[],notMapped:[]},'no city gazetteer: an uncued city is neither pinned nor guessed');
 assert.deepEqual(codes(B.pinsOf('Chad said we were in Chad',G)),['TCD'],'a cued mention pins; the uncued one is not listed twice');
 assert.deepEqual(B.pinsOf('Chad said we were in Chad',G).notMapped,[]);
 // a cued list stops at a word that is not a place
 assert.deepEqual(codes(B.pinsOf('We ran it in Portugal and Jordan agreed later.',G)),['PRT','JOR'],'"and" continues a cued list (documented limit)');
 assert.deepEqual(codes(B.pinsOf('We ran it in Portugal while Jordan agreed.',G)),['PRT']);});

test('pins: aliases, cities and ambiguous names are never mapped',()=>{
 const holland=B.pinsOf('We shipped to Holland.',G);assert.deepEqual(holland.pins,[]);assert.deepEqual(holland.notMapped.map(x=>x.text),['Holland']);
 assert.deepEqual(B.pinsOf('The office in Mexico City',G).pins,[],'a city named after its country is not the country');
 assert.deepEqual(B.pinsOf('We worked in the UK',G).pins,[],'an abbreviation is not the country name');
 const georgia=B.pinsOf('We delivered the programme in Georgia last year.',G);
 assert.deepEqual(georgia.pins,[],'Georgia is ambiguous in free text');assert.ok(georgia.notMapped.some(x=>x.text==='Georgia'));
 assert.deepEqual(B.pinsOf('We worked in Congo',G).pins,[],'ambiguous name');
 assert.deepEqual(codes(B.pinsOf('Operations across South Sudan and Sudan',G)),['SDS','SDN'],'longest name first, no overlap');
 assert.deepEqual(B.pinsOf('Around Lake Chad the pumps failed',G).pins,[],'part of a longer place name');
 assert.deepEqual(B.pinsOf('',G),{pins:[],notMapped:[]});assert.deepEqual(B.pinsOf('in Spain',null),{pins:[],notMapped:[]});});

test('pins: a cued country name still pins when an alias of it comes first',()=>{
 // The resolver keeps one fragment per country (the first, 'UK'); the cued exact name later in the quote must still be found.
 const uk=B.pinsOf('A UK bank asked us to roll it out in the United Kingdom.',G);
 assert.deepEqual(codes(uk),['GBR']);assert.deepEqual(uk.notMapped,[],'the alias chip goes once its country is pinned');
 assert.deepEqual(codes(B.pinsOf('Holland was first; then we went live in the Netherlands.',G)),['NLD']);
 assert.deepEqual(codes(B.pinsOf('The US team helped us deliver in the United States.',G)),['USA']);
 assert.deepEqual(codes(B.pinsOf('Britain first, then we deployed in the United Kingdom and in Germany.',G)),['GBR','DEU']);
 // the name alone is still not enough: without a cue, or as part of a longer place, nothing pins
 assert.deepEqual(B.pinsOf('A UK bank said the United Kingdom team was slow.',G).pins,[]);
 assert.deepEqual(B.pinsOf('The Mexico City office and Mexico headquarters agreed.',G).pins,[]);});

test('pins: lower-case speech recognition still needs the cue',()=>{
 assert.deepEqual(codes(B.pinsOf('we worked in portugal and spain',G)),['PRT','ESP']);
 assert.deepEqual(B.pinsOf('chad said so',G).pins,[]);});

test('metrics: exact substrings, grown spans, ranges, merging, unit flag',needPolicy,()=>{
 const one=(q,text,unit,unclear=false)=>{const m=B.metricSpans(q,POLICY.NUMERIC_SRC);
  assert.deepEqual(m.map(x=>x.text),[text],q);assert.equal(m[0].unit,unit,q);assert.equal(m[0].unitUnclear,unclear,q);
  assert.equal(q.slice(m[0].start,m[0].end),m[0].text,'exact substring');};
 one('We cut costs by $3.5 million in year one.','$3.5 million','million');
 one('We saved €2 million over the contract.','€2 million','million');
 one('Lead time went from 12 to 4 days.','12 to 4 days','days');
 one('We laid 1.5 m of cable.','1.5 m','m',true);
 one('Errors fell 40% after the launch.','40%','%');
 one('Backlog shrank 4-6 days on average','4-6 days','days');
 one('A drop of 30–40% in rework','30–40%','%');
 one('It cost $5k in licences','$5k','k',false);
 one('Around 5k tickets a month','5k','k',true);
 one('Roughly 1,200 hours were saved','1,200 hours','hours');
 one('It took 3 hours to 12 teams','3 hours','hours');  // a bare number AFTER a span is never pulled in
 assert.deepEqual(B.metricSpans('from 10% to 40%',POLICY.NUMERIC_SRC).map(x=>x.text),['10%','40%'],'two measured values stay two chips');
 assert.deepEqual(B.metricSpans('3 percentage points',POLICY.NUMERIC_SRC),[],'a unit cut inside a longer word is not a figure');
 assert.deepEqual(B.metricSpans('5 daily runs',POLICY.NUMERIC_SRC),[]);
 assert.deepEqual(B.metricSpans('In 2023 we hired 12 people',POLICY.NUMERIC_SRC),[],'numbers without a unit are not figures');
 assert.deepEqual(B.metricSpans('twelve days',POLICY.NUMERIC_SRC),[]);
 const q='We went from 12 to 4 days, saving $3.5 million and 40% of rework.';
 for(const m of B.metricSpans(q,POLICY.NUMERIC_SRC))assert.ok(q.includes(m.text),'never normalised: '+m.text);});

test('metrics: NUMERIC_SRC comes from the injected policy',()=>{
 assert.deepEqual(B.metricSpans('40% and 3 days',String.raw`\d+%`).map(x=>x.text),['40%'],'a different policy detects differently');
 assert.deepEqual(B.metricSpans('40% and 3 days',''),[]);assert.deepEqual(B.metricSpans('40%',undefined),[]);
 assert.deepEqual(B.metricSpans('40%','('),[],'a broken pattern yields nothing rather than throwing');
 const m=B.model({quality:{candidate_details:[d('D-001','outcome','Errors fell 40% after 3 days')]},policy:{FIELDS:{outcome:['Observed outcome','?']},NUMERIC_SRC:String.raw`\d+%`},geo:G});
 assert.deepEqual(m.metrics.map(x=>x.text),['40%']);
 assert.deepEqual(B.model({quality:{candidate_details:[d('D-001','outcome','Errors fell 40%')]},policy:{FIELDS:{outcome:['Observed outcome','?']}},geo:G}).metrics,[],'no policy regex, no figures');});

test('model: the exact F5.1 shape and the synthetic interview',needPolicy,()=>{
 const q={candidate_details:[
  d('D-001','problem','Our claims queue in Portugal and Spain was slow.'),
  d('D-002','outcome','Errors fell 40% and lead time went from 12 to 4 days.'),
  d('D-003','stakes','We cut costs by $3.5 million, we saved €2 million later.',{status:'uncertain'}),
  d('D-004','intervention','We laid 1.5 m of cable. Chad said the Lisbon queue was fine.'),
  d('D-005','measurement','No baseline, I don\'t know.',{status:'unknown'})],
  deferred_fields:{evidence:'Two clarification plans did not resolve this point'},measurement_gaps:['before/after','period','bogus'],
  flags:['Uncertainty must remain in the story'],next_field:'measurement',next_question:'What were the before and after values for that measure?',
  planned_question:'What were the before and after values for that measure?',story_route:'qualitative candidate'};
 const m=B.model(state(q,{session:{readyAt:1000,maxSeconds:900,mode:'full',timePlan:{depthAt:405,closingAt:690}},now:61000}));
 assert.deepEqual(Object.keys(m),['label','dims','coverage','pins','placesNotMapped','metrics','measurementSlots','corrected','challenge','time','gaps']);
 assert.equal(m.label,'From the interview · unverified');
 assert.deepEqual(m.coverage,{present:5,total:12,meaning:'candidate coverage, not verification'});
 assert.deepEqual(m.dims.map(x=>x.field),Object.keys(POLICY.FIELDS),'the 12 FIELDS in order');
 const dim=f=>m.dims.find(x=>x.field===f);
 assert.deepEqual(dim('problem'),{field:'problem',label:'Customer problem',state:'reported',count:1});
 assert.equal(dim('stakes').state,'uncertain');assert.equal(dim('measurement').state,'unknown');assert.equal(dim('evidence').state,'deferred');assert.equal(dim('decision').state,'empty');
 assert.deepEqual(m.pins,[{code:'PRT',name:'Portugal',detailIds:['D-001']},{code:'ESP',name:'Spain',detailIds:['D-001']}]);
 assert.deepEqual(m.placesNotMapped,['Chad']);
 assert.deepEqual(m.metrics.map(x=>[x.text,x.unit,x.unitUnclear,x.status]),[['40%','%',false,'reported'],['12 to 4 days','days',false,'reported'],
  ['$3.5 million','million',false,'uncertain'],['€2 million','million',false,'uncertain'],['1.5 m','m',true,'reported']]);
 assert.deepEqual(Object.keys(m.metrics[0]),['detailId','field','text','unit','unitUnclear','status']);
 assert.deepEqual(m.measurementSlots,[{need:'before/after'},{need:'period'}]);
 assert.deepEqual(m.challenge,{next:{field:'measurement',label:'Measurement basis'},planned:'What were the before and after values for that measure?',
  flags:['Uncertainty must remain in the story'],deferred:['evidence'],route:'qualitative candidate',analysing:false});
 assert.deepEqual(m.time,{elapsed:60,max:900,left:840,phase:'breadth'});
 assert.deepEqual(m.gaps,[]);});

test('supersede: the corrected chip disappears and the board says corrected',needPolicy,()=>{
 const q={candidate_details:[d('D-001','outcome','Errors fell 40%'),d('D-002','outcome','Sorry, errors fell 30%',{supersedes:'D-001'})]};  // a stale list still holding D-001
 const m=B.model(state(q));
 assert.deepEqual(m.metrics.map(x=>[x.detailId,x.text]),[['D-002','30%']]);
 assert.deepEqual(m.corrected,[{detailId:'D-001',supersededBy:'D-002'}]);
 assert.equal(m.dims.find(x=>x.field==='outcome').count,1);
 assert.match(B.summaryText(m),/corrected/);});

test('a lagging probe_history is never shown as asked',needPolicy,()=>{
 const q={candidate_details:[],next_field:'outcome',next_question:'What changed in practice?',planned_question:'What changed in practice?',
  probe_history:[{field:'problem',question:'OLD PLANNED QUESTION?',turn:'user-1',status:'planned_not_confirmed_spoken'}]};
 const m=B.model(state(q));
 assert.equal(m.challenge.planned,'What changed in practice?');
 assert.ok(!JSON.stringify(m).includes('OLD PLANNED QUESTION'),'probe_history never reaches the board');
 assert.doesNotMatch(B.summaryText(m),/\basked\b/i);assert.match(B.summaryText(m),/ATLAS may ask next about Observed outcome/);
 assert.equal(B.model(state({next_question:'Fallback?'})).challenge.planned,'Fallback?','next_question when no plan was made');});

test('analysing: a turn newer than the last quality event',needPolicy,()=>{
 const heard=[{item_id:'user-1',text:'We rebuilt triage.',seq:3}];
 assert.equal(B.model(state({},{heard,qualitySeq:2})).challenge.analysing,true);
 assert.equal(B.model(state({},{heard,qualitySeq:4})).challenge.analysing,false);
 assert.equal(B.model(state(null,{heard,qualitySeq:undefined})).challenge.analysing,true,'no quality yet');
 assert.equal(B.model(state({},{heard:[],qualitySeq:undefined})).challenge.analysing,false);});

test('time phases from ready.timePlan: full and gap',()=>{
 const full={readyAt:0,maxSeconds:900,mode:'full',timePlan:{depthAt:405,closingAt:690}};
 const at=(session,s)=>B.model({session,now:s*1000,policy:POLICY||{}}).time;
 assert.equal(at(full,0).phase,'breadth');assert.equal(at(full,404).phase,'breadth');assert.equal(at(full,405).phase,'depth');
 assert.equal(at(full,689).phase,'depth');assert.equal(at(full,690).phase,'closing');assert.deepEqual(at(full,2000),{elapsed:900,max:900,left:0,phase:'closing'});
 const gap={readyAt:0,maxSeconds:300,mode:'gap',timePlan:{depthAt:null,closingAt:210},gaps:[{id:'G1',label:'Observed outcome',ask:'Proof the bid needs: a KPI'}]};
 assert.deepEqual(at(gap,0),{elapsed:0,max:300,left:300,phase:'focused'});assert.equal(at(gap,209).phase,'focused');assert.equal(at(gap,210).phase,'closing');
 assert.equal(at({...full,stoppedAt:30000},600).elapsed,30,'the clock stops with the audio');
 assert.equal(at({readyAt:0,maxSeconds:900,mode:'full'},500).phase,null,'no timePlan: no phase is invented');
 assert.equal(at({readyAt:0,maxSeconds:300,mode:'gap'},10).phase,'focused');
 assert.deepEqual(B.model({}).time,{elapsed:0,max:null,left:null,phase:null});});

test('gap checklist: ready.gaps merged with quality.gap_status',()=>{
 const session={mode:'gap',gaps:[{id:'G1',label:'Observed outcome',ask:'Proof the bid needs: [company] KPI'},{id:'G2',label:'Supporting artifact',ask:'Proof the bid needs: a source'},{id:'G3',label:'Customer relevance',ask:'x'}]};
 const q={gap_status:[{id:'G1',field:'outcome',label:'Observed outcome',status:'answered_unverified',details:['D-001']},{id:'G2',status:'verified'},{id:'G9',status:'unknown'}]};
 assert.deepEqual(B.model({quality:q,session,policy:POLICY||{}}).gaps,[{id:'G1',label:'Observed outcome',status:'answered_unverified'},{id:'G2',label:'Supporting artifact',status:'open'},{id:'G3',label:'Customer relevance',status:'open'}]);
 assert.deepEqual(B.model({quality:q,session:{...session,mode:'full'}}).gaps,[],'full mode has no checklist');
 assert.deepEqual(B.model({quality:{gap_status:[{id:'G1',label:'Observed outcome',status:'deferred'}]},session:{mode:'gap'}}).gaps,[{id:'G1',label:'Observed outcome',status:'deferred'}]);});

test('diff: only items new by D-id, code, field state or ask status',needPolicy,()=>{
 const a=B.model(state({candidate_details:[d('D-001','outcome','Errors fell 40% in Spain')]}));
 const b=B.model(state({candidate_details:[d('D-001','outcome','Errors fell 40% in Spain'),d('D-002','problem','We worked in Portugal, it cost 3 days')]}));
 assert.deepEqual(B.diff(a,b).sort(),['dim:problem:reported','metric:D-002|3 days','pin:PRT']);
 assert.deepEqual(B.diff(b,b),[]);assert.deepEqual(B.diff(null,a).sort(),['dim:outcome:reported','metric:D-001|40%','pin:ESP']);});

test('hostile text stays plain data, bounded, and nothing claims a check',needPolicy,()=>{
 const x='<img src=x onerror=alert(1)>';
 const q={candidate_details:[d('<b>','outcome',x+' in Spain we saved 40%',{supersedes:'"><script>'}),{field:'problem',quote:x,id:{toString(){throw Error('no');}}},'junk',null],
  next_field:'<svg>',next_question:x,flags:[x,7],story_route:x,deferred_fields:{'<i>':'y'},measurement_gaps:[x]};
 const m=B.model(state(q));
 assert.deepEqual(m.metrics.map(y=>[y.detailId,y.text]),[['?0','40%']],'ids outside [A-Za-z0-9_-] are replaced, text kept exact');
 assert.deepEqual(m.pins.map(p=>p.code),['ESP']);assert.equal(m.challenge.planned,x,'data is returned as data; the UI renders it as text');
 assert.equal(m.challenge.next,null);assert.deepEqual(m.challenge.flags,[x]);assert.deepEqual(m.challenge.deferred,[]);assert.deepEqual(m.measurementSlots,[]);assert.deepEqual(m.corrected,[]);
 for(const bad of [undefined,null,'x',{quality:'x',heard:'y',session:7,policy:[]},{quality:{candidate_details:{}}}])assert.doesNotThrow(()=>B.summaryText(B.model(bad)));
 const s=B.summaryText(m);assert.doesNotMatch(s,WORDS);assert.match(s,/unverified/);assert.doesNotMatch(JSON.stringify({label:m.label,coverage:m.coverage}),WORDS);});

test('a full interview with a planned end shows elapsed time and the 20-30 minute range (Tony, 2026-10-31); the clock cap is the hard limit',()=>{
const at=(session,sec)=>B.model(state({}, {session,now:sec*1000})).time;
const full={readyAt:0,maxSeconds:1800,softSeconds:1200,mode:'full',timePlan:{depthAt:540,closingAt:930}};
assert.deepEqual(at(full,60),{elapsed:60,max:1800,left:1740,phase:'breadth',soft:1200});
assert.equal(at(full,1500).soft,1200);assert.equal(at(full,5000).elapsed,1800,'never past the hard cap');
assert.equal('soft' in at({...full,mode:'gap',maxSeconds:300,softSeconds:0},10),false,'a gap interview keeps its countdown');});
