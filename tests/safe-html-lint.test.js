// F1: markup reaches the DOM only through src/safe-html.js, and no inline event handler exists anywhere (script-src-attr 'none').
// Fails on: raw innerHTML/outerHTML (assigned, computed or in an object), insertAdjacentHTML, document.write, srcdoc, eval/Function, DOMParser, createContextualFragment, setHTMLUnsafe,
// setAttribute on on*/URL attributes, a javascript: URL (outside safe-html.js); an inline on*= attribute in any markup the app serves; and any trusted(...) whose WHOLE argument is not one call to an audited producer.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const list=(dir,re)=>fs.readdirSync(path.join(ROOT,dir)).filter(n=>re.test(n)).map(n=>dir+'/'+n);
const SRC=[...list('src',/\.(js|html)$/),...list('deploy/cloudflare-edge/src',/\.js$/).filter(f=>!/policy\.generated|csp\.generated/.test(f))];
const read=f=>fs.readFileSync(path.join(ROOT,f),'utf8');
const hits=(re,files)=>files.flatMap(f=>{const t=read(f),out=[];for(const m of t.matchAll(re)){const line=t.slice(0,m.index).split('\n').length;out.push(`${f}:${line}: ${t.slice(m.index,m.index+70).replace(/\s+/g,' ')}`);}return out;});
const NOT_SAFE=f=>f!=='src/safe-html.js';

