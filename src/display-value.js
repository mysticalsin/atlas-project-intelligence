/* Display text for one record value.
   Strings and finite numbers are returned unchanged as text.
   A plain object with its own label (a string or a finite number) uses that label.
   Everything else is the neutral placeholder. This file does not touch the DOM. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AtlasDisplayValue=api;})(typeof globalThis!=='undefined'?globalThis:this,()=>{
'use strict';
const PLACEHOLDER='\u2014';
function displayValue(value){
  if(typeof value==='string')return value;
  if(typeof value==='number'&&Number.isFinite(value))return String(value);
  if(value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.prototype.hasOwnProperty.call(value,'label')){
    const label=value.label;
    if(typeof label==='string')return label;
    if(typeof label==='number'&&Number.isFinite(label))return String(label);
  }
  return PLACEHOLDER;
}
return Object.freeze({displayValue,PLACEHOLDER});
});
