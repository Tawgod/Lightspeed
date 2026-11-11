import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createSpecialOrdersRouter} from '../special-orders.js';
import {createStaffAccessBaseline} from '../services/security/staffAccessBaseline.js';
import {createCoreOperationsRouteAdmission} from '../services/security/coreOperationsRouteAdmission.js';

const key='fixture-only-legacy-key';
async function serve(router){
  const app=express();
  app.use('/api/special-orders',router);
  const server=await new Promise(resolve=>{
    const s=app.listen(0,'127.0.0.1',()=>resolve(s));
  });
  return {
    base:'http://127.0.0.1:'+server.address().port+'/api/special-orders',
    close:()=>{
      const closed=new Promise(resolve=>server.close(resolve));
      // All callers finish assertions first; avoid leaked idle loopback
      // fetch sockets holding up CI after the test server closes.
      server.closeAllConnections?.();
      return closed;
    }
  };
}
const legacyHeaders={'x-hobby-corner-key':key};

test('existing Special Orders behavior is untouched when the optional new guard is NOT supplied',async()=>{
  const web=await serve(createSpecialOrdersRouter({adminKey:key}));
  try{
    const health=await fetch(web.base+'/health');
    assert.equal(health.status,200);
    await health.text();
    const auth=await fetch(web.base+'/auth-check',{headers:legacyHeaders});
    assert.equal(auth.status,200);
    assert.equal((await auth.json()).authMode,'legacy_admin_key');
    const lookup=await fetch(web.base+'/orders',{headers:legacyHeaders});
    assert.equal(lookup.status,503); // existing requireDb boundary, not a new auth block
    await lookup.text();
  }finally{await web.close();}
});

test('explicit zero-approved-route guard denies main and nested business handlers but leaves health and session-check unchanged',async()=>{
  const gate=createCoreOperationsRouteAdmission();
  const web=await serve(createSpecialOrdersRouter({
    adminKey:key,coreOperationsAdmission:gate
  }));
  try{
    const health=await fetch(web.base+'/health');
    assert.equal(health.status,200);
    await health.text();
    const auth=await fetch(web.base+'/auth-check',{headers:legacyHeaders});
    assert.equal(auth.status,200);
    await auth.text();
    for(const [method,path] of [
      ['GET','/orders'],
      ['GET','/products/search?q=abc'],
      ['POST','/supplier-orders']
    ]){
      const result=await fetch(web.base+path,{method,headers:legacyHeaders});
      assert.equal(result.status,403,method+' '+path);
      assert.equal(result.headers.get('cache-control'),'no-store');
      assert.deepEqual(await result.json(),{error:'Core Operations permission required.'});
    }
  }finally{await web.close();}
});

test('explicit signed-employee route approval is checked independently of the legacy-key admission',async()=>{
  const NOW=Date.parse('2026-11-11T16:00:00Z');
  const staffAccess=createStaffAccessBaseline({
    now:()=>NOW,
    verifyEmployeeSession:async request=>{
      if(request.get('authorization')!=='Bearer fixture-signed-staff')throw Error('Invalid employee');
      return {id:'42',active:true};
    },
    verifyWorkstation:async request=>request.get('x-fixture-workstation')==='approved'
      ? {verified:true,deviceId:'store-terminal-1',expiresAtMs:NOW+60_000}:null,
    checkPermission:async ({operation})=>operation==='special-orders.read'
  });
  const gate=createCoreOperationsRouteAdmission({
    approvedRoutes:[{source:'special-orders.js',method:'GET',path:'/orders',
      audience:'employee',operation:'special-orders.read'}],
    staffAccess
  });
  const web=await serve(createSpecialOrdersRouter({
    adminKey:key,
    verifyEmployee:async request=>{
      if(request.get('authorization')!=='Bearer fixture-signed-staff')throw Error('Invalid employee');
      return {id:'42',active:true};
    },
    coreOperationsAdmission:gate
  }));
  try{
    const rejected=await fetch(web.base+'/orders',{headers:legacyHeaders});
    assert.equal(rejected.status,403);
    await rejected.text();
    const accepted=await fetch(web.base+'/orders',{headers:{
      authorization:'Bearer fixture-signed-staff',
      'x-fixture-workstation':'approved'
    }});
    // The separate auth gates passed, and only then requireDb denies (no DB
    // installed in these isolated tests). No Lightspeed/database call occurs.
    assert.equal(accepted.status,503);
    assert.match((await accepted.json()).error,/not configured/i);
  }finally{await web.close();}
});

test('router rejects malformed guard configuration instead of silently skipping protection',()=>{
  assert.throws(()=>createSpecialOrdersRouter({
    adminKey:key,coreOperationsAdmission:{authorize:async()=>true}
  }),TypeError);
});
