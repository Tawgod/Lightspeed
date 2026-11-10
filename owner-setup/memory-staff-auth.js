(() => {
 'use strict';
 // Isolated Owner security screens deliberately do NOT use shared-ui's
 // sessionStorage/legacy Lightspeed key fallback. A page refresh signs out.
 let session=null;
 function readSession(){
  if(!session||session.expiresAt<=Date.now()){session=null;return null;}
  return session;
 }
 const employee=()=>readSession()?.employee||null;
 const headers=extra=>{
  const current=readSession();
  return current?{...extra,Authorization:'Bearer '+current.token}:{...extra};
 };
 async function signIn(pin){
  const entered=String(pin??'');
  if(!/^\d{4}$/.test(entered))throw Error('Enter a four-digit Timeclock PIN.');
  const response=await fetch('/api/staff-auth/session',{
   method:'POST',mode:'same-origin',credentials:'omit',cache:'no-store',
   referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({pin:entered})
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error('Timeclock sign-in was not accepted.');
  if(typeof data?.token!=='string'||data.token.length>3000||
     !Number.isSafeInteger(data.expiresIn)||data.expiresIn<1||
     data.expiresIn>900||!data.employee?.id)
   throw Error('A valid signed Timeclock employee session is required.');
  session=Object.freeze({
   token:data.token,employee:data.employee,
   expiresAt:Date.now()+data.expiresIn*1000
  });
  return session;
 }
 async function verify(){
  const current=readSession();
  if(!current)return null;
  let response;
  try{
   response=await fetch('/api/staff-auth/session',{
    method:'GET',mode:'same-origin',credentials:'omit',cache:'no-store',
    referrerPolicy:'no-referrer',headers:headers()
   });
   if(!response.ok){session=null;return null;}
   const data=await response.json();
   if(data?.ok!==true||String(data.employee?.id)!==
     String(current.employee.id)){session=null;return null;}
   return current;
  }catch{session=null;return null;}
 }
 const signOut=()=>{session=null;};
 const failLegacy=()=>{throw Error('Legacy API keys are unavailable in Owner security.');};
 window.HCStaffAuth=Object.freeze({
  readSession,employee,headers,signIn,verify,signOut,
  setLegacyKey:failLegacy,legacyKey:()=>null
 });
 window.addEventListener('pagehide',signOut);
})();
