/* ATLAS local domain logic. No network, identity claims, or language-model calls. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AtlasEngine=api;})(typeof globalThis!=='undefined'?globalThis:this,()=>{
'use strict';
const TOPICS=[
 {label:'The context',title:'What was the problem, and why did it matter?',hint:'Describe the team, the situation before the project, why action was needed, and the scope.'},
 {label:'Your contribution',title:'What did you personally change?',hint:'Be specific about what you designed, built, tested or led—and what other people owned.'},
 {label:'The approach',title:'Why this approach—and did people use it?',hint:'Explain the implementation, tools, trade-offs, adoption and handover. A process change can be the right answer.'},
 {label:'The outcome',title:'What changed, and how do you know?',hint:'Distinguish measured results from estimates and observations. An honest qualitative result is useful.'},
 {label:'The evidence',title:'What could a reviewer actually check?',hint:'Name the source, its version, what it supports and its limitations. Add the supporting excerpt below.'},
 {label:'Customer relevance',title:'Who would care—and where would this not work?',hint:'Describe the buyer’s situation, prerequisites, poor-fit cases and restrictions on sharing this experience.'}
];
const HEADINGS=['The challenge','Our consultant’s contribution','The approach','The outcome','Evidence notes · internal','Where this experience is relevant'];
const BUYERS={operations:{label:'Operations leader',question:'Which part of your process faces a similar constraint—and how do you measure it today?'},technology:{label:'Technology leader',question:'Which integration, data or ownership constraint would we need to resolve in your environment?'},transformation:{label:'Transformation leader',question:'What would need to change in ownership and adoption for a similar approach to work for your teams?'}};
const STAGES=['Assessment','Proof of concept','Pilot','Production','Ongoing operation','Lessons learned'];
const id=()=>typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():`local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const now=()=>new Date().toISOString();
const text=(v,n=6000)=>typeof v==='string'?v.slice(0,n):'';
function blankProfile(name='My workspace'){return {id:id(),name:name.trim()||'My workspace',preferences:[],projects:[],lastProject:null};}
function blankState(){const p=blankProfile();return {schema:4,revision:0,activeProfile:p.id,profiles:[p]};}
function project(values={}){return {id:id(),title:text(values.title,140).trim(),consultant:text(values.consultant,100).trim(),role:text(values.role,100).trim(),roleFrom:['profile','you'].includes(values.roleFrom)?values.roleFrom:'',sector:text(values.sector,100).trim(),sectorFrom:values.sectorFrom==='interview'?'interview':'',stage:STAGES.includes(values.stage)?values.stage:'Pilot',client:cleanClient(values.client),jev:null,report:null,interview:null,details:cleanDetails(values.details),sheet:cleanSheet(values.sheet),validation:cleanValidation(values.validation),library:null,invitationId:null,quality:null,gapNotes:null,createdAt:now(),updatedAt:now(),recordRevision:1,pos:0,answers:Array(6).fill(''),deferred:Array(6).fill(false),sources:[],metric:null,story:null,audit:[],sample:Boolean(values.sample)};}
// Confidential client (who and where). Kept with the project for Mantu reference only: never placed in
// voice/LLM prompts, JEV requests or story drafts. Plain local storage is not encryption.
function cleanClient(c){c=c&&typeof c==='object'?c:{};return {name:text(c.name,120).trim(),location:text(c.location,120).trim(),contact:text(c.contact,120).trim()};}
const REPORT_TOPICS=['context','contribution','approach','outcome','evidence','customer_relevance'],VALIDATION=['none','awaiting','validated','not_required'];
function oneLine(v,n){return typeof v==='string'?Array.from(v.split(/\s+/).filter(Boolean).join(' ')).slice(0,n).join(''):'';}
// Model-drafted end-of-interview report: bounded like the server parser, never evidence, reviewed by the consultant before saving.
function cleanReport(r){if(!r||typeof r!=='object')return null;const t=r.topics&&typeof r.topics==='object'?r.topics:{};const list=(v,n)=>(Array.isArray(v)?v:[]).slice(0,n).map(x=>oneLine(x,200)).filter(Boolean);
 const f=r.facts&&typeof r.facts==='object'?r.facts:null;
 const out={headline:oneLine(r.headline,120),summary:oneLine(r.summary,900),topics:Object.fromEntries(REPORT_TOPICS.map(k=>[k,oneLine(t[k],900)])),highlights:list(r.highlights,4),gaps:list(r.gaps,6),follow_ups:list(r.follow_ups,5),status:'model_draft',savedAt:text(r.savedAt,40),
  facts:f?{project_id:oneLine(f.project_id,60),country:oneLine(f.country,60),industry:oneLine(f.industry,100),start:oneLine(f.start,20),end:oneLine(f.end,20),duration:oneLine(f.duration,40),team_size:Number.isInteger(f.team_size)&&f.team_size>0&&f.team_size<=10000?f.team_size:null,team_roles:cleanList(f.team_roles,8,60),technologies:cleanList(f.technologies,15,60),deliverables:cleanList(f.deliverables,10,160),service_lines:cleanList(f.service_lines,6,60)}:null};
 return out.headline&&out.summary?out:null;}
// N+1 (line manager) validation of the saved report. A local record, not an authenticated corporate approval.
function cleanValidation(v){v=v&&typeof v==='object'?v:{};const m=v.manager&&typeof v.manager==='object'?v.manager:{},email=text(m.email,200).trim();
 return {manager:{name:text(m.name,100).trim(),email:/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)?email:''},managerStaff:v.managerStaff===true,status:VALIDATION.includes(v.status)?v.status:'none',notifiedAt:text(v.notifiedAt,40),validatedAt:text(v.validatedAt,40),by:text(v.by,100)};}
// Backstop to the report prompt: any client detail recorded on the project is replaced in the report before it is stored.
function scrubReport(r,client){if(!r)return r;const names=[client?.name,client?.location,client?.contact].map(x=>String(x||'').trim()).filter(x=>x.length>=3);if(!names.length)return r;
 const esc=x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),re=new RegExp(names.map(esc).join('|'),'gi'),fix=v=>typeof v==='string'?v.replace(re,'the client'):v;
 const facts=r.facts?Object.fromEntries(Object.entries(r.facts).map(([k,v])=>[k,Array.isArray(v)?v.map(fix):fix(v)])):r.facts;
 return {...r,headline:fix(r.headline),summary:fix(r.summary),topics:Object.fromEntries(Object.entries(r.topics).map(([k,v])=>[k,fix(v)])),highlights:r.highlights.map(fix),gaps:r.gaps.map(fix),follow_ups:r.follow_ups.map(fix),facts};}
function requestValidation(p){const v=p.validation;v.status='awaiting';v.notifiedAt='';v.validatedAt='';v.by='';
 log(p,'Report saved; awaiting a trusted manager and a bid/pre-sales reviewer. A manager-staff checkbox does not skip either approval'+(v.manager.name?' (named '+v.manager.name+')':''));}
function recordValidation(p){const v=p.validation;if(v.status!=='awaiting')throw Error('This report is not awaiting N+1 validation.');if(!v.manager.name)throw Error('Add your N+1 on the project first.');
 v.status='validated';v.validatedAt=now();v.by=v.manager.name;log(p,'N+1 validation recorded for '+v.manager.name+' (local record, not an authenticated approval)');}
// Email draft for the N+1. The consultant sends it; the confidential client is deliberately left out.
// The same recorded name, location, and contact that scrubReport replaces are removed here too, including the subject.
function validationEmail(p,link=''){const r=p.report,v=p.validation;if(!r)throw Error('Save the interview report first.');if(!v.manager.email)throw Error('Add your N+1’s email on the project first.');
 const names=[p.client?.name,p.client?.location,p.client?.contact].map(x=>String(x||'').trim()).filter(x=>x.length>=3);
 const hide=s=>{if(typeof s!=='string')return '';if(!names.length)return s;return s.replace(new RegExp(names.map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'gi'),'the client');};
 const bullets=a=>a.length?a.map(x=>'- '+hide(x)).join('\n'):'- None noted';
 const title=hide(p.title),sector=hide(p.sector),role=hide(p.role),who=hide(p.consultant)||'I',stage=hide(p.stage),shown=hide(link);
 const head=`Hi ${v.manager.name||'there'},\n\n${who} completed an ATLAS project interview and would like your validation as N+1.\n\nProject: ${title} (${stage}${sector?', '+sector:''})\nRole: ${role||'not stated'}\n\n`;
 const foot=(shown?'\n\nValidate it or request changes directly in ATLAS: '+shown:'')+'\n\nPlease reply to confirm this account is accurate, or tell me what to correct.\n\nThe client name is recorded confidentially in ATLAS and is not included in this email. This report was drafted from a self-reported interview and is not independently verified.';
 let middle=`${hide(r.headline)}\n${hide(r.summary)}\n\nHighlights:\n${bullets(r.highlights)}\n\nOpen points:\n${bullets(r.gaps)}`;const room=1800-head.length-foot.length;if(middle.length>room)middle=middle.slice(0,Math.max(0,room-1))+'…';
 const body=head+middle+foot;return {to:v.manager.email,subject:'ATLAS report for validation: '+title,body};}
// Reference-record details (the brief's template). Stated by the consultant or typed; interview-filled fields are marked.
const DETAIL_TEXT={projectId:60,country:60,start:20,end:20,duration:40},DETAIL_LISTS={teamRoles:[8,60],technologies:[15,60],deliverables:[10,160],serviceLines:[6,60]};
function cleanList(v,n,limit){return [...new Set((Array.isArray(v)?v:typeof v==='string'?v.split(/[,;\n]/):[]).slice(0,50).map(x=>oneLine(x,limit)).filter(Boolean))].slice(0,n);}
function cleanDetails(v){v=v&&typeof v==='object'?v:{};const d=Object.fromEntries(Object.entries(DETAIL_TEXT).map(([k,n])=>[k,oneLine(v[k],n)]));
 const size=Number(v.teamSize);d.teamSize=Number.isInteger(size)&&size>0&&size<=10000?size:null;
 for(const [k,[n,l]] of Object.entries(DETAIL_LISTS))d[k]=cleanList(v[k],n,l);
 d.consultants=(Array.isArray(v.consultants)?v.consultants:[]).slice(0,20).map(c=>({name:oneLine(c?.name,100),email:/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(c?.email||'').trim())?String(c.email).trim().slice(0,200):'',role:oneLine(c?.role,100)})).filter(c=>c.name||c.email);
 d.links=(Array.isArray(v.links)?v.links:[]).slice(0,10).map(l=>({label:oneLine(l?.label,100),url:safeURL(l?.url)})).filter(l=>l.url);
 const from=v.from&&typeof v.from==='object'?v.from:{};d.from=Object.fromEntries(Object.keys(from).filter(k=>k in d&&from[k]==='interview').map(k=>[k,'interview']));return d;}
// Fill only empty details from the report's stated facts, marking them as interview-sourced (unverified).
function fillDetails(p,facts){if(!facts)return [];const d=p.details,filled=[],map={projectId:'project_id',country:'country',start:'start',end:'end',duration:'duration',teamSize:'team_size',teamRoles:'team_roles',technologies:'technologies',deliverables:'deliverables',serviceLines:'service_lines'};
 for(const [k,f] of Object.entries(map)){const val=facts[f],empty=d[k]===null||d[k]===''||(Array.isArray(d[k])&&!d[k].length);const has=val!==null&&val!==undefined&&val!==''&&!(Array.isArray(val)&&!val.length);
  if(empty&&has){const next=cleanDetails({...d,[k]:val})[k];if(next!==null&&next!==''&&!(Array.isArray(next)&&!next.length)){d[k]=next;d.from[k]='interview';filled.push(k);}}}
 if(!p.sector&&facts.industry){p.sector=oneLine(facts.industry,100);p.sectorFrom='interview';filled.push('sector');}
 if(filled.length)log(p,'Reference details filled from the interview (unverified): '+filled.join(', '));return filled;}
// ---- Project reference sheet (Amaris/Mantu template): Opp ID first, Executive Summary, 8-section fact sheet, visuals ----
const SHEET_EXEC=['summary','teamSize','duration','price','contacts'],SHEET_SECTIONS=['industry','issue','scope','methodology','deliverables','tools','team','value'];
const SHEET_LABELS={summary:'Summary',teamSize:'Team size',duration:'Project duration',price:'Project price',contacts:'Contacts',industry:'Industry sector, size and type of client',issue:'The issue raised and the client’s stated requirement',scope:'Scope of the project',methodology:'Methodology and timing',deliverables:'Deliverables and results achieved',tools:'Tools and technical solution',team:'Team organization',value:'Added value and ROI'};
const ENTITIES=['HEMA','SOLLAN','ACT','CRO'],TBD='To be completed';
const para=(v,n)=>typeof v==='string'?v.replace(/\r/g,'').trim().slice(0,n):'';
function cleanSheet(v){v=v&&typeof v==='object'?v:{};const e=v.exec&&typeof v.exec==='object'?v.exec:{},s=v.sections&&typeof v.sections==='object'?v.sections:{},f=v.file&&typeof v.file==='object'?v.file:{};
 const from=v.from&&typeof v.from==='object'?v.from:{};
 return {oppId:oneLine(v.oppId,40),oppIdPending:v.oppIdPending===true,title:oneLine(v.title,140),
  exec:Object.fromEntries(SHEET_EXEC.map(k=>[k,para(e[k],k==='summary'?1500:600)])),sections:Object.fromEntries(SHEET_SECTIONS.map(k=>[k,para(s[k],3000)])),
  visuals:(Array.isArray(v.visuals)?v.visuals:[]).slice(0,3).map(x=>({name:oneLine(x?.name,120),caption:para(x?.caption,400),why:para(x?.why,300),type:x?.type==='jpeg'?'jpeg':'png',width:Number(x?.width)||0,height:Number(x?.height)||0,dataUrl:typeof x?.dataUrl==='string'&&/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(x.dataUrl)&&x.dataUrl.length<=2800000?x.dataUrl:''})).filter(x=>x.dataUrl),
  file:{country:oneLine(f.country,60),entity:ENTITIES.includes(f.entity)?f.entity:'',entityCountry:oneLine(f.entityCountry,60)},
  from:Object.fromEntries(Object.entries(from).filter(([k,x])=>[...SHEET_EXEC,...SHEET_SECTIONS,'title'].includes(k)&&['document','interview','ai','project'].includes(x))),
  confirmedAt:oneLine(v.confirmedAt,40),fileName:oneLine(v.fileName,240)};}
const fileSafe=s=>String(s||'').replace(/[\\/:*?"<>|\u0000-\u001f]/g,' ').replace(/\s+/g,' ').trim();
// [Opp ID] - [country of business | entity (+ country)] - [client name] - [project title].docx
function sheetFileName(sheet,client){const s=sheet,loc=s.file.entity?[s.file.entity,s.file.entityCountry].filter(Boolean).join(' '):s.file.country;
 const parts=[s.oppIdPending&&!s.oppId?'TBC':s.oppId,loc,client,s.title].map(fileSafe);return parts.every(Boolean)?parts.join(' - ').slice(0,200)+'.docx':'';}
// What still blocks generation, and what should be challenged (never guessed).
function sheetIssues(sheet,client,people=[]){const s=sheet,out=[];
 if(!s.oppId&&!s.oppIdPending)out.push({field:'oppId',kind:'missing',text:'Opportunity ID (asked first)'});
 if(!s.title)out.push({field:'title',kind:'missing',text:'Project title'});
 for(const k of SHEET_EXEC)if(!s.exec[k]||s.exec[k]===TBD)out.push({field:k,kind:k==='price'?'optional':'missing',text:SHEET_LABELS[k]});
 for(const k of SHEET_SECTIONS)if(!s.sections[k]||s.sections[k]===TBD)out.push({field:k,kind:'missing',text:SHEET_LABELS[k]});
 const names=people.map(x=>String(x||'').trim()).filter(x=>x.length>=3);
 for(const k of ['summary','teamSize','duration','price'])for(const n of names)if(s.exec[k]&&s.exec[k].toLowerCase().includes(n.toLowerCase()))out.push({field:k,kind:'rule',text:`Part 1 must not name consultants (“${n}” in ${SHEET_LABELS[k]})`});
 if(/\b\d+\s*(consultants?|engineers?|developers?|people|FTEs?|architects?|analysts?)\b/i.test(s.sections.tools||''))out.push({field:'tools',kind:'rule',text:'Tools and technical solution must not include consultant counts or profiles: move them to Team organization'});
 if(s.exec.summary&&s.exec.summary!==TBD){const n=(s.exec.summary.match(/[.!?](\s|$)/g)||[]).length;if(n<3||n>5)out.push({field:'summary',kind:'rule',text:`The summary should be 3 to 5 sentences (now ${n})`});}
 if(!(s.file.entity||s.file.country))out.push({field:'file',kind:'missing',text:'Country of business (or solution entity) for the file name'});
 if(!String(client||'').trim())out.push({field:'client',kind:'missing',text:'Client name for the file name'});
 return out;}
// Deterministic baseline from what ATLAS already holds (no model): only fields the project states; the rest stays empty.
function sheetFromProject(p){const d=p.details||cleanDetails({}),a=p.answers||[],r=p.report,j=(...x)=>x.filter(v=>v&&String(v).trim()).join('\n\n');
 const team=[d.teamSize?d.teamSize+' consultants':'',d.teamRoles.length?'Roles: '+d.teamRoles.join(', '):''].filter(Boolean).join('. ');
 return cleanSheet({...p.sheet,oppId:p.sheet?.oppId||'',title:p.sheet?.title||p.title,
  exec:{summary:r?.summary||'',teamSize:d.teamSize?d.teamSize+' consultants':'',duration:d.duration||(d.start&&d.end?`${d.start} to ${d.end}`:''),price:'',contacts:''},
  sections:{industry:p.sector||'',issue:a[0]||'',scope:a[1]||'',methodology:a[2]||'',deliverables:j(d.deliverables.length?'Deliverables: '+d.deliverables.join('; '):'',a[3]),tools:d.technologies.join(', '),team,value:j(a[5],r?.topics?.outcome)}});}
// Fill only empty or "To be completed" fields; everything a person typed wins. Marks where each value came from.
function mergeSheet(base,draft,source='ai'){const s=cleanSheet(base),d=draft||{},empty=v=>!v||v===TBD;
 if(empty(s.title)&&d.title){s.title=oneLine(d.title,140);s.from.title=source;}
 for(const k of SHEET_EXEC)if(empty(s.exec[k])&&d.exec?.[k]&&d.exec[k]!==TBD){s.exec[k]=para(d.exec[k],1500);s.from[k]=source;}
 for(const k of SHEET_SECTIONS)if(empty(s.sections[k])&&d.sections?.[k]&&d.sections[k]!==TBD){s.sections[k]=para(d.sections[k],3000);s.from[k]=source;}
 return s;}
// Part 1 never names consultants: replace any known consultant name (the contacts field is exempt by design).
function scrubPart1(sheet,people=[]){const names=people.map(x=>String(x||'').trim()).filter(x=>x.length>=3);if(!names.length)return sheet;
 const re=new RegExp(names.map(n=>n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'gi');
 return {...sheet,exec:{...sheet.exec,...Object.fromEntries(['summary','teamSize','duration','price'].map(k=>[k,sheet.exec[k].replace(re,'a consultant')]))}};}
// Self-reported interview transcript kept with the project for context (unverified speech recognition, never evidence).
function cleanInterview(v){if(!v||typeof v!=='object'||typeof v.transcript!=='string'||!v.transcript.trim())return null;return {transcript:v.transcript.slice(0,60000),at:text(v.at,40),provenance:'unverified_speech_recognition'};}
// Links to server state, kept across reloads so a later sync updates the same reference (never a second one).
// An imported backup drops all of them (cleanProject importing=true): it must never write into a colleague's server reference.
const SERVER_ID=/^[A-Za-z0-9_-]{1,100}$/;
function cleanLibraryLink(l){if(!l||typeof l!=='object'||typeof l.id!=='string'||!SERVER_ID.test(l.id))return null;return {id:l.id,revision:Number.isSafeInteger(l.revision)&&l.revision>0?l.revision:null,status:text(l.status,40),syncedAt:text(l.syncedAt,40)};}
function cleanQuality(q){if(!q||typeof q!=='object'||typeof q.score!=='number'||!Number.isFinite(q.score))return null;return {score:Math.max(0,Math.min(100,q.score)),status:text(q.status,40),issues:(Array.isArray(q.issues)?q.issues:[]).slice(0,20).map(i=>({field:text(i?.field,60),detail:text(i?.detail,400)}))};}
// Proof-interview (gap mode) answers: kept on this device only until the consultant adds them to the reference (WOW_SPEC F2.1 step 6).
// results: the per-ask answers of the proof interview (<= 5 asks, <= 5 quotes of 400 characters), kept so they can be sent
// to the bid team later from the Library (review #22). Unsent answers alone keep the notes.
const GAP_STATUS=['answered_unverified','unknown','deferred','open'];
function cleanGapNotes(g){if(!g||typeof g!=='object'||typeof g.requestId!=='string'||!/^[a-f0-9]{32}$/.test(g.requestId))return null;
 const sections=Array.from({length:6},(_,i)=>{const v=Array.isArray(g.sections)?g.sections[i]:null;return typeof v==='string'&&v.trim()?v.trim().slice(0,6000):null;}),transcript=typeof g.transcript==='string'?g.transcript.slice(0,60000):'';
 const results=(Array.isArray(g.results)?g.results:[]).filter(r=>r&&typeof r==='object'&&typeof r.askId==='string'&&r.askId.trim()).slice(0,5).map(r=>({askId:r.askId.trim().slice(0,20),status:GAP_STATUS.includes(r.status)?r.status:'open',
  quotes:(Array.isArray(r.quotes)?r.quotes:[]).filter(q=>typeof q==='string'&&q.trim()).slice(0,5).map(q=>q.trim().slice(0,400))}));
 if(!sections.some(Boolean)&&!transcript.trim()&&!results.length)return null;return {requestId:g.requestId,sections,transcript,results,at:text(g.at,40)};}
function cleanJev(j){if(!j||typeof j!=='object'||!j.primary||typeof j.impact!=='number'||!Number.isFinite(j.impact))return null;const num=(x,a,b)=>typeof x==='number'&&Number.isFinite(x)?Math.max(a,Math.min(b,x)):0;
 const scores={};for(const [k,v] of Object.entries(j.scores||{}).slice(0,8))scores[text(k,40)]={label:text(v?.label,60),score:num(v?.score,0,4),confidence:num(v?.confidence,0,1)};
 return {primary:{key:text(j.primary.key,40),label:text(j.primary.label,60),confidence:num(j.primary.confidence,0,1)},also:(Array.isArray(j.also)?j.also:[]).slice(0,8).map(a=>({key:text(a?.key,40),label:text(a?.label,60),probability:num(a?.probability,0,1)})),
  scores,impact:num(j.impact,0,100),model:text(j.model,60),at:text(j.at,40),revision:Number.isSafeInteger(j.revision)?j.revision:0};}
function log(p,message){p.audit.unshift({at:now(),message:text(message,250)});p.audit=p.audit.slice(0,50);p.updatedAt=now();}
function invalidate(p,reason='Record changed',sourceChange=true){if(sourceChange)p.recordRevision++;if(p.validation?.status==='validated'){p.validation.status='awaiting';p.validation.validatedAt='';p.validation.by='';reason+='; N+1 validation reopened';}if(p.story){p.story.review={facts:null,permission:null};p.story.revision++;}log(p,reason);}
function challenge(p,index,value){const t=String(value||'').trim();const a=[];
 if(!t)return ['Start with what you remember. You can leave an unknown open rather than inventing a detail.'];

 if(index===0){if(!/team|operations|staff|users|customer|client|plant|service|department|people/i.test(t))a.push('Which team or group experienced the problem?');if(!/before|manual|delay|inconsisten|error|risk|cost|quality|bottleneck|difficult|missing|unclear/i.test(t))a.push('What was happening before the project, and what made it worth changing?');a.push('What was explicitly outside the scope?');}
 if(index===1){if(!/\bI\b|\bmy\b|personally/i.test(t))a.push('When you say “we,” which deliverables were specifically yours?');if(!/built|designed|implemented|tested|led|facilitated|developed|created|configured|mapped|migrated|wrote|specified/i.test(t))a.push('What did you personally design, build, test or lead?');if(!/owned|other|architect|supervisor|client|colleague|team|manager/i.test(t))a.push('Who owned the parts you did not deliver?');}
 if(index===2){if(!/instead|alternative|rather|reject|chose|chosen|trade.?off|because/i.test(t))a.push('Which alternative did you consider, and why did you choose this approach?');if(!/adopt|train|handover|hand.?over|owner|used|users|staff|team|operat/i.test(t))a.push('Who used the change, and who owned it after handover?');}
 if(index===3){if(/\d|%|percent|saving|faster/i.test(t)&&!p.metric)a.push('What exactly does the number measure? Add its before/after values, unit, comparison period and source—or label it as an estimate.');if(/\b(roi|savings|saved|productivity)\b/i.test(t))a.push('Is that an observed business result or an estimate? What assumptions connect the measurement to that claim?');if(!/source|worksheet|report|log|note|record|measur|observ|qualitative|estimate/i.test(t))a.push('Which record supports the result? No measurement is also a valid answer.');if(!/limit|pilot|caus|scope|sample|cohort|compare|comparison|not|only|uncertain/i.test(t))a.push('What changed besides your intervention, and what does the result not establish?');}
 if(index===4){if(!p.sources.filter(s=>s.active).length)a.push('Add a source excerpt or a versioned document reference, and choose which statements it supports.');if(!/version|v\d|dated|20\d\d|review|confirm|owner/i.test(t))a.push('Which version and which person can verify this account?');}
 if(index===5){if(!/leader|buyer|operations|technology|transformation|customer|client|plant|team/i.test(t))a.push('What kind of buyer is facing this problem?');if(!/not|poor|unless|prerequisite|depend|require|limited|boundary/i.test(t))a.push('Where would this example be a poor fit, and what prerequisites would a new customer need?');if(!/permission|share|disclos|authoriz|confidential|approval|account|consent/i.test(t))a.push('What may be shared, and who can authorize the exact customer-facing version?');}
 if(t.length<70)a.push('Can you add a concrete example, the scope and who was involved?');
 return [...new Set(a)].slice(0,3).length?[...new Set(a)].slice(0,3):['The main details are present. What is the most important limitation a customer should understand? These checks assess completeness—not truth.'];
}
function metricIssues(m,sources=[]){if(!m)return [];const e=[];if(!m.name?.trim())e.push('Name the metric.');if(!m.unit?.trim())e.push('Provide its unit.');if(!Number.isFinite(m.before)||!Number.isFinite(m.after))e.push('Enter valid before and after numbers.');if(Math.abs(m.before)>1e12||Math.abs(m.after)>1e12)e.push('Values must be within ±1 trillion.');if(!m.period?.trim())e.push('Describe the before and after periods.');if(!m.scope?.trim())e.push('Describe the sample and comparison scope.');if(!m.caveat?.trim())e.push('Record comparability limits; do not imply causality.');const src=sources.find(s=>s.id===m.sourceId&&s.active&&s.topics.includes(3));if(!src)e.push('Link an active source that supports the outcome.');return e;}
function metricDisplay(m){if(!m||!Number.isFinite(m.before)||!Number.isFinite(m.after))return null;const delta=m.after-m.before;const fmt=n=>new Intl.NumberFormat('en',{maximumFractionDigits:1}).format(n);if(['%','percent','percentage'].includes(m.unit.trim().toLowerCase()))return {headline:`${fmt(Math.abs(delta))} pp`,label:`${delta<0?'Decrease':delta>0?'Increase':'No change'} in ${m.name} (${fmt(m.before)}% → ${fmt(m.after)}%).`,percent:null};if(m.before>0)return {headline:`${fmt(Math.abs(delta/m.before*100))}%`,label:`${delta<0?'Reduction':delta>0?'Increase':'Change'} in ${m.name} (${fmt(m.before)} → ${fmt(m.after)} ${m.unit}).`,percent:delta/m.before*100};return {headline:`${fmt(Math.abs(delta))} ${m.unit}`,label:`Absolute ${delta<0?'decrease':delta>0?'increase':'change'} in ${m.name}; relative change is not reported for a non-positive baseline.`,percent:null};}
function generate(p,{buyer='operations',audience='internal'}={}){const old=p.story;const out={title:p.title,buyer:BUYERS[buyer]?buyer:'operations',audience:['internal','external'].includes(audience)?audience:'internal',parts:p.answers.slice(),limitations:p.metric?p.metric.caveat:'',sourceRevision:p.recordRevision,revision:old?old.revision+1:1,edited:false,review:{facts:null,permission:null}};p.story=out;log(p,'Draft assembled from the six interview answers');return out;}
function evidenceIssues(p){const e=[];if(!p.story){return ['Build a draft from your interview first.'];}if(p.story.sourceRevision!==p.recordRevision)e.push('The interview or evidence changed. Update the draft before reviewing.');if(!p.story.title.trim())e.push('Add a story title.');for(let i=0;i<6;i++)if(!p.story.parts[i]?.trim()||p.deferred[i])e.push(`Resolve “${TOPICS[i].label}” before marking the story reviewed.`);const active=p.sources.filter(s=>s.active);if(!active.length)e.push('Add at least one active supporting source.');for(const i of [0,1,2,3,5])if(!active.some(s=>s.topics.includes(i)&&s.inspected))e.push(`Inspect a source covering “${TOPICS[i].label}”.`);if(p.metric)e.push(...metricIssues(p.metric,p.sources));return [...new Set(e)];}
function ready(p){return !evidenceIssues(p).length&&!!p.story?.review.facts&&!!p.story?.review.permission;}
function simpleHash(v){let h=2166136261;for(const c of String(v)){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return (h>>>0).toString(16).padStart(8,'0');}
function fingerprint(p){return simpleHash(JSON.stringify({title:p.title,stage:p.stage,answers:p.answers,sources:p.sources,metric:p.metric,story:p.story?{title:p.story.title,parts:p.story.parts,buyer:p.story.buyer,audience:p.story.audience,limitations:p.story.limitations}:null}));}
function safeURL(value){try{const u=new URL(String(value));return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}}
function cleanProject(o,importing=false){if(!o||typeof o!=='object'||!text(o.title,140).trim())throw Error('Every project needs a title.');if(!Array.isArray(o.answers)||o.answers.length!==6||o.answers.some(x=>typeof x!=='string'||x.length>6000))throw Error('A project must contain exactly six text answers (up to 6,000 characters each).');
 const p=project(o);p.id=typeof o.id==='string'&&o.id.length<=100?o.id:id();p.createdAt=text(o.createdAt,40)||now();p.updatedAt=text(o.updatedAt,40)||now();p.recordRevision=Number.isSafeInteger(o.recordRevision)&&o.recordRevision>0?o.recordRevision:1;p.pos=Number.isInteger(o.pos)?Math.max(0,Math.min(6,o.pos)):0;p.answers=o.answers.slice();p.deferred=Array.from({length:6},(_,i)=>!!o.deferred?.[i]);p.jev=cleanJev(o.jev);p.report=cleanReport(o.report);p.interview=cleanInterview(o.interview);p.details=cleanDetails(o.details);p.sheet=cleanSheet(o.sheet);p.validation=cleanValidation(o.validation);if(importing&&p.validation.status==='validated'){p.validation.status='awaiting';p.validation.validatedAt='';p.validation.by='';}
 if(!importing){p.library=cleanLibraryLink(o.library);p.invitationId=typeof o.invitationId==='string'&&SERVER_ID.test(o.invitationId)?o.invitationId:null;p.quality=cleanQuality(o.quality);p.gapNotes=cleanGapNotes(o.gapNotes);}
 if(!Array.isArray(o.sources)||o.sources.length>20)throw Error('A project can contain up to 20 sources.');const ids=new Set();p.sources=o.sources.map(s=>{if(!s||!text(s.name,160).trim()||!text(s.version,100).trim()||typeof s.text!=='string'||s.text.length>20000)throw Error('A source needs a name, version and an excerpt of up to 20,000 characters.');const sid=text(s.id,100)||id();if(ids.has(sid))throw Error('Duplicate source IDs are not allowed.');ids.add(sid);return {id:sid,name:text(s.name,160),version:text(s.version,100),text:text(s.text,20000),url:safeURL(s.url),topics:[...new Set(Array.isArray(s.topics)?s.topics.filter(x=>[0,1,2,3,5].includes(x)):[])],active:s.active!==false,inspected:!importing&&s.inspected===true};});
 if(o.metric){const m=o.metric;p.metric={name:text(m.name,120),unit:text(m.unit,30),before:typeof m.before==='number'&&Number.isFinite(m.before)?m.before:null,after:typeof m.after==='number'&&Number.isFinite(m.after)?m.after:null,period:text(m.period,600),scope:text(m.scope,600),caveat:text(m.caveat,1000),sourceId:text(m.sourceId,100)};}
 if(o.story){const s=o.story;if(!Array.isArray(s.parts)||s.parts.length!==6||s.parts.some(v=>typeof v!=='string'||v.length>6000))throw Error('Story sections are invalid.');const r={facts:null,permission:null};if(!importing){for(const k of ['facts','permission']){const a=s.review?.[k];if(a&&typeof a==='object'&&text(a.name,100)&&text(a.role,100))r[k]={name:text(a.name,100),role:text(a.role,100),reference:text(a.reference,600),at:text(a.at,40),fingerprint:text(a.fingerprint,30)};}}
 p.story={title:text(s.title,200),parts:s.parts.slice(),limitations:text(s.limitations,2000),buyer:BUYERS[s.buyer]?s.buyer:'operations',audience:s.audience==='external'?'external':'internal',sourceRevision:Number.isSafeInteger(s.sourceRevision)?s.sourceRevision:0,revision:Number.isSafeInteger(s.revision)&&s.revision>0?s.revision:1,edited:!!s.edited,review:r};}
 p.audit=Array.isArray(o.audit)?o.audit.slice(0,50).map(x=>({at:text(x?.at,40),message:text(x?.message,250)})):[];
 if(importing){p.id=id();if(p.story)p.story.review={facts:null,permission:null};log(p,'Imported into this local workspace; all source inspections and approvals cleared');}
 if(p.story&&evidenceIssues(p).length)p.story.review={facts:null,permission:null};return p;
}
function validateState(raw){if(!raw||raw.schema!==4||!Array.isArray(raw.profiles)||!raw.profiles.length||raw.profiles.length>10)throw Error('Unsupported workspace file.');const seen=new Set();const s={schema:4,revision:Number.isSafeInteger(raw.revision)?raw.revision:0,activeProfile:text(raw.activeProfile,100),profiles:raw.profiles.map(o=>{if(!o||!text(o.name,100)||!Array.isArray(o.projects)||o.projects.length>50)throw Error('Invalid workspace profile.');const pid=text(o.id,100);if(!pid||seen.has(pid))throw Error('Duplicate or missing profile ID.');seen.add(pid);const proj=o.projects.map(v=>cleanProject(v));if(new Set(proj.map(p=>p.id)).size!==proj.length)throw Error('Duplicate project IDs.');return {id:pid,name:text(o.name,100),preferences:Array.isArray(o.preferences)?o.preferences.filter(v=>typeof v==='string').slice(0,10).map(v=>text(v,300)):[],projects:proj,lastProject:proj.some(p=>p.id===o.lastProject)?o.lastProject:proj[0]?.id||null};})};if(!s.profiles.some(p=>p.id===s.activeProfile))s.activeProfile=s.profiles[0].id;return s;}
function importBackup(raw){if(!raw||raw.format!=='atlas-workspace'||raw.schema!==4||!raw.profile||!Array.isArray(raw.profile.projects)||raw.profile.projects.length>50)throw Error('Select an ATLAS v4 workspace backup (.json).');const p=blankProfile(text(raw.profile.name,100)||'Imported workspace');p.projects=raw.profile.projects.map(x=>cleanProject(x,true));p.preferences=Array.isArray(raw.profile.preferences)?raw.profile.preferences.filter(v=>typeof v==='string').slice(0,10).map(v=>text(v,300)):[];p.lastProject=p.projects[0]?.id||null;return p;}
return {TOPICS,HEADINGS,BUYERS,STAGES,id,now,text,blankProfile,blankState,project,log,invalidate,challenge,metricIssues,metricDisplay,generate,evidenceIssues,ready,simpleHash,fingerprint,safeURL,cleanProject,validateState,importBackup,cleanReport,cleanValidation,requestValidation,recordValidation,validationEmail,cleanInterview,cleanLibraryLink,cleanQuality,cleanGapNotes,scrubReport,cleanDetails,fillDetails,cleanSheet,sheetFileName,sheetIssues,scrubPart1,sheetFromProject,mergeSheet,SHEET_EXEC,SHEET_SECTIONS,SHEET_LABELS,ENTITIES,TBD};
});
