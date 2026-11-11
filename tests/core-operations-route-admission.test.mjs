import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createStaffAccessBaseline } from '../services/security/staffAccessBaseline.js';
import { createCoreOperationsRouteAdmission } from '../services/security/coreOperationsRouteAdmission.js';

const NOW=Date.parse('2026-11-11T16:00:00Z');
const denied=error=>error?.status===403 && error.code==='HC_CORE_OPERATIONS_FORBIDDEN';
function req(method,path,headers={}) {
  return {
    method,path,headers,body:{role:'owner',employeeId:'42',serviceId:'bot'},
    hcAuth:{mode:'legacy_admin_key',employee:null},
    get(name){return headers[String(name).toLowerCase()];}
  };
}
function staffAccess({grants=new Set(['special-orders.read','special-orders.manage'])}={}) {
  return createStaffAccessBaseline({
    now:()=>NOW,
    verifyEmployeeSession:async request=>{
      if(request.get('authorization')!=='Bearer signed-staff')throw Error('Unsigned session');
      return {id:'42',active:true,clockedIn:false};
    },
    verifyWorkstation:async request=>request.get('x-fixture-proof')==='station'
      ? {verified:true,deviceId:'enrolled-fixture-01',expiresAtMs:NOW+60_000}:null,
    verifyStepUp:async request=>['passkey','totp'].includes(request.get('x-fixture-proof'))
      ? {verified:true,employeeId:'42',method:request.get('x-fixture-proof'),authenticatedAtMs:NOW-500}:null,
    checkPermission:async ({operation,identity})=>identity.id==='42'&&grants.has(operation)
  });
}
const readApproval={source:'special-orders.js',method:'GET',path:'/orders',
  audience:'employee',operation:'special-orders.read'};
const writeApproval={source:'special-orders.js',method:'POST',path:'/orders',
  audience:'employee',operation:'special-orders.manage'};
const serviceApproval={source:'special-orders.js',method:'POST',
  path:'/notifications/:id/claim-discord',audience:'service',
  operation:'service.notifications.claim-discord'};

test('zero approved routes: no legacy key, Owner role, employee claim, known path, or public health obtains permission',async()=>{
  const gate=createCoreOperationsRouteAdmission({staffAccess:staffAccess()});
  for(const [method,path] of [['GET','/orders'],['POST','/orders'],['GET','/health'],['POST','/notifications/10/claim-discord']]) {
    await assert.rejects(gate.authorize({request:req(method,path,{
      authorization:'Bearer signed-staff','x-fixture-proof':'passkey','x-hc-role':'owner'
    })}),denied,path);
  }
});

test('routine store read requires an independently verified station or MFA AND exact employee grant',async()=>{
  const gate=createCoreOperationsRouteAdmission({approvedRoutes:[readApproval],staffAccess:staffAccess()});
  const result=await gate.authorize({request:req('GET','/orders',{
    authorization:'Bearer signed-staff','x-fixture-proof':'station'
  })});
  assert.deepEqual({principal:result.principal,id:result.identityId,operation:result.operation},
    {principal:'employee',id:'42',operation:'special-orders.read'});
  for(const headers of [
    {'x-hc-role':'owner','x-fixture-proof':'station'},
    {authorization:'Bearer signed-staff','x-hc-role':'owner','x-trusted-device':'true'},
    {'x-hobby-corner-key':'legacy-key','x-fixture-proof':'station'}
  ]) {
    await assert.rejects(gate.authorize({request:req('GET','/orders',headers)}),denied);
  }
  const noGrant=createCoreOperationsRouteAdmission({
    approvedRoutes:[readApproval],staffAccess:staffAccess({grants:new Set()})
  });
  await assert.rejects(noGrant.authorize({request:req('GET','/orders',{
    authorization:'Bearer signed-staff','x-fixture-proof':'station'
  })}),denied);
});

test('protected staff write requires fresh, bound passkey and exact write grant, not workstation or TOTP',async()=>{
  const gate=createCoreOperationsRouteAdmission({
    approvedRoutes:[readApproval,writeApproval],staffAccess:staffAccess()
  });
  const base={authorization:'Bearer signed-staff'};
  await assert.rejects(gate.authorize({request:req('POST','/orders',{
    ...base,'x-fixture-proof':'station'
  })}),denied);
  await assert.rejects(gate.authorize({request:req('POST','/orders',{
    ...base,'x-fixture-proof':'totp'
  })}),denied);
  const granted=await gate.authorize({request:req('POST','/orders',{
    ...base,'x-fixture-proof':'passkey'
  })});
  assert.equal(granted.operation,'special-orders.manage');
  assert.equal(granted.assurance,'step-up');
  const onlyRead=createCoreOperationsRouteAdmission({
    approvedRoutes:[writeApproval],staffAccess:staffAccess({grants:new Set(['special-orders.read'])})
  });
  await assert.rejects(onlyRead.authorize({request:req('POST','/orders',{
    ...base,'x-fixture-proof':'passkey'
  })}),denied);
});

