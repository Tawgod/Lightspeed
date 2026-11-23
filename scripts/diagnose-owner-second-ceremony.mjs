#!/usr/bin/env node
// Read-only, no-secret second-recovery ceremony diagnosis.
// Reads only Boolean eligibility and privilege flags, never digests or tokens.
import pg from 'pg';
const e=process.env;
if(e.HC_OWNER_OPERATOR_TUNNEL_CHECK!=='READ_ONLY'||!e.HC_OWNER_OPERATOR_DB_PASSWORD){
 console.error('HC_OWNER_SECOND_DIAG_BLOCKED=ENV');process.exit(1);
}
const c=new pg.Client({host:'127.0.0.1',port:15439,
 database:'hc_owner_stage_test',user:'hc_owner_stage_operator',
 password:e.HC_OWNER_OPERATOR_DB_PASSWORD,ssl:false,connectionTimeoutMillis:6000});
const cases=[
 ['identity',`SELECT current_database()='hc_owner_stage_test'
     AND current_user='hc_owner_stage_operator'
     AND current_setting('transaction_read_only')='on' AS ok`],
 ['second_function_exists',`SELECT to_regprocedure(
  'public.hc_second_recover_expired_first_owner_activation(bigint,text,text)')
  IS NOT NULL AS ok`],
 ['operator_execute',`SELECT COALESCE(has_function_privilege(current_user,
  to_regprocedure('public.hc_second_recover_expired_first_owner_activation(bigint,text,text)'),
  'EXECUTE'),false) AS ok`],
 ['no_direct_digest_update',`SELECT NOT has_column_privilege(current_user,
  'public.hc_first_owner_activations','activation_digest','UPDATE') AS ok`],
 ['expired_unused',`SELECT (SELECT count(*)=1 FROM public.hc_first_owner_activations
  WHERE employee_id=1 AND consumed_at IS NULL AND credential_id IS NULL
  AND expires_at<clock_timestamp()) AS ok`],
 ['first_audit_one',`SELECT (SELECT count(*)=1
  FROM public.hc_first_owner_activation_reissues) AS ok`],
 ['second_audit_table_exists',`SELECT
  to_regclass('public.hc_first_owner_activation_second_recoveries') IS NOT NULL AS ok`],
 ['second_audit_empty',`SELECT NOT EXISTS(
  SELECT 1 FROM public.hc_first_owner_activation_second_recoveries) AS ok`],
 ['zero_owners',`SELECT NOT EXISTS(
  SELECT 1 FROM public.hc_admin_principals) AS ok`],
 ['zero_passkeys',`SELECT NOT EXISTS(
  SELECT 1 FROM public.hc_staff_passkeys) AS ok`],
 ['zero_events',`SELECT NOT EXISTS(
  SELECT 1 FROM public.hc_first_owner_activation_events) AS ok`],
];
let all=true;
try {
 await c.connect();
 await c.query('SET default_transaction_read_only=on');
 for(const [name,sql] of cases){
  try{
   const r=await c.query(sql);
   const status=r.rowCount===1 && r.rows[0].ok===true?'PASS':'BLOCKED';
   if(status!=='PASS')all=false;
   console.log('HC_OWNER_SECOND_DIAG_'+name.toUpperCase()+'='+status);
  }catch(ex){
   all=false;
   const code=typeof ex?.code==='string' && /^[A-Z0-9]{5}$/.test(ex.code)
       ?ex.code:'UNKNOWN';
   console.log('HC_OWNER_SECOND_DIAG_'+name.toUpperCase()+'=ERROR_'+code);
  }
 }
} catch(ex){
 all=false;
 const code=typeof ex?.code==='string' && /^[A-Z0-9]{5}$/.test(ex.code)
  ?ex.code:'UNKNOWN';
 console.error('HC_OWNER_SECOND_DIAG_CONNECTION=ERROR_'+code);
}finally{await c.end().catch(()=>{});}
console.log('HC_OWNER_SECOND_DIAG_ALL_PASS='+all);
console.log('READ_ONLY=true; ACTIVATION_NOT_ISSUED=true');
if(!all)process.exitCode=1;
