'use strict';
// AtlasDocx.buildOnePager (WOW_SPEC F1.8): a valid stored zip with word/document.xml, superscript source runs and a Sources section.
const test=require('node:test'),assert=require('node:assert/strict'),D=require('../src/docx.js'),P=require('../src/pptx.js'),B=require('../src/bids-core.js');
function entries(b){const v=new DataView(b.buffer,b.byteOffset,b.byteLength);const e=b.length-22;assert.equal(v.getUint32(e,true),0x06054b50);const n=v.getUint16(e+10,true);let o=v.getUint32(e+16,true);const out={};
 for(let i=0;i<n;i++){assert.equal(v.getUint32(o,true),0x02014b50);const crc=v.getUint32(o+16,true),size=v.getUint32(o+20,true),nl=v.getUint16(o+28,true),lo=v.getUint32(o+42,true),name=new TextDecoder().decode(b.slice(o+46,o+46+nl));
  const ln=v.getUint16(lo+26,true),data=b.slice(lo+30+ln,lo+30+ln+size);assert.equal(P.crc32(data),crc,name);out[name]=new TextDecoder().decode(data);o+=46+nl;}return out;}
const MODEL={title:'Proof for <Falcon> & co',subtitle:'Two references',warning:'',label:'Every claim cites.',
 blocks:[{heading:'Summary',paragraphs:[{text:'Triage fell from 40 to 12 minutes.',kind:'fact',notes:[1]},{text:'Fits a "regional" insurer.',kind:'interpretation',notes:[2,1,2]}]}],
 notes:[{n:1,text:'“Triage fell <b>” — Consultant’s words · Outcome. Claims routing, r3. Confirmed by N+1.'},{n:2,text:'“Q2” — Evidence · Ops v3. Queue ops, r1. Unverified.'}]};

test('one-pager docx: valid zip with every part and matching CRCs',()=>{const f=entries(D.buildOnePager(MODEL));
 for(const part of ['[Content_Types].xml','_rels/.rels','docProps/core.xml','docProps/app.xml','word/document.xml','word/styles.xml','word/_rels/document.xml.rels'])assert.ok(f[part],part);
 assert.match(f['[Content_Types].xml'],/wordprocessingml\.document\.main\+xml/);});

test('one-pager docx: superscript [n] runs per claim, interpretation marked, a final Sources section',()=>{const doc=entries(D.buildOnePager(MODEL))['word/document.xml'];
 const sup=[...doc.matchAll(/<w:vertAlign w:val="superscript"\/>[^]*?<w:t xml:space="preserve">(\[\d+\])<\/w:t>/g)].map(m=>m[1]);
 assert.deepEqual(sup,['[1]','[2]','[1]'],'one run per distinct source, in claim order');
 assert.match(doc,/◇ /);assert.match(doc,/<w:i\/>/);
 const sources=doc.indexOf('>Sources<');assert.ok(sources>doc.indexOf('Fits a'),'Sources comes after the claims');
 assert.ok(doc.indexOf('[1] ',sources)>0&&doc.indexOf('[2] ',sources)>doc.indexOf('[1] ',sources));
 assert.match(doc,/Heading1[^]*Proof for &lt;Falcon&gt; &amp; co/);});

test('one-pager docx: text is XML-escaped and control characters are removed',()=>{const doc=entries(D.buildOnePager({...MODEL,blocks:[{heading:'H<1>',paragraphs:[{text:'a\u0001b <w:t>x</w:t> & "q"',kind:'fact',notes:[1]}]}]}))['word/document.xml'];
 assert.doesNotMatch(doc,/<w:t>x<\/w:t>/);assert.match(doc,/ab &lt;w:t&gt;x&lt;\/w:t&gt; &amp; &quot;q&quot;/);assert.match(doc,/H&lt;1&gt;/);assert.match(doc,/Triage fell &lt;b&gt;/);assert.doesNotMatch(doc,/\u0001/);});

test('one-pager docx: built from the AtlasBids model end to end, and build() is unchanged',()=>{
 const op={title:'T',subtitle:'',summary:[{text:'A 40% cut.',kind:'fact',cites:[1]}],sections:[],footnotes:[{n:1,refId:'r1',revision:2,kind:'consultant_words',topic:'outcome',quote:'Costs fell 40%.',confirmation:'unverified'}],references:[{id:'r1',title:'Ref',revision:2}],dropped:[]};
 const doc=entries(D.buildOnePager(B.onePagerDocxModel(op)))['word/document.xml'];assert.match(doc,/A 40% cut\./);assert.match(doc,/Costs fell 40%\./);
 const sheet=entries(D.build({title:'T',exec:{},sections:{},visuals:[]}))['word/document.xml'];assert.match(sheet,/Detailed Information Sheet/);assert.doesNotMatch(sheet,/Sources/);
 const empty=entries(D.buildOnePager(null))['word/document.xml'];assert.match(empty,/To be completed/);assert.match(empty,/>Sources</);});