test('service action requires a separate validated machine credential plus exact backend service operation grant',async()=>{
  const seen=[];
  const gate=createCoreOperationsRouteAdmission({
    approvedRoutes:[serviceApproval],
    staffAccess:staffAccess(),
    verifyServiceRequest:async request=>request.get('x-fixture-service-credential')==='valid-signed-service'
      ? {type:'service',id:'gw-notifications',active:true}:null,
    checkServiceGrant:async ({identity,operation,route})=>{
      seen.push({id:identity.id,operation,path:route.path});
      return identity.id==='gw-notifications' &&
        operation==='service.notifications.claim-discord';
    }
  });
  await assert.rejects(gate.authorize({request:req('POST','/notifications/90/claim-discord',{
    'x-hc-service':'gw-notifications','x-hobby-corner-key':'legacy-key'
  })}),denied);
  const granted=await gate.authorize({request:req('POST','/notifications/90/claim-discord',{
    'x-fixture-service-credential':'valid-signed-service'
  })});
  assert.equal(granted.principal,'service');
  assert.equal(granted.identityId,'gw-notifications');
  assert.equal(granted.operation,'service.notifications.claim-discord');
  assert.deepEqual(seen,[{id:'gw-notifications',operation:'service.notifications.claim-discord',
    path:'/notifications/:id/claim-discord'}]);
  await assert.rejects(gate.authorize({request:req('GET','/orders',{
    'x-fixture-service-credential':'valid-signed-service'
  })}),denied);
  const noGrant=createCoreOperationsRouteAdmission({
    approvedRoutes:[serviceApproval],
    verifyServiceRequest:async()=>({type:'service',id:'gw-notifications',active:true}),
    checkServiceGrant:async()=>false
  });
  await assert.rejects(noGrant.authorize({request:req('POST','/notifications/90/claim-discord')}),denied);
});

test('bad configs, prototype paths, unreviewed routes, encoded URLs, and failing backends deny',async()=>{
  assert.throws(()=>createCoreOperationsRouteAdmission({approvedRoutes:[readApproval,readApproval]}),TypeError);
  assert.throws(()=>createCoreOperationsRouteAdmission({approvedRoutes:[{
    ...readApproval,path:'/not-a-real-route'
  }]}),TypeError);
  assert.throws(()=>createCoreOperationsRouteAdmission({approvedRoutes:[{
    ...readApproval,path:'/health'
  }]}),TypeError);
  assert.throws(()=>createCoreOperationsRouteAdmission({approvedRoutes:[{
    ...readApproval,operation:'admin.delegation.delete-all'
  }]}),TypeError);
  // Known administrative privileges must not be assignable to ordinary
  // feature routers either, even though the Admin catalog recognizes them.
  assert.throws(()=>createCoreOperationsRouteAdmission({approvedRoutes:[{
    ...readApproval,operation:'admin.delegation.manage'
  }]}),TypeError);
  assert.throws(()=>createCoreOperationsRouteAdmission({approvedRoutes:[{
    ...serviceApproval,operation:'special-orders.manage'
  }]}),TypeError);
  const gate=createCoreOperationsRouteAdmission({approvedRoutes:[readApproval],staffAccess:staffAccess()});
  for(const path of ['/orders%2fanything','/orders//','/orders/extra','/__proto__']) {
    await assert.rejects(gate.authorize({request:req('GET',path,{
      authorization:'Bearer signed-staff','x-fixture-proof':'station'
    })}),denied);
  }
  const broken=createCoreOperationsRouteAdmission({
    approvedRoutes:[serviceApproval],
    verifyServiceRequest:async()=>{throw Error('Service unavailable')},
    checkServiceGrant:async()=>true
  });
  await assert.rejects(broken.authorize({request:req('POST','/notifications/8/claim-discord')}),denied);
});

test('optional HTTP middleware rejects unauthorized calls BEFORE handlers, allowing only independent verified admission',async()=>{
  let invoked=0;
  const gate=createCoreOperationsRouteAdmission({
    approvedRoutes:[readApproval],staffAccess:staffAccess()
  });
  const app=express();
  app.use('/api/special-orders',gate.middleware);
  app.get('/api/special-orders/orders',(_req,res)=>{invoked++;res.json({ok:true})});
  app.post('/api/special-orders/orders',(_req,res)=>{invoked++;res.json({ok:true})});
  const server=await new Promise(resolve=>{
    const s=app.listen(0,'127.0.0.1',()=>resolve(s));
  });
  try{
    const url='http://127.0.0.1:'+server.address().port+'/api/special-orders/orders';
    const untrusted=await fetch(url,{headers:{
      authorization:'Bearer signed-staff','x-hc-role':'owner'
    }});
    assert.equal(untrusted.status,403);
    await untrusted.text();
    assert.equal(invoked,0);
    assert.equal(untrusted.headers.get('cache-control'),'no-store');
    const blockedWrite=await fetch(url,{method:'POST',headers:{
      authorization:'Bearer signed-staff','x-fixture-proof':'passkey'
    }});
    assert.equal(blockedWrite.status,403);
    await blockedWrite.text();
    assert.equal(invoked,0);
    const allowed=await fetch(url,{headers:{
      authorization:'Bearer signed-staff','x-fixture-proof':'station'
    }});
    assert.equal(allowed.status,200);
    assert.equal(invoked,1);
    assert.equal((await allowed.json()).ok,true);
  }finally{
    const closed=new Promise(resolve=>server.close(resolve));
    // Disposable loopback test only: never keep the CI job open on an idle
    // undici connection after completing our authorization assertions.
    server.closeAllConnections?.();
    await closed;
  }
});
