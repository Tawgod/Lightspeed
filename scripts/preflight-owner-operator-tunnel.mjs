#!/usr/bin/env node
// Read-only operator preflight through a local-only SSH tunnel.
// Railway run injects HC_OWNER_OPERATOR_DB_PASSWORD from the isolated DB
// service into this process. No app runtime, no superuser connection, no writes.
import pg from 'pg';

const refuse=()=>{throw Error('HC_OWNER_OPERATOR_TUNNEL_PREFLIGHT_BLOCKED')};
const password=process.env.HC_OWNER_OPERATOR_DB_PASSWORD;
if(!password||process.env.HC_OWNER_OPERATOR_TUNNEL_CHECK!=='READ_ONLY')refuse();

const client=new pg.Client({
  host:'127.0.0.1',port:15439,
  database:'hc_owner_stage_test',
  user:'hc_owner_stage_operator',
  password,
  ssl:false,
  connectionTimeoutMillis:6000,
  application_name:'hc-owner-staging-operator-preflight'
});
try {
 await client.connect();
 await client.query('SET default_transaction_read_only = on');
 const sql=[
 'SELECT',
 " current_database()='hc_owner_stage_test' AS exact_db,",
 " current_user='hc_owner_stage_operator' AS exact_role,",
 " current_setting('transaction_read_only')='on' AS read_only,",
 " has_function_privilege(current_user,",
 "   'public.hc_reissue_expired_first_owner_activation(bigint,text,text)',",
 "   'EXECUTE') AS can_reissue,",
 " NOT has_table_privilege(current_user,",
 "   'public.hc_staff_totp','SELECT') AS no_totp_access,",
 " NOT has_table_privilege(current_user,",
 "   'public.hc_admin_principals','INSERT') AS no_owner_creation,",
 " NOT has_column_privilege(current_user,",
 "   'public.hc_first_owner_activations','activation_digest','UPDATE') AS no_raw_update,",
 " (SELECT count(*)=1 FROM public.hc_first_owner_activations) AS one_activation,",
 " EXISTS(SELECT 1 FROM public.hc_first_owner_activations",
 "   WHERE employee_id=1 AND consumed_at IS NULL AND credential_id IS NULL",
 "   AND expires_at<clock_timestamp()) AS expired_unused,",
 " NOT EXISTS(SELECT 1 FROM public.hc_first_owner_activation_reissues) AS no_reissue,",
 " NOT EXISTS(SELECT 1 FROM public.hc_admin_principals) AS no_owner"
 ].join('\n');
 const {rows}=await client.query(sql);
 if(rows.length!==1 || Object.values(rows[0]).some(value=>value!==true)) refuse();
 console.log('HC_OWNER_OPERATOR_TUNNEL_PREFLIGHT_OK=true');
 console.log('READ_ONLY=true; ACTIVATION_NOT_ISSUED=true');
} catch {
 console.error('HC_OWNER_OPERATOR_TUNNEL_PREFLIGHT_BLOCKED');
 process.exitCode=1;
} finally {
 await client.end().catch(()=>{});
}
