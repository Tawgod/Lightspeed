import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRuntimeScope,checkRuntime} from '../staging/hc-secure-runtime-readiness.js';
const env=()=>({
 RAILWAY_PROJECT_ID:'120de974-f2e8-46be-9a00-8eb8b1be4cc4',
 RAILWAY_ENVIRONMENT_ID:'8c8cd3a9-079f-4fe8-b8f5-a76c79813f0c',
 RAILWAY_SERVICE_NAME:'hc-secure-auth-staging',HC_SECURE_RUNTIME_READINESS_ONLY:'true',
 HC_OWNER_STAGING_ENABLED:'false',HC_STAGING_TEST_LOGIN_ENABLED:'false',HC_STAGING_PIN_SETUP_ENABLED:'false',
 HC_OWNER_STAGING_DATABASE_URL:'postgresql://hc_owner_stage_runtime:'+'A'.repeat(48)+'@hc-secure-postgres-staging.railway.internal:5432/hc_owner_stage_test'
});
test('exact private runtime scope accepted',()=>assert.equal(validateRuntimeScope(env()),env().HC_OWNER_STAGING_DATABASE_URL));
test('wrong scope, privileged secrets, or active authentication denied before connection',async()=>{
 for(const v of [{RAILWAY_PROJECT_ID:'original'},{RAILWAY_SERVICE_NAME:'hc-secure-db-bootstrap-once'},{HC_OWNER_STAGING_ENABLED:'true'},{HC_SECURE_BOOTSTRAP_ROOT_URL:'forbidden'},{HC_SECURE_DB_OPERATOR_PASSWORD:'forbidden'},{HC_OWNER_TIMECLOCK_SERVICE_SECRET:'forbidden'},{HC_SECURE_CREDENTIAL_COMMISSION_ONLY:'true'},{HC_OWNER_STAGING_DATABASE_URL:env().HC_OWNER_STAGING_DATABASE_URL.replace('hc_owner_stage_runtime','postgres')}]){
 let called=false;
 await assert.rejects(checkRuntime({environment:{...env(),...v},createClient:()=>{called=true;throw Error('unsafe')}}),/refused/);
 assert.equal(called,false);
 }
});
const context={db:'hc_owner_stage_test',role:'hc_owner_stage_runtime',version:180002,ro:'on',runtime:true,operator:false,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false};
function mock(log,ctx=context,override={}){
 return {connect:async()=>{},end:async()=>{},query:async q=>{
 log.push(q);
 if(q.startsWith('SELECT current_database'))return {rowCount:1,rows:[ctx]};
 if(q.startsWith('SELECT'))return {rowCount:1,rows:[{runtime_role:'hc_owner_stage_runtime',...Object.fromEntries(Array.from({length:9},(_,i)=>['t'+i,true])),can_issue:false,can_delete:false,can_change_digest:false,can_change_employee:false,can_change_expiry:false,can_consume:true,can_save_credential:true,...override}]};
 return {rowCount:0,rows:[]};
 }};
}
test('read-only transaction verifies schema and rolls back',async()=>{
 const log=[];assert.equal(await checkRuntime({environment:env(),createClient:()=>mock(log)}),true);
 assert.equal(log[0],'BEGIN READ ONLY');assert.equal(log.at(-1),'ROLLBACK');
 assert.equal(log.some(q=>/^(INSERT|UPDATE|DELETE|ALTER|CREATE|COMMIT)/.test(q)),false);
});
test('unexpected role attributes or activation issuance permission fail closed',async()=>{
 for(const [ctx,override] of [[{...context,operator:true},{}],[{...context,ro:'off'},{}],[context,{can_issue:true}]]){
 const log=[];await assert.rejects(checkRuntime({environment:env(),createClient:()=>mock(log,ctx,override)}),/refused/);
 assert.equal(log.at(-1),'ROLLBACK');
 }
});
