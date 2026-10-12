// Backend-only bridge to Timeclock employee PINs and scanner permissions.
export function createTimeclockScannerIdentity({baseUrl,serviceSecret,fetchImpl=globalThis.fetch,timeoutMs=6000}={}){
  if(!baseUrl || !serviceSecret || serviceSecret.length<32)throw new Error('Scanner Timeclock integration not configured.');
  const root=new URL(baseUrl);
  if(!['https:','http:'].includes(root.protocol)||root.username||root.password||root.search||root.hash||root.pathname!=='/'){
    throw new Error('Invalid Timeclock service origin.');
  }
  if(root.protocol==='http:'&&!(/^(?:localhost|127\.0\.0\.1|\[::1\])$/.test(root.hostname)||root.hostname.endsWith('.railway.internal'))){
    throw new Error('Unencrypted Timeclock requests require a private service origin.');
  }
  async function request(endpoint,payload){
    const response=await fetchImpl(new URL(endpoint,root),{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),
      headers:{'Content-Type':'application/json','Accept':'application/json','x-scanner-service-secret':serviceSecret},
      body:JSON.stringify(payload)
    });
    if(!response.ok)throw Object.assign(new Error('Timeclock employee verification denied.'),{status:response.status===401?401:response.status===403?403:503});
    const data=await response.json();
    if(!data?.employee?.id || typeof data.employee.canLookup!=='boolean'||typeof data.employee.canApprove!=='boolean')throw new Error('Invalid Timeclock identity response.');
    return {id:data.employee.id,name:data.employee.name,canLookup:data.employee.canLookup,canApprove:data.employee.canApprove};
  }
  return {
    verifyPin:pin=>request('/api/timeclock/integrations/scanner/verify-pin',{pin}),
    authorize:employeeId=>request('/api/timeclock/integrations/scanner/authorize',{employeeId})
  };
}
