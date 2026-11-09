// Backend-only Timeclock roster reader for the shared admin portal.
// NEVER import this in browser code; the service secret must stay server-side.
// The target route is read-only and must not trigger Lightspeed roster sync.
export function createAdminTimeclockDirectoryReader({
 baseUrl,adminSecret,fetchImpl=globalThis.fetch,timeoutMs=5000
}={}){
 if(typeof baseUrl!=='string'||!baseUrl||typeof adminSecret!=='string'||
    adminSecret.length<24||typeof fetchImpl!=='function'||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<500||timeoutMs>10000)
  throw new TypeError('Private Timeclock roster service is not configured.');
 const url=new URL(baseUrl);
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password||
    url.search||url.hash||url.pathname!=='/'||
    (url.protocol==='http:'&&!(/^(?:localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)||
      url.hostname.endsWith('.railway.internal'))))
  throw new TypeError('Timeclock roster origin must be HTTPS or private service.');
 const endpoint=new URL('/api/timeclock/admin/employees/readonly',url);
 return async function readTimeclockEmployees(){
  let response;
  try{
   response=await fetchImpl(endpoint,{
    method:'GET',redirect:'error',cache:'no-store',
    signal:AbortSignal.timeout(timeoutMs),
    headers:{Accept:'application/json','x-timeclock-admin-secret':adminSecret}
   });
  }catch{throw new Error('Timeclock directory request failed.');}
  if(!response.ok)throw new Error('Timeclock directory unavailable.');
  const data=await response.json().catch(()=>null);
  if(data?.source!=='timeclock'||data.readOnly!==true||
    !Array.isArray(data.employees)||data.count!==data.employees.length)
   throw new Error('Invalid Timeclock directory response.');
  return data.employees;
 };
}
