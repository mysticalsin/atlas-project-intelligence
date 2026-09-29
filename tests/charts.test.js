'use strict';
// "Project at a glance" chart module: honesty, escaping, confidentiality and export safety. Run: node --test tests/charts.test.js
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const E=require('../src/engine.js'),C=require('../src/charts.js');
const HOSTILE='<img src=x onerror=alert(1)>',BREAK='"><script>alert(1)</script>',ROOT=path.join(__dirname,'..');
const escH=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Stub AtlasGeo that follows the shared interface (the real src/geo.js is exercised at the end when present).
function stubGeo(){const T={france:['FRA','France'],germany:['DEU','Germany'],deutschland:['DEU','Germany'],belgium:['BEL','Belgium'],belgique:['BEL','Belgium'],spain:['ESP','Spain'],uk:['GBR','United Kingdom'],'united kingdom':['GBR','United Kingdom'],singapore:['SGP','Singapore']};
 return {resolveLocations(text){const out={countries:[],unresolved:[],ambiguous:[],missing:!String(text||'').trim()};for(const raw of String(text||'').split(/[,;&/]+/)){const t=raw.trim(),k=t.toLowerCase();if(!t)continue;if(T[k]){if(!out.countries.some(c=>c.code===T[k][0]))out.countries.push({code:T[k][0],name:T[k][1],from:t});}else if(['congo','korea'].includes(k))out.ambiguous.push(t);else out.unresolved.push(t);}return out;},
  countryName:c=>(Object.values(T).find(x=>x[0]===c)||['',''])[1],fitBox:(codes,a=16/9)=>codes.length?[400,100,180,+(180/a).toFixed(1)]:[0,0,1000,+(1000/a).toFixed(1)],
  worldSVG(o){const codes=['FRA','DEU','BEL','ESP','GBR','USA'];return `<svg viewBox="${(o.viewBox||[0,0,1000,562]).join(' ')}" role="img" aria-label="World map"><defs><pattern id="${o.idPrefix}-hatch" width="6" height="6"></pattern></defs><path class="geo-graticule" d="M0 0"/>`
   +codes.map(c=>`<path class="geo-country" data-code="${c}"${o.states[c]?` data-state="${o.states[c]}"`:''} d="M0 0">${o.titles[c]?`<title>${escH(o.titles[c])}</title>`:''}</path>`).join('')+(o.states.SGP?`<circle class="geo-marker" data-code="SGP" data-state="${o.states.SGP}" r="2.5"/>`:'')+'</svg>';}};}
C.setGeo(stubGeo());

function full(){const p=E.project({title:'Triage pilot',consultant:'Maya',role:'Data engineer',sector:'Financial services',stage:'Pilot',client:{name:'Zebracorp',location:'Lyon, Belgium',contact:'ceo@zebracorp.example'},
  details:{country:'Deutschland',start:'2024-01',end:'2024-09',duration:'8 months',teamSize:5,teamRoles:['Lead engineer','Analyst'],technologies:['Python','SQL','Airflow'],deliverables:['Pipeline','Runbook'],serviceLines:['Data']}});
 p.answers=E.TOPICS.map(t=>'Specific content for '+t.label);p.deferred[4]=true;
 p.sources=[{id:'s1',name:'Acceptance note',version:'v1',text:'x',url:'',active:true,inspected:true,topics:[0,1,2,3,5]},{id:'s2',name:'Worksheet',version:'v2',text:'y',url:'',active:true,inspected:false,topics:[3]},{id:'s3',name:'Old deck',version:'v0',text:'z',url:'',active:false,inspected:false,topics:[0]}];
 p.metric={name:'Median triage duration',unit:'minutes',before:42,after:26,period:'June vs August',scope:'180 tickets each',caveat:'Different periods',sourceId:'s1'};
 p.jev={primary:{key:'data',label:'Data & AI',confidence:.8},also:[{key:'ops',label:'Operations',probability:.4}],impact:62,model:'jev',at:'',revision:p.recordRevision,
  scores:{business_impact:{label:'Business impact',score:3,confidence:.62},evidence:{label:'Evidence',score:2.5,confidence:.5},reusability:{label:'Reusability',score:2,confidence:.7},differentiation:{label:'Differentiation',score:1.5,confidence:.4},showcase:{label:'Showcase',score:3.5,confidence:.9}}};
 p.sheet=E.cleanSheet({exec:{summary:'One. Two. Three.',teamSize:'5 consultants',duration:'8 months',price:'EUR 999,999 SECRETPRICE',contacts:'Jane SECRETCONTACT'},sections:{industry:'Banking',issue:E.TBD,scope:'Scope text'},from:{scope:'interview'}});
 E.generate(p);return p;}
const gateOf=(p,draft=true)=>{const dm=p.metric?E.metricDisplay(p.metric):null,stale=!!p.story&&p.story.sourceRevision!==p.recordRevision;return {numberOk:!!dm&&!E.metricIssues(p.metric,p.sources).length&&!stale,stale,localReady:!!p.story&&E.ready(p)&&!draft};};
const model=(p,o={})=>C.modelFromProject(p,E,{draft:true,audience:p.story&&p.story.audience,gate:gateOf(p),...o});
const both=m=>[C.dashboard(m,{interactive:false}),C.dashboard(m,{interactive:true})];
const mapPart=h=>h.slice(h.indexOf('class="ag-mf"'),h.indexOf('</svg>',h.indexOf('role="img" aria-label="World map"'))+6);

