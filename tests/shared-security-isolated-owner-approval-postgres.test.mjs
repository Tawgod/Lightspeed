import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createPostgresStaffEnrollmentApprovals} from '../services/security/staffEnrollmentApprovals.js';
import {createIsolatedOwnerApprovalPolicy} from '../staging/isolated-owner-approval-policy.js';

const url=process.env.HC_TEST_DATABASE_URL;
const guard={skip:!url?'Requires disposable hc_test PostgreSQL':false};
const TIME=Date.parse('2026-11-05T20:00:00Z');
const ORIGIN='https://staff-security-staging-test.up.railway.app';
const environment={
  NODE_ENV:'test',HC_SECURITY_ENV:'isolated-staging',
  HC_STAGING_TEST_OWNER_DISCORD_ID:'115626919134887940',
  HC_STAGING_TEST_GUILD_ID:'1485804234753573066',
  HC_STAGING_PUBLIC_ORIGIN:ORIGIN,HC_STAGING_PIN_STORE_MODE:'database',
  HC_STAGING_PIN_SETUP_ENABLED:'false',HC_STAGING_OWNER_PASSKEY_ENABLED:'true',
  HC_STAGING_OWNER_APPROVAL_ENABLED:'true'
};
function context({factor='pin',binding='owner-staging-901-signed-session-unique',origin=ORIGIN,method='passkey',age=1000}={}){
 return {
   employeeId:'901',binding,factor,method,age,
   get(name){return ({origin,'sec-fetch-site':'same-origin'})[name.toLowerCase()]||null}
 };
}
async function verifiedPasskey(ctx){
 if(ctx.factor!=='passkey')throw Error('Independent passkey unavailable');
 return {verified:true,method:ctx.method,id:'901',employeeId:'901',active:true,authenticatedAtMs:TIME-ctx.age};
}
test('real approval database requires independent Owner WebAuthn proof, exact operation and original signed session',guard,async()=>{
 if(!url.includes('hc_test'))throw Error('Refusing non-disposable database');
 const pool=new pg.Pool({connectionString:url,max:3});
 const policy=createIsolatedOwnerApprovalPolicy({environment,verifyOwnerPasskey:verifiedPasskey,now:()=>TIME});
 const service=createPostgresStaffEnrollmentApprovals({
   pool,secret:'test-only-session-bound-approval-key-owner-2026',
   now:()=>TIME,
   verifyEmployeeSession:async ctx=>ctx?.employeeId==='901'?{id:'901',active:true}:null,
   getSessionBinding:async ctx=>ctx.binding,
   verifyStrongApprover:async ctx=>{
     if(ctx.factor!=='passkey')return {id:'901',active:true,method:'pin',authenticatedAtMs:TIME};
     return {id:'901',active:true,method:ctx.method,authenticatedAtMs:TIME-ctx.age};
   },
   canApprove:policy.canApproveEnrollment,
   throttle:{reserve:async()=>true}
 });
 const employee=context(),verified=context({factor:'passkey'});
 const stale=context({factor:'passkey',age:300001});
 const forged=context({factor:'passkey',origin:'https://evil.example'});
 try{
   await pool.query(await readFile(new URL('../db/hc_staff_factor_approvals.sql',import.meta.url),'utf8'));
   const r=await service.request({context:employee,sourceIp:'127.0.0.1'});
   assert.equal(r.state,'requested');
   for(const manager of [employee,stale,forged,context({factor:'passkey',method:'totp'})])
     await assert.rejects(service.approve({context:manager,requestId:r.requestId}),
       e=>e.code==='HC_FACTOR_APPROVAL_DENIED');
   assert.equal((await service.status({context:employee})).state,'requested',
     'denied approvals must not change employee request');
   assert.equal((await service.approve({context:verified,requestId:r.requestId})).approved,true);
   const row=await pool.query(
     'SELECT state,approver_id,approver_method,session_hash FROM hc_staff_factor_approvals WHERE request_id=$1',
     [r.requestId]);
   assert.equal(row.rows[0].state,'approved');
   assert.equal(row.rows[0].approver_id,'901');
   assert.equal(row.rows[0].approver_method,'passkey');
   assert.match(row.rows[0].session_hash,/^[a-f0-9]{64}$/);
   await assert.rejects(service.start({context:context({binding:'forged-signed-session-other-employee'})}),
     e=>e.code==='HC_FACTOR_APPROVAL_DENIED');
   assert.equal(await service.start({context:employee}),true);
   assert.equal(await service.allowConfirmation({context:employee}),true);
   assert.equal(await service.allowConfirmation({context:context({binding:'forged-signed-session-other-employee'})}),false);
   assert.equal(await service.finish({context:employee}),true);
   assert.equal(await policy.canRecoverFactor(),false);
   assert.equal(await policy.canResetFactor(),false);
 }finally{await pool.end();}
});
