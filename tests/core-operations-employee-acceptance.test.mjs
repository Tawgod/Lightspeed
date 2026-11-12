import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {createStaffBoundSessionAdapter,createStaffSecurityAccessGate}
  from '../services/security/staffSecurityBridge.js';
import {createStaffMfaSessions} from '../services/security/staffMfaSessions.js';
import {createCoreOperationsRouteAdmission}
  from '../services/security/coreOperationsRouteAdmission.js';
import {CORE_OPERATIONS_PROVISIONAL_SCOPES}
  from '../services/security/coreOperationsProvisionalScopes.js';
import {createIsolatedStagingCoreAdmission}
  from '../services/security/coreOperationsStagingActivation.js';

// These HMAC keys and identities exist ONLY inside this short-lived Node test.
// They are not Timeclock sign-in, WebAuthn passkeys, production/staging grants,
// real staff records, browser credentials, or a public Railway login path.
const START=Date.parse('2026-11-12T22:00:00Z');
const FACTOR_GENERATION='a7fe1994-ae2e-4a8e-8dfa-ac35c02806e3';
const deny=e=>e?.code==='HC_CORE_OPERATIONS_FORBIDDEN'&&e?.status===403;

function fixture(){
  let instant=START;
  const keys=Object.fromEntries(['session','station','strong'].map(k=>[k,randomBytes(32)]));
  const active=new Set(['42','84']);
  const bindings=new Map([['42','fixture-session-42-generation-1'],['84','fixture-session-84-generation-1']]);
  const generations=new Map([['42',FACTOR_GENERATION],['84',FACTOR_GENERATION]]);
  const grants=new Map([['42',new Set()],['84',new Set()]]);
  const now=()=>instant;
  const seal=(key,claims)=>{
    const body=Buffer.from(JSON.stringify(claims)).toString('base64url');
    return body+'.'+createHmac('sha256',keys[key]).update(body).digest('base64url');
  };
  const verify=(key,token)=>{
    if(typeof token!=='string'||token.length>2048||
       !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))return null;
    const [body,signature]=token.split('.');
    const expected=createHmac('sha256',keys[key]).update(body).digest();
    const actual=Buffer.from(signature,'base64url');
    if(actual.length!==expected.length||!timingSafeEqual(expected,actual))return null;
    try{
      const claims=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
      return claims?.aud==='hc:fixture:'+key&&claims.exp>instant?claims:null;
    }catch{return null;}
  };
  const token=(key,claims)=>seal(key,{aud:'hc:fixture:'+key,exp:instant+60_000,...claims});
  const session=id=>token('session',{id,binding:bindings.get(id)});
  const station=id=>token('station',{id,binding:bindings.get(id),deviceId:'test-register-1'});
  const strong=id=>token('strong',{id,binding:bindings.get(id),method:'passkey',authenticatedAtMs:instant-500});
  const headers=(id,proof='none')=>{
    const values={authorization:'Bearer '+session(id),'x-hc-role':'owner',
      'x-hc-employee-id':'999','x-trusted-device':'true'};
    if(proof==='station')values['x-fixture-station']=station(id);
    if(proof==='passkey')values['x-fixture-strong']=strong(id);
    return values;
  };
  const request=(id,method,path,{proof='none',query={},body={}}={})=>{
    const values=headers(id,proof);
    return {method,path,query,body:{...body,role:'owner',employeeId:'999'},headers:values,
      get(name){return values[String(name).toLowerCase()];}};
  };
  const staffAuth={verifyBoundEmployee:async req=>{
    const bearer=req.get('authorization');
    const claims=verify('session',typeof bearer==='string'&&bearer.startsWith('Bearer ')
      ?bearer.slice(7):'');
    if(!claims||!active.has(claims.id)||bindings.get(claims.id)!==claims.binding)
      throw Error('Test-only revoked, inactive, or invalid employee session');
    return {id:claims.id,employeeId:claims.id,active:true,binding:claims.binding,
      expiresAtMs:claims.exp};
  }};
  const staffSession=createStaffBoundSessionAdapter({staffAuth,now});
  const mfa=createStaffMfaSessions({
    secret:randomBytes(48).toString('hex'),now,
    verifyBaseSession:staffSession.verifyBaseSession,
    totp:{
      verifyCode:async({context,code})=>{
        const base=await staffSession.verifyBaseSession(context);
        return code==='271828'?{verified:true,employeeId:base.employeeId,
          method:'totp',authenticatedAtMs:instant}:null;
      },
      getActiveGeneration:async({context})=>{
        const base=await staffSession.verifyBaseSession(context);
        return generations.get(base.employeeId);
      }
    }
  });
  const staffAccess=createStaffSecurityAccessGate({
    staffSession,mfa,now,
    verifyWorkstation:async(req,employee)=>{
      const claims=verify('station',req.get('x-fixture-station'));
      return claims?.id===employee.id&&claims.binding===bindings.get(employee.id)
        ?{verified:true,deviceId:claims.deviceId,expiresAtMs:claims.exp}:null;
    },
    verifyStrongStepUp:async(req,employee)=>{
      const claims=verify('strong',req.get('x-fixture-strong'));
      return claims?.id===employee.id&&claims.binding===bindings.get(employee.id)
        ?{verified:true,employeeId:claims.id,method:claims.method,
          authenticatedAtMs:claims.authenticatedAtMs}:null;
    },
    checkPermission:async({identity,operation})=>grants.get(identity.id)?.has(operation)===true
  });
  const authenticateTotp=async id=>mfa.authenticate({context:request(id,'GET','/orders'),
    code:'271828',sourceIp:'203.0.113.1'});
  return {
    request,headers,staffAccess,authenticateTotp,
    grant:(id,operation)=>grants.get(id).add(operation),
    revoke:(id,operation)=>grants.get(id).delete(operation),
    deactivate:id=>active.delete(id),
    invalidateSession:id=>bindings.set(id,bindings.get(id)+'-rotated'),
    rotateFactor:id=>generations.set(id,'e1cc1bb0-2081-4b1f-965c-158cc622be1e'),
    advance:ms=>{instant+=ms;}
  };
}
const approval=scope=>({source:scope.source,method:scope.method,path:scope.path,
  audience:'employee',operation:scope.operation,
  ...(scope.statusPolicy?{statusPolicy:scope.statusPolicy}:{}),
  ...(scope.bodyPolicy?{bodyPolicy:scope.bodyPolicy}:{}),
  ...(scope.queryPolicy?{queryPolicy:scope.queryPolicy}:{})});
