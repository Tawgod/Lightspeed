// Runtime authorization boundary for an opt-in Owner staging deployment.
// A privileged migration/activation issuer must NOT also be the public
// application DB role. Read-only check, never creates tables or grants.
const TABLES=Object.freeze([
 'hc_admin_principals','hc_staff_passkeys','hc_staff_passkey_challenges',
 'hc_staff_passkey_events','hc_staff_auth_throttle','hc_staff_factor_approvals',
 'hc_staff_totp','hc_first_owner_activations','hc_first_owner_activation_events'
]);
const denied=()=>new Error('Owner staging database is not safely provisioned.');
export async function verifyOwnerStagingDatabasePrivileges({pool}={}){
 if(typeof pool?.connect!=='function')throw denied();
 let client;
 try{
  client=await pool.connect();
  const r=await client.query(`SELECT
    current_user AS runtime_role,
    ${TABLES.map((_,i)=>'to_regclass($'+(i+1)+'::text) IS NOT NULL AS t'+i).join(',\n    ')},
    has_table_privilege(current_user,'hc_first_owner_activations','INSERT') AS can_issue,
    has_table_privilege(current_user,'hc_first_owner_activations','DELETE') AS can_delete,
    has_column_privilege(current_user,'hc_first_owner_activations','activation_digest','UPDATE') AS can_change_digest,
    has_column_privilege(current_user,'hc_first_owner_activations','employee_id','UPDATE') AS can_change_employee,
    has_column_privilege(current_user,'hc_first_owner_activations','expires_at','UPDATE') AS can_change_expiry,
    has_column_privilege(current_user,'hc_first_owner_activations','consumed_at','UPDATE') AS can_consume,
    has_column_privilege(current_user,'hc_first_owner_activations','credential_id','UPDATE') AS can_save_credential`,
   [...TABLES]);
  const row=r.rows?.[0];
  if(r.rowCount!==1||typeof row?.runtime_role!=='string'||
     !TABLES.every((_,i)=>row['t'+i]===true)||
     row.can_issue!==false||row.can_delete!==false||
     row.can_change_digest!==false||
     row.can_change_employee!==false||
     row.can_change_expiry!==false||
     row.can_consume!==true||row.can_save_credential!==true)
   throw denied();
  // Never reveal role names or table/grant details to unauthenticated clients.
  return Object.freeze({ready:true});
 }catch{throw denied();}finally{client?.release();}
}
