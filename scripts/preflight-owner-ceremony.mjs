#!/usr/bin/env node
// Combined read-only operator plus Timeclock preflight. Execute via two
// exact-service Railway variable injection calls, with localhost PG tunnel.
// Does not issue a token, print secrets, or write to any database.
import pg from 'pg';
import {createTimeclockScannerIdentity} from '../services/scannerTimeclockIdentity.js';

const e=process.env;
const report=(name,ok)=>console.log(name+'='+(ok?'PASS':'BLOCKED'));
const requirement={
  'NODE_ENV': 'test',
  'HC_SECURITY_ENV': 'isolated-staging',
  'HC_OWNER_STAGING_ENABLED': 'true',
  'HC_OWNER_TIMECLOCK_EMPLOYEE_ID': '1'
};
const configured=Object.entries(requirement).every(([k,v])=>e[k]===v)
 && typeof e.HC_OWNER_OPERATOR_DB_PASSWORD==='string'
 && e.HC_OWNER_OPERATOR_DB_PASSWORD.length>0
 && typeof e.HC_OWNER_TIMECLOCK_SERVICE_SECRET==='string'
 && e.HC_OWNER_TIMECLOCK_SERVICE_SECRET.length>=32
 && typeof e.HC_OWNER_TIMECLOCK_ORIGIN==='string'
 && e.HC_OWNER_TIMECLOCK_ORIGIN.length>0;
report('HC_OWNER_CEREMONY_ENV',configured);
report('HC_OWNER_CEREMONY_TTY',Boolean(process.stdin.isTTY&&process.stdout.isTTY));
if(!configured)process.exit(1);

let pgReady=false;
const client=new pg.Client({
 host:'127.0.0.1',port:15439,database:'hc_owner_stage_test',
 user:'hc_owner_stage_operator',password:e.HC_OWNER_OPERATOR_DB_PASSWORD,
 ssl:false,connectionTimeoutMillis:6000,
 application_name:'hc-owner-private-ceremony-preflight'
});
try {
 await client.connect();
 await client.query('SET default_transaction_read_only = on');
 const result=await client.query([
 "SELECT",
 " current_database()='hc_owner_stage_test' AS correct_db,",
 " current_user='hc_owner_stage_operator' AS restricted_role,",
 " has_function_privilege(current_user,",
 " 'public.hc_reissue_expired_first_owner_activation(bigint,text,text)','EXECUTE') AS can_reissue,",
 " NOT has_table_privilege(current_user,'public.hc_staff_totp','SELECT') AS no_totp,",
 " (SELECT count(*)=1 FROM public.hc_first_owner_activations) AS one_activation,",
 " EXISTS(SELECT 1 FROM public.hc_first_owner_activations WHERE employee_id=1",
 " AND expires_at<clock_timestamp() AND consumed_at IS NULL AND credential_id IS NULL) AS unused,",
 " NOT EXISTS(SELECT 1 FROM public.hc_first_owner_activation_reissues) AS no_prior_recovery,",
 " NOT EXISTS(SELECT 1 FROM public.hc_admin_principals) AS no_owner"
 ].join('\n'));
 pgReady=result.rows.length===1&&Object.values(result.rows[0]).every(v=>v===true);
} catch {} finally {await client.end().catch(()=>{});}
report('HC_OWNER_CEREMONY_OPERATOR_DB',pgReady);

let timeclockReady=false;
try {
 const identity=createTimeclockScannerIdentity({
   baseUrl:e.HC_OWNER_TIMECLOCK_ORIGIN,
   serviceSecret:e.HC_OWNER_TIMECLOCK_SERVICE_SECRET,
   mode:'owner-staging'
 });
 const p=await identity.authorize('1');
 timeclockReady=String(p?.id)==='1' &&
   p?.permissionSource==='timeclock_employee' && p?.canLookup===true;
} catch {}
report('HC_OWNER_CEREMONY_TIMECLOCK',timeclockReady);
if(!pgReady||!timeclockReady){process.exitCode=1;}
else console.log('HC_OWNER_CEREMONY_PREFLIGHT_OK=true; ACTIVATION_NOT_ISSUED=true');
