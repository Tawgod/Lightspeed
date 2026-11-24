import test from 'node:test';
import assert from 'node:assert/strict';
import {commissionHcSecureCredentials as commission}
 from '../scripts/commission-hc-secure-db-credentials.mjs';
const env=()=>({
 RAILWAY_PROJECT_ID:'120de974-f2e8-46be-9a00-8eb8b1be4cc4',
 RAILWAY_ENVIRONMENT_ID:'8c8cd3a9-079f-4fe8-b8f5-a76c79813f0c',
 RAILWAY_SERVICE_NAME:'hc-secure-db-bootstrap-once',
 HC_SECURE_CREDENTIAL_COMMISSION_ONLY:'true',
 HC_SECURE_DB_MUTATION_APPROVED:'HC_SECURE_CREDENTIALS_ONLY',
 HC_SECURE_BOOTSTRAP_ROOT_URL:
  'postgresql://postgres:'+ 'A'.repeat(48)+'@hc-secure-postgres-staging.railway.internal:5432/railway',
 HC_SECURE_DB_RUNTIME_PASSWORD:'B'.repeat(48),
 HC_SECURE_DB_OPERATOR_PASSWORD:'C'.repeat(48)
});
const context={db:'hc_owner_stage_test',role:'postgres',version:180002,owners:0,activations:0};
function mockRoot({ctx=context,roles=2,stopAt='',sqlLog=[]}={}){
 return {
  connect:async()=>{},
  query:async sql=>{
   const s=String(sql);sqlLog.push(s);
   if(stopAt&&s.startsWith(stopAt))throw Error('injected failure');
   if(s.startsWith('SELECT current_database()'))return {rowCount:1,rows:[ctx]};
   if(s.startsWith('SELECT r.rolname'))return {rowCount:roles,rows:Array.from({length:roles},()=>({
    rolcanlogin:true,locked:true,rolsuper:false,rolcreatedb:false,
    rolcreaterole:false,rolreplication:false,rolbypassrls:false,rolinherit:true
   }))};
   if(s.startsWith('SELECT pg_has_role'))return {rowCount:1,rows:[{rr:true,ro:false,oo:true,orole:false}]};
   if(s.startsWith('SELECT rolname,rolpassword'))return {rowCount:2,rows:[{scram:true},{scram:true}]};
   return {rowCount:0,rows:[]};
  },
  end:async()=>{}
 };
}
test('wrong HC Secure environment prevents even opening DB client',async()=>{
 let created=false;
 await assert.rejects(commission({
  environment:{...env(),RAILWAY_PROJECT_ID:'original-owner'},
  createClient:()=>{created=true;throw Error('unsafe connection');}
 }),/blocked/);
 assert.equal(created,false);
});
test('existing Owner or activation blocks password changes and rolls back',async()=>{
 for(const ctx of [
  {...context,owners:1},{...context,activations:1},
  {...context,role:'hc_owner_stage_runtime'},
  {...context,db:'railway'}
 ]){
  const sqlLog=[];
  await assert.rejects(commission({
   environment:env(),createClient:()=>mockRoot({ctx,sqlLog})
  }),/blocked/);
  assert.equal(sqlLog.some(s=>s.startsWith('ALTER ROLE')),false);
  assert.ok(sqlLog.includes('ROLLBACK'));
 }
});
test('precondition failure from existing unlocked roles never rewrites password',async()=>{
 const sqlLog=[];
 await assert.rejects(commission({
  environment:env(),createClient:()=>mockRoot({roles:1,sqlLog})
 }),/blocked/);
 assert.equal(sqlLog.some(s=>s.startsWith('ALTER ROLE')),false);
 assert.ok(sqlLog.includes('ROLLBACK'));
});
test('failure after writing first password rolls back before commit',async()=>{
 const sqlLog=[];
 await assert.rejects(commission({
  environment:env(),createClient:()=>mockRoot({
   sqlLog,stopAt:'ALTER ROLE hc_owner_stage_operator PASSWORD'
  })
 }),/blocked/);
 assert.equal(sqlLog.filter(s=>s==='COMMIT').length,0);
 assert.ok(sqlLog.includes('ROLLBACK'));
});
test('post-commit role-login failure relocks both roles with a second transaction',async()=>{
 const sqlLog=[];const root=mockRoot({sqlLog});let calls=0;
 await assert.rejects(commission({
  environment:env(),
  createClient:()=>{calls++;if(calls===1)return root;return{
   connect:async()=>{throw Error('runtime unavailable');},
   end:async()=>{}
  };}
 }),/blocked/);
 assert.equal(sqlLog.filter(s=>s==='COMMIT').length,2);
 assert.ok(sqlLog.includes('ALTER ROLE hc_owner_stage_runtime PASSWORD NULL'));
 assert.ok(sqlLog.includes('ALTER ROLE hc_owner_stage_operator PASSWORD NULL'));
});
test('wrong-password network errors are NOT accepted as proof of denial',async()=>{
 const rootLog=[];const root=mockRoot({sqlLog:rootLog});let calls=0;
 const roleClient=role=>({
  connect:async()=>{if(role==='wrong')throw Object.assign(Error('network unreachable'),{code:'ECONNREFUSED'});},
  query:async sql=>({rowCount:1,rows:[{
   db:'hc_owner_stage_test',who:role,
   issue:role==='hc_owner_stage_operator',drop_approval:false,
   totp_read:role==='hc_owner_stage_runtime',
   consume:role==='hc_owner_stage_runtime'
  }]}),
  end:async()=>{}
 });
 let poolEnded=false;
 await assert.rejects(commission({
  environment:env(),
  createClient:()=>{calls++;return calls===1?root:calls===2?
   roleClient('hc_owner_stage_runtime'):calls===3?
   roleClient('hc_owner_stage_operator'):roleClient('wrong');},
  createPool:()=>({
   connect:async()=>({
    query:async()=>({rowCount:1,rows:[{
     runtime_role:'hc_owner_stage_runtime',
     ...Object.fromEntries(Array.from({length:9},(_,i)=>['t'+i,true])),
     can_issue:false,can_delete:false,can_change_digest:false,
     can_change_employee:false,can_change_expiry:false,
     can_consume:true,can_save_credential:true
    }]}),
    release:()=>{}
   }),
   end:async()=>{poolEnded=true;}
  })
 }),/blocked/);
 assert.equal(poolEnded,true);
 assert.ok(rootLog.includes('ALTER ROLE hc_owner_stage_runtime PASSWORD NULL'));
 assert.ok(rootLog.includes('ALTER ROLE hc_owner_stage_operator PASSWORD NULL'));
});
