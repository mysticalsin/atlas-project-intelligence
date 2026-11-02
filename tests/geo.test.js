'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const G=require('../src/geo.js'),ROOT=path.join(__dirname,'..'),ASSET=path.join(ROOT,'assets/geo/world-110m.json'),SCRIPT=path.join(ROOT,'scripts/build_world_map.py');
const RAW=fs.readFileSync(ASSET,'utf8'),W=JSON.parse(RAW),F=Object.fromEntries(W.fields.map((k,i)=>[k,i]));
const PINS={'ne_110m_admin_0_countries.geojson':'6866c877d39cba9c357620878839b336d569f8c662d3cfab4cb1dbe2d39c977f','ne_50m_admin_0_countries.geojson':'3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb'};
const R=G.resolveLocations,codes=r=>r.countries.map(c=>c.code);
const tagAttrs=s=>(s.match(/<[^>]*>/g)||[]).join(' ');  // markup only: escaped text may legitimately read 'onerror='
function points(d){if(!d)return [];const out=[];let cmd='',x=0,y=0,n=[];for(const t of d.match(/[Mlz]|-?(?:\d+(?:\.\d*)?|\.\d+)/g)){if(t==='M'||t==='l'||t==='z'){cmd=t;continue;}n.push(Math.round(+t*10));if(n.length<2)continue;
 if(cmd==='M'){x=n[0];y=n[1];out.push({x:x/10,y:y/10,move:true});}else{out.push({x:(x+n[0])/10,y:(y+n[1])/10,dx:n[0]/10,dy:n[1]/10});x+=n[0];y+=n[1];}n=[];}return out;}

