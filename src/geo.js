/* ATLAS world map and country resolver. Data: Natural Earth v5.1.2 (public domain, de facto boundaries), pre-projected
   by scripts/build_world_map.py into window.ATLAS_WORLD. No network, no eval. It reads only the strings it is given,
   never guesses a country from a city, and reports everything it could not place instead of dropping it. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.AtlasGeo=api;})(typeof globalThis!=='undefined'?globalThis:this,root=>{
'use strict';
const own=(o,k)=>!!o&&Object.prototype.hasOwnProperty.call(o,k);
const esc=(root.AtlasSafe||(typeof require==='function'?require('./safe-html.js'):null)).esc;  // the shared escape (src/safe-html.js, loaded first in the page)
let DATA=null,F=null,IDX=null;const BOXES=new Map();
function world(){if(DATA)return DATA;let w=root.ATLAS_WORLD;if(!w&&typeof require==='function'){try{w=require('../assets/geo/world-110m.json');}catch(e){w=null;}}
 if(w&&w.countries&&Array.isArray(w.fields)){const f=k=>w.fields.indexOf(k);F={name:f('name'),iso2:f('iso2'),iso3:f('iso3'),aliases:f('aliases'),box:f('box'),label:f('label'),path:f('path')};DATA=w;}return DATA;}
const row=code=>{const w=world();return w&&typeof code==='string'&&own(w.countries,code)?w.countries[code]:null;};
function countryName(code){const r=row(code);return r?r[F.name]:'';}
function labelPoint(code){const r=row(code);return r?r[F.label].slice():null;}
function size(){const w=world();return w?[w.width,w.height]:[0,0];}

/* ---------- Resolver: free text -> ADM0_A3 codes ---------- */
const TOKEN=/[\p{L}\p{M}\p{N}]+|&/gu,MARKS=/\p{M}/gu,SPECIAL={'ß':'ss','æ':'ae','ø':'o','œ':'oe','ł':'l','đ':'d','ð':'d','þ':'th','ı':'i','ŀ':'l'};
const SEP=/[,;\/|+()[\]{}•·–—:\n\r\t]|\s-|-\s/,MAX_INPUT=500,TBD='to be completed';
const words=s=>new Set(s.split(' '));
const SPLIT=words('and et und y e en og och or ou oder o');
const FILLER=words('in at on of the a an from to with for by based mainly mostly primarily team teams people persons person consultant consultants staff member members fte ftes x country countries location locations '+
 'au aux le la les l de du des d dans sur pour avec personnes equipe equipes pays ville base basee bases basees '+
 'im der die das den dem mit fur bei aus land el los las del con para equipo pais personas '+
 'il lo gli di della delle dei per squadra paese persone het van te op bij met voor em no na nos nas os as do da dos das com pessoas');
// A country name inside a longer place name is not that country: 'Benin City', 'Niger Delta', 'Lake Chad', 'Gulf of Guinea', 'North Cyprus'
const BEFORE=words('north northern south southern east eastern west western central greater caribbean lake sea gulf bay river delta lac lago mer golfe golfo baie'),AFTER=words('city delta sea lake river basin gulf bay antilles'),LINK=words('of the de du del della di des do da la le les l d');
const CITIES={'mexico city':'MEX','kuwait city':'KWT','guatemala city':'GTM','belize city':'BLZ','luxembourg city':'LUX','djibouti city':'DJI'};  // only cities named after their own country
const US_CODES=words('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY');
const CAUCASUS=words('tbilisi tbilissi tiflis batumi batoumi kutaisi koutaissi rustavi caucasus caucase kaukasus caucaso sakartvelo georgien');  // not 'georgie': French for the US state too
const normToken=t=>t.toLowerCase().normalize('NFKD').replace(MARKS,'').replace(/[ßæøœłđðþıŀ]/g,c=>SPECIAL[c]).replace(/[^a-z0-9]/g,'');
function tokens(s){const out=[];for(const m of s.matchAll(TOKEN))out.push({raw:m[0],s:m.index,e:m.index+m[0].length,n:m[0]==='&'?'and':normToken(m[0])});return out;}
const shouting=tok=>tok.raw.length>1&&tok.raw===tok.raw.toUpperCase();  // 'IN', 'DE' may be codes: keep them visible, never drop them
const isFiller=tok=>/^\d+$/.test(tok.n)||(FILLER.has(tok.n)&&!shouting(tok));
const isSplit=tok=>SPLIT.has(tok.n)&&!shouting(tok);
function index(){if(IDX)return IDX;const w=world();if(!w)return null;const g=w.gazetteer||{},map=new Map(),codes=new Map();let max=1;
 const put=(k,v)=>{map.set(k,v);max=Math.max(max,k.split(' ').length);};
 for(const code of Object.keys(w.countries)){const r=w.countries[code];for(const a of r[F.aliases].split('|'))if(a)put(a,{t:'c',c:code});if(r[F.iso2])codes.set(r[F.iso2],code);if(r[F.iso3])codes.set(r[F.iso3],code);}
 for(const k of Object.keys(CITIES))if(own(w.countries,CITIES[k]))put(k,{t:'c',c:CITIES[k]});
 for(const k of Object.keys(g.ambiguous||{}))put(k,{t:'a',c:g.ambiguous[k].slice()});
 for(const k of g.falseFriends||[])put(k,{t:'f'});for(const k of g.usStates||[])put(k,{t:'s'});for(const k of g.usCities||[])put(k,{t:'u'});
 const abbr=new Map(Object.entries(g.abbreviations||{}));for(const k of abbr.keys())max=Math.max(max,k.split(' ').length);
 return IDX={map,codes,abbr,max};}
