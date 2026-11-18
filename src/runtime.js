/* The server's per-person facts (subjectKey, authMode, name) arrive as DATA, never as script: the Worker or gateway fills the
   <script type="application/json" id="atlas-runtime"> block (JSON with "<" escaped), and this reads it. An offline copy has the
   empty block, so window.ATLAS_RUNTIME stays undefined and the page behaves as before. */
(()=>{let r;try{const el=document.getElementById('atlas-runtime'),v=el?JSON.parse(el.textContent||'null'):null;
 if(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length)r=Object.freeze(v);}catch(e){r=undefined;}
window.ATLAS_RUNTIME=r;})();