test('model from a full project follows the engine shape and the paper gate',()=>{const p=full(),m=model(p),dm=E.metricDisplay(p.metric);
 assert.equal(m.map.states.DEU,'recorded');assert.match(m.map.titles.DEU,/Deutschland → Germany\nProject details/);
 assert.equal(m.period.months,8);assert.equal(m.team.size,5);assert.deepEqual(m.scope.tech,['Python','SQL','Airflow']);
 assert.deepEqual(m.readiness.map(r=>r.segs.filter(s=>s==='done').length),[5,5,0]);assert.equal(m.readiness[0].segs[4],'deferred');
 assert.deepEqual(m.evidence.cols.map(c=>c.ref+' '+c.label),['S1 Acceptance note · v1','S2 Worksheet · v2'],'withdrawn source excluded');
 assert.deepEqual(m.evidence.rows.map(r=>r.label),[0,2,1,3,5].map(i=>E.TOPICS[i].label));assert.deepEqual(m.evidence.rows[3].cells,['inspected','linked']);
 assert.equal(m.outcome.ok,true);assert.equal(m.outcome.headline,dm.headline);assert.equal(m.outcome.label,dm.label);
 assert.equal(m.jev.scores.length,5);assert.equal(m.sheet.filled,7,'5 exec fields + industry + scope; E.TBD is not filled');
 const [h]=both(m);for(const s of ['PROJECT AT A GLANCE','DRAFT / UNVERIFIED · CHARTS SHOW ONLY WHAT IS RECORDED','atlas-outcome-bars','about 8 months, from the dates entered','Boundaries: Natural Earth 1:110m (de facto) · illustrative','7 of 13 fields','Deutschland → Germany','answered ≠ verified'])assert.ok(h.includes(s),s);
 assert.equal((h.match(/<section class="atlas-dash/g)||[]).length,1);});

test('an empty project renders every card with a dashed To be completed slot and never a zero bar',()=>{const p=E.project({title:'Empty'});E.generate(p);const m=model(p);
 for(const h of both(m)){for(const s of ['Location: To be completed','Period: To be completed','Team size: To be completed','Roles: To be completed','Technologies: To be completed','Deliverables: To be completed','Service lines: To be completed','Sector: To be completed','No verified headline metric is being asserted','Not scored · To be completed','0 of 13 fields · To be completed'])assert.ok(h.includes(s),s);
  assert.equal((h.match(/No supporting source yet · To be completed/g)||[]).length,5+1,'5 rows plus the text table');
  assert.equal((mapPart(h).match(/data-state=/g)||[]).length,0,'no highlighted country');assert.ok(!h.includes('atlas-outcome-bars'));assert.ok(!/class="ag-bar/.test(h));
  assert.equal((h.match(/class="ag-sq ag-m is-empty"/g)||[]).length,13);assert.match(h,/<div class="ag-val is-tbd">—<\/div>/);
  const team=h.slice(h.indexOf('>Team<'),h.indexOf('>Scope<'));assert.ok(!/>0</.test(team),'team size is never shown as 0');assert.ok(!/ag-seg[^"]*is-done/.test(h));}
 p.sheet=null;const h=C.dashboard(model(p));assert.equal((h.match(/class="ag-sq ag-m is-empty"/g)||[]).length,13);assert.ok(h.includes('Reference sheet not generated · To be completed'));});

test('interview-sourced fields are hatched and labelled from interview · unverified',()=>{const p=full();p.details=E.cleanDetails({...p.details,from:{country:'interview',teamSize:'interview',start:'interview',end:'interview',technologies:'interview'}});
 const m=model(p),[st,live]=both(m);assert.equal(m.map.states.DEU,'interview');assert.match(m.map.titles.DEU,/From interview · unverified/);
 assert.ok(st.includes('<title>Germany\nDeutschland → Germany\nFrom interview · unverified</title>'));assert.ok(st.includes('data-state="interview"'));
 assert.match(st,/class="ag-tb is-hatch"/);assert.match(st,/<span class="ag-iv" title="Team size: 5 · from interview · unverified">5<\/span>/);
 assert.match(live,/data-tt="Team size: 5" data-td="from interview · unverified" tabindex="0" role="img" aria-label="Team size: 5 · from interview · unverified">5</);assert.ok(live.includes('<li><i class="ag-sw is-acch"></i>From interview · unverified</li>'));
 assert.ok(C.textSummary(m).includes('Germany (entered as “Deutschland”, from interview · unverified)'));});

test('the outcome chart obeys the paper gate: issues, stale drafts and a missing metric draw no bars',()=>{let p=full();p.metric.sourceId='';let h=C.dashboard(model(p));
 assert.ok(!h.includes('atlas-outcome-bars'));assert.ok(h.includes('No verified headline metric is being asserted'));assert.ok(h.includes('Complete the measurement: Link an active source that supports the outcome.'));
 p=full();p.recordRevision++;h=C.dashboard(model(p));assert.ok(!h.includes('atlas-outcome-bars'));assert.ok(h.includes('Draft needs updating'));assert.match(h,/is-stale/);
 p=full();h=C.dashboard(C.modelFromProject(p,E,{gate:{numberOk:false,stale:false,localReady:false}}));assert.ok(!h.includes('atlas-outcome-bars'),'the gate from paperHTML is authoritative');
 p=full();p.metric=null;h=C.dashboard(model(p),{interactive:true});assert.ok(!h.includes('atlas-outcome-bars'));assert.ok(h.includes('Add a measurement in Precise outcomes.'));assert.ok(h.includes('data-action="metric"'));});

test('a valid metric reuses the metricDisplay text verbatim and stays hatched until reviewed locally',()=>{const p=full(),dm=E.metricDisplay(p.metric);let h=C.dashboard(model(p));
 assert.ok(h.includes(escH(dm.headline))&&h.includes(escH(dm.label)));assert.ok(h.includes('Calculated from your entries · not verified'));assert.match(h,/class="ag-bar ag-m is-b is-hatch"/);assert.ok(h.includes('Before/after is not causality.'));
 h=C.dashboard(C.modelFromProject(p,E,{gate:{numberOk:true,stale:false,localReady:true}}));assert.ok(h.includes('Evidence reviewed locally'));assert.ok(!/ag-bar[^"]*is-hatch/.test(h));assert.ok(h.includes('REVIEWED LOCALLY · CHARTS SHOW ONLY WHAT IS RECORDED'));});

test('a negative value switches to a dumbbell on a number line that includes zero',()=>{const p=full();Object.assign(p.metric,{name:'Net balance',unit:'points',before:-12,after:30});
 const m=model(p),h=C.dashboard(m),dm=E.metricDisplay(p.metric);assert.ok(m.outcome.ok);assert.match(h,/atlas-outcome-bars ag-bars ag-rv ag-dg is-dumbbell/);assert.match(h,/class="ag-gl is-zero"/);
 assert.ok(!/class="ag-bar /.test(h));assert.ok(h.includes(escH(dm.headline)));const ticks=[...h.matchAll(/data-tick[^>]*>([^<]*)</g)].map(x=>x[1]);assert.ok(ticks.includes('0')&&ticks.some(t=>t.startsWith('-')),ticks.join());
 assert.deepEqual(C.niceAxis(0,42).ticks,[0,20,40,60]);assert.deepEqual(C.niceAxis(-12,30).ticks,[-20,0,20,40]);assert.deepEqual(C.niceAxis(0,0).ticks,[0,0.25,0.5,0.75,1]);});

function hostile(){const p=full();const H=HOSTILE,B=BREAK;
 p.details=E.cleanDetails({country:H+', '+B,start:'early '+H,end:B,duration:H,teamSize:3,teamRoles:[H,B],technologies:[H,B],deliverables:[H],serviceLines:[B],from:{country:'interview'}});p.sector=H;
 p.sources=[{id:'s1',name:H,version:B,text:'x',url:'',active:true,inspected:true,topics:[0,1,2,3,5]}];Object.assign(p.metric,{name:H,unit:B,period:H,scope:B,caveat:H,sourceId:'s1'});
 p.jev.primary.label=H;p.jev.also=[{label:B}];p.jev.scores.business_impact.label=H;p.story.title=H;p.recordRevision=p.story.sourceRevision;p.jev.revision=p.recordRevision;return p;}
test('every renderer escapes hostile strings in countries, sources, roles, labels and metric text',()=>{const p=hostile(),m=model(p);
 const outs={...Object.fromEntries(['dashboard','mapCard','tiles','periodTimeline','readinessRings','evidenceMatrix','outcomeBars','jevRadar','sheetSquares'].flatMap(f=>[[f,C[f](m,{interactive:false})],[f+'·live',C[f](m,{interactive:true})]])),
  quality:C.qualityGauge({score:50,readyScore:75,completeness:40,aiScore:null,status:HOSTILE}),portfolio:C.portfolioMap({totals:{visible:2},byCountry:[{name:HOSTILE,n:2},{name:BREAK,n:1}]},{interactive:true})};
 assert.ok(m.outcome.ok,'hostile metric text still passes the gate');
 for(const [k,h] of Object.entries(outs)){assert.ok(h.length,k);assert.ok(!h.includes(HOSTILE),k+' raw img');assert.ok(!/<script|<img/i.test(h),k+' tag injected');assert.ok(!h.includes(BREAK)&&!h.includes('"><script'),k+' attribute break-out');}
 const d=outs.dashboard;assert.ok(d.includes(escH(HOSTILE))&&d.includes('&quot;&gt;&lt;script&gt;'));assert.ok(outs['evidenceMatrix'].includes('title="S1 · '+escH(HOSTILE)+' · '+escH(BREAK)));});

const tagsOf=h=>h.match(/<[a-zA-Z][^>]*>/g)||[];
test('dashboard output carries no script, no inline event handlers and no external URLs',()=>{for(const p of [full(),hostile()])for(const h of both(model(p))){
  assert.ok(!/<script/i.test(h));for(const t of tagsOf(h)){const bare=t.replace(/"[^"]*"/g,'""');assert.ok(!/\son[a-z]+\s*=/i.test(bare),t);assert.ok(!/javascript:/i.test(t),t);}assert.ok(!/https?:\/\//.test(h));}
 for(const css of [C.EXPORT_CSS,fs.readFileSync(path.join(ROOT,'src/charts.css'),'utf8')])assert.ok(!/@import|url\((?!#)|expression\(|https?:/i.test(css.replace(/url\(#\$\{[^)]*\)/g,'')));
 const live=C.dashboard(model(full()),{interactive:true}),st=C.dashboard(model(full()),{interactive:false});
 assert.ok(live.includes('data-ag-zoom="in"')&&live.includes('data-tt=')&&!/ title="/.test(live.replace(/<svg[^]*?<\/svg>/g,'')),'live marks use the delegated tooltip, not native titles');
 assert.ok(!st.includes('<button')&&!st.includes('tabindex')&&!st.includes('data-tt=')&&!st.includes('data-key'),'static export has no controls or local ids');assert.ok(live.includes('data-key="'),'live panel keys its re-render state');});

test('a fictional sample is labelled in the panel header',()=>{const p=full();p.sample=true;assert.ok(C.dashboard(model(p)).includes('FICTIONAL EXAMPLE · CHARTS SHOW ONLY WHAT IS RECORDED'));
 assert.ok(C.dashboard(model(full(),{sample:true})).includes('FICTIONAL EXAMPLE'));assert.ok(!C.dashboard(model(full())).includes('FICTIONAL'));});

test('client name and client location never reach the charts, and sheet values never appear',()=>{const p=full();p.details.country='';p.sheet.file={country:'',entity:'',entityCountry:''};
 const m=model(p);assert.deepEqual(m.map.states,{});assert.ok(!JSON.stringify(m).includes('Zebracorp')&&!JSON.stringify(m).includes('Lyon'));
 for(const h of [...both(m),C.textSummary(m),C.textSummary(m,false)]){for(const s of ['Zebracorp','Lyon','Belgium','zebracorp.example','SECRETPRICE','SECRETCONTACT','999,999'])assert.ok(!h.includes(s),s);assert.ok(!h.includes('data-state="recorded"'));}
 assert.ok(C.sheetSquares(model(full())).includes('title="Project price · Filled"'));});

test('the external audience sees evidence numbers only and no JEV card',()=>{const p=full();p.story.audience='external';const m=model(p);assert.equal(m.jev,null);
 for(const h of [...both(m),C.textSummary(m)]){assert.ok(!h.includes('Acceptance note')&&!h.includes('Worksheet'));assert.ok(!h.includes('JEV')&&!h.includes('Business impact'));}
 const h=C.dashboard(m);assert.ok(h.includes('title="S1 · EVIDENCE 1"')&&h.includes('title="S2 · EVIDENCE 2"'));assert.ok(h.includes('<div class="ag-card ag-c12"><div class="ag-ch"><h4 class="ag-h4">Outcome before / after'));});

test('the timeline draws a bar only from two valid months and echoes stated text verbatim',()=>{const t=d=>{const p=full();p.details=E.cleanDetails(d);return C.periodTimeline(model(p));};
 let h=t({start:'2024-01',end:'2024-09',duration:'6 months (approx.)'});assert.ok(h.includes('about 8 months, from the dates entered')&&h.includes('>Jan 2024<')&&h.includes('>Sep 2024<'));assert.match(h,/class="ag-tb"/);assert.ok(h.includes('Duration (as stated): <span>6 months (approx.)</span>'));
 h=t({start:'early 2024',end:'2024-09'});assert.ok(h.includes('Start (as stated): early 2024'));assert.ok(!h.includes('ag-tb')&&!h.includes('months, from'));
 h=t({start:'2024-03'});assert.ok(h.includes('ag-tail')&&h.includes('End: To be completed'));assert.ok(!h.includes('months, from'));
 h=t({start:'2024-03',end:'Q3 2025'});assert.ok(h.includes('ag-tail')&&h.includes('End (as stated): Q3 2025'));
 h=t({start:'2024-09',end:'2024-01'});assert.ok(!h.includes('ag-tb')&&h.includes('check the dates'));
 h=t({});assert.ok(h.includes('Period: To be completed'));
 h=t({start:'2019-02',end:'2026-11'});assert.ok(h.includes('about 93 months'));assert.ok([...h.matchAll(/data-tick[^>]*>([^<]*)</g)].length<=8,'tick labels thin out over long spans');});

test('textSummary gives the same facts for the Markdown and plain-text exports',()=>{const p=full(),m=model(p),md=C.textSummary(m),txt=C.textSummary(m,false);
 assert.ok(md.startsWith('## At a glance\n')&&txt.startsWith('At a glance\n'));
 for(const s of ['- Status: DRAFT / UNVERIFIED · CHARTS SHOW ONLY WHAT IS RECORDED','- Location: Germany (entered as “Deutschland”)','- Period: 2024-01 to 2024-09 · about 8 months, from the dates entered','- Team size: 5','- Interview topics answered: 5 of 6 · 1 deferred','- Evidence · The outcome: 1 inspected · 1 not inspected','Calculated from your entries · not verified','- JEV impact: 62 of 100 · Data & AI · JEV model estimate · not verified','- Reference sheet: 7 of 13 fields · filled does not mean confirmed'])assert.ok(md.includes(s),s);
 const e=E.project({title:'Empty'});E.generate(e);const em=C.textSummary(model(e));assert.ok(em.includes('- Location: To be completed')&&em.includes('- Team size: To be completed')&&em.includes('No verified headline metric'));
 const u=full();u.details.country='Remote, Congo';const um=C.textSummary(model(u));assert.ok(um.includes('Not placed on the map: “Remote” — add a country')&&um.includes('“Congo” is ambiguous — choose Republic of the Congo or DR Congo'));
 const h=C.dashboard(m);for(const [k,v] of C.summaryRows(m))assert.ok(h.includes(`<tr><th scope="row">${escH(k)}</th><td>${escH(v)}</td></tr>`),'hidden text table row '+k);});

test('every number shown comes from the record, metricDisplay, a count or an axis tick',()=>{const p=full(),m=model(p);
 const allowed=new Set(['42','26','5','2024','01','09','8','38.1','62','3.0','2.5','2.0','1.5','3.5','0.62','0.5','0.7','0.4','0.9','100','110','10','180',...Array.from({length:14},(_,i)=>String(i))]);
 for(const h of both(m)){const text=h.replace(/<span[^>]*data-tick[^>]*>[^<]*<\/span>/g,' ').replace(/<[^>]+>/g,' ').replace(/&[a-z#0-9]+;/gi,' ');
  for(const n of (text.match(/\d+(?:[.,]\d+)*/g)||[]).map(x=>x.replace(/,/g,'')))assert.ok(allowed.has(n),'unexpected number '+n);
  assert.deepEqual([...new Set(text.match(/[\d.]+%/g))],['38.1%'],'no percentage other than the metricDisplay headline');}});

test('palette contrast meets WCAG and the sequential scale steps are distinct',()=>{const tok=n=>{const x=C.EXPORT_CSS.match(new RegExp('--'+n+':(#[0-9A-Fa-f]{6})'));assert.ok(x,n);return x[1];};
 const lin=h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)/255).map(c=>c<=.03928?c/12.92:((c+.055)/1.055)**2.4),L=h=>{const [r,g,b]=lin(h);return .2126*r+.7152*g+.0722*b;},ratio=(a,b)=>{const x=L(a),y=L(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
 for(const n of ['chart-label','chart-fg'])assert.ok(ratio(tok(n),tok('chart-surface'))>=4.5,n);for(const n of ['chart-accent','chart-1'])assert.ok(ratio(tok(n),tok('chart-muted'))>=3,n);
 const s=[1,2,3,4,5].map(i=>L(tok('chart-scale-0'+i)));for(let i=1;i<5;i++)assert.ok(s[i]>s[i-1]*1.15,'scale step '+i);assert.ok(s[0]>L(tok('chart-muted')),'lowest step differs from no data');});

test('the portfolio map bins real counts, discloses merges and lists unplaced strings',()=>{const an={totals:{visible:7},byCountry:[{name:'UK',n:2},{name:'United Kingdom',n:1},{name:'France',n:1},{name:'Paris',n:2},{name:'Congo',n:1}],byClient:[{name:'Zebracorp',n:3}]};
 const h=C.portfolioMap(an,{interactive:false});assert.ok(h.includes('data-code="GBR" data-state="count-2"')&&h.includes('data-code="FRA" data-state="count-1"'));
 assert.ok(h.includes('United Kingdom\n3 references visible to you\nincludes: UK (2), United Kingdom (1)'));assert.ok(h.includes('Not placed on the map: “Paris” (2)')&&h.includes('“Congo” (1) is ambiguous'));
 assert.ok(h.includes('References visible to you · not company-wide')&&!h.includes('Zebracorp'));
 const e=C.portfolioMap({totals:{visible:0},byCountry:[]});assert.ok(e.includes('No published references visible to you yet'));assert.ok(!/data-state=/.test(e));});

test('the quality gauge shows the server score against its threshold and never as verification',()=>{let h=C.qualityGauge({score:81,readyScore:75,completeness:90,aiScore:74,status:'ready'});
 for(const s of ['>81<','threshold 75','Completeness · weight 0.45','Review agent · weight 0.55','Ready for use','A server review score is not verification'])assert.ok(h.includes(s),s);assert.equal((h.match(/class="ag-notch is-on"/g)||[]).length,32);assert.match(h,/class="ag-gt"/);
 h=C.qualityGauge({score:40,readyScore:75,completeness:50,aiScore:null,status:'insufficient'});assert.ok(h.includes('Review agent unavailable (score = 0.8 × completeness)')&&h.includes('ag-meter is-tbd'));
 assert.ok(C.qualityGauge(null).includes('In review · To be completed'));});

test('a failing or unsafe geo module degrades to text, never to an unsafe SVG',()=>{try{
  C.setGeo({...stubGeo(),worldSVG:()=>'<svg onload="alert(1)"></svg>'});let h=C.dashboard(model(full()));assert.ok(!h.includes('onload')&&h.includes('The map could not be drawn'));assert.ok(h.includes('Project details: Deutschland → Germany'));
  C.setGeo({resolveLocations(){throw Error('x');},fitBox(){throw Error('x');},worldSVG(){throw Error('x');}});h=C.dashboard(model(full()));assert.ok(h.includes('The map could not be drawn')&&h.includes('Not placed on the map'));
 }finally{C.setGeo(stubGeo());}});

test('bind is safe without a DOM and registers its delegated listeners once',()=>{assert.equal(C.bind(null),null);const seen=[],root={addEventListener:t=>seen.push(t),querySelector:()=>null,querySelectorAll:()=>[]};
 global.document={};try{C.bind(root);const n=seen.length;C.bind(root);assert.ok(n>=8);assert.equal(seen.length,n);assert.ok(!seen.some(t=>/^on/.test(t)));}finally{delete global.document;}});

test('the export stylesheet styles every chart class the static dashboard emits',()=>{const hooks=new Set(['ag-m','ag-dg','ag-rv','ag-c12']),css=C.EXPORT_CSS;
 const p=full(),neg=full();Object.assign(neg.metric,{before:-5,after:5});const html=[C.dashboard(model(p)),C.dashboard(model(neg)),C.dashboard(model(E.project({title:'x'}))),C.qualityGauge({score:50,completeness:50,aiScore:50}),C.portfolioMap({byCountry:[{name:'France',n:1}]})].join('');
 const cls=new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap(x=>x[1].split(' ')).filter(c=>/^ag-/.test(c)&&!hooks.has(c)));const missing=[...cls].filter(c=>!css.includes('.'+c));assert.deepEqual(missing,[]);});

test('size regression guard (measured size, not the page budget)',()=>{const js=fs.statSync(path.join(ROOT,'src/charts.js')).size,css=fs.statSync(path.join(ROOT,'src/charts.css')).size;assert.ok(js<=54000,'charts.js '+js);assert.ok(css<=3400,'charts.css '+css);});

test('a sector filled from the interview report is hatched and labelled wherever it is shown',()=>{const p=full();p.sector='';E.fillDetails(p,{industry:'Banking'});const m=model(p),[st,live]=both(m);
 assert.equal(m.scope.iSector,true);assert.ok(st.includes('<span class="ag-chip ag-iv" title="Sector: Banking · from interview · unverified">Sector: Banking</span>'));assert.ok(live.includes('data-tt="Sector: Banking" data-td="from interview · unverified"'));
 assert.ok(C.textSummary(m).includes('- Sector: Banking · from interview · unverified\n'));assert.ok(C.textSummary(model(full())).includes('- Sector: Financial services\n'),'a typed sector stays recorded');});

test('sheet cells copied from the record keep their origin: interview and model values are hatched, typed details stay solid',()=>{
 const p=E.project({title:'Voice project',consultant:'Maya'});p.details=E.cleanDetails({duration:'6 months'});p.answers[0]='The claims team waited days for triage.';p.report=E.cleanReport({headline:'Faster triage',summary:'Model-drafted summary.',facts:{}});
 E.fillDetails(p,{team_size:4,industry:'Banking'});p.sheet=E.mergeSheet(E.cleanSheet(p.sheet),E.sheetFromProject(p),'project');
 const src=(m,k)=>m.sheet.cells.find(c=>c.label===E.SHEET_LABELS[k]).src;let m=model(p);
 assert.deepEqual(['teamSize','summary','issue','industry','duration'].map(k=>src(m,k)),['interview','ai','interview','interview','recorded']);
 const live=C.dashboard(m,{interactive:true}),sq=l=>(live.match(new RegExp(`<i class="ag-sq ag-m is-(\\w+)" data-tt="${l}" data-td="([^"]*)"`))||[]).slice(1);
 assert.deepEqual(sq('Team size'),['hatch','Filled · from interview · unverified']);assert.match(live,/<span class="ag-iv" data-tt="Team size: 4" data-td="from interview · unverified"/,'the Team tile marks the same size');
 assert.deepEqual(sq('Summary'),['hatch','Filled · model draft · unverified']);assert.deepEqual(sq('Project duration'),['on','Filled · from the project details']);
 p.details.duration='7 months';m=model(p);assert.equal(src(m,'duration'),'project','a copy that no longer matches the record is not recorded');
 assert.match(C.sheetSquares(m,{interactive:true}),/is-hatch" data-tt="Project duration" data-td="Filled · copied from the project record · unverified"/);});

test('every focusable mark is named with its tooltip text, and an SVG with focusable marks is a group, not an image',()=>{const live=C.dashboard(model(full()),{interactive:true});
 const un=v=>v.replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&amp;/g,'&'),marks=tagsOf(live).filter(t=>t.includes('tabindex="0"'));assert.ok(marks.length>=30,String(marks.length));
 for(const t of marks){const a=k=>{const x=t.match(new RegExp(' '+k+'="([^"]*)"'));return x?un(x[1]):'';};assert.equal(a('aria-label'),[a('data-tt'),...a('data-td').split('\n')].filter(Boolean).join(' · '),t);if(!/^<(path|circle)/.test(t))assert.match(t,/ role="img"/,t);}
 const svgs=live.match(/<svg[^>]*>[^]*?<\/svg>/g)||[];assert.ok(svgs.filter(x=>x.includes('tabindex=')).length>=2);for(const x of svgs)if(x.includes('tabindex='))assert.match(x,/^<svg[^>]* role="group"/,x.slice(0,90));
 const st=C.dashboard(model(full()),{interactive:false});assert.ok(!st.includes('role="group"')&&!/is-live/.test(st),'the static export keeps image SVGs and no live classes');});

test('the insights map separates "no references" from "no country recorded" and lists the unplaced parts of a placed string',()=>{
 let h=C.portfolioMap({totals:{visible:10,published:10},byCountry:[]});assert.ok(h.includes('No country recorded on the 10 references visible to you · To be completed'));assert.ok(!h.includes('No published references visible to you yet'));
 assert.ok(C.portfolioMap({totals:{visible:1},byCountry:[]}).includes('No country recorded on the 1 reference visible to you'));
 h=C.portfolioMap({totals:{visible:3},byCountry:[{name:'Congo, France',n:3},{name:'Paris, France',n:2}]});assert.ok(h.includes('data-code="FRA" data-state="count-3"'));
 assert.ok(h.includes('Not placed on the map: “Congo” in “Congo, France” (3) is ambiguous'));assert.ok(h.includes('Not placed on the map: “Paris” in “Paris, France” (2)'));});

test('the quality gauge names the 0.45 completeness weight only when the review agent scored',()=>{const h=C.qualityGauge({score:48,readyScore:75,completeness:60,aiScore:null,status:'needs_work'});
 assert.ok(!h.includes('weight 0.45'));assert.ok(h.includes('<span>Completeness</span>')&&h.includes('Review agent unavailable (score = 0.8 × completeness)'));
 assert.ok(C.qualityGauge({score:81,completeness:90,aiScore:74}).includes('Completeness · weight 0.45'));});

test('breakpoints follow the dashboard width, the export map keeps its 16:9 frame, and the reveal leaves nothing clipped',()=>{const css=C.EXPORT_CSS,app=fs.readFileSync(path.join(ROOT,'src/charts.css'),'utf8');
 assert.match(css,/^\.atlas-dash\{[^}]*container:ag\/inline-size/);assert.ok(css.includes('@container ag (max-width:600px){.ag-c6{grid-column:span 12}.ag-c4{grid-column:span 6}}'));assert.ok(css.includes('@container ag (max-width:480px){.ag-c4{grid-column:span 12}'));
 assert.ok(css.includes('@supports not (container-type:inline-size){@media(max-width:800px){.ag-c6{grid-column:span 12}'),'the viewport rules remain as the fallback');
 assert.ok(!/[{}]\.ag-mf\{aspect-ratio:4\/3\}/.test(css),'the static export map never letterboxes to 4:3');assert.ok(css.includes('.is-live .ag-mf{aspect-ratio:4/3}'));
 const rv=app.match(/\.ag-rv\{animation:([^}]*)\}/);assert.ok(rv&&/\bbackwards\b/.test(rv[1])&&!/\b(both|forwards)\b/.test(rv[1]),'the reveal clip-path does not outlive the animation');});

// A minimal DOM double with only the element API that prepare() and bind() use (this suite runs without a browser).
function fakeDom(){class N{constructor(tag,a={},kids=[]){Object.assign(this,{tag,attrs:{},kids:[],parent:null,style:{},hidden:false,rect:{left:0,top:0,width:10,height:10},h:{},captured:[],_t:'',cl:new Set()});
  for(const [k,v] of Object.entries(a))if(k==='class')v.split(' ').forEach(c=>this.cl.add(c));else this.attrs[k]=String(v);kids.forEach(k=>this.appendChild(k));this.classList={add:c=>this.cl.add(c),toggle:(c,f)=>f?this.cl.add(c):this.cl.delete(c),contains:c=>this.cl.has(c)};}
 set className(v){this.cl=new Set(v.split(' '));}get textContent(){return this._t+this.kids.map(k=>k.textContent).join('');}set textContent(v){this._t=String(v);this.kids=[];}
 get offsetWidth(){return 120;}get offsetHeight(){return 40;}get isConnected(){let n=this;while(n.parent)n=n.parent;return n.tag==='html';}
 getAttribute(k){return k in this.attrs?this.attrs[k]:null;}setAttribute(k,v){this.attrs[k]=String(v);}hasAttribute(k){return k in this.attrs;}getBoundingClientRect(){return this.rect;}
 matches(q){return q[0]==='.'?this.cl.has(q.slice(1)):q[0]==='['?q.slice(1,-1) in this.attrs:this.tag===q;}closest(q){for(let n=this;n;n=n.parent)if(n.matches(q))return n;return null;}
 appendChild(c){c.parent=this;this.kids.push(c);return c;}remove(){if(this.parent)this.parent.kids.splice(this.parent.kids.indexOf(this),1);this.parent=null;}
 querySelectorAll(q){const all=n=>n.kids.flatMap(k=>[k,...all(k)]);return q.startsWith(':scope>')?this.kids.filter(k=>k.matches(q.slice(7))):all(this).filter(k=>k.matches(q));}querySelector(q){return this.querySelectorAll(q)[0]||null;}
 addEventListener(t,fn){(this.h[t]=this.h[t]||[]).push(fn);}setPointerCapture(id){this.captured.push(id);}getScreenCTM(){return {a:1,d:1};}}
 const n=(t,a,k)=>new N(t,a,k),title=t=>{const x=n('title');x.textContent=t;return x;},country=(c,name,box)=>{const x=n('path',{class:'geo-country','data-code':c,'data-state':'recorded'},[title(name+'\n'+name+' → '+name+'\nProject details')]);x.getBBox=()=>box;return x;};
 const fra=country('FRA','France',{x:450,y:120,width:40,height:40}),jpn=country('JPN','Japan',{x:850,y:150,width:30,height:40}),svg=n('svg',{viewBox:'0 0 1000 562',role:'img','aria-label':'World map'},[n('path',{class:'geo-country','data-code':'USA'}),fra,jpn]);
 const f=n('div',{class:'ag-mf','data-codes':'FRA'},[svg]),sq=n('i',{class:'ag-sq ag-m','data-tt':'Summary','data-td':'Filled',tabindex:'0'}),dash=n('section',{class:'atlas-dash is-live','data-key':'p1'},[f,sq]),root=n('html').appendChild(n('div'));
 Object.assign(f,{clientWidth:320,clientHeight:180});dash.rect={left:0,top:0,width:400,height:300};root.appendChild(dash);
 const fire=(type,target,x={})=>(root.h[type]||[]).forEach(fn=>fn({type,target,clientX:0,clientY:0,pointerType:'mouse',pointerId:1,button:0,relatedTarget:null,preventDefault(){},...x}));
 const tipOf=d=>{const t=d.querySelector(':scope>.ag-tip');return t&&!t.hidden?t.kids.map(k=>k.textContent).join(' | '):null;};
 return {n,fra,jpn,svg,sq,dash,root,fire,tipOf,vb:()=>svg.getAttribute('viewBox').split(' ').map(Number)};}
const withDom=fn=>()=>{const D=fakeDom();global.document={createElement:t=>D.n(t)};try{C.bind(D.root);fn(D);}finally{delete global.document;}};

test('prepare names each map country with its tooltip text and makes the map a group, not an image',withDom(({svg,fra})=>{
 assert.equal(fra.getAttribute('tabindex'),'0');assert.equal(fra.getAttribute('aria-label'),'France · France → France · Project details');assert.equal(svg.getAttribute('role'),'group');}));

test('a mouse click pins a map country: pointer capture starts only once a drag does',withDom(({svg,fra,dash,fire,tipOf})=>{
 fire('pointerdown',fra);assert.deepEqual(svg.captured,[],'a plain press does not capture, so the click reaches the country');fire('pointerup',fra);fire('click',fra);assert.equal(tipOf(dash),'France | France → France | Project details');
 fire('pointerdown',fra);fire('pointermove',fra,{clientX:12});assert.deepEqual(svg.captured,[1],'a drag captures the pointer');fire('pointerup',fra,{clientX:12});}));

test('keyboard focus on a country outside the zoomed view pans to it, and its tooltip stays inside the dashboard',withDom(({jpn,dash,fire,vb})=>{
 const inside=([x,y],v)=>x>=v[0]&&x<=v[0]+v[2]&&y>=v[1]&&y<=v[1]+v[3],c=[865,170];assert.ok(!inside(c,vb()));
 jpn.rect={left:1250,top:100,width:10,height:10};fire('focusin',jpn);const v=vb();assert.ok(inside(c,v),v.join(' '));assert.equal(v[2],180,'the zoom level is kept');
 const t=dash.querySelector(':scope>.ag-tip'),l=parseFloat(t.style.left);assert.ok(l>=8&&l+t.offsetWidth<=dash.rect.width-8,t.style.left);
 fire('focusin',jpn);assert.deepEqual(vb(),v,'a country already in view does not move the map');}));

test('a pinned tooltip whose mark a re-render replaced no longer blocks hover and focus tooltips',withDom(({n,sq,dash,root,fire,tipOf})=>{
 fire('click',sq);assert.equal(tipOf(dash),'Summary | Filled');dash.remove();
 const b=n('i',{class:'ag-sq ag-m','data-tt':'Team size','data-td':'Filled'}),c=n('i',{class:'ag-sq ag-m','data-tt':'Scope','data-td':'To be completed',tabindex:'0'}),d2=n('section',{class:'atlas-dash is-live','data-key':'p1'},[b,c]);
 root.appendChild(d2);C.bind(root);fire('pointerover',b);assert.equal(tipOf(d2),'Team size | Filled');fire('focusin',c);assert.equal(tipOf(d2),'Scope | To be completed');}));

const realGeo=fs.existsSync(path.join(ROOT,'src/geo.js'))&&fs.existsSync(path.join(ROOT,'assets/geo/world-110m.json'));
test('with the real AtlasGeo module',{skip:!realGeo&&'src/geo.js or assets/geo/world-110m.json not built yet'},()=>{let G;try{G=require('../src/geo.js');}catch(e){G=null;}
 assert.ok(G&&typeof G.resolveLocations==='function','src/geo.js exports the shared interface');C.setGeo(G);try{
  const p=full();let m=model(p);assert.equal(m.map.states.DEU,'recorded');let [st,live]=both(m);
  for(const h of [st,live]){assert.ok(!/<script/i.test(h));for(const t of tagsOf(h))assert.ok(!/\son[a-z]+\s*=/i.test(t.replace(/"[^"]*"/g,'""')),t);assert.match(h,/data-code="DEU"[^>]*data-state="recorded"|data-state="recorded"[^>]*data-code="DEU"/);}
  assert.ok(st.includes('Deutschland → Germany'));
  p.details.country='Remote';[st]=both(model(p));assert.ok(st.includes('Not placed on the map: “Remote” — add a country'));
  p.details.country='';p.sheet.file={country:'',entity:'',entityCountry:''};m=model(p);assert.deepEqual(m.map.codes,[]);[st]=both(m);assert.ok(st.includes('Location: To be completed'));assert.ok(!/data-state="(recorded|interview|sheet)"/.test(st));
  p.details.country=HOSTILE+' France';[st,live]=both(model(p));assert.ok(!st.includes(HOSTILE)&&!live.includes(HOSTILE));
 }finally{C.setGeo(stubGeo());}});
