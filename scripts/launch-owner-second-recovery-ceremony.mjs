#!/usr/bin/env node
// Private staging-only *second* recovery ceremony. Never in web service or CI.
// Requires exact DB/app Railway variable injection and 127.0.0.1:15439 SSH tunnel.
import pg from 'pg';
import {spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {createTimeclockScannerIdentity} from '../services/scannerTimeclockIdentity.js';

const e=process.env;
const fail=msg=>{console.error('HC_OWNER_SECOND_CEREMONY_BLOCKED: '+msg);process.exit(1)};
if(process.argv.length!==2||!process.stdin.isTTY||!process.stdout.isTTY)
 fail('private interactive TTY required');
if(e.NODE_ENV!=='test'||e.HC_SECURITY_ENV!=='isolated-staging'||
   e.HC_OWNER_STAGING_ENABLED!=='true'||e.HC_OWNER_TIMECLOCK_EMPLOYEE_ID!=='1'||
   e.HC_OWNER_STAGING_ORIGIN!=='https://hc-owner-staging-staging.up.railway.app')
 fail('scope guard failed');
if(!e.HC_OWNER_OPERATOR_DB_PASSWORD||!e.HC_OWNER_TIMECLOCK_ORIGIN||
   !e.HC_OWNER_TIMECLOCK_SERVICE_SECRET||e.HC_OWNER_OPERATOR_DATABASE_URL||
   e.HC_OWNER_OPERATOR_ACK||e.HC_OWNER_OPERATOR_SECOND_RECOVERY_ACK)
 fail('missing secret or unexpected environment override');
const db=new URL('postgresql://hc_owner_stage_operator@127.0.0.1:15439/hc_owner_stage_test');
db.password=e.HC_OWNER_OPERATOR_DB_PASSWORD;
const client=new pg.Client({connectionString:db.toString(),connectionTimeoutMillis:6000});
try {
 await client.connect();
 await client.query('SET default_transaction_read_only=on');
 const r=await client.query([
  "SELECT current_database()='hc_owner_stage_test' AS db,",
  "current_user='hc_owner_stage_operator' AS role,",
  "current_setting('transaction_read_only')='on' AS readonly,",
  "has_function_privilege(current_user,",
  "'public.hc_second_recover_expired_first_owner_activation(bigint,text,text)','EXECUTE') AS authorized,",
  "NOT has_column_privilege(current_user,'public.hc_first_owner_activations','activation_digest','UPDATE') AS no_raw_update,",
  "(SELECT count(*)=1 FROM public.hc_first_owner_activations a",
  " WHERE employee_id=1 AND consumed_at IS NULL AND credential_id IS NULL",
  " AND expires_at<clock_timestamp()) AS expired_unused,",
  "(SELECT count(*)=1 FROM public.hc_first_owner_activation_reissues) AS first_audit,",
  "NOT EXISTS(SELECT 1 FROM public.hc_first_owner_activation_second_recoveries) AS not_yet_issued,",
  // The restricted operator deliberately has no SELECT on passkeys/events.
  // The DB SECURITY DEFINER recovery function checks both under the same
  // transaction/lock before issuing anything. Do not grant operator access.
  "NOT EXISTS(SELECT 1 FROM public.hc_admin_principals) AS no_owners"
 ].join('\n'));
 if(r.rows.length!==1||Object.values(r.rows[0]).some(v=>v!==true))
  fail('restricted operator eligibility failed; no code issued');
} catch {fail('operator DB preflight failed; no code issued');}
finally {await client.end().catch(()=>{});}
let person;
try {
 const identity=createTimeclockScannerIdentity({
  baseUrl:e.HC_OWNER_TIMECLOCK_ORIGIN,
  serviceSecret:e.HC_OWNER_TIMECLOCK_SERVICE_SECRET,
  mode:'owner-staging'
 });
 person=await identity.authorize('1');
 if(String(person?.id)!=='1'||person?.permissionSource!=='timeclock_employee'||
    person?.canLookup!==true)throw Error();
} catch {fail('canonical Timeclock identity failed; no code issued');}
try {
 const h=await fetch(e.HC_OWNER_STAGING_ORIGIN+'/health',{signal:AbortSignal.timeout(7000)});
 if(!h.ok||(await h.json())?.ready!==true)throw Error();
 const p=await fetch(e.HC_OWNER_STAGING_ORIGIN+'/owner-setup/',{signal:AbortSignal.timeout(7000)});
 if(!p.ok)throw Error();
} catch {fail('deployed staging HTTPS setup unavailable; no code issued');}
console.log('HC_OWNER_SECOND_CEREMONY_PREFLIGHT_OK=true; NO_ACTIVATION_ISSUED=true');
console.log('Warning: this is the final audited staging recovery, expires after 10 minutes.');
console.log('Have your phone, browser and Timeclock PIN ready BEFORE confirming.');
const ui=createInterface({input:process.stdin,output:process.stdout});
let answer='';
try {
 answer=await ui.question('Type ISSUE SECOND OWNER STAGING KEY to authorize: ');
} finally {ui.close();}
if(answer!=='ISSUE SECOND OWNER STAGING KEY')fail('operator did not authorize issuance');
const env={...e,
 HC_OWNER_OPERATOR_DATABASE_URL:db.toString(),
 HC_OWNER_OPERATOR_REF:'HC-OwnerFinalRecovery-20261123',
 HC_OWNER_OPERATOR_ACK:'I_VERIFIED_EMPLOYEE_ACCOUNT',
 HC_OWNER_OPERATOR_SECOND_RECOVERY_ACK:'I_REVIEWED_SECOND_FAILED_ENROLLMENT_RECOVERY'
};
const child=spawnSync(process.execPath,
 ['scripts/issue-owner-stage-activation.mjs','--second-recover-expired-staging-owner'],
 {stdio:'inherit',env});
db.password='';
if(child.error||child.status!==0)
 fail('issuer failure or outcome uncertain; inspect read-only audit before retrying');
console.log('HC_OWNER_SECOND_KEY_ISSUANCE_COMPLETED=true');
console.log('Use code immediately at '+e.HC_OWNER_STAGING_ORIGIN+'/owner-setup/');
