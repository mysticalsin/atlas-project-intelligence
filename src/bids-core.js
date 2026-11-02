/* ATLAS bid proof: pure presentation logic for the Bids view (verdict copy, footnotes, one-pager exports, win cells).
   No DOM, no network. UMD so node tests cover it (WOW_SPEC F1.7, F1.8, F7.3). Every string that reaches HTML goes through esc();
   the server's view (author or other) is rendered exactly as returned, never re-masked or un-masked here. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.AtlasBids=api;})(typeof globalThis!=='undefined'?globalThis:this,root=>{
'use strict';
const esc=(root.AtlasSafe||(typeof require==='function'?require('./safe-html.js'):null)).esc;  // the shared escape (src/safe-html.js, loaded first in the page)
const own=(o,k)=>Object.hasOwn(o,k)?o[k]:undefined;  // table lookups never reach Object.prototype
const str=v=>typeof v==='string'?v:v==null?'':String(v);
const line=v=>str(v).replace(/\s+/g,' ').trim();
const int=v=>Number.isInteger(v)&&v>=0?v:0;
const arr=v=>Array.isArray(v)?v:[];
const MIN_N=5;
// F1.7 verdict banner copy (exact wording). `run` is a MatchRun (coverage per requirement) or {covered, total}.
const VERDICTS={strong:'Strong proof found for N of M requirements.',partial:'Partial matches only. Check each caveat.',none:'No strong match in the library for this brief.',
 unranked:'Not ranked: the AI ranking did not answer. Similarity only.',empty_library:'No published references are available to you yet.'};
function verdictCopy(v,run){if(!Object.prototype.hasOwnProperty.call(VERDICTS,v))return null;
 const cov=arr(run?.coverage).filter(c=>c&&typeof c==='object');
 const covered=cov.length?cov.filter(c=>c.status==='covered').length:int(run?.covered),total=cov.length?cov.length:int(run?.total);
 let text=VERDICTS[v];
 // The JEV path ranks without per-requirement coverage (F1.3): say so rather than print "0 of M".
 if(v==='strong')text=cov.length&&cov.every(c=>c.status==='unknown')?'Strong proof found. Coverage per requirement was not assessed.':text.replace('N',covered).replace('M',total);
 return {verdict:v,tone:v==='empty_library'?'empty':v,text,cta:v==='none'?'Ask consultants for proof':null};}
// Ask ATLAS mirrors the F1 copy (F6.3); a question has no requirements, and an empty answer is stated plainly.
const ASK_EMPTY='Nothing in the library answers this yet.';
function askVerdictCopy(v,results){const c=verdictCopy(v,{covered:0,total:0});if(!c)return null;
 if(!arr(results).length)return {...c,cta:null,text:v==='empty_library'?c.text:ASK_EMPTY};
 return {...c,cta:null,text:v==='strong'?'Strong matches found for your question.':v==='none'?'No strong match in the library for this question.':c.text};}
const TOPIC={context:'Context',contribution:'Contribution',approach:'Approach',outcome:'Outcome',evidence:'Evidence',customer_relevance:'Customer relevance'};
const CONFIRMATION={manager_confirmed:'Confirmed by N+1',client_confirmed:'Confirmed by the client contact',consultant_named:'Named by the consultant, not independently confirmed',corrected:'Corrected by N+1',cant_say:'N+1 couldn’t say',unverified:'Unverified'};
const confirmationLabel=c=>own(CONFIRMATION,c)||CONFIRMATION.unverified;
function sourceLabel(f){if(f?.kind==='evidence'){const s=[line(f.sourceName),line(f.sourceVersion)].filter(Boolean).join(' ');return 'Evidence'+(s?' · '+s:'');}
 return 'Consultant’s words'+(own(TOPIC,f?.topic)?' · '+TOPIC[f.topic]:'');}
const refOf=(op,id)=>arr(op?.references).find(r=>r&&r.id===id)||null;
const notesOf=c=>[...new Set(arr(c?.cites).filter(n=>Number.isInteger(n)&&n>0))];
const claimsOf=op=>[{heading:'Summary',claims:arr(op?.summary)},...arr(op?.sections).map(s=>({heading:line(s?.heading),claims:arr(s?.claims)}))].filter(b=>b.claims.length);
const footnotesOf=op=>arr(op?.footnotes).filter(f=>f&&Number.isInteger(f.n)&&f.n>0).sort((a,b)=>a.n-b.n);
// Plain-text source line shared by the Markdown and .docx exports.
function footnoteText(op,f){const r=refOf(op,f.refId),bits=[sourceLabel(f),(line(r?.title)||'Reference')+', r'+int(f.revision),confirmationLabel(f.confirmation)];
 if(r&&line(r.client))bits.push('Client: '+line(r.client));
 return '“'+line(f.quote)+'” — '+bits.join('. ')+'.';}
// The one-pager body for #onePager: claims with superscript source numbers (interpretation styled apart) and a Sources list with the
// quote, source label, reference title, r{revision}, confirmation badge and, only where the server returned it, that reference's client.
function footnoteHTML(op){if(!op||typeof op!=='object')return '';
 const sup=c=>{const n=notesOf(c);return n.length?`<sup class="fn" aria-label="Sources ${esc(n.join(', '))}">${n.map(esc).join(',')}</sup>`:'';};
 const claim=c=>`<li class="claim ${c?.kind==='interpretation'?'interpretation':'fact'}">${c?.kind==='interpretation'?'<span class="claim-kind" aria-label="Interpretation">◇</span> ':''}${esc(line(c?.text))}${sup(c)}</li>`;
 const blocks=claimsOf(op).map(b=>`${b.heading?`<h4>${esc(b.heading)}</h4>`:''}<ul class="onepager-claims">${b.claims.map(claim).join('')}</ul>`).join('');
 const notes=footnotesOf(op).map(f=>{const r=refOf(op,f.refId),conf=own(CONFIRMATION,f.confirmation)?f.confirmation:'unverified';
  return `<li value="${f.n}" data-fn="${f.n}"><q>${esc(line(f.quote))}</q> <span class="fn-source">${esc(sourceLabel(f))}</span> · <span class="fn-ref">${esc(line(r?.title)||'Reference')} · r${int(f.revision)}</span> <span class="badge conf-${esc(conf)}">${esc(confirmationLabel(conf))}</span>${r&&line(r.client)?` <span class="fn-client">Client: ${esc(line(r.client))}</span>`:''}</li>`;}).join('');
 const dropped=arr(op.dropped).map(line).filter(Boolean);
 return `<article class="onepager-paper"><p class="eyebrow">PROOF ONE-PAGER${op.view==='other'?' · SHARED VIEW':''}</p><h3 class="onepager-title">${esc(line(op.title)||'Proof summary')}</h3>${line(op.subtitle)?`<p class="onepager-subtitle">${esc(line(op.subtitle))}</p>`:''}`
  +(line(op.warning)?`<p class="onepager-warning">${esc(line(op.warning))}</p>`:'')+blocks
  +`<h4>Sources</h4><ol class="onepager-sources">${notes}</ol>`
  +(dropped.length?`<p class="tiny muted">Removed because a number or source could not be found in the cited words: ${dropped.map(esc).join(' · ')}</p>`:'')
  +`<p class="tiny muted">◇ interpretation relating the cited words to a requirement. Everything else restates them.${line(op.label)?' '+esc(line(op.label)):''}</p></article>`;}
// Markdown export with [^n] footnotes. Text is escaped so a quote can never forge a footnote marker, a link or HTML.
const md=s=>line(s).replace(/[\\`*_[\]<>#|]/g,'\\$&');
function onePagerMarkdown(op){if(!op||typeof op!=='object')return '';
 const out=['# '+md(line(op.title)||'Proof summary')];if(line(op.subtitle))out.push('*'+md(op.subtitle)+'*');if(line(op.warning))out.push('> '+md(op.warning));
 for(const b of claimsOf(op)){out.push('## '+md(b.heading));out.push(b.claims.map(c=>'- '+(c?.kind==='interpretation'?'◇ *Interpretation:* ':'')+md(c?.text)+notesOf(c).map(n=>'[^'+n+']').join('')).join('\n'));}
 out.push('## Sources');out.push(footnotesOf(op).map(f=>'[^'+f.n+']: '+md(footnoteText(op,f))).join('\n'));
 const dropped=arr(op.dropped).map(line).filter(Boolean);if(dropped.length)out.push('_Removed because a number or source could not be found in the cited words:_ '+dropped.map(md).join(' · '));
 out.push('---\n\n◇ interpretation relating the cited words to a requirement. Everything else restates them.'+(line(op.label)?' '+md(op.label):''));
 return out.join('\n\n')+'\n';}
// Model for AtlasDocx.buildOnePager (F1.8).
function onePagerDocxModel(op){if(!op||typeof op!=='object')return null;
 return {title:line(op.title)||'Proof summary',subtitle:line(op.subtitle),warning:line(op.warning),label:line(op.label),
  blocks:claimsOf(op).map(b=>({heading:b.heading,paragraphs:b.claims.map(c=>({text:line(c?.text),kind:c?.kind==='interpretation'?'interpretation':'fact',notes:notesOf(c)}))})),
  notes:footnotesOf(op).map(f=>({n:f.n,text:footnoteText(op,f)}))};}
// Win statistics (F7.3): a 95% Wilson interval as "41-78%"; a rate only from n >= 5 decided bids, else the caveat.
function wilsonLabel(ci){if(!Array.isArray(ci)||ci.length!==2||!ci.every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=1))return '';
 return Math.round(ci[0]*100)+'-'+Math.round(ci[1]*100)+'%';}
function winCell(row){const n=int(row?.decided),rate=row?.winRate;
 if(typeof rate!=='number'||!Number.isFinite(rate)||n<MIN_N)return {n,low:true,rate:null,ci:'',text:line(row?.caveat)||'Fewer than 5 decided bids: not shown.'};
 const ci=wilsonLabel(row.ci95),pct=Math.round(rate*100);return {n,low:false,rate:pct,ci,text:pct+'%'+(ci?' (95% CI '+ci+')':'')};}
const PROOF_TYPES={'quantified+confirmed':'Quantified · confirmed','quantified+unconfirmed':'Quantified · unconfirmed','qualitative+confirmed':'Qualitative · confirmed','qualitative+unconfirmed':'Qualitative · unconfirmed'};
const proofTypeLabel=t=>own(PROOF_TYPES,t)||line(t)||'Unknown';
// Outreach status chips (F2.6, F3.4, F4.7). Nothing is ever sent by ATLAS: email is a draft the person sends, Teams waits for an
// approval and, while Teams is not connected, always reads "Teams: BLOCKED_EXTERNAL".
const OUTREACH={pending_approval:'awaiting approval',drafted:'draft ready',sent:'sent',failed:'failed',blocked_external:'BLOCKED_EXTERNAL',dismissed:'dismissed'};
const outreachLabel=s=>own(OUTREACH,s)||line(s)||'unknown';
function outreachChips(rows,teams){const list=arr(rows).filter(r=>r&&typeof r==='object'),t=list.find(r=>r.channel==='teams'),m=list.find(r=>r.channel==='email_draft');
 const chip=(text,cls)=>`<span class="tag chip-${cls}">${esc(text)}</span>`;
 return chip(teams!=='connected'||t?.status==='blocked_external'?'Teams: BLOCKED_EXTERNAL':'Teams: '+outreachLabel(t?.status||'pending_approval'),teams!=='connected'||t?.status==='blocked_external'?'blocked':'teams')
  +chip('Email: '+(m?outreachLabel(m.status):'draft for you to send'),'email');}
// Export file name: the alias, never the title (F1.8).
const slug=s=>line(s).normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,60)||'bid';
function fileName(alias,date=new Date()){const d=date instanceof Date&&!isNaN(date)?date:new Date(),p=n=>String(n).padStart(2,'0');
 return 'ATLAS_proof_'+slug(alias)+'_'+d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());}
return {verdictCopy,askVerdictCopy,footnoteHTML,onePagerMarkdown,onePagerDocxModel,winCell,wilsonLabel,proofTypeLabel,confirmationLabel,sourceLabel,outreachChips,outreachLabel,fileName,slug,esc,MIN_N,ASK_EMPTY};
});