// ---- the sinks (red-team retest I1: the first version missed parsers, URL attributes, computed names and a wrapper with data in it) ----
const SINKS=[
  [/\.(?:innerHTML|outerHTML)\s*\+?=(?!=)/,'raw innerHTML/outerHTML assignment'],
  [/\[\s*['"`](?:inner|outer)/,"computed innerHTML/outerHTML (el['inner'+'HTML'])"],
  [/\b(?:inner|outer)HTML\s*:/,'innerHTML in an object literal (Object.assign(el,{innerHTML:...}))'],
  [/insertAdjacentHTML/,'insertAdjacentHTML'],
  [/document\.write(?:ln)?\s*\(/,'document.write'],
  [/srcdoc/i,'srcdoc'],
  [/\beval\s*\(/,'eval'],
  [/(?<![\w$.])(?:new\s+)?Function\s*\(/,'Function constructor'],
  [/set(?:Timeout|Interval)\(\s*['"`]/,'a string handed to setTimeout/setInterval'],
  [/DOMParser|parseFromString/,'DOMParser / parseFromString'],
  [/createContextualFragment/,'createContextualFragment'],
  [/setHTMLUnsafe|parseHTMLUnsafe/,'setHTMLUnsafe / parseHTMLUnsafe'],
  [/execCommand\s*\(\s*['"`]insertHTML/i,"execCommand('insertHTML')"],
  [/createElement\(\s*['"`]script/i,'a script element created from code'],
  [/setAttribute\(\s*['"`]\s*on/i,"setAttribute('on…') (an inline handler)"],
  [/setAttribute\(\s*['"`]\s*(?:href|src|action|formaction|xlink:href|data)\s*['"`]/i,'setAttribute on a URL attribute (set the property from a validated URL instead)'],
  [/\.(?:href|src|action|formAction|location)\s*=\s*['"`]\s*(?:javascript|data|vbscript):/i,'a javascript:/data: URL assigned to a URL property'],
  [/(?:location(?:\.href)?|\.href|\.src)\s*=\s*['"`]\s*javascript:/i,'javascript: URL'],
  [/href\s*=\s*["'`]?\s*javascript:/i,'javascript: URL in markup'],
];
const sinks=(text,file='')=>SINKS.flatMap(([re,why])=>{const g=new RegExp(re.source,re.flags.includes('g')?re.flags:re.flags+'g'),out=[];for(const m of text.matchAll(g)){out.push(`${file}:${text.slice(0,m.index).split('\n').length}: ${why}: ${text.slice(m.index,m.index+60).replace(/\s+/g,' ')}`);}return out;});

// trusted(...): the WHOLE argument must be one call to an audited producer (a prefix match let `trusted(AtlasCharts.esc('')+user)` through).
const PRODUCER=/^(?:(?:window\.)?(?:AtlasCharts|G|AtlasGeo)\.(?!esc\b|escape\b)[A-Za-z]\w*|B\.(?:footnoteHTML|outreachChips)|paperHTML)\(/;
function closeOf(t,open){ // index of the ) matching the ( at `open`, stepping over strings, template literals (with ${ }) and comments
  const stack=[')'];let i=open+1;
  while(i<t.length&&stack.length){const c=t[i],top=stack[stack.length-1];
    if(top==='`'){if(c==='\\')i++;else if(c==='`')stack.pop();else if(c==='$'&&t[i+1]==='{'){stack.push('}');i++;}}
    else if(c==='\''||c==='"'){const q=c;i++;while(i<t.length&&t[i]!==q){if(t[i]==='\\')i++;i++;}}
    else if(c==='`')stack.push('`');
    else if(c==='/'&&t[i+1]==='/'){while(i<t.length&&t[i]!=='\n')i++;}
    else if(c==='/'&&t[i+1]==='*'){i=t.indexOf('*/',i+2);if(i<0)return -1;i++;}
    else if(c==='('||c==='[')stack.push(c==='('?')':']');
    else if(c===')'||c===']'||c==='}'){if(c===top)stack.pop();else if(top==='}'&&c==='}')stack.pop();}
    i++;}
  return stack.length?-1:i-1;}
const trustedUses=(text,file='')=>{const out=[];for(const m of text.matchAll(/(?<![\w$.])trusted\s*\(/g)){
  const open=m.index+m[0].length-1,end=closeOf(text,open),arg=end<0?'':text.slice(open+1,end).trim();let ok=false;
  if(arg&&PRODUCER.test(arg)){const o=arg.indexOf('('),e=closeOf(arg,o);ok=e===arg.length-1;} // the producer call is the whole argument
  out.push({file,line:text.slice(0,m.index).split('\n').length,arg,ok});}return out;};

test('no raw innerHTML/outerHTML (also computed or in an object), insertAdjacentHTML, document.write, srcdoc, eval, Function, string timers, DOMParser, createContextualFragment, setHTMLUnsafe, script elements, setAttribute on on*/URL attributes or a javascript: URL outside safe-html.js',()=>{
  const bad=SRC.filter(NOT_SAFE).flatMap(f=>sinks(read(f),f));
  assert.deepEqual(bad,[],'use setHTML(el, html`...`) from src/safe-html.js:\n'+bad.join('\n'));
});

test('no inline event-handler attribute (on*=) in any markup the app serves',()=>{
  const bad=hits(/<[a-zA-Z][^<>]*?\son[a-z]{3,}\s*=/g,SRC);
  assert.deepEqual(bad,[],'attach handlers with addEventListener or delegation (script-src-attr is none):\n'+bad.join('\n'));
  assert.deepEqual(hits(/href\s*=\s*["'`]?\s*javascript:/gi,SRC),[],'no javascript: URL');
});

test('trusted(...) wraps one call to an audited producer (charts.js, geo.js, the story paper) as its whole argument, and every use is counted',()=>{
  const uses=SRC.filter(NOT_SAFE).flatMap(f=>trustedUses(read(f),f));
  const bad=uses.filter(u=>!u.ok).map(u=>`${u.file}:${u.line}: trusted(${u.arg.slice(0,60)}`);
  assert.deepEqual(bad,[],'trusted() wraps only audited producers, as the whole argument:\n'+bad.join('\n'));
  assert.ok(uses.length>=5&&uses.length<=14,'trusted() is rare: '+uses.length+' uses');
});

test('the lint itself: it catches every probe from the red-team retest (s15) and the other sinks, and passes the audited patterns',()=>{
  const flagged=src=>sinks(src).length>0, trustedBad=src=>trustedUses(src).filter(u=>!u.ok).length;
  for(const bad of [
    "el['inner'+'HTML']=user","el['innerHTML']=user","el.innerHTML=user","el.outerHTML+=user","Object.assign(el,{innerHTML:user})","el.insertAdjacentHTML('beforeend',user)",
    "new DOMParser().parseFromString(user,'text/html')","document.createRange().createContextualFragment(user)","f.srcdoc=user","f.setAttribute('srcdoc',user)",
    "a.setAttribute('href',user)","a.setAttribute(\"src\",user)","a.setAttribute('onclick','x()')","a.setAttribute('onerror', x)","a.href='javascript:alert(1)'","a.href = `javascript:${x}`","location.href='javascript:x'",
    "new Function('return 1')()","Function('return 1')()","eval(user)","setTimeout('x()',1)","document.write(user)","el.setHTMLUnsafe(user)","document.createElement('script')","<a href=javascript:x>",
  ])assert.ok(flagged(bad),'not flagged: '+bad);
  for(const bad of [
    "trusted(AtlasCharts.esc('')+user)","trusted(AtlasCharts.dashboard(m)+user)","trusted('<b>'+user)","trusted(`<b>${user}</b>`)","trusted(user)","trusted(G.worldSVG(a)||user)","trusted(AtlasCharts.esc(user))",
    "trusted(B.footnoteHTML(x)+'<i>'+user)","trusted( AtlasGeo.worldSVG(a)+b )","trusted(AtlasCharts.qualityGauge(')')+user)",
  ])assert.ok(trustedBad(bad)>0&&trustedBad("setHTML(el,"+bad+")")>0,'trusted() accepted: '+bad);
  for(const good of [
    "setHTML(el,trusted(AtlasCharts.qualityGauge(q,{jev:J,admin:!!x?.admin})))","trusted(window.AtlasCharts.portfolioMap({a:(1+2)},{interactive:true}))","trusted(G.worldSVG({states,titles,idPrefix:'board',aspect:16/10}))",
    "trusted(B.outreachChips(g?.outreach,S.boot.features?.teams))","${x?trusted(B.footnoteHTML(S.onePager)):''}","trusted(AtlasCharts.dashboard(AtlasCharts.modelFromProject(p,E,{a:`x${')'}`})))","trusted(paperHTML(a,b))",
  ])assert.equal(trustedBad(good),0,'trusted() rejected: '+good);
  for(const ok of ["el.textContent=user","el.href=safeUrl(u)","a.setAttribute('data-id',x)","a.setAttribute('class','x')","setHTML(el,html`<b>${u}</b>`)","const tf=document.createTextNode(u)","x.innerHTML.length","if(a.innerHTML==='')b()"])
    assert.equal(flagged(ok),false,'false positive: '+ok);
});

test('src/safe-html.js: html escapes every interpolation, passes Safe through, joins arrays, setHTML refuses a plain string',()=>{
  const {html,esc,trusted,join,setHTML,Safe}=require('../src/safe-html.js');
  const evil='"><img src=x onerror=alert(1)>\'&';
  assert.equal(String(html`<a title="${evil}">${evil}</a>`),'<a title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&#39;&amp;">&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&#39;&amp;</a>');
  assert.equal(String(html`<ul>${[1,2,3].map(n=>html`<li>${n}</li>`)}</ul>`),'<ul><li>1</li><li>2</li><li>3</li></ul>');
  assert.equal(String(html`<p>${'<b>'}</p>`),'<p>&lt;b&gt;</p>','a plain string is never markup');
  assert.equal(String(html`${null}|${undefined}|${false}|${0}|${true}`),'|||0|true');
  assert.equal(String(html`<i>${html`<b>${'<'}</b>`}</i>`),'<i><b>&lt;</b></i>','nested Safe is not escaped twice');
  assert.equal(String(join([html`<b>a</b>`,'<c>'],' · ')),'<b>a</b> · &lt;c&gt;');
  assert.equal(String(join(['a','b'],'<')),'a&lt;b');
  assert.equal(esc(trusted('<b>')),'<b>'); assert.equal(esc(null),''); assert.equal(esc(5),'5');
  assert.ok(html`x` instanceof Safe&&Object.isFrozen(require('../src/safe-html.js')));
  const el={set innerHTML(v){this.v=v;}}; setHTML(el,html`<b>${'<'}</b>`); assert.equal(el.v,'<b>&lt;</b>');
  assert.throws(()=>setHTML(el,'<b>x</b>'),TypeError); assert.throws(()=>setHTML(el,String(html`x`)),TypeError);
  const el2={insertAdjacentHTML(w,v){this.w=w;this.v=v;}}; require('../src/safe-html.js').insertHTML(el2,'afterend',html`<i>${'&'}</i>`); assert.deepEqual([el2.w,el2.v],['afterend','<i>&amp;</i>']);
});

test('src/runtime.js reads the JSON data block (and tolerates the empty one, a missing one and junk)',()=>{
  const run=text=>{const g={document:{getElementById:id=>id==='atlas-runtime'&&text!==null?{textContent:text}:null}};g.window=g;new Function('window','document',fs.readFileSync(path.join(ROOT,'src/runtime.js'),'utf8'))(g,g.document);return g.ATLAS_RUNTIME;};
  assert.deepEqual({...run('{"subjectKey":"k","authMode":"access","name":"a@b.c"}')},{subjectKey:'k',authMode:'access',name:'a@b.c'});
  assert.equal(run('{}'),undefined,'an offline copy has no runtime'); assert.equal(run(null),undefined); assert.equal(run('not json'),undefined); assert.equal(run('[1]'),undefined);
  assert.ok(Object.isFrozen(run('{"a":1}')));
});
