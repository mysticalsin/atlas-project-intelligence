/* Deterministic local helpers. These are not a language model or live JEV scores. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.AtlasQuality=api;})(typeof globalThis!=='undefined'?globalThis:this,root=>{
'use strict';
const sections=['challenge','contribution','approach','outcome','evidence','limitations','customer_fit','poor_fit'];
const fields={problem:'Problem',stakes:'Business stakes',contribution:'Personal contribution',intervention:'What changed',decision:'Decision & trade-off',adoption:'Actual adoption',outcome:'Observed outcome',measurement:'Measurement basis',evidence:'Checkable source',limitations:'Limits',customer_fit:'Customer fit',poor_fit:'Poor-fit conditions'};
const {esc}=root.AtlasSafe||require('./safe-html.js'); // the one shared escape; kept in the exports for the tests
function challenge(text){
 const t=String(text||'').trim().slice(0,12000),unknown=/\b(don.t know|not measured|unsure|uncertain|no baseline|estimate)\b/i.test(t);
 const checks=[
 ['contribution',/\b(I|my|personally)\b/i.test(t)&&/built|designed|implemented|tested|facilitated|led|configured/i.test(t),'Which deliverable was personally yours, and who owned the other parts?'],
 ['decision',/because|instead|rather than|trade.?off|alternative/i.test(t),'What alternative did you reject, and why was this approach appropriate?'],
 ['measurement',/\d|%|percent|saved|faster/i.test(t)?/baseline|before|after|median|cohort|sample/i.test(t)&&/source|worksheet|log|report|record|dashboard/i.test(t):true,'What does that number measure: before and after, unit, comparison period, population and source?'],
 ['evidence',/version|v\d|dated|20\d\d|signed|source|worksheet|log|report|record/i.test(t),'Which exact source and version can a reviewer check?'],
 ['limits',/pilot|limited|not causal|only|out of scope|not production|not prove|uncertain/i.test(t),'Was this production, a pilot or an assessment—and what does the outcome not prove?'],
 ['fit',/buyer|operations leader|technology leader|customer|similar team/i.test(t)&&/prerequisite|unless|poor fit|not fit|requires|ownership/i.test(t),'Which customer situation fits, and which prerequisites or constraints make it a poor fit?']];
 const gaps=checks.filter(x=>!x[1]);
 let next=gaps[0]?.[2]||'Which detail in this account would you correct before an independent reviewer sees it?';
 if(/\d|%|percent|saved|faster/i.test(t)&&!checks[2][1])next=checks[2][2];
 if(/assess|recommended|recommendation/.test(t.toLowerCase())&&/not implemented|nothing was implemented|not production|no implementation/.test(t.toLowerCase()))next='What decision did the assessment enable, rather than which production benefit did it deliver?';
 if(/cannot share|can.t share|under NDA|not authorized to disclose/i.test(t))next='We can leave restricted details out. Which non-identifying mechanism or lesson are you authorized to discuss?';
 if(unknown)next='Let’s come at that another way. What did you observe directly, and who could verify it later?';
 return {next,signals:checks.map(([id,present])=>({id,present})),flags:unknown?['Uncertainty preserved; no achieved benefit inferred']:[],
   notice:'Local wording checks only. Detailed language is not proof; these signals never approve a story.'};
}
function fromProject(p){
 if(!p)throw Error('Choose a project first.');
 const a=p.answers||[],edited=p.story?.parts;
 const val=i=>(Array.isArray(edited)&&typeof edited[i]==='string'?edited[i]:a[i])?.trim()||'Unknown — resolve with the consultant before factual review.';
 return {title:p.story?.title||p.title,kind:p.metric?'quantified':p.stage==='Lessons learned'?'learning':'experience',stage:p.stage||'Unknown',audience:'internal',
   tags:[p.sector,p.stage].filter(Boolean).map(x=>x.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,50)).filter(Boolean),
   customer_brief:'Not yet positioned for a named customer situation.',
   sections:{challenge:val(0),contribution:val(1),approach:val(2),outcome:val(3),evidence:val(4),limitations:p.story?.limitations||'Unknown — verify scope, adoption and comparability.',customer_fit:val(5),poor_fit:'Unknown — ask for prerequisites and where this approach would not transfer.'},
   sources:(p.sources||[]).filter(s=>s.active).map(s=>({id:s.id,version:s.version||'Unversioned — review required',excerpt:s.text||'No excerpt',supports:(s.topics||[]).map(i=>['challenge','contribution','approach','outcome','evidence','customer_fit'][i]).filter(Boolean)})).filter(s=>s.supports.length)};
}
function md(record){
 const meta={schema:'atlas-story-v1',id:'local-draft',title:record.title,kind:record.kind,stage:record.stage,audience:record.audience,tags:record.tags,
 status:'candidate',classification:'restricted',authority:'Local export is not publication permission. Consult the server registry for reviewed reuse.'};
 let out='---\n'+JSON.stringify(meta,null,2)+'\n---\n\n# '+record.title+'\n\n> DRAFT / UNVERIFIED. Never present as an approved customer reference.\n\n';
 for(const k of sections)out+='## '+k.replace(/_/g,' ')+'\n\n'+record.sections[k]+'\n\n';
 out+='## Versioned sources\n\n';
 for(const s of record.sources){let fence='`'.repeat(Math.max(4,1+Math.max(0,...(s.excerpt.match(/`+/g)||[]).map(x=>x.length))));out+='### '+s.id+' · '+s.version+'\nSupports: '+s.supports.join(', ')+'\n\n'+fence+'text\n'+s.excerpt+'\n'+fence+'\n\n';}
 return out;
}
return {sections,fields,challenge,fromProject,md,esc};});
