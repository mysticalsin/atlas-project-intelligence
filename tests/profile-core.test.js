'use strict';
// WOW_ZERO_CONFIG §9 "App node tests": chips, form mapping, the model boundary and the DNA-export CSV reader.
const test=require('node:test'),assert=require('node:assert/strict'),C=require('../src/profile-core.js');
const P={email:'zelda@example.com',guessed:false,fields:{
 name:{value:'Zelda Quintero',from:'dna',at:'2026-09-01T10:00:00Z'},preferredName:null,
 title:{value:'Principal Zebra',from:'dna_export',at:'2026-08-15T09:00:00Z'},
 managerName:{value:'Sam Lead',from:'you',at:'2026-09-02T10:00:00Z'},managerEmail:{value:'sam@example.com',from:'you',at:'2026-09-02T10:00:00Z'}}};

test('chip labels: computed from the profile field versus the form value',()=>{
 assert.equal(C.chipFor(P.fields.name,'Zelda Quintero'),'from DNA');
 assert.equal(C.chipFor(P.fields.title,'Principal Zebra'),'from the DNA export (2026-08-15)');
 assert.equal(C.chipFor(P.fields.managerName,'Sam Lead'),'you edited');
 assert.equal(C.chipFor(P.fields.name,'Someone Else'),'you edited','a different value is the user\'s own');
 assert.equal(C.chipFor(P.fields.name,'  '),'','an empty value has no chip');
 assert.equal(C.chipFor(null,'Typed'),'you edited','no profile value: typed by the user');
 assert.equal(C.chipFor({value:'Tony Walteur',from:'guess'},'Tony Walteur'),'guessed from your email: please check');
 assert.equal(C.chipFor({value:'Tony Walteur',from:'signin'},'Tony Walteur'),'from your sign-in');
 assert.equal(C.sourceLabel('dna_export',''),'from the DNA export');});

test('profile to form mapping, and a guess is never a confirmed name',()=>{
 assert.deepEqual(C.formValues(P),{consultant:'Zelda Quintero',role:'Principal Zebra',managerName:'Sam Lead',managerEmail:'sam@example.com'});
 assert.equal(C.confirmedName(P),'Zelda Quintero');
 const g={fields:{name:{value:'Tony Walteur',from:'guess'}}};
 assert.equal(C.confirmedName(g),'');assert.equal(C.formValues(g).consultant,'Tony Walteur','the form shows it, labelled as a guess');
 for(const from of ['you','dna','dna_export','signin'])assert.equal(C.confirmedName({fields:{name:{value:'A B',from}}}),'A B');
 assert.deepEqual(C.formValues(null),{consultant:'',role:'',managerName:'',managerEmail:''});
 assert.equal(C.confirmedName({fields:{name:{value:'X',from:'hacker'}}}),'','unknown sources are ignored');});

test('roleFrom on submit: profile when equal to the title, you when different, blank when empty',()=>{
 assert.equal(C.roleFrom('Principal Zebra','Principal Zebra'),'profile');
 assert.equal(C.roleFrom('Data engineer','Principal Zebra'),'you');
 assert.equal(C.roleFrom('Data engineer',''),'you');
 assert.equal(C.roleFrom('',''),'');});

test('modelProject, flat shape: name blanked; role blanked only for roleFrom profile; client and the rest kept',()=>{
 const x={id:'p1',title:'Claims triage',consultant:'Zelda Quintero',role:'Principal Zebra',client:{name:'Zebracorp'},answers:['a'],sector:'Insurance'};
 const a=C.modelProject(x,'profile');
 assert.equal(a.consultant,'');assert.equal(a.role,'');assert.deepEqual(a.client,{name:'Zebracorp'});assert.deepEqual(a.answers,['a']);assert.equal(a.title,'Claims triage');assert.equal(a.sector,'Insurance');
 const b=C.modelProject(x,'you');assert.equal(b.consultant,'');assert.equal(b.role,'Principal Zebra');
 assert.equal(x.consultant,'Zelda Quintero','the input is not mutated');
 assert.doesNotMatch(JSON.stringify(a),/Zelda|Quintero|Principal Zebra/);});

test('modelProject, library payload shape: consultant.name blanked; consultant.role blanked only for profile; client kept',()=>{
 const x={title:'T',consultant:{name:'Zelda Quintero',role:'Principal Zebra'},client:{name:'Zebracorp',location:'Lyon',contact:''},answers:['x'],validation:{manager:{name:'Sam',email:'sam@example.com'}}};
 const a=C.modelProject(x,'profile');assert.deepEqual(a.consultant,{name:'',role:''});assert.equal(a.client.name,'Zebracorp');
 assert.doesNotMatch(JSON.stringify(a.consultant),/Zelda|Principal/);
 const b=C.modelProject(x,'');assert.deepEqual(b.consultant,{name:'',role:'Principal Zebra'});
 assert.equal(x.consultant.name,'Zelda Quintero');});