/* Resolver: the 38 research inputs plus regressions. [input, countries, unresolved, ambiguous] */
const CASES=[
 ['France',['FRA'],[],[]],['UK',['GBR'],[],[]],['Paris, France',['FRA'],['Paris'],[]],['Deutschland',['DEU'],[],[]],['USA',['USA'],[],[]],
 ['France & Spain',['FRA','ESP'],[],[]],['France / Belgique / Luxembourg',['FRA','BEL','LUX'],[],[]],['3 in Paris, 2 in Madrid',[],['Paris','Madrid'],[]],
 ['Bosnia and Herzegovina',['BIH'],[],[]],['Niger',['NER'],[],[]],['Nigeria',['NGA'],[],[]],['Guinea-Bissau',['GNB'],[],[]],['Papua New Guinea',['PNG'],[],[]],
 ['Newark, New Jersey, US',['USA'],['Newark','New Jersey'],[]],['Tbilisi, Georgia',['GEO'],['Tbilisi'],[]],['Congo',[],[],['Congo']],['Korea',[],[],['Korea']],
 ['Remote',[],['Remote'],[]],['EMEA',[],['EMEA'],[]],['Hong Kong',['HKG'],[],[]],["Côte d'Ivoire",['CIV'],[],[]],['Ivory Coast',['CIV'],[],[]],['Türkiye',['TUR'],[],[]],
 ['Czech Republic',['CZE'],[],[]],['Holland',['NLD'],[],[]],['Royaume-Uni',['GBR'],[],[]],['États-Unis',['USA'],[],[]],['Monaco',['MCO'],[],[]],['Singapore',['SGP'],[],[]],
 ['Indiana',[],['Indiana'],[]],['India',['IND'],[],[]],['DE',['DEU'],[],[]],['in',[],['in'],[]],['Suisse romande et Maroc',['CHE','MAR'],['romande'],[]],
 ['Sydney, New South Wales',[],['Sydney','New South Wales'],[]],['Trinidad and Tobago',['TTO'],[],[]],['Lyon (FR) + Casablanca',[],['Lyon','FR','Casablanca'],[]],
 // regressions for the three defects found in the research prototype
 ['Atlanta, Georgia',[],['Atlanta'],['Georgia']],['Georgia, USA',['USA'],[],['Georgia']],['Guinea',['GIN'],[],[]],['Worldwide',[],['Worldwide'],[]],
 // multiple countries, false friends, codes, languages
 ['France, Spain and Portugal',['FRA','ESP','PRT'],[],[]],['España y Portugal',['ESP','PRT'],[],[]],['Espagne, Italie et Grèce',['ESP','ITA','GRC'],[],[]],
 ['Georgia',['GEO'],[],[]],['Peru, Indiana',[],['Indiana'],['Peru']],['New Mexico',[],['New Mexico'],[]],['Mexico City',['MEX'],[],[]],['New England',[],['New England'],[]],
 ['Jersey City',[],['Jersey City'],[]],['Jersey',['JEY'],[],[]],['New Guinea',[],[],['New Guinea']],['South Georgia',['SGS'],[],[]],['Equatorial Guinea',['GNQ'],[],[]],
 ['DR Congo',['COD'],[],[]],['Republic of the Congo',['COG'],[],[]],['Congo, Democratic Republic of the',['COD'],[],[]],['Korea, Republic of',['KOR'],[],[]],['South Korea',['KOR'],[],[]],
 ['Saint Martin',[],[],['Saint Martin']],['Sint Maarten',['SXM'],[],[]],['US Virgin Islands',['VIR'],[],[]],['U.S.',['USA'],[],[]],['Irlande du Nord',['GBR'],[],[]],['Northern Ireland',['GBR'],[],[]],
 ['Großbritannien',['GBR'],[],[]],['Saint Kitts & Nevis',['KNA'],[],[]],['St Lucia',['LCA'],[],[]],['Granada, Spain',['ESP'],['Granada'],[]],['Salvador, Brazil',['BRA'],['Salvador'],[]],
 ['Norfolk, UK',['GBR'],['Norfolk'],[]],['Island',[],['Island'],[]],['South America',[],['South America'],[]],['Antarctica',[],['Antarctica'],[]],
 ['FRA',['FRA'],[],[]],['GB',['GBR'],[],[]],['fr',[],['fr'],[]],['EU',[],['EU'],[]],['FR, DE',[],['FR','DE'],[]],['London, GB',[],['London','GB'],[]],['Lyon (FR)',[],['Lyon','FR'],[]],
 ['PARIS, FRANCE',['FRA'],['PARIS'],[]],['Mumbai, IN',[],['Mumbai','IN'],[]],['TEAM IN FRANCE',['FRA'],['TEAM IN'],[]],
 ['Remote (France)',['FRA'],['Remote'],[]],['Team of 3 in Paris region',[],['Paris region'],[]],['us',[],['us'],[]],['Россия',[],['Россия'],[]],
 // review: a country name inside a city, region or feature name is not that country; the other named country still counts
 ['Benin City, Nigeria',['NGA'],['Benin City'],[]],['Panama City, Florida',[],['Panama City','Florida'],[]],['Niger Delta',[],['Niger Delta'],[]],['Lake Chad',[],['Lake Chad'],[]],
 ['South China Sea',[],['South China Sea'],[]],['North Cyprus',[],['North Cyprus'],[]],['Caribbean Netherlands',[],['Caribbean Netherlands'],[]],['Netherlands Antilles',[],['Netherlands Antilles'],[]],
 ['Gulf of Guinea',[],['Gulf of Guinea'],[]],['Congo Basin',[],['Congo Basin'],[]],['Kuwait City',['KWT'],[],[]],['Northern Cyprus',['CYN'],[],[]],
 // review: a US state, city or state code after any country makes it ambiguous; a later country or 'and' ends the item
 ['Lebanon (Tennessee)',[],['Tennessee'],['Lebanon']],['Lebanon, PA',[],['PA'],['Lebanon']],['Lebanon, Nashville, Tennessee',[],['Nashville','Tennessee'],['Lebanon']],
 ['Lebanon',['LBN'],[],[]],['India, IN',['IND'],['IN'],[]],['France, Spain and New York',['FRA','ESP'],['New York'],[]],['USA and Mexico',['USA','MEX'],[],[]],
 // review: 'Georgia' next to any other unplaced text is ambiguous unless the text itself points to the Caucasus
 ['Athens, Georgia',[],['Athens'],['Georgia']],['Columbus, Georgia',[],['Columbus'],['Georgia']],['Albany, Georgia',[],['Albany'],['Georgia']],['Georgia Tech',[],['Tech'],['Georgia']],
 ['Georgia, GA',[],['GA'],['Georgia']],['North Georgia',[],['North Georgia'],[]],['Athènes, Géorgie',[],['Athènes'],['Géorgie']],['Batumi, Georgia',['GEO'],['Batumi'],[]],
 ['Georgia (Caucasus)',['GEO'],['Caucasus'],[]],['Kutaisi, Georgien',['GEO'],['Kutaisi'],[]],['Tbilissi, Géorgie',['GEO'],['Tbilissi'],[]],['Georgia and Armenia',['GEO','ARM'],[],[]],
];
for(const [input,c,u,a] of CASES)test(`resolves ${JSON.stringify(input)}`,()=>{const r=R(input);assert.equal(r.missing,false);assert.deepEqual(codes(r),c);assert.deepEqual(r.unresolved,u);assert.deepEqual(r.ambiguous,a);});
test('research case list is at least the 38 prototype inputs',()=>assert.ok(CASES.length>=38));
test('empty, blank, punctuation-only and the engine placeholder are missing, never a default country',()=>{for(const v of ['','   ',null,undefined,42,'—','?','To be completed'])assert.deepEqual(R(v),{countries:[],unresolved:[],ambiguous:[],missing:true});});
test('countries carry display name and the captured text for tooltips',()=>{assert.deepEqual(R('Deutschland').countries,[{code:'DEU',name:'Germany',from:'Deutschland'}]);assert.equal(R('Royaume-Uni').countries[0].from,'Royaume-Uni');});
test('non-empty input is never silently dropped',()=>{for(const v of ['in','3','the','Remote','EMEA','and','de la','Paris'])assert.ok(R(v).unresolved.length+R(v).ambiguous.length+R(v).countries.length>0,v);});
test('a country is reported once even when named twice',()=>assert.deepEqual(codes(R('France (Paris), France (Lyon)')),['FRA']));
test('unresolved text is quoted verbatim, never normalized or truncated',()=>assert.deepEqual(R('Frankfurt am Main, Hessen').unresolved,['Frankfurt am Main','Hessen']));
test('very long input is bounded',()=>{const r=R('France, '.repeat(5000));assert.deepEqual(codes(r),['FRA']);});
test('ambiguous choices name both candidates',()=>{assert.deepEqual(G.choices('Congo').map(c=>c.code),['COD','COG']);assert.deepEqual(G.choices('Korea').map(c=>c.code),['KOR','PRK']);assert.deepEqual(G.choices('Georgia').map(c=>c.code),['GEO','USA']);assert.deepEqual(G.choices('Paris'),[]);});
test('every gazetteer alias resolves to its own country (Python/JS normalization parity)',()=>{const bad=[];
 for(const [code,r] of Object.entries(W.countries))for(const a of r[F.aliases].split('|').filter(Boolean)){const got=codes(R(a));if(got.length!==1||got[0]!==code)bad.push(a+' -> '+got.join(','));}
 assert.deepEqual(bad,[]);});
