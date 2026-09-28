'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),P=require('../src/pptx.js');
function entries(b){const v=new DataView(b.buffer,b.byteOffset,b.byteLength);let e=b.length-22;assert.equal(v.getUint32(e,true),0x06054b50);const n=v.getUint16(e+10,true);let o=v.getUint32(e+16,true);const out={};
 for(let i=0;i<n;i++){assert.equal(v.getUint32(o,true),0x02014b50);const crc=v.getUint32(o+16,true),size=v.getUint32(o+20,true),nl=v.getUint16(o+28,true),lo=v.getUint32(o+42,true),name=new TextDecoder().decode(b.slice(o+46,o+46+nl));
  const ln=v.getUint16(lo+26,true),data=b.slice(lo+30+ln,lo+30+ln+size);assert.equal(P.crc32(data),crc,name);out[name]=new TextDecoder().decode(data);o+=46+nl;}return out;}
const deck={title:'Claims & <triage>',subtitle:'Insurance',summary:'S',context:'COO "meeting"',client:'',sections:[{heading:'Results',bullets:[{text:'Fell from 40 to 12.',kind:'fact'},{text:'Fits your backlog.',kind:'interpretation'}]}],facts:{industry:'Insurance',technologies:['Python']},reference:{revision:3}};
test('pptx: valid stored zip with every required part and matching CRCs',()=>{const f=entries(P.build(deck));
 for(const part of ['[Content_Types].xml','_rels/.rels','ppt/presentation.xml','ppt/slides/slide1.xml','ppt/slides/slide2.xml','ppt/slideMasters/slideMaster1.xml','ppt/slideLayouts/slideLayout1.xml','ppt/theme/theme1.xml'])assert.ok(f[part],part);});
test('pptx: text is XML-escaped, interpretation is marked, the provenance note is present, no client unless given',()=>{const f=entries(P.build(deck)),s2=f['ppt/slides/slide2.xml'];
 assert.match(s2,/Claims &amp; &lt;triage&gt;/);assert.doesNotMatch(s2,/<triage>/);assert.match(s2,/◇ Fits your backlog\./);assert.match(s2,/nothing was added/);assert.doesNotMatch(f['ppt/slides/slide1.xml'],/Client:/);
 assert.match(entries(P.build({...deck,client:'Zebracorp'}))['ppt/slides/slide1.xml'],/Client: Zebracorp/);});
