/* AtlasPalette (v2.2 W3): the Cmd/Ctrl+K command palette and the "?" shortcut list.
   It only ever calls what a button on the page already does: go to a view, start a new project, start the interview, open Settings on a tab (Download my data opens the Privacy tab, it never downloads
   or deletes anything), open How it works. There is no destructive command here and none can be added by data: the list is fixed in this file. Everything shown is set as text.
   Both sheets are native modal dialogs, so the page behind is inert, Tab stays inside, Esc closes and focus returns to where it was. The palette is built once; opening it only shows it (the open time of the last
   use is kept in AtlasPalette.lastOpenMs for the test). The list is a listbox the input controls (aria-activedescendant); typing filters it; the arrow keys, Home, End and Enter drive it. "G" then C, P, S, L or B goes
   to a view. */
(()=>{'use strict';
const $=id=>document.getElementById(id),app=()=>window.ATLAS_APP;
const mac=/Mac|iPhone|iPad/.test((navigator.userAgentData&&navigator.userAgentData.platform)||navigator.platform||'');
const MOD=mac?'⌘':'Ctrl';
function h(tag,attrs={},...kids){const el=document.createElement(tag);for(const [k,v] of Object.entries(attrs||{})){if(v===null||v===undefined||v===false)continue;if(k==='text')el.textContent=v;else if(k.startsWith('on'))el.addEventListener(k.slice(2),v);else el.setAttribute(k,v===true?'':String(v));}
 for(const k of kids.flat())if(k!==null&&k!==undefined&&k!==false)el.append(k instanceof Node?k:document.createTextNode(String(k)));return el;}
const navBtn=v=>document.querySelector('.topbar nav [data-view="'+v+'"]');
const go=v=>()=>{const b=navBtn(v);if(b&&!b.hidden)b.click();else app()?.switchView?.(v);};
const settings=tab=>()=>{if(window.AtlasSettings?.open)window.AtlasSettings.open(tab);else app()?.open?.('profileDialog');};
const idle=()=>{const p=window.AtlasVoice?.status?.().phase;return !p||p==='idle'||p==='error';};
function startInterview(){go('interview')();setTimeout(()=>{const b=['voiceStart','voiceStartText'].map($).find(x=>x&&!x.hidden&&x.offsetParent&&!x.disabled);if(b)b.click();},60);}
// The fixed list. `when` hides a command that cannot work right now (Bids for a person without Bids, Start interview while one is running).
const COMMANDS=[
 {id:'go-interview',label:'Go to Conversation',hint:'G then C',words:'talk interview home',run:go('interview')},
 {id:'go-projects',label:'Go to Projects',hint:'G then P',words:'my projects experience',run:go('projects')},
 {id:'go-stories',label:'Go to Stories',hint:'G then S',words:'story draft case study',run:go('stories')},
 {id:'go-library',label:'Go to Library',hint:'G then L',words:'references shared reviews',run:go('library')},
 {id:'go-bids',label:'Go to Bids',hint:'G then B',words:'bid tender proof',run:go('bids'),when:()=>{const b=navBtn('bids');return !!b&&!b.hidden;}},
 {id:'new-project',label:'New project',words:'add create project',run:()=>{go('projects')();setTimeout(()=>app()?.newProject?.(),30);}},
 {id:'start-interview',label:'Start interview',words:'begin talk record conversation',run:startInterview,when:idle},
 {id:'open-settings',label:'Open settings',hint:MOD+' ,',words:'preferences profile account',run:settings('profile')},
 {id:'download-data',label:'Download my data',words:'export privacy gdpr copy',note:'Opens Privacy in Settings',run:settings('privacy')},
 {id:'backup',label:'Back up my workspace',words:'save export backup file',note:'Opens Workspace in Settings',run:settings('workspace')},
 {id:'how',label:'How it works',words:'help explain steps who sees',run:()=>app()?.open?.('howDialog')},
 {id:'shortcuts',label:'Keyboard shortcuts',hint:'?',words:'keys help',run:()=>openHelp()}];

let dlg=null,input=null,list=null,count=null,shown=[],active=0,opener=null;
function build(){if(dlg)return;
 input=h('input',{type:'text',id:'paletteInput',class:'palette-input',role:'combobox','aria-expanded':'true','aria-controls':'paletteList','aria-autocomplete':'list','aria-label':'Type a command',placeholder:'Type a command, for example: library',autocomplete:'off',spellcheck:'false',autocapitalize:'off',maxlength:'60'});
 list=h('ul',{id:'paletteList',class:'palette-list',role:'listbox','aria-label':'Commands'});
 count=h('p',{class:'sr',id:'paletteCount',role:'status','aria-live':'polite'});
 dlg=h('dialog',{id:'paletteDialog',class:'palette','aria-label':'Commands'},input,list,count,
  h('p',{class:'palette-foot'},h('span',{text:'Up and down to choose'}),h('span',{text:'Enter to run'}),h('span',{text:'Esc to close'})));
 document.body.append(dlg);
 input.addEventListener('input',()=>paint(input.value));
 input.addEventListener('keydown',e=>{
  if(e.key==='ArrowDown'){e.preventDefault();move(1);}else if(e.key==='ArrowUp'){e.preventDefault();move(-1);}
  else if(e.key==='Home'&&shown.length){e.preventDefault();pick(0);}else if(e.key==='End'&&shown.length){e.preventDefault();pick(shown.length-1);}
  else if(e.key==='Enter'){e.preventDefault();run(active);}});
 list.addEventListener('click',e=>{const li=e.target.closest('li[data-i]');if(li)run(Number(li.dataset.i));});
 list.addEventListener('pointermove',e=>{const li=e.target.closest('li[data-i]');if(li&&Number(li.dataset.i)!==active)pick(Number(li.dataset.i),false);});
 dlg.addEventListener('close',()=>{opener=null;});}
const score=(c,q)=>{if(!q)return 1;const hay=(c.label+' '+(c.words||'')).toLowerCase(),lab=c.label.toLowerCase();let s=0;for(const t of q.split(/\s+/).filter(Boolean)){const i=hay.indexOf(t);if(i<0)return 0;s+=lab.startsWith(t)?4:lab.includes(t)?3:2;}return s;};
function paint(q){const query=String(q||'').trim().toLowerCase();
 shown=COMMANDS.filter(c=>!c.when||c.when()).map(c=>[c,score(c,query)]).filter(x=>x[1]>0).sort((a,b)=>b[1]-a[1]).map(x=>x[0]);
 list.replaceChildren(...shown.map((c,i)=>h('li',{id:'pal-'+c.id,class:'palette-item',role:'option','aria-selected':'false','data-i':String(i)},h('span',{class:'palette-label',text:c.label}),c.note?h('span',{class:'palette-note',text:c.note}):null,c.hint?h('kbd',{class:'palette-hint',text:c.hint}):null)));
 if(!shown.length)list.append(h('li',{class:'palette-empty',role:'presentation',text:'Nothing matches. Try a place name, like Library.'}));
 count.textContent=shown.length?shown.length+(shown.length===1?' command':' commands'):'No commands match';
 active=0;pick(0,true);}
function pick(i,scroll=true){active=Math.max(0,Math.min(i,shown.length-1));[...list.querySelectorAll('li[data-i]')].forEach((li,k)=>{const on=k===active;li.setAttribute('aria-selected',on?'true':'false');li.classList.toggle('on',on);});
 const cur=shown[active];if(cur)input.setAttribute('aria-activedescendant','pal-'+cur.id);else input.removeAttribute('aria-activedescendant');
 if(scroll)list.querySelector('li.on')?.scrollIntoView({block:'nearest'});}
function move(d){if(shown.length)pick((active+d+shown.length)%shown.length);}
function run(i){const c=shown[i];if(!c)return;close();try{c.run();}catch(e){}}
function open(t0){build();if(dlg.open)return;opener=document.activeElement;input.value='';paint('');
 if(typeof t0!=='number')t0=performance.now();dlg.showModal();input.focus();
 requestAnimationFrame(()=>{api.lastOpenMs=Math.round((performance.now()-t0)*10)/10;});}
function close(){if(dlg?.open)dlg.close();}

// ---- the "?" list
let help=null;
const KEYS=[[MOD+' + K','Open this command palette'],['G then C, P, S, L, B','Go to Conversation, Projects, Stories, Library or Bids'],[MOD+' + ,','Open Settings'],['F','Focus mode, in the Conversation (when you are not typing)'],['Enter','Send your typed answer (Shift + Enter for a new line)'],['Esc','Close a sheet, or leave focus mode'],['?','Show this list']];
function openHelp(){if(!help){help=h('dialog',{id:'shortcutsDialog',class:'palette-help','aria-labelledby':'shortcutsTitle'},
  h('div',{class:'dialog-head'},h('div',{},h('p',{class:'eyebrow',text:'Keyboard'}),h('h2',{id:'shortcutsTitle',text:'Shortcuts'})),h('button',{class:'close','aria-label':'Close shortcuts','data-close':'',type:'button',text:'×'})),
  h('dl',{class:'palette-keys'},...KEYS.map(([k,d])=>h('div',{},h('dt',{},h('kbd',{text:k})),h('dd',{text:d})))),
  h('div',{class:'actions'},h('button',{class:'btn primary','data-close':'',type:'button',text:'Done'})));
  help.addEventListener('click',e=>{if(e.target.closest('[data-close]'))help.close();});document.body.append(help);}
 if(!help.open)help.showModal();}

// ---- the keys
let gAt=0;
const typing=t=>!!(t&&t.closest&&t.closest('input,textarea,select,[contenteditable=""],[contenteditable=true]'));
document.addEventListener('keydown',e=>{
 if((e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&(e.key==='k'||e.key==='K')){e.preventDefault();e.stopPropagation();if(dlg?.open)close();else open(e.timeStamp);return;}
 if(e.metaKey||e.ctrlKey||e.altKey||e.isComposing)return;
 if(typing(e.target)||document.querySelector('dialog[open]'))return;
 if(e.key==='?'){e.preventDefault();openHelp();return;}
 const k=e.key.toLowerCase();
 if(gAt&&Date.now()-gAt<1200){gAt=0;const to={c:'interview',p:'projects',s:'stories',l:'library',b:'bids'}[k];if(to){e.preventDefault();go(to)();}return;}
 if(k==='g'&&!e.shiftKey)gAt=Date.now();else gAt=0;},true);
$('paletteOpen')?.addEventListener('click',()=>open());
if($('paletteKeys'))$('paletteKeys').textContent=mac?'⌘K':'Ctrl K';
const api={open:()=>open(),close,help:openHelp,commands:()=>COMMANDS.map(c=>({id:c.id,label:c.label})),lastOpenMs:null};
window.AtlasPalette=api;
})();
