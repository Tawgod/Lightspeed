import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {readFileSync} from 'node:fs';
import {coreOperationsAuditActor} from '../services/security/coreOperationsAuditActor.js';
import {createCoreOperationsRouteAdmission} from '../services/security/coreOperationsRouteAdmission.js';
import {createStaffAccessBaseline} from '../services/security/staffAccessBaseline.js';

const denied=error=>error?.status===403 &&
  error?.code==='HC_CORE_OPERATIONS_ACTOR_UNVERIFIED';

test('legacy router mode preserves existing string or null actor exactly as before',()=>{
  const request={body:{changed_by:'Unverified browser claim'}};
  assert.equal(coreOperationsAuditActor(request,request.body.changed_by),'Unverified browser claim');
  assert.equal(coreOperationsAuditActor(request,null),null);
  assert.equal(coreOperationsAuditActor(request,'ordering-web',{guardEnabled:false}),'ordering-web');
});

test('enabled guard overwrites browser Owner/name/changed_by with verified active employee identity',()=>{
  const request={
    body:{changed_by:'Owner',created_by:'another employee',reviewed_by:'manager'},
    headers:{'x-hc-role':'owner'},
    hcCoreOperationsAdmission:Object.freeze({
      principal:'employee',identityId:'42',
      operation:'special-orders.notes.write',assurance:'workstation'
    })
  };
  for(const claimed of ['Owner','another employee','manager','employee:999','']) {
    assert.equal(coreOperationsAuditActor(request,claimed,{guardEnabled:true}),'employee:42');
  }
});

test('enabled service actor must identify the verified machine principal, not client claims',()=>{
  const request={
    body:{changed_by:'Employee 999'},
    hcCoreOperationsAdmission:Object.freeze({
      principal:'service',identityId:'gw-notifications',
      operation:'service.notifications.claim-discord',assurance:'scoped-service'
    })
  };
  assert.equal(coreOperationsAuditActor(request,'Employee 999',{guardEnabled:true}),
    'service:gw-notifications');
});

test('missing, inactive or malformed server admission denies actor attribution fail-closed',()=>{
  for(const admission of [
    undefined,null,{}, {principal:'employee',identityId:'0<script>',
      operation:'special-orders.notes.write'},
    {principal:'employee',identityId:'42',operation:''},
    {principal:'employee',identityId:42,operation:'special-orders.notes.write'},
    {principal:'service',identityId:'bad service id',operation:'service.foo'},
    {principal:'owner',identityId:'42',operation:'special-orders.notes.write'}
  ]){
    assert.throws(()=>coreOperationsAuditActor({
      body:{changed_by:'owner'},hcCoreOperationsAdmission:admission
    },'owner',{guardEnabled:true}),denied);
  }
});

test('HTTP client headers and body do not set admission identity; only verified middleware does',async()=>{
  const NOW=Date.parse('2026-11-11T21:45:00Z');
  const staff=createStaffAccessBaseline({
    now:()=>NOW,
    verifyEmployeeSession:async req=>req.get('authorization')==='Bearer fixture-staff'
      ? {id:'42',active:true}:null,
    verifyWorkstation:async req=>req.get('x-fixture-proof')==='valid'
      ? {verified:true,deviceId:'registered-fixture',expiresAtMs:NOW+60_000}:null,
    checkPermission:async ({operation})=>operation==='special-orders.notes.write'
  });
  const admission=createCoreOperationsRouteAdmission({
    approvedRoutes:[{source:'special-orders.js',method:'PATCH',path:'/items/:id/notes',
      audience:'employee',operation:'special-orders.notes.write'}],
    staffAccess:staff
  });
  const app=express();app.use(express.json());
  // Match production's app.use('/api/special-orders', router) so the
  // authorization guard receives the relative /items/:id/notes path.
  const router=express.Router();
  router.patch('/items/:id/notes',
    admission.middleware,
    (req,res)=>res.json({
      actor:coreOperationsAuditActor(req,req.body?.changed_by,{guardEnabled:true})
    }));
  app.use('/api/special-orders',router);
  const server=await new Promise(resolve=>{
    const s=app.listen(0,'127.0.0.1',()=>resolve(s));
  });
  try{
    const url='http://127.0.0.1:'+server.address().port+'/api/special-orders/items/12/notes';
    const rejected=await fetch(url,{method:'PATCH',
      headers:{'Content-Type':'application/json','x-hc-role':'owner'},
      body:JSON.stringify({changed_by:'employee:1'})});
    assert.equal(rejected.status,403);
    await rejected.text();
    const allowed=await fetch(url,{method:'PATCH',
      headers:{'Content-Type':'application/json',
        authorization:'Bearer fixture-staff','x-fixture-proof':'valid'},
      body:JSON.stringify({changed_by:'employee:1'})});
    assert.equal(allowed.status,200);
    assert.deepEqual(await allowed.json(),{actor:'employee:42'});
  }finally{
    const closed=new Promise(resolve=>server.close(resolve));
    server.closeAllConnections?.();
    await closed;
  }
});

test('sensitive guarded actor sinks use server attribution, not body claims',()=>{
  const content=readFileSync(new URL('../special-orders.js',import.meta.url),'utf8');
  const required=[
    'auditActor(req, created_by)',
    'auditActor(req, item.created_by||null)',
    'auditActor(req, received_by)',
    'auditActor(req, req.body?.changed_by||null)',
    'auditActor(req, req.body?.changed_by || null)',
    "auditActor(req, req.body?.changed_by||'ordering-web')",
    "const changedBy=auditActor(req,",
    "const receivedBy=auditActor(req,",
    "const reviewedBy=auditActor(req,",
    'auditActor(req, body.gw_reviewed_by??null)',
    "auditActor(req,'discord-bot')"
  ];
  for(const expression of required){
    assert.ok(content.includes(expression),'Missing guarded audit actor at '+expression);
  }
  assert.ok(content.includes('coreOperationsAdmission != null'));
});
