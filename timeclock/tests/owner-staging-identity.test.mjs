import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createOwnerStageIdentityRouter} from '../ownerStagingIdentity.js';

const env = {
  OWNER_STAGING_IDENTITY_ENABLED:'true',
  OWNER_STAGING_EMPLOYEE_ID:'42',
  OWNER_STAGING_SERVICE_SECRET:'owner-stage-dedicated-secret-0123456789',
  OWNER_STAGING_THROTTLE_SECRET:'throttle-independent-secret-0123456789',
  SCANNER_SERVICE_SECRET:'scanner-existing-independent-secret-0123456789'
};
const employee = {id:42,name:'Fixture',active:true};
async function setup({environment=env, rows=[employee], reserve=async()=>true}={}) {
  const queries=[];
  const pool={
    connect: async()=>({query:async()=>({rowCount:1,rows:[{count:1}]}),release(){}}),
    async query(sql, params) {
      queries.push({sql,params});
      return {rowCount:rows.length,rows};
    }
  };
  const app=express();
  app.use(express.json());
  app.use('/api/timeclock/integrations/owner-staging',
    createOwnerStageIdentityRouter({
      pool,environment,reserve,pinHash:pin=>'hash:'+pin,
      permissions:async row=>({id:row.id,name:row.name,canLookup:true,
        canApprove:true,permissionSource:'timeclock_employee'})
    }));
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const url='http://127.0.0.1:'+server.address().port+
    '/api/timeclock/integrations/owner-staging/';
  async function post(path,body,secret=env.OWNER_STAGING_SERVICE_SECRET,extra={}) {
    const response=await fetch(url+path,{method:'POST',
      headers:{'Content-Type':'application/json',
        'x-owner-staging-service-secret':secret,...extra},
      body:JSON.stringify(body)});
    return {status:response.status,body:await response.json(),headers:response.headers};
  }
  return {post,queries,close:()=>new Promise(resolve=>server.close(resolve))};
}

test('dedicated credential, exact employee and strict PIN',async()=>{
  const s=await setup();
  try {
    assert.equal((await s.post('verify-pin',{pin:'1234'})).status,200);
    assert.deepEqual(s.queries[0].params,['42','hash:1234']);
    assert.equal((await s.post('verify-pin',{pin:'123'})).status,401);
    assert.equal((await s.post('verify-pin',{pin:1234})).status,401);
    assert.equal((await s.post('verify-pin',{pin:'1234'},env.SCANNER_SERVICE_SECRET)).status,403);
    assert.equal((await s.post('authorize',{employeeId:42})).status,200);
    assert.equal((await s.post('authorize',{employeeId:43})).status,403);
    assert.equal((await s.post('authorize',{employeeId:901})).status,403);
    assert.equal((await s.post('authorize',{employeeId:42},env.OWNER_STAGING_SERVICE_SECRET,
      {origin:'https://untrusted.example'})).status,403);
  } finally {await s.close();}
});
test('inactive or missing employee, throttling and failures deny',async()=>{
  const inactive=await setup({rows:[]});
  try {
    assert.equal((await inactive.post('verify-pin',{pin:'1234'})).status,401);
    assert.equal((await inactive.post('authorize',{employeeId:42})).status,403);
  }finally{await inactive.close();}
  const blocked=await setup({reserve:async()=>false});
  try {
    assert.equal((await blocked.post('verify-pin',{pin:'1234'})).status,429);
    assert.equal(blocked.queries.length,0);
  }finally{await blocked.close();}
  const dbDown=await setup({reserve:async()=>{throw Error('database offline');}});
  try {assert.equal((await dbDown.post('verify-pin',{pin:'1234'})).status,503);}
  finally{await dbDown.close();}
});
test('disabled, missing or reused credentials deny before database',async()=>{
  for(const environment of [
    {...env,OWNER_STAGING_IDENTITY_ENABLED:'false'},
    {...env,OWNER_STAGING_EMPLOYEE_ID:'901'},
    {...env,OWNER_STAGING_SERVICE_SECRET:env.SCANNER_SERVICE_SECRET},
    {...env,OWNER_STAGING_THROTTLE_SECRET:''},
    {...env,OWNER_STAGING_THROTTLE_SECRET:env.OWNER_STAGING_SERVICE_SECRET},
    {...env,OWNER_STAGING_THROTTLE_SECRET:env.SCANNER_SERVICE_SECRET}
  ]) {
    const s=await setup({environment});
    try {
      assert.equal((await s.post('verify-pin',{pin:'1234'})).status,403);
      assert.equal(s.queries.length,0);
    }finally{await s.close();}
  }
});