const concretePath=path=>path.replace(/:[A-Za-z][A-Za-z0-9_]*/g,'77');
const candidateRequest=(f,scope,proof)=>f.request('42',scope.method,concretePath(scope.path),{
  proof,body:scope.statusPolicy?{status:'COMPLETED'}:
    scope.bodyPolicy?{sync_lightspeed:false}:{},query:{}
});

test('all 38 review-PENDING employee scopes can be exercised only as separately signed, exact-grant in-process fixtures',async()=>{
  assert.equal(CORE_OPERATIONS_PROVISIONAL_SCOPES.length,38);
  const f=fixture();
  const ticket=await f.authenticateTotp('42');
  for(const scope of CORE_OPERATIONS_PROVISIONAL_SCOPES){
    assert.equal(scope.review,'pending','Never treat the inventory as live policy');
    const gate=createCoreOperationsRouteAdmission({approvedRoutes:[approval(scope)],
      staffAccess:f.staffAccess});
    const correct=scope.assurance==='step-up'?'passkey':'station';
    const req=candidateRequest(f,scope,correct);
    await assert.rejects(gate.authorize({request:req}),deny,
      'No independently granted operation: '+scope.method+' '+scope.path);
    f.grant('42',scope.operation);
    const allowed=await gate.authorize({request:req});
    assert.equal(allowed.operation,scope.operation,scope.path);
    assert.equal(allowed.identityId,'42',scope.path);
    assert.equal(allowed.principal,'employee');
    assert.equal(allowed.assurance,scope.assurance==='step-up'?'step-up':'workstation');
    const noProof=candidateRequest(f,scope,'none');
    await assert.rejects(gate.authorize({request:noProof}),deny,scope.path);
    const totp=candidateRequest(f,scope,'none');
    totp.headers['x-hc-mfa-session']=ticket.token;
    if(scope.assurance==='step-up'){
      await assert.rejects(gate.authorize({request:candidateRequest(f,scope,'station')}),deny,scope.path);
      await assert.rejects(gate.authorize({request:totp}),deny,scope.path);
    }else{
      assert.equal((await gate.authorize({request:totp})).operation,scope.operation,scope.path);
    }
    f.revoke('42',scope.operation);
    await assert.rejects(gate.authorize({request:req}),deny,
      'Revoked grant must immediately deny '+scope.path);
  }
});

