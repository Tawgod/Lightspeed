import {readFile} from 'node:fs/promises';
import {createIsolatedFirstOwnerSetup} from './isolatedFirstOwnerSetup.js';
import {createOwnerPasskeyTotpEnrollmentCandidate} from './ownerPasskeyTotpEnrollmentCandidate.js';
import {createStaffPasskeyRouter} from '../../routes/staffPasskey.js';

// REVIEW-ONLY COMPOSITION. Never mounted by server.js or the existing
// synthetic Railway staging service. Uses a separately configured real
// Timeclock verifier only when that verifier is independently approved.
// The actual activation token is issued OUTSIDE this application.
const ID=/^[1-9][0-9]{0,17}$/;
const denied=()=>Object.assign(new Error('Strong Owner verification required.'),{status:403});
function crossSiteGuard(origin){
 return (req,res,next)=>{
  if(['GET','HEAD','OPTIONS'].includes(req.method))return next();
  if(req.get('origin')!==origin||req.get('sec-fetch-site')!=='same-origin')
   return res.status(403).json({error:'Same-origin security request required.'});
  next();
 };
}
export function createOwnerSecurityStagingMount({
 environment,enabled=false,expectedOwnerEmployeeId,loginRouter,
 staffAuthGateway,timeclockIdentity,pool,origin,rpID,signingSecret,
 loginThrottle,totpEncryptionKey,throttleHmacSecret,
 approvalHmacSecret,mfaSessionSecret,now=()=>Date.now(),webauthn,
 createOwnerSetup=createIsolatedFirstOwnerSetup,
 createTotp=createOwnerPasskeyTotpEnrollmentCandidate
}={}){
 const id=String(expectedOwnerEmployeeId??'');
 if(environment!=='test'||enabled!==true||!ID.test(id)||
    id==='901'||typeof loginRouter!=='function'||
    typeof staffAuthGateway?.verifyBoundEmployee!=='function'||
    typeof timeclockIdentity?.authorize!=='function'||
    typeof pool?.connect!=='function'||
    typeof loginThrottle?.reserve!=='function'||
    typeof createOwnerSetup!=='function'||typeof createTotp!=='function')
  throw new TypeError('Approved isolated staging, non-synthetic canonical Timeclock and verified adapters required.');
 let url;
 try{url=new URL(origin);}catch{throw new TypeError('Exact secure origin required.');}
 if(url.origin!==origin||url.protocol!=='https:'||url.pathname!=='/'||
   url.username||url.password||url.search||url.hash||
   rpID!==url.hostname)
  throw new TypeError('Approved HTTPS host and exact WebAuthn RP ID required.');
 // No independent identity issuer or self-appointment API.
 const setup=createOwnerSetup({
   environment,enabled,expectedOwnerEmployeeId:id,staffAuthGateway,
   timeclockIdentity,pool,origin,rpID,signingSecret,loginThrottle,now,webauthn
 });
 if(!setup?.router||!setup?.passkeys||
   ['beginAuthentication','finishAuthentication','verify'].some(
    k=>typeof setup.passkeys[k]!=='function'))
  throw new TypeError('A complete registered credential verifier is required.');
 const factor=createTotp({
   environment,enabled,expectedOwnerEmployeeId:id,staffAuthGateway,
   timeclockIdentity,pool,totpEncryptionKey,throttleHmacSecret,
   approvalHmacSecret,mfaSessionSecret,now,
   // This checks a backend-signed passkey proof against the canonical
   // employee session and stored non-revoked device generation.
   verifyOwnerPasskey:request=>setup.passkeys.verify({
     context:request,token:request.get('x-hc-passkey-proof')
   })
 });
 if(typeof factor?.settingsRouter!=='function')
  throw new TypeError('Existing encrypted Authenticator subsystem required.');
 const guard=crossSiteGuard(origin);
 function mount(app){
  if(typeof app?.use!=='function')throw new TypeError('Express app required.');
  // All security routes use the SAME canonical login adapter and Origin.
  app.use('/api/staff-auth',guard,loginRouter);
  app.use('/owner-setup',guard,setup.router);
  app.use('/staff-passkey',guard,createStaffPasskeyRouter({passkeys:{
   ...setup.passkeys,
   // The initial setup candidate never grants revocation/recovery.
   revoke:async()=>{throw denied();}
  }}));
  // Existing Employee Security Settings expects HCStaffAuth. Serve a
  // memory-only substitute at the same URL, never the general shared-ui
  // sessionStorage/legacy-key implementation.
  app.get('/shared-ui/staff-auth.js',async(_req,res)=>{
   res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
   try{
    const code=await readFile(new URL('../../owner-setup/memory-staff-auth.js',import.meta.url));
    return res.type('application/javascript').send(code);
   }catch{return res.sendStatus(503);}
  });
  app.use('/staff-security',guard,factor.settingsRouter);
 }
 return Object.freeze({mount});
}