function resolveLocations(text){const out={countries:[],unresolved:[],ambiguous:[],missing:false};
 const t=(typeof text==='string'?text:'').slice(0,MAX_INPUT).trim();
 if(!/[\p{L}\p{N}]/u.test(t)||t.toLowerCase()===TBD){out.missing=true;return out;}
 const ix=index();if(!ix){out.unresolved.push(t);return out;}
 const add=(code,from)=>{if(!out.countries.some(c=>c.code===code))out.countries.push({code,name:countryName(code),from});};
 if(/^[A-Z]{2,3}$/.test(t)&&ix.codes.has(t)){add(ix.codes.get(t),t);return out;}  // ISO codes only as the whole field
 const tk=tokens(t),hits=[],used=new Array(tk.length).fill(false)
 for(let i=0;i<tk.length;){let hit=null;  // greedy longest match on word boundaries
  for(let L=Math.min(ix.max,tk.length-i);L>0&&!hit;L--){const part=tk.slice(i,i+L),ab=ix.abbr.get(part.map(x=>x.raw).join(' '));
   const e=ab?{t:'c',c:ab}:part.every(x=>x.n)?ix.map.get(part.map(x=>x.n).join(' ')):null;
   if(e)hit={...e,i,L,s:part[0].s,e:part[L-1].e};}
  if(hit){hits.push(hit);for(let k=i;k<i+hit.L;k++)used[k]=true;i+=hit.L;}else i++;}
 // nearest word beside hit h (d=-1 before, +1 after) in the same phrase, skipping 'of'/'de'-style links; '' at a separator or another hit
 const near=(h,d)=>{for(let k=d<0?h.i-1:h.i+h.L;k>=0&&k<tk.length;k+=d){if(used[k]||SEP.test(t.slice(tk[d<0?k:k-1].e,tk[d<0?k+1:k].s)))return '';if(!LINK.has(tk[k].n))return tk[k].n;}return '';};
 const inner=new Set(hits.filter(h=>(h.t==='c'||h.t==='a')&&(BEFORE.has(near(h,-1))||AFTER.has(near(h,1))))),kept=hits.filter(h=>!inner.has(h));
 for(const h of inner)for(let k=h.i;k<h.i+h.L;k++)used[k]=false;  // reported whole below, as unplaced text
 const us=kept.some(h=>h.t==='s'||h.t==='u'||(h.t==='c'&&h.c==='USA')),un=kept.filter(h=>h.t!=='c'&&h.t!=='a').map(h=>({s:h.s,x:t.slice(h.s,h.e)})),amb=[];
 let run=[];const flush=()=>{while(run.length&&isFiller(run[0]))run.shift();while(run.length&&isFiller(run[run.length-1]))run.pop();
  if(run.length)un.push({s:run[0].s,x:t.slice(run[0].s,run[run.length-1].e)});run=[];};
 tk.forEach((tok,k)=>{if(used[k]||isSplit(tok)||(run.length&&SEP.test(t.slice(tk[k-1].e,tok.s))))flush();if(!used[k]&&!isSplit(tok))run.push(tok);});flush();
 // a US state, US city or state code later in the same list item makes any country a possible US place: 'Peru, Indiana', 'Lebanon (Tennessee)', 'Lebanon, PA'
 const at=new Map(kept.map(h=>[h.i,h])),usAfter=h=>{const iso=row(h.c)[F.iso2];for(let k=h.i+h.L;k<tk.length;k++){const x=at.get(k);
   if(isSplit(tk[k])||/[;\/|+•·\n\r\t]/.test(t.slice(tk[k-1].e,tk[k].s)))return false;if(x)return x.t==='s'||x.t==='u';if(US_CODES.has(tk[k].raw)&&tk[k].raw!==iso)return true;}return false;};
 const cau=tk.some(x=>CAUCASUS.has(x.n));  // 'Georgia' beside any other unplaced text ('Athens, Georgia', 'Georgia Tech') needs Caucasus context
 for(const h of kept){const frag=t.slice(h.s,h.e);
  if(h.t==='c'){if(h.c!=='USA'&&(usAfter(h)||(h.c==='GEO'&&(us||(un.length&&!cau)))))amb.push(frag);else add(h.c,frag);}
  else if(h.t==='a')amb.push(frag);}
 out.ambiguous=[...new Set(amb)];out.unresolved=[...new Set(un.sort((a,b)=>a.s-b.s).map(u=>u.x))];
 if(!out.countries.length&&!out.ambiguous.length&&!out.unresolved.length)out.unresolved.push(t);  // never silently drop text
 return out;}