test('real MFA-session code binds signed TOTP to one employee, base session, factor generation and expiry',async()=>{
  const f=fixture();
  f.grant('42','special-orders.read');f.grant('84','special-orders.read');
  const gate=createCoreOperationsRouteAdmission({approvedRoutes:[{
    source:'special-orders.js',method:'GET',path:'/orders',audience:'employee',
    operation:'special-orders.read'}],staffAccess:f.staffAccess});
  const ticket=await f.authenticateTotp('42');
  const request=f.request('42','GET','/orders');
  request.headers['x-hc-mfa-session']=ticket.token;
  assert.equal((await gate.authorize({request})).assurance,'step-up');
  const other=f.request('84','GET','/orders');
  other.headers['x-hc-mfa-session']=ticket.token;
  await assert.rejects(gate.authorize({request:other}),deny,'Cross-employee TOTP replay');
  f.rotateFactor('42');
  await assert.rejects(gate.authorize({request}),deny,'TOTP factor revoked');
  const newTicket=await f.authenticateTotp('42');
  const newRequest=f.request('42','GET','/orders');
  newRequest.headers['x-hc-mfa-session']=newTicket.token;
  assert.equal((await gate.authorize({request:newRequest})).operation,'special-orders.read');
  f.invalidateSession('42');
  await assert.rejects(gate.authorize({request:newRequest}),deny,'Base session revoked');
  const fresh=f.request('42','GET','/orders',{proof:'station'});
  assert.equal((await gate.authorize({request:fresh})).assurance,'workstation');
  f.advance(61_000);
  await assert.rejects(gate.authorize({request:fresh}),deny,'Employee token expired');
});

test('signed station and step-up proofs do not transfer across employees; forged Owner claims never confer grants',async()=>{
  const f=fixture();
  f.grant('84','special-orders.read');f.grant('84','special-orders.create');
  const read={source:'special-orders.js',method:'GET',path:'/orders',
    audience:'employee',operation:'special-orders.read'};
  const write=CORE_OPERATIONS_PROVISIONAL_SCOPES.find(x=>x.path==='/orders'&&x.method==='POST');
  const gate=createCoreOperationsRouteAdmission({approvedRoutes:[read,approval(write)],staffAccess:f.staffAccess});
  const station=f.request('84','GET','/orders');
  station.headers['x-fixture-station']=f.headers('42','station')['x-fixture-station'];
  await assert.rejects(gate.authorize({request:station}),deny);
  const protectedRequest=f.request('84','POST','/orders');
  protectedRequest.headers['x-fixture-strong']=f.headers('42','passkey')['x-fixture-strong'];
  await assert.rejects(gate.authorize({request:protectedRequest}),deny);
  assert.equal((await gate.authorize({request:f.request('84','POST','/orders',{proof:'passkey'})})).operation,
    'special-orders.create');
  const ungranted=f.request('42','POST','/orders',{proof:'passkey'});
  await assert.rejects(gate.authorize({request:ungranted}),deny);
  f.deactivate('84');
  await assert.rejects(gate.authorize({request:f.request('84','POST','/orders',{proof:'passkey'})}),deny);
});

