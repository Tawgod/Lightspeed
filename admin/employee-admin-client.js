(() => {
 'use strict';
 const $=id=>document.getElementById(id);
 const auth=()=>window.HCAdminAuth;
 let viewEpoch=0;
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
       [proof.factorType==='passkey'?'x-hc-passkey-proof':'x-hc-mfa-session']:proof.factorToken
     }
   });
   if(!response.ok)throw Error(response.status===403
     ? 'Administrator access denied. Verify your identity and permissions.'
     : 'Administrator settings are temporarily unavailable.');
   return response.json();
 }
 async function updateGrant(url,body){
   const proof=auth()?.getProof?.();
   if(!proof?.baseToken || !proof?.factorToken)throw Error('Administrator verification required.');
   const response=await fetch(url,{
     method:'POST',cache:'no-store',mode:'same-origin',credentials:'omit',
     headers:{
       Authorization:'Bearer '+proof.baseToken,
       [proof.factorType==='passkey'?'x-hc-passkey-proof':'x-hc-mfa-session']:proof.factorToken,
       'Content-Type':'application/json'
     },
     body:JSON.stringify(body)
   });
   if(!response.ok)throw Error(response.status===403
     ? 'Not authorized for this change. A fresh passkey and specific permission are required.'
     : 'Permission change was not applied. Recheck employee and connection.');
   return response.json();
 }
 function bindPermissionEditor(formId,url,extract){
   $(formId).addEventListener('submit',async event=>{
     event.preventDefault();
     const payload=extract();
     if(!/^[1-9][0-9]{0,17}$/.test(payload.targetEmployeeId)||
        typeof payload.reason!=='string'||payload.reason.trim().length<8){
       $('notification').textContent='Enter a valid employee ID and a reason of at least eight characters.';
       return;
     }
     const label=payload.operation||payload.toolOperation||payload.settingId;
     const action=payload.enabled?'grant':'revoke';
     if(typeof window.confirm==='function' &&
        !window.confirm('Confirm '+action+' '+label+' for employee '+payload.targetEmployeeId+'?'))return;
     $('notification').textContent='Submitting permission update…';
     try{
       await updateGrant(url,payload);
       $('notification').textContent='Permission update accepted by server. Changes are audited.';
     }catch(error){$('notification').textContent=error.message;}
   });
 }
 bindPermissionEditor('delegationForm','/employee-admin/api/admin-grants',()=>({
   targetEmployeeId:$('delegationEmployee').value.trim(),
   operation:$('delegationOperation').value,
   enabled:$('delegationEnabled').value==='true',
   reason:$('delegationReason').value.trim()
 }));
 bindPermissionEditor('settingScopeForm','/employee-admin/api/setting-scopes',()=>({
   targetEmployeeId:$('settingScopeEmployee').value.trim(),
   settingId:$('settingScopeId').value,
   enabled:$('settingScopeEnabled').value==='true',
   reason:$('settingScopeReason').value.trim()
 }));
 bindPermissionEditor('toolGrantForm','/employee-admin/api/employee-tool-grants',()=>({
   targetEmployeeId:$('toolEmployee').value.trim(),
   toolOperation:$('toolOperation').value,
   enabled:$('toolEnabled').value==='true',
   reason:$('toolReason').value.trim()
 }));
 // Request intake is not employee creation. Exactly the request status is
 // visible to its submitter; the manager cannot read the employee roster.
 let pendingOnboardingKey=null;
 async function loadOwnOnboarding(epoch){
   const response=await fetchAdmin('/employee-admin/api/onboarding/requests');
   if(epoch!==viewEpoch||document.hidden||!auth()?.getProof?.())return;
   if(response?.ownOnly!==true||!Array.isArray(response.items))throw Error('Invalid request list.');
   const list=$('onboardingRequestList');list.replaceChildren();
   for(const item of response.items){
     if(typeof item?.name!=='string'||typeof item?.status!=='string')continue;
     const row=make('div','','setting');
     row.append(make('strong',item.name),make('span',item.status,'status'));
     list.append(row);
   }
   $('onboardingMessage').textContent=response.items.length+
     ' request(s) submitted by your employee account.';
 }
 $('onboardingForm').addEventListener('submit',async event=>{
   event.preventDefault();
   if($('onboardingPanel').hidden)return;
   const name=$('onboardingName').value.trim(),reason=$('onboardingReason').value.trim();
   if(name.length<2||name.length>120||reason.length<8||reason.length>400){
     $('onboardingMessage').textContent='Enter a valid name and a reason of at least eight characters.';
     return;
   }
   if(!pendingOnboardingKey){
     if(typeof crypto?.randomUUID!=='function'){
       $('onboardingMessage').textContent='Secure request identifier unavailable.';
       return;
     }
     pendingOnboardingKey=crypto.randomUUID();
   }
   const payload={
     requestKey:pendingOnboardingKey,name,
     requestedRole:$('onboardingRole').value,reason
   };
   $('onboardingMessage').textContent='Submitting for review (no employee account created)…';
   try{
     await updateGrant('/employee-admin/api/onboarding/requests',payload);
     pendingOnboardingKey=null;
     $('onboardingName').value='';
     $('onboardingReason').value='';
     $('onboardingMessage').textContent='Request accepted for review. No employee account or PIN was created.';
     await loadOwnOnboarding(viewEpoch);
   }catch{
     $('onboardingMessage').textContent='Request was not confirmed. You may retry the same request without creating a duplicate.';
   }
 });
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
 async function loadDirectory(epoch){
   const response=await fetchAdmin('/employee-admin/api/employees');
   if(epoch!==viewEpoch||document.hidden||!auth()?.getProof?.())return;
   if(response?.source!=='timeclock'||response?.readOnly!==true||
      response?.scope!=='directory'||!Array.isArray(response.employees)||
      response.employees.length>5000)throw Error('Employee directory response was not recognized.');
   const list=$('employeeDirectoryList');list.replaceChildren();
   for(const employee of response.employees){
     if(!employee||typeof employee.id!=='string'||
        !/^[1-9][0-9]{0,17}$/.test(employee.id)||
        typeof employee.name!=='string'||typeof employee.active!=='boolean')continue;
     const row=make('div','','setting');
     const details=make('div','');
     details.append(make('strong',employee.name));
     details.append(make('small','Timeclock employee '+employee.id));
     row.append(details,make('span',employee.active?'Active':'Inactive','status'));
     list.append(row);
   }
   $('employeeDirectoryStatus').textContent=response.employees.length+' employee records available (minimum directory only).';
 }
 async function load(){
   const epoch=++viewEpoch;
   $('notification').textContent='Checking administrator access…';
   try {
     const overview=await fetchAdmin('/employee-admin/api/overview');
     const registry=await fetchAdmin('/employee-admin/api/settings');
     if(epoch!==viewEpoch || !auth()?.getProof?.() || document.hidden)return;
     if(!overview||typeof overview.employeeId!=='string' ||
        !Array.isArray(registry.items)||registry.readOnly!==true ||
        overview.configurationWritesEnabled!==false)throw Error('Unexpected administration service response.');
     if(!['owner','delegated_admin'].includes(overview.role))throw Error('Administrator role is unavailable.');
     $('identity').textContent=(overview.role==='owner'?'Owner':'Delegated administrator')+
       ' · '+overview.authMethod;
     $('gate').hidden=true;
     $('workspace').hidden=false;
     $('adminSignOut').hidden=false;
     showCards(overview.sectionAccess);
     $('ownerDelegationPanel').hidden=overview.role!=='owner' ||
       !overview.grantedOperations?.includes('admin.delegation.manage');
     $('toolGrantPanel').hidden=!overview.grantedOperations?.includes('permissions.manage');
     const onboardingAllowed=overview.grantedOperations?.includes('employees.onboard');
     $('onboardingPanel').hidden=!onboardingAllowed;
     if(onboardingAllowed){
       try{await loadOwnOnboarding(epoch);}
       catch{
         if(epoch!==viewEpoch)return;
         $('onboardingMessage').textContent='Onboarding requests are not connected or unavailable.';
       }
     }
     const directoryAllowed=overview.grantedOperations?.includes('employees.directory.read');
     $('employeeDirectoryPanel').hidden=!directoryAllowed;
     if(directoryAllowed){
       $('employeeDirectoryStatus').textContent='Loading permitted directory…';
       try{await loadDirectory(epoch);}
       catch(error){
         if(epoch!==viewEpoch)return;
         $('employeeDirectoryList').replaceChildren();
         $('employeeDirectoryStatus').textContent='Employee directory is unavailable. No records were loaded.';
       }
     }
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
   }catch(error){
     if(epoch!==viewEpoch)return;
     $('gate').hidden=false;
     $('workspace').hidden=true;
     $('notification').textContent='';
     const message=$('adminAuthMessage');
     if(message && auth()?.getProof?.())message.textContent=
       error?.message||'Administrator access could not be verified.';
   }
 }
 $('reload').addEventListener('click',load);
 window.addEventListener('hc-admin-authenticated',load);
 function hideProtectedView(){
   ++viewEpoch;
   $('gate').hidden=false;
   $('workspace').hidden=true;
   $('settingSummary').textContent='';
   $('settingsList').replaceChildren();
   $('sections').replaceChildren();
   $('identity').textContent='';
   $('ownerDelegationPanel').hidden=true;
   $('toolGrantPanel').hidden=true;
   $('onboardingPanel').hidden=true;
   $('onboardingRequestList').replaceChildren();
   pendingOnboardingKey=null;
   $('employeeDirectoryPanel').hidden=true;
   $('employeeDirectoryList').replaceChildren();
   $('employeeDirectoryStatus').textContent='Not connected.';
   $('notification').textContent='';
 }
 window.addEventListener('hc-admin-suspended',hideProtectedView);
 window.addEventListener('hc-admin-signed-out',hideProtectedView);
 if(auth()?.getProof)load();
})();
