/* Minimal Office reader for the reference-sheet wizard: zip entries (stored or deflate, via DecompressionStream),
   PowerPoint slide text (Workers AI toMarkdown does not read .pptx), and embedded PNG/JPEG images from .docx/.pptx
   as candidate key visuals. Read-only; nothing leaves the browser except what the user then sends. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AtlasOffice=api;})(typeof globalThis!=='undefined'?globalThis:this,()=>{
'use strict';
async function inflate(bytes){const ds=new DecompressionStream('deflate-raw');const out=new Response(new Blob([bytes]).stream().pipeThrough(ds));return new Uint8Array(await out.arrayBuffer());}
// name -> () => Promise<Uint8Array>
function entries(buf){const b=buf instanceof Uint8Array?buf:new Uint8Array(buf),v=new DataView(b.buffer,b.byteOffset,b.byteLength);
 let e=-1;for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--)if(v.getUint32(i,true)===0x06054b50){e=i;break;}
 if(e<0)throw Error('Not a zip-based Office file.');
 const n=v.getUint16(e+10,true),out=new Map();let o=v.getUint32(e+16,true);
 for(let i=0;i<n&&o+46<=b.length;i++){if(v.getUint32(o,true)!==0x02014b50)break;
  const method=v.getUint16(o+10,true),size=v.getUint32(o+20,true),nl=v.getUint16(o+28,true),xl=v.getUint16(o+30,true),cl=v.getUint16(o+32,true),lo=v.getUint32(o+42,true);
  const name=new TextDecoder().decode(b.subarray(o+46,o+46+nl));
  out.set(name,async()=>{const ln=v.getUint16(lo+26,true),lx=v.getUint16(lo+28,true),start=lo+30+ln+lx,data=b.subarray(start,start+size);return method===0?data.slice():method===8?inflate(data):new Uint8Array(0);});
  o+=46+nl+xl+cl;}
 return out;}
const unxml=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
async function pptxText(buf){const z=entries(buf),slides=[...z.keys()].filter(k=>/^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a,b)=>+a.match(/\d+/)[0]-+b.match(/\d+/)[0]);
 const out=[];for(const [i,k] of slides.entries()){const xml=new TextDecoder().decode(await z.get(k)());const paras=xml.split(/<\/a:p>/).map(p=>[...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m=>unxml(m[1])).join('')).filter(t=>t.trim());
  if(paras.length)out.push(`Slide ${i+1}\n`+paras.join('\n'));}
 return out.join('\n\n');}
// Embedded PNG/JPEG media, largest first, small icons skipped.
async function mediaImages(buf,{minBytes=8000,max=12}={}){const z=entries(buf),keys=[...z.keys()].filter(k=>/^(word|ppt)\/media\/[^/]+\.(png|jpe?g)$/i.test(k)),out=[];
 for(const k of keys){const bytes=await z.get(k)();if(bytes.length<minBytes)continue;out.push({name:k.split('/').pop(),type:/png$/i.test(k)?'png':'jpeg',bytes});}
 return out.sort((a,b)=>b.bytes.length-a.bytes.length).slice(0,max);}
return {entries,pptxText,mediaImages};
});