test('query, body and status switches demand their separate exact stronger grants, even for signed employees',async()=>{
  const f=fixture();
  const allocation={source:'special-orders.js',method:'GET',
    path:'/preorders/products/:id/allocation-suggestions',audience:'employee',
    operation:'special-orders.read',queryPolicy:'allocation-refresh-v1'};
  const profile=CORE_OPERATIONS_PROVISIONAL_SCOPES.find(x=>x.bodyPolicy==='customer-profile-sync-v1');
  const statusScope=CORE_OPERATIONS_PROVISIONAL_SCOPES.find(x=>x.statusPolicy==='locked-transition-v1');
  const gate=createCoreOperationsRouteAdmission({approvedRoutes:[allocation,approval(profile),approval(statusScope)],
    staffAccess:f.staffAccess});
  f.grant('42','special-orders.read');f.grant('42','customers.profile.write');
  f.grant('42','special-orders.status.progress');
  const allocationRead=f.request('42','GET','/preorders/products/77/allocation-suggestions',{proof:'station'});
  assert.equal((await gate.authorize({request:allocationRead})).operation,'special-orders.read');
  const refresh=f.request('42','GET','/preorders/products/77/allocation-suggestions',
    {proof:'passkey',query:{refresh_lightspeed:'1'}});
  await assert.rejects(gate.authorize({request:refresh}),deny,'Read grant cannot sync vendor');
  f.grant('42','special-orders.purchase-metrics.refresh');
  assert.equal((await gate.authorize({request:refresh})).operation,'special-orders.purchase-metrics.refresh');
  const ambiguous=f.request('42','GET','/preorders/products/77/allocation-suggestions',
    {proof:'passkey',query:{refresh_lightspeed:['1']}});
  await assert.rejects(gate.authorize({request:ambiguous}),deny);
  const local=f.request('42','PATCH','/customers/77/profile',
    {proof:'station',body:{sync_lightspeed:false}});
  assert.equal((await gate.authorize({request:local})).operation,'customers.profile.write');
  const live=f.request('42','PATCH','/customers/77/profile',
    {proof:'passkey',body:{sync_lightspeed:true}});
  await assert.rejects(gate.authorize({request:live}),deny,'Local profile grant cannot sync vendor');
  f.grant('42','customers.lightspeed.update');
  assert.equal((await gate.authorize({request:live})).operation,'customers.lightspeed.update');
  const malformed=f.request('42','PATCH','/customers/77/profile',
    {proof:'passkey',body:{sync_lightspeed:'true'}});
  await assert.rejects(gate.authorize({request:malformed}),deny);
  const routine=f.request('42','PATCH','/items/77/status',
    {proof:'station',body:{status:'READY_TO_ORDER'}});
  const progressed=await gate.authorize({request:routine});
  assert.equal(progressed.operation,'special-orders.status.progress');
  assert.equal(progressed.statusTarget,'READY_TO_ORDER');
  const cancel=f.request('42','PATCH','/items/77/status',
    {proof:'passkey',body:{status:'CANCELLED'}});
  await assert.rejects(gate.authorize({request:cancel}),deny);
  f.grant('42','special-orders.status.write');
  assert.equal((await gate.authorize({request:cancel})).operation,'special-orders.status.write');
});

test('the isolated Railway composition remains zero-grant even for a fully signed synthetic fixture',async()=>{
  const staging={NODE_ENV:'staging',HC_PUBLIC_BASE_PATH:'/HobbyCorner',
    DATABASE_URL:'postgres://disposable-fixture.invalid/test',
    SPECIAL_ORDERS_LIVE_MODE:'false',SPECIAL_ORDERS_ALLOW_MIGRATION:'false',
    SPECIAL_ORDERS_ALLOW_PRODUCT_WRITES:'false',SCANNER_ENABLED:'false',
    SCANNER_TEST_CREATION_ENABLED:'false',HC_ADMIN_NAV_ENABLED:'false',
    HC_CORE_SECURITY_STAGING_ENABLED:'true'};
  const guarded=createIsolatedStagingCoreAdmission({env:staging});
  const f=fixture();f.grant('42','special-orders.read');
  await assert.rejects(guarded.authorize({request:f.request('42','GET','/orders',{proof:'station'})}),deny);
  assert.equal(CORE_OPERATIONS_PROVISIONAL_SCOPES.every(s=>s.review==='pending'),true);
});
