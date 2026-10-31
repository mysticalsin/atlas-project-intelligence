/* Profile helpers (WOW_ZERO_CONFIG §3.5, §5, §5.6, §5.9). Pure and deterministic: no network, no storage, no DOM.
   The model boundary lives here (modelProject), with the chip labels, the form mapping and the DNA-export CSV reader that
   drops every column outside the six approved fields before anything leaves the browser. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AtlasProfileCore=api;})(typeof window!=='undefined'?window:globalThis,function(){'use strict';
const SOURCES=['you','dna','dna_export','signin','guess'];
const FIELDS=['name','preferredName','title','managerName','managerEmail'];
const LIMITS={name:100,preferredName:40,title:100,managerName:100,managerEmail:200};
// A confirmed name may become a project's consultant; a guess never does (§3.5).
const CONFIRMED=['you','dna','dna_export','signin'];
// The six approved directory columns (§5.10); nothing else is ever uploaded.
const APPROVED=['email','name','givenName','title','managerName','managerEmail'];
const str=(v,n)=>typeof v==='string'?v.trim().slice(0,n):'';
function day(at){const m=/^(\d{4}-\d{2}-\d{2})/.exec(String(at||''));return m?m[1]:'';}
// Chip text for a value's source (§8).
function sourceLabel(from,at){
 if(from==='dna')return 'from DNA';
 if(from==='dna_export'){const d=day(at);return d?'from the DNA export ('+d+')':'from the DNA export';}
 if(from==='signin')return 'from your sign-in';
 if(from==='guess')return 'guessed from your email: please check';
 if(from==='you')return 'you edited';
 return '';}
// Chips are computed at render time (§3.5): a value equal to the profile field shows that field's source, a different
// value shows "you edited", and an empty value shows nothing.
function chipFor(field,value){const v=String(value??'').trim();if(!v)return '';if(field&&typeof field.value==='string'&&field.value.trim()===v)return sourceLabel(field.from,field.at);return 'you edited';}
function field(profile,name){const f=profile?.fields?.[name];return f&&typeof f==='object'&&typeof f.value==='string'&&SOURCES.includes(f.from)?f:null;}
// Bidi controls and zero-width characters never reach the screen in a name (the server strips them too; this covers a profile stored before that): U+202E could make a name read as an address.
const INVISIBLE=/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u200B-\u200D\u2060\uFEFF]/g;
const clean=s=>String(s??'').replace(INVISIBLE,'');
function value(profile,name){return clean(field(profile,name)?.value).trim().slice(0,LIMITS[name]||200)||'';}
function confirmedName(profile){const f=field(profile,'name');return f&&CONFIRMED.includes(f.from)?clean(f.value).trim().slice(0,100):'';}
// Profile -> project form (§3.5): consultant, role, N+1 name and email. managerStaff is never part of it.
function formValues(profile){return {consultant:value(profile,'name'),role:value(profile,'title'),managerName:value(profile,'managerName'),managerEmail:value(profile,'managerEmail')};}
// The on-screen first name (§5.7), re-validated here: at most two words, letters only, rendered with textContent.
const FIRST=/^[\p{L}\p{M}](?:[\p{L}\p{M}'’. -]{0,28}[\p{L}\p{M}.])?$/u;
function validFirstName(s){s=typeof s==='string'?s.trim():'';if(!s||!FIRST.test(s)||/[\d()[\]{}<>]/.test(s)||s.split(/\s+/).length>2)return '';return s;}
// The model boundary (§5.9): a copy with the consultant name blanked (flat or library shape), the role blanked when it
// came from the profile, and every other key kept, client included (the server scrubs with it).
function modelProject(x,roleFrom){if(!x||typeof x!=='object')return x;const out={...x};
 if(out.consultant&&typeof out.consultant==='object'){out.consultant={...out.consultant,name:''};if(roleFrom==='profile')out.consultant.role='';}
 else{if('consultant' in out)out.consultant='';if(roleFrom==='profile'&&'role' in out)out.role='';}
 return out;}
// Role provenance on submit (§3.5): 'profile' when it equals the profile title, 'you' when it differs, '' when empty.
function roleFrom(role,title){const r=String(role||'').trim(),t=String(title||'').trim();return !r?'':t&&r===t?'profile':'you';}
const EMAIL=/^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,190}\.[^\s@<>()",;:.]{2,63}$/;
function validEmail(e){e=typeof e==='string'?e.trim().toLowerCase():'';return e.length<=200&&EMAIL.test(e)?e:'';}
// ---- DNA export CSV (§5.6): UTF-8 with or without BOM; ',', ';' or tab; RFC 4180 quotes; CRLF or LF.
function detectDelimiter(text){let best=',',n=-1;const line=(()=>{let q=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"')q=!q;else if(!q&&(c==='\n'||c==='\r'))return text.slice(0,i);}return text;})();
 for(const d of [',',';','\t']){let q=false,k=0;for(const c of line){if(c==='"')q=!q;else if(!q&&c===d)k++;}if(k>n){n=k;best=d;}}return best;}
function parseCsv(input,{maxRows=20000}={}){let text=String(input??'');if(text.charCodeAt(0)===0xFEFF)text=text.slice(1);
 const d=detectDelimiter(text),rows=[];let row=[],cell='',q=false,i=0;
 const endRow=()=>{row.push(cell);cell='';if(!(row.length===1&&row[0]===''))rows.push(row);row=[];};
 while(i<text.length){const c=text[i];
  if(q){if(c==='"'){if(text[i+1]==='"'){cell+='"';i+=2;continue;}q=false;i++;continue;}cell+=c;i++;continue;}
  if(c==='"'&&cell===''){q=true;i++;continue;}
  if(c===d){row.push(cell);cell='';i++;continue;}
  if(c==='\r'){endRow();i+=text[i+1]==='\n'?2:1;if(rows.length>maxRows)throw Error('This file has more than '+maxRows.toLocaleString('en')+' rows.');continue;}
  if(c==='\n'){endRow();i++;if(rows.length>maxRows)throw Error('This file has more than '+maxRows.toLocaleString('en')+' rows.');continue;}
  cell+=c;i++;}
 if(cell!==''||row.length)endRow();
 return {delimiter:d,header:(rows.shift()||[]).map(h=>h.trim()),rows};}
const norm=h=>String(h||'').normalize('NFKD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const NAMES={email:['email','e mail','mail','adresse e mail','adresse email','adresse mail','courriel','email address','e mail address'],
 name:['name','nom complet','display name','full name'],givenName:['first name','prenom','given name'],title:['title','job title','fonction','poste']};
// UI defaults only, for the approved fields only: the admin confirms each one (§5.6).
function suggestColumns(header){const out=Object.fromEntries(APPROVED.map(k=>[k,-1])),used=new Set();
 const take=(k,i)=>{if(out[k]<0&&!used.has(i)){out[k]=i;used.add(i);}};
 (header||[]).forEach((h,i)=>{const n=norm(h);if(!n)return;const manager=/(^| )(manager|n 1|n1|responsable)( |$)/.test(n);
  if(manager){if(/(^| )(mail|email|e mail|courriel)( |$)/.test(n))take('managerEmail',i);else take('managerName',i);return;}
  for(const k of ['email','name','givenName','title'])if(NAMES[k].includes(n)){take(k,i);return;}});
 return out;}
// Rows built from the mapped approved columns only; every other column never leaves this function. Rejected rows are
// reported by spreadsheet row number (the header is row 1), never by value; lines[i] is the row number of rows[i].
function directoryRows(table,mapping){const rows=[],lines=[],rejected=[];const m=Object.fromEntries(APPROVED.map(k=>[k,Number.isInteger(mapping?.[k])?mapping[k]:-1]));
 if(m.email<0)throw Error('Choose the email column.');
 (table?.rows||[]).forEach((r,j)=>{const at=j+2,cell=k=>m[k]>=0?String(r[m[k]]??'').trim():'';
  const email=validEmail(cell('email'));if(!email){rejected.push({row:at,reason:'no valid email'});return;}
  const out={email};for(const k of ['name','givenName','title','managerName'])if(cell(k))out[k]=cell(k).slice(0,100);
  if(cell('managerEmail')){const me=validEmail(cell('managerEmail'));if(me)out.managerEmail=me;}
  rows.push(out);lines.push(at);});
 return {rows,lines,rejected};}
function batches(rows,size=500){const out=[];for(let i=0;i<rows.length;i+=size)out.push(rows.slice(i,i+size));return out.length?out:[[]];}
function randomBatchId(){const a=new Uint8Array(16);(globalThis.crypto||{}).getRandomValues?.(a);if(a.every(x=>x===0))for(let i=0;i<16;i++)a[i]=Math.floor(Math.random()*256);return [...a].map(x=>x.toString(16).padStart(2,'0')).join('');}
return {INVISIBLE,clean,SOURCES,FIELDS,LIMITS,APPROVED,sourceLabel,chipFor,formValues,confirmedName,validFirstName,modelProject,roleFrom,validEmail,parseCsv,suggestColumns,directoryRows,batches,randomBatchId,field,value};
});
