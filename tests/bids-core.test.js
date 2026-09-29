'use strict';
// AtlasBids (src/bids-core.js): verdict copy, footnote HTML escaping, Markdown [^n] export, .docx model, win cells (WOW_SPEC F1.7, F1.8, F7.3).
const test=require('node:test'),assert=require('node:assert/strict'),B=require('../src/bids-core.js');
const HOSTILE='<img src=x onerror=alert(1)>"\'&';
const OP={bidId:'b'.repeat(32),view:'author',title:'Claims triage proof',subtitle:'Two references for [Company 1]',
 summary:[{text:'Triage fell from 40 to 12 minutes.',kind:'fact',cites:[1],requirementIds:['R1']},{text:'This fits a regional insurer.',kind:'interpretation',cites:[2,1],requirementIds:['R2']}],
 sections:[{heading:'Delivery',claims:[{text:'Ran the pilot with two teams.',kind:'fact',cites:[2],requirementIds:['R1']}]}],
 footnotes:[{n:1,refId:'r1',revision:3,kind:'consultant_words',topic:'outcome',quote:'Triage fell from 40 to 12 minutes per claim.',confirmation:'manager_confirmed'},
  {n:2,refId:'r2',revision:1,kind:'evidence',sourceName:'Ops dashboard',sourceVersion:'v3',quote:HOSTILE,confirmation:'unverified'}],
 dropped:['Cut costs by 99% overnight'],references:[{id:'r1',title:'Claims routing',revision:3,status:'published',validation:'validated',client:'Zebracorp'},{id:'r2',title:'Queue <b>ops</b>',revision:1,status:'published',validation:'validated'}],
 warning:'',generatedAt:'2026-09-29T10:00:00Z',label:'Every claim cites the consultant\'s own words or recorded evidence. Interpretation is labelled.'};

test('verdict copy: exact F1.7 wording for all five verdicts; the none CTA; unknown verdicts refused',()=>{
 const run={coverage:[{requirementId:'R1',status:'covered'},{requirementId:'R2',status:'partial'},{requirementId:'R3',status:'covered'}]};
 assert.equal(B.verdictCopy('strong',run).text,'Strong proof found for 2 of 3 requirements.');
 assert.equal(B.verdictCopy('strong',{covered:1,total:4}).text,'Strong proof found for 1 of 4 requirements.');
 assert.equal(B.verdictCopy('partial').text,'Partial matches only. Check each caveat.');
 const none=B.verdictCopy('none');assert.equal(none.text,'No strong match in the library for this brief.');assert.equal(none.cta,'Ask consultants for proof');
 assert.equal(B.verdictCopy('unranked').text,'Not ranked: the AI ranking did not answer. Similarity only.');
 assert.equal(B.verdictCopy('empty_library').text,'No published references are available to you yet.');
 for(const v of ['strong','partial','unranked','empty_library'])assert.equal(B.verdictCopy(v).cta,null,v);
 assert.equal(B.verdictCopy('strong',{coverage:[{status:'unknown'},{status:'unknown'}]}).text,'Strong proof found. Coverage per requirement was not assessed.');
 assert.equal(B.verdictCopy('great'),null);assert.equal(B.verdictCopy('__proto__'),null);});

test('ask verdict copy mirrors F1 and states an empty answer plainly',()=>{
 assert.equal(B.askVerdictCopy('none',[]).text,'Nothing in the library answers this yet.');
 assert.equal(B.askVerdictCopy('unranked',[]).text,'Nothing in the library answers this yet.');
 assert.equal(B.askVerdictCopy('empty_library',[]).text,'No published references are available to you yet.');
 assert.equal(B.askVerdictCopy('unranked',[{}]).text,'Not ranked: the AI ranking did not answer. Similarity only.');
 assert.equal(B.askVerdictCopy('partial',[{}]).text,'Partial matches only. Check each caveat.');
 assert.equal(B.askVerdictCopy('strong',[{}]).cta,null);});

