// D-DSR dispute panel (src/dispute-ui.js) against a minimal fake DOM: the badge, both views, buttons disabled from the record's actions with the reason beside
// them, a reason required before anything is sent, the exact review body posted, a refusal shown in words with the buttons restored. textContent only.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
class El{constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.listeners={};this.hidden=false;this._text='';this.disabled=false;this.value='';}
 setAttribute(k,v){this.attrs[k]=v;}getAttribute(k){return this.attrs[k];}removeAttribute(k){delete this.attrs[k];}
 get dataset(){const d={};for(const [k,v] of Object.entries(this.attrs))if(k.startsWith('data-'))d[k.slice(5).replace(/-(\w)/g,(_,c)=>c.toUpperCase())]=v;return d;}
 addEventListener(t,f){this.listeners[t]=f;}append(...k){for(const x of k)this.children.push(x);}focus(){this.focused=true;}
 set textContent(v){this._text=String(v);this.children=[];}get textContent(){return this._text+this.children.map(c=>typeof c==='string'?c:c.textContent).join('');}
 find(pred,out=[]){if(pred(this))out.push(this);for(const c of this.children)if(c instanceof El)c.find(pred,out);return out;}}
function boot(reply){const calls=[];globalThis.window=globalThis;globalThis.document={createElement:t=>new El(t)};
 window.AtlasAuth={Expired:class extends Error{}};
 window.ATLAS_APP={libraryApi:async(p,o)=>{calls.push([p,o&&o.body]);if(reply instanceof Error)throw reply;return reply;}};
 window.AtlasDisputeCore=require('../src/dispute-core.js');const f=path.resolve(__dirname,'../src/dispute-ui.js');delete require.cache[f];require(f);return calls;}
const REJ={by:'solo@mantu.com',reason:'The figure has no source.'},DIS={by:'alex@mantu.com',rationale:'The export is the source.',rejection:REJ};
const REC=o=>({id:'ev1',revision:3,state:'disputed',access:'reviewer',rejection:REJ,dispute:DIS,actions:['uphold_rejection','reopen_review'],adjudication_policy:{reviewers:1,you_rejected:true,may_adjudicate:true,rule:'single_reviewer'},...o});
const q=(el,attr,val)=>el.find(e=>e.attrs&&e.attrs[attr]!==undefined&&(val===undefined||e.attrs[attr]===val));
const settle=()=>new Promise(r=>setTimeout(r,10));

test('single reviewer: badge, both views, the note, and an overturn with a reason posts exactly one review',async()=>{
 const calls=boot({id:'ev1',state:'reviewer_queue'});let changed=null;
 const el=window.AtlasDisputeUI.panel(REC(),{onChanged:(r,a)=>{changed=[r.state,a];}});
 assert.equal(el.attrs['data-dispute-state'],'disputed');assert.equal(q(el,'data-dp-badge')[0].textContent,'Disputed');
 assert.match(el.textContent,/Rejected by solo@mantu\.com/);assert.match(el.textContent,/The export is the source\./);assert.match(el.textContent,/only reviewer for this project/);
 const [up,re]=q(el,'data-dp-do');assert.deepEqual([up.disabled,re.disabled],[false,false]);
 await re.listeners.click();assert.equal(calls.length,0,'nothing is sent without a reason');assert.match(el.textContent,/Say why the rejection is overturned\./);
 el.find(e=>e.tag==='textarea')[0].value='The export supports it.';await re.listeners.click();await settle();
 assert.deepEqual(calls,[['/evidence/ev1/review',{action:'reopen_review',expected_revision:3,reason:'The export supports it.'}]]);
 assert.deepEqual(changed,['reviewer_queue','reopen_review']);assert.match(el.textContent,/back in review/);
});

test('a rejecter with another reviewer available: both buttons disabled, described, and nothing can be sent',async()=>{
 const calls=boot({});const el=window.AtlasDisputeUI.panel(REC({actions:[],adjudication_policy:{reviewers:2,you_rejected:true,may_adjudicate:false,rule:'refused'}}));
 const bs=q(el,'data-dp-do');assert.ok(bs.every(b=>b.disabled&&b.attrs['aria-describedby']));
 assert.equal(q(el,'data-dp-why').length,2);assert.match(q(el,'data-dp-why')[0].textContent,/another reviewer is available/);
 assert.equal(el.find(e=>e.tag==='textarea').length,0,'no reason box when nothing can be decided');
 await bs[0].listeners.click();assert.equal(calls.length,0);
});

test('owner raises a dispute with an optional adjudicator; a refusal is said in words and the buttons come back',async()=>{
 const err=Object.assign(new Error('Not allowed: REVISION_MISMATCH:3'),{reason:'REVISION_MISMATCH:3'});const calls=boot(err);
 const el=window.AtlasDisputeUI.panel(REC({state:'rejected',access:'owner',mine:true,dispute:null,actions:['dispute','accept_rejection','withdraw'],adjudication_policy:null}));
 assert.equal(q(el,'data-dp-badge')[0].textContent,'Rejected');const [raise,accept]=q(el,'data-dp-do');assert.deepEqual([raise.textContent,raise.disabled,accept.disabled],['Raise a dispute',false,false]);
 el.find(e=>e.tag==='textarea')[0].value='The export is the source.';el.find(e=>e.tag==='input')[0].value='rev2@mantu.com';
 await raise.listeners.click();await settle();
 assert.deepEqual(calls[0][1],{action:'dispute',expected_revision:3,reason:'The export is the source.',rationale:'The export is the source.',adjudicator:'rev2@mantu.com'});
 assert.match(el.textContent,/changed while you were reading/);assert.deepEqual([raise.disabled,accept.disabled],[false,false]);
});

test('nothing for a record that has never been rejected',()=>{boot({});assert.equal(window.AtlasDisputeUI.panel({id:'x',state:'reviewer_queue',actions:['approve']}),null);});
