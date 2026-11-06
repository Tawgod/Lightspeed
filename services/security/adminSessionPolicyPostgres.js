import {validateStaffSessionPolicy} from './adminSessionPolicy.js';

const conflict=()=>Object.assign(new Error('Policy was updated by another administrator.'),{status:409,code:'HC_ADMIN_POLICY_CONFLICT'});
const unavailable=()=>Object.assign(new Error('Session policy service unavailable.'),{status:503,code:'HC_ADMIN_POLICY_UNAVAILABLE'});
const denied=()=>Object.assign(new Error('Authorized administrator required.'),{status:403,code:'HC_ADMIN_POLICY_DENIED'});
const readPolicy=row=>validateStaffSessionPolicy({
 'approved-workstation':{
   idleSeconds:Number(row.local_idle_seconds),
   absoluteSeconds:Number(row.local_absolute_seconds)
 },
 remote:{
   idleSeconds:Number(row.remote_idle_seconds),
   absoluteSeconds:Number(row.remote_absolute_seconds)
 }
});
function normalize(row){
 return Object.freeze({
  version:Number(row.version),policy:readPolicy(row),
  changedAt:row.changed_at instanceof Date?row.changed_at.toISOString():String(row.changed_at)
 });
}
export function createAdminSessionPolicyStore({pool,adminAccess}={}){
 if(typeof pool?.connect!=='function'||typeof adminAccess?.authorize!=='function')
   throw new TypeError('Private PostgreSQL and independent administrator gate required.');
 async function transaction(work){
  let client;
  try{
   client=await pool.connect();
   await client.query('BEGIN');
   const result=await work(client);
   await client.query('COMMIT');
   return result;
  }catch(error){
   if(client)await client.query('ROLLBACK').catch(()=>{});
   if(error?.code==='HC_ADMIN_POLICY_CONFLICT'||error?.code==='HC_ADMIN_POLICY_DENIED')throw error;
   throw unavailable();
  }finally{client?.release();}
 }
 async function current({context}={}){
  await adminAccess.authorize({context,operation:'sessions.policy.read'});
  return transaction(async db=>{
   const result=await db.query('SELECT * FROM hc_admin_session_policies WHERE policy_id=1');
   if(result.rowCount!==1)throw unavailable();
   return normalize(result.rows[0]);
  });
 }
 async function update({context,expectedVersion,policy,reason}={}){
  // Explicit privileged admin operation, distinct from TOTP-only entry.
  const approval=await adminAccess.authorize({
   context,operation:'sessions.policy.manage',requireStrong:true
  });
  if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1||
     typeof reason!=='string'||reason.trim().length<8||reason.trim().length>400)
   throw denied();
  const next=validateStaffSessionPolicy(policy);
  const employeeId=String(approval.employeeId);
  if(!/^[1-9][0-9]{0,17}$/.test(employeeId))throw denied();
  return transaction(async db=>{
   const found=await db.query(
    'SELECT * FROM hc_admin_session_policies WHERE policy_id=1 FOR UPDATE');
   if(found.rowCount!==1)throw unavailable();
   const existing=found.rows[0],version=Number(existing.version);
   if(version!==expectedVersion)throw conflict();
   const previous=readPolicy(existing);
   const changed=Object.keys(next).some(key=>
     next[key].idleSeconds!==previous[key].idleSeconds ||
     next[key].absoluteSeconds!==previous[key].absoluteSeconds
   );
   if(!changed) return normalize(existing);
   const written=await db.query(
    `UPDATE hc_admin_session_policies
       SET version=version+1,local_idle_seconds=$1,local_absolute_seconds=$2,
         remote_idle_seconds=$3,remote_absolute_seconds=$4,
         changed_by=$5,changed_at=now()
       WHERE policy_id=1 AND version=$6
       RETURNING *`,
    [next['approved-workstation'].idleSeconds,
     next['approved-workstation'].absoluteSeconds,
     next.remote.idleSeconds,next.remote.absoluteSeconds,employeeId,version]
   );
   if(written.rowCount!==1)throw conflict();
   await db.query(
    `INSERT INTO hc_admin_session_policy_events
      (old_version,new_version,employee_id,reason,previous_policy,next_policy)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
    [version,version+1,employeeId,reason.trim(),
     JSON.stringify(previous),JSON.stringify(next)]
   );
   return normalize(written.rows[0]);
  });
 }
 return Object.freeze({current,update});
}
