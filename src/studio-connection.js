/* Navigation helper only: live calls stay same-origin. No permissive CORS/null-origin bypass. */
(()=>{'use strict';
 const $=id=>document.getElementById(id);
 function validate(){const link=$('gatewayOpen');link.removeAttribute('href');link.setAttribute('aria-disabled','true');link.tabIndex=-1;let url;
  if(!$('gatewayAddress').value.trim()){$('gatewayInputError').textContent='';return;}
  try{url=AtlasStudioCore.gatewayOrigin($('gatewayAddress').value);$('gatewayInputError').textContent=$('gatewayTrusted').checked?'Opens '+url+' in a new tab.':'Confirm you trust '+url+' before opening it.';}
  catch(e){$('gatewayInputError').textContent=e.message;return;}
  if(!$('gatewayTrusted').checked)return;link.href=url;link.setAttribute('aria-disabled','false');link.tabIndex=0;
 }
 $('gatewayAddress').addEventListener('input',()=>{$('gatewayTrusted').checked=false;validate();});
 $('gatewayTrusted').addEventListener('change',validate);
 $('gatewayLocal').onclick=()=>{$('gatewayAddress').value='http://localhost:8080';$('gatewayTrusted').checked=false;validate();};
 $('gatewayOpen').addEventListener('click',e=>{if(e.currentTarget.getAttribute('aria-disabled')==='true'){e.preventDefault();return;}window.AtlasVoice.cancel('Opening the selected workspace. Microphone closed.');});
 validate();
})();
