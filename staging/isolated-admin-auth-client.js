// Loaded ONLY by isolated synthetic-owner staging with explicit opt-in.
// Credentials remain in memory and are never placed in URLs or browser storage.
(() => {
 'use strict';
 const $=id=>document.getElementById(id);
 let base=null,factor=null,expiry=0,mode=null,busy=false,verificationEpoch=0;
 const clearFactor=()=>{verificationEpoch++;factor=null;expiry=0;mode=null;};
 const status=message=>{$('adminAuthMessage').textContent=message;};
 function update(){
  const signed=Boolean(base?.token);
  $('adminTestSignIn').hidden=signed;
  $('adminTestTotp').hidden=!signed;
  $('adminTestPasskey').hidden=!signed;
  $('adminSignOut').hidden=!signed;
 }
 function clear(){
  base=null;clearFactor();
  $('adminTestPin').value='';
  $('adminTestCode').value='';
  update();
  window.dispatchEvent(new Event('hc-admin-signed-out'));
 }
 async function call(url,{method='GET',body,additionalHeaders={}}={}){
  const response=await fetch(url,{
   method,mode:'same-origin',cache:'no-store',credentials:'omit',
   headers:{
    ...(base?.token?{Authorization:'Bearer '+base.token}:{}),
    ...(body===undefined?{}:{'Content-Type':'application/json'}),
    ...additionalHeaders
   },
   ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(response.status===429?'Too many attempts. Try later.':
   response.status===401||response.status===403
     ?'Employee session, factor or administration grant not accepted.'
     :'Security verification temporarily unavailable.');
  return data;
 }
 const b64bytes=value=>{
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value))throw Error('Invalid challenge.');
  const encoded=value.replace(/-/g,'+').replace(/_/g,'/');
  return Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length/4)*4,'=')),c=>c.charCodeAt(0));
 };
 const toB64=value=>{
  let bytes='';
  for(const byte of new Uint8Array(value))bytes+=String.fromCharCode(byte);
  return btoa(bytes).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 };
 async function verified(result,type,epoch){
  if(typeof result?.token!=='string'||result.token.length>2500||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.token)||
    !Number.isSafeInteger(result.expiresIn)||
    result.expiresIn<1||result.expiresIn>300)
   throw Error('Unrecognized verification proof.');
  if(epoch!==verificationEpoch||document.hidden)throw Error('Verification was cleared when the page was left.');
  factor=result.token;
  expiry=Date.now()+result.expiresIn*1000;
  mode=type;
  const current=getProof();
  if(!current)throw Error('Verification session could not be established.');
  // Only the server decides if proof and actor have actual admin access.
  status('Second factor verified; checking server-side administrator permission…');
  window.dispatchEvent(new Event('hc-admin-authenticated'));
 }
 const getProof=()=>{
  if(!base?.token||!factor||Date.now()>=expiry){clearFactor();return null;}
  return {baseToken:base.token,factorToken:factor,factorType:mode};
 };
 $('adminTestSignIn').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;
  const pin=$('adminTestPin').value;
  $('adminTestPin').value='';
  if(!/^\d{4}$/.test(pin)){status('Enter the four-digit synthetic staging PIN.');return;}
  busy=true;clearFactor();
  try{
   const data=await call('/api/staff-auth/session',{method:'POST',body:{pin}});
   if(String(data?.employee?.id)!=='901'||
      data.employee?.permissionSource!=='synthetic_staging_only'||
      typeof data.token!=='string'||data.token.length>2500)throw Error('Unexpected staging identity.');
   base={token:data.token};
   status('Synthetic test employee signed in. Independent factor verification is still required.');
  }catch{clear();status('Synthetic staging sign-in rejected.');}
  finally{busy=false;update();}
 });
 $('adminTestTotp').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;
  const code=$('adminTestCode').value.trim();$('adminTestCode').value='';
  if(!/^\d{6}$/.test(code)){status('Enter a valid six-digit code.');return;}
  busy=true;clearFactor();
  try{
   const epoch=verificationEpoch;
   const data=await call('/staff-security/api/mfa/session',{method:'POST',body:{code}});
   await verified(data,'totp',epoch);
  }catch{status('Authenticator verification was not accepted.');}
  finally{busy=false;update();}
 });
 $('adminTestPasskey').addEventListener('click',async()=>{
  if(busy||!base?.token)return;
  busy=true;clearFactor();
  try{
   if(!navigator.credentials?.get)throw Error('Passkeys unavailable.');
   const epoch=verificationEpoch;
   const {challengeId,options}=await call('/staff-passkey/authentication/options',{method:'POST',body:{}});
   const publicKey={
    ...options,challenge:b64bytes(options.challenge),
    allowCredentials:(options.allowCredentials||[]).map(item=>({...item,id:b64bytes(item.id)}))
   };
   const credential=await navigator.credentials.get({publicKey});
   if(!credential)throw Error('Passkey cancelled.');
   const response={
    id:credential.id,rawId:toB64(credential.rawId),type:credential.type,
    response:{
     clientDataJSON:toB64(credential.response.clientDataJSON),
     authenticatorData:toB64(credential.response.authenticatorData),
     signature:toB64(credential.response.signature),
     userHandle:credential.response.userHandle?toB64(credential.response.userHandle):null
    },
    clientExtensionResults:credential.getClientExtensionResults()
   };
   const data=await call('/staff-passkey/authentication/verify',{
    method:'POST',body:{challengeId,response}
   });
   await verified(data,'passkey',epoch);
  }catch{status('Passkey verification was not accepted.');}
  finally{busy=false;update();}
 });
 $('adminSignOut').addEventListener('click',()=>{clear();status('Signed out.');});
 document.addEventListener('visibilitychange',()=>{
  if(document.hidden){
   const wasVerified=Boolean(factor);
   clearFactor();
   $('adminTestCode').value='';
   status(wasVerified
    ?'Admin verification cleared when you left the page. Verify your Authenticator or passkey again.'
    :'Admin verification is not active. Verify again to open the dashboard.');
   window.dispatchEvent(new Event('hc-admin-signed-out'));
  } else if(base?.token&&!factor){
   status('Admin verification is not active. Use your Authenticator or passkey to return to the dashboard.');
  }
 });
 window.addEventListener('pagehide',clear);
 window.HCAdminAuth=Object.freeze({getProof});
 update();
})();