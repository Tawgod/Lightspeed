#!/usr/bin/env node
// Read-only state of staging first-Owner activation, never prints code or digest.
// Existing local-only PG tunnel plus Railway DB variable injection required.
import pg from 'pg';
const password=process.env.HC_OWNER_OPERATOR_DB_PASSWORD;
if(!password||process.env.HC_OWNER_OPERATOR_TUNNEL_CHECK!=='READ_ONLY') {
 console.error('HC_OWNER_ACTIVATION_STATE_BLOCKED: missing safe scope'); process.exit(1);
}
const c=new pg.Client({host:'127.0.0.1',port:15439,
 database:'hc_owner_stage_test',user:'hc_owner_stage_operator',
 password,ssl:false,connectionTimeoutMillis:6000,
 application_name:'hc-owner-read-only-activation-diagnosis'});
try {
 await c.connect();
 await c.query('SET default_transaction_read_only = on');
 const r=await c.query([
  'SELECT',
  "current_database()='hc_owner_stage_test' AS db_ok,",
  "current_user='hc_owner_stage_operator' AS role_ok,",
  "current_setting('transaction_read_only')='on' AS read_only,",
  '(SELECT count(*) FROM public.hc_first_owner_activations) AS grants,',
  '(SELECT count(*) FROM public.hc_first_owner_activation_reissues) AS reissues,',
  '(SELECT count(*) FROM public.hc_admin_principals) AS owners,',
  '(SELECT CASE',
  " WHEN count(*) <> 1 THEN 'COUNT_UNEXPECTED'",
  " WHEN bool_or(employee_id<>1) THEN 'EMPLOYEE_MISMATCH'",
  " WHEN bool_or(consumed_at IS NOT NULL OR credential_id IS NOT NULL) THEN 'CONSUMED'",
  " WHEN bool_or(expires_at <= clock_timestamp()) THEN 'EXPIRED_UNUSED'",
  " WHEN bool_or(approved_at > clock_timestamp()) THEN 'CLOCK_MISMATCH'",
  " ELSE 'ACTIVE_UNUSED' END",
  ' FROM public.hc_first_owner_activations) AS activation_state'
 ].join('\n'));
 if(r.rowCount!==1||!r.rows[0].db_ok||!r.rows[0].role_ok||!r.rows[0].read_only)
   throw Error('wrong identity');
 const x=r.rows[0];
 console.log('HC_OWNER_ACTIVATION_STATE='+x.activation_state);
 console.log('HC_OWNER_RECOVERY_RECORDS='+x.reissues);
 console.log('HC_OWNER_REGISTERED_OWNERS='+x.owners);
 console.log('READ_ONLY=true');
} catch {
 console.error('HC_OWNER_ACTIVATION_STATE_BLOCKED');process.exitCode=1;
} finally {await c.end().catch(()=>{});}
