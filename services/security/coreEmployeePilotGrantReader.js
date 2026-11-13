// DEVELOPMENT ONLY: an isolated test identity may read one employee tool
// scope from an operator-maintained table with a SELECT-only runtime role.
// This module never creates, changes, approves or exposes a grant endpoint.
const PILOT_ID = '901';
const PILOT_OPERATION = 'special-orders.read';
const GRANT_TABLE = 'public.hc_core_employee_pilot_grants';
const SCHEMA_CHECK = `SELECT
  to_regclass('public.hc_core_employee_pilot_grants') IS NOT NULL AS table_present,
  has_table_privilege(current_user,'public.hc_core_employee_pilot_grants','SELECT') AS can_read,
  has_table_privilege(current_user,'public.hc_core_employee_pilot_grants',
    'INSERT,UPDATE,DELETE,TRUNCATE') AS can_write,
  has_schema_privilege(current_user,'public','CREATE') AS can_create`;

const failClosed = row => row?.table_present === true &&
  row?.can_read === true && row?.can_write === false &&
  row?.can_create === false;

export function createCoreEmployeePilotGrantReader({pool}={}){
  if(typeof pool?.query!=='function')
    throw new TypeError('A separate SELECT-only PostgreSQL grant reader is required.');

  async function verifyReadOnly(){
    try {
      const got=await pool.query(SCHEMA_CHECK);
      return got.rowCount===1 && failClosed(got.rows?.[0]);
    } catch { return false; }
  }

  async function checkPermission({identity,operation}={}){
    if(String(identity?.id??'')!==PILOT_ID || identity?.active!==true ||
      operation!==PILOT_OPERATION) return false;
    try {
      // Privilege check and grant lookup run in the SAME statement on the
      // SAME PostgreSQL connection. No cached grant or role can authorize.
      const got=await pool.query(`SELECT
        to_regclass('public.hc_core_employee_pilot_grants') IS NOT NULL AS table_present,
        has_table_privilege(current_user,'public.hc_core_employee_pilot_grants','SELECT') AS can_read,
        has_table_privilege(current_user,'public.hc_core_employee_pilot_grants',
          'INSERT,UPDATE,DELETE,TRUNCATE') AS can_write,
        has_schema_privilege(current_user,'public','CREATE') AS can_create,
        EXISTS (
          SELECT 1 FROM public.hc_core_employee_pilot_grants
           WHERE employee_id=$1 AND operation=$2
             AND revoked_at IS NULL AND expires_at>now()
        ) AS granted`,[PILOT_ID,PILOT_OPERATION]);
      return got.rowCount===1 && failClosed(got.rows?.[0]) &&
        got.rows[0].granted === true;
    } catch { return false; }
  }

  return Object.freeze({verifyReadOnly,checkPermission});
}
