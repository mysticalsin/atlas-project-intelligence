/* Small, deterministic UI helpers. No network or authentication logic. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AtlasStudioCore=api;})(typeof window!=='undefined'?window:globalThis,function(){'use strict';
 function gatewayOrigin(value){
  if(typeof value!=='string'||value.length>2048)throw Error('Enter the application gateway address.');
  let u;try{u=new URL(value.trim());}catch{throw Error('Use a complete HTTPS address, or http://localhost:8080 for the local gateway.');}
  const local=['localhost','127.0.0.1','[::1]'].includes(u.hostname);
  if(u.protocol!=='https:'&&!(u.protocol==='http:'&&local))throw Error('Use HTTPS for a shared gateway. HTTP is allowed only on this computer.');
  if(u.username||u.password||u.search||u.hash)throw Error('Do not include credentials, tokens, query strings or fragments. Use the gateway origin only.');
  if(u.pathname&&u.pathname!=='/')throw Error('Use the application origin, not an API endpoint or file path.');
  return u.origin;
 }
 function previewFrame(elapsed){
  if(!Number.isFinite(elapsed)||elapsed<0)return{phase:'idle',name:'Idle',input:0,output:0,complete:false};
  if(elapsed>=16000)return{phase:'idle',name:'Finished',input:0,output:0,complete:true};
  if(elapsed<4500)return{phase:'listening',name:'Listening animation',input:.08+.055*Math.sin(elapsed/175)**2,output:0,complete:false};
  if(elapsed<10000)return{phase:'speaking',name:'Speaking animation',input:0,output:.04+.13*Math.sin(elapsed/123)**2,complete:false};
  if(elapsed<13000)return{phase:'muted',name:'Muted animation',input:0,output:0,complete:false};
  return{phase:'listening',name:'Listening animation',input:.10*Math.sin(elapsed/160)**2,output:0,complete:false};
 }
 
 function patternFrame(kind,elapsed){
  elapsed=Number.isFinite(elapsed)?Math.max(0,elapsed):0;
  if(!['idle','listening','speaking','muted','processing','connecting'].includes(kind))kind='idle';
  const x=(elapsed%12000)/1000;
  // A repeated phrase-like envelope, rather than random pulses. This is silent
  // animation input used only by the explicitly labelled visual preview.
  const hump=(a,b)=>x<a||x>b?0:Math.sin(Math.PI*(x-a)/(b-a))**2;
  const phrase=hump(.3,2.3)+hump(2.9,4.4)+hump(5.1,7.6)+hump(8.3,10.7);
  const input=kind==='listening'?.04+.13*phrase:0;
  const output=kind==='speaking'?.21*phrase*(.68+.32*Math.sin(x*11)**2):0;
  const name={idle:'Breathing animation',listening:'Listening animation',speaking:'Speaking animation',muted:'Muted animation',processing:'Preparing-notes animation',connecting:'Connecting animation'}[kind];
  return {phase:kind,name,input,output,complete:elapsed>=12000};
 }
return{gatewayOrigin,previewFrame,patternFrame};
});