test('every display name resolves to its own code unless the name itself is ambiguous',()=>{const bad=[];for(const code of Object.keys(W.countries)){const r=R(G.countryName(code));if(!(codes(r).length===1&&codes(r)[0]===code)&&!r.ambiguous.length)bad.push(code);}assert.deepEqual(bad,[]);});
test('countryName and labelPoint are safe on unknown input',()=>{assert.equal(G.countryName('FRA'),'France');for(const v of ['XXX','__proto__','constructor',null,7])assert.equal(G.countryName(v),'');assert.equal(G.labelPoint('__proto__'),null);assert.equal(G.labelPoint('FRA').length,2);});

/* Asset integrity */
test('world asset is within the 115,000 byte budget',()=>assert.ok(fs.statSync(ASSET).size<=115000,String(fs.statSync(ASSET).size)));
test('provenance pins Natural Earth v5.1.2 hashes and the generator pins the same values',()=>{const p=W.provenance,src=fs.readFileSync(SCRIPT,'utf8');assert.equal(p.tag,'v5.1.2');assert.equal(p.version,'5.1.2');
 for(const s of p.sources){assert.equal(s.sha256,PINS[s.file]);assert.equal(s.url,'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/'+s.file);assert.ok(src.includes(s.sha256));}
 assert.equal(p.sources.length,2);assert.equal(p.projection.name,'Mercator');assert.deepEqual(p.dropped,['ATA']);assert.match(p.boundaries,/de facto/i);});
