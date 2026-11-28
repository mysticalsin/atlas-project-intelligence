/* ATLAS project reference sheet as a real .docx (Office Open XML), in the Amaris/Mantu template:
   (1) project title heading, (2) Executive Summary as labelled paragraphs, (3) one 8-row x 2-column table
   (label column fixed at 3 cm), (4) optional key visuals with captions. Calibri is set on every run. */
(function(root,factory){const api=factory(root.AtlasPptx||(typeof require==='function'?require('./pptx.js'):null));if(typeof module==='object'&&module.exports)module.exports=api;else root.AtlasDocx=api;})(typeof globalThis!=='undefined'?globalThis:this,(Pptx)=>{
'use strict';
const plain=s=>String(s??'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,'');
const x=s=>plain(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const HEAD='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS='xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const FONT='<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/>';
const CM=567,PAGE_W=11906,PAGE_H=16838,MARGIN=1134,TEXT_W=PAGE_W-2*MARGIN,LABEL_W=3*CM,CONTENT_W=TEXT_W-LABEL_W; // A4, 2 cm margins, 3 cm labels
const PURPLE='3E007A';
function run(text,{bold=false,italic=false,size=11,color=''}={}){const lines=String(text??'').split('\n');
 return lines.map((l,i)=>`<w:r><w:rPr>${FONT}${bold?'<w:b/><w:bCs/>':''}${italic?'<w:i/><w:iCs/>':''}${color?`<w:color w:val="${color}"/>`:''}<w:sz w:val="${size*2}"/><w:szCs w:val="${size*2}"/></w:rPr>${i?'<w:br/>':''}<w:t xml:space="preserve">${x(l)}</w:t></w:r>`).join('');}
function para(runs,{style='',after=120,align=''}={}){return `<w:p><w:pPr>${style?`<w:pStyle w:val="${style}"/>`:''}<w:spacing w:after="${after}"/>${align?`<w:jc w:val="${align}"/>`:''}<w:rPr>${FONT}</w:rPr></w:pPr>${runs}</w:p>`;}
const TBD='To be completed';
const val=v=>{const s=plain(v).trim();return s||TBD;};
function cell(width,content){return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${content}</w:tc>`;}
function cellParas(text,opts){return String(text).split(/\n{2,}/).map(p=>para(run(p,opts),{after:60})).join('');}
let imageSeq=0;
function picture(rel,v){const maxW=6*914400,w=Math.max(1,v.width||1600),h=Math.max(1,v.height||900),cx=Math.min(maxW,Math.round(w*9525)),cy=Math.round(cx*h/w),id=++imageSeq;
 return `<w:r><w:rPr>${FONT}</w:rPr><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Visual ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${x(v.name)||'visual'}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;}
const SECTIONS=[['industry','Industry sector, size and type of client'],['issue','The issue raised and the client’s stated requirement'],['scope','Scope of the project'],['methodology','Methodology and timing'],['deliverables','Deliverables and results achieved'],['tools','Tools and technical solution'],['team','Team organization'],['value','Added value and ROI']];
// sheet: {title, exec:{summary, teamSize, duration, price, contacts}, sections:{industry..value}, visuals:[{bytes:Uint8Array, type:'png'|'jpeg', width, height, name, caption}]}
function build(sheet){
 imageSeq=0;const e=sheet.exec||{},s=sheet.sections||{},vis=(sheet.visuals||[]).filter(v=>v&&v.bytes&&v.bytes.length&&['png','jpeg'].includes(v.type)).slice(0,3);
 const border='<w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/>';
 const table=`<w:tbl><w:tblPr><w:tblW w:w="${TEXT_W}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${border}</w:tblBorders><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="${LABEL_W}"/><w:gridCol w:w="${CONTENT_W}"/></w:tblGrid>`
  +SECTIONS.map(([k,label])=>`<w:tr><w:trPr><w:cantSplit/></w:trPr>${cell(LABEL_W,para(run(label,{bold:true,size:10,color:PURPLE}),{after:0}))}${cell(CONTENT_W,cellParas(val(s[k]),{size:10}))}</w:tr>`).join('')+'</w:tbl>';
 const summary=[['Summary',e.summary],['Team size',e.teamSize],['Project duration',e.duration],['Project price',e.price],['Contacts',e.contacts]].map(([l,v])=>para(run(l+': ',{bold:true})+run(val(v)))).join('');
 const visuals=vis.length?para(run('Key Visuals',{bold:true,size:14,color:PURPLE}),{style:'Heading2',after:120})+vis.map((v,i)=>para(picture('rIdImg'+(i+1),v),{after:60,align:'center'})+para(run(val(v.caption),{italic:true,size:9}),{after:200,align:'center'})).join(''):'';
 const body=para(run(val(sheet.title),{bold:true,size:20,color:PURPLE}),{style:'Heading1',after:200})
  +para(run('Executive Summary',{bold:true,size:14,color:PURPLE}),{style:'Heading2',after:120})+summary
  +para(run('Detailed Information Sheet',{bold:true,size:14,color:PURPLE}),{style:'Heading2',after:120})+table+para('',{after:0})
  +visuals;
 const doc=HEAD+`<w:document ${NS}><w:body>${body}<w:sectPr><w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;
 const styles=HEAD+`<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>${FONT}<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr>${FONT}</w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr>${FONT}<w:b/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr><w:rPr>${FONT}<w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;
 const rels=HEAD+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  +vis.map((v,i)=>`<Relationship Id="rIdImg${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/visual${i+1}.${v.type==='jpeg'?'jpeg':'png'}"/>`).join('')+'</Relationships>';
 const files=[
  ['[Content_Types].xml',HEAD+'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>'],
  ['_rels/.rels',HEAD+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>'],
  ['docProps/core.xml',HEAD+`<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${x(val(sheet.title))}</dc:title><dc:creator>ATLAS</dc:creator></cp:coreProperties>`],
  ['docProps/app.xml',HEAD+'<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>ATLAS</Application></Properties>'],
  ['word/document.xml',doc],['word/styles.xml',styles],['word/_rels/document.xml.rels',rels],
  ...vis.map((v,i)=>[`word/media/visual${i+1}.${v.type==='jpeg'?'jpeg':'png'}`,v.bytes])];
 return Pptx.zip(files);}
// Bid proof one-pager (WOW_SPEC F1.8), additive: a heading, paragraphs whose sources are [n] superscript runs, then a final
// "Sources" section. Interpretation paragraphs are marked ◇ and set in italics. `build` above is unchanged.
// model: {title, subtitle?, warning?, label?, blocks:[{heading, paragraphs:[{text, kind:'fact'|'interpretation', notes:[n]}]}], notes:[{n, text}]}
function buildOnePager(model){const m=model&&typeof model==='object'?model:{},list=v=>Array.isArray(v)?v:[],GREY='666A78';
 const sup=n=>`<w:r><w:rPr>${FONT}<w:vertAlign w:val="superscript"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:t xml:space="preserve">[${n}]</w:t></w:r>`;
 const notesOf=p=>[...new Set(list(p?.notes).filter(n=>Number.isInteger(n)&&n>0))];
 const paragraph=p=>para((p?.kind==='interpretation'?run('◇ ',{color:PURPLE}):'')+run(p?.text,{italic:p?.kind==='interpretation'})+notesOf(p).map(sup).join(''));
 const body=para(run(val(m.title),{bold:true,size:20,color:PURPLE}),{style:'Heading1',after:120})
  +(plain(m.subtitle).trim()?para(run(m.subtitle,{italic:true,size:12})):'')
  +(plain(m.warning).trim()?para(run(m.warning,{italic:true,size:10,color:'9A0000'})):'')
  +list(m.blocks).map(b=>(plain(b?.heading).trim()?para(run(b.heading,{bold:true,size:14,color:PURPLE}),{style:'Heading2',after:120}):'')+list(b?.paragraphs).map(paragraph).join('')).join('')
  +para(run('Sources',{bold:true,size:14,color:PURPLE}),{style:'Heading2',after:120})
  +list(m.notes).filter(n=>Number.isInteger(n?.n)&&n.n>0).map(n=>para(run('['+n.n+'] ',{bold:true,size:9})+run(n.text,{size:9}),{after:60})).join('')
  +para(run('◇ interpretation relating the cited words to a requirement. Everything else restates them.'+(plain(m.label).trim()?' '+m.label:''),{italic:true,size:9,color:GREY}),{after:0});
 const doc=HEAD+`<w:document ${NS}><w:body>${body}<w:sectPr><w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;
 const styles=HEAD+`<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>${FONT}<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr>${FONT}</w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr>${FONT}<w:b/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr><w:rPr>${FONT}<w:b/><w:sz w:val="28"/></w:rPr></w:style></w:styles>`;
 const files=[
  ['[Content_Types].xml',HEAD+'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>'],
  ['_rels/.rels',HEAD+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>'],
  ['docProps/core.xml',HEAD+`<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${x(val(m.title))}</dc:title><dc:creator>ATLAS</dc:creator></cp:coreProperties>`],
  ['docProps/app.xml',HEAD+'<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>ATLAS</Application></Properties>'],
  ['word/document.xml',doc],['word/styles.xml',styles],
  ['word/_rels/document.xml.rels',HEAD+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>']];
 return Pptx.zip(files);}
return {build,buildOnePager,SECTIONS,TBD,LABEL_W,CONTENT_W,TEXT_W};
});