// Candidate countries for a fragment that resolveLocations reported as ambiguous ('Congo', 'Georgia', 'Peru' before a US state).
function choices(fragment){const ix=index();if(!ix)return [];const e=ix.map.get(tokens(String(fragment||'')).map(x=>x.n).filter(Boolean).join(' '));
 const cs=!e?[]:e.t==='a'?e.c:e.t==='c'?[...new Set([e.c,'USA'])]:[];return cs.map(code=>({code,name:countryName(code)}));}

/* ---------- Geometry ---------- */
function bbox(code){if(BOXES.has(code))return BOXES.get(code);const r=row(code);if(!r)return null;const d=r[F.path];let b=r[F.box].slice();
 if(d){let cmd='',x=0,y=0,n=[];b=[Infinity,Infinity,-Infinity,-Infinity];  // integer tenths: no float drift
  for(const tok of d.match(/[Mlz]|-?(?:\d+(?:\.\d*)?|\.\d+)/g)){if(tok==='M'||tok==='l'||tok==='z'){cmd=tok;continue;}n.push(Math.round(+tok*10));
   if(n.length<2)continue;if(cmd==='M'){x=n[0];y=n[1];}else{x+=n[0];y+=n[1];}n=[];b=[Math.min(b[0],x),Math.min(b[1],y),Math.max(b[2],x),Math.max(b[3],y)];}
  b=b.map(v=>v/10);}
 BOXES.set(code,b);return b;}
const r1=v=>Math.round(v*10)/10,okAspect=a=>typeof a==='number'&&isFinite(a)&&a>0?a:16/9;
function fitBox(codes,aspect){const A=okAspect(aspect),w=world(),W=w?w.width:1000,H=w?w.height:668,Wa=Math.max(W,H*A),Ha=Wa/A,all=[(W-Wa)/2,(H-Ha)/2,Wa,Ha].map(r1);
 const boxes=(Array.isArray(codes)?codes:[]).map(row).filter(Boolean).map(r=>r[F.box]);if(!boxes.length)return all;
 let x0=Math.min(...boxes.map(b=>b[0])),y0=Math.min(...boxes.map(b=>b[1])),x1=Math.max(...boxes.map(b=>b[2])),y1=Math.max(...boxes.map(b=>b[3]));
 const cx=(x0+x1)/2,cy=(y0+y1)/2;let bw=Math.max((x1-x0)*1.7,W*.18),bh=(y1-y0)*1.7;  // 35% context on each side, at least 18% of the world width
 if(bw/Math.max(bh,1e-9)<A)bw=bh*A;else bh=bw/A;if(bw>=Wa)return all;
 const x=Math.min(Math.max(cx-bw/2,all[0]),all[0]+Wa-bw),y=bh>=Ha?cy-bh/2:Math.min(Math.max(cy-bh/2,all[1]),all[1]+Ha-bh);return [x,y,bw,bh].map(r1);}

