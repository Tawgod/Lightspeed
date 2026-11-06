(() => {
 'use strict';
 const $=id=>document.getElementById(id);
 const auth=()=>window.HCAdminAuth;
 const sections=Object.freeze([
  {key:'employees',label:'Employees'},{key:'security',label:'Security'},
  {key:'devices',label:'Verified Computers'},{key:'timeclock',label:'Timeclock'},
  {key:'permissions',label:'Tool Permissions'},{key:'settings',label:'Tool Settings'},
  {key:'audit',label:'Audit'}
 ]);
 const make=(tag,text,cls='')=>{
   const node=document.createElement(tag);
   if(cls)node.className=cls;
   node.textContent=text;
   return node;
 };
 async function fetchAdmin(url) {
   const proof=auth()?.getProof?.();
   if(!proof || typeof proof.baseToken!=='string'||!proof.baseToken ||
      typeof proof.factorToken!=='string'||!proof.factorToken) {
     throw Error('Independent administrator verification is required.');
   }
   // The trusted backend must validate both claims and an exact admin grant.
   // Never persist, render, log or place credentials in URLs.
   const response=await fetch(url,{
     method:'GET',cache:'no-store',mode:'same-origin',credentials:'omit',
     headers:{
       Authorization:'Bearer '+proof.baseToken,
       'x-hc-mfa-session':proof.factorToken
     }
   });
   if(!response.ok)throw Error(response.status===403
     ? 'Administrator access denied. Verify your identity and permissions.'
     : 'Administrator settings are temporarily unavailable.');
   return response.json();
 }
 function showCards(sectionAccess){
   const container=$('sections');
   container.replaceChildren();
   for(const section of sections){
     if(sectionAccess?.[section.key]!==true)continue;
     const card=make('article','', 'tile');
     card.append(make('h3',section.label));
     card.append(make('p','Read-only overview; sensitive actions require fresh approval.'));
     container.append(card);
   }
 }
 async function load(){
   $('notification').textContent='Checking administrator access…';
   try {
     const overview=await fetchAdmin('/employee-admin/api/overview');
     const registry=await fetchAdmin('/employee-admin/api/settings');
     if(!overview||typeof overview.employeeId!=='string' ||
        !Array.isArray(registry.items)||registry.readOnly!==true ||
        overview.configurationWritesEnabled!==false)throw Error('Unexpected administration service response.');
     if(!['owner','delegated_admin'].includes(overview.role))throw Error('Administrator role is unavailable.');
     $('identity').textContent=(overview.role==='owner'?'Owner':'Delegated administrator')+
       ' · '+overview.authMethod;
     $('gate').hidden=true;
     $('workspace').hidden=false;
     showCards(overview.sectionAccess);
     const list=$('settingsList');list.replaceChildren();
     for(const item of registry.items){
       if(!item || typeof item.label!=='string' || typeof item.owner!=='string' ||
          typeof item.section!=='string' || typeof item.status!=='string')continue;
       const row=make('div','', 'setting');
       const details=make('div','');
       details.append(make('strong',item.label));
       details.append(make('small',item.section+' · '+item.owner));
       row.append(details,make('span',item.status,'status'));
       list.append(row);
     }
     $('settingSummary').textContent=String(registry.items.length)+' registered settings and configuration areas. Read-only until owners connect approved validators and audit flows.';
     $('notification').textContent='Settings metadata loaded. No employee information or configuration values were changed.';
   }catch{
     $('gate').hidden=false;
     $('workspace').hidden=true;
     $('notification').textContent='';
   }
 }
 $('reload').addEventListener('click',load);
 if(auth()?.getProof)load();
})();
