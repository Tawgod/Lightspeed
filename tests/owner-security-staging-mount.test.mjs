import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createOwnerSecurityStagingMount} from '../services/security/ownerSecurityStagingMount.js';

const ORIGIN='https://owner-security-stage.example.test';
const identity={verifyBoundEmployee:async()=>({id:'42',employeeId:'42',active:true})};
const canonical={authorize:async id=>({id,active:true,permissionSource:'timeclock_employee'})};
const always={reserve:async()=>true};
const sample=(overrides={})=>({
 environment:'test',enabled:true,expectedOwnerEmployeeId:'42',
 origin:ORIGIN,rpID:'owner-security-stage.example.test',
 staffAuthGateway:identity,timeclockIdentity:canonical,
 pool:{connect:async()=>({release(){},query:async()=>({rowCount:0})})},
 loginThrottle:always,signingSecret:'unit-test-only-long-signing-secret-not-live',
 totpEncryptionKey:'test',throttleHmacSecret:'test',
 approvalHmacSecret:'test',mfaSessionSecret:'test',
 loginRouter:express.Router(),
 createOwnerSetup:()=>({
  router:express.Router().get('/',(_req,res)=>res.json({page:'owner'})),
  passkeys:{
   beginRegistration:async()=>({}),finishRegistration:async()=>({registered:true}),
   beginAuthentication:async()=>({}),finishAuthentication:async()=>({token:'proof'}),
   verify:async()=>({verified:true,employeeId:'42',method:'passkey'})
  }
 }),
 createTotp:({verifyOwnerPasskey})=>{
  const router=express.Router();
  router.post('/api/test-proof',async(req,res)=>{
   const p=await verifyOwnerPasskey(req);
   res.json({verified:p.verified});
  });
  return {settingsRouter:router};
 },
 ...overrides
});
test('staging composition refuses production, synthetic 901, missing real signed identity or invalid origins',()=>{
 for(const overrides of [
  {environment:'production'},{enabled:false},
  {expectedOwnerEmployeeId:'901'},{expectedOwnerEmployeeId:'0'},
  {staffAuthGateway:null},{timeclockIdentity:null},{loginRouter:null},
  {origin:'http://owner-security-stage.example.test'},
  {origin:'https://owner-security-stage.example.test/extra'},
  {rpID:'example.test'},
  {pool:null}
 ])assert.throws(()=>createOwnerSecurityStagingMount(sample(overrides)),TypeError);
 assert.throws(()=>createOwnerSecurityStagingMount(sample({
  createOwnerSetup:()=>({router:express.Router(),passkeys:{}})
 })),TypeError,'no mocked credential verifier is accepted');
});
test('secure staging routes are composed under existing URLs and mutating cross-site requests fail closed',async()=>{
 const mount=createOwnerSecurityStagingMount(sample());
 const app=express();mount.mount(app);
 const server=await new Promise(resolve=>{
  const s=app.listen(0,'127.0.0.1',()=>resolve(s));
 });
 const base='http://127.0.0.1:'+server.address().port;
 try{
  const page=await fetch(base+'/owner-setup/');
  assert.equal(page.status,200);
  assert.deepEqual(await page.json(),{page:'owner'});
  const authAsset=await fetch(base+'/shared-ui/staff-auth.js');
  assert.equal(authAsset.status,200);
  const authScript=await authAsset.text();
  assert.match(authScript,/HCStaffAuth/);
  assert.doesNotMatch(authScript,/(?:sessionStorage|localStorage)\\.|hcSpecialOrdersKey/);
  assert.match(authScript,/pagehide/);
  const passkeyRequest=await fetch(base+'/staff-passkey/authentication/options',{
   method:'POST',headers:{
    'Content-Type':'application/json','Origin':ORIGIN,
    'Sec-Fetch-Site':'same-origin'
   },body:'{}'
  });
  assert.equal(passkeyRequest.status,200,'existing WebAuthn auth route shares the setup verifier');
  const send=headers=>fetch(base+'/staff-security/api/test-proof',{
   method:'POST',headers:{'Origin':ORIGIN,'Sec-Fetch-Site':'same-origin',...headers}
  });
  let result=await send({});
  assert.equal(result.status,200);
  assert.deepEqual(await result.json(),{verified:true});
  for(const headers of [
   {'Origin':'https://attacker.example'},
   {'Origin':''},
   {'Sec-Fetch-Site':'cross-site'},
   {'Sec-Fetch-Site':''}
  ]){
   result=await send(headers);
   assert.equal(result.status,403);
  }
  result=await fetch(base+'/staff-passkey/registration/options',{
   method:'POST',headers:{'Origin':'https://attacker.example',
    'Sec-Fetch-Site':'cross-site','Content-Type':'application/json'},body:'{}'
  });
  assert.equal(result.status,403);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
