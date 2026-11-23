#!/usr/bin/env node
// Operator-only, staging-only one-shot Owner recovery launcher.
// Requires two nested exact-service Railway variable injections and a
// localhost-only SSH tunnel already verified by preflight-owner-ceremony.
// This launcher is not a web endpoint or CI job.
import {spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {pathToFileURL} from 'node:url';

const e=process.env;
const refuse=(reason)=>{console.error('HC_OWNER_ISSUANCE_BLOCKED: '+reason);process.exit(1)};
if(process.argv.length!==2||!process.stdin.isTTY||!process.stdout.isTTY)
 refuse('interactive local terminal required');
if(e.NODE_ENV!=='test'||e.HC_SECURITY_ENV!=='isolated-staging'||
   e.HC_OWNER_STAGING_ENABLED!=='true'||e.HC_OWNER_TIMECLOCK_EMPLOYEE_ID!=='1')
 refuse('isolated staging and canonical employee 1 required');
if(e.HC_OWNER_STAGING_ORIGIN!=='https://hc-owner-staging-staging.up.railway.app')
 refuse('unexpected HTTPS origin');
if(!e.HC_OWNER_OPERATOR_DB_PASSWORD||!e.HC_OWNER_TIMECLOCK_ORIGIN||
   !e.HC_OWNER_TIMECLOCK_SERVICE_SECRET)refuse('missing private credential');
if(e.HC_OWNER_OPERATOR_DATABASE_URL||e.HC_OWNER_OPERATOR_ACK||
   e.HC_OWNER_OPERATOR_RECOVERY_ACK)refuse('unexpected operator override');
const db=new URL('postgresql://hc_owner_stage_operator@127.0.0.1:15439/hc_owner_stage_test');
db.password=e.HC_OWNER_OPERATOR_DB_PASSWORD;
const label='HC-OwnerStage-20261123';
const args=['scripts/preflight-owner-ceremony.mjs'];
const preflight=spawnSync(process.execPath,args,{stdio:'inherit',env:e});
if(preflight.status!==0)refuse('combined live preflight failed; no recovery used');
try {
 const h=await fetch(e.HC_OWNER_STAGING_ORIGIN+'/health',{signal:AbortSignal.timeout(7000)});
 if(!h.ok||(await h.json())?.ready!==true)refuse('staging health not ready');
 const page=await fetch(e.HC_OWNER_STAGING_ORIGIN+'/owner-setup/',{signal:AbortSignal.timeout(7000)});
 if(!page.ok)refuse('Owner setup page unavailable');
} catch {refuse('staging HTTPS health/page check failed');}
console.log('Combined preflight and HTTPS setup page passed.');
console.log('RECOVERY IS ONE TIME ONLY. New activation expires in 10 minutes.');
console.log('Have your phone, passkey capability, and Timeclock PIN ready.');
const ui=createInterface({input:process.stdin,output:process.stdout});
let answer;
try {
 answer=await ui.question('Type ISSUE STAGING OWNER RECOVERY to consume the one-time recovery: ');
} finally {ui.close();}
if(answer!=='ISSUE STAGING OWNER RECOVERY')refuse('operator did not approve issuance');
console.log('Starting reviewed operator-only issuer. Confirm employee ID 1 when prompted.');
const childEnv={...e,
 HC_OWNER_OPERATOR_DATABASE_URL:db.toString(),
 HC_OWNER_OPERATOR_REF:label,
 HC_OWNER_OPERATOR_ACK:'I_VERIFIED_EMPLOYEE_ACCOUNT',
 HC_OWNER_OPERATOR_RECOVERY_ACK:'I_REVIEWED_EXPIRED_UNUSED_ACTIVATION'
};
const outcome=spawnSync(process.execPath,
 ['scripts/issue-owner-stage-activation.mjs','--reissue-expired-staging-owner'],
 {stdio:'inherit',env:childEnv});
db.password='';
if(outcome.error||outcome.status!==0)refuse('operator issuer returned failure; inspect private DB before retrying');
console.log('HC_OWNER_ISSUANCE_COMMAND_COMPLETED=true');
console.log('Complete Owner enrollment immediately at '+e.HC_OWNER_STAGING_ORIGIN+'/owner-setup/');