test('first name shown on screen: validated, at most two words, no digits or brackets',()=>{
 assert.equal(C.validFirstName('Tony'),'Tony');assert.equal(C.validFirstName('Jean-Marc'),'Jean-Marc');assert.equal(C.validFirstName('Anne Sophie'),'Anne Sophie');
 assert.equal(C.validFirstName('Éloïse'),'Éloïse');assert.equal(C.validFirstName("D'Arcy"),"D'Arcy");
 for(const bad of ['<system>','R2D2','Mary Ann Lou','','  ','(Tony)','a'.repeat(40)])assert.equal(C.validFirstName(bad),'',bad);});

test('CSV parser: BOM, semicolons, quotes with delimiters and newlines, CRLF',()=>{
 const t=C.parseCsv('﻿E-mail;Nom complet;Poste\r\n"jane@example.com";"Doe; Jane";"Lead ""data"""\r\nbob@example.com;Bob;"two\nlines"\r\n\r\n');
 assert.equal(t.delimiter,';');assert.deepEqual(t.header,['E-mail','Nom complet','Poste']);
 assert.deepEqual(t.rows,[['jane@example.com','Doe; Jane','Lead "data"'],['bob@example.com','Bob','two\nlines']]);
 assert.equal(C.parseCsv('a,b\n1,2').delimiter,',');assert.equal(C.parseCsv('a\tb\n1\t2').delimiter,'\t');
 assert.deepEqual(C.parseCsv('a,b\n1,2').rows,[['1','2']]);
 assert.throws(()=>C.parseCsv('email\n'+'x@example.com\n'.repeat(5),{maxRows:3}),/more than 3 rows/);});

test('header suggestions, French and English, approved fields only',()=>{
 const fr=C.suggestColumns(['Adresse e-mail','Nom complet','Prénom','Fonction','Responsable','Mail responsable','Salaire','Site']);
 assert.deepEqual(fr,{email:0,name:1,givenName:2,title:3,managerName:4,managerEmail:5});
 const en=C.suggestColumns(['Display name','First name','Job title','Email','Manager','Manager email','Date of birth']);
 assert.deepEqual(en,{email:3,name:0,givenName:1,title:2,managerName:4,managerEmail:5});
 const n1=C.suggestColumns(['courriel','N+1','N+1 mail','poste']);assert.equal(n1.email,0);assert.equal(n1.managerName,1);assert.equal(n1.managerEmail,2);assert.equal(n1.title,3);
 assert.deepEqual(C.suggestColumns(['Salaire','Date de naissance']),{email:-1,name:-1,givenName:-1,title:-1,managerName:-1,managerEmail:-1});});

test('column minimisation: Salaire, Date de naissance and Site never reach a row',()=>{
 const csv='Email;Nom complet;Prénom;Poste;Responsable;Mail responsable;Salaire;Date de naissance;Site\n'+
  'jane@example.com;Jane Doe;Jane;Data lead;Sam Lead;sam@example.com;85000;1980-02-03;Lyon\n'+
  'not-an-email;Nobody;;;;;90000;1970-01-01;Paris\n'+
  'BOB@EXAMPLE.COM;Bob Stone;;;;;70000;1990-05-06;Nantes\n';
 const t=C.parseCsv(csv),map=C.suggestColumns(t.header),{rows,lines,rejected}=C.directoryRows(t,map);
 assert.deepEqual(rows,[{email:'jane@example.com',name:'Jane Doe',givenName:'Jane',title:'Data lead',managerName:'Sam Lead',managerEmail:'sam@example.com'},{email:'bob@example.com',name:'Bob Stone'}]);
 for(const r of rows)for(const k of Object.keys(r))assert.ok(C.APPROVED.includes(k),k);
 const body=JSON.stringify(rows);for(const leak of ['85000','1980-02-03','Lyon','Nantes','90000','Salaire','Site'])assert.ok(!body.includes(leak),leak);
 assert.deepEqual(rejected,[{row:3,reason:'no valid email'}],'rejected rows by number only, never by value');assert.deepEqual(lines,[2,4],'each uploaded row keeps its spreadsheet row number');
 assert.throws(()=>C.directoryRows(t,{...map,email:-1}),/email column/);});

test('batches of at most 500, and a 32-hex batch id',()=>{
 const rows=Array.from({length:1201},(_,i)=>({email:'p'+i+'@example.com'}));
 assert.deepEqual(C.batches(rows).map(b=>b.length),[500,500,201]);assert.deepEqual(C.batches([]),[[]]);
 assert.match(C.randomBatchId(),/^[a-f0-9]{32}$/);assert.notEqual(C.randomBatchId(),C.randomBatchId());});