test('footnote HTML: superscripts, Sources list with quote, label, title, r{revision}, badge; hostile text escaped',()=>{
 const h=B.footnoteHTML(OP);
 assert.doesNotMatch(h,/<img/);assert.doesNotMatch(h,/<b>ops/);assert.match(h,/&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/);assert.match(h,/Queue &lt;b&gt;ops&lt;\/b&gt; · r1/);
 assert.match(h,/Triage fell from 40 to 12 minutes\.<sup class="fn" aria-label="Sources 1">1<\/sup>/);
 assert.match(h,/<li class="claim interpretation"><span class="claim-kind" aria-label="Interpretation">◇<\/span> This fits a regional insurer\.<sup class="fn" aria-label="Sources 2, 1">2,1<\/sup>/);
 assert.match(h,/<li value="1" data-fn="1"><q>Triage fell from 40 to 12 minutes per claim\.<\/q> <span class="fn-source">Consultant’s words · Outcome<\/span> · <span class="fn-ref">Claims routing · r3<\/span> <span class="badge conf-manager_confirmed">Confirmed by N\+1<\/span>/);
 assert.match(h,/<span class="fn-source">Evidence · Ops dashboard v3<\/span>/);assert.match(h,/conf-unverified">Unverified</);
 assert.ok(h.indexOf('data-fn="1"')<h.indexOf('data-fn="2"'),'sources in footnote order');
 assert.match(h,/Removed because .*Cut costs by 99% overnight/);assert.match(h,/Interpretation is labelled\./);});

test('footnote HTML: the per-reference client appears only where the server returned it',()=>{
 const h=B.footnoteHTML(OP);assert.equal((h.match(/fn-client/g)||[]).length,1);assert.match(h,/<span class="fn-client">Client: Zebracorp<\/span><\/li><li value="2"/);
 const none=B.footnoteHTML({...OP,references:OP.references.map(({client,...r})=>r)});assert.doesNotMatch(none,/Client:/);assert.doesNotMatch(none,/Zebracorp/);
 const hostile=B.footnoteHTML({...OP,references:[{...OP.references[0],client:HOSTILE}]});assert.doesNotMatch(hostile,/<img/);
 assert.equal(B.footnoteHTML(null),'');assert.equal(B.footnoteHTML('x'),'');});

test('Markdown export: [^n] markers and definitions; text cannot forge markers, links or HTML',()=>{
 const m=B.onePagerMarkdown({...OP,summary:[...OP.summary,{text:'See [^9] and [a](javascript:x) <script>',kind:'fact',cites:[1]}]});
 assert.match(m,/^# Claims triage proof\n/);assert.match(m,/\n- Triage fell from 40 to 12 minutes\.\[\^1\]\n/);assert.match(m,/- ◇ \*Interpretation:\* This fits a regional insurer\.\[\^2\]\[\^1\]/);
 assert.match(m,/\n\[\^1\]: “Triage fell from 40 to 12 minutes per claim\.” — Consultant’s words · Outcome\. Claims routing, r3\. Confirmed by N\+1\. Client: Zebracorp\./);
 assert.match(m,/\n\[\^2\]: .*Evidence · Ops dashboard v3\. Queue \\<b\\>ops\\</);
 assert.match(m,/See \\\[\^9\\\] and \\\[a\\\]\(javascript:x\) \\<script\\>/);assert.doesNotMatch(m,/(^|[^\\])<(script|img|b)\b/,'every < is backslash-escaped');assert.match(m,/\\<img src=x onerror=alert\(1\)\\>/);
 assert.equal((m.match(/^\[\^\d+\]: /gm)||[]).length,2);assert.equal(B.onePagerMarkdown(null),'');});

test('docx model: blocks per section with note numbers; notes carry the source line',()=>{
 const d=B.onePagerDocxModel(OP);assert.equal(d.title,'Claims triage proof');assert.deepEqual(d.blocks.map(b=>b.heading),['Summary','Delivery']);
 assert.deepEqual(d.blocks[0].paragraphs[1],{text:'This fits a regional insurer.',kind:'interpretation',notes:[2,1]});
 assert.deepEqual(d.notes.map(n=>n.n),[1,2]);assert.match(d.notes[0].text,/Claims routing, r3\. Confirmed by N\+1\. Client: Zebracorp\.$/);assert.equal(B.onePagerDocxModel(undefined),null);});

test('win cells: rates only from n >= 5, Wilson CI label, caveat otherwise',()=>{
 assert.equal(B.wilsonLabel([0.41,0.78]),'41-78%');assert.equal(B.wilsonLabel([0.2307,0.8824]),'23-88%');assert.equal(B.wilsonLabel(null),'');assert.equal(B.wilsonLabel([0.1,2]),'');
 assert.deepEqual(B.winCell({decided:5,winRate:0.6,ci95:[0.2307,0.8824]}),{n:5,low:false,rate:60,ci:'23-88%',text:'60% (95% CI 23-88%)'});
 const low=B.winCell({decided:3,winRate:null,ci95:null,caveat:'Fewer than 5 decided bids: not shown.'});assert.equal(low.low,true);assert.equal(low.rate,null);assert.equal(low.n,3);assert.equal(low.text,'Fewer than 5 decided bids: not shown.');
 assert.equal(B.winCell({decided:4,winRate:0.75}).low,true,'a rate under n=5 is never shown even if sent');assert.equal(B.winCell({}).n,0);
 assert.equal(B.proofTypeLabel('quantified+confirmed'),'Quantified · confirmed');});

test('outreach chips: Teams reads BLOCKED_EXTERNAL until connected; email is a draft; nothing claims sent unless the row says so',()=>{
 const rows=[{channel:'teams',status:'pending_approval'},{channel:'email_draft',status:'pending_approval'}];
 assert.match(B.outreachChips(rows,'BLOCKED_EXTERNAL'),/Teams: BLOCKED_EXTERNAL/);assert.match(B.outreachChips([],undefined),/Teams: BLOCKED_EXTERNAL.*Email: draft for you to send/);
 assert.match(B.outreachChips(rows,'connected'),/Teams: awaiting approval.*Email: awaiting approval/);
 assert.match(B.outreachChips([{channel:'teams',status:'blocked_external'}],'connected'),/Teams: BLOCKED_EXTERNAL/);
 assert.doesNotMatch(B.outreachChips([{channel:'email_draft',status:'<b>'}],'x'),/<b>/);});

test('export file name uses the alias, never the title',()=>{
 assert.equal(B.fileName('Project Falcon / EU',new Date(2026,8,29)),'ATLAS_proof_Project-Falcon-EU_2026-09-29');assert.equal(B.fileName('',new Date(2026,0,2)),'ATLAS_proof_bid_2026-01-02');});