/* ---------- SVG ---------- */
const STATES=new Set(['recorded','interview','sheet','count-1','count-2','count-3','count-4','count-5']);
const STATE_WORDS={interview:'from interview, unverified',sheet:'reference sheet'};
const okBox=v=>Array.isArray(v)&&v.length===4&&v.every(n=>typeof n==='number'&&isFinite(n))&&v[2]>0&&v[3]>0;
const sig=v=>String(+v.toPrecision(3));  // style fallbacks scale with the viewBox
function worldSVG(opts){const o=opts&&typeof opts==='object'?opts:{},w=world();if(!w)return '';
 const p=String(o.idPrefix||'geo').replace(/[^A-Za-z0-9_-]/g,'')||'geo',interactive=o.interactive===true,titles=o.titles&&typeof o.titles==='object'?o.titles:{};
 const states=Object.create(null);if(o.states&&typeof o.states==='object')for(const c of Object.keys(o.states))if(row(c)&&STATES.has(o.states[c]))states[c]=o.states[c];
 const lit=Object.keys(states).sort(),vb=okBox(o.viewBox)?o.viewBox.map(r1):fitBox(lit,o.aspect),u=vb[2]/700;  // u: viewBox units per rendered px at ~700 px
 const hatch=`url(#${p}-hatch)`,hs=sig(6*u);
 const attrs=c=>{const s=states[c];return ` data-code="${esc(c)}"`+(s?` data-state="${esc(s)}"`+(s==='interview'?` style="fill:${hatch}"`:'')+(interactive?' tabindex="0"':''):'');};
 const title=c=>own(titles,c)&&typeof titles[c]==='string'&&titles[c]?`<title>${esc(titles[c])}</title>`:'';
 // static culling keeps the bands a 4:3 frame (the narrowest the stylesheet uses, on phones) letterboxes above and below a wider view
 const inView=c=>{if(interactive)return true;const b=bbox(c),m=vb[2]*.02,my=m+Math.max(0,vb[2]*.75-vb[3])/2;return b[2]>=vb[0]-m&&b[0]<=vb[0]+vb[2]+m&&b[3]>=vb[1]-my&&b[1]<=vb[1]+vb[3]+my;};
 const shape=c=>{const t=title(c);return `<path class="geo-country"${attrs(c)} d="${esc(w.countries[c][F.path])}"`+(t?`>${t}</path>`:'/>');};
 const drawn=Object.keys(w.countries).filter(c=>w.countries[c][F.path]&&inView(c)).sort();
 const label=typeof o.label==='string'&&o.label?o.label:lit.length?'World map. Highlighted: '+lit.map(c=>countryName(c)+(STATE_WORDS[states[c]]?` (${STATE_WORDS[states[c]]})`:'')).join(', ')+'.':'World map. No country highlighted.';
 const marks=w.markers.filter(m=>states[m[0]]).map(m=>{const t=title(m[0]);return `<circle class="geo-marker"${attrs(m[0])} cx="${esc(m[1])}" cy="${esc(m[2])}" r="${sig(4*u)}" stroke-width="${sig(2*u)}"`+(t?`>${t}</circle>`:'/>');}).join('');
 return `<svg xmlns="http://www.w3.org/2000/svg" class="geo-map" viewBox="${vb.join(' ')}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(label)}" data-fit="${vb.join(' ')}" data-world="0 0 ${esc(w.width)} ${esc(w.height)}">`+
  `<defs><pattern id="${p}-hatch" class="geo-hatch" patternUnits="userSpaceOnUse" width="${hs}" height="${hs}" patternTransform="rotate(45)"><rect class="geo-hatch-bg" width="${hs}" height="${hs}" fill="#2F3440"/>`+
  `<path class="geo-hatch-line" d="M${sig(3*u)} 0V${hs}" stroke="#F6EB4B" stroke-opacity=".55" stroke-width="${sig(1.2*u)}"/></pattern></defs>`+
  `<rect class="geo-bg" x="${-w.width}" y="${-w.height}" width="${3*w.width}" height="${3*w.height}" fill="none"/>`+
  `<path class="geo-graticule" d="${esc(w.graticule)}" fill="none" stroke="#FFFFFF" stroke-opacity=".08" stroke-width=".5" vector-effect="non-scaling-stroke"/>`+
  `<g class="geo-countries" fill="#2F3440" fill-rule="evenodd" stroke="#101011" stroke-width="${sig(.5*u)}" stroke-linejoin="round">`+
  drawn.filter(c=>!states[c]).map(shape).join('')+drawn.filter(c=>states[c]).map(shape).join('')+`</g>`+
  (marks?`<g class="geo-markers" fill="#F6EB4B" stroke="#101011">${marks}</g>`:'')+`</svg>`;}
return {resolveLocations,countryName,fitBox,worldSVG,labelPoint,choices,size};
});
