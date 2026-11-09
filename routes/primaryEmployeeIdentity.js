import express from 'express';

// Unmounted first-stage self-identity route for a controlled future rollout.
// A signed staff session, canonical Timeclock lookup and independent Owner
// appointment check are all supplied by trusted backend adapters.
// No employee selector, factor enrollment, permission writer or PIN reset.
export function createPrimaryEmployeeIdentityRouter({
  identityDiscovery, enabled=false
}={}) {
  if(typeof identityDiscovery?.inspectIdentity!=='function')
    throw new TypeError('Trusted primary employee identity discovery required.');
  const router=express.Router();
  router.use((_req,res,next)=>{
    res.set({
      'Cache-Control':'no-store',
      'X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'no-referrer'
    });
    next();
  });
  router.get('/self', async(req,res)=>{
    if(enabled!==true)
      return res.status(503).json({error:'Primary employee identity checks are unavailable.'});
    try{
      const readiness=await identityDiscovery.inspectIdentity({context:req});
      // Serialize an explicit allowlist; never leak session bindings,
      // tokens, authenticator seeds, employee name or private roster data.
      return res.json({
        readOnly:true,
        employeeId:readiness.employeeId,
        canonicalTimeclockIdentityVerified:readiness.canonicalTimeclockIdentityVerified===true,
        independentlyAppointedOwner:readiness.independentlyAppointedOwner===true,
        nextGate:readiness.nextGate,
        enrollmentAuthorized:false
      });
    }catch(error){
      const status=error?.code==='HC_PRIMARY_IDENTITY_DENIED'?403:503;
      return res.status(status).json({
        error:status===403?'Employee verification required.':'Primary employee identity checks are unavailable.'
      });
    }
  });
  return router;
}
