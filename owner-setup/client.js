(() => {
 'use strict';
 const el=id=>document.getElementById(id);
 let signedToken=null,busy=false;
 const show=(message,error=false)=>{el('status').textContent=message;el('status').dataset.error=String(error);};
 const refresh=()=>{
  el('register').disabled=busy||!signedToken;
  el('signout').disabled=busy||!signedToken;
 };
 const bytes=value=>{
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value))throw Error('Invalid passkey challenge.');
  const data=atob(value.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(value.length/4)*4,'='));
  return Uint8Array.from(data,c=>c.charCodeAt(0));
 };
 const encoded=value=>{
  let out='';for(const n of new Uint8Array(value))out+=String.fromCharCode(n);
  return btoa(out).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 };
 const request=async(path,body,activation)=>{
  const res=await fetch(path,{
   method:'POST',mode:'same-origin',credentials:'omit',cache:'no-store',
   referrerPolicy:'no-referrer',headers:{
    'Content-Type':'application/json',
    ...(signedToken?{'Authorization':'Bearer '+signedToken}:{}),
    ...(activation?{'X-HC-Owner-Activation':activation}:{})
   },body:JSON.stringify(body)
  });
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw Error(res.status===403?'Setup authorization denied or expired.':
    data.error||'Owner setup temporarily unavailable.');
  return data;
 };
 const run=async task=>{
  if(busy)return;busy=true;refresh();
  try{await task();}catch(e){show(e?.message||'Setup could not be completed.',true);}
  finally{busy=false;refresh();}
 };
 const clear=()=>{
  signedToken=null;el('pin').value='';el('activation').value='';
  el('identity').textContent='Not signed in';refresh();
 };
 el('login').addEventListener('submit',event=>{
  event.preventDefault();run(async()=>{
   const pin=el('pin').value;el('pin').value='';
   if(!/^\d{4}$/.test(pin))throw Error('Enter your existing four-digit PIN.');
   const result=await request('/api/staff-auth/session',{pin});
   if(typeof result.token!=='string'||!result.employee?.id)
    throw Error('Signed Timeclock session unavailable.');
   signedToken=result.token;
   el('identity').textContent='Signed in as '+String(result.employee.name||'employee');
   show('Signed in. Your private activation code is also required.');
  });
 });
 el('register').addEventListener('click',()=>run(async()=>{
  if(!signedToken)throw Error('Sign in first.');
  if(!window.isSecureContext||!navigator.credentials?.create)
   throw Error('A secure browser with passkey support is required.');
  let activation=el('activation').value.trim();
  el('activation').value='';
  if(!/^[A-Za-z0-9_-]{43}$/.test(activation))
   throw Error('Enter the separate 32-byte one-time activation code.');
  try{
   const start=await request('./registration/options',{},activation);
   const options=start.options;
   if(!options?.challenge||!options?.user?.id)throw Error('Invalid WebAuthn response.');
   const credential=await navigator.credentials.create({publicKey:{
    ...options,challenge:bytes(options.challenge),
    user:{...options.user,id:bytes(options.user.id)},
    excludeCredentials:(options.excludeCredentials||[]).map(c=>({...c,id:bytes(c.id)}))
   }});
   if(!credential)throw Error('Passkey creation was cancelled.');
   const response={
    id:credential.id,rawId:encoded(credential.rawId),type:credential.type,
    response:{
     clientDataJSON:encoded(credential.response.clientDataJSON),
     attestationObject:encoded(credential.response.attestationObject),
     transports:typeof credential.response.getTransports==='function'
      ?credential.response.getTransports():[]
    },clientExtensionResults:credential.getClientExtensionResults()
   };
   const completed=await request('./registration/verify',{
    challengeId:start.challengeId,response
   },activation);
   if(completed.registered!==true)throw Error('Enrollment was not confirmed.');
   show('Owner passkey registered. Next: secure Admin Authenticator setup.');
   clear();
  }finally{activation=null;}
 }));
 el('signout').addEventListener('click',()=>{clear();show('Local sign-in and setup information cleared.');});
 window.addEventListener('pagehide',clear);
 refresh();
})();
