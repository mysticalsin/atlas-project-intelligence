// F1: markup reaches the DOM only through src/safe-html.js, and no inline event handler exists anywhere (script-src-attr 'none').
// Fails on: a raw innerHTML/outerHTML assignment, insertAdjacentHTML, document.write, srcdoc, eval/new Function outside safe-html.js;
// an inline on*= attribute in any HTML string or file the app serves; and any trusted(...) call that is not one of the audited producers.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const list=(dir,re)=>fs.readdirSync(path.join(ROOT,dir)).filter(n=>re.test(n)).map(n=>dir+'/'+n);
const SRC=[...list('src',/\.(js|html)$/),...list('deploy/cloudflare-edge/src',/\.js$/).filter(f=>!/policy\.generated|csp\.generated/.test(f))];
const read=f=>fs.readFileSync(path.join(ROOT,f),'utf8');
const hits=(re,files)=>files.flatMap(f=>{const t=read(f),out=[];for(const m of t.matchAll(re)){const line=t.slice(0,m.index).split('\n').length;out.push(`${f}:${line}: ${t.slice(m.index,m.index+70).replace(/\s+/g,' ')}`);}return out;});
const NOT_SAFE=f=>f!=='src/safe-html.js';

test('no raw innerHTML/outerHTML assignment, insertAdjacentHTML, document.write, srcdoc, eval or new Function outside safe-html.js',()=>{
  const bad=hits(/\.(?:innerHTML|outerHTML)\s*\+?=(?!=)|insertAdjacentHTML|document\.write(?:ln)?\s*\(|\.srcdoc\s*=|\beval\s*\(|new\s+Function\s*\(/g,SRC.filter(NOT_SAFE));
  assert.deepEqual(bad,[],'use setHTML(el, html`...`) from src/safe-html.js:\n'+bad.join('\n'));
});

test('no inline event-handler attribute (on*=) in any markup the app serves',()=>{
  const bad=hits(/<[a-zA-Z][^<>]*?\son[a-z]{3,}\s*=/g,SRC);
  assert.deepEqual(bad,[],'attach handlers with addEventListener or delegation (script-src-attr is none):\n'+bad.join('\n'));
  assert.deepEqual(hits(/href\s*=\s*["'`]?\s*javascript:/gi,SRC),[],'no javascript: URL');
});

test('trusted(...) is used only for the audited SVG/markup producers (charts.js, geo.js, the story paper) and every use is listed',()=>{
  const ALLOWED=/^(?:window\.)?(?:AtlasCharts|G|AtlasGeo)\.|^B\.(?:footnoteHTML|outreachChips)\(|^paperHTML\(/;
  const uses=SRC.filter(NOT_SAFE).flatMap(f=>{const t=read(f),out=[];for(const m of t.matchAll(/(?<![\w.])trusted\(/g)){const rest=t.slice(m.index+m[0].length,m.index+m[0].length+80);out.push({f,arg:rest,line:t.slice(0,m.index).split('\n').length});}return out;});
  const bad=uses.filter(u=>!ALLOWED.test(u.arg)).map(u=>`${u.f}:${u.line}: trusted(${u.arg.slice(0,50)}`);
  assert.deepEqual(bad,[],'trusted() wraps only audited producers:\n'+bad.join('\n'));
  assert.ok(uses.length<=14,'trusted() is rare: '+uses.length+' uses');
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
