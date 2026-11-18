/* ATLAS safe HTML rendering (v2.2 F1). The one escaping function, a tagged template and the only way markup reaches the DOM:
     setHTML(el, html`<b>${userText}</b>`)
   Every ${} in html`` is escaped unless it is already Safe (a nested html``) or an array (each item the same way, joined), so a
   forgotten esc() cannot happen. null, undefined and false print nothing. A plain string is never markup: setHTML throws on one.
   join(items, sep) is the same for a separator (items escaped, the separator text escaped).
   `trusted(s)` marks a string as trusted markup. It is for the output of a producer that is itself built with html``/esc (the SVG
   renderers), never for text that came from a person or the server; tests/safe-html-lint.test.js counts every use.
   Loaded first. UMD so node tests and the UMD cores (bids-core, charts, geo, intelligence-core) share this one esc. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AtlasSafe=api;})(typeof globalThis!=='undefined'?globalThis:this,()=>{
'use strict';
const MAP={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
class Safe{constructor(s){this.s=String(s);}toString(){return this.s;}}
const esc=v=>v instanceof Safe?v.s:String(v??'').replace(/[&<>"']/g,c=>MAP[c]);
const part=v=>Array.isArray(v)?v.map(part).join(''):v==null||v===false?'':esc(v);
const html=(strs,...vals)=>new Safe(strs.reduce((o,s,i)=>o+s+(i<vals.length?part(vals[i]):''),''));
const trusted=s=>s instanceof Safe?s:new Safe(s);
const join=(arr,sep='')=>new Safe(arr.map(part).join(esc(sep)));
const need=v=>{if(!(v instanceof Safe))throw new TypeError('Markup must be built with html`` (got '+typeof v+')');return v.s;};
// Trusted Types (CSP require-trusted-types-for 'script'; trusted-types atlas-html): the one policy, private to this file and reached only
// after need(), so only html``-built markup can become TrustedHTML. No createScript, no createScriptURL, no default policy.
const TT=(()=>{const t=typeof globalThis!=='undefined'?globalThis.trustedTypes:undefined;return t&&typeof t.createPolicy==='function'?t.createPolicy('atlas-html',{createHTML:s=>s}):null;})();
const markup=v=>{const s=need(v);return TT?TT.createHTML(s):s;};
const setHTML=(el,v)=>{el.innerHTML=markup(v);};
const insertHTML=(el,where,v)=>{el.insertAdjacentHTML(where,markup(v));};
return Object.freeze({esc,html,trusted,join,Safe,setHTML,insertHTML});
});