test('ADM0_A3 codes are unique and well formed',()=>{const keys=[...RAW.slice(RAW.indexOf('"countries":{')).matchAll(/"([A-Z0-9]{3})":\["/g)].map(m=>m[1]);assert.equal(keys.length,Object.keys(W.countries).length);assert.equal(new Set(keys).size,keys.length);
 const marks=W.markers.map(m=>m[0]);assert.equal(new Set(marks).size,marks.length);for(const c of marks)assert.ok(W.countries[c],c);});
test('Antarctica is absent',()=>{assert.equal(W.countries.ATA,undefined);assert.ok(!W.markers.some(m=>m[0]==='ATA'));});
test('map is Mercator 1000 wide with 668 height and only safe path characters',()=>{assert.equal(W.width,1000);assert.equal(W.height,668);
 for(const [c,r] of Object.entries(W.countries))assert.match(r[F.path],/^[Mlz0-9. -]*$/,c);assert.match(W.graticule,/^[MVH0-9. ]+$/);});
test('streak guard: no path segment is longer than 250 units',()=>{let worst=0,who='';for(const [c,r] of Object.entries(W.countries))for(const p of points(r[F.path]))if(!p.move){const l=Math.hypot(p.dx,p.dy);if(l>worst){worst=l;who=c;}}assert.ok(worst<=250,`${who} ${worst}`);});
test('all points lie inside the map frame',()=>{for(const [c,r] of Object.entries(W.countries))for(const p of points(r[F.path]))assert.ok(p.x>=0&&p.x<=1000&&p.y>=0&&p.y<=668,c);});
test('Russia and Fiji reach both map edges (split at the antimeridian, not streaked)',()=>{for(const c of ['RUS','FJI']){const xs=points(W.countries[c][F.path]).map(p=>p.x);assert.ok(Math.min(...xs)<=1,c);assert.ok(Math.max(...xs)>=999,c);}});
test('small-territory markers exist',()=>{const m=new Set(W.markers.map(x=>x[0]));for(const c of ['SGP','HKG','MCO','LUX','MLT','BHR','MAC','LIE','AND'])assert.ok(m.has(c),c);});
test('France main box ignores French Guiana; Norway main box ignores Svalbard',()=>{const f=W.countries.FRA[F.box];assert.ok(f[3]-f[1]<60&&f[1]>250,String(f));const n=W.countries.NOR[F.box];assert.ok(n[1]>150,String(n));});
test('graticule is straight lines every 10 degrees',()=>{assert.equal((W.graticule.match(/V/g)||[]).length,37);assert.equal((W.graticule.match(/H/g)||[]).length,14);});

/* fitBox */
const near=(a,b,e=0.2)=>Math.abs(a-b)<=e;
test('fitBox with no codes frames the whole world at the requested aspect',()=>{const b=G.fitBox([]);assert.ok(near(b[2]/b[3],16/9,.01));assert.ok(b[0]<=0&&b[0]+b[2]>=1000&&b[1]<=0&&b[1]+b[3]>=668);assert.deepEqual(G.fitBox(['ATA']),b);assert.deepEqual(G.fitBox(null),b);});
test('fitBox frames France with context, at least 18% of world width, 16:9 and 4:3',()=>{const f=W.countries.FRA[F.box];for(const a of [16/9,4/3]){const b=G.fitBox(['FRA'],a);
 assert.ok(near(b[2]/b[3],a,.01),String(b));assert.ok(b[2]>=180-.1);assert.ok(b[0]<f[0]&&b[1]<f[1]&&b[0]+b[2]>f[2]&&b[1]+b[3]>f[3],String(b));}});
test('fitBox frames a union and stays inside the world frame',()=>{const b=G.fitBox(['FRA','JPN']),w=G.fitBox([]);for(const c of ['FRA','JPN']){const x=W.countries[c][F.box];assert.ok(b[0]<=x[0]&&b[2]+b[0]>=x[2]);}
 assert.ok(b[0]>=w[0]-.1&&b[0]+b[2]<=w[0]+w[2]+.1&&b[1]>=w[1]-.1&&b[1]+b[3]<=w[1]+w[3]+.1);const s=G.fitBox(['SGP']);assert.ok(s[2]>=180-.1);});
test('fitBox falls back to 16:9 on a bad aspect',()=>assert.deepEqual(G.fitBox(['FRA'],-1),G.fitBox(['FRA'])));

/* worldSVG */
const XSS='<img src=x onerror=alert(1)>',XSS2='"><script>alert(1)</script>';
test('worldSVG is a complete, script-free SVG with prefixed hatch defs and one path per drawn country',()=>{const s=G.worldSVG({states:{FRA:'recorded'},interactive:true,idPrefix:'m1'});
 assert.match(s,/^<svg [^>]*role="img"[^>]*aria-label="[^"]+"/);assert.ok(s.endsWith('</svg>'));assert.ok(!/<script/i.test(s));assert.ok(!/\son[a-z]+=/i.test(tagAttrs(s)));
 assert.match(s,/<pattern id="m1-hatch"/);assert.match(s,/class="geo-graticule"/);assert.equal((s.match(/<path class="geo-country"/g)||[]).length,176);
 assert.match(s,/<path class="geo-country" data-code="FRA" data-state="recorded" tabindex="0" d="/);assert.equal((s.match(/tabindex/g)||[]).length,1);});
test('titles and every inserted value are escaped',()=>{const s=G.worldSVG({states:{FRA:'interview'},titles:{FRA:XSS,DEU:XSS2},idPrefix:XSS2,label:XSS2});
 assert.ok(!s.includes('<img')&&!/<script/i.test(s)&&!/\son[a-z]+=/i.test(tagAttrs(s)));assert.ok(s.includes('<title>&lt;img src=x onerror=alert(1)&gt;</title>'));assert.ok(s.includes('&quot;&gt;&lt;script&gt;'));
 assert.match(s,/<pattern id="scriptalert1script-hatch"/);});
test('interview state is hatched via the prefixed pattern; sheet is a plain state',()=>{const s=G.worldSVG({states:{DEU:'interview',ESP:'sheet'},idPrefix:'p2'});
 assert.match(s,/data-code="DEU" data-state="interview" style="fill:url\(#p2-hatch\)"/);assert.match(s,/data-code="ESP" data-state="sheet" d="/);assert.match(s,/aria-label="World map\. Highlighted: Germany \(from interview, unverified\), Spain \(reference sheet\)\."/);});
test('unknown states, codes and injected values are ignored',()=>{const s=G.worldSVG({states:{FRA:'recorded" onload="x',XXX:'recorded',__proto__:'recorded',ESP:'count-9'}});assert.ok(!s.includes('data-state'));assert.match(s,/No country highlighted/);});
test('small territories get a circle marker only when they have a state',()=>{const s=G.worldSVG({states:{SGP:'recorded',HKG:'interview',LUX:'sheet'},titles:{SGP:'Singapore'}});
 assert.equal((s.match(/<circle class="geo-marker"/g)||[]).length,3);assert.match(s,/<circle class="geo-marker" data-code="SGP" data-state="recorded" cx="[\d.]+" cy="[\d.]+" r="[\d.]+" stroke-width="[\d.]+"><title>Singapore<\/title><\/circle>/);
 assert.match(s,/data-code="LUX" data-state="sheet" d="/);assert.ok(!G.worldSVG({}).includes('<circle'));});
test('highlighted countries are drawn after the others so outlines stay visible',()=>{const s=G.worldSVG({states:{AFG:'recorded'}});assert.ok(s.indexOf('data-code="AFG"')>s.indexOf('data-code="ZWE"'));});
test('static export crops to the fitted view and has no tabindex',()=>{const s=G.worldSVG({states:{FRA:'recorded'},titles:{FRA:'France'},interactive:false});const n=(s.match(/<path class="geo-country"/g)||[]).length;
 assert.ok(n<80&&n>10,String(n));for(const c of ['FRA','DEU','ESP'])assert.ok(s.includes(`data-code="${c}"`),c);assert.ok(!s.includes('data-code="AUS"'));assert.ok(!s.includes('tabindex'));assert.ok(s.includes('<title>France</title>'));
 assert.ok(s.length<40000,String(s.length));});
test('static export also draws what a 4:3 phone frame letterboxes above and below a 16:9 view',()=>{for(const c of ['FRA','NGA','JPN']){const vb=G.fitBox([c],16/9),s=G.worldSVG({states:{[c]:'recorded'},interactive:false,viewBox:vb});
  const h=vb[2]*3/4,y0=vb[1]+vb[3]/2-h/2,miss=[];for(const [k,r] of Object.entries(W.countries)){const p=points(r[F.path]);if(!p.length)continue;const xs=p.map(q=>q.x),ys=p.map(q=>q.y);
   if(Math.max(...xs)>=vb[0]&&Math.min(...xs)<=vb[0]+vb[2]&&Math.max(...ys)>=y0&&Math.min(...ys)<=y0+h&&!s.includes(`data-code="${k}"`))miss.push(k);}
  assert.deepEqual(miss,[],c);}});
test('an explicit viewBox is honoured and non-numeric viewBoxes fall back to the fit',()=>{assert.match(G.worldSVG({viewBox:[10,20,300,150]}),/viewBox="10 20 300 150"/);assert.match(G.worldSVG({viewBox:['x',1,2,3]}),new RegExp(`viewBox="${G.fitBox([]).join(' ')}"`));});
test('output is deterministic',()=>{const o={states:{FRA:'recorded',DEU:'interview'},titles:{FRA:'a'},interactive:false};assert.equal(G.worldSVG(o),G.worldSVG(o));});

test('browser mode: reads window.ATLAS_WORLD without require and runs with string code generation disabled (CSP, no eval)',()=>{const vm=require('node:vm');
 const ctx=vm.createContext({ATLAS_WORLD:JSON.parse(RAW)},{codeGeneration:{strings:false,wasm:false}});const SAFE=fs.readFileSync(path.join(ROOT,'src/safe-html.js'),'utf8');vm.runInContext(SAFE,ctx);vm.runInContext(fs.readFileSync(path.join(ROOT,'src/geo.js'),'utf8'),ctx);  // the page loads src/safe-html.js first
 const out=vm.runInContext("JSON.stringify([AtlasGeo.resolveLocations('Deutschland').countries[0].code,AtlasGeo.worldSVG({states:{DEU:'recorded'}}).length>1000,typeof require])",ctx);assert.equal(out,'["DEU",true,"undefined"]');
 const bare=vm.createContext({});vm.runInContext(SAFE,bare);vm.runInContext(fs.readFileSync(path.join(ROOT,'src/geo.js'),'utf8'),bare);assert.equal(vm.runInContext("AtlasGeo.worldSVG({})+'|'+JSON.stringify(AtlasGeo.resolveLocations('France'))",bare),'|{"countries":[],"unresolved":["France"],"ambiguous":[],"missing":false}');});

/* Generator */
const python=()=>{const r=spawnSync('python3',['--version']);return r.status===0;};
test('generator refuses tampered input (hash mismatch) without writing output',{skip:!python()&&'python3 unavailable'},()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'atlas-ne-'));
 for(const f of Object.keys(PINS))fs.writeFileSync(path.join(dir,f),'{"type":"FeatureCollection","features":[]}');const out=path.join(dir,'out.json');
 const r=spawnSync('python3',[SCRIPT,'--src',dir,'--out',out],{encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/SHA-256 mismatch/);assert.ok(!fs.existsSync(out));fs.rmSync(dir,{recursive:true,force:true});});
test('regeneration from the pinned sources is byte-identical to the committed asset',{skip:!process.env.ATLAS_NE_SRC&&'set ATLAS_NE_SRC to a folder holding the two pinned Natural Earth v5.1.2 files'},()=>{
 const r=spawnSync('python3',[SCRIPT,'--src',process.env.ATLAS_NE_SRC,'--check'],{encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/identical/);});

/* F1 audit: worldSVG is wrapped in trusted() by the page; every caller-supplied value and every value read from the data asset must be inert. */
const inertSVG=(s,k)=>{assert.ok(s.startsWith('<svg')&&s.endsWith('</svg>'),k);assert.ok(!/<img|<script/i.test(s),k+' tag injected');for(const t of s.match(/<[a-zA-Z][^>]*>/g)||[])assert.ok(!/\son[a-z]+\s*=/i.test(t.replace(/"[^"]*"/g,'""')),k+' handler: '+t.slice(0,90));assert.ok(!s.includes(XSS2),k+' break-out');};
test('F1 audit: hostile states, titles, label, idPrefix, viewBox and aspect cannot inject markup',()=>{
 const H=XSS+XSS2,st={FRA:'recorded',DEU:'interview',ESP:'sheet',[XSS2]:'recorded',ITA:XSS2,GBR:'constructor',BEL:'count-3" onload="x',POL:'__proto__'};
 const tt={FRA:H,DEU:XSS2,ESP:'ok',constructor:H,__proto__:H,[XSS2]:H};
 for(const interactive of [false,true]){const s=G.worldSVG({states:st,titles:tt,label:H,idPrefix:H,interactive,viewBox:['"><x>',1,2,3],aspect:'"><x>'});inertSVG(s,'worldSVG '+interactive);
  assert.equal((s.match(/data-state=/g)||[]).length,(s.match(/data-state="(recorded|interview|sheet|count-[1-5])"/g)||[]).length,'only whitelisted states are printed');
  assert.ok(!/data-state="(constructor|__proto__)/.test(s)&&!/data-code="[^"]*[<>]/.test(s));assert.match(s,/<pattern id="[\w-]+-hatch"/);}
 inertSVG(G.worldSVG({label:H}),'label only');inertSVG(G.worldSVG(),'no options');inertSVG(G.worldSVG({states:{FRA:'recorded'},titles:{FRA:12345}}),'non-string title');});
test('F1 audit: values read from the data asset (paths, graticule, markers, size, country names) are escaped too',()=>{const vm=require('node:vm');
 const w=JSON.parse(RAW),codes=Object.keys(w.countries),c0=codes.find(c=>w.countries[c][F.path]);
 w.countries[c0][F.path]+=XSS2;w.countries[c0][F.name]=XSS;w.graticule+=XSS2;w.width=XSS2;w.height=XSS2;if(w.markers.length)w.markers[0]=[w.markers[0][0],XSS2,XSS];
 const ctx=vm.createContext({ATLAS_WORLD:w});vm.runInContext(fs.readFileSync(path.join(ROOT,'src/safe-html.js'),'utf8'),ctx);vm.runInContext(fs.readFileSync(path.join(ROOT,'src/geo.js'),'utf8'),ctx);
 ctx.o={states:{[c0]:'recorded'},interactive:true};ctx.mk=w.markers.length?w.markers[0][0]:null;if(ctx.mk)ctx.o.states[ctx.mk]='sheet';
 const s=vm.runInContext('AtlasGeo.worldSVG(o)',ctx);assert.ok(s.length>0);assert.ok(!/<img|<script/i.test(s)&&!s.includes(XSS2),'asset values are inert');assert.ok(s.includes('&quot;&gt;&lt;script&gt;'));});
test('F1 audit: the escape is the shared src/safe-html.js one and geo needs it loaded (page order), failing loudly otherwise',()=>{const vm=require('node:vm');
 assert.throws(()=>vm.runInContext(fs.readFileSync(path.join(ROOT,'src/geo.js'),'utf8'),vm.createContext({})),{name:'TypeError'});
 const ctx=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(ROOT,'src/safe-html.js'),'utf8'),ctx);vm.runInContext(fs.readFileSync(path.join(ROOT,'src/geo.js'),'utf8'),ctx);assert.equal(typeof vm.runInContext('AtlasGeo.worldSVG',ctx),'function');});
