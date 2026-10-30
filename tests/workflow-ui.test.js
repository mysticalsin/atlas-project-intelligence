// workflow-ui.js against a minimal fake DOM (no browser needed): it renders the seven cards with textContent only, shows the mock badge,
// hides itself when the workflow is off or there is nothing to show, and never writes markup from server strings.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
class El{constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.listeners={};this.hidden=false;this._text='';this.id='';}
 setAttribute(k,v){this.attrs[k]=v;if(k==='id')this.id=v;}getAttribute(k){return this.attrs[k];}
 get dataset(){const d={};for(const [k,v] of Object.entries(this.attrs))if(k.startsWith('data-'))d[k.slice(5).replace(/-(\w)/g,(_,c)=>c.toUpperCase())]=v;return d;}
 addEventListener(t,f){this.listeners[t]=f;}append(...k){for(const x of k)this.children.push(x);}replaceChildren(...k){this.children=[...k];this._text='';}
 set textContent(v){this._text=String(v);this.children=[];}get textContent(){return this._text+this.children.map(c=>typeof c==='string'?c:c.textContent).join('');}
 find(pred,out=[]){if(pred(this))out.push(this);for(const c of this.children)if(c instanceof El)c.find(pred,out);return out;}}
const mk=()=>{globalThis.Node=El;const els={workflowStatus:new El('div'),library:new El('section')};els.workflowStatus.hidden=true;els.library.hidden=false;
 globalThis.document={readyState:'complete',createElement:t=>new El(t),createTextNode:s=>String(s),getElementById:id=>els[id]||null,addEventListener(){}};
 return els;};
function boot({features={evidence_workflow:true},items,view,mode='live',library=true}){
 const els=mk(),calls=[];
 class Expired extends Error{}
 globalThis.MutationObserver=class{constructor(f){this.f=f;}observe(){}};
 globalThis.window=globalThis;
 window.AtlasAuth={mode,probe:async()=>{},Expired,onSignedIn(){}};
 window.ATLAS_APP={bootInfo:async()=>({library,features}),libraryApi:async p=>{calls.push(p);return p==='/evidence'?{items}:view;}};
 window.AtlasWorkflowCore=require('../src/workflow-core.js');
 const f=path.resolve(__dirname,'../src/workflow-ui.js');delete require.cache[f];require(f);
 return {els,calls};
}
const ORDER=['evidence','maap','project_review','dna','mechat','imp','spotlight'];
const VIEW=()=>({adapters:'mock',overall:{status:'in_progress',complete:false},cards:ORDER.map((b,i)=>({branch:b,label:'<b>'+b+'</b>',status:'x',display_status:['approved','pending','pending','mock_acknowledged','failed','waiting_permission','draft'][i],
 mock:i>2,updated_at:'2026-11-01T00:00:00.000Z',reason:['','MAAP_NOT_CONFIGURED','PROJECT_REVIEW_NOT_CONFIGURED','MOCK_NOT_SYNCED','<script>x</script>','PURPOSE_NOT_GRANTED:matching',null][i]}))});
const settle=()=>new Promise(r=>setTimeout(r,20));
test('renders seven cards in order with the mock badge, and the overall line is not "complete"',async()=>{
 const {els,calls}=boot({items:[{id:'e1',project_ref:'PRJ-1',state:'approved',revision:1,mine:true}],view:VIEW()});await settle();
 const s=els.workflowStatus;assert.equal(s.hidden,false);assert.deepEqual(calls,['/evidence','/evidence/e1/status']);
 const cards=s.find(e=>e.attrs.class==='wf-card');assert.deepEqual(cards.map(c=>c.attrs['data-branch']),ORDER);
 assert.deepEqual(cards.map(c=>c.find(e=>e.attrs.class==='tag wf-mock').length),[0,0,0,1,1,1,1]);
 assert.equal(cards[3].find(e=>e.attrs.class==='wf-card-status')[0].textContent,'Mock acknowledged — not synced');
 assert.equal(cards[0].find(e=>e.tag==='h3')[0].textContent,'Evidence'); // the server's label (with markup) is ignored
 assert.match(cards[4].textContent,/Reported: |Failed/);assert.ok(!s.textContent.includes('<script>'),'a hostile reason is not shown');
 const overall=s.find(e=>e.attrs.class==='wf-overall small')[0];assert.match(overall.textContent,/Needs attention/);assert.ok(!/Everything is finished/.test(overall.textContent));
 assert.match(s.textContent,/Nothing was sent to a real system/);
});
test('hidden when the feature is off, not live, no library or no records',async()=>{
 for(const o of [{features:{evidence_workflow:false}},{features:{}},{mode:'local'},{library:false},{items:[]}]){
  const {els,calls}=boot({items:[{id:'e1',state:'approved',revision:1}],view:VIEW(),...o});await settle();
  assert.equal(els.workflowStatus.hidden,true,JSON.stringify(o));assert.ok(!calls.includes('/evidence/e1/status'));
 }
});
test('a failing status call hides the panel instead of showing a guess',async()=>{
 const els=mk();globalThis.MutationObserver=class{observe(){}};globalThis.window=globalThis;
 class Expired extends Error{}window.AtlasAuth={mode:'live',probe:async()=>{},Expired,onSignedIn(){}};
 window.ATLAS_APP={bootInfo:async()=>({library:true,features:{evidence_workflow:true}}),libraryApi:async p=>{if(p==='/evidence')return {items:[{id:'e1',state:'approved',revision:1}]};throw new Error('boom');}};
 window.AtlasWorkflowCore=require('../src/workflow-core.js');const f=path.resolve(__dirname,'../src/workflow-ui.js');delete require.cache[f];require(f);await settle();
 assert.equal(els.workflowStatus.hidden,true);
});
